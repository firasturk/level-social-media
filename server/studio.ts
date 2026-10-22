import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { spendStatus } from "./spend";
import { previewNoImages } from "./env";
import { all, first, run, now, uuid } from "./db";
import {
  advanceBatch,
  engineConfigured,
  keyLooksValid,
  makeClient,
  makeFalClient,
  makeGoogleClient,
  makeOpenAIClient,
  runFramingCheck,
  runReferenceRead,
  directionRules,
  DIRECTION_RULES_SETTING,
} from "./engine";
import { OPENAI_MODELS } from "./openai";
import { GOOGLE_MODELS } from "./google";
import { parseServiceAccount, VertexImageClient } from "./vertex";
import { FAL_MODELS } from "./fal";
import { listSkills, saveSkillsOrder, setFavourite, readMoodBoard, writeMoodBoard } from "./skills";
import { buildSkillFromReferences } from "./skillbuilder";
import { SKILLS } from "@shared/skills";
import { DEFAULT_DIRECTION_RULES, storeDirectionRules } from "@shared/direction-rules";
import {
  ENGINE_KEY_SETTING,
  ENGINE_MODEL_SETTING,
  FAL_KEY_SETTING,
  GOOGLE_KEY_SETTING,
  VERTEX_SETTING,
  resolveVertex,
  resolveGoogleAuth,
  MODES_SETTING,
  OPENAI_KEY_SETTING,
  ZAID_DIRECTION_SETTING,
  deleteSetting,
  getSetting,
  resolveEngineKey,
  resolveEngineModel,
  resolveFalKey,
  resolveGoogleKey,
  resolveOpenAIKey,
  setSetting,
  HERO_KEYS,
  heroStamp,
} from "./settings";
import {
  MODES,
  cardsPerSource,
  createsTasks,
  type Config,
  validateConfig,
  NP_POSES,
  NP_BACKGROUNDS,
} from "@shared/config";
import { configSchema } from "@shared/config-schema";
import { purgeBatch } from "./batchfiles";
import { resizedPicture, thumbWidth } from "./thumbs";
import { buildPrompt } from "@shared/prompts";
import { stemOf, stemKey, isValidSourceName, relativeUploadName } from "@shared/naming";
import type { Batch, LookInfo, ModeOverride, Preset, Source, Task, User, PersonSpend } from "@shared/types";
import type { EditorialBrief } from "./editorial";
import { signObjectUrl } from "./signed";
import { readAdminSettings } from "./admin";
import { clientRoutes, listClients, requireActiveClient } from "./clients";
import { describeUpload, postRoutes } from "./posts";
import { videoRoutes } from "./video";
import { videoAudioRoutes } from "./video-audio";
import { videoEditorRoutes } from "./video-editor";
import { VIDEO_MODELS, videoPriceSetting } from "@shared/video-models";
import { promptboxRoutes } from "./promptbox";
import { styleRoutes } from "./styles";
import { ambassadorRoutes } from "./ambassadors";
import { metaRoutes } from "./meta";
import { profileRoutes } from "./profile";
import { driveRoutes } from "./drive";
import { deliveryRoutes } from "./drive-delivery";
import { autopilotRoutes } from "./autopilot";
import { lessonRoutes } from "./lessons";
import { ocrRoutes } from "./ocr-routes";
import { feedbackRoutes } from "./feedback";
import { notifyRoutes } from "./notify";
import { photoLabRoutes } from "./photolab";
import { freepikRoutes } from "./freepik";
import { freepikMcpRoutes } from "./freepik-mcp";
import { publishRoutes } from "./publish";

type Variables = { user: User };
export const studioRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
studioRoutes.route("/clients", clientRoutes);
studioRoutes.route("/posts", postRoutes);
// The video versions of a post, under the posts' own path (mounted here so posts.ts and video.ts do not import each other in a loop).
// The audio of those versions first, so /posts/video/audio/* is not read as a video route.
studioRoutes.route("/posts/video/audio", videoAudioRoutes);
studioRoutes.route("/posts/video", videoRoutes);
// The video editor's projects and exports, next to the versions they read and produce.
studioRoutes.route("/posts/video/editor", videoEditorRoutes);
studioRoutes.route("/ambassadors", ambassadorRoutes);
studioRoutes.route("/styles", styleRoutes);
studioRoutes.route("/meta", metaRoutes);
studioRoutes.route("/profiles", profileRoutes);
studioRoutes.route("/drive/delivery", deliveryRoutes);
studioRoutes.route("/drive", driveRoutes);
studioRoutes.route("/autopilot", autopilotRoutes);
studioRoutes.route("/lessons", lessonRoutes);
studioRoutes.route("/ocr", ocrRoutes);
studioRoutes.route("/promptbox", promptboxRoutes);
studioRoutes.route("/feedback", feedbackRoutes);
studioRoutes.route("/notify", notifyRoutes);
studioRoutes.route("/photolab", photoLabRoutes);
// The MCP adapter first: /freepik/mcp/* is its own sub-app, the rest of /freepik is the stock library.
studioRoutes.route("/freepik/mcp", freepikMcpRoutes);
studioRoutes.route("/freepik", freepikRoutes);
studioRoutes.route("/publish", publishRoutes);

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_IDENTITY = 8 * 1024 * 1024;
const MAX_REFERENCE = 3 * 1024 * 1024;

interface BatchRow extends Batch {
  owner: string;
  last_error: string | null;
}

/** A member's own months; an admin opens every month of the team (the maker stays its owner). */
async function ownedBatch(env: Env, user: User, id: string | undefined): Promise<BatchRow> {
  if (!id) throw new StudioError("Batch id is required.");
  const b =
    user.role === "admin"
      ? await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ? AND deleted IS NULL", id)
      : await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ? AND owner = ? AND deleted IS NULL", id, user.id);
  if (!b) throw new StudioError("Batch not found.", 404);
  return b;
}

/** A month in the bin (deleted, not yet purged): its owner's, or any for an admin. */
async function binnedBatch(env: Env, user: User, id: string | undefined): Promise<BatchRow> {
  if (!id) throw new StudioError("Batch id is required.");
  const b =
    user.role === "admin"
      ? await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ? AND deleted IS NOT NULL", id)
      : await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ? AND owner = ? AND deleted IS NOT NULL", id, user.id);
  if (!b) throw new StudioError("That month is not in the bin.", 404);
  return b;
}

/**
 * A month as the browser sees it. The prompts and briefs (the studio's know-how) go to admins
 * only; members see the images, the plan and the captions they work with.
 */
async function batchPayload(env: Env, b: BatchRow, user?: User) {
  const [sources, tasks] = await Promise.all([
    all<Source>(
      env.DB,
      "SELECT id, name, mime, size, role, kind, created, skill, note, category FROM sources WHERE batch = ? ORDER BY name",
      b.id,
    ),
    all<Task>(
      env.DB,
      "SELECT t.id, t.source, t.card, t.status, t.output, t.qa, t.error, t.prompt, t.attempts, t.request_id, t.brief, t.cost, t.updated, t.post, t.caption, t.preflight, t.made_for, t.making_for FROM tasks t JOIN sources s ON s.id = t.source WHERE t.batch = ? ORDER BY t.post, s.name, t.card",
      b.id,
    ),
  ]);
  // 'finalizing' is an internal step; the UI treats it as processing.
  for (const t of tasks) if (t.status === ("finalizing" as string)) t.status = "processing";
  if (user?.role !== "admin")
    for (const t of tasks) {
      t.prompt = null as unknown as Task["prompt"];
      t.brief = null as unknown as Task["brief"];
    }
  const { owner: _owner, ...batch } = b;
  void _owner;
  // The month's spending ledger: what was approved for it and what its attempts have reserved.
  const spend = await spendStatus(env, b.id);
  return { batch, sources, tasks, spend };
}

