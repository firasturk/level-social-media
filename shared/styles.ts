/**
 * The style gallery ("pick your style"): product-photo styles read from Pinterest pins. Each style
 * is written for any product; picking one for a post rewrites it for that post's real product,
 * its ingredients, the brand and the month's colours.
 */
import { parseStyleDesign, STYLE_DESIGN_SCHEMA, type StyleDesign } from "./style-design";

export const STYLE_KINDS = ["product", "people"] as const;
export type StyleKind = (typeof STYLE_KINDS)[number];

/** The library's categories, as the team browses them. */
export const STYLE_CATEGORIES = [
  { id: "corporate", label: "Corporate" },
  { id: "fashion", label: "Fashion" },
  { id: "food", label: "Food" },
  { id: "drinks", label: "Drinks" },
  { id: "sweets", label: "Sweets" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "beauty", label: "Beauty" },
  { id: "seasonal", label: "Seasonal" },
  { id: "luxury", label: "Luxury" },
  // A whole Instagram feed: the month follows it tile by tile (never one post's style).
  { id: "grid", label: "Grids" },
] as const;
export type StyleCategory = (typeof STYLE_CATEGORIES)[number]["id"];
export const STYLE_CATEGORY_IDS = STYLE_CATEGORIES.map((c) => c.id) as StyleCategory[];
/** The shelves of single photo styles (everything but the grids). */
export const PHOTO_CATEGORY_IDS: StyleCategory[] = STYLE_CATEGORY_IDS.filter((c) => c !== "grid");

/** Styles per page of the library. */
export const STYLE_PAGE_SIZE = 120;
/** "Trends": what joined the library in the last two weeks. */
export const TREND_DAYS = 14;

/** The lowest score a pin needs to enter the gallery (see STYLE_BAR). */
export const MIN_SCORE = 8;

/**
 * The team's bar, from the pins it chose: bold advertising concepts, not catalogue packshots.
 * Each pin read is scored against it.
 */
export const STYLE_BAR =
  "THE BAR (the team's own picks): bold, original advertising concepts with a clear idea, for example a giant product towering over a real city street, a product sitting on a swing among pink clouds, a claw machine grabbing product boxes, a mini fridge packed with products, ice and cherries, heart balloons lifting a jar into the sky, products pegged on a clothesline against a blue sky, a bottle tied up in thick pink rope, a person peeking out of a sea of pink balloons with the product, a product parked on a pastel vintage car by the sea, a person in a monochrome room with oversized products. They share: one surprising idea (impossible scale, an everyday object used in a new way, a playful set piece), one strong colour world, clean premium CGI-grade finish, social-media impact. Ordinary catalogue packshots, plain still lifes on a table, simple flat lays, generic lifestyle shots and stock photos are far below the bar.";

/** One style as the gallery shows it. The prompt goes to admins only. */
export interface StyleItem {
  id: string;
  kind: StyleKind;
  category: StyleCategory | "";
  created: number;
  title: string;
  tags: string;
  prompt?: string;
  position: number;
  updated: number;
  /** 1-10 against STYLE_BAR. */
  score: number;
  /** The picture's size, for the gallery's even rows (0 when unknown). */
  w: number;
  h: number;
  /** A grid's number of post tiles (0 for a photo style). */
  tiles: number;
  /** The client a grid was found or added for. */
  client?: string;
  /** That client's name, for the shelf label. */
  clientName?: string;
  /** The kind of brand a grid suits (GRID_GENRES). */
  genre?: string;
  /** Still waiting for the admin's approval (shown to the admin picking a month's grid). */
  waiting?: boolean;
  /** In the collection of the client the list was asked for ("Add to Habibah's"). */
  saved?: boolean;
  /**
   * A designed post (shared/style-design.ts): typography set over the photo or an Instagram post
   * mockup, drawn by the studio in the client's fonts and account; null for a plain photo.
   */
  design?: StyleDesign | null;
}

/**
 * The design block of a style read, or null for a plain photograph. The nullable object is written
 * as `type: ["object", "null"]`, the form the contract's own nested objects use; the Gemini path
 * rewrites it to its `nullable` flag (server/vertex.ts), Claude reads the schema as text, and the
 * OpenAI path takes no schema.
 */
export const STYLE_DESIGN_FIELD_SCHEMA = { ...STYLE_DESIGN_SCHEMA, type: ["object", "null"] };

export const STYLE_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    score: { type: "integer" },
    kind: { type: "string", enum: ["product", "people"] },
    category: { type: "string", enum: ["corporate", "fashion", "food", "drinks", "sweets", "lifestyle", "beauty", "seasonal", "luxury"] },
    title: { type: "string" },
    tags: { type: "string" },
    prompt: { type: "string" },
    design: STYLE_DESIGN_FIELD_SCHEMA,
  },
  required: ["keep", "score", "kind", "category", "title", "tags", "prompt", "design"],
};

