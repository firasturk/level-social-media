/**
 * The music library (docs/music-library.md): the studio's starter catalog (shared/music-catalog.ts)
 * and each client's own tracks, imported by an admin from Drive or an upload with the licence
 * filled in and confirmed. Nothing here is paid and no provider is called: the only outside reads
 * are the catalog's canonical files (Wikimedia Commons), copied once into our storage on first use
 * when the licence allows it, and Drive files shared with the service account.
 *
 * Routes (mounted at /api/studio/music):
 *   GET  /catalog?q&mood&genre&minDuration&maxDuration&minBpm&maxBpm&test=0   the catalog, filtered (everyone)
 *   GET  /library?client=&…same filters                                        a client's tracks (everyone)
 *   GET|HEAD /file?id=cat:<slug>|lib:<id>       the audio with Range (everyone); a catalog track is copied on first use
 *   GET  /peaks?id=                              the cached waveform; computed here for WAV test audio,
 *                                                otherwise null until a browser sends it
 *   PUT  /peaks {id, peaks, bpm?}                the waveform a browser computed: stored once, never overwritten (everyone)
 *   POST /library/upload   multipart {client, file, …licence form}   admins, switch "audio", ledger music.import
 *   POST /library/drive    {client, file: link or id, …licence form}  admins, switch "audio", ledger music.import
 *   PATCH /library/:id     {…licence form}       admins: the licence fields corrected (all required again)
 *   DELETE /library/:id                          admins: archived (kept for the videos that used it)
 */
import { Hono } from "hono";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { serveObject } from "./range";
import { readMp4 } from "./mp4";
import { driveAudioFile } from "./drive";
import { audioFormat, wavDurationMs } from "./video-audio";
import { assertIntegrationEnabled, integrationAccess, recordIntegrationOp, requireIntegrationAdmin } from "./integrations";
import { AUDIO_MAX_BYTES } from "@shared/video-audio";
import { CATALOG, catalogEntry, type CatalogEntry } from "@shared/music-catalog";
import { synthTestWav, readWav } from "@shared/music-test-audio";
import {
  LICENCES,
  MUSIC_MOODS,
  driveFileId,
  filterFromQuery,
  filterTracks,
  genresOf,
  isMood,
  peaksFrom,
  validPeaks,
  validateLicenceForm,
  type LicenceForm,
  type MusicMood,
  type MusicTrack,
} from "@shared/music";
import type { User } from "@shared/types";

type Variables = { user: User };
export const musicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PROVIDER = "audio" as const;
const BASE = "/api/studio/music";
/** Wikimedia asks automated clients to name themselves (https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy). */
export const COPY_USER_AGENT = "LevelSocialMediaStudio/1.0 (music library; contact: noreply@anthropic.com)";
/** WAVs up to this size get their waveform drawn here; larger files are drawn by the browser. */
const SERVER_PEAKS_MAX = 8 * 1024 * 1024;

export interface MusicTrackRow {
  id: string;
  client: string;
  title: string;
  artist: string;
  moods: string;
  genre: string;
  bpm: number | null;
  bpm_source: string | null;
  duration_ms: number | null;
  key: string;
  mime: string;
  size: number;
  sha1: string | null;
  origin: "upload" | "drive";
  file_name: string | null;
  drive_id: string | null;
  drive_version: string | null;
  drive_md5: string | null;
  source: string;
  source_url: string;
  author: string;
  licence: string;
  licence_name: string;
  licence_version: string;
  licence_url: string;
  attribution: string;
  content_id: string;
  content_id_note: string;
  confirmed_by: string;
  confirmed: number;
  created: number;
  created_by: string;
  updated: number;
  updated_by: string;
  archived: number | null;
}

interface CopyRow {
  track: string;
  key: string;
  source_url: string;
  licence: string;
  bytes: number;
  sha1: string | null;
  copied: number;
  copied_by: string;
}

/* ───────────── Tracks as the panel sees them ───────────── */

const fileUrl = (id: string) => `${BASE}/file?id=${encodeURIComponent(id)}`;
const peaksUrl = (id: string) => `${BASE}/peaks?id=${encodeURIComponent(id)}`;

