/**
 * Layouts: whole arrangements of words, shapes, helpers and the logo over a post, built from the
 * client's fonts and colours and the post's own words in its language. A layout is data (layers),
 * never a picture: applying one changes only the design, and the browser's renderer draws it.
 * Text styles (the look of one layer: outline, neon, gradient) live in the editor's model; this
 * file holds only the full layouts.
 */
import { LATIN_FONTS } from "./overlay";
import { luminance, newLogoLayer, newShapeLayer, newTextLayer, type CanvasFx, type Layer, type TextDesign, type TextLayer } from "./layers";
import { alignFor, directionFor, languageOfText, type ClientLanguage, type SampleContent } from "./language";

/** What a layout needs to know about the brand (the editor's Brand satisfies it). */
export interface LayoutBrand {
  colors: { name: string; hex: string }[];
  fonts: { headline?: string; body?: string };
  fontFiles: { id: string; name: string }[];
}

export interface LayoutContext {
  brand: LayoutBrand;
  language: ClientLanguage;
  sample: SampleContent;
  /** The client has a logo file: the layout places it. */
  hasLogo: boolean;
  /** Canvas height over width (1.25 for 4:5), for places given in widths. */
  ratio: number;
}

export interface LayoutPreset {
  id: string;
  name: string;
  hint: string;
  /** Only offered for bilingual clients. */
  bilingualOnly?: boolean;
  make: (ctx: LayoutContext) => { layers: Layer[]; canvas?: CanvasFx };
}

/* ───────────── Fonts and colours ───────────── */

export const isLatinOnlyFont = (f: string) => LATIN_FONTS.some((x) => x.family === f);

type Flavour = "bold" | "editorial" | "minimal" | "launch" | "offer" | "statement";

/** Default faces per language when the brand kit names none: Arabic faces that also carry Latin, Latin faces for English clients. */
const DEFAULT_FONTS: Record<"ar" | "en", Record<Flavour, { headline: string; body: string }>> = {
  ar: {
    bold: { headline: "Cairo", body: "Almarai" },
    editorial: { headline: "El Messiri", body: "Almarai" },
    minimal: { headline: "Almarai", body: "Almarai" },
    launch: { headline: "Beiruti", body: "Tajawal" },
    offer: { headline: "Cairo", body: "Almarai" },
    statement: { headline: "Noto Kufi Arabic", body: "Almarai" },
  },
  en: {
    bold: { headline: "Montserrat", body: "Inter" },
    editorial: { headline: "Playfair Display", body: "Inter" },
    minimal: { headline: "Inter", body: "Inter" },
    launch: { headline: "Unbounded", body: "Inter" },
    offer: { headline: "Poppins", body: "Inter" },
    statement: { headline: "Anton", body: "Inter" },
  },
};

/**
 * The face for a role: the brand kit's font first (the client's identity, whatever the language),
 * then an uploaded brand file, then a default for the language and the layout's flavour. An
 * English client never gets an Arabic default, and an Arabic client never a Latin-only one.
 */
export function fontFor(brand: LayoutBrand, role: "headline" | "body", language: ClientLanguage, flavour: Flavour, forText?: string): string {
  const lang: "ar" | "en" = forText ? languageOfText(forText, language === "en" ? "en" : "ar") : language === "en" ? "en" : "ar";
  const named = role === "headline" ? brand.fonts.headline : brand.fonts.body;
  if (named) return named;
  const uploaded = brand.fontFiles[role === "headline" ? 0 : 1]?.name ?? brand.fontFiles[0]?.name;
  if (uploaded) return uploaded;
  if (role === "body" && brand.fonts.headline) return brand.fonts.headline;
  return DEFAULT_FONTS[lang][flavour][role];
}

export const brandHex = (b: LayoutBrand, i: number, fallback: string) => b.colors[i]?.hex ?? fallback;
/** White or near-black, whichever reads on the colour. */
export const inkOn = (hex: string) => (luminance(hex) > 0.45 ? "#111111" : "#ffffff");

/* ───────────── Pieces ───────────── */

const white = { type: "solid" as const, color: "#ffffff" };
const solid = (color: string) => ({ type: "solid" as const, color });

function text(ctx: LayoutContext, words: string, over: Partial<TextLayer>, language?: ClientLanguage): TextLayer {
  const lang = language ?? ctx.language;
  return newTextLayer(words, { direction: directionFor(lang), fill: white, autoSize: true, ...over });
}

