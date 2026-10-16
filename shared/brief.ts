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
    "Read the product list like a creative lead. Group the products into kinds by how they are packed or served (for example Gift box, Tin, Tray, Plated pieces, Single piece, Drink): give every product exactly one short kind (1-2 words, Title Case, the same words for the same kind) in 'categories'. In the points say how many of each kind there are, the packaging colours and finishes that dominate, and how each kind is best photographed (a box opened on a table, a tin carried by its handle, pieces on a plate). The logic line says how the month should use these products.",
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
  properties: { shots: { type: "array", items: { type: "string" } } },
  required: ["shots"],
};

/** What a reference held that this client does not sell: it never reaches a month's shot. */
export const FOREIGN_ITEMS =
  /\b(glass(es)?|cups?|mugs?|beverages?|drinks?|juices?|coffee|tea|latte|smoothies?|milkshakes?|liquids?|straws?|sandwich(es)?|snack bars?|burgers?|pizzas?|fries|bottles?|cup carriers?|wine|cocktails?)\b/i;

/**
 * The pins' shots rewritten as this month's shoot: same place, camera, light and gesture, with the
 * client's own products in the hands and on the tables, and only the month's colours.
 */
export function adaptShotsInstruction(r: {
  shots: string[];
  products: string[];
  palette: string[];
  props?: string;
  strict?: boolean;
}): string {
  return [
    `You are the photographer planning this month's shoot for a brand. Below are ${r.shots.length} shots read from Pinterest references. The references show other brands' items (drinks, glasses, cups, snacks, sandwiches...). Rewrite every shot for THIS brand's products, in the same order, one shot per entry, 2-4 sentences each.`,
    "Keep from each reference shot: the place and surfaces, the camera angle and distance, the light, the framing, the gesture of the hands or the person, the composition and the calm space left for a headline.",
    "Replace whatever the reference shows or holds with one of the brand's products, choosing the product whose kind fits the gesture naturally: a gift box opened on a table or held in both hands, a tin carried by its handle or held against the body, one piece lifted between the fingers, a tray on a surface. Describe the product by its kind and look (for example 'the blue and silver gift box of mini tarts'), never by a file name or number.",
    "NEVER write any of these unless the brand's products listed below are one: glass, cup, mug, beverage, drink, juice, coffee, tea, liquid, straw, bottle, can, carrier, sandwich, snack bar, burger or any food that is not the brand's product. A hand that held a glass now holds the product.",
    r.palette.length
      ? `COLOURS: name only these colours: ${r.palette.join(", ")}. The background (wall, backdrop, main surface) is ${r.palette[0]}; clothing, fabrics, car paint and props take the other colours. Never name any other colour (no red sleeve, no crimson velvet).`
      : "",
    r.props?.trim() ? `PROPS this month (place them where they fit): ${r.props.trim()}.` : "",
    r.strict ? "Your previous answer still named a drink, glass, cup or other item the brand does not sell. Remove every such item." : "",
    `THE BRAND'S PRODUCTS:\n${r.products.join("\n") || "(no products: show the brand's world without objects in the hands)"}`,
    `THE REFERENCE SHOTS:\n${r.shots.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    `Return ONLY JSON: {"shots": ["...", ...]} with exactly ${r.shots.length} entries.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