studioRoutes.get("/state", async (c) => {
  const user = c.get("user");
  const batches = await all<
    Batch & { total: number; completed: number; review: number; failed: number; queued: number }
  >(
    c.env.DB,
    `SELECT b.id, b.name, b.config, b.client, b.month, b.theme, b.state, b.last_error, b.created, b.updated, u.name AS ownerName,
       COUNT(t.id) AS total,
       COALESCE(SUM(t.cost), 0) AS spent,
       SUM(CASE WHEN t.output IS NOT NULL THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) AS review,
       SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN t.status IN ('queued','processing','finalizing') THEN 1 ELSE 0 END) AS queued
     FROM batches b LEFT JOIN tasks t ON t.batch = b.id LEFT JOIN users u ON u.id = b.owner
     WHERE b.deleted IS NULL AND ${user.role === "admin" ? "1 = 1" : "b.owner = ?"} GROUP BY b.id ORDER BY b.created DESC LIMIT 200`,
    ...(user.role === "admin" ? [] : [user.id]),
  );
  // The bin: deleted months that can still come back (purged after TRASH_DAYS).
  const trash = await all<Batch>(
    c.env.DB,
    `SELECT id, name, config, client, month, theme, state, created, updated, deleted FROM batches
     WHERE deleted IS NOT NULL AND ${user.role === "admin" ? "1 = 1" : "owner = ?"} ORDER BY deleted DESC LIMIT 50`,
    ...(user.role === "admin" ? [] : [user.id]),
  );
  const thumbRows = await all<{ batch: string; id: string }>(
    c.env.DB,
    `SELECT batch, id FROM (
       SELECT t.batch, t.id, ROW_NUMBER() OVER (PARTITION BY t.batch ORDER BY t.updated DESC) AS rn
       FROM tasks t JOIN batches b ON b.id = t.batch WHERE ${user.role === "admin" ? "1 = 1" : "b.owner = ?"} AND t.output IS NOT NULL
     ) WHERE rn <= 3`,
    ...(user.role === "admin" ? [] : [user.id]),
  );
  const thumbsByBatch = new Map<string, string[]>();
  for (const r of thumbRows)
    thumbsByBatch.set(r.batch, [...(thumbsByBatch.get(r.batch) ?? []), r.id]);
  for (const b of batches) b.thumbs = thumbsByBatch.get(b.id) ?? [];
  // Admin: what each person spent on pictures in all (a task's cost adds up over its takes).
  const spend =
    user.role === "admin"
      ? await all<PersonSpend>(
          c.env.DB,
          `SELECT u.id, u.name, u.role,
             COUNT(t.id) AS pictures,
             COALESCE(SUM(t.cost), 0) AS spent,
             COUNT(DISTINCT b.id) AS months
           FROM users u LEFT JOIN batches b ON b.owner = u.id LEFT JOIN tasks t ON t.batch = b.id
           GROUP BY u.id ORDER BY spent DESC`,
        )
      : undefined;
  const engineKey = await resolveEngineKey(c.env);
  const adminSettings = await readAdminSettings(c.env);
  return c.json({
    user,
    batches,
    trash,
    spend,
    spendThreshold: adminSettings.spendThreshold,
    workflowV2: adminSettings.workflowV2,
    pricesHidden: adminSettings.pricing === "admins" && user.role !== "admin",
    autopilotReview: adminSettings.autopilotReview,
    preview: previewNoImages(c.env) || undefined,
    zaidDirection: (await getSetting(c.env, ZAID_DIRECTION_SETTING)) || "",
    moodBoard: await readMoodBoard(c.env, user.id),
    modes: await readModes(c.env),
    clients: await listClients(c.env, true),
    hero: await heroStamp(c.env),
    engine: {
      model: await resolveEngineModel(c.env),
      configured: keyLooksValid(engineKey.key),
      source: engineKey.source,
      openai: (await resolveOpenAIKey(c.env)).source,
      google: (await resolveGoogleKey(c.env)).source,
      fal: (await resolveFalKey(c.env)).source,
      review: !!(await resolveGoogleAuth(c.env)).auth,
      vertex: await (async () => {
        const v = await resolveVertex(c.env);
        return v ? { project: v.projectId, location: v.location } : null;
      })(),
    },
  });
});

/**
 * Only an admin connects or disconnects an engine: the keys are shared by every client and
 * every member, and a member can still read the connection status and the model lists.
 */
export function requireEngineAdmin(user: User): void {
  if (user.role !== "admin") throw new StudioError("Only an admin can change the engine connection.", 403);
}
studioRoutes.use("/engine/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") requireEngineAdmin(c.get("user"));
  await next();
});

/** The fallback price per video clip for each model, when Higgsfield gives no estimate (Connection → Higgsfield). */
studioRoutes.get("/engine/video-prices", async (c) => {
  const prices: Record<string, number | null> = {};
  for (const m of VIDEO_MODELS) {
    const s = Number((await getSetting(c.env, videoPriceSetting(m.slug))) ?? "");
    prices[m.slug] = typeof m.price === "number" ? m.price : Number.isFinite(s) && s > 0 ? s : null;
  }
  return c.json({ ok: true, prices, models: VIDEO_MODELS.map((m) => ({ slug: m.slug, name: m.name, catalog: m.price })) });
});

/** An admin sets (or clears) the fallback price of one video model, in USD per clip. */
studioRoutes.post("/engine/video-price", async (c) => {
  const parsed = z.object({ model: z.string().min(1), usd: z.number().min(0).max(500).nullable() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Send the model and its price in USD, or null to clear it.");
  if (!VIDEO_MODELS.some((m) => m.slug === parsed.data.model)) throw new StudioError("Unknown video engine.", 404);
  const key = videoPriceSetting(parsed.data.model);
  if (parsed.data.usd === null || parsed.data.usd === 0) await deleteSetting(c.env, key);
  else await setSetting(c.env, key, String(parsed.data.usd));
  return c.json({ ok: true, model: parsed.data.model, usd: parsed.data.usd || null });
});

/** Save an OpenAI key from the app after checking it against the Models endpoint. */
studioRoutes.post("/engine/openai-key", async (c) => {
  if (c.env.OPENAI_API_KEY)
    throw new StudioError("The OpenAI key is managed as a Worker secret on this deployment.", 409);
  const { key } = await body(c, z.object({ key: z.string().trim().min(10).max(400) }));
  const check = await (await makeOpenAIClient(c.env, key)).verify();
  if (!check.ok) throw new StudioError(`OpenAI rejected this key: ${check.message}`, 400);
  await setSetting(c.env, OPENAI_KEY_SETTING, key);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true, message: check.message });
});

/** Save a Google AI Studio key from the app. It also powers the automatic review. */
studioRoutes.post("/engine/google-key", async (c) => {
  if (c.env.GEMINI_API_KEY)
    throw new StudioError("The Google key is managed as a Worker secret on this deployment.", 409);
  const { key } = await body(c, z.object({ key: z.string().trim().min(20).max(400) }));
  const check = await (await makeGoogleClient(c.env, key)).verify();
  if (!check.ok) throw new StudioError(`Google rejected this key: ${check.message}`, 400);
  await setSetting(c.env, GOOGLE_KEY_SETTING, key);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true, message: check.message });
});

/** Google Cloud (Vertex AI): a service account for the project whose credits pay for Gemini. */
studioRoutes.post("/engine/vertex", async (c) => {
  const { json, location } = await body(
    c,
    z.object({ json: z.string().min(20).max(20000), location: z.string().max(40).optional() }),
  );
  const creds = parseServiceAccount(json, location || "global");
  const check = await new VertexImageClient(creds).verify();
  if (!check.ok)
    throw new StudioError(`Google Cloud rejected the service account: ${check.message}`, 400);
  await setSetting(c.env, VERTEX_SETTING, JSON.stringify(creds));
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true, message: check.message });
});

studioRoutes.delete("/engine/vertex", async (c) => {
  await deleteSetting(c.env, VERTEX_SETTING);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true });
});

studioRoutes.delete("/engine/google-key", async (c) => {
  await deleteSetting(c.env, GOOGLE_KEY_SETTING);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true });
});

