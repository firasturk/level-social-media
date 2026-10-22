/**
 * Client feedback: a message pasted, typed or dictated on a month (or one post) is stored, read
 * into separate changes (the rules, or the text model when a key is connected, or the demo fixture
 * on a preview) and each change is approved and applied by the designer, one at a time. A layer or
 * words change patches the plan through the same save path as the designer's card; a picture edit
 * goes through Generate's own approval (and is only described on a preview); an idea rewrites the
 * post's brief and makes nothing. Feedback never writes a lesson.
 */
import { Hono } from "hono";
import { z } from "zod";
import { previewNoImages, type Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { demoMode } from "./demo";
import { resolveGoogleAuth, resolveOpenAIKey } from "./settings";
import { askText, generateRun, ownedPlan, parseJson, savePlan, type BatchRow } from "./posts";
import type { Config } from "@shared/config";
import type { Post } from "@shared/posts";
import { MAX_POST_COUNT } from "@shared/posts";
import { resolveOverlay, type PostOverlayPatch } from "@shared/overlay";
import {
  canApply,
  FEEDBACK_SCHEMA,
  feedbackInstruction,
  interpretFeedback,
  parseFeedbackActions,
  type FeedbackAction,
  type FeedbackContext,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackPost,
  type ProposedAction,
  type WordsPatch,
} from "@shared/feedback";
import type { User } from "@shared/types";

type Variables = { user: User };
export const feedbackRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export type Interpreter = "rules" | "model" | "demo";

interface FeedbackRow {
  id: string;
  batch: string;
  post: number | null;
  text: string;
  source: string;
  interpreter: string;
  created: number;
  by: string;
}

interface ActionRow {
  id: string;
  feedback: string;
  batch: string;
  post: number | null;
  slide: number | null;
  version: string | null;
  kind: string;
  change: string;
  patch: string | null;
  instruction: string | null;
  ambiguity: string | null;
  conflict: string | null;
  status: string;
  applied_at: number | null;
  applied_result: string | null;
  created: number;
}

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

const SOURCES = ["pasted", "typed", "voice", "approval-page"] as const;
const KINDS = ["layer", "image", "words", "idea", "unclear"] as const;

/** A layer patch as the plan accepts it (the same bounds as the plan's own ov). */
const LAYER_PATCH = z
  .object({
    position: z.enum(["top", "center", "bottom"]).optional(),
    pin: z.boolean().optional(),
    dx: z.number().min(-1).max(1).optional(),
    dy: z.number().min(-2).max(2).optional(),
    scale: z.number().min(0.2).max(4).optional(),
    color: z.string().max(12).optional(),
    subColor: z.string().max(12).optional(),
    align: z.enum(["center", "left", "right"]).optional(),
    logoDx: z.number().min(-1).max(1).optional(),
    logoDy: z.number().min(-2).max(2).optional(),
    logoWidth: z.number().min(0.02).max(1).optional(),
    fade: z.boolean().optional(),
  })
  .strict();
const WORDS_PATCH = z.object({ headline: z.string().max(80).optional(), subline: z.string().max(120).optional(), caption: z.string().max(2200).optional() }).strict();

function toItem(r: FeedbackRow): FeedbackItem & { interpreter: Interpreter } {
  return { id: r.id, batch: r.batch, post: r.post ?? undefined, text: r.text, source: r.source as FeedbackItem["source"], created: r.created, by: r.by, interpreter: (r.interpreter as Interpreter) || "rules" };
}

function toAction(r: ActionRow): FeedbackAction {
  let patch: FeedbackAction["patch"];
  try {
    patch = r.patch ? (JSON.parse(r.patch) as FeedbackAction["patch"]) : undefined;
  } catch {
    patch = undefined;
  }
  return {
    id: r.id,
    feedback: r.feedback,
    post: r.post ?? undefined,
    slide: r.slide ?? undefined,
    version: r.version ?? undefined,
    kind: r.kind as FeedbackKind,
    change: r.change,
    patch,
    instruction: r.instruction ?? undefined,
    ambiguity: r.ambiguity ?? undefined,
    conflict: r.conflict ?? undefined,
    status: r.status as FeedbackAction["status"],
    applied: r.applied_at ? { at: r.applied_at, result: r.applied_result ?? undefined } : undefined,
  };
}

interface ClientLite {
  name: string;
  donts: string | null;
  image_rules: string | null;
  overlay: string | null;
}

/** What the reading knows about the month: its posts, their pictures and the client's rules. */
async function contextOf(env: Env, b: BatchRow, config: Config, post: number | undefined): Promise<{ ctx: FeedbackContext; client: ClientLite }> {
  const client = (await first<ClientLite>(env.DB, "SELECT name, donts, image_rules, overlay FROM clients WHERE id = ?", config.client ?? "")) ?? { name: "The client", donts: "", image_rules: "", overlay: null };
  let logoWidth: number | undefined;
  try {
    logoWidth = resolveOverlay(client.overlay ? JSON.parse(client.overlay) : null).logo.width;
  } catch {
    logoWidth = undefined;
  }
  const made = new Set((await all<{ post: number }>(env.DB, "SELECT post FROM tasks WHERE batch = ? AND post IS NOT NULL AND output IS NOT NULL", b.id)).map((t) => t.post));
  const posts: FeedbackPost[] = (config.plan ?? [])
    .slice()
    .sort((x, y) => x.index - y.index)
    .map((p) => ({ index: p.index, title: p.title, headline: p.headline, caption: p.caption, hasPicture: made.has(p.index), slides: p.group?.kind === "carousel" ? p.group.of : undefined, ov: p.ov, logoWidth }));
  const rules = `${client.donts ?? ""}\n${client.image_rules ?? ""}`;
  const noPeople = /\bno (people|persons|faces|humans|models)\b|\bwithout people\b/i.test(rules) || (!config.ambassadors?.length && /\b(hands? only|no one in the picture)\b/i.test(rules));
  return { ctx: { posts, post, constraints: { noPeople, donts: (client.donts ?? "").trim() || undefined } }, client };
}

/** The reading: the model when a key is connected, the fixture on a preview, the rules otherwise (and as the fallback). */
async function interpret(env: Env, clientName: string, text: string, ctx: FeedbackContext): Promise<{ actions: ProposedAction[]; interpreter: Interpreter }> {
  const rules = interpretFeedback(text, ctx);
  const demo = await demoMode(env);
  const hasKey = !!(await resolveGoogleAuth(env)).auth || !!(await resolveOpenAIKey(env)).key;
  if (!demo && !hasKey) return { actions: rules, interpreter: "rules" };
  try {
    const raw = await askText(env, feedbackInstruction({ client: clientName, text, context: ctx }), FEEDBACK_SCHEMA);
    return { actions: parseFeedbackActions(parseJson<unknown>(raw), ctx, rules), interpreter: demo ? "demo" : "model" };
  } catch (e) {
    console.error("[feedback] model reading failed, rules used", errorMessage(e));
    return { actions: rules, interpreter: "rules" };
  }
}

/* ───────────── Routes ───────────── */

/** Feedback on the month (or one post): stored, read into changes, nothing applied. */
feedbackRoutes.post("/", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      post: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
      text: z.string().trim().min(1).max(6000),
      source: z.enum(SOURCES).default("typed"),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  if (d.post !== undefined && !(config.plan ?? []).some((p) => p.index === d.post)) throw new StudioError(`Post ${d.post} is not in this month.`, 404);
  const { ctx, client } = await contextOf(c.env, b, config, d.post);
  const { actions, interpreter } = await interpret(c.env, client.name, d.text, ctx);
  const t = now();
  const item: FeedbackItem & { interpreter: Interpreter } = { id: uuid(), batch: b.id, post: d.post, text: d.text, source: d.source, created: t, by: user.name || user.email, interpreter };
  await run(c.env.DB, "INSERT INTO client_feedback (id, batch, post, text, source, interpreter, created, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", item.id, b.id, d.post ?? null, d.text, d.source, interpreter, t, item.by);
  const stored: FeedbackAction[] = [];
  for (const a of actions) {
    const row: FeedbackAction = { id: uuid(), feedback: item.id, ...a, status: "proposed" };
    await run(
      c.env.DB,
      "INSERT INTO feedback_actions (id, feedback, batch, post, slide, version, kind, change, patch, instruction, ambiguity, conflict, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)",
      row.id,
      item.id,
      b.id,
      row.post ?? null,
      row.slide ?? null,
      row.version ?? null,
      row.kind,
      row.change,
      row.patch ? JSON.stringify(row.patch) : null,
      row.instruction ?? null,
      row.ambiguity ?? null,
      row.conflict ?? null,
      t,
    );
    stored.push(row);
  }
  return c.json({ ok: true, feedback: item, actions: stored, interpreter });
});

