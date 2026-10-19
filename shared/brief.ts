/**
 * The journey reads each screen like a creative lead taking a brief: what was given, what it
 * means for the month, and one rule the ideas writer then follows.
 */
import type { BriefNote, BriefStep } from "./config";
import { EDIBLE, NO_PROPS_RULE } from "./posts";

export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    points: { type: "array", items: { type: "string" } },
    logic: { type: "string" },
    categories: {
      type: "array",
      items: {
        type: "object",
        properties: { product: { type: "string" }, category: { type: "string" } },
        required: ["product", "category"],
      },
    },
  },
  required: ["summary", "points", "logic"],
};

const ASK: Record<Exclude<BriefStep, "count">, string> = {
  products:
    "If the screen says the brand sells a service and has no products, read the service instead: who it is for, the moments it is about and what the pictures can show without a product (people, places, objects of those moments); 'categories' stays []. Otherwise: read the product list like a creative lead. Group the products into kinds by how they are packed or served (for example Gift box, Tin, Tray, Plated pieces, Single piece, Drink): give every product exactly one short kind (1-2 words, Title Case, the same words for the same kind) in 'categories'. In the points say how many of each kind there are, the packaging colours and finishes that dominate, and how each kind is best photographed (a box or tin held level with both hands or set on a table exactly as packed, pieces on a plate when the photo shows loose pieces; never in a bag). The logic line says how the month should use these products.",
  brand:
    "Read the brand kit like a creative lead: what the tone of voice, the language, the rules and the identity mean for this month's photos, headlines and captions. Points are concrete do's for the posts. The logic line sums up the brand's voice and look in one instruction.",
  theme:
    "Read the theme of the month like a creative lead: the world of its references (places, light, mood, composition), how the cast ambassadors fit it, and what must be avoided. Points are concrete. The logic line says how every post lives in this theme.",
  colours:
    "Read the chosen colours like an art director next to the product packaging: which colour carries the background (the first one), which colours go to props and fabrics, and where the product packaging needs contrast against the background (for example navy tins on a cream background). Flag any clash. The logic line states the colour rule of the month.",
  shots:
    "Read the shots and props like a photographer planning the shoot with these products: which shots suit which kind of product, which gestures change because the client does not sell what the reference held (no drinks, cups or carriers unless the client sells them), and how the props from the screen's PROPS line are placed (when it says none, the month has no props: never suggest any, no blocks, beads, fabrics or decorations). Never name a colour that is not in the month's colours. The logic line says how the shots are used across the month.",
};

export function briefInstruction(step: Exclude<BriefStep, "count">, context: string): string {
  return [
    "You are the creative lead of a design agency taking a social-media brief from a designer, one screen at a time. Write what you understood from this screen, in English, short and concrete:",
    "summary: one or two sentences (max 220 characters). points: 3-5 short bullet points (each max 140 characters). logic: one instruction (max 260 characters) that the writer of the month's posts must follow because of this screen.",
    ASK[step],
    `THE SCREEN:\n${context}`,
    'Return ONLY JSON: {"summary": "...", "points": ["..."], "logic": "..."' + (step === "products" ? ', "categories": [{"product": "...", "category": "..."}]' : "") + "}.",
  ].join("\n\n");
}

export function parseBrief(raw: unknown): Omit<BriefNote, "at"> & { categories: { product: string; category: string }[] } {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const points = Array.isArray(d.points)
    ? (d.points as unknown[]).map((p) => String(p ?? "").trim()).filter(Boolean).slice(0, 6).map((p) => p.slice(0, 220))
    : [];
  const categories = Array.isArray(d.categories)
    ? (d.categories as { product?: unknown; category?: unknown }[])
        .map((c) => ({ product: String(c?.product ?? "").trim(), category: String(c?.category ?? "").trim().slice(0, 30) }))
        .filter((c) => c.product && c.category)
    : [];
  return {
    summary: String(d.summary ?? "").trim().slice(0, 400),
    points,
    logic: String(d.logic ?? "").trim().slice(0, 400),
    categories,
  };
}

