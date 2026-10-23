/**
 * Videos through the Magnific MCP (server/freepik-mcp.ts, docs/freepik.md) for the Video studio:
 * the video engines (`video_models_list`, cached a day), a clip made from a post's picture
 * (`video_generate` with the picture as the first keyframe), and the tools on an existing clip
 * (`video_upscale`, `video_color_grade`, `video_music`, `video_soundfx`, `video_relight`,
 * `video_hdr`), each estimated with `simulate_cost` first and confirmed by the admin, then
 * collected with `creations_wait` by a settler of the versions list. A result becomes a version of
 * the same post with `provider = 'magnific'`. To hand one of our clips to Magnific it is uploaded
 * as a creation first, with whichever upload tool the live `tools/list` offers.
 *
 * Governance is the Freepik integration's: admins only, the `freepik` switch, a ledger row per
 * operation under provider `freepik` (kind `video.generate`, `video.enhance`), confirm before
 * spend, an unknown cost blocked, a claim per ask, no retry.
 *
 * Routes (mounted at /api/studio/video/magnific):
 *   GET  /status             connected?, admin, switch (every member)
 *   GET  /models?refresh=1   the video engines (admins)
 *   GET  /luts               the colour-grade LUTs (admins)
 *   POST /generate           {batch, index, slug, prompt, duration, aspectRatio?, resolution?, source?, artwork?, withSoundEffects?, confirm?}
 *   POST /enhance            {batch, videoId, tool, arguments?, confirm?}
 *
 * Every answer shape is assumed from the tool descriptions and read defensively (docs/video-studio.md).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { first, now, run, uuid } from "./db";
import { setSetting } from "./settings";
import { readJsonSetting } from "./oauth-signin";
import { ownedPlan } from "./posts";
import { signObjectUrl } from "./signed";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { creditsIn, MagnificMcp, magnificFetcher, MCP_NOT_CONNECTED, tokenSource } from "./freepik-mcp";
import { posterFor } from "./higgsfield-mcp";
import { findString, findValue, firstUrl, jsonOf, objectsWith, resultText, type McpCallResult } from "./mcp-client";
import { finishedVersion, frameFields, frameSettings, GIVE_UP_MS, insertVideoRow, parseSettings, patchVideoSettings, registerPendingSettler, sha256, storeFinishedClip, versionItem, type VideoItem, type VideoRow } from "./video";
import type { User } from "@shared/types";

type Variables = { user: User };
export const videoMagnificRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The `videos.provider` of a clip made or changed by Magnific. */
export const MAGNIFIC_PROVIDER = "magnific";
export const MAGNIFIC_MODELS_SETTING = "magnific_video_models";
export const MAGNIFIC_LUTS_SETTING = "magnific_video_luts";
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const POLL_LIMIT = 6;

/** The tools of the Enhance panel on an existing clip, with what each is for (plain words for the panel). */
export const MAGNIFIC_ENHANCE_TOOLS: Record<string, { label: string; hint: string }> = {
  video_upscale: { label: "Upscale", hint: "A sharper, larger clip (Topaz, Magnific, or Magnific precision)." },
  video_color_grade: { label: "Colour grade", hint: "A LUT or slider adjustments applied to the whole clip." },
  video_music: { label: "Music", hint: "A music track generated for the clip, mixed under or over its sound." },
  video_soundfx: { label: "Sound effects", hint: "Sound effects that follow what happens in the clip." },
  video_relight: { label: "Relight", hint: "New lighting on the clip from a few words." },
  video_hdr: { label: "HDR", hint: "More range in the highlights and shadows." },
};

/* ───────────── Reading the answers ───────────── */

export interface MagnificVideoModel {
  slug: string;
  name: string;
  description: string;
  durations: number[];
  aspectRatios: string[];
  resolutions: string[];
  recommended: boolean;
  recommendation: string;
  /** The engine makes a clip from a picture (a start keyframe), as far as the answer says; unknown counts as yes. */
  imageToVideo: boolean;
}

