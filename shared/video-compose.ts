/**
 * The compositor's definition, shared by the editor's preview, its export and the tests: where a
 * source lands in the output frame (Fill or Fit, zoom, pan, display rotation), which text and logo
 * layers are on screen at a time, and the encoded size of each of the four frames. Pure maths, no
 * browser: the engine (src/video-editor/engine/grader.ts, overlays.ts, compose.ts) draws what this
 * file decides, the same way for the preview canvas and for every exported frame.
 *
 * Layer order, bottom to top: the background colour (visible around a Fit picture), the clip on
 * screen (two during a crossfade), the colour grade (look, sliders, LUT) applied to the footage
 * only, then the overlays in list order (text and logos are never colour-graded, so brand colours
 * stay exact).
 */
import { pictureFrame, type FrameId } from "./video-frame";

export type FitMode = "fill" | "fit";

/** How a clip sits in the frame: Fill covers it (cropping), Fit shows all of it; zoom ≥ 1 enlarges, x/y pan (-1 … 1). */
export interface Framing {
  fit: FitMode;
  /** 1 … 4, uniform: a picture is never stretched. */
  zoom: number;
  /** -1 … 1: -1 shows the left (top) edge of the overflow, 1 the right (bottom), 0 centred. */
  x: number;
  y: number;
}

export const DEFAULT_FRAMING: Framing = { fit: "fill", zoom: 1, x: 0, y: 0 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** The encoded size of each frame: the long side 1920, the short side 1080 (H.264 needs even sides). */
export const FRAME_OUTPUT: Record<FrameId, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

export function outputForFrame(frame: FrameId): { width: number; height: number } {
  return FRAME_OUTPUT[frame];
}

/** The frame of an output size, when it is one of the four. */
export function frameOfOutput(o: { width: number; height: number }): FrameId | null {
  return pictureFrame(o.width, o.height);
}

/** Display rotation, clockwise, as phones record it in the track header's matrix. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * The clockwise display rotation of an mp4 track header matrix (9 numbers: a, b, u, c, d, v, x, y, w
 * in 16.16 / 2.30 fixed point). A phone held upright records landscape pixels with a 90° matrix.
 * Mirrored or skewed matrices are reported as 0 (not handled: the picture is drawn as coded).
 */
export function rotationOfMatrix(m: ArrayLike<number> | null | undefined): Rotation {
  if (!m || m.length < 5) return 0;
  // Some readers hand the matrix out as unsigned 32-bit numbers: -1.0 then reads 4294901760.
  const at = (i: number) => (m[i] > 0x7fffffff ? m[i] - 0x100000000 : m[i]) / 65536;
  const a = at(0);
  const b = at(1);
  const c = at(3);
  const d = at(4);
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return 0;
  if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90;
  if (near(a, -1) && near(b, 0) && near(c, 0) && near(d, -1)) return 180;
  if (near(a, 0) && near(b, -1) && near(c, 1) && near(d, 0)) return 270;
  return 0;
}

/** The size a source shows at once rotated for display. */
export function displaySize(coded: { width: number; height: number }, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: coded.height, height: coded.width } : { width: coded.width, height: coded.height };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A framing with every field present and inside its bounds. */
export function normaliseFraming(f: Partial<Framing> | null | undefined, base: Framing = DEFAULT_FRAMING): Framing {
  return {
    fit: f?.fit === "fit" || f?.fit === "fill" ? f.fit : base.fit,
    zoom: clamp(typeof f?.zoom === "number" && Number.isFinite(f.zoom) ? f.zoom : base.zoom, MIN_ZOOM, MAX_ZOOM),
    x: clamp(typeof f?.x === "number" && Number.isFinite(f.x) ? f.x : base.x, -1, 1),
    y: clamp(typeof f?.y === "number" && Number.isFinite(f.y) ? f.y : base.y, -1, 1),
  };
}

/**
 * Where the (display-oriented) source is drawn in the output, in output pixels: one uniform scale
 * (Fill: the larger of the two ratios, Fit: the smaller, times zoom), centred, then moved by the pan
 * across the part that overflows (Fill) or the empty band (Fit). The aspect ratio of the source is
 * kept exactly: w / h of the rect equals the source's.
 */
export function placeSource(src: { width: number; height: number }, out: { width: number; height: number }, framing: Framing): Rect {
  const sw = Math.max(1, src.width);
  const sh = Math.max(1, src.height);
  const base = framing.fit === "fit" ? Math.min(out.width / sw, out.height / sh) : Math.max(out.width / sw, out.height / sh);
  const scale = base * clamp(framing.zoom, MIN_ZOOM, MAX_ZOOM);
  const w = sw * scale;
  const h = sh * scale;
  // The slack on each axis: how far the picture can move and stay covering (Fill) or inside (Fit).
  const slackX = Math.abs(w - out.width) / 2;
  const slackY = Math.abs(h - out.height) / 2;
  // Fill: x = 1 shows the right edge, so the picture moves left. Fit: x = 1 moves the picture right.
  const dirX = w >= out.width ? -1 : 1;
  const dirY = h >= out.height ? -1 : 1;
  const x = (out.width - w) / 2 + dirX * clamp(framing.x, -1, 1) * slackX;
  const y = (out.height - h) / 2 + dirY * clamp(framing.y, -1, 1) * slackY;
  return { x, y, w, h };
}

/**
 * The shader's sampling for a placement: output UV (0 … 1, top-left origin) to source UV is
 * `src = (uv - offset) * scale`, with offset = rect.xy / out and scale = out / rect.wh. Returned as
 * [scaleX, scaleY, offsetX, offsetY].
 */
export function placementUniform(rect: Rect, out: { width: number; height: number }): [number, number, number, number] {
  return [out.width / rect.w, out.height / rect.h, rect.x / out.width, rect.y / out.height];
}

/**
 * A display-space UV (0 … 1, top-left) mapped to the coded picture's UV for a clockwise display
 * rotation: the coded frame is what the decoder hands out, the display is what a player shows.
 */
export function codedUv(u: number, v: number, rotation: Rotation): [number, number] {
  switch (rotation) {
    case 90:
      return [v, 1 - u];
    case 180:
      return [1 - u, 1 - v];
    case 270:
      return [1 - v, u];
    default:
      return [u, v];
  }
}

/* ───────────── Overlays ───────────── */

export type TextFont = "sans" | "serif" | "display";
export type TextAlign = "start" | "center" | "end";

/** A line (or a few) of words over the video: Arabic and English, shaped by the browser's own text engine. */
export interface TextOverlay {
  id: string;
  kind: "text";
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  /** The text block's centre, as a fraction of the frame (0 … 1). */
  x: number;
  y: number;
  /** Font size as a fraction of the frame's height (0.02 … 0.2). */
  size: number;
  color: string;
  font: TextFont;
  weight: 400 | 600 | 800;
  align: TextAlign;
  /** A box behind the words (a colour), or null. */
  box: string | null;
  /** Wrap width as a fraction of the frame's width (0.2 … 1). */
  width: number;
}

/** A picture (the client's logo, a sticker) over the video. */
export interface LogoOverlay {
  id: string;
  kind: "logo";
  /** A same-origin path (`/api/...`) or a small data: URL (PNG/JPEG/WebP/SVG, 200 KB at most). */
  src: string;
  name: string;
  start: number;
  end: number;
  x: number;
  y: number;
  /** Width as a fraction of the frame's width (0.03 … 1); the height follows the picture. */
  width: number;
  /** 0 … 1. */
  opacity: number;
}

export type Overlay = TextOverlay | LogoOverlay;

export const MAX_OVERLAYS = 24;
export const MAX_TEXT = 300;
export const MAX_LOGO_DATA_URL = 200 * 1024;

/** The overlays on screen at timeline time t, bottom first (list order). */
export function overlaysAt(overlays: readonly Overlay[] | null | undefined, t: number): Overlay[] {
  return (overlays ?? []).filter((o) => t >= o.start && t < o.end);
}

/** The text direction of a string: right-to-left when its first strong character is Arabic or Hebrew. */
export function textDirection(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return "rtl";
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) return "ltr";
  }
  return "ltr";
}

