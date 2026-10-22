/**
 * The Video studio's preset gallery: the categories on its left (as Higgsfield's presets page shows
 * them, mapped to the MCP's `get_presets` sources) and the shape of one card, shared by the server
 * (server/video-presets.ts normalises the tool answers into it) and the studio (which only draws it).
 * No preset is invented here: a category with no answer says so.
 *
 * The gallery shows videos only (`keepCard`): a card needs a real id, a title and a reference
 * **video** (the provider says which preview is a video with `preview_type`). Picture presets
 * (the Marketing Studio's product shots, whose preview is a picture) belong to the Photo studio and
 * never reach this gallery. The provider's category lists (entries titled "All", "Motion",
 * "Product shot"…) and recipes that are not a video made from a picture (Blender, After Effects,
 * DaVinci, websites…) are dropped too.
 *
 * No UGC category: Higgsfield's UGC ads live in its Marketing Studio widget, not in the preset
 * catalog (`get_presets` with `query: "ugc"` answers nothing), so nothing is promised there.
 */

export type PresetCategoryId = "popular" | "paid-ads" | "motion" | "marketing" | "production" | "faceless" | "effects" | "genjutsu" | "recipes";

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
  { id: "marketing", label: "Marketing", hint: "Product, logo and unboxing clips from the Marketing Studio." },
  { id: "production", label: "Production", hint: "Katana: multi-shot productions with a storyline (the community catalog)." },
  { id: "faceless", label: "Faceless", hint: "\"What if\" explainer styles: scenes, text and data, no presenter." },
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
  /** What the preset makes, when the answer says ("video", "image"); null when it does not. */
  output: "video" | "image" | null;
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

/* ───────────── Videos only: the gallery's rules ───────────── */

/** The names of the provider's filters and our own categories: an entry so titled is a category list, not a preset. */
export const CATEGORY_NAMES: readonly string[] = [
  ...PRESET_CATEGORIES.map((c) => c.label),
  "All",
  "Motion",
  "Product shot",
  "Product shots",
  "Ads",
  "Ad",
  "Viral",
  "Trending",
  "New",
  "Featured",
  "Katana",
  "Marketing Studio",
  "Recipe",
  "Categories",
  "Category",
].map((s) => s.toLowerCase());

export function isCategoryName(title: string): boolean {
  const t = title.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return CATEGORY_NAMES.includes(t);
}

/** What a preset or its execution block says it makes, from any of the usual fields. */
export function outputKind(...values: unknown[]): "video" | "image" | null {
  for (const v of values) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (/video|clip|motion|animat|reel|footage/i.test(v)) return "video";
    if (/\b(image|photo|picture|still|poster)s?\b/i.test(v)) return "image";
  }
  return null;
}

/** Why a card is kept out of the gallery, or null when it stays. Only presets with a real reference video are shown. */
export function dropReason(c: Pick<PresetCard, "id" | "title" | "description" | "video" | "poster" | "output" | "source" | "category">): string | null {
  if (!c.id || !String(c.id).trim() || c.id === "undefined" || c.id === "null") return "no id";
  if (!c.title.trim()) return "no title";
  if (isCategoryName(c.title)) return "a category name, not a preset";
  if (c.output === "image") return "makes a picture, not a video";
  if (c.video) return null;
  if (!c.poster && !c.description) return "no preview and no description";
  return "no reference video";
}

export const keepCard = (c: Parameters<typeof dropReason>[0]): boolean => dropReason(c) === null;

const VIDEO_WORDS = /\b(videos?|clips?|reels?|motion|animat\w*|cinematic|footage|b-roll|camera moves?|turntable|loop)\b/i;
const NOT_FROM_PICTURE = /\b(blender|after effects|davinci|resolve|premiere|final cut|websites?|web ?apps?|landing pages?|games?|3d (?:model|scene|mesh|jutsu)|glb|code|typescript|python|shaders?|influencer|character sheet|voices?|dubbing|audio|music|podcast|exploded view|color grading|colour grading)\b/i;
const PICTURE_WORDS = /\b(pictures?|photos?|images?|product shots?|stills?|reference|artwork|poster)\b/i;

/**
 * A recipe stays only when it makes a video from a picture: its words say video (clip, reel,
 * motion…), name a picture it takes (or its inputs do), and do not point at another tool (Blender,
 * After Effects, DaVinci, websites, 3D, code…). `inputs` is whatever the recipe lists as what it
 * takes; `runnable` is the provider's flag when the answer carries one.
 */
export function isVideoFromPictureRecipe(text: string, opts: { inputs?: unknown; runnable?: boolean | null; needs?: string[] } = {}): boolean {
  if (opts.runnable === false) return false;
  if (!VIDEO_WORDS.test(text) || NOT_FROM_PICTURE.test(text)) return false;
  const inputsText = JSON.stringify(opts.inputs ?? "");
  return PICTURE_WORDS.test(text) || /image|photo|picture|media/i.test(inputsText) || (opts.needs ?? []).some((n) => /picture/.test(n));
}
