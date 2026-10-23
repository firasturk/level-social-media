/**
 * "Edit like this video" (docs/video-editor.md → Edit quality): a reference video (a Pinterest pin's
 * video, a clip from the client's Drive, or a file from this computer) is read in the browser, never
 * rendered into the output, and its structure becomes a template for the person's own footage:
 *  - its shots (cuts by an adaptive threshold on frame histograms, dissolves by twin comparison),
 *    each one's length, what moves in it and how the camera moves (still, pan, push in, pull out,
 *    handheld), its brightness, and a rough guess at on-screen text and where it sits;
 *  - the pace over time (cuts per second in 2-second windows);
 *  - its colour (Lab mean and spread, pooled over frames), for an optional "match its colour";
 *  - its music's pulse and bars when it has a steady beat.
 * `templateFromReference` turns that into a VideoTemplate (same shape as the gallery's), the
 * planner (`fillSlots`, shared/edit-plan.ts) maps the person's best shots onto its slots by action,
 * and `compareTimings` lines the two up shot by shot. Only the analysis is stored with the project
 * (`project.reference`), never the reference's pictures; the file is fetched or picked again to
 * play it side by side.
 */
import type { Boundary, FrameFeatures, MotionSample } from "./shot-analysis";
import { detectBoundaries, motionSeries } from "./shot-analysis";
import type { MusicGrid } from "./music-bars";
import type { TemplateSlot, TemplateText, VideoTemplate } from "./video-templates";
import { cutTimes, totalLength, type Clip } from "./video-project";
import { MAX_REFERENCE_SHOTS, type CameraMove, type ReferenceAnalysis, type ReferenceShot } from "./reference-check";

export * from "./reference-check";

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function cameraOf(ms: readonly MotionSample[]): CameraMove {
  if (ms.length < 2) return "still";
  const dt = Math.max(1e-3, (ms[ms.length - 1].t - ms[0].t) / Math.max(1, ms.length - 1));
  let zoom = 1;
  let sx = 0;
  let sy = 0;
  let jitter = 0;
  for (let i = 0; i < ms.length; i++) {
    zoom *= ms[i].zoom;
    sx += ms[i].dx;
    sy += ms[i].dy;
    if (i > 0 && i < ms.length - 1) jitter += Math.hypot(ms[i].dx - (ms[i - 1].dx + ms[i + 1].dx) / 2, ms[i].dy - (ms[i - 1].dy + ms[i + 1].dy) / 2);
  }
  const seconds = dt * ms.length;
  const drift = Math.hypot(sx, sy) / seconds;
  jitter /= Math.max(1, ms.length - 2);
  const zoomRate = Math.log(zoom) / seconds;
  if (zoomRate > 0.04) return "push";
  if (zoomRate < -0.04) return "pull";
  if (jitter > 0.008) return "handheld";
  if (drift > 0.04) return "pan";
  return "still";
}

/**
 * The reference's structure from its frames (in time order, ideally every frame), its length and
 * size, and optionally its music's grid and its pooled colour.
 */
export function analyseReference(
  frames: readonly FrameFeatures[],
  meta: { duration: number; width: number; height: number; fps: number; source: ReferenceAnalysis["source"] },
  extra: { grid?: MusicGrid | null; colour?: ReferenceAnalysis["colour"]; now?: number } = {},
): ReferenceAnalysis {
  const boundaries: Boundary[] = detectBoundaries(frames, { fades: true });
  // A dissolve counts as a cut at its middle for timing: that is where a viewer feels the change.
  const cuts = boundaries.map((b) => b.t).filter((t) => t > 0.05 && t < meta.duration - 0.05);
  const edges = [0, ...cuts, meta.duration];
  const motion = motionSeries(frames);
  const raw = edges.slice(1).map((end, i) => {
    const start = edges[i];
    // Frames right at the cut compare across it: they are left out of the shot's own movement.
    const ms = motion.filter((m) => m.t > start + 1e-6 && m.t < end - 1e-6);
    const fs = frames.filter((f) => f.t >= start - 1e-6 && f.t < end - 1e-6);
    const action = ms.length ? ms.reduce((s, m) => s + m.action, 0) / ms.length : 0;
    const luma = fs.length ? fs.reduce((s, f) => s + f.luma, 0) / fs.length : 0;
    const texts = fs.map((f) => f.textY).filter((y): y is number => y !== null);
    const textY = texts.length >= Math.max(2, fs.length * 0.6) ? texts.sort((a, b) => a - b)[Math.floor(texts.length / 2)] : null;
    return { start, end, action, camera: cameraOf(ms), luma, textY };
  });
  const top = Math.max(1e-6, ...raw.map((r) => r.action));
  const shots: ReferenceShot[] = raw.slice(0, MAX_REFERENCE_SHOTS).map((r) => ({ start: round3(r.start), end: round3(r.end), action: round3(r.action / top), camera: r.camera, luma: round3(r.luma), textY: r.textY === null ? null : round3(r.textY) }));
  const pace: number[] = [];
  for (let t = 0; t < meta.duration - 1e-6; t += 2) pace.push(round3(cuts.filter((c) => c >= t && c < t + 2).length / Math.min(2, meta.duration - t)));
  const g = extra.grid;
  const music = g && g.pulse.length >= 4 && g.bpm > 0 ? { bpm: g.bpm, pulse: g.pulse.map(round3), bars: g.bars.map(round3) } : null;
  return {
    source: meta.source,
    duration: round3(meta.duration),
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    shots,
    pace,
    colour: extra.colour ?? null,
    music,
    text: shots.some((s) => s.textY !== null) ? "found" : "none",
    analysedAt: extra.now ?? Date.now(),
  };
}

