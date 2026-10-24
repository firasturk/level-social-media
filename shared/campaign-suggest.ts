/**
 * "Suggest a campaign": the text model, briefed as the brand's creative director, writes three
 * distinct campaigns for the month from what the studio knows (the brand kit and its Analysis, the
 * products, the cast, the approved brand rules, the month's occasions, the campaigns already made).
 * One is picked to fill the setup; nothing is planned or paid for until the admin presses Plan.
 */
import type { CampaignLanguage, CampaignSetup, ProductPick } from "./campaign-plan";
import { SETUP_LIMITS } from "./campaign-plan";
import type { CastMember } from "./campaign-planner";
import { peopleRule } from "./campaign-planner";

export interface SuggestInput {
  brand: { name: string; tone: string; audience: string; language: string; dos: string; donts: string; style: string };
  /** What the Analysis understood (summary, offer, tone, content that works, direction), as text. */
  profile: string;
  products: (ProductPick & { listId: string })[];
  month: string;
  today: string;
  occasions: { date: string; name: string }[];
  cast: CastMember[];
  rules: string[];
  /** The objectives of the campaigns already planned for this client (not repeated). */
  past: string[];
  /** The admin's own words for this suggestion (optional). */
  hint: string;
  language: CampaignLanguage;
}

export interface CampaignSuggestion {
  title: string;
  insight: string;
  why: string;
  setup: Partial<CampaignSetup>;
}

export const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          insight: { type: "string" },
          why: { type: "string" },
          objective: { type: "string" },
          audience: { type: "string" },
          offer: { type: "string" },
          message: { type: "string" },
          direction: { type: "string" },
          products: { type: "array", items: { type: "string" } },
          imagePosts: { type: "number" },
          videos: { type: "number" },
          shotsPerVideo: { type: "number" },
          videoSeconds: { type: "number" },
        },
        required: ["title", "insight", "why", "objective", "audience", "offer", "message", "direction", "products", "imagePosts", "videos", "shotsPerVideo", "videoSeconds"],
      },
    },
  },
  required: ["suggestions"],
} as const;

export const isSuggestSchema = (props: Record<string, unknown>) => "suggestions" in props;

