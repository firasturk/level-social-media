/**
 * Social-media posts: the plan of a client's month (ideas), the brief stored on each generated
 * post, and the deterministic prompt the image engine receives. No fashion assumptions: the
 * subject is a product, a place, a person at work, a texture, whatever the post calls for.
 */
import type { PromptImages } from "./prompts";
import type { PostOverlayPatch } from "./overlay";
import { FULL_FRAME_RULE } from "./prompts";
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
};

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
  format?: Format;
  /** Headline drawn over the image by the overlay (hook, 2-4 words) and its second line. */
  headline?: string;
  subline?: string;
  /** false hides the overlay on this post (a text-free image). */
  overlay?: boolean;
  /** Adjustments made in the on-image editor. */
  ov?: PostOverlayPatch;
  /** Which tile of a reference grid this post follows (grid mode). */
  tile?: string;
}

/** What a generated post was built from; stored on its task so retries and revisions keep it. */
export interface PostBrief {
  post: true;
  index: number;
  type: PostType;
  title: string;
  brief: string;
  /** Hex palette with names, e.g. "Primary #1a1a1a". */
  palette: string[];
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
  /** Grid mode: what the reference grid looks like and which tile this post follows. */
  grid?: string;
  tile?: string;
}

export const NO_TEXT_RULE =
  "TEXT: the image contains no letters, numbers, words, logos, labels, stickers, price tags, watermarks, speech bubbles or user-interface elements, in any language or script. Headlines, prices and logos are added later outside the image. Where the product itself carries printed text on its packaging in image 1, that packaging is reproduced exactly as photographed, nothing else is written anywhere.";

export const ONE_PRODUCT_RULE =
  "PRODUCT: image 1 is the product. Reproduce it exactly: identical shape, proportions, colours, materials, finish, label and packaging; nothing added, removed, restyled or recoloured. It appears once, whole and undistorted, as the clear subject.";

export function paletteRule(palette: string[]): string {
  if (!palette.length) return "";
  return `PALETTE: the scene, props, surfaces and light sit inside this palette: ${palette.join(", ")}. The product keeps its own exact colours.`;
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

const AVOID =
  "AVOID: text, letters, numbers, logos, watermarks, price tags, UI elements, speech bubbles, extra limbs, duplicated products, changed product colour or shape, borders or bars, collage, split frames, cartoon or illustration style unless the brief asks for it, oversaturated HDR, plastic skin.";

/** The engine prompt for one post. Deterministic: the same brief gives the same text. */
export function buildPostPrompt(b: PostBrief, edit = "", images: PromptImages = {}): string {
  const parts: string[] = [];
  if (b.hasProduct) {
    parts.push(
      b.ref && !b.refIsSource
        ? "Image 1 is the product photo: the product is the source of truth and is reproduced exactly. Image 2 is a style reference: take its place, light, camera, colour grade, mood and the way it stages people (how many, how framed, what they do), never its specific objects, its text, or the identity of its people (new faces, same role)."
        : "Image 1 is the product photo: the product is the source of truth and is reproduced exactly. Create the scene described below around it.",
    );
  } else if (b.ref) {
    parts.push(
      "No product is attached. Image 1 is a style reference: take its place, light, camera, colour grade, mood and the way it stages people (how many, how framed, what they do), never its specific objects, its text, or the identity of its people (new faces, same role). Create the scene described below in that visual language.",
    );
  } else {
    parts.push("No product is attached. Create the scene described below.");
  }
  if (images.revision)
    parts.push(
      "The last image is the previous result of this post: apply the revision below to it and keep everything else.",
    );
  if (b.hasProduct && b.product) parts.push(`THE PRODUCT IN IMAGE 1: ${b.product.trim()}`);
  parts.push(`POST (${POST_TYPE_INFO[b.type]?.label ?? b.type}): ${b.title}\n${b.brief.trim()}`);
  const style = [b.style.trim(), b.theme.trim()].filter(Boolean).join("\n");
  if (style) parts.push(`CLIENT STYLE:\n${style}`);
  const rules = [
    b.always?.trim() ? `ALWAYS: ${b.always.trim()}` : "",
    b.never?.trim() ? `NEVER: ${b.never.trim()}` : "",
  ].filter(Boolean);
  if (rules.length) parts.push(`CLIENT RULES (these override the reference and the brief):\n${rules.join("\n")}`);
  if (b.library) parts.push(`VISUAL LANGUAGE:\n${b.library.trim()}`);
  if (b.props?.trim())
    parts.push(
      `PROPS: the scene includes ${b.props.trim()}, placed naturally around the subject in the same light; they never cover the product.`,
    );
  if (b.grid)
    parts.push(
      `REFERENCE GRID: the attached style reference is a whole feed grid. Reproduce its world (sets, materials, props, palette, light, camera) and the rhythm of its tiles, never its products, text or logos.${b.tile ? ` THIS POST FOLLOWS TILE: ${b.tile.trim()}` : ""}\n${b.grid.trim()}`,
    );
  parts.push(socialFrameRule(b.format));
  if (b.type === "offer" || b.type === "quote" || b.type === "tip" || b.type === "testimonial")
    parts.push(HEADLINE_SPACE_RULE);
  const palette = paletteRule(b.palette);
  if (palette) parts.push(palette);
  if (b.hasProduct) parts.push(ONE_PRODUCT_RULE);
  parts.push(NO_TEXT_RULE);
  parts.push(FULL_FRAME_RULE);
  parts.push(
    "PHOTOGRAPHY: a real photograph with a full-frame camera look, true materials and textures, natural depth of field, honest colour and contrast; the light has one clear source and direction and every object casts a shadow consistent with it.",
  );
  parts.push(POST_SHADOW_RULE);
  parts.push(POST_PEOPLE_RULE);
  parts.push(SAFE_WORDING_RULE);
  if (edit.trim()) parts.push(`REVISION: ${edit.trim()}`);
  parts.push(AVOID);
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
          headline: { type: "string" },
          subline: { type: "string" },
        },
        required: ["type", "title", "brief", "caption", "hashtags", "product", "headline", "subline"],
      },
    },
  },
  required: ["posts"],
};

