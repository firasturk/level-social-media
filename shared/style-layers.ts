/**
 * Designed styles, the apply side (28 Oct): a pin's StyleDesign (shared/style-design.ts) turned into
 * the post's own layers. The engine makes the photograph alone; these layers draw the words in the
 * client's fonts and colours with the post's own headline, second line and caption, and rebuild an
 * Instagram post mockup with the client's own account (handle, name, picture, caption, hashtags,
 * logo). Pure and deterministic: no model, no DOM, the same input gives the same design, so the
 * layers are made again whenever the words change (until the designer edits them by hand).
 *
 * Units follow the renderer (src/lib/textLayers.ts): x, w, font sizes, shape strokes and corner radii
 * are fractions of the canvas WIDTH; y and h of the HEIGHT; lineHeight and a text background's padding
 * and radius are ems.
 */
import type { DesignText, DesignMockup, StyleDesign } from "./style-design";
import {
  contrastRatio,
  luminance,
  type Fill,
  type ImageLayer,
  type Layer,
  type LogoLayer,
  type ShapeLayer,
  type TextDesign,
  type TextLayer,
  type TextRun,
} from "./layers";
import { fontFor, inkOn, type LayoutBrand } from "./layouts";
import { languageOfText, type ClientLanguage } from "./language";

export interface StyleLayerContext {
  headline: string;
  subline: string;
  caption: string;
  hashtags: string;
  /** The client's Instagram handle without "@". */
  handle: string;
  /** The account's display name (the client's name). */
  accountName: string;
  /** Where the browser loads the profile picture from (the client's logo), null when there is none. */
  avatarSrc: string | null;
  hasLogo: boolean;
  /** Mockup figures (server/clients.ts instagramAccount); the Text studio can edit them. */
  likes: number;
  comments: number;
  brand: LayoutBrand;
  language: ClientLanguage;
  /** The month's colours (#rrggbb), after the brand's own. */
  palette: string[];
  /** Canvas height over width (1.25 for 4:5). */
  ratio: number;
}

export const TYPOGRAPHY_GROUP = "typography";
export const INSTAGRAM_GROUP = "instagram";

/** Instagram's own red for the filled heart when the design does not take the brand's colour. */
export const INSTAGRAM_RED = "#ed4956";

const WEIGHTS: Record<DesignText["weight"], number> = { heavy: 800, regular: 500, light: 300 };
const BODY_WEIGHTS: Record<DesignText["weight"], number> = { heavy: 700, regular: 400, light: 300 };

const solid = (color: string, alpha?: number): Fill =>
  alpha === undefined ? { type: "solid", color } : { type: "solid", color, alpha };
const HEX_RE = /^#[0-9a-f]{6}$/i;
const hexOr = (v: string | undefined, fallback: string) =>
  v && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : fallback;
const round = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The brand's main colour: the brand kit's first colour, else the month's first, else the studio blue. */
export function mainColour(ctx: Pick<StyleLayerContext, "brand" | "palette">): string {
  return hexOr(ctx.brand.colors[0]?.hex, hexOr(ctx.palette[0], "#1129d3"));
}

/** A number the way Instagram shortens it: 328K, 1.2M. */
export function compactCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1_000_000)
    return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 1000)
    return `${v >= 100_000 ? Math.round(v / 1000) : (v / 1000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(v);
}

/** The first `n` words of a text. */
const firstWords = (text: string, n: number) =>
  text.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** The first sentence of a caption, without its emoji tail. */
const firstSentence = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?؟،])(\s|$)/.exec(t);
  return (m ? m[1] : t).replace(/[.،]$/, "").trim();
};

/** A text cut to `max` characters at a word boundary, with an ellipsis. */
export function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,.;:،]+$/, "")}…`;
}

/** The average advance of a character in ems, by weight and script (Arabic is narrower on average). */
const advance = (text: string, weight: number) =>
  languageOfText(text, "en") === "ar" ? 0.5 : weight >= 700 ? 0.62 : 0.55;

/**
 * A font size (fraction of the width) that sets `text` inside a box of `w` by `hw` (both in width
 * fractions), wrapping onto up to `lines` lines. The renderer's `fit` shrinks it further if needed.
 */