export function newOverlayId(): string {
  return `o${Math.random().toString(36).slice(2, 10)}`;
}

export function newTextOverlay(text: string, start: number, end: number, id = newOverlayId()): TextOverlay {
  return { id, kind: "text", text, start, end, x: 0.5, y: 0.78, size: 0.06, color: "#ffffff", font: "sans", weight: 800, align: "center", box: null, width: 0.86 };
}

export function newLogoOverlay(src: string, name: string, start: number, end: number, id = newOverlayId()): LogoOverlay {
  return { id, kind: "logo", src, name, start, end, x: 0.84, y: 0.08, width: 0.22, opacity: 1 };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const COLOUR_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** The overlays a saved project carries, checked one by one; the reason names the bad one. */
export function checkOverlays(x: unknown): Overlay[] | string {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) return "overlays must be a list.";
  if (x.length > MAX_OVERLAYS) return `At most ${MAX_OVERLAYS} text and logo layers.`;
  const out: Overlay[] = [];
  const ids = new Set<string>();
  for (const [i, o] of (x as unknown[]).entries()) {
    const where = `layer ${i + 1}`;
    if (!isObj(o)) return `${where} must be an object.`;
    if (typeof o.id !== "string" || !o.id || o.id.length > 40 || ids.has(o.id)) return `${where} needs a unique id.`;
    ids.add(o.id);
    if (!num(o.start, 0, 3600) || !num(o.end, 0, 3600) || o.end <= o.start) return `${where}: start and end must be seconds with start before end.`;
    if (!num(o.x, -0.5, 1.5) || !num(o.y, -0.5, 1.5)) return `${where}: its position must be inside the frame.`;
    if (o.kind === "text") {
      if (typeof o.text !== "string" || !o.text.trim() || o.text.length > MAX_TEXT) return `${where}: the words must be 1 to ${MAX_TEXT} characters.`;
      if (!num(o.size, 0.01, 0.3)) return `${where}: the size is out of range.`;
      if (typeof o.color !== "string" || !COLOUR_RE.test(o.color)) return `${where}: the colour must be a hex colour like #ffffff.`;
      if (o.box !== null && o.box !== undefined && (typeof o.box !== "string" || !COLOUR_RE.test(o.box))) return `${where}: the box colour must be a hex colour or none.`;
      const font: TextFont = o.font === "serif" || o.font === "display" ? o.font : "sans";
      const weight = o.weight === 400 || o.weight === 600 ? o.weight : 800;
      const align: TextAlign = o.align === "start" || o.align === "end" ? o.align : "center";
      const width = num(o.width, 0.1, 1) ? o.width : 0.86;
      out.push({ id: o.id, kind: "text", text: o.text, start: o.start, end: o.end, x: o.x, y: o.y, size: o.size, color: o.color, font, weight, align, box: (o.box as string | null | undefined) ?? null, width });
    } else if (o.kind === "logo") {
      if (typeof o.src !== "string" || !o.src) return `${where}: the logo needs a picture.`;
      const isData = /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(o.src);
      if (!isData && !/^\/[A-Za-z0-9/_.?=&%:+-]*$/.test(o.src)) return `${where}: the logo must be a picture from the studio or a small uploaded file.`;
      if (isData && o.src.length > MAX_LOGO_DATA_URL) return `${where}: the logo file is too large (200 KB at most).`;
      if (o.src.length > MAX_LOGO_DATA_URL) return `${where}: the logo address is too long.`;
      if (!num(o.width, 0.02, 1)) return `${where}: the logo's width is out of range.`;
      const opacity = num(o.opacity, 0, 1) ? o.opacity : 1;
      out.push({ id: o.id, kind: "logo", src: o.src, name: typeof o.name === "string" ? o.name.slice(0, 120) : "Logo", start: o.start, end: o.end, x: o.x, y: o.y, width: o.width, opacity });
    } else return `${where} must be text or a logo.`;
  }
  return out;
}

