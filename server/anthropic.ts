/**
 * Claude as the studio's text and vision model (27 Oct). Every text call the studio makes (the
 * plans and ideas, the client's comments, the captions, the picture reviews, the help assistant,
 * the Prompt Box) tries Claude first when a key is saved under Connection → Claude, then Google,
 * then OpenAI as before: Claude never blocks the work, it only answers first. Three models by the
 * job: Opus for planning and creative direction, Sonnet for words and picture reviews, Haiku for
 * the help assistant and the Prompt Box's reading of a sentence. Every answer's tokens are priced
 * and added to this month's spend in the settings table; past the monthly cap (US$200 by default,
 * set under Connection → Claude) the studio stops asking Claude until next month and the other
 * providers answer.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { getSetting, resolveAnthropicKey, setSetting, ANTHROPIC_CAP_SETTING } from "./settings";
import type { ImageBytes } from "./openai";

export type ClaudeTier = "opus" | "sonnet" | "haiku";
export const CLAUDE_MODELS: Record<ClaudeTier, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

/** US$ per million tokens: input, output, a cache read (a tenth of input), a cache write (1.25× input). */
const PRICES: Record<ClaudeTier, { input: number; output: number }> = { opus: { input: 4, output: 20 }, sonnet: { input: 2, output: 10 }, haiku: { input: 0.1, output: 0.5 } };
export const CLAUDE_DEFAULT_CAP = 200;

/**
 * Which Claude answers, read from the JSON schema the caller wants back (the same signal the demo
 * fixture reads): plans, ideas, the client's comments and creative direction go to Opus; the help
 * assistant and the Prompt Box's reading of a sentence to Haiku; everything else (captions, picture
 * reviews, product matches, palettes, prompts) to Sonnet.
 */
export function tierFor(schema: unknown): ClaudeTier {
  const props = ((schema as { properties?: Record<string, unknown> } | null)?.properties ?? {}) as Record<string, unknown>;
  if (props.posts || (props.shots && props.direction) || (props.world && props.tiles)) return "opus";
  if ((props.answer && props.steps) || (props.tool && props.q && props.model)) return "haiku";
  return "sonnet";
}

/** The month's spend so far, kept in the settings table as one small record per month. */
export interface ClaudeSpend {
  month: string;
  usd: number;
  calls: number;
  input: number;
  output: number;
}
const monthKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const spendKey = (month: string) => `anthropic_spend:${month}`;

export async function claudeSpend(env: Env): Promise<ClaudeSpend> {
  const month = monthKey();
  const raw = await getSetting(env, spendKey(month));
  const d = raw ? (JSON.parse(raw) as Partial<ClaudeSpend>) : {};
  return { month, usd: d.usd ?? 0, calls: d.calls ?? 0, input: d.input ?? 0, output: d.output ?? 0 };
}

export async function claudeCap(env: Env): Promise<number> {
  const raw = await getSetting(env, ANTHROPIC_CAP_SETTING);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : CLAUDE_DEFAULT_CAP;
}

