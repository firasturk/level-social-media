/**
 * Social-media posts: the plan of a client's month (ideas), the brief stored on each generated
 * post, and the deterministic prompt the image engine receives. No fashion assumptions: the
 * subject is a product, a place, a person at work, a texture, whatever the post calls for.
 */
import { REAL_PEOPLE_RULE, realRefLine } from "./realism";
import type { PromptImages } from "./prompts";
import { BODY_FONTS, HEADLINE_FONTS, LATIN_FONTS, type PostOverlayPatch } from "./overlay";
import { FULL_FRAME_RULE } from "./prompts";
import { childOf } from "./cast";
import { SAFE_WORDING_RULE } from "./safety";

export const POST_TYPES = [
  "product",
  "lifestyle",
  "offer",
  "tip",
  "quote",
  "announcement",
  "behind",
  "testimonial",
  "greeting",
] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_TYPE_INFO: Record<
  PostType,
  { label: string; labelAr: string; description: string; needsProduct: boolean }
> = {
  product: {
    label: "Product",
    labelAr: "منتج",
    description: "One product as the hero, in the client's world.",
    needsProduct: true,
  },
  lifestyle: {
    label: "Lifestyle",
    labelAr: "لايف ستايل",
    description: "People or places living the brand; the product may appear in use.",
    needsProduct: false,
  },
  offer: {
    label: "Offer",
    labelAr: "عرض",
    description: "A promotion. The image leaves calm space for the price and the headline overlay.",
    needsProduct: false,
  },
  tip: {
    label: "Tip",
    labelAr: "نصيحة",
    description: "Educational post. A clean visual that supports a short tip added as text later.",
    needsProduct: false,
  },
  quote: {
    label: "Quote",
    labelAr: "اقتباس",
    description: "A mood image with a large calm area for a quote overlay.",
    needsProduct: false,
  },
  announcement: {
    label: "Announcement",
    labelAr: "إعلان",
    description: "Launch, opening, event or news. Bold and simple.",
    needsProduct: false,
  },
  behind: {
    label: "Behind the scenes",
    labelAr: "كواليس",
    description: "The team, the craft, the place. Candid and warm.",
    needsProduct: false,
  },
  testimonial: {
    label: "Testimonial",
    labelAr: "رأي عميل",
    description: "A customer moment; the image leaves room for the quote.",
    needsProduct: false,
  },
  greeting: {
    label: "Occasion greeting",
    labelAr: "تهنئة مناسبة",
    description: "A greeting for an occasion the designer picked, designed in the theme with the occasion's elements.",
    needsProduct: false,
  },
};

/** What an offer post must carry before it can be generated: the designer fills all of it. */
export interface PostOffer {
  /** Products in the offer, by upload name (one or more). */
  products: string[];
  /** The price as it is written on the post ("15 JD", "٢ علب بـ ١٥ دينار"). */
  price: string;
  /** What the offer is: contents, conditions, dates. */
  details: string;
}

export function offerReady(o: PostOffer | undefined): boolean {
  return !!o && o.products.length > 0 && !!o.price.trim() && !!o.details.trim();
}

export const FORMATS = ["1:1", "4:5", "9:16"] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_INFO: Record<Format, { label: string; pixels: string }> = {
  "1:1": { label: "Square post", pixels: "1080 × 1080" },
  "4:5": { label: "Portrait post", pixels: "1080 × 1350" },
  "9:16": { label: "Story / Reel cover", pixels: "1080 × 1920" },
};

export const DEFAULT_POST_COUNT = 12;
export const MAX_POST_COUNT = 60;

/** One planned post of a month. Edited by the designer before and after generation. */
/** A reference the designer attached to one post: the picture to take something from, and what. */
export interface PostReference {
  /** R2 key of the picture. */
  key: string;
  /** R2 key of its thumbnail. */
  thumb: string;
  /** What to take from it, in the designer's words. */
  note?: string;
  name?: string;
  at: number;
}

export interface Post {
  index: number;
  type: PostType;
  title: string;
  /** What the photograph shows: place, subject, action, light, mood, where the product is. */
  brief: string;
  caption: string;
  hashtags: string;
  /** Upload name (stem) of the product the post uses, when any. */
  product?: string;
  /** Further products shown in the same picture (a row of cups, two drinks), by upload name. */
  products?: string[];
  /** Brand ambassadors in the picture, by name (from the month's chosen ambassadors). */
  people?: string[];
  format?: Format;
  /** Headline drawn over the image by the overlay (hook, 2-4 words) and its second line. */
  headline?: string;
  subline?: string;
  /** false hides the overlay on this post (a text-free image). */
  overlay?: boolean;
  /** Adjustments made in the on-image editor. */
  ov?: PostOverlayPatch;
  /** The text-on-design check of the finished post (the words drawn on the picture): for which picture, and what it found. */
  textCheck?: { ok: boolean; note: string; for: string; at: number };
  /** What the gate took out of the idea or the shot before the last Generate, so no credit was spent on it. */
  prechecks?: { at: number; notes: string[] };
  /** A carousel's slide or a series' post: the group it belongs to and its place in it. */
  group?: { id: string; kind: "carousel" | "series"; slide: number; of: number; role?: string };
  /** The real product photo is set into the picture (exact mode) for this post, whatever the month says. */
  exact?: boolean;
  /** An ingredients slide: the picture shows only these ingredients of the product, no cup or packaging. */
  ingredients?: string;
  /** A picture the designer attached to this post as a reference for its next take or revision. */
  reference?: PostReference;
  /** Which tile of a reference grid this post follows (grid mode). */
  tile?: string;
  /** That tile read in detail: what it shows, its background and how its text is set. */
  tileSpec?: TileSpec;
  /** Which of the theme's shots (1-based) this post follows, when the theme has shots. */
  shot?: number;
  /** Posting day, YYYY-MM-DD, inside the month. */
  date?: string;
  /** The occasion a greeting post is for (occasion id). */
  occasion?: string;
  /** An offer post's contents, filled by the designer. */
  offer?: PostOffer;
  /** This post's own shot: the pins' look written for its product, type, occasion and people. */
  scene?: string;
  /** A style picked from the gallery (styles.id): the scene is that style written for this product. */
  style?: string;
  /** The idea the post had before a style replaced it (it comes back when the style is taken off). */
  briefBeforeStyle?: string;
  /** The image (output key) the caption was written from: a new image makes it old. */
  captionFrom?: string;
  /** The designer wrote or edited the caption: a new image never rewrites it by itself. */
  captionHand?: boolean;
}

/** What a generated post was built from; stored on its task so retries and revisions keep it. */
export interface PostBrief {
  post: true;
  index: number;
  /** "background": a typographic tile's textured background only; the headline goes on it later. */
  design?: "background";
  /** A photo of the client's own place (R2 key): the picture is taken there (a grid's place tile). */
  place?: { key: string; /** What the photo shows: "shop" or "kitchen or factory". */ what?: string };
  /** A real photograph of a person, attached only for realism (skin, light, lens) when the post shows people. */
  realRef?: { key: string };
  /** A text tile with a product: the picture keeps a calm area for the words. */
  wordsSpace?: boolean;
  /** A test post made smaller than the month's size: it is made again with the rest. */
  draft?: "1K";
  /** The picked gallery style's picture (R2 key): attached as the style reference instead of a pin. */
  styleKey?: string;
  /** Grid months: this post's own tile, cut from the grid (R2 key), attached instead of the whole grid. */
  tileKey?: string;
  /** The outfit the post's people wear, from the month's wardrobe. */
  wardrobe?: string;
  /**
   * Exact product mode: the engine paints the scene with an empty place, and the real photo of this
   * product (sources.id) is set into it afterwards, so the product is never redrawn.
   */
  exact?: { source: string };
  type: PostType;
  title: string;
  brief: string;
  /** Hex palette with names, e.g. "Primary #1a1a1a". */
  palette: string[];
  /** true when the palette is the theme's chosen colours (they override the reference's). */
  paletteChosen?: boolean;
  /** The client's style text (from the brand kit) and the theme's direction. */
  style: string;
  theme: string;
  format: Format;
  /** Reference-library photo attached after the product, when any. */
  ref: string | null;
  /** True when the reference photo is image 1 itself (no product in this post). */
  refIsSource: boolean;
  hasProduct: boolean;
  /** The product's name and what its photo shows, so the scene is built around the right item. */
  product?: string;
  /** Theme-level visual language written by "Analyse theme" (light, palette, composition). */
  library?: string;
  /** Props the designer asked for this month (autumn leaves, pumpkins...). */
  props?: string;
  /** The client's ALWAYS and NEVER rules from the brand kit. */
  always?: string;
  never?: string;
  /** The client's own picture rules, verbatim: they stand above the defaults for everything about the picture. */
  rules?: string;
  /** Mistakes the review found in this client's earlier pictures, worded as rules (see server/lessons). */
  lessons?: string[];
  /**
   * The style or tile image is NOT attached: its people or its words would be copied over the
   * ambassadors or into the picture, so the words of the shot describe it instead.
   */
  noRefImage?: boolean;
  /** Which take of this post this is; takes after the first ask for a different picture. */
  take?: number;
  /** The reference shot this post follows (one of the theme's shots), when any. */
  shot?: string;
  /** Food, drink or toppings the shot names that the product photo does not show: named so the engine leaves them out. */
  notInPicture?: string[];
  /** Every product name of the month, so the prompt can keep file names away from the model. */
  productNames?: string[];
  /** A greeting post's occasion: what it is built from; royal days leave room for the portrait. */
  occasion?: { name: string; elements: string; portrait?: boolean };
  /** An offer post's contents, as the designer set them. */
  offer?: PostOffer;
  /** The client sells drinks (the review then allows cups and glasses). */
  sellsDrinks?: boolean;
  /** An ingredients slide: only these ingredients, shown on their own. */
  ingredients?: string;
  /** A quote or tip post without a product: what the brand's products are, so the backdrop is made of their foods and textures. */
  brandFoods?: string;
  /**
   * The post comes from a campaign brief: the designer's own reference picture and brief decide the
   * look, the colours and the ingredients around the product; the month's palette and the client's
   * look step back, and the brief's ingredients are never foreign.
   */
  campaign?: { ingredients?: string };
  /** The designer's own reference picture for this take, attached after the style reference. */
  editRef?: { key: string; note?: string };
  /** The post's occasion id (Coffee Day may show coffee). */
  occasionId?: string;
  /** Further products attached after image 1, in order: their names, notes and R2 keys. */
  extraProducts?: { name: string; note?: string; key: string }[];
  /** Brand ambassadors in this post, attached after the products: name, look and portrait key. */
  ambassadors?: { name: string; description: string; key: string }[];
  /** Grid mode: what the reference grid looks like and which tile this post follows. */
  grid?: string;
  tile?: string;
}

/** The designer cleared the props: nothing decorative is added to the scenes. */
export const NO_PROPS_RULE =
  "PROPS: none this month. Add no decorations of your own (no geometric blocks, cubes, pedestals, beads, pearls scattered around, fabric accents, ribbons, leaves, flowers or petals): the picture holds the surface, the product, the people the post names and what its idea itself needs.";

export const NO_TEXT_RULE =
  "TEXT: the image contains no letters, numbers, words, logos, labels, stickers, price tags, watermarks, speech bubbles or user-interface elements, in any language or script. Headlines, prices and logos are added later outside the image. Where the product itself carries printed text on its packaging in image 1, that packaging is reproduced exactly as photographed, nothing else is written anywhere.";

export const ONE_PRODUCT_RULE =
  "PRODUCT: image 1 is the product. Reproduce it exactly: identical shape, proportions, colours, materials, finish, label and packaging; nothing added, removed, restyled or recoloured. It appears once, whole and undistorted, as the clear subject.";

/**
 * A plain colour word for a hex ("deep blue", "cream", "tan"), so the prompt never carries a
 * stale name that contradicts the colour the designer actually picked ("Deep Crimson #0042aa").
 */
export function colourName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  if (s < 0.1 || d < 0.04) {
    if (l < 0.1) return "black";
    if (l < 0.3) return "charcoal";
    if (l < 0.55) return "grey";
    if (l < 0.8) return "light grey";
    if (l < 0.95) return "off-white";
    return "white";
  }
  // Warm, quiet tones read as the names designers use for them.
  if (h >= 15 && h < 50) {
    if (l < 0.45) return l < 0.22 ? "dark brown" : "brown";
    if (l >= 0.85) return "cream";
    if (s < 0.6 && l >= 0.7) return "sand beige";
    if (s < 0.6) return "tan";
  }
  const hue =
    h < 10 ? "red"
    : h < 20 ? "red-orange"
    : h < 40 ? "orange"
    : h < 52 ? "amber"
    : h < 66 ? "yellow"
    : h < 85 ? "yellow-green"
    : h < 155 ? "green"
    : h < 180 ? "teal"
    : h < 200 ? "cyan"
    : h < 245 ? "blue"
    : h < 265 ? "indigo"
    : h < 290 ? "purple"
    : h < 320 ? "magenta"
    : h < 345 ? "pink"
    : "red";
  const tone =
    l < 0.2 ? "very dark "
    : l < 0.38 ? "deep "
    : l > 0.85 ? "pale "
    : l > 0.68 ? "light "
    : "";
  const muted = s < 0.3 ? "muted " : "";
  return `${tone}${muted}${hue}`;
}

/** "deep blue #0042aa": the colour word always comes from the hex itself. */
export function colourLabel(hex: string): string {
  const h = hex.trim().toLowerCase();
  const name = colourName(h);
  return name ? `${name} ${h}` : h;
}

/**
 * The product's file name never reaches the image model: it gets printed on the packaging
 * ("50 - Pistachio Burma" written on a tin). Every spelling of a known product name in the text,
 * whole or by its dash-separated parts, becomes "the product".
 */