function sizeFor(
  text: string,
  w: number,
  hw: number,
  weight: number,
  lineHeight: number,
  lines: number,
): number {
  const chars = Math.max(1, text.replace(/\s+/g, " ").trim().length);
  const perLine = Math.ceil(chars / Math.max(1, lines));
  const byWidth = w / (perLine * advance(text, weight) + 0.2);
  const byHeight = hw / (Math.max(1, lines) * lineHeight);
  return round(Math.max(0.012, Math.min(byWidth, byHeight)));
}

/** Rotation close to a quarter turn: the layer's own box is the visible box turned on its side. */
const isQuarterTurn = (deg: number) => Math.abs(Math.abs(deg) - 90) <= 30;

interface Box {
  x: number;
  y: number;
  w: number;
  /** In height fractions. */
  h: number;
  rotate: number;
}

/**
 * The layer's own (unrotated) box for a visible box: for a quarter turn the width and height swap
 * around the same centre, so the words run along the visible box; otherwise the visible box as is.
 */
function layerBox(
  t: Pick<DesignText, "x" | "y" | "w" | "h" | "rotate">,
  ratio: number,
  rotate: number,
): Box {
  if (!isQuarterTurn(rotate)) return { x: t.x, y: t.y, w: t.w, h: t.h, rotate };
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const w = t.h * ratio;
  const h = t.w / ratio;
  return { x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h), rotate };
}

/** White or near-black for the tone, or the brand's colour when the design takes it and it reads on that ground. */
function inkFor(
  t: Pick<DesignText, "tone">,
  accent: StyleDesign["accent"],
  brandMain: string,
): string {
  const plain = t.tone === "light" ? "#ffffff" : "#111111";
  if (accent !== "brand") return plain;
  const ground = t.tone === "light" ? "#2a2a2a" : "#f0f0f0";
  return contrastRatio(luminance(brandMain), luminance(ground)) >= 3 ? brandMain : plain;
}

export interface TextWords {
  /** The words for each role, resolved from the post. */
  big: string;
  line: string;
  label: string;
  caption: string;
  handle: string;
}

/** What the post's words give each role (the brand's name stands in for an empty headline). */
export function wordsForRoles(
  design: StyleDesign,
  ctx: Pick<StyleLayerContext, "headline" | "subline" | "caption" | "handle" | "accountName">,
): TextWords {
  const headline = ctx.headline.trim() || ctx.accountName.trim();
  const subline = ctx.subline.trim();
  const caption = ctx.caption.trim();
  const bigSpec = design.texts.find((t) => t.role === "big");
  const sampleWords = bigSpec ? wordCount(bigSpec.sample) : 0;
  // A one- or two-word hero on the pin takes that many words of the headline; a longer sample, the headline.
  const big =
    sampleWords >= 1 && sampleWords <= 2 && wordCount(headline) > sampleWords
      ? firstWords(headline, sampleWords)
      : headline;
  const line = subline || firstSentence(caption) || headline;
  const label =
    subline && wordCount(subline) <= 4 && subline.length <= 28 ? subline : firstWords(headline, 3);
  return {
    big,
    line,
    label,
    caption: caption || subline || headline,
    handle: ctx.handle ? `@${ctx.handle.replace(/^@/, "")}` : "",
  };
}

/* ───────────── Typography ───────────── */