/** The post's headline in its language, with the role the plan keeps in step. */
function headline(ctx: LayoutContext, over: Partial<TextLayer>, flavour: Flavour): TextLayer {
  return text(ctx, ctx.sample.headline, { name: "Headline", role: "headline", font: fontFor(ctx.brand, "headline", ctx.language, flavour, ctx.sample.headline), ...over });
}

function subline(ctx: LayoutContext, over: Partial<TextLayer>, flavour: Flavour): TextLayer | null {
  if (!ctx.sample.subline.trim()) return null;
  return text(ctx, ctx.sample.subline, { name: "Second line", role: "subline", font: fontFor(ctx.brand, "body", ctx.language, flavour, ctx.sample.subline), weight: 400, lineHeight: 1.35, ...over });
}

/**
 * A bilingual client's second headline: the other language's line as its own layer, read in its
 * own direction, so each language is edited on its own. Never a translation: the post's line in
 * that script, or sample copy to write over.
 */
function altHeadline(ctx: LayoutContext, over: Partial<TextLayer>, flavour: Flavour): TextLayer | null {
  if (ctx.language !== "both" || !ctx.sample.headlineAlt) return null;
  const lang = languageOfText(ctx.sample.headlineAlt);
  return text(ctx, ctx.sample.headlineAlt, { name: lang === "ar" ? "Headline (Arabic)" : "Headline (English)", font: fontFor(ctx.brand, "headline", lang, flavour, ctx.sample.headlineAlt), align: alignFor(lang), ...over }, lang);
}

function logo(ctx: LayoutContext, x: number, y: number, w: number): Layer | null {
  return ctx.hasLogo ? newLogoLayer({ x, y, w, name: "Logo" }) : null;
}

const keep = (...layers: (Layer | null)[]): Layer[] => layers.filter((l): l is Layer => !!l);

/* ───────────── The layouts ───────────── */