studioRoutes.post("/engine/fal-key", async (c) => {
  if (c.env.FAL_KEY)
    throw new StudioError("The fal.ai key is managed as a Worker secret on this deployment.", 409);
  const { key } = await body(c, z.object({ key: z.string().trim().min(20).max(400) }));
  const check = await (await makeFalClient(c.env, key)).verify();
  if (!check.ok) throw new StudioError(`fal.ai rejected this key: ${check.message}`, 400);
  await setSetting(c.env, FAL_KEY_SETTING, key);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true, message: check.message });
});

studioRoutes.delete("/engine/fal-key", async (c) => {
  await deleteSetting(c.env, FAL_KEY_SETTING);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true });
});

studioRoutes.delete("/engine/openai-key", async (c) => {
  await deleteSetting(c.env, OPENAI_KEY_SETTING);
  await deleteSetting(c.env, MODELS_CACHE);
  return c.json({ ok: true });
});

/** Known image models on the Higgsfield API. Each is probed (no generation) and cached for an hour. */
const MODEL_CANDIDATES: { slug: string; name: string }[] = [
  { slug: "nano-banana-pro", name: "Nano Banana Pro (via Higgsfield)" },
  { slug: "flux-2-pro", name: "FLUX.2 Pro (Higgsfield)" },
  { slug: "flux-2-max", name: "FLUX.2 Max (Higgsfield)" },
  { slug: "flux-2-flex", name: "FLUX.2 Flex (Higgsfield)" },
  { slug: "qwen-image-edit", name: "Qwen Image Edit (Higgsfield)" },
  { slug: "seedream-4-5", name: "Seedream 4.5 (Higgsfield)" },
  { slug: "gpt-image-2", name: "GPT Image 2 (via Higgsfield)" },
];
const MODELS_CACHE = "engine_models_cache";

/** Production approach cards: team-wide renames and hidden cards. */
async function readModes(env: Env): Promise<Record<string, ModeOverride>> {
  try {
    const v = JSON.parse((await getSetting(env, MODES_SETTING)) || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, ModeOverride>) : {};
  } catch {
    return {};
  }
}

studioRoutes.post("/modes", async (c) => {
  const d = await body(
    c,
    z.object({
      id: z.enum(MODES),
      title: z.string().trim().max(40).optional(),
      caption: z.string().trim().max(60).optional(),
      hidden: z.boolean().optional(),
      reset: z.boolean().optional(),
    }),
  );
  const modes = await readModes(c.env);
  if (d.reset) delete modes[d.id];
  else {
    const cur = modes[d.id] ?? {};
    if (d.title !== undefined) cur.title = d.title || undefined;
    if (d.caption !== undefined) cur.caption = d.caption || undefined;
    if (d.hidden !== undefined) cur.hidden = d.hidden || undefined;
    modes[d.id] = cur;
  }
  const visible = MODES.filter((id) => !modes[id]?.hidden);
  if (!visible.length) throw new StudioError("Keep at least one production approach visible.");
  await setSetting(c.env, MODES_SETTING, JSON.stringify(modes));
  return c.json({ ok: true, modes });
});

/** Shared default text for the Zaid creative direction workflow (mode 7). */
studioRoutes.post("/direction", async (c) => {
  const { text } = await body(c, z.object({ text: z.string().max(20000) }));
  await setSetting(c.env, ZAID_DIRECTION_SETTING, text.trim());
  return c.json({ ok: true, text: text.trim() });
});

/** Creative direction fixed rules: read, replace, reset to the built-in list. */
studioRoutes.get("/direction-rules", async (c) =>
  c.json({ rules: await directionRules(c.env), defaults: DEFAULT_DIRECTION_RULES }),
);

const rulesBody = z.object({
  rules: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .regex(/^[a-z0-9-]{1,40}$/),
        title: z.string().trim().max(80).default(""),
        text: z.string().trim().max(4000),
        enabled: z.boolean().default(true),
      }),
    )
    .max(40),
});

studioRoutes.put("/direction-rules", async (c) => {
  const { rules } = await body(c, rulesBody);
  await setSetting(c.env, DIRECTION_RULES_SETTING, JSON.stringify(storeDirectionRules(rules)));
  return c.json({ ok: true, rules });
});

studioRoutes.delete("/direction-rules", async (c) => {
  await deleteSetting(c.env, DIRECTION_RULES_SETTING);
  return c.json({ ok: true, rules: DEFAULT_DIRECTION_RULES });
});

/** Creative direction's Mood board entry: rename, describe, hide, restore. The star uses the skills route. */
studioRoutes.get("/direction-skill", async (c) =>
  c.json({ moodBoard: await readMoodBoard(c.env, c.get("user").id) }),
);

studioRoutes.post("/direction-skill", async (c) => {
  const d = await body(
    c,
    z.object({
      title: z.string().trim().min(2).max(60),
      caption: z.string().trim().max(80).default(""),
      description: z.string().trim().max(400).default(""),
      goal: z.string().max(20000).optional(),
    }),
  );
  await writeMoodBoard(c.env, { title: d.title, caption: d.caption, description: d.description });
  if (d.goal !== undefined) await setSetting(c.env, ZAID_DIRECTION_SETTING, d.goal.trim());
  return c.json({
    ok: true,
    moodBoard: await readMoodBoard(c.env, c.get("user").id),
    direction: d.goal?.trim(),
  });
});

studioRoutes.delete("/direction-skill", async (c) => {
  await writeMoodBoard(c.env, { hidden: true });
  return c.json({ ok: true, moodBoard: await readMoodBoard(c.env, c.get("user").id) });
});

studioRoutes.post("/direction-skill/restore", async (c) => {
  await writeMoodBoard(c.env, { hidden: false });
  return c.json({ ok: true, moodBoard: await readMoodBoard(c.env, c.get("user").id) });
});

/** Team-managed skills: list, create or edit, delete (a built-in is hidden rather than removed). */
studioRoutes.get("/skills", async (c) =>
  c.json({ skills: await listSkills(c.env, c.get("user").id) }),
);

/** Saved looks: prompts the team liked, reusable as the direction of later batches. */
studioRoutes.get("/looks", async (c) =>
  c.json({
    looks: (
      await all<Omit<LookInfo, "image"> & { image: string | null }>(
        c.env.DB,
        "SELECT id, skill, name, scene, pose, light, image, created FROM looks ORDER BY created DESC",
      )
    ).map((l) => ({ ...l, image: !!l.image })),
  }),
);

studioRoutes.post("/looks", async (c) => {
  const { task, name } = await body(
    c,
    z.object({ task: z.string().max(80), name: z.string().trim().min(1).max(60) }),
  );
  const t = await first<{
    brief: string | null;
    batch: string;
    source: string;
    output: string | null;
  }>(
    c.env.DB,
    `SELECT t.brief, t.batch, t.source, t.output FROM tasks t JOIN batches b ON b.id = t.batch WHERE t.id = ?${c.get("user").role === "admin" ? "" : " AND b.owner = ?"}`,
    task,
    ...(c.get("user").role === "admin" ? [] : [c.get("user").id]),
  );
  if (!t?.brief) throw new StudioError("This image has no skill prompt to save.", 404);
  const b = await first<{ config: string }>(
    c.env.DB,
    "SELECT config FROM batches WHERE id = ?",
    t.batch,
  );
  const cfg = b ? (JSON.parse(b.config) as Config) : null;
  const brief = JSON.parse(t.brief) as EditorialBrief;
  const src = await first<{ skill: string | null }>(
    c.env.DB,
    "SELECT skill FROM sources WHERE id = ?",
    t.source,
  );
  const skill =
    cfg?.mode === "7"
      ? src?.skill || cfg?.skill || "zaid"
      : src?.skill || cfg?.skill || "editorial";
  const id = uuid();
  // Keep a copy of the result as the look's reminder image, so deleting the batch later does not lose it.
  let image: string | null = null;
  if (t.output) {
    const obj = await c.env.BUCKET.get(t.output);
    if (obj) {
      image = `looks/${id}.${t.output.split(".").pop() || "png"}`;
      await c.env.BUCKET.put(image, obj.body, {
        httpMetadata: { contentType: obj.httpMetadata?.contentType || "image/png" },
      });
    }
  }
  await run(
    c.env.DB,
    "INSERT INTO looks (id, skill, name, prompt, negative, scene, pose, light, image, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    skill,
    name,
    brief.prompt,
    brief.negative ?? "",
    brief.scene ?? "",
    brief.pose ?? "",
    brief.light ?? "",
    image,
    c.get("user").id,
    now(),
  );
  return c.json({ ok: true, id, skill });
});

