/**
 * Draws a post's overlay (logo, headline, sub-line, scrim) on a canvas over the generated image,
 * using the client's fonts and the overlay spec. Used for previews and for the export.
 */
import type { AnimationPreset, OverlaySpec, PostOverlayPatch, TextPosition } from "@shared/overlay";
import { HEADLINE_FONTS, HOSTED_FONTS, LATIN_FONTS } from "@shared/overlay";
import type { PostTypography, SubjectMask } from "@shared/typography";

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
  /** Faces in the picture as [x, y, w, h] fractions (from the review): the words never sit on one. */
  faces?: number[][];
  /** Entry animation state: progress 0..1 of the chosen preset. */
  anim?: { preset: AnimationPreset; progress: number };
}

const loadedFonts = new Map<string, Promise<void>>();

/** The faces the review stored on a task's QA, for the renderer to keep the words off them. */
export function facesOf(qa: string | null | undefined): number[][] {
  if (!qa) return [];
  try {
    const f = (JSON.parse(qa) as { faces?: unknown }).faces;
    return Array.isArray(f) ? (f as number[][]).filter((x) => Array.isArray(x) && x.length === 4) : [];
  } catch {
    return [];
  }
}

/** A luminance-free reading of whether a colour is (near) white. */
function isWhite(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const v = parseInt(m[1], 16);
  return ((v >> 16) & 255) > 235 && ((v >> 8) & 255) > 235 && (v & 255) > 235;
}
/** The ink that reads on a solid colour: dark on light, white on dark. */
function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const l = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return l > 0.6 ? "#1f1a17" : "#ffffff";
}

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
  const faceRects: Rect[] = (opts.faces ?? []).map((f) => ({ x: f[0] * W, y: f[1] * H, w: f[2] * W, h: f[3] * H }));
  // Typography: the picture as it is, kept to draw the product back over its letters.
  const typo = !anim && headline ? patch.typo : undefined;
  const base = typo ? copyCanvas(ctx.canvas) : null;
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
  if (spec.scrim > 0 && patch.fade !== false && !typo && (headline || subline)) {
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
  const typeset = typo && base ? await drawTypography(ctx, W, H, spec, { ...typo, color: typo.color || patch.color || "" }, headline, subline, base, layout.logo, scale, patch, faceRects) : null;
  if (typeset) {
    layout.text = typeset;
    return layout;
  }
  const h = spec.headline;
  // The words never take more than a third of the picture, whatever a tile's "huge" asks.
  const cap = Math.min(scale, (0.34 * H) / Math.max(1, h.size * W * 2.4));
  const hSize = h.size * W * Math.max(0.5, cap);
  const sSize = spec.subline.size * W * Math.max(0.5, cap);
  const maxWidth = W - margin * 2;
  const rtl = ARABIC.test(headline + subline);
  ctx.textBaseline = "alphabetic";
  ctx.direction = rtl ? "rtl" : "ltr";
  const align = patch.align ?? h.align;
  ctx.textAlign = align;
  const dx = (patch.dx ?? 0) * W;
  const dy = (patch.dy ?? 0) * W;
  const x = (align === "center" ? W / 2 : align === "left" ? margin : W - margin) + dx;
  const headColor = patch.color ?? h.color;
  const subColor = patch.subColor ?? spec.subline.color;

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
  const yFor = (pos: TextPosition) => (pos === "top" ? h.inset * W : pos === "center" ? (H - blockH) / 2 : H - h.inset * W - blockH);
  let y = yFor(h.position) + dy;
  const bx0 = align === "center" ? x - maxWidth / 2 : align === "left" ? x : x - maxWidth;
  // Unless the designer moved the words by hand, they go where the picture is calm: a block set
  // over the product (busy detail) moves to the calmest of the three places.
  if (!patch.dx && !patch.dy && headline) {
    const energy = (yy: number) => detailEnergy(ctx, bx0, yy, maxWidth, blockH);
    const here = energy(y);
    const options: TextPosition[] = ["bottom", "top", "center"];
    const best = options.map((pos) => ({ pos, e: energy(yFor(pos)) })).sort((a, b) => a.e - b.e)[0];
    if (best && best.pos !== h.position && here > best.e * 1.6) y = yFor(best.pos);
  }
  // The words never sit on a face: a block over one moves to the first of the three places that is clear.
  if (!patch.dx && !patch.dy && headline && faceRects.length) {
    const onFace = (yy: number) => faceRects.some((f) => bx0 < f.x + f.w && bx0 + maxWidth > f.x && yy < f.y + f.h && yy + blockH > f.y);
    if (onFace(y)) {
      const clear = (["bottom", "top", "center"] as TextPosition[]).map(yFor).find((yy) => !onFace(yy));
      if (clear !== undefined) y = clear;
    }
  }
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
  // The words keep their colour whatever is behind them: white for every client, or the colour the
  // designer chose by hand. Readability comes from the fade and the placement, never from a colour
  // switch the designer did not ask for.

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

function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

const mattes = new Map<string, Promise<{ matte: HTMLCanvasElement; box: Rect } | null>>();

/**
 * The product's outline as an alpha matte the size of the picture, from the masks read on the
 * server (each a greyscale PNG over its box), and the box around them all.
 */
function subjectMatte(url: string, W: number, H: number): Promise<{ matte: HTMLCanvasElement; box: Rect } | null> {
  const key = `${url}|${W}x${H}`;
  let p = mattes.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) return null;
      const masks = (await r.json()) as SubjectMask[];
      if (!Array.isArray(masks) || !masks.length) return null;
      const matte = document.createElement("canvas");
      matte.width = W;
      matte.height = H;
      const mctx = matte.getContext("2d")!;
      for (const m of masks) {
        const img = await loadImage(m.mask);
        const bx = Math.round(m.box[0] * W);
        const by = Math.round(m.box[1] * H);
        const bw = Math.max(1, Math.round(m.box[2] * W));
        const bh = Math.max(1, Math.round(m.box[3] * H));
        const t = document.createElement("canvas");
        t.width = bw;
        t.height = bh;
        const tctx = t.getContext("2d")!;
        tctx.drawImage(img, 0, 0, bw, bh);
        const data = tctx.getImageData(0, 0, bw, bh);
        // The mask is a probability: a soft edge around the middle keeps the outline clean.
        for (let i = 0; i < data.data.length; i += 4) {
          const v = data.data[i];
          data.data[i + 3] = Math.max(0, Math.min(255, ((v - 96) / 64) * 255));
          data.data[i] = data.data[i + 1] = data.data[i + 2] = 0;
        }
        tctx.putImageData(data, 0, 0);
        mctx.drawImage(t, bx, by);
      }
      // The box around the subject itself (a full-picture matte is mostly empty).
      const a = mctx.getImageData(0, 0, W, H).data;
      let x0 = W;
      let y0 = H;
      let x1 = -1;
      let y1 = -1;
      const step = Math.max(1, Math.round(W / 270));
      for (let y = 0; y < H; y += step)
        for (let x = 0; x < W; x += step)
          if (a[(y * W + x) * 4 + 3] > 128) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      // No subject, or one filling the whole picture: no outline to work with.
      if (x1 < 0 || (x1 - x0) * (y1 - y0) > W * H * 0.92) return null;
      return { matte, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    })().catch(() => null);
    mattes.set(key, p);
  }
  return p;
}

