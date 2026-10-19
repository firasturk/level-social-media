/**
 * A campaign brief: the designer's own plan for a product (a carousel that reveals it slide by
 * slide, a series of posts on one product, a single post) with reference pictures. The planner
 * turns it into posts; the reference pictures become private styles the posts follow.
 */
import { CAPTION_WORDS, matchProduct, POST_TYPES, type Post, type PostType } from "./posts";

export type GroupKind = "carousel" | "series";

export interface PostGroup {
  id: string;
  kind: GroupKind;
  /** 1-based position in the group and the group's size. */
  slide: number;
  of: number;
  /** What the slide does in a carousel: teaser, ingredients, reveal, detail… */
  role?: string;
}

export const BRIEF_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          group: { type: "string" },
          slide: { type: "integer" },
          of: { type: "integer" },
          role: { type: "string" },
          title: { type: "string" },
          headline: { type: "string" },
          subline: { type: "string" },
          brief: { type: "string" },
          product: { type: "string" },
          products: { type: "array", items: { type: "string" } },
          ingredients: { type: "string" },
          exact: { type: "boolean" },
          reference: { type: "integer" },
          caption: { type: "string" },
          hashtags: { type: "string" },
        },
        required: ["type", "group", "slide", "of", "role", "title", "headline", "subline", "brief", "product", "products", "ingredients", "exact", "reference", "caption", "hashtags"],
      },
    },
  },
  required: ["summary", "posts"],
};

