/**
 * The sound of a cut, as numbers both the preview and the render use (phase 2): every clip's own
 * sound at its volume (fading under crossfades and dips, and in and out by its own fades), the
 * music at its place on the timeline with its volume and fades, ducked under speech, and the
 * voice-over recordings with their volumes and fades.
 *
 * Every fade is the same arithmetic, `fadeGain`: a straight ramp from silence over the first
 * `fadeIn` seconds of the sound's place on the timeline and back to silence over its last
 * `fadeOut` seconds; when the two overlap (a short sound, long fades) they multiply. The music
 * applies it to its span, a voice-over to its span, a clip to its trimmed place on the timeline.
 *
 * Ducking is sidechain-style: wherever a clip marked "has speech" is heard, or a voice-over plays,
 * the music goes down to `duck.level` of its volume, starting `DUCK_ATTACK` seconds before the
 * words and coming back over `DUCK_RELEASE` seconds after them. The music's gain over the whole
 * cut is one curve sampled at `CURVE_RATE` per second (`musicGainCurve`); the render's offline mix
 * and the preview's player both hand that same curve to Web Audio (`setValueCurveAtTime`), so what
 * is heard while editing is what is written.
 */
import { clipVolume, dipHalf, musicSpan, placeClips, totalLength, type Clip, type Placed, type VideoProject, type VoiceClip } from "./video-project";

/** The music starts going down this long before the speech, and comes back over this long after it. */
export const DUCK_ATTACK = 0.2;
export const DUCK_RELEASE = 0.4;
/** Samples per second of the music's gain curve (linear between samples). */
export const CURVE_RATE = 100;

export type Span = readonly [number, number];

/**
 * The fade factor at timeline time t of a sound placed from `start` to `end` (0 … 1): 0 outside
 * its place, rising from 0 to 1 over the first `fadeIn` seconds and falling back to 0 over the
 * last `fadeOut` seconds; 1 in between. A fade of 0 (or less) is no fade. Overlapping fades
 * multiply, so neither end ever jumps.
 */
export function fadeGain(t: number, start: number, end: number, fadeIn = 0, fadeOut = 0): number {
  if (!(end > start) || t < start || t > end) return 0;
  let g = 1;
  if (fadeIn > 0 && t < start + fadeIn) g *= Math.max(0, (t - start) / fadeIn);
  if (fadeOut > 0 && t > end - fadeOut) g *= Math.max(0, (end - t) / fadeOut);
  return Math.max(0, Math.min(1, g));
}

/**
 * Seconds between the breakpoints a fade is handed to Web Audio with, inside a fade. A lone fade is
 * a straight line and needs only its ends; a fade that meets another ramp (the other fade, a
 * crossfade, a dip) is a product of two lines, which these samples follow to well under 1 %.
 */
export const FADE_STEP = 0.02;

