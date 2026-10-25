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
  /** The plan for this post, in order: which of the studio's tools does what (CLIENT_CHANGE_TOOLS). */
  steps?: ClientStep[];
}

export interface ClientStep {
  tool: ClientToolId;
  /** What to ask the tool, in English: the prompt, the angles, the number of slides. */
  what: string;
}

/**
 * When a step happens: on Apply (the studio writes it, free), asked right after Apply (making the
 * picture again), or run by the team in the editor (each run shows its price before anything is made).
 */
export type ClientToolWhen = "apply" | "after" | "team";

export interface ClientTool {
  id: string;
  label: string;
  /** Where it is in the studio. */
  where: string;
  when: ClientToolWhen;
  /** What it costs, in words. */
  cost: string;
  /** What it is for, told to the art director and shown on the plan. */
  use: string;
  /** It makes the post a carousel (its result is added as the next slides). */
  carousel?: boolean;
}

/**
 * The studio's tools a client's comment can call for, and nothing else: the art director picks from
 * this list, and the plan shows each step with where it is and what it costs (25 Oct). The carousel
 * tools all end with "Add as a carousel" under the tool's result: the post becomes slide 1 and the
 * result the next slides (ten at most), with no further cost.
 */
export const CLIENT_CHANGE_TOOLS = [
  { id: "rewrite", label: "Rewrite the idea and the words", where: "Done by Apply", when: "apply", cost: "Free", use: "The post's shot, product, headline, caption and hashtags rewritten for the comment. Every plan starts here when the idea or the words change." },
  { id: "remake", label: "Make the picture again", where: "Asked after Apply, or Make it again on the card", when: "after", cost: "About $0.13 a picture", use: "A new picture from the rewritten shot: when the product, the scene, the setting or the whole look changes." },
  { id: "ai-edit", label: "Edit AI", where: "Edit picture → Edit AI", when: "team", cost: "One picture-engine edit, price shown first", use: "One change on the current picture, the rest kept: a colour, an object added or taken out, the plate, the light on one side." },
  { id: "words", label: "Words & caption / Text studio", where: "Words & caption, or T on the card", when: "team", cost: "Free", use: "The words on the design: font, size, place, colour of the text, a second line. Nothing is made again." },
  { id: "carousel-variations", label: "Variations → Add as a carousel", where: "Edit picture → AI tools → Magnific Variations → Add as a carousel", when: "team", cost: "Magnific credits, price shown first", use: "Close variations of the same picture (same product, same set, small changes) as the next slides: a carousel that looks like one shoot.", carousel: true },
  { id: "carousel-camera", label: "Change camera → Add as a carousel", where: "Edit picture → AI tools → Magnific Change camera → Add as a carousel", when: "team", cost: "Magnific credits for each angle, price shown first", use: "The same product from other angles (from above, closer, from the left, wider) as the next slides: a product carousel that shows it all round.", carousel: true },
  { id: "carousel-generate", label: "Generate → Add as a carousel", where: "Edit picture → AI tools → Higgsfield Generate → Add as a carousel", when: "team", cost: "Higgsfield credits, price shown first", use: "A new slide from words: a detail, the ingredients, a cut, the product in a hand, a slide with space for text. For slides the picture does not already hold.", carousel: true },
  { id: "restyle", label: "Restyle", where: "Edit picture → AI tools → Magnific Restyle", when: "team", cost: "Magnific credits, price shown first", use: "The same picture in another look or colour mood (a touch of blue, warmer, film). Keeps the picture; it does not make slides." },
  { id: "relight", label: "Relight", where: "Edit picture → AI tools → Relight", when: "team", cost: "Credits, price shown first", use: "New light on the same picture: brighter, warmer, evening, from one side." },
  { id: "replace-bg", label: "Replace background", where: "Edit picture → AI tools → Magnific Replace background", when: "team", cost: "Magnific credits, price shown first", use: "The product kept exactly, set on another surface or background." },
  { id: "retouch", label: "Retouch", where: "Edit picture → AI tools → Magnific Retouch", when: "team", cost: "Magnific credits, price shown first", use: "Small fixes: a crumb, a smudge, an edge, a label." },
  { id: "expand", label: "Expand", where: "Edit picture → AI tools → Expand or Outpaint", when: "team", cost: "Credits, price shown first", use: "More picture around the edges, for a new frame (4:5, 9:16) or room for words." },
  { id: "preset", label: "A Higgsfield preset", where: "Edit picture → Presets", when: "team", cost: "Higgsfield credits, price shown first", use: "A ready ad, poster or product-shot template from Higgsfield, when the client asks for a designed ad look." },
] as const satisfies readonly ClientTool[];

export type ClientToolId = (typeof CLIENT_CHANGE_TOOLS)[number]["id"];
export const clientTool = (id: string): ClientTool | undefined => (CLIENT_CHANGE_TOOLS as readonly ClientTool[]).find((t) => t.id === id);

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
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: { tool: { type: "string", enum: CLIENT_CHANGE_TOOLS.map((t) => t.id) }, what: { type: "string" } },
              required: ["tool", "what"],
            },
          },
        },
        required: ["index", "product", "brief", "scene", "headline", "caption", "hashtags", "summary", "lesson", "steps"],
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
    "- steps: the plan for this post, in order, using ONLY the studio's tools below by their id, each with `what` (in English: what to ask the tool, the prompt, the angles, how many slides). Start with rewrite when the idea or the words change. Use remake only when the picture's subject, product, scene or whole look must change; for one change on the current picture use ai-edit, restyle, relight, replace-bg or retouch instead, and no remake. A carousel request: keep the post as slide 1 and add slides with carousel-camera (other angles of the same product), carousel-variations (close variations of the same shot) or carousel-generate (new slides from words: detail, ingredients, a hand), say how many slides (ten at most in all), and do not remake the post. Words on the design only: words.",
    `THE STUDIO'S TOOLS (id: what it is for):\n${CLIENT_CHANGE_TOOLS.map((t) => `- ${t.id}: ${t.use}`).join("\n")}`,
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
    'Return ONLY JSON: {"posts": [{"index": 1, "product": "exact name or empty", "brief": "...", "scene": "...", "headline": "...", "caption": "...", "hashtags": "#...", "summary": "...", "lesson": "", "steps": [{"tool": "rewrite", "what": "..."}]}]}.',
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
      steps: parseSteps(x.steps),
    });
  }
  return out;
}

/** The plan's steps: only the studio's own tools, in order, at most eight, each named once with its words. */
export function parseSteps(raw: unknown): ClientStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientStep[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const tool = String((x as { tool?: unknown }).tool ?? "").trim();
    if (!clientTool(tool)) continue;
    const what = String((x as { what?: unknown }).what ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    out.push({ tool: tool as ClientToolId, what });
    if (out.length === 8) break;
  }
  return out;
}

/** Whether the plan asks to make the post's picture again (only then is "Generate now" offered after Apply). A plan with no steps (older answers) does. */
export const plansRemake = (c: Pick<ClientChange, "steps">): boolean => !c.steps?.length || c.steps.some((s) => s.tool === "remake");
