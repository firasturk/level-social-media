/**
 * The analysis of a reference video as the project stores it ("Edit like this video",
 * shared/reference-template.ts) and its validation. No imports, so shared/video-project.ts can
 * check it without a cycle.
 */
export type ReferenceKind = "pinterest" | "drive" | "upload";
export type CameraMove = "still" | "pan" | "push" | "pull" | "handheld";

export interface ReferenceShot {
  /** Seconds in the reference. */
  start: number;
  end: number;
  /** What moves beyond the camera, 0 … 1 relative to the reference's busiest shot. */
  action: number;
  camera: CameraMove;
  /** Mean brightness, 0 … 1. */
  luma: number;
  /** A text guess: where its band sits (0 top … 1 bottom), or null. */
  textY: number | null;
}

export interface ReferenceAnalysis {
  /** Where it came from: the pin (id, its link), the Drive file (id), the uploaded file (its name); `copy` is the studio's 7-day copy (server/video-reference.ts) to play it again. */
  source: { kind: ReferenceKind; id: string; name: string; url?: string; copy?: string };
  duration: number;
  width: number;
  height: number;
  /** Frames analysed per second (the video's own rate when every frame was read). */
  fps: number;
  shots: ReferenceShot[];
  /** Cuts per second in 2-second windows. */
  pace: number[];
  /** Lab mean and spread over the analysed frames. */
  colour: { mean: [number, number, number]; std: [number, number, number] } | null;
  /** The music: its pulse in the reference's seconds, the bars, the tempo; null when no steady beat was heard (or there is no sound). */
  music: { bpm: number; pulse: number[]; bars: number[] } | null;
  /** Whether on-screen text was looked for and found. */
  text: "found" | "none";
  analysedAt: number;
}

export const MAX_REFERENCE_SHOTS = 200;
export const MAX_REFERENCE_SECONDS = 180;

/* ───────────── Stored with the project ───────────── */

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const CAMERAS: readonly CameraMove[] = ["still", "pan", "push", "pull", "handheld"];

/** The stored analysis checked field by field (shared/video-project.ts validateProject); the reason says what is wrong. */
export function checkReference(x: unknown): ReferenceAnalysis | string {
  if (!isObj(x)) return "reference must be an object.";
  const s = x.source;
  if (!isObj(s) || !(s.kind === "pinterest" || s.kind === "drive" || s.kind === "upload") || typeof s.id !== "string" || s.id.length > 300 || typeof s.name !== "string" || s.name.length > 200) return "reference.source needs a kind (pinterest, drive or upload), an id and a name.";
  if (s.url !== undefined && (typeof s.url !== "string" || s.url.length > 2000)) return "reference.source.url is too long.";
  if (s.copy !== undefined && (typeof s.copy !== "string" || !/^[0-9a-f-]{36}$/i.test(s.copy))) return "reference.source.copy must be a copy id.";
  if (!num(x.duration, 0, MAX_REFERENCE_SECONDS) || !num(x.width, 0, 8192) || !num(x.height, 0, 8192) || !num(x.fps, 0, 240)) return "reference needs its length (up to 3 minutes), size and frame rate.";
  if (!Array.isArray(x.shots) || x.shots.length > MAX_REFERENCE_SHOTS) return `reference.shots must be a list of at most ${MAX_REFERENCE_SHOTS}.`;
  const shots: ReferenceShot[] = [];
  for (const sh of x.shots as unknown[]) {
    if (!isObj(sh) || !num(sh.start, 0, MAX_REFERENCE_SECONDS) || !num(sh.end, 0, MAX_REFERENCE_SECONDS) || sh.end <= sh.start || !num(sh.action, 0, 1) || !num(sh.luma, 0, 1) || !CAMERAS.includes(sh.camera as CameraMove) || !(sh.textY === null || num(sh.textY, 0, 1)))
      return "reference.shots: each shot needs a start before its end, action and brightness (0–1), a camera move and a text height or null.";
    shots.push({ start: sh.start, end: sh.end, action: sh.action, camera: sh.camera as CameraMove, luma: sh.luma, textY: sh.textY as number | null });
  }
  if (!Array.isArray(x.pace) || x.pace.length > 200 || !x.pace.every((p) => num(p, 0, 120))) return "reference.pace must be a list of cuts per second.";
  let colour: ReferenceAnalysis["colour"] = null;
  if (x.colour !== null && x.colour !== undefined) {
    const c = x.colour;
    if (!isObj(c) || !Array.isArray(c.mean) || !Array.isArray(c.std) || c.mean.length !== 3 || c.std.length !== 3 || ![...c.mean, ...c.std].every((v) => num(v, -200, 200))) return "reference.colour needs a Lab mean and spread.";
    colour = { mean: c.mean as [number, number, number], std: c.std as [number, number, number] };
  }
  let music: ReferenceAnalysis["music"] = null;
  if (x.music !== null && x.music !== undefined) {
    const m = x.music;
    const list = (v: unknown) => Array.isArray(v) && v.length <= 2000 && v.every((b) => num(b, 0, MAX_REFERENCE_SECONDS));
    if (!isObj(m) || !num(m.bpm, 20, 400) || !list(m.pulse) || !list(m.bars)) return "reference.music needs a tempo, a pulse and bars.";
    music = { bpm: m.bpm, pulse: m.pulse as number[], bars: m.bars as number[] };
  }
  if (x.text !== "found" && x.text !== "none") return "reference.text must be found or none.";
  if (!num(x.analysedAt, 0, 1e14)) return "reference.analysedAt must be a timestamp.";
  return { source: { kind: s.kind, id: s.id, name: s.name, ...(typeof s.url === "string" ? { url: s.url } : {}), ...(typeof s.copy === "string" ? { copy: s.copy } : {}) }, duration: x.duration, width: x.width, height: x.height, fps: x.fps, shots, pace: x.pace as number[], colour, music, text: x.text, analysedAt: x.analysedAt };
}
