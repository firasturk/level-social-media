/**
 * What a stretch of footage looks like, measured from small grey and colour copies of its frames
 * (docs/video-editor.md → Edit quality). Plain maths, no browser: the editor decodes the frames
 * (src/video-editor/engine/analyse.ts), this file turns them into numbers, and the auto edit and
 * "Edit like this video" plan from those numbers. Deterministic: the same frames give the same
 * result. Heuristics, said plainly: nothing here recognises faces, objects or words.
 *
 * Per frame: brightness (mean luma), contrast (its spread), clipped shadows and highlights, sharpness
 * (variance of the Laplacian), a colour histogram (4×4×4 RGB bins), a 64-bit difference hash, a
 * horizontal "focus" (where the detail is, so a 9:16 crop of wide footage can keep it), and, for a
 * text guess, the rows with many sharp, high-contrast edges.
 * Between frames: the change (mean absolute luma difference and histogram distance), the camera's
 * movement (a global shift from row and column profiles), a zoom hint (the scale that best maps
 * one frame onto the next) and what moves beyond the camera (the difference left after the shift).
 */

/* ───────────── One frame ───────────── */

export interface FrameFeatures {
  /** Seconds in the source. */
  t: number;
  /** 0 … 1. */
  luma: number;
  contrast: number;
  /** Fractions of pixels below 16/255 and above 240/255. */
  dark: number;
  bright: number;
  /** Focus: the variance of the Laplacian in the frame's sharpest tile of a 4×3 grid (a sharp face on a soft background is sharp). 0 … ~0.05; higher is sharper. */
  sharp: number;
  /** The median tile's focus: low when most of the frame is soft (a blurred foreground across it, a shallow-focus portrait). */
  sharpMid: number;
  /** 64 bins (4 per channel), summing to 1. */
  hist: number[];
  /** 16 hex characters. */
  hash: string;
  /** Where the detail is, horizontally: 0 (left) … 1 (right). */
  focusX: number;
  /** Row band most like text (many short, strong horizontal edge transitions), 0 … 1 top to bottom; null when none stands out. */
  textY: number | null;
  /** Grey copy kept for the comparisons with the next frame (w × h, 0 … 1); may be dropped once `pair` is set. */
  grey: Float32Array;
  /** The comparison with the frame before, when computed as the frames arrive (`linkFrames`), so long videos need not keep every grey copy. */
  pair?: FramePair;
  w: number;
  h: number;
}

/** Grey (BT.709 weights) of RGBA bytes, 0 … 1. */
export function greyOf(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  return out;
}

/** Variance of the 4-neighbour Laplacian: a standard focus measure (Pech-Pacheco et al., 2000). */
export function laplacianVariance(grey: ArrayLike<number>, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = grey[i - 1] + grey[i + 1] + grey[i - w] + grey[i + w] - 4 * grey[i];
      sum += l;
      sumSq += l * l;
      n++;
    }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** The variance of the Laplacian in each tile of a 4×3 grid: the largest and the median. */
export function tileFocus(grey: ArrayLike<number>, w: number, h: number): { max: number; median: number } {
  const tw = Math.floor(w / 4);
  const th = Math.floor(h / 3);
  if (tw < 4 || th < 4) {
    const v = laplacianVariance(grey, w, h);
    return { max: v, median: v };
  }
  const tile = new Float32Array(tw * th);
  const vs: number[] = [];
  for (let ty = 0; ty < 3; ty++)
    for (let tx = 0; tx < 4; tx++) {
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tile[y * tw + x] = grey[(ty * th + y) * w + tx * tw + x];
      vs.push(laplacianVariance(tile, tw, th));
    }
  vs.sort((a, b) => a - b);
  return { max: vs[vs.length - 1], median: (vs[5] + vs[6]) / 2 };
}

