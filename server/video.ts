/**
 * Video versions of a post: a finished picture (or the composed artwork with its words and logo)
 * becomes a short clip on Higgsfield Cloud, or an mp4 is uploaded as a labelled sample. Every clip
 * is a version of the post; one of them can be the version the client reviews.
 *
 * Routes (mounted at /api/studio/posts/video):
 *   POST /            submit a clip (admins; the cost must be known or confirmed)
 *   POST /retry       a failed clip submitted again as a new job
 *   GET  /list        a post's clips, newest first; in-flight ones are asked about and stored when done
 *   GET  /summary     one line per post of the month (the cards)
 *   POST /select      the version the client sees (for_client), or none
 *   POST /upload      an mp4 sample (admins), stored as a done version, with its preview rendition when the browser made one
 *   GET|HEAD /file    the mp4, with Range
 *   GET|HEAD /preview the lightweight preview of the mp4 (small, short, muted), with Range
 *   POST /preview     a preview rendition (small mp4 and/or still) kept with a finished version (admins)
 *   GET  /poster      the clip's own still when one was kept, else the still the clip started from
 *
 * The cron never submits a clip: only a person does, here.
 */
import { Hono } from "hono";
import { z } from "zod";
import { PREVIEW_MESSAGE, previewNoImages, type Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { makeClient } from "./engine";
import { signObjectUrl } from "./signed";
import { getSetting } from "./settings";
import { ownedPlan } from "./posts";
import { serveObject } from "./range";
import { readMp4 } from "./mp4";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, integrationEstimate, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { CREDITS_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { checkVideoSettings, VIDEO_MODELS, videoModel, videoPriceSetting, videoRequestInput, type VideoModel, type VideoSettings } from "@shared/video-models";
import { isFill, isFrame, pictureFrame, type FrameFill, type FrameId } from "@shared/video-frame";
import type { HiggsfieldClient } from "./higgsfield";
import type { User } from "@shared/types";
import type { AudioChoice } from "@shared/video-audio";

type Variables = { user: User };
export const videoRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export type VideoStatus = "queued" | "generating" | "done" | "failed";
export type VideoSource = "picture" | "artwork" | "upload" | "editor";

export interface VideoRow {
  id: string;
  batch: string;
  post: number;
  task: string;
  owner: string;
  model: string;
  prompt: string;
  status: VideoStatus;
  request_id: string | null;
  key: string | null;
  error: string | null;
  created: number;
  updated: number;
  provider: string;
  settings: string | null;
  poster_key: string | null;
  source: VideoSource;
  for_client: number;
  op_id: string | null;
  /** The version's audio choice (shared/video-audio.ts), null when none was made. */
  audio_choice: AudioChoice | null;
  audio_id: string | null;
  /** The studio card shows the done version with the highest rank (migration 0076); null: never put there. */
  card_rank?: number | null;
}

/** The settings stored with a clip: what was asked, plus what the submission learned. */
interface StoredSettings extends Partial<VideoSettings> {
  estimate?: number | null;
  estimateSource?: "catalog" | "setting" | "provider" | "confirmed";
  credits?: number | null;
  faststart?: boolean | null;
  codecs?: string[];
  width?: number | null;
  height?: number | null;
  warnings?: string[];
  note?: string;
  /** What made this version, in plain words ("Preset · Hero shot", "Magnific · kling-3", "Upscale (Magnific) of Video 2"). */
  label?: string;
  /** The last Check answer on this version (the Video studio's Check panel). */
  check?: { tool: string; at: number; text: string; credits: number | null } | null;
  /** A Higgsfield video analysis started on this version, polled by the Check panel. */
  analysis?: { id: string; status: string; text: string; at: number } | null;
  /** The frame asked for ("9:16"), handed to the engine as its aspect or composed into the picture first (shared/video-frame.ts). */
  frame?: FrameId | null;
  /** How the picture was made to fit the frame in the browser, when it was ("crop" or "blur"); absent when the engine took the frame itself. */
  frameFill?: FrameFill | null;
  /** True when the words and logo were drawn into the first frame; false for the bare picture (composed to a frame or not). */
  words?: boolean | null;
  /** The lightweight preview rendition (a small, short, muted H.264 mp4 the browser made), for cards and galleries. */
  previewKey?: string;
  previewBytes?: number;
  /** A small JPEG/WebP/PNG still of the clip's own first frame (the browser made it), the poster when present. */
  stillKey?: string;
}

/** The frame fields a submit body may carry: `frame` (one of the four), `fill` (crop | blur), `words` (the words drawn in). */
export const frameFields = {
  frame: z.string().max(10).refine((s) => isFrame(s), "Unknown frame: use 9:16, 4:5, 1:1 or 16:9.").optional(),
  fill: z.string().max(10).refine((s) => isFill(s), "Unknown fill: use crop or blur.").optional(),
  words: z.boolean().optional(),
};

/** What of a body's frame fields goes into the version's settings. */
export function frameSettings(d: { frame?: string; fill?: string; words?: boolean; source?: string }): Pick<StoredSettings, "frame" | "frameFill" | "words"> {
  const out: Pick<StoredSettings, "frame" | "frameFill" | "words"> = {};
  if (isFrame(d.frame)) out.frame = d.frame;
  if (isFill(d.fill)) out.frameFill = d.fill;
  if (typeof d.words === "boolean") out.words = d.words;
  else if (d.source === "artwork" && !isFill(d.fill)) out.words = true; // the artwork as before the frame control: the words drawn in
  return out;
}

const MAX_UPLOAD = 60 * 1024 * 1024;
const MAX_ARTWORK = 12 * 1024 * 1024;
/** A clip the engine has not finished after this long is marked failed; nothing is retried by itself. */
export const GIVE_UP_MS = 30 * 60 * 1000;
/** The same clip (post, prompt, settings, source) is not submitted twice within this window. */
const CLAIM_TTL_MS = 10 * 60 * 1000;
/** How many in-flight clips one list call asks the provider about. */
const POLL_LIMIT = 6;

export function parseSettings(v: VideoRow): StoredSettings {
  try {
    return v.settings ? (JSON.parse(v.settings) as StoredSettings) : {};
  } catch {
    return {};
  }
}

export interface VideoItem {
  id: string;
  post: number;
  model: string;
  provider: string;
  source: VideoSource;
  prompt: string;
  status: VideoStatus;
  error: string | null;
  created: number;
  updated: number;
  duration: number | null;
  aspect: string | null;
  resolution: string | null;
  estimate: number | null;
  forClient: boolean;
  requestId: string | null;
  url: string | null;
  poster: string | null;
  /** The lightweight preview rendition for cards and galleries (small, short, muted); null when none was made: use `url`. */
  preview: string | null;
  /** The clip's number among the post's clips, oldest first ("Video 2"). */
  version: number;
  warnings: string[];
  /** The audio choice made for this version, else what the generation settings imply (engine sound on/off), else null. */
  audioChoice: AudioChoice | null;
  audioId: string | null;
  /** The uploaded or generated track's name, when the choice points at one and the caller looked it up. */
  audioName: string | null;
  /** What made this version, when the maker said ("Preset · Hero shot"); null for the plain engines. */
  label: string | null;
  check: { tool: string; at: number; text: string; credits: number | null } | null;
  analysis: { id: string; status: string; text: string; at: number } | null;
  /** The frame asked for ("9:16"), null for versions made before the frame control or uploaded. */
  frame: FrameId | null;
  /** "crop" or "blur" when the picture was composed to the frame in the browser; null when the engine took the frame or none was asked. */
  frameFill: FrameFill | null;
  /** True when the words and logo are in the clip's first frame; false for the bare picture; null when not known (older versions, uploads). */
  words: boolean | null;
  /** The encoded size read from the stored file, when known. */
  width: number | null;
  height: number | null;
  /** The editor project and its saved revision this version was rendered from (editor renders only). */
  project: { id: string; rev: number } | null;
}

/** The names of a post's tracks by id, for the versions list ("Track: Summer loop"). */
export async function audioNamesFor(env: Env, batch: string, post: number): Promise<Map<string, string>> {
  const rows = await all<{ id: string; name: string | null }>(env.DB, "SELECT id, name FROM video_audio WHERE batch = ? AND post = ?", batch, post);
  return new Map(rows.map((r) => [r.id, r.name ?? ""]));
}

export function videoItem(v: VideoRow, version: number, audioNames?: Map<string, string>): VideoItem {
  const s = parseSettings(v);
  const q = `batch=${encodeURIComponent(v.batch)}&id=${encodeURIComponent(v.id)}`;
  const audioChoice: AudioChoice | null = v.audio_choice ?? (s.audio === true ? "provider" : s.audio === false ? "none" : null);
  return {
    id: v.id,
    post: v.post,
    model: v.model,
    provider: v.provider,
    source: v.source,
    prompt: v.prompt,
    status: v.status,
    error: v.error,
    created: v.created,
    updated: v.updated,
    duration: s.duration ?? null,
    aspect: s.aspect ?? null,
    resolution: s.resolution ?? null,
    estimate: s.estimate ?? null,
    forClient: v.for_client === 1,
    requestId: v.request_id,
    url: v.key ? `/api/studio/posts/video/file?${q}` : null,
    poster: v.poster_key || s.stillKey ? `/api/studio/posts/video/poster?${q}` : null,
    preview: v.key && s.previewKey ? `/api/studio/posts/video/preview?${q}` : null,
    version,
    warnings: s.warnings ?? [],
    audioChoice,
    audioId: v.audio_id ?? null,
    audioName: v.audio_id ? (audioNames?.get(v.audio_id) ?? null) : null,
    label: typeof s.label === "string" ? s.label : null,
    check: s.check ?? null,
    analysis: s.analysis ?? null,
    // The frame the file really has wins over the one asked for (an engine may follow the picture's frame instead).
    frame: (s.width && s.height ? pictureFrame(s.width, s.height) : null) ?? (isFrame(s.frame) ? s.frame : null),
    frameFill: isFill(s.frameFill) ? s.frameFill : null,
    words: typeof s.words === "boolean" ? s.words : v.source === "artwork" && !isFill(s.frameFill) ? true : v.source === "picture" ? false : null,
    width: typeof s.width === "number" ? s.width : null,
    height: typeof s.height === "number" ? s.height : null,
    project: typeof (s as { project?: unknown }).project === "string" && typeof (s as { rev?: unknown }).rev === "number" ? { id: (s as { project: string }).project, rev: (s as { rev: number }).rev } : null,
  };
}

export interface NewVideoRow {
  id: string;
  batch: string;
  post: number;
  task: string;
  owner: string;
  model: string;
  prompt: string;
  status: VideoStatus;
  requestId: string | null;
  error: string | null;
  provider: string;
  settings: Record<string, unknown>;
  posterKey: string | null;
  source: VideoSource;
  opId: string | null;
}

/** One `videos` row as a provider adapter writes it (queued with a job id, or failed with the provider's words). */
export async function insertVideoRow(env: Env, r: NewVideoRow): Promise<void> {
  const ts = now();
  await run(
    env.DB,
    "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    r.id,
    r.batch,
    r.post,
    r.task,
    r.owner,
    r.model,
    r.prompt,
    r.status,
    r.requestId,
    r.error,
    ts,
    ts,
    r.provider,
    JSON.stringify(r.settings),
    r.posterKey,
    r.source,
    r.opId,
  );
}

/** A version's settings changed in place (a creation id learned, a check answer kept). */
export async function patchVideoSettings(env: Env, v: VideoRow, patch: Record<string, unknown>): Promise<void> {
  const s = { ...parseSettings(v), ...patch };
  v.settings = JSON.stringify(s);
  await run(env.DB, "UPDATE videos SET settings = ?, updated = ? WHERE id = ?", v.settings, now(), v.id);
}

/** The version a tool works on: finished, stored, on this month and post. */
export async function finishedVersion(env: Env, batch: string, id: string): Promise<VideoRow> {
  const v = await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", id, batch);
  if (!v) throw new StudioError("Video not found.", 404);
  if (v.status !== "done" || !v.key) throw new StudioError("Only a finished clip can be worked on.", 409);
  return v;
}

/**
 * A finished clip becomes the client's version when the post has none yet (the share page shows
 * the clip without anyone selecting it); a post whose client version was already chosen keeps it.
 * The team can still change or clear it under Versions ("Select for client review" / "Show the
 * picture instead"). Returns true when this clip was marked.
 */
export async function autoSelectForClient(env: Env, v: { id: string; batch: string; post: number; status: VideoStatus; key: string | null; for_client?: number }): Promise<boolean> {
  if (v.status !== "done" || !v.key) return false;
  const r = await env.DB.prepare("UPDATE videos SET for_client = 1, updated = ? WHERE id = ? AND status = 'done' AND key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM videos WHERE batch = ? AND post = ? AND for_client = 1)").bind(now(), v.id, v.batch, v.post).run();
  const marked = (r.meta?.changes ?? 0) > 0;
  if (marked) v.for_client = 1;
  return marked;
}

/** The version's item with its number among the post's clips, after a change. */
export async function versionItem(env: Env, batch: string, post: number, id: string): Promise<VideoItem> {
  const rows = await postRows(env, batch, post);
  const row = rows.find((v) => v.id === id);
  if (!row) throw new StudioError("Video not found.", 404);
  return videoItem(row, versionNumbers(rows).get(id) ?? rows.length, await audioNamesFor(env, batch, post));
}

/** Each clip's number among its post's clips, oldest first. */
export function versionNumbers(rows: { id: string; post: number; created: number }[]): Map<string, number> {
  const byPost = new Map<number, { id: string; created: number }[]>();
  for (const r of rows) byPost.set(r.post, [...(byPost.get(r.post) ?? []), r]);
  const out = new Map<string, number>();
  for (const list of byPost.values()) list.sort((a, b) => a.created - b.created).forEach((r, i) => out.set(r.id, i + 1));
  return out;
}

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function dataUrlBytes(dataUrl: string): { bytes: ArrayBuffer; mime: string } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new StudioError("The artwork must be a PNG or JPEG picture.");
  const bin = atob(m[2]);
  if (bin.length > MAX_ARTWORK) throw new StudioError("The artwork is too large (12 MB at most).");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out.buffer, mime: m[1] };
}

