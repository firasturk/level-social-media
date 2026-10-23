/**
 * The music library (docs/music-library.md): the shape of a track as the routes (server/music.ts)
 * and the panel (src/video-editor/ui/MusicLibrary.tsx) share it, the licences a track may carry,
 * the catalog filters, the BPM estimate from detected beats, the waveform peaks, and the licence
 * form an admin fills in when importing a track. Plain TypeScript: no browser, no Worker APIs.
 *
 * What a licence does and does not promise is written in docs/music-library.md: a licence lets us
 * use the recording; it does not stop a platform's automated matcher (YouTube Content ID, Meta
 * Rights Manager) from flagging a video. The panel never says a track "cannot be claimed".
 */

/* ───────────── Moods, genres ───────────── */

export type MusicMood = "upbeat" | "calm" | "cinematic" | "corporate" | "energy" | "arabic" | "playful";

export const MUSIC_MOODS: readonly { id: MusicMood; label: string }[] = [
  { id: "upbeat", label: "Upbeat" },
  { id: "calm", label: "Calm" },
  { id: "cinematic", label: "Cinematic" },
  { id: "corporate", label: "Corporate" },
  { id: "energy", label: "Sport / energy" },
  { id: "arabic", label: "Arabic-flavoured" },
  { id: "playful", label: "Playful" },
] as const;

export const isMood = (x: unknown): x is MusicMood => typeof x === "string" && MUSIC_MOODS.some((m) => m.id === x);

/** Duration bands the panel offers (seconds; `max` exclusive). */
export const DURATION_BANDS: readonly { id: string; label: string; min?: number; max?: number }[] = [
  { id: "short", label: "Under 30 s", max: 30 },
  { id: "clip", label: "30 s – 1 min", min: 30, max: 60 },
  { id: "mid", label: "1 – 3 min", min: 60, max: 180 },
  { id: "long", label: "Over 3 min", min: 180 },
] as const;

/** Tempo bands the panel offers (BPM; `max` exclusive). */
export const BPM_BANDS: readonly { id: string; label: string; min?: number; max?: number }[] = [
  { id: "slow", label: "Slow (under 90)", max: 90 },
  { id: "medium", label: "Medium (90–120)", min: 90, max: 120 },
  { id: "fast", label: "Fast (120 and up)", min: 120 },
] as const;

/* ───────────── Licences ───────────── */

/**
 * The licences a track in the library may carry. Every one allows commercial use in a client's
 * video and offering the file to the team inside the studio. NonCommercial (NC), NoDerivatives
 * (ND) and ShareAlike (SA) are refused: NC forbids client work, ND forbids cutting the track to a
 * video, SA would put the client's video itself under a free licence.
 */
export type LicenceId = "cc0-1.0" | "pdm-1.0" | "cc-by-4.0" | "cc-by-3.0" | "paid" | "own" | "other";

export interface LicenceKind {
  id: LicenceId;
  name: string;
  version: string;
  url: string;
  /** The licence asks for credit wherever the music is used. */
  attribution: boolean;
  /** One line for the panel. */
  note: string;
}

