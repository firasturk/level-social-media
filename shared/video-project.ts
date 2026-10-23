/**
 * The video editor's project document and the arithmetic on it: clips on a timeline (trims, order,
 * speed, transitions), colour, a music track, the output. Plain TypeScript, no zod, no browser:
 * the server validates a saved project with `validateProject`, the editor and the tests use the
 * timeline, beat-snapping and auto-edit functions below. Everything here is deterministic.
 *
 * Seconds everywhere. A clip's `in`/`out` are source times; its length on the timeline is
 * (out - in) / speed. Clips sit one after another in `clips` order; a crossfade overlaps the
 * previous clip's tail by `transitionDuration`.
 */

import { checkOverlays, DEFAULT_FRAMING, normaliseFraming, type Framing, type Overlay } from "./video-compose";

export const PROJECT_VERSION = 1;

/** Where a clip's footage comes from: a stored version of the post, or a file picked in the browser. */
export type ClipSource = { kind: "version"; batch: string; videoId: string } | { kind: "upload"; name: string; size: number };

export type Transition = "cut" | "crossfade";

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
}

export const DEFAULT_COLOUR: ColourParams = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };

export const COLOUR_KEYS: (keyof ColourParams)[] = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];

/** A named look: a set of colour parameters the person can still adjust. Heuristics, not a film emulation. */
export interface Look {
  id: string;
  name: string;
  hint: string;
  params: ColourParams;
}

export const LOOKS: readonly Look[] = [
  { id: "none", name: "None", hint: "The footage as it is.", params: DEFAULT_COLOUR },
  { id: "clean", name: "Clean", hint: "A touch more contrast and colour.", params: { ...DEFAULT_COLOUR, contrast: 0.12, saturation: 0.1 } },
  { id: "warm", name: "Warm", hint: "Golden, soft shadows.", params: { ...DEFAULT_COLOUR, temperature: 0.3, saturation: 0.08, shadows: 0.12, contrast: 0.06 } },
  { id: "cool", name: "Cool", hint: "Blue, crisp highlights.", params: { ...DEFAULT_COLOUR, temperature: -0.3, contrast: 0.1, highlights: -0.08 } },
  { id: "matte", name: "Matte", hint: "Lifted blacks, muted colour.", params: { ...DEFAULT_COLOUR, shadows: 0.3, contrast: -0.1, saturation: -0.2 } },
  { id: "punch", name: "Punch", hint: "Strong contrast and colour for product shots.", params: { ...DEFAULT_COLOUR, contrast: 0.3, saturation: 0.3, exposure: 0.1 } },
  { id: "mono", name: "Mono", hint: "Black and white with deep contrast.", params: { ...DEFAULT_COLOUR, saturation: -1, contrast: 0.2 } },
];

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
  /** Seconds of overlap for a crossfade. */
  transitionDuration: number;
  /** Per-clip colour on top of the project's; absent = none. */
  colour?: ColourParams;
  /** How this clip sits in the frame (Fill/Fit, zoom, pan); absent = the project's framing. */
  framing?: Framing;
}

export type MusicSource = { kind: "audioKey"; key: string; name?: string } | { kind: "upload"; name: string; size: number };

export interface Music {
  source: MusicSource;
  /** Seconds into the track where the timeline's 0 starts. */
  offset: number;
  /** 0 … 1. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** The track's length in seconds, when known. */
  duration?: number;
  /** Beat times in track seconds, as detected (the editor keeps them with the project). */
  beats?: number[];
}

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
  colour: ColourParams;
  /** A .cube LUT by name (the editor keeps the parsed table in memory; the file is not stored). */
  lut?: { name: string; size: number; strength: number } | null;
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
    colour: { ...DEFAULT_COLOUR },
    lut: null,
    music: null,
    output: { width: 1080, height: 1920, fps: OUTPUT_FPS, bitrate: 8_000_000 },
    snapToBeats: false,
    framing: { ...DEFAULT_FRAMING },
    background: "#000000",
    overlays: [],
  };
}

export function newClip(source: ClipSource, duration: number, id = newClipId()): Clip {
  return { id, source, duration, in: 0, out: duration, speed: 1, transition: "cut", transitionDuration: 0.5 };
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
  return "a clip's source must be a version or an upload.";
}