/**
 * What one clip costs, in this order: the catalog's price, the admin's fallback setting, the
 * provider's own estimate for this exact request. Null when none of them knows.
 */
export async function clipEstimate(
  env: Env,
  engine: HiggsfieldClient | null,
  model: VideoModel,
  input: Record<string, unknown>,
): Promise<{ usd: number | null; credits: number | null; source: "catalog" | "setting" | "provider" | null }> {
  if (typeof model.price === "number") return { usd: model.price, credits: null, source: "catalog" };
  const setting = Number((await getSetting(env, videoPriceSetting(model.slug))) ?? "");
  if (Number.isFinite(setting) && setting > 0) return { usd: setting, credits: null, source: "setting" };
  // The one figure an admin entered under Admin → Integrations ("estimated cost per video clip") covers every engine.
  const general = await integrationEstimate(env, "higgsfield", "video");
  if (general !== null && general > 0) return { usd: general, credits: null, source: "setting" };
  if (engine) {
    try {
      const e = await engine.estimate(model.slug, input);
      if (e && (e.usd !== null || e.credits !== null)) return { usd: e.usd, credits: e.credits, source: "provider" };
    } catch (err) {
      console.error("[video] estimate", model.slug, errorMessage(err));
    }
  }
  return { usd: null, credits: null, source: null };
}