/** The product drawn back over the letters (only above `cut` when given). */
function drawSubject(ctx: CanvasRenderingContext2D, base: HTMLCanvasElement, matte: HTMLCanvasElement, cut?: number) {
  const layer = document.createElement("canvas");
  layer.width = base.width;
  layer.height = base.height;
  const l = layer.getContext("2d")!;
  l.drawImage(base, 0, 0);
  l.globalCompositeOperation = "destination-in";
  l.drawImage(matte, 0, 0, base.width, base.height);
  if (cut !== undefined) {
    l.globalCompositeOperation = "destination-out";
    l.fillRect(0, cut, layer.width, layer.height - cut);
  }
  ctx.drawImage(layer, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * A word drawn as one clean outline: its filled shape grown in every direction, then the shape cut
 * out. Stroking the letters instead traces every glyph on its own, so joined Arabic letters show
 * lines where they meet.
 */
function outlineText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, width: number) {
  const c = document.createElement("canvas");
  c.width = ctx.canvas.width;
  c.height = ctx.canvas.height;
  const o = c.getContext("2d")!;
  o.font = ctx.font;
  o.direction = ctx.direction;
  o.textAlign = ctx.textAlign;
  o.textBaseline = ctx.textBaseline;
  o.fillStyle = color;
  const steps = Math.max(12, Math.round(width * 4));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    o.fillText(text, x + Math.cos(a) * width, y + Math.sin(a) * width);
  }
  o.globalCompositeOperation = "destination-out";
  o.fillText(text, x, y);
  ctx.drawImage(c, 0, 0);
}