/** A 64-bit difference hash (Krawetz's dHash): the grey frame shrunk to 9×8, each pixel brighter than its right neighbour or not. */
export function dHash(grey: ArrayLike<number>, w: number, h: number): string {
  const cells: number[] = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) {
      const x0 = Math.floor((x * w) / 9);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / 9));
      const y0 = Math.floor((y * h) / 8);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / 8));
      let s = 0;
      let k = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          s += grey[yy * w + xx];
          k++;
        }
      cells.push(s / Math.max(1, k));
    }
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (cells[y * 9 + x] > cells[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Bits that differ between two hashes (0 … 64). */
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

/** Two frames this close (in hash bits) show the same picture: a near-duplicate. */
export const DUPLICATE_BITS = 10;

/** The 4×4×4 RGB histogram of RGBA bytes, every pixel, normalised to sum 1. */
export function colourHistogram(rgba: ArrayLike<number>, w: number, h: number): number[] {
  const bins = new Array<number>(64).fill(0);
  const n = w * h;
  for (let i = 0; i < n; i++) bins[((rgba[i * 4] >> 6) << 4) | ((rgba[i * 4 + 1] >> 6) << 2) | (rgba[i * 4 + 2] >> 6)]++;
  return bins.map((b) => b / Math.max(1, n));
}

/** Half the L1 distance of two normalised histograms: 0 (same colours) … 1 (nothing in common). */
export const histDistance = (a: readonly number[], b: readonly number[]): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - (b[i] ?? 0));
  return d / 2;
};

/** Where the detail sits horizontally: the centroid of the horizontal gradient energy, 0 … 1 (0.5 when flat). */
export function focusOf(grey: ArrayLike<number>, w: number, h: number): number {
  let sum = 0;
  let wx = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const g = Math.abs(grey[i + 1] - grey[i - 1]) + Math.abs(grey[i + w] - grey[i - w]);
      sum += g;
      wx += g * (x / (w - 1));
    }
  return sum > 1e-6 ? wx / sum : 0.5;
}

/**
 * A guess at where words sit in the frame: rows where strong edges alternate often (letters are
 * many short, sharp strokes on a plain ground). The band (an eighth of the height) with the most of
 * them wins when it is well above the frame's average; otherwise null. Rough on purpose: a striped
 * shirt or a fence can look like text, and thin text on a busy picture is missed.
 */
export function textBandOf(grey: ArrayLike<number>, w: number, h: number): number | null {
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let flips = 0;
    let last = 0;
    for (let x = 1; x < w; x++) {
      const d = grey[y * w + x] - grey[y * w + x - 1];
      if (Math.abs(d) > 0.18) {
        const s = Math.sign(d);
        if (s !== last) flips++;
        last = s;
      }
    }
    rows[y] = flips / w;
  }
  const band = Math.max(2, Math.round(h / 8));
  let best = -1;
  let bestY = 0;
  let total = 0;
  for (let y = 0; y < h; y++) total += rows[y];
  const mean = total / h;
  for (let y = 0; y + band <= h; y++) {
    let s = 0;
    for (let k = 0; k < band; k++) s += rows[y + k];
    s /= band;
    if (s > best) {
      best = s;
      bestY = y;
    }
  }
  return best > 0.06 && best > mean * 2.2 ? (bestY + band / 2) / h : null;
}

/** Every number of one frame from its RGBA bytes (a small copy: about 160 pixels wide). */
export function frameFeatures(t: number, rgba: ArrayLike<number>, w: number, h: number): FrameFeatures {
  const grey = greyOf(rgba, w, h);
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < grey.length; i++) {
    const v = grey[i];
    sum += v;
    sumSq += v * v;
    if (v < 16 / 255) dark++;
    else if (v > 240 / 255) bright++;
  }
  const n = Math.max(1, grey.length);
  const luma = sum / n;
  const focus = tileFocus(grey, w, h);
  return {
    t,
    luma,
    contrast: Math.sqrt(Math.max(0, sumSq / n - luma * luma)),
    dark: dark / n,
    bright: bright / n,
    sharp: focus.max,
    sharpMid: focus.median,
    hist: colourHistogram(rgba, w, h),
    hash: dHash(grey, w, h),
    focusX: focusOf(grey, w, h),
    textY: textBandOf(grey, w, h),
    grey,
    w,
    h,
  };
}

/* ───────────── Between two frames ───────────── */

export interface FramePair {
  grey: number;
  dx: number;
  dy: number;
  residual: number;
  zoom: number;
}

/** The comparison of frame b with frame a, stored on b (`b.pair`). */
export function linkFrames(a: FrameFeatures, b: FrameFeatures): FramePair {
  const m = cameraMotion(a.grey, b.grey, a.w, a.h);
  b.pair = { grey: greyDiff(a.grey, b.grey), dx: m.dx, dy: m.dy, residual: m.residual, zoom: zoomHint(a.grey, b.grey, a.w, a.h, m.dx * a.w, m.dy * a.h) };
  return b.pair;
}

/** Mean absolute grey difference, 0 … 1. */
export function greyDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / Math.max(1, a.length);
}

