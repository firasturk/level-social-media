/**
 * Draws a post's overlay (logo, headline, sub-line, scrim) on a canvas over the generated image,
 * using the client's fonts and the overlay spec. Used for previews and for the export.
 */
import type { OverlaySpec } from "@shared/overlay";
import { HOSTED_FONTS } from "@shared/overlay";

export interface OverlayText {
  headline?: string;
  subline?: string;
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
): Promise<void> {
  if (spec.template === "none") return;
  const headline = (text.headline ?? "").trim();
  const subline = (text.subline ?? "").trim();
  const margin = spec.margin * W;
  await document.fonts.ready;

  // Scrim behind the text block.
  if (spec.scrim > 0 && (headline || subline)) {
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

  // Logo.
  if (logoSrc && spec.logo.position !== "none") {
    try {
      const img = await loadImage(logoSrc);
      const natural = img.naturalWidth || 300;
      const naturalH = img.naturalHeight || 150;
      const lw = spec.logo.width * W;
      const lh = (lw * naturalH) / natural;
      const top = spec.logo.top * W;
      let x = (W - lw) / 2;
      let y = top;
      if (spec.logo.position === "top-left") x = margin;
      if (spec.logo.position === "top-right") x = W - margin - lw;
      if (spec.logo.position === "bottom-center") y = H - top - lh;
      ctx.drawImage(img, x, y, lw, lh);
    } catch {
      /* no logo: the text still draws */
    }
  }

  if (!headline && !subline) return;
  const h = spec.headline;
  const hSize = h.size * W;
  const sSize = spec.subline.size * W;
  const maxWidth = W - margin * 2;
  const rtl = ARABIC.test(headline + subline);
  ctx.textBaseline = "alphabetic";
  ctx.direction = rtl ? "rtl" : "ltr";
  const align = h.align;
  ctx.textAlign = align;
  const x = align === "center" ? W / 2 : align === "left" ? margin : W - margin;

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

  // Headline lines (ascent ~ 0.8 em).
  ctx.font = `${h.weight} ${hSize}px ${fontStack(h.font)}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${h.letterSpacing * hSize}px`;
  for (const line of hLines) {
    const baseline = y + hSize * 0.82;
    if (h.shadow) {
      ctx.fillStyle = h.shadow;
      ctx.fillText(line, x, baseline + h.shadowOffset * W);
    }
    ctx.fillStyle = h.color;
    ctx.fillText(line, x, baseline);
    y += hLineH;
  }
  y += gap;
  ctx.font = `${spec.subline.weight} ${sSize}px ${fontStack(spec.subline.font || h.font)}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
  ctx.fillStyle = spec.subline.color;
  for (const line of sLines) {
    ctx.fillText(line, x, y + sSize * 0.82);
    y += sLineH;
  }
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
): Promise<HTMLCanvasElement> {
  const img = await loadImage(imageSrc);
  const W = width ?? img.naturalWidth;
  const H = Math.round((W * img.naturalHeight) / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, W, H);
  await drawOverlay(ctx, W, H, spec, text, logoSrc);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))), "image/jpeg", quality),
  );
}
