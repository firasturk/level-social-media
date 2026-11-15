/**
 * A client with a brand kit and an approved brand rule, for the tests that prove the client's
 * identity reaches an AI edit and a video. The seeds of those tests create client `c1` with an
 * empty kit; `giveKit` fills it.
 */
import type { fakeEnv } from "./fakes";
import { BRAND_BLOCK_LABEL } from "../../shared/brandMemory";

type FakeEnv = ReturnType<typeof fakeEnv>;

export const KIT = {
  colors: JSON.stringify([
    { name: "Royal blue", hex: "#0042aa" },
    { name: "Cream", hex: "#f5e9d0" },
  ]),
  // The first line is a whole scene (it must never reach an edit); the second says how people dress.
  dos: "The brass tray stays in view\nWomen wear modest clothing with long sleeves",
  // The second line is about the layout: the designer's, never the picture's.
  donts: "No plastic cups\nNo logos in the corners",
  image_rules: "Every box keeps its printed lid.",
  photography: "50mm, eye level, soft window light.",
  language: "ar",
};

/** A never-rule and a brand colour of the kit, as they must appear in what a provider is sent. */
export const NEVER = "NEVER: No plastic cups.";
export const COLOUR = "deep blue #0042aa";
export const BRAND_RULE = "No red backgrounds";
export const EDIT_LABEL = BRAND_BLOCK_LABEL.edit;
export const VIDEO_LABEL = BRAND_BLOCK_LABEL.video;

export async function giveKit(env: FakeEnv, client = "c1", over: Partial<typeof KIT> = {}): Promise<void> {
  const k = { ...KIT, ...over };
  await env.DB.prepare("UPDATE clients SET colors = ?, dos = ?, donts = ?, image_rules = ?, photography = ?, language = ? WHERE id = ?").bind(k.colors, k.dos, k.donts, k.image_rules, k.photography, k.language, client).run();
}

/** An approved, brand-wide rule in the client's memory. */
export async function giveBrandRule(env: FakeEnv, text = BRAND_RULE, client = "c1"): Promise<void> {
  const t = Date.now();
  await env.DB.prepare("INSERT INTO lessons (id, client, kind, text, seen, first, last, batch, status, source, category, scope, revision) VALUES (?, ?, 'rule', ?, 1, ?, ?, NULL, 'approved', 'team', 'brand_rule', '', 1)").bind(`m-${t}-${Math.random()}`, client, text, t, t).run();
}

/** How many times a text carries a brand block. */
export const blocksIn = (text: unknown) => (String(text ?? "").match(/CLIENT BRAND (?:LIMITS|RULES)/g) ?? []).length;
