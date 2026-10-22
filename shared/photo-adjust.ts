/**
 * The Photo studio's Adjust tool, the pure part: the parameters a designer sets (crop, rotation,
 * flip, straighten, the colour sliders, sharpen, vignette), the crop rectangle maths, and the
 * per-pixel operations on an RGBA buffer. Nothing here touches the DOM or a canvas: the studio
 * draws the geometry with a canvas and hands this module the pixels, so the maths can be tested on
 * a small buffer. Every operation is free: no provider is called.
 */

export type Aspect = "free" | "1:1" | "4:5" | "9:16";

/** A rectangle in fractions of the picture it crops (after rotation and flip). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AdjustParams {
  /** null: the whole picture. */
  crop: CropRect | null;
  aspect: Aspect;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** Degrees, −10..10; the picture is scaled up so the frame stays filled. */
  straighten: number;
  /** −100..100 each. */
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  /** 0..100 each. */
  sharpen: number;
  vignette: number;
}

export const DEFAULT_ADJUST: AdjustParams = {
  crop: null,
  aspect: "free",
  rotate: 0,
  flipH: false,
  flipV: false,
  straighten: 0,
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  sharpen: 0,
  vignette: 0,
};

/** The colour sliders, in the order the panel shows them, with their plain names. */
export const COLOR_SLIDERS: { key: keyof AdjustParams; label: string; min: number; max: number }[] = [
  { key: "exposure", label: "Exposure", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "temperature", label: "Temperature", min: -100, max: 100 },
  { key: "tint", label: "Tint", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100 },
  { key: "vignette", label: "Vignette", min: 0, max: 100 },
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function isDefaultAdjust(p: AdjustParams): boolean {
  return describeAdjust(p).length === 0;
}

/** Whether the colour pipeline has anything to do (the geometry is drawn by the canvas). */
export function hasColorWork(p: AdjustParams): boolean {
  return p.exposure !== 0 || p.contrast !== 0 || p.saturation !== 0 || p.temperature !== 0 || p.tint !== 0 || p.highlights !== 0 || p.shadows !== 0;
}

/** What changed, in words: the take's note ("crop 4:5, exposure +20, sharpen 30"). */
export function describeAdjust(p: AdjustParams): string[] {
  const out: string[] = [];
  if (p.crop) out.push(p.aspect === "free" ? "crop" : `crop ${p.aspect}`);
  if (p.rotate) out.push(`rotate ${p.rotate}°`);
  if (p.flipH) out.push("flip horizontally");
  if (p.flipV) out.push("flip vertically");
  if (p.straighten) out.push(`straighten ${p.straighten > 0 ? "+" : ""}${p.straighten}°`);
  for (const s of COLOR_SLIDERS) {
    const v = p[s.key] as number;
    if (v) out.push(`${s.label.toLowerCase()} ${v > 0 && s.min < 0 ? "+" : ""}${v}`);
  }
  return out;
}

/* ───────────── Geometry ───────────── */

export function aspectRatioOf(aspect: Aspect): number | null {
  return aspect === "1:1" ? 1 : aspect === "4:5" ? 4 / 5 : aspect === "9:16" ? 9 / 16 : null;
}

/** The picture's size once rotated by a quarter turn or two. */
export function rotatedSize(w: number, h: number, rotate: AdjustParams["rotate"]): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h };
}

/** The scale that keeps a frame of w×h filled after it is turned by `deg` degrees. */
export function straightenScale(deg: number, w: number, h: number): number {
  const a = (Math.abs(deg) * Math.PI) / 180;
  if (!a) return 1;
  // Each axis must still cover the frame after rotation: the larger of the two requirements.
  const s1 = (w * Math.cos(a) + h * Math.sin(a)) / w;
  const s2 = (w * Math.sin(a) + h * Math.cos(a)) / h;
  return Math.max(s1, s2);
}

/** The largest centred crop of the picture (w×h pixels) with the aspect asked, as fractions. */
export function cropForAspect(aspect: Aspect, w: number, h: number): CropRect {
  const r = aspectRatioOf(aspect);
  if (!r || !w || !h) return { x: 0, y: 0, w: 1, h: 1 };
  const pictureRatio = w / h;
  if (pictureRatio > r) {
    // Too wide: the full height, a narrower width.
    const cw = (r * h) / w;
    return { x: (1 - cw) / 2, y: 0, w: cw, h: 1 };
  }
  const ch = w / r / h;
  return { x: 0, y: (1 - ch) / 2, w: 1, h: ch };
}

/** The minimum side a crop can shrink to (a fraction of the picture). */
export const MIN_CROP = 0.05;

