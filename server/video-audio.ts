/**
 * Audio for a post's video versions (docs/video.md "Audio"; the research in
 * docs/audio-capabilities.md). The server keeps a licensed track with the post and records which
 * audio choice each version carries; it never changes the clip's mp4 (no muxing on the Worker: the
 * browser-side video editor mixes the track in).
 *
 * Routes (mounted at /api/studio/posts/video/audio):
 *   POST /upload      a track (mp3, m4a, aac, wav; 25 MB at most), or a video whose sound is the
 *                     track (mp4, mov; 60 MB at most: "Sound from a video file") — admins, provider "audio"
 *   POST /instagram   the sound of a public Instagram reel from its link, read through the agency's
 *                     Meta connection (server/meta.ts `instagramVideo`) and kept as the reel's mp4 —
 *                     admins, provider "audio"; a ledger row at estimate 0
 *   GET  /list        the post's tracks — every signed-in user
 *   GET|HEAD /file    one track with Range — every signed-in user
 *   POST /choose      the audio choice of a version — admins; a ledger row at estimate 0
 *   POST /generate    not built: 503 "not connected", written to the ledger as refused
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { ownedPlan } from "./posts";
import { serveObject } from "./range";
import { readMp4 } from "./mp4";
import { assertIntegrationEnabled, integrationAccess, recordIntegrationOp, requireIntegrationAdmin } from "./integrations";
import { audioNamesFor, parseSettings, versionNumbers, videoItem, type VideoRow } from "./video";
import { instagramVideo } from "./meta";
import {
  AUDIO_CHOICES,
  AUDIO_MAX_BYTES,
  GENERATED_NOT_CONNECTED,
  INSTAGRAM_SOUND_WARNING,
  instagramSoundLicence,
  instagramSoundName,
  TRACK_MIMES,
  VIDEO_SOUND_MAX_BYTES,
  VIDEO_SOUND_MIMES,
  type AudioChoice,
} from "@shared/video-audio";
import type { User } from "@shared/types";

type Variables = { user: User };
export const videoAudioRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export interface AudioRow {
  id: string;
  batch: string;
  post: number;
  kind: "upload" | "generated";
  key: string | null;
  mime: string | null;
  name: string | null;
  duration_ms: number | null;
  license: string | null;
  provider: string | null;
  op_id: string | null;
  created: number;
  created_by: string;
}

export interface AudioItem {
  id: string;
  post: number;
  kind: "upload" | "generated";
  name: string;
  mime: string | null;
  durationMs: number | null;
  license: string;
  provider: string | null;
  created: number;
  createdBy: string;
  url: string | null;
}

const MAX_POST = 200;
const MAX_DURATION_MS = 60 * 60 * 1000;

export function audioItem(a: AudioRow): AudioItem {
  return {
    id: a.id,
    post: a.post,
    kind: a.kind,
    name: a.name ?? "",
    mime: a.mime,
    durationMs: a.duration_ms,
    license: a.license ?? "",
    provider: a.provider,
    created: a.created,
    createdBy: a.created_by,
    url: a.key ? `/api/studio/posts/video/audio/file?batch=${encodeURIComponent(a.batch)}&id=${encodeURIComponent(a.id)}` : null,
  };
}

/**
 * The upload's format from its name and type: the extension decides, the MIME must agree when the
 * browser sent one. Audio files only, unless `video` is set: then an mp4 or mov whose sound is the
 * track is taken too (a post's tracks; the music library keeps to audio files).
 */
export function audioFormat(fileName: string, type: string, opts: { video?: boolean } = {}): { ext: string; mime: string } | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? "").toLowerCase();
  const video = Object.hasOwn(VIDEO_SOUND_MIMES, ext);
  if (video && !opts.video) return null;
  const mime = Object.hasOwn(TRACK_MIMES, ext) ? TRACK_MIMES[ext] : undefined;
  if (!mime) return null;
  const sent = type.split(";")[0].trim().toLowerCase();
  const alias: Record<string, string[]> = {
    mp3: ["audio/mpeg", "audio/mp3"],
    m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
    aac: ["audio/aac", "audio/aacp", "audio/x-aac"],
    wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
    mp4: ["video/mp4", "audio/mp4", "application/mp4"],
    mov: ["video/quicktime"],
  };
  if (sent && sent !== "application/octet-stream" && !alias[ext].includes(sent)) return null;
  return { ext, mime };
}

