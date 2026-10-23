/**
 * "Match colour" (docs/video-editor.md, phase 3): a clip's colour moved toward a reference picture
 * by a statistical transfer in CIE Lab (Reinhard et al., "Color Transfer between Images", 2001):
 * each Lab channel of the clip is shifted and scaled so its mean and spread become the reference's,
 * out = (in − mean_clip) · (std_ref / std_clip) + mean_ref, stored as a scale and an offset per
 * channel. Plain maths, no browser: the editor measures, this file fits, the shader
 * (src/video-editor/engine/grader.ts) applies the same formula to every frame, and `applyMatch`
 * below is its CPU twin for the tests.
 *
 * Temporal stability: the clip's statistics are pooled from several frames spread over the clip
 * and fitted ONCE; every frame is then mapped by the same fixed transfer, so nothing changes from
 * frame to frame (no flicker). The scales are bounded (a reference with far more or less contrast
 * cannot blow a clip out), and the result is clamped to the displayable range.
 *
 * Limits, said plainly: a global statistic, not a scene understanding. It moves the overall
 * brightness, contrast and colour cast toward the reference; it does not know skin from sky (the
 * "Protect skin tones" switch limits what reaches skin), and a reference whose content differs a
 * lot from the clip (a blue sea against a red dress) transfers its cast along with its mood.
 */

export type Vec3 = [number, number, number];

/* ───────────── sRGB ↔ Lab (D65) ───────────── */

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);

const WHITE: Vec3 = [0.95047, 1.0, 1.08883];
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const fInv = (t: number) => (t * t * t > EPS ? t * t * t : (116 * t - 16) / KAPPA);

/** sRGB (0 … 1 per channel) to CIE Lab (L 0 … 100, a/b about −128 … 127), D65 white. */
export function rgbToLab(r: number, g: number, b: number): Vec3 {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0];
  const y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / WHITE[1];
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / WHITE[2];
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE Lab back to sRGB, clamped to 0 … 1. */
export function labToRgb(L: number, a: number, b: number): Vec3 {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fInv(fx) * WHITE[0];
  const y = (L > KAPPA * EPS ? fy * fy * fy : L / KAPPA) * WHITE[1];
  const z = fInv(fz) * WHITE[2];
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const c = (v: number) => Math.min(1, Math.max(0, linearToSrgb(v)));
  return [c(R), c(G), c(B)];
}

/* ───────────── Statistics ───────────── */

/** Lab statistics of a set of pixels: the sums are kept so several frames can be pooled exactly. */
export interface LabStats {
  n: number;
  mean: Vec3;
  std: Vec3;
  sum: Vec3;
  sumSq: Vec3;
}

/**
 * The Lab mean and standard deviation of RGBA bytes (canvas ImageData), every `step`-th pixel.
 * Fully transparent pixels are skipped (a reference PNG's empty corners say nothing about colour).
 */
export function labStats(rgba: ArrayLike<number>, step = 1): LabStats {
  const sum: Vec3 = [0, 0, 0];
  const sumSq: Vec3 = [0, 0, 0];
  let n = 0;
  const stride = 4 * Math.max(1, Math.floor(step));
  for (let i = 0; i + 3 < rgba.length; i += stride) {
    if (rgba[i + 3] === 0) continue;
    const lab = rgbToLab(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
    for (let c = 0; c < 3; c++) {
      sum[c] += lab[c];
      sumSq[c] += lab[c] * lab[c];
    }
    n++;
  }
  return finish(n, sum, sumSq);
}

function finish(n: number, sum: Vec3, sumSq: Vec3): LabStats {
  const mean: Vec3 = [0, 0, 0];
  const std: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    mean[c] = n ? sum[c] / n : 0;
    std[c] = n ? Math.sqrt(Math.max(0, sumSq[c] / n - mean[c] * mean[c])) : 0;
  }
  return { n, mean, std, sum, sumSq };
}

/** Several frames' statistics as one (the exact pooled mean and variance, weighted by pixel count). */
export function poolStats(list: readonly LabStats[]): LabStats {
  const sum: Vec3 = [0, 0, 0];
  const sumSq: Vec3 = [0, 0, 0];
  let n = 0;
  for (const s of list) {
    n += s.n;
    for (let c = 0; c < 3; c++) {
      sum[c] += s.sum[c];
      sumSq[c] += s.sumSq[c];
    }
  }
  return finish(n, sum, sumSq);
}

/* ───────────── The transfer ───────────── */

/** How far a channel's spread may be scaled: a reference cannot flatten or explode a clip. */
export const MATCH_SCALE_L: [number, number] = [0.6, 1.6];
export const MATCH_SCALE_AB: [number, number] = [0.5, 2];
/** Below this spread a channel is treated as flat (a grey card has no a/b spread to match). */
const MIN_STD = 1.5;