/* ───────────── Colour metadata ───────────── */

/** What an mp4's `colr` box (nclx) or a decoder says about a source's colour. */
export interface SourceColour {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean | null;
}

const PRIMARIES: Record<number, string> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020", 12: "smpte432" };
const TRANSFER: Record<number, string> = { 1: "bt709", 6: "smpte170m", 8: "linear", 13: "iec61966-2-1", 14: "bt709", 15: "bt709", 16: "pq", 18: "hlg" };
const MATRIX: Record<number, string> = { 0: "rgb", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020-ncl" };

/** The nclx numbers (ISO/IEC 23091-2) in the names WebCodecs uses; unknown numbers are null. */
export function colourFromNclx(primaries: number, transfer: number, matrix: number, fullRange: boolean): SourceColour {
  return { primaries: PRIMARIES[primaries] ?? null, transfer: TRANSFER[transfer] ?? null, matrix: MATRIX[matrix] ?? null, fullRange };
}

/** HDR footage (PQ or HLG transfer, or BT.2020 primaries): the editor does not tone-map it. */
export function isHdr(c: SourceColour | null | undefined): boolean {
  return !!c && (c.transfer === "pq" || c.transfer === "hlg" || c.primaries === "bt2020");
}

/**
 * The colour the decoder is told to assume, so every source becomes the same RGB before the grade:
 * what the file says when it says it, else the broadcast convention for its size (BT.709 for HD and
 * above, BT.601 / SMPTE 170M below 720 lines), limited range unless the file says full.
 */
export function assumedColour(c: SourceColour | null | undefined, height: number): { primaries: string; transfer: string; matrix: string; fullRange: boolean } {
  const sd = height < 720;
  return {
    primaries: c?.primaries ?? (sd ? "smpte170m" : "bt709"),
    transfer: c?.transfer ?? (sd ? "smpte170m" : "bt709"),
    matrix: c?.matrix ?? (sd ? "smpte170m" : "bt709"),
    fullRange: c?.fullRange ?? false,
  };
}

/** The colour every export is written in, and tagged with: BT.709, limited range (what iPhone and Instagram expect). */
export const OUTPUT_COLOUR = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false } as const;