interface ClipAsk {
  model: VideoModel;
  prompt: string;
  settings: VideoSettings;
  source: "picture" | "artwork";
  /** The still the clip starts from (the task's picture, or the stored artwork). */
  posterKey: string;
  /** The person confirmed a clip whose cost is not known. */
  confirm: boolean;
  note?: string;
  /** The frame asked for, how the picture was fitted to it, and whether the words are in it (shared/video-frame.ts). */
  frame?: Pick<StoredSettings, "frame" | "frameFill" | "words">;
}

/**
 * One clip submitted to Higgsfield: the cost is settled first (or refused), the same ask within
 * ten minutes is refused, the op is recorded, then the job goes out with an idempotency key. A
 * submission the provider rejects is kept as a failed version with its message; nothing retries
 * by itself.
 */
async function submitClip(env: Env, user: User, b: { id: string; owner: string }, task: { id: string }, index: number, ask: ClipAsk): Promise<VideoRow> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const engine = await makeClient(env);
  const imageUrl = await signObjectUrl(env, ask.posterKey, 6 * 60 * 60 * 1000);
  const input = videoRequestInput(ask.model, ask.prompt, imageUrl, ask.settings);
  // The estimate is asked with the same body the generation gets, minus the signed picture link.
  const estimate = await clipEstimate(env, engine, ask.model, { ...input, image_url: "https://example.com/input.jpg" });
  if (estimate.usd === null && estimate.credits === null && !ask.confirm)
    throw new StudioError(`The cost of a ${ask.model.name} clip is not known yet. An admin can set its price in Connection → Higgsfield, or confirm this clip at an unknown cost.`, 409, false, {
      needsEstimate: true,
      model: ask.model.slug,
    });
  const fingerprint = await sha256([ask.model.slug, ask.prompt.trim(), JSON.stringify(ask.settings), ask.source, ask.posterKey].join("\n"));
  if (!(await claimSubmission(env, `video:${b.id}:${index}:${fingerprint}`, CLAIM_TTL_MS)))
    throw new StudioError("This exact clip was asked for a moment ago. Wait for it, or change the idea or the settings.", 409);
  const id = uuid();
  const estimateUsd = estimate.usd;
  const stored: StoredSettings = {
    ...ask.settings,
    ...(ask.frame ?? {}),
    estimate: estimateUsd,
    credits: estimate.credits,
    estimateSource: estimate.source ?? "confirmed",
    note: ask.note,
  };
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "video",
    user: user.id,
    batch: b.id,
    post: index,
    estimate: estimateUsd,
    status: "confirmed",
    note: `${ask.model.name} · ${ask.settings.duration}s · ${ask.source}${ask.frame?.frame ? ` · frame ${ask.frame.frame}${ask.frame.frameFill ? ` (${ask.frame.frameFill})` : ""}` : ""}${estimate.source ? ` · estimate from ${estimate.source}` : " · cost unknown, confirmed"}`,
  });
  const t = now();
  const insert = (status: VideoStatus, requestId: string | null, error: string | null) =>
    run(
      env.DB,
      "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'higgsfield', ?, ?, ?, 0, ?)",
      id,
      b.id,
      index,
      task.id,
      user.id,
      ask.model.slug,
      ask.prompt,
      status,
      requestId,
      error,
      t,
      t,
      JSON.stringify(stored),
      ask.posterKey,
      ask.source,
      opId,
    );
  let requestId: string;
  try {
    requestId = await engine.submitVideo({ model: ask.model.slug, prompt: "", imageUrl, duration: ask.settings.duration, extra: input, idempotencyKey: id });
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    await insert("failed", null, message);
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  await insert("queued", requestId, null);
  await updateIntegrationOp(env, opId, { taskId: requestId, status: "running" });
  return (await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ?", id))!;
}

export type PendingSettler = (env: Env, b: { id: string; owner: string }, rows: VideoRow[]) => Promise<void>;
const pendingSettlers = new Map<string, PendingSettler>();

/**
 * Another provider's way of asking about its in-flight clips (the Higgsfield MCP adapter registers
 * `higgsfield-mcp`): `settlePending` hands it the rows of that provider that are still queued or
 * generating. Nothing here submits anything.
 */
export function registerPendingSettler(provider: string, fn: PendingSettler): void {
  pendingSettlers.set(provider, fn);
}

/**
 * A finished clip fetched from the provider's URL into R2 and marked done, with what the mp4's
 * boxes say (faststart, codecs, size) kept in the version's settings. The op is left to the caller,
 * which knows what the provider reported.
 */
export async function storeFinishedClip(env: Env, b: { id: string; owner: string }, v: VideoRow, url: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new StudioError(`The video could not be fetched (${r.status}).`, 502);
  const key = `${b.owner}/${b.id}/video/${v.task}/${v.id}.mp4`;
  const bytes = await r.arrayBuffer();
  const info = readMp4(bytes);
  const s = parseSettings(v);
  s.faststart = info.faststart;
  s.codecs = info.codecs;
  s.width = info.width;
  s.height = info.height;
  if (info.duration) s.duration = s.duration ?? Math.round(info.duration);
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  await run(env.DB, "UPDATE videos SET status = 'done', key = ?, error = NULL, settings = ?, updated = ? WHERE id = ?", key, JSON.stringify(s), now(), v.id);
  v.status = "done";
  v.key = key;
  v.settings = JSON.stringify(s);
  // The first finished clip of a post is what the client sees, until the team chooses otherwise.
  await autoSelectForClient(env, v);
}

/**
 * The in-flight clips asked about, bounded: a finished one is downloaded into R2 and marked done,
 * a failed one keeps the provider's message, one older than half an hour is given up. Nothing is
 * submitted again here.
 */
export async function settlePending(env: Env, b: { id: string; owner: string }, rows: VideoRow[]): Promise<void> {
  for (const [provider, settle] of pendingSettlers) {
    const mine = rows.filter((v) => (v.status === "queued" || v.status === "generating") && v.provider === provider);
    if (mine.length) await settle(env, b, mine).catch((e) => console.error("[video] settle", provider, errorMessage(e)));
  }
  const pending = rows.filter((v) => (v.status === "queued" || v.status === "generating") && v.provider === "higgsfield").slice(0, POLL_LIMIT);
  if (!pending.length) return;
  const engine = await makeClient(env).catch(() => null);
  for (const v of pending) {
    const fail = async (message: string) => {
      await run(env.DB, "UPDATE videos SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), v.id);
      v.status = "failed";
      v.error = message;
      if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "failed", note: message });
    };
    try {
      if (!v.request_id) {
        await fail("The clip was never submitted.");
        continue;
      }
      if (!engine) {
        if (now() - v.created > GIVE_UP_MS) await fail("Higgsfield is not connected; the clip could not be collected in half an hour.");
        continue;
      }
      const st = await engine.videoStatus(v.request_id);
      if (st.state === "done") {
        await storeFinishedClip(env, b, v, st.url);
        if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "done" });
      } else if (st.state === "failed") {
        await fail(st.message);
      } else if (now() - v.created > GIVE_UP_MS) {
        await fail("The engine did not finish in half an hour.");
      } else if (st.raw === "in_progress" && v.status === "queued") {
        await run(env.DB, "UPDATE videos SET status = 'generating', updated = ? WHERE id = ?", now(), v.id);
        v.status = "generating";
      }
    } catch (e) {
      console.error("[video] status", v.id, errorMessage(e));
    }
  }
}