export const LAYOUTS: LayoutPreset[] = [
  {
    id: "bold",
    name: "Bold promotional",
    hint: "A big headline low on the picture, the offer in a brand-colour pill above",
    make: (ctx) => {
      const side = alignFor(ctx.language);
      const primary = brandHex(ctx.brand, 0, "#1129d3");
      const m = 0.07;
      const head = headline(ctx, { x: m, y: 0.6, w: 1 - m * 2, size: 0.1, weight: 800, lineHeight: 1.05, align: side }, "bold");
      const alt = altHeadline(ctx, { x: m, y: 0.76, w: 1 - m * 2, size: 0.065, weight: 700, lineHeight: 1.1 }, "bold");
      const sub = subline(ctx, { x: m, y: alt ? 0.86 : 0.8, w: 1 - m * 2, size: 0.038, align: side }, "bold");
      const pill = text(ctx, ctx.sample.price, { name: "Offer", font: fontFor(ctx.brand, "headline", ctx.language, "bold", ctx.sample.price), weight: 800, size: 0.045, lineHeight: 1.1, x: side === "right" ? 1 - m - 0.34 : m, y: 0.08, w: 0.34, align: "center", fill: solid(inkOn(primary)), background: { color: primary, alpha: 1, padding: 0.5, radius: 2 } });
      return { layers: keep(logo(ctx, side === "right" ? m : 1 - m - 0.18, 0.06, 0.18), pill, head, alt, sub), canvas: { gradient: { color: "#000000", angle: 180, from: 0, to: 0.7 } } };
    },
  },
  {
    id: "editorial",
    name: "Editorial",
    hint: "A small caption and rule at the top, a quiet headline centred low, a spaced second line",
    make: (ctx) => {
      const m = 0.1;
      const latin = ctx.language === "en";
      const cap = text(ctx, ctx.sample.cta, { name: "Caption", font: fontFor(ctx.brand, "body", ctx.language, "editorial"), weight: 500, size: 0.026, letterSpacing: latin ? 0.2 : 0.04, transform: latin ? "upper" : "none", x: m, y: 0.08, w: 1 - m * 2, align: "center" });
      const rule = newShapeLayer("line", { name: "Rule", x: 0.42, y: 0.128, w: 0.16, h: 0.002, fill: white });
      const head = headline(ctx, { x: m, y: 0.62, w: 1 - m * 2, size: 0.072, weight: 500, lineHeight: 1.2, align: "center" }, "editorial");
      const alt = altHeadline(ctx, { x: m, y: 0.75, w: 1 - m * 2, size: 0.05, weight: 400, lineHeight: 1.2, align: "center" }, "editorial");
      const sub = subline(ctx, { x: m, y: alt ? 0.84 : 0.78, w: 1 - m * 2, size: 0.03, letterSpacing: latin ? 0.12 : 0.02, transform: latin ? "upper" : "none", align: "center" }, "editorial");
      return { layers: keep(logo(ctx, 0.42, 0.9, 0.16), cap, rule, head, alt, sub), canvas: { gradient: { color: "#000000", angle: 180, from: 0, to: 0.5 } } };
    },
  },
  {
    id: "minimal",
    name: "Minimal premium",
    hint: "Air around a modest headline in the corner, a thin second line, the logo small",
    make: (ctx) => {
      const side = alignFor(ctx.language);
      const m = 0.08;
      const head = headline(ctx, { x: m, y: 0.74, w: 0.7, size: 0.055, weight: 500, lineHeight: 1.2, align: side, ...(side === "right" ? { x: 1 - m - 0.7 } : {}) }, "minimal");
      const alt = altHeadline(ctx, { x: side === "right" ? 1 - m - 0.7 : m, y: 0.83, w: 0.7, size: 0.04, weight: 400 }, "minimal");
      const sub = subline(ctx, { x: side === "right" ? 1 - m - 0.7 : m, y: alt ? 0.9 : 0.84, w: 0.7, size: 0.028, weight: 300, align: side }, "minimal");
      return { layers: keep(logo(ctx, side === "right" ? 1 - m - 0.14 : m, 0.06, 0.14), head, alt, sub), canvas: { gradient: { color: "#000000", angle: 180, from: 0, to: 0.3 } } };
    },
  },
  {
    id: "launch",
    name: "Product launch",
    hint: "A small 'new' tag and the headline at the top, the product free below, a call to action at the foot",
    make: (ctx) => {
      const primary = brandHex(ctx.brand, 0, "#1129d3");
      const m = 0.08;
      const tag = text(ctx, ctx.language === "en" ? "New" : "جديد", { name: "Tag", font: fontFor(ctx.brand, "body", ctx.language, "launch"), weight: 700, size: 0.03, lineHeight: 1.1, x: 0.5 - 0.09, y: 0.07, w: 0.18, align: "center", letterSpacing: ctx.language === "en" ? 0.12 : 0, transform: ctx.language === "en" ? "upper" : "none", fill: solid(inkOn(primary)), background: { color: primary, alpha: 1, padding: 0.5, radius: 2 } });
      const head = headline(ctx, { x: m, y: 0.13, w: 1 - m * 2, size: 0.085, weight: 800, lineHeight: 1.05, align: "center" }, "launch");
      const alt = altHeadline(ctx, { x: m, y: 0.25, w: 1 - m * 2, size: 0.055, weight: 700, align: "center" }, "launch");
      const sub = subline(ctx, { x: m, y: alt ? 0.32 : 0.27, w: 1 - m * 2, size: 0.034, align: "center" }, "launch");
      const cta = text(ctx, ctx.sample.cta, { name: "Call to action", font: fontFor(ctx.brand, "body", ctx.language, "launch"), weight: 700, size: 0.036, lineHeight: 1.1, x: 0.5 - 0.2, y: 0.88, w: 0.4, align: "center", fill: solid("#111111"), background: { color: "#ffffff", alpha: 1, padding: 0.6, radius: 2 } });
      return { layers: keep(logo(ctx, m, 0.9, 0.14), tag, head, alt, sub, cta), canvas: { gradient: { color: "#000000", angle: 0, from: 0, to: 0.55 } } };
    },
  },
  {
    id: "offer",
    name: "Clean price / offer",
    hint: "The headline in a corner, the price large in a brand-colour block opposite, nothing else",
    make: (ctx) => {
      const side = alignFor(ctx.language);
      const primary = brandHex(ctx.brand, 0, "#1129d3");
      const m = 0.07;
      const head = headline(ctx, { x: side === "right" ? 1 - m - 0.6 : m, y: 0.08, w: 0.6, size: 0.065, weight: 800, lineHeight: 1.1, align: side }, "offer");
      const alt = altHeadline(ctx, { x: side === "right" ? 1 - m - 0.6 : m, y: 0.2, w: 0.6, size: 0.045, weight: 700 }, "offer");
      const sub = subline(ctx, { x: side === "right" ? 1 - m - 0.6 : m, y: alt ? 0.27 : 0.2, w: 0.6, size: 0.032, align: side }, "offer");
      const price = text(ctx, ctx.sample.price, { name: "Price", font: fontFor(ctx.brand, "headline", ctx.language, "offer", ctx.sample.price), weight: 900, size: 0.08, lineHeight: 1.05, x: side === "right" ? m : 1 - m - 0.44, y: 0.8, w: 0.44, align: "center", fill: solid(inkOn(primary)), background: { color: primary, alpha: 1, padding: 0.35, radius: 0.3 } });
      return { layers: keep(logo(ctx, side === "right" ? m : 1 - m - 0.16, 0.06, 0.16), head, alt, sub, price), canvas: { gradient: { color: "#000000", angle: 180, from: 0, to: 0.45 } } };
    },
  },
  {
    id: "statement",
    name: "Typographic statement",
    hint: "One giant headline across the middle, shrunk to fit its box, a tiny line at the foot",
    make: (ctx) => {
      const latin = ctx.language === "en";
      const m = 0.06;
      const head = headline(ctx, { x: m, y: 0.3, w: 1 - m * 2, h: 0.4, size: 0.15, weight: 900, lineHeight: 1.0, letterSpacing: latin ? -0.03 : 0, align: "center", vAlign: "middle", autoSize: false, fit: true }, "statement");
      const alt = altHeadline(ctx, { x: m, y: 0.72, w: 1 - m * 2, size: 0.06, weight: 800, lineHeight: 1.05, align: "center" }, "statement");
      const sub = subline(ctx, { x: m, y: alt ? 0.83 : 0.8, w: 1 - m * 2, size: 0.028, letterSpacing: latin ? 0.14 : 0.02, transform: latin ? "upper" : "none", align: "center" }, "statement");
      return { layers: keep(logo(ctx, 0.42, 0.06, 0.16), head, alt, sub), canvas: { overlay: { color: "#000000", alpha: 0.2 }, gradient: { color: "#000000", angle: 180, from: 0, to: 0.4 } } };
    },
  },
  {
    id: "bilingual",
    name: "Bilingual split",
    hint: "Arabic at the top right, English at the bottom left, each its own layer",
    bilingualOnly: true,
    make: (ctx) => {
      const m = 0.07;
      const arFirst = languageOfText(ctx.sample.headline) === "ar";
      const top = arFirst ? ctx.sample.headline : (ctx.sample.headlineAlt ?? ctx.sample.headline);
      const bottom = arFirst ? (ctx.sample.headlineAlt ?? "") : ctx.sample.headline;
      const ar = text(ctx, top, { name: "Headline (Arabic)", role: arFirst ? "headline" : undefined, font: fontFor(ctx.brand, "headline", "ar", "bold", top), weight: 800, size: 0.085, lineHeight: 1.1, x: 1 - m - 0.7, y: 0.1, w: 0.7, align: "right" }, "ar");
      const en = bottom ? text(ctx, bottom, { name: "Headline (English)", role: arFirst ? undefined : "headline", font: fontFor(ctx.brand, "headline", "en", "bold", bottom), weight: 800, size: 0.075, lineHeight: 1.05, x: m, y: 0.72, w: 0.7, align: "left" }, "en") : null;
      const sub = subline(ctx, { x: m, y: 0.86, w: 1 - m * 2, size: 0.03, align: "left" }, "bold");
      return { layers: keep(logo(ctx, m, 0.07, 0.16), ar, en, sub), canvas: { gradient: { color: "#000000", angle: 180, from: 0.25, to: 0.6 } } };
    },
  },
];

/** The layouts a client sees: the bilingual split only when it writes in both languages. */
export function layoutsFor(language: ClientLanguage): LayoutPreset[] {
  return LAYOUTS.filter((l) => !l.bilingualOnly || language === "both");
}

/**
 * A layout applied to a design: its words, shapes, helpers and logo replace the design's; the
 * pictures the designer added (image layers) stay underneath. The result is a new design, so the
 * editor's undo brings the old one back.
 */
export function applyLayout(design: TextDesign | null, made: { layers: Layer[]; canvas?: CanvasFx }): TextDesign {
  const pictures = (design?.layers ?? []).filter((l) => l.type === "image");
  return { version: 1, layers: [...pictures, ...made.layers], canvas: made.canvas };
}