export function withoutProductNames(text: string, names: string[]): string {
  const variants = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const parts = name.split(/\s*[-–—_]\s*/).filter(Boolean);
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j <= parts.length; j++) {
        const run = parts.slice(i, j);
        if (run.join("").length < 4 || (run.length === 1 && /^\d+$/.test(run[0]))) continue;
        variants.add(run.join(" - "));
        variants.add(run.join("-"));
        variants.add(run.join(" "));
      }
    variants.add(name);
  }
  // A space in a name needs a space in the text: a product called "milk shake" never eats the word "milkshake".
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  let out = text;
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?:the\\s+)?["'“”‘’«»]?${esc(v)}["'“”‘’«»]?`, "gi"), "the product");
  }
  return out.replace(/the product(?:\s*[-–—,]?\s*the product)+/gi, "the product").replace(/\bthe the product\b/gi, "the product");
}

/** Client rules about the layout (logo, marks, bands, type) are the designer's, never drawn in the photo. */
const LAYOUT_RULE =
  /\b(logo|logos|mark|marks|band|ornament|ornaments|kufic|typeset|typography|lettering|font|fonts|corner|ground|frame|border|caption|captions|headline|headlines|swipe|hashtag|hashtags|emoji|emojis|cta|call[- ]to[- ]action|slogan|slogans|tagline|taglines|carousel|carousels|arabic|english|levantine|msa|dialect|language|wording|copywriting|post copy|sticker|stickers|watermark|overlay)\b/i;

/**
 * Sentences about the words to be set on the picture (headline placement, a reference's slogan,
 * a swipe arrow): the designer adds words later, so the engine never reads them as things to draw.
 */
const WORDS_SENTENCE =
  /\b(headline|headlines|caption|captions|lettering|typography|typeset|swipe|slogan|tagline|wordmark|subtitle|hashtag|call[- ]to[- ]action|cta)\b|\b(text|words?|title|copy)\s+(reads?|says?|is|are|sits|goes)\b|\b(reads?|says?)\s*["'“‘]/i;
export function withoutWordsSentences(text: string): string {
  if (!text.trim()) return text;
  return text
    .split(/(?<=[.!?؟])\s+/)
    .filter((x) => !WORDS_SENTENCE.test(x))
    .join(" ")
    .trim();
}

export function photoRules(text: string | undefined): string {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !LAYOUT_RULE.test(l))
    .join("\n");
}