export async function postRows(env: Env, batch: string, index: number): Promise<VideoRow[]> {
  return all<VideoRow>(env.DB, "SELECT * FROM videos WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 30", batch, index);
}

const MAX_POST = 200;

const submitSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(MAX_POST),
  prompt: z.string().trim().max(5000).default(""),
  model: z.string().refine((m) => !!videoModel(m), "Unknown video engine."),
  duration: z.number().int().min(1).max(60).optional(),
  aspect: z.string().max(10).optional(),
  resolution: z.string().max(10).optional(),
  audio: z.boolean().optional(),
  source: z.enum(["picture", "artwork"]).default("picture"),
  /** The composed post (words and logo drawn by the browser, or the picture fitted to the frame) as a data URL, when source is "artwork". */
  artwork: z.string().max(17 * 1024 * 1024).optional(),
  confirm: z.boolean().optional(),
  note: z.string().trim().max(200).optional(),
  ...frameFields,
});

export type SubmitInput = z.infer<typeof submitSchema>;

/**
 * Makes the video: the post's picture (or its artwork) is the first frame, the idea is the motion.
 * The caller has checked the admin and the switch; the Prompt Box calls this too.
 */
export async function submitVideoRequest(env: Env, user: User, d: SubmitInput): Promise<VideoItem> {
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const model = videoModel(d.model);
  if (!model) throw new StudioError("Unknown video engine.");
  if (model.promptRequired && d.prompt.trim().length < 5) throw new StudioError(`${model.name} needs a motion idea of a few words.`);
  const checked = checkVideoSettings(model, { duration: d.duration, aspect: d.aspect, resolution: d.resolution, audio: d.audio });
  if (!checked.ok) throw new StudioError(checked.reason);
  let posterKey = t.output;
  if (d.source === "artwork") {
    if (!d.artwork) throw new StudioError("Send the artwork (the post with its words and logo) to make the clip from it.");
    const art = dataUrlBytes(d.artwork);
    posterKey = `${b.owner}/${b.id}/video/${t.id}/${uuid()}.artwork.${art.mime === "image/png" ? "png" : art.mime === "image/webp" ? "webp" : "jpg"}`;
    await env.BUCKET.put(posterKey, art.bytes, { httpMetadata: { contentType: art.mime } });
  }
  const row = await submitClip(env, user, b, t, d.index, { model, prompt: d.prompt.trim(), settings: checked.settings, source: d.source, posterKey, confirm: !!d.confirm, note: d.note, frame: frameSettings(d) });
  const rows = await postRows(env, b.id, d.index);
  const numbers = versionNumbers(rows);
  return videoItem(row, numbers.get(row.id) ?? rows.length);
}

