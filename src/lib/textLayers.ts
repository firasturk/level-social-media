/**
 * Draws a post's text design (editable layers) on a canvas. The editor, the cards, the share link
 * and the export all come through here, so what the designer sees is what the file holds.
 * Arabic shaping, ligatures and diacritics are the browser's own text engine (fillText), never
 * glyph-by-glyph, except along a curve where each word keeps its shape.
 */
import type { CanvasFx, Fill, ImageLayer, LogoLayer, RunStyle, ShapeLayer, TextDesign, TextLayer } from "@shared/layers";
import { ARABIC_RE, applyCase, directionRuns, isTextLayer, paragraphDirection, segmentsOf } from "@shared/layers";
import { ensureFont, fontStack } from "./fonts";

/** Where a layer's box landed, in canvas pixels, before rotation (cx, cy is the pivot). */
export interface LayerBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  rotate: number;
  /** Pixel size of the font actually used (after "fit"). */
  px: number;
  lines: number;
}

export interface DesignOptions {
  /** Layers laid out but not painted (the one being typed in the editor). */
  skip?: Set<string>;
  /** The picture alone, for blur effects behind the text. */
  base?: HTMLCanvasElement;
  /** Where the client's logo file is served from, for logo layers (the same file the automatic layout draws). */
  logoSrc?: string | null;
}

/** A picture that can be drawn and measured: an <img> or a canvas. */
type Picture = HTMLImageElement | HTMLCanvasElement;

const pictures = new Map<string, Promise<Picture | null>>();