/** The month's feedback, newest first, each with its changes. */
feedbackRoutes.get("/", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch") ?? "");
  const post = c.req.query("post") ? Number(c.req.query("post")) : undefined;
  const items = await all<FeedbackRow>(c.env.DB, "SELECT * FROM client_feedback WHERE batch = ? ORDER BY created DESC LIMIT 200", b.id);
  const actions = await all<ActionRow>(c.env.DB, "SELECT * FROM feedback_actions WHERE batch = ? ORDER BY created ASC", b.id);
  const list = items
    .map((r) => ({ ...toItem(r), actions: actions.filter((a) => a.feedback === r.id).map(toAction) }))
    // Post level: the feedback given on this post, and the month's feedback with a change aimed at it.
    .filter((f) => post === undefined || f.post === post || f.actions.some((a) => a.post === post));
  return c.json({ feedback: list });
});

async function ownedAction(env: Env, user: User, id: string): Promise<{ row: ActionRow; b: BatchRow }> {
  const row = await first<ActionRow>(env.DB, "SELECT * FROM feedback_actions WHERE id = ?", id);
  if (!row) throw new StudioError("Change not found.", 404);
  const b = await ownedPlan(env, user, row.batch);
  return { row, b };
}

/** The designer fixes a change (its post, slide, picture, words or edit) and approves or rejects it. */
feedbackRoutes.put("/actions/:id", async (c) => {
  const d = await body(
    c,
    z.object({
      status: z.enum(["proposed", "approved", "rejected"]).optional(),
      kind: z.enum(KINDS).optional(),
      post: z.number().int().min(1).max(MAX_POST_COUNT).nullable().optional(),
      slide: z.number().int().min(1).max(10).nullable().optional(),
      version: z.string().max(200).nullable().optional(),
      change: z.string().trim().min(1).max(400).optional(),
      patch: z.record(z.unknown()).nullable().optional(),
      instruction: z.string().trim().max(600).nullable().optional(),
    }),
  );
  const user = c.get("user");
  const { row, b } = await ownedAction(c.env, user, c.req.param("id"));
  if (row.status === "applied") throw new StudioError("This change was applied already.", 409);
  const config = JSON.parse(b.config) as Config;
  const kind = (d.kind ?? row.kind) as FeedbackKind;
  const post = d.post === undefined ? row.post : d.post;
  if (post !== null && !(config.plan ?? []).some((p) => p.index === post)) throw new StudioError(`Post ${post} is not in this month.`, 404);
  let patch = row.patch;
  if (d.patch !== undefined) {
    if (d.patch === null) patch = null;
    else {
      const parsed = kind === "layer" ? LAYER_PATCH.safeParse(d.patch) : kind === "words" ? WORDS_PATCH.safeParse(d.patch) : null;
      if (!parsed) throw new StudioError("Only a layer or words change takes a patch.");
      if (!parsed.success) throw new StudioError(`Invalid patch: ${parsed.error.issues[0]?.path.join(".") || "patch"} ${parsed.error.issues[0]?.message ?? "is invalid"}.`);
      if (!Object.keys(parsed.data).length) throw new StudioError("The patch is empty.");
      patch = JSON.stringify(parsed.data);
    }
  }
  const instruction = d.instruction === undefined ? row.instruction : d.instruction || null;
  // A fixed target or wording answers the question; the designer's own kind wins over the reading's.
  const ambiguity = (post !== null && (d.post !== undefined || d.kind !== undefined || d.patch !== undefined || d.instruction !== undefined)) && kind !== "unclear" ? null : row.ambiguity;
  const status = d.status ?? row.status;
  await run(
    c.env.DB,
    "UPDATE feedback_actions SET status = ?, kind = ?, post = ?, slide = ?, version = ?, change = ?, patch = ?, instruction = ?, ambiguity = ? WHERE id = ?",
    status,
    kind,
    post,
    d.slide === undefined ? row.slide : d.slide,
    d.version === undefined ? row.version : d.version || null,
    d.change ?? row.change,
    patch,
    instruction,
    ambiguity,
    row.id,
  );
  const fresh = await first<ActionRow>(c.env.DB, "SELECT * FROM feedback_actions WHERE id = ?", row.id);
  return c.json({ ok: true, action: toAction(fresh!) });
});

