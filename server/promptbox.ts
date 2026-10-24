/**
 * The Prompt Box's run button: a confirmed intent card is checked once more against the month,
 * the admin-only gate and the cost, recorded as an integration op, then run through the adapter
 * in promptbox-tools.ts. The sentence that produced the card never reaches here; only the card.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, recordIntegrationOp, requireIntegrationUser, updateIntegrationOp, type IntegrationProvider } from "./integrations";
import { promptboxTools } from "./promptbox-tools";
import { COST_UNKNOWN, intentSummary, validateIntent, videoCatalog, type PromptContext, type ToolIntent } from "@shared/promptbox";
import type { Config } from "@shared/config";
import type { User } from "@shared/types";

type Variables = { user: User };
export const promptboxRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const ASSET = z.object({ id: z.string().min(1).max(120), source: z.string().min(1).max(40), url: z.string().max(2000).optional(), title: z.string().max(300).optional() }).nullable().optional();

/** The month's posts as the resolver sees them. */
export function promptContext(batchId: string, config: Config, ctx?: { post?: number | null; slide?: number | null; asset?: { id: string; source: string; url?: string; title?: string } | null }): PromptContext {
  return {
    batch: batchId,
    posts: (config.plan ?? []).map((p) => ({ index: p.index, title: p.title, group: p.group ? { kind: p.group.kind, slide: p.group.slide, of: p.group.of } : null })),
    openPost: ctx?.post ?? null,
    openSlide: ctx?.slide ?? null,
    lastAsset: ctx?.asset ?? null,
    videoModels: videoCatalog(),
  };
}

/**
 * Runs one confirmed card. Refused without `confirm: true`, with an open question, with no known
 * cost (an admin may set one in `estimate`). The whole team runs the cards (24 Oct). Searching is
 * free and makes nothing; it is still recorded.
 */
promptboxRoutes.post("/execute", async (c) => {
  const parsed = z
    .object({
      intent: z.record(z.unknown()),
      confirm: z.boolean().optional(),
      /** An admin's own estimate when the catalog has none. */
      estimate: z.number().min(0).max(100_000).optional(),
      context: z.object({ post: z.number().int().positive().nullable().optional(), slide: z.number().int().positive().nullable().optional(), asset: ASSET }).optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError(`Invalid request: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? "is invalid"}.`);
  const d = parsed.data;
  if (d.confirm !== true) throw new StudioError("Confirm the card first: nothing runs from the sentence alone.", 428);
  const user = c.get("user");
  const target = (d.intent.target ?? {}) as { batch?: unknown };
  const b = await ownedPlan(c.env, user, typeof target.batch === "string" ? target.batch : undefined);
  const config = JSON.parse(b.config) as Config;
  // The card's own asset is the one shown last; the browser's context may carry the same one.
  const cardAsset = d.intent.asset && typeof d.intent.asset === "object" ? (d.intent.asset as { id: string; source: string; url?: string; title?: string }) : (d.context?.asset ?? null);
  const ctx = promptContext(b.id, config, { ...d.context, asset: cardAsset });
  const intent: ToolIntent | null = validateIntent(d.intent, ctx);
  if (!intent || intent.tool === "none") throw new StudioError("That card is not a tool the box can run.", 400);
  if (intent.questions.length) throw new StudioError(intent.questions[0], 409);
  if (intent.estimate === null) {
    if (user.role === "admin" && typeof d.estimate === "number") {
      intent.estimate = d.estimate;
      intent.estimateNote = `About ${d.estimate} credits, set by ${user.name || "an admin"}.`;
    } else throw new StudioError(`${COST_UNKNOWN} · blocked until clarified. An admin can set the estimate on the card.`, 409);
  }
  const provider = intent.provider as IntegrationProvider;
  requireIntegrationUser(c, provider);
  await assertIntegrationEnabled(c.env, provider);
  const summary = intentSummary(intent, ctx.posts);
  const opId = await recordIntegrationOp(c.env, { provider, kind: intent.tool, user: user.id, batch: b.id, post: intent.target.post, estimate: intent.estimate, status: "confirmed", note: summary });
  try {
    const s = intent.settings;
    if (intent.tool === "freepik.search") {
      // Browsing never generates: the results are shown, nothing is downloaded or made.
      const r = await promptboxTools.freepikSearch(c.env, user, { q: String(s.q ?? ""), type: String(s.type ?? "photo"), orientation: String(s.orientation ?? ""), page: Number(s.page) || 1 });
      await updateIntegrationOp(c.env, opId, { status: "done", reported: 0, note: `${r.results.length} results${r.fixture ? " (fixture)" : ""}` });
      return c.json({ ok: true, kind: "results", intent, opId, results: r.results, page: r.page, more: r.more, fixture: r.fixture });
    }
    if (intent.tool === "freepik.use") {
      const r = await promptboxTools.freepikUse(c.env, user, { asset: intent.asset!, batch: b.id, post: intent.target.post!, slide: intent.target.slide, role: s.role === "reference" ? "reference" : "design", placement: typeof s.placement === "string" ? s.placement : "" });
      await updateIntegrationOp(c.env, opId, { status: "done", reported: 0, note: r.note });
      return c.json({ ok: true, kind: "done", intent, opId, note: r.note, fixture: r.fixture });
    }
    if (intent.tool === "video.generate") {
      await updateIntegrationOp(c.env, opId, { status: "running" });
      const r = await promptboxTools.videoGenerate(c.env, user, { batch: b.id, index: intent.target.post!, model: String(s.model), prompt: String(s.prompt || `Animate post ${intent.target.post} gently; the product stays exactly as pictured.`), duration: Number(s.duration) || 5, aspect: String(s.aspect ?? ""), frame: typeof s.frame === "string" ? s.frame : undefined, source: s.source === "artwork" ? "artwork" : "picture" });
      await updateIntegrationOp(c.env, opId, { status: "done", taskId: r.video?.id ?? null, note: r.note });
      return c.json({ ok: true, kind: "done", intent, opId, note: r.note, video: r.video });
    }
    await updateIntegrationOp(c.env, opId, { status: "running" });
    const r = await promptboxTools.photolabRun(c.env, user, { batch: b.id, post: intent.target.post!, operation: String(s.operation ?? "enhance"), prompt: String(s.prompt ?? "") });
    await updateIntegrationOp(c.env, opId, { status: "done", note: r.note });
    return c.json({ ok: true, kind: "done", intent, opId, note: r.note, fixture: r.fixture });
  } catch (e) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: errorMessage(e).slice(0, 400) }).catch(() => undefined);
    throw e;
  }
});