export function catalogTrack(e: CatalogEntry, stored = false): MusicTrack {
  const id = `cat:${e.slug}`;
  return {
    id,
    kind: "catalog",
    title: e.title,
    artist: e.artist,
    moods: e.moods,
    genre: e.genre,
    duration: e.duration,
    bpm: e.bpm,
    bpmSource: e.bpmSource,
    test: e.test,
    source: { name: e.source.name, page: e.source.page, author: e.source.author },
    licence: e.licence,
    contentId: e.contentId,
    url: fileUrl(id),
    peaksUrl: peaksUrl(id),
    stored,
  };
}

function parseMoods(s: string): MusicMood[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter(isMood) : [];
  } catch {
    return [];
  }
}

export function libraryTrack(r: MusicTrackRow): MusicTrack {
  const id = `lib:${r.id}`;
  const kind = LICENCES[r.licence as keyof typeof LICENCES];
  return {
    id,
    kind: "library",
    title: r.title,
    artist: r.artist,
    moods: parseMoods(r.moods),
    genre: r.genre,
    duration: (r.duration_ms ?? 0) / 1000,
    bpm: r.bpm,
    bpmSource: r.bpm_source === "source" || r.bpm_source === "measured" ? r.bpm_source : null,
    test: false,
    source: { name: r.source, page: r.source_url, author: r.author },
    licence: { id: kind ? kind.id : "other", name: r.licence_name, version: r.licence_version, url: r.licence_url, attribution: r.attribution, attributionRequired: kind?.attribution ?? false },
    contentId: { status: r.content_id === "registered" || r.content_id === "not_registered" ? r.content_id : "unknown", note: r.content_id_note },
    url: fileUrl(id),
    peaksUrl: peaksUrl(id),
    client: r.client,
    importedBy: r.created_by,
    imported: r.created,
    origin: r.origin,
  };
}

type Resolved = { kind: "catalog"; id: string; entry: CatalogEntry } | { kind: "library"; id: string; row: MusicTrackRow };

async function resolveTrack(env: Env, id: string | undefined): Promise<Resolved> {
  const s = id ?? "";
  if (s.startsWith("cat:")) {
    const entry = catalogEntry(s.slice(4));
    if (entry) return { kind: "catalog", id: s, entry };
  } else if (s.startsWith("lib:")) {
    const row = await first<MusicTrackRow>(env.DB, "SELECT * FROM music_tracks WHERE id = ?", s.slice(4));
    if (row) return { kind: "library", id: s, row };
  }
  throw new StudioError("Track not found.", 404);
}

async function requireClient(env: Env, client: string | undefined): Promise<string> {
  if (!client) throw new StudioError("Pick a client first.");
  const row = await first<{ id: string }>(env.DB, "SELECT id FROM clients WHERE id = ?", client);
  if (!row) throw new StudioError("This client is missing. Pick another client.", 404);
  return row.id;
}

/* ───────────── The catalog's copies ───────────── */

const catalogKey = (e: CatalogEntry) => `music/catalog/${e.slug}.${e.file?.mime === "audio/wav" || !e.file ? "wav" : "mp3"}`;
const catalogMime = (e: CatalogEntry) => (e.file ? e.file.mime : "audio/wav");

export async function sha1Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const copying = new Map<string, Promise<string>>(); // per isolate: one copy at a time per track

/**
 * The catalog track in our storage, copied on first use: from its canonical file (size and SHA-1
 * checked where the catalog pins them) or synthesised (test audio). The copy is recorded (who,
 * when, from where, under which licence) in music_copies and the ledger. A track whose licence
 * does not allow keeping a copy is never stored.
 */
