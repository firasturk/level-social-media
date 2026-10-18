/**
 * The style gallery ("pick your style"): product-photo styles read from Pinterest pins. Each style
 * is written for any product; picking one for a post rewrites it for that post's real product,
 * its ingredients, the brand and the month's colours.
 */
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
  /** The client a suggested grid was found for. */
  client?: string;
  /** Still waiting for the admin's approval (shown to the admin picking a month's grid). */
  waiting?: boolean;
  /** In the collection of the client the list was asked for ("Add to Habibah's"). */
  saved?: boolean;
}

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
  },
  required: ["keep", "score", "kind", "category", "title", "tags", "prompt"],
};

/** The vision model reads one pin into a reusable style (or a fresh variation of one). */
export function describeStyleInstruction(note: string, previous?: { title: string; prompt: string }): string {
  return [
    "You are a senior product photographer building a library of photo styles that any brand's product can be shot in. The image is a pin from Pinterest.",
    note.trim() ? `The pin's own title and description (may hold a written prompt, in any language): ${note.trim().slice(0, 1500)}` : "",
    "keep: true only when the image is one photograph (or one main photograph) of a product, or of a person with a product, in a style another product could be shot in (studio packshot, splash, levitation, ingredients, still life, lifestyle). keep is false for: collages of several photos, text-only cards, screenshots, charts, before/after, drawings; a picture with no product in it (only fabric, a backdrop or a shadow); a product inside a bag, net, basket, carrier or shopping trolley; alcohol; and any person in clothes unsuitable for a Middle Eastern family brand (bare shoulders, sleeveless or strapless tops, low necklines, crop tops, short skirts or shorts, swimwear) or making a silly or rude face (tongue out).",
    STYLE_BAR,
    "score: 1-10, how far this pin reaches the bar (9-10: as bold and original as the team's picks; 7-8: a strong concept; 4-6: a nice but ordinary product photo; 1-3: catalogue or stock).",
    'kind: "people" when a person, or hands and arms that are part of the style, hold, use or present the product; otherwise "product".',
    'category: the shelf it belongs on, by what the pin advertises: "corporate" (banks, insurance, telecom, tech, services, B2B), "fashion" (clothes, shoes, bags, accessories), "food" (meals, snacks, savoury food), "drinks" (coffee, juice, soft drinks, milkshakes, any beverage), "sweets" (desserts, chocolate, pastries, sweets, ice cream), "lifestyle" (home, everyday products, people living with a product), "beauty" (skincare, cosmetics, perfume, care), "seasonal" (an occasion or season: Ramadan, Eid, winter, summer, Valentine), "luxury" (premium gifts, jewellery, high-end boxes).',
    'title: 2-3 words naming the idea, like a product-shot preset ("Claw Machine Grab", "Cloud Swing", "Fridge Stash", "Balloon Lift", "Giant In The City").',
    "tags: 3-5 short words, comma separated (surface, effect, mood).",
    "prompt: a reusable photo prompt in English, 110-190 words, for ANY product, that keeps the pin's IDEA (the surprising scale, object or set piece) as its heart. Write 'the product' for the item. Describe: camera angle and distance; how the product sits, stands, floats or is held; the set and surface; the props and how they are arranged; effects (splash, condensation, frost, smoke, light beams); the light (direction, hardness, colour); the background (write 'the brand's main colour' where the pin uses a strong single colour); depth of field and lens; the mood. Where the pin shows a flavour or ingredient (raspberries, citrus slices, coffee beans), write 'the product's own key ingredients' (for example 'pieces of the product's own key ingredients frozen inside crystal-clear ice cubes'), never a specific fruit, food or brand. For a person write 'the brand ambassador' with pose, hands, framing and modest clothing, never a specific face. No text, logos or brand names in the picture. Use a written prompt on the pin as inspiration only; write your own.",
    previous
      ? `This style already exists as "${previous.title}": ${previous.prompt}\nWrite a FRESH variation of the same idea: keep what makes the style recognisable, change the camera angle, the arrangement or the set so it reads new. Keep the same kind.`
      : "",
    'Return ONLY JSON: {"keep": true, "score": 8, "kind": "product", "category": "sweets", "title": "...", "tags": "...", "prompt": "..."}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseStyle(raw: unknown): { keep: boolean; score: number; kind: StyleKind; category: StyleCategory; title: string; tags: string; prompt: string } {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = String(d.prompt ?? "").trim().slice(0, 2000);
  const title = String(d.title ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 60);
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  return {
    keep: d.keep !== false && prompt.length > 40 && !!title && score >= MIN_SCORE,
    score,
    kind: d.kind === "people" ? "people" : "product",
    category: PHOTO_CATEGORY_IDS.includes(d.category as StyleCategory) ? (d.category as StyleCategory) : "lifestyle",
    title,
    tags: String(d.tags ?? "").trim().slice(0, 120),
    prompt,
  };
}

/* ───────────── Grids: whole Instagram feeds a month follows ───────────── */

/** A grid enters the library from this score (a feed is judged as a month's plan, not one ad). */
export const GRID_MIN_SCORE = 7;

export const GRID_STYLE_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    score: { type: "integer" },
    title: { type: "string" },
    tags: { type: "string" },
    tiles: { type: "integer" },
    prompt: { type: "string" },
  },
  required: ["keep", "score", "title", "tags", "tiles", "prompt"],
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
    "prompt: 120-200 words in English for ANY brand: first the feed's world (palette written as 'the brand's main colour' and named neutrals, light, sets, materials, camera habits), then its rhythm tile by tile in reading order, one short line each (\"1 product hero on a plinth, 2 lifestyle with the brand ambassador, 3 calm text tile\"). Write 'the product' for the item; never a brand name, a logo or a specific food.",
    previous
      ? `This grid already exists as "${previous.title}": ${previous.prompt}\nWrite it again as a FRESH reading: the same feed, described anew.`
      : "",
    'Return ONLY JSON: {"keep": true, "score": 8, "title": "...", "tags": "...", "tiles": 9, "prompt": "..."}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseGridStyle(raw: unknown): { keep: boolean; score: number; title: string; tags: string; tiles: number; prompt: string } {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = String(d.prompt ?? "").trim().slice(0, 2000);
  const title = String(d.title ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 60);
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  const tiles = Math.max(0, Math.min(30, Math.round(Number(d.tiles) || 0)));
  return {
    keep: d.keep !== false && prompt.length > 40 && !!title && score >= GRID_MIN_SCORE && tiles >= 6,
    score,
    title,
    tags: String(d.tags ?? "").trim().slice(0, 120),
    tiles,
    prompt,
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
  sellsDrinks?: boolean;
  /** The brand sells a service, not products. */
  service?: string;
  /** The month's theme (its world and mood), for the feel of the set only. */
  theme?: string;
}