/** The logic lines of the steps done so far, in journey order. */
export function briefLines(brief: Partial<Record<BriefStep, BriefNote>> | undefined, without: BriefStep[] = []): string[] {
  if (!brief) return [];
  const order = (["products", "count", "brand", "theme", "colours", "shots"] as BriefStep[]).filter((k) => !without.includes(k));
  return order.map((k) => brief[k]?.logic?.trim() ?? "").filter(Boolean);
}

export const SHOTS_SCHEMA = {
  type: "object",
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: { post: { type: "integer" }, ref: { type: "integer" }, shot: { type: "string" } },
        required: ["post", "ref", "shot"],
      },
    },
  },
  required: ["shots"],
};

/** One planned post as the photographer reads it. */
export interface ShotPost {
  index: number;
  type: string;
  /** What the type asks of the picture. */
  typeRule: string;
  /** The product(s) in the picture, by kind and look. */
  products: string[];
  occasion?: { name: string; elements: string; portrait?: boolean };
  /** Cast ambassadors in the picture, with their look (gender included). */
  people: string[];
  headline: string;
  brief: string;
}

/** What a reference held that this client does not sell: it never reaches a month's shot. */
export const FOREIGN_ITEMS =
  /\b(glass(es)?|cups?|mugs?|beverages?|drinks?|juices?|coffee|tea|latte|smoothies?|milkshakes?|liquids?|straws?|sandwich(es)?|snack bars?|burgers?|pizzas?|fries|bottles?|cup carriers?|wine|cocktails?)\b/i;

/**
 * The month's shoot list: one shot per planned post, in the look of the pins. Each post takes the
 * pin whose place, camera and gesture fit it best and becomes a shot of its own product, type,
 * occasion and people, in the month's colours.
 */