/** What one answer cost, from the tokens the API reports. */
export function priceOf(tier: ClaudeTier, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const p = PRICES[tier];
  const m = 1_000_000;
  return (usage.input_tokens * p.input + usage.output_tokens * p.output + (usage.cache_read_input_tokens ?? 0) * p.input * 0.1 + (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25) / m;
}

async function recordSpend(env: Env, tier: ClaudeTier, usage: Anthropic.Usage): Promise<void> {
  const s = await claudeSpend(env);
  const next: ClaudeSpend = { month: s.month, usd: s.usd + priceOf(tier, usage), calls: s.calls + 1, input: s.input + usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), output: s.output + usage.output_tokens };
  await setSetting(env, spendKey(s.month), JSON.stringify(next));
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Claude takes pictures up to 5 MB each (as base64): a larger one goes to the other providers. */
const MAX_IMAGE_BYTES = 3_700_000;

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * One JSON answer from Claude: the instruction as the user turn (its pictures first), a system line
 * that asks for the JSON alone and names the schema, the model by the schema's job. Throws when the
 * key, the picture or the answer is not usable; the caller falls back to the other providers.
 */
export async function askVisionAnthropic(env: Env, key: string, instruction: string, images: ImageBytes[], schema: unknown, fetchImpl: typeof fetch = fetch, tier: ClaudeTier = tierFor(schema)): Promise<string> {
  for (const img of images) {
    const mime = img.mime === "image/jpg" ? "image/jpeg" : img.mime;
    if (!IMAGE_TYPES.has(mime)) throw new StudioError(`Claude does not read ${img.mime} pictures.`, 415);
    if (img.bytes.byteLength > MAX_IMAGE_BYTES) throw new StudioError("A picture is too large for Claude (5 MB at most).", 413);
  }
  // The address is pinned: the SDK would otherwise read ANTHROPIC_BASE_URL from the environment.
  const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", fetch: fetchImpl, maxRetries: 1, timeout: 120_000 });
  const model = CLAUDE_MODELS[tier];
  const content: Anthropic.ContentBlockParam[] = [
    ...images.map((img): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: (img.mime === "image/jpg" ? "image/jpeg" : img.mime) as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: toBase64(img.bytes) } })),
    { type: "text", text: instruction },
  ];
  const system = ["You are the text and vision model of a social-media studio for clients in Amman. Answer with the JSON the instruction asks for and nothing else: no prose before or after it, no code fences.", schema ? `The JSON must follow this schema exactly (every required field present, no other fields):\n${JSON.stringify(schema)}` : ""].filter(Boolean).join("\n\n");
  const response = await client.messages.create({
    model,
    max_tokens: tier === "opus" ? 16000 : 8192,
    system,
    // Planning earns a little thought; words and reviews answer at low effort (cheaper, faster).
    output_config: { effort: tier === "opus" ? "medium" : "low" },
    messages: [{ role: "user", content }],
  });
  await recordSpend(env, tier, response.usage).catch((e) => console.error("[claude] spend", errorMessage(e)));
  if (response.stop_reason === "refusal") throw new StudioError(`Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`, 422);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new StudioError("Claude gave an empty answer.", 502);
  return text;
}

/**
 * Claude's answer, or null when the studio should ask the next provider instead: no key, the
 * month's cap reached, a picture it cannot take, or a failed call (logged, never thrown: the
 * other providers still answer as before). Every site that asks a text model starts here.
 */
export async function tryClaude(env: Env, instruction: string, images: ImageBytes[], schema: unknown, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const { key } = await resolveAnthropicKey(env);
  if (!key) return null;
  const [spent, cap] = await Promise.all([claudeSpend(env), claudeCap(env)]);
  if (spent.usd >= cap) {
    console.log(`[claude] monthly cap reached (${spent.usd.toFixed(2)} of ${cap}): the other providers answer`);
    return null;
  }
  try {
    return await askVisionAnthropic(env, key, instruction, images, schema, fetchImpl);
  } catch (e) {
    console.error(`[claude] ${errorMessage(e).slice(0, 200)}; trying the next provider`);
    return null;
  }
}

/** A key checked against the free models list: nothing is generated. */
export async function verifyAnthropicKey(key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  try {
    const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", fetch: fetchImpl, maxRetries: 0, timeout: 30_000 });
    const page = await client.models.list({ limit: 5 });
    const ids = page.data.map((m) => m.id);
    const have = (Object.values(CLAUDE_MODELS) as string[]).filter((m) => ids.includes(m));
    return { ok: true, message: `Claude key verified${have.length ? ` · ${have.length === 3 ? "Opus, Sonnet and Haiku 5.5 available" : `${have.join(", ")} available`}` : ""}.` };
  } catch (e) {
    return { ok: false, message: errorMessage(e).slice(0, 200) };
  }
}