async function markApplied(env: Env, id: string, result: string): Promise<FeedbackAction> {
  await run(env.DB, "UPDATE feedback_actions SET status = 'applied', applied_at = ?, applied_result = ? WHERE id = ?", now(), result.slice(0, 400), id);
  const fresh = await first<ActionRow>(env.DB, "SELECT * FROM feedback_actions WHERE id = ?", id);
  return toAction(fresh!);
}

/**
 * One approved change applied. layer / words: the plan is patched through the designer's own save
 * path (the picture stays, no task is made). image: the same request as "Make it again" with the
 * edit as its note, through Generate's spend approval (a 409 asks first); on a preview, the request
 * it would make is returned and nothing is spent. idea: the post's brief carries the change; nothing
 * is generated. Never more than one change per call.
 */
feedbackRoutes.post("/actions/:id/apply", async (c) => {
  const d = await body(c, z.object({ approve: z.boolean().optional(), run: z.string().max(80).optional() }));
  const user = c.get("user");
  const { row, b } = await ownedAction(c.env, user, c.req.param("id"));
  const action = toAction(row);
  if (action.status === "applied") throw new StudioError("This change was applied already.", 409);
  if (action.status !== "approved") throw new StudioError("Approve the change first.", 409);
  if (action.post === undefined) throw new StudioError("Pick the post this change is about first.");
  if (!canApply(action)) throw new StudioError(action.kind === "unclear" ? "Say what kind of change this is (layer, words, picture or idea) before applying it." : action.kind === "image" ? "Write the edit for the picture first." : "The change has no patch to apply.");
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === action.post);
  if (!post) throw new StudioError(`Post ${action.post} is not in this month.`, 404);
  const feedback = await first<FeedbackRow>(c.env.DB, "SELECT * FROM client_feedback WHERE id = ?", action.feedback);

  if (action.kind === "layer") {
    const patch = LAYER_PATCH.parse(action.patch ?? {}) as PostOverlayPatch;
    const plan: Post[] = (config.plan ?? []).map((p) => (p.index === action.post ? { ...p, ov: { ...(p.ov ?? {}), ...patch } } : p));
    await savePlan(c.env, b, plan);
    return c.json({ ok: true, action: await markApplied(c.env, action.id, `Layer patched on post ${action.post}: ${Object.keys(patch).join(", ")}. The picture was not touched.`) });
  }

  if (action.kind === "words") {
    const patch = WORDS_PATCH.parse(action.patch ?? {}) as WordsPatch;
    const plan: Post[] = (config.plan ?? []).map((p) => (p.index === action.post ? { ...p, ...(patch.headline !== undefined ? { headline: patch.headline } : {}), ...(patch.subline !== undefined ? { subline: patch.subline } : {}), ...(patch.caption !== undefined ? { caption: patch.caption } : {}) } : p));
    await savePlan(c.env, b, plan);
    return c.json({ ok: true, action: await markApplied(c.env, action.id, `Words changed on post ${action.post}: ${Object.keys(patch).join(", ")}.`) });
  }

  if (action.kind === "idea") {
    const t = now();
    const note = feedback?.text?.trim().slice(0, 1000) || action.change;
    const brief = `${post.brief.trim()}\n\nClient feedback: ${action.change}`.slice(0, 2000);
    const plan: Post[] = (config.plan ?? []).map((p) => (p.index === action.post ? { ...p, brief, clientNote: { note, at: t, summary: action.change.slice(0, 300) } } : p));
    await savePlan(c.env, b, plan);
    return c.json({ ok: true, action: await markApplied(c.env, action.id, `The idea of post ${action.post} carries the client's change; nothing was generated. Write the ideas again or press Make on the post when ready.`) });
  }

  // image
  const request = { batch: b.id, indexes: [action.post], regenerate: true as const, note: action.instruction!.trim(), approve: d.approve, run: d.run ?? action.id };
  if (previewNoImages(c.env))
    return c.json({ ok: true, preview: true, request: { path: "/api/studio/posts/generate", body: request }, action, note: "This is the preview: no picture is made here. The request shown is what the studio would send, through Generate's own approval." });
  const r = await generateRun(c.env, user, request, (p) => c.executionCtx.waitUntil(p));
  if (r.status !== 200) return c.json(r.body, r.status);
  const versionNote = action.version ? ` The edit starts from the post's current picture (the version named, ${action.version}, is kept in Versions).` : "";
  return c.json({ ok: true, generate: r.body, action: await markApplied(c.env, action.id, `Making post ${action.post} again with the edit: ${action.instruction}.${versionNote}`) });
});

/** A feedback item and its changes taken off the month (nothing applied is undone). */
feedbackRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const row = await first<FeedbackRow>(c.env.DB, "SELECT * FROM client_feedback WHERE id = ?", c.req.param("id"));
  if (!row) return c.json({ ok: true });
  await ownedPlan(c.env, user, row.batch);
  await run(c.env.DB, "DELETE FROM feedback_actions WHERE feedback = ?", row.id);
  await run(c.env.DB, "DELETE FROM client_feedback WHERE id = ?", row.id);
  return c.json({ ok: true });
});