function profile(grey: ArrayLike<number>, w: number, h: number, axis: "x" | "y"): Float32Array {
  const out = new Float32Array(axis === "x" ? w : h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[axis === "x" ? x : y] += grey[y * w + x];
  const k = axis === "x" ? h : w;
  for (let i = 0; i < out.length; i++) out[i] /= k;
  return out;
}

/** The whole-pixel shift that best matches two profiles, and the same refined below a pixel (a parabola through the errors around it). */
function bestShift(a: Float32Array, b: Float32Array, max: number): { whole: number; fine: number } {
  const errs = new Map<number, number>();
  let best = 0;
  let bestErr = Infinity;
  for (let s = -max; s <= max; s++) {
    let err = 0;
    let n = 0;
    for (let i = Math.max(0, -s); i < Math.min(a.length, a.length - s); i++) {
      err += Math.abs(a[i] - b[i + s]);
      n++;
    }
    err /= Math.max(1, n);
    // A tiny preference for no movement, so a flat frame reads as still.
    err += Math.abs(s) * 1e-5;
    errs.set(s, err);
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  const l = errs.get(best - 1);
  const r = errs.get(best + 1);
  let fine = best;
  if (l !== undefined && r !== undefined) {
    const den = l - 2 * bestErr + r;
    if (den > 1e-9) fine = best + Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den)));
  }
  return { whole: best, fine };
}

/**
 * The camera's movement from frame a to frame b: a global shift (fractions of the width and height,
 * from the best match of the row and column brightness profiles, up to an eighth of the frame), and
 * what moved beyond that shift (the grey difference left once b is moved back), 0 … 1.
 */
export function cameraMotion(a: Float32Array, b: Float32Array, w: number, h: number): { dx: number; dy: number; residual: number } {
  const mx = Math.max(1, Math.round(w / 8));
  const my = Math.max(1, Math.round(h / 8));
  const fx = bestShift(profile(a, w, h, "x"), profile(b, w, h, "x"), mx);
  const fy = bestShift(profile(a, w, h, "y"), profile(b, w, h, "y"), my);
  const sx = fx.whole;
  const sy = fy.whole;
  let s = 0;
  let n = 0;
  for (let y = Math.max(0, -sy); y < Math.min(h, h - sy); y++)
    for (let x = Math.max(0, -sx); x < Math.min(w, w - sx); x++) {
      s += Math.abs(a[y * w + x] - b[(y + sy) * w + (x + sx)]);
      n++;
    }
  return { dx: fx.fine / w, dy: fy.fine / h, residual: n ? s / n : 0 };
}

/** The scales tried: fine near 1 (a slow push in over a second is about half a percent a frame), coarser further out. */
const ZOOM_STEPS = [0.94, 0.96, 0.97, 0.98, 0.985, 0.99, 0.995, 1, 1.005, 1.01, 1.015, 1.02, 1.03, 1.04, 1.06];

/**
 * Zoom between two frames: the scale about the centre (0.94 … 1.06) that best maps a onto b. Above
 * 1 the picture grows (a push in), below 1 it shrinks (a pull out). Rough; 1 when nothing fits better.
 */
