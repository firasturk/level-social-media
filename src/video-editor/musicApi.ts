/** The music library's routes (/api/studio/music, server/music.ts) as the panel calls them. */
import { ApiError, del, get, postForm, post, put } from "@/api";
import type { LicenceForm, MusicFilter, MusicMood, MusicTrack } from "@shared/music";

export interface MusicAccess {
  admin: boolean;
  enabled: boolean;
  /** Empty when the viewer may import; otherwise why not, in plain words. */
  reason: string;
}

export interface MusicList {
  tracks: MusicTrack[];
  total: number;
  moods: { id: MusicMood; label: string }[];
  genres: string[];
  access: MusicAccess;
}

const BASE = "/api/studio/music";

function query(f: MusicFilter, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (f.q) p.set("q", f.q);
  if (f.mood) p.set("mood", f.mood);
  if (f.genre) p.set("genre", f.genre);
  if (f.minDuration !== undefined) p.set("minDuration", String(f.minDuration));
  if (f.maxDuration !== undefined) p.set("maxDuration", String(f.maxDuration));
  if (f.minBpm !== undefined) p.set("minBpm", String(f.minBpm));
  if (f.maxBpm !== undefined) p.set("maxBpm", String(f.maxBpm));
  if (f.includeTest === false) p.set("test", "0");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The network layer, replaceable (tests pass their own). */
export interface MusicApi {
  catalog(f: MusicFilter): Promise<MusicList>;
  library(client: string, f: MusicFilter): Promise<MusicList>;
  peaks(track: MusicTrack): Promise<{ peaks: number[] | null }>;
  savePeaks(track: MusicTrack, peaks: number[], bpm: number | null): Promise<{ peaks: number[] }>;
  /** The track's bytes (Range-capable route; the whole file here). */
  file(track: MusicTrack, signal?: AbortSignal): Promise<ArrayBuffer>;
  importUpload(client: string, form: LicenceForm, file: File, durationSec: number | null): Promise<{ track: MusicTrack }>;
  importDrive(client: string, form: LicenceForm, link: string): Promise<{ track: MusicTrack }>;
  edit(id: string, form: LicenceForm): Promise<{ track: MusicTrack }>;
  archive(id: string): Promise<{ ok: true }>;
}

export const musicApi: MusicApi = {
  catalog: (f) => get(`${BASE}/catalog${query(f)}`),
  library: (client, f) => get(`${BASE}/library${query(f, { client })}`),
  peaks: (t) => get(t.peaksUrl),
  savePeaks: (t, peaks, bpm) => put(`${BASE}/peaks`, { id: t.id, peaks, bpm }),
  file: async (t, signal) => {
    const r = await fetch(t.url, { credentials: "same-origin", signal });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error || `The track could not be read (${r.status}).`, r.status, data as Record<string, unknown>);
    }
    return r.arrayBuffer();
  },
  importUpload: (client, form, file, durationSec) => {
    const fd = new FormData();
    fd.set("client", client);
    for (const [k, v] of Object.entries(form)) fd.set(k, Array.isArray(v) ? v.join(",") : v === null ? "" : String(v));
    if (durationSec) fd.set("duration", String(durationSec));
    fd.set("file", file);
    return postForm(`${BASE}/library/upload`, fd);
  },
  importDrive: (client, form, link) => post(`${BASE}/library/drive`, { ...form, client, file: link }),
  edit: async (id, form) => {
    const r = await fetch(`${BASE}/library/${encodeURIComponent(id.replace(/^lib:/, ""))}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const data = (await r.json().catch(() => ({}))) as { error?: string; track: MusicTrack };
    if (!r.ok) throw new ApiError(data.error || `Request failed (${r.status})`, r.status, data as unknown as Record<string, unknown>);
    return data;
  },
  archive: (id) => del(`${BASE}/library/${encodeURIComponent(id.replace(/^lib:/, ""))}`),
};
