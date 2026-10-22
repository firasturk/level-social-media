/**
 * Higgsfield's tools on one of a post's finished clips, for the Video studio's Enhance and Check
 * panels (docs/video-studio.md): `upscale_video`, `reframe` (9:16, 1:1, 4:5), `remove_background`
 * make a new version of the same post; `virality_predictor` and `video_analysis_create` /
 * `video_analysis_status` answer with words kept on the version. All on the subscription credits
 * through the Higgsfield MCP (server/higgsfield-mcp.ts), under the usual rules: admins only, the
 * `higgsfield` switch, the billing choice, confirm before spend (a `get_cost` preflight when the
 * tool's input schema offers one, else "cost not known" until confirmed), one claim per ask, a
 * ledger row, no retry. The clip reaches Higgsfield as a media id (`media_import_url` of a
 * short-lived signed link) or, when the tool takes a link, as the link itself; the tool's input
 * schema from the live `tools/list` decides which.
 *
 * Routes (mounted at /api/studio/video/higgsfield):
 *   GET  /tools                        which of the six tools the server lists (every member)
 *   POST /tool   {batch, videoId, tool, arguments?, confirm?}        admins → a new version
 *   POST /check  {batch, videoId, tool, confirm?}                    admins → words on the version
 *   GET  /check/status?batch=&videoId=                               the analysis polled (admins)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { first, uuid } from "./db";
import { ownedPlan } from "./posts";
import { signObjectUrl } from "./signed";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { balanceOf, fetcher, HiggsfieldMcp, higgsfieldSignIn, MCP_PROVIDER, mediaFor, parseCost, parseJobs, unlimChoiceIn } from "./higgsfield-mcp";
import { CLOUD_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { findString, firstUrl, jsonOf, resultText, type McpCallResult } from "./mcp-client";
import { finishedVersion, insertVideoRow, parseSettings, patchVideoSettings, sha256, storeFinishedClip, versionItem, type VideoItem, type VideoRow } from "./video";
import type { User } from "@shared/types";

type Variables = { user: User };
export const videoHiggsfieldRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CLAIM_TTL_MS = 10 * 60 * 1000;

/** The tools on an existing clip, with what each is for. */
export const HIGGSFIELD_CLIP_TOOLS: Record<string, { label: string; hint: string }> = {
  upscale_video: { label: "Upscale", hint: "A sharper, larger clip from Higgsfield." },
  reframe: { label: "Reframe", hint: "The clip refitted to another frame: 9:16, 1:1 or 4:5." },
  remove_background: { label: "Remove the background", hint: "The subject kept, the background taken out." },
};
/** The Check panel's tools: words about the clip, nothing made. */
export const HIGGSFIELD_CHECK_TOOLS: Record<string, { label: string; hint: string }> = {
  virality_predictor: { label: "Virality check", hint: "How the clip is likely to perform: the hook, attention, retention." },
  video_analysis_create: { label: "Video analysis", hint: "A longer look at the clip (a job; the answer arrives in a minute or two)." },
};
const ALL_TOOLS = [...Object.keys(HIGGSFIELD_CLIP_TOOLS), ...Object.keys(HIGGSFIELD_CHECK_TOOLS), "video_analysis_status"];

/* ───────────── The clip as the tool wants it ───────────── */

const ID_PARAMS = ["media_id", "medias", "video_id", "video", "media", "input_media_id"];
const URL_PARAMS = ["video_url", "url", "input_url", "source_url"];

/**
 * The argument that carries the clip, chosen from the tool's declared parameters: an imported media
 * id under the name the schema uses, or a signed link when the tool takes one. With no schema the
 * studio assumes `media_id` (the first live run tells).
 */