/** The style rewritten for one post's real product: its ingredients, packaging, colours and people. */
/** A garment: worn in the picture, never handled like a box or a plate. */
export const CLOTHING =
  /\b(sweatshirt|sweater|hoodie|t-?shirt|tee|shirt|blouse|top|dress|skirt|jeans|trousers|pants|shorts|leggings|jacket|coat|abaya|kaftan|thobe|jumpsuit|romper|onesie|pyjamas?|pajamas?|activewear|sportswear|tracksuit|socks|sneakers|shoes|boots|cap|beanie|scarf|outfit|garment|clothing|clothes|wear)\b/i;
export function isClothing(text: string): boolean {
  return CLOTHING.test(text);
}

export function adaptStyleInstruction(r: AdaptRequest): string {
  return [
    `You are the photographer of ${r.brand.name}, shooting one post in a style picked from the library. Write the final shot for the image engine: 3-6 concrete sentences.`,
    `THE STYLE "${r.style.title}": ${r.style.prompt}`,
    r.service?.trim()
      ? `THE BRAND SELLS A SERVICE, NOT PRODUCTS: ${r.service.trim()}. Replace 'the product' with an object of the service's moment (keys, a phone, a folder), never a drink or food.`
      : `THE PRODUCT (as photographed): ${r.product || "the brand's product"}${r.category ? ` (kind: ${r.category})` : ""}.`,
    `THE POST (${r.post.type}): headline "${r.post.headline}". Its earlier idea (for its message only, never its picture): ${r.post.brief}`,
    "THE STYLE'S OWN IDEA REPLACES THE EARLIER ONE: the picture is the style's concept, done with this brand's product. Nothing of the earlier idea's staging is carried over: none of its gestures, props, objects or poses (no cups held to the eyes, no extra cups, bags or boxes); the product appears only the way the style shows it, once unless the style itself repeats it.",
    "KEEP the style's camera angle, composition, set, effects and light: the picture must read as this style.",
    r.theme?.trim() ? `THE MONTH'S THEME (its mood for the set, never more products): ${r.theme.trim().slice(0, 400)}` : "",
    "INGREDIENTS: replace 'the product's own key ingredients' and every generic ingredient with this product's real ingredients and flavours as its description shows them (for example pistachios, kunafa threads, sesame, rose petals, dates), never ones it does not have. An effect built on an ingredient keeps working with the real one (raspberries frozen in ice become pistachios frozen in ice).",
    isClothing(`${r.product} ${r.category ?? ""}`)
      ? "THE PRODUCT IS CLOTHING: it is WORN by the post's person (the style's person, replaced by this brand's ambassador) with its exact print, graphic, colours and cut as photographed, the printed side facing the camera; it is folded or laid flat only when the style shows nobody. Its print is never redrawn, and no shopping bag, carrier or packaging is added around it."
      : "",
    "THE PRODUCT keeps its real packaging, shape, label and colours, never recoloured; a closed box stays closed and an open one open; real size against hands and furniture; held level or set on a surface; never put into a bag or onto another object.",
    r.palette.length
      ? `COLOURS: name only these: ${r.palette.join(", ")}. The background is ${r.palette[0]}; props and fabrics take the others.`
      : "",
    r.people.length
      ? `PEOPLE: only ${r.people.join("; ")}, each as described (their own gender, a man never in a headscarf or dress, modest clothing when their look says so).`
      : "PEOPLE: nobody appears; a hand is the most the picture shows.",
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