studioRoutes.get("/looks/:id/image", async (c) => {
  const row = await first<{ image: string | null }>(
    c.env.DB,
    "SELECT image FROM looks WHERE id = ?",
    c.req.param("id"),
  );
  const obj = row?.image ? await c.env.BUCKET.get(row.image) : null;
  if (!obj) throw new StudioError("No image for this look.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": "private, max-age=86400",
    },
  });
});

studioRoutes.delete("/looks/:id", async (c) => {
  const row = await first<{ image: string | null }>(
    c.env.DB,
    "SELECT image FROM looks WHERE id = ?",
    c.req.param("id"),
  );
  if (row?.image) await c.env.BUCKET.delete(row.image);
  await run(c.env.DB, "DELETE FROM looks WHERE id = ?", c.req.param("id"));
  return c.json({ ok: true });
});

studioRoutes.post("/skills/order", async (c) => {
  const { ids } = await body(c, z.object({ ids: z.array(z.string().max(60)).max(200) }));
  await saveSkillsOrder(c.env, ids);
  return c.json({ ok: true, skills: await listSkills(c.env, c.get("user").id) });
});

studioRoutes.post("/skills/:id/favourite", async (c) => {
  const { on } = await body(c, z.object({ on: z.boolean() }));
  await setFavourite(c.env, c.get("user").id, c.req.param("id"), on);
  return c.json({ ok: true, skills: await listSkills(c.env, c.get("user").id) });
});

const skillBody = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/, "Use lowercase letters, digits and dashes for the id.")
    .optional(),
  title: z.string().trim().min(2).max(60),
  caption: z.string().trim().max(80).default(""),
  description: z.string().trim().max(400).default(""),
  goal: z.string().trim().max(20000).default(""),
  library: z.string().trim().max(20000).default(""),
  /** true keeps the skill on automatic text (written from its photos); false means the team wrote it. */
  auto: z.boolean().optional(),
});

studioRoutes.post("/skills", async (c) => {
  const d = await body(c, skillBody);
  if (d.id === "zaid")
    throw new StudioError("The creative direction is edited from its own workflow.");
  const goal =
    d.goal ||
    `Goal: write ONE prompt for "${d.title}". The reference photos in this skill's library are the creative source: build the scene, pose and stance, light and camera angle from the attached reference as a sibling of it. The garment, footwear and accessories stay exactly as supplied; the output keeps the upload's framing.`;
  // A skill saved with its own text is manual; a name-only skill stays automatic.
  const auto = d.auto ?? !d.goal;
  const id =
    d.id ||
    d.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) ||
    uuid().slice(0, 8);
  await run(
    c.env.DB,
    `INSERT INTO skills (id, title, caption, description, goal, library, hidden, auto, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, caption = excluded.caption, description = excluded.description,
       goal = excluded.goal, library = excluded.library, hidden = 0, auto = excluded.auto, updated = excluded.updated`,
    id,
    d.title,
    d.caption,
    d.description,
    goal,
    d.library,
    auto ? 1 : 0,
    now(),
    now(),
  );
  return c.json({ ok: true, id, skills: await listSkills(c.env, c.get("user").id) });
});

/**
 * Writes a skill's direction and library from its reference photos. With `save` the result is
 * stored and the skill stays automatic (the panel calls this after every library change);
 * without it the texts come back for review in the editor.
 */
studioRoutes.post("/skills/:id/analyze", async (c) => {
  const id = c.req.param("id");
  const { title, save } = await body(
    c,
    z.object({ title: z.string().trim().min(2).max(60), save: z.boolean().optional() }),
  );
  const rows = await all<{ key: string }>(
    c.env.DB,
    "SELECT key FROM refs WHERE skill = ? ORDER BY created LIMIT 10",
    id,
  );
  const images = [];
  for (const r of rows) {
    const obj = await c.env.BUCKET.get(r.key);
    if (obj)
      images.push({
        bytes: await obj.arrayBuffer(),
        mime: obj.httpMetadata?.contentType || "image/jpeg",
      });
  }
  const built = await buildSkillFromReferences(c.env, title, images);
  if (save) {
    const current = (await listSkills(c.env, c.get("user").id)).find((s) => s.id === id);
    await run(
      c.env.DB,
      `INSERT INTO skills (id, title, caption, description, goal, library, hidden, auto, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET goal = excluded.goal, library = excluded.library, description = excluded.description,
         hidden = 0, auto = 1, updated = excluded.updated`,
      id,
      current?.title ?? title,
      current?.caption ?? "",
      built.description,
      built.goal,
      built.library,
      now(),
      now(),
    );
    return c.json({ ...built, skills: await listSkills(c.env, c.get("user").id) });
  }
  return c.json(built);
});

/** Built-in skills are hidden (and any edit of them dropped); custom ones are removed. Reference photos stay. */
studioRoutes.delete("/skills/:id", async (c) => {
  const id = c.req.param("id");
  const visible = await listSkills(c.env, c.get("user").id);
  if (visible.length <= 1 && visible.some((s) => s.id === id))
    throw new StudioError("Keep at least one skill. Create another one before deleting this.");
  if (SKILLS.some((s) => s.id === id)) {
    await run(
      c.env.DB,
      `INSERT INTO skills (id, title, caption, description, goal, library, hidden, created, updated)
       VALUES (?, ?, '', '', '', '', 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET hidden = 1, updated = excluded.updated`,
      id,
      id,
      now(),
      now(),
    );
  } else {
    await run(c.env.DB, "DELETE FROM skills WHERE id = ?", id);
  }
  return c.json({ ok: true, skills: await listSkills(c.env, c.get("user").id) });
});

/** Restores a hidden built-in skill to its original text. */
studioRoutes.post("/skills/:id/reset", async (c) => {
  const id = c.req.param("id");
  if (!SKILLS.some((s) => s.id === id)) throw new StudioError("Only built-in skills can be reset.");
  await run(c.env.DB, "DELETE FROM skills WHERE id = ?", id);
  return c.json({ ok: true, skills: await listSkills(c.env, c.get("user").id) });
});

/** Reference library: inspiration photos per skill (background, pose and light only). */
const MAX_REFERENCE_UPLOAD = 12 * 1024 * 1024;
const skillRef = z.object({ skill: z.string().regex(/^[a-z0-9-]{1,40}$/) });

studioRoutes.get("/references", async (c) => {
  const { skill } = skillRef.parse({ skill: c.req.query("skill") ?? "" });
  const items = await all<{
    id: string;
    name: string | null;
    created: number;
    framing: string | null;
  }>(
    c.env.DB,
    "SELECT id, name, created, framing FROM refs WHERE skill = ? ORDER BY created",
    skill,
  );
  return c.json({ references: items });
});

studioRoutes.post("/references", async (c) => {
  const form = await c.req.formData();
  const { skill } = skillRef.parse({ skill: String(form.get("skill") ?? "") });
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!files.length) throw new StudioError("Choose at least one image.");
  const added: string[] = [];
  for (const raw of files.slice(0, 20)) {
    const f = checkImage(raw, MAX_REFERENCE_UPLOAD, "Reference");
    const id = uuid();
    const key = `refs/${skill}/${id}`;
    const bytes = await f.arrayBuffer();
    await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: f.type } });
    // A pose photo is classified once (full, three-quarter, upper or lower body) so an upload only
    // ever borrows a pose with the same framing.
    // Backgrounds and poses are read once as well (light, shadows, camera, standing spot; stance,
    // hands, gaze) so every batch can tell the engine in words what the photo shows.
    let framing: string | null = null;
    let notes: string | null = null;
    const image = { bytes, mime: f.type };
    if (skill === NP_POSES) {
      try {
        framing = (await runFramingCheck(c.env, image)).framing;
      } catch (e) {
        console.error("[references] pose check failed", errorMessage(e));
      }
    }
    if (skill === NP_POSES || skill === NP_BACKGROUNDS) {
      try {
        notes =
          (await runReferenceRead(c.env, image, skill === NP_POSES ? "pose" : "scene")) || null;
      } catch (e) {
        console.error("[references] read failed", errorMessage(e));
      }
    }
    await run(
      c.env.DB,
      "INSERT INTO refs (id, skill, key, name, framing, notes, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      skill,
      key,
      f.name.slice(0, 120),
      framing,
      notes,
      now(),
    );
    added.push(id);
  }
  return c.json({ ok: true, added });
});