const numbersOf = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "number" ? x : typeof x === "string" ? Number(x.replace(/s$/i, "")) : typeof x === "object" && x ? Number((x as Record<string, unknown>).value ?? (x as Record<string, unknown>).seconds) : NaN)).filter((n) => Number.isFinite(n) && n > 0)
    : typeof v === "number" && v > 0
      ? [v]
      : [];
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as Record<string, unknown>).value ?? (x as Record<string, unknown>).id ?? (x as Record<string, unknown>).name ?? "") : "")).filter(Boolean) : []);

/** The engines a `video_models_list` answer lists (objects with a `slug`). */
export function parseVideoModels(r: McpCallResult): MagnificVideoModel[] {
  const out: MagnificVideoModel[] = [];
  const seen = new Set<string>();
  for (const o of objectsWith(jsonOf(r), "slug")) {
    const slug = String(o.slug);
    if (seen.has(slug) || !/^[a-z0-9][a-z0-9_.:/-]{1,80}$/i.test(slug)) continue;
    seen.add(slug);
    // `private: true` = internal or feature-flagged (the catalog's own words): not offered.
    if (o.private === true) continue;
    // Only video generators: the catalog may list other tools under the same key.
    if (typeof o.tool === "string" && o.tool && !/video/i.test(o.tool)) continue;
    const caps = `${JSON.stringify(o.capabilities ?? o.features ?? o.inputs ?? o.supports ?? "")}`.toLowerCase();
    const rec = o.agentRecommendation ?? o.recommendation ?? o.recommended;
    // The live catalog: `agentRecommendation: {tier, rank, summary}`; older shapes said a string or a flag.
    const recBlock = rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as Record<string, unknown>) : null;
    const recText = recBlock ? String(recBlock.summary ?? recBlock.tier ?? "") : typeof rec === "string" ? rec : "";
    const keyframes = o.keyframes && typeof o.keyframes === "object" ? (o.keyframes as Record<string, unknown>) : null;
    const startFrame = o.supportsStartFrame === true || !!keyframes?.start;
    out.push({
      slug,
      name: String(o.name ?? o.title ?? o.displayName ?? slug).slice(0, 80),
      description: String(o.description ?? recBlock?.summary ?? o.summary ?? "").slice(0, 300),
      durations: numbersOf(o.durations ?? o.duration ?? o.supportedDurations ?? o.durationOptions),
      aspectRatios: stringsOf(o.aspectRatios ?? o.aspect_ratios ?? o.supportedAspectRatios),
      resolutions: stringsOf(o.resolutions ?? o.supportedResolutions),
      recommended: rec === true || !!recBlock || (typeof rec === "string" && rec.trim() !== "" && !/not recommended/i.test(rec)),
      recommendation: recText.slice(0, 300),
      imageToVideo: o.supportsStartFrame === false && !keyframes?.start ? false : startFrame || caps === '""' || /image|keyframe|start/.test(caps) || !/text[-_ ]?only/.test(caps),
    });
  }
  return out;
}

export interface MagnificLut {
  id: string;
  name: string;
}

/** The LUTs `video_luts_list` names (an id with a name). */
export function parseLuts(r: McpCallResult): MagnificLut[] {
  const out: MagnificLut[] = [];
  const seen = new Set<string>();
  for (const o of [...objectsWith(jsonOf(r), "id"), ...objectsWith(jsonOf(r), "lutId")]) {
    const id = String(o.lutId ?? o.id);
    const name = String(o.name ?? o.title ?? o.label ?? id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: name.slice(0, 80) });
  }
  return out;
}

