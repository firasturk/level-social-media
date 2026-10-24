/**
 * The Photo studio's preset gallery: pictures only (the Video studio keeps the clips). Four
 * categories, each mapped to a provider's list, and the shape of one card, shared by the server
 * (server/photo-presets.ts normalises the tool answers into it) and the studio (which only draws
 * it). Nothing is invented here: a category with no answer says so, a card with no sample says so.
 */

export type PhotoPresetCategoryId = "styles" | "product-shots" | "ads" | "posters" | "marketplace" | "magnific-looks" | "recipes";

export interface PhotoPresetCategory {
  id: PhotoPresetCategoryId;
  label: string;
  /** What the person finds here, in plain words. */
  hint: string;
  provider: "higgsfield" | "magnific";
}

export const PHOTO_PRESET_CATEGORIES: readonly PhotoPresetCategory[] = [
  { id: "styles", label: "Styles", hint: "Higgsfield's Soul picture styles: a look applied to this post's picture with a few words.", provider: "higgsfield" },
  { id: "product-shots", label: "Product shots", hint: "Every Higgsfield product-shot preset (with a model or on its own): the product set into a scene, one run each.", provider: "higgsfield" },
  { id: "ads", label: "Ads", hint: "Marketing Studio ad layouts: the product, a headline and a design (the ones Higgsfield shows first).", provider: "higgsfield" },
  { id: "posters", label: "Posters", hint: "Marketing Studio posters: the product in a printed-poster design (the ones Higgsfield shows first).", provider: "higgsfield" },
  { id: "marketplace", label: "Marketplace", hint: "Marketing Studio marketplace pictures: listing-ready product cards (the ones Higgsfield shows first).", provider: "higgsfield" },
  { id: "magnific-looks", label: "Magnific looks", hint: "Magnific's picture models and upscale presets, for the Magnific tools.", provider: "magnific" },
  { id: "recipes", label: "Recipes", hint: "Step-by-step picture commands (/hero-shot and the like) with what each one does.", provider: "higgsfield" },
] as const;

export const PHOTO_PRESET_CATEGORY_IDS: readonly PhotoPresetCategoryId[] = PHOTO_PRESET_CATEGORIES.map((c) => c.id);

export function isPhotoPresetCategory(s: string): s is PhotoPresetCategoryId {
  return (PHOTO_PRESET_CATEGORY_IDS as readonly string[]).includes(s);
}

/** What "Use this style / look / preset" fills in the AI tools panel. */
export interface PresetUse {
  provider: "higgsfield" | "magnific";
  /** The studio's tool id (shared/photo-tools.ts). */
  tool: string;
  /** Option values by option id (styleId, preset, model, prompt…). */
  options: Record<string, string>;
}

/** One card of the gallery, normalised from a provider's answer. */
export interface PhotoPresetCard {
  id: string;
  /** Where it came from: soul, marketing_studio, marketing_studio_v2 (the Marketing Studio widget's ads, posters, marketplace), magnific, recipe. */
  source: string;
  provider: "higgsfield" | "magnific";
  kind: "style" | "preset" | "look" | "recipe";
  title: string;
  description: string;
  /** The slash command ("/hero-shot"), when the entry has one. */
  command: string | null;
  category: string | null;
  type: string | null;
  /** The provider's own sample picture, hotlinked (never copied here); null = no sample. */
  image: string | null;
  /** Credits the answer names for one run, else null ("cost not known"). */
  price: number | null;
  /** What the preset needs from the person, in plain words. */
  needs: string[];
  /** Can be run from the Presets panel (execute_preset on the post's picture). */
  runnable: boolean;
  /** A prompt the entry carries or suggests. */
  prompt: string | null;
  use: PresetUse | null;
}

export interface PhotoPresetDetail extends PhotoPresetCard {
  inputSchema: Record<string, unknown> | null;
  readiness: unknown;
  available: boolean | null;
  /** The instructions text ("Learn more"), when the entry has one. */
  instructions: string;
}

export const NOTHING_IN_PHOTO_CATEGORY = "Nothing in this category on your plan yet.";
export const NO_MAGNIFIC_SAMPLE = "No sample from Magnific";

/** The words a preset run sends: the product first (so the engine keeps it), then the change asked for. */
export function presetPrompt(product: string, change: string): string {
  const p = product.trim();
  const c = change.trim();
  if (!p) return c;
  return c ? `${p}\n\nChange for this picture: ${c}` : p;
}

/** The input the product's words go into: the preset's prompt (its "Describe your result"), else its first text input. */
export function wordsFieldOf(fields: { name: string; label: string }[]): string | null {
  return (fields.find((f) => /prompt|idea|words|describ/i.test(`${f.name} ${f.label}`)) ?? fields[0])?.name ?? null;
}