export function zoomHint(a: Float32Array, b: Float32Array, w: number, h: number, sx = 0, sy = 0): number {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  let best = 1;
  let bestErr = Infinity;
  for (const s of ZOOM_STEPS) {
    let err = 0;
    let n = 0;
    // b at (x, y) shows what a showed at the point scaled back toward the centre, once the camera's shift (sx, sy pixels) is taken off.
    for (let y = Math.floor(h * 0.15); y < h * 0.85; y++)
      for (let x = Math.floor(w * 0.15); x < w * 0.85; x++) {
        const ax = Math.round(cx + (x - sx - cx) / s);
        const ay = Math.round(cy + (y - sy - cy) / s);
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        err += Math.abs(b[y * w + x] - a[ay * w + ax]);
        n++;
      }
    err = err / Math.max(1, n) + Math.abs(s - 1) * 0.002;
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

/* ───────────── Shot boundaries ───────────── */

export interface Boundary {
  /** Seconds: the first frame of the new shot (a cut), or the middle of a dissolve. */
  t: number;
  kind: "cut" | "fade";
  /** For a fade, its first and last frame times. */
  from?: number;
  to?: number;
  /** How strong the change was (histogram distance). */
  strength: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export interface CutOptions {
  /** A frame change must be at least this (histogram distance) to be a cut. */
  floor?: number;
  /** … and this many times the local median change around it. */
  ratio?: number;
  /** Frames each side for the local median. */
  radius?: number;
  /** Detect gradual transitions (dissolves, fades) by accumulated change (twin comparison). */
  fades?: boolean;
}

/**
 * Shot boundaries from consecutive frames' histograms and grey copies, with an adaptive
 * threshold: frame i starts a new shot when its change from frame i−1 (histogram distance, with the
 * grey difference as a second vote) is a local peak, above an absolute floor and well above the
 * median change of the frames around it, so a busy handheld shot does not cut itself to pieces and
 * a calm one still shows its cuts. With `fades`, a run of moderate changes whose ends differ as much
 * as a cut does is a gradual transition (Zhang et al.'s twin comparison).
 */
export function detectBoundaries(frames: readonly Pick<FrameFeatures, "t" | "hist" | "grey" | "pair" | "hash">[], opts: CutOptions = {}): Boundary[] {
  const n = frames.length;
  if (n < 2) return [];
  const floor = opts.floor ?? 0.28;
  const ratio = opts.ratio ?? 3;
  const radius = opts.radius ?? 6;
  const d: number[] = [0];
  const g: number[] = [0];
  const hm: number[] = [0];
  for (let i = 1; i < n; i++) {
    d.push(histDistance(frames[i - 1].hist, frames[i].hist));
    g.push(frames[i].pair?.grey ?? greyDiff(frames[i - 1].grey, frames[i].grey));
    hm.push(hamming(frames[i - 1].hash, frames[i].hash));
  }
  const localMedian = (xs: number[], i: number) => {
    const around: number[] = [];
    for (let k = Math.max(1, i - radius); k <= Math.min(n - 1, i + radius); k++) if (k !== i) around.push(xs[k]);
    return median(around);
  };
  const isPeak = (xs: number[], i: number) => xs[i] >= (xs[i - 1] ?? 0) && xs[i] >= (xs[i + 1] ?? 0);
  const out: Boundary[] = [];
  const isCut: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    const local = localMedian(d, i);
    const gLocal = localMedian(g, i);
    const hLocal = localMedian(hm, i);
    // A dissolve's frames change steadily: a histogram jump there (colours crossing a bin edge) is not a cut unless the picture jumps too.
    const strongHist = isPeak(d, i) && d[i] > floor && d[i] > ratio * local + 0.02 && (d[i] > 0.6 || g[i] > 2 * gLocal + 0.01);
    // Same colours, new picture (a cut between two shots of one scene): the grey difference votes.
    const strongGrey = isPeak(g, i) && g[i] > 0.12 && g[i] > ratio * gLocal + 0.03 && d[i] > floor * 0.4;
    // A dark or low-contrast scene changes little in colour and grey level; its structure (the hash) still jumps at a cut.
    const strongHash = isPeak(hm, i) && hm[i] >= 22 && hm[i] > ratio * hLocal + 4 && g[i] > 2 * gLocal + 0.004;
    if ((strongHist || strongGrey || strongHash) && !isCut[i - 1]) {
      isCut[i] = true;
      out.push({ t: frames[i].t, kind: "cut", strength: d[i] });
    }
  }
  if (opts.fades) {
    const low = Math.max(0.03, floor * 0.18);
    let i = 1;
    while (i < n) {
      if (isCut[i] || d[i] < low) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && !isCut[j + 1] && d[j + 1] >= low * 0.7) j++;
      const len = j - i + 1;
      if (len >= 3) {
        const total = histDistance(frames[i - 1].hist, frames[j].hist);
        if (total > floor * 1.3) {
          // A change this steady over 3 or more frames whose ends differ like a cut: a dissolve or fade.
          const from = frames[i - 1].t;
          const to = frames[j].t;
          out.push({ t: (from + to) / 2, kind: "fade", from, to, strength: total });
        }
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Shots between the boundaries: [start, end) in seconds; a fade's span belongs to neither shot. */
export function shotsFrom(boundaries: readonly Boundary[], duration: number): { start: number; end: number }[] {
  const shots: { start: number; end: number }[] = [];
  let start = 0;
  for (const b of boundaries) {
    const end = b.kind === "fade" ? (b.from ?? b.t) : b.t;
    if (end - start > 1e-3) shots.push({ start, end });
    start = b.kind === "fade" ? (b.to ?? b.t) : b.t;
  }
  if (duration - start > 1e-3) shots.push({ start, end: duration });
  return shots;
}

/* ───────────── Windows of footage, scored ───────────── */

export type WindowFlag = "dark" | "bright" | "flat" | "blurry" | "shaky" | "cut" | "fade";

/** A half second of footage, scored for the auto edit. */
export interface WindowScore {
  /** Window start, source seconds. */
  t: number;
  /** 0 … 1: how usable the picture is (sharp, exposed, steady, not blank). */
  quality: number;
  /** 0 … 1: how much happens (subject movement first, the camera's second), relative to the source. */
  action: number;
  /** Mean brightness, 0 … 1. */
  luma: number;
  /** Where the detail is, 0 … 1 (left to right). */
  focus: number;
  hash: string;
  flags: WindowFlag[];
  /** Focus (the sharpest tile's Laplacian variance), for the report. */
  sharp?: number;
  /** A text guess for the window (the band's centre, 0 … 1), when most of its frames show one. */
  textY: number | null;
}

export interface MotionSample {
  t: number;
  /** What moves beyond the camera (0 … 1). */
  action: number;
  /** The camera's movement, fraction of the frame per second. */
  camera: number;
  zoom: number;
  /** Frame-to-frame shift for shake: x, y (fractions). */
  dx: number;
  dy: number;
}

/** Each frame's movement against the one before (the first frame copies the second). */
export function motionSeries(frames: readonly FrameFeatures[]): MotionSample[] {
  const out: MotionSample[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const dt = Math.max(1e-3, b.t - a.t);
    const m = b.pair ?? linkFrames(a, b);
    out.push({ t: b.t, action: m.residual, camera: Math.hypot(m.dx, m.dy) / dt, zoom: m.zoom, dx: m.dx, dy: m.dy });
  }
  if (out.length) out.unshift({ ...out[0], t: frames[0].t });
  else if (frames.length) out.push({ t: frames[0].t, action: 0, camera: 0, zoom: 1, dx: 0, dy: 0 });
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

/** Thresholds of the window flags; tuned on the Blender open movies' footage (docs/video-editor.md → Edit quality). */
export const QUALITY = {
  /** Mean luma below this is dark, above this (with many clipped pixels) blown out. */
  dark: 0.11,
  bright: 0.85,
  /** A frame this flat (grey spread) is blank: black, white, a plain card. */
  flat: 0.045,
  /** Laplacian variance below this is soft at the analysis size (about 160 px wide). */
  blurry: 0.004,
  /** Frame-to-frame shift jitter (fraction of the frame) above this is shake. */
  shaky: 0.02,
};

/**
 * The footage scored per `step` seconds (half a second by default): its quality (sharpness against
 * the source's sharpest stretch and an absolute floor, exposure, clipping, steadiness, not blank),
 * its action (what moves, relative to the source's busiest stretch, with the camera's movement
 * counted at half), and flags for what makes a window unusable: inside a cut or fade of the
 * footage, dark, blown out, flat, blurry, shaky.
 */
export function scoreWindows(frames: readonly FrameFeatures[], motion: readonly MotionSample[], boundaries: readonly Boundary[], duration: number, step = 0.5): WindowScore[] {
  const n = Math.max(1, Math.floor(duration / step + 1e-6));
  const sharpRef = Math.max(QUALITY.blurry * 2, pct(frames.map((f) => f.sharp), 0.9));
  const detail = (f: FrameFeatures) => Math.sqrt(f.sharp * (f.sharpMid ?? f.sharp));
  const detailRef = Math.max(QUALITY.blurry, pct(frames.map(detail), 0.9));
  const actRef = Math.max(0.01, pct(motion.map((m) => m.action + 0.5 * Math.min(0.2, m.camera * 0.1)), 0.9));
  const out: WindowScore[] = [];
  for (let w = 0; w < n; w++) {
    const t0 = w * step;
    const t1 = Math.min(duration, t0 + step);
    const fs = frames.filter((f) => f.t >= t0 - 1e-6 && f.t < t1 - 1e-6);
    const ms = motion.filter((m) => m.t >= t0 - 1e-6 && m.t < t1 - 1e-6);
    const flags: WindowFlag[] = [];
    if (boundaries.some((b) => b.kind === "cut" && b.t > t0 + 1e-6 && b.t < t1 - 1e-6)) flags.push("cut");
    if (boundaries.some((b) => b.kind === "fade" && (b.from ?? b.t) < t1 && (b.to ?? b.t) > t0)) flags.push("fade");
    if (!fs.length) {
      out.push({ t: t0, quality: 0, action: 0, luma: 0, focus: 0.5, hash: "0".repeat(16), flags: [...flags, "flat"], textY: null });
      continue;
    }
    const avg = (f: (x: FrameFeatures) => number) => fs.reduce((s, x) => s + f(x), 0) / fs.length;
    const luma = avg((f) => f.luma);
    const contrast = avg((f) => f.contrast);
    const bright = avg((f) => f.bright);
    const dark = avg((f) => f.dark);
    const sharp = avg((f) => f.sharp);
    if (luma < QUALITY.dark) flags.push("dark");
    if (luma > QUALITY.bright || bright > 0.45) flags.push("bright");
    if (contrast < QUALITY.flat) flags.push("flat");
    if (sharp < QUALITY.blurry || sharp < sharpRef * 0.1) flags.push("blurry");
    // Shake: the frame-to-frame shift that a steady pan or a still camera would not have (its jitter).
    let jitter = 0;
    if (ms.length >= 3) {
      let s = 0;
      for (let i = 1; i < ms.length - 1; i++) s += Math.hypot(ms[i].dx - (ms[i - 1].dx + ms[i + 1].dx) / 2, ms[i].dy - (ms[i - 1].dy + ms[i + 1].dy) / 2);
      jitter = s / (ms.length - 2);
      // The median, so one mis-read frame does not make a steady shot shaky.
      const js: number[] = [];
      for (let i = 1; i < ms.length - 1; i++) js.push(Math.hypot(ms[i].dx - (ms[i - 1].dx + ms[i + 1].dx) / 2, ms[i].dy - (ms[i - 1].dy + ms[i + 1].dy) / 2));
      jitter = Math.min(jitter, median(js) * 1.5);
    }
    if (jitter > QUALITY.shaky) flags.push("shaky");
    // Quality wants the frame sharp across (the sharpest and the median tile), so a soft foreground across the picture counts against it.
    const sharpQ = Math.min(1, avg(detail) / (detailRef * 0.6));
    const exposureQ = Math.max(0, 1 - Math.abs(luma - 0.45) * 1.4) * (1 - Math.min(0.6, dark * 0.8 + bright * 0.8));
    const steadyQ = Math.max(0.3, 1 - jitter / (QUALITY.shaky * 2.5));
    const contrastQ = Math.min(1, contrast / 0.18);
    let quality = Math.sqrt(sharpQ) * 0.4 + exposureQ * 0.3 + contrastQ * 0.15 + steadyQ * 0.15;
    if (flags.some((f) => f === "flat" || f === "dark" || f === "cut" || f === "fade")) quality *= 0.15;
    else if (flags.length) quality *= 0.5;
    const action = ms.length ? Math.min(1, ms.reduce((s, m) => s + m.action + 0.5 * Math.min(0.2, m.camera * 0.1), 0) / ms.length / actRef) : 0;
    const mid = fs[Math.floor(fs.length / 2)];
    const texts = fs.map((f) => f.textY).filter((y): y is number => y !== null);
    out.push({ t: t0, quality: round3(quality), action: round3(action), luma: round3(luma), focus: round3(avg((f) => f.focusX)), sharp: Math.round(sharp * 1e5) / 1e5, hash: mid.hash, flags, textY: texts.length > fs.length / 2 ? round3(median(texts)) : null });
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The footage's whole reading: windows, its own shots (between cuts and fades), and the motion series for cut points. */
export interface FootageAnalysis {
  duration: number;
  step: number;
  windows: WindowScore[];
  shots: { start: number; end: number }[];
  boundaries: Boundary[];
  /** Movement per analysed frame (action and camera), for placing cuts where the picture is still. */
  motion: { t: number; v: number }[];
}

/** Frames → the analysis the planners use. The frames are expected in time order, a few per second or more. */
export function analyseFootage(frames: readonly FrameFeatures[], duration: number, opts: { step?: number; cuts?: CutOptions } = {}): FootageAnalysis {
  const boundaries = detectBoundaries(frames, { fades: true, ...opts.cuts });
  const motion = motionSeries(frames);
  const windows = scoreWindows(frames, motion, boundaries, duration, opts.step ?? 0.5);
  return { duration, step: opts.step ?? 0.5, windows, shots: shotsFrom(boundaries, duration), boundaries, motion: motion.map((m) => ({ t: round3(m.t), v: round3(m.action + 0.5 * Math.min(0.2, m.camera * 0.1)) })) };
}