/**
 * The DESIGN section of the reader's instruction: a designed pin comes back with its typography
 * and Instagram mockup as data (never as letters in the photo prompt).
 */
export const STYLE_DESIGN_INSTRUCTION = [
  "DESIGN: some pins are designed posts, not only photographs: words set as typography over or along the product photo (a huge rotated word along a pour, a small vertical line, a tag inside a thin outlined oval), or an Instagram post mockup framing the product photo (a white panel across the picture with the heart, comment and share icons, a bookmark, a like count, the handle with a caption and hashtags, an avatar row with handle and name, a comments pill, a logo, a keychain or product on a plinth). The studio draws every letter and every piece of that UI itself, in the client's own fonts, colours, words and Instagram account; the engine never draws letters. So read the design into `design`, exactly in this shape, and keep the photograph apart from it.",
  '`design` is null for a plain photograph with no words and no UI. Otherwise: `kind`: ["typography"] for words set on the photo, ["mockup"] for an Instagram post mockup, both when the pin has both. `texts`: one entry per text element, with `role` ("big": the hero word or two set huge; "line": a short second line; "label": a small tag or label, often outlined or in a pill; "caption": a longer sentence; "handle": the brand\'s Instagram handle), its box as fractions of the canvas (`x` and `w` of the width, `y` and `h` of the height, 0-1, measured on the whole picture), `rotate` in degrees clockwise (0 upright, -90 read bottom to top, 90 top to bottom), `weight` (heavy, regular, light), `case` (upper or none), `tone` ("light": light letters on a dark or mid ground; "dark": dark letters on a light ground), `align` (left, center, right), `decoration` (none, oval, pill, underline, box), `behind` (true when the letters sit behind the product or the pour, partly hidden by it) and `sample`: the words the pin itself shows, copied as they are (they are never drawn; they tell the studio the length and the language). For a mockup `mockup` holds `ui`: "instagram-post", `panel`: the box the UI sits in as fractions with its `radius` (0-1 of its height) and `tone` (light or dark), or null when the UI floats on the photo; `parts`: which parts the pin shows (actions: the heart, comment and share icons; likes: the like count; caption: the handle with a caption; hashtags; account: the avatar row with handle and name; comments: a comments count or pill; logo); and `logo`: where the logo sits (x, y, w as fractions) when the pin shows one, else null. `space`: one short English sentence on where the photograph must stay clean for the design (for example "the right third stays an even cream backdrop" or "the middle band behind the panel stays calm"). `accent`: what the lettering or panel takes: "brand" (the brand\'s main colour), "light" or "dark".',
  "For a designed pin the `prompt` describes the PHOTOGRAPH ALONE: no letters, no words, no typography, no UI, no panel, no icons, no like count, no handle, no logo; and it says that the composition leaves that clean space for the design (for example \"the right third stays an even cream backdrop for typography\" or \"a calm band across the middle, where a panel will sit\"). The photograph's own product, pour, set, light and mood are described as for any style.",
].join("\n\n");

/** The sentence the instruction uses for the photo prompt of a designed pin (tests look for it). */
export const PHOTOGRAPH_ALONE = "describes the PHOTOGRAPH ALONE";