studioRoutes.delete("/references/:id", async (c) => {
  const id = c.req.param("id");
  const row = await first<{ key: string }>(c.env.DB, "SELECT key FROM refs WHERE id = ?", id);
  if (!row) throw new StudioError("Reference not found.", 404);
  await c.env.BUCKET.delete(row.key);
  await run(c.env.DB, "DELETE FROM refs WHERE id = ?", id);
  await deleteSetting(c.env, `ref_url_${id}`);
  return c.json({ ok: true });
});

studioRoutes.get("/references/:id/file", async (c) => {
  const id = c.req.param("id");
  const row = await first<{ key: string }>(c.env.DB, "SELECT key FROM refs WHERE id = ?", id);
  const obj = row ? await c.env.BUCKET.get(row.key) : null;
  if (!obj) throw new StudioError("Reference not found.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
});

/** Looping hero video for the studio page (admin-uploaded, stored in R2). Supports byte ranges. */
studioRoutes.get("/hero", async (c) => {
  const HERO_KEY = HERO_KEYS[c.req.query("f") === "webm" ? "webm" : "mp4"];
  const range = c.req.header("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  const head = await c.env.BUCKET.head(HERO_KEY);
  if (!head) throw new StudioError("No hero video.", 404);
  const size = head.size;
  const type = head.httpMetadata?.contentType || "video/mp4";
  const base = {
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    "Cache-Control": "private, max-age=3600",
  };
  if (!m) {
    const obj = await c.env.BUCKET.get(HERO_KEY);
    if (!obj) throw new StudioError("No hero video.", 404);
    return new Response(obj.body, { headers: { ...base, "Content-Length": String(size) } });
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const obj = await c.env.BUCKET.get(HERO_KEY, {
    range: { offset: start, length: end - start + 1 },
  });
  if (!obj) throw new StudioError("No hero video.", 404);
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...base,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
});

/** Raw Higgsfield model catalogue for the connected key. */
studioRoutes.get("/engine/catalog", async (c) => {
  return c.json(await (await makeClient(c.env)).catalog());
});

studioRoutes.get("/engine/models", async (c) => {
  const refresh = c.req.query("refresh") === "1";
  if (!refresh) {
    const cached = await getSetting(c.env, MODELS_CACHE);
    if (cached) {
      const parsed = JSON.parse(cached) as { at: number; models: { slug: string }[] };
      // A cache from before a model was added to the lists is stale, whatever its age.
      const known = new Set(parsed.models.map((m) => m.slug));
      const complete = GOOGLE_MODELS.every((m) => known.has(m.slug));
      if (complete && now() - parsed.at < 60 * 60 * 1000)
        return c.json({ models: parsed.models, cached: true });
    }
  }
  const models: { slug: string; name: string; enabled: boolean; reason: string }[] = [];
  const googleAuth = (await resolveGoogleAuth(c.env)).auth;
  if (googleAuth) {
    try {
      const g = await makeGoogleClient(c.env);
      for (const m of GOOGLE_MODELS) {
        const ok = await g.hasModel(m.slug);
        models.push({ ...m, enabled: ok, reason: ok ? "" : "not available to this Google key" });
      }
    } catch (e) {
      for (const m of GOOGLE_MODELS) models.push({ ...m, enabled: false, reason: errorMessage(e) });
    }
  } else {
    for (const m of GOOGLE_MODELS)
      models.push({ ...m, enabled: false, reason: "add a Google key" });
  }
  const openaiKey = (await resolveOpenAIKey(c.env)).key;
  if (openaiKey) {
    try {
      const oa = await makeOpenAIClient(c.env, openaiKey);
      for (const m of OPENAI_MODELS) {
        const ok = await oa.hasModel(m.slug);
        models.push({
          ...m,
          enabled: ok,
          reason: ok ? "" : "not available on this OpenAI account",
        });
      }
    } catch (e) {
      for (const m of OPENAI_MODELS) models.push({ ...m, enabled: false, reason: errorMessage(e) });
    }
  } else {
    for (const m of OPENAI_MODELS)
      models.push({ ...m, enabled: false, reason: "add an OpenAI key" });
  }
  const falKey = (await resolveFalKey(c.env)).key;
  if (falKey) {
    let reason = "";
    try {
      const check = await (await makeFalClient(c.env, falKey)).verify();
      if (!check.ok) reason = check.message;
    } catch (e) {
      reason = errorMessage(e);
    }
    for (const m of FAL_MODELS) models.push({ ...m, enabled: !reason, reason });
  } else {
    for (const m of FAL_MODELS) models.push({ ...m, enabled: false, reason: "add a fal.ai key" });
  }
  if (await engineConfigured(c.env)) {
    const client = await makeClient(c.env);
    const probed = await Promise.all(
      MODEL_CANDIDATES.map(async (m) => {
        try {
          const r = await client.probeModel(m.slug);
          const code = r.detail.trim().toLowerCase();
          const enabled =
            r.status !== 404 && code !== "model_not_found" && code !== "model_disabled";
          return { ...m, enabled, reason: enabled ? "" : code || `HTTP ${r.status}` };
        } catch (e) {
          return { ...m, enabled: false, reason: errorMessage(e) };
        }
      }),
    );
    models.push(...probed);
  } else {
    for (const m of MODEL_CANDIDATES)
      models.push({ ...m, enabled: false, reason: "add a Higgsfield key" });
  }
  // Never cache a scan in which nothing answered (network trouble), so the next open re-probes.
  if (models.some((m) => m.enabled))
    await setSetting(c.env, MODELS_CACHE, JSON.stringify({ at: now(), models }));
  return c.json({ models });
});

studioRoutes.get("/engine/verify", async (c) => {
  if (!(await engineConfigured(c.env)))
    return c.json({ ok: false, message: "No Higgsfield API key is configured." });
  try {
    return c.json(await (await makeClient(c.env)).verify());
  } catch (e) {
    return c.json({ ok: false, message: errorMessage(e) });
  }
});

/** Save the engine key from the app. It is verified against Higgsfield first and stored encrypted. */
studioRoutes.post("/engine/key", async (c) => {
  if (c.env.HIGGSFIELD_API_KEY)
    throw new StudioError("The key is managed as a Worker secret on this deployment.", 409);
  const { key } = await body(c, z.object({ key: z.string().trim().min(3).max(500) }));
  if (!keyLooksValid(key))
    throw new StudioError(
      "Enter the key as KEY_ID:KEY_SECRET (both parts from cloud.higgsfield.ai).",
    );
  const check = await (await makeClient(c.env, key)).verify();
  if (!check.ok) throw new StudioError(`Higgsfield rejected this key: ${check.message}`, 400);
  await setSetting(c.env, ENGINE_KEY_SETTING, key);
  return c.json({ ok: true, message: check.message });
});

/** Diagnostic used to find the right model slug: reports the API's answer for a slug without generating. */
studioRoutes.get("/engine/probe", async (c) => {
  const slug = (c.req.query("slug") ?? "").trim();
  if (!slug || slug.length > 120 || !/^[\w./-]+$/.test(slug))
    throw new StudioError("Invalid slug.");
  const raw = c.req.query("body");
  let body = "{}";
  if (raw) {
    try {
      body = JSON.stringify(JSON.parse(raw));
    } catch {
      throw new StudioError("Probe body must be JSON.");
    }
  }
  return c.json(await (await makeClient(c.env)).probeModel(slug, body));
});

/** Save the model slug after checking that Higgsfield knows it and has it enabled. */
studioRoutes.post("/engine/model", async (c) => {
  const { model } = await body(c, z.object({ model: z.string().trim().min(1).max(120) }));
  if (!/^[\w./-]+$/.test(model)) throw new StudioError("Invalid model slug.");
  if (GOOGLE_MODELS.some((m) => m.slug === model)) {
    const g = await makeGoogleClient(c.env);
    if (!(await g.hasModel(model)))
      throw new StudioError(`"${model}" is not available to your Google key.`);
    await setSetting(c.env, ENGINE_MODEL_SETTING, model);
    return c.json({ ok: true, message: `Model "${model}" is available.` });
  }
  if (FAL_MODELS.some((m) => m.slug === model)) {
    const check = await (await makeFalClient(c.env)).verify();
    if (!check.ok) throw new StudioError(`fal.ai key problem: ${check.message}`);
    await setSetting(c.env, ENGINE_MODEL_SETTING, model);
    return c.json({ ok: true, message: `Model "${model}" is available.` });
  }
  if (OPENAI_MODELS.some((m) => m.slug === model)) {
    const oa = await makeOpenAIClient(c.env);
    if (!(await oa.hasModel(model)))
      throw new StudioError(`"${model}" is not available on your OpenAI account.`);
    await setSetting(c.env, ENGINE_MODEL_SETTING, model);
    return c.json({ ok: true, message: `Model "${model}" is available.` });
  }
  const probe = await (await makeClient(c.env)).probeModel(model);
  const code = probe.detail.trim().toLowerCase();
  if (probe.status === 404 || code === "model_not_found")
    throw new StudioError(`Higgsfield does not know a model called "${model}".`);
  if (code === "model_disabled")
    throw new StudioError(`"${model}" exists but is disabled on your Higgsfield account.`);
  await setSetting(c.env, ENGINE_MODEL_SETTING, model);
  const note =
    code === "not_enough_credits" ? " Note: your Higgsfield account has no credits yet." : "";
  return c.json({ ok: true, message: `Model "${model}" is available.${note}` });
});

studioRoutes.delete("/engine/key", async (c) => {
  await deleteSetting(c.env, ENGINE_KEY_SETTING);
  return c.json({ ok: true });
});

const newBatch = z.object({ name: z.string().max(100).optional(), config: configSchema });
/** A month of the same client, month and name created again inside this window is the same month. */
export const BATCH_TWIN_WINDOW_MS = 60_000;

studioRoutes.post("/batch", async (c) => {
  const user = c.get("user");
  const parsed = newBatch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.filter((p) => p !== "config").join(".") || "settings";
    throw new StudioError(`Invalid batch settings: ${field} ${issue?.message ?? "is invalid"}.`);
  }
  const config = parsed.data.config;
  if (!config.model) config.model = await resolveEngineModel(c.env);
  if (config.model && !/^[\w./-]+$/.test(config.model))
    throw new StudioError("Invalid model slug.");
  const problem = validateConfig(config);
  if (problem) throw new StudioError(problem);
  const client = await requireActiveClient(c.env, config.client);
  if (config.identity) {
    const identity = await first(
      c.env.DB,
      "SELECT id FROM identities WHERE id = ? AND owner = ?",
      config.identity,
      user.id,
    );
    if (!identity) throw new StudioError("Identity reference not found.");
  }
  const name = (
    parsed.data.name ||
    (config.mode === "post" && config.month
      ? `${client.name} · ${config.month}`
      : `${client.name} · ${new Date().toLocaleDateString("en-GB")}`)
  ).slice(0, 100);
  // One month per click: the same month asked for again within a minute (a double click, a request
  // sent twice, an effect that ran again) is the month just made, not a second empty one.
  const month = config.mode === "post" && config.month ? config.month : null;
  if (month) {
    const twin = await first<{ id: string }>(
      c.env.DB,
      "SELECT id FROM batches WHERE owner = ? AND client = ? AND month = ? AND name = ? AND deleted IS NULL AND created >= ? ORDER BY created DESC LIMIT 1",
      user.id,
      client.id,
      month,
      name,
      now() - BATCH_TWIN_WINDOW_MS,
    );
    if (twin) return c.json({ id: twin.id, existing: true });
  }
  // Requests that run at the same time never see each other above, so a month's id inside one
  // window is fixed by what it is: the same request twice is one row, and the second gets the first's id.
  const id = month ? await twinBatchId(`${user.id}|${client.id}|${month}|${name}|${Math.floor(now() / BATCH_TWIN_WINDOW_MS)}`) : uuid();
  const inserted = await run(
    c.env.DB,
    "INSERT OR IGNORE INTO batches (id, owner, name, config, client, month, theme, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)",
    id,
    user.id,
    name,
    JSON.stringify(config),
    client.id,
    month,
    config.theme ?? null,
    now(),
    now(),
  );
  if (inserted) return c.json({ id });
  const taken = await first<{ deleted: number | null; created: number }>(c.env.DB, "SELECT deleted, created FROM batches WHERE id = ?", id);
  if (taken && taken.deleted === null && taken.created >= now() - BATCH_TWIN_WINDOW_MS) return c.json({ id, existing: true });
  // The twin of this minute was binned already (or is older than the window): this one is made afresh under its own id.
  const fresh = uuid();
  await run(
    c.env.DB,
    "INSERT INTO batches (id, owner, name, config, client, month, theme, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)",
    fresh,
    user.id,
    name,
    JSON.stringify(config),
    client.id,
    month,
    config.theme ?? null,
    now(),
    now(),
  );
  return c.json({ id: fresh });
});

/** A UUID-shaped id fixed by the month's key (owner, client, month, name, minute): the same request twice is one row. */
async function twinBatchId(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Edit a saved batch's creative direction. The workflow (mode) is fixed because it defines the card
 * structure; everything else can change. Queued tasks get fresh prompts, and the number of cards per
 * source is grown or shrunk (only never-generated cards are removed).
 */
studioRoutes.post("/batch/config", async (c) => {
  const user = c.get("user");
  const parsed = z
    .object({
      batch: z.string().min(1),
      name: z.string().max(100).optional(),
      config: configSchema,
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.filter((p) => p !== "config").join(".") || "settings";
    throw new StudioError(`Invalid batch settings: ${field} ${issue?.message ?? "is invalid"}.`);
  }
  const b = await ownedBatch(c.env, user, parsed.data.batch);
  if (b.state === "running")
    throw new StudioError("Pause the batch before editing its settings.", 409);
  const previous = JSON.parse(b.config) as Config;
  // The workflow and the client are fixed once a batch exists.
  const config = { ...parsed.data.config, mode: previous.mode, client: previous.client };
  if (!config.model) config.model = await resolveEngineModel(c.env);
  if (config.model && !/^[\w./-]+$/.test(config.model))
    throw new StudioError("Invalid model slug.");
  const problem = validateConfig(config);
  if (problem) throw new StudioError(problem);

  const statements = [
    c.env.DB.prepare("UPDATE batches SET config = ?, name = ?, updated = ? WHERE id = ?").bind(
      JSON.stringify(config),
      (parsed.data.name || b.name).slice(0, 100),
      now(),
      b.id,
    ),
  ];
  const wanted = cardsPerSource(config);
  const sources = await all<{ id: string; role: string }>(
    c.env.DB,
    "SELECT id, role FROM sources WHERE batch = ?",
    b.id,
  );
  for (const src of sources) {
    if (!createsTasks(config, src.role as "lead" | "supporting")) continue;
    const tasks = await all<{ id: string; card: number; status: string; output: string | null }>(
      c.env.DB,
      "SELECT id, card, status, output FROM tasks WHERE batch = ? AND source = ? ORDER BY card",
      b.id,
      src.id,
    );
    const have = new Set(tasks.map((t) => t.card));
    for (let card = 1; card <= wanted; card++) {
      if (!have.has(card))
        statements.push(
          c.env.DB.prepare(
            "INSERT INTO tasks (id, batch, source, card, status, prompt, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
          ).bind(uuid(), b.id, src.id, card, buildPrompt(config, card), now()),
        );
    }
    for (const t of tasks) {
      if (t.card > wanted && !t.output && t.status !== "processing")
        statements.push(c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(t.id));
      else if (t.status === "queued" || t.status === "failed")
        statements.push(
          c.env.DB.prepare("UPDATE tasks SET prompt = ?, brief = NULL WHERE id = ?").bind(
            buildPrompt(config, t.card),
            t.id,
          ),
        );
    }
  }
  await c.env.DB.batch(statements);
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, user, b.id), c.get("user")));
});

studioRoutes.get("/batch", async (c) => {
  const b = await ownedBatch(c.env, c.get("user"), c.req.query("batch"));
  return c.json(await batchPayload(c.env, b, c.get("user")));
});

/**
 * Delete a month: it goes to the bin, out of every list, with its pictures and rows untouched, and
 * can come back for TRASH_DAYS. "forever" purges a month that is already in the bin.
 */
studioRoutes.delete("/batch", async (c) => {
  const user = c.get("user");
  if (c.req.query("forever") === "1") {
    const b = await binnedBatch(c.env, user, c.req.query("batch"));
    await purgeBatch(c.env, b);
    return c.json({ ok: true, purged: true });
  }
  const b = await ownedBatch(c.env, user, c.req.query("batch"));
  if (b.state === "running") throw new StudioError("Posts are being made: pause the month first.", 409);
  await run(c.env.DB, "UPDATE batches SET deleted = ?, state = 'idle', updated = ? WHERE id = ?", now(), now(), b.id);
  return c.json({ ok: true, binned: true });
});

/** A month back from the bin, exactly as it was. */
studioRoutes.post("/batch/restore", async (c) => {
  const user = c.get("user");
  const { batch } = await body(c, z.object({ batch: z.string().min(1) }));
  const b = await binnedBatch(c.env, user, batch);
  await run(c.env.DB, "UPDATE batches SET deleted = NULL, updated = ? WHERE id = ?", now(), b.id);
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, user, b.id), user));
});

