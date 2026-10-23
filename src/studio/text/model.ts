/**
 * Editor-side helpers of the Text studio: the first design made from a post's legacy headline,
 * presets built on the brand, snapping, hit tests, saved styles and the small stores in the browser.
 */
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import { BODY_FONTS, HEADLINE_FONTS, LATIN_FONTS } from "@shared/overlay";
import { contrastRatio, fillColor, luminance, newLogoLayer, newTextLayer, type Layer, type TextDesign, type TextLayer } from "@shared/layers";
import { layoutBox, luminanceUnder, type LayerBox } from "@/lib/textLayers";

export interface Brand {
  id: string;
  name: string;
  colors: { name: string; hex: string }[];
  fonts: { headline?: string; body?: string };
  fontFiles: { id: string; name: string }[];
  tone?: string;
  language?: "ar" | "en" | "both";
}

/** The brand's font families: uploaded files first, then the two named in the brand kit. */
export function brandFonts(b: Brand): string[] {
  return [...new Set([...b.fontFiles.map((f) => f.name), b.fonts.headline ?? "", b.fonts.body ?? ""].filter(Boolean))];
}

/**
 * A post that was never opened in the studio: its headline and second line become two layers
 * exactly where the automatic layout put them, and the fade becomes a gradient helper.
 */
/**
 * The automatic layout as layers. `logoRect` is where the client's layout drew the logo (when it drew
 * one): it becomes a logo layer in that very place, so the logo can be selected, moved, resized or
 * hidden like any layer instead of being drawn under the design where nothing reaches it.
 */
export function designFromLegacy(spec: OverlaySpec, headline: string, subline: string, patch: PostOverlayPatch | undefined, textRect: { x: number; y: number; w: number; h: number } | null, W: number, H: number, logoRect: { x: number; y: number; w: number; h: number } | null = null): TextDesign {
  const h = spec.headline;
  const p = patch ?? {};
  const scale = p.scale ?? 1;
  const cap = Math.min(scale, (0.34 * H) / Math.max(1, h.size * W * 2.4));
  const size = h.size * Math.max(0.5, cap);
  const margin = spec.margin;
  const align = p.align ?? h.align;
  const x = textRect ? textRect.x / W : margin;
  const w = textRect ? textRect.w / W : 1 - margin * 2;
  const y0 = textRect ? textRect.y / H : h.position === "top" ? h.inset * (W / H) : h.position === "center" ? 0.4 : 1 - (h.inset * W) / H - 0.25;
  const layers: Layer[] = [];
  const shadow = h.shadow ? { color: h.shadow, blur: 0, x: 0, y: (h.shadowOffset * scale) / size } : undefined;
  const head = newTextLayer(headline, {
    name: "Headline",
    role: "headline",
    x,
    y: y0,
    w,
    font: h.font,
    weight: h.weight,
    size,
    lineHeight: h.lineHeight,
    letterSpacing: h.letterSpacing || undefined,
    align: align === "center" ? "center" : align,
    fill: { type: "solid", color: p.color ?? h.color },
    shadow,
  });
  if (headline.trim()) layers.push(head);
  const showSub = spec.subline.show !== false && subline.trim();
  if (showSub) {
    const sSize = spec.subline.size * Math.max(0.5, cap);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const headH = headline.trim() ? layoutBox(canvas.getContext("2d")!, head, W, H).box.h / H : 0;
    layers.push(
      newTextLayer(subline, {
        name: "Second line",
        role: "subline",
        x,
        y: y0 + headH + (headline.trim() ? (spec.subline.gap * W) / H : 0),
        w,
        font: spec.subline.font || h.font,
        weight: spec.subline.weight,
        size: sSize,
        lineHeight: 1.3,
        align: align === "center" ? "center" : align,
        fill: { type: "solid", color: p.subColor ?? spec.subline.color },
      }),
    );
  }
  const fade = spec.scrim > 0 && p.fade !== false && layers.length;
  // The logo first: the layout draws it under the words.
  if (logoRect && logoRect.w > 0) layers.unshift(newLogoLayer({ x: logoRect.x / W, y: logoRect.y / H, w: logoRect.w / W }));
  const position = p.position ?? h.position;
  return {
    version: 1,
    layers,
    canvas: fade
      ? {
          gradient:
            position === "center"
              ? { color: spec.scrimColor, angle: 180, from: spec.scrim * 0.6, to: spec.scrim * 0.6 }
              : { color: spec.scrimColor, angle: position === "top" ? 0 : 180, from: 0, to: spec.scrim },
        }
      : undefined,
  };
}

/* ───────────── Text styles (the look of one layer) and layouts (whole arrangements) ───────────── */

/*
 * Layouts are whole arrangements (headline, second line, price, logo, helpers) built from the
 * brand and the post's words in its language; they live in shared/layouts.ts so the tests and
 * "apply to all designs" can build them without a browser. Text styles below change one layer's
 * look only (outline, neon, gradient) and never move anything.
 */