/** The document a save carries, checked field by field; the reason says what is wrong in plain words. */
export function validateProject(x: unknown): Check {
  if (!isObj(x)) return { ok: false, reason: "The project must be an object." };
  if (x.v !== PROJECT_VERSION) return { ok: false, reason: `The project version must be ${PROJECT_VERSION}.` };
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
    if (c.transition !== "cut" && c.transition !== "crossfade") return { ok: false, reason: `${where}: transition must be cut or crossfade.` };
    if (!num(c.transitionDuration ?? 0.5, 0, 5)) return { ok: false, reason: `${where}: a transition lasts up to 5 seconds.` };
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
    clips.push({ id: c.id, source, duration: c.duration, in: c.in, out: c.out, speed: c.speed, transition: c.transition, transitionDuration: (c.transitionDuration as number | undefined) ?? 0.5, ...(colour ? { colour } : {}), ...(framing ? { framing } : {}) });
  }
  if (!str(x.look ?? "none", 40)) return { ok: false, reason: "look must be a short name." };
  const colour = checkColour(x.colour ?? DEFAULT_COLOUR, "project");
  if (typeof colour === "string") return { ok: false, reason: colour };
  let lut: VideoProject["lut"] = null;
  if (x.lut !== undefined && x.lut !== null) {
    if (!isObj(x.lut) || !str(x.lut.name, 200) || !num(x.lut.size, 2, 128) || !num(x.lut.strength ?? 1, 0, 1)) return { ok: false, reason: "lut needs a name, a size (2–128) and a strength (0–1)." };
    lut = { name: x.lut.name, size: x.lut.size, strength: (x.lut.strength as number | undefined) ?? 1 };
  }
  let music: Music | null = null;
  if (x.music !== undefined && x.music !== null) {
    const m = x.music;
    if (!isObj(m) || !isObj(m.source)) return { ok: false, reason: "music needs a source." };
    let source: MusicSource;
    if (m.source.kind === "audioKey" && str(m.source.key, 300) && m.source.key) source = { kind: "audioKey", key: m.source.key, ...(str(m.source.name, 200) && m.source.name ? { name: m.source.name } : {}) };
    else if (m.source.kind === "upload" && str(m.source.name, 200)) source = { kind: "upload", name: m.source.name, size: num(m.source.size, 0, 1e10) ? m.source.size : 0 };
    else return { ok: false, reason: "music.source must be an audioKey or an upload." };
    if (!num(m.offset ?? 0, 0, 36000) || !num(m.volume ?? 1, 0, 1) || !num(m.fadeIn ?? 0, 0, 30) || !num(m.fadeOut ?? 0, 0, 30)) return { ok: false, reason: "music offset, volume and fades are out of range." };
    if (m.duration !== undefined && !num(m.duration, 0, 36000)) return { ok: false, reason: "music.duration must be seconds." };
    if (m.beats !== undefined && (!Array.isArray(m.beats) || m.beats.length > 5000 || !m.beats.every((b) => num(b, 0, 36000)))) return { ok: false, reason: "music.beats must be a list of seconds." };
    music = { source, offset: (m.offset as number | undefined) ?? 0, volume: (m.volume as number | undefined) ?? 1, fadeIn: (m.fadeIn as number | undefined) ?? 0, fadeOut: (m.fadeOut as number | undefined) ?? 0, ...(m.duration !== undefined ? { duration: m.duration as number } : {}), ...(m.beats !== undefined ? { beats: m.beats as number[] } : {}) };
  }
  const o = x.output;
  if (!isObj(o) || !num(o.width, 16, 4096) || !num(o.height, 16, 4096) || !num(o.fps, 1, 60) || !num(o.bitrate, 100_000, 50_000_000)) return { ok: false, reason: "output needs width, height (16–4096), fps (1–60) and bitrate." };
  if (o.width % 2 || o.height % 2) return { ok: false, reason: "output width and height must be even numbers (H.264)." };
  if (x.framing !== undefined && x.framing !== null && !isObj(x.framing)) return { ok: false, reason: "framing must be an object." };
  const background = x.background ?? "#000000";
  if (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background)) return { ok: false, reason: "background must be a hex colour like #000000." };
  const overlays = checkOverlays(x.overlays);
  if (typeof overlays === "string") return { ok: false, reason: overlays };
  const project: VideoProject = {
    v: PROJECT_VERSION,
    rev: x.rev,
    createdAt: x.createdAt,
    updatedAt: (x.updatedAt as number | undefined) ?? x.createdAt,
    name: x.name,
    clips,
    look: (x.look as string | undefined) ?? "none",
    colour,
    lut,
    music,
    output: { width: o.width, height: o.height, fps: o.fps, bitrate: o.bitrate },
    snapToBeats: x.snapToBeats === true,
    framing: normaliseFraming(x.framing as Partial<Framing> | undefined),
    background,
    overlays,
  };
  const total = totalLength(project);
  if (total > MAX_TIMELINE_SECONDS + 1e-6) return { ok: false, reason: `The timeline is ${total.toFixed(1)} s; the editor renders up to ${MAX_TIMELINE_SECONDS} s.` };
  return { ok: true, project };
}