/** The creation identifiers an answer names (`identifier`, `creationIdentifier`, or a list of creations with an `id`). */
export function parseIdentifiers(r: McpCallResult): string[] {
  const j = jsonOf(r);
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^[A-Za-z0-9_:-]{4,120}$/.test(v) && !out.includes(v)) out.push(v);
  };
  const direct = findValue(j, ["identifiers", "creationIdentifiers", "creation_identifiers"], (v): v is unknown[] => Array.isArray(v));
  if (direct) for (const x of direct) push(typeof x === "object" && x ? (x as Record<string, unknown>).identifier ?? (x as Record<string, unknown>).id : x);
  for (const o of [...objectsWith(j, "identifier"), ...objectsWith(j, "creationIdentifier"), ...objectsWith(j, "creation_identifier")]) push(o.identifier ?? o.creationIdentifier ?? o.creation_identifier);
  if (!out.length) for (const o of objectsWith(j, "id")) if (/creation|queued|processing|status/.test(JSON.stringify(o).toLowerCase())) push(o.id);
  if (!out.length) {
    const m = /(?:identifier|creation)[^A-Za-z0-9]{1,6}([A-Za-z0-9_:-]{6,120})/i.exec(resultText(r));
    if (m) push(m[1]);
  }
  return out;
}

export interface CreationEntry {
  identifier: string;
  status: string;
  url: string | null;
  error: string | null;
}

const DONE = /^(completed|complete|succeeded|success|done|finished|ready)$/i;
/** A creation that ended badly. Not "timeout": a one-second `creations_wait` that ran out says nothing about it (see server/provider-status.ts). */
const FAILED = /^(failed|failure|error|errored|cancelled|canceled|rejected|moderated)$/i;

/** What `creations_wait` says about each creation. */
export function parseCreations(r: McpCallResult): CreationEntry[] {
  const j = jsonOf(r);
  const out: CreationEntry[] = [];
  for (const o of [...objectsWith(j, "identifier"), ...objectsWith(j, "creationIdentifier"), ...objectsWith(j, "id")]) {
    const identifier = String(o.identifier ?? o.creationIdentifier ?? o.id);
    if (out.some((x) => x.identifier === identifier)) continue;
    const status = String(findString(o, ["status", "state"]) ?? "").toLowerCase();
    const media = findValue(o, ["url", "fileUrl", "file_url", "videoUrl", "video_url", "downloadUrl", "download_url", "file", "files", "output", "outputs", "result", "results", "media", "assets"], (v): v is unknown => v !== null && v !== undefined);
    const url = media ? firstUrl(media, "") : null;
    out.push({ identifier, status, url, error: findString(o, ["error", "errorMessage", "error_message", "failureReason", "reason"]) });
  }
  return out;
}

/* ───────────── Catalogs ───────────── */

let modelsMemo: { at: number; models: MagnificVideoModel[] } | null = null;
let lutsMemo: { at: number; luts: MagnificLut[] } | null = null;
export function resetMagnificVideoCaches(): void {
  modelsMemo = null;
  lutsMemo = null;
}

export async function magnificVideoModels(env: Env, mcp: MagnificMcp, refresh = false): Promise<{ models: MagnificVideoModel[]; at: number }> {
  if (!refresh && modelsMemo && Date.now() - modelsMemo.at < MODELS_TTL_MS) return modelsMemo;
  if (!refresh) {
    const stored = await readJsonSetting<{ at: number; models: MagnificVideoModel[] }>(env, MAGNIFIC_MODELS_SETTING);
    if (stored && Array.isArray(stored.models) && Date.now() - stored.at < MODELS_TTL_MS) {
      modelsMemo = stored;
      return stored;
    }
  }
  const r = await mcp.callTool("video_models_list", {});
  const models = parseVideoModels(r);
  if (!models.length) throw new StudioError(`Magnific listed no video engine the studio could read. Answer: ${resultText(r).slice(0, 200)}`, 502);
  modelsMemo = { at: Date.now(), models };
  await setSetting(env, MAGNIFIC_MODELS_SETTING, JSON.stringify(modelsMemo));
  return modelsMemo;
}