export { LAYOUTS, applyLayout, layoutsFor, type LayoutContext, type LayoutPreset } from "@shared/layouts";
export { LANGUAGE_LABELS, directionFor, languageWithSource, resolveLanguage, sampleContent, type ClientLanguage } from "@shared/language";

export interface Preset {
  name: string;
  hint: string;
  make: (b: Brand) => Partial<TextLayer>;
}

const headFont = (b: Brand) => b.fonts.headline || b.fontFiles[0]?.name || "Cairo";
const bodyFont = (b: Brand) => b.fonts.body || b.fontFiles[1]?.name || b.fonts.headline || "Almarai";
const brandColor = (b: Brand, i: number, fallback: string) => b.colors[i]?.hex ?? fallback;

export const PRESETS: Preset[] = [
  { name: "Headline", hint: "The brand's headline face, big and white", make: (b) => ({ font: headFont(b), weight: 700, size: 0.085, lineHeight: 1.1, fill: { type: "solid", color: "#ffffff" } }) },
  { name: "Second line", hint: "The body face at 55% of the headline", make: (b) => ({ font: bodyFont(b), weight: 400, size: 0.045, lineHeight: 1.3, fill: { type: "solid", color: "#ffffff" } }) },
  { name: "Caption", hint: "Small, wide-set, for a date or a place", make: (b) => ({ font: bodyFont(b), weight: 500, size: 0.028, lineHeight: 1.3, letterSpacing: 0.12, transform: "upper", fill: { type: "solid", color: "#ffffff" } }) },
  { name: "Price tag", hint: "A pill in the first brand colour", make: (b) => ({ font: headFont(b), weight: 800, size: 0.05, lineHeight: 1.1, w: 0.36, fill: { type: "solid", color: "#ffffff" }, background: { color: brandColor(b, 0, "#1129d3"), alpha: 1, padding: 0.5, radius: 2 } }) },
  { name: "Sticker", hint: "Tilted, outlined, playful", make: (b) => ({ font: headFont(b), weight: 900, size: 0.06, rotate: -6, fill: { type: "solid", color: brandColor(b, 1, "#ffd400") }, stroke: { color: "#111111", width: 0.08 }, shadow: { color: "#000000", blur: 0, x: 0.06, y: 0.06 } }) },
  { name: "Quote", hint: "Italic serif, centred", make: () => ({ font: "Playfair Display", italic: true, weight: 400, size: 0.055, lineHeight: 1.3, fill: { type: "solid", color: "#ffffff" } }) },
  { name: "Editorial", hint: "Upper case, letter-spaced, thin", make: (b) => ({ font: headFont(b), weight: 300, size: 0.05, letterSpacing: 0.25, transform: "upper", lineHeight: 1.4, fill: { type: "solid", color: "#ffffff" } }) },
  { name: "Outline", hint: "Hollow letters", make: (b) => ({ font: headFont(b), weight: 800, size: 0.11, fill: { type: "solid", color: "#ffffff", alpha: 0 }, stroke: { color: "#ffffff", width: 0.03, outside: false } }) },
  { name: "Neon", hint: "Glowing script", make: () => ({ font: "Pacifico", weight: 400, size: 0.09, fill: { type: "solid", color: "#ffffff" }, glow: { color: "#ff3fa4", blur: 0.5, strength: 3 } }) },
  { name: "Gradient", hint: "Two brand colours across the words", make: (b) => ({ font: headFont(b), weight: 800, size: 0.09, fill: { type: "linear", angle: 90, stops: [{ at: 0, color: brandColor(b, 0, "#1129d3") }, { at: 1, color: brandColor(b, 1, "#bbf714") }] } }) },
  { name: "Glass box", hint: "Frosted backing behind the words", make: (b) => ({ font: bodyFont(b), weight: 600, size: 0.04, lineHeight: 1.35, padding: 0.6, fill: { type: "solid", color: "#ffffff" }, background: { color: "#000000", alpha: 0.25, padding: 0.4, radius: 0.8, blur: 18 } }) },
  { name: "Arc", hint: "Words along a curve", make: (b) => ({ font: headFont(b), weight: 800, size: 0.07, curve: 50, fill: { type: "solid", color: "#ffffff" } }) },
];

/*
 * The look of a layer (styleOf) and "one look for the whole month" (applyStyleToDesign,
 * applyStyleToPosts, styleToApply, logoPlacementOf, ApplyRole) are pure data logic and live in
 * shared/layers.ts so the tests and the server can read them; the editor takes them from here.
 */
export { applyStyleToDesign, applyStyleToPosts, logoPlacementOf, styleOf, styleToApply, type ApplyRole } from "@shared/layers";