export async function ensureCatalogCopy(env: Env, e: CatalogEntry, user: User): Promise<string> {
  const key = catalogKey(e);
  if (await env.BUCKET.head(key)) return key;
  const pending = copying.get(key);
  if (pending) return pending;
  const p = (async () => {
    if (!e.redistribution) throw new StudioError(`"${e.title}" may not be kept in the studio under its licence, so it cannot be played from here.`, 403);
    let bytes: ArrayBuffer;
    let from: string;
    if (e.synth) {
      bytes = synthTestWav(e.synth);
      from = "generated in the studio (shared/music-test-audio.ts)";
    } else if (e.file) {
      from = e.file.url;
      const r = await fetch(e.file.url, { headers: { "User-Agent": COPY_USER_AGENT }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
      if (!r) throw new StudioError(`${e.source.name} did not answer. Nothing was stored; try again in a minute.`, 503);
      if (r.status === 429 || r.status >= 500) throw new StudioError(`${e.source.name} is busy (answered ${r.status}). Nothing was stored; try again in a minute.`, 503);
      if (!r.ok) throw new StudioError(`${e.source.name} answered ${r.status} for "${e.title}". Nothing was stored.`, 502);
      const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
      if (type && !type.startsWith("audio/") && type !== "application/octet-stream" && type !== "application/ogg")
        throw new StudioError(`${e.source.name} sent ${type}, not audio, for "${e.title}". Nothing was stored.`, 502);
      bytes = await r.arrayBuffer();
      if (bytes.byteLength > AUDIO_MAX_BYTES || bytes.byteLength === 0) throw new StudioError(`The file for "${e.title}" is ${bytes.byteLength ? "too large" : "empty"}. Nothing was stored.`, 502);
    } else throw new StudioError("This catalog entry has no file.", 500);
    const sha1 = await sha1Hex(bytes);
    if (e.file?.bytes !== undefined && e.file.bytes !== bytes.byteLength) throw new StudioError(`The file for "${e.title}" changed at ${e.source.name} (size ${bytes.byteLength}, expected ${e.file.bytes}). Nothing was stored; the catalog needs checking.`, 502);
    if (e.file?.sha1 && e.file.sha1 !== sha1) throw new StudioError(`The file for "${e.title}" changed at ${e.source.name} (checksum differs). Nothing was stored; the catalog needs checking.`, 502);
    const licence = `${e.licence.name} ${e.licence.url}`.trim();
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: catalogMime(e) },
      customMetadata: { track: e.slug, source: from.slice(0, 500), page: e.source.page.slice(0, 500), licence: licence.slice(0, 300), sha1 },
    });
    await run(env.DB, "INSERT OR IGNORE INTO music_copies (track, key, source_url, licence, bytes, sha1, copied, copied_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", e.slug, key, from, licence, bytes.byteLength, sha1, now(), user.id);
    await recordIntegrationOp(env, { provider: PROVIDER, kind: "music.copy", user: user.id, estimate: 0, status: "done", note: `Catalog track "${e.title}" copied into the studio on first use · ${Math.round(bytes.byteLength / 1024)} KB · ${e.licence.name} · from ${from}`.slice(0, 500) });
    return key;
  })();
  copying.set(key, p);
  try {
    return await p;
  } finally {
    copying.delete(key);
  }
}

/* ───────────── Listing ───────────── */

musicRoutes.get("/catalog", async (c) => {
  const user = c.get("user");
  const copies = new Set((await all<CopyRow>(c.env.DB, "SELECT track FROM music_copies")).map((r) => r.track));
  const tracks = CATALOG.map((e) => catalogTrack(e, copies.has(e.slug)));
  const filter = filterFromQuery(c.req.query());
  const access = await integrationAccess(c.env, user, PROVIDER);
  return c.json({ ok: true, tracks: filterTracks(tracks, filter), total: tracks.length, moods: MUSIC_MOODS, genres: genresOf(tracks), access });
});

musicRoutes.get("/library", async (c) => {
  const user = c.get("user");
  const client = await requireClient(c.env, c.req.query("client"));
  const rows = await all<MusicTrackRow>(c.env.DB, "SELECT * FROM music_tracks WHERE client = ? AND archived IS NULL ORDER BY created DESC LIMIT 500", client);
  const tracks = rows.map(libraryTrack);
  const access = await integrationAccess(c.env, user, PROVIDER);
  return c.json({ ok: true, tracks: filterTracks(tracks, filterFromQuery(c.req.query())), total: tracks.length, moods: MUSIC_MOODS, genres: genresOf(tracks), access });
});

/* ───────────── The audio ───────────── */

