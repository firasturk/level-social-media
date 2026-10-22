import { type Config, cardsPerSource, FABRIC_CARD, usesBuilder } from "./config";

/**
 * Approximate list prices per generated image in USD (October 2026). Google and Higgsfield publish
 * flat per-image prices; OpenAI bills tokens, so its figures are output tokens at $30/M plus about
 * $0.008 per reference image. Treat every number here as an estimate, not an invoice.
 */
interface Rate {
  /** per image by size tier */
  "1K": number;
  "2K": number;
  "4K": number;
  /** added per reference image sent with the request (token-billed engines) */
  perReference?: number;
  /** multiplier when economy (Flex) mode is on */
  economy?: number;
  /** the first reference image is included in the base price */
  firstReferenceFree?: boolean;
}

const RATES: Record<string, Rate> = {
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24, economy: 0.5 },
  // Nano Banana 2.1 (released 6 Oct 2026): $30 per million image tokens; 1,120 / 1,680 / 3,780 tokens per image.
  "gemini-nano-banana-2.1": { "1K": 0.0336, "2K": 0.0504, "4K": 0.113, economy: 0.5 },
  "gemini-3.1-flash-image": { "1K": 0.067, "2K": 0.101, "4K": 0.151, economy: 0.5 },
  "gemini-2.5-flash-image": { "1K": 0.039, "2K": 0.039, "4K": 0.039, economy: 0.5 },
  "gpt-image-2.5-sunburst": { "1K": 0.0132, "2K": 0.0527, "4K": 0.0937, perReference: 0.008 },
  "gpt-image-2.5-flare": { "1K": 0.0132, "2K": 0.0527, "4K": 0.0937, perReference: 0.008 },
  "gpt-image-2": { "1K": 0.0132, "2K": 0.0527, "4K": 0.0937, perReference: 0.008 },
  "fal/bytedance/seedream/v5/pro/edit": {
    "1K": 0.0675,
    "2K": 0.135,
    "4K": 0.135,
    perReference: 0.0045,
    firstReferenceFree: true,
  },
  "fal/fal-ai/bytedance/seedream/v5/lite/edit": { "1K": 0.035, "2K": 0.035, "4K": 0.035 },
  "fal/fal-ai/bytedance/seedream/v4.5/edit": { "1K": 0.03, "2K": 0.03, "4K": 0.03 },
  "nano-banana-pro": { "1K": 0.15, "2K": 0.15, "4K": 0.3 },
  "flux-2-pro": { "1K": 0.08, "2K": 0.08, "4K": 0.08 },
  "flux-2-max": { "1K": 0.1, "2K": 0.1, "4K": 0.1 },
  "flux-2-flex": { "1K": 0.06, "2K": 0.06, "4K": 0.06 },
  "qwen-image-edit": { "1K": 0.03, "2K": 0.03, "4K": 0.03 },
};

/** Vision-model cost of writing one editorial prompt (mode 5). */
const PROMPT_BUILDER_COST = 0.01;

export function rateFor(model: string | undefined): Rate | null {
  return (model && RATES[model]) || null;
}

/** Reference images attached for a given card (garment, card 1, card 2, latest result on revision). */
export function referencesFor(c: Config, card: number, revision = false): number {
  let n = 1;
  if (c.mode === "1" && card > 1 && card < FABRIC_CARD) n += card > 2 ? 2 : 1;
  if (c.mode === "7") n += 1;
  if (c.mode === "9") n += 2; // background photo + pose photo
  if (revision) n += 1;
  return n;
}

export interface CostEstimate {
  perImage: number;
  total: number;
  images: number;
  known: boolean;
  economy: boolean;
}

/** Cost of generating `images` more images under this config (one image per card, no retries). */
export function estimateCost(c: Config, images: number, cards?: number[]): CostEstimate {
  const rate = rateFor(c.model);
  if (!rate || images <= 0)
    return { perImage: 0, total: 0, images, known: !!rate, economy: !!c.economy };
  const size = rate[c.size] ?? rate["2K"];
  const multiplier = c.economy && rate.economy ? rate.economy : 1;
  let total = 0;
  const list = cards ?? Array.from({ length: images }, (_, i) => (i % cardsPerSource(c)) + 1);
  for (const card of list) {
    let cost = size * multiplier;
    if (rate.perReference)
      cost +=
        rate.perReference * Math.max(0, referencesFor(c, card) - (rate.firstReferenceFree ? 1 : 0));
    if (usesBuilder(c.mode)) cost += PROMPT_BUILDER_COST;
    total += cost;
  }
  return {
    perImage: total / list.length,
    total,
    images: list.length,
    known: true,
    economy: !!c.economy,
  };
}

/** Prices hidden for this viewer (the admins-only setting): every amount reads as a note instead. */
let pricesHidden = false;
export function setPricesHidden(hidden: boolean): void {
  pricesHidden = hidden;
}
export const HIDDEN_PRICE = "(cost shown to admins)";

export function formatUsd(n: number): string {
  if (pricesHidden) return HIDDEN_PRICE;
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * The size of the test post: 1K when it costs less than the month's size (it is then made again
 * with the rest), otherwise the month's own size, so the approved test is kept as the final image.
 */
export function testSize(model: string | undefined, size: "1K" | "2K" | "4K"): "1K" | "2K" | "4K" {
  const r = rateFor(model);
  if (!r) return "1K";
  return r["1K"] < r[size] ? "1K" : size;
}

/**
 * Photo lab (Freepik / Magnific) tools, approximate USD per picture (October 2026). Freepik bills
 * credits per call and publishes the credit rates on its pricing page, which change; these are
 * rounded working figures for the confirmation dialog, not an invoice. Upscale is the 2x creative
 * upscaler; higher factors cost more.
 */
export const PHOTO_LAB_PRICES = {
  "remove-bg": 0.02,
  background: 0.1,
  relight: 0.1,
  upscale: 0.12,
} as const;
export type PhotoLabOp = keyof typeof PHOTO_LAB_PRICES;
/** Every Photo lab price is an estimate: the UI says "about". */
export const PHOTO_LAB_PRICES_APPROXIMATE = true;
