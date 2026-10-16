/**
 * The style gallery ("pick your style"): product-photo styles read from Pinterest pins. Each style
 * is written for any product; picking one for a post rewrites it for that post's real product,
 * its ingredients, the brand and the month's colours.
 */
export const STYLE_KINDS = ["product", "people"] as const;
export type StyleKind = (typeof STYLE_KINDS)[number];

/** How many styles of each kind the gallery shows. */
export const STYLE_TARGET: Record<StyleKind, number> = { product: 50, people: 20 };

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
}

export const STYLE_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    score: { type: "integer" },
    kind: { type: "string", enum: ["product", "people"] },
    title: { type: "string" },
    tags: { type: "string" },
    prompt: { type: "string" },
  },
  required: ["keep", "score", "kind", "title", "tags", "prompt"],
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
    'title: 2-3 words naming the idea, like a product-shot preset ("Claw Machine Grab", "Cloud Swing", "Fridge Stash", "Balloon Lift", "Giant In The City").',
    "tags: 3-5 short words, comma separated (surface, effect, mood).",
    "prompt: a reusable photo prompt in English, 110-190 words, for ANY product, that keeps the pin's IDEA (the surprising scale, object or set piece) as its heart. Write 'the product' for the item. Describe: camera angle and distance; how the product sits, stands, floats or is held; the set and surface; the props and how they are arranged; effects (splash, condensation, frost, smoke, light beams); the light (direction, hardness, colour); the background (write 'the brand's main colour' where the pin uses a strong single colour); depth of field and lens; the mood. Where the pin shows a flavour or ingredient (raspberries, citrus slices, coffee beans), write 'the product's own key ingredients' (for example 'pieces of the product's own key ingredients frozen inside crystal-clear ice cubes'), never a specific fruit, food or brand. For a person write 'the brand ambassador' with pose, hands, framing and modest clothing, never a specific face. No text, logos or brand names in the picture. Use a written prompt on the pin as inspiration only; write your own.",
    previous
      ? `This style already exists as "${previous.title}": ${previous.prompt}\nWrite a FRESH variation of the same idea: keep what makes the style recognisable, change the camera angle, the arrangement or the set so it reads new. Keep the same kind.`
      : "",
    'Return ONLY JSON: {"keep": true, "score": 8, "kind": "product", "title": "...", "tags": "...", "prompt": "..."}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseStyle(raw: unknown): { keep: boolean; score: number; kind: StyleKind; title: string; tags: string; prompt: string } {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = String(d.prompt ?? "").trim().slice(0, 2000);
  const title = String(d.title ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 60);
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)));
  return {
    keep: d.keep !== false && prompt.length > 40 && !!title && score >= MIN_SCORE,
    score,
    kind: d.kind === "people" ? "people" : "product",
    title,
    tags: String(d.tags ?? "").trim().slice(0, 120),
    prompt,
  };
}

export const ADAPT_SCHEMA = {
  type: "object",
  properties: { prompt: { type: "string" } },
  required: ["prompt"],
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
}

/** The style rewritten for one post's real product: its ingredients, packaging, colours and people. */
export function adaptStyleInstruction(r: AdaptRequest): string {
  return [
    `You are the photographer of ${r.brand.name}, shooting one post in a style picked from the library. Write the final shot for the image engine: 3-6 concrete sentences.`,
    `THE STYLE "${r.style.title}": ${r.style.prompt}`,
    r.service?.trim()
      ? `THE BRAND SELLS A SERVICE, NOT PRODUCTS: ${r.service.trim()}. Replace 'the product' with an object of the service's moment (keys, a phone, a folder), never a drink or food.`
      : `THE PRODUCT (as photographed): ${r.product || "the brand's product"}${r.category ? ` (kind: ${r.category})` : ""}.`,
    `THE POST (${r.post.type}): headline "${r.post.headline}"; idea: ${r.post.brief}`,
    "KEEP the style's camera angle, composition, set, effects and light: the picture must read as this style.",
    "INGREDIENTS: replace 'the product's own key ingredients' and every generic ingredient with this product's real ingredients and flavours as its description shows them (for example pistachios, kunafa threads, sesame, rose petals, dates), never ones it does not have. An effect built on an ingredient keeps working with the real one (raspberries frozen in ice become pistachios frozen in ice).",
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
    'Return ONLY JSON: {"prompt": "..."}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Pinterest searches that fill the pool, by the kind they mostly bring. */
export const STYLE_QUERIES: Record<StyleKind, string[]> = {
  product: [
    "creative product advertising concept surreal",
    "giant product in city ad cgi",
    "product on swing clouds advertising",
    "claw machine product advertising",
    "product in fridge creative advertising",
    "product balloons sky advertising",
    "surreal product photography concept pink",
    "nano banana pro product concept prompt",
    "oversized product surreal campaign",
    "product tied rope creative ad",
    "creative skincare advertising concept 3d",
    "playful product set design advertising",
  ],
  people: [
    "surreal fashion advertising product model",
    "creative campaign model holding oversized product",
    "model monochrome set product advertising",
    "playful advertising concept person product balloons",
    "editorial product campaign surreal person",
  ],
};
