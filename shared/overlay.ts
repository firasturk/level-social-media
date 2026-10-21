/**
 * Overlay: the headline, sub-line and logo the browser draws over a generated post, in the
 * client's fonts and colours. Every metric is a fraction of the canvas width (1080 = 1), so one
 * spec fits 1:1, 4:5 and 9:16 outputs at any resolution. The engine never draws text; this does.
 */
import type { PostTypography } from "./typography";
import type { TextDesign } from "./layers";
export type OverlayTemplate = "united" | "abusaleh" | "habibah" | "clean" | "none";
export type LogoPosition = "top-center" | "top-left" | "top-right" | "bottom-center" | "none";
export type TextPosition = "bottom" | "top" | "center";
export type TextAlign = "center" | "left" | "right";
export type BadgePosition = "bottom-left" | "bottom-right" | "top-left" | "top-right" | "none";

/** A second, small mark in a corner of every post (a parent or partner logo). */
export interface BadgeSpec {
  position: BadgePosition;
  /** Width as a fraction of the canvas width. */
  width: number;
  /** Distance from the two nearest edges, as a fraction of the width. */
  inset: number;
  /** Fill the mark with one colour (e.g. "#ffffff"); empty keeps the file's own colours. */
  color: string;
  /** Runtime only: where the browser loads the file from. Never stored. */
  src?: string | null;
}

export const NO_BADGE: BadgeSpec = { position: "none", width: 0.09, inset: 0.04, color: "" };

export interface OverlaySpec {
  template: OverlayTemplate;
  logo: { position: LogoPosition; width: number; top: number };
  /** Corner logo; position "none" (the default) draws nothing. */
  badge: BadgeSpec;
  headline: {
    position: TextPosition;
    /** Font family name (a brand font file, a Google font, or a system fallback). */
    font: string;
    size: number;
    weight: number;
    color: string;
    lineHeight: number;
    align: TextAlign;
    /** Hard drop copy under the text (Abu Saleh); empty for none. */
    shadow: string;
    shadowOffset: number;
    letterSpacing: number;
    /** Distance from the top (position "top") or bottom (position "bottom") edge. */
    inset: number;
  };
  /** The second line; show false hides it on every post (and the ideas writer leaves it empty). */
  subline: { font: string; size: number; weight: number; color: string; gap: number; show?: boolean };
  /** Side safe margin. */
  margin: number;
  /** Opacity of the dark fade behind a headline (0 = none) and its colour. */
  scrim: number;
  scrimColor: string;
}

