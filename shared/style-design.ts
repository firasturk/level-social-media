/**
 * Designed styles (28 Oct): a pin that is not only a photograph but a designed post, with words set
 * as typography (a huge rotated word, a small vertical line, an outlined label) or framed as an
 * Instagram post mockup (the like, comment and share icons, a like count, the handle and caption,
 * a comments pill, the logo). The engine makes the PHOTOGRAPH alone, with clean space where the
 * design sits; the browser draws the design as editable layers in the client's own fonts, colours,
 * words and Instagram account, so no letter is ever drawn wrong by an engine.
 */

/** What the design is: typography over the photo, an Instagram post mockup, or both. */
export type StyleDesignKind = "typography" | "mockup";

/** The job of one text element of the design; the post's own words fill it. */
export type DesignTextRole =
  /** The hero word or two, set huge (the post's headline). */
  | "big"
  /** A short line next to it (the post's second line). */
  | "line"
  /** A small tag or label, often outlined or in a pill (a short phrase from the headline or second line). */
  | "label"
  /** A longer sentence (the post's caption, shortened). */
  | "caption"
  /** The brand's Instagram handle. */
  | "handle";

export type DesignDecoration = "none" | "oval" | "pill" | "underline" | "box";

export interface DesignText {
  role: DesignTextRole;
  /** The box the text sits in, as fractions of the canvas width (x, w) and height (y, h). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in degrees, clockwise; -90 is a line read bottom to top, 90 top to bottom. */
  rotate: number;
  /** How the letters are set. */
  weight: "heavy" | "regular" | "light";
  case: "upper" | "none";
  /** Light letters on a dark or mid ground, or dark letters on a light ground. */
  tone: "light" | "dark";
  align: "left" | "center" | "right";
  decoration: DesignDecoration;
  /** The letters sit behind the product or the pour, partly hidden by it. */
  behind: boolean;
  /** The words the pin itself shows, for the reader's record (never drawn). */
  sample: string;
}

/** The Instagram mockup chrome the pin shows; each part is drawn by the browser with the client's account. */
export interface DesignMockup {
  ui: "instagram-post";
  /** The white (or tinted) panel that carries the UI, as fractions; null when the UI floats on the photo. */
  panel: { x: number; y: number; w: number; h: number; radius: number; tone: "light" | "dark" } | null;
  /** The parts the pin shows. */
  parts: {
    actions: boolean;
    likes: boolean;
    caption: boolean;
    hashtags: boolean;
    account: boolean;
    comments: boolean;
    logo: boolean;
  };
  /** Where the logo sits when the pin shows one. */
  logo?: { x: number; y: number; w: number };
}

export interface StyleDesign {
  kind: StyleDesignKind[];
  texts: DesignText[];
  mockup: DesignMockup | null;
  /** Where the photograph must stay clean for the design (short English, for the engine prompt). */
  space: string;
  /** The accent the design's lettering or panel takes: "brand" (the brand's main colour), "light" or "dark". */
  accent: "brand" | "light" | "dark";
}

export const STYLE_DESIGN_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "array", items: { type: "string", enum: ["typography", "mockup"] } },
    texts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["big", "line", "label", "caption", "handle"] },
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
          rotate: { type: "number" },
          weight: { type: "string", enum: ["heavy", "regular", "light"] },
          case: { type: "string", enum: ["upper", "none"] },
          tone: { type: "string", enum: ["light", "dark"] },
          align: { type: "string", enum: ["left", "center", "right"] },
          decoration: { type: "string", enum: ["none", "oval", "pill", "underline", "box"] },
          behind: { type: "boolean" },
          sample: { type: "string" },
        },
        required: ["role", "x", "y", "w", "h", "rotate", "weight", "case", "tone", "align", "decoration", "behind", "sample"],
      },
    },
    mockup: {
      type: ["object", "null"],
      properties: {
        ui: { type: "string", enum: ["instagram-post"] },
        panel: {
          type: ["object", "null"],
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
            radius: { type: "number" },
            tone: { type: "string", enum: ["light", "dark"] },
          },
          required: ["x", "y", "w", "h", "radius", "tone"],
        },
        parts: {
          type: "object",
          properties: {
            actions: { type: "boolean" },
            likes: { type: "boolean" },
            caption: { type: "boolean" },
            hashtags: { type: "boolean" },
            account: { type: "boolean" },
            comments: { type: "boolean" },
            logo: { type: "boolean" },
          },
          required: ["actions", "likes", "caption", "hashtags", "account", "comments", "logo"],
        },
        logo: { type: ["object", "null"], properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" } }, required: ["x", "y", "w"] },
      },
      required: ["ui", "panel", "parts", "logo"],
    },
    space: { type: "string" },
    accent: { type: "string", enum: ["brand", "light", "dark"] },
  },
  required: ["kind", "texts", "mockup", "space", "accent"],
};

