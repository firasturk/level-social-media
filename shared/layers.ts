/**
 * Text design: the words on a post as editable layers, kept as data next to the picture and never
 * flattened into it. Every length is a fraction of the canvas: x, w and font sizes of the width,
 * y and h of the height, so one design fits 1:1, 4:5 and 9:16 outputs at any resolution. The
 * browser draws the layers (preview, share link, export) with the one renderer in src/lib.
 */
import { z } from "zod";

export interface GradientStop {
  /** 0..1 along the gradient. */
  at: number;
  color: string;
  /** 0..1, 1 when omitted. */
  alpha?: number;
}

export type Fill =
  | { type: "solid"; color: string; alpha?: number }
  | { type: "linear"; angle: number; stops: GradientStop[] }
  | { type: "radial"; stops: GradientStop[] };

/** Styling of a run of characters inside a layer (bold words, a coloured word, a superscript). */
export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
  /** Multiplier on the layer's size. */
  size?: number;
  script?: "super" | "sub";
  /** A highlight colour drawn behind the run. */
  highlight?: string;
}

export interface TextRun {
  from: number;
  to: number;
  style: RunStyle;
}

/** A shadow in ems of the font size. */
export interface TextShadow {
  color: string;
  blur: number;
  x: number;
  y: number;
  alpha?: number;
}

export type TextAlign4 = "left" | "center" | "right" | "justify";
export type VAlign = "top" | "middle" | "bottom";
export type TextCase = "none" | "upper" | "lower" | "title";
export type ListKind = "none" | "bullet" | "number";
export type Direction = "auto" | "rtl" | "ltr";

export interface TextLayer {
  id: string;
  type: "text";
  name?: string;
  /** The post's headline or second line: these two keep the plan's headline/subline in step. */
  role?: "headline" | "subline";
  text: string;
  runs?: TextRun[];
  /** Box: x, w as fractions of the width; y, h of the height (h unset: the box follows the text). */
  x: number;
  y: number;
  w: number;
  h?: number;
  /** Degrees, clockwise. */
  rotate?: number;
  /** Horizontal skew in degrees. */
  skew?: number;
  font: string;
  weight: number;
  italic?: boolean;
  /** Font size as a fraction of the width. */
  size: number;
  lineHeight: number;
  /** In ems. */
  letterSpacing?: number;
  wordSpacing?: number;
  paragraphSpacing?: number;
  indent?: number;
  padding?: number;
  align: TextAlign4;
  vAlign?: VAlign;
  direction?: Direction;
  transform?: TextCase;
  list?: ListKind;
  /** true: the box grows with the text; false: a fixed box the text wraps (and fits) inside. */
  autoSize?: boolean;
  /** Fixed box: shrink the size until the words fit. */
  fit?: boolean;
  fill: Fill;
  opacity?: number;
  stroke?: { color: string; width: number; outside?: boolean };
  shadow?: TextShadow;
  innerShadow?: TextShadow;
  glow?: { color: string; blur: number; strength?: number };
  /** Blur of the letters, in ems. */
  blur?: number;
  background?: { color: string; alpha: number; padding: number; radius: number; blur?: number };
  /** Curve of each line in degrees of arc (positive bends up, negative down). */
  curve?: number;
  blend?: string;
  locked?: boolean;
  hidden?: boolean;
  group?: string;
}

/** A rectangle in fractions (of the canvas, or of a source picture for a crop). */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The client's logo as a layer: the same file the automatic layout draws, placed by hand. Its height
 * follows the file's own proportions. A `white` or `dark` variant recolours the mark in one colour
 * (for a mark that must read on a light or a dark picture); `default` keeps the file's colours.
 */
export interface LogoLayer {
  id: string;
  type: "logo";
  name?: string;
  variant?: "default" | "white" | "dark";
  x: number;
  y: number;
  /** Width as a fraction of the canvas width. */
  w: number;
  rotate?: number;
  opacity?: number;
  blend?: string;
  locked?: boolean;
  hidden?: boolean;
  group?: string;
}