export const OVERLAY_TEMPLATES: Record<Exclude<OverlayTemplate, "none">, OverlaySpec> = {
  /** United Insurance: white stacked logo top-centre, two-line headline in the bottom third. */
  united: {
    template: "united",
    logo: { position: "top-center", width: 0.185, top: 0.044 },
    badge: NO_BADGE,
    headline: {
      position: "bottom",
      font: "Tajawal",
      size: 0.078,
      weight: 700,
      color: "#ffffff",
      lineHeight: 1.15,
      align: "center",
      shadow: "",
      shadowOffset: 0,
      letterSpacing: 0,
      inset: 0.1,
    },
    subline: { font: "Tajawal", size: 0.067, weight: 400, color: "#ffffff", gap: 0.012 },
    margin: 0.1,
    scrim: 0.55,
    scrimColor: "#030619",
  },
  /** Abu Saleh: three-tile logo top-centre, Graphic School headline under it with a turquoise drop. */
  abusaleh: {
    template: "abusaleh",
    logo: { position: "top-center", width: 0.158, top: 0.04 },
    badge: NO_BADGE,
    headline: {
      position: "top",
      font: "Graphic School",
      size: 0.09,
      weight: 400,
      color: "#ffffff",
      lineHeight: 1.1,
      align: "center",
      shadow: "#63c7c9",
      shadowOffset: 0.0093,
      letterSpacing: 0,
      inset: 0.176,
    },
    subline: { font: "Graphic School", size: 0.046, weight: 400, color: "#ffffff", gap: 0.02 },
    margin: 0.074,
    scrim: 0,
    scrimColor: "#000000",
  },
  /**
   * Habibah: the Arabic oval logo centred at the top, a calligraphic Arabic headline (Gulzar, close
   * to the brand's hand-lettering) alone at the bottom in white on a black fade (no second line),
   * the AlBandar Group mark small and white in the bottom-left corner. No gold.
   */
  habibah: {
    template: "habibah",
    logo: { position: "top-center", width: 0.3, top: 0.05 },
    badge: { position: "bottom-left", width: 0.085, inset: 0.04, color: "#ffffff" },
    headline: {
      position: "bottom",
      font: "Gulzar",
      size: 0.095,
      weight: 400,
      color: "#ffffff",
      lineHeight: 1.45,
      align: "center",
      shadow: "",
      shadowOffset: 0,
      letterSpacing: 0,
      inset: 0.09,
    },
    subline: { font: "Almarai", size: 0.036, weight: 400, color: "#ffffff", gap: 0.014, show: false },
    margin: 0.08,
    scrim: 0.5,
    scrimColor: "#000000",
  },
  /** A neutral layout for clients without their own rules. */
  clean: {
    template: "clean",
    logo: { position: "top-left", width: 0.16, top: 0.05 },
    badge: NO_BADGE,
    headline: {
      position: "bottom",
      font: "Inter",
      size: 0.065,
      weight: 700,
      color: "#ffffff",
      lineHeight: 1.15,
      align: "left",
      shadow: "",
      shadowOffset: 0,
      letterSpacing: 0,
      inset: 0.09,
    },
    subline: { font: "Inter", size: 0.034, weight: 400, color: "#ffffff", gap: 0.012 },
    margin: 0.07,
    scrim: 0.5,
    scrimColor: "#000000",
  },
};

export const NO_OVERLAY: OverlaySpec = {
  ...OVERLAY_TEMPLATES.clean,
  template: "none",
  logo: { ...OVERLAY_TEMPLATES.clean.logo, position: "none" },
};

/** Per-post adjustments made in the on-image editor: offsets are fractions of the width. */
export interface PostOverlayPatch {
  /** Where the words sit on this post, whatever the client's layout says (a grid tile's own place). */
  position?: TextPosition;
  /** true: the designer chose the place by hand; the text check never moves it. */
  pin?: boolean;
  dx?: number;
  dy?: number;
  /** Multiplier on the headline and sub-line sizes. */
  scale?: number;
  color?: string;
  subColor?: string;
  align?: TextAlign;
  logoDx?: number;
  logoDy?: number;
  logoWidth?: number;
  /** An official portrait framed on the post (royal occasions), drawn exactly as uploaded. */
  photo?: string;
  /** false: no dark fade under the text on this post, whatever the client's layout says. */
  fade?: boolean;
  /** The words set as typography: a big word behind or across the product, repeated or outlined. */
  typo?: PostTypography;
  /** The picture the typography was chosen for (it is chosen again for a new picture). */
  typoFor?: string;
  /** The typography kept aside while the month's typography is switched off. */
  typoOff?: PostTypography;
  /** The words as editable layers (Text studio): drawn instead of the headline block when present. */
  design?: TextDesign;
}

/** Text animation presets rendered in the browser for "Animate this text". */
export const ANIMATION_PRESETS = ["fade", "rise", "typewriter", "zoom"] as const;
export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

/** A full spec from whatever is stored: a template name fills the gaps. */
export function resolveOverlay(raw: Partial<OverlaySpec> | null | undefined): OverlaySpec {
  const base =
    raw?.template && raw.template !== "none"
      ? OVERLAY_TEMPLATES[raw.template]
      : raw?.template === "none"
        ? NO_OVERLAY
        : OVERLAY_TEMPLATES.clean;
  if (!raw) return base;
  return {
    ...base,
    ...raw,
    logo: { ...base.logo, ...(raw.logo ?? {}) },
    badge: { ...base.badge, ...(raw.badge ?? {}) },
    headline: { ...base.headline, ...(raw.headline ?? {}) },
    subline: { ...base.subline, ...(raw.subline ?? {}) },
  };
}

