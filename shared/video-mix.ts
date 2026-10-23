/**
 * The sound of a cut, as numbers both the preview and the render use (phase 2): every clip's own
 * sound at its volume (fading under crossfades and dips), the music at its place on the timeline
 * with its volume and fades, ducked under speech, and the voice-over recordings.
 *
 * Ducking is sidechain-style: wherever a clip marked "has speech" is heard, or a voice-over plays,
 * the music goes down to `duck.level` of its volume, starting `DUCK_ATTACK` seconds before the
 * words and coming back over `DUCK_RELEASE` seconds after them. The music's gain over the whole
 * cut is one curve sampled at `CURVE_RATE` per second (`musicGainCurve`); the render's offline mix
 * and the preview's player both hand that same curve to Web Audio (`setValueCurveAtTime`), so what
 * is heard while editing is what is written.
 */
import { clipVolume, dipHalf, musicSpan, placeClips, totalLength, type Clip, type Placed, type VideoProject } from "./video-project";

/** The music starts going down this long before the speech, and comes back over this long after it. */
export const DUCK_ATTACK = 0.2;
export const DUCK_RELEASE = 0.4;
/** Samples per second of the music's gain curve (linear between samples). */
export const CURVE_RATE = 100;

export type Span = readonly [number, number];

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
  let g = m.volume;
  if (m.fadeIn > 0 && t < start + m.fadeIn) g *= Math.max(0, (t - start) / m.fadeIn);
  if (m.fadeOut > 0 && t > end - m.fadeOut) g *= Math.max(0, (end - t) / m.fadeOut);
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
 * to the cut and in after it, as the picture does.
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
  return Math.max(0, Math.min(1, g));
}

/**
 * The same level as breakpoints for Web Audio's linear ramps (`[time, gain]`, timeline seconds,
 * in order): the offline mix schedules exactly these.
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
  return [...times].sort((a, b) => a - b).map((t) => [t, clipGainAt(clips, index, t, placed)]);
}