/** A picture layer: a product photo, a brand asset or an uploaded graphic, cropped and fitted in its box. */
export interface ImageLayer {
  id: string;
  type: "image";
  name?: string;
  /** A studio URL (a product photo, a place photo, an uploaded graphic); never the pixels themselves. */
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  opacity?: number;
  /** The part of the source that is shown, as fractions of the source; the whole picture when unset. */
  crop?: FracRect;
  /** cover: fills the box, trimming the sides; contain: the whole crop fits inside the box. */
  fit?: "cover" | "contain";
  /** Corner radius as a fraction of the canvas width. */
  radius?: number;
  blend?: string;
  locked?: boolean;
  hidden?: boolean;
  group?: string;
}

export type ShapeKind = "rect" | "ellipse" | "line";

/** A flat shape: a band behind words, a circle sticker, a rule. */
export interface ShapeLayer {
  id: string;
  type: "shape";
  name?: string;
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  opacity?: number;
  fill: Fill;
  /** Width as a fraction of the canvas width. A line is its stroke only. */
  stroke?: { color: string; width: number; alpha?: number };
  /** Corner radius of a rect, as a fraction of the canvas width. */
  radius?: number;
  blend?: string;
  locked?: boolean;
  hidden?: boolean;
  group?: string;
}

export type Layer = TextLayer | LogoLayer | ImageLayer | ShapeLayer;
export type LayerType = Layer["type"];

export const isTextLayer = (l: Layer): l is TextLayer => l.type === "text";
export const isLogoLayer = (l: Layer): l is LogoLayer => l.type === "logo";
export const isImageLayer = (l: Layer): l is ImageLayer => l.type === "image";
export const isShapeLayer = (l: Layer): l is ShapeLayer => l.type === "shape";

/** The text layers of a design, in drawing order. */
export function textLayersOf(design: TextDesign): TextLayer[] {
  return design.layers.filter(isTextLayer);
}

/** Readability helpers over the picture, before any text: the picture's pixels are never changed. */
export interface CanvasFx {
  overlay?: { color: string; alpha: number };
  /** A fade from one edge: angle 180 = dark at the bottom. */
  gradient?: { color: string; angle: number; from: number; to: number };
  /** Blur of the picture in pixels at 1080 width. */
  blur?: number;
  /** The part of the photograph that fills the canvas, as fractions of the photograph; all of it when unset. */
  crop?: FracRect;
  /** A shift of the (cropped) photograph under the layers, as fractions of the canvas width and height. */
  offset?: { x: number; y: number };
}

export interface TextDesign {
  version: 1;
  layers: Layer[];
  canvas?: CanvasFx;
}

/**
 * Reads a stored design of any earlier shape into the current one. Version 1 is still the current
 * version: the new layer types are additions, so a design with only text layers comes back as it
 * was. A layer stored before `type` existed is a text layer.
 */
export function upgradeDesign(raw: unknown): TextDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<TextDesign> & { layers?: unknown };
  if (!Array.isArray(d.layers)) return null;
  const layers: Layer[] = [];
  for (const l of d.layers as Partial<Layer>[]) {
    if (!l || typeof l !== "object") continue;
    const type = (l as { type?: string }).type;
    if (type === "logo" || type === "image" || type === "shape") layers.push(l as Layer);
    else if (type === "text" || (type === undefined && typeof (l as TextLayer).text === "string")) layers.push({ ...(l as TextLayer), type: "text" });
  }
  return { version: 1, layers, canvas: d.canvas };
}

export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "soft-light", "hard-light"] as const;

export const DEFAULT_LAYER: Omit<TextLayer, "id" | "text"> = {
  type: "text",
  x: 0.1,
  y: 0.4,
  w: 0.8,
  font: "Inter",
  weight: 700,
  size: 0.07,
  lineHeight: 1.15,
  align: "center",
  fill: { type: "solid", color: "#ffffff" },
  autoSize: true,
};