/** A hosted font offered in the pickers, with the weight it looks right at. */
export interface FontChoice {
  family: string;
  weight: number;
  /** One or two words on its character. */
  style: string;
}

/** Ten Arabic display faces for headlines, calligraphic first. */
export const HEADLINE_FONTS: FontChoice[] = [
  { family: "Gulzar", weight: 400, style: "Calligraphic, Nastaliq" },
  { family: "Noto Nastaliq Urdu", weight: 700, style: "Calligraphic, bold" },
  { family: "Aref Ruqaa", weight: 700, style: "Ruq'a" },
  { family: "Amiri", weight: 700, style: "Classic Naskh" },
  { family: "Reem Kufi", weight: 700, style: "Kufi" },
  { family: "El Messiri", weight: 700, style: "Elegant modern" },
  { family: "Lalezar", weight: 400, style: "Heavy display" },
  { family: "Rakkas", weight: 400, style: "Bold display" },
  { family: "Lemonada", weight: 700, style: "Rounded, playful" },
  { family: "Cairo", weight: 900, style: "Bold modern" },
  { family: "Marhey", weight: 700, style: "Bold rounded display" },
  { family: "Blaka", weight: 400, style: "Expressive, raw" },
  { family: "Beiruti", weight: 800, style: "Modern geometric" },
  { family: "Baloo Bhaijaan 2", weight: 800, style: "Chunky rounded" },
  { family: "Zain", weight: 800, style: "Soft display" },
  { family: "Kufam", weight: 700, style: "Kufi display" },
  { family: "Mada", weight: 700, style: "Clean heavy" },
  { family: "Rubik", weight: 800, style: "Rounded sans" },
];

/** Ten readable Arabic text faces for the second line and body copy. */
export const BODY_FONTS: FontChoice[] = [
  { family: "Almarai", weight: 400, style: "Clean sans" },
  { family: "Tajawal", weight: 400, style: "Geometric sans" },
  { family: "Cairo", weight: 400, style: "Modern sans" },
  { family: "IBM Plex Sans Arabic", weight: 400, style: "Corporate sans" },
  { family: "Noto Kufi Arabic", weight: 400, style: "Kufi sans" },
  { family: "Readex Pro", weight: 400, style: "Wide sans" },
  { family: "Alexandria", weight: 400, style: "Friendly sans" },
  { family: "Changa", weight: 400, style: "Condensed" },
  { family: "Noto Naskh Arabic", weight: 400, style: "Naskh" },
  { family: "Vazirmatn", weight: 400, style: "Neutral sans" },
];

/** Latin faces kept for English-first clients. */
export const LATIN_FONTS: FontChoice[] = [
  { family: "Montserrat", weight: 600, style: "Latin" },
  { family: "Inter", weight: 600, style: "Latin" },
  { family: "Poppins", weight: 700, style: "Latin geometric" },
  { family: "Bebas Neue", weight: 400, style: "Latin condensed display" },
  { family: "Anton", weight: 400, style: "Latin heavy display" },
  { family: "Oswald", weight: 700, style: "Latin condensed" },
  { family: "Archivo Black", weight: 400, style: "Latin black" },
  { family: "Unbounded", weight: 800, style: "Latin wide display" },
  { family: "Playfair Display", weight: 700, style: "Latin serif" },
  { family: "DM Serif Display", weight: 400, style: "Latin serif display" },
  { family: "Abril Fatface", weight: 400, style: "Latin fat serif" },
  { family: "Fredoka", weight: 700, style: "Latin rounded, playful" },
  { family: "Righteous", weight: 400, style: "Latin retro" },
  { family: "Pacifico", weight: 400, style: "Latin script" },
  { family: "Caveat", weight: 700, style: "Latin handwritten" },
  { family: "Permanent Marker", weight: 400, style: "Latin marker" },
];

/** Google Fonts families the overlay may use without a file; everything else needs an uploaded font. */
export const HOSTED_FONTS = [
  ...new Set([
    ...HEADLINE_FONTS.map((f) => f.family),
    ...BODY_FONTS.map((f) => f.family),
    ...LATIN_FONTS.map((f) => f.family),
    "Mirza",
    "Lateef",
  ]),
];