/**
 * A video kept for its sound: an ISO MP4 or MOV (an `ftyp` box) that carries a sound track when its
 * index could be read. Its length, from the movie header, when found.
 */
function videoSound(bytes: ArrayBuffer, what: string): { durationMs: number | null } {
  const info = readMp4(bytes);
  if (!info.isMp4) throw new StudioError(`${what} is not an MP4 or MOV video.`, 415);
  if (info.codecs.length && !info.audio) throw new StudioError(`${what} has no sound: there is nothing to use as the track.`, 422);
  return { durationMs: info.duration ? Math.round(info.duration * 1000) : null };
}

/** A WAV's length from its header (sample rate × block size against the data chunk), when the chunks are where they usually are. */
export function wavDurationMs(bytes: ArrayBuffer): number | null {
  if (bytes.byteLength < 44) return null;
  const v = new DataView(bytes);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let o = 12;
  let byteRate = 0;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && o + 20 <= bytes.byteLength) byteRate = v.getUint32(o + 16, true);
    if (id === "data") return byteRate > 0 ? Math.round((Math.min(size, bytes.byteLength - o - 8) / byteRate) * 1000) : null;
    o += 8 + size + (size % 2);
  }
  return null;
}

async function postTracks(env: Env, batch: string, post: number): Promise<AudioRow[]> {
  return all<AudioRow>(env.DB, "SELECT * FROM video_audio WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 50", batch, post);
}

function postIndex(v: unknown): number {
  const index = Number(v);
  if (!Number.isInteger(index) || index < 1 || index > MAX_POST) throw new StudioError("Post index is required.");
  return index;
}

/**
 * A licensed track kept with the post (admins). The file is stored as sent; nothing is converted
 * or mixed here. The licence line is free text: who cleared the track, under what.
 */