export function briefPlanInstruction(r: {
  client: string;
  brief: string;
  month: string;
  /** The month's product photos: exact names and what each shows. */
  products: { name: string; note: string }[];
  /** How many reference pictures are attached (numbered in order). */
  references: number;
  brand: { style?: string; tone?: string; dos?: string; donts?: string };
  language: "ar" | "en" | "both";
  /** Posts already in the month: the new ones come after them. */
  existing: number;
}): string {
  const lang = r.language === "ar" ? "Arabic (Levantine, friendly)" : r.language === "en" ? "English" : "Arabic with an English line where natural";
  return [
    `You are the creative director of "${r.client}" planning posts for ${r.month} from the designer's brief below. Turn the brief into a precise post plan: the designer wrote what they want; you make every slide concrete, in order, and never add posts the brief does not ask for.`,
    `THE BRIEF:\n${r.brief.trim()}`,
    r.references
      ? `${r.references === 1 ? "The attached image is the reference" : `The ${r.references} attached images are the references`} the brief talks about, numbered in order. Every post names the reference it follows ("reference": 1..${r.references}, or 0 for none). Read what makes it work (light, composition, scale, mood) and describe each slide so a photographer could shoot it in that style with THIS brand's product.`
      : "No reference image is attached: describe each picture from the brief and the brand's style.",
    r.products.length
      ? `THE PRODUCT PHOTOS OF THE MONTH (use the exact names; "product" is the one the picture shows, "" when the picture shows no product, for example an ingredients slide). When the brief's product is NOT among these photos (a new product not uploaded yet), never stand another product in for it: write product "" on its slides and say in the summary exactly which photo the designer must upload, then the slides are matched when it arrives:\n${r.products.map((p) => `- ${p.name}${p.note ? `: ${p.note}` : ""}`).join("\n")}`
      : "No product photo is uploaded yet: write the posts with product \"\" and say in the summary which product photos the designer must upload.",
    [
      "GROUPS:",
      '- "carousel": slides of ONE Instagram carousel, posted together; the same visual style on every slide, different information on each; group them with the same slide numbering (slide 1..N of N) and give each a role (teaser, ingredients, reveal, detail, offer, cta).',
      '- "series": several separate feed posts on the SAME product side by side, each a different visual (another angle, set, scale or moment), same style; slide 1..N of N.',
      '- "single": one post on its own (slide 1 of 1).',
      '- A SEPARATOR (when the brief asks for one between carousels or posts): a single post with role "separator", type "quote", product "", exact false; its picture is a full-frame TEXTURE of the brand\'s own world, never a plain colour: its ingredients and foods close up filling the frame (fruit pieces and whole fruit, berries, chocolate, marshmallows, coffee beans, crushed ice, as the brand sells) or a material of its world (its cups\' texture, wood, linen, marble), softly lit, with a calmer third of the frame for the words; no cup, packaging or logo in the picture. Its headline is a short line from the brief or the brand\'s tagline.',
      "INGREDIENTS AROUND THE PRODUCT: on every post, \"ingredients\" lists the product's OWN ingredients that appear around or in the picture (from its description and name: mango pieces for a mango drink, strawberries for a strawberry drink, chili only for a chili product), or \"\" when nothing edible is around it. A reference's ingredients are never carried over to a product that does not have them: a chili beside a mango drink becomes mango pieces, lychees beside a strawberry drink become strawberries. The brief never names an ingredient the product does not have.",
      "exact: true ONLY when the brief itself says the product must stay the real photo (no AI replacement), and then only on slides where it stands on a surface whole and closed; never on a slide where a hand holds it, where it is open, splashing, pouring or in the air, and never when the brief does not ask for it (exact: false by default).",
      "An ingredients slide (no cup, no packaging) names the ingredients in \"ingredients\" exactly as the brief lists them, and nothing the brief does not mention; product stays \"\".",
      "A teaser slide hints at the product without revealing it whole (a part of the cup, a silhouette, the ingredients gathering).",
    ].join("\n"),
    [
      "FOR EACH POST:",
      `- type: one of ${POST_TYPES.filter((t) => t !== "offer" && t !== "greeting").join(", ")}.`,
      "- title: 2-4 words for the designer.",
      "- headline: the TEXT ON DESIGN. When the brief gives the text for a slide, copy it EXACTLY, letter for letter, same language; otherwise write it yourself, at most 6 words.",
      "- subline: a second short line or \"\".",
      "- brief: the picture in 3-5 concrete sentences: set, light, camera angle and distance, what is in frame and where, how the product or the ingredients are staged, the mood; in the reference's style. No words, signs or typography described in the picture (the headline is added later). Nothing added to the product that the brief does not say.",
      `- caption: at most ${CAPTION_WORDS} words in ${lang}; hashtags: 5-8 with #.`,
    ].join("\n"),
    r.brand.style?.trim() ? `BRAND STYLE: ${r.brand.style.trim().slice(0, 500)}` : "",
    r.brand.tone?.trim() ? `TONE: ${r.brand.tone.trim().slice(0, 300)}` : "",
    r.brand.dos?.trim() ? `ALWAYS: ${r.brand.dos.trim().slice(0, 300)}` : "",
    r.brand.donts?.trim() ? `NEVER: ${r.brand.donts.trim().slice(0, 300)}` : "",
    `The month already has ${r.existing} post${r.existing === 1 ? "" : "s"}; yours come after them.`,
    'Return ONLY JSON: {"summary": "one or two sentences on the plan and anything the designer must add", "posts": [{"type": "lifestyle", "group": "carousel", "slide": 1, "of": 3, "role": "teaser", "title": "...", "headline": "...", "subline": "", "brief": "...", "product": "exact name or empty", "products": [], "ingredients": "", "exact": false, "reference": 1, "caption": "...", "hashtags": "#..."}]}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A month that is its brief's posts: the brief planned it and nothing wrote the ideas again since.
 * No reading, grid, colour or count change makes these posts stale.
 */
export function briefMonth(config: { campaign?: { at: number; only?: boolean } | null; plannedAt?: number | null } | null | undefined): boolean {
  if (!config?.campaign?.only) return false;
  return (config.plannedAt ?? 0) <= config.campaign.at;
}

export interface PlannedPost {
  post: Post;
  reference: number;
}

/** The planner's answer as posts, numbered after the existing ones; groups get one id each. */
export function parseBriefPlan(raw: unknown, products: string[], firstIndex: number, groupId: () => string): { summary: string; posts: PlannedPost[] } {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(d.posts) ? (d.posts as Record<string, unknown>[]) : [];
  const out: PlannedPost[] = [];
  const groups = new Map<string, string>();
  let index = firstIndex;
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const brief = String(x.brief ?? "").trim();
    const headline = String(x.headline ?? "").trim();
    if (!brief) continue;
    const written = String(x.type ?? "lifestyle");
    const type: PostType = (POST_TYPES as readonly string[]).includes(written) && written !== "offer" && written !== "greeting" ? (written as PostType) : "lifestyle";
    const role = String(x.role ?? "").trim().toLowerCase();
    // An ingredients slide shows the ingredients on their own: no product photo joins it, whatever
    // the planner wrote in "product" (a cup in the picture would defeat the slide).
    // An ingredients slide and a separator carry no product photo.
    const bare = role === "ingredients" || role === "separator";
    const lead = bare ? undefined : matchProduct(String(x.product ?? ""), products);
    const extras = bare ? [] : (Array.isArray(x.products) ? (x.products as unknown[]) : []).map((n) => matchProduct(String(n ?? ""), products)).filter((n): n is string => !!n && n !== lead);
    const kindRaw = String(x.group ?? "single");
    const kind: GroupKind | null = kindRaw === "carousel" || kindRaw === "series" ? kindRaw : null;
    const of = Math.max(1, Math.min(10, Math.round(Number(x.of) || 1)));
    const slide = Math.max(1, Math.min(of, Math.round(Number(x.slide) || 1)));
    let group: PostGroup | undefined;
    if (kind && of > 1) {
      // Slides of one group share an id: a new group starts at slide 1.
      const key = `${kind}:${of}`;
      if (slide === 1 || !groups.has(key)) groups.set(key, groupId());
      group = { id: groups.get(key)!, kind, slide, of, role: String(x.role ?? "").trim().slice(0, 30) || undefined };
    }
    // An ingredients slide shows them on their own; any other post names the product's own ingredients around it.
    const ingredients = role === "separator" ? "" : String(x.ingredients ?? "").trim().slice(0, 300);
    const post: Post = {
      index: index++,
      type,
      title: String(x.title ?? "").trim().slice(0, 80) || headline.slice(0, 80) || "Post",
      brief: brief.slice(0, 2000),
      caption: String(x.caption ?? "").trim().slice(0, 2200),
      hashtags: String(x.hashtags ?? "").trim().slice(0, 400),
      headline: headline.slice(0, 80) || undefined,
      subline: String(x.subline ?? "").trim().slice(0, 120) || undefined,
      product: lead,
      products: extras.length ? extras.slice(0, 3) : undefined,
      ingredients: ingredients || undefined,
      exact: x.exact === true ? true : undefined,
      group,
      captionHand: true,
    };
    // A separator is a plain backdrop: no reference picture shapes it.
    out.push({ post, reference: role === "separator" ? 0 : Math.max(0, Math.round(Number(x.reference) || 0)) });
  }
  return { summary: String(d.summary ?? "").trim().slice(0, 600), posts: out };
}