function typographyLayers(design: StyleDesign, ctx: StyleLayerContext, id: () => string): Layer[] {
  const out: Layer[] = [];
  const words = wordsForRoles(design, ctx);
  const brandMain = mainColour(ctx);
  const lang = ctx.language;
  for (const t of design.texts) {
    const text = words[t.role];
    if (!text) continue;
    const arabic = languageOfText(text, lang === "en" ? "en" : "ar") === "ar";
    // Arabic never stands on its side: a quarter turn stays horizontal in the same box.
    const rotate = arabic && isQuarterTurn(t.rotate) ? 0 : t.rotate;
    const box = layerBox(t, ctx.ratio, rotate);
    const ink = inkFor(t, design.accent, brandMain);
    const direction = arabic ? "rtl" : "ltr";
    const hw = box.h * ctx.ratio;
    const flavour = t.role === "big" ? "statement" : "minimal";
    const common: Partial<TextLayer> = {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      rotate: rotate || undefined,
      autoSize: false,
      fit: true,
      align: t.align,
      vAlign: "middle",
      direction,
      fill: solid(ink),
      group: TYPOGRAPHY_GROUP,
    };
    const upper = t.case === "upper" && !arabic ? ("upper" as const) : undefined;
    if (t.role === "big") {
      const weight = WEIGHTS[t.weight];
      const lines = Math.min(
        3,
        Math.max(1, wordCount(text) > 1 && hw > box.w * 0.8 ? wordCount(text) : 1),
      );
      out.push({
        id: id(),
        type: "text",
        name: t.behind ? "Big word (behind the product on the pin)" : "Big word",
        ...(text === ctx.headline.trim() ? { role: "headline" as const } : {}),
        text,
        font: fontFor(ctx.brand, "headline", lang, "statement", text),
        weight,
        size: sizeFor(upper ? text.toUpperCase() : text, box.w, hw, weight, 0.95, lines),
        lineHeight: 0.95,
        letterSpacing: upper ? -0.02 : undefined,
        transform: upper,
        ...common,
      } as TextLayer);
      continue;
    }
    if (t.role === "label") {
      const weight = BODY_WEIGHTS[t.weight] + 100;
      const size = sizeFor(
        upper ? text.toUpperCase() : text,
        box.w * 0.82,
        hw * 0.7,
        weight,
        1.1,
        1,
      );
      const pill = t.decoration === "pill";
      const pillBg =
        design.accent === "brand" ? brandMain : t.tone === "light" ? "#ffffff" : "#111111";
      const decoId = id();
      if (t.decoration === "oval" || t.decoration === "box") {
        out.push({
          id: decoId,
          type: "shape",
          name: t.decoration === "oval" ? "Oval outline" : "Box outline",
          shape: t.decoration === "oval" ? "ellipse" : "rect",
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          rotate: rotate || undefined,
          fill: solid(ink, 0),
          stroke: { color: ink, width: 0.0025 },
          radius: t.decoration === "box" ? 0 : undefined,
          group: TYPOGRAPHY_GROUP,
        } as ShapeLayer);
      } else if (t.decoration === "underline") {
        out.push({
          id: decoId,
          type: "shape",
          name: "Underline",
          shape: "line",
          x: round(box.x + box.w * 0.1),
          y: round(box.y + box.h * 0.88),
          w: round(box.w * 0.8),
          h: 0.0025,
          rotate: rotate || undefined,
          fill: solid(ink),
          group: TYPOGRAPHY_GROUP,
        } as ShapeLayer);
      }
      out.push({
        id: id(),
        type: "text",
        name: "Label",
        text,
        font: fontFor(ctx.brand, "body", lang, "minimal", text),
        weight,
        size,
        lineHeight: 1.1,
        letterSpacing: upper ? 0.12 : undefined,
        transform: upper,
        ...common,
        ...(pill
          ? {
              fill: solid(inkOn(pillBg)),
              background: { color: pillBg, alpha: 1, padding: 0.55, radius: 2 },
            }
          : {}),
      } as TextLayer);
      continue;
    }
    // line, caption, handle: body copy.
    const weight = t.role === "handle" ? 600 : BODY_WEIGHTS[t.weight];
    const lineHeight = t.role === "caption" ? 1.35 : 1.2;
    const capacity =
      t.role === "caption"
        ? Math.max(24, Math.floor(((box.w / (0.026 * 0.55)) * hw) / (0.026 * lineHeight)))
        : Infinity;
    const shown = t.role === "caption" ? shorten(text, Math.min(capacity, 180)) : text;
    const lines =
      t.role === "caption"
        ? Math.max(1, Math.min(4, Math.ceil(shown.length / Math.max(12, box.w / (0.026 * 0.55)))))
        : 1;
    out.push({
      id: id(),
      type: "text",
      name: t.role === "line" ? "Second line" : t.role === "caption" ? "Caption" : "Handle",
      ...(t.role === "line" && text === ctx.subline.trim() ? { role: "subline" as const } : {}),
      text: shown,
      font: fontFor(ctx.brand, "body", lang, flavour, shown),
      weight,
      size: sizeFor(upper ? shown.toUpperCase() : shown, box.w, hw, weight, lineHeight, lines),
      lineHeight,
      letterSpacing: upper && t.role === "line" ? 0.1 : undefined,
      transform: upper,
      ...common,
    } as TextLayer);
  }
  return out;
}

