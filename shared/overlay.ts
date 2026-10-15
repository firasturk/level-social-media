/**
 * Overlay: the headline, sub-line and logo the browser draws over a generated post, in the
 * client's fonts and colours. Every metric is a fraction of the canvas width (1080 = 1), so one
 * spec fits 1:1, 4:5 and 9:16 outputs at any resolution. The engine never draws text; this does.
 */
export type OverlayTemplate = "united" | "abusaleh" | "habibah" | "clean" | "none";
export type LogoPosition = "top-center" | "top-left" | "top-right" | "bottom-center" | "none";
export type TextPosition = "bottom" | "top" | "center";
export type TextAlign = "center" | "left" | "right";

export interface OverlaySpec {
  template: OverlayTemplate;
  logo: { position: LogoPosition; width: number; top: number };
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
  subline: { font: string; size: number; weight: number; color: string; gap: number };
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
  /** Habibah: the oval logo centred at the top, Montserrat headline at the bottom, gold sub-line. */
  habibah: {
    template: "habibah",
    logo: { position: "top-center", width: 0.3, top: 0.05 },
    headline: {
      position: "bottom",
      font: "Montserrat",
      size: 0.06,
      weight: 600,
      color: "#ffffff",
      lineHeight: 1.2,
      align: "center",
      shadow: "",
      shadowOffset: 0,
      letterSpacing: 0.02,
      inset: 0.09,
    },
    subline: { font: "Montserrat", size: 0.03, weight: 600, color: "#d9be8e", gap: 0.014 },
    margin: 0.08,
    scrim: 0.5,
    scrimColor: "#002a5c",
  },
  /** A neutral layout for clients without their own rules. */
  clean: {
    template: "clean",
    logo: { position: "top-left", width: 0.16, top: 0.05 },
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
    headline: { ...base.headline, ...(raw.headline ?? {}) },
    subline: { ...base.subline, ...(raw.subline ?? {}) },
  };
}

/** Google Fonts families the overlay may use without a file; everything else needs an uploaded font. */
export const HOSTED_FONTS = ["Inter", "Tajawal", "Montserrat", "Cairo", "Almarai", "Noto Kufi Arabic"];