musicRoutes.on(["GET", "HEAD"], "/file", async (c) => {
  const user = c.get("user");
  const t = await resolveTrack(c.env, c.req.query("id"));
  if (t.kind === "catalog") {
    const key = await ensureCatalogCopy(c.env, t.entry, user);
    return serveObject(c.env.BUCKET, key, c.req.raw, { contentType: catalogMime(t.entry), cacheControl: "private, max-age=86400", filename: key.split("/").pop() });
  }
  if (t.row.archived) throw new StudioError("This track was removed from the client's library.", 410);
  const ext = t.row.key.split(".").pop() ?? "mp3";
  return serveObject(c.env.BUCKET, t.row.key, c.req.raw, { contentType: t.row.mime, cacheControl: "private, max-age=86400", filename: `track-${t.row.id.slice(0, 8)}.${ext}` });
});

/* ───────────── The waveform ───────────── */

const peaksKey = (id: string) => `music/peaks/${id.replace(/[^\w:-]/g, "_")}.json`;

interface StoredPeaks {
  peaks: number[];
  at: number;
  by: string;
  computed: "server" | "browser";
}

async function readPeaks(env: Env, id: string): Promise<StoredPeaks | null> {
  const obj = await env.BUCKET.get(peaksKey(id));
  if (!obj) return null;
  try {
    const v = JSON.parse(await obj.text()) as StoredPeaks;
    return validPeaks(v.peaks) ? v : null;
  } catch {
    return null;
  }
}

async function writePeaks(env: Env, id: string, v: StoredPeaks): Promise<void> {
  await env.BUCKET.put(peaksKey(id), JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });
}

/** The file's key and MIME type, the catalog copy made first when needed. */
async function trackFile(env: Env, t: Resolved, user: User): Promise<{ key: string; mime: string }> {
  if (t.kind === "catalog") return { key: await ensureCatalogCopy(env, t.entry, user), mime: catalogMime(t.entry) };
  return { key: t.row.key, mime: t.row.mime };
}

/**
 * The waveform, cached once per track. WAV files (test audio, small uploads) are drawn here the
 * first time; any other format is drawn by the first browser that decodes it (PUT below), because
 * a Worker cannot decode mp3 or AAC.
 */
musicRoutes.get("/peaks", async (c) => {
  const user = c.get("user");
  const t = await resolveTrack(c.env, c.req.query("id"));
  const cached = await readPeaks(c.env, t.id);
  if (cached) return c.json({ ok: true, id: t.id, peaks: cached.peaks, cached: true, computed: cached.computed });
  const isWav = t.kind === "catalog" ? catalogMime(t.entry) === "audio/wav" : t.row.mime === "audio/wav";
  const small = t.kind === "catalog" ? true : t.row.size <= SERVER_PEAKS_MAX;
  if (isWav && small) {
    const f = await trackFile(c.env, t, user);
    const obj = await c.env.BUCKET.get(f.key);
    const wav = obj ? readWav(await obj.arrayBuffer()) : null;
    if (wav) {
      const peaks = peaksFrom(wav.channels);
      await writePeaks(c.env, t.id, { peaks, at: now(), by: user.id, computed: "server" });
      return c.json({ ok: true, id: t.id, peaks, cached: false, computed: "server" });
    }
  }
  return c.json({ ok: true, id: t.id, peaks: null, cached: false, computed: null });
});

/** The waveform (and, for a client's track with no tempo yet, the measured BPM) a browser computed: kept once. */
musicRoutes.put("/peaks", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; peaks?: unknown; bpm?: unknown };
  const t = await resolveTrack(c.env, body.id);
  const peaks = validPeaks(body.peaks);
  if (!peaks) throw new StudioError("The waveform must be 16 to 2000 numbers between 0 and 1.");
  const cached = await readPeaks(c.env, t.id);
  if (!cached) await writePeaks(c.env, t.id, { peaks, at: now(), by: user.id, computed: "browser" });
  const bpm = Number(body.bpm);
  if (t.kind === "library" && t.row.bpm === null && Number.isFinite(bpm) && bpm >= 30 && bpm <= 300)
    await run(c.env.DB, "UPDATE music_tracks SET bpm = ?, bpm_source = 'measured' WHERE id = ? AND bpm IS NULL", Math.round(bpm), t.row.id);
  return c.json({ ok: true, id: t.id, peaks: cached?.peaks ?? peaks, cached: !!cached });
});

/* ───────────── Imports (admins) ───────────── */