export const LICENCES: Record<LicenceId, LicenceKind> = {
  "cc0-1.0": { id: "cc0-1.0", name: "CC0 (public domain dedication)", version: "1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: false, note: "No credit required; crediting is still good practice." },
  "pdm-1.0": { id: "pdm-1.0", name: "Public Domain Mark", version: "1.0", url: "https://creativecommons.org/publicdomain/mark/1.0/", attribution: false, note: "Marked as free of known copyright. Check the recording, not only the composition." },
  "cc-by-4.0": { id: "cc-by-4.0", name: "CC BY (Attribution)", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/", attribution: true, note: "Credit the author wherever the video is published." },
  "cc-by-3.0": { id: "cc-by-3.0", name: "CC BY (Attribution)", version: "3.0", url: "https://creativecommons.org/licenses/by/3.0/", attribution: true, note: "Credit the author wherever the video is published." },
  paid: { id: "paid", name: "Paid licence", version: "", url: "", attribution: false, note: "A licence we bought: keep the receipt or licence certificate with the source line." },
  own: { id: "own", name: "Own work or commissioned", version: "", url: "", attribution: false, note: "Made by us or for us under a contract that gives us the rights." },
  other: { id: "other", name: "Other licence (described)", version: "", url: "", attribution: false, note: "Describe the licence and link its text; an admin is responsible for it." },
};

export const isLicenceId = (x: unknown): x is LicenceId => typeof x === "string" && x in LICENCES;

/** Words that mean a licence we refuse (NC, ND, SA, personal use, YouTube-only, no redistribution). */
export const REFUSED_LICENCE =
  /\b(by-nc|by-nd|by-sa|cc[- ]by[- ](nc|nd|sa)|non-?commercial|no-?derivatives?|share-?alike|personal use only|youtube only|not for redistribution)\b/i;

export type ContentIdStatus = "unknown" | "registered" | "not_registered";

export const CONTENT_ID_LABELS: Record<ContentIdStatus, string> = {
  unknown: "Content ID: unknown",
  registered: "Content ID: registered",
  not_registered: "Content ID: not registered",
};

export const isContentId = (x: unknown): x is ContentIdStatus => x === "unknown" || x === "registered" || x === "not_registered";

export interface MusicLicence {
  id: LicenceId;
  /** As the source names it ("CC BY 3.0", "Epidemic Sound Personal plan"). */
  name: string;
  version: string;
  /** The licence text. */
  url: string;
  /** The credit line to publish with the video (empty when none is needed). */
  attribution: string;
  attributionRequired: boolean;
}

export interface MusicContentId {
  status: ContentIdStatus;
  /** What the source says (or what we know), in words. */
  note: string;
  /** Where the source says it. */
  url?: string;
}

/** Where the recording comes from: the page a person can open to check the licence. */
export interface MusicSourceInfo {
  /** "Wikimedia Commons", "Google Drive", "Upload", "Generated in the studio". */
  name: string;
  /** The page that states the licence (Commons file page, Drive link, the seller's page). */
  page: string;
  /** The author or performer as the source credits them. */
  author: string;
}

/* ───────────── Tracks ───────────── */

export interface MusicTrack {
  /** "cat:<slug>" for the studio catalog, "lib:<uuid>" for a client's imported track. */
  id: string;
  kind: "catalog" | "library";
  title: string;
  artist: string;
  moods: MusicMood[];
  genre: string;
  /** Seconds. */
  duration: number;
  bpm: number | null;
  /** "measured": our beat analysis; "source": what the source says; null: not known yet. */
  bpmSource: "measured" | "source" | null;
  /** Generated test audio for development: never for a client's video. */
  test: boolean;
  source: MusicSourceInfo;
  licence: MusicLicence;
  contentId: MusicContentId;
  /** Our route that streams the file with Range (preview and the editor's download). */
  url: string;
  /** Our route that answers the cached waveform peaks. */
  peaksUrl: string;
  /** Catalog only: whether the file is already in our storage (copied on first use). */
  stored?: boolean;
  /** Library only: the client it belongs to, who imported it and when. */
  client?: string;
  importedBy?: string;
  imported?: number;
  origin?: "upload" | "drive";
}

/** The credit line for a track: the attribution text when the licence needs one, otherwise a courtesy line. */
export function creditLine(t: Pick<MusicTrack, "title" | "artist" | "licence">): string {
  if (t.licence.attribution.trim()) return t.licence.attribution.trim();
  return `"${t.title}"${t.artist ? ` by ${t.artist}` : ""}${t.licence.name ? ` (${t.licence.name}${t.licence.version && !t.licence.name.includes(t.licence.version) ? ` ${t.licence.version}` : ""})` : ""}`;
}

/* ───────────── Filters ───────────── */

export interface MusicFilter {
  q?: string;
  mood?: MusicMood | "";
  genre?: string;
  /** Seconds, inclusive. */
  minDuration?: number;
  /** Seconds, exclusive. */
  maxDuration?: number;
  /** Inclusive. A track with no BPM is left out when a BPM bound is set. */
  minBpm?: number;
  /** Exclusive. */
  maxBpm?: number;
  /** Test audio is shown unless false. */
  includeTest?: boolean;
}

/** Folds case, Arabic letter variants and diacritics so "Desert" finds "desert" and "إيقاع" finds "ايقاع". */
export function foldText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ًͯ-ٰٟـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

export function matchesFilter(t: MusicTrack, f: MusicFilter): boolean {
  if (f.includeTest === false && t.test) return false;
  if (f.mood && !t.moods.includes(f.mood)) return false;
  if (f.genre && foldText(t.genre) !== foldText(f.genre)) return false;
  if (f.minDuration !== undefined && t.duration < f.minDuration) return false;
  if (f.maxDuration !== undefined && t.duration >= f.maxDuration) return false;
  if (f.minBpm !== undefined || f.maxBpm !== undefined) {
    if (t.bpm === null) return false;
    if (f.minBpm !== undefined && t.bpm < f.minBpm) return false;
    if (f.maxBpm !== undefined && t.bpm >= f.maxBpm) return false;
  }
  const q = foldText((f.q ?? "").trim());
  if (q) {
    const hay = foldText([t.title, t.artist, t.genre, t.source.author, ...t.moods, ...t.moods.map((m) => MUSIC_MOODS.find((x) => x.id === m)?.label ?? "")].join(" "));
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function filterTracks(tracks: readonly MusicTrack[], f: MusicFilter): MusicTrack[] {
  return tracks.filter((t) => matchesFilter(t, f));
}

/** A filter from query parameters (strings); unknown or malformed values are dropped, not refused. */
export function filterFromQuery(q: Record<string, string | undefined>): MusicFilter {
  const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  return {
    q: (q.q ?? "").slice(0, 100) || undefined,
    mood: isMood(q.mood) ? q.mood : undefined,
    genre: (q.genre ?? "").slice(0, 60) || undefined,
    minDuration: num(q.minDuration),
    maxDuration: num(q.maxDuration),
    minBpm: num(q.minBpm),
    maxBpm: num(q.maxBpm),
    includeTest: q.test === "0" ? false : undefined,
  };
}

/** The distinct genres of a list, sorted, for the genre picker. */
export function genresOf(tracks: readonly MusicTrack[]): string[] {
  return [...new Set(tracks.map((t) => t.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/* ───────────── Tempo ───────────── */

/**
 * A tempo from beat times (seconds), as the editor's detector gives them (detectBeats in
 * shared/video-project.ts): the median spacing, folded into 70–180 BPM so a half- or double-time
 * grid reads as the tempo people count. Null when there are too few beats to say.
 */
export function estimateBpm(beats: readonly number[]): number | null {
  if (beats.length < 8) return null;
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const g = beats[i] - beats[i - 1];
    if (g > 0.15 && g < 3) gaps.push(g);
  }
  if (gaps.length < 6) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  let bpm = 60 / median;
  while (bpm < 70) bpm *= 2;
  while (bpm >= 180) bpm /= 2;
  return Math.round(bpm);
}

/**
 * A tempo from an energy envelope (RMS per `hop` seconds, as the editor's energyEnvelope makes it):
 * the onset strength (how much the log energy rises from one hop to the next) is autocorrelated
 * over the lags of 60–180 BPM, weighted gently towards 120 so a half- or double-time answer loses
 * to the tempo people count. The confidence is how far the best lag stands above the average one;
 * under `minConfidence` the answer is null ("no clear pulse"), which is what rubato classical music
 * and ambient pads should get. A heuristic: it reads produced, rhythmic music well.
 */
export function tempoFromEnvelope(energy: ArrayLike<number>, hop: number, minConfidence = 0.1): { bpm: number | null; confidence: number } {
  const n = energy.length;
  if (n < 200 || hop <= 0) return { bpm: null, confidence: 0 };
  const flux = new Float32Array(n);
  let prev = Math.log(1e-4 + energy[0]);
  for (let i = 1; i < n; i++) {
    const l = Math.log(1e-4 + energy[i]);
    flux[i] = Math.max(0, l - prev);
    prev = l;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n;
  for (let i = 0; i < n; i++) flux[i] -= mean;
  const minLag = Math.max(1, Math.floor(60 / 180 / hop));
  const maxLag = Math.ceil(60 / 60 / hop);
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += flux[i] * flux[i];
  r0 /= n;
  if (r0 <= 0) return { bpm: null, confidence: 0 };
  const scores: { lag: number; score: number; r: number }[] = [];
  for (let lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += flux[i] * flux[i - lag];
    const r = s / (n - lag) / r0;
    const bpm = 60 / (lag * hop);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.2, 2));
    scores.push({ lag, score: r * prior, r });
  }
  if (!scores.length) return { bpm: null, confidence: 0 };
  let best = scores[0];
  for (const s of scores) if (s.score > best.score) best = s;
  // The confidence is the normalised autocorrelation at the chosen lag: near 0 for noise or a
  // held sound, well above for a steady pulse.
  const confidence = best.r;
  // Refine the lag with a parabola through its neighbours.
  const i = scores.indexOf(best);
  let lag = best.lag;
  if (i > 0 && i < scores.length - 1) {
    const a = scores[i - 1].score;
    const b = best.score;
    const c = scores[i + 1].score;
    const d = a - 2 * b + c;
    if (d < 0) lag += (0.5 * (a - c)) / d;
  }
  const bpm = Math.round(60 / (lag * hop));
  return { bpm: confidence >= minConfidence ? bpm : null, confidence: Math.round(confidence * 1000) / 1000 };
}

/* ───────────── Waveform peaks ───────────── */

export const PEAK_COUNT = 400;

/**
 * The waveform: `count` buckets over the track, each the loudest absolute sample of the mono
 * mixdown in it, scaled so the loudest bucket is 1, to 3 decimals. Computed once per track and
 * cached by the server (GET/PUT /api/studio/music/peaks).
 */
export function peaksFrom(channels: readonly ArrayLike<number>[], count = PEAK_COUNT): number[] {
  const n = channels[0]?.length ?? 0;
  if (!n || count < 1) return [];
  const out = new Array<number>(count).fill(0);
  const per = n / count;
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.min(n, Math.floor((b + 1) * per)));
    // Long buckets are sampled: 2000 reads per bucket are plenty for a picture.
    const step = Math.max(1, Math.floor((to - from) / 2000));
    let peak = 0;
    for (let i = from; i < to; i += step) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v = Math.abs(v / channels.length);
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  const max = Math.max(...out);
  return out.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
}

/** A peaks list as a client sent it: 16–2000 numbers in 0…1, or null. */
export function validPeaks(x: unknown): number[] | null {
  if (!Array.isArray(x) || x.length < 16 || x.length > 2000) return null;
  if (!x.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  return x.map((v: number) => Math.round(v * 1000) / 1000);
}

/* ───────────── Drive links ───────────── */

/** A Drive file's id from the links people paste (…/file/d/<id>/view, ?id=<id>) or the bare id. */
export function driveFileId(link: string): string | null {
  const s = link.trim();
  const m = s.match(/\/file\/d\/([\w-]{10,})/) ?? s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : null;
}

/* ───────────── The licence form ───────────── */

/** What an admin fills in (or confirms) when importing a track. */
export interface LicenceForm {
  title: string;
  artist: string;
  moods: MusicMood[];
  genre: string;
  bpm: number | null;
  /** Where the recording comes from, in words ("Bought on Artlist, order 1234", "Client's Drive"). */
  source: string;
  /** The page that states the licence, when there is one. */
  sourceUrl: string;
  author: string;
  licence: LicenceId;
  /** As the source names it; defaults to the licence kind's name. */
  licenceName: string;
  licenceVersion: string;
  licenceUrl: string;
  attribution: string;
  contentId: ContentIdStatus;
  contentIdNote: string;
  /** The admin confirms the rights: "We may use this track in client videos and keep it in the studio." */
  confirmed: boolean;
}

export const LICENCE_CONFIRMATION = "I confirm we may use this track in client videos and keep it in the studio for the team, under the licence described here.";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

/**
 * The licence form checked: what is missing or refused is said in plain words, one reason at a
 * time. Required: title, source, author, licence (with its URL for CC licences and "other"),
 * attribution text when the licence asks for credit, a Content ID status, and the confirmation.
 */
export function validateLicenceForm(x: unknown): { ok: true; form: LicenceForm } | { ok: false; reason: string } {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const title = text(o.title, 120);
  if (!title) return { ok: false, reason: "Give the track a name." };
  const source = text(o.source, 300);
  if (!source) return { ok: false, reason: "Say where the track comes from (source)." };
  const author = text(o.author, 200);
  if (!author) return { ok: false, reason: "Name the author or performer." };
  if (!isLicenceId(o.licence)) return { ok: false, reason: "Pick the track's licence." };
  const kind = LICENCES[o.licence];
  const licenceName = text(o.licenceName, 120) || kind.name;
  const licenceVersion = text(o.licenceVersion, 20) || kind.version;
  const licenceUrl = text(o.licenceUrl, 500) || kind.url;
  const sourceUrl = text(o.sourceUrl, 500);
  if (sourceUrl && !isUrl(sourceUrl)) return { ok: false, reason: "The source link must start with http:// or https://." };
  if (licenceUrl && !isUrl(licenceUrl)) return { ok: false, reason: "The licence link must start with http:// or https://." };
  if (o.licence === "other" && (!text(o.licenceName, 120) || !licenceUrl)) return { ok: false, reason: "For another licence, name it and link its text." };
  if (REFUSED_LICENCE.test(`${licenceName} ${licenceUrl} ${source}`))
    return { ok: false, reason: "This licence cannot be used: NonCommercial, NoDerivatives, ShareAlike, personal-use or no-redistribution terms do not allow client videos kept in the studio." };
  const attribution = text(o.attribution, 600);
  if (kind.attribution && !attribution) return { ok: false, reason: `${kind.name} ${kind.version} needs credit: write the attribution text to publish with the video.` };
  if (!isContentId(o.contentId)) return { ok: false, reason: "Say whether the track is registered with Content ID (unknown is an answer)." };
  if (o.confirmed !== true && o.confirmed !== "true" && o.confirmed !== "1" && o.confirmed !== "on") return { ok: false, reason: "Confirm the rights before importing the track." };
  const moods = (Array.isArray(o.moods) ? o.moods : typeof o.moods === "string" ? o.moods.split(",") : []).map((m) => String(m).trim()).filter(isMood);
  const bpmRaw = Number(o.bpm);
  const bpm = o.bpm !== undefined && o.bpm !== null && o.bpm !== "" && Number.isFinite(bpmRaw) && bpmRaw >= 30 && bpmRaw <= 300 ? Math.round(bpmRaw) : null;
  return {
    ok: true,
    form: {
      title,
      artist: text(o.artist, 120) || author,
      moods: [...new Set(moods)],
      genre: text(o.genre, 60),
      bpm,
      source,
      sourceUrl,
      author,
      licence: o.licence,
      licenceName,
      licenceVersion,
      licenceUrl,
      attribution,
      contentId: o.contentId,
      contentIdNote: text(o.contentIdNote, 500),
      confirmed: true,
    },
  };
}