export interface IdeasRequest {
  clientName: string;
  tone: string;
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
  products: string[];
  /** What each product photo shows, by product name (read by vision at upload). */
  productNotes?: Record<string, string>;
  month: string;
  count: number;
  /** Extra wishes typed by the designer for this month. */
  notes?: string;
  /** Post types to prefer, when the designer limited them. */
  types?: PostType[];
}

/** The instruction for the text model that plans a month of posts. */
export function ideasInstruction(r: IdeasRequest): string {
  const lang =
    r.language === "ar"
      ? "Captions in Modern Standard Arabic (no dialect unless the tone says so)."
      : r.language === "en"
        ? "Captions in English, sentence case."
        : "Captions in Arabic first, then an English version after a blank line.";
  const types = (r.types?.length ? r.types : [...POST_TYPES])
    .map((t) => `${t}: ${POST_TYPE_INFO[t].description}`)
    .join("\n");
  return [
    `You are the social-media creative lead of a design agency planning ${r.count} Instagram posts for the client "${r.clientName}" for ${monthLabel(r.month)}. The posts are produced as single images (no text inside the image; headlines are added later as an overlay), each with a caption.`,
    `CLIENT TONE OF VOICE: ${r.tone || "friendly, clear, professional"}.`,
    r.dos ? `ALWAYS: ${r.dos}` : "",
    r.donts ? `NEVER: ${r.donts}` : "",
    r.palette.length ? `BRAND PALETTE: ${r.palette.join(", ")}.` : "",
    r.style ? `VISUAL IDENTITY (from the client's past posts): ${r.style}` : "",
    r.themeTitle || r.themeDirection
      ? `THIS MONTH'S THEME "${r.themeTitle}": ${r.themeDirection}`
      : "",
    r.themeLibrary?.trim()
      ? `VISUAL LANGUAGE OF THE THEME'S REFERENCES (the posts live in this world):\n${r.themeLibrary.trim()}`
      : "",
    "PEOPLE: when the references or the theme show people with the product (a hand holding the cup, a person at a table), write people into the briefs the same way, naming how many and how they are framed; the image engine adds people only when a brief asks for them. Respect the client's ALWAYS and NEVER rules about who appears.",
    r.products.length
      ? `PRODUCTS AVAILABLE AS PHOTOS (use the exact names in the product field; spread the posts over different products, and when there are more products than posts leave some products out rather than adding posts). The description after each name is what its photo actually shows: the post's title, headline, subline, brief and caption are about THAT item and never name or describe a different product:
${r.products.map((n) => `- ${n}${r.productNotes?.[n] ? `: ${r.productNotes[n]}` : ""}`).join("\n")}`
      : "No product photos were uploaded: set product to an empty string for every post.",
    r.props?.trim() ? `PROPS TO USE: ${r.props.trim()}. Work them into the scenes naturally (not every post needs all of them) and mention them in the briefs.` : "",
    r.notes ? `DESIGNER NOTES FOR THIS MONTH: ${r.notes}` : "",
    `POST TYPES (field "type", use a varied mix across the month, never the same type twice in a row, and respect the month's occasions in the region when relevant):\n${types}`,
    `For each post write: title (3-6 words, internal), brief (3-5 sentences describing ONE photograph for the image engine: the place, the subject, what happens, where the product is and what it does, the light and the mood; concrete and visual, no slogans, no text in the picture, catalogue-safe wording), headline (the words drawn over the image later: a 2-4 word hook in the caption language, in the client's tone), subline (the second line under the headline: the promise, offer or product name, at most 8 words, or ""), caption (${lang} Hook first, value in the middle, call to action last, 40-90 words, no hashtags inside), hashtags (8-12, space separated, starting with #), product (one of the product names exactly, or "").`,
    `Return ONLY JSON: {"posts": [...]} with exactly ${r.count} posts in posting order.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Turn the model's answer into posts, dropping anything malformed. */
/** Loose key for product names: case, extension, underscores, punctuation and spacing do not count. */
export function productKeyOf(name: string): string {
  return name
    .normalize("NFC")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .toLowerCase()
    .replace(/[_\-.,'"()\u0640]+/g, " ")
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
  return partial?.p;
}

export function parseIdeas(text: string, count: number, products: string[]): Post[] {
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
    const type = (POST_TYPES as readonly string[]).includes(String(raw.type))
      ? (String(raw.type) as PostType)
      : "lifestyle";
    const brief = String(raw.brief ?? "").trim();
    if (!brief) continue;
    const title = String(raw.title ?? "").trim();
    // The product field first; a product named in the title stands in when the field is empty.
    const product =
      matchProduct(String(raw.product ?? ""), products) ?? matchProduct(title, products);
    out.push({
      index: out.length + 1,
      type,
      title: title.slice(0, 80) || `Post ${out.length + 1}`,
      brief: brief.slice(0, 2000),
      caption: String(raw.caption ?? "").trim().slice(0, 2200),
      hashtags: String(raw.hashtags ?? "").trim().slice(0, 400),
      product: product || undefined,
      headline: String(raw.headline ?? "").trim().slice(0, 80) || undefined,
      subline: String(raw.subline ?? "").trim().slice(0, 120) || undefined,
    });
    if (out.length >= count) break;
  }
  return out;
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
        },
        required: ["position", "scene", "productPlacement", "textPlacement"],
      },
    },
    posts: IDEAS_SCHEMA.properties.posts,
  },
  required: ["world", "tiles", "posts"],
};

export function gridIdeasInstruction(r: IdeasRequest): string {
  const lang =
    r.language === "ar"
      ? "Captions and headlines in Modern Standard Arabic unless the tone says dialect."
      : r.language === "en"
        ? "Captions and headlines in English."
        : "Captions in Arabic first, then English after a blank line; headlines in Arabic.";
  return [
    `The attached image is a reference social-media feed grid (several post tiles in one picture). You are the creative lead of a design agency: read it tile by tile, then plan ${r.count} posts for the client "${r.clientName}" for ${monthLabel(r.month)} that recreate the SAME world and rhythm with the client's own products and identity. The posts are produced as single images by an image engine (no text inside the image) and get a headline overlay and a caption.`,
    "First describe the grid: world (one paragraph: the sets, materials, surfaces, props, palette with colour words, light, camera angles, mood, how products are staged and where text sits) and tiles (one entry per tile in reading order: position like 'row 1, col 2'; scene; productPlacement; textPlacement). Ignore the reference's brand, products, logos and words: only the staging matters.",
    `CLIENT TONE OF VOICE: ${r.tone || "friendly, clear, professional"}.`,
    r.dos ? `ALWAYS: ${r.dos}` : "",
    r.donts ? `NEVER: ${r.donts}` : "",
    r.palette.length
      ? `BRAND PALETTE (the posts use these colours for sets and props instead of the reference's palette): ${r.palette.join(", ")}.`
      : "",
    r.style ? `VISUAL IDENTITY: ${r.style}` : "",
    r.themeDirection ? `THEME DIRECTION: ${r.themeDirection}` : "",
    r.products.length
      ? `PRODUCTS AVAILABLE AS PHOTOS (use the exact names in the product field; spread the posts over different products, and when there are more products than posts leave some products out rather than adding posts). The description after each name is what its photo actually shows: each post's title, headline, subline, brief and caption are about THAT item, never another product:\n${r.products.map((n) => `- ${n}${r.productNotes?.[n] ? `: ${r.productNotes[n]}` : ""}`).join("\n")}`
      : "No product photos were uploaded: set product to \"\" for every post and stage the client's kind of product generically.",
    r.props?.trim() ? `PROPS TO USE: ${r.props.trim()}. Work them into the tiles' staging naturally and mention them in the briefs.` : "",
    "PEOPLE: where the grid's tiles show people with the product, write people into those briefs the same way (how many, how framed); the image engine adds people only when a brief asks for them. Respect the client's ALWAYS and NEVER rules about who appears.",
    r.notes ? `DESIGNER NOTES: ${r.notes}` : "",
    `Then write the ${r.count} posts in posting order, cycling through the tiles so the feed keeps the reference's rhythm (tile 1 staging for post 1, tile 2 for post 2, and so on, varying props so no two posts are identical). For each post: type (one of ${POST_TYPES.join(", ")}), title (3-6 words, internal; start it with the tile it follows, e.g. "T3 ·"), brief (4-6 sentences describing ONE photograph for the image engine: the set and its materials in the brand palette, the props, the camera angle, where the product sits and what it does, the light, the mood, and which area stays calm for the headline; concrete, visual, catalogue-safe wording, no text in the picture), headline (2-4 words), subline (at most 8 words or ""), caption (${lang} Hook first, value, call to action; 40-90 words; no hashtags inside), hashtags (8-12 with #), product (exact name or "").`,
    `Return ONLY JSON: {"world": "...", "tiles": [...], "posts": [...]} with exactly ${r.count} posts.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface GridRead {
  world: string;
  tiles: { position: string; scene: string; productPlacement: string; textPlacement: string }[];
}

/** The grid description as one text for the prompts and the theme notes. */
export function gridNotes(g: GridRead): string {
  return [
    g.world.trim(),
    ...g.tiles.map(
      (t, i) =>
        `Tile ${i + 1} (${t.position}): ${t.scene} Product: ${t.productPlacement} Text: ${t.textPlacement}`,
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
  },
  required: ["description", "direction", "library"],
};

export function themeBuilderInstruction(title: string, count: number): string {
  return [
    `You are writing the visual direction of a social-media theme called "${title}" for a brand, from ${count} attached reference images (mood board, Pinterest pins, past posts). Generated posts will later borrow their place, light, palette, composition and mood from these references.`,
    "Study each image and extract ONLY: the kind of places and surfaces, the props and materials, the light (direction, quality, colour temperature), the colour palette and grade, the composition habits (distance, angle, negative space, symmetry), the photographic treatment (film, clean, flat lay, macro...), the mood, and the people: whether they appear, how many, how they are framed (hands only, half body, full body, face shown or turned away), what they do with the product, and their styling. Ignore and never mention brand names, logos, readable text, specific people's identities or specific products.",
    "Write three texts in English:",
    "0. description: one sentence (max 160 characters) a designer reads under the theme's name.",
    "1. direction: 4-8 sentences that start with 'Goal: produce posts that ...', naming the world, the light signature, the palette, the composition habits and the mood, ending with 'No text, logos or prices are drawn inside the image.'",
    "2. library: Markdown with '## Scenes' (one numbered line per image describing its setting and props in one dense sentence), '## Light' (3-4 dash lines), '## Palette' (2-3 dash lines with colour words), '## Composition' (2-3 dash lines), '## People' (1-2 dash lines: how often people appear, how many, how they are framed and what they do; or 'none' when the references show no people), '## Mood' (1-2 dash lines) and '## Avoid' (one dash line of what would break this world).",
    "Return ONLY a JSON object with keys description, direction and library.",
  ].join("\n\n");
}

/** The style text of a client's identity, from its past posts. */
export function identityBuilderInstruction(name: string, count: number): string {
  return [
    `You are describing the visual identity of the brand "${name}" from ${count} attached images of its past social-media posts, so that new posts can be generated in the same identity.`,
    "Extract ONLY: photography style (real photo, flat lay, studio, lifestyle, illustration mix), light, colour palette and grade, composition habits, typical props and surfaces, how products are shown, whether people appear and how, and the overall mood. Ignore readable text, logos and specific people's identities.",
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
  return `The attached image is a product photo uploaded under the name "${name}". In one line (at most 30 words, English) say what the item is: the kind of product (drink, dessert, dish, package, device...), its colours, container or packaging, and any readable brand or flavour text on it. Describe only what is visible; no marketing words. Return ONLY JSON: {"note": "..."}.`;
}