/** Colour words of the reference analysis give way to the designer's chosen colours. */
export function withoutPaletteText(text: string): string {
  return withoutColourWords(
    text
      .replace(/##\s*Palette[\s\S]*?(?=\n##\s|$)/i, "")
      .split("\n")
      .map((line) =>
        line
          .split(/(?<=[.!?])\s+/)
          .filter((sentence) => !/\b(palette|colou?r scheme|dominated by)\b/i.test(sentence))
          .join(" "),
      )
      .join("\n"),
  ).trim();
}

const COLOUR_WORDS =
  "red|reds|crimson|burgundy|maroon|scarlet|pink|blush|fuchsia|magenta|orange|coral|terracotta|rust|ochre|yellow|mustard|green|sage|emerald|teal|turquoise|blue|navy|cobalt|azure|purple|violet|lilac|lavender|tan|beige|cream|ivory|camel|khaki|sand(?=-colou?red)";

/**
 * "a glossy red car hood" -> "a glossy car hood": once the designer has chosen the month's colours,
 * the colours the reference happened to have are dropped from its shots and visual language.
 */
export function withoutColourWords(text: string): string {
  const mod = "(?:deep|dark|light|pale|bright|rich|warm|soft|muted|dusty|vibrant|vivid|toasted|burnt)";
  const word = `(?:${mod}[\\s-]+)*(?:${COLOUR_WORDS})(?:-(?:colou?red|toned|coloured))?`;
  return text
    .replace(new RegExp(`\\b${word}(?:(?:\\s*(?:,|and|or|&|-)\\s*)${word})*\\b\\s?`, "gi"), "")
    .replace(/\b([Aa])n? +(?=\w)/g, (m, a: string, at: number, all: string) =>
      /[aeiou]/i.test(all[at + m.length] ?? "") ? `${a}n ` : `${a} `,
    )
    .replace(/ {2,}/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .replace(/,\s*([.;:])/g, "$1")
    .replace(/\b(with|and|in|of) (and|or)\b/gi, "$1");
}

export function paletteRule(palette: string[], chosen = false): string {
  if (!palette.length) return "";
  if (chosen)
    return `COLOURS (chosen by the designer for this month; they win over everything else): the backgrounds, surfaces, props, fabrics and light sit inside this palette: ${palette.join(", ")}. They replace the colours of the style reference and any colour named in the shot or the visual language above: a pink reference still gives a scene in these colours. These colours are for the scene only: the product, its box, tin, lid and print keep the exact colours of its photo even when they are close to or clash with the background (a silver tin stays silver on a blue wall, never turns blue); packaging is never recoloured to match the palette.`;
  return `PALETTE: the scene, props, surfaces and light sit inside this palette: ${palette.join(", ")}. The product, its packaging and print keep the exact colours of its photo; packaging is never recoloured to match the palette.`;
}

export function socialFrameRule(format: Format): string {
  const where =
    format === "9:16"
      ? "a tall vertical story frame; the subject sits in the middle band and the top third stays calm and low in detail for a headline"
      : format === "4:5"
        ? "a portrait post frame; the subject fills it with comfortable margins"
        : "a square post frame; the subject is centred with even margins";
  return `FORMAT: ${where}. Nothing important touches the edges; no bars, borders or collage.`;
}

export const HEADLINE_SPACE_RULE =
  "HEADLINE SPACE: keep roughly a third of the frame as a calm, low-contrast, low-detail area (plain surface, soft sky, blurred depth) where a headline can be placed later. The subject stays sharp in the rest of the frame.";

export const POST_SHADOW_RULE =
  "SHADOWS: one light source for the whole scene. Every object, the product included, casts exactly one shadow consistent in direction, length and softness with that light, with a soft contact shadow at its base; nothing floats, nothing has a second shadow or a shadow from a light that is not in the scene.";

export const POST_PEOPLE_RULE =
  "PEOPLE: only when the post brief asks for people, and then exactly the number it names, each with one head, two arms, two hands with five fingers and two legs, natural faces and expressions, no duplicated or extra limbs. A real person from image 1, when present, is kept identical in face, hair and skin.";

/** No ambassador in the post: nobody appears; a hand is the most the picture may show. */
export const NO_PEOPLE_RULE =
  "PEOPLE: none. No person, model, face, body, crowd or silhouette appears, whatever the style reference shows. At most one natural hand holding or placing the product, and only when the post asks for it.";

/** Ambassadors in the post: only them, from their portraits. */
export const ONLY_AMBASSADORS_RULE =
  "PEOPLE: only the ambassadors from the attached portraits, each exactly once, each with one head, two arms, two hands with five fingers, natural face and expression. No other people: no friends, crowds, staff or passers-by, whatever the style reference shows. Each ambassador keeps their own gender, face, hair and build from the portrait: the reference's person is replaced, never copied onto them, so clothing that belongs to another gender (a headscarf or hijab, a dress or a skirt on a man; a beard on a woman) is never put on an ambassador; they wear clothes that fit them, in the month's colours.";

/** The product is photographed, never invented: nothing is added to it, nothing else is food. */
/** Real size, real colours, a real grip: the three ways a product still looked wrong. */
export const HANDLING_RULE =
  "TRUE SIZE AND GRIP: every product keeps its real-world size against hands, people and furniture (a gift box or tin is about as wide as a forearm is long, a tray rests on a table or on both forearms, one piece of baklava fits between two fingers); it is never enlarged to fill the frame. It is held the way a person really holds it: level, with both hands under or around it, or simply set on a surface; never balanced on fingertips, pinched at a rim, hung, tilted to spill, or placed on top of another object. A product is never put into a bag, a basket, a carrier, another box or any container that is not in its photo, and nothing else is stacked on it. A cup, glass or drink stands on the table or in a hand, NEVER inside a plate, bowl, saucer or tray as if it were food.";

/** A picked style may stage the product big or several times: its size follows the style, its look never changes. */
export const STYLED_HANDLING_RULE =
  "SIZE AND COPIES: the product's scale, number of copies and placement follow the picked style or the grid tile (a stack, a giant product towering over a person, several copies on the floor or on pedestals, when the style shows that). Every copy is the same product, identical to its photo. When a person holds it, it is held the way a person really holds it: level, with the hand under or around it. A product is never put into a bag, a basket, a carrier, another box or any container that is not in its photo; a cup, glass or drink is never set inside a plate, bowl, saucer or tray as if it were food.";

/** Every copy of the product in a styled picture is the photographed product, never the style's own. */
export function styledProductRule(styleImage: number): string {
  return `PRODUCT: image 1 is the product. Every copy of it in the picture, giant or small, is reproduced exactly from image 1: identical shape, proportions, colours, materials, lid or no lid, toppings piled exactly as photographed, and the same printed logo in the same colour and lettering. Image ${styleImage}'s product, packaging, logo and print never appear; only its staging is used.`;
}

export const PRODUCT_TRUTH_RULE =
  "PRODUCT TRUTH (most important): this is a real commercial photoshoot of the attached product photos. Every product looks exactly as in its photo: same shape, proportions, number of pieces, arrangement, colours, filling, toppings, packaging and print. Packaging stays exactly as photographed: a closed box keeps its printed lid on, an open box or tray stays open as shown; a product is never opened, closed, unwrapped, re-packed or taken out of its box, and its box never changes shape, material or size. Nothing is added onto or into a product (no nuts, pine nuts, seeds, sauce, syrup, cream, herbs, powder, petals or decoration that its photo does not show) and nothing is removed; packaging is never redesigned: its print, logo, colours and pattern are copied exactly from the photo, and no product name, file name, number or new word is ever written on a box, tin, label or anywhere else. The only food and drink in the picture are the attached products: no other dishes, sweets, drinks, juices, coffee, tea, glasses of liquid, fruit or loose ingredients, whatever the style reference or the brief shows. Props are non-food: plates and trays, fabrics, ceramics, wood, stone, metal, leaves and flowers kept away from the food.";

/** The photo is only the photograph: the logo, the corner mark and any band or frame come later. */
export const NO_DESIGN_RULE =
  "PHOTO ONLY: the image is a plain photograph, not a designed post. No logo, brand mark, emblem, header or footer band, ornamental strip, pattern border, frame or graphic panel is drawn anywhere: the designer adds the logo and graphics afterwards. Brand patterns appear only where they are printed on the product's own packaging in its photo.";

const AVOID =
  "AVOID: text, letters, numbers, logos, watermarks, price tags, UI elements, speech bubbles, extra limbs, duplicated products, a cup or drink inside a plate or bowl, changed product colour or shape, toppings or garnish the product photo does not show, other food or drinks, people who are not in the post, borders or bars, collage, split frames, cartoon, CGI or illustration style unless the brief asks for it, oversaturated HDR, plastic skin.";

/** What the picture must be for the post's type: a greeting, a text-led tip or quote, an offer. */
function postTypeRule(b: PostBrief): string {
  if (b.type === "greeting" && b.occasion)
    return b.occasion.portrait
      ? `OCCASION (${b.occasion.name}): a dignified greeting design in the month's colours and the theme's light, built from ${b.occasion.elements}. The upper middle of the frame stays an empty, calm, softly lit space framed by the design: an official portrait is placed there later. No person, face, silhouette, portrait, photo frame with a person, crown, coat of arms or text is drawn anywhere.`
      : `OCCASION (${b.occasion.name}): a greeting picture for this occasion in the theme's world, built from ${b.occasion.elements}, in the month's colours and the theme's light. No text.`;
  if ((b.type === "tip" || b.type === "quote") && !b.hasProduct && !b.exact)
    return `TEXT-LED POST, TEXTURE BACKDROP: the whole frame is a rich, real texture that belongs to this brand, never a plain flat colour, a gradient or an empty wall: ${b.brandFoods ? `the brand's own foods and ingredients close up and filling the frame (the brand sells: ${b.brandFoods}; so fruit pieces and whole fruit, berries, chocolate, marshmallows, coffee beans, cream, crushed ice, as fits), or a material of its world (its paper cups' texture, a wooden counter, linen, marble)` : "a material or ingredient texture of the brand's world (fruit, beans, chocolate, crushed ice, wood, linen, marble)"}, softly and evenly lit, in the month's colours where they fit. About a third of the frame (the middle or the upper middle) stays calmer and lower in contrast (a soft-focus or lightly misted part of the same texture) for the words added later. No packaging, cup, logo or product in the picture, and no words.`;
  if (b.type === "tip" || b.type === "quote")
    return "TEXT-LED POST: a calm, minimal picture with one large clean area (about half the frame, a plain wall or surface) for the words added later; the product, when attached, is small and to one side, never crowded.";
  if (b.type === "offer" && b.offer)
    return "OFFER: the offer's products together, clearly visible and whole, as a crisp commercial offer shot; a calm area is left for the price added later.";
  return "";
}

/**
 * A fix note starts with this mark: the picture is made again from the brief with the review's
 * lessons, instead of patching the rejected picture (which keeps its faults: a generated-looking
 * face, a toy-sized product, an invented topping).
 */
export const FRESH_TAKE = "FRESH TAKE: ";

/** The edit text with its fresh-take mark read off. */
export function splitEdit(edit: string | null | undefined): { fresh: boolean; text: string } {
  const t = (edit ?? "").trim();
  return t.startsWith(FRESH_TAKE) ? { fresh: true, text: t.slice(FRESH_TAKE.length).trim() } : { fresh: false, text: t };
}

/** The text without the sentences that name any of the words (a biscuit dipped in, syrup poured over). */
export function withoutSentencesNaming(text: string, words: string[]): string {
  if (!words.length || !text.trim()) return text;
  const pattern = new RegExp(`\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]*")).join("|")})`, "i");
  return text
    .split(/(?<=[.!?؟])\s+/)
    .filter((x) => !pattern.test(x))
    .join(" ")
    .trim();
}

/** A garment whose print or graphic is on its back, as its photo and description show. */
export const BACK_PRINT = /\b(?:printed |graphic |print |design |artwork |text |embroider\w* )?(?:on|across|at|covers?|covering) (?:the |its )?(?:upper |lower )?back\b|\bback (?:print|graphic|design|artwork)\b|\bon the reverse\b/i;

/**
 * The rule that keeps a back print on the back: the engine's easy way out is to move the graphic
 * to the chest so the wearer can face the camera; the pose turns instead.
 */
export function backPrintRule(notes: string[]): string {
  const printed = notes.filter((t) => t && BACK_PRINT.test(t));
  if (printed.length)
    return "BACK PRINT: the graphic of this garment is on its BACK, as photographed. It stays on the back: the wearer is seen from behind or turned three-quarter away so the back print is in view, or the garment is shown folded or laid with its back up. The front of the garment is plain, as in its photo; the graphic is never moved, copied or mirrored onto the front or the chest.";
  const front = notes.filter((t) => t && FRONT_PRINT.test(t));
  if (front.length)
    return "FRONT PRINT: the graphic of this garment is on its CHEST, as photographed. The wearer faces the camera or stands three-quarter to it so the chest print is in view; the back of the garment is plain, as in its photo, and the graphic is never moved, copied or mirrored onto the back.";
  return "";
}

/** A garment whose print or graphic is on its chest or front, as its photo and description show. */
export const FRONT_PRINT = /\b(?:on|across|at) (?:the |its )?(?:chest|front)\b|\b(?:chest|front) (?:print|graphic|design|artwork|text)\b/i;

const CHILD_WORDS = { test: (t: string) => !!childOf(t) };

/** The engine prompt for one post. Deterministic: the same brief gives the same text. */
export function buildPostPrompt(raw: PostBrief, rawEdit = "", images: PromptImages = {}): string {
  // A fix note makes the picture again from the brief with the review's lessons; a plain edit revises the picture.
  const { fresh, text: edit } = splitEdit(rawEdit);
  // What the idea or the shot added to the product (a biscuit, syrup, rolls) leaves their text: the
  // engine follows a concrete sentence over any rule against it.
  const b: PostBrief =
    raw.hasProduct && raw.notInPicture?.length
      ? { ...raw, brief: withoutSentencesNaming(raw.brief, raw.notInPicture) || raw.title, shot: raw.shot ? withoutSentencesNaming(raw.shot, raw.notInPicture) || undefined : raw.shot }
      : raw;
  // A typographic tile: only its background is painted; the words go on it afterwards.
  if (b.design === "background")
    return [
      `A flat, evenly lit background that fills the whole ${b.format === "9:16" ? "tall 9:16 story frame" : b.format === "1:1" ? "square frame" : "4:5 portrait frame"}.`,
      `THE BACKGROUND: ${b.shot ?? "a plain surface in the month's first colour"}. Seen straight on, edge to edge, with a soft natural texture and even light.`,
      "NOTHING ELSE: no objects, products, food, drinks, people, hands, props, shadows of objects, frames, borders, text, letters, numbers or logos. Words are set on it later.",
      "Any attached image is a reference feed for this background's colour and texture only: never reproduce its tiles, objects or words.",
      edit.trim() ? `REVISION: ${edit.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  const parts: string[] = [];
  const extras = b.extraProducts ?? [];
  const people = b.ambassadors ?? [];
  // Older briefs carry "file name — note" in b.product; the name part never reaches the model.
  const names = [...(b.productNames ?? []), ...extras.map((e) => e.name)];
  const productText = (() => {
    const raw = (b.product ?? "").trim();
    const note = raw.includes(" — ") ? raw.slice(raw.indexOf(" — ") + 3) : raw;
    return withoutProductNames(note, names).trim();
  })();
  // Sentences that put a product into a bag or a carrier (older briefs and shots) never reach the
  // engine: the product is held or set down, never packed into something.
  // Bags and carriers never reach the engine, with a product or without one (it copies a
  // reference's branded bag, logo and all).
  const unbagged = (t: string) => withoutBags(t);
  const clean = (t: string) => withoutLettering(unbagged(withoutProductNames(t, names)));
  // A campaign brief keeps its reference's own colours: the month's palette does not apply.
  const chosen = !!b.paletteChosen && b.palette.length > 0 && !b.campaign;
  const styleRef =
    "take its place, light, camera, colour grade, mood and the way it stages people (how many, how framed, what they do), never its specific objects, its text, or the identity of its people (new faces, same role)";
  // A grid month's own tile: its composition is the picture, the brand is not.
  const tileRef =
    "the tile of the month's reference grid that this post recreates: recreate its composition, camera angle and distance, arrangement, set, surface and light closely, with this brand's product in place of its products; never its products, packaging, bags, cups, cards, text, logo, brand or the identity of its people";
  // A style picked from the gallery is the picture to make, not just a mood.
  const picked = b.campaign
    ? `the reference picture the designer attached to the campaign brief (its people are placeholders: the attached ambassadors take their place, at the ambassadors' own age and gender): recreate its composition, camera angle and distance, set, surfaces, colours, light, props, effects and mood closely, with this brand's product in place of its product${b.campaign.ingredients?.trim() ? ` and the brief's ingredients (${b.campaign.ingredients.trim()}) where it shows its own` : ""}; never its product, packaging, text, logo, price, buttons or the identity of its people, and nothing of the page or app it was saved from`
    : `the style the designer picked (its people are placeholders: the attached ambassadors take their place, at the ambassadors' own age and gender): recreate its composition, camera angle and distance, set, surface, gesture, effects and light closely, with this brand's product in place of its product; never its product, text, logo or the identity of its people${b.paletteChosen && b.palette.length ? `. ITS COLOURS ARE NOT COPIED: the backdrop, surfaces, props and light take the month's colours (${b.palette.join(", ")}) instead` : ""}`;
  // In exact mode the reference's own product is never drawn: its place stays empty for the real photo.
  const exactRef = b.exact
    ? " ITS PRODUCT IS NOT DRAWN: the cup, can, glass, bottle, box or dish it shows is left out entirely, with no stand-in of any kind; where it stands, the scene's own surface is left empty for the real product that is set in afterwards. Nothing of its print, logo or lettering appears anywhere."
    : "";
  // Images are attached in this order: products, ambassador portraits, style reference, revision.
  let n = 0;
  if (b.hasProduct && extras.length) {
    n = extras.length + 1;
    parts.push(
      `Images 1 to ${n} are product photos: ${n} different products that appear TOGETHER in this one picture, each reproduced exactly (shape, colours, label, packaging) and each appearing once. ${extras.map((e, i) => `Image ${i + 2}: ${e.note ? withoutProductNames(e.note, names) : "another of the client's products"}.`).join(" ")}`,
    );
  } else if (b.hasProduct) {
    n = 1;
    parts.push("Image 1 is the product photo: the product is the source of truth and is reproduced exactly.");
  } else if (b.ref || b.styleKey || b.tileKey) {
    n = 1;
    parts.push(`No product is attached. Image 1 is ${b.styleKey ? picked : b.tileKey ? tileRef : `a style reference: ${styleRef}`}.${exactRef}`);
  } else parts.push("No product is attached.");
  if (people.length) {
    const first = n + 1;
    n += people.length;
    parts.push(
      `${people.length > 1 ? `Images ${first} to ${n} are portraits of the brand's ambassadors` : `Image ${first} is the portrait of the brand's ambassador`}: ${people.map((p, i) => `Image ${first + i}: ${p.name}${p.description ? ` (${p.description})` : ""}.`).join(" ")} ${people.every((p) => CHILD_WORDS.test(p.description)) ? "ALL THE AMBASSADORS ARE CHILDREN: every person in the picture is one of these children; no adult man or woman appears anywhere, whatever the style or the reference shows, and the style's grown-ups are replaced by these children at their own age and size. " : ""}Every ambassador in the picture is exactly this person: the same face, features, hair, skin tone and build as the portrait, in a new pose, expression and outfit that fit the scene; the portrait's background, framing and clothes are not copied. No other people appear unless the post asks for them.`,
    );
  }
  if (b.place) {
    n += 1;
    parts.push(
      `Image ${n} is a photo of the client's own ${b.place.what ?? "place"}: the picture is taken HERE, in this same room with its walls, materials, furniture, windows and light, from a fitting angle; the product and any people are set into it. Never invent another place, never copy its signs or words.`,
    );
  }
  if (b.realRef) {
    n += 1;
    parts.push(realRefLine(n));
  }
  if (b.hasProduct && (b.ref || b.styleKey || b.tileKey) && !b.refIsSource && !b.noRefImage) {
    n += 1;
    parts.push(`Image ${n} is ${b.styleKey ? picked : b.tileKey ? tileRef : `a style reference: ${styleRef}`}.`);
  }
  if (b.editRef && images.reference) {
    n += 1;
    const note = b.editRef.note?.trim();
    parts.push(
      `Image ${n} is a reference picture the designer attached for this take${note ? `, with this note on what to take from it: "${note}"` : ""}. ${note ? "Do exactly what the note says with it" : "Take its composition, light, colour world, props and mood"} and keep everything else as the brief below says. Nothing of the reference's own product, packaging, text, logo or people is copied: the product stays this brand's product exactly as photographed.`,
    );
  }
  parts.push(b.hasProduct ? "Create the scene described below around the product." : "Create the scene described below.");
  if (b.exact && !images.revision)
    parts.push(
      "THE PRODUCT IS NOT IN THIS PICTURE: the brand's real product photo is set in afterwards. Wherever the post or the shot below describes the product (a box, tin, tray, package or its sweets, open or closed, with its lid), that describes the photo added later: draw none of it, not even a similar or empty one; leave its place as plain empty surface.",
    );
  if (images.revision)
    parts.push(
      "The last image is the previous result of this post: apply the revision below to it and keep everything else.",
    );
  if (b.hasProduct && productText && productText.toLowerCase() !== "the product")
    parts.push(`THE PRODUCT IN IMAGE 1 (as photographed): ${productText}`);
  if (b.hasProduct) {
    const back = backPrintRule([productText, ...extras.map((e) => e.note ?? "")]);
    if (back) parts.push(back);
  }
  // A retake of a picked style stays that style: only the details move, never its composition.
  if ((b.take ?? 1) > 1 && b.styleKey)
    parts.push(
      `TAKE ${b.take}: the designer rejected the earlier takes of this post. Make a fresh take of the same picked style: keep its composition, set, camera and scale; get the product exactly right and vary only small details (the pose, the exact placement of the copies).`,
    );
  else if ((b.take ?? 1) > 1)
    parts.push(
      `TAKE ${b.take}: the designer rejected the earlier takes of this post. Make a clearly different picture of the same brief: another camera angle and distance, another arrangement of the set and props, another placement of the product, a different light direction; the subject, the product and the mood stay.`,
    );
  // A picked style replaces the post's own idea of the photograph: the style, written for this product, is the picture.
  if (b.styleKey && b.shot?.trim())
    parts.push(
      `POST (${POST_TYPE_INFO[b.type]?.label ?? b.type}): ${clean(b.title)}\nTHE PHOTOGRAPH (the picked style written for this product; follow it closely, every element of it): ${clean(withoutWordsSentences(chosen ? withoutColourWords(b.shot.trim()) : b.shot.trim()))}`,
    );
  else parts.push(`POST (${POST_TYPE_INFO[b.type]?.label ?? b.type}): ${clean(b.title)}\n${clean(withoutWordsSentences(b.brief.trim()))}`);
  // A fresh take's findings come first, right after the brief: the engine weighs what it reads early.
  if (edit.trim() && fresh && b.editRef && images.reference)
    parts.push(`NEW TAKE: the designer asks for this post again with the attached reference. Make the picture again from the brief: ${edit.trim()}`);
  else if (edit.trim() && fresh)
    parts.push(
      `NEW TAKE: the earlier picture of this post was rejected by the review for the problems below. Make the picture again from the brief, and make sure none of these problems is in it: ${edit.trim()}`,
    );
  const typeRule = postTypeRule(b);
  if (typeRule) parts.push(typeRule);
  // The month's theme (its pins' world, visual language and props) steps back for a picked style.
  // A grid month follows its grid: the theme's pins and their visual language step back too.
  const theme = b.styleKey || b.grid ? "" : chosen ? withoutPaletteText(b.theme.trim()) : b.theme.trim();
  const style = [chosen ? withoutPaletteText(b.style.trim()) : b.style.trim(), theme].filter(Boolean).join("\n");
  if (b.campaign && b.styleKey) {
    // The designer's reference is the look: the client's usual finish would pull the picture away from it.
  } else if (style && b.styleKey)
    parts.push(`CLIENT LOOK (colour grade and finish only; the picked style decides the set, composition, people and scale):\n${style}`);
  else if (style) parts.push(`CLIENT STYLE:\n${style}`);
  // Layout rules (logo placement, bands, marks, type) belong to the designer's overlay, not the photo.
  // The client's ALWAYS scenes (a blue sky, pool water) are a theme of their own: a picked style replaces them.
  const always = b.styleKey ? "" : photoRules(b.always);
  const never = photoRules(b.never);
  const rules = [always ? `ALWAYS: ${always}` : "", never ? `NEVER: ${never}` : ""].filter(Boolean);
  if (rules.length)
    parts.push(
      b.styleKey
        ? `CLIENT RULES FOR THE PHOTOGRAPH (they never change the picked style's set, composition or scale):\n${rules.join("\n")}`
        : `CLIENT RULES FOR THE PHOTOGRAPH (these override the reference and the brief):\n${rules.join("\n")}`,
    );
  if (b.rules?.trim())
    parts.push(`THE CLIENT'S OWN IMAGE RULES (they stand above every default about realism, light, people and product fidelity; the set, composition and scale still follow the picked style or the grid tile):\n${b.rules.trim()}`);
  const library = b.library && !b.styleKey && !b.grid ? (chosen ? withoutPaletteText(b.library.trim()) : b.library.trim()) : "";
  if (library) parts.push(`VISUAL LANGUAGE:\n${library}`);
  if (b.shot?.trim() && !b.styleKey)
    parts.push(
      `REFERENCE SHOT: this post recreates the place, camera, framing and gesture of one picture of the reference, with new faces for any people: ${clean(withoutWordsSentences(chosen ? withoutColourWords(b.shot.trim()) : b.shot.trim()))}\nThe client's product is shown the way it is really held or served: a box or tin held level with both hands from below or set on a surface, a tray on a table, one piece lifted between the fingers; it is never squeezed into the reference's cup, cup carrier, glass, wrapper or plate, never put into a bag, and never cut out and pasted onto the scene.${b.hasProduct ? " Where the shot names any food, drink, pastry, topping, sauce, syrup, drizzle, sprinkles or garnish that the attached product photo does not show, it is NOT in the picture: the product stands there by itself, exactly as photographed, in its own colours, with nothing added onto it." : ""}`,
    );
  if (b.campaign && b.notInPicture?.length)
    parts.push(
      `NOT IN THE PICTURE: ${b.notInPicture.join(", ")}. The reference or the idea shows them, but this product does not have them: none of them appears anywhere in the picture, not beside the product, not tucked into the fruit, not on the surface. ${b.campaign.ingredients?.trim() ? `Only ${b.campaign.ingredients.trim()} surround the product.` : "Nothing edible surrounds the product."}`,
    );
  else if (b.hasProduct && b.notInPicture?.length)
    parts.push(
      `NOT IN THE PICTURE: ${b.notInPicture.join(", ")}. The shot or the idea names them, but the product photo does not have them: nothing is dipped into, poured over, sprinkled on or set beside the product. The product appears exactly as photographed, by itself, with its own toppings and colours only.`,
    );
  if (b.props?.trim() && !b.styleKey)
    parts.push(
      `PROPS: the scene includes ${b.props.trim()}, placed naturally around the subject in the same light; they never cover the product.`,
    );
  else if (!b.styleKey) parts.push(NO_PROPS_RULE);
  if (b.wardrobe)
    parts.push(
      `WARDROBE: the people in the picture wear ${b.wardrobe}. This outfit replaces any clothes the shot or the reference describes; it stays modest where the person's rules say so, and nothing is printed or written on it.`,
    );
  if (b.grid)
    parts.push(
      `REFERENCE GRID: ${b.tileKey ? "the month follows a feed grid (its tile for this post is attached)" : "the attached style reference is a whole feed grid"}. Reproduce its world (sets, materials, props, palette, light, camera) and the rhythm of its tiles, never its products, packaging, shopping bags, cups, boxes, cards, text, logos or brand name: nothing of that brand appears in this picture.${b.tile ? ` THIS POST FOLLOWS TILE: ${tileForPeople(tileWithoutBags(b.tile.trim(), !!b.hasProduct || !!b.exact), people.length)}` : ""}\n${gridWithoutBags(b.grid.trim(), !!b.hasProduct)}`,
    );
  parts.push(socialFrameRule(b.format));
  if (b.type === "offer" || b.type === "quote" || b.type === "tip" || b.type === "testimonial" || b.wordsSpace)
    parts.push(HEADLINE_SPACE_RULE);
  const palette = b.campaign
    ? `COLOURS: this post follows a campaign brief, so the month's palette does not apply. The backdrop, surfaces, props and light keep the colours, contrast and mood of the attached reference picture (a dark moody scene stays dark); the product keeps the exact colours of its photo and is never recoloured.`
    : paletteRule(b.palette, !!b.paletteChosen);
  if (palette) parts.push(palette);
  if (chosen)
    parts.push(
      `BACKGROUND: the backdrop, wall and main surface behind the product are ${b.palette[0]}; the other chosen colours go to ${b.props?.trim() ? "the props, fabrics and accents" : "the surfaces, the light and the people's clothes"}.`,
    );
  if (b.exact && images.revision)
    parts.push(
      "THE PRODUCT in the previous result is the real product photo, set in exactly: keep it untouched, pixel for pixel (shape, colours, packaging, size and position); change only what the revision asks around it.",
    );
  else if (b.exact && b.campaign?.ingredients?.trim())
    parts.push(
      `EMPTY PLACE FOR THE PRODUCT: the brand's product is photographed separately and set into this picture afterwards, so it is NOT drawn. Leave its place empty: a plain, clear area of the scene's own main surface (the same table top, cloth or backdrop that runs through the picture) in the lower middle of the frame, about the middle 45% of the width and from 45% to 85% of the height, in sharp focus, lit by the scene's light, seen from the same camera angle as the product's photo (straight from above when the product is photographed from above), big enough for that product at its real size. Nothing marks or holds that place: no stand, plinth, tray, ring, frame, plate, mat, box, tin, product, prop, hand or shadow of a missing object; it is simply empty surface. Wherever the post says someone holds, carries or shows the product, they sit or stand beside that place instead, never touching or covering it; the composition leads the eye to it.`,
      `AROUND THE EMPTY PLACE: the brief's ingredients, real and natural, staged the way the reference stages its own: ${b.campaign.ingredients.trim()}. Nothing else edible, and nothing edible from the reference that is not in this list (its chilies, its other fruit, its can or glass): these ingredients take their places.`,
    );
  else if (b.exact)
    parts.push(
      `EMPTY PLACE FOR THE PRODUCT: the brand's product is photographed separately and set into this picture afterwards, so it is NOT drawn. Leave its place empty: a plain, clear area of the scene's own main surface (the same table top, cloth or backdrop that runs through the picture) in the lower middle of the frame, about the middle 45% of the width and from 45% to 85% of the height, in sharp focus, lit by the scene's light, seen from the same camera angle as the product's photo (straight from above when the product is photographed from above), big enough for that product at its real size. Nothing marks or holds that place: no stand, plinth, tray, ring, frame, plate, mat, box, tin, product, prop, hand or shadow of a missing object; it is simply empty surface. Wherever the post says someone holds, carries or shows the product, they sit or stand beside that place instead, never touching or covering it; the composition leads the eye to it.`,
    );
  if (b.hasProduct) {
    parts.push(PRODUCT_TRUTH_RULE, b.styleKey || b.tileKey ? STYLED_HANDLING_RULE : HANDLING_RULE);
    if (b.campaign && b.styleKey)
      parts.push(
        "THE REFERENCE'S CONTAINER IS NOT THIS PRODUCT: the cup, can, glass, bottle or box in the reference picture is only a stand-in for where the product goes. The product keeps the exact shape of its own photo (image 1): its height against its width, taper, rim, smooth or ribbed walls, material, transparency, fill and the print and logo in the same place, size and colour. A short smooth cup stays short and smooth even when the reference's is tall and ribbed. LID: when the shot shows the drink open (a splash out of it, a pour, fruit or ice piled into it), the cup is shown without its dome lid, open at the top with the drink visible; nothing else of the cup changes. Otherwise the lid stays as photographed.",
      );
    if (b.campaign?.ingredients?.trim())
      parts.push(
        `THE BRIEF'S INGREDIENTS (the one exception to the rule above): the designer's brief shows the product's own ingredients around it, real and natural, the way the reference picture stages its own: ${b.campaign.ingredients.trim()}. They appear as the shot describes them (whole, broken, scattered, in small bowls, a splash of the drink's own liquid); nothing else edible joins them, and nothing is added onto or into the product itself beyond what its photo shows. The reference's own ingredients, garnishes and drinks that are not in this list (its chilies, its other fruit, its can or glass) are NOT in the picture: these ingredients take their places.`,
      );
  }
  else if (b.ingredients?.trim())
    parts.push(
      `INGREDIENTS SLIDE: the picture shows ONLY these ingredients of the brand's product, real and natural, close up and beautifully lit: ${b.ingredients.trim()}. No cup, glass, box, packaging, logo or brand item, and no other food or drink; nothing is written anywhere.`,
    );
  else
    parts.push(
      "NO PRODUCT PHOTO: no product photo is attached to this post, so no packaged product, box, tin, tray of sweets, label or brand item appears anywhere; nothing is invented to stand in for one, and no product name or word is written on anything.",
    );
  if (b.hasProduct && !extras.length) parts.push((b.styleKey || b.tileKey) && !b.refIsSource ? styledProductRule(n) : ONE_PRODUCT_RULE);
  if (b.hasProduct && extras.length)
    parts.push(
      `PRODUCTS: the ${extras.length + 1} attached products are the only products in the picture, each shown once, whole, undistorted and recognisable; no invented extra cups, bottles or packs.`,
    );
  parts.push(NO_TEXT_RULE);
  parts.push(FULL_FRAME_RULE);
  parts.push(
    "PHOTOGRAPHY: a very realistic high-end commercial product photograph, as shot by a professional food and product photographer on a full-frame camera with a macro-capable lens: the product is the sharp hero with true-to-life texture, crumbs, sheen and printing; real materials, natural depth of field, honest colour and contrast; never a 3D render, CGI, illustration or AI-smooth look. The light has one clear source and direction and every object casts a shadow consistent with it.",
  );
  parts.push(POST_SHADOW_RULE);
  parts.push(people.length ? ONLY_AMBASSADORS_RULE : NO_PEOPLE_RULE);
  if (people.length) parts.push(REAL_PEOPLE_RULE, SAFE_WORDING_RULE);
  if (people.length && b.hasProduct && sellsClothing([productText, ...extras.map((e) => e.note ?? "")]))
    parts.push(
      `DRESSED IN THE BRAND: ${people.length === 1 ? "the ambassador wears" : `the ${people.length} ambassadors each wear one of`} the attached product garment${extras.length ? "s" : ""}, exactly as photographed (print, colours, cut), with the printed side in view; nobody wears a plain tee or another garment in its place, and the attached products are never shown only held or laid aside while a person wears something else. THE PRINT IS COPIED, NEVER REDESIGNED: the graphic on the garment is the one in its photo, with the same motif, the same colours (a red stays red, an orange stays orange), the same size and the same place on the body; no new flowers, no extra motifs, no recolouring, and a flat printed graphic stays flat (never turned into embroidery or stitching). ${people.length > extras.length + 1 ? `There are more people than garments: the ${extras.length + 1 === 1 ? "one garment" : `${extras.length + 1} garments`} go to ${extras.length + 1 === 1 ? "one ambassador" : "the first ambassadors"} and the other${people.length - extras.length - 1 > 1 ? "s" : ""} wear plain unprinted clothes in the month's colours.` : ""}`,
    );
  if (people.some((p) => CHILD_WORDS.test(p.description)))
    parts.push(
      "CHILDREN: the child looks like a real photographed child, never a doll or a render: real child skin with its natural unevenness and a faint flush, slightly messy real hair, a genuine expression caught mid-play or mid-laugh, natural child proportions, real small hands with five fingers each resting naturally. Any garment worn with the product is plain and unprinted.",
    );
  if (b.lessons?.length)
    parts.push(`MISTAKES SEEN IN EARLIER PICTURES FOR THIS CLIENT (the review rejected them; never repeat any of them):\n${b.lessons.map((l) => `- ${l}`).join("\n")}`);
  parts.push(NO_DESIGN_RULE);
  if (edit.trim() && !fresh) parts.push(`REVISION: ${edit.trim()}`);
  if (b.exact && !images.revision)
    parts.push("FINAL CHECK: no product, box, tin, package, tray, plate of sweets or food anywhere in the picture; the lower middle is empty surface.");
  const avoid = b.styleKey ? AVOID.replace("duplicated products, ", "") : AVOID;
  parts.push(b.ingredients?.trim() || b.campaign?.ingredients?.trim() ? avoid.replace("other food or drinks, ", "") : avoid);
  return parts.join("\n\n");
}

/** Month label for file names and headings: "2026-11" -> "November 2026". */
export function monthLabel(month: string, locale = "en-GB"): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}

export function currentMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** `habibah_2026-11_post03.jpg` */
export function postFileName(clientSlug: string, month: string, index: number, ext: string): string {
  return `${clientSlug}_${month}_post${String(index).padStart(2, "0")}.${ext}`;
}

/** The captions sheet that ships beside the images. Excel-friendly: UTF-8 BOM, CRLF, quoted cells. */
export function captionsCsv(
  rows: { index: number; type: string; title: string; file: string; caption: string; hashtags: string }[],
): string {
  const q = (s: string) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["post", "type", "title", "file", "caption", "hashtags"].map(q).join(","),
    ...rows.map((r) =>
      [String(r.index), r.type, r.title, r.file, r.caption, r.hashtags].map(q).join(","),
    ),
  ];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** JSON schema for the ideas call (Google structured output; OpenAI gets the same shape in text). */
export const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...POST_TYPES] },
          title: { type: "string" },
          brief: { type: "string" },
          caption: { type: "string" },
          hashtags: { type: "string" },
          product: { type: "string" },
          products: { type: "array", items: { type: "string" } },
          headline: { type: "string" },
          subline: { type: "string" },
          shot: { type: "integer" },
          people: { type: "array", items: { type: "string" } },
          date: { type: "string" },
          occasion: { type: "string" },
        },
        required: ["type", "title", "brief", "caption", "hashtags", "product", "products", "headline", "subline", "shot", "people", "date", "occasion"],
      },
    },
  },
  required: ["posts"],
};