/** The framing a clip is drawn with: its own, else the project's. */
export function clipFraming(p: Pick<VideoProject, "framing">, c: Pick<Clip, "framing">): Framing {
  return normaliseFraming(c.framing ?? p.framing ?? DEFAULT_FRAMING);
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

/** What is on screen at timeline time t: one clip, or two with a mix during a crossfade. */
export function frameAt(clips: readonly Clip[], t: number): FrameAt {
  const placed = placeClips(clips);
  const on = placed.filter((pl) => t >= pl.start && t < pl.end);
  if (!on.length) {
    const last = placed[placed.length - 1];
    return last && t >= last.end ? { a: { placed: last, source: last.clip.out }, b: null } : { a: null, b: null };
  }
  if (on.length === 1) return { a: { placed: on[0], source: sourceTimeAt(on[0], t) }, b: null };
  const [a, b] = on.slice(-2);
  const mix = b.overlap > 0 ? Math.min(1, Math.max(0, (t - b.start) / b.overlap)) : 1;
  return { a: { placed: a, source: sourceTimeAt(a, t) }, b: { placed: b, source: sourceTimeAt(b, t), mix } };
}

/** The clip split in two at a timeline time inside it; null when the split would leave a sliver. */
export function splitClip(c: Clip, atLocal: number): [Clip, Clip] | null {
  const len = clipLength(c);
  if (atLocal < MIN_CLIP_SECONDS || len - atLocal < MIN_CLIP_SECONDS) return null;
  const s = c.in + atLocal * c.speed;
  return [
    { ...c, out: s },
    { ...c, id: newClipId(), in: s, transition: "cut" },
  ];
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

/** Beat times in track seconds moved onto the timeline (the track starts `offset` seconds before 0). */
export function timelineBeats(music: Pick<Music, "beats" | "offset"> | null | undefined, length: number): number[] {
  if (!music?.beats) return [];
  return music.beats.map((b) => b - music.offset).filter((b) => b >= 0 && b <= length);
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
    const newOut = c.out + delta * c.speed;
    if (newOut <= c.in + MIN_CLIP_SECONDS * c.speed || newOut > c.duration) continue;
    out[i] = { ...c, out: newOut };
  }
  return out;
}

/**
 * Beat times from an energy envelope (one value per `hop` seconds, e.g. the RMS of 1024-sample
 * windows): an onset is a hop whose energy rises above the local average by a margin, at least a
 * minimum gap apart; then a steady grid is fitted to the most common onset spacing so quiet bars
 * still get a tick. Energy-based, so it finds pulses, not musical downbeats; a track without a
 * clear pulse gets a grid from the loudest rises only. This is a heuristic, not a transcription.
 */
export function detectBeats(energy: ArrayLike<number>, hop: number, opts: { minGap?: number; window?: number; threshold?: number } = {}): number[] {
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
  // The most common spacing (to 20 ms) becomes the grid period; the grid starts at the first onset
  // and drifts back to the nearest onset where there is one.
  const spacings = new Map<number, number>();
  for (let i = 1; i < onsets.length; i++) {
    const s = Math.round((onsets[i] - onsets[i - 1]) / 0.02) * 0.02;
    if (s >= minGap && s <= 2) spacings.set(s, (spacings.get(s) ?? 0) + 1);
  }
  let period = 0;
  let count = 0;
  for (const [s, c] of spacings) if (c > count || (c === count && s < period)) [period, count] = [s, c];
  if (!period || count < 2) return onsets;
  const end = (n - 1) * hop;
  const grid: number[] = [];
  let t = onsets[0];
  while (t <= end + 1e-9) {
    const near = nearestBeat(t, onsets, period * 0.3);
    grid.push(Math.round(near * 1000) / 1000);
    t = near + period;
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