/** Loads (once) a picture a layer points at; null when it cannot be loaded, so the rest still draws. */
export function loadLayerImage(src: string): Promise<Picture | null> {
  let p = pictures.get(src);
  if (!p) {
    p = new Promise<Picture | null>((resolve) => {
      if (typeof Image === "undefined") return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    pictures.set(src, p);
  }
  return p;
}

const sizeOf = (img: Picture) => ({ w: ("naturalWidth" in img && img.naturalWidth) || img.width || 1, h: ("naturalHeight" in img && img.naturalHeight) || img.height || 1 });

/**
 * The photograph under the layers, cropped and shifted as the design asks: `crop` is the part of
 * the file that fills the canvas (scaled to cover it), `offset` slides it. Only this drawing moves;
 * the file's pixels are never changed, and without either the whole picture fills the canvas.
 */
export function drawBasePicture(ctx: CanvasRenderingContext2D, img: Picture, W: number, H: number, fx?: CanvasFx) {
  const { w: nw, h: nh } = sizeOf(img);
  const crop = fx?.crop;
  const offset = fx?.offset;
  if (!crop && !offset) {
    ctx.drawImage(img, 0, 0, W, H);
    return;
  }
  const sx = (crop?.x ?? 0) * nw;
  const sy = (crop?.y ?? 0) * nh;
  const sw = Math.max(1, (crop?.w ?? 1) * nw);
  const sh = Math.max(1, (crop?.h ?? 1) * nh);
  const k = Math.max(W / sw, H / sh);
  const dw = sw * k;
  const dh = sh * k;
  const dx = (W - dw) / 2 + (offset?.x ?? 0) * W;
  const dy = (H - dh) / 2 + (offset?.y ?? 0) * H;
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}

interface Token {
  text: string;
  space: boolean;
  style: RunStyle;
  family: string;
  weight: number;
  italic: boolean;
  px: number;
  shift: number;
  width: number;
  /** The CSS font string. */
  font: string;
}

interface Line {
  tokens: Token[];
  width: number;
  height: number;
  ascent: number;
  dir: "rtl" | "ltr";
  last: boolean;
  first: boolean;
  spaces: number;
  prefix?: Token;
  /** Space between a list mark and the words. */
  prefixGap: number;
}

interface Layout {
  lines: Line[];
  total: number;
  px: number;
  pad: number;
}

type Ctx = CanvasRenderingContext2D;

const withSpacing = (ctx: Ctx, em: number, px: number) => {
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${em * px}px`;
};

function fontOf(layer: TextLayer, style: RunStyle, basePx: number) {
  const family = style.font || layer.font;
  const weight = style.bold ? Math.max(700, layer.weight) : layer.weight;
  const italic = !!(layer.italic || style.italic);
  const px = basePx * (style.size ?? 1) * (style.script ? 0.6 : 1);
  const shift = style.script === "super" ? -0.4 * basePx : style.script === "sub" ? 0.15 * basePx : 0;
  return { family, weight, italic, px, shift, font: `${italic ? "italic " : ""}${weight} ${px}px ${fontStack(family)}` };
}

/** Every (family, weight, italic) a design draws, loaded before the first measurement. */
export async function loadDesignFonts(design: TextDesign): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const l of design.layers) {
    if (!isTextLayer(l) || l.hidden) continue;
    jobs.push(ensureFont(l.font, l.weight, !!l.italic, l.text));
    for (const r of l.runs ?? []) {
      const s = r.style;
      if (s.font || s.bold || s.italic) jobs.push(ensureFont(s.font || l.font, s.bold ? Math.max(700, l.weight) : l.weight, !!(l.italic || s.italic), l.text.slice(r.from, r.to)));
    }
  }
  await Promise.all(jobs);
  await document.fonts.ready;
}

function layoutLayer(ctx: Ctx, layer: TextLayer, W: number, scale = 1): Layout {
  const basePx = Math.max(1, layer.size * W * scale);
  const pad = (layer.padding ?? 0) * basePx;
  const maxW = Math.max(1, layer.w * W - pad * 2);
  const wordGap = (layer.wordSpacing ?? 0) * basePx;
  const letter = layer.letterSpacing ?? 0;
  const lines: Line[] = [];
  const text = layer.text;
  let offset = 0;
  const paragraphs = text.split("\n");
  paragraphs.forEach((para, pi) => {
    const from = offset;
    const to = offset + para.length;
    offset = to + 1;
    const dir = paragraphDirection(para, layer.direction);
    const tokens: Token[] = [];
    for (const seg of segmentsOf(layer.runs, from, to)) {
      const f = fontOf(layer, seg.style, basePx);
      ctx.font = f.font;
      withSpacing(ctx, letter, f.px);
      // Bidi isolate marks (a price pasted from a caption) are ordering hints for DOM text: the
      // renderer orders runs itself, and a canvas would measure them as width.
      const piece = applyCase(text.slice(seg.from, seg.to), layer.transform).replace(/[\u2066-\u2069\u200e\u200f\u061c]/g, "");
      for (const part of piece.split(/(\s+)/)) {
        if (!part) continue;
        const space = /^\s+$/.test(part);
        const width = space ? ctx.measureText(" ").width * part.length + wordGap : ctx.measureText(part).width;
        tokens.push({ text: space ? " ".repeat(part.length) : part, space, style: seg.style, ...f, width });
      }
    }
    let prefix: Token | undefined;
    let prefixGap = 0;
    if (layer.list && layer.list !== "none" && para.trim()) {
      const f = fontOf(layer, {}, basePx);
      ctx.font = f.font;
      withSpacing(ctx, letter, f.px);
      const mark = layer.list === "bullet" ? "•" : `${pi + 1}.`;
      prefix = { text: mark, space: false, style: {}, ...f, width: ctx.measureText(mark).width };
      prefixGap = ctx.measureText(" ").width;
    }
    const indent = (layer.indent ?? 0) * basePx;
    let cur: Token[] = [];
    let width = 0;
    let first = true;
    const flush = (last: boolean) => {
      while (cur.length && cur[cur.length - 1].space) {
        width -= cur[cur.length - 1].width;
        cur.pop();
      }
      while (cur.length && cur[0].space) {
        width -= cur[0].width;
        cur.shift();
      }
      const maxPx = cur.reduce((m, t) => Math.max(m, t.px), 0) || basePx;
      lines.push({
        tokens: cur,
        width: width + (first ? indent : 0) + (prefix ? prefix.width + prefixGap : 0),
        height: maxPx * layer.lineHeight,
        ascent: maxPx * 0.8,
        dir,
        last,
        first,
        spaces: cur.filter((t) => t.space).length,
        prefix: first ? prefix : undefined,
        prefixGap: first && prefix ? prefixGap : 0,
      });
      cur = [];
      width = 0;
      first = false;
    };
    const room = () => maxW - (first ? indent : 0) - (prefix ? prefix.width + prefixGap : 0);
    for (const t of tokens) {
      if (!t.space && cur.some((c) => !c.space) && width + t.width > room()) flush(false);
      cur.push(t);
      width += t.width;
    }
    flush(true);
    if (!para.trim() && !lines[lines.length - 1]?.tokens.length) lines[lines.length - 1].height = basePx * layer.lineHeight;
  });
  const paraGap = (layer.paragraphSpacing ?? 0) * basePx;
  let total = 0;
  lines.forEach((l) => {
    total += l.height + (l.last ? paraGap : 0);
  });
  total -= paraGap;
  return { lines, total: Math.max(total, 0), px: basePx, pad };
}

function fillStyleOf(ctx: Ctx, fill: Fill, box: { x: number; y: number; w: number; h: number }): string | CanvasGradient {
  if (fill.type === "solid") return rgba(fill.color, fill.alpha ?? 1);
  if (fill.type === "linear") {
    const a = ((fill.angle - 90) * Math.PI) / 180;
    const r = Math.sqrt(box.w * box.w + box.h * box.h) / 2;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    for (const s of fill.stops) g.addColorStop(clamp01(s.at), rgba(s.color, s.alpha ?? 1));
    return g;
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(box.w, box.h) / 2);
  for (const s of fill.stops) g.addColorStop(clamp01(s.at), rgba(s.color, s.alpha ?? 1));
  return g;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const a = m[2] ? (parseInt(m[2], 16) / 255) * alpha : alpha;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Applies the layer's rotation and skew around its centre. */
function placeLayer(ctx: Ctx, box: LayerBox, layer: TextLayer) {
  ctx.translate(box.cx, box.cy);
  if (layer.rotate) ctx.rotate((layer.rotate * Math.PI) / 180);
  if (layer.skew) ctx.transform(1, 0, Math.tan((layer.skew * Math.PI) / 180), 1, 0, 0);
  ctx.translate(-box.cx, -box.cy);
}

/** Paints one piece of text with the layer's effects (glow, shadow, stroke, fill) at its baseline. */
function paintPiece(ctx: Ctx, layer: TextLayer, t: Token, x: number, y: number, fill: string | CanvasGradient, fillOnly: boolean) {
  ctx.font = t.font;
  withSpacing(ctx, layer.letterSpacing ?? 0, t.px);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const color = t.style.color ? t.style.color : fill;
  if (!fillOnly) {
    if (layer.glow && layer.glow.blur > 0) {
      ctx.save();
      ctx.shadowColor = layer.glow.color;
      ctx.shadowBlur = layer.glow.blur * t.px;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = color;
      for (let i = 0; i < (layer.glow.strength ?? 2); i++) ctx.fillText(t.text, x, y);
      ctx.restore();
    }
    if (layer.shadow) {
      ctx.save();
      ctx.shadowColor = rgba(layer.shadow.color, layer.shadow.alpha ?? 1);
      ctx.shadowBlur = layer.shadow.blur * t.px;
      ctx.shadowOffsetX = layer.shadow.x * t.px;
      ctx.shadowOffsetY = layer.shadow.y * t.px;
      ctx.fillStyle = color;
      ctx.fillText(t.text, x, y);
      ctx.restore();
    }
    if (layer.stroke && layer.stroke.width > 0 && layer.stroke.outside !== false) {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = layer.stroke.color;
      ctx.lineWidth = layer.stroke.width * t.px * 2;
      ctx.strokeText(t.text, x, y);
      ctx.restore();
    }
  }
  ctx.fillStyle = color;
  ctx.fillText(t.text, x, y);
  if (!fillOnly && layer.stroke && layer.stroke.width > 0 && layer.stroke.outside === false) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = layer.stroke.color;
    ctx.lineWidth = layer.stroke.width * t.px;
    ctx.strokeText(t.text, x, y);
    ctx.restore();
  }
}

/** Draws a laid-out layer's lines into a context already placed (rotation applied). */
function paintLines(ctx: Ctx, layer: TextLayer, lay: Layout, box: LayerBox, fill: string | CanvasGradient, fillOnly: boolean) {
  const maxW = box.w - lay.pad * 2;
  const indent = (layer.indent ?? 0) * lay.px;
  const paraGap = (layer.paragraphSpacing ?? 0) * lay.px;
  const vAlign = layer.vAlign ?? "top";
  let y = box.y + lay.pad + (vAlign === "middle" ? (box.h - lay.pad * 2 - lay.total) / 2 : vAlign === "bottom" ? box.h - lay.pad * 2 - lay.total : 0);
  const left = box.x + lay.pad;
  for (const line of lay.lines) {
    const baseline = y + line.ascent + (line.height - line.ascent * 1.25) / 2;
    const lineIndent = line.first ? indent : 0;
    const prefixW = line.prefix ? line.prefix.width + line.prefixGap : 0;
    const contentW = line.width - lineIndent - prefixW;
    const free = maxW - line.width;
    const justify = layer.align === "justify" && !line.last && line.spaces > 0 && free > 0;
    const extra = justify ? free / line.spaces : 0;
    const align = layer.align === "justify" ? (line.dir === "rtl" ? "right" : "left") : layer.align;
    const slack = justify ? 0 : align === "center" ? free / 2 : align === "right" ? free : 0;
    ctx.direction = line.dir;
    const pieces: { t: Token; x: number }[] = [];
    const span = (t: Token) => t.width + (t.space ? extra : 0);
    // Words walk along the line in its direction; a run that reads the other way (Latin inside
    // Arabic, Arabic inside Latin) keeps its own order inside the room it takes.
    const runs = directionRuns(line.tokens, line.dir);
    if (line.dir === "ltr") {
      let x = left + slack + lineIndent;
      if (line.prefix) {
        pieces.push({ t: line.prefix, x });
        x += prefixW;
      }
      for (const run of runs) {
        const rw = run.tokens.reduce((s, t) => s + span(t), 0);
        let xx = run.dir === "ltr" ? x : x + rw;
        for (const t of run.tokens) {
          if (run.dir === "ltr") {
            if (!t.space) pieces.push({ t, x: xx });
            xx += span(t);
          } else {
            xx -= span(t);
            if (!t.space) pieces.push({ t, x: xx });
          }
        }
        x += rw;
      }
    } else {
      // Right-to-left: the line's right edge is the mirror of the left one, pieces walk leftwards.
      let x = left + maxW - slack - lineIndent;
      if (line.prefix) {
        // The mark sits at the right end of the line, its gap between it and the first word.
        x -= prefixW;
        pieces.push({ t: line.prefix, x: x + line.prefixGap });
      }
      for (const run of runs) {
        const rw = run.tokens.reduce((s, t) => s + span(t), 0);
        let xx = run.dir === "rtl" ? x : x - rw;
        for (const t of run.tokens) {
          if (run.dir === "rtl") {
            xx -= span(t);
            if (!t.space) pieces.push({ t, x: xx });
          } else {
            if (!t.space) pieces.push({ t, x: xx });
            xx += span(t);
          }
        }
        x -= rw;
      }
    }
    void contentW;
    if (layer.curve && Math.abs(layer.curve) >= 2 && line.width > 0) paintCurved(ctx, layer, line, pieces, left + lineIndent + slack + (line.width - lineIndent) / 2, baseline, fill, fillOnly);
    else
      for (const p of pieces) {
        const by = baseline + p.t.shift;
        if (p.t.style.highlight && !fillOnly) {
          ctx.fillStyle = p.t.style.highlight;
          ctx.fillRect(p.x - p.t.px * 0.05, by - p.t.px * 0.85, p.t.width + p.t.px * 0.1, p.t.px * 1.1);
        }
        paintPiece(ctx, layer, p.t, p.x, by, fill, fillOnly);
        if (!fillOnly && (p.t.style.underline || p.t.style.strike)) {
          ctx.fillStyle = p.t.style.color ? p.t.style.color : fill;
          if (p.t.style.underline) ctx.fillRect(p.x, by + p.t.px * 0.1, p.t.width, Math.max(1, p.t.px * 0.06));
          if (p.t.style.strike) ctx.fillRect(p.x, by - p.t.px * 0.3, p.t.width, Math.max(1, p.t.px * 0.06));
        }
      }
    y += line.height + (line.last ? paraGap : 0);
  }
}

/** A line along an arc: Latin words glyph by glyph, Arabic words whole so their letters stay joined. */
function paintCurved(ctx: Ctx, layer: TextLayer, line: Line, pieces: { t: Token; x: number }[], cx: number, baseline: number, fill: string | CanvasGradient, fillOnly: boolean) {
  const units: { t: Token; center: number }[] = [];
  for (const p of pieces) {
    if (ARABIC_RE.test(p.t.text) || p.t.text.length === 1) units.push({ t: p.t, center: p.x + p.t.width / 2 });
    else {
      ctx.font = p.t.font;
      withSpacing(ctx, layer.letterSpacing ?? 0, p.t.px);
      let x = p.x;
      for (const ch of p.t.text) {
        const w = ctx.measureText(ch).width + (layer.letterSpacing ?? 0) * p.t.px;
        units.push({ t: { ...p.t, text: ch, width: w }, center: x + w / 2 });
        x += w;
      }
    }
  }
  const deg = layer.curve ?? 0;
  const radius = (line.width * 360) / (2 * Math.PI * Math.abs(deg));
  const up = deg > 0;
  const ox = cx;
  const oy = up ? baseline + radius : baseline - radius;
  for (const u of units) {
    const theta = (u.center - cx) / radius;
    const px = ox + Math.sin(theta) * radius;
    const py = up ? oy - Math.cos(theta) * radius : oy + Math.cos(theta) * radius;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(up ? theta : -theta);
    paintPiece(ctx, layer, u.t, -u.t.width / 2, u.t.shift, fill, fillOnly);
    ctx.restore();
  }
}

/** An inner shadow: the shadow of everything outside the letters, kept only inside them. */
function innerShadow(ctx: Ctx, W: number, H: number, layer: TextLayer, draw: (c: Ctx) => void, px: number) {
  const sh = layer.innerShadow!;
  const text = document.createElement("canvas");
  text.width = W;
  text.height = H;
  const tc = text.getContext("2d")!;
  draw(tc);
  const inverse = document.createElement("canvas");
  inverse.width = W;
  inverse.height = H;
  const ic = inverse.getContext("2d")!;
  ic.fillStyle = "#000";
  ic.fillRect(0, 0, W, H);
  ic.globalCompositeOperation = "destination-out";
  ic.drawImage(text, 0, 0);
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const oc = out.getContext("2d")!;
  oc.shadowColor = rgba(sh.color, sh.alpha ?? 1);
  oc.shadowBlur = sh.blur * px;
  oc.shadowOffsetX = sh.x * px;
  oc.shadowOffsetY = sh.y * px;
  oc.drawImage(inverse, 0, 0);
  oc.shadowColor = "transparent";
  oc.globalCompositeOperation = "destination-in";
  oc.drawImage(text, 0, 0);
  ctx.drawImage(out, 0, 0);
}

/** The readability helpers over the picture: blur, a colour wash, a fade from one edge. */
export function drawCanvasFx(ctx: Ctx, W: number, H: number, fx: CanvasFx | undefined, base?: HTMLCanvasElement) {
  if (!fx) return;
  if (fx.blur && base && "filter" in ctx) {
    ctx.save();
    ctx.filter = `blur(${(fx.blur * W) / 1080}px)`;
    ctx.drawImage(base, 0, 0, W, H);
    ctx.restore();
  }
  if (fx.overlay && fx.overlay.alpha > 0) {
    ctx.fillStyle = rgba(fx.overlay.color, fx.overlay.alpha);
    ctx.fillRect(0, 0, W, H);
  }
  if (fx.gradient && (fx.gradient.from > 0 || fx.gradient.to > 0)) {
    const a = ((fx.gradient.angle - 90) * Math.PI) / 180;
    const r = Math.sqrt(W * W + H * H) / 2;
    const g = ctx.createLinearGradient(W / 2 - Math.cos(a) * r, H / 2 - Math.sin(a) * r, W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r);
    g.addColorStop(0, rgba(fx.gradient.color, fx.gradient.from));
    g.addColorStop(1, rgba(fx.gradient.color, fx.gradient.to));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

/** Lays out and paints every visible layer (text, logo, picture, shape) in order; returns where each landed. */
export async function drawDesign(ctx: Ctx, W: number, H: number, design: TextDesign, opts: DesignOptions = {}): Promise<LayerBox[]> {
  await loadDesignFonts(design);
  const boxes: LayerBox[] = [];
  for (const layer of design.layers) {
    if (layer.hidden) continue;
    if (isTextLayer(layer)) {
      if (!layer.text.trim()) continue;
      const box = layoutBox(ctx, layer, W, H);
      boxes.push(box.box);
      if (opts.skip?.has(layer.id)) continue;
      paintLayer(ctx, W, H, layer, box.lay, box.box, opts.base);
      continue;
    }
    if (layer.type === "logo") {
      const img = opts.logoSrc ? await loadLayerImage(opts.logoSrc) : null;
      const box = plainBox(layer, W, H, img ? sizeOf(img) : undefined);
      boxes.push(box);
      if (img && !opts.skip?.has(layer.id)) paintLogo(ctx, layer, box, img);
      continue;
    }
    if (layer.type === "image") {
      const box = plainBox(layer, W, H);
      boxes.push(box);
      if (opts.skip?.has(layer.id)) continue;
      const img = await loadLayerImage(layer.src);
      if (img) paintImage(ctx, W, layer, box, img);
      continue;
    }
    const box = plainBox(layer, W, H);
    boxes.push(box);
    if (!opts.skip?.has(layer.id)) paintShape(ctx, W, layer, box);
  }
  return boxes;
}

/** The box of a logo, picture or shape layer at this canvas size (a logo's height follows its file). */
export function plainBox(layer: LogoLayer | ImageLayer | ShapeLayer, W: number, H: number, natural?: { w: number; h: number }): LayerBox {
  const x = layer.x * W;
  const y = layer.y * H;
  const w = layer.w * W;
  const h = layer.type === "logo" ? (natural ? (w * natural.h) / natural.w : w * 0.5) : layer.h * H;
  return { id: layer.id, x, y, w, h, cx: x + w / 2, cy: y + h / 2, rotate: layer.rotate ?? 0, px: 0, lines: 0 };
}

/** The ratio of a logo file's height to its width once it is loaded (for the editor's boxes). */
export async function logoAspect(logoSrc: string | null | undefined): Promise<number | null> {
  if (!logoSrc) return null;
  const img = await loadLayerImage(logoSrc);
  if (!img) return null;
  const s = sizeOf(img);
  return s.h / s.w;
}

function begin(ctx: Ctx, layer: LogoLayer | ImageLayer | ShapeLayer, box: LayerBox) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = layer.opacity ?? 1;
  if (layer.blend && layer.blend !== "normal") ctx.globalCompositeOperation = layer.blend as GlobalCompositeOperation;
  if (layer.rotate) {
    ctx.translate(box.cx, box.cy);
    ctx.rotate((layer.rotate * Math.PI) / 180);
    ctx.translate(-box.cx, -box.cy);
  }
}

/** The client's mark, as the file is, or recoloured in one colour for a light or a dark picture. */
function paintLogo(ctx: Ctx, layer: LogoLayer, box: LayerBox, img: Picture) {
  begin(ctx, layer, box);
  const variant = layer.variant ?? "default";
  if (variant === "default" || typeof document === "undefined") ctx.drawImage(img, box.x, box.y, box.w, box.h);
  else {
    const tint = document.createElement("canvas");
    tint.width = Math.max(1, Math.round(box.w));
    tint.height = Math.max(1, Math.round(box.h));
    const t = tint.getContext("2d")!;
    t.drawImage(img, 0, 0, tint.width, tint.height);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = variant === "white" ? "#ffffff" : "#1f1a17";
    t.fillRect(0, 0, tint.width, tint.height);
    ctx.drawImage(tint, box.x, box.y, box.w, box.h);
  }
  ctx.restore();
}

/** A picture layer: the chosen part of the source, covering or fitting its box, with rounded corners when asked. */
function paintImage(ctx: Ctx, W: number, layer: ImageLayer, box: LayerBox, img: Picture) {
  const { w: nw, h: nh } = sizeOf(img);
  const crop = layer.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.max(0, Math.min(nw - 1, crop.x * nw));
  const sy = Math.max(0, Math.min(nh - 1, crop.y * nh));
  const sw = Math.max(1, Math.min(nw - sx, crop.w * nw));
  const sh = Math.max(1, Math.min(nh - sy, crop.h * nh));
  const k = layer.fit === "contain" ? Math.min(box.w / sw, box.h / sh) : Math.max(box.w / sw, box.h / sh);
  const dw = sw * k;
  const dh = sh * k;
  begin(ctx, layer, box);
  roundRect(ctx, box.x, box.y, box.w, box.h, (layer.radius ?? 0) * W);
  ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
  ctx.restore();
}

/** A flat shape: a rounded rectangle, an ellipse or a rule, filled and outlined. */
function paintShape(ctx: Ctx, W: number, layer: ShapeLayer, box: LayerBox) {
  begin(ctx, layer, box);
  const fill = fillStyleOf(ctx, layer.fill, box);
  const strokeW = (layer.stroke?.width ?? 0) * W;
  if (layer.shape === "line") {
    ctx.beginPath();
    ctx.moveTo(box.x, box.cy);
    ctx.lineTo(box.x + box.w, box.cy);
    ctx.lineWidth = Math.max(1, box.h);
    ctx.lineCap = layer.radius ? "round" : "butt";
    ctx.strokeStyle = layer.stroke && strokeW > 0 ? rgba(layer.stroke.color, layer.stroke.alpha ?? 1) : fill;
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (layer.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(box.cx, box.cy, Math.max(0, box.w / 2), Math.max(0, box.h / 2), 0, 0, Math.PI * 2);
    ctx.closePath();
  } else roundRect(ctx, box.x, box.y, box.w, box.h, (layer.radius ?? 0) * W);
  ctx.fillStyle = fill;
  ctx.fill();
  if (layer.stroke && strokeW > 0) {
    ctx.lineWidth = strokeW;
    ctx.strokeStyle = rgba(layer.stroke.color, layer.stroke.alpha ?? 1);
    ctx.stroke();
  }
  ctx.restore();
}

/** The layer's box and layout at this canvas size (shrinking the type to fit a fixed box when asked). */
export function layoutBox(ctx: Ctx, layer: TextLayer, W: number, H: number): { lay: Layout; box: LayerBox } {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  let lay = layoutLayer(ctx, layer, W);
  const fixed = layer.autoSize === false && layer.h !== undefined;
  if (fixed && layer.fit) {
    const target = layer.h! * H - lay.pad * 2;
    const maxW = layer.w * W - lay.pad * 2;
    let scale = 1;
    for (let i = 0; i < 24 && (lay.total > target || lay.lines.some((l) => l.width > maxW + 0.5)); i++) {
      scale *= 0.92;
      lay = layoutLayer(ctx, layer, W, scale);
    }
  }
  ctx.restore();
  const x = layer.x * W;
  const y = layer.y * H;
  const w = layer.w * W;
  const h = fixed ? layer.h! * H : lay.total + lay.pad * 2;
  return { lay, box: { id: layer.id, x, y, w, h, cx: x + w / 2, cy: y + h / 2, rotate: layer.rotate ?? 0, px: lay.px, lines: lay.lines.length } };
}

function paintLayer(ctx: Ctx, W: number, H: number, layer: TextLayer, lay: Layout, box: LayerBox, base?: HTMLCanvasElement) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = layer.opacity ?? 1;
  if (layer.blend && layer.blend !== "normal") ctx.globalCompositeOperation = layer.blend as GlobalCompositeOperation;
  placeLayer(ctx, box, layer);
  const bg = layer.background;
  if (bg && (bg.alpha > 0 || bg.blur)) {
    const p = bg.padding * lay.px;
    const bx = box.x - p;
    const by = box.y - p;
    const bw = box.w + p * 2;
    const bh = box.h + p * 2;
    if (bg.blur && base && "filter" in ctx) {
      ctx.save();
      roundRect(ctx, bx, by, bw, bh, bg.radius * lay.px);
      ctx.clip();
      ctx.filter = `blur(${(bg.blur * W) / 1080}px)`;
      ctx.drawImage(base, 0, 0, W, H);
      ctx.restore();
    }
    if (bg.alpha > 0) {
      ctx.fillStyle = rgba(bg.color, bg.alpha);
      roundRect(ctx, bx, by, bw, bh, bg.radius * lay.px);
      ctx.fill();
    }
  }
  const fill = fillStyleOf(ctx, layer.fill, box);
  if (layer.blur && "filter" in ctx) ctx.filter = `blur(${layer.blur * lay.px}px)`;
  paintLines(ctx, layer, lay, box, fill, false);
  ctx.filter = "none";
  ctx.restore();
  if (layer.innerShadow) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity ?? 1;
    innerShadow(
      ctx,
      W,
      H,
      layer,
      (c) => {
        placeLayer(c, box, layer);
        paintLines(c, layer, lay, box, "#000", true);
      },
      lay.px,
    );
    ctx.restore();
  }
}

/** The design alone on a transparent canvas (a layers-only PNG the client can lay over anything). */
export async function renderDesignOnly(design: TextDesign, W: number, H: number, opts: Pick<DesignOptions, "logoSrc"> = {}): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  await drawDesign(ctx, W, H, { ...design, canvas: undefined }, opts);
  return canvas;
}

/** Mean luminance (0..1) of the picture under a box, for contrast warnings. */
export function luminanceUnder(base: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }): number {
  const ctx = base.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0.5;
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.max(1, Math.min(base.width - x, Math.ceil(box.w)));
  const h = Math.max(1, Math.min(base.height - y, Math.ceil(box.h)));
  try {
    const d = ctx.getImageData(x, y, w, h).data;
    let sum = 0;
    let n = 0;
    const step = Math.max(4, Math.floor((w * h) / 4000) * 4);
    for (let i = 0; i < d.length; i += step) {
      sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      n++;
    }
    return n ? sum / n : 0.5;
  } catch {
    return 0.5;
  }
}