function checkImage(f: unknown, max: number, label: string): File {
  if (!(f instanceof File)) throw new StudioError(`${label} is missing.`);
  if (!IMAGE_TYPES.includes(f.type)) throw new StudioError(`${label}: use JPG, PNG or WebP.`);
  if (f.size > max)
    throw new StudioError(`${label}: file is over ${Math.round(max / 1048576)} MB.`);
  return f;
}

studioRoutes.post("/identity", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData();
  const f = checkImage(form.get("file"), MAX_IDENTITY, "Identity reference");
  const id = uuid();
  const key = `${user.id}/identity/${id}`;
  await c.env.BUCKET.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
  await run(
    c.env.DB,
    "INSERT INTO identities (id, owner, key, name, created) VALUES (?, ?, ?, ?, ?)",
    id,
    user.id,
    key,
    String(form.get("name") || f.name).slice(0, 200),
    now(),
  );
  return c.json({ id });
});

studioRoutes.post("/upload", async (c) => {
  const user = c.get("user");
  const b = await ownedBatch(c.env, user, c.req.query("batch"));
  const config = JSON.parse(b.config) as Config;
  const form = await c.req.formData();
  const f = checkImage(form.get("file"), MAX_UPLOAD, "Image");
  const name = relativeUploadName(String(form.get("name") || ""), f.name).normalize("NFC");
  if (!isValidSourceName(name)) throw new StudioError("Unsupported filename.");
  const stem = stemKey(name);
  const duplicate = await first(
    c.env.DB,
    "SELECT id FROM sources WHERE batch = ? AND stem = ?",
    b.id,
    stem,
  );
  if (duplicate)
    throw new StudioError(`Duplicate upload: ${stemOf(name)} is already in this batch.`, 409);

  const role = form.get("role") === "supporting" ? "supporting" : "lead";
  const id = uuid();
  const key = `${user.id}/${b.id}/source/${id}`;
  await c.env.BUCKET.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
  let referenceKey: string | null = null;
  const reference = form.get("reference");
  if (
    reference instanceof File &&
    reference.type === "image/jpeg" &&
    reference.size <= MAX_REFERENCE
  ) {
    referenceKey = `${key}.reference`;
    await c.env.BUCKET.put(referenceKey, reference.stream(), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }
  try {
    const statements = [
      c.env.DB.prepare(
        "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, b.id, name, stem, key, referenceKey, f.type, f.size, role, now()),
    ];
    if (createsTasks(config, role)) {
      for (let card = 1; card <= cardsPerSource(config); card++) {
        statements.push(
          c.env.DB.prepare(
            "INSERT INTO tasks (id, batch, source, card, status, prompt, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
          ).bind(uuid(), b.id, id, card, buildPrompt(config, card), now()),
        );
      }
    }
    await c.env.DB.batch(statements);
  } catch (e) {
    await c.env.BUCKET.delete([key, ...(referenceKey ? [referenceKey] : [])]);
    throw e;
  }
  await run(c.env.DB, "UPDATE batches SET updated = ? WHERE id = ?", now(), b.id);
  // A product photo is read right away, so writing the ideas later does not wait for it.
  if (config.mode === "post")
    c.executionCtx.waitUntil(
      describeUpload(c.env, id).catch((e) => console.error("[upload] describe", errorMessage(e))),
    );
  return c.json({ id });
});

studioRoutes.get("/file", async (c) => {
  const b = await ownedBatch(c.env, c.get("user"), c.req.query("batch"));
  const id = c.req.query("id") ?? "";
  const kind = c.req.query("kind") ?? "result";
  let key: string | null = null;
  let filename = "image";
  if (kind === "original" || kind === "reference") {
    const row = await first<{ key: string; reference_key: string | null; name: string }>(
      c.env.DB,
      "SELECT key, reference_key, name FROM sources WHERE id = ? AND batch = ?",
      id,
      b.id,
    );
    key = kind === "reference" ? (row?.reference_key ?? row?.key ?? null) : (row?.key ?? null);
    filename = row?.name ?? filename;
  } else {
    const row = await first<{ output: string | null }>(
      c.env.DB,
      "SELECT output FROM tasks WHERE id = ? AND batch = ?",
      id,
      b.id,
    );
    key = row?.output ?? null;
  }
  if (!key) throw new StudioError("Image not found.", 404);
  // A card asks for a smaller copy (made once, kept); a versioned address is kept for a year.
  const w = kind === "result" ? thumbWidth(c.req.query("w")) : null;
  const keep = c.req.query("v") ? "private, max-age=31536000, immutable" : "private, max-age=3600";
  if (w) {
    const small = await resizedPicture(c.env, key, w);
    if (!small) throw new StudioError("Image not found.", 404);
    return new Response(small.bytes, { headers: { "Content-Type": small.mime, "Cache-Control": keep, "X-Content-Type-Options": "nosniff" } });
  }
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw new StudioError("Image not found.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": keep,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
});

/** A short-lived public link to one of the caller's originals or results (what fal.ai is given). */
studioRoutes.get("/file-link", async (c) => {
  const b = await ownedBatch(c.env, c.get("user"), c.req.query("batch"));
  const id = c.req.query("id") ?? "";
  const kind = c.req.query("kind") ?? "result";
  let key: string | null = null;
  if (kind === "original" || kind === "reference") {
    const row = await first<{ key: string; reference_key: string | null }>(
      c.env.DB,
      "SELECT key, reference_key FROM sources WHERE id = ? AND batch = ?",
      id,
      b.id,
    );
    key = kind === "reference" ? (row?.reference_key ?? row?.key ?? null) : (row?.key ?? null);
  } else {
    const row = await first<{ output: string | null }>(
      c.env.DB,
      "SELECT output FROM tasks WHERE id = ? AND batch = ?",
      id,
      b.id,
    );
    key = row?.output ?? null;
  }
  if (!key) throw new StudioError("Image not found.", 404);
  return c.json({ url: await signObjectUrl(c.env, key) });
});

const batchRef = z.object({ batch: z.string().min(1) });
const taskRef = batchRef.extend({ id: z.string().min(1) });

async function body<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid request.");
  return parsed.data;
}

studioRoutes.post("/start", async (c) => {
  const { batch } = await body(c, batchRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  if (
    !(await engineConfigured(c.env)) &&
    !(await resolveGoogleKey(c.env)).key &&
    !(await resolveOpenAIKey(c.env)).key &&
    !(await resolveFalKey(c.env)).key
  )
    throw new StudioError("No image engine is connected. Add an API key in Connection.", 428);
  await run(
    c.env.DB,
    "UPDATE batches SET state = 'running', last_error = NULL, updated = ? WHERE id = ?",
    now(),
    b.id,
  );
  // The first pass (framing checks, prompt building, submissions) runs after the response: the
  // click answers at once, and the tick and the cron carry on if this invocation is cut short.
  // Running it inline made the start request itself fail when the pass outgrew the request.
  c.executionCtx.waitUntil(
    advanceBatch(c.env, b.id, {
      background: (p) => c.executionCtx.waitUntil(p),
      deferSync: true,
    }).catch((e) => console.error("[start] first pass failed", e)),
  );
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, c.get("user"), b.id), c.get("user")));
});