videoAudioRoutes.post("/upload", async (c) => {
  const user = requireIntegrationAdmin(c, "audio");
  await assertIntegrationEnabled(c.env, "audio");
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new StudioError("Send the track as a form upload.");
  const batch = String(form.get("batch") ?? "");
  const index = postIndex(form.get("post") ?? form.get("index") ?? 0);
  const file = form.get("file");
  if (!(file instanceof File)) throw new StudioError("Attach the track as 'file'.");
  const fmt = audioFormat(file.name, file.type, { video: true });
  if (!fmt) throw new StudioError("The track must be an mp3, m4a, aac or wav file, or an mp4 or mov video with sound.", 415);
  const isVideo = Object.hasOwn(VIDEO_SOUND_MIMES, fmt.ext);
  if (isVideo ? file.size > VIDEO_SOUND_MAX_BYTES : file.size > AUDIO_MAX_BYTES) throw new StudioError(isVideo ? "The video is too large (60 MB at most)." : "The track is too large (25 MB at most).", 413);
  if (file.size === 0) throw new StudioError("The track is empty.");
  const name = String(form.get("name") ?? "").trim().slice(0, 120) || file.name.replace(/\.[a-z0-9]+$/i, "");
  const license = String(form.get("license") ?? "").trim().slice(0, 500);
  const sentDuration = Number(form.get("duration") ?? "");
  const b = await ownedPlan(c.env, user, batch);
  const bytes = await file.arrayBuffer();
  let durationMs: number | null = Number.isFinite(sentDuration) && sentDuration > 0 && sentDuration <= MAX_DURATION_MS ? Math.round(sentDuration) : null;
  if (fmt.ext === "wav") durationMs = wavDurationMs(bytes) ?? durationMs;
  if (fmt.ext === "m4a") {
    const info = readMp4(bytes);
    if (!info.isMp4) throw new StudioError("The m4a file is not an MPEG-4 container.", 415);
    if (info.duration) durationMs = Math.round(info.duration * 1000);
  }
  if (isVideo) durationMs = videoSound(bytes, "The video").durationMs ?? durationMs;
  const id = uuid();
  const key = `${b.owner}/${b.id}/audio/${index}/${id}.${fmt.ext}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: fmt.mime } });
  const opId = await recordIntegrationOp(c.env, {
    provider: "audio",
    kind: "audio.upload",
    user: user.id,
    batch: b.id,
    post: index,
    estimate: 0,
    status: "done",
    note: `${name} · ${fmt.ext} · ${Math.round(file.size / 1024)} KB${license ? ` · licence: ${license}` : " · no licence line"}`,
  });
  await run(
    c.env.DB,
    "INSERT INTO video_audio (id, batch, post, kind, key, mime, name, duration_ms, license, provider, op_id, created, created_by) VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    id,
    b.id,
    index,
    key,
    fmt.mime,
    name,
    durationMs,
    license,
    opId,
    now(),
    user.id,
  );
  const rows = await postTracks(c.env, b.id, index);
  return c.json({ ok: true, track: audioItem(rows.find((r) => r.id === id)!), tracks: rows.map(audioItem) });
});

const instagramSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(MAX_POST),
  link: z.string().trim().min(1).max(500),
});

/**
 * "Sound from an Instagram link" (admins): the reel's video is read through the agency's Meta
 * connection (server/meta.ts `instagramVideo`: oEmbed for the account, Business Discovery for the
 * post's file) and kept with the post as one of its tracks, the mp4 as it is, the same row an
 * upload writes (kind "upload", provider "instagram"). The editor then uses it as the music and
 * reads the AAC sound out of the mp4 in the browser. The licence line says where it came from and
 * that Instagram's sound is for Instagram only. A ledger row at estimate 0: reading costs nothing.
 */
videoAudioRoutes.post("/instagram", async (c) => {
  const user = requireIntegrationAdmin(c, "audio");
  await assertIntegrationEnabled(c.env, "audio");
  const parsed = instagramSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Paste the reel's Instagram link, and say which post (batch and index).");
  const d = parsed.data;
  const b = await ownedPlan(c.env, user, d.batch);
  const reel = await instagramVideo(c.env, d.link);
  const { durationMs } = videoSound(reel.bytes, "The reel's file");
  const name = instagramSoundName(reel.username);
  const license = instagramSoundLicence(reel.username, reel.permalink).slice(0, 500);
  const id = uuid();
  const key = `${b.owner}/${b.id}/audio/${d.index}/${id}.mp4`;
  await c.env.BUCKET.put(key, reel.bytes, { httpMetadata: { contentType: VIDEO_SOUND_MIMES.mp4 } });
  const opId = await recordIntegrationOp(c.env, {
    provider: "audio",
    kind: "audio.instagram",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: 0,
    status: "done",
    note: `${name} · mp4 · ${Math.round(reel.bytes.byteLength / 1024)} KB · ${reel.permalink.slice(0, 200)}`,
  });
  await run(
    c.env.DB,
    "INSERT INTO video_audio (id, batch, post, kind, key, mime, name, duration_ms, license, provider, op_id, created, created_by) VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, 'instagram', ?, ?, ?)",
    id,
    b.id,
    d.index,
    key,
    VIDEO_SOUND_MIMES.mp4,
    name,
    durationMs,
    license,
    opId,
    now(),
    user.id,
  );
  const rows = await postTracks(c.env, b.id, d.index);
  return c.json({ ok: true, track: audioItem(rows.find((r) => r.id === id)!), tracks: rows.map(audioItem), warning: INSTAGRAM_SOUND_WARNING });
});

/** The post's tracks, newest first; open to every signed-in user of the month. */
videoAudioRoutes.get("/list", async (c) => {
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, c.req.query("batch"));
  const index = postIndex(c.req.query("post") ?? c.req.query("index"));
  const rows = await postTracks(c.env, b.id, index);
  return c.json({ ok: true, tracks: rows.map(audioItem), access: await integrationAccess(c.env, user, "audio"), generated: { connected: false, reason: GENERATED_NOT_CONNECTED } });
});

/** One stored track, with Range and HEAD (the browser's audio element and the editor seek in it). */
videoAudioRoutes.on(["GET", "HEAD"], "/file", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const a = await first<AudioRow>(c.env.DB, "SELECT * FROM video_audio WHERE id = ? AND batch = ?", c.req.query("id") ?? "", b.id);
  if (!a?.key) throw new StudioError("Track not found.", 404);
  const ext = a.key.split(".").pop() ?? "mp3";
  return serveObject(c.env.BUCKET, a.key, c.req.raw, { contentType: a.mime ?? "application/octet-stream", cacheControl: "private, max-age=86400", filename: `post-${a.post}-audio-${a.id.slice(0, 8)}.${ext}` });
});

const chooseSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(MAX_POST),
  videoId: z.string().min(1),
  choice: z.enum(AUDIO_CHOICES as [AudioChoice, ...AudioChoice[]]),
  audioId: z.string().min(1).optional(),
});

/**
 * The audio choice of one version (admins). Written on the video row and in the ledger at
 * estimate 0: nothing is sent anywhere and the mp4 does not change.
 */
videoAudioRoutes.post("/choose", async (c) => {
  const user = requireIntegrationAdmin(c, "audio");
  await assertIntegrationEnabled(c.env, "audio");
  const parsed = chooseSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Say which version, and which audio choice (provider, none, upload, generated or instagram).");
  const d = parsed.data;
  const b = await ownedPlan(c.env, user, d.batch);
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ? AND post = ?", d.videoId, b.id, d.index);
  if (!v) throw new StudioError("Video not found.", 404);
  let audioId: string | null = null;
  let trackName: string | null = null;
  if (d.choice === "upload" || d.choice === "generated") {
    if (!d.audioId) throw new StudioError("Say which track (audioId).");
    const a = await first<AudioRow>(c.env.DB, "SELECT * FROM video_audio WHERE id = ? AND batch = ? AND post = ?", d.audioId, b.id, d.index);
    if (!a) throw new StudioError("Track not found.", 404);
    if (a.kind !== d.choice) throw new StudioError(`That track is ${a.kind === "upload" ? "an upload" : "generated"}; the choice says ${d.choice}.`, 409);
    audioId = a.id;
    trackName = a.name;
  }
  await run(c.env.DB, "UPDATE videos SET audio_choice = ?, audio_id = ?, updated = ? WHERE id = ?", d.choice, audioId, now(), v.id);
  const s = parseSettings(v);
  await recordIntegrationOp(c.env, {
    provider: "audio",
    kind: "audio.choose",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: 0,
    status: "done",
    note: `${d.choice}${trackName ? ` · ${trackName}` : ""} · version ${v.id.slice(0, 8)}${s.audio !== undefined ? ` (engine sound at generation: ${s.audio ? "on" : "off"})` : ""}`,
  });
  const rows = await all<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 30", b.id, d.index);
  const numbers = versionNumbers(rows);
  const names = await audioNamesFor(c.env, b.id, d.index);
  return c.json({ ok: true, videos: rows.map((r) => videoItem(r, numbers.get(r.id) ?? 0, names)) });
});

/**
 * Generated music is not built: no provider is connected for it (docs/audio-capabilities.md lists
 * what Magnific and Higgsfield would offer). The ask is refused with 503 and written to the ledger
 * as refused, so the panel shows who asked and when. Nothing is sent or charged.
 */
videoAudioRoutes.post("/generate", async (c) => {
  const user = requireIntegrationAdmin(c, "audio");
  await assertIntegrationEnabled(c.env, "audio");
  const body = (await c.req.json().catch(() => ({}))) as { batch?: string; index?: number; prompt?: string };
  const batch = typeof body.batch === "string" ? body.batch : null;
  const index = Number.isInteger(body.index) && (body.index as number) >= 1 ? (body.index as number) : null;
  if (batch) await ownedPlan(c.env, user, batch);
  const opId = await recordIntegrationOp(c.env, {
    provider: "audio",
    kind: "audio.generate",
    user: user.id,
    batch,
    post: index,
    estimate: null,
    status: "refused",
    note: `not connected${typeof body.prompt === "string" && body.prompt.trim() ? ` · ${body.prompt.trim().slice(0, 120)}` : ""}`,
  });
  throw new StudioError(GENERATED_NOT_CONNECTED, 503, false, { opId, connected: false });
});
