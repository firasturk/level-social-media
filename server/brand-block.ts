/**
 * The client's brand block on the requests that used to carry the typed words alone: an AI edit of
 * a picture (the Photo studio's tools and presets, the Photo lab, the Prompt Box's edits) and a
 * video (Higgsfield Cloud, the Higgsfield subscription, Magnific, the campaign's clips). The text is
 * written by `brandBlock` (shared/brandMemory.ts) from the client's kit and its approved memory;
 * this file only reads them and puts the block after the typed words.
 *
 * Words nobody typed get no block: a tool with no prompt (upscale, remove background, a camera
 * angle, variations) is sent exactly what it was sent before, and no prompt is invented for it.
 */
import type { Env } from "./env";
import { first } from "./db";
import { lessonsFor } from "./lessons";
import { asksForWords, brandBlock, stripBrandBlock, withBrandBlock, type BrandBlockOptions, type BrandKit, type BrandUse } from "@shared/brandMemory";
import type { Config } from "@shared/config";

/** A month as the callers hold it: the client is on the row, and in the stored config of older rows. */
export interface BrandMonth {
  id: string;
  client?: string | null;
  config?: string;
}

export function clientOf(b: BrandMonth): string | null {
  if (b.client) return b.client;
  try {
    return (JSON.parse(b.config ?? "{}") as Config).client ?? null;
  } catch {
    return null;
  }
}

/** The kit columns the block reads, and the memory lines of the brand and of this month. */
export async function clientBrandBlock(env: Env, client: string | null | undefined, use: BrandUse, opts: BrandBlockOptions & { batch?: string | null } = {}): Promise<string> {
  if (!client) return "";
  const kit = await first<BrandKit>(env.DB, "SELECT colors, dos, donts, image_rules, photography, language FROM clients WHERE id = ?", client);
  if (!kit) return "";
  // Without a month only brand-wide items come back; a post's own instructions are never asked for.
  const memory = await lessonsFor(env, client, opts.batch ? { batch: opts.batch } : undefined).catch(() => [] as string[]);
  return brandBlock(kit, memory, use, opts);
}

export interface Branded {
  /** What the provider is sent: the typed words, then the block. */
  text: string;
  /** The block alone ("" when nothing was added), kept beside the typed words so the person can see it. */
  block: string;
}

/**
 * The typed words with the client's block after them, inside the provider's limit (the typed words
 * always whole). Empty words stay empty: nothing is sent where nothing was typed.
 */
export async function withClientBrand(env: Env, client: string | null | undefined, typed: string, use: BrandUse, limit: number | null, opts: BrandBlockOptions & { batch?: string | null } = {}): Promise<Branded> {
  if (!typed.trim() || !client) return { text: typed, block: "" };
  // The language is named for the words the person asked for, not for an earlier block's own lines.
  const block = await clientBrandBlock(env, client, use, use === "video" ? { ...opts, words: opts.words ?? asksForWords(stripBrandBlock(typed)) } : opts);
  return withBrandBlock(typed, block, limit);
}

/** The same for a month of posts. */
export function withMonthBrand(env: Env, b: BrandMonth, typed: string, use: BrandUse, limit: number | null, opts: BrandBlockOptions = {}): Promise<Branded> {
  return withClientBrand(env, clientOf(b), typed, use, limit, { ...opts, batch: b.id });
}

/** A preset names its own inputs: its typed words are under one of these names. */
const WORDS_INPUT = /^(prompt|notes?|text|description|instructions?|brief|idea)$/i;

/**
 * A preset's inputs with the client's block after the words the person typed into it. A preset
 * run with no typed words is sent as it was: its picture and its own recipe, nothing invented.
 */
export async function withBrandOnInputs(env: Env, b: BrandMonth, inputs: Record<string, unknown>, use: BrandUse, limit: number, opts: BrandBlockOptions = {}): Promise<{ inputs: Record<string, unknown>; block: string }> {
  const name = Object.keys(inputs).find((k) => WORDS_INPUT.test(k) && typeof inputs[k] === "string" && (inputs[k] as string).trim());
  if (!name) return { inputs, block: "" };
  const sent = await withMonthBrand(env, b, (inputs[name] as string).trim(), use, limit, opts);
  return { inputs: sent.block ? { ...inputs, [name]: sent.text } : inputs, block: sent.block };
}