export async function magnificLuts(env: Env, mcp: MagnificMcp, refresh = false): Promise<{ luts: MagnificLut[]; at: number }> {
  if (!refresh && lutsMemo && Date.now() - lutsMemo.at < MODELS_TTL_MS) return lutsMemo;
  if (!refresh) {
    const stored = await readJsonSetting<{ at: number; luts: MagnificLut[] }>(env, MAGNIFIC_LUTS_SETTING);
    if (stored && Array.isArray(stored.luts) && Date.now() - stored.at < MODELS_TTL_MS) {
      lutsMemo = stored;
      return stored;
    }
  }
  const r = await mcp.callTool("video_luts_list", {});
  lutsMemo = { at: Date.now(), luts: parseLuts(r) };
  await setSetting(env, MAGNIFIC_LUTS_SETTING, JSON.stringify(lutsMemo));
  return lutsMemo;
}

/* ───────────── The estimate and the confirm, as the Freepik MCP rules say ───────────── */

/** `simulate_cost` first; no figure blocks the run (every generation draws on the credit balance). */
async function estimateOf(mcp: MagnificMcp, tool: string, args: Record<string, unknown>): Promise<number | null> {
  try {
    const sim = await mcp.callTool("simulate_cost", { tool, arguments: args });
    return sim.isError ? null : creditsIn(sim);
  } catch (e) {
    console.error("[video-magnific] simulate_cost", tool, errorMessage(e));
    return null;
  }
}

async function openMcp(env: Env): Promise<MagnificMcp> {
  const mcp = await MagnificMcp.open(env);
  if (!mcp) throw new StudioError(MCP_NOT_CONNECTED, 409, false, { connected: false });
  return mcp;
}

/* ───────────── Generate: the post's picture as the first keyframe ───────────── */

const generateSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(200),
  slug: z.string().min(1).max(80),
  prompt: z.string().trim().max(5000).default(""),
  duration: z.number().int().min(1).max(60),
  aspectRatio: z.string().max(10).optional(),
  resolution: z.string().max(10).optional(),
  source: z.enum(["picture", "artwork"]).default("picture"),
  artwork: z.string().max(17 * 1024 * 1024).optional(),
  withSoundEffects: z.boolean().optional(),
  confirm: z.boolean().optional(),
  note: z.string().trim().max(200).optional(),
  ...frameFields,
});
export type MagnificGenerateInput = z.infer<typeof generateSchema>;