/**
 * A crop kept inside the picture and, when an aspect is set, at that aspect: the size is clamped
 * first (the aspect wins over whichever side would go out), then the position.
 */
export function clampCrop(c: CropRect, aspect: Aspect, w: number, h: number): CropRect {
  let cw = clamp(c.w, MIN_CROP, 1);
  let ch = clamp(c.h, MIN_CROP, 1);
  const r = aspectRatioOf(aspect);
  if (r && w && h) {
    // Fractions are of different lengths: the pixel aspect decides the fraction of height.
    ch = (cw * w) / r / h;
    if (ch > 1) {
      ch = 1;
      cw = (r * h) / w;
    }
    if (ch < MIN_CROP) {
      ch = MIN_CROP;
      cw = (r * h * ch) / w;
    }
  }
  const x = clamp(c.x, 0, 1 - cw);
  const y = clamp(c.y, 0, 1 - ch);
  return { x, y, w: cw, h: ch };
}

/** A crop in whole pixels of a w×h picture (at least one pixel each way). */
export function cropPixels(c: CropRect | null, w: number, h: number): { x: number; y: number; w: number; h: number } {
  if (!c) return { x: 0, y: 0, w, h };
  const x = Math.min(Math.max(0, w - 1), Math.round(clamp(c.x, 0, 1) * w));
  const y = Math.min(Math.max(0, h - 1), Math.round(clamp(c.y, 0, 1) * h));
  const cw = Math.max(1, Math.min(w - x, Math.round(c.w * w)));
  const ch = Math.max(1, Math.min(h - y, Math.round(c.h * h)));
  return { x, y, w: cw, h: ch };
}

/** The size of the picture the Adjust tool puts out, from the source size. */
export function outputSize(p: AdjustParams, w: number, h: number): { w: number; h: number } {
  const r = rotatedSize(w, h, p.rotate);
  const c = cropPixels(p.crop, r.w, r.h);
  return { w: c.w, h: c.h };
}

/**
 * A corner or an edge of the crop frame dragged by (dx, dy) fractions: the opposite side stays,
 * the aspect holds when one is set. `handle` names the side(s) moving: n, s, e, w, ne, nw, se, sw.
 */
export function resizeCrop(c: CropRect, handle: string, dx: number, dy: number, aspect: Aspect, w: number, h: number): CropRect {
  let { x, y, w: cw, h: ch } = c;
  if (handle.includes("w")) {
    x += dx;
    cw -= dx;
  }
  if (handle.includes("e")) cw += dx;
  if (handle.includes("n")) {
    y += dy;
    ch -= dy;
  }
  if (handle.includes("s")) ch += dy;
  const r = aspectRatioOf(aspect);
  if (r && w && h) {
    // The side being dragged decides; the other follows the aspect, anchored on the still side.
    const horizontal = handle === "e" || handle === "w";
    if (horizontal) ch = (cw * w) / r / h;
    else cw = (ch * h * r) / w;
    if (handle.includes("n")) y = c.y + c.h - ch;
    if (handle.includes("w")) x = c.x + c.w - cw;
  }
  // The anchor must hold: clamping the size moves the far side only.
  const clamped = clampCrop({ x, y, w: Math.max(cw, MIN_CROP), h: Math.max(ch, MIN_CROP) }, aspect, w, h);
  if (handle.includes("n")) clamped.y = clamp(c.y + c.h - clamped.h, 0, 1 - clamped.h);
  if (handle.includes("w")) clamped.x = clamp(c.x + c.w - clamped.w, 0, 1 - clamped.w);
  return clamped;
}

/** The crop frame moved by (dx, dy) fractions, kept inside the picture. */
export function moveCrop(c: CropRect, dx: number, dy: number): CropRect {
  return { ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) };
}

/* ───────────── Colour ───────────── */

/**
 * The tone curve, as a 256-entry table: exposure (a gain in stops, ±1 at the slider's ends),
 * contrast (an S around middle grey), then highlights and shadows (lifted or held back where the
 * tone is bright or dark). One table serves the three channels, so hues are not shifted.
 */
export function toneCurve(p: Pick<AdjustParams, "exposure" | "contrast" | "highlights" | "shadows">): Uint8Array {
  const lut = new Uint8Array(256);
  const gain = Math.pow(2, p.exposure / 100);
  const k = 1 + p.contrast / 100; // 0..2
  const hi = p.highlights / 100;
  const sh = p.shadows / 100;
  for (let i = 0; i < 256; i++) {
    let v = (i / 255) * gain;
    v = 0.5 + (v - 0.5) * k;
    v = clamp(v, 0, 1);
    if (hi) {
      // Weight 0 in the dark, 1 in the bright: pull or push the bright end only.
      const wgt = v * v;
      v = clamp(v + hi * 0.5 * wgt * (hi > 0 ? 1 - v : v), 0, 1);
    }
    if (sh) {
      const wgt = (1 - v) * (1 - v);
      v = clamp(v + sh * 0.5 * wgt * (sh > 0 ? 1 - v : v), 0, 1);
    }
    lut[i] = Math.round(v * 255);
  }
  return lut;
}