const CAMERA_LABEL: Record<CameraMove, string> = { still: "still", pan: "a pan", push: "a push in", pull: "a pull out", handheld: "handheld" };
export const cameraLabel = (c: CameraMove): string => CAMERA_LABEL[c];

/**
 * The reference as a template: one slot per shot (its length exactly; a push or pull becomes a slow
 * zoom over the slot; cuts throughout, as in the reference), a placeholder text layer over each shot
 * where text was seen (at its height), the logo's place on the last shot. No look of its own (the
 * project's colour stays; "match its colour" is a separate choice). Shots past the editor's 24 clips
 * or 60 seconds are left out (said in `notes`).
 */
export function templateFromReference(a: ReferenceAnalysis, opts: { maxClips?: number; maxSeconds?: number } = {}): { template: VideoTemplate; notes: string[] } {
  const maxClips = opts.maxClips ?? 24;
  const maxSeconds = opts.maxSeconds ?? 60;
  const notes: string[] = [];
  const slots: TemplateSlot[] = [];
  let total = 0;
  for (const s of a.shots) {
    const d = round3(s.end - s.start);
    if (slots.length >= maxClips || total + d > maxSeconds + 1e-6) break;
    total += d;
    const zoom = s.camera === "pull" ? 1.12 : 1;
    slots.push({
      label: `Shot ${slots.length + 1}`,
      hint: `${d.toFixed(2)} s, ${cameraLabel(s.camera)}, ${s.action > 0.66 ? "lots of movement" : s.action > 0.33 ? "some movement" : "calm"}.`,
      duration: d,
      framing: { fit: "fill", zoom, x: 0, y: 0 },
      transition: "cut",
      ...(s.camera === "push" ? { push: 1.12 } : s.camera === "pull" ? { push: 1 } : {}),
      action: s.action,
    });
  }
  if (slots.length < a.shots.length) notes.push(`The reference has ${a.shots.length} shots; the editor holds ${maxClips} clips and ${maxSeconds} s, so the first ${slots.length} are used.`);
  const texts: TemplateText[] = [];
  slots.forEach((_, i) => {
    const y = a.shots[i].textY;
    if (y === null) return;
    // Consecutive shots with text at the same height share one layer.
    const prev = texts[texts.length - 1];
    if (prev && prev.to === i - 1 && Math.abs(prev.y - y) < 0.08) {
      prev.to = i;
      return;
    }
    texts.push({ role: "caption", en: "Your words here", ar: "كلماتك هنا", from: i, to: i, x: 0.5, y: Math.min(0.85, Math.max(0.1, y)), size: 0.05, font: "sans", weight: 800, color: "#ffffff", box: "#000000" });
  });
  const last = Math.max(0, slots.length - 1);
  const template: VideoTemplate = {
    id: "reference",
    name: `Like ${a.source.name}`.slice(0, 60),
    description: `${slots.length} shots read from the reference, ${total.toFixed(1)} s.`,
    pace: averageShot(a) < 1 ? "fast" : averageShot(a) < 2.2 ? "steady" : "calm",
    music: { moods: [], bpm: a.music ? [Math.round(a.music.bpm) - 5, Math.round(a.music.bpm) + 5] : null, note: a.music ? `The reference's music runs at about ${Math.round(a.music.bpm)} BPM.` : "No steady beat was heard in the reference." },
    look: { id: "none", amount: 1 },
    protectSkin: false,
    background: "#000000",
    slots,
    texts,
    logo: { x: 0.5, y: 0.12, width: 0.26, from: last, to: last },
  };
  return { template, notes };
}

export const averageShot = (a: Pick<ReferenceAnalysis, "shots">): number => (a.shots.length ? a.shots.reduce((s, x) => s + x.end - x.start, 0) / a.shots.length : 0);

export interface TimingRow {
  index: number;
  ref: { start: number; length: number } | null;
  ours: { start: number; length: number; label: string } | null;
  /** Our cut minus the reference's, in frames at 30 fps (start of the shot); null when one side has no shot. */
  deltaFrames: number | null;
}

/** The two cuts side by side, shot by shot: where each shot starts and how long it lasts, and the difference in frames. */
export function compareTimings(a: Pick<ReferenceAnalysis, "shots">, clips: readonly Clip[], labelOf: (c: Clip) => string = (c) => (c.source.kind === "upload" ? c.source.name : c.source.kind), fps = 30): TimingRow[] {
  // A shot starts at its cut (the middle of a crossfade) and lasts to the next cut.
  const starts = clips.length ? [0, ...cutTimes(clips)] : [];
  const total = totalLength({ clips: [...clips] });
  const n = Math.max(a.shots.length, starts.length);
  const rows: TimingRow[] = [];
  for (let i = 0; i < n; i++) {
    const r = a.shots[i];
    const ref = r ? { start: r.start, length: round3(r.end - r.start) } : null;
    const ours = i < starts.length ? { start: round3(starts[i]), length: round3((starts[i + 1] ?? total) - starts[i]), label: labelOf(clips[i]) } : null;
    rows.push({ index: i + 1, ref, ours, deltaFrames: ref && ours ? Math.round((ours.start - ref.start) * fps) : null });
  }
  return rows;
}

