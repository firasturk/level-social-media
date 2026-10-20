/**
 * "Do client comments": the client's change requests from the approval page, read by the art
 * director and turned into the posts' new briefs, so the month is made again without the team
 * rewriting anything by hand.
 */
import { matchProduct } from "./posts";

export interface ClientAsk {
  index: number;
  title: string;
  brief: string;
  scene?: string;
  product?: string;
  headline?: string;
  caption: string;
  hashtags: string;
  /** What the client wrote under "Ask for a change" (often Arabic). */
  note: string;
}

export interface ClientChange {
  index: number;
  /** The exact product name the post now shows ("" keeps the post's product). */
  product: string;
  brief: string;
  scene: string;
  headline: string;
  caption: string;
  hashtags: string;
  /** One English sentence on what changed, and any stand-in taken. */
  summary: string;
  /** One general rule for this client's future posts learned from the request, or "" when it teaches nothing general. */
  lesson: string;
}

export const CLIENT_CHANGES_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          product: { type: "string" },
          brief: { type: "string" },
          scene: { type: "string" },
          headline: { type: "string" },
          caption: { type: "string" },
          hashtags: { type: "string" },
          summary: { type: "string" },
          lesson: { type: "string" },
        },
        required: ["index", "product", "brief", "scene", "headline", "caption", "hashtags", "summary", "lesson"],
      },
    },
  },
  required: ["posts"],
};

export function clientChangesInstruction(r: { client: string; asks: ClientAsk[]; products: { name: string; note: string }[] }): string {
  return [
    `You are the art director of a social-media studio. ${r.client}'s client looked at the month's posts on the approval page and asked for changes, often written in Arabic. Apply each request to its post and nothing more.`,
    "RULES:",
    "- Keep the post's idea, composition, setting, light and style exactly as they are; change only what the request asks.",
    "- When the request names another product, pick it from THE PRODUCT PHOTOS below by its exact name and rewrite the brief and the scene so the new product replaces the old one everywhere (its cup, colour, toppings, garnish, ingredients). Never invent a product that has no photo: when the named product has none, take the closest photo and say so plainly in the summary (\"no frappé photo: the Iced Spanish latte stands in\").",
    "- Keep the headline unless the request asks to change the words; keep it short.",
    "- Rewrite the caption and the hashtags for the new product in the same language and tone as before, the caption at most 10 words.",
    "- The brief and the scene are in English, concrete, and never describe words, letters, logos or signs to draw.",
    "- summary: one English sentence on what changed for this post, naming any stand-in.",
    "- lesson: one general rule in English the studio should keep for this client's future posts, read from the request (\"prefers its signature drinks over generic mojitos\", \"no close-ups of the lid\"), or \"\" when the request is about this one post only.",
    `THE PRODUCT PHOTOS (use the exact names):\n${r.products.map((p) => `- ${p.name}${p.note ? `: ${p.note}` : ""}`).join("\n")}`,
    `THE POSTS AND THE CLIENT'S REQUESTS:\n${r.asks
      .map((a) =>
        [
          `Post ${a.index} "${a.title}"`,
          `  product: ${a.product || "(none)"}`,
          `  brief: ${a.brief}`,
          a.scene ? `  scene: ${a.scene}` : "",
          `  headline: ${a.headline || "(none)"}`,
          `  caption: ${a.caption} | hashtags: ${a.hashtags}`,
          `  THE CLIENT ASKS: "${a.note}"`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n")}`,
    'Return ONLY JSON: {"posts": [{"index": 1, "product": "exact name or empty", "brief": "...", "scene": "...", "headline": "...", "caption": "...", "hashtags": "#...", "summary": "...", "lesson": ""}]}.',
  ].join("\n\n");
}

/** The model's answer, one change per asked post, products matched to the real names. */
export function parseClientChanges(raw: unknown, asks: ClientAsk[], products: string[]): ClientChange[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { posts?: unknown }).posts) ? ((raw as { posts: unknown[] }).posts as Record<string, unknown>[]) : [];
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const out: ClientChange[] = [];
  for (const ask of asks) {
    const x = list.find((p) => p && typeof p === "object" && Number((p as { index?: unknown }).index) === ask.index);
    if (!x) continue;
    const product = matchProduct(str(x.product), products) ?? "";
    const brief = str(x.brief).slice(0, 1200) || ask.brief;
    out.push({
      index: ask.index,
      product,
      brief,
      scene: str(x.scene).slice(0, 1500),
      headline: str(x.headline).slice(0, 80) || (ask.headline ?? ""),
      caption: str(x.caption).slice(0, 300) || ask.caption,
      hashtags: str(x.hashtags).slice(0, 300) || ask.hashtags,
      summary: str(x.summary).slice(0, 300),
      lesson: str(x.lesson).slice(0, 300),
    });
  }
  return out;
}