studioRoutes.post("/pause", async (c) => {
  const { batch } = await body(c, batchRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  await run(
    c.env.DB,
    "UPDATE batches SET state = 'paused', updated = ? WHERE id = ? AND state = 'running'",
    now(),
    b.id,
  );
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, c.get("user"), b.id), c.get("user")));
});

studioRoutes.post("/tick", async (c) => {
  const { batch } = await body(c, batchRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  // The tick keeps its connection open until the synchronous generations it started have been
  // saved, so they are never cut off by the post-response waitUntil limit.
  const jobs: Promise<unknown>[] = [];
  await advanceBatch(c.env, b.id, {
    background: (p) => {
      jobs.push(p);
      // Also registered with the runtime so a reload or closed tab does not cut the work short.
      c.executionCtx.waitUntil(p.catch(() => {}));
    },
  });
  // Finished images refill their slots with new jobs while the tick is held, so wait for those too.
  for (let i = 0; i < jobs.length; i++) await jobs[i].catch(() => {});
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, c.get("user"), b.id), c.get("user")));
});

studioRoutes.post("/retry", async (c) => {
  const { batch } = await body(c, batchRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  await run(
    c.env.DB,
    // A failed image gets a freshly written prompt on retry (the cached brief may be what was refused).
    "UPDATE tasks SET status = 'queued', error = NULL, brief = NULL, updated = ? WHERE batch = ? AND status = 'failed'",
    now(),
    b.id,
  );
  await run(
    c.env.DB,
    "UPDATE batches SET state = 'running', last_error = NULL, updated = ? WHERE id = ?",
    now(),
    b.id,
  );
  await advanceBatch(c.env, b.id, {
    background: (p) => c.executionCtx.waitUntil(p),
    deferSync: true,
  });
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, c.get("user"), b.id), c.get("user")));
});

