/**
 * Exact product mode: the real product photo is cut out and set into the generated scene, so
 * its pixels never change. The image engine only paints the place around it; this file does the
 * pixel work (cut-out, size, shadows) on plain RGBA arrays, with Photon for decoding and resizing.
 */

/** RGBA pixels with their size. */
export interface Raster {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Normalised box [ymin, xmin, ymax, xmax] in 0..1000, as the vision model returns it. */
export type Box = [number, number, number, number];

export type Light = "left" | "right" | "front" | "top" | "back";

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * The product photo's own background, when it is plain: its border is one even colour. Returns
 * that colour, or null for a busy background (a photo of the product in a scene).
 */
export function plainBackground(img: Raster): [number, number, number] | null {
  const { data, width: w, height: h } = img;
  const samples: number[][] = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 60));
  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < w; x += step) {
    at(x, 0);
    at(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    at(0, y);
    at(w - 1, y);
  }
  const mean = [0, 1, 2].map((c) => samples.reduce((s, p) => s + p[c], 0) / samples.length);
  const spread = samples.filter((p) => Math.abs(p[0] - mean[0]) + Math.abs(p[1] - mean[1]) + Math.abs(p[2] - mean[2]) > 42).length;
  return spread / samples.length < 0.06 ? [mean[0], mean[1], mean[2]] : null;
}

/**
 * Alpha of a product on a plain background: everything connected to the border that is close to
 * the background colour becomes transparent (a flood fill, so light parts inside the product stay).
 */
export function alphaFromBackground(img: Raster, bg: [number, number, number], tolerance = 38): Uint8Array {
  const { data, width: w, height: h } = img;
  const alpha = new Uint8Array(w * h).fill(255);
  const near = (p: number) => {
    const i = p * 4;
    return Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) <= tolerance;
  };
  const stack: number[] = [];
  const push = (p: number) => {
    if (alpha[p] === 255 && near(p)) {
      alpha[p] = 0;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  // The outermost ring still carries some of the background colour: it goes too.
  const inner = new Uint8Array(alpha);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (alpha[p] && (!alpha[p - 1] || !alpha[p + 1] || !alpha[p - w] || !alpha[p + w])) inner[p] = 0;
    }
  return soften(inner, w, h);
}

/** Alpha from a black-and-white mask (white = product), as the image model draws it. */
export function alphaFromMask(mask: Raster, w: number, h: number): Uint8Array {
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / h));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / w));
      const i = (my * mask.width + mx) * 4;
      const l = lum(mask.data[i], mask.data[i + 1], mask.data[i + 2]);
      alpha[y * w + x] = l <= 60 ? 0 : l >= 195 ? 255 : Math.round(((l - 60) / 135) * 255);
    }
  }
  return soften(alpha, w, h);
}

/** A one-pixel feather so the cut edge is not jagged. */
function soften(alpha: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += alpha[yy * w + xx];
          n++;
        }
      out[y * w + x] = Math.round(s / n);
    }
  return out;
}

/** Share of the frame the alpha covers: a usable cut-out is neither empty nor the whole photo. */
export function coverage(alpha: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 127) n++;
  return n / alpha.length;
}

/** The product with its alpha, cropped to what is visible. */
export function cutout(img: Raster, alpha: Uint8Array): Raster {
  const { width: w, height: h } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha[y * w + x] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { data: new Uint8Array(4), width: 1, height: 1 };
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const data = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const s = ((y + y0) * w + (x + x0)) * 4;
      const d = (y * cw + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = alpha[(y + y0) * w + (x + x0)];
    }
  return { data, width: cw, height: ch };
}

/**
 * Where the product goes, in scene pixels: inside the box the vision model chose (its real size in
 * the scene), keeping the photo's proportions, standing on the box's bottom edge, centred.
 */