export interface IdeasRequest {
  clientName: string;
  tone: string;
  /** The client's profile from its Analysis (voice, audience, what works, rules for headlines and captions). */
  profile?: string;
  /** The client has photos of its own shop: a grid's place tiles can be shot there. */
  hasPlaces?: boolean;
  /** The client's own spaces it has photos of ("its shop (4 photos), its kitchen or factory (12 photos)"). */
  places?: string;
  dos: string;
  donts: string;
  language: "ar" | "en" | "both";
  palette: string[];
  style: string;
  themeTitle: string;
  themeDirection: string;
  /** The theme's visual language written from its references (scenes, light, people...). */
  themeLibrary?: string;
  /** Props the designer wants in the scenes this month. */
  props?: string;
  /** The client's overlay shows no second line: every subline stays "". */
  noSubline?: boolean;
  /** The theme's chosen colours; they replace every colour the references and shots name. */
  monthPalette?: string[];
  /** The month's brand ambassadors: the only people the posts may show. */
  ambassadors?: { name: string; description: string }[];
  /** Mistakes the review found in this client's earlier pictures: no idea leads to them again. */
  lessons?: string[];
  /** One shot per reference picture, written by Analyse theme; the month is planned over them. */
  shots?: string[];
  products: string[];
  /** What each product photo shows, by product name (read by vision at upload). */
  productNotes?: Record<string, string>;
  month: string;
  count: number;
  /** Extra wishes typed by the designer for this month. */
  notes?: string;
  /** Post types to prefer, when the designer limited them. */
  types?: PostType[];
  /** The occasions the designer picked for this month: each gets one greeting post. */
  occasions?: { id: string; date: string; name: string; elements: string; portrait?: boolean }[];
  /** The creative brief agreed step by step in the journey: one logic line per step. */
  brief?: string[];
  /** A client with no products: the service it offers. */
  service?: string;
}

