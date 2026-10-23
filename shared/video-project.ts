/**
 * The video editor's project document and the arithmetic on it: clips on a timeline (trims, order,
 * speed, transitions), colour, a music track, the output. Plain TypeScript, no zod, no browser:
 * the server validates a saved project with `validateProject`, the editor and the tests use the
 * timeline, beat-snapping and auto-edit functions below. Everything here is deterministic.
 *
 * Seconds everywhere. A clip's `in`/`out` are source times; its length on the timeline is
 * (out - in) / speed. Clips sit one after another in `clips` order; a crossfade overlaps the
 * previous clip's tail by `transitionDuration`; a dip to black or white does not overlap: the
 * picture goes to the colour and back over `transitionDuration`, centred on the cut. A gap (a
 * clip whose source is `{ kind: "gap" }`) is an empty stretch: the background, no sound.
 *
 * Version 2 (phase 2) added per-clip sound (volume, mute), lock and "has speech", clip framing
 * keyframes, dips, gaps, the music's place on the timeline (start, end) and its ducking, and
 * voice-over clips. A version 1 document is read as version 2 by `validateProject` (migrated, see
 * `migrateV1`), so drafts saved before keep opening and sound the same.
 */

import { checkOverlays, DEFAULT_FRAMING, normaliseFraming, type Framing, type Overlay } from "./video-compose";
import { checkKeyframes, CLIP_PROPS, CLIP_RANGE, splitKeyframes, valueAt, type Keyframes } from "./video-keyframes";
import { checkMatch, type ColourMatch } from "./colour-match";
import { MAX_STORED_LUT_SIZE, storedLutChars } from "./cube-lut";
import { checkReference, type ReferenceAnalysis } from "./reference-check";
import { creditLine, isContentId, isLicenceId, tempoFromEnvelope, type ContentIdStatus, type LicenceId, type MusicTrack } from "./music";

/**
 * 3 (phase 3): colour presets with an intensity (`lookAmount`, a clip's own `look`), vibrance,
 * whites and blacks, skin protection, a clip's colour `match`, the LUT's table kept with the draft
 * (`lut.data`), the library's music sources (`catalog`, `library`) with their licence, and the
 * template a cut was started from. Older documents are read and migrated by `validateProject`:
 * 1 → 2 (`migrateV1`, phase 2's sound and timeline), then 2 → 3 (`migrateV2`): every new field
 * takes the value that draws the same picture.
 *
 * 4 (edit quality): what the auto edit did (`edit`: its plain summary) and "Edit like this video"
 * (`reference`: the reference's analysis, never its pictures). 3 → 4 (`migrateV3`) adds neither,
 * so every older document draws and sounds exactly as before.
 *
 * Still 4: a voice-over's and a clip's own sound may carry `fadeIn` and `fadeOut` seconds (as the
 * music always could). Both are optional and absent means 0, so an older document needs no
 * migration and sounds exactly as before.
 */
export const PROJECT_VERSION = 4;
/** The oldest document version this code still reads. */
export const OLDEST_PROJECT_VERSION = 1;

/** Where a clip's footage comes from: a stored version of the post, a file picked in the browser, or nothing (a gap). */
export type ClipSource = { kind: "version"; batch: string; videoId: string } | { kind: "upload"; name: string; size: number } | { kind: "gap" };

/**
 * The footage a first cut or a template may pick from: the post's clips without the editor's own
 * renders (`rendered`: their version ids), which already carry words, logo and grade and would come
 * back twice. When renders are all there is, they are all there is. (QA: an auto edit took the
 * combined video it had just rendered as a shot.)
 */
export function footageOnly<T extends { source: ClipSource }>(items: readonly T[], rendered: ReadonlySet<string>): T[] {
  const own = items.filter((m) => !(m.source.kind === "version" && rendered.has(m.source.videoId)));
  return own.length ? own : [...items];
}

/** Restrained joins only: a cut, a crossfade, a dip to black, a dip to white. */
export type Transition = "cut" | "crossfade" | "dipBlack" | "dipWhite";
export const TRANSITIONS: readonly { id: Transition; name: string }[] = [
  { id: "cut", name: "A cut" },
  { id: "crossfade", name: "A crossfade" },
  { id: "dipBlack", name: "A dip to black" },
  { id: "dipWhite", name: "A dip to white" },
];
const isTransition = (x: unknown): x is Transition => x === "cut" || x === "crossfade" || x === "dipBlack" || x === "dipWhite";

export interface ColourParams {
  /** Stops, -2 … 2. */
  exposure: number;
  /** -1 … 1, 0 is unchanged. */
  contrast: number;
  saturation: number;
  /** Warm (+) or cool (-), -1 … 1. */
  temperature: number;
  /** Magenta (+) or green (-), -1 … 1. */
  tint: number;
  highlights: number;
  shadows: number;
  /** Colour on the muted parts only (saturated colours move less), -1 … 1. */
  vibrance: number;
  /** The brightest tones up or down (narrower than highlights), -1 … 1. */
  whites: number;
  /** The darkest tones lifted (+, a faded black) or crushed (-), -1 … 1. */
  blacks: number;
}

export const DEFAULT_COLOUR: ColourParams = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vibrance: 0, whites: 0, blacks: 0 };

export const COLOUR_KEYS: (keyof ColourParams)[] = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows", "vibrance", "whites", "blacks"];

/** A named look: a set of colour parameters the person can still adjust. Heuristics, not a film emulation. */
export interface Look {
  id: string;
  name: string;
  hint: string;
  params: ColourParams;
  /** A phase-1 look kept so drafts that use it draw exactly as before; the panel offers `replacedBy` instead. */
  legacy?: boolean;
  replacedBy?: string;
}

/**
 * The colour presets (phase 3): five originals, each a set of the sliders' parameters that the
 * intensity scales (0 … 100 % toward the preset), plus None and Mono. Values chosen by eye on
 * skin, product and outdoor footage; they are starting points, not film emulations. The phase-1
 * looks (warm, cool, matte, punch) stay readable with their old values (`legacy`), so a saved draft
 * renders exactly as it did; "clean" keeps its id and values.
 */
export const LOOKS: readonly Look[] = [
  { id: "none", name: "None", hint: "The footage as it is.", params: DEFAULT_COLOUR },
  { id: "clean", name: "Clean", hint: "Neutral and crisp: a touch more contrast and colour, nothing else.", params: { ...DEFAULT_COLOUR, contrast: 0.12, saturation: 0.1 } },
  { id: "warm-film", name: "Warm Film", hint: "Golden light, soft faded blacks, gentle highlights.", params: { ...DEFAULT_COLOUR, temperature: 0.28, tint: 0.04, contrast: 0.08, saturation: -0.06, vibrance: 0.12, shadows: 0.08, highlights: -0.08, whites: -0.06, blacks: 0.16 } },
  { id: "cool-editorial", name: "Cool Editorial", hint: "Cool clean whites, restrained colour, crisp contrast.", params: { ...DEFAULT_COLOUR, exposure: 0.04, temperature: -0.24, tint: -0.03, contrast: 0.16, saturation: -0.14, vibrance: 0.04, highlights: -0.06, whites: 0.1, blacks: -0.06 } },
  { id: "soft-matte", name: "Soft Matte", hint: "Low contrast, lifted blacks, muted pastel colour.", params: { ...DEFAULT_COLOUR, temperature: 0.04, contrast: -0.16, saturation: -0.18, vibrance: 0.06, shadows: 0.1, whites: -0.1, blacks: 0.32 } },
  { id: "bold-sport", name: "Bold Sport", hint: "Punchy contrast and colour, deep blacks, bright whites.", params: { ...DEFAULT_COLOUR, exposure: 0.05, temperature: -0.04, contrast: 0.32, saturation: 0.18, vibrance: 0.28, highlights: -0.06, whites: 0.12, blacks: -0.14 } },
  { id: "mono", name: "Mono", hint: "Black and white with deep contrast.", params: { ...DEFAULT_COLOUR, saturation: -1, contrast: 0.2 } },
  { id: "warm", name: "Warm (earlier look)", hint: "Golden, soft shadows.", params: { ...DEFAULT_COLOUR, temperature: 0.3, saturation: 0.08, shadows: 0.12, contrast: 0.06 }, legacy: true, replacedBy: "warm-film" },
  { id: "cool", name: "Cool (earlier look)", hint: "Blue, crisp highlights.", params: { ...DEFAULT_COLOUR, temperature: -0.3, contrast: 0.1, highlights: -0.08 }, legacy: true, replacedBy: "cool-editorial" },
  { id: "matte", name: "Matte (earlier look)", hint: "Lifted blacks, muted colour.", params: { ...DEFAULT_COLOUR, shadows: 0.3, contrast: -0.1, saturation: -0.2 }, legacy: true, replacedBy: "soft-matte" },
  { id: "punch", name: "Punch (earlier look)", hint: "Strong contrast and colour for product shots.", params: { ...DEFAULT_COLOUR, contrast: 0.3, saturation: 0.3, exposure: 0.1 }, legacy: true, replacedBy: "bold-sport" },
];