/** The vision model reads one pin into a reusable style (or a fresh variation of one). */
export function describeStyleInstruction(note: string, previous?: { title: string; prompt: string }): string {
  return [
    "You are a senior product photographer building a library of photo styles that any brand's product can be shot in. The image is a pin from Pinterest.",
    note.trim() ? `The pin's own title and description (may hold a written prompt, in any language): ${note.trim().slice(0, 1500)}` : "",
    "keep: true only when the image is one photograph (or one main photograph) of a product, or of a person with a product, in a style another product could be shot in (studio packshot, splash, levitation, ingredients, still life, lifestyle). keep is ALSO true for a designed post whose heart is a photograph of a product: typography set over or along the product photo (a word along a pour, a vertical line, an outlined label), or an Instagram post mockup framing a product photo (its UI panel across the picture); the design is read into `design` below and the photograph into `prompt`. keep is false for: collages of several photos, text-only cards (words with no product photo), plain screenshots with no product photo, charts, before/after, drawings; a picture with no product in it (only fabric, a backdrop or a shadow); a product inside a bag, net, basket, carrier or shopping trolley; alcohol; and any person in clothes unsuitable for a Middle Eastern family brand (bare shoulders, sleeveless or strapless tops, low necklines, crop tops, short skirts or shorts, swimwear) or making a silly or rude face (tongue out).",
    STYLE_BAR,
    "score: 1-10, how far this pin reaches the bar (9-10: as bold and original as the team's picks; 7-8: a strong concept; 4-6: a nice but ordinary product photo; 1-3: catalogue or stock).",
    'kind: "people" when a person, or hands and arms that are part of the style, hold, use or present the product; otherwise "product".',
    'category: the shelf it belongs on, by what the pin advertises: "corporate" (banks, insurance, telecom, tech, services, B2B), "fashion" (clothes, shoes, bags, accessories), "food" (meals, snacks, savoury food), "drinks" (coffee, juice, soft drinks, milkshakes, any beverage), "sweets" (desserts, chocolate, pastries, sweets, ice cream), "lifestyle" (home, everyday products, people living with a product), "beauty" (skincare, cosmetics, perfume, care), "seasonal" (an occasion or season: Ramadan, Eid, winter, summer, Valentine), "luxury" (premium gifts, jewellery, high-end boxes).',
    'title: 2-3 words naming the idea, like a product-shot preset ("Claw Machine Grab", "Cloud Swing", "Fridge Stash", "Balloon Lift", "Giant In The City").',
    "tags: 3-5 short words, comma separated (surface, effect, mood).",
    "prompt: a reusable photo prompt in English, 110-190 words, for ANY product, that keeps the pin's IDEA (the surprising scale, object or set piece) as its heart. Write 'the product' for the item. Describe: camera angle and distance; how the product sits, stands, floats or is held; the set and surface; the props and how they are arranged; effects (splash, condensation, frost, smoke, light beams); the light (direction, hardness, colour); the background (write 'the brand's main colour' where the pin uses a strong single colour); depth of field and lens; the mood. Where the pin shows a flavour or ingredient (raspberries, citrus slices, coffee beans), write 'the product's own key ingredients' (for example 'pieces of the product's own key ingredients frozen inside crystal-clear ice cubes'), never a specific fruit, food or brand. For a person write 'the brand ambassador' with pose, hands, framing and modest clothing, never a specific face. No text, logos or brand names in the picture. Use a written prompt on the pin as inspiration only; write your own.",
    STYLE_DESIGN_INSTRUCTION,
    previous
      ? `This style already exists as "${previous.title}": ${previous.prompt}\nWrite a FRESH variation of the same idea: keep what makes the style recognisable, change the camera angle, the arrangement or the set so it reads new. Keep the same kind. Read the design again as the pin shows it (it does not vary).`
      : "",
    'Return ONLY JSON: {"keep": true, "score": 8, "kind": "product", "category": "sweets", "title": "...", "tags": "...", "prompt": "...", "design": null} with `design` filled as above for a designed pin, for example {"kind": ["typography"], "texts": [{"role": "big", "x": 0.55, "y": 0.05, "w": 0.4, "h": 0.9, "rotate": -90, "weight": "heavy", "case": "upper", "tone": "light", "align": "center", "decoration": "none", "behind": true, "sample": "BRIGADEIRO"}], "mockup": null, "space": "the right third stays an even dark backdrop", "accent": "light"}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface StyleReading {
  keep: boolean;
  score: number;
  kind: StyleKind;
  category: StyleCategory;
  title: string;
  tags: string;
  prompt: string;
  /** The pin's typography or Instagram mockup (shared/style-design.ts); null for a plain photo. */
  design: StyleDesign | null;
}

export function parseStyle(raw: unknown): StyleReading {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = String(d.prompt ?? "").trim().slice(0, 2000);
  const title = String(d.title ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 60);
  const design = parseStyleDesign(d.design);
  const read = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  // A designed post is a concept by itself (its typography or its Instagram frame is the idea), so
  // a pin the reader keeps with a design passes the bar: its score is lifted to MIN_SCORE when it
  // reads lower. A pin the reader drops (keep: false) keeps its own score, design or not.
  const score = design && d.keep !== false ? Math.max(read, MIN_SCORE) : read;
  return {
    keep: d.keep !== false && prompt.length > 40 && !!title && score >= MIN_SCORE,
    score,
    kind: d.kind === "people" ? "people" : "product",
    category: PHOTO_CATEGORY_IDS.includes(d.category as StyleCategory) ? (d.category as StyleCategory) : "lifestyle",
    title,
    tags: String(d.tags ?? "").trim().slice(0, 120),
    prompt,
    design,
  };
}

/** A design as the styles table stores it (JSON text), or NULL for a plain photo. */
export function designJson(design: StyleDesign | null | undefined): string | null {
  return design ? JSON.stringify(design) : null;
}

/** A design back from the styles table (JSON text or NULL), made safe; null when there is none. */
export function designFromJson(text: string | null | undefined): StyleDesign | null {
  if (!text) return null;
  try {
    return parseStyleDesign(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ───────────── Grids: whole Instagram feeds a month follows ───────────── */

/** A grid enters the library from this score (a feed is judged as a month's plan, not one ad). */
export const GRID_MIN_SCORE = 7;

/** The kinds of brand a feed grid suits: the Grids shelf is browsed by them. */
export const GRID_GENRES: { id: string; label: string; words: string[] }[] = [
  { id: "food", label: "Food", words: ["food", "restaurant", "bakery", "bread", "pastry", "burger", "pizza", "kitchen", "meal", "dish", "chef"] },
  { id: "drinks", label: "Drinks", words: ["drink", "coffee", "cafe", "café", "juice", "tea", "latte", "mojito", "beverage", "smoothie"] },
  { id: "sweets", label: "Sweets", words: ["sweet", "dessert", "chocolate", "cake", "kunafa", "kunafeh", "ice cream", "candy", "cookie"] },
  { id: "fashion", label: "Fashion", words: ["fashion", "clothing", "apparel", "outfit", "wear", "dress", "abaya", "shoe", "bag", "streetwear"] },
  { id: "beauty", label: "Beauty", words: ["beauty", "skincare", "cosmetic", "perfume", "makeup", "salon", "hair", "spa"] },
  { id: "corporate", label: "Corporate", words: ["corporate", "insurance", "bank", "finance", "telecom", "tech", "software", "clinic", "medical", "real estate", "b2b", "service"] },
  { id: "lifestyle", label: "Lifestyle", words: ["lifestyle", "home", "interior", "furniture", "decor", "travel", "fitness", "gym", "wellness", "family"] },
  { id: "luxury", label: "Luxury", words: ["luxury", "jewellery", "jewelry", "gold", "watch", "premium", "gift"] },
  { id: "seasonal", label: "Seasonal", words: ["ramadan", "eid", "christmas", "winter", "summer", "valentine", "mother's day", "national day", "seasonal"] },
];
export const GRID_GENRE_IDS = GRID_GENRES.map((g) => g.id);

/** The genre a grid was read with (its tags start with "genre:<id>"). */
export function gridGenre(tags: string | null | undefined): string | undefined {
  const m = /(?:^|\s)genre:([a-z]+)/.exec(tags ?? "");
  return m && GRID_GENRE_IDS.includes(m[1]) ? m[1] : undefined;
}

export const GRID_STYLE_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    score: { type: "integer" },
    title: { type: "string" },
    tags: { type: "string" },
    tiles: { type: "integer" },
    prompt: { type: "string" },
    genre: { type: "string", enum: GRID_GENRE_IDS },
  },
  required: ["keep", "score", "title", "tags", "tiles", "prompt", "genre"],
};

/** The vision model reads a picture of an Instagram feed into a grid a brand's month can follow. */
export function gridStyleInstruction(note: string, previous?: { title: string; prompt: string }): string {
  return [
    "You are an art director building a library of Instagram feed grids that a brand's month of posts can follow. The image is a picture of a feed (a pin, a screenshot or a designer's upload).",
    note.trim() ? `Its own title and description: ${note.trim().slice(0, 1200)}` : "",
    "keep: true only when the image shows one brand's Instagram feed as a grid: at least 6 post tiles in rows of three (a profile screenshot or a flat grid mockup) with one consistent visual world. keep is false for: a single photo; a collage that is not a feed; tiles of unrelated stock photos; a template where most tiles are only text; alcohol; any person in clothes unsuitable for a Middle Eastern family brand (bare shoulders, low necklines, short skirts, swimwear).",
    "score: 1-10, how strong the feed is as a month's plan: a clear rhythm between product heroes, lifestyle moments, close-ups and calm text tiles; one colour world; premium photography (9-10: a feed a top agency would show; 7-8: strong and consistent; 4-6: ordinary; 1-3: messy or amateur).",
    'title: 2-3 words naming the feed\'s look ("Sunlit Pastel Cafe", "Bold Colour Blocks", "Night Gold Luxury").',
    "tags: 3-5 short words, comma separated (palette, light, mood, kind of brand).",
    "tiles: how many post tiles the feed shows.",
    `genre: the kind of brand this feed suits best, one of: ${GRID_GENRE_IDS.join(", ")}.`,
    "prompt: 120-200 words in English for ANY brand: first the feed's world (palette written as 'the brand's main colour' and named neutrals, light, sets, materials, camera habits), then its rhythm tile by tile in reading order, one short line each (\"1 product hero on a plinth, 2 lifestyle with the brand ambassador, 3 calm text tile\"). Write 'the product' for the item; never a brand name, a logo or a specific food.",
    previous
      ? `This grid already exists as "${previous.title}": ${previous.prompt}\nWrite it again as a FRESH reading: the same feed, described anew.`
      : "",
    'Return ONLY JSON: {"keep": true, "score": 8, "title": "...", "tags": "...", "tiles": 9, "prompt": "...", "genre": "food"}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseGridStyle(raw: unknown): { keep: boolean; score: number; title: string; tags: string; tiles: number; prompt: string; genre?: string } {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = String(d.prompt ?? "").trim().slice(0, 2000);
  const title = String(d.title ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 60);
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  const tiles = Math.max(0, Math.min(30, Math.round(Number(d.tiles) || 0)));
  const genre = GRID_GENRE_IDS.includes(String(d.genre ?? "")) ? String(d.genre) : undefined;
  return {
    keep: d.keep !== false && prompt.length > 40 && !!title && score >= GRID_MIN_SCORE && tiles >= 6,
    score,
    title,
    // The genre leads the tags so the shelf can be browsed by it.
    tags: `${genre ? `genre:${genre} ` : ""}${String(d.tags ?? "").trim().slice(0, 120)}`.trim(),
    tiles,
    prompt,
    genre,
  };
}

/** How many posts a month gets from a grid: its tiles, within what a month can hold. */
export function gridPostCount(tiles: number, fallback: number): number {
  return tiles >= 3 ? Math.min(30, tiles) : fallback;
}

export const ADAPT_SCHEMA = {
  type: "object",
  properties: { prompt: { type: "string" }, brief: { type: "string" } },
  required: ["prompt", "brief"],
};

export interface AdaptRequest {
  style: { title: string; kind: StyleKind; prompt: string };
  /** What the product photo shows (packaging, colours, contents). */
  product: string;
  category?: string;
  /** The post: its type, headline and idea. */
  post: { type: string; headline: string; brief: string };
  brand: { name: string; style?: string; always?: string; never?: string };
  palette: string[];
  /** The post's ambassadors with their look; empty for a style without people or a post without them. */
  people: string[];
  /** The idea names its own people (a family, a father, a couple): they appear as the idea describes them. */
  briefPeople?: boolean;
  sellsDrinks?: boolean;
  /** The brand sells a service, not products. */
  service?: string;
  /** The month's theme (its world and mood), for the feel of the set only. */
  theme?: string;
  /** Mistakes the review found in this client's earlier pictures: the shot leads to none of them. */
  lessons?: string[];
  /** A campaign's own ingredients: the only food, spice or garnish that may appear around the product. */
  onlyFood?: string;
  /** The style is the designer's own reference picture for a campaign brief: the brief is the picture, the reference the look. */
  reference?: boolean;
}

/** The style rewritten for one post's real product: its ingredients, packaging, colours and people. */
/** A garment: worn in the picture, never handled like a box or a plate. */
export const CLOTHING =
  /\b(sweatshirt|sweater|hoodie|t-?shirt|tee|shirt|blouse|top|dress|skirt|jeans|trousers|pants|shorts|leggings|jacket|coat|abaya|kaftan|thobe|jumpsuit|romper|onesie|pyjamas?|pajamas?|activewear|sportswear|tracksuit|socks|sneakers|shoes|boots|cap|beanie|scarf|outfit|garment|clothing|clothes|wear)\b/i;
export function isClothing(text: string): boolean {
  return CLOTHING.test(text);
}

/** Words that make a sentence about the camera, the angle or where the product stands. */
const CAMERA_WORDS = /\b(camera|angle|lens|shot|shooting|viewpoint|point of view|eye[- ]level|overhead|from above|from below|bird'?s|worm'?s|close[- ]up|macro|wide|telephoto|framed|framing|perspective|straight[- ]on|low|high)\b/i;
const PLACE_WORDS = /\b(stands|sits|rests|lies|placed|set|edge|ledge|plinth|pedestal|diagonal|diagonally|centre|center|centred|centered|foreground|floats|levitat|hangs|suspended|frame)\w*\b/i;

/**
 * The style's own camera and composition, as its prompt opens (28 Oct): the shot writer kept
 * dropping the first sentences of a style (the low heroic angle, the ledge slicing the frame),
 * so they travel to the engine on their own, word for word. At most two sentences from the first
 * three; empty when the style's opening says nothing about the camera or the product's place.
 */
export function styleCameraSentences(prompt: string): string {
  const sentences = prompt
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  const picked: string[] = [];
  for (const s of sentences) {
    if (picked.length === 2) break;
    if (CAMERA_WORDS.test(s) || (picked.length && PLACE_WORDS.test(s))) picked.push(s);
  }
  return picked.join(" ");
}

export function adaptStyleInstruction(r: AdaptRequest): string {
  return [
    `You are the photographer of ${r.brand.name}, shooting one post in a style picked from the library. Write the final shot for the image engine: 3-6 concrete sentences.`,
    `THE STYLE "${r.style.title}": ${r.style.prompt}`,
    r.service?.trim()
      ? `THE BRAND SELLS A SERVICE, NOT PRODUCTS: ${r.service.trim()}. Replace 'the product' with an object of the service's moment (keys, a phone, a folder), never a drink or food.`
      : `THE PRODUCT (as photographed): ${r.product || "the brand's product"}${r.category ? ` (kind: ${r.category})` : ""}.`,
    r.reference
      ? `THE POST (${r.post.type}): headline "${r.post.headline}". THE DESIGNER'S BRIEF FOR THIS PICTURE (it decides what is in frame and what is not; when it says no cup or no packaging is visible, none is): ${r.post.brief}`
      : `THE POST (${r.post.type}): headline "${r.post.headline}". Its earlier idea (for its message only, never its picture): ${r.post.brief}`,
    r.reference
      ? "THE STYLE ABOVE IS THE DESIGNER'S OWN REFERENCE PICTURE for a campaign: the brief is the picture and the reference is its look. Keep the reference's colours, surfaces, light, camera, effects and mood exactly as they are (a dark scene stays dark; a splash, a pool of liquid, a floating ingredient or an ingredient rain are the designer's choice and stay), with this brand's product and the brief's ingredients in place of the reference's. Never name a colour the reference does not have."
      : "THE STYLE'S OWN IDEA REPLACES THE EARLIER ONE: the picture is the style's concept, done with this brand's product. Nothing of the earlier idea's staging is carried over: none of its gestures, props, objects or poses (no cups held to the eyes, no extra cups, bags or boxes); the product appears only the way the style shows it, once unless the style itself repeats it.",
    "KEEP the style's camera angle, composition, set, effects and light: the picture must read as this style. The first sentence names the style's camera angle and the surface or set the product stands on, exactly as the style has them; no sentence of the style is left out.",
    `WHEN THE STYLE'S ACTION CANNOT HAPPEN WITH THIS PRODUCT (a garment does not pour, flow, melt, splash or stack like sweets; a box does not get worn), keep the style's set, camera, scale, effects and mood and stage the product the way it is really presented (worn, folded, held, set down). Never write a product doing something its material cannot do, and never let it float, hang in the air or fall unless the style is a levitation shot${r.reference ? " or the reference itself shows an ingredient in the air" : ""}. A cup, glass or bottle stands upright on its base (or is held upright), never balanced on a corner, an edge or its rim.`,
    r.lessons?.length ? `MISTAKES SEEN IN THIS CLIENT'S EARLIER PICTURES (the review rejected them; the shot leads to none of them):\n${r.lessons.map((l) => `- ${l}`).join("\n")}` : "",
    r.theme?.trim() ? `THE MONTH'S THEME (its mood for the set, never more products): ${r.theme.trim().slice(0, 400)}` : "",
    "INGREDIENTS: replace 'the product's own key ingredients' and every generic ingredient with this product's real ingredients and flavours as its description shows them (for example pistachios, kunafa threads, sesame, rose petals, dates), never ones it does not have. An effect built on an ingredient keeps working with the real one (raspberries frozen in ice become pistachios frozen in ice).",
    isClothing(`${r.product} ${r.category ?? ""}`)
      ? "THE PRODUCT IS CLOTHING: it is WORN by the post's person (the style's person, replaced by this brand's ambassador) with its exact print, graphic, colours and cut as photographed; the side that carries the print faces the camera, so a garment printed on the BACK is worn by a person seen from behind or turned three-quarter away, and one printed on the CHEST by a person facing the camera; the print is never moved to the other side, and when the description does not say where it sits, the shot never names a side; it is folded or laid flat only when the style shows nobody. Its print is never redrawn, and no shopping bag, carrier or packaging is added around it."
      : "",
    "THE PRODUCT keeps its real packaging, shape, label and colours, never recoloured; a closed box stays closed and an open one open; real size against hands and furniture; held level or set on a surface; never put into a bag or onto another object. Never add a lid, straw, sleeve, cap or any packaging part the product's photo does not show: where the style shows one (a lid hovering beside the cup), leave it out.",
    "THE STYLE'S OWN STAGING STAYS: a vessel of the style caught mid-pour (a jug, a pitcher, an open cup), a block or pieces of the product's own ingredient, a splash or a ribbon of liquid are staging and stay in the shot, pouring or showing this product's own drink or ingredient; they are plain and unprinted, and they are never a second product.",
    "THE STYLE'S OWN DRINK OR DISH IS THIS PRODUCT: where the style shows a slush in a glass, a cocktail, a bowl or any other food or drink, that is this product in its own packaging, exactly as photographed (a frozen slush in a tall glass becomes this product in its own cup, lid and all); never a drink or dish the brand does not sell, and no straw, garnish or topping the product's photo does not show.",
    // The style is a whole look, its colours included (27 Oct): the month's palette no longer
    // recolours it; the brand's main colour fills the style's own placeholder alone. A campaign's
    // reference keeps the brief's named colours as before.
    r.reference && r.palette.length
      ? `COLOURS: name only these: ${r.palette.join(", ")}. The background is ${r.palette[0]}; props and fabrics take the others.`
      : "COLOURS: keep the style's own colours (its background, surfaces, props, fabrics and light) exactly as its picture shows them; never name the brand's colours and never write a hex code. Where the style says 'the brand's main colour', write 'the same colour as the backdrop of the attached style picture, copied from it'. The product keeps the colours of its own photo.",
    r.people.length
      ? `PEOPLE: only ${r.people.join("; ")}, each as described (their own gender, a man never in a headscarf or dress, modest clothing when their look says so).`
      : r.briefPeople
        ? "PEOPLE: the people the post's idea names appear exactly as the idea describes them (their number, gender, age, modest clothing, a man never in a headscarf or dress), and nobody else."
        : "PEOPLE: nobody appears; a hand is the most the picture shows.",
    r.onlyFood?.trim()
      ? `ONLY THESE INGREDIENTS may appear around or in the product, and nothing else edible (no other spice, garnish, powder, stick, fruit or sweet): ${r.onlyFood.trim()}.`
      : "",
    r.sellsDrinks ? "" : "NEVER a drink, cup, glass, bottle or food that is not the brand's product.",
    r.brand.style?.trim() ? `BRAND STYLE: ${r.brand.style.trim().slice(0, 500)}` : "",
    r.brand.always?.trim() ? `ALWAYS: ${r.brand.always.trim().slice(0, 400)}` : "",
    r.brand.never?.trim() ? `NEVER: ${r.brand.never.trim().slice(0, 400)}` : "",
    "No text, letters or logos in the picture except the product's own printed packaging. Never use the product's file name.",
    'Return ONLY JSON: {"prompt": "the shot", "brief": "the post\'s new idea in one sentence: the style\'s concept with this product and the headline\'s message"}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Pinterest searches that fill the pool, by the kind they mostly bring. */
/** What the daily refresh searches for, by category (the season's words are added on the day). */
export const STYLE_QUERIES: Record<StyleCategory, string[]> = {
  corporate: [
    "creative insurance advertising concept",
    "creative bank advertising campaign surreal",
    "telecom creative ad concept 3d",
    "corporate creative advertising poster concept",
    "exhibition booth design creative 3d render",
    "trade show stand design modern saudi",
  ],
  fashion: ["creative fashion advertising concept surreal", "shoes creative advertising set design", "handbag creative campaign surreal", "fashion product cgi campaign", "kids fashion creative advertising campaign", "activewear creative advertising campaign"],
  food: ["creative food advertising concept surreal", "burger creative advertising cgi", "snack packaging creative campaign", "food product giant scale advertising"],
  drinks: ["creative drink advertising concept", "coffee creative advertising surreal", "juice bottle creative campaign splash", "soft drink can creative cgi ad", "boba tea creative advertising"],
  sweets: ["creative dessert advertising concept", "chocolate box creative ad campaign", "pastry creative advertising surreal", "ice cream creative campaign cgi", "sweets packaging creative photography", "arabic sweets creative advertising", "baklava kunafa product photography premium"],
  lifestyle: ["creative lifestyle product advertising concept", "surreal advertising model holding oversized product", "product in everyday scene surreal ad", "playful product set design advertising"],
  beauty: ["creative skincare advertising concept 3d", "surreal cosmetics product ad", "perfume creative campaign surreal"],
  seasonal: ["ramadan product advertising creative", "eid gift box advertising concept", "winter product advertising surreal", "summer product advertising creative"],
  luxury: ["luxury gift box creative advertising", "premium packaging surreal campaign", "luxury product set design advertising", "jewellery creative campaign surreal"],
  grid: [
    "instagram feed grid aesthetic brand",
    "instagram feed layout cafe brand",
    "instagram grid design food brand",
    "instagram feed planner aesthetic product",
    "skincare brand instagram feed grid",
    "dessert shop instagram feed aesthetic",
    "coffee shop instagram feed design",
    "bakery instagram feed layout",
    "restaurant instagram grid design",
    "juice bar instagram feed aesthetic",
    "chocolate brand instagram feed",
    "ice cream shop instagram grid",
    "burger restaurant instagram feed design",
    "perfume brand instagram feed layout",
    "jewellery brand instagram grid aesthetic",
    "fashion brand instagram feed grid minimal",
    "clothing brand instagram feed design",
    "cosmetics brand instagram feed grid",
    "furniture brand instagram feed aesthetic",
    "real estate instagram feed design",
    "clinic instagram feed layout",
    "gym instagram feed design grid",
    "kids brand instagram feed aesthetic",
    "arabic brand instagram feed design",
    "ramadan instagram feed grid design",
    "instagram feed mockup brand identity",
    "instagram grid puzzle feed design",
    "social media feed design brand grid",
    "instagram feed color palette brand aesthetic",
    "product brand instagram feed 9 posts",
    "kids clothing brand instagram feed",
    "insurance company instagram feed design",
    "arabic sweets instagram feed design",
    "juice bar instagram feed aesthetic",
    "exhibition company instagram feed design",
    "activewear brand instagram feed",
  ],
};

/**
 * The agency's own clients, by kind: the searches that bring photo styles and feed grids for
 * them. The daily refresh draws from these too, so the library keeps growing where it is used.
 */
export const CLIENT_QUERIES: { kind: string; photo: string[]; grid: string[] }[] = [
  {
    kind: "kids fashion",
    photo: ["kids fashion creative advertising campaign", "children clothing brand editorial photography playful", "kids wear surreal ad concept colorful", "toddler outfit product photography studio pastel"],
    grid: ["kids clothing brand instagram feed", "children fashion instagram grid aesthetic", "baby clothes brand instagram feed design"],
  },
  {
    kind: "insurance",
    photo: ["creative insurance advertising concept", "insurance company campaign surreal protection", "family protection ad concept 3d", "car insurance creative ad visual", "health insurance creative campaign poster"],
    grid: ["insurance company instagram feed design", "financial services instagram grid corporate", "insurance brand social media feed layout"],
  },
  {
    kind: "arabic sweets",
    photo: ["arabic sweets creative advertising", "baklava kunafa product photography premium", "oriental sweets box campaign surreal", "middle eastern dessert brand editorial photo", "ramadan sweets gift box advertising"],
    grid: ["arabic sweets instagram feed design", "baklava shop instagram grid", "dessert brand instagram feed arabic", "kunafa shop social media feed"],
  },
  {
    kind: "drinks and juices",
    photo: ["fresh juice creative advertising splash", "coffee creative campaign surreal", "iced coffee product photography bold color", "smoothie brand creative ad fruit explosion", "juice bar advertising concept summer"],
    grid: ["juice bar instagram feed aesthetic", "coffee shop instagram feed design", "fresh juice brand instagram grid", "cafe instagram feed layout colorful"],
  },
  {
    kind: "exhibitions and booths",
    photo: ["exhibition booth design creative 3d render", "trade show stand design modern saudi", "exhibition stand concept premium lighting", "event booth design visualization", "expo pavilion design concept"],
    grid: ["exhibition company instagram feed design", "event agency instagram grid", "booth design studio instagram feed", "architecture visualization instagram feed"],
  },
  {
    kind: "activewear",
    photo: ["activewear creative advertising campaign", "sportswear brand editorial photography studio", "gym wear surreal ad concept", "athleisure product photography bold", "running apparel campaign dynamic motion"],
    grid: ["activewear brand instagram feed", "sportswear instagram grid aesthetic", "fitness apparel instagram feed design", "gym brand instagram feed layout"],
  },
];

/** Words of the season for the daily search (a Jordanian brand's calendar). */
export function seasonWords(date: Date): string[] {
  const m = date.getUTCMonth() + 1;
  const out = [m === 12 || m <= 2 ? "winter" : m <= 5 ? "spring" : m <= 8 ? "summer" : "autumn"];
  const hijri = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { month: "numeric" }).format(date);
  const hm = Number(hijri.replace(/\D/g, ""));
  if (hm === 8 || hm === 9) out.push("ramadan");
  if (hm === 9 || hm === 10) out.push("eid al fitr");
  if (hm === 11 || hm === 12) out.push("eid al adha");
  if (m === 2) out.push("valentine");
  if (m === 12) out.push("christmas new year");
  return out;
}

/** A picture's fingerprint: the pinimg file name, the same for every pin of that picture. */
export function pictureSig(url: string): string | null {
  return /\/([0-9a-f]{32})\.[a-z]+$/i.exec(url)?.[1]?.toLowerCase() ?? null;
}