export function adaptShotsInstruction(r: {
  shots: string[];
  posts: ShotPost[];
  palette: string[];
  props?: string;
  /** True, or the edible items the previous answer invented, when it is asked again. */
  strict?: boolean | string;
  /** A client with no products: the service it offers. */
  service?: string;
  /** Mistakes the review found in this client's earlier pictures: no shot leads to them again. */
  lessons?: string[];
}): string {
  return [
    `You are the photographer planning this month's shoot. The month has ${r.posts.length} posts (below, with their type, product, occasion and people). The look comes from ${r.shots.length} reference shots read from Pinterest, which show other brands' items. Write ONE shot per post: 2-4 sentences that a camera crew can shoot.`,
    "For each post pick the reference shot whose place, camera angle and distance, light and gesture fit the post best (vary the references across the month; give its number in \"ref\"), and write the post's own shot in that look: its product, its type, its occasion, its people and its message.",
    "PRODUCTS: each product appears exactly as described, in its own colours (never recoloured to the palette): a closed box stays closed with its lid, an open one stays open; never opened, unwrapped or re-packed. Describe it by its kind and look ('the blue and silver gift box of mini tarts'), never by a file name. What a reference's hands held becomes the post's product.",
    "NOTHING ADDED TO THE PRODUCT: its toppings, fill, cream, nuts, fruit, sauce and colours are exactly those in its description; never write a topping, drizzle, syrup, sauce, sprinkles, garnish, fruit, cookie, pastry or any edible item that the description does not name, on the product or beside it. The food, pastries, fruit, cookies, cups and toppings a reference or a tile shows belong to another brand: the post's product takes their place, and they are never written.",
    "SIZE AND GRIP: each product keeps its real size against hands and furniture (a box or tin about a forearm wide, one piece between two fingers) and is held level with both hands from below or set on a surface; never balanced on fingertips, hung from a finger, pinched at a rim, put into a bag, a basket or a carrier, or set on top of another object.",
    "TYPES: a lifestyle post shows the product living in a real moment; a tip or quote post is a calm minimal frame with one large empty area for the words and the product small to one side; a greeting post is built from its occasion's elements (a royal day: no person, no product, an empty dignified frame of space in the upper middle for the official portrait added later); an offer shows exactly its products together; an announcement is bold and simple.",
    r.posts.some((p) => p.products.some((x) => /\b(sweatshirt|hoodie|t-?shirt|tee|shirt|dress|skirt|jeans|trousers|pants|shorts|jacket|abaya|outfit|garment|clothing|wear)\b/i.test(x)))
      ? "A CLOTHING BRAND: every person in a shot wears one of that post's products (one garment per person), with the printed side in view; a person with no garment to wear is left out of the shot. The rest of the outfit is plain and unprinted. The graphic is described exactly as the product's description words it (a printed graphic is printed, never embroidered) and never redesigned or recoloured. Every shot with a person gets a different pose and action from the other shots (walking, a lunge, a stretch, sitting, mid-jump, from behind, tying a shoe…): never the same standing pose twice. The print sits where the product's description says: a back print means the person is seen from behind, a chest print means they face the camera, and when the description does not say, the shot never names a side."
      : "",
    "PEOPLE: only the people listed for a post appear, each as described (their own gender and look; a man never wears a headscarf, hijab or dress; a woman wears a hijab only when her look says so), dressed as their look says (modest clothing when it says so: no bare shoulders, sleeveless tops, low necklines or short skirts); a post with no people shows at most a hand.",
    "NEVER write any of these unless a post's own product is one: glass, cup, mug, beverage, drink, juice, coffee, tea, liquid, straw, bottle, carrier, sandwich, snack bar, burger or any food that is not the brand's product.",
    r.palette.length
      ? `COLOURS: name only these colours: ${r.palette.join(", ")}. The background (wall, backdrop, main surface) is ${r.palette[0]}; ${r.props?.trim() ? "clothing, fabrics, car paint and props" : "clothing, surfaces and car paint"} take the other colours. Never name any other colour.`
      : "",
    r.props?.trim() ? `PROPS this month (place them where they fit): ${r.props.trim()}.` : NO_PROPS_RULE,
    r.service?.trim()
      ? `THE BRAND SELLS A SERVICE, NOT PRODUCTS: ${r.service.trim()}. The hands hold something of the service's moment (car keys, a phone, a folder, a suitcase, a house key), never a drink or food.`
      : "",
    r.lessons?.length
      ? `MISTAKES SEEN IN THIS CLIENT'S EARLIER PICTURES (the review rejected them; write no shot that leads to them again):\n${r.lessons.map((l) => `- ${l}`).join("\n")}`
      : "",
    r.strict
      ? `Your previous answer still named ${typeof r.strict === "string" ? `food, drink or toppings the brand's products do not have (${r.strict})` : "a drink, glass, cup or other item the brand does not sell"}. Remove every such item: the product stands there by itself.`
      : "",
    `THE POSTS:\n${r.posts
      .map(
        (p) =>
          `Post ${p.index} (${p.type}: ${p.typeRule})${p.products.length ? `; product: ${p.products.join(" + ")}` : "; no product"}${p.occasion ? `; occasion: ${p.occasion.name}, built from ${p.occasion.elements}${p.occasion.portrait ? " (royal day: no person, no product, empty frame for the official portrait)" : ""}` : ""}${p.people.length ? `; people: ${p.people.join("; ")}` : "; no people"}; headline "${p.headline}"; idea: ${p.brief}`,
      )
      .join("\n")}`,
    `THE REFERENCE SHOTS:\n${r.shots.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    `Return ONLY JSON: {"shots": [{"post": 1, "ref": 3, "shot": "..."}, ...]} with exactly one entry per post.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The edible words a shot names that its post's products do not have (their names and photo
 * descriptions): what the writer invented from a reference or a tile.
 */
export function foreignFood(shot: string, allowed: string): string[] {
  // "corn flakes" and "cornflakes" are one word; a generic word (drink, snack) names no item.
  const squash = (t: string) => t.toLowerCase().replace(/[\s-]+/g, "");
  const ok = squash(allowed);
  const out = new Set<string>();
  for (const m of shot.matchAll(EDIBLE)) {
    const w = m[0].toLowerCase();
    if (GENERIC_FOOD.test(w)) continue;
    const stem = squash(w).replace(/(?:ies|es|s)$/, "");
    if (!ok.includes(stem.slice(0, Math.max(3, stem.length - 1)))) out.add(w);
  }
  return [...out];
}

/** Words that name a kind, not an item: a milkshake is a drink, a cup of nuts is a snack. */
const GENERIC_FOOD = /^(?:drinks?|beverages?|snacks?|sweets?|candy|candies|food|toppings?|garnish|spices?|seeds?|beans?)$/i;
