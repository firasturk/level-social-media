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
  /** Which tile of a reference grid this post follows (grid mode). */
  tile?: string;
  /** Which of the theme's shots (1-based) this post follows, when the theme has shots. */
  shot?: number;
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
  /** Which take of this post this is; takes after the first ask for a different picture. */
  take?: number;
  /** The reference shot this post follows (one of the theme's shots), when any. */
  shot?: string;
  /** Further products attached after image 1, in order: their names, notes and R2 keys. */
  extraProducts?: { name: string; note?: string; key: string }[];
  /** Brand ambassadors in this post, attached after the products: name, look and portrait key. */
  ambassadors?: { name: string; description: string; key: string }[];
  /** Grid mode: what the reference grid looks like and which tile this post follows. */
  grid?: string;
  tile?: string;
}

export const NO_TEXT_RULE =
  "TEXT: the image contains no letters, numbers, words, logos, labels, stickers, price tags, watermarks, speech bubbles or user-interface elements, in any language or script. Headlines, prices and logos are added later outside the image. Where the product itself carries printed text on its packaging in image 1, that packaging is reproduced exactly as photographed, nothing else is written anywhere.";

export const ONE_PRODUCT_RULE =
  "PRODUCT: image 1 is the product. Reproduce it exactly: identical shape, proportions, colours, materials, finish, label and packaging; nothing added, removed, restyled or recoloured. It appears once, whole and undistorted, as the clear subject.";

export function paletteRule(palette: string[], chosen = false): string {
  if (!palette.length) return "";
  if (chosen)
    return `COLOURS (chosen by the designer for this month; they win over everything else): the backgrounds, surfaces, props, fabrics and light sit inside this palette: ${palette.join(", ")}. They replace the colours of the style reference and any colour named in the shot or the visual language above: a pink reference still gives a scene in these colours. The product keeps its own exact colours.`;
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
  const extras = b.extraProducts ?? [];
  const people = b.ambassadors ?? [];
  const styleRef =
    "take its place, light, camera, colour grade, mood and the way it stages people (how many, how framed, what they do), never its specific objects, its text, or the identity of its people (new faces, same role)";
  // Images are attached in this order: products, ambassador portraits, style reference, revision.
  let n = 0;
  if (b.hasProduct && extras.length) {
    n = extras.length + 1;
    parts.push(
      `Images 1 to ${n} are product photos: ${n} different products that appear TOGETHER in this one picture, each reproduced exactly (shape, colours, label, packaging) and each appearing once. ${extras.map((e, i) => `Image ${i + 2}: ${e.name}${e.note ? ` — ${e.note}` : ""}.`).join(" ")}`,
    );
  } else if (b.hasProduct) {
    n = 1;
    parts.push("Image 1 is the product photo: the product is the source of truth and is reproduced exactly.");
  } else if (b.ref) {
    n = 1;
    parts.push(`No product is attached. Image 1 is a style reference: ${styleRef}.`);
  } else parts.push("No product is attached.");
  if (people.length) {
    const first = n + 1;
    n += people.length;
    parts.push(
      `${people.length > 1 ? `Images ${first} to ${n} are portraits of the brand's ambassadors` : `Image ${first} is the portrait of the brand's ambassador`}: ${people.map((p, i) => `Image ${first + i}: ${p.name}${p.description ? ` (${p.description})` : ""}.`).join(" ")} Every ambassador in the picture is exactly this person: the same face, features, hair, skin tone and build as the portrait, in a new pose, expression and outfit that fit the scene; the portrait's background, framing and clothes are not copied. No other people appear unless the post asks for them.`,
    );
  }
  if (b.hasProduct && b.ref && !b.refIsSource) {
    n += 1;
    parts.push(`Image ${n} is a style reference: ${styleRef}.`);
  }
  parts.push(b.hasProduct ? "Create the scene described below around the product." : "Create the scene described below.");
  if (images.revision)
    parts.push(
      "The last image is the previous result of this post: apply the revision below to it and keep everything else.",
    );
  if (b.hasProduct && b.product) parts.push(`THE PRODUCT IN IMAGE 1: ${b.product.trim()}`);
  if ((b.take ?? 1) > 1)
    parts.push(
      `TAKE ${b.take}: the designer rejected the earlier takes of this post. Make a clearly different picture of the same brief: another camera angle and distance, another arrangement of the set and props, another placement of the product, a different light direction; the subject, the product and the mood stay.`,
    );
  parts.push(`POST (${POST_TYPE_INFO[b.type]?.label ?? b.type}): ${b.title}\n${b.brief.trim()}`);
  const style = [b.style.trim(), b.theme.trim()].filter(Boolean).join("\n");
  if (style) parts.push(`CLIENT STYLE:\n${style}`);
  const rules = [
    b.always?.trim() ? `ALWAYS: ${b.always.trim()}` : "",
    b.never?.trim() ? `NEVER: ${b.never.trim()}` : "",
  ].filter(Boolean);
  if (rules.length) parts.push(`CLIENT RULES (these override the reference and the brief):\n${rules.join("\n")}`);
  if (b.library) parts.push(`VISUAL LANGUAGE:\n${b.library.trim()}`);
  if (b.shot?.trim())
    parts.push(
      `REFERENCE SHOT: this post recreates one picture of the reference, with the client's product in the place of the reference's product and new faces for any people: ${b.shot.trim()}`,
    );
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
  const palette = paletteRule(b.palette, !!b.paletteChosen);
  if (palette) parts.push(palette);
  if (b.hasProduct && !extras.length) parts.push(ONE_PRODUCT_RULE);
  if (b.hasProduct && extras.length)
    parts.push(
      `PRODUCTS: the ${extras.length + 1} attached products are the only products in the picture, each shown once, whole, undistorted and recognisable; no invented extra cups, bottles or packs.`,
    );
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
          products: { type: "array", items: { type: "string" } },
          headline: { type: "string" },
          subline: { type: "string" },
          shot: { type: "integer" },
          people: { type: "array", items: { type: "string" } },
        },
        required: ["type", "title", "brief", "caption", "hashtags", "product", "products", "headline", "subline", "shot", "people"],
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
  /** The client's overlay shows no second line: every subline stays "". */
  noSubline?: boolean;
  /** The theme's chosen colours; they replace every colour the references and shots name. */
  monthPalette?: string[];
  /** The month's brand ambassadors: the only people the posts may show. */
  ambassadors?: { name: string; description: string }[];
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
}