/** A service brand has nothing to hold: the posts show the moments its service is about. */
function serviceBlock(r: IdeasRequest): string {
  return `SERVICE BRAND (no products): ${r.clientName} offers ${r.service?.trim()}. Every post shows a moment this service is about, in the theme's world: what people protect, plan or enjoy because of it (for insurance: a family car on the road, the keys of a new home, a trip starting). Objects in the pictures belong to that moment (car keys, a phone, a folder, a suitcase); never a drink, a glass or food in the hands. Headlines and captions carry the service's promise in the client's tone. Set product to "" and products to [] for every post.`;
}

/** When the posts go out: dates inside the month, occasions on their own day. */
function datesBlock(r: IdeasRequest): string {
  if (!/^\d{4}-\d{2}$/.test(r.month)) return "";
  return [
    `POSTING DATES: give every post a date (field "date", YYYY-MM-DD) inside ${monthLabel(r.month)}, in posting order, spread across the month (no two posts on the same day unless there are more posts than days).`,
    r.occasions?.length
      ? `OCCASIONS THE DESIGNER PICKED (each gets exactly ONE post of type "greeting", dated on its day, with the occasion's id in the field "occasion"; no other occasion is posted):\n${r.occasions
          .map(
            (o) =>
              `- ${o.date} ${o.name} (occasion "${o.id}"): build it from ${o.elements}.${o.portrait ? " ROYAL DAY: no product and no person in the picture; an empty, dignified framed space in the upper middle is left for the official portrait added later; the headline and caption are a respectful greeting." : " The client's product may sit in the scene when it fits the moment; the headline is the greeting in the client's tone."}`,
          )
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The brief the designer confirmed screen by screen; it steers every idea. */
function briefBlock(r: IdeasRequest): string {
  return r.brief?.length
    ? `CREATIVE BRIEF (analysed and confirmed with the designer step by step; follow it):\n${r.brief.map((l) => `- ${l}`).join("\n")}`
    : "";
}

/** Who may appear in the briefs: the month's ambassadors only, or nobody. */
function peopleRule(r: IdeasRequest): string {
  return r.ambassadors?.length
    ? "PEOPLE: the cast ambassadors above are the only people any brief may show, and only in posts whose \"people\" lists them; never add friends, groups, staff, models or passers-by, even when the references show them. Every other post shows no person at all (a hand holding the product is the most it may show)."
    : "PEOPLE: no brief shows a person, model, face, group or crowd, even when the references show them; the posts are product photography. A hand holding or placing the product is the most a brief may show, and \"people\" is always [].";
}

/** The products are the only food: nothing is invented around them or added onto them. */
const PRODUCT_ONLY_IDEAS =
  "PRODUCTS ONLY: the client's products are the only food or drink in any brief. Never write other dishes, drinks, juices, coffee, tea, glasses of liquid, fruit or ingredients into a scene, even when the references show them: where a reference has a drink or fruit, use a non-food prop in the month's colours instead. In briefs, refer to a product as \"the product\" (or by what it looks like), never by its file name or number. Show each product at its real size, held level with both hands or set on a surface; never put a product into a bag, a basket or another container. Describe each product exactly as its photo note says and never add toppings, garnish, nuts, pine nuts, sauces, syrup or decorations to it. The posts must read as a very realistic product photoshoot of these exact products.";

/** A garment: worn in the picture, never handled like a box or a plate (same words as the style writer's). */
const CLOTHING_WORDS =
  /\b(sweatshirt|sweater|hoodie|t-?shirt|tee|shirt|blouse|top|dress|skirt|jeans|trousers|pants|shorts|leggings|jacket|coat|abaya|kaftan|thobe|jumpsuit|romper|onesie|pyjamas?|pajamas?|activewear|sportswear|tracksuit|socks|sneakers|shoes|boots|cap|beanie|scarf|outfit|garment|clothing|clothes|wear)\b/i;
export function sellsClothing(notes: string[]): boolean {
  return notes.some((n) => CLOTHING_WORDS.test(n));
}

/** A clothing brand's people wear its products: nobody stands there in a plain tee from nowhere. */
export const DRESSED_RULE =
  "A CLOTHING BRAND: every person in a picture wears one of the month's products (one garment per person, each named in the product fields); a person for whom no product is in the post does not appear, so a post never shows more people than garments to wear. The rest of the outfit is plain and unprinted.";

/** The month's ambassadors as an instruction block for the ideas writer (empty when none). */
function ambassadorsBlock(r: IdeasRequest): string {
  if (!r.ambassadors?.length) return "";
  return `${sellsClothing(Object.values(r.productNotes ?? {})) ? `${DRESSED_RULE} ` : ""}BRAND AMBASSADORS THIS MONTH (the brand's recurring people; their portraits keep the same faces in every post): ${r.ambassadors.map((a) => `${a.name}${a.description ? ` (${a.description})` : ""}`).join("; ")}. Whenever a post shows a person, cast one or more of these ambassadors by name in the field "people" (1-3 names, exact spelling) and name them in the brief with what they do; they are the only people who appear. Cast by fit: a shot whose person is a woman gets a woman ambassador and a man's gets a man; when no cast ambassador fits, rewrite the person and their clothes to fit the ambassador (a man never wears a headscarf, a hijab or a dress) or show hands only. Spread them across the month so each appears, and leave "people" empty for product-only posts. The client's ALWAYS and NEVER rules still apply.`;
}

/** What language the caption, headline and subline are written in. */
export function languageRule(language: "ar" | "en" | "both"): string {
  if (language === "ar")
    return "Arabic ONLY for the caption, the headline and the subline: Modern Standard Arabic unless the tone of voice asks for a dialect. No English words or sentences in them, apart from a brand or product name written as the brand writes it. The title field (internal) may be English.";
  if (language === "en")
    return "English ONLY for the caption, the headline and the subline, sentence case; no Arabic apart from a brand name written as the brand writes it.";
  return "Bilingual: the caption gives the Arabic text first, then the English version after a blank line; the headline and subline are Arabic, with the English headline after a slash when it fits.";
}

/** The instruction for the text model that plans a month of posts. */
export function ideasInstruction(r: IdeasRequest): string {
  const lang = languageRule(r.language);
  const types = (r.types?.length ? r.types : [...POST_TYPES])
    .map((t) => `${t}: ${POST_TYPE_INFO[t].description}`)
    .join("\n");
  return [
    `You are the social-media creative lead of a design agency planning ${r.count} Instagram posts for the client "${r.clientName}" for ${monthLabel(r.month)}. The posts are produced as single images (no text inside the image; headlines are added later as an overlay), each with a caption.`,
    `CLIENT TONE OF VOICE: ${r.tone || "friendly, clear, professional"}.`,
    `LANGUAGE (this setting wins over anything the tone of voice says about languages): ${lang}`,
    r.profile ? `CLIENT PROFILE (the Analysis of their Instagram and website; write for this audience, in this voice, by these rules for headlines and captions; other brands are never copied):\n${r.profile}` : "",
    r.dos ? `ALWAYS: ${r.dos}` : "",
    r.donts ? `NEVER: ${r.donts}` : "",
    r.lessons?.length ? `MISTAKES SEEN IN THIS CLIENT'S EARLIER PICTURES (the review rejected them; write nothing that leads to them again):\n${r.lessons.map((l) => `- ${l}`).join("\n")}` : "",
    r.monthPalette?.length
      ? `COLOURS THIS MONTH (chosen by the designer; they win over everything else): ${r.monthPalette.join(", ")}. The background of every brief (wall, backdrop, main surface) is ${r.monthPalette[0]}; the other colours go to ${r.props?.trim() ? "props, fabrics and accents" : "surfaces, light and the people's clothes"}. Every colour a brief names comes from this list: a car, a cloth, a wall or a cup in the brief is described in one of these colours, never in a colour of the reference (no red car or crimson velvet unless red is in this list).${r.palette.length ? ` Brand colours for small accents only: ${r.palette.join(", ")}.` : ""}`
      : r.palette.length
        ? `BRAND PALETTE: ${r.palette.join(", ")}.`
        : "",
    r.style ? `VISUAL IDENTITY (from the client's past posts): ${r.style}` : "",
    r.themeTitle || r.themeDirection
      ? `THIS MONTH'S THEME "${r.themeTitle}": ${r.themeDirection}`
      : "",
    r.themeLibrary?.trim()
      ? `VISUAL LANGUAGE OF THE THEME'S REFERENCES (the posts live in this world):\n${r.themeLibrary.trim()}`
      : "",
    r.shots?.length
      ? `SHOTS FROM THE REFERENCES (one per reference picture, numbered): the month is planned over these shots. With ${r.count} posts and ${r.shots.length} shots: when there are more shots than posts, pick the ${r.count} most varied shots and leave the rest out; when there are more posts than shots, reuse shots with a different product and a changed arrangement so no two posts look the same. Each post's brief recreates its shot with the client's product and names the shot number in the field "shot". A shot shows the place, camera and gesture, not what to hold: where the reference holds a drink, a cup carrier, a sandwich or anything this client does not sell, rewrite the moment around how THIS product is really held or served (a box or tin held level with both hands or set on a table, a tray on a table, one piece lifted by hand); never put a product in a bag, a basket or another container. Never put the product into a cup, carrier, glass or wrapper made for the reference's item.\n${r.shots.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
      : "",
    briefBlock(r),
    datesBlock(r),
    ambassadorsBlock(r),
    peopleRule(r),
    r.products.length ? PRODUCT_ONLY_IDEAS : "",
    r.products.length
      ? `PRODUCTS AVAILABLE AS PHOTOS (use the exact names in the product fields). COVERAGE: no product appears a second time before every product has appeared once; a picture that shows several products together counts for each of them, so group products into one post wherever the shot or the idea shows several items (a row of cups, a pair of drinks, a tray). When there are still more products than the posts can carry, leave some out rather than adding posts. The description after each name is what its photo actually shows: the post's title, headline, subline, brief and caption are about THOSE items and never name or describe a different product. NOTHING IS ADDED TO A PRODUCT: no biscuit, cookie, fruit, sauce, syrup, drizzle, sprinkles, cream or topping its description does not name, nothing dipped into it or poured over it, and no other food or pastry beside it; its colours stay its own. A GARMENT'S PRINT SITS WHERE ITS DESCRIPTION SAYS, and nowhere else: when the description puts the graphic on the back, the person is seen from behind so it shows; when it is on the chest, the person faces the camera; when the description does not say, the brief never names a side and never writes "on the back" or "on the front". A client rule about showing the backs of sweatshirts applies only to garments whose description puts the graphic on the back:
${r.products.map((n) => `- ${n}${r.productNotes?.[n] ? `: ${r.productNotes[n]}` : ""}`).join("\n")}`
      : r.service?.trim()
        ? serviceBlock(r)
        : "No product photos were uploaded: set product to an empty string for every post.",
    r.props?.trim() ? `PROPS TO USE: ${r.props.trim()}. Work them into the scenes naturally (not every post needs all of them) and mention them in the briefs.` : NO_PROPS_RULE,
    r.notes
      ? `COPY BRIEF FROM THE DESIGNER (what the words must say this month: headlines, second lines, captions, tone, offers, phrases to use or avoid, language; it wins over every default above): ${r.notes}`
      : "",
    r.types?.length
      ? `POST TYPES (field "type", only these, mixed across the month):\n${types}`
      : `POST TYPES (field "type"): every post is "lifestyle": ${r.products.length ? "the client's product living in a real moment of the theme's world (held, served, carried, on a table), the product clearly visible" : "a real moment of the theme's world that the client's offer is about"}. The only exceptions are the picked occasions (type "greeting"). Never write "offer" posts: offers are set by the designer with their products and price. Never write a "quote" or "tip" post unless the designer's notes ask for one.`,
    "POSES: every post with a person gets its own pose and action, named concretely in the brief (walking, a lunge, a stretch, sitting, mid-jump, seen from behind, tying a shoe, leaning on a wall…); never the same standing-facing-the-camera pose twice in the month, and never two posts in a row with the same body position.",
    `For each post write: title (3-6 words, internal), brief (3-5 sentences describing ONE photograph for the image engine: the place, the subject, what happens, where the product is and what it does, the light and the mood; concrete and visual, no slogans, no text in the picture, catalogue-safe wording), headline (the words drawn over the image later: a 2-4 word hook in the caption language, in the client's tone, that names the product or a concrete benefit or moment; never filler that could sit on any brand's post, and never the same opening twice in the month), ${r.noSubline ? 'subline (always "": this client\'s posts carry the headline alone, so the headline must say everything on its own)' : 'subline (the second line under the headline: the promise, offer or product name, at most 8 words, or "")'}, caption (${lang} SHORT: at most 10 words in all, one or two short lines, warm and to the point, no hashtags inside, ending with one clear call to action: order, visit, try, tag someone), hashtags (8-12, space separated, starting with #), product (the lead product: one of the product names exactly, or ""), products (every product shown in the picture, lead first, exact names: a shot of several drinks in a row or two cups side by side lists 2-4 products; a single-product picture lists just the lead; [] when none), shot (the number of the reference shot the post follows, or 0 when the theme has no shots), people (names of the brand ambassadors in the picture, or []), date (the posting day, YYYY-MM-DD), occasion (the picked occasion's id for a greeting post, otherwise "").`,
    `Return ONLY JSON: {"posts": [...]} with exactly ${r.count} posts in posting order.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Turn the model's answer into posts, dropping anything malformed. */
/** Loose key for product names: case, extension, underscores, punctuation and spacing do not count. */
/** File names saved from websites carry HTML entities ("Burma &#038; Ush"); read them as text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

export function productKeyOf(name: string): string {
  return decodeEntities(name)
    .normalize("NFC")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .toLowerCase()
    .replace(/[_\-.,'"()&\u0640]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The uploaded product a name refers to, written as the model or a person wrote it: exact
 * loose match first, then the longest product name contained in (or containing) the text.
 */
export function matchProduct(name: string | undefined | null, products: string[]): string | undefined {
  const key = productKeyOf(name ?? "");
  if (!key) return undefined;
  const exact = products.find((p) => productKeyOf(p) === key);
  if (exact) return exact;
  const partial = products
    .map((p) => ({ p, k: productKeyOf(p) }))
    .filter(({ k }) => k.length >= 3 && (key.includes(k) || (k.length >= 5 && k.includes(key))))
    .sort((a, b) => b.k.length - a.k.length)[0];
  if (partial) return partial.p;
  // Last chance: most of the product's words appear in the text ("Pistachio Burma tin").
  const words = new Set(key.split(" ").filter((w) => w.length >= 3));
  const scored = products
    .map((p) => {
      const pw = [...new Set(productKeyOf(p).split(" ").filter((w) => w.length >= 3 && !/^\d+$/.test(w)))];
      const hits = pw.filter((w) => words.has(w)).length;
      return { p, hits, share: pw.length ? hits / pw.length : 0 };
    })
    .filter((x) => x.hits >= 2 && x.share >= 0.5)
    .sort((a, b) => b.share - a.share || b.hits - a.hits);
  return scored[0]?.p;
}

/** Captions are short: at most 10 words, cut at a sentence end when one fits. */
export const CAPTION_WORDS = 10;
export function shortCaption(text: string, max = CAPTION_WORDS): string {
  const t = text.replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (words.length <= max) return t;
  let out = "";
  for (const sentence of t.split(/(?<=[.!?؟。])\s+/)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.split(" ").length > max) break;
    out = next;
  }
  return out || `${words.slice(0, max).join(" ")}…`;
}

/* ───────────── The caption, written from the finished picture ───────────── */

export const CAPTION_SCHEMA = {
  type: "object",
  properties: { caption: { type: "string" }, hashtags: { type: "string" } },
  required: ["caption", "hashtags"],
};

export interface CaptionRequest {
  clientName: string;
  tone: string;
  language: "ar" | "en" | "both";
  dos?: string;
  donts?: string;
  post: Post;
  /** The client's profile from its Analysis: its voice and its rules for captions. */
  profile?: string;
  /** The greeting's occasion: its name and day. */
  occasion?: { name: string; date: string };
  /** The post's products with what their photos show. */
  products: { name: string; note?: string }[];
}

/** The caption follows the picture: what it really shows, in the client's voice, around the headline. */
export function captionFromImageInstruction(r: CaptionRequest): string {
  const p = r.post;
  const info = POST_TYPE_INFO[p.type];
  return [
    `You are the social-media copywriter of a design agency. The attached image is the finished photograph of one Instagram post for "${r.clientName}". Write its caption from what the picture really shows: the moment, the place, the light and the mood, what the people do and how the product appears. Never mention anything the picture does not show.`,
    `CLIENT TONE OF VOICE: ${r.tone || "friendly, clear, professional"}.`,
    `LANGUAGE (this setting wins over anything the tone of voice says about languages): ${languageRule(r.language)}`,
    r.profile ? `CLIENT PROFILE (their audience, their voice at its best and the rules for their captions):\n${r.profile}` : "",
    r.dos ? `ALWAYS: ${r.dos}` : "",
    r.donts ? `NEVER: ${r.donts}` : "",
    `THE POST: ${info?.label ?? p.type} (${info?.description ?? ""}).`,
    p.headline ? `HEADLINE ON THE IMAGE: "${p.headline}"${p.subline ? ` / "${p.subline}"` : ""}. The caption adds to it and never repeats it word for word.` : "",
    r.occasion ? `OCCASION: ${r.occasion.name} on ${r.occasion.date}; the caption greets the day in the client's tone.` : "",
    p.date ? `POSTED ON ${p.date}: the words and hashtags fit that season and month, never another season.` : "",
    p.offer ? `OFFER, exactly as the designer set it: products ${p.offer.products.join(", ")}; price ${p.offer.price}; ${p.offer.details}. State it as given, never anything else.` : "",
    r.products.length ? `THE PRODUCT${r.products.length > 1 ? "S" : ""}: ${r.products.map((x) => `${x.name}${x.note ? ` (${x.note})` : ""}`).join("; ")}.` : "",
    p.people?.length ? `The people in the picture are the brand's ambassadors; never write their names.` : "",
    p.caption.trim() ? `THE IDEA'S FIRST DRAFT (keep its intent, make it fit the picture): "${p.caption.trim()}"` : "",
    `Write: caption (SHORT: at most ${CAPTION_WORDS} words in all, one or two short lines, warm and to the point, no hashtags inside; it names the product and ENDS WITH ONE CLEAR CALL TO ACTION in the client's tone: order, visit, try, tag someone, save it; never a price or claim the post does not give) and hashtags (8-12, space separated, each starting with #, about the brand and this moment).`,
    "SPELLING: correct Arabic, hamza and ta marbuta right (آخر not أخر, حلوة not حلوه), no Latin letters inside Arabic words, no doubled letters for stretch unless the tone asks for it.",
    `Return ONLY JSON: {"caption": "...", "hashtags": "..."}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseCaption(text: string): { caption: string; hashtags: string } | null {
  let d: { caption?: unknown; hashtags?: unknown } = {};
  try {
    d = JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as typeof d;
  } catch {
    return null;
  }
  const caption = shortCaption(String(d.caption ?? "").replace(/#\S+/g, "").trim());
  if (!caption) return null;
  const tags = [...new Set(String(d.hashtags ?? "").split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : `#${t}`)))];
  return { caption, hashtags: tags.slice(0, 12).join(" ") };
}

export function parseIdeas(
  text: string,
  count: number,
  products: string[],
  ambassadors: string[] = [],
): Post[] {
  const byName = new Map(ambassadors.map((n) => [n.trim().toLowerCase(), n]));
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let d: { posts?: unknown } = {};
  try {
    d = JSON.parse(cleaned) as { posts?: unknown };
  } catch {
    return [];
  }
  const list = Array.isArray(d.posts) ? d.posts : [];
  const out: Post[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    // Offers come from the designer (products and price), never from the writer.
    const written = (POST_TYPES as readonly string[]).includes(String(raw.type))
      ? (String(raw.type) as PostType)
      : "lifestyle";
    const type: PostType = written === "offer" ? "lifestyle" : written;
    const brief = String(raw.brief ?? "").trim();
    if (!brief) continue;
    const title = String(raw.title ?? "").trim();
    // The product field first; a product named in the title stands in when the field is empty.
    const lead =
      matchProduct(String(raw.product ?? ""), products) ??
      matchProduct(title, products) ??
      (String(raw.product ?? "").trim() ? matchProduct(brief, products) : undefined);
    const listed = Array.isArray(raw.products)
      ? (raw.products as unknown[]).map((x) => matchProduct(String(x ?? ""), products))
      : [];
    const all = [...new Set([lead, ...listed].filter((x): x is string => !!x))];
    const product = all[0];
    const extra = all.slice(1, 4);
    out.push({
      index: out.length + 1,
      type,
      title: title.slice(0, 80) || `Post ${out.length + 1}`,
      brief: brief.slice(0, 2000),
      caption: shortCaption(String(raw.caption ?? "")),
      hashtags: String(raw.hashtags ?? "").trim().slice(0, 400),
      product: product || undefined,
      products: extra.length ? extra : undefined,
      headline: String(raw.headline ?? "").trim().slice(0, 80) || undefined,
      subline: String(raw.subline ?? "").trim().slice(0, 120) || undefined,
      shot: Number.isInteger(raw.shot) && Number(raw.shot) > 0 ? Number(raw.shot) : undefined,
      people: (() => {
        const list = Array.isArray(raw.people)
          ? [...new Set((raw.people as unknown[]).map((x) => byName.get(String(x ?? "").trim().toLowerCase())))]
          : [];
        const named = list.filter((x): x is string => !!x).slice(0, 3);
        return named.length ? named : undefined;
      })(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? "").trim()) ? String(raw.date).trim() : undefined,
      occasion: type === "greeting" && String(raw.occasion ?? "").trim() ? String(raw.occasion).trim().slice(0, 80) : undefined,
    });
    if (out.length >= count) break;
  }
  return out;
}

/** What one tile of a reference grid shows, so the month's post takes the same role in the feed. */
export const TILE_KINDS = ["product", "drink", "food", "place", "person", "text", "texture", "detail"] as const;
export type TileKind = (typeof TILE_KINDS)[number];

/** How a tile's words sit on it: the overlay of the month's post follows it. */
export interface TileText {
  position: "top" | "center" | "bottom" | "none";
  align: "left" | "center" | "right";
  size: "small" | "medium" | "large" | "huge";
  /** The words' colour as #rrggbb ("" when unclear). */
  color: string;
  /** Lettering: serif, sans, script, handwritten, condensed, display… */
  style: string;
}

export interface TileSpec {
  kind: TileKind;
  /** The objects and props on the tile (never the reference's products or brand). */
  items: string;
  /** Its background: colour words with #rrggbb when it is a plain colour, or the texture. */
  background: string;
  text: TileText;
}

/** The grid's lettering matched to the fonts the overlay can use. */
export interface GridFonts {
  headline: string;
  body: string;
  why: string;
}

/** A textured background (paper, marble…) is painted by the engine; a plain one is drawn exactly. */
export const TEXTURED_BACKGROUND = /textur|paper|marble|fabric|linen|concrete|stone|wood|gradient|grain|terrazzo|plaster|cloth|velvet|photo/i;

/** The first #rrggbb in a description, else the fallback. */
export function hexIn(text: string | undefined, fallback: string): string {
  return /#[0-9a-f]{6}\b/i.exec(text ?? "")?.[0] ?? fallback;
}

/** The post's text laid out like its tile: position, alignment, size and colour (the designer can still move it). */
export function overlayFromTile(t: TileText, kind: TileKind): { overlay?: false; ov?: PostOverlayPatch } {
  if (t.position === "none" && kind !== "text") return { overlay: false };
  const scale = { small: 0.8, medium: 1, large: 1.35, huge: 1.8 }[t.size] ?? 1;
  return {
    ov: {
      position: t.position === "none" ? "center" : t.position,
      align: t.align,
      scale: kind === "text" ? Math.max(scale, 1.35) : scale,
      // The tile's text colour is not copied: the text is white for every client unless changed by hand.
      // A grid's tiles carry their words without a dark fade behind them.
      fade: false,
    },
  };
}

/** Grid mode: one reference image shows a whole feed; the model reads it tile by tile and plans the month. */
export const GRID_SCHEMA = {
  type: "object",
  properties: {
    world: { type: "string" },
    tiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          position: { type: "string" },
          scene: { type: "string" },
          productPlacement: { type: "string" },
          textPlacement: { type: "string" },
          kind: { type: "string", enum: [...TILE_KINDS] },
          items: { type: "string" },
          background: { type: "string" },
          text: {
            type: "object",
            properties: {
              position: { type: "string", enum: ["top", "center", "bottom", "none"] },
              align: { type: "string", enum: ["left", "center", "right"] },
              size: { type: "string", enum: ["small", "medium", "large", "huge"] },
              color: { type: "string" },
              style: { type: "string" },
            },
            required: ["position", "align", "size", "color", "style"],
          },
        },
        required: ["position", "scene", "productPlacement", "textPlacement", "kind", "items", "background", "text"],
      },
    },
    fonts: {
      type: "object",
      properties: { headline: { type: "string" }, body: { type: "string" }, why: { type: "string" } },
      required: ["headline", "body", "why"],
    },
    posts: IDEAS_SCHEMA.properties.posts,
  },
  required: ["world", "tiles", "fonts", "posts"],
};

