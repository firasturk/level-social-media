/**
 * The Video studio's preset gallery: the categories on its left (as Higgsfield's presets page shows
 * them, mapped to the MCP's `get_presets` sources) and the shape of one card, shared by the server
 * (server/video-presets.ts normalises the tool answers into it) and the studio (which only draws it).
 * No preset is invented here: a category with no answer says so.
 */

export type PresetCategoryId = "popular" | "paid-ads" | "motion" | "marketing" | "production" | "ugc" | "faceless" | "effects" | "genjutsu" | "recipes";

export interface PresetCategory {
  id: PresetCategoryId;
  label: string;
  /** What the person finds here, in plain words. */
  hint: string;
}

export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  { id: "popular", label: "Popular", hint: "What Higgsfield shows first: the viral effects and the marketing presets together." },
  { id: "paid-ads", label: "Paid Ads", hint: "Presets written for ads: a product, a hook, a call to action." },
  { id: "motion", label: "Motion Design", hint: "Moving graphics and transitions from the Marketing Studio." },
  { id: "marketing", label: "Marketing", hint: "Product shots and ad formats from the Marketing Studio." },
  { id: "production", label: "Production", hint: "Katana: multi-shot productions with a storyline." },
  { id: "ugc", label: "UGC", hint: "Creator-style clips that look filmed on a phone." },
  { id: "faceless", label: "Faceless", hint: "Clips with no presenter: hands, products, text and scenes." },
  { id: "effects", label: "Effects", hint: "The viral effects applied to a picture." },
  { id: "genjutsu", label: "Genjutsu", hint: "Trending motion transfers and replacements." },
  { id: "recipes", label: "Recipes", hint: "Step-by-step commands (/hero-shot and the like) with what each one does." },
] as const;

export const PRESET_CATEGORY_IDS: readonly PresetCategoryId[] = PRESET_CATEGORIES.map((c) => c.id);

export function isPresetCategory(s: string): s is PresetCategoryId {
  return (PRESET_CATEGORY_IDS as readonly string[]).includes(s);
}

/** One card of the gallery, normalised from a provider's answer. Every field but id, source and title may be missing. */
export interface PresetCard {
  id: string;
  /** Where it came from: viral, marketing_studio, genjutsu, katana, recipe, or what the answer said. */
  source: string;
  title: string;
  description: string;
  /** The slash command ("/hero-shot"), when the preset has one. */
  command: string | null;
  category: string | null;
  type: string | null;
  /** The provider's own reference video, hotlinked (never copied to our storage); null when the answer carries none. */
  video: string | null;
  /** A still for the card (the preview image), when the answer carries one. */
  poster: string | null;
  /** Credits the answer names for one run, else null ("cost not known"). */
  price: number | null;
  /** What the preset needs from the person, in plain words ("1 product picture", "a few words of prompt"). */
  needs: string[];
  /** The preset can be run from here (execute_preset accepts its source); a recipe or a Katana production cannot. */
  runnable: boolean;
  /** An engine the preset names, when it does. */
  engine: string | null;
  /** A prompt the preset carries or suggests, for "Use this preset". */
  prompt: string | null;
}

export interface PresetDetail extends PresetCard {
  /** The preset's inputs as the provider describes them (a JSON schema), when the detail carries them. */
  inputSchema: Record<string, unknown> | null;
  /** The provider's readiness answer for the given inputs, as it came. */
  readiness: unknown;
  /** The provider's "capability" flag; not a permission. */
  available: boolean | null;
  /** The instructions text ("Learn more"), when the preset has a command with instructions. */
  instructions: string;
}

/** The sources `execute_preset` takes, per the tool description. */
export const EXECUTABLE_SOURCES: readonly string[] = ["viral", "marketing_studio", "genjutsu"];

export const NOTHING_IN_CATEGORY = "Nothing in this category on your plan yet.";