/** Times every `FADE_STEP` seconds from `a` to `b` (both included); none when the stretch is empty. */
function samples(a: number, b: number): number[] {
  if (!(b > a)) return [];
  const n = Math.max(1, Math.ceil((b - a) / FADE_STEP - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => (i === n ? b : a + (i * (b - a)) / n));
}

/** The breakpoint times of a fade over a sound placed from `start` to `end`: its ends, and samples inside each fade. */
export function fadeTimes(start: number, end: number, fadeIn = 0, fadeOut = 0): number[] {
  const times = [start, end];
  if (fadeIn > 0) times.push(...samples(start, Math.min(end, start + fadeIn)));
  if (fadeOut > 0) times.push(...samples(Math.max(start, end - fadeOut), end));
  return times;
}

/** `[time, gain]` points in time order with each time once. */
function pointsAt(times: readonly number[], gainAt: (t: number) => number): [number, number][] {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  return sorted.map((t) => [t, gainAt(t)]);
}

/**
 * Breakpoints (`[timeline seconds, gain]`, in order) from timeline time `from` on, for a player
 * that starts mid-cut: the value at `from` is read off the straight line between the breakpoints
 * around it, exactly what Web Audio's linear ramps would be at that moment in the render.
 */
export function pointsFrom(points: readonly (readonly [number, number])[], from: number): [number, number][] {
  if (!points.length) return [];
  if (from <= points[0][0]) return points.map(([t, g]) => [t, g]);
  const last = points[points.length - 1];
  if (from >= last[0]) return [[from, last[1]]];
  const k = points.findIndex(([t]) => t > from);
  const [t0, g0] = points[k - 1];
  const [t1, g1] = points[k];
  const at = t1 > t0 ? g0 + ((g1 - g0) * (from - t0)) / (t1 - t0) : g1;
  return [[from, at], ...points.slice(k).map(([t, g]) => [t, g] as [number, number])];
}

/** Spans joined where they touch or overlap, sorted. */
export function mergeSpans(spans: readonly Span[]): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** Where someone speaks on the timeline: clips marked "has speech" that are heard, and every voice-over that is heard. */
export function speechSpans(project: Pick<VideoProject, "clips" | "voices">): [number, number][] {
  const spans: Span[] = [];
  for (const pl of placeClips(project.clips)) if (pl.clip.speech && clipVolume(pl.clip) > 0) spans.push([pl.start, pl.end]);
  for (const v of project.voices ?? []) if (v.volume > 0) spans.push([v.start, v.start + (v.out - v.in)]);
  return mergeSpans(spans);
}

/** The ducking factor at t (1 = full music, `level` = under speech), ramping in before each span and out after it. */
export function duckFactor(spans: readonly Span[], level: number, t: number, attack = DUCK_ATTACK, release = DUCK_RELEASE): number {
  let f = 1;
  for (const [a, b] of spans) {
    let g = 1;
    if (t >= a && t <= b) g = level;
    else if (t < a && t > a - attack) g = 1 - (1 - level) * ((t - (a - attack)) / attack);
    else if (t > b && t < b + release) g = level + (1 - level) * ((t - b) / release);
    if (g < f) f = g;
  }
  return f;
}

/** The music's gain at timeline time t: silent outside its span; volume × fade in × fade out × ducking. */
export function musicGainAt(project: Pick<VideoProject, "clips" | "voices" | "music">, t: number, spans?: readonly Span[]): number {
  const m = project.music;
  if (!m) return 0;
  const length = totalLength(project);
  const { start, end } = musicSpan(m, length);
  if (t < start || t > end || end <= start) return 0;
  let g = m.volume * fadeGain(t, start, end, m.fadeIn, m.fadeOut);
  if (m.duck?.enabled) g *= duckFactor(spans ?? speechSpans(project), m.duck.level, t);
  return Math.max(0, Math.min(1, g));
}

/** The music's gain over the whole cut, `rate` samples per second from 0 to the end (inclusive). */
export function musicGainCurve(project: Pick<VideoProject, "clips" | "voices" | "music">, rate = CURVE_RATE): Float32Array {
  const length = Math.max(0.1, totalLength(project));
  const n = Math.max(2, Math.ceil(length * rate) + 1);
  const spans = speechSpans(project);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = musicGainAt(project, Math.min(length, i / rate), spans);
  return out;
}

/** The part of a gain curve from timeline time `from` on (the preview starting mid-cut), at least two samples. */
export function curveFrom(curve: Float32Array, from: number, rate = CURVE_RATE): Float32Array {
  const i = Math.min(curve.length - 2, Math.max(0, Math.floor(from * rate)));
  return curve.slice(i);
}

/**
 * A clip's own sound level at timeline time t (0 outside it): its volume (0 when muted), fading in
 * under the crossfade that starts it and out under the one that ends it; around a dip it fades out
 * to the cut and in after it, as the picture does; and its own fade in and fade out (`fadeIn`,
 * `fadeOut`) over its first and last seconds on the timeline, on top of those.
 */
export function clipGainAt(clips: readonly Clip[], index: number, t: number, placed: readonly Placed[] = placeClips(clips)): number {
  const pl = placed[index];
  if (!pl || t < pl.start || t > pl.end) return 0;
  let g = clipVolume(pl.clip);
  if (!g) return 0;
  const prev = clips[index - 1];
  const next = placed[index + 1];
  if (pl.overlap > 0 && t < pl.start + pl.overlap) g *= (t - pl.start) / pl.overlap;
  if (next && next.overlap > 0 && t > pl.end - next.overlap) g *= Math.max(0, (pl.end - t) / next.overlap);
  const hIn = dipHalf(prev, pl.clip);
  if (hIn > 0 && t < pl.start + hIn) g *= (t - pl.start) / hIn;
  const hOut = next ? dipHalf(pl.clip, next.clip) : 0;
  if (hOut > 0 && t > pl.end - hOut) g *= Math.max(0, (pl.end - t) / hOut);
  g *= fadeGain(t, pl.start, pl.end, pl.clip.fadeIn ?? 0, pl.clip.fadeOut ?? 0);
  return Math.max(0, Math.min(1, g));
}

/**
 * The same level as breakpoints for Web Audio's linear ramps (`[time, gain]`, timeline seconds,
 * in order): the offline mix schedules exactly these. Inside the clip's own fades the level is
 * sampled every `FADE_STEP` seconds, since a fade can meet a crossfade or a dip there.
 */
export function clipGainPoints(clips: readonly Clip[], index: number, placed: readonly Placed[] = placeClips(clips)): [number, number][] {
  const pl = placed[index];
  if (!pl) return [];
  const prev = clips[index - 1];
  const next = placed[index + 1];
  const times = new Set<number>([pl.start, pl.end]);
  if (pl.overlap > 0) times.add(pl.start + pl.overlap);
  if (next && next.overlap > 0) times.add(pl.end - next.overlap);
  const hIn = dipHalf(prev, pl.clip);
  if (hIn > 0) times.add(pl.start + hIn);
  const hOut = next ? dipHalf(pl.clip, next.clip) : 0;
  if (hOut > 0) times.add(pl.end - hOut);
  for (const t of fadeTimes(pl.start, pl.end, pl.clip.fadeIn ?? 0, pl.clip.fadeOut ?? 0)) times.add(t);
  return pointsAt([...times], (t) => clipGainAt(clips, index, t, placed));
}

/** Where a voice-over sits on the timeline: from its start for the length of its trimmed part. */
export const voiceSpan = (v: Pick<VoiceClip, "start" | "in" | "out">): { start: number; end: number } => ({ start: v.start, end: v.start + Math.max(0, v.out - v.in) });

/** A voice-over's level at timeline time t: its volume × its fade in and fade out over its place (0 outside it). */
export function voiceGainAt(v: Pick<VoiceClip, "start" | "in" | "out" | "volume" | "fadeIn" | "fadeOut">, t: number): number {
  const { start, end } = voiceSpan(v);
  return Math.max(0, Math.min(1, v.volume * fadeGain(t, start, end, v.fadeIn ?? 0, v.fadeOut ?? 0)));
}

/**
 * A voice-over's level as breakpoints for Web Audio's linear ramps (`[time, gain]`, timeline
 * seconds, in order): the render schedules these from 0, the preview the part from the playhead on
 * (`pointsFrom`), so both play the same fades.
 */
export function voiceGainPoints(v: Pick<VoiceClip, "start" | "in" | "out" | "volume" | "fadeIn" | "fadeOut">): [number, number][] {
  const { start, end } = voiceSpan(v);
  if (!(end > start)) return [];
  // The span's ends are silent only when a fade reaches them; otherwise the recording starts and stops at its volume.
  return pointsAt(fadeTimes(start, end, v.fadeIn ?? 0, v.fadeOut ?? 0), (t) => voiceGainAt(v, t));
}