/** The Cloud API path is refused while the admin chose the subscription credits (the MCP adapter takes those clips). */
async function assertCloudBilling(env: Env): Promise<void> {
  if ((await higgsfieldBilling(env)) === "credits") throw new StudioError(CREDITS_CHOSEN, 409, false, { billing: "credits" });
}

videoRoutes.post("/", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  await assertCloudBilling(c.env);
  const d = await parseBody(c, submitSchema);
  return c.json({ ok: true, video: await submitVideoRequest(c.env, user, d) });
});

/** A failed clip asked for again: a new job, a new op, the same idea and settings. */
videoRoutes.post("/retry", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  await assertCloudBilling(c.env);
  const d = await parseBody(c, z.object({ batch: z.string().min(1), id: z.string().min(1), confirm: z.boolean().optional() }));
  const b = await ownedPlan(c.env, user, d.batch);
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", d.id, b.id);
  if (!v) throw new StudioError("Video not found.", 404);
  if (v.status !== "failed") throw new StudioError("Only a failed clip is tried again.", 409);
  if (v.provider !== "higgsfield" || (v.source !== "picture" && v.source !== "artwork")) throw new StudioError("This version was not made by Higgsfield.", 409);
  const model = videoModel(v.model);
  if (!model) throw new StudioError("This clip's engine is no longer in the catalog.", 409);
  const t = await first<{ id: string; output: string | null }>(c.env.DB, "SELECT id, output FROM tasks WHERE id = ?", v.task);
  if (!t) throw new StudioError("That post has no picture any more.", 409);
  const s = parseSettings(v);
  const checked = checkVideoSettings(model, { duration: s.duration, aspect: s.aspect, resolution: s.resolution, audio: s.audio });
  if (!checked.ok) throw new StudioError(checked.reason);
  const posterKey = v.poster_key ?? t.output;
  if (!posterKey) throw new StudioError("That post has no picture any more.", 409);
  const row = await submitClip(c.env, user, b, t, v.post, { model, prompt: v.prompt, settings: checked.settings, source: v.source, posterKey, confirm: !!d.confirm, note: `try again of ${v.id}`, frame: { frame: s.frame, frameFill: s.frameFill, words: s.words } });
  const rows = await postRows(c.env, b.id, v.post);
  return c.json({ ok: true, video: videoItem(row, versionNumbers(rows).get(row.id) ?? rows.length) });
});