const frac = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** A design as the reader returned it, made safe; null when the pin carries no design. */
export function parseStyleDesign(raw: unknown): StyleDesign | null {
  const d = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!d) return null;
  const kind = (Array.isArray(d.kind) ? d.kind : []).filter((k): k is StyleDesignKind => k === "typography" || k === "mockup");
  const texts: DesignText[] = (Array.isArray(d.texts) ? d.texts : [])
    .map((t): DesignText | null => {
      const x = (t && typeof t === "object" ? t : null) as Record<string, unknown> | null;
      if (!x) return null;
      const w = frac(x.w, 0);
      const h = frac(x.h, 0);
      if (w <= 0 || h <= 0) return null;
      return {
        role: pick(x.role, ["big", "line", "label", "caption", "handle"] as const, "line"),
        x: frac(x.x, 0),
        y: frac(x.y, 0),
        w,
        h,
        rotate: Math.max(-180, Math.min(180, Math.round(Number(x.rotate) || 0))),
        weight: pick(x.weight, ["heavy", "regular", "light"] as const, "regular"),
        case: pick(x.case, ["upper", "none"] as const, "none"),
        tone: pick(x.tone, ["light", "dark"] as const, "light"),
        align: pick(x.align, ["left", "center", "right"] as const, "left"),
        decoration: pick(x.decoration, ["none", "oval", "pill", "underline", "box"] as const, "none"),
        behind: x.behind === true,
        sample: String(x.sample ?? "").trim().slice(0, 120),
      };
    })
    .filter((t): t is DesignText => !!t)
    .slice(0, 8);
  const m = (d.mockup && typeof d.mockup === "object" ? d.mockup : null) as Record<string, unknown> | null;
  const parts = (m?.parts && typeof m.parts === "object" ? m.parts : {}) as Record<string, unknown>;
  const panel = (m?.panel && typeof m.panel === "object" ? m.panel : null) as Record<string, unknown> | null;
  const logo = (m?.logo && typeof m.logo === "object" ? m.logo : null) as Record<string, unknown> | null;
  const mockup: DesignMockup | null =
    m && kind.includes("mockup")
      ? {
          ui: "instagram-post",
          panel: panel ? { x: frac(panel.x, 0), y: frac(panel.y, 0.3), w: frac(panel.w, 1), h: frac(panel.h, 0.35), radius: frac(panel.radius, 0), tone: pick(panel.tone, ["light", "dark"] as const, "light") } : null,
          parts: {
            actions: parts.actions !== false,
            likes: parts.likes !== false,
            caption: parts.caption !== false,
            hashtags: parts.hashtags === true,
            account: parts.account !== false,
            comments: parts.comments === true,
            logo: parts.logo === true,
          },
          ...(logo ? { logo: { x: frac(logo.x, 0.7), y: frac(logo.y, 0.85), w: frac(logo.w, 0.2) } } : {}),
        }
      : null;
  if (!kind.length || (!texts.length && !mockup)) return null;
  return {
    kind: mockup ? (kind.includes("mockup") ? kind : [...kind, "mockup"]) : kind.filter((k) => k !== "mockup"),
    texts,
    mockup,
    space: String(d.space ?? "").trim().slice(0, 300),
    accent: pick(d.accent, ["brand", "light", "dark"] as const, "light"),
  };
}

/** The short label the gallery shows on a designed style. */
export function designLabel(design: StyleDesign | null | undefined): string {
  if (!design) return "";
  if (design.mockup && design.kind.includes("typography")) return "Typography + Instagram mockup";
  if (design.mockup) return "Instagram mockup";
  return "Typography";
}