/* ───────────── Instagram post mockup ───────────── */

/** A compact inline SVG as a data URL the renderer's image loader draws (no fetch, no CORS). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${svg.replace(/"/g, "'").replace(/\s+/g, " ").trim().replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23").replace(/ /g, "%20")}`;
}

const svgIcon = (body: string) =>
  svgDataUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>${body}</svg>`);
const stroked = (d: string, color: string) =>
  svgIcon(
    `<path fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='${d}'/>`,
  );

/** The Instagram action icons as inline SVGs. */
export const ICONS = {
  heart: (color: string) =>
    svgIcon(
      `<path fill='${color}' d='M12 21s-7.5-4.6-9.5-9.3C1.2 8.5 3 5 6.5 5c2 0 3.3 1 4.5 2.5C12.2 6 13.5 5 15.5 5 19 5 20.8 8.5 19.5 11.7 17.5 16.4 12 21 12 21z'/>`,
    ),
  comment: (color: string) =>
    stroked("M20.7 12a8.7 8.7 0 0 1-12.9 7.6L3 21l1.4-4.8A8.7 8.7 0 1 1 20.7 12z", color),
  share: (color: string) => stroked("M22 3 2.5 10.6l8.2 2.7 2.7 8.2L22 3zM10.7 13.3 22 3", color),
  bookmark: (color: string) => stroked("M20 21l-8-6-8 6V3h16z", color),
};