/** A post's clips, newest first; the ones still running are asked about and stored when done. */
videoRoutes.get("/list", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const index = Number(c.req.query("index"));
  if (!Number.isInteger(index) || index < 1) throw new StudioError("Post index is required.");
  const rows = await postRows(c.env, b.id, index);
  await settlePending(c.env, b, rows);
  const numbers = versionNumbers(rows);
  const prices: Record<string, number | null> = {};
  for (const m of VIDEO_MODELS) {
    const s = Number((await getSetting(c.env, videoPriceSetting(m.slug))) ?? "");
    prices[m.slug] = typeof m.price === "number" ? m.price : Number.isFinite(s) && s > 0 ? s : null;
  }
  const user = c.get("user");
  const names = await audioNamesFor(c.env, b.id, index);
  return c.json({ ok: true, videos: rows.map((v) => videoItem(v, numbers.get(v.id) ?? 0, names)), engines: VIDEO_MODELS, prices, admin: user.role === "admin", access: await integrationAccess(c.env, user, "higgsfield"), billing: await higgsfieldBilling(c.env) });
});

/** One line per post of the month: the version the client sees, and the newest clip (its progress or failure). */
videoRoutes.get("/summary", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const rows = await all<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE batch = ? ORDER BY created DESC LIMIT 600", b.id);
  await settlePending(c.env, b, rows);
  const numbers = versionNumbers(rows);
  const posts: Record<string, { latest: VideoItem; client: VideoItem | null; done: VideoItem | null; card: VideoItem | null }> = {};
  const cardRank = new Map<string, number>();
  for (const v of rows) {
    const k = String(v.post);
    const item = videoItem(v, numbers.get(v.id) ?? 0);
    posts[k] ??= { latest: item, client: null, done: null, card: null };
    if (v.for_client === 1 && v.status === "done") posts[k].client = item;
    if (v.status === "done" && !posts[k].done) posts[k].done = item;
    // The card's version: the done version put there last (a render, or an explicit choice).
    if (v.status === "done" && v.key && typeof v.card_rank === "number" && v.card_rank > (cardRank.get(k) ?? -Infinity)) {
      cardRank.set(k, v.card_rank);
      posts[k].card = item;
    }
  }
  return c.json({ ok: true, posts });
});