export interface Transfer {
  scale: Vec3;
  offset: Vec3;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The per-channel transfer that gives the clip's pooled statistics the reference's mean and spread:
 * scale = std_ref / std_clip (bounded), offset = mean_ref − scale · mean_clip.
 */
export function fitTransfer(clip: LabStats, ref: LabStats): Transfer {
  const scale: Vec3 = [1, 1, 1];
  const offset: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const [lo, hi] = c === 0 ? MATCH_SCALE_L : MATCH_SCALE_AB;
    const s = clip.std[c] < MIN_STD || ref.std[c] < MIN_STD ? 1 : clamp(ref.std[c] / clip.std[c], lo, hi);
    scale[c] = round4(s);
    offset[c] = round4(ref.mean[c] - s * clip.mean[c]);
  }
  return { scale, offset };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Where the reference came from: a picture saved in the studio, this post's reference, a Drive photo, a file from this computer, or a reference video ("Edit like this video": its pooled colour). */
export type MatchRefKind = "studio" | "post" | "drive" | "upload" | "video";

/** A clip's colour match, stored with the project: the fitted transfer and where its reference came from. */
export interface ColourMatch {
  ref: {
    kind: MatchRefKind;
    /** The studio reference id, the Drive file id, the post ("batch:index"), or the uploaded file's name. */
    id: string;
    name: string;
    /** A tiny JPEG of the reference (an uploaded file is not stored anywhere else), 8 KB at most. */
    thumb?: string;
  };
  scale: Vec3;
  offset: Vec3;
  /** 0 … 1: how far toward the reference. */
  amount: number;
  /** How many of the clip's frames the fit pooled. */
  frames: number;
  at: number;
}

export const MAX_MATCH_THUMB = 8 * 1024;

/** One colour through the match (the shader's formula, on the CPU): Lab, scaled and offset, back, blended by `amount`. */
export function applyMatch(rgb: Vec3, m: Pick<ColourMatch, "scale" | "offset" | "amount">): Vec3 {
  if (!(m.amount > 0)) return [...rgb];
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const out = labToRgb(lab[0] * m.scale[0] + m.offset[0], lab[1] * m.scale[1] + m.offset[1], lab[2] * m.scale[2] + m.offset[2]);
  const a = clamp(m.amount, 0, 1);
  return [rgb[0] + (out[0] - rgb[0]) * a, rgb[1] + (out[1] - rgb[1]) * a, rgb[2] + (out[2] - rgb[2]) * a];
}

/** The statistics a set of pixels would have after the match (to check that a fit moves toward the reference). */
export function matchedStats(rgba: ArrayLike<number>, m: Pick<ColourMatch, "scale" | "offset" | "amount">, step = 1): LabStats {
  const out = new Uint8ClampedArray(Math.ceil(rgba.length / (4 * step)) * 4);
  let j = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4 * step) {
    const [r, g, b] = applyMatch([rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255], m);
    out[j++] = Math.round(r * 255);
    out[j++] = Math.round(g * 255);
    out[j++] = Math.round(b * 255);
    out[j++] = rgba[i + 3];
  }
  return labStats(out.subarray(0, j));
}

/** A distance between two sets of statistics (mean and spread, Lab units): smaller is closer. */
export function statsDistance(a: LabStats, b: LabStats): number {
  let d = 0;
  for (let c = 0; c < 3; c++) d += (a.mean[c] - b.mean[c]) ** 2 + (a.std[c] - b.std[c]) ** 2;
  return Math.sqrt(d);
}

/* ───────────── Validation ───────────── */

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const vec = (x: unknown, lo: number, hi: number): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every((v) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi);

/** A stored match, checked; the reason names what is wrong. */
export function checkMatch(x: unknown, where: string): ColourMatch | string {
  if (!isObj(x)) return `${where}: match must be an object.`;
  const ref = x.ref;
  if (!isObj(ref) || !["studio", "post", "drive", "upload", "video"].includes(String(ref.kind))) return `${where}: match.ref needs a kind (studio, post, drive, upload or video).`;
  if (typeof ref.id !== "string" || !ref.id || ref.id.length > 200) return `${where}: match.ref needs an id.`;
  if (typeof ref.name !== "string" || ref.name.length > 200) return `${where}: match.ref.name is too long.`;
  if (ref.thumb !== undefined && (typeof ref.thumb !== "string" || ref.thumb.length > MAX_MATCH_THUMB || !/^data:image\/(jpeg|png|webp);base64,/.test(ref.thumb))) return `${where}: match.ref.thumb must be a small picture (8 KB at most).`;
  if (!vec(x.scale, 0.25, 4)) return `${where}: match.scale must be three numbers between 0.25 and 4.`;
  if (!vec(x.offset, -200, 200)) return `${where}: match.offset must be three numbers between -200 and 200.`;
  const amount = x.amount ?? 1;
  if (typeof amount !== "number" || !(amount >= 0 && amount <= 1)) return `${where}: match.amount must be between 0 and 1.`;
  const frames = x.frames ?? 1;
  if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 1 || frames > 100) return `${where}: match.frames must be a whole number of frames.`;
  const at = x.at ?? 0;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return `${where}: match.at must be a timestamp.`;
  return {
    ref: { kind: ref.kind as MatchRefKind, id: ref.id, name: ref.name, ...(typeof ref.thumb === "string" ? { thumb: ref.thumb } : {}) },
    scale: [...(x.scale as Vec3)] as Vec3,
    offset: [...(x.offset as Vec3)] as Vec3,
    amount,
    frames,
    at,
  };
}
