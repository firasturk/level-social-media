/**
 * The frame of a generated video: Reel 9:16 (the default), Portrait 4:5, Square 1:1, Landscape
 * 16:9. An engine with a frame option is handed the frame; an engine that follows the picture's
 * frame gets a picture composed to that frame in the browser first (src/video-editor/frame.ts),
 * with the maths from here: cover (crop to fit, centred) or contain (the whole picture, with a
 * blurred, darkened copy filling the edges). Shared by the studio, the server (which stores the
 * frame on the version) and the Prompt Box.
 */

export type FrameId = "9:16" | "4:5" | "1:1" | "16:9";
export type FrameFill = "crop" | "blur";

export interface Frame {
  id: FrameId;
  /** The plain word ("Reel"); `frameLabel` gives "Reel 9:16". */
  name: string;
  w: number;
  h: number;
  hint: string;
}

export const FRAMES: readonly Frame[] = [
  { id: "9:16", name: "Reel", w: 9, h: 16, hint: "Reels, Stories and TikTok: the full phone screen" },
  { id: "4:5", name: "Portrait", w: 4, h: 5, hint: "The feed's tall post" },
  { id: "1:1", name: "Square", w: 1, h: 1, hint: "A square post" },
  { id: "16:9", name: "Landscape", w: 16, h: 9, hint: "YouTube and screens" },
] as const;

export const DEFAULT_FRAME: FrameId = "9:16";
export const DEFAULT_FILL: FrameFill = "crop";

export const FILLS: readonly { id: FrameFill; label: string; hint: string }[] = [
  { id: "crop", label: "Crop to fit", hint: "The picture fills the frame; what falls outside is cut, centred" },
  { id: "blur", label: "Blur the edges", hint: "The whole picture stays, over a blurred, darkened copy of itself" },
] as const;

export function isFrame(s: unknown): s is FrameId {
  return typeof s === "string" && FRAMES.some((f) => f.id === s);
}

export function isFill(s: unknown): s is FrameFill {
  return s === "crop" || s === "blur";
}

export function frameOf(id: FrameId): Frame {
  return FRAMES.find((f) => f.id === id) ?? FRAMES[0];
}

/** "Reel 9:16", for the badges and the versions list; "" for null. */
export function frameLabel(id: string | null | undefined): string {
  if (!isFrame(id)) return "";
  const f = frameOf(id);
  return `${f.name} ${f.id}`;
}

/** The pixel size of a frame with its long side at `longSide` (1080 × 1920 for a Reel at 1920). */
export function frameSize(id: FrameId, longSide = 1920): { w: number; h: number } {
  const f = frameOf(id);
  if (f.w >= f.h) return { w: longSide, h: Math.round((longSide * f.h) / f.w) };
  return { w: Math.round((longSide * f.w) / f.h), h: longSide };
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The picture scaled to cover the canvas, centred: what falls outside is cut (the "crop to fit" fill). */
export function coverPlacement(img: { w: number; h: number }, canvas: { w: number; h: number }): Placement {
  const scale = Math.max(canvas.w / img.w, canvas.h / img.h);
  const w = img.w * scale;
  const h = img.h * scale;
  return { x: (canvas.w - w) / 2, y: (canvas.h - h) / 2, w, h };
}

/** The whole picture inside the canvas, centred, with bands left over on two sides (the "blur the edges" fill draws them). */
export function containPlacement(img: { w: number; h: number }, canvas: { w: number; h: number }): Placement {
  const scale = Math.min(canvas.w / img.w, canvas.h / img.h);
  const w = img.w * scale;
  const h = img.h * scale;
  return { x: (canvas.w - w) / 2, y: (canvas.h - h) / 2, w, h };
}

/** The frame a picture already has, when its sides are within 2% of one of the four; else null. */
export function pictureFrame(w: number, h: number): FrameId | null {
  if (!(w > 0 && h > 0)) return null;
  const r = w / h;
  for (const f of FRAMES) if (Math.abs(r - f.w / f.h) / (f.w / f.h) <= 0.02) return f.id;
  return null;
}

/** False when the picture is already in the frame: nothing to compose, the picture goes as it is. */
export function needsCompose(img: { w: number; h: number }, frame: FrameId): boolean {
  return pictureFrame(img.w, img.h) !== frame;
}

/** The browser's memory of the last frame chosen for a month, per month. */
export const frameStorageKey = (batch: string) => `lsm-video-frame-${batch}`;

export interface FrameChoice {
  frame: FrameId;
  fill: FrameFill;
}

/** Reads a stored choice, falling back to the defaults for anything unknown. */
export function parseFrameChoice(raw: string | null | undefined): FrameChoice {
  try {
    const o = raw ? (JSON.parse(raw) as Partial<FrameChoice>) : {};
    return { frame: isFrame(o.frame) ? o.frame : DEFAULT_FRAME, fill: isFill(o.fill) ? o.fill : DEFAULT_FILL };
  } catch {
    return { frame: DEFAULT_FRAME, fill: DEFAULT_FILL };
  }
}

/**
 * How a frame reaches an engine: `aspect` when the engine's frame options include it (the engine
 * reframes itself), else the picture is composed here first. `aspects` is the engine's list, or
 * null / empty when it follows the picture.
 */
export function frameRoute(frame: FrameId, aspects: readonly string[] | null | undefined): { aspect: FrameId | undefined; compose: boolean } {
  return aspects && aspects.includes(frame) ? { aspect: frame, compose: false } : { aspect: undefined, compose: true };
}

/** One line for the Generate panel: how this engine gets the frame. */
export function frameRouteLine(engineName: string, frame: FrameId, aspects: readonly string[] | null | undefined, fill: FrameFill): string {
  const route = frameRoute(frame, aspects);
  const label = frameLabel(frame);
  if (!route.compose) return `${engineName} takes the ${label} frame itself.`;
  return `${engineName} follows the picture's frame, so the picture is made ${label} here before it is sent (${fill === "blur" ? "the whole picture over blurred edges" : "cropped to fit, centred"}).`;
}