studioRoutes.post("/revise", async (c) => {
  const { batch, id, edit } = await body(
    c,
    taskRef.extend({ edit: z.string().trim().min(1).max(3000) }),
  );
  const b = await ownedBatch(c.env, c.get("user"), batch);
  const changed = await run(
    c.env.DB,
    "UPDATE tasks SET status = 'queued', edit = ?, preflight = NULL, error = NULL, updated = ? WHERE id = ? AND batch = ? AND output IS NOT NULL AND status IN ('ready','review','approved','failed')",
    edit,
    now(),
    id,
    b.id,
  );
  if (!changed) throw new StudioError("This image cannot be revised right now.", 409);
  await run(
    c.env.DB,
    "UPDATE batches SET state = 'running', last_error = NULL, updated = ? WHERE id = ?",
    now(),
    b.id,
  );
  await advanceBatch(c.env, b.id, {
    background: (p) => c.executionCtx.waitUntil(p),
    deferSync: true,
  });
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, c.get("user"), b.id), c.get("user")));
});

/** Zaid creative direction: run some photos of a saved batch with another skill. */
studioRoutes.post("/sources/skill", async (c) => {
  const { batch, ids, skill } = await body(
    c,
    z.object({
      batch: z.string(),
      ids: z.array(z.string()).min(1).max(500),
      skill: z.string().max(60).nullable(),
    }),
  );
  const b = await ownedBatch(c.env, c.get("user"), batch);
  if (b.state === "running")
    throw new StudioError("Pause the batch before changing which skill a photo uses.", 409);
  for (const id of ids) {
    await run(c.env.DB, "UPDATE sources SET skill = ? WHERE id = ? AND batch = ?", skill, id, b.id);
    // Prompts not yet generated are rewritten with the new skill on the next pass.
    await run(
      c.env.DB,
      "UPDATE tasks SET brief = NULL, prompt = '' WHERE source = ? AND batch = ? AND output IS NULL AND status NOT IN ('processing','finalizing')",
      id,
      b.id,
    );
  }
  return c.json(await batchPayload(c.env, b, c.get("user")));
});

studioRoutes.post("/approve", async (c) => {
  const { batch, id } = await body(c, taskRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  const changed = await run(
    c.env.DB,
    "UPDATE tasks SET status = 'approved', updated = ? WHERE id = ? AND batch = ? AND output IS NOT NULL AND status IN ('ready','review')",
    now(),
    id,
    b.id,
  );
  if (!changed) throw new StudioError("Image is not ready for approval.", 409);
  return c.json({ ok: true });
});

studioRoutes.post("/approve-all", async (c) => {
  const { batch } = await body(c, batchRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  const changed = await run(
    c.env.DB,
    "UPDATE tasks SET status = 'approved', updated = ? WHERE batch = ? AND status = 'ready' AND output IS NOT NULL",
    now(),
    b.id,
  );
  return c.json({ ok: true, approved: changed });
});

studioRoutes.get("/presets", async (c) => {
  const presets = await all<Preset>(
    c.env.DB,
    "SELECT id, name, config, created FROM presets WHERE owner = ? ORDER BY created DESC LIMIT 100",
    c.get("user").id,
  );
  return c.json({ presets });
});

studioRoutes.post("/presets", async (c) => {
  const { name, config } = await body(
    c,
    z.object({ name: z.string().trim().min(1).max(80), config: configSchema }),
  );
  const id = uuid();
  await run(
    c.env.DB,
    "INSERT INTO presets (id, owner, name, config, created) VALUES (?, ?, ?, ?, ?)",
    id,
    c.get("user").id,
    name,
    JSON.stringify(config),
    now(),
  );
  return c.json({ id });
});

studioRoutes.delete("/presets", async (c) => {
  await run(
    c.env.DB,
    "DELETE FROM presets WHERE id = ? AND owner = ?",
    c.req.query("id") ?? "",
    c.get("user").id,
  );
  return c.json({ ok: true });
});

studioRoutes.post("/task/retry", async (c) => {
  const { batch, id } = await body(c, taskRef);
  const b = await ownedBatch(c.env, c.get("user"), batch);
  const changed = await run(
    c.env.DB,
    "UPDATE tasks SET status = 'queued', error = NULL, brief = NULL, updated = ? WHERE id = ? AND batch = ? AND status = 'failed'",
    now(),
    id,
    b.id,
  );
  if (!changed) throw new StudioError("Only failed images can be retried.", 409);
  await run(
    c.env.DB,
    "UPDATE batches SET state = 'running', last_error = NULL, updated = ? WHERE id = ?",
    now(),
    b.id,
  );
  await advanceBatch(c.env, b.id, {
    background: (p) => c.executionCtx.waitUntil(p),
    deferSync: true,
  });
  return c.json(await batchPayload(c.env, await ownedBatch(c.env, c.get("user"), b.id), c.get("user")));
});