export async function clipArgs(env: Env, mcp: HiggsfieldMcp, v: VideoRow, params: string[]): Promise<{ args: Record<string, unknown>; how: string }> {
  const idParam = ID_PARAMS.find((p) => params.includes(p));
  const urlParam = URL_PARAMS.find((p) => params.includes(p));
  if (!idParam && urlParam) return { args: { [urlParam]: await signObjectUrl(env, v.key!, 2 * 60 * 60 * 1000) }, how: `link as ${urlParam}` };
  const mediaId = await mediaFor(env, mcp, v.key!, "video");
  const name = idParam ?? "media_id";
  if (name === "medias") return { args: { medias: [{ value: mediaId, role: "video" }] }, how: "media id in medias[]" };
  return { args: { [name]: mediaId }, how: `media id as ${name}` };
}

/** Tools whose schema nests everything under `params` (as generate_video does) get the same nesting. */
function shaped(params: string[], args: Record<string, unknown>): Record<string, unknown> {
  return params.includes("params") && !params.some((p) => ID_PARAMS.includes(p) || URL_PARAMS.includes(p)) ? { params: args } : args;
}

/* ───────────── The estimate: a get_cost preflight when the tool offers it ───────────── */

async function preflight(mcp: HiggsfieldMcp, tool: string, params: string[], args: Record<string, unknown>): Promise<{ credits: number | null; offered: boolean }> {
  const nested = params.includes("params") && !params.some((p) => ID_PARAMS.includes(p) || URL_PARAMS.includes(p));
  if (!params.includes("get_cost") && !nested) return { credits: null, offered: false };
  try {
    const r = await mcp.call(tool, nested ? { params: { ...args, get_cost: true } } : { ...args, get_cost: true });
    return { credits: r.isError ? null : parseCost(r), offered: true };
  } catch (e) {
    console.error("[video-enhance] get_cost", tool, errorMessage(e));
    return { credits: null, offered: true };
  }
}

async function session(env: Env): Promise<HiggsfieldMcp> {
  if ((await higgsfieldBilling(env)) !== "credits") throw new StudioError(CLOUD_CHOSEN, 409, false, { billing: "cloud" });
  const mcp = new HiggsfieldMcp(env, fetcher());
  await mcp.connect();
  return mcp;
}

/* ───────────── Enhance: a new version from a tool ───────────── */

const toolSchema = z.object({
  batch: z.string().min(1),
  videoId: z.string().min(1),
  tool: z.string().regex(/^[a-z0-9_]{2,80}$/),
  arguments: z.record(z.string(), z.unknown()).default({}),
  confirm: z.boolean().optional(),
});
export type HiggsfieldToolInput = z.infer<typeof toolSchema>;