let seq = 0;
export function layerId(): string {
  seq += 1;
  return `L${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newTextLayer(text: string, over: Partial<TextLayer> = {}): TextLayer {
  return { ...DEFAULT_LAYER, id: layerId(), text, ...over };
}

const hex = z.string().max(12);
const stop = z.object({ at: z.number().min(0).max(1), color: hex, alpha: z.number().min(0).max(1).optional() });
const fill = z.union([
  z.object({ type: z.literal("solid"), color: hex, alpha: z.number().min(0).max(1).optional() }),
  z.object({ type: z.literal("linear"), angle: z.number().min(-360).max(360), stops: z.array(stop).min(2).max(8) }),
  z.object({ type: z.literal("radial"), stops: z.array(stop).min(2).max(8) }),
]);
const shadow = z.object({ color: hex, blur: z.number().min(0).max(5), x: z.number().min(-5).max(5), y: z.number().min(-5).max(5), alpha: z.number().min(0).max(1).optional() });
const runStyle = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: hex.optional(),
  font: z.string().max(60).optional(),
  size: z.number().min(0.2).max(4).optional(),
  script: z.enum(["super", "sub"]).optional(),
  highlight: hex.optional(),
});

export const TEXT_LAYER_SCHEMA = z.object({
  id: z.string().min(1).max(40),
  type: z.literal("text"),
  name: z.string().max(60).optional(),
  role: z.enum(["headline", "subline"]).optional(),
  text: z.string().max(2000),
  runs: z.array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0), style: runStyle })).max(200).optional(),
  x: z.number().min(-2).max(3),
  y: z.number().min(-2).max(3),
  w: z.number().min(0.02).max(3),
  h: z.number().min(0.01).max(3).optional(),
  rotate: z.number().min(-360).max(360).optional(),
  skew: z.number().min(-80).max(80).optional(),
  font: z.string().max(60),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean().optional(),
  size: z.number().min(0.005).max(1),
  lineHeight: z.number().min(0.5).max(4),
  letterSpacing: z.number().min(-0.5).max(2).optional(),
  wordSpacing: z.number().min(-0.5).max(3).optional(),
  paragraphSpacing: z.number().min(0).max(4).optional(),
  indent: z.number().min(0).max(4).optional(),
  padding: z.number().min(0).max(2).optional(),
  align: z.enum(["left", "center", "right", "justify"]),
  vAlign: z.enum(["top", "middle", "bottom"]).optional(),
  direction: z.enum(["auto", "rtl", "ltr"]).optional(),
  transform: z.enum(["none", "upper", "lower", "title"]).optional(),
  list: z.enum(["none", "bullet", "number"]).optional(),
  autoSize: z.boolean().optional(),
  fit: z.boolean().optional(),
  fill,
  opacity: z.number().min(0).max(1).optional(),
  stroke: z.object({ color: hex, width: z.number().min(0).max(1), outside: z.boolean().optional() }).optional(),
  shadow: shadow.optional(),
  innerShadow: shadow.optional(),
  glow: z.object({ color: hex, blur: z.number().min(0).max(5), strength: z.number().min(1).max(5).optional() }).optional(),
  blur: z.number().min(0).max(2).optional(),
  background: z.object({ color: hex, alpha: z.number().min(0).max(1), padding: z.number().min(0).max(3), radius: z.number().min(0).max(5), blur: z.number().min(0).max(60).optional() }).optional(),
  curve: z.number().min(-360).max(360).optional(),
  blend: z.enum(BLEND_MODES).optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  group: z.string().max(40).optional(),
});

const common = {
  id: z.string().min(1).max(40),
  name: z.string().max(60).optional(),
  x: z.number().min(-2).max(3),
  y: z.number().min(-2).max(3),
  rotate: z.number().min(-360).max(360).optional(),
  opacity: z.number().min(0).max(1).optional(),
  blend: z.enum(BLEND_MODES).optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  group: z.string().max(40).optional(),
};

export const LOGO_LAYER_SCHEMA = z.object({
  ...common,
  type: z.literal("logo"),
  variant: z.enum(["default", "white", "dark"]).optional(),
  w: z.number().min(0.02).max(3),
});

export const IMAGE_LAYER_SCHEMA = z.object({
  ...common,
  type: z.literal("image"),
  src: z.string().min(1).max(600),
  w: z.number().min(0.01).max(3),
  h: z.number().min(0.01).max(3),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).optional(),
  fit: z.enum(["cover", "contain"]).optional(),
  radius: z.number().min(0).max(1).optional(),
});

export const SHAPE_LAYER_SCHEMA = z.object({
  ...common,
  type: z.literal("shape"),
  shape: z.enum(["rect", "ellipse", "line"]),
  w: z.number().min(0).max(3),
  h: z.number().min(0).max(3),
  fill,
  stroke: z.object({ color: hex, width: z.number().min(0).max(0.5), alpha: z.number().min(0).max(1).optional() }).optional(),
  radius: z.number().min(0).max(1).optional(),
});

export const LAYER_SCHEMA = z.discriminatedUnion("type", [TEXT_LAYER_SCHEMA, LOGO_LAYER_SCHEMA, IMAGE_LAYER_SCHEMA, SHAPE_LAYER_SCHEMA]);

export const TEXT_DESIGN_SCHEMA = z.object({
  version: z.literal(1),
  layers: z.array(LAYER_SCHEMA).max(40),
  canvas: z
    .object({
      overlay: z.object({ color: hex, alpha: z.number().min(0).max(1) }).optional(),
      gradient: z.object({ color: hex, angle: z.number().min(0).max(360), from: z.number().min(0).max(1), to: z.number().min(0).max(1) }).optional(),
      blur: z.number().min(0).max(60).optional(),
      crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).optional(),
      offset: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }).optional(),
    })
    .optional(),
});

export const DEFAULT_SHAPE: Omit<ShapeLayer, "id"> = { type: "shape", shape: "rect", x: 0.1, y: 0.4, w: 0.8, h: 0.12, fill: { type: "solid", color: "#1129d3" }, radius: 0.01 };

export function newLogoLayer(over: Partial<LogoLayer> = {}): LogoLayer {
  return { type: "logo", id: layerId(), x: 0.4, y: 0.04, w: 0.2, name: "Logo", ...over };
}
export function newImageLayer(src: string, over: Partial<ImageLayer> = {}): ImageLayer {
  return { type: "image", id: layerId(), src, x: 0.25, y: 0.3, w: 0.5, h: 0.4, fit: "cover", ...over };
}
export function newShapeLayer(shape: ShapeKind, over: Partial<ShapeLayer> = {}): ShapeLayer {
  const base: ShapeLayer = { ...DEFAULT_SHAPE, id: layerId(), shape };
  if (shape === "line") return { ...base, h: 0.004, fill: { type: "solid", color: "#ffffff" }, radius: undefined, ...over };
  if (shape === "ellipse") return { ...base, w: 0.3, h: 0.24, x: 0.35, radius: undefined, ...over };
  return { ...base, ...over };
}

/** The look of a shape without its place: fill, stroke, corners. */
export function shapeStyleOf(l: ShapeLayer): Partial<ShapeLayer> {
  const { fill, stroke, radius, opacity, blend } = l;
  return { fill, stroke, radius, opacity, blend };
}

/** The look of a text layer without its words and place, for saved styles, presets and the month. */
export function styleOf(l: TextLayer): Partial<TextLayer> {
  const { font, weight, italic, size, lineHeight, letterSpacing, wordSpacing, paragraphSpacing, padding, align, transform, fill, opacity, stroke, shadow, innerShadow, glow, blur, background, curve, skew, blend } = l;
  return { font, weight, italic, size, lineHeight, letterSpacing, wordSpacing, paragraphSpacing, padding, align, transform, fill, opacity, stroke, shadow, innerShadow, glow, blur, background, curve, skew, blend };
}

/* ───────────── One look for the whole month ───────────── */

/** What "apply to all posts" carries across: the look of a roled text layer, or the logo's place and size. */
export type ApplyRole = "headline" | "subline" | "logo";

/** The place, size and finish of a logo layer, without its identity. */
export function logoPlacementOf(l: LogoLayer): Partial<LogoLayer> {
  const { x, y, w, rotate, opacity, variant, blend } = l;
  return { x, y, w, rotate, opacity, variant, blend };
}

/** The look to carry to the other posts from the selected layer, by its role; null when it has none. */
export function styleToApply(layer: Layer): { style: Partial<Layer>; role: ApplyRole } | null {
  if (isLogoLayer(layer)) return { style: logoPlacementOf(layer), role: "logo" };
  if (isTextLayer(layer) && layer.role) return { style: styleOf(layer), role: layer.role };
  return null;
}

/**
 * The look applied to one design: the same-role text layers take the style (their words, place and
 * box stay); for the logo, the design's logo layers move and resize, or one is added when the
 * design has none. Returns the same design when nothing changed.
 */
export function applyStyleToDesign(design: TextDesign, style: Partial<Layer>, role: ApplyRole): TextDesign {
  if (role === "logo") {
    const place = style as Partial<LogoLayer>;
    const has = design.layers.some(isLogoLayer);
    const layers = has ? design.layers.map((l) => (isLogoLayer(l) ? { ...l, ...place, id: l.id, type: "logo" as const } : l)) : [...design.layers, newLogoLayer(place)];
    return { ...design, layers };
  }
  // Only the look travels: never the words, the runs, the place, the box or the role.
  const look = { ...(style as Partial<TextLayer>) };
  for (const k of ["id", "type", "text", "runs", "x", "y", "w", "h", "role", "name", "hidden", "locked", "group", "autoSize", "fit"] as const) delete (look as Record<string, unknown>)[k];
  let changed = false;
  const layers = design.layers.map((l) => {
    if (!isTextLayer(l) || l.role !== role) return l;
    changed = true;
    return { ...l, ...look, text: l.text, runs: l.runs } as TextLayer;
  });
  return changed ? { ...design, layers } : design;
}

/**
 * The look applied across a month: every post but `current` gets it; a post without a design first
 * gets one made from its words (`designFor`, null when there is nothing to make one from). Returns
 * the new plan and how many posts changed. Only `ov.design` is touched: never a picture.
 */
export function applyStyleToPosts<P extends { index: number; ov?: { design?: TextDesign } }>(plan: P[], current: number, style: Partial<Layer>, role: ApplyRole, designFor: (post: P) => TextDesign | null): { plan: P[]; changed: number } {
  let changed = 0;
  const next = plan.map((p) => {
    if (p.index === current) return p;
    const base = p.ov?.design ?? designFor(p);
    if (!base) return p;
    const d = applyStyleToDesign(base, style, role);
    if (d === base && p.ov?.design) return p;
    changed++;
    return { ...p, ov: { ...(p.ov ?? {}), design: d } };
  });
  return { plan: next, changed };
}

/* ───────────── Pure helpers the renderer and the editor share ───────────── */

export const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const STRONG_LTR_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const STRONG_LTR = STRONG_LTR_RE;

/**
 * Groups a line's words into runs that read the same way: a Latin phrase inside an Arabic line (or
 * an Arabic one inside a Latin line) keeps its own order while the line as a whole reads in its
 * direction. Neutral words (numbers, punctuation) follow the word before them.
 */
export function directionRuns<T extends { text: string }>(tokens: T[], lineDir: "rtl" | "ltr"): { dir: "rtl" | "ltr"; tokens: T[] }[] {
  const out: { dir: "rtl" | "ltr"; tokens: T[] }[] = [];
  let cur = lineDir;
  for (const t of tokens) {
    const dir: "rtl" | "ltr" = ARABIC_RE.test(t.text) ? "rtl" : STRONG_LTR_RE.test(t.text) ? "ltr" : cur;
    const last = out[out.length - 1];
    if (last && last.dir === dir) last.tokens.push(t);
    else out.push({ dir, tokens: [t] });
    cur = dir;
  }
  return out;
}

/** The direction a paragraph reads in: its first strong character decides, Arabic when nothing is strong. */
export function paragraphDirection(text: string, wanted: Direction = "auto"): "rtl" | "ltr" {
  if (wanted !== "auto") return wanted;
  for (const ch of text) {
    if (ARABIC_RE.test(ch)) return "rtl";
    if (STRONG_LTR.test(ch)) return "ltr";
  }
  return ARABIC_RE.test(text) ? "rtl" : "ltr";
}

/** Upper, lower or title case; Arabic letters have no case and pass through. */
export function applyCase(text: string, mode: TextCase | undefined): string {
  if (!mode || mode === "none") return text;
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text.replace(/(^|\s)(\S)/g, (_, s: string, c: string) => s + c.toUpperCase());
}

/** The style of character `i`: the layer's own, with every run that covers it on top. */
export function styleAt(runs: TextRun[] | undefined, i: number): RunStyle {
  let out: RunStyle = {};
  for (const r of runs ?? []) if (i >= r.from && i < r.to) out = { ...out, ...r.style };
  return out;
}

/** Cuts [from, to) into pieces whose style is the same throughout. */
export function segmentsOf(runs: TextRun[] | undefined, from: number, to: number): { from: number; to: number; style: RunStyle }[] {
  const cuts = new Set<number>([from, to]);
  for (const r of runs ?? []) {
    if (r.from > from && r.from < to) cuts.add(r.from);
    if (r.to > from && r.to < to) cuts.add(r.to);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: { from: number; to: number; style: RunStyle }[] = [];
  for (let k = 0; k + 1 < points.length; k++) if (points[k + 1] > points[k]) out.push({ from: points[k], to: points[k + 1], style: styleAt(runs, points[k]) });
  return out;
}

/**
 * Sets a style on [from, to): a run is added, and the same property on runs underneath is left
 * (the new run wins where it covers). Passing `undefined` for a property clears it on that range.
 */
export function setRunStyle(runs: TextRun[] | undefined, from: number, to: number, style: RunStyle): TextRun[] {
  if (to <= from) return runs ?? [];
  const keys = Object.keys(style) as (keyof RunStyle)[];
  const out: TextRun[] = [];
  // Every run is split around the range and loses the properties the new run sets.
  for (const r of runs ?? []) {
    const stripped: RunStyle = { ...r.style };
    const overlap = r.from < to && r.to > from;
    if (!overlap) {
      out.push(r);
      continue;
    }
    if (r.from < from) out.push({ from: r.from, to: from, style: r.style });
    if (r.to > to) out.push({ from: to, to: r.to, style: r.style });
    for (const k of keys) delete stripped[k];
    const a = Math.max(r.from, from);
    const b = Math.min(r.to, to);
    if (Object.keys(stripped).length && b > a) out.push({ from: a, to: b, style: stripped });
  }
  const kept: RunStyle = {};
  for (const k of keys) if (style[k] !== undefined) (kept as Record<string, unknown>)[k] = style[k];
  if (Object.keys(kept).length) out.push({ from, to, style: kept });
  return out.filter((r) => r.to > r.from && Object.keys(r.style).length).sort((a, b) => a.from - b.from);
}

/** Moves run boundaries after the text changed: `at` is where `removed` characters became `added`. */
export function shiftRuns(runs: TextRun[] | undefined, at: number, removed: number, added: number): TextRun[] | undefined {
  if (!runs?.length) return runs;
  const delta = added - removed;
  const end = at + removed;
  // Text typed exactly at a run's edge stays outside it: the run moves along instead of growing.
  const moveFrom = (i: number) => (i >= end ? i + delta : i <= at ? i : at);
  const moveTo = (i: number) => (i <= at ? i : i >= end ? i + delta : at);
  const out: TextRun[] = [];
  for (const r of runs) {
    const from = moveFrom(r.from);
    const to = moveTo(r.to);
    if (to > from) out.push({ ...r, from, to });
  }
  return out.length ? out : undefined;
}

/** The one place a text edit goes through: the new text, and runs moved with it. */
export function editText(layer: TextLayer, next: string): TextLayer {
  const prev = layer.text;
  if (prev === next) return layer;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { ...layer, text: next, runs: shiftRuns(layer.runs, start, endPrev - start, endNext - start) };
}

/** Relative luminance (0..1) of a #rrggbb colour. */
export function luminance(hexColor: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexColor.trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** WCAG contrast ratio between two luminances. */
export function contrastRatio(l1: number, l2: number): number {
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

/** The colour a fill mostly shows (its first stop for a gradient). */
export function fillColor(f: Fill): string {
  return f.type === "solid" ? f.color : (f.stops[0]?.color ?? "#ffffff");
}

/** Finds and replaces across every layer's text (a plain, case-insensitive match). */
export function replaceInLayers<L extends Layer>(layers: L[], find: string, replace: string): { layers: L[]; count: number } {
  if (!find) return { layers, count: 0 };
  let count = 0;
  const esc = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc, "gi");
  const out = layers.map((l) => {
    if (!isTextLayer(l)) return l;
    const hits = l.text.match(re)?.length ?? 0;
    if (!hits) return l;
    count += hits;
    return editText(l, l.text.replace(re, replace)) as L;
  });
  return { layers: out, count };
}

/** The headline and second line the plan keeps: the roled layers' words, else the first two layers'. */
export function wordsOf(design: TextDesign): { headline: string; subline: string } {
  const visible = design.layers.filter(isTextLayer).filter((l) => !l.hidden && l.text.trim());
  const head = visible.find((l) => l.role === "headline") ?? visible[0];
  const sub = visible.find((l) => l.role === "subline" && l !== head) ?? visible.find((l) => l !== head && !l.role);
  const one = (t: string | undefined) => (t ?? "").replace(/\s*\n\s*/g, " ").trim();
  return { headline: one(head?.text), subline: one(sub?.text) };
}