export function placement(
  box: Box,
  scene: { width: number; height: number },
  product: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.max(0, Math.min(1000, v)));
  const bw = ((xmax - xmin) / 1000) * scene.width;
  const bh = ((ymax - ymin) / 1000) * scene.height;
  const ratio = product.width / product.height;
  let width = bw;
  let height = width / ratio;
  if (height > bh) {
    height = bh;
    width = height * ratio;
  }
  // Never a giant: at most 70% of the frame's width or height.
  const cap = Math.min((scene.width * 0.7) / width, (scene.height * 0.7) / height, 1);
  width *= cap;
  height *= cap;
  const cx = ((xmin + xmax) / 2000) * scene.width;
  const bottom = (ymax / 1000) * scene.height;
  return {
    x: Math.round(cx - width / 2),
    y: Math.round(Math.min(scene.height - height, bottom - height)),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** A box blur of a single channel (three passes approximate a Gaussian). */
function blur(src: Float32Array<ArrayBuffer>, w: number, h: number, r: number): Float32Array<ArrayBuffer> {
  if (r < 1) return src;
  let a = src;
  let b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = s / (2 * r + 1);
        s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += a[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        b[y * w + x] = s / (2 * r + 1);
        s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

/**
 * Sets the product (already resized to `at`) into the scene: a soft contact shadow where it
 * stands, a cast shadow away from the light, then the product's own pixels, unchanged.
 */
export function composite(scene: Raster, product: Raster, at: { x: number; y: number }, light: Light = "front"): Raster {
  const out = new Uint8Array(scene.data);
  const W = scene.width;
  const H = scene.height;
  const pw = product.width;
  const ph = product.height;
  // The shadow layer covers the product plus a margin, at a quarter of the size for speed.
  const k = 4;
  const margin = Math.round(Math.max(pw, ph) * 0.35);
  const sx0 = at.x - margin;
  const sy0 = at.y - margin;
  const sw = Math.ceil((pw + margin * 2) / k);
  const sh = Math.ceil((ph + margin * 2) / k);
  const shadow = new Float32Array(sw * sh);
  const dir = light === "left" ? 1 : light === "right" ? -1 : 0;
  const offX = Math.round((dir * pw * 0.06) / k);
  const offY = Math.round((ph * (light === "top" ? 0.01 : 0.03)) / k);
  // Cast shadow: the product's silhouette, moved away from the light.
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const px = x * k - margin - offX * k;
      const py = y * k - margin - offY * k;
      if (px < 0 || py < 0 || px >= pw || py >= ph) continue;
      shadow[y * sw + x] = product.data[(py * pw + px) * 4 + 3] / 255;
    }
  const cast = blur(shadow, sw, sh, Math.max(1, Math.round((pw * 0.035) / k)));
  // Contact shadow: a flat ellipse along the base.
  const baseY = (margin + ph) / k;
  const cx = (margin + pw / 2) / k + offX * 0.5;
  const rx = (pw * 0.5) / k;
  const ry = Math.max(1, (ph * 0.035) / k);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - baseY) / ry) ** 2;
      const contact = d < 1 ? (1 - d) ** 1.5 : 0;
      cast[y * sw + x] = Math.min(1, cast[y * sw + x] * 0.28 + contact * 0.5);
    }
  // Darken the scene under the shadow (multiply toward a warm black).
  for (let y = 0; y < sh * k; y++) {
    const Y = sy0 + y;
    if (Y < 0 || Y >= H) continue;
    for (let x = 0; x < sw * k; x++) {
      const X = sx0 + x;
      if (X < 0 || X >= W) continue;
      const s = cast[Math.floor(y / k) * sw + Math.floor(x / k)];
      if (s <= 0.002) continue;
      const i = (Y * W + X) * 4;
      out[i] = out[i] * (1 - s * 0.92);
      out[i + 1] = out[i + 1] * (1 - s * 0.94);
      out[i + 2] = out[i + 2] * (1 - s * 0.96);
    }
  }
  // The product itself, blended into the scene but never redrawn: its shape, print and packaging
  // stay the photo's. Only how it sits in this light moves a little: the scene's white balance and
  // brightness (a light touch), a soft shade on the side away from the light, edges softened by a
  // pixel or two, and the scene's colour wrapping its rim.
  const b = blendFor(scene, product, at, light);
  for (let y = 0; y < ph; y++) {
    const Y = at.y + y;
    if (Y < 0 || Y >= H) continue;
    for (let x = 0; x < pw; x++) {
      const X = at.x + x;
      if (X < 0 || X >= W) continue;
      const s = (y * pw + x) * 4;
      const a = b.alpha[y * pw + x];
      if (a <= 0.004) continue;
      const i = (Y * W + X) * 4;
      const shade = 1 - b.shade(x / pw, y / ph);
      const wrap = b.wrap[y * pw + x];
      for (let c = 0; c < 3; c++) {
        const toned = Math.min(255, product.data[s + c] * b.gain[c] * shade);
        const rim = toned * (1 - wrap) + out[i + c] * wrap;
        out[i + c] = rim * a + out[i + c] * (1 - a);
      }
      out[i + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/** Mean colour of the pixels a test lets through, or null when there are none. */
function meanColour(img: Raster, x0: number, y0: number, x1: number, y1: number, keep: (x: number, y: number, i: number) => boolean): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  const step = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 160));
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y += step)
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x += step) {
      const i = (y * img.width + x) * 4;
      if (!keep(x, y, i)) continue;
      r += img.data[i];
      g += img.data[i + 1];
      bl += img.data[i + 2];
      n++;
    }
  return n ? [r / n, g / n, bl / n] : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How the product blends into this scene: a colour gain toward the scene's white balance and
 * brightness (capped, so the product's colours stay its own), a soft alpha edge, a rim of the
 * scene's colour around it, and a shade on the side away from the light.
 */
export function blendFor(scene: Raster, product: Raster, at: { x: number; y: number }, light: Light) {
  const pw = product.width;
  const ph = product.height;
  // The scene right around the product (a ring a quarter of its size), and the product itself.
  const mx = Math.round(pw * 0.25);
  const my = Math.round(ph * 0.25);
  const around = meanColour(scene, at.x - mx, at.y - my, at.x + pw + mx, at.y + ph + my, (x, y) => x < at.x || x >= at.x + pw || y < at.y || y >= at.y + ph);
  const own = meanColour(product, 0, 0, pw, ph, (_x, _y, i) => product.data[i + 3] > 128);
  let gain: [number, number, number] = [1, 1, 1];
  if (around && own) {
    const sGrey = (around[0] + around[1] + around[2]) / 3 || 1;
    const pGrey = (own[0] + own[1] + own[2]) / 3 || 1;
    const bright = clamp(1 + 0.18 * (lum(...around) / Math.max(1, lum(...own)) - 1), 0.88, 1.06);
    gain = [0, 1, 2].map((c) => clamp(1 + 0.3 * ((around[c] / sGrey) / ((own[c] / pGrey) || 1) - 1), 0.93, 1.07) * bright) as [number, number, number];
  }
  // Edges: the cut-out's alpha softened by a pixel or two; the rim takes the scene's colour.
  const raw = new Float32Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) raw[i] = product.data[i * 4 + 3] / 255;
  const soft = blur(raw, pw, ph, Math.max(1, Math.round(Math.min(pw, ph) * 0.003)));
  const wide = blur(raw, pw, ph, Math.max(2, Math.round(Math.min(pw, ph) * 0.012)));
  const alpha = new Float32Array(pw * ph);
  const wrap = new Float32Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) {
    alpha[i] = Math.min(raw[i], soft[i] * 1.15);
    wrap[i] = raw[i] > 0 ? 0.3 * clamp(1 - wide[i], 0, 1) : 0;
  }
  // The side away from the light falls a little into shade (u, v: 0..1 across the product).
  const shade = (u: number, v: number) =>
    light === "left" ? 0.1 * u : light === "right" ? 0.1 * (1 - u) : light === "back" ? 0.06 : 0.07 * v;
  return { gain, alpha, wrap, shade };
}