/** The version the client reviews on the link: one clip, or none (the picture alone). */
videoRoutes.post("/select", async (c) => {
  const d = await parseBody(c, z.object({ batch: z.string().min(1), index: z.number().int().min(1).max(MAX_POST), id: z.string().min(1).nullable() }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  if (d.id) {
    const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ? AND post = ?", d.id, b.id, d.index);
    if (!v) throw new StudioError("Video not found.", 404);
    if (v.status !== "done" || !v.key) throw new StudioError("Only a finished clip can go to the client.", 409);
  }
  await run(c.env.DB, "UPDATE videos SET for_client = 0, updated = ? WHERE batch = ? AND post = ? AND for_client = 1", now(), b.id, d.index);
  // An explicit choice is also what the card shows from now on: a render that started before it never replaces it.
  if (d.id) await run(c.env.DB, "UPDATE videos SET for_client = 1, card_rank = ?, updated = ? WHERE id = ?", now(), now(), d.id);
  else await run(c.env.DB, "UPDATE videos SET card_rank = NULL WHERE batch = ? AND post = ? AND card_rank IS NOT NULL", b.id, d.index);
  const rows = await postRows(c.env, b.id, d.index);
  const numbers = versionNumbers(rows);
  const names = await audioNamesFor(c.env, b.id, d.index);
  return c.json({ ok: true, videos: rows.map((v) => videoItem(v, numbers.get(v.id) ?? 0, names)) });
});

export const MAX_VIDEO_FILE = MAX_UPLOAD;

/** The lightweight preview rendition is small by design; anything larger is not a preview. */
export const MAX_PREVIEW = 6 * 1024 * 1024;
export const MAX_STILL = 1024 * 1024;

/**
 * The lightweight versions of a clip the browser made from it (Workers cannot transcode): a small,
 * short, muted H.264 mp4 for cards and galleries, and a still of its first frame for the poster.
 * Either may be missing (a browser without an H.264 encoder makes only the still).
 */
export interface Rendition {
  preview?: File | null;
  still?: File | null;
}

/** The still's type from its first bytes (JPEG, PNG, WebP), or null for anything else. */
export function stillType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** A rendition's form fields ('preview', 'still'), when they are files. */
export function renditionFrom(form: FormData): Rendition {
  const preview = form.get("preview");
  const still = form.get("still");
  return { preview: preview instanceof File ? preview : null, still: still instanceof File ? still : null };
}

/**
 * The rendition stored next to the clip (`<clip>.preview.mp4`, `<clip>.still.<ext>`), after its
 * checks: the preview a real H.264 mp4 of at most 6 MB, the still a JPEG, PNG or WebP of at most
 * 1 MB. What fails a check is left out (the full file still plays); the clip is never refused for it.
 */
export async function storeRendition(env: Env, clipKey: string, r: Rendition): Promise<Pick<StoredSettings, "previewKey" | "previewBytes" | "stillKey">> {
  const base = clipKey.replace(/\.mp4$/i, "");
  const out: Pick<StoredSettings, "previewKey" | "previewBytes" | "stillKey"> = {};
  if (r.preview && r.preview.size > 0 && r.preview.size <= MAX_PREVIEW) {
    const bytes = await r.preview.arrayBuffer();
    const info = readMp4(bytes);
    if (info.isMp4 && info.video === "h264") {
      const key = `${base}.preview.mp4`;
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
      out.previewKey = key;
      out.previewBytes = bytes.byteLength;
    }
  }
  if (r.still && r.still.size > 0 && r.still.size <= MAX_STILL) {
    const bytes = new Uint8Array(await r.still.arrayBuffer());
    const type = stillType(bytes);
    if (type) {
      const key = `${base}.still.${type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp"}`;
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
      out.stillKey = key;
    }
  }
  return out;
}

export interface StoreVideoAsk {
  /** The mp4 file as sent. */
  file: File;
  index: number;
  note: string;
  /** 'upload' for a sample a person attached, 'editor' for an export of the video editor. */
  provider: "upload" | "editor";
  source: "upload" | "editor";
  /** The model column (what made it): 'upload', or the editor's project id. */
  model?: string;
  /** Extra settings kept with the clip (the editor notes its project id and rev). */
  extra?: Record<string, unknown>;
  opId?: string | null;
  /** The lightweight preview and still the browser made from the file, when it could. */
  rendition?: Rendition;
  /** False: the caller decides where the version shows (the editor's promotion); default true (the first clip goes to the client). */
  autoSelect?: boolean;
}

/**
 * An mp4 stored as a finished version of a post, after the same checks for every origin: a real
 * MP4 (ftyp), H.264 video (else 400), AAC sound and a front `moov` noted as warnings when absent
 * (iPhone plays those from the first byte). The caller has settled who may do this. Returns the
 * stored row with its version number and what the file's boxes said.
 */
export async function storeVideoFile(env: Env, user: User, b: { id: string; owner: string }, ask: StoreVideoAsk): Promise<{ video: VideoItem; info: ReturnType<typeof readMp4> }> {
  const { file, index } = ask;
  if (file.size > MAX_UPLOAD) throw new StudioError("The video is too large (60 MB at most).");
  if (!Number.isInteger(index) || index < 1) throw new StudioError("Post index is required.");
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const bytes = await file.arrayBuffer();
  const info = readMp4(bytes);
  if (!info.isMp4) throw new StudioError("The file is not an MP4 (no ftyp box at the start).");
  if (info.video !== "h264") throw new StudioError(`The video must be H.264 in an MP4 for iPhone playback (found: ${info.codecs.join(", ") || "no video track"}).`);
  const warnings: string[] = [];
  if (info.audio && info.audio !== "aac") warnings.push("The sound is not AAC; iPhone may play it silently.");
  if (info.faststart === false) warnings.push("The moov index is at the end of the file; playback starts only after the whole file is fetched.");
  const id = uuid();
  const key = `${b.owner}/${b.id}/video/${t.id}/${id}.mp4`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  const rendition = ask.rendition ? await storeRendition(env, key, ask.rendition) : {};
  const note = ask.note.slice(0, 200);
  // An editor render keeps its length to a tenth of a second (the card and the client page show it).
  const duration = info.duration ? (ask.source === "editor" ? Math.round(info.duration * 10) / 10 : Math.round(info.duration)) : undefined;
  const settings: StoredSettings & Record<string, unknown> = { ...(ask.extra ?? {}), duration, faststart: info.faststart, codecs: info.codecs, width: info.width, height: info.height, warnings, note: note || undefined, estimate: 0, estimateSource: "catalog", ...rendition };
  const ts = now();
  await run(
    env.DB,
    "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?)",
    id,
    b.id,
    index,
    t.id,
    user.id,
    ask.model ?? ask.provider,
    note || file.name,
    key,
    ts,
    ts,
    ask.provider,
    JSON.stringify(settings),
    t.output,
    ask.source,
    ask.opId ?? null,
  );
  // A stored file is a finished clip: the client's version when the post has none yet.
  if (ask.autoSelect !== false) await autoSelectForClient(env, { id, batch: b.id, post: index, status: "done", key });
  const rows = await postRows(env, b.id, index);
  const row = rows.find((r) => r.id === id)!;
  return { video: videoItem(row, versionNumbers(rows).get(id) ?? 0), info };
}

/**
 * A labelled mp4 uploaded as a finished version (admins): tests playback end to end without a
 * paid call, and gives the video editor its raw footage. The checks live in `storeVideoFile`.
 */
videoRoutes.post("/upload", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") throw new StudioError("Only an admin can upload a video.", 403);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new StudioError("Send the video as a form upload.");
  const batch = String(form.get("batch") ?? "");
  const index = Number(form.get("index") ?? 0);
  const note = String(form.get("note") ?? "").slice(0, 200);
  const file = form.get("file");
  if (!(file instanceof File)) throw new StudioError("Attach the mp4 as 'file'.");
  if (file.size > MAX_UPLOAD) throw new StudioError("The video is too large (60 MB at most).");
  if (!Number.isInteger(index) || index < 1) throw new StudioError("Post index is required.");
  const b = await ownedPlan(c.env, user, batch);
  const { video, info } = await storeVideoFile(c.env, user, b, { file, index, note, provider: "upload", source: "upload", rendition: renditionFrom(form) });
  return c.json({ ok: true, video, info });
});

/**
 * A preview rendition kept with a finished version after the fact (admins): the Video studio makes
 * one in the browser for a clip an engine delivered (Workers cannot transcode). Nothing is generated
 * and no provider is called; the full file is untouched.
 */
videoRoutes.post("/preview", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") throw new StudioError("Only an admin can keep a preview.", 403);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new StudioError("Send the preview as a form upload.");
  const b = await ownedPlan(c.env, user, String(form.get("batch") ?? ""));
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", String(form.get("id") ?? ""), b.id);
  if (!v) throw new StudioError("Video not found.", 404);
  if (v.status !== "done" || !v.key) throw new StudioError("Only a finished clip has a preview.", 409);
  const kept = await storeRendition(c.env, v.key, renditionFrom(form));
  if (!kept.previewKey && !kept.stillKey) throw new StudioError("Nothing to keep: the preview must be an H.264 mp4 of at most 6 MB, the still a JPEG, PNG or WebP of at most 1 MB.");
  await patchVideoSettings(c.env, v, kept);
  const rows = await postRows(c.env, b.id, v.post);
  const names = await audioNamesFor(c.env, b.id, v.post);
  return c.json({ ok: true, video: videoItem(v, versionNumbers(rows).get(v.id) ?? 0, names) });
});