function formFrom(entries: Record<string, unknown>): LicenceForm {
  const v = validateLicenceForm(entries);
  if (!v.ok) throw new StudioError(v.reason);
  return v.form;
}

async function storeLibraryTrack(
  env: Env,
  user: User,
  client: string,
  form: LicenceForm,
  file: { bytes: ArrayBuffer; name: string; type: string; durationSec?: number; origin: "upload" | "drive"; drive?: { id: string; version: string; md5: string | null } },
): Promise<MusicTrack> {
  const fmt = audioFormat(file.name, file.type);
  if (!fmt) throw new StudioError("The track must be an mp3, m4a, aac or wav file.", 415);
  if (file.bytes.byteLength > AUDIO_MAX_BYTES) throw new StudioError("The track is too large (25 MB at most).", 413);
  if (file.bytes.byteLength === 0) throw new StudioError("The track is empty.");
  let durationMs: number | null = file.durationSec && Number.isFinite(file.durationSec) && file.durationSec > 0 && file.durationSec < 3600 ? Math.round(file.durationSec * 1000) : null;
  if (fmt.ext === "wav") durationMs = wavDurationMs(file.bytes) ?? durationMs;
  if (fmt.ext === "m4a") {
    const info = readMp4(file.bytes);
    if (!info.isMp4) throw new StudioError("The m4a file is not an MPEG-4 container.", 415);
    if (info.duration) durationMs = Math.round(info.duration * 1000);
  }
  const id = uuid();
  const key = `music/library/${client}/${id}.${fmt.ext}`;
  const sha1 = await sha1Hex(file.bytes);
  await env.BUCKET.put(key, file.bytes, { httpMetadata: { contentType: fmt.mime }, customMetadata: { client, licence: `${form.licenceName} ${form.licenceVersion}`.trim().slice(0, 200), source: form.source.slice(0, 300), sha1 } });
  const t = now();
  await run(
    env.DB,
    `INSERT INTO music_tracks (id, client, title, artist, moods, genre, bpm, bpm_source, duration_ms, key, mime, size, sha1, origin, file_name, drive_id, drive_version, drive_md5,
       source, source_url, author, licence, licence_name, licence_version, licence_url, attribution, content_id, content_id_note, confirmed_by, confirmed, created, created_by, updated, updated_by, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    client,
    form.title,
    form.artist,
    JSON.stringify(form.moods),
    form.genre,
    form.bpm,
    form.bpm === null ? null : "source",
    durationMs,
    key,
    fmt.mime,
    file.bytes.byteLength,
    sha1,
    file.origin,
    file.name.slice(0, 200),
    file.drive?.id ?? null,
    file.drive?.version ?? null,
    file.drive?.md5 ?? null,
    form.source,
    form.sourceUrl,
    form.author,
    form.licence,
    form.licenceName,
    form.licenceVersion,
    form.licenceUrl,
    form.attribution,
    form.contentId,
    form.contentIdNote,
    user.id,
    t,
    t,
    user.id,
    t,
    user.id,
  );
  await recordIntegrationOp(env, {
    provider: PROVIDER,
    kind: "music.import",
    user: user.id,
    estimate: 0,
    status: "done",
    note: `"${form.title}" imported for client ${client} from ${file.origin === "drive" ? "Drive" : "an upload"} · ${form.licenceName}${form.licenceVersion ? ` ${form.licenceVersion}` : ""} · source: ${form.source} · Content ID: ${form.contentId}`.slice(0, 500),
  });
  const row = (await first<MusicTrackRow>(env.DB, "SELECT * FROM music_tracks WHERE id = ?", id))!;
  return libraryTrack(row);
}

/** A track uploaded from the computer, with its licence (admins). */
musicRoutes.post("/library/upload", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new StudioError("Send the track as a form upload.");
  const fields: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = k === "moods" ? form.getAll("moods").map(String).join(",") : v;
  const licence = formFrom(fields);
  const client = await requireClient(c.env, String(fields.client ?? ""));
  const file = form.get("file");
  if (!(file instanceof File)) throw new StudioError("Attach the track as 'file'.");
  if (file.size > AUDIO_MAX_BYTES) throw new StudioError("The track is too large (25 MB at most).", 413);
  const track = await storeLibraryTrack(c.env, user, client, licence, { bytes: await file.arrayBuffer(), name: file.name, type: file.type, durationSec: Number(fields.duration), origin: "upload" });
  return c.json({ ok: true, track });
});

/** A track read from the client's Drive (shared with the service account), with its licence (admins). */
musicRoutes.post("/library/drive", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const licence = formFrom(body);
  const client = await requireClient(c.env, String(body.client ?? ""));
  const fileId = driveFileId(String(body.file ?? ""));
  if (!fileId) throw new StudioError("Paste the Drive link of the audio file (or its id).");
  const f = await driveAudioFile(c.env, fileId, AUDIO_MAX_BYTES);
  const track = await storeLibraryTrack(c.env, user, client, licence, { bytes: f.bytes, name: f.name, type: f.mime, durationSec: Number(body.duration), origin: "drive", drive: { id: fileId, version: f.version, md5: f.md5 } });
  return c.json({ ok: true, track });
});

/** The licence fields corrected (admins): the whole form is checked again and confirmed again. */
musicRoutes.patch("/library/:id", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const row = await first<MusicTrackRow>(c.env.DB, "SELECT * FROM music_tracks WHERE id = ? AND archived IS NULL", c.req.param("id"));
  if (!row) throw new StudioError("Track not found.", 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const current: Record<string, unknown> = {
    title: row.title,
    artist: row.artist,
    moods: parseMoods(row.moods),
    genre: row.genre,
    bpm: row.bpm,
    source: row.source,
    sourceUrl: row.source_url,
    author: row.author,
    licence: row.licence,
    licenceName: row.licence_name,
    licenceVersion: row.licence_version,
    licenceUrl: row.licence_url,
    attribution: row.attribution,
    contentId: row.content_id,
    contentIdNote: row.content_id_note,
  };
  const merged = { ...current, ...body };
  const form = formFrom(merged);
  const changed = Object.keys(current).filter((k) => JSON.stringify(current[k]) !== JSON.stringify((form as unknown as Record<string, unknown>)[k]));
  await run(
    c.env.DB,
    "UPDATE music_tracks SET title = ?, artist = ?, moods = ?, genre = ?, bpm = ?, bpm_source = ?, source = ?, source_url = ?, author = ?, licence = ?, licence_name = ?, licence_version = ?, licence_url = ?, attribution = ?, content_id = ?, content_id_note = ?, confirmed_by = ?, confirmed = ?, updated = ?, updated_by = ? WHERE id = ?",
    form.title,
    form.artist,
    JSON.stringify(form.moods),
    form.genre,
    form.bpm,
    form.bpm === null ? null : form.bpm === row.bpm ? row.bpm_source : "source",
    form.source,
    form.sourceUrl,
    form.author,
    form.licence,
    form.licenceName,
    form.licenceVersion,
    form.licenceUrl,
    form.attribution,
    form.contentId,
    form.contentIdNote,
    user.id,
    now(),
    now(),
    user.id,
    row.id,
  );
  await recordIntegrationOp(c.env, { provider: PROVIDER, kind: "music.edit", user: user.id, estimate: 0, status: "done", note: `"${form.title}" (client ${row.client}): ${changed.length ? `changed ${changed.join(", ")}` : "confirmed again, nothing changed"}`.slice(0, 500) });
  const after = (await first<MusicTrackRow>(c.env.DB, "SELECT * FROM music_tracks WHERE id = ?", row.id))!;
  return c.json({ ok: true, track: libraryTrack(after) });
});

/** Archived, not deleted (admins): a video that used the track keeps its licence record. */
musicRoutes.delete("/library/:id", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const row = await first<MusicTrackRow>(c.env.DB, "SELECT * FROM music_tracks WHERE id = ? AND archived IS NULL", c.req.param("id"));
  if (!row) throw new StudioError("Track not found.", 404);
  await run(c.env.DB, "UPDATE music_tracks SET archived = ?, updated = ?, updated_by = ? WHERE id = ?", now(), now(), user.id, row.id);
  await recordIntegrationOp(c.env, { provider: PROVIDER, kind: "music.archive", user: user.id, estimate: 0, status: "done", note: `"${row.title}" removed from client ${row.client}'s library (file and licence record kept)` });
  return c.json({ ok: true });
});