function mockupLayers(
  mockup: DesignMockup,
  ctx: StyleLayerContext,
  accent: StyleDesign["accent"],
  id: () => string,
): Layer[] {
  const out: Layer[] = [];
  const r = ctx.ratio;
  const brandMain = mainColour(ctx);
  const panel = mockup.panel;
  // Without a panel the UI floats on the photograph, in white, over its lower third.
  const region = panel
    ? { x: panel.x, y: panel.y, w: panel.w, h: panel.h }
    : { x: 0, y: 0.66, w: 1, h: 0.34 };
  const ink = panel ? (panel.tone === "light" ? "#262626" : "#fafafa") : "#ffffff";
  const muted = panel ? (panel.tone === "light" ? "#737373" : "#a8a8a8") : "#e6e6e6";
  const body = (text: string) => fontFor(ctx.brand, "body", ctx.language, "minimal", text);
  const lang = ctx.language;
  const direction = lang === "ar" ? "rtl" : lang === "en" ? "ltr" : "auto";
  const handle = ctx.handle.replace(/^@/, "") || "brand";
  if (panel) {
    out.push({
      id: id(),
      type: "shape",
      name: "Instagram panel",
      shape: "rect",
      x: panel.x,
      y: panel.y,
      w: panel.w,
      h: panel.h,
      fill: solid(panel.tone === "light" ? "#ffffff" : "#111111"),
      radius: Math.min(0.1, panel.radius),
      group: INSTAGRAM_GROUP,
    } as ShapeLayer);
  }
  const pad = Math.min(0.045, region.w * 0.06);
  const x0 = round(region.x + pad);
  const inner = round(region.w - pad * 2);
  let y = region.y + pad / r;
  const icon = 0.05;
  const parts = mockup.parts;
  if (parts.actions) {
    const icons: [string, string][] = [
      ["Like", ICONS.heart(accent === "brand" ? brandMain : INSTAGRAM_RED)],
      ["Comment", ICONS.comment(ink)],
      ["Share", ICONS.share(ink)],
    ];
    icons.forEach(([name, src], i) => {
      out.push({
        id: id(),
        type: "image",
        name,
        src,
        x: round(x0 + i * (icon + 0.028)),
        y: round(y),
        w: icon,
        h: round(icon / r),
        fit: "contain",
        group: INSTAGRAM_GROUP,
      } as ImageLayer);
    });
    out.push({
      id: id(),
      type: "image",
      name: "Save",
      src: ICONS.bookmark(ink),
      x: round(region.x + region.w - pad - icon),
      y: round(y),
      w: icon,
      h: round(icon / r),
      fit: "contain",
      group: INSTAGRAM_GROUP,
    } as ImageLayer);
    y += icon / r + 0.018 / r;
  }
  if (parts.likes) {
    const text = `${Math.max(0, Math.round(ctx.likes)).toLocaleString("en-US")} likes`;
    const size = 0.03;
    out.push({
      id: id(),
      type: "text",
      name: "Likes",
      text,
      font: body(text),
      weight: 700,
      size,
      lineHeight: 1.25,
      x: x0,
      y: round(y),
      w: inner,
      align: "left",
      direction: "ltr",
      fill: solid(ink),
      autoSize: true,
      group: INSTAGRAM_GROUP,
    } as TextLayer);
    y += (size * 1.25) / r + 0.012 / r;
  }
  if (parts.caption) {
    const size = 0.028;
    const perLine = Math.max(16, Math.floor(inner / (size * 0.55)));
    const caption = shorten(
      ctx.caption.trim() || ctx.subline.trim() || ctx.headline.trim(),
      perLine * 3 - handle.length - 1,
    );
    const text = `${handle} ${caption}`;
    const runs: TextRun[] = [
      {
        from: 0,
        to: handle.length,
        style: { bold: true, color: accent === "brand" ? brandMain : ink },
      },
    ];
    const lines = Math.max(1, Math.ceil(text.length / perLine));
    out.push({
      id: id(),
      type: "text",
      name: "Caption",
      text,
      runs,
      font: body(caption),
      weight: 400,
      size,
      lineHeight: 1.35,
      x: x0,
      y: round(y),
      w: inner,
      align: "left",
      direction,
      fill: solid(ink),
      autoSize: true,
      group: INSTAGRAM_GROUP,
    } as TextLayer);
    y += (lines * size * 1.35) / r + 0.01 / r;
  }
  if (parts.hashtags) {
    const size = 0.026;
    const tags = ctx.hashtags.trim() || `#${handle}`;
    const text = shorten(tags, Math.floor(inner / (size * 0.55)) * 2);
    out.push({
      id: id(),
      type: "text",
      name: "Hashtags",
      text,
      font: body(text),
      weight: 500,
      size,
      lineHeight: 1.3,
      x: x0,
      y: round(y),
      w: inner,
      align: "left",
      direction: "ltr",
      fill: solid(accent === "brand" || accent === "light" ? brandMain : "#00376b"),
      autoSize: true,
      group: INSTAGRAM_GROUP,
    } as TextLayer);
    y +=
      (Math.ceil(text.length / Math.max(16, inner / (size * 0.55))) * size * 1.3) / r + 0.016 / r;
  }
  const pillW = Math.min(0.36, inner * 0.46);
  const pillH = 0.052;
  if (parts.account) {
    const avatar = 0.075;
    if (ctx.avatarSrc) {
      out.push({
        id: id(),
        type: "image",
        name: "Profile picture",
        src: ctx.avatarSrc,
        x: x0,
        y: round(y),
        w: avatar,
        h: round(avatar / r),
        fit: "cover",
        radius: avatar / 2,
        source: "brand",
        group: INSTAGRAM_GROUP,
      } as ImageLayer);
    } else if (ctx.hasLogo) {
      out.push({
        id: id(),
        type: "logo",
        name: "Profile picture",
        x: x0,
        y: round(y),
        w: avatar,
        group: INSTAGRAM_GROUP,
      } as LogoLayer);
    } else {
      out.push({
        id: id(),
        type: "shape",
        name: "Profile picture",
        shape: "ellipse",
        x: x0,
        y: round(y),
        w: avatar,
        h: round(avatar / r),
        fill: solid(brandMain),
        group: INSTAGRAM_GROUP,
      } as ShapeLayer);
      const initial = (ctx.accountName.trim() || handle).slice(0, 1).toUpperCase();
      out.push({
        id: id(),
        type: "text",
        name: "Initial",
        text: initial,
        font: body(initial),
        weight: 700,
        size: 0.036,
        lineHeight: 1,
        x: x0,
        y: round(y),
        w: avatar,
        h: round(avatar / r),
        align: "center",
        vAlign: "middle",
        autoSize: false,
        fill: solid(inkOn(brandMain)),
        group: INSTAGRAM_GROUP,
      } as TextLayer);
    }
    const tx = round(x0 + avatar + 0.022);
    const tw = round(inner - avatar - 0.022 - (parts.comments ? pillW + 0.02 : 0));
    out.push({
      id: id(),
      type: "text",
      name: "Handle",
      text: handle,
      font: body(handle),
      weight: 700,
      size: 0.03,
      lineHeight: 1.2,
      x: tx,
      y: round(y + 0.002 / r),
      w: tw,
      align: "left",
      direction: "ltr",
      fill: solid(ink),
      autoSize: true,
      group: INSTAGRAM_GROUP,
    } as TextLayer);
    const name = ctx.accountName.trim() || handle;
    out.push({
      id: id(),
      type: "text",
      name: "Account name",
      text: name,
      font: body(name),
      weight: 400,
      size: 0.026,
      lineHeight: 1.2,
      x: tx,
      y: round(y + (0.03 * 1.2 + 0.006) / r),
      w: tw,
      align: "left",
      direction,
      fill: solid(muted),
      autoSize: true,
      group: INSTAGRAM_GROUP,
    } as TextLayer);
  }
  if (parts.comments) {
    const px = round(region.x + region.w - pad - pillW);
    const py = round(parts.account ? y + (0.075 / r - pillH / r) / 2 : y);
    const pillBg = panel ? (panel.tone === "light" ? "#efefef" : "#262626") : "#ffffff";
    const pillInk = panel ? ink : "#262626";
    const text = `${compactCount(ctx.comments)} comments`;
    out.push({
      id: id(),
      type: "shape",
      name: "Comments pill",
      shape: "rect",
      x: px,
      y: py,
      w: pillW,
      h: round(pillH / r),
      fill: solid(pillBg, panel ? 1 : 0.92),
      radius: pillH / 2,
      group: INSTAGRAM_GROUP,
    } as ShapeLayer);
    out.push({
      id: id(),
      type: "image",
      name: "Comment icon",
      src: ICONS.comment(pillInk),
      x: round(px + 0.02),
      y: round(py + (pillH - 0.03) / 2 / r),
      w: 0.03,
      h: round(0.03 / r),
      fit: "contain",
      group: INSTAGRAM_GROUP,
    } as ImageLayer);
    out.push({
      id: id(),
      type: "text",
      name: "Comments",
      text,
      font: body(text),
      weight: 600,
      size: 0.024,
      lineHeight: 1,
      x: round(px + 0.058),
      y: py,
      w: round(pillW - 0.07),
      h: round(pillH / r),
      align: "left",
      vAlign: "middle",
      direction: "ltr",
      autoSize: false,
      fill: solid(pillInk),
      group: INSTAGRAM_GROUP,
    } as TextLayer);
  }
  if (parts.logo && ctx.hasLogo) {
    const at = mockup.logo ?? { x: 0.78, y: 0.04, w: 0.18 };
    out.push({
      id: id(),
      type: "logo",
      name: "Logo",
      x: clamp01(at.x),
      y: clamp01(at.y),
      w: Math.max(0.04, Math.min(0.6, at.w)),
      group: INSTAGRAM_GROUP,
    } as LogoLayer);
  }
  return out;
}

/**
 * The post's layers for a designed style: the typography in the client's fonts and colours with the
 * post's own words, and the Instagram mockup with the client's own account. Typography layers are
 * grouped "typography", mockup layers "instagram", so the Text studio moves each set together.
 */
export function layersFromStyleDesign(design: StyleDesign, ctx: StyleLayerContext): TextDesign {
  let n = 0;
  const id = () => `sd${++n}`;
  const layers: Layer[] = [];
  if (design.mockup && design.kind.includes("mockup"))
    layers.push(...mockupLayers(design.mockup, ctx, design.accent, id));
  if (design.texts.length) layers.push(...typographyLayers(design, ctx, id));
  return { version: 1, layers: layers.slice(0, 40) };
}