/** The lightweight preview, with Range and HEAD; the same access as the full file. */
videoRoutes.on(["GET", "HEAD"], "/preview", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", c.req.query("id") ?? "", b.id);
  const key = v?.key ? parseSettings(v).previewKey : undefined;
  if (!v || !key) throw new StudioError("Preview not found.", 404);
  return serveObject(c.env.BUCKET, key, c.req.raw, { contentType: "video/mp4", cacheControl: "private, max-age=86400" });
});

/** The stored mp4, with Range (seeking, iPhone) and HEAD. */
videoRoutes.on(["GET", "HEAD"], "/file", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", c.req.query("id") ?? "", b.id);
  if (!v?.key) throw new StudioError("Video not found.", 404);
  return serveObject(c.env.BUCKET, v.key, c.req.raw, { contentType: "video/mp4", cacheControl: "private, max-age=86400", filename: `post-${v.post}-video-${v.id.slice(0, 8)}.mp4` });
});

/** The poster under the player: the clip's own still when the browser kept one, else the still the clip started from. */
export function posterKeyOf(v: VideoRow): string | null {
  return parseSettings(v).stillKey ?? v.poster_key;
}

videoRoutes.get("/poster", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", c.req.query("id") ?? "", b.id);
  const key = v ? posterKeyOf(v) : null;
  const obj = key ? await c.env.BUCKET.get(key) : null;
  if (!obj) throw new StudioError("Poster not found.", 404);
  return new Response(obj.body ?? (await obj.arrayBuffer()), {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
});