export async function runClipTool(env: Env, user: User, d: HiggsfieldToolInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const meta = HIGGSFIELD_CLIP_TOOLS[d.tool];
  if (!meta) throw new StudioError(`"${d.tool}" is not one of the Enhance tools.`);
  const b = await ownedPlan(env, user, d.batch);
  const v = await finishedVersion(env, b.id, d.videoId);
  const mcp = await session(env);
  await mcp.requireTool(d.tool);
  const params = await mcp.toolParams(d.tool);
  const extra = Object.fromEntries(Object.entries(d.arguments).filter(([k, val]) => !ID_PARAMS.includes(k) && !URL_PARAMS.includes(k) && k !== "get_cost" && val !== undefined && val !== null && val !== "" && JSON.stringify(val).length < 2000));
  const clip = await clipArgs(env, mcp, v, params);
  const args = { ...clip.args, ...extra };
  const est = await preflight(mcp, d.tool, params, args);
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null, plan: null as string | null, text: "" }));
  if (est.credits === null && !d.confirm) throw new StudioError(`The cost of ${meta.label.toLowerCase()} is not known: ${est.offered ? "Higgsfield gave no figure" : "this tool offers no estimate"}. Confirm it at an unknown cost, or leave it.`, 409, false, { needsEstimate: true, tool: d.tool });
  if (!d.confirm) throw new StudioError(`Confirm ${meta.label.toLowerCase()}: about ${est.credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits: est.credits, balance: bal.credits });
  const fingerprint = await sha256([MCP_PROVIDER, d.tool, v.id, JSON.stringify(extra)].join("\n"));
  if (!(await claimSubmission(env, `enhance:${b.id}:${v.post}:${fingerprint}`, CLAIM_TTL_MS))) throw new StudioError("This exact change was asked for a moment ago. Wait for it, or change its settings.", 409);
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "video.enhance",
    user: user.id,
    batch: b.id,
    post: v.post,
    estimate: est.credits,
    status: "confirmed",
    note: `${meta.label} (${d.tool}) of version ${v.id.slice(0, 8)} · ${est.credits ?? "unknown"} credits (subscription, MCP)${est.credits === null ? " · cost unknown, confirmed" : ""} · clip as ${clip.how}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}`,
  });
  const id = uuid();
  const from = parseSettings(v);
  const settings = { enhance: { tool: d.tool, label: meta.label, from: v.id, arguments: extra }, label: `${meta.label} (Higgsfield) of an earlier version`, estimate: est.credits, credits: est.credits, estimateSource: est.credits === null ? "confirmed" : "provider", unit: "credits", duration: from.duration, aspect: typeof extra.aspect_ratio === "string" ? extra.aspect_ratio : from.aspect, balanceBefore: bal.credits, plan: bal.plan, outcomeUnknown: false };
  const row = { id, batch: b.id, post: v.post, task: v.task, owner: user.id, model: `tool:${d.tool}`, prompt: v.prompt, provider: MCP_PROVIDER, posterKey: v.poster_key, source: v.source, opId };
  let r: McpCallResult;
  try {
    r = await mcp.call(d.tool, shaped(params, args));
  } catch (e) {
    const timeout = e instanceof Error && (/TimeoutError|AbortError/.test(e.name) || /timed? ?out/i.test(e.message));
    if (timeout) {
      const note = "Higgsfield did not answer in time: the tool may still have started, so nothing was sent again. The version stays queued and is given up after half an hour if no job id can be learned.";
      await insertVideoRow(env, { ...row, status: "queued", requestId: null, error: null, settings: { ...settings, outcomeUnknown: true } });
      await updateIntegrationOp(env, opId, { status: "running", note: `outcome unknown (timeout) · ${note}` });
      throw new StudioError(note, 504, false, { outcomeUnknown: true, videoId: id });
    }
    const message = errorMessage(e).slice(0, 400);
    await insertVideoRow(env, { ...row, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  if (unlimChoiceIn(r)) {
    await updateIntegrationOp(env, opId, { status: "proposed", note: "waiting for the unlimited-allowance choice; nothing submitted" });
    throw new StudioError(`Higgsfield asks whether ${meta.label.toLowerCase()} should use the unlimited allowance or pay credits; the studio does not answer that for this tool yet.`, 409, false, { unlimChoice: unlimChoiceIn(r) });
  }
  const jobs = parseJobs(r);
  const direct = r.isError ? null : firstUrl(jsonOf(r), resultText(r));
  if (!jobs.length && direct && /\.mp4(\?|$)/i.test(direct)) {
    await insertVideoRow(env, { ...row, status: "queued", requestId: null, error: null, settings });
    const fresh = (await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ?", id))!;
    await storeFinishedClip(env, b, fresh, direct, fetcher());
    await updateIntegrationOp(env, opId, { status: "done", reported: est.credits, taskId: id });
    return versionItem(env, b.id, v.post, id);
  }
  if (r.isError || !jobs.length) {
    const message = `Higgsfield did not start ${meta.label.toLowerCase()}: ${resultText(r).slice(0, 300) || "no job id in the answer"}`;
    await insertVideoRow(env, { ...row, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insertVideoRow(env, { ...row, status: "queued", requestId: jobs[0].jobId, error: null, settings: { ...settings, jobIds: jobs.map((j) => j.jobId) } });
  await updateIntegrationOp(env, opId, { taskId: jobs[0].jobId, status: "running" });
  return versionItem(env, b.id, v.post, id);
}

/* ───────────── Check: words about the clip ───────────── */

const checkSchema = z.object({
  batch: z.string().min(1),
  videoId: z.string().min(1),
  tool: z.string().regex(/^[a-z0-9_]{2,80}$/),
  confirm: z.boolean().optional(),
});
export type HiggsfieldCheckInput = z.infer<typeof checkSchema>;

/** The readable part of an analysis answer: its text, or the JSON pretty enough to read. */
function wordsOf(r: McpCallResult): string {
  const text = resultText(r).trim();
  if (text && !/^[[{]/.test(text)) return text.slice(0, 6000);
  const j = jsonOf(r);
  return (j ? JSON.stringify(j, null, 2) : text).slice(0, 6000);
}

export async function runCheck(env: Env, user: User, d: HiggsfieldCheckInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const meta = HIGGSFIELD_CHECK_TOOLS[d.tool];
  if (!meta) throw new StudioError(`"${d.tool}" is not one of the Check tools.`);
  const b = await ownedPlan(env, user, d.batch);
  const v = await finishedVersion(env, b.id, d.videoId);
  const mcp = await session(env);
  if (!(await mcp.hasTool(d.tool))) throw new StudioError(`${meta.label} is not available on this plan (Higgsfield lists no "${d.tool}" tool today).`, 409, false, { notAvailable: true, tool: d.tool });
  const params = await mcp.toolParams(d.tool);
  const clip = await clipArgs(env, mcp, v, params);
  const est = await preflight(mcp, d.tool, params, clip.args);
  if (est.credits === null && !d.confirm) throw new StudioError(`The cost of the ${meta.label.toLowerCase()} is not known: ${est.offered ? "Higgsfield gave no figure" : "this tool offers no estimate"}. Confirm it at an unknown cost, or leave it.`, 409, false, { needsEstimate: true, tool: d.tool });
  if (!d.confirm && est.credits !== null && est.credits > 0) throw new StudioError(`Confirm the ${meta.label.toLowerCase()}: about ${est.credits} credits from the subscription balance.`, 409, false, { needsConfirm: true, credits: est.credits });
  if (!(await claimSubmission(env, `check:${b.id}:${v.id}:${d.tool}`, 60_000))) throw new StudioError("This check is already running.", 409);
  const opId = await recordIntegrationOp(env, { provider: "higgsfield", kind: "video.check", user: user.id, batch: b.id, post: v.post, estimate: est.credits, status: "running", note: `${meta.label} (${d.tool}) of version ${v.id.slice(0, 8)} · ${est.credits ?? "unknown"} credits · clip as ${clip.how}` });
  let r: McpCallResult;
  try {
    r = await mcp.call(d.tool, shaped(params, clip.args));
  } catch (e) {
    await updateIntegrationOp(env, opId, { status: "failed", note: errorMessage(e).slice(0, 300) });
    throw e;
  }
  if (r.isError) {
    await updateIntegrationOp(env, opId, { status: "failed", note: resultText(r).slice(0, 300) });
    throw new StudioError(`Higgsfield could not run the ${meta.label.toLowerCase()}: ${resultText(r).slice(0, 300)}`, 502);
  }
  if (d.tool === "video_analysis_create") {
    const analysisId = findString(jsonOf(r), ["analysis_id", "analysisId", "job_id", "id", "task_id"]) ?? /(?:analysis|job)[_ ]id\W+([A-Za-z0-9_-]{4,})/i.exec(resultText(r))?.[1] ?? null;
    if (!analysisId) {
      await updateIntegrationOp(env, opId, { status: "failed", note: `no analysis id: ${resultText(r).slice(0, 200)}` });
      throw new StudioError(`Higgsfield started no analysis: ${resultText(r).slice(0, 200) || "no id in the answer"}`, 502);
    }
    await patchVideoSettings(env, v, { analysis: { id: analysisId, status: "running", text: "", at: Date.now(), opId } });
    await updateIntegrationOp(env, opId, { taskId: analysisId });
  } else {
    await patchVideoSettings(env, v, { check: { tool: d.tool, at: Date.now(), text: wordsOf(r), credits: est.credits } });
    await updateIntegrationOp(env, opId, { status: "done", reported: est.credits });
  }
  return versionItem(env, b.id, v.post, v.id);
}

/** The analysis asked about once; its words land on the version when it is done. Admins. */
export async function pollAnalysis(env: Env, user: User, batch: string, videoId: string): Promise<VideoItem> {
  const b = await ownedPlan(env, user, batch);
  const v = await finishedVersion(env, b.id, videoId);
  const s = parseSettings(v) as { analysis?: { id: string; status: string; text: string; at: number; opId?: string } | null };
  if (!s.analysis?.id || s.analysis.status !== "running") return versionItem(env, b.id, v.post, v.id);
  const mcp = await session(env);
  await mcp.requireTool("video_analysis_status");
  const params = await mcp.toolParams("video_analysis_status");
  const key = params.find((p) => /analysis_id|analysisId|job_id|id/.test(p)) ?? "analysis_id";
  const r = await mcp.call("video_analysis_status", { [key]: s.analysis.id });
  const status = (findString(jsonOf(r), ["status", "state"]) ?? "").toLowerCase();
  const done = /^(completed|complete|succeeded|done|finished|ready)$/.test(status) || (!status && !!wordsOf(r) && !/pending|running|processing/i.test(resultText(r)));
  const failed = /^(failed|failure|error|cancelled|canceled)$/.test(status) || r.isError;
  if (done || failed) {
    await patchVideoSettings(env, v, { analysis: { ...s.analysis, status: failed ? "failed" : "done", text: wordsOf(r) } });
    if (s.analysis.opId) await updateIntegrationOp(env, s.analysis.opId, { status: failed ? "failed" : "done", note: failed ? resultText(r).slice(0, 300) : "analysis delivered" });
  }
  return versionItem(env, b.id, v.post, v.id);
}

/* ───────────── Routes ───────────── */

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  return u;
}

/** Which clip and check tools the live server lists, so the panels can say "Not available on this plan". Every member. */
videoHiggsfieldRoutes.get("/tools", async (c) => {
  const user = c.get("user");
  const access = await integrationAccess(c.env, user, "higgsfield");
  const signedIn = await higgsfieldSignIn.isSignedIn(c.env);
  const billing = await higgsfieldBilling(c.env);
  const available: Record<string, boolean> = Object.fromEntries(ALL_TOOLS.map((t) => [t, false]));
  let reason = "";
  if (!signedIn) reason = "Not signed in: Connection → Higgsfield → Sign in to Higgsfield.";
  else if (!access.enabled) reason = access.reason;
  else {
    try {
      const names = await new HiggsfieldMcp(c.env, fetcher()).toolNames();
      for (const t of ALL_TOOLS) available[t] = names.includes(t);
    } catch (e) {
      reason = errorMessage(e);
    }
  }
  return c.json({
    ok: true,
    signedIn,
    billing,
    admin: user.role === "admin",
    access,
    reason,
    available,
    tools: Object.entries(HIGGSFIELD_CLIP_TOOLS).map(([name, t]) => ({ name, ...t, available: available[name] })),
    checks: Object.entries(HIGGSFIELD_CHECK_TOOLS).map(([name, t]) => ({ name, ...t, available: available[name] && (name !== "video_analysis_create" || available.video_analysis_status) })),
  });
});

videoHiggsfieldRoutes.post("/tool", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, toolSchema);
  return c.json({ ok: true, video: await runClipTool(c.env, user, d) });
});

videoHiggsfieldRoutes.post("/check", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, checkSchema);
  return c.json({ ok: true, video: await runCheck(c.env, user, d) });
});

videoHiggsfieldRoutes.get("/check/status", async (c) => {
  const user = await gate(c);
  return c.json({ ok: true, video: await pollAnalysis(c.env, user, c.req.query("batch") ?? "", c.req.query("videoId") ?? "") });
});