export function gridIdeasInstruction(r: IdeasRequest): string {
  const lang = languageRule(r.language);
  return [
    `The attached image is a reference social-media feed grid (several post tiles in one picture). You are the creative lead of a design agency: read it tile by tile, then plan ${r.count} posts for the client "${r.clientName}" for ${monthLabel(r.month)} that recreate the SAME world and rhythm with the client's own products and identity. The posts are produced as single images by an image engine (no text inside the image) and get a headline overlay and a caption.`,
    "First describe the grid: world (one paragraph: the sets, materials, surfaces, props, palette with colour words, light, camera angles, mood, how products are staged and where text sits) and tiles (one entry per tile in reading order: position like 'row 1, col 2'; scene; productPlacement; textPlacement). Ignore the reference's brand, products, logos and words: only the staging matters.",
    `For each tile also give: kind (${TILE_KINDS.join(", ")}: "text" is a tile that is mostly words on a plain or textured background, "place" shows a shop, café, kitchen or interior, "drink" a beverage, "food" a dish or dessert, "product" a packaged item, "person" a person, "texture" a close-up surface, "detail" a close-up of an ingredient or object); items (the objects and props on it, as words); background (its colour words with #rrggbb when it is plain, or the texture: "cream paper #f3ece0", "white marble"); text (how its words sit: position top, center, bottom or none; align; size small, medium, large or huge; color #rrggbb; style: the lettering such as bold serif, thin sans, script, handwritten, condensed, display).`,
    `fonts: the closest overlay fonts to the grid's lettering, from these only. Headline: ${HEADLINE_FONTS.map((f) => `${f.family} (${f.style})`).join(", ")}, ${LATIN_FONTS.map((f) => `${f.family} (${f.style})`).join(", ")}. Body: ${BODY_FONTS.map((f) => `${f.family} (${f.style})`).join(", ")}. why: one sentence on the match.`,
    `CLIENT TONE OF VOICE: ${r.tone || "friendly, clear, professional"}.`,
    `LANGUAGE (this setting wins over anything the tone of voice says about languages): ${lang}`,
    r.profile ? `CLIENT PROFILE (the Analysis of their Instagram and website; write for this audience, in this voice, by these rules for headlines and captions; other brands are never copied):\n${r.profile}` : "",
    r.dos ? `ALWAYS: ${r.dos}` : "",
    r.donts ? `NEVER: ${r.donts}` : "",
    r.monthPalette?.length
      ? `COLOURS THIS MONTH (chosen by the designer; the posts use these for sets, surfaces and props instead of the grid's colours): ${r.monthPalette.join(", ")}.`
      : r.palette.length
      ? `BRAND PALETTE (the posts use these colours for sets and props instead of the reference's palette): ${r.palette.join(", ")}.`
      : "",
    r.style ? `VISUAL IDENTITY: ${r.style}` : "",
    r.themeDirection ? `THEME DIRECTION: ${r.themeDirection}` : "",
    r.products.length
      ? `PRODUCTS AVAILABLE AS PHOTOS (use the exact names in the product field; spread the posts over different products, and when there are more products than posts leave some products out rather than adding posts). The description after each name is what its photo actually shows: each post's title, headline, subline, brief and caption are about THAT item, never another product:\n${r.products.map((n) => `- ${n}${r.productNotes?.[n] ? `: ${r.productNotes[n]}` : ""}`).join("\n")}`
      : "No product photos were uploaded: set product to \"\" for every post and stage the client's kind of product generically.",
    r.props?.trim() ? `PROPS TO USE: ${r.props.trim()}. Work them into the tiles' staging naturally and mention them in the briefs.` : NO_PROPS_RULE,
    ambassadorsBlock(r),
    peopleRule(r),
    PRODUCT_ONLY_IDEAS,
    r.notes ? `COPY BRIEF FROM THE DESIGNER (what the words must say: headlines, captions, tone, offers, phrases to use or avoid; it wins over the defaults): ${r.notes}` : "",
    `MATCH EACH TILE: a post takes its tile's role. A drink tile shows one of the client's drinks, a food tile one of its dishes or sweets, a product tile a packaged product (a box, tin or bottle), ${r.hasPlaces === false ? "a place tile becomes a food or product tile (the client has no photos of its shop: never an interior, a shop, a counter, a shelf or a wall with signs or patterns; a close-up of a product on the tile's surfaces and in its light instead)" : `a place tile the client's own ${r.places ? `spaces, from its photos: ${r.places} (a post on the making, the craft or behind the scenes is set in its kitchen or factory)` : "shop or café"}`}, a person tile a brand ambassador with the product, a detail or texture tile a close-up of the product's own ingredients or surface${r.ambassadors?.length && sellsClothing(Object.values(r.productNotes ?? {})) ? " (for this clothing brand: a close-up of the garment WORN by an ambassador named in \"people\", the waist, hip, sleeve or print on the body, never a garment laid flat)" : ""}, and a text tile is a typographic post (type quote, tip or announcement: its headline carries the message and the picture is only the tile's background). Pick the product whose photo note fits the tile's kind; reproduce the tile's items as non-food props in the month's colours.`,
    "POSES: every post with a person gets its own pose and action, named concretely in the brief (walking across the frame, a deep lunge, a floor stretch, sitting cross-legged, mid-jump, seen from behind, tying a shoe, adjusting the waistband, a side plank, leaning on a wall, hands on hips looking away…); never the same standing-facing-the-camera pose twice in the month, and never two posts in a row with the same body position.",
    `Then write the ${r.count} posts in posting order, cycling through the tiles so the feed keeps the reference's rhythm (tile 1 staging for post 1, tile 2 for post 2, and so on, varying props so no two posts are identical). For each post: type (one of ${POST_TYPES.join(", ")}), title (3-6 words, internal; start it with the tile it follows, e.g. "T3 ·"), brief (4-6 sentences describing ONE photograph for the image engine: the set and its materials in the brand palette, the props, the camera angle, where the product sits and what it does, the light, the mood, and which area stays calm for the headline; concrete, visual, catalogue-safe wording, no text in the picture), headline (2-4 words that name the product or a concrete benefit or moment; never filler that fits any brand, never the same opening twice in the month), ${r.noSubline ? 'subline (always "")' : 'subline (at most 8 words or "")'}, caption (${lang} SHORT: at most 10 words in all; no hashtags inside; ends with one clear call to action), hashtags (8-12 with #), product (exact name or ""), people (names of the brand ambassadors in the picture, or []).`,
    `Return ONLY JSON: {"world": "...", "tiles": [...], "fonts": {...}, "posts": [...]} with exactly ${r.count} posts.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface GridRead {
  world: string;
  tiles: ({ position: string; scene: string; productPlacement: string; textPlacement: string } & Partial<TileSpec>)[];
  fonts?: GridFonts;
}

/** One tile's detailed read, cleaned (null when the model gave none). */
export function tileSpecOf(t: Partial<TileSpec> | undefined): TileSpec | undefined {
  if (!t || !t.kind || !(TILE_KINDS as readonly string[]).includes(t.kind)) return undefined;
  const x = (t.text ?? {}) as Partial<TileText>;
  const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => ((list as readonly unknown[]).includes(v) ? (v as T) : d);
  return {
    kind: t.kind,
    items: String(t.items ?? "").slice(0, 400),
    background: String(t.background ?? "").slice(0, 160),
    text: {
      position: pick(x.position, ["top", "center", "bottom", "none"] as const, "bottom"),
      align: pick(x.align, ["left", "center", "right"] as const, "center"),
      size: pick(x.size, ["small", "medium", "large", "huge"] as const, "medium"),
      color: /^#[0-9a-f]{6}$/i.test(String(x.color ?? "").trim()) ? String(x.color).trim() : "",
      style: String(x.style ?? "").slice(0, 80),
    },
  };
}

/** The grid description as one text for the prompts and the theme notes. */
export function gridNotes(g: GridRead): string {
  return [
    g.world.trim(),
    ...g.tiles.map(
      (t, i) =>
        `Tile ${i + 1} (${t.position}${t.kind ? `, ${t.kind}` : ""}): ${t.scene} Product: ${t.productPlacement} Text: ${t.textPlacement}${t.items ? ` Items: ${t.items}` : ""}${t.background ? ` Background: ${t.background}` : ""}`,
    ),
  ].join("\n");
}

/** JSON schema and instruction for "Analyse theme": the visual language of a theme's references. */
export const THEME_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    direction: { type: "string" },
    library: { type: "string" },
    shots: { type: "array", items: { type: "string" } },
    palette: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, hex: { type: "string" } },
        required: ["name", "hex"],
      },
    },
  },
  required: ["description", "direction", "library", "shots", "palette"],
};

export const PALETTE_SCHEMA = {
  type: "object",
  properties: {
    palette: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, hex: { type: "string" } },
        required: ["name", "hex"],
      },
    },
  },
  required: ["palette"],
};

const PALETTE_ASK =
  "palette: the 4-6 colours that carry the references' colour story (backgrounds, surfaces, props, light), most used first, each as a 6-digit hex like #f2a0b0 and a plain two-word English name like 'Dusty rose'; leave out the colours of products, logos and skin.";

/** Only the colour story of the references, for "Suggest colours". */
export function paletteInstruction(count: number): string {
  return `The ${count} attached images are the references of a social-media theme. Return ${PALETTE_ASK} Return ONLY JSON: {"palette": [{"name": "...", "hex": "#rrggbb"}]}.`;
}

/** The colour story of the feed grid the month follows, for "Suggest colours" in a grid month. */
export function gridPaletteInstruction(): string {
  return `The attached image is an Instagram feed grid the brand wants its month to look like (many posts side by side). Return ${PALETTE_ASK.replace("the references' colour story", "the grid's colour story: the tiles' backgrounds, the plain text tiles and the surfaces")} Return ONLY JSON: {"palette": [{"name": "...", "hex": "#rrggbb"}]}.`;
}

/** Parses a model palette: valid 6-digit hex only, no duplicates, at most 8. */
export function parsePalette(raw: unknown): { name: string; hex: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { name: string; hex: string }[] = [];
  for (const c of raw as { name?: unknown; hex?: unknown }[]) {
    const hex = String(c?.hex ?? "").trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ name: String(c?.name ?? "").trim().slice(0, 40), hex });
    if (out.length >= 8) break;
  }
  return out;
}

export function themeBuilderInstruction(title: string, count: number): string {
  return [
    `You are writing the visual direction of a social-media theme called "${title}" for a brand, from ${count} attached reference images (mood board, Pinterest pins, past posts). Generated posts will later borrow their place, light, palette, composition and mood from these references.`,
    "Study each image and extract ONLY: the kind of places and surfaces, the props and materials, the light (direction, quality, colour temperature), the colour palette and grade, the composition habits (distance, angle, negative space, symmetry), the photographic treatment (film, clean, flat lay, macro...), the mood, and the people: whether they appear, how many, how they are framed (hands only, half body, full body, face shown or turned away), what they do with the product, and their styling. Ignore and never mention brand names, logos, readable text, specific people's identities or specific products.",
    "A reference that is a collage or feed grid (several pictures in one image) counts as several pictures: treat every tile as its own picture everywhere below.",
    "Write three texts and one list in English:",
    "0. description: one sentence (max 160 characters) a designer reads under the theme's name.",
    "1. direction: 4-8 sentences that start with 'Goal: produce posts that ...', naming the world, the light signature, the palette, the composition habits and the mood, ending with 'No text, logos or prices are drawn inside the image.'",
    "2. library: Markdown with '## Scenes' (one numbered line per image describing its setting and props in one dense sentence), '## Light' (3-4 dash lines), '## Palette' (2-3 dash lines with colour words), '## Composition' (2-3 dash lines), '## People' (1-2 dash lines: how often people appear, how many, how they are framed and what they do; or 'none' when the references show no people), '## Mood' (1-2 dash lines) and '## Avoid' (one dash line of what would break this world).",
    "3. shots: one entry per picture (every tile of a collage counts), in reading order, each a ready brief for an image engine in 2-4 sentences: the set and its materials, the camera angle and distance, where the product sits and what happens to it (pouring, held, stacked...), the props, the light, and where calm space is left for a headline. Write 'the product' instead of the reference's product, never its brand or text; describe people by role, framing and action only. Name no colours in the shots (write 'a vintage car hood', 'a draped velvet cloth', not 'a red car hood'): the designer picks the month's colours separately. Describe what the hands or the person do in a way any boxed or plated product fits, and write 'the product' for whatever they hold or what sits on the table: never write glass, cup, mug, beverage, drink, carrier, straw, bottle, sandwich, snack, bar or any food the reference shows.",
    `4. ${PALETTE_ASK}`,
    "Return ONLY a JSON object with keys description, direction, library, shots and palette.",
  ].join("\n\n");
}

/** The style text of a client's identity, from its past posts. */
export function identityBuilderInstruction(name: string, count: number): string {
  return [
    `You are describing the visual identity of the brand "${name}" from ${count} attached images of its past social-media posts, so that new posts can be generated in the same identity.`,
    "Extract ONLY: photography style (real photo, flat lay, studio, lifestyle, illustration mix), light, colour palette and grade, composition habits, typical props and surfaces, how products are shown, whether people appear and how, and the overall mood. Ignore readable text, logos and specific people's identities.",
    "Leave out anything seasonal or one-off (autumn or falling leaves, snow, Christmas, Ramadan lanterns, Valentine hearts, a campaign's props): the identity is what stays true all year; each month's theme brings its own season.",
    "Write a single text 'style' of 6-10 sentences in English, concrete and usable as instructions for an image engine, plus 'description' (one sentence, max 160 characters).",
    "Return ONLY a JSON object with keys description and style.",
  ].join("\n\n");
}
export const IDENTITY_SCHEMA = {
  type: "object",
  properties: { description: { type: "string" }, style: { type: "string" } },
  required: ["description", "style"],
};

export const PRODUCT_NOTE_SCHEMA = {
  type: "object",
  properties: { note: { type: "string" } },
  required: ["note"],
} as const;

/** Reads one product photo: what the item is, in one line, for the ideas writer and the prompt. */
export function productNoteInstruction(name: string): string {
  return `The attached image is a product photo uploaded under the name "${name}". In one line (at most 30 words, English) say what the item is (for a garment: its type and cut, its colour, and its print or graphic with WHERE it sits: "on the chest", "on the back", "on the sleeve"; call a graphic "printed" unless raised stitches are clearly visible, and never "embroidered" for a flat print): the kind of product (drink, dessert, dish, package, device...), its colours, container or packaging, its approximate real-world size (for example "about 25 cm wide"), and any readable brand or flavour text on it. Describe the product itself only: not the surface, props, other food, pastries, people, logos or text around it in the photo. Describe only what is visible; no marketing words. Return ONLY JSON: {"note": "..."}.`;
}

/** One fresh idea for a single post of a month that is already planned. */
/** What a post of each type must be, so changing the type really changes the post. */
function typeBrief(post: Post): string {
  switch (post.type) {
    case "tip":
      return 'A TIP POST: the headline is a short, useful tip about the product or its moment (how to serve, keep, gift or pair it); the caption gives it in at most 10 words. The picture is calm and simple, with a large clean area for the text; the product, when there is one, is small and to the side.';
    case "quote":
      return "A QUOTE POST: the headline is a short line people would share (warm, in the client's tone, never a famous person's quote); the picture is a calm mood image with a large clean area for the words.";
    case "announcement":
      return "AN ANNOUNCEMENT: news (a launch, a branch, an event) written from the designer's notes; never invent prices or dates that were not given.";
    case "offer":
      return post.offer
        ? `AN OFFER POST, exactly as the designer set it: products ${post.offer.products.join(", ")}; price ${post.offer.price}; what it is: ${post.offer.details}. The picture shows exactly these products together as a clear commercial offer shot; field "product" is the first of them and "products" lists them all. The headline carries the offer hook and the subline the price as written (${post.offer.price}); the caption states the offer in at most 10 words, never anything the designer did not give.`
        : "";
    case "greeting":
      return 'A GREETING POST for its occasion: the headline is the greeting in the client\'s tone, the picture carries the occasion\'s elements in the theme\'s colours and light; keep the "occasion" field.';
    default:
      return "";
  }
}

export function singleIdeaInstruction(
  r: IdeasRequest,
  post: Post,
  others: string[],
  wish: string,
): string {
  const base = ideasInstruction({ ...r, count: 1 });
  return [
    base,
    `THIS IS A REPLACEMENT for post ${post.index} of a month already planned. Its type is "${post.type}" (${POST_TYPE_INFO[post.type]?.description ?? ""}) and it stays that type even if the rules above say otherwise${post.product && post.type !== "offer" ? `; keep its product (${post.product}, exact name in the product field)` : ""}. Write a NEW idea for it: a different scene, angle, action and headline from the one it replaces ("${post.title}": ${post.brief.slice(0, 300)}).`,
    typeBrief(post),
    others.length ? `It must not repeat these other posts of the month: ${others.join(" · ")}.` : "",
    wish.trim() ? `THE DESIGNER ASKS FOR: ${wish.trim()}` : "",
    'Return ONLY JSON: {"posts": [one post]}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Bags, carriers and shopping: a product is held or set down, never packed into something. */
export const BAGS = /\b(bags?|carriers?|baskets?|totes?|shopping)\b/i;

/** The text without its sentences that put something into a bag or a carrier. */
export function withoutBags(text: string): string {
  return text
    .split(/(?<=[.!?؟])\s+/)
    .filter((x) => !BAGS.test(x))
    .join(" ")
    .trim();
}

/** Things that carry words (a card, a price tag, a menu): the engine writes on them, so they stay out. */
export const LETTERED = /\bcards?\b|\bprice\s+tags?\b|\bmenus?\b/i;

/**
 * The text without the things that carry words: "next to a business card" goes, and a sentence
 * that still names a card, a price tag or a menu goes; so do sentences that place a logo or a brand
 * mark in the picture (logos are added later, by the designer).
 */
export function withoutLettering(text: string): string {
  return text
    .replace(/,?\s+(?:next to|beside|alongside|with|and|near|by)\s+(?:an?|the|some|two|three)?\s*(?:[\w#-]+\s+){0,6}?(?:cards?|price\s+tags?|menus?)\b/gi, "")
    .split(/(?<=[.!?\u061f])\s+/)
    .filter((x) => !/\b(logos?|watermarks?|monograms?|mark)\b/i.test(x) && !LETTERED.test(x))
    .join(" ")
    .trim();
}

/** A bag, carrier or tote however it is written ("a large brand shopping bag"). */
const BAG_PHRASE = /\b(?:an?\s+|the\s+)?(?:(?:large|small|big|paper|brand(?:ed)?|shopping|gift|tote)\s+)*(?:bags?|carriers?|totes?|baskets?)\b/gi;

/** A grid tile's words without its bag: the product takes the bag's place, or the bag goes. */
/** Words of a tile that cast people: a group tile shot with one ambassador is a portrait of that one. */
const TILE_PEOPLE =
  /\b(friends?|family|families|couples?|group|groups|crowd|crowds|kids|children|boys|girls|people|siblings|duo|trio|pair|team|two|three|four|several|many)\b/gi;
/**
 * A tile read from the grid may stage a group ("group portrait … Items: friends standing"); the
 * post shows only its own ambassadors, so the tile is reworded to their number before the engine
 * or the review reads it. With one person it becomes a single portrait; with none, nobody.
 */
export function tileForPeople(tile: string, people: number): string {
  if (!tile.trim()) return tile;
  if (people >= 2) return tile.replace(/\bgroup portrait\b/gi, `portrait of ${people} people`);
  const items = tile.replace(/(Items:\s*)([^]*?)(?=\s+(?:Background|Text):|$)/i, (_m, label: string, list: string) => {
    const kept = list
      .split(/,\s*/)
      .map((x) => x.trim())
      .filter((x) => x && !TILE_PEOPLE.test(x) && (TILE_PEOPLE.lastIndex = 0) === 0);
    return `${label}${kept.length ? kept.join(", ") : "none"}`;
  });
  const single = items
    .replace(/\bgroup portrait\b/gi, people === 1 ? "portrait of one person" : "picture with nobody in it")
    .replace(/\b(a group of|several|many|two|three|four) (friends|kids|children|boys|girls|people)\b/gi, people === 1 ? "one person" : "nobody")
    .replace(/\b(friends|kids|children|siblings) (standing|sitting|playing|laughing|together)\b/gi, people === 1 ? "one person $2" : "nobody");
  return `${single}${people === 1 ? " (this post shows ONE person: the ambassador, alone)" : " (this post shows nobody)"}`;
}

export function tileWithoutBags(tile: string, hasProduct: boolean): string {
  // Cards carry words: they leave the tile ("A container and a branded card" → "A container").
  tile = tile.replace(/,?\s*(?:and\s+)?(?:an?\s+)?(?:(?:branded|business|name|gift|greeting)\s+)?cards?\b/gi, "");
  if (hasProduct) tile = withoutEdibleItems(tile);
  if (!BAGS.test(tile)) return tile;
  if (hasProduct) return tile.replace(BAG_PHRASE, "the product");
  return tile
    .split(/(?<=[.:])\s+/)
    .filter((x) => !BAGS.test(x))
    .join(" ");
}

/** The grid's reading without the tiles that hold bags or logos (the engine copies them). */
export function gridWithoutBags(grid: string, hasProduct = false): string {
  return grid
    .split("\n")
    .map((line) => (/^Tile \d/.test(line) ? (BAGS.test(line) || LETTERED.test(line) || /\blogos?\b/i.test(line) ? "" : hasProduct ? withoutEdibleItems(line) : line) : withoutLettering(withoutBags(line))))
    .filter(Boolean)
    .join("\n");
}

/**
 * Food, drink and toppings of another brand: what a reference tile or shot shows that the client's
 * product takes the place of. Never written into a prompt that carries a product photo.
 */
export const EDIBLE =
  /\b(?:cookies?|biscuits?|cinnamon rolls?|rolls?|buns?|croissants?|pastr(?:y|ies)|donuts?|doughnuts?|muffins?|cupcakes?|cakes?|brownies?|tarts?|pies?|bread|toast|waffles?|pancakes?|crepes?|macarons?|candy|candies|sweets?|chocolates?|chocolate (?:chips?|sauce|syrup|drizzle)|truffles?|marshmallows?|pretzels?|crackers?|chips|popcorn|nuts?|almonds?|pistachios?|walnuts?|hazelnuts?|peanuts?|seeds?|cereal|corn ?flakes|granola|oats?|fruits?|fruit slices?|berries|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|cherr(?:y|ies)|bananas?|apples?|oranges?|lemons?|limes?|mango(?:es|s)?|grapes?|dates?|figs?|pomegranates?|kiwis?|peach(?:es)?|melons?|watermelons?|coconuts?|avocados?|olives?|vegetables?|herbs?|mint|basil|rosemary|cream|whipped cream|ice cream|gelato|yogh?urt|cheese|butter|honey|jam|syrup|sauce|caramel|drizzle|sprinkles|glaze|frosting|icing|toppings?|garnish|sugar|cinnamon|spices?|coffee beans?|beans?|eggs?|milk|juices?|smoothies?|milkshakes?|drinks?|beverages?|coffee|tea|latte|cocktails?|sandwich(?:es)?|burgers?|pizzas?|fries|pasta|rice|salads?|soups?|meat|chicken|fish|sushi|snacks?)\b/gi;

const EDIBLE_ONE = new RegExp(EDIBLE.source, "i");

/** A tile line without the reference's edible items ("Items: wooden tray, cinnamon rolls" → "Items: wooden tray"). */
export function withoutEdibleItems(line: string): string {
  return line.replace(/\bItems:\s*([^.;\n]*?)(?=\s*(?:Background:|Text:|Product:|$|[.;\n]))/g, (_m, items: string) => {
    const kept = items
      .split(/,\s*|\s+and\s+/)
      .map((x) => x.trim())
      .filter((x) => x && !EDIBLE_ONE.test(x));
    return `Items: ${kept.length ? kept.join(", ") : "none (the product stands there)"}`;
  });
}

/** The month's outfits, one per line; each post with people wears one of them, in turn. */
export function outfitsOf(wardrobe: string | undefined | null): string[] {
  return (wardrobe ?? "")
    .split("\n")
    .map((x) => x.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter(Boolean);
}

export const WARDROBE_SCHEMA = {
  type: "object",
  properties: { outfits: { type: "array", items: { type: "string" } } },
  required: ["outfits"],
};

export function wardrobeInstruction(r: {
  client: string;
  palette: string[];
  world: string;
  people: { name: string; description: string; gender?: string; modest?: boolean; hijab?: boolean }[];
}): string {
  return [
    `You are the stylist of a social-media photo shoot for the brand "${r.client}" in Jordan. Suggest 4 outfits for the people in this month's pictures.`,
    r.world ? `THE MONTH'S LOOK: ${r.world.slice(0, 900)}` : "",
    r.palette.length ? `THE MONTH'S COLOURS (the outfits use them, with their hex): ${r.palette.join(", ")}.` : "",
    r.people.length
      ? `THE PEOPLE:\n${r.people.map((p) => `- ${p.name}${p.gender ? ` (${p.gender})` : ""}: ${p.description.slice(0, 200)}${p.modest ? "; dresses modestly: sleeves down to the wrist, an ankle-length skirt or wide trousers, a loose fit, a high neckline, nothing sheer or fitted" : ""}${p.hijab ? "; wears a hijab, matching the outfit" : ""}`).join("\n")}`
      : "THE PEOPLE: models of the brand's audience, dressed modestly (long sleeves, long skirts or wide trousers, loose fit).",
    r.people.some((p) => p.modest) ? "Every outfit is for a person who dresses modestly: wrist-length sleeves, nothing above the ankle, no short or three-quarter sleeves." : "",
    "Each outfit is one line: the garments, their cut and fabric, their colours (name and hex from the month's colours), shoes and one or two simple accessories (rings, a watch, a scarf). They suit a premium food brand: elegant, calm, never costume-like; no logos, prints or words on any garment; they never compete with the product.",
    "Return ONLY JSON: {\"outfits\": [\"...\", \"...\"]}.",
  ]
    .filter(Boolean)
    .join("\n\n");
}



/**
 * The gate before paying: the mistakes the review would flag that can be read from the words of the
 * idea and the shot are taken out here, deterministically, before any image is bought. A sentence
 * that describes words to draw (a headline, a swipe arrow), a bag or a carrier, a card or a menu
 * never reaches the engine. Returns the cleaned texts and a note for each thing taken out.
 */
export function gatePostText(post: Pick<Post, "brief" | "scene">): { brief: string; scene?: string; notes: string[] } {
  const notes: string[] = [];
  const quoted = (t: string) => (t.match(/["'“”‘’]([^"'“”‘’]{1,40})["'“”‘’]/g) ?? []).map((q) => q.slice(1, -1)).slice(0, 3);
  const pass = (label: string, text: string | undefined): string | undefined => {
    if (!text?.trim()) return text;
    let out = text;
    const w = withoutWordsSentences(out);
    if (w !== out.trim()) {
      const q = quoted(out).filter((x) => !quoted(w).includes(x));
      notes.push(`took the words to draw out of the ${label}${q.length ? ` (${q.map((x) => `"${x}"`).join(", ")})` : ""}`);
      out = w;
    }
    const bagless = withoutBags(out);
    if (bagless && bagless !== out.trim()) {
      notes.push(`took the bag or carrier out of the ${label}`);
      out = bagless;
    }
    const lettered = withoutLettering(out);
    if (lettered && lettered !== out.trim()) {
      notes.push(`took the card, tag, menu or logo out of the ${label}`);
      out = lettered;
    }
    return out;
  };
  const brief = pass("idea", post.brief) ?? post.brief;
  const scene = pass("shot", post.scene);
  return { brief, scene, notes: [...new Set(notes)] };
}
