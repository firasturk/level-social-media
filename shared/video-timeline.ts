/**
 * The timeline's editing maths (phase 2), pure and shared by the editor and the tests: timecodes
 * (mm:ss:ff at 30 fps), frame stepping, zoom (pixels per second, fit, zoom around a point),
 * snapping (to the playhead, cuts, beats, text, logo, music and voice edges), selection with
 * shift / cmd clicks, reordering several clips at once, splitting at the playhead, deleting with
 * or without closing the gap (ripple), and aligning cuts to the music's beats without moving
 * locked clips or cutting inside speech.
 */
import { clipLength, gapClip, isGap, MIN_CLIP_SECONDS, musicSpan, nearestBeat, placeClips, splitClip, totalLength, type Clip, type VideoProject } from "./video-project";
import { keyTimes } from "./video-keyframes";

export const TIMELINE_FPS = 30;

/* ───────────── Timecode ───────────── */

/** "mm:ss:ff" at `fps` (frames 00 … fps-1), from seconds rounded to the nearest frame. */
export function formatTimecode(t: number, fps = TIMELINE_FPS): string {
  const frames = Math.max(0, Math.round((Number.isFinite(t) ? t : 0) * fps));
  const ff = frames % fps;
  const totalSec = Math.floor(frames / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(mm)}:${p(ss)}:${p(ff)}`;
}

/**
 * Seconds from what a person types: "mm:ss:ff", "mm:ss", "ss" or "12.5" (seconds), "12.5s".
 * Null when it is not a time (frames past the last of a second, seconds past 59 with minutes).
 */
export function parseTimecode(s: string, fps = TIMELINE_FPS): number | null {
  const v = s.trim().replace(/s$/i, "");
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const parts = v.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  const [mm, ss, ff] = nums.length === 3 ? nums : [nums[0], nums[1], 0];
  if (ss > 59 || ff >= fps) return null;
  return Math.round((mm * 60 + ss + ff / fps) * 1e6) / 1e6;
}

/** The time n frames from t, on the frame grid. */
export function stepFrames(t: number, n: number, length: number, fps = TIMELINE_FPS): number {
  const f = Math.round(t * fps) + n;
  return Math.min(Math.max(0, f / fps), Math.max(0, length));
}

/* ───────────── Zoom ───────────── */

/** Pixels per second: from a whole minute on a phone to a few pixels per frame. */
export const MIN_PPS = 4;
export const MAX_PPS = 480;
export const ZOOM_STEP = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Seconds rounded to a microsecond, so repeated edits do not pile up float noise (0.2999999…). */
const r6 = (t: number) => Math.round(t * 1e6) / 1e6;

/** The zoom that shows the whole cut (plus a little room) in `width` pixels. */
export function fitPps(width: number, length: number): number {
  const span = Math.max(5, length * 1.05);
  return clamp(Math.max(1, width) / span, MIN_PPS, MAX_PPS);
}

/**
 * Zoom by `factor` keeping the time under `anchorX` (pixels from the lane's left edge, as seen) in
 * place: returns the new pixels per second and the new scroll offset.
 */
export function zoomAround(view: { pps: number; scroll: number }, factor: number, anchorX: number): { pps: number; scroll: number } {
  const pps = clamp(view.pps * factor, MIN_PPS, MAX_PPS);
  const t = (view.scroll + anchorX) / view.pps;
  return { pps, scroll: Math.max(0, t * pps - anchorX) };
}

/** Ruler ticks: a spacing in seconds that leaves room for the labels at this zoom. */
export function tickSpacing(pps: number): number {
  for (const s of [1 / TIMELINE_FPS, 5 / TIMELINE_FPS, 0.5, 1, 2, 5, 10, 15, 30, 60]) if (s * pps >= 56) return s;
  return 60;
}

/* ───────────── Snapping ───────────── */

export type SnapKind = "playhead" | "cut" | "beat" | "text" | "logo" | "music" | "voice" | "key";
export interface SnapTarget {
  t: number;
  kind: SnapKind;
}

/** Snap distance on screen: a few pixels, whatever the zoom. */
export const SNAP_PX = 8;

/**
 * Everything an edge may snap to: the playhead, the start and end of every clip (cuts), the beats,
 * the edges of the text and logo layers, the music and the voice-over; `exclude` leaves out the
 * thing being dragged (so it does not snap to itself).
 */
export function snapTargets(project: Pick<VideoProject, "clips" | "overlays" | "music" | "voices">, opts: { playhead?: number; beats?: readonly number[]; exclude?: ReadonlySet<string> } = {}): SnapTarget[] {
  const ex = opts.exclude ?? new Set<string>();
  const out: SnapTarget[] = [];
  if (opts.playhead !== undefined) out.push({ t: opts.playhead, kind: "playhead" });
  const placed = placeClips(project.clips);
  for (const pl of placed) {
    if (ex.has(pl.clip.id)) continue;
    out.push({ t: pl.start, kind: "cut" }, { t: pl.end, kind: "cut" });
  }
  for (const b of opts.beats ?? []) out.push({ t: b, kind: "beat" });
  for (const o of project.overlays ?? []) {
    if (ex.has(o.id)) continue;
    out.push({ t: o.start, kind: o.kind }, { t: o.end, kind: o.kind });
  }
  const length = totalLength(project);
  if (project.music && !ex.has("music")) {
    const s = musicSpan(project.music, length);
    out.push({ t: s.start, kind: "music" }, { t: s.end, kind: "music" });
  }
  for (const v of project.voices ?? []) {
    if (ex.has(v.id)) continue;
    out.push({ t: v.start, kind: "voice" }, { t: v.start + (v.out - v.in), kind: "voice" });
  }
  return out;
}

/** t moved to the nearest target within `tolerance` seconds; `target` says which (null when nothing was near). */
export function snapTime(t: number, targets: readonly SnapTarget[], tolerance: number): { t: number; target: SnapTarget | null } {
  let best: SnapTarget | null = null;
  let d = tolerance;
  for (const x of targets) {
    const dd = Math.abs(x.t - t);
    if (dd <= d) {
      d = dd;
      best = x;
    }
  }
  return best ? { t: best.t, target: best } : { t, target: null };
}

/** A block of fixed length moved to `start`: whichever of its two edges is closer to a target snaps; returns the new start. */
export function snapSpan(start: number, length: number, targets: readonly SnapTarget[], tolerance: number): { start: number; target: SnapTarget | null } {
  const a = snapTime(start, targets, tolerance);
  const b = snapTime(start + length, targets, tolerance);
  const da = a.target ? Math.abs(a.t - start) : Infinity;
  const db = b.target ? Math.abs(b.t - (start + length)) : Infinity;
  if (da === Infinity && db === Infinity) return { start, target: null };
  return da <= db ? { start: a.t, target: a.target } : { start: b.t - length, target: b.target };
}

/* ───────────── Selection ───────────── */

/**
 * The selection after a click on `id`: a plain click selects it alone; cmd/ctrl toggles it in or
 * out; shift selects the range from the last selected to it, in timeline order.
 */
export function clickSelect(selection: readonly string[], id: string, mods: { shift?: boolean; toggle?: boolean }, order: readonly string[]): string[] {
  if (mods.toggle) return selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
  if (mods.shift && selection.length) {
    const anchor = selection[selection.length - 1];
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return [id];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = order.slice(lo, hi + 1);
    return [...selection.filter((x) => !range.includes(x)), ...range];
  }
  return [id];
}

/* ───────────── Reorder, split, delete ───────────── */

/**
 * The selected clips moved together, in their timeline order, to land before the clip that is
 * now at `toIndex` (an index in the current list; `clips.length` puts them at the end).
 */
export function moveClips(clips: readonly Clip[], ids: readonly string[], toIndex: number): Clip[] {
  const set = new Set(ids);
  const moving = clips.filter((c) => set.has(c.id));
  if (!moving.length) return [...clips];
  const before = clips.slice(0, Math.max(0, Math.min(clips.length, toIndex))).filter((c) => !set.has(c.id)).length;
  const rest = clips.filter((c) => !set.has(c.id));
  const out = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
  // The first clip never joins a previous one.
  return out.map((c, i) => (i === 0 && c.transition !== "cut" ? { ...c, transition: "cut" as const } : c));
}

/** Where a dragged clip lands when dropped at timeline time t: before the first clip whose middle is after t. */
export function dropIndexAt(clips: readonly Clip[], t: number): number {
  const placed = placeClips(clips);
  const i = placed.findIndex((pl) => t < (pl.start + pl.end) / 2);
  return i < 0 ? clips.length : i;
}

/**
 * Splits at timeline time t: the selected clips under t (or, with no selection, the clip under t)
 * in two. Returns the new clips and the ids of the right-hand parts, or null when nothing could be
 * split (the playhead is outside, or too close to an edge).
 */
export function splitAt(clips: readonly Clip[], t: number, ids: readonly string[] = []): { clips: Clip[]; right: string[] } | null {
  const placed = placeClips(clips);
  const under = placed.filter((pl) => t > pl.start && t < pl.end && (!ids.length || ids.includes(pl.clip.id)));
  // During a crossfade two clips are under t: the one that is starting is split (it is the one seen).
  const target = under.length ? under[under.length - 1] : null;
  if (!target) return null;
  const parts = splitClip(target.clip, t - target.start);
  if (!parts) return null;
  return { clips: clips.flatMap((c) => (c.id === target.clip.id ? parts : [c])), right: [parts[1].id] };
}

/** Adjacent gaps joined into one, and gaps at the very end dropped (an empty tail is not a gap). */
export function tidyGaps(clips: readonly Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const prev = out[out.length - 1];
    if (prev && isGap(prev) && isGap(c)) {
      const len = clipLength(prev) + clipLength(c);
      out[out.length - 1] = { ...gapClip(len, prev.id), transition: prev.transition };
    } else out.push(c);
  }
  while (out.length && isGap(out[out.length - 1])) out.pop();
  return out.map((c, i) => (i === 0 && c.transition !== "cut" ? { ...c, transition: "cut" as const } : c));
}

/**
 * The selected clips deleted. With `ripple` the gap closes: everything after moves left, and the
 * text, logo and voice-over that start after a removed clip move left with the footage (by the
 * length the timeline lost up to there). Without, each clip is replaced by a gap of its length, so
 * nothing else moves.
 */
export function deleteClips(project: VideoProject, ids: readonly string[], ripple: boolean): VideoProject {
  const set = new Set(ids);
  if (!project.clips.some((c) => set.has(c.id))) return project;
  if (!ripple) {
    const placed = placeClips(project.clips);
    const clips = tidyGaps(placed.map((pl) => (set.has(pl.clip.id) ? { ...gapClip(pl.end - pl.start - pl.overlap, pl.clip.id), transition: "cut" as const } : pl.clip)));
    return { ...project, clips };
  }
  const before = placeClips(project.clips);
  const clips = tidyGaps(project.clips.filter((c) => !set.has(c.id)));
  const after = placeClips(clips);
  // How far a time t moves left: the timeline lost before t, measured on the clips kept (their start moved by this much).
  const shiftAt = (t: number): number => {
    let shift = 0;
    for (const pl of before) {
      if (set.has(pl.clip.id) || pl.start > t + 1e-9) continue;
      const now = after.find((a) => a.clip.id === pl.clip.id);
      if (now) shift = pl.start - now.start;
    }
    // After the last kept clip, the whole loss applies.
    const lastKept = [...before].reverse().find((pl) => !set.has(pl.clip.id));
    if (!lastKept || t >= lastKept.end - 1e-9) shift = totalLength(project) - totalLength({ clips });
    return Math.max(0, shift);
  };
  const removedSpans = before.filter((pl) => set.has(pl.clip.id)).map((pl) => [pl.start, pl.end] as const);
  const inRemoved = (t: number) => removedSpans.some(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);
  const overlays = project.overlays.map((o) => {
    if (inRemoved(o.start)) return o;
    const s = shiftAt(o.start);
    return s > 0 ? { ...o, start: r6(Math.max(0, o.start - s)), end: r6(Math.max(0.1, o.end - s)) } : o;
  });
  const voices = (project.voices ?? []).map((v) => {
    if (inRemoved(v.start)) return v;
    const s = shiftAt(v.start);
    return s > 0 ? { ...v, start: r6(Math.max(0, v.start - s)) } : v;
  });
  return { ...project, clips, overlays, voices };
}

/* ───────────── Beats ───────────── */

/**
 * "Align cuts to beats": each cut within `tolerance` of a beat moves onto it by a roll edit (the
 * clip before ends later or earlier and the clip after starts at the matching source second), so
 * the total length and every other cut stay where they are. When the clips have no footage to give
 * (whole clips, the usual case: the clip after already starts at its first frame), the clip before
 * is trimmed back to the beat before the cut instead, up to `rippleLimit` seconds, and what follows
 * closes up (the cut is on the beat; the video is that much shorter). A cut stays where it is when
 * either clip is locked, carries speech (it would be cut inside), is a gap, or a locked clip
 * follows (a ripple would move it). Returns the clips and the number of cuts moved.
 */
export function alignCutsToBeats(clips: readonly Clip[], beats: readonly number[], tolerance = 0.25, rippleLimit = 0.5): { clips: Clip[]; moved: number; kept: number } {
  const out = clips.map((c) => ({ ...c }));
  let moved = 0;
  let kept = 0;
  if (!beats.length || out.length < 2) return { clips: out, moved, kept };
  for (let i = 0; i < out.length - 1; i++) {
    const placed = placeClips(out);
    const next = placed[i + 1];
    const cut = next.start + next.overlap / 2;
    const target = nearestBeat(cut, beats, tolerance);
    if (Math.abs(target - cut) < 1e-6) continue;
    const a = out[i];
    const b = out[i + 1];
    if (a.locked || b.locked || a.speech || b.speech || isGap(a) || isGap(b)) {
      kept++;
      continue;
    }
    const delta = target - cut;
    const aOut = a.out + delta * a.speed;
    const bIn = b.in + delta * b.speed;
    const ok = aOut > a.in + MIN_CLIP_SECONDS * a.speed && aOut <= a.duration + 1e-9 && bIn >= -1e-9 && bIn < b.out - MIN_CLIP_SECONDS * b.speed;
    if (!ok) {
      // No footage to roll: trim the clip before back to the previous beat and close up.
      let earlier = -Infinity;
      for (const t of beats) if (t < cut - 1e-6 && t > earlier) earlier = t;
      const trimmed = a.out - (cut - earlier) * a.speed;
      if (cut - earlier <= rippleLimit && trimmed > a.in + MIN_CLIP_SECONDS * a.speed && !out.slice(i + 1).some((x) => x.locked)) {
        out[i] = { ...a, out: trimmed };
        moved++;
      } else kept++;
      continue;
    }
    out[i] = { ...a, out: Math.min(a.duration, aOut) };
    out[i + 1] = { ...b, in: Math.max(0, bIn) };
    moved++;
  }
  return { clips: out, moved, kept };
}

/* ───────────── Lanes ───────────── */

/** The keyframe diamonds of a clip or a layer on its lane, as timeline seconds. */
export function diamondTimes(start: number, kf: Parameters<typeof keyTimes>[0], end: number): number[] {
  return keyTimes(kf)
    .map((t) => start + t)
    .filter((t) => t >= start - 1e-9 && t <= end + 1e-9);
}