export function suggestInstruction(x: SuggestInput): string {
  const lang = x.language === "ar" ? "Arabic" : x.language === "en" ? "English" : "Arabic for the message and the words people read, English allowed for the brief fields";
  return [
    `You are the creative director of a top regional agency, planning ${x.brand.name}'s next social campaign for ${x.month || "this month"} (today is ${x.today}). Propose THREE campaigns that are genuinely different from each other (a different insight, a different emotional territory, a different reason to buy now), each strong enough to win the client's approval on its own.`,
    "",
    "WHAT MAKES A CAMPAIGN GOOD HERE",
    "- One sharp human insight about the audience in this market (Jordan and the Levant unless the brand says otherwise), not a product feature.",
    "- One idea that every post and every Reel can carry, with a memorable line people would repeat.",
    "- Built for Instagram Reels first: the first second stops the scroll; a moment people recognise from their own day.",
    "- Timely: tie it to the season, the weather, an occasion from the list below or a real moment in people's routine when it fits. Use only occasions from that list (they are the ones still ahead): never one that has already passed, never one you remember from elsewhere, and never force one that does not fit the brand.",
    "- Products: feature the brand's real products from the list below, by their ids; the hero product first. Never invent products, flavours, prices or offers.",
    "- Offer: only an offer the brand already runs (from the brand kit or the Analysis). If none is known, leave it empty: never invent a discount.",
    "- Direction: describe the visual world in concrete terms a photographer can shoot (place, light, palette from the brand, props, styling, camera feel), consistent with the brand's photography.",
    "- Sizing: image posts 2 to 6, Reels 1 to 4, 3 to 6 shots per Reel, 10 to 30 seconds; size it to the idea, not the maximum.",
    "",
    `LANGUAGE: ${lang}. Write title, insight, why, objective, audience, offer, message and direction in that language. Never write list ids (P1, P2…) inside the text: put them only in "products".`,
    "",
    "BRAND",
    `Name: ${x.brand.name}`,
    x.brand.tone && `Tone: ${x.brand.tone}`,
    x.brand.audience && `Audience: ${x.brand.audience}`,
    x.brand.style && `Style: ${x.brand.style}`,
    x.brand.dos && `Do: ${x.brand.dos}`,
    x.brand.donts && `Don't: ${x.brand.donts}`,
    x.profile && `\nWHAT THE ANALYSIS FOUND (Instagram, website, competitors)\n${x.profile}`,
    "",
    peopleRule(x.cast),
    x.rules.length ? `\nAPPROVED BRAND RULES AND LESSONS (never break them)\n${x.rules.map((r) => `- ${r}`).join("\n")}` : "",
    "",
    "PRODUCTS (id: name · note)",
    x.products.length ? x.products.map((p) => `${p.listId}: ${p.name}${p.note ? ` · ${p.note}` : ""}`).join("\n") : "(none listed: suggest campaigns around the brand itself, products: [])",
    "",
    x.occasions.length ? `OCCASIONS STILL AHEAD THIS MONTH\n${x.occasions.map((o) => `${o.date}: ${o.name}`).join("\n")}` : "OCCASIONS STILL AHEAD THIS MONTH: none (do not build on an occasion)",
    x.past.length ? `\nCAMPAIGNS ALREADY MADE FOR THIS CLIENT (do not repeat their ideas)\n${x.past.map((p) => `- ${p}`).join("\n")}` : "",
    x.hint ? `\nTHE ADMIN ASKS FOR: ${x.hint}` : "",
    "",
    'For each campaign: "title" (2 to 5 words), "insight" (the human truth, one sentence), "why" (why this, for this brand, now: one sentence), "objective", "audience", "offer" (or empty), "message" (the line people remember), "direction" (the visual world, 2 to 4 sentences), "products" (ids), and the sizes.',
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");
}

interface RawSuggestion {
  title?: string;
  insight?: string;
  why?: string;
  objective?: string;
  audience?: string;
  offer?: string;
  message?: string;
  direction?: string;
  products?: string[];
  imagePosts?: number;
  videos?: number;
  shotsPerVideo?: number;
  videoSeconds?: number;
}

const clamp = (n: unknown, min: number, max: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d);

/** The model's answer as setups: products resolved against the list (unknown ids dropped), sizes kept in the limits, ids out of the words. */
export function suggestionsFrom(raw: unknown, x: Pick<SuggestInput, "products">): CampaignSuggestion[] {
  const list = ((raw as { suggestions?: RawSuggestion[] } | null)?.suggestions ?? []).slice(0, 3);
  const byId = new Map(x.products.map((p) => [p.listId, p]));
  const clean = (t: unknown) =>
    String(t ?? "")
      .replace(/\s*[([]\s*\bP\d{1,3}\b\s*[)\]]/g, (all) => {
        const id = /P\d{1,3}/.exec(all)![0];
        return byId.has(id) ? "" : all;
      })
      .replace(/\bP\d{1,3}\b/g, (id) => byId.get(id)?.name ?? id)
      .replace(/\s{2,}/g, " ")
      .trim();
  return list
    .filter((s) => s && (s.objective || s.title))
    .map((s) => {
      const products = [...new Set(s.products ?? [])].map((id) => byId.get(String(id).trim())).filter((p): p is ProductPick & { listId: string } => !!p);
      return {
        title: clean(s.title).slice(0, 80),
        insight: clean(s.insight).slice(0, 400),
        why: clean(s.why).slice(0, 400),
        setup: {
          objective: clean(s.objective).slice(0, 600),
          audience: clean(s.audience).slice(0, 400),
          offer: clean(s.offer).slice(0, 200),
          message: clean(s.message).slice(0, 200),
          imagePosts: clamp(s.imagePosts, 0, SETUP_LIMITS.imagePosts, 3),
          videos: clamp(s.videos, 0, SETUP_LIMITS.videos, 2),
          shotsPerVideo: clamp(s.shotsPerVideo, 1, SETUP_LIMITS.shotsPerVideo, 4),
          videoSeconds: clamp(s.videoSeconds, 5, SETUP_LIMITS.videoSeconds, 15),
          products: products.map(({ listId: _l, ...p }) => {
            void _l;
            return p;
          }),
          productMode: products.length ? "manual" : "suggest",
          direction: { prompt: clean(s.direction).slice(0, 1200), references: [], styleId: null },
        },
      };
    });
}

/** The preview's answer (no text model there): three labelled suggestions from the listed products. */
export function demoSuggestions(instruction: string): { suggestions: RawSuggestion[] } {
  const ids = [...instruction.matchAll(/^(P\d+): ([^·\n]+)/gm)].map((m) => ({ id: m[1], name: m[2].trim() }));
  const brand = /^Name: (.+)$/m.exec(instruction)?.[1] ?? "the brand";
  const pick = (n: number) => ids.slice(n, n + 2);
  const one = (title: string, insight: string, n: number, posts: number, videos: number) => ({
    title: `Preview: ${title}`,
    insight: `Preview fixture (no text model on the preview): ${insight}`,
    why: `Preview fixture for ${brand}: on the live studio the text model writes this from the brand, its products and the month.`,
    objective: `${title}: bring ${brand}'s ${pick(n).map((p) => p.name).join(" and ") || "products"} into people's routine this month`,
    audience: "Young adults in Amman who buy on the way, 18 to 34",
    offer: "",
    message: `${title}.`,
    direction: "Warm late-afternoon light, the brand's palette, real places in the city, hands and products close to the camera.",
    products: pick(n).map((p) => p.id),
    imagePosts: posts,
    videos: videos,
    shotsPerVideo: 4,
    videoSeconds: 15,
  });
  return { suggestions: [one("The daily pause", "a short break is the best part of a long day", 0, 3, 2), one("Made for the road", "the car is where people actually have their snacks", 2, 2, 3), one("Share the cold one", "a drink tastes better when it is shared", 4, 4, 1)] };
}