const typoWeight = (font: string) => [...HEADLINE_FONTS, ...LATIN_FONTS].find((f) => f.family === font)?.weight ?? 700;

/**
 * A post's words as typography: one big word in a second font behind the product, crossing it,
 * repeated or outlined, and the rest of the words small beside it. Returns where the words sit.
 */
async function drawTypography(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  spec: OverlaySpec,
  typo: PostTypography,
  headline: string,
  subline: string,
  base: HTMLCanvasElement,
  logo: Rect | null,
  scale: number,
  patch: PostOverlayPatch = {},
  faces: Rect[] = [],
): Promise<Rect | null> {
  const word = typo.word.trim() || headline;
  const weight = typoWeight(typo.font);
  const family = fontStack(typo.font);
  await document.fonts.load(`${weight} 64px ${family}`, word).catch(() => []);
  await document.fonts.ready;
  const subject = typo.subject ? await subjectMatte(typo.subject, W, H) : null;
  const style = typo.style;
  // Letters behind or across the subject need an outline and room for some letters to show: a
  // subject filling the whole frame edge to edge, or a missing outline, keeps the plain headline.
  // A person wearing the product is a tall subject: the word still reads behind their sides.
  if ((style === "behind" || style === "overlap") && (!subject || subject.box.w > W * 0.82 || subject.box.w * subject.box.h > W * H * 0.78)) return null;
  // A word set in a band of its own needs a band free of the product: above it or below it.
  if (style !== "behind" && style !== "overlap" && style !== "vertical" && subject && subject.box.h > H * 0.72) return null;
  const margin = spec.margin * W;
  const rtl = ARABIC.test(word + headline);
  // The designer's own placement (dragged in the editor) moves the whole block.
  const dx = (patch.dx ?? 0) * W;
  const dy = (patch.dy ?? 0) * W;
  const moved = !!patch.dx || !!patch.dy;
  ctx.save();
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
  const color = typo.color || spec.headline.color;
  // The colour never changes by itself: the text stays white unless the designer chose a colour.
  // A band, a sticker or a marker needs a solid colour of its own: a white choice gives a dark one.
  const solid = isWhite(color) ? "#1f1a17" : color;
  const box = subject?.box;
  const top = logo ? logo.y + logo.h + 0.02 * W : margin;
  // A block over a face (outside the product's own outline) is moved or dropped.
  const onFace = (r: Rect) =>
    faces.some((f) => !(box && f.x >= box.x && f.y >= box.y && f.x + f.w <= box.x + box.w && f.y + f.h <= box.y + box.h) && r.x < f.x + f.w && r.x + r.w > f.x && r.y < f.y + f.h && r.y + r.h > f.y);

  /* ── the lines to set and their size ── */
  const lines: string[] =
    style === "stack"
      ? (() => {
          const words = (headline || word).split(/\s+/).filter(Boolean);
          if (words.length <= 3) return words;
          const per = Math.ceil(words.length / 3);
          const out: string[] = [];
          for (let k = 0; k < words.length; k += per) out.push(words.slice(k, k + per).join(" "));
          return out;
        })()
      : style === "repeat"
        ? [word, word, word, word]
        : [word];
  const rows = lines.length;
  const measureAt = (px: number, t: string) => {
    ctx.font = `${weight} ${px}px ${family}`;
    const m = ctx.measureText(t);
    return Math.max(m.width, (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0));
  };
  const longest = lines.reduce((a, b) => (measureAt(100, a) >= measureAt(100, b) ? a : b), lines[0]);
  const room = style === "vertical" ? H - margin * 2 - (logo ? logo.h + 0.02 * W : 0) : W - margin * 2;
  const fit = (room / Math.max(1, measureAt(100, longest))) * 100;
  const cap = style === "repeat" ? 0.2 : style === "sticker" ? 0.15 : style === "vertical" ? 0.17 : style === "stack" ? 0.24 : style === "band" || style === "marker" ? 0.26 : 0.34;
  const size = Math.min(fit, W * cap * scale);
  ctx.font = `${weight} ${size}px ${family}`;
  const mm = ctx.measureText(longest);
  const glyphH = (mm.actualBoundingBoxAscent || size * 0.8) + (mm.actualBoundingBoxDescent || size * 0.2);
  const lineH = glyphH * (style === "repeat" ? 1.04 : style === "stack" ? 1.02 : 1.1);
  const shift = ((mm.actualBoundingBoxAscent || size * 0.8) - (mm.actualBoundingBoxDescent || size * 0.2)) / 2;
  const blockH = style === "band" ? lineH * 1.3 : style === "sticker" ? size * 1.6 : rows * lineH;

  /* ── vertical: along the left (or right, for Arabic) edge, reading upwards ── */
  if (style === "vertical") {
    const x = rtl ? W - margin - size * 0.55 + dx : margin + size * 0.55 + dx;
    const y1 = H - margin + dy;
    const rect: Rect = { x: x - size * 0.6, y: y1 - room, w: size * 1.2, h: room };
    if (!moved && onFace(rect)) {
      ctx.restore();
      return null;
    }
    ctx.save();
    ctx.translate(x, y1);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.fillText(word, 0, 0);
    ctx.restore();
    if (subject) drawSubject(ctx, base, subject.matte, undefined);
    ctx.restore();
    return rect;
  }

  /* ── where the block sits: behind the product's upper part, across its lower part, or in the calmest band ── */
  let cy: number;
  if (style === "behind" && box) cy = box.y + box.h * 0.3;
  else if (style === "overlap" && box) cy = box.y + box.h * 0.66;
  else if (box) {
    const above = box.y - top;
    const below = H - margin - (box.y + box.h);
    if (above < blockH && below < blockH) {
      ctx.restore();
      return null;
    }
    cy = above >= below ? top + blockH / 2 : box.y + box.h + blockH / 2;
  } else cy = rows > 1 ? H * 0.42 : style === "sticker" ? H * 0.2 : H * 0.36;
  cy = Math.max(top + blockH / 2, Math.min(H - margin - blockH / 2 - size * 0.4, cy)) + dy;
  const cx = W / 2 + dx;
  const blockRect = (yc: number): Rect => ({ x: margin, y: yc - blockH / 2, w: W - margin * 2, h: blockH });
  if (!moved && faces.length && style !== "behind" && style !== "overlap" && onFace(blockRect(cy))) {
    // Try the other band, then the bottom and the top; else the plain headline.
    const options = [box ? box.y + box.h + blockH / 2 : -1, H - margin - blockH / 2, top + blockH / 2].filter((v) => v > 0);
    const clear = options.find((yc) => !onFace(blockRect(yc)));
    if (clear === undefined) {
      ctx.restore();
      return null;
    }
    cy = clear;
  } else if (!moved && (style === "behind" || style === "overlap") && onFace(blockRect(cy))) {
    ctx.restore();
    return null;
  }
  const blockTop = cy - blockH / 2;
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, size * 0.022);
  ctx.lineJoin = "round";
  ctx.textBaseline = "alphabetic";
  const textX = style === "stack" ? (rtl ? W - margin + dx : margin + dx) : cx;
  if (style === "stack") ctx.textAlign = rtl ? "right" : "left";

  /* ── the backgrounds of band, sticker and marker ── */
  if (style === "band") {
    ctx.fillStyle = solid;
    ctx.fillRect(0, blockTop, W, blockH);
    ctx.fillStyle = inkOn(solid);
  } else if (style === "sticker") {
    const tw = measureAt(size, word);
    const pw = tw + size * 0.9;
    const ph = size * 1.5;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.07);
    ctx.fillStyle = solid;
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, ph / 2);
    ctx.fill();
    ctx.fillStyle = inkOn(solid);
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(word, 0, shift);
    ctx.restore();
  } else if (style === "marker") {
    const tw = measureAt(size, word);
    ctx.save();
    ctx.fillStyle = solid;
    ctx.globalAlpha = 0.88;
    ctx.translate(cx, cy);
    ctx.rotate(-0.02);
    roundRect(ctx, -tw / 2 - size * 0.18, -glyphH * 0.48, tw + size * 0.36, glyphH * 0.96, size * 0.08);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = inkOn(solid);
  }

  /* ── the letters ── */
  if (style !== "sticker")
    for (let i = 0; i < rows; i++) {
      const y = blockTop + (style === "band" ? blockH / 2 : lineH * (i + 0.5)) + shift;
      const t = lines[i];
      if (style === "outline" || (style === "repeat" && i !== 1)) outlineText(ctx, t, textX, y, color, ctx.lineWidth);
      else if (style === "shadow") {
        const off = size * 0.055;
        ctx.fillStyle = inkOn(color) === "#ffffff" ? "#ffffff" : "#1f1a17";
        ctx.fillText(t, textX + off, y + off);
        ctx.fillStyle = color;
        ctx.fillText(t, textX, y);
      } else ctx.fillText(t, textX, y);
    }
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  if (subject) drawSubject(ctx, base, subject.matte, style === "overlap" ? cy : undefined);

  /* ── the rest of the words, small, under the big word (above it when there is no room below) ── */
  const rest = style === "stack" ? subline : headline !== word ? headline : subline;
  let textRect: Rect = { x: margin, y: blockTop, w: W - margin * 2, h: blockH };
  if (rest) {
    const sSize = Math.max(spec.subline.size, 0.034) * W * scale;
    ctx.font = `${spec.subline.weight} ${sSize}px ${fontStack(spec.subline.font || spec.headline.font)}`;
    ctx.direction = ARABIC.test(rest) ? "rtl" : "ltr";
    // Under the big word, never across the product, a face or the logo: the first place that is free.
    const free = (y: number) =>
      y - sSize / 2 >= margin &&
      y + sSize / 2 <= H - margin &&
      !(box && y + sSize / 2 > box.y && y - sSize / 2 < box.y + box.h) &&
      !(logo && y + sSize / 2 > logo.y && y - sSize / 2 < logo.y + logo.h) &&
      !onFace({ x: margin, y: y - sSize / 2, w: W - margin * 2, h: sSize });
    const places = [blockTop + blockH + sSize * 0.9, box ? box.y + box.h + sSize * 0.9 : -1, blockTop - sSize * 0.9, H - margin - sSize];
    const ry = (moved ? places[0] : places.find(free)) ?? places[0];
    ctx.fillStyle = patch.subColor ?? spec.subline.color;
    ctx.textAlign = style === "stack" ? (rtl ? "right" : "left") : "center";
    ctx.fillText(rest, textX, ry, W - margin * 2);
    const y0 = Math.min(blockTop, ry - sSize / 2);
    textRect = { x: margin, y: y0, w: W - margin * 2, h: Math.max(blockTop + blockH, ry + sSize / 2) - y0 };
  }
  ctx.restore();
  return textRect;
}

/**
 * How busy the picture is under a block (the sum of brightness steps between neighbouring
 * samples): a product, food or a face scores high, a wall, sky or cloth low.
 */
function detailEnergy(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): number {
  try {
    const sx = Math.max(0, Math.round(x));
    const sy = Math.max(0, Math.round(y));
    const sw = Math.max(2, Math.min(ctx.canvas.width - sx, Math.round(w)));
    const sh = Math.max(2, Math.min(ctx.canvas.height - sy, Math.round(h)));
    if (sw < 2 || sh < 2) return Infinity;
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    const step = Math.max(2, Math.round(Math.sqrt((sw * sh) / 3000)));
    let sum = 0;
    let n = 0;
    const lum = (i: number) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    for (let yy = 0; yy < sh - step; yy += step)
      for (let xx = 0; xx < sw - step; xx += step) {
        const i = (yy * sw + xx) * 4;
        sum += Math.abs(lum(i) - lum(i + step * 4)) + Math.abs(lum(i) - lum(i + step * sw * 4));
        n++;
      }
    return n ? sum / n : Infinity;
  } catch {
    return Infinity;
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