/** The month's ambassadors as an instruction block for the ideas writer (empty when none). */
function ambassadorsBlock(r: IdeasRequest): string {
  if (!r.ambassadors?.length) return "";
  return `BRAND AMBASSADORS THIS MONTH (the brand's recurring people; their portraits keep the same faces in every post): ${r.ambassadors.map((a) => `${a.name}${a.description ? ` (${a.description})` : ""}`).join("; ")}. Whenever a post shows a person, cast one or more of these ambassadors by name in the field "people" (1-3 names, exact spelling) and name them in the brief with what they do; they are the only people who appear. Spread them across the month so each appears, and leave "people" empty for product-only posts. The client's ALWAYS and NEVER rules still apply.`;
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
    r.dos ? `ALWAYS: ${r.dos}` : "",
    r.donts ? `NEVER: ${r.donts}` : "",
    r.monthPalette?.length
      ? `COLOURS THIS MONTH (chosen by the designer; they win over everything else): ${r.monthPalette.join(", ")}. Every brief builds its backgrounds, surfaces, props and fabrics from these colours. Where the theme, its visual language or the shots name other colours (for example pink walls in a reference), write these colours instead.${r.palette.length ? ` Brand colours for small accents only: ${r.palette.join(", ")}.` : ""}`
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
      ? `SHOTS FROM THE REFERENCES (one per reference picture, numbered): the month is planned over these shots. With ${r.count} posts and ${r.shots.length} shots: when there are more shots than posts, pick the ${r.count} most varied shots and leave the rest out; when there are more posts than shots, reuse shots with a different product and a changed arrangement so no two posts look the same. Each post's brief recreates its shot with the client's product and names the shot number in the field "shot".\n${r.shots.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
      : "",
    ambassadorsBlock(r),
    "PEOPLE: when the references or the theme show people with the product (a hand holding the cup, a person at a table), write people into the briefs the same way, naming how many and how they are framed; the image engine adds people only when a brief asks for them. State each person's gender and rough age in the brief (\"a man in his thirties\", \"a boy of ten\"), never a vague \"a person\", and keep every person inside the client's ALWAYS and NEVER rules: a rule that excludes women, children or anyone else is absolute, whatever the references show.",
    r.products.length
      ? `PRODUCTS AVAILABLE AS PHOTOS (use the exact names in the product fields). COVERAGE: no product appears a second time before every product has appeared once; a picture that shows several products together counts for each of them, so group products into one post wherever the shot or the idea shows several items (a row of cups, a pair of drinks, a tray). When there are still more products than the posts can carry, leave some out rather than adding posts. The description after each name is what its photo actually shows: the post's title, headline, subline, brief and caption are about THOSE items and never name or describe a different product:
${r.products.map((n) => `- ${n}${r.productNotes?.[n] ? `: ${r.productNotes[n]}` : ""}`).join("\n")}`
      : "No product photos were uploaded: set product to an empty string for every post.",
    r.props?.trim() ? `PROPS TO USE: ${r.props.trim()}. Work them into the scenes naturally (not every post needs all of them) and mention them in the briefs.` : "",
    r.notes ? `DESIGNER NOTES FOR THIS MONTH: ${r.notes}` : "",
    `POST TYPES (field "type", use a varied mix across the month, never the same type twice in a row, and respect the month's occasions in the region when relevant):\n${types}`,
    `For each post write: title (3-6 words, internal), brief (3-5 sentences describing ONE photograph for the image engine: the place, the subject, what happens, where the product is and what it does, the light and the mood; concrete and visual, no slogans, no text in the picture, catalogue-safe wording), headline (the words drawn over the image later: a 2-4 word hook in the caption language, in the client's tone), ${r.noSubline ? 'subline (always "": this client\'s posts carry the headline alone, so the headline must say everything on its own)' : 'subline (the second line under the headline: the promise, offer or product name, at most 8 words, or "")'}, caption (${lang} Hook first, value in the middle, call to action last, 40-90 words, no hashtags inside), hashtags (8-12, space separated, starting with #), product (the lead product: one of the product names exactly, or ""), products (every product shown in the picture, lead first, exact names: a shot of several drinks in a row or two cups side by side lists 2-4 products; a single-product picture lists just the lead; [] when none), shot (the number of the reference shot the post follows, or 0 when the theme has no shots), people (names of the brand ambassadors in the picture, or []).`,
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
    const type = (POST_TYPES as readonly string[]).includes(String(raw.type))
      ? (String(raw.type) as PostType)
      : "lifestyle";
    const brief = String(raw.brief ?? "").trim();
    if (!brief) continue;
    const title = String(raw.title ?? "").trim();
    // The product field first; a product named in the title stands in when the field is empty.
    const lead =
      matchProduct(String(raw.product ?? ""), products) ?? matchProduct(title, products);
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
      caption: String(raw.caption ?? "").trim().slice(0, 2200),
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
  const lang = languageRule(r.language);
  return [
    `The attached image is a reference social-media feed grid (several post tiles in one picture). You are the creative lead of a design agency: read it tile by tile, then plan ${r.count} posts for the client "${r.clientName}" for ${monthLabel(r.month)} that recreate the SAME world and rhythm with the client's own products and identity. The posts are produced as single images by an image engine (no text inside the image) and get a headline overlay and a caption.`,
    "First describe the grid: world (one paragraph: the sets, materials, surfaces, props, palette with colour words, light, camera angles, mood, how products are staged and where text sits) and tiles (one entry per tile in reading order: position like 'row 1, col 2'; scene; productPlacement; textPlacement). Ignore the reference's brand, products, logos and words: only the staging matters.",
    `CLIENT TONE OF VOICE: ${r.tone || "friendly, clear, professional"}.`,
    `LANGUAGE (this setting wins over anything the tone of voice says about languages): ${lang}`,
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
    r.props?.trim() ? `PROPS TO USE: ${r.props.trim()}. Work them into the tiles' staging naturally and mention them in the briefs.` : "",
    ambassadorsBlock(r),
    "PEOPLE: where the grid's tiles show people with the product, write people into those briefs the same way (how many, how framed); the image engine adds people only when a brief asks for them. State each person's gender and rough age in the brief, never a vague \"a person\", and keep every person inside the client's ALWAYS and NEVER rules: a rule that excludes women, children or anyone else is absolute, whatever the grid shows.",
    r.notes ? `DESIGNER NOTES: ${r.notes}` : "",
    `Then write the ${r.count} posts in posting order, cycling through the tiles so the feed keeps the reference's rhythm (tile 1 staging for post 1, tile 2 for post 2, and so on, varying props so no two posts are identical). For each post: type (one of ${POST_TYPES.join(", ")}), title (3-6 words, internal; start it with the tile it follows, e.g. "T3 ·"), brief (4-6 sentences describing ONE photograph for the image engine: the set and its materials in the brand palette, the props, the camera angle, where the product sits and what it does, the light, the mood, and which area stays calm for the headline; concrete, visual, catalogue-safe wording, no text in the picture), headline (2-4 words), ${r.noSubline ? 'subline (always "")' : 'subline (at most 8 words or "")'}, caption (${lang} Hook first, value, call to action; 40-90 words; no hashtags inside), hashtags (8-12 with #), product (exact name or ""), people (names of the brand ambassadors in the picture, or []).`,
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
    "3. shots: one entry per picture (every tile of a collage counts), in reading order, each a ready brief for an image engine in 2-4 sentences: the set and its materials, the camera angle and distance, where the product sits and what happens to it (pouring, held, stacked...), the props, the light, and where calm space is left for a headline. Write 'the product' instead of the reference's product, never its brand or text; describe people by role, framing and action only.",
    `4. ${PALETTE_ASK}`,
    "Return ONLY a JSON object with keys description, direction, library, shots and palette.",
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

/** One fresh idea for a single post of a month that is already planned. */
export function singleIdeaInstruction(
  r: IdeasRequest,
  post: Post,
  others: string[],
  wish: string,
): string {
  const base = ideasInstruction({ ...r, count: 1 });
  return [
    base,
    `THIS IS A REPLACEMENT for post ${post.index} of a month already planned. Keep its type (${post.type})${post.product ? ` and its product (${post.product}, exact name in the product field)` : ""}, and write a NEW idea for it: a different scene, angle, action and headline from the one it replaces ("${post.title}": ${post.brief.slice(0, 300)}).`,
    others.length ? `It must not repeat these other posts of the month: ${others.join(" · ")}.` : "",
    wish.trim() ? `THE DESIGNER ASKS FOR: ${wish.trim()}` : "",
    'Return ONLY JSON: {"posts": [one post]}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}