/* ───────────── Small stores ───────────── */

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export interface SavedStyle {
  name: string;
  style: Partial<TextLayer>;
}
export const savedStyles = {
  list: (clientId: string): SavedStyle[] => read(`lsm-text-styles:${clientId}`, []),
  save: (clientId: string, list: SavedStyle[]) => write(`lsm-text-styles:${clientId}`, list.slice(0, 40)),
};
export const recentFonts = {
  list: (): string[] => read("lsm-recent-fonts", []),
  add: (f: string) => write("lsm-recent-fonts", [f, ...recentFonts.list().filter((x) => x !== f)].slice(0, 8)),
};
export const favouriteFonts = {
  list: (): string[] => read("lsm-fav-fonts", []),
  toggle: (f: string) => {
    const l = favouriteFonts.list();
    write("lsm-fav-fonts", l.includes(f) ? l.filter((x) => x !== f) : [f, ...l].slice(0, 20));
  },
};
export const savedColours = {
  list: (clientId: string): string[] => read(`lsm-text-colours:${clientId}`, []),
  add: (clientId: string, hex: string) => write(`lsm-text-colours:${clientId}`, [hex, ...savedColours.list(clientId).filter((x) => x !== hex)].slice(0, 16)),
};

export const ALL_FONTS = [...HEADLINE_FONTS, ...BODY_FONTS, ...LATIN_FONTS];
export const isLatinFont = (f: string) => LATIN_FONTS.some((x) => x.family === f);

/* ───────────── Geometry ───────────── */

/** Pointer position in a layer's own frame (rotation undone around its centre). */
export function toLocal(box: LayerBox, x: number, y: number): { x: number; y: number } {
  if (!box.rotate) return { x, y };
  const a = (-box.rotate * Math.PI) / 180;
  const dx = x - box.cx;
  const dy = y - box.cy;
  return { x: box.cx + dx * Math.cos(a) - dy * Math.sin(a), y: box.cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

/**
 * The layer under the pointer, top first. A background (drawn behind the photograph) is only hit
 * once it is selected, from the layers list: a click on the photograph never grabs it by mistake.
 */
export function hitLayer(boxes: LayerBox[], layers: Layer[], x: number, y: number, slack = 0, selected: string[] = []): LayerBox | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    const l = layers.find((k) => k.id === b.id);
    if (!l || l.hidden) continue;
    if (l.type === "image" && l.behind && !selected.includes(l.id)) continue;
    const p = toLocal(b, x, y);
    if (p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack) return b;
  }
  return null;
}

export interface Guide {
  axis: "x" | "y";
  at: number;
}

/**
 * Magnetic snapping while moving: the box's edges and centre pull to the canvas centre, the
 * safe margins, the edges and the other layers' edges and centres. Returns the corrected delta.
 */
export function snapMove(moving: LayerBox[], others: LayerBox[], dx: number, dy: number, W: number, H: number, margin: number, threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [0, W / 2, W, margin, W - margin, ...others.flatMap((b) => [b.x, b.cx, b.x + b.w])];
  const ys = [0, H / 2, H, margin, H - margin, ...others.flatMap((b) => [b.y, b.cy, b.y + b.h])];
  const guides: Guide[] = [];
  let bestX: { d: number; at: number } | null = null;
  let bestY: { d: number; at: number } | null = null;
  for (const b of moving) {
    for (const edge of [b.x + dx, b.cx + dx, b.x + b.w + dx]) for (const t of xs) {
      const d = t - edge;
      if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: t };
    }
    for (const edge of [b.y + dy, b.cy + dy, b.y + b.h + dy]) for (const t of ys) {
      const d = t - edge;
      if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: t };
    }
  }
  if (bestX) {
    dx += bestX.d;
    guides.push({ axis: "x", at: bestX.at });
  }
  if (bestY) {
    dy += bestY.d;
    guides.push({ axis: "y", at: bestY.at });
  }
  return { dx, dy, guides };
}

/** The contrast of a layer's main colour over the picture under it (WCAG ratio; under 3 reads badly). */
export function contrastOf(base: HTMLCanvasElement | null, layer: TextLayer, box: LayerBox | undefined): number | null {
  if (!base || !box) return null;
  if (layer.background && layer.background.alpha > 0.5) return contrastRatio(luminance(fillColor(layer.fill)), luminance(layer.background.color));
  const under = luminanceUnder(base, box);
  return contrastRatio(luminance(fillColor(layer.fill)), under);
}

/** Is this colour one of the brand's (or near enough)? */
export function onPalette(hex: string, palette: string[]): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const near = (o: string) => {
    const k = /^#?([0-9a-f]{6})$/i.exec(o.trim());
    if (!k) return false;
    const v = parseInt(k[1], 16);
    const d = Math.abs(((n >> 16) & 255) - ((v >> 16) & 255)) + Math.abs(((n >> 8) & 255) - ((v >> 8) & 255)) + Math.abs((n & 255) - (v & 255));
    return d < 36;
  };
  return near("#ffffff") || near("#000000") || palette.some(near);
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The composite with the given design, for the assistant and the export. */
export function patchWith(patch: PostOverlayPatch | undefined, design: TextDesign): PostOverlayPatch {
  return { ...(patch ?? {}), design };
}