/** The per-channel gains for temperature (warm: more red, less blue) and tint (magenta ↔ green). */
export function whiteBalanceGains(p: Pick<AdjustParams, "temperature" | "tint">): { r: number; g: number; b: number } {
  const t = p.temperature / 100;
  const n = p.tint / 100;
  return { r: 1 + 0.25 * t - 0.08 * n, g: 1 + 0.16 * n, b: 1 - 0.25 * t - 0.08 * n };
}

/**
 * The colour pipeline on an RGBA buffer, in place: tone curve, saturation around the pixel's luma,
 * white balance. Alpha is left alone.
 */
export function applyColor(data: Uint8ClampedArray | Uint8Array, p: AdjustParams): void {
  if (!hasColorWork(p)) return;
  const lut = toneCurve(p);
  const sat = 1 + p.saturation / 100;
  const wb = whiteBalanceGains(p);
  const doSat = p.saturation !== 0;
  const doWb = p.temperature !== 0 || p.tint !== 0;
  for (let i = 0; i < data.length; i += 4) {
    let r = lut[data[i]];
    let g = lut[data[i + 1]];
    let b = lut[data[i + 2]];
    if (doSat) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }
    if (doWb) {
      r *= wb.r;
      g *= wb.g;
      b *= wb.b;
    }
    data[i] = clamp255(Math.round(r));
    data[i + 1] = clamp255(Math.round(g));
    data[i + 2] = clamp255(Math.round(b));
  }
}

/**
 * An unsharp mask: the picture minus its 3×3 blur, added back with `amount` (0..100 → 0..1.5).
 * Edges are clamped; alpha is left alone. `scale` lets a small preview match the full picture.
 */
export function unsharpMask(data: Uint8ClampedArray | Uint8Array, w: number, h: number, amount: number): void {
  if (amount <= 0 || w < 3 || h < 3) return;
  const k = (amount / 100) * 1.5;
  const src = new Uint8Array(data.length);
  src.set(data);
  const at = (x: number, y: number) => (clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[at(x + dx, y + dy) + c];
        const blur = sum / 9;
        const v = src[o + c];
        data[o + c] = clamp255(Math.round(v + (v - blur) * k));
      }
    }
  }
}

/** A soft dark edge: `amount` 0..100 is how dark the corners get; the middle is untouched. */
export function vignette(data: Uint8ClampedArray | Uint8Array, w: number, h: number, amount: number): void {
  if (amount <= 0) return;
  const strength = amount / 100;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxD = Math.sqrt(cx * cx + cy * cy) || 1;
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / maxD;
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / maxD;
      const d = Math.sqrt(dx * dx + dy * dy); // 0 at the centre, 1 in the corner
      // Nothing inside the middle 40%; a smooth fall to the corners.
      const t = clamp((d - 0.4) / 0.6, 0, 1);
      const f = 1 - strength * t * t;
      if (f >= 1) continue;
      const o = (y * w + x) * 4;
      data[o] = clamp255(Math.round(data[o] * f));
      data[o + 1] = clamp255(Math.round(data[o + 1] * f));
      data[o + 2] = clamp255(Math.round(data[o + 2] * f));
    }
  }
}

/** The whole pixel pipeline on a buffer that already has the geometry applied. */
export function applyPixels(data: Uint8ClampedArray | Uint8Array, w: number, h: number, p: AdjustParams): void {
  applyColor(data, p);
  unsharpMask(data, w, h, p.sharpen);
  vignette(data, w, h, p.vignette);
}

/**
 * The marked area of an AI edit, in words: where it sits and how big it is. The engine redraws the
 * whole picture, so the box is guidance in the instruction, not a mask.
 */
export function areaWords(a: CropRect): string {
  const col = a.x + a.w / 2 < 0.34 ? "left" : a.x + a.w / 2 > 0.66 ? "right" : "centre";
  const row = a.y + a.h / 2 < 0.34 ? "top" : a.y + a.h / 2 > 0.66 ? "bottom" : "middle";
  return `Change only the marked area (${row} ${col} of the picture, about ${Math.round(a.w * 100)}% wide and ${Math.round(a.h * 100)}% tall); keep everything outside it exactly as it is.`;
}