export async function generateMagnificVideo(env: Env, user: User, d: MagnificGenerateInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const mcp = await openMcp(env);
  const { models } = await magnificVideoModels(env, mcp);
  const engine = models.find((m) => m.slug === d.slug);
  if (!engine) throw new StudioError(`"${d.slug}" is not on Magnific's video engine list. Pick an engine from the list (refresh it if it looks stale).`, 400, false, { unknownEngine: d.slug });
  if (engine.durations.length && !engine.durations.includes(d.duration)) throw new StudioError(`${engine.name} makes clips of ${engine.durations.join(", ")} seconds.`);
  if (d.aspectRatio && engine.aspectRatios.length && !engine.aspectRatios.includes(d.aspectRatio)) throw new StudioError(`${engine.name} offers these frames: ${engine.aspectRatios.join(", ")}.`);
  const posterKey = await posterFor(env, b, { id: t.id, output: t.output }, d);
  const url = await signObjectUrl(env, posterKey, 2 * 60 * 60 * 1000);
  const args: Record<string, unknown> = { slug: d.slug, prompt: d.prompt.trim() || undefined, duration: d.duration, keyframes: { start: { type: "image", url } } };
  if (d.aspectRatio) args.aspectRatio = d.aspectRatio;
  if (d.resolution) args.resolution = d.resolution;
  if (d.withSoundEffects !== undefined) args.withSoundEffects = d.withSoundEffects;
  const base = { provider: "freepik" as const, kind: "video.generate", user: user.id, batch: b.id, post: d.index };
  const estimate = await estimateOf(mcp, "video_generate", args);
  if (estimate === null) {
    await recordIntegrationOp(env, { ...base, estimate: null, status: "refused", note: `cost not known: simulate_cost gave no figure for video_generate (${engine.name})` });
    throw new StudioError(`Cost not known: Magnific could not estimate a ${engine.name} clip, so it was not made. Every generation draws on the Magnific credit balance.`, 409, false, { blocked: true });
  }
  if (!d.confirm) throw new StudioError(`Confirm the clip: about ${estimate} credits from the Magnific balance.`, 409, false, { needsConfirm: true, estimate, credits: estimate });
  const fingerprint = await sha256([MAGNIFIC_PROVIDER, d.slug, d.prompt.trim(), d.duration, d.aspectRatio ?? "", d.resolution ?? "", d.source, posterKey].join("\n"));
  if (!(await claimSubmission(env, `video:${b.id}:${d.index}:${fingerprint}`, CLAIM_TTL_MS))) throw new StudioError("This exact clip was asked for a moment ago. Wait for it, or change the idea or the settings.", 409);
  const opId = await recordIntegrationOp(env, { ...base, estimate, status: "confirmed", note: `${engine.name} · ${d.duration}s · ${d.source}${d.frame ? ` · frame ${d.frame}${d.fill ? ` (${d.fill})` : ""}` : ""} · ${estimate} credits (Magnific)${d.note ? ` · ${d.note}` : ""}` });
  const id = uuid();
  const settings = { slug: d.slug, engineName: engine.name, duration: d.duration, aspect: d.aspectRatio, resolution: d.resolution, ...frameSettings(d), estimate, credits: estimate, estimateSource: "provider", unit: "credits", label: `Magnific · ${engine.name}`, withSoundEffects: d.withSoundEffects ?? null, note: d.note, identifiers: [] as string[] };
  const row = { id, batch: b.id, post: d.index, task: t.id, owner: user.id, model: `magnific:${d.slug}`, prompt: d.prompt.trim(), provider: MAGNIFIC_PROVIDER, posterKey, source: d.source, opId };
  let r: McpCallResult;
  try {
    r = await mcp.callTool("video_generate", args);
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    await insertVideoRow(env, { ...row, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  const ids = r.isError ? [] : parseIdentifiers(r);
  if (!ids.length) {
    const message = `Magnific did not start the clip: ${resultText(r).slice(0, 300) || "no creation identifier in the answer"}`;
    await insertVideoRow(env, { ...row, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insertVideoRow(env, { ...row, status: "queued", requestId: ids[0], error: null, settings: { ...settings, identifiers: ids } });
  await updateIntegrationOp(env, opId, { taskId: ids[0], status: "running" });
  return versionItem(env, b.id, d.index, id);
}

/* ───────────── Enhance: a tool on one of our clips ───────────── */

/** The names and the input properties of the live tools, once per request. */
async function toolMap(mcp: MagnificMcp): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const t of await mcp.listTools()) {
    const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    out.set(t.name, props && typeof props === "object" ? Object.keys(props) : []);
  }
  return out;
}

/**
 * One of our clips as a Magnific creation, uploaded once and remembered on the version:
 * `creations_upload_file` when it takes a link, else `creations_request_upload` → PUT →
 * `creations_finalize_upload`. Which exists is read from the live tool list.
 */
export async function creationFor(env: Env, mcp: MagnificMcp, v: VideoRow, tools: Map<string, string[]>): Promise<string> {
  const s = parseSettings(v) as { magnificCreation?: string };
  if (s.magnificCreation) return s.magnificCreation;
  if (!v.key) throw new StudioError("This version has no stored file.", 409);
  const fileName = `post-${v.post}-video-${v.id.slice(0, 8)}.mp4`;
  let id: string | null = null;
  const byLink = tools.get("creations_upload_file");
  if (byLink && byLink.some((p) => /url|link|source/i.test(p))) {
    const url = await signObjectUrl(env, v.key, 2 * 60 * 60 * 1000);
    const key = byLink.find((p) => /^(url|fileUrl|file_url|sourceUrl|source_url|link)$/i.test(p)) ?? byLink.find((p) => /url/i.test(p))!;
    const r = await mcp.callTool("creations_upload_file", { [key]: url, fileName, contentType: "video/mp4", type: "video" });
    if (r.isError) throw new StudioError(`Magnific refused the clip: ${resultText(r).slice(0, 200)}`, 502);
    id = parseIdentifiers(r)[0] ?? null;
  } else if (tools.has("creations_request_upload") && tools.has("creations_finalize_upload")) {
    const obj = await env.BUCKET.get(v.key);
    if (!obj) throw new StudioError("The clip's file is missing from storage.", 404);
    const bytes = await obj.arrayBuffer();
    const r1 = await mcp.callTool("creations_request_upload", { fileName, contentType: "video/mp4", size: bytes.byteLength, type: "video" });
    if (r1.isError) throw new StudioError(`Magnific refused the upload: ${resultText(r1).slice(0, 200)}`, 502);
    const j1 = jsonOf(r1);
    const uploadUrl = findString(j1, ["uploadUrl", "upload_url", "signedUrl", "signed_url", "url"]) ?? firstUrl(j1, resultText(r1));
    const uploadId = findString(j1, ["identifier", "uploadId", "upload_id", "creationIdentifier", "id"]);
    if (!uploadUrl || !uploadId) throw new StudioError(`Magnific's upload answer had no link or id: ${resultText(r1).slice(0, 200)}`, 502);
    const put = await magnificFetcher()(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes, signal: AbortSignal.timeout(120_000) });
    if (!put.ok) throw new StudioError(`The clip could not be uploaded to Magnific (${put.status}).`, 502);
    const r2 = await mcp.callTool("creations_finalize_upload", { identifier: uploadId, uploadId });
    if (r2.isError) throw new StudioError(`Magnific could not finish the upload: ${resultText(r2).slice(0, 200)}`, 502);
    id = parseIdentifiers(r2)[0] ?? uploadId;
  } else {
    throw new StudioError("Magnific lists no upload tool the studio knows (creations_upload_file, creations_request_upload + creations_finalize_upload), so the clip cannot be handed to it. Nothing was run.", 502, false, { missingTool: "creations_upload" });
  }
  if (!id) throw new StudioError("Magnific gave no creation identifier for the uploaded clip.", 502);
  await patchVideoSettings(env, v, { magnificCreation: id });
  return id;
}

const enhanceSchema = z.object({
  batch: z.string().min(1),
  videoId: z.string().min(1),
  tool: z.string().regex(/^[a-z0-9_]{2,80}$/),
  arguments: z.record(z.string(), z.unknown()).default({}),
  confirm: z.boolean().optional(),
});
export type MagnificEnhanceInput = z.infer<typeof enhanceSchema>;

const RESERVED_ARGS = new Set(["creationIdentifier", "videoUrl", "url", "creation_identifier", "video_url"]);

export async function enhanceMagnificVideo(env: Env, user: User, d: MagnificEnhanceInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const meta = MAGNIFIC_ENHANCE_TOOLS[d.tool];
  if (!meta) throw new StudioError(`"${d.tool}" is not one of the Enhance tools.`);
  const b = await ownedPlan(env, user, d.batch);
  const v = await finishedVersion(env, b.id, d.videoId);
  const mcp = await openMcp(env);
  const tools = await toolMap(mcp);
  if (!tools.has(d.tool)) throw new StudioError(`Magnific lists no tool named "${d.tool}" today; nothing was run.`, 502, false, { missingTool: d.tool });
  const args: Record<string, unknown> = Object.fromEntries(Object.entries(d.arguments).filter(([k, val]) => !RESERVED_ARGS.has(k) && val !== undefined && val !== null && val !== "" && JSON.stringify(val).length < 4000));
  const params = tools.get(d.tool) ?? [];
  // A tool that takes a link gets a signed link to our file; the others get the clip uploaded as a creation.
  if (params.includes("videoUrl") && !params.includes("creationIdentifier")) args.videoUrl = await signObjectUrl(env, v.key!, 2 * 60 * 60 * 1000);
  else args.creationIdentifier = await creationFor(env, mcp, v, tools);
  const base = { provider: "freepik" as const, kind: "video.enhance", user: user.id, batch: b.id, post: v.post };
  const estimate = await estimateOf(mcp, d.tool, args);
  if (estimate === null) {
    await recordIntegrationOp(env, { ...base, estimate: null, status: "refused", note: `cost not known: simulate_cost gave no figure for ${d.tool}` });
    throw new StudioError(`Cost not known: Magnific could not estimate ${meta.label.toLowerCase()}, so it was not run.`, 409, false, { blocked: true });
  }
  if (!d.confirm) throw new StudioError(`Confirm ${meta.label.toLowerCase()}: about ${estimate} credits from the Magnific balance.`, 409, false, { needsConfirm: true, estimate, credits: estimate });
  const fingerprint = await sha256([MAGNIFIC_PROVIDER, d.tool, v.id, JSON.stringify(args)].join("\n"));
  if (!(await claimSubmission(env, `enhance:${b.id}:${v.post}:${fingerprint}`, CLAIM_TTL_MS))) throw new StudioError("This exact change was asked for a moment ago. Wait for it, or change its settings.", 409);
  const opId = await recordIntegrationOp(env, { ...base, estimate, status: "confirmed", note: `${meta.label} (${d.tool}) of version ${v.id.slice(0, 8)} · ${estimate} credits (Magnific) · ${JSON.stringify(d.arguments).slice(0, 200)}` });
  const id = uuid();
  const from = parseSettings(v);
  const settings = { enhance: { tool: d.tool, label: meta.label, from: v.id, arguments: d.arguments }, label: `${meta.label} (Magnific) of an earlier version`, estimate, credits: estimate, estimateSource: "provider", unit: "credits", duration: from.duration, aspect: from.aspect, frame: from.frame, frameFill: from.frameFill, words: from.words, identifiers: [] as string[] };
  const row = { id, batch: b.id, post: v.post, task: v.task, owner: user.id, model: `magnific:${d.tool}`, prompt: v.prompt, provider: MAGNIFIC_PROVIDER, posterKey: v.poster_key, source: v.source, opId };
  let r: McpCallResult;
  try {
    r = await mcp.callTool(d.tool, args);
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    await insertVideoRow(env, { ...row, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  const ids = r.isError ? [] : parseIdentifiers(r).filter((x) => x !== args.creationIdentifier);
  const direct = r.isError ? null : firstUrl(jsonOf(r), resultText(r));
  if (!ids.length && direct && /\.mp4(\?|$)/i.test(direct)) {
    // A tool that answers with the file at once: stored now, no polling.
    await insertVideoRow(env, { ...row, status: "queued", requestId: null, error: null, settings });
    const fresh = (await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ?", id))!;
    await storeFinishedClip(env, b, fresh, direct, magnificFetcher());
    await updateIntegrationOp(env, opId, { status: "done", reported: estimate, taskId: id });
    return versionItem(env, b.id, v.post, id);
  }
  if (!ids.length) {
    const message = `Magnific did not start ${meta.label.toLowerCase()}: ${resultText(r).slice(0, 300) || "no creation identifier in the answer"}`;
    await insertVideoRow(env, { ...row, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insertVideoRow(env, { ...row, status: "queued", requestId: ids[0], error: null, settings: { ...settings, identifiers: ids } });
  await updateIntegrationOp(env, opId, { taskId: ids[0], status: "running" });
  return versionItem(env, b.id, v.post, id);
}

/* ───────────── Polling, from settlePending ───────────── */

/** The in-flight Magnific creations asked about with one `creations_wait` (a short wait), six at most. */
export async function settleMagnificPending(env: Env, b: { id: string; owner: string }, rows: VideoRow[]): Promise<void> {
  const pending = rows.filter((v) => (v.status === "queued" || v.status === "generating") && v.provider === MAGNIFIC_PROVIDER).slice(0, POLL_LIMIT);
  if (!pending.length) return;
  const fail = async (v: VideoRow, message: string) => {
    await run(env.DB, "UPDATE videos SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), v.id);
    v.status = "failed";
    v.error = message;
    if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "failed", note: message });
  };
  const old = (v: VideoRow) => now() - v.created > GIVE_UP_MS;
  const withId: VideoRow[] = [];
  for (const v of pending) {
    if (v.request_id) withId.push(v);
    else if (old(v)) await fail(v, "The outcome of this Magnific run was never learned and nothing was sent again.");
  }
  if (!withId.length) return;
  const mcp = await MagnificMcp.open(env);
  if (!mcp) {
    for (const v of withId) if (old(v)) await fail(v, "Magnific is not signed in; the clip could not be collected in half an hour.");
    return;
  }
  let answer: McpCallResult;
  try {
    answer = await mcp.callTool("creations_wait", { identifiers: withId.map((v) => v.request_id), timeoutSeconds: 1 });
  } catch (e) {
    console.error("[video-magnific] creations_wait", errorMessage(e));
    for (const v of withId) if (old(v)) await fail(v, "Magnific could not be asked for half an hour.");
    return;
  }
  const entries = parseCreations(answer);
  for (const v of withId) {
    const e = entries.find((x) => x.identifier === v.request_id);
    try {
      if (!e) {
        if (old(v)) await fail(v, "Magnific no longer lists this creation.");
        continue;
      }
      if (DONE.test(e.status) || (!e.status && e.url)) {
        if (!e.url) {
          await fail(v, "The creation finished without a video link.");
          continue;
        }
        await storeFinishedClip(env, b, v, e.url, magnificFetcher());
        const s = parseSettings(v);
        if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "done", reported: s.estimate ?? null, note: `${s.estimate ?? "?"} credits (Magnific, from the estimate)` });
      } else if (FAILED.test(e.status)) {
        await fail(v, e.error ? `Magnific failed: ${e.error}` : "Magnific failed to make this clip.");
      } else if (old(v)) {
        await fail(v, "Magnific did not finish in half an hour.");
      } else if (v.status === "queued" && /^(running|processing|in_progress|generating|started|rendering)$/.test(e.status)) {
        await run(env.DB, "UPDATE videos SET status = 'generating', updated = ? WHERE id = ?", now(), v.id);
        v.status = "generating";
      }
    } catch (err) {
      console.error("[video-magnific] settle", v.id, errorMessage(err));
    }
  }
}

registerPendingSettler(MAGNIFIC_PROVIDER, settleMagnificPending);

/* ───────────── Routes ───────────── */

async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "freepik");
  await assertIntegrationEnabled(c.env, "freepik");
  return u;
}

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** Connected?, admin, the switch: so the panel can say "Admins only for now" or "Not connected" without a call. Every member. */
videoMagnificRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const source = await tokenSource(c.env);
  return c.json({ ok: true, connected: !!source, source, admin: user.role === "admin", access: await integrationAccess(c.env, user, "freepik"), tools: Object.entries(MAGNIFIC_ENHANCE_TOOLS).map(([name, t]) => ({ name, ...t })), reason: source ? "" : MCP_NOT_CONNECTED });
});

/** The video engines, cached a day; `?refresh=1` asks again. Admins. */
videoMagnificRoutes.get("/models", async (c) => {
  await gate(c);
  const mcp = await openMcp(c.env);
  const { models, at } = await magnificVideoModels(c.env, mcp, c.req.query("refresh") === "1");
  return c.json({ ok: true, models, at });
});

/** The colour-grade LUTs, cached a day. Admins. */
videoMagnificRoutes.get("/luts", async (c) => {
  await gate(c);
  const mcp = await openMcp(c.env);
  const { luts, at } = await magnificLuts(c.env, mcp, c.req.query("refresh") === "1");
  return c.json({ ok: true, luts, at });
});

videoMagnificRoutes.post("/generate", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, generateSchema);
  return c.json({ ok: true, video: await generateMagnificVideo(c.env, user, d) });
});

videoMagnificRoutes.post("/enhance", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, enhanceSchema);
  return c.json({ ok: true, video: await enhanceMagnificVideo(c.env, user, d) });
});
