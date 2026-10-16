/**
 * The journey reads each screen like a creative lead taking a brief: what was given, what it
 * means for the month, and one rule the ideas writer then follows.
 */
import type { BriefNote, BriefStep } from "./config";

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
    "If the screen says the brand sells a service and has no products, read the service instead: who it is for, the moments it is about and what the pictures can show without a product (people, places, objects of those moments); 'categories' stays []. Otherwise: read the product list like a creative lead. Group the products into kinds by how they are packed or served (for example Gift box, Tin, Tray, Plated pieces, Single piece, Drink): give every product exactly one short kind (1-2 words, Title Case, the same words for the same kind) in 'categories'. In the points say how many of each kind there are, the packaging colours and finishes that dominate, and how each kind is best photographed (a box held or set on a table exactly as packed, a tin carried by its handle, pieces on a plate when the photo shows loose pieces). The logic line says how the month should use these products.",
  brand:
    "Read the brand kit like a creative lead: what the tone of voice, the language, the rules and the identity mean for this month's photos, headlines and captions. Points are concrete do's for the posts. The logic line sums up the brand's voice and look in one instruction.",
  theme:
    "Read the theme of the month like a creative lead: the world of its references (places, light, mood, composition), how the cast ambassadors fit it, and what must be avoided. Points are concrete. The logic line says how every post lives in this theme.",
  colours:
    "Read the chosen colours like an art director next to the product packaging: which colour carries the background (the first one), which colours go to props and fabrics, and where the product packaging needs contrast against the background (for example navy tins on a cream background). Flag any clash. The logic line states the colour rule of the month.",
  shots:
    "Read the shots and props like a photographer planning the shoot with these products: which shots suit which kind of product, which gestures change because the client does not sell what the reference held (no drinks, cups or carriers unless the client sells them), and how the props are placed. Never name a colour that is not in the month's colours. The logic line says how the shots are used across the month.",
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
export function briefLines(brief: Partial<Record<BriefStep, BriefNote>> | undefined): string[] {
  if (!brief) return [];
  const order: BriefStep[] = ["products", "count", "brand", "theme", "colours", "shots"];
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
  strict?: boolean;
  /** A client with no products: the service it offers. */
  service?: string;
}): string {
  return [
    `You are the photographer planning this month's shoot. The month has ${r.posts.length} posts (below, with their type, product, occasion and people). The look comes from ${r.shots.length} reference shots read from Pinterest, which show other brands' items. Write ONE shot per post: 2-4 sentences that a camera crew can shoot.`,
    "For each post pick the reference shot whose place, camera angle and distance, light and gesture fit the post best (vary the references across the month; give its number in \"ref\"), and write the post's own shot in that look: its product, its type, its occasion, its people and its message.",
    "PRODUCTS: each product appears exactly as described: a closed box stays closed with its lid, an open one stays open; never opened, unwrapped or re-packed. Describe it by its kind and look ('the blue and silver gift box of mini tarts'), never by a file name. What a reference's hands held becomes the post's product.",
    "TYPES: a lifestyle post shows the product living in a real moment; a tip or quote post is a calm minimal frame with one large empty area for the words and the product small to one side; a greeting post is built from its occasion's elements (a royal day: no person, no product, an empty dignified frame of space in the upper middle for the official portrait added later); an offer shows exactly its products together; an announcement is bold and simple.",
    "PEOPLE: only the people listed for a post appear, each as described (their own gender and look; a man never wears a headscarf, hijab or dress); a post with no people shows at most a hand.",
    "NEVER write any of these unless a post's own product is one: glass, cup, mug, beverage, drink, juice, coffee, tea, liquid, straw, bottle, carrier, sandwich, snack bar, burger or any food that is not the brand's product.",
    r.palette.length
      ? `COLOURS: name only these colours: ${r.palette.join(", ")}. The background (wall, backdrop, main surface) is ${r.palette[0]}; clothing, fabrics, car paint and props take the other colours. Never name any other colour.`
      : "",
    r.props?.trim() ? `PROPS this month (place them where they fit): ${r.props.trim()}.` : "",
    r.service?.trim()
      ? `THE BRAND SELLS A SERVICE, NOT PRODUCTS: ${r.service.trim()}. The hands hold something of the service's moment (car keys, a phone, a folder, a suitcase, a house key), never a drink or food.`
      : "",
    r.strict ? "Your previous answer still named a drink, glass, cup or other item the brand does not sell. Remove every such item." : "",
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