/** The five presets the Colour panel shows with thumbnails, in order. */
export const PRESET_IDS = ["clean", "warm-film", "cool-editorial", "soft-matte", "bold-sport"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const lookOf = (id: string | undefined): Look => LOOKS.find((l) => l.id === id) ?? LOOKS[0];

export interface Clip {
  id: string;
  source: ClipSource;
  /** The source's full length in seconds (read from the file). */
  duration: number;
  /** Source in and out points, seconds; 0 ≤ in < out ≤ duration. */
  in: number;
  out: number;
  /** 0.25 … 4; 2 plays twice as fast. */
  speed: number;
  /** How this clip joins the previous one (ignored on the first clip). */
  transition: Transition;
  /** Seconds of overlap for a crossfade; the whole dip for a dip to black or white. */
  transitionDuration: number;
  /** Per-clip colour on top of the project's; absent = none. */
  colour?: ColourParams;
  /** This clip's own preset and intensity, in place of the project's; absent = the project's. */
  look?: ClipLook;
  /** This clip's colour matched to a reference picture (shared/colour-match.ts); absent = none. */
  match?: ColourMatch;
  /** How this clip sits in the frame (Fill/Fit, zoom, pan); absent = the project's framing. */
  framing?: Framing;
  /** The clip's own sound, 0 … 1 (absent = 1); mixed with the music and the voice-over. */
  volume?: number;
  /** The clip's own sound left out. */
  muted?: boolean;
  /**
   * The clip's own sound fades in over its first `fadeIn` seconds on the timeline and out over its
   * last `fadeOut` seconds (absent = 0, no fade). The seconds count on the timeline, from the
   * trimmed clip's start and to its end, after the speed; the crossfade and dip ramps still apply
   * on top (shared/video-mix.ts `clipGainAt`).
   */
  fadeIn?: number;
  fadeOut?: number;
  /** Auto edit and beat alignment never move or trim a locked clip, and the timeline does not drag it. */
  locked?: boolean;
  /** The clip carries speech: never cut inside by auto edit or beat alignment, and the music ducks under it. */
  speech?: boolean;
  /** Pan (x, y) and zoom over time, seconds from the clip's start on the timeline. */
  keyframes?: Keyframes;
}

/** A preset at an intensity (0 … 1 toward the preset). */
export interface ClipLook {
  id: string;
  amount: number;
}

/**
 * What a library track's licence asks of the published video, kept with the project when the
 * track is picked (shared/music.ts has the full licence; this is what the render and the caption
 * need): the licence, the credit line, and what is known about Content ID.
 */
export interface MusicRights {
  licence: { id: LicenceId; name: string; version: string; url: string };
  /** The licence asks for the credit wherever the video is published (CC BY). */
  attributionRequired: boolean;
  /** The line to publish with the video (the caption or description); a courtesy line when not required. */
  credit: string;
  author: string;
  /** The page that states the licence. */
  sourcePage: string;
  contentId: { status: ContentIdStatus; note: string; url?: string };
  /** Generated test audio: never for a client's video. */
  test?: boolean;
}

/**
 * Where the music comes from: one of the post's licensed tracks (`audioKey`), a file in this tab
 * (`upload`), the studio's catalog (`catalog`, id "cat:<slug>") or a client's imported track
 * (`library`, id "lib:<uuid>"), both from the music library (docs/music-library.md) with the rights.
 */
export type MusicSource =
  | { kind: "audioKey"; key: string; name?: string }
  | { kind: "upload"; name: string; size: number }
  | { kind: "catalog"; trackId: string; name: string; rights: MusicRights }
  | { kind: "library"; trackId: string; client: string; name: string; rights: MusicRights };

/** How far the music goes down under speech: `level` is the music's gain while someone speaks (0.3 = to 30 %). */
export interface Ducking {
  enabled: boolean;
  level: number;
}
export const DEFAULT_DUCKING: Ducking = { enabled: true, level: 0.3 };

export interface Music {
  source: MusicSource;
  /** Seconds into the track at the music's `start` on the timeline. */
  offset: number;
  /** 0 … 1. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** The track's length in seconds, when known. */
  duration?: number;
  /** Beat times in track seconds, as detected (the editor keeps them with the project). */
  beats?: number[];
  /** Where the music starts on the timeline, seconds (version 2; 0 before). */
  start?: number;
  /** Where it stops on the timeline; absent = the end of the cut. */
  end?: number;
  /** Goes down under the clips marked "has speech" and under the voice-over. */
  duck?: Ducking;
}

/** A voice-over: an uploaded recording on its own lane, at a place on the timeline, with its own volume. */
export interface VoiceClip {
  id: string;
  source: MusicSource;
  /** The recording's name for the lane. */
  name: string;
  /** Timeline seconds where it starts. */
  start: number;
  /** Source in and out, seconds. */
  in: number;
  out: number;
  /** The recording's full length. */
  duration: number;
  /** 0 … 1. */
  volume: number;
  /** Seconds the recording fades in from its start and out to its end on the timeline (absent = 0, no fade), as the music's fades. */
  fadeIn?: number;
  fadeOut?: number;
}
export const MAX_VOICES = 8;
/** The longest fade a document may carry on the music, a voice-over or a clip's sound (the sliders go to 5 s). */
export const MAX_FADE_SECONDS = 30;

export interface Output {
  width: number;
  height: number;
  fps: number;
  /** Video bits per second. */
  bitrate: number;
}

export interface VideoProject {
  v: typeof PROJECT_VERSION;
  rev: number;
  createdAt: number;
  updatedAt: number;
  name: string;
  clips: Clip[];
  /** The project-wide colour, then the look's params are its starting point. */
  look: string;
  /** The project look's intensity, 0 … 1 toward the preset (1 for phase-1 drafts). */
  lookAmount: number;
  colour: ColourParams;
  /** Limit hue and saturation changes on skin tones (a hue-range heuristic in the shader; shared/video-looks.ts). */
  protectSkin: boolean;
  /**
   * A .cube LUT: its name, size and strength, and since phase 3 its table (`data`: 8-bit RGB,
   * base64, at most 33³; shared/cube-lut.ts). A phase-1 draft has the name only.
   */
  lut?: { name: string; size: number; strength: number; data?: string } | null;
  music?: Music | null;
  output: Output;
  /** Cuts snap to the music's beats when they are moved. */
  snapToBeats: boolean;
  /** The project's framing for every clip without its own (Fill or Fit, zoom, pan). */
  framing: Framing;
  /** The colour around a Fit picture. */
  background: string;
  /** Text and logo layers over the video, bottom first (shared/video-compose.ts). */
  overlays: Overlay[];
  /** The template the cut was started from (shared/video-templates.ts), when it was. */
  template?: { id: string; at: number } | null;
  /** Voice-over recordings on the Voice lane. */
  voices: VoiceClip[];
  /** What the last auto edit did, in plain lines (shared/edit-plan.ts), shown again on reopen. */
  edit?: AutoEditRecord | null;
  /** "Edit like this video": the reference's analysis (its shots, pace, colour, beat), for the template and the comparison; never its pictures. */
  reference?: ReferenceRecord | null;
}

export interface AutoEditRecord {
  purpose: string;
  pace: string;
  summary: string[];
  at: number;
}

export interface ReferenceRecord {
  analysis: ReferenceAnalysis;
  /** When its template was applied to the cut (null: analysed only). */
  appliedAt: number | null;
  /** The cut's colour was matched to the reference's. */
  matchColour: boolean;
}

export interface OutputPreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const OUTPUT_PRESETS: readonly OutputPreset[] = [
  { id: "reel", name: "Reel · 1080×1920", width: 1080, height: 1920 },
  { id: "square", name: "Square · 1080×1080", width: 1080, height: 1080 },
  { id: "portrait", name: "Portrait · 1080×1350", width: 1080, height: 1350 },
  { id: "landscape", name: "Landscape · 1920×1080", width: 1920, height: 1080 },
];

export const BITRATE_PRESETS: readonly { id: string; name: string; bps: number }[] = [
  { id: "small", name: "Smaller file · 4 Mbit/s", bps: 4_000_000 },
  { id: "good", name: "Good · 8 Mbit/s", bps: 8_000_000 },
  { id: "best", name: "Best · 12 Mbit/s", bps: 12_000_000 },
];

export const OUTPUT_FPS = 30;
/** Audio bits per second for the AAC track. */
export const AUDIO_BITRATE = 128_000;
export const AUDIO_SAMPLE_RATE = 48_000;
/** The editor refuses longer timelines: the browser renders every frame. */
export const MAX_TIMELINE_SECONDS = 60;
export const MAX_CLIPS = 24;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
/** A clip shorter than this on the timeline is not kept by the planner or a split. */
export const MIN_CLIP_SECONDS = 0.25;

export function newClipId(): string {
  return `c${Math.random().toString(36).slice(2, 10)}`;
}

export function newProject(name: string, now = Date.now()): VideoProject {
  return {
    v: PROJECT_VERSION,
    rev: 0,
    createdAt: now,
    updatedAt: now,
    name,
    clips: [],
    look: "none",
    lookAmount: 1,
    colour: { ...DEFAULT_COLOUR },
    protectSkin: false,
    lut: null,
    music: null,
    output: { width: 1080, height: 1920, fps: OUTPUT_FPS, bitrate: 8_000_000 },
    snapToBeats: false,
    framing: { ...DEFAULT_FRAMING },
    background: "#000000",
    overlays: [],
    voices: [],
  };
}

export function newClip(source: ClipSource, duration: number, id = newClipId()): Clip {
  return { id, source, duration, in: 0, out: duration, speed: 1, transition: "cut", transitionDuration: 0.5 };
}

/** An empty stretch of `length` seconds on the Video lane (what a delete that keeps the gap leaves). */
export function gapClip(length: number, id = newClipId()): Clip {
  const d = Math.max(MIN_CLIP_SECONDS, length);
  return { id, source: { kind: "gap" }, duration: d, in: 0, out: d, speed: 1, transition: "cut", transitionDuration: 0.5 };
}

export const isGap = (c: Pick<Clip, "source">): boolean => c.source.kind === "gap";

/** The clip's own sound level after mute: 0 … 1. */
export const clipVolume = (c: Pick<Clip, "volume" | "muted" | "source">): number => (c.muted || c.source.kind === "gap" ? 0 : Math.min(1, Math.max(0, c.volume ?? 1)));

/** The music's place on the timeline: its start, its end (bounded by the cut and the track), and the track second at its start. */
export function musicSpan(m: Pick<Music, "start" | "end" | "offset" | "duration">, length: number): { start: number; end: number } {
  const start = Math.max(0, m.start ?? 0);
  let end = Math.min(length, m.end ?? length);
  if (m.duration !== undefined && m.duration > 0) end = Math.min(end, start + Math.max(0, m.duration - m.offset));
  return { start, end: Math.max(start, end) };
}

/* ───────────── Validation ───────────── */

type Check = { ok: true; project: VideoProject } | { ok: false; reason: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const str = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;

function checkColour(x: unknown, where: string): ColourParams | string {
  if (!isObj(x)) return `${where}: colour must be an object.`;
  const out = { ...DEFAULT_COLOUR };
  for (const k of COLOUR_KEYS) {
    const v = x[k] ?? 0;
    if (!num(v, -2, 2)) return `${where}: colour.${k} must be a number between -2 and 2.`;
    out[k] = v;
  }
  return out;
}

function checkSource(x: unknown): ClipSource | string {
  if (!isObj(x)) return "a clip's source must be an object.";
  if (x.kind === "version") {
    if (!str(x.batch, 100) || !x.batch || !str(x.videoId, 100) || !x.videoId) return "a version source needs batch and videoId.";
    return { kind: "version", batch: x.batch, videoId: x.videoId };
  }
  if (x.kind === "upload") {
    if (!str(x.name, 200) || !num(x.size ?? 0, 0, 1e10)) return "an upload source needs a name and a size.";
    return { kind: "upload", name: x.name, size: (x.size as number | undefined) ?? 0 };
  }
  if (x.kind === "gap") return { kind: "gap" };
  return "a clip's source must be a version, an upload or a gap.";
}

function checkAudioSource(x: unknown, where: string): MusicSource | string {
  if (!isObj(x)) return `${where} needs a source.`;
  if (x.kind === "audioKey" && str(x.key, 300) && x.key) return { kind: "audioKey", key: x.key, ...(str(x.name, 200) && x.name ? { name: x.name } : {}) };
  if (x.kind === "upload" && str(x.name, 200)) return { kind: "upload", name: x.name, size: num(x.size, 0, 1e10) ? x.size : 0 };
  return `${where}.source must be an audioKey or an upload.`;
}

/**
 * A version 1 document read as version 2. What changes and why it sounds the same:
 * - version 1 left the clips' own sound out whenever music was set; version 2 mixes both, so a
 *   v1 document with music gets every clip muted (the render is unchanged); without music the
 *   clips keep their sound as before;
 * - the music starts at 0 on the timeline (its `offset` meant "the track second at 0", which is
 *   the same as "the track second at its start" when the start is 0) and ducking is off (there was
 *   no speech to duck under);
 * - no voice-over, no keyframes, no locks.
 */
export function migrateV1(x: Record<string, unknown>): Record<string, unknown> {
  const hasMusic = isObj(x.music);
  const clips = Array.isArray(x.clips) ? x.clips.map((c) => (isObj(c) && hasMusic ? { ...c, muted: true } : c)) : x.clips;
  const music = hasMusic ? { ...(x.music as Record<string, unknown>), start: 0, duck: { enabled: false, level: DEFAULT_DUCKING.level } } : x.music;
  return { ...x, v: 2, clips, music, voices: [] };
}

/**
 * A version 2 document read as version 3 (phase 3), drawing the same picture: the look at its full
 * intensity (`lookAmount` 1), skin protection off; the new sliders (vibrance, whites, blacks)
 * default to 0 in validation; a clip without `look`/`match` uses the project's colour as it always
 * did; a LUT without `data` keeps asking for its file.
 */
export function migrateV2(x: Record<string, unknown>): Record<string, unknown> {
  return { ...x, v: 3, lookAmount: x.lookAmount ?? 1, protectSkin: x.protectSkin ?? false };
}

/** A version 3 document read as version 4 (edit quality): no auto edit summary and no reference yet; nothing drawn changes. */
export function migrateV3(x: Record<string, unknown>): Record<string, unknown> {
  return { ...x, v: 4, edit: x.edit ?? null, reference: x.reference ?? null };
}

/** An older document brought to the current version step by step (1 → 2 → 3 → 4); other versions are returned as they are. */
export function migrateProject(x: Record<string, unknown>): Record<string, unknown> {
  let doc = x;
  if (doc.v === 1) doc = migrateV1(doc);
  if (doc.v === 2) doc = migrateV2(doc);
  if (doc.v === 3) doc = migrateV3(doc);
  return doc;
}

const TRACK_ID = { catalog: /^cat:[a-z0-9-]{1,80}$/, library: /^lib:[A-Za-z0-9-]{4,80}$/ } as const;

/** The project's music source for a track picked in the music library, with what its licence asks (credit, Content ID). */
export function musicSourceFromTrack(track: MusicTrack): MusicSource {
  const rights: MusicRights = {
    licence: { id: track.licence.id, name: track.licence.name, version: track.licence.version, url: track.licence.url },
    attributionRequired: track.licence.attributionRequired,
    credit: creditLine(track).slice(0, 1000),
    author: track.source.author.slice(0, 200),
    sourcePage: track.source.page.slice(0, 500),
    contentId: { status: track.contentId.status, note: track.contentId.note.slice(0, 1000), ...(track.contentId.url ? { url: track.contentId.url } : {}) },
    ...(track.test ? { test: true } : {}),
  };
  const name = track.title.slice(0, 200) || "Track";
  return track.kind === "library" ? { kind: "library", trackId: track.id, client: track.client ?? "", name, rights } : { kind: "catalog", trackId: track.id, name, rights };
}

/** Where the editor reads a library or catalog track's file (the music library's Range route). */
export const musicFileUrl = (trackId: string): string => `/api/studio/music/file?id=${encodeURIComponent(trackId)}`;

function checkRights(x: unknown): MusicRights | string {
  if (!isObj(x)) return "music.source.rights must say the licence.";
  const l = x.licence;
  if (!isObj(l) || !isLicenceId(l.id) || !str(l.name, 120) || !str(l.version ?? "", 20) || !str(l.url ?? "", 500)) return "music.source.rights.licence needs an id, a name, a version and a link.";
  if (!str(x.credit ?? "", 1000)) return "music.source.rights.credit is too long (1000 characters at most).";
  if (x.attributionRequired === true && !String(x.credit ?? "").trim()) return "music.source.rights.credit is required for a licence that asks for credit.";
  const cid = x.contentId;
  if (!isObj(cid) || !isContentId(cid.status) || !str(cid.note ?? "", 1000) || !str(cid.url ?? "", 500)) return "music.source.rights.contentId needs a status (unknown, registered or not_registered).";
  return {
    licence: { id: l.id, name: l.name, version: (l.version as string | undefined) ?? "", url: (l.url as string | undefined) ?? "" },
    attributionRequired: x.attributionRequired === true,
    credit: (x.credit as string | undefined) ?? "",
    author: str(x.author, 200) ? x.author : "",
    sourcePage: str(x.sourcePage, 500) ? x.sourcePage : "",
    contentId: { status: cid.status, note: (cid.note as string | undefined) ?? "", ...(typeof cid.url === "string" && cid.url ? { url: cid.url } : {}) },
    ...(x.test === true ? { test: true } : {}),
  };
}

/** The music's source: the older kinds (checkAudioSource), or a music library track with its rights. */
function checkMusicSource(s: unknown): MusicSource | string {
  if (!isObj(s)) return "music needs a source.";
  if (s.kind === "catalog" || s.kind === "library") {
    if (typeof s.trackId !== "string" || !TRACK_ID[s.kind].test(s.trackId)) return `music.source.trackId must be a ${s.kind} track id.`;
    if (!str(s.name, 200) || !s.name) return "music.source needs the track's name.";
    const rights = checkRights(s.rights);
    if (typeof rights === "string") return rights;
    if (s.kind === "catalog") return { kind: "catalog", trackId: s.trackId, name: s.name, rights };
    if (!str(s.client, 80) || !s.client) return "a library track needs its client.";
    return { kind: "library", trackId: s.trackId, client: s.client, name: s.name, rights };
  }
  const old = checkAudioSource(s, "music");
  return typeof old === "string" ? "music.source must be an audioKey, an upload, a catalog track or a library track." : old;
}

function checkClipLook(x: unknown, where: string): ClipLook | string {
  if (!isObj(x) || !str(x.id, 40) || !x.id) return `${where}: look needs a preset id.`;
  const amount = x.amount ?? 1;
  if (!num(amount, 0, 1)) return `${where}: look.amount must be between 0 and 1.`;
  return { id: x.id, amount };
}

/** The document a save carries, checked field by field; the reason says what is wrong in plain words. Older versions (1, 2, 3) are migrated first. */
export function validateProject(input: unknown): Check {
  if (!isObj(input)) return { ok: false, reason: "The project must be an object." };
  if (typeof input.v === "number" && input.v > PROJECT_VERSION) return { ok: false, reason: `This project was saved by a newer editor (version ${input.v}); reload the studio to open it.` };
  if (typeof input.v !== "number" || !Number.isInteger(input.v) || input.v < OLDEST_PROJECT_VERSION) return { ok: false, reason: `The project version must be ${PROJECT_VERSION} (or 1, 2 or 3, which are read as ${PROJECT_VERSION}).` };
  const x = migrateProject(input);
  if (x.v !== PROJECT_VERSION) return { ok: false, reason: `The project version must be ${PROJECT_VERSION} (or 1, 2 or 3, which are read as ${PROJECT_VERSION}).` };
  if (!num(x.rev, 0, 1e9) || !Number.isInteger(x.rev)) return { ok: false, reason: "rev must be a whole number." };
  if (!num(x.createdAt, 0, 1e14) || !num(x.updatedAt ?? x.createdAt, 0, 1e14)) return { ok: false, reason: "createdAt and updatedAt must be timestamps." };
  if (!str(x.name, 120)) return { ok: false, reason: "The name is too long (120 characters at most)." };
  if (!Array.isArray(x.clips)) return { ok: false, reason: "clips must be a list." };
  if (x.clips.length > MAX_CLIPS) return { ok: false, reason: `At most ${MAX_CLIPS} clips.` };
  const clips: Clip[] = [];
  const ids = new Set<string>();
  for (const [i, c] of (x.clips as unknown[]).entries()) {
    const where = `clip ${i + 1}`;
    if (!isObj(c)) return { ok: false, reason: `${where} must be an object.` };
    if (!str(c.id, 40) || !c.id || ids.has(c.id)) return { ok: false, reason: `${where} needs a unique id.` };
    ids.add(c.id);
    const source = checkSource(c.source);
    if (typeof source === "string") return { ok: false, reason: `${where}: ${source}` };
    if (!num(c.duration, 0, 3600)) return { ok: false, reason: `${where}: duration must be seconds up to an hour.` };
    if (!num(c.in, 0, c.duration) || !num(c.out, 0, c.duration) || c.out <= c.in) return { ok: false, reason: `${where}: in and out must be inside the clip, with in before out.` };
    if (!num(c.speed, MIN_SPEED, MAX_SPEED)) return { ok: false, reason: `${where}: speed must be between ${MIN_SPEED} and ${MAX_SPEED}.` };
    if (!isTransition(c.transition)) return { ok: false, reason: `${where}: transition must be a cut, a crossfade or a dip to black or white.` };
    if (!num(c.transitionDuration ?? 0.5, 0, 5)) return { ok: false, reason: `${where}: a transition lasts up to 5 seconds.` };
    if (c.volume !== undefined && !num(c.volume, 0, 1)) return { ok: false, reason: `${where}: the clip's volume must be between 0 and 1.` };
    if (!num(c.fadeIn ?? 0, 0, MAX_FADE_SECONDS) || !num(c.fadeOut ?? 0, 0, MAX_FADE_SECONDS)) return { ok: false, reason: `${where}: the sound's fade in and fade out must be seconds between 0 and ${MAX_FADE_SECONDS}.` };
    const kf = checkKeyframes(c.keyframes, CLIP_PROPS, CLIP_RANGE, where);
    if (typeof kf === "string") return { ok: false, reason: kf };
    let colour: ColourParams | undefined;
    if (c.colour !== undefined && c.colour !== null) {
      const r = checkColour(c.colour, where);
      if (typeof r === "string") return { ok: false, reason: r };
      colour = r;
    }
    let framing: Framing | undefined;
    if (c.framing !== undefined && c.framing !== null) {
      if (!isObj(c.framing)) return { ok: false, reason: `${where}: framing must be an object.` };
      framing = normaliseFraming(c.framing as Partial<Framing>);
    }
    let look: ClipLook | undefined;
    if (c.look !== undefined && c.look !== null) {
      const r = checkClipLook(c.look, where);
      if (typeof r === "string") return { ok: false, reason: r };
      look = r;
    }
    let match: ColourMatch | undefined;
    if (c.match !== undefined && c.match !== null) {
      const r = checkMatch(c.match, where);
      if (typeof r === "string") return { ok: false, reason: r };
      match = r;
    }
    clips.push({
      id: c.id,
      source,
      duration: c.duration,
      in: c.in,
      out: c.out,
      speed: c.speed,
      transition: c.transition,
      transitionDuration: (c.transitionDuration as number | undefined) ?? 0.5,
      ...(colour ? { colour } : {}),
      ...(framing ? { framing } : {}),
      ...(look ? { look } : {}),
      ...(match ? { match } : {}),
      ...(typeof c.volume === "number" && c.volume !== 1 ? { volume: c.volume } : {}),
      ...(c.muted === true ? { muted: true } : {}),
      ...(typeof c.fadeIn === "number" && c.fadeIn > 0 ? { fadeIn: c.fadeIn } : {}),
      ...(typeof c.fadeOut === "number" && c.fadeOut > 0 ? { fadeOut: c.fadeOut } : {}),
      ...(c.locked === true ? { locked: true } : {}),
      ...(c.speech === true ? { speech: true } : {}),
      ...(kf ? { keyframes: kf } : {}),
    });
  }
  if (!str(x.look ?? "none", 40)) return { ok: false, reason: "look must be a short name." };
  const lookAmount = x.lookAmount ?? 1;
  if (!num(lookAmount, 0, 1)) return { ok: false, reason: "lookAmount must be between 0 and 1." };
  const colour = checkColour(x.colour ?? DEFAULT_COLOUR, "project");
  if (typeof colour === "string") return { ok: false, reason: colour };
  let lut: VideoProject["lut"] = null;
  if (x.lut !== undefined && x.lut !== null) {
    if (!isObj(x.lut) || !str(x.lut.name, 200) || !num(x.lut.size, 2, 128) || !num(x.lut.strength ?? 1, 0, 1)) return { ok: false, reason: "lut needs a name, a size (2–128) and a strength (0–1)." };
    lut = { name: x.lut.name, size: x.lut.size, strength: (x.lut.strength as number | undefined) ?? 1 };
    if (x.lut.data !== undefined && x.lut.data !== null) {
      // The stored table: at most 33³, exactly size³ RGB bytes as base64 (a larger .cube is resampled before it is stored).
      if (!num(x.lut.size, 2, MAX_STORED_LUT_SIZE) || typeof x.lut.data !== "string" || x.lut.data.length !== storedLutChars(x.lut.size) || !/^[A-Za-z0-9+/]*={0,2}$/.test(x.lut.data))
        return { ok: false, reason: `lut.data must be the table as base64, ${MAX_STORED_LUT_SIZE}³ at most, matching its size.` };
      lut.data = x.lut.data;
    }
  }
  let music: Music | null = null;
  if (x.music !== undefined && x.music !== null) {
    const m = x.music;
    if (!isObj(m) || !isObj(m.source)) return { ok: false, reason: "music needs a source." };
    const source = checkMusicSource(m.source);
    if (typeof source === "string") return { ok: false, reason: source };
    if (!num(m.offset ?? 0, 0, 36000) || !num(m.volume ?? 1, 0, 1) || !num(m.fadeIn ?? 0, 0, MAX_FADE_SECONDS) || !num(m.fadeOut ?? 0, 0, MAX_FADE_SECONDS)) return { ok: false, reason: "music offset, volume and fades are out of range." };
    if (m.duration !== undefined && !num(m.duration, 0, 36000)) return { ok: false, reason: "music.duration must be seconds." };
    if (m.beats !== undefined && (!Array.isArray(m.beats) || m.beats.length > 5000 || !m.beats.every((b) => num(b, 0, 36000)))) return { ok: false, reason: "music.beats must be a list of seconds." };
    if (!num(m.start ?? 0, 0, 3600) || (m.end !== undefined && m.end !== null && (!num(m.end, 0, 3600) || m.end <= ((m.start as number | undefined) ?? 0)))) return { ok: false, reason: "music start and end must be timeline seconds, with the start before the end." };
    let duck: Ducking = { ...DEFAULT_DUCKING };
    if (m.duck !== undefined && m.duck !== null) {
      if (!isObj(m.duck) || !num(m.duck.level ?? DEFAULT_DUCKING.level, 0, 1)) return { ok: false, reason: "music ducking needs a level between 0 and 1." };
      duck = { enabled: m.duck.enabled !== false, level: (m.duck.level as number | undefined) ?? DEFAULT_DUCKING.level };
    }
    music = {
      source,
      offset: (m.offset as number | undefined) ?? 0,
      volume: (m.volume as number | undefined) ?? 1,
      fadeIn: (m.fadeIn as number | undefined) ?? 0,
      fadeOut: (m.fadeOut as number | undefined) ?? 0,
      ...(m.duration !== undefined ? { duration: m.duration as number } : {}),
      ...(m.beats !== undefined ? { beats: m.beats as number[] } : {}),
      start: (m.start as number | undefined) ?? 0,
      ...(typeof m.end === "number" ? { end: m.end } : {}),
      duck,
    };
  }
  const voices: VoiceClip[] = [];
  if (x.voices !== undefined && x.voices !== null) {
    if (!Array.isArray(x.voices) || x.voices.length > MAX_VOICES) return { ok: false, reason: `voices must be a list of at most ${MAX_VOICES} recordings.` };
    const vids = new Set<string>();
    for (const [i, v] of (x.voices as unknown[]).entries()) {
      const where = `voice-over ${i + 1}`;
      if (!isObj(v) || !str(v.id, 40) || !v.id || vids.has(v.id)) return { ok: false, reason: `${where} needs a unique id.` };
      vids.add(v.id);
      const source = checkAudioSource(v.source, where);
      if (typeof source === "string") return { ok: false, reason: source };
      if (!num(v.duration, 0, 3600) || !num(v.in, 0, v.duration) || !num(v.out, 0, v.duration) || v.out <= v.in) return { ok: false, reason: `${where}: in and out must be inside the recording, with in before out.` };
      if (!num(v.start, 0, 3600)) return { ok: false, reason: `${where}: its start must be timeline seconds.` };
      if (!num(v.volume ?? 1, 0, 1)) return { ok: false, reason: `${where}: the volume must be between 0 and 1.` };
      if (!num(v.fadeIn ?? 0, 0, MAX_FADE_SECONDS) || !num(v.fadeOut ?? 0, 0, MAX_FADE_SECONDS)) return { ok: false, reason: `${where}: the fade in and fade out must be seconds between 0 and ${MAX_FADE_SECONDS}.` };
      voices.push({
        id: v.id,
        source,
        name: str(v.name, 200) && v.name ? v.name : "Voice-over",
        start: v.start,
        in: v.in,
        out: v.out,
        duration: v.duration,
        volume: (v.volume as number | undefined) ?? 1,
        // Absent stays absent: a document saved before the voice-over had fades reads back unchanged.
        ...(typeof v.fadeIn === "number" && v.fadeIn > 0 ? { fadeIn: v.fadeIn } : {}),
        ...(typeof v.fadeOut === "number" && v.fadeOut > 0 ? { fadeOut: v.fadeOut } : {}),
      });
    }
  }
  const o = x.output;
  if (!isObj(o) || !num(o.width, 16, 4096) || !num(o.height, 16, 4096) || !num(o.fps, 1, 60) || !num(o.bitrate, 100_000, 50_000_000)) return { ok: false, reason: "output needs width, height (16–4096), fps (1–60) and bitrate." };
  if (o.width % 2 || o.height % 2) return { ok: false, reason: "output width and height must be even numbers (H.264)." };
  if (x.framing !== undefined && x.framing !== null && !isObj(x.framing)) return { ok: false, reason: "framing must be an object." };
  const background = x.background ?? "#000000";
  if (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background)) return { ok: false, reason: "background must be a hex colour like #000000." };
  const overlays = checkOverlays(x.overlays);
  if (typeof overlays === "string") return { ok: false, reason: overlays };
  let template: VideoProject["template"] = null;
  if (x.template !== undefined && x.template !== null) {
    if (!isObj(x.template) || !str(x.template.id, 40) || !x.template.id || !num(x.template.at ?? 0, 0, 1e14)) return { ok: false, reason: "template needs an id." };
    template = { id: x.template.id, at: (x.template.at as number | undefined) ?? 0 };
  }
  let edit: AutoEditRecord | null = null;
  if (x.edit !== undefined && x.edit !== null) {
    const e = x.edit;
    if (!isObj(e) || !str(e.purpose, 40) || !str(e.pace, 40) || !Array.isArray(e.summary) || e.summary.length > 16 || !e.summary.every((l) => str(l, 400)) || !num(e.at, 0, 1e14)) return { ok: false, reason: "edit needs a purpose, a pace, a summary of at most 16 short lines and a time." };
    edit = { purpose: e.purpose, pace: e.pace, summary: e.summary as string[], at: e.at };
  }
  let reference: ReferenceRecord | null = null;
  if (x.reference !== undefined && x.reference !== null) {
    const r = x.reference;
    if (!isObj(r)) return { ok: false, reason: "reference must be an object." };
    const a = checkReference(r.analysis);
    if (typeof a === "string") return { ok: false, reason: a };
    if (!(r.appliedAt === null || r.appliedAt === undefined || num(r.appliedAt, 0, 1e14))) return { ok: false, reason: "reference.appliedAt must be a timestamp or null." };
    reference = { analysis: a, appliedAt: (r.appliedAt as number | null | undefined) ?? null, matchColour: r.matchColour === true };
  }
  const project: VideoProject = {
    v: PROJECT_VERSION,
    rev: x.rev,
    createdAt: x.createdAt,
    updatedAt: (x.updatedAt as number | undefined) ?? x.createdAt,
    name: x.name,
    clips,
    look: (x.look as string | undefined) ?? "none",
    lookAmount,
    colour,
    protectSkin: x.protectSkin === true,
    lut,
    music,
    output: { width: o.width, height: o.height, fps: o.fps, bitrate: o.bitrate },
    snapToBeats: x.snapToBeats === true,
    framing: normaliseFraming(x.framing as Partial<Framing> | undefined),
    background,
    overlays,
    ...(template ? { template } : {}),
    voices,
    ...(edit ? { edit } : {}),
    ...(reference ? { reference } : {}),
  };
  const total = totalLength(project);
  if (total > MAX_TIMELINE_SECONDS + 1e-6) return { ok: false, reason: `The timeline is ${total.toFixed(1)} s; the editor renders up to ${MAX_TIMELINE_SECONDS} s.` };
  return { ok: true, project };
}

/** The framing a clip is drawn with: its own, else the project's. */
export function clipFraming(p: Pick<VideoProject, "framing">, c: Pick<Clip, "framing">): Framing {
  return normaliseFraming(c.framing ?? p.framing ?? DEFAULT_FRAMING);
}

/** The framing at `local` seconds into the clip on the timeline: its framing moved by its pan and zoom keyframes. */
export function clipFramingAt(p: Pick<VideoProject, "framing">, c: Pick<Clip, "framing" | "keyframes">, local: number): Framing {
  const f = clipFraming(p, c);
  const kf = c.keyframes;
  if (!kf) return f;
  return normaliseFraming({ fit: f.fit, zoom: valueAt(kf.zoom, local, f.zoom), x: valueAt(kf.x, local, f.x), y: valueAt(kf.y, local, f.y) });
}

/* ───────────── Timeline arithmetic ───────────── */

/** Seconds a clip takes on the timeline. */
export const clipLength = (c: Clip): number => Math.max(0, (c.out - c.in) / c.speed);

/** The overlap a clip takes from the one before it (a crossfade), bounded by both clips' lengths. */
export function overlapOf(prev: Clip | undefined, c: Clip): number {
  if (!prev || c.transition !== "crossfade") return 0;
  return Math.max(0, Math.min(c.transitionDuration, clipLength(prev) / 2, clipLength(c) / 2));
}

export interface Placed {
  clip: Clip;
  index: number;
  /** Timeline start and end, seconds. */
  start: number;
  end: number;
  /** Seconds at the start that fade in from the previous clip. */
  overlap: number;
}

/** Each clip's place on the timeline, in order; crossfades pull a clip back over the previous one. */
export function placeClips(clips: readonly Clip[]): Placed[] {
  const out: Placed[] = [];
  let t = 0;
  clips.forEach((clip, index) => {
    const overlap = overlapOf(clips[index - 1], clip);
    const start = Math.max(0, t - overlap);
    const end = start + clipLength(clip);
    out.push({ clip, index, start, end, overlap });
    t = end;
  });
  return out;
}

export const totalLength = (p: Pick<VideoProject, "clips">): number => {
  const placed = placeClips(p.clips);
  return placed.length ? placed[placed.length - 1].end : 0;
};

/** The cut points between clips (where one ends and the next begins), timeline seconds, without 0 and the end. */
export function cutTimes(clips: readonly Clip[]): number[] {
  return placeClips(clips)
    .slice(1)
    .map((pl) => pl.start + pl.overlap / 2);
}

/** Source time of a clip at timeline time t (clamped inside the clip). */
export function sourceTimeAt(pl: Placed, t: number): number {
  const local = Math.min(Math.max(0, t - pl.start), pl.end - pl.start);
  return Math.min(pl.clip.out, pl.clip.in + local * pl.clip.speed);
}

export interface FrameAt {
  /** The clip drawn underneath (the one ending) and the one fading in, when inside a crossfade. */
  a: { placed: Placed; source: number } | null;
  b: { placed: Placed; source: number; mix: number } | null;
}

/** Seconds a cut may sit after a frame time and still start on it (a microsecond). */
export const CUT_EPSILON = 1e-6;

/** What is on screen at timeline time t: one clip, or two with a mix during a crossfade. */
export function frameAt(clips: readonly Clip[], t: number): FrameAt {
  const placed = placeClips(clips);
  // A cut that floating-point sums put a hair after a frame time (0.1 + 0.2 = 0.30000000000000004) still lands on that frame.
  const on = placed.filter((pl) => t >= pl.start - CUT_EPSILON && t < pl.end - CUT_EPSILON);
  if (!on.length) {
    const last = placed[placed.length - 1];
    return last && t >= last.end - CUT_EPSILON ? { a: { placed: last, source: last.clip.out }, b: null } : { a: null, b: null };
  }
  if (on.length === 1) return { a: { placed: on[0], source: sourceTimeAt(on[0], t) }, b: null };
  const [a, b] = on.slice(-2);
  const mix = b.overlap > 0 ? Math.min(1, Math.max(0, (t - b.start) / b.overlap)) : 1;
  return { a: { placed: a, source: sourceTimeAt(a, t) }, b: { placed: b, source: sourceTimeAt(b, t), mix } };
}

/** Half a dip, on each side of the cut: half the transition, bounded by half of either clip. 0 when the clip does not dip. */
export function dipHalf(prev: Clip | undefined, c: Clip): number {
  if (!prev || (c.transition !== "dipBlack" && c.transition !== "dipWhite")) return 0;
  return Math.max(0, Math.min(c.transitionDuration / 2, clipLength(prev) / 2, clipLength(c) / 2));
}

/**
 * A dip to black or white at timeline time t: the colour and how much of it covers the footage
 * (0 … 1, full at the cut, linear on both sides). Null outside every dip. The text and logo layers
 * stay on top of it.
 */
export function dipAt(clips: readonly Clip[], t: number): { colour: "black" | "white"; amount: number } | null {
  const placed = placeClips(clips);
  for (let i = 1; i < placed.length; i++) {
    const h = dipHalf(clips[i - 1], placed[i].clip);
    if (!h) continue;
    const d = Math.abs(t - placed[i].start);
    if (d < h) return { colour: placed[i].clip.transition === "dipWhite" ? "white" : "black", amount: 1 - d / h };
  }
  return null;
}

/** The clip split in two at a timeline time inside it; null when the split would leave a sliver. Keyframes are split with it. */
export function splitClip(c: Clip, atLocal: number): [Clip, Clip] | null {
  const len = clipLength(c);
  if (atLocal < MIN_CLIP_SECONDS || len - atLocal < MIN_CLIP_SECONDS) return null;
  const s = c.in + atLocal * c.speed;
  const [kl, kr] = splitKeyframes(c.keyframes, atLocal);
  const left: Clip = { ...c, out: s };
  const right: Clip = { ...c, id: newClipId(), in: s, transition: "cut" };
  // The sound's fade in stays at the start of the first half, its fade out at the end of the second.
  delete left.fadeOut;
  delete right.fadeIn;
  if (c.source.kind === "gap") {
    left.duration = s;
    right.duration = c.out - s;
    right.in = 0;
    right.out = c.out - s;
  }
  delete left.keyframes;
  delete right.keyframes;
  if (kl) left.keyframes = kl;
  if (kr) right.keyframes = kr;
  return [left, right];
}

/** A clip's in or out moved, kept inside the source and at least a sliver long. */
export function trimClip(c: Clip, patch: { in?: number; out?: number }): Clip {
  const min = MIN_CLIP_SECONDS * c.speed;
  let i = patch.in ?? c.in;
  let o = patch.out ?? c.out;
  i = Math.min(Math.max(0, i), c.duration - min);
  o = Math.max(Math.min(c.duration, o), i + min);
  if (patch.in !== undefined && o - i < min) i = o - min;
  return { ...c, in: Math.max(0, i), out: o };
}

export function moveClip(clips: readonly Clip[], from: number, to: number): Clip[] {
  const out = [...clips];
  const [c] = out.splice(from, 1);
  if (!c) return out;
  out.splice(Math.min(Math.max(0, to), out.length), 0, c);
  return out;
}

/** The output's rough size in bytes: video plus audio at their bit rates. */
export function estimateBytes(output: Output, seconds: number): number {
  return Math.round(((output.bitrate + AUDIO_BITRATE) * seconds) / 8);
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/* ───────────── Beats ───────────── */

/** The beat closest to t within `tolerance` seconds, or t itself. */
export function nearestBeat(t: number, beats: readonly number[], tolerance = 0.25): number {
  let best = t;
  let d = tolerance;
  for (const b of beats) {
    const dd = Math.abs(b - t);
    if (dd <= d) {
      d = dd;
      best = b;
    }
  }
  return best;
}

/** Beat times in track seconds moved onto the timeline: the track second `offset` plays at the music's `start`; only beats while the music plays. */
export function timelineBeats(music: Pick<Music, "beats" | "offset" | "start" | "end"> | null | undefined, length: number): number[] {
  if (!music?.beats) return [];
  const start = music.start ?? 0;
  const end = Math.min(length, music.end ?? length);
  return music.beats.map((b) => Math.round((start + b - music.offset) * 1e6) / 1e6).filter((b) => b >= start && b >= 0 && b <= end);
}

/**
 * Every cut moved to its nearest beat by trimming the clip that ends there (its out point moves;
 * speed stays). A cut with no beat within `tolerance` stays. The first clip's start is 0 and the
 * last clip's end is not moved. Pure: returns new clips.
 */
export function snapCutsToBeats(clips: readonly Clip[], beats: readonly number[], tolerance = 0.25): Clip[] {
  if (!beats.length || clips.length < 2) return [...clips];
  const out = clips.map((c) => ({ ...c }));
  for (let i = 0; i < out.length - 1; i++) {
    const placed = placeClips(out);
    const cut = placed[i + 1].start + placed[i + 1].overlap / 2;
    const target = nearestBeat(cut, beats, tolerance);
    if (target === cut) continue;
    const delta = target - cut;
    const c = out[i];
    // A locked clip is never moved or trimmed, and neither is a clip with speech cut inside.
    if (c.locked || c.speech || out.slice(i + 1).some((x) => x.locked)) continue;
    const newOut = c.out + delta * c.speed;
    if (newOut <= c.in + MIN_CLIP_SECONDS * c.speed || newOut > c.duration) continue;
    out[i] = { ...c, out: newOut };
  }
  return out;
}

/**
 * Beat times from an energy envelope (one value per `hop` seconds, e.g. the RMS of 20 ms hops):
 * the tempo comes from the autocorrelation of the onset strength (shared/music.ts
 * `tempoFromEnvelope`), or from `bpm` when the track's tempo is already known (the music
 * library's); the grid's phase is the one whose ticks land on the strongest rises; then each tick
 * moves onto an onset close to it, so a recording that drifts a little stays on the beat and quiet
 * bars still get a tick. Without a clear tempo the grid falls back to the most common spacing
 * between onsets. Energy-based, so it finds pulses, not musical downbeats: a heuristic, not a
 * transcription. (The spacing-only grid picked 0.36 s on a 128 BPM track, cuts off the beat.)
 */
export function detectBeats(energy: ArrayLike<number>, hop: number, opts: { minGap?: number; window?: number; threshold?: number; bpm?: number | null } = {}): number[] {
  const n = energy.length;
  if (n < 4 || hop <= 0) return [];
  const minGap = opts.minGap ?? 0.25;
  const win = Math.max(2, Math.round((opts.window ?? 1) / hop));
  const threshold = opts.threshold ?? 1.3;
  const onsets: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < n; i++) {
    const from = Math.max(0, i - win);
    let sum = 0;
    for (let j = from; j < i; j++) sum += energy[j];
    const mean = sum / (i - from);
    const rise = energy[i] - energy[i - 1];
    const t = i * hop;
    if (energy[i] > mean * threshold && rise > 0 && t - last >= minGap) {
      onsets.push(t);
      last = t;
    }
  }
  if (onsets.length < 2) return onsets;
  const end = (n - 1) * hop;
  const hint = opts.bpm && opts.bpm >= 40 && opts.bpm <= 240 ? opts.bpm : null;
  const bpm = hint ?? tempoFromEnvelope(energy, hop).bpm;
  if (bpm) return tempoGrid(energy, hop, 60 / bpm, onsets, end);
  // No clear tempo: the most common spacing (to 20 ms) becomes the grid period; the grid starts at
  // the first onset and drifts back to the nearest onset where there is one.
  const spacings = new Map<number, number>();
  for (let i = 1; i < onsets.length; i++) {
    const s = Math.round((onsets[i] - onsets[i - 1]) / 0.02) * 0.02;
    if (s >= minGap && s <= 2) spacings.set(s, (spacings.get(s) ?? 0) + 1);
  }
  let period = 0;
  let count = 0;
  for (const [s, c] of spacings) if (c > count || (c === count && s < period)) [period, count] = [s, c];
  if (!period || count < 2) return onsets;
  const grid: number[] = [];
  let t = onsets[0];
  while (t <= end + 1e-9) {
    const near = nearestBeat(t, onsets, period * 0.3);
    grid.push(Math.round(near * 1000) / 1000);
    t = near + period;
  }
  return grid;
}

/** A steady grid at `period`: the phase where the ticks meet the strongest rises, each tick then moved onto an onset within a fifth of a beat. */
function tempoGrid(energy: ArrayLike<number>, hop: number, period: number, onsets: readonly number[], end: number): number[] {
  const n = energy.length;
  const flux = new Float32Array(n);
  let prev = Math.log(1e-4 + energy[0]);
  for (let i = 1; i < n; i++) {
    const l = Math.log(1e-4 + energy[i]);
    flux[i] = Math.max(0, l - prev);
    prev = l;
  }
  // The phase from the first minute (or the whole track when shorter).
  const span = Math.min(end, 60);
  let phase = 0;
  let best = -1;
  for (let p = 0; p < period; p += hop) {
    let s = 0;
    for (let t = p; t <= span; t += period) {
      const i = Math.round(t / hop);
      s += Math.max(flux[i] ?? 0, flux[i + 1] ?? 0);
    }
    if (s > best) [best, phase] = [s, p];
  }
  const grid: number[] = [];
  let t = phase;
  while (t <= end + 1e-9) {
    const near = nearestBeat(t, onsets, period * 0.2);
    grid.push(Math.round(near * 1000) / 1000);
    // The next tick from this one, pulled half way back to the steady grid so one stray onset does not drag it.
    t = (near + t) / 2 + period;
  }
  return grid;
}

/* ───────────── Auto edit ───────────── */

export type AutoStyle = "calm" | "energetic";

export interface AutoClipInput {
  id: string;
  source: ClipSource;
  duration: number;
  /** Motion energy per `step` seconds (mean absolute frame difference); empty when not measured. */
  energy: ArrayLike<number>;
  step: number;
}

export interface AutoEditOptions {
  /** Wanted timeline length, seconds. */
  target: number;
  style: AutoStyle;
  /** Beat times in timeline seconds, when music is set: cuts land on them. */
  beats?: readonly number[];
  look?: string;
}

/**
 * A deterministic first cut from the chosen footage (heuristics, not AI):
 *  - the target length is shared among the clips in proportion to their length, with a floor and
 *    a ceiling per style (calm: 2–6 s shots, energetic: 0.8–2.5 s);
 *  - each clip is trimmed to its most active window: the stretch of that length with the highest
 *    mean frame-difference energy (a clip with no measurement keeps its middle);
 *  - calm orders clips as given with crossfades; energetic orders them by energy, the liveliest
 *    first, with hard cuts;
 *  - with beats, every shot's length is rounded to whole beats so cuts fall on the grid;
 *  - clips are reused in order when the footage is shorter than the target.
 * The person edits everything afterwards.
 */
export function planAutoEdit(inputs: readonly AutoClipInput[], opts: AutoEditOptions): Clip[] {
  const usable = inputs.filter((c) => c.duration >= MIN_CLIP_SECONDS);
  if (!usable.length) return [];
  const target = Math.min(MAX_TIMELINE_SECONDS, Math.max(1, opts.target));
  const [minShot, maxShot] = opts.style === "energetic" ? [0.8, 2.5] : [2, 6];
  const ordered = opts.style === "energetic" ? [...usable].sort((a, b) => meanEnergy(b) - meanEnergy(a) || a.id.localeCompare(b.id)) : [...usable];
  const beatPeriod = opts.beats && opts.beats.length > 1 ? medianGap(opts.beats) : 0;
  const shots: Clip[] = [];
  const remaining = () => target - totalLength({ clips: shots });
  // A shot shorter than the style's minimum is never added: the cut ends a little short of the target instead.
  const floor = Math.max(MIN_CLIP_SECONDS, beatPeriod || minShot);
  for (let round = 0; round < 8 && remaining() >= floor && shots.length < MAX_CLIPS; round++) {
    const share = Math.min(maxShot, Math.max(minShot, remaining() / ordered.length));
    let added = false;
    for (const src of ordered) {
      const rem = remaining();
      if (rem < floor || shots.length >= MAX_CLIPS) break;
      const transition: Transition = opts.style === "calm" && shots.length > 0 ? "crossfade" : "cut";
      const overlap = transition === "crossfade" ? 0.5 : 0;
      let len = Math.min(share, src.duration, rem + overlap);
      if (beatPeriod) len = Math.min(src.duration, Math.max(beatPeriod, Math.round(len / beatPeriod) * beatPeriod));
      if (len < MIN_CLIP_SECONDS) continue;
      // A later round takes the next-best window, so the same seconds are not shown twice when the clip is long enough.
      const start = bestWindow(src, len, round);
      shots.push({ id: `${src.id}-${round}`, source: src.source, duration: src.duration, in: start, out: start + len, speed: 1, transition, transitionDuration: overlap || 0.3 });
      added = true;
    }
    if (!added) break;
  }
  return shots;
}

function meanEnergy(c: AutoClipInput): number {
  const n = c.energy.length;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += c.energy[i];
  return s / n;
}

function medianGap(beats: readonly number[]): number {
  const gaps = beats
    .slice(1)
    .map((b, i) => b - beats[i])
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

/**
 * The start of the `len`-second window with the highest mean energy; `rank` 1 asks for the best
 * window that does not overlap the best one, and so on. Without a measurement the clip's middle.
 */
export function bestWindow(c: AutoClipInput, len: number, rank = 0): number {
  const n = c.energy.length;
  if (len >= c.duration) return 0;
  if (!n || c.step <= 0) return Math.max(0, (c.duration - len) / 2);
  const w = Math.max(1, Math.round(len / c.step));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + c.energy[i];
  const candidates: { start: number; score: number }[] = [];
  for (let i = 0; i + w <= n; i++) candidates.push({ start: i, score: prefix[i + w] - prefix[i] });
  if (!candidates.length) return 0;
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const taken: { start: number }[] = [];
  for (const cand of candidates) {
    if (taken.some((t) => Math.abs(t.start - cand.start) < w)) continue;
    taken.push(cand);
    if (taken.length > rank) break;
  }
  const pick = taken[Math.min(rank, taken.length - 1)];
  return Math.min(Math.max(0, pick.start * c.step), Math.max(0, c.duration - len));
}
