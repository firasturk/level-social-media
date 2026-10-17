/**
 * Draws a post's overlay (logo, headline, sub-line, scrim) on a canvas over the generated image,
 * using the client's fonts and the overlay spec. Used for previews and for the export.
 */
import type { AnimationPreset, OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import { HOSTED_FONTS } from "@shared/overlay";

export interface OverlayText {
  headline?: string;
  subline?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the logo and the text block landed, in canvas pixels, for the on-image editor. */
export interface OverlayLayout {
  logo: Rect | null;
  text: Rect | null;
}

export interface DrawOptions {
  patch?: PostOverlayPatch;
  /** Entry animation state: progress 0..1 of the chosen preset. */
  anim?: { preset: AnimationPreset; progress: number };
}

const loadedFonts = new Map<string, Promise<void>>();

/** Loads an uploaded brand font once; hosted Google fonts come from the stylesheet in index.html. */
export function loadFont(name: string, url: string): Promise<void> {
  const key = `${name}|${url}`;
  let p = loadedFonts.get(key);
  if (!p) {
    p = (async () => {
      const face = new FontFace(name, `url(${url})`);
      await face.load();
      document.fonts.add(face);
    })().catch(() => undefined);
    loadedFonts.set(key, p);
  }
  return p;
}

const images = new Map<string, Promise<HTMLImageElement>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image failed to load."));
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function fontStack(family: string): string {
  const quoted = `"${family.replace(/"/g, "")}"`;
  if (HOSTED_FONTS.includes(family)) return `${quoted}, Tajawal, sans-serif`;
  return `${quoted}, Tajawal, Inter, sans-serif`;
}

/** Wraps text to the width, splitting on spaces; a single long word is kept whole. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (ctx.measureText(probe).width <= maxWidth || !line) line = probe;
      else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Draws the overlay on a context whose canvas already holds the image. */
export async function drawOverlay(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  spec: OverlaySpec,
  text: OverlayText,
  logoSrc: string | null,
  opts: DrawOptions = {},
): Promise<OverlayLayout> {
  const layout: OverlayLayout = { logo: null, text: null };
  if (spec.template === "none") return layout;
  const patch = opts.patch ?? {};
  // A post can put its words elsewhere than the client's layout (a grid tile's own place).
  if (patch.position && patch.position !== spec.headline.position) spec = { ...spec, headline: { ...spec.headline, position: patch.position } };
  const anim = opts.anim;
  const p = anim ? Math.max(0, Math.min(1, anim.progress)) : 1;
  const ease = 1 - Math.pow(1 - p, 3);
  let headline = (text.headline ?? "").trim();
  let subline = spec.subline.show === false ? "" : (text.subline ?? "").trim();
  if (anim?.preset === "typewriter") {
    const total = headline.length + subline.length;
    const shown = Math.round(total * ease);
    if (shown < headline.length) {
      headline = headline.slice(0, shown);
      subline = "";
    } else subline = subline.slice(0, shown - headline.length);
  }
  const margin = spec.margin * W;
  const scale = patch.scale ?? 1;
  // A web font only downloads once something asks for it; a canvas never does on its own, so
  // without this the text silently falls back to the default face. Ask for the exact faces,
  // with the text itself so the right (Arabic or Latin) subset is fetched.
  await Promise.all([
    document.fonts.load(`${spec.headline.weight} 48px ${fontStack(spec.headline.font)}`, headline || "حب Ab"),
    document.fonts.load(
      `${spec.subline.weight} 32px ${fontStack(spec.subline.font || spec.headline.font)}`,
      subline || "حب Ab",
    ),
  ]).catch(() => []);
  await document.fonts.ready;

  // Scrim behind the text block.
  if (spec.scrim > 0 && patch.fade !== false && (headline || subline)) {
    const g =
      spec.headline.position === "top"
        ? ctx.createLinearGradient(0, 0, 0, H * 0.5)
        : spec.headline.position === "center"
          ? ctx.createLinearGradient(0, H * 0.2, 0, H * 0.8)
          : ctx.createLinearGradient(0, H, 0, H * 0.5);
    const c = spec.scrimColor;
    g.addColorStop(0, hexWithAlpha(c, spec.scrim));
    if (spec.headline.position === "center") {
      g.addColorStop(0.5, hexWithAlpha(c, spec.scrim));
      g.addColorStop(0, hexWithAlpha(c, 0));
    }
    g.addColorStop(1, hexWithAlpha(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // An official portrait (royal days): drawn exactly as uploaded, framed in the upper middle.
  if (patch.photo) {
    try {
      const img = await loadImage(patch.photo);
      const nw = img.naturalWidth || 400;
      const nh = img.naturalHeight || 500;
      let pw = W * 0.44;
      let ph = (pw * nh) / nw;
      if (ph > H * 0.46) {
        ph = H * 0.46;
        pw = (ph * nw) / nh;
      }
      const px = (W - pw) / 2;
      const py = H * 0.17;
      const border = W * 0.012;
      const r = W * 0.02;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = W * 0.04;
      ctx.shadowOffsetY = W * 0.012;
      ctx.fillStyle = "#ffffff";
      roundRect(ctx, px - border, py - border, pw + border * 2, ph + border * 2, r + border);
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundRect(ctx, px, py, pw, ph, r);
      ctx.clip();
      ctx.globalAlpha = anim ? ease : 1;
      ctx.drawImage(img, px, py, pw, ph);
      ctx.restore();
    } catch {
      /* the post shows without it */
    }
  }

  // Logo.
  if (logoSrc && spec.logo.position !== "none") {
    try {
      const img = await loadImage(logoSrc);
      const natural = img.naturalWidth || 300;
      const naturalH = img.naturalHeight || 150;
      const lw = (patch.logoWidth ?? spec.logo.width) * W;
      const lh = (lw * naturalH) / natural;
      const top = spec.logo.top * W;
      let x = (W - lw) / 2;
      let y = top;
      if (spec.logo.position === "top-left") x = margin;
      if (spec.logo.position === "top-right") x = W - margin - lw;
      if (spec.logo.position === "bottom-center") y = H - top - lh;
      x += (patch.logoDx ?? 0) * W;
      y += (patch.logoDy ?? 0) * W;
      ctx.drawImage(img, x, y, lw, lh);
      layout.logo = { x, y, w: lw, h: lh };
    } catch {
      /* no logo: the text still draws */
    }
  }

  // Corner logo (parent or partner mark), small, in one colour when the spec asks for it.
  const badge = spec.badge;
  if (badge?.src && badge.position !== "none") {
    try {
      const img = await loadImage(badge.src);
      const bw = badge.width * W;
      const bh = (bw * (img.naturalHeight || 100)) / (img.naturalWidth || 100);
      const inset = badge.inset * W;
      const x = badge.position.endsWith("left") ? inset : W - inset - bw;
      const y = badge.position.startsWith("top") ? inset : H - inset - bh;
      if (badge.color) {
        const tint = document.createElement("canvas");
        tint.width = Math.max(1, Math.round(bw));
        tint.height = Math.max(1, Math.round(bh));
        const tctx = tint.getContext("2d")!;
        tctx.drawImage(img, 0, 0, tint.width, tint.height);
        tctx.globalCompositeOperation = "source-in";
        tctx.fillStyle = badge.color;
        tctx.fillRect(0, 0, tint.width, tint.height);
        ctx.drawImage(tint, x, y, bw, bh);
      } else ctx.drawImage(img, x, y, bw, bh);
    } catch {
      /* no badge: the rest still draws */
    }
  }

  if (!headline && !subline) return layout;
  const h = spec.headline;
  const hSize = h.size * W * scale;
  const sSize = spec.subline.size * W * scale;
  const maxWidth = W - margin * 2;
  const rtl = ARABIC.test(headline + subline);
  ctx.textBaseline = "alphabetic";
  ctx.direction = rtl ? "rtl" : "ltr";
  const align = patch.align ?? h.align;
  ctx.textAlign = align;
  const dx = (patch.dx ?? 0) * W;
  const dy = (patch.dy ?? 0) * W;
  const x = (align === "center" ? W / 2 : align === "left" ? margin : W - margin) + dx;
  let headColor = patch.color ?? h.color;
  let subColor = patch.subColor ?? spec.subline.color;

  ctx.font = `${h.weight} ${hSize}px ${fontStack(h.font)}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${h.letterSpacing * hSize}px`;
  const hLines = headline ? wrap(ctx, headline, maxWidth) : [];
  ctx.font = `${spec.subline.weight} ${sSize}px ${fontStack(spec.subline.font || h.font)}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
  const sLines = subline ? wrap(ctx, subline, maxWidth) : [];
  const hLineH = hSize * h.lineHeight;
  const sLineH = sSize * 1.3;
  const gap = hLines.length && sLines.length ? spec.subline.gap * W : 0;
  const blockH = hLines.length * hLineH + gap + sLines.length * sLineH;
  let y: number;
  if (h.position === "top") y = h.inset * W;
  else if (h.position === "center") y = (H - blockH) / 2;
  else y = H - h.inset * W - blockH;
  y += dy;
  // The words never sit on the logo: a block that meets it moves below it (or above a bottom logo).
  const lg = layout.logo;
  if (lg) {
    const bx = align === "center" ? x - maxWidth / 2 : align === "left" ? x : x - maxWidth;
    const across = bx < lg.x + lg.w && bx + maxWidth > lg.x;
    const room = 0.025 * W;
    if (across && y < lg.y + lg.h + room && y + blockH > lg.y - room) {
      if (lg.y + lg.h / 2 < H / 2) y = lg.y + lg.h + room;
      else y = lg.y - room - blockH;
    }
  }
  layout.text = {
    x: align === "center" ? x - maxWidth / 2 : align === "left" ? x : x - maxWidth,
    y,
    w: maxWidth,
    h: blockH,
  };
  // Words that would vanish into the picture behind them (white on cream, navy on navy) take the
  // colour that reads on it.
  const behind = averageLuminance(ctx, layout.text.x, y, maxWidth, blockH);
  if (behind !== null) {
    headColor = readableOn(headColor, behind);
    subColor = readableOn(subColor, behind);
  }

  // Entry animation: fade, rise from below, or zoom in around the block's centre.
  ctx.save();
  if (anim && anim.preset !== "typewriter") {
    ctx.globalAlpha = ease;
    if (anim.preset === "rise") ctx.translate(0, (1 - ease) * 0.08 * W);
    if (anim.preset === "zoom") {
      const cx = x;
      const cy = y + blockH / 2;
      const k = 0.6 + 0.4 * ease;
      ctx.translate(cx, cy);
      ctx.scale(k, k);
      ctx.translate(-cx, -cy);
    }
  }

  // Headline lines (ascent ~ 0.8 em).
  ctx.font = `${h.weight} ${hSize}px ${fontStack(h.font)}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${h.letterSpacing * hSize}px`;
  for (const line of hLines) {
    const baseline = y + hSize * 0.82;
    if (h.shadow) {
      ctx.fillStyle = h.shadow;
      ctx.fillText(line, x, baseline + h.shadowOffset * W * scale);
    }
    ctx.fillStyle = headColor;
    ctx.fillText(line, x, baseline);
    y += hLineH;
  }
  y += gap;
  ctx.font = `${spec.subline.weight} ${sSize}px ${fontStack(spec.subline.font || h.font)}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
  ctx.fillStyle = subColor;
  for (const line of sLines) {
    ctx.fillText(line, x, y + sSize * 0.82);
    y += sLineH;
  }
  ctx.restore();
  return layout;
}

/** Relative luminance (0-1) of a #rrggbb colour; null for anything else. */
function luminanceOf(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
}

/** The picture's mean luminance under a block, or null when it cannot be read. */
function averageLuminance(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): number | null {
  try {
    const sx = Math.max(0, Math.round(x));
    const sy = Math.max(0, Math.round(y));
    const sw = Math.max(1, Math.min(ctx.canvas.width - sx, Math.round(w)));
    const sh = Math.max(1, Math.min(ctx.canvas.height - sy, Math.round(h)));
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    const step = Math.max(4, Math.floor(data.length / 4 / 4000) * 4);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += step) {
      const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
      n++;
    }
    return n ? sum / n : null;
  } catch {
    return null;
  }
}

/** The colour itself when it reads on the background (contrast 2.5:1), else a dark or a light ink. */
export function readableOn(color: string, behind: number): string {
  const l = luminanceOf(color);
  if (l === null) return color;
  const contrast = (Math.max(l, behind) + 0.05) / (Math.min(l, behind) + 0.05);
  if (contrast >= 2.5) return color;
  return behind > 0.35 ? "#1f1a17" : "#ffffff";
}

function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** The image with its overlay, as a canvas at the requested width (full size when omitted). */
export async function renderOverlay(
  imageSrc: string,
  spec: OverlaySpec,
  text: OverlayText,
  logoSrc: string | null,
  width?: number,
  opts: DrawOptions = {},
): Promise<HTMLCanvasElement> {
  const img = await loadImage(imageSrc);
  const W = width ?? img.naturalWidth;
  const H = Math.round((W * img.naturalHeight) / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, W, H);
  await drawOverlay(ctx, W, H, spec, text, logoSrc, opts);
  return canvas;
}

/** Draws image + overlay on an existing canvas (the editor and the animation preview reuse one). */
export async function paintFrame(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  spec: OverlaySpec,
  text: OverlayText,
  logoSrc: string | null,
  opts: DrawOptions = {},
): Promise<OverlayLayout> {
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return drawOverlay(ctx, canvas.width, canvas.height, spec, text, logoSrc, opts);
}

export { loadImage };

/** The video MIME type this browser can record, MP4 where available (Safari, newer Chrome), else WebM. */
export function videoMime(): { mime: string; ext: string } {
  const candidates: [string, string][] = [
    ["video/mp4;codecs=avc1", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm", "webm"],
  ];
  for (const [mime, ext] of candidates)
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime))
      return { mime, ext };
  return { mime: "video/webm", ext: "webm" };
}

/**
 * Records the entry animation of the text over the still image as a short video: `seconds` of
 * motion then a hold, at `fps`, rendered on a canvas of `width` pixels.
 */
export async function recordAnimation(
  imageSrc: string,
  spec: OverlaySpec,
  text: OverlayText,
  logoSrc: string | null,
  options: {
    preset: AnimationPreset;
    seconds: number;
    hold: number;
    fps: number;
    width: number;
    patch?: PostOverlayPatch;
  },
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  const img = await loadImage(imageSrc);
  const W = options.width;
  const H = Math.round((W * img.naturalHeight) / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const { mime, ext } = videoMime();
  const stream = canvas.captureStream(options.fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
  });
  const frame = (progress: number) =>
    paintFrame(canvas, img, spec, text, logoSrc, {
      patch: options.patch,
      anim: { preset: options.preset, progress },
    });
  await frame(0);
  recorder.start(200);
  const total = options.seconds + options.hold;
  const frames = Math.round(total * options.fps);
  const frameMs = 1000 / options.fps;
  for (let i = 0; i <= frames; i++) {
    const t = i / options.fps;
    await frame(Math.min(1, t / options.seconds));
    onProgress?.(i / frames);
    await new Promise((r) => setTimeout(r, frameMs));
  }
  recorder.stop();
  const blob = await done;
  return { blob, ext };
}

export function canvasBlob(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))), "image/jpeg", quality),
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
