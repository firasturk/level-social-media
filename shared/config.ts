import type { Post, Format } from "./posts";

/** "post" is Level Social Media's month of posts; the numbered approaches are the fashion studio's. */
export const MODES = ["post", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export const MARKETS = ["auto", "arab", "european", "mixed"] as const;
export const INPUT_TYPES = ["model", "mannequin", "flatlay"] as const;
export const RATIOS = ["2:3", "3:4", "4:5", "1:1", "9:16", "16:9"] as const;
export const SIZES = ["1K", "2K", "4K"] as const;
export const OUTPUT_FORMATS = ["png", "jpg", "webp"] as const;
export const MAX_COUNT = 6;
export type Mode = (typeof MODES)[number];
/** Skill campaign approaches: 5 keeps the real model's face, 8 generates a new model. They share skills, references and notes. */
export function isSkillCampaign(mode: string): boolean {
  return mode === "5" || mode === "8";
}
/** Approaches whose prompt is written per image by the prompt builder. */
export function usesBuilder(mode: string): boolean {
  return mode === "5" || mode === "7" || mode === "8";
}
/** Approaches that take product folders: only the _01/_02 shots are kept and each product runs as a set. */
export function usesProductSets(mode: string): boolean {
  return usesBuilder(mode) || isNoPrompt(mode);
}
/** No prompt: a background photo and a pose photo from the libraries replace the written prompt. */
export const NO_PROMPT_MODE = "9";
export function isNoPrompt(mode: string): boolean {
  return mode === NO_PROMPT_MODE;
}
/** Reference-library ids of the No prompt approach. */
export const NP_BACKGROUNDS = "np-bg";
export const NP_POSES = "np-pose";
/** The person in the upload is replaced by an AI-generated model; only what is worn is kept. */
export function newModelMode(mode: string): boolean {
  return mode === "8";
}
export type Market = (typeof MARKETS)[number];
export type InputType = (typeof INPUT_TYPES)[number];
export type Ratio = (typeof RATIOS)[number];
export type Size = (typeof SIZES)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** The journey's screens whose analysis feeds the month's logic. */
export const BRIEF_STEPS = ["products", "count", "brand", "theme", "colours", "shots"] as const;
export type BriefStep = (typeof BRIEF_STEPS)[number];

/** One screen's analysis: what was understood, in short points, and the rule it adds. */
export interface BriefNote {
  summary: string;
  points: string[];
  /** One instruction the ideas writer follows. */
  logic: string;
  at: number;
}

export interface Approval {
  status: "approved" | "changes";
  note?: string;
  at: number;
}

/** Batch configuration. Validated on the server by configSchema in config-schema.ts; kept zod-free here so the client bundle stays small. */
export interface Config {
  /** Client (clients.id) the batch is produced for. Required for new batches. */
  client?: string;
  /** Theme (skills.id scoped to the client) that gives the month its visual direction. */
  theme?: string;
  /** Month of the plan, YYYY-MM. */
  month?: string;
  /** Posts planned for the month (default 12). */
  postCount?: number;
  /** Post size; the engine ratio is derived from it. */
  format?: Format;
  /** The month's posts, written by "Generate ideas" and edited by the designer. */
  plan?: Post[];
  /** Designer notes that steer the ideas of this month. */
  notes?: string;
  /** When the plan was last written by the ideas writer; posts generated before it are stale. */
  plannedAt?: number;
  /** Brand ambassadors (ambassadors.id, at most 3) this month's posts may cast. */
  ambassadors?: string[];
  /** Grid mode: the reference photo (refs.id) whose feed grid the month follows, and its read. */
  gridRef?: string;
  gridNotes?: string;
  /** The creative brief of the journey: what each step's analysis understood. */
  brief?: Partial<Record<BriefStep, BriefNote>>;
  /** Secret of the client's approval link (/share/<token>); absent until a link is made. */
  shareToken?: string;
  /** The client's answers on the approval link, by post index. */
  approvals?: Record<string, Approval>;
  mode: Mode;
  /** Kept optional so batches saved before the category picker was removed still load. */
  category?: string;
  input: InputType;
  prompt: string;
  ratio: Ratio;
  size: Size;
  /** Engine model slug chosen for this batch; empty means the server default. */
  model?: string;
  /** Images per original for modes 2-4. Mode 1 always produces six. */
  count: number;
  /** Export format for the ZIP; PNG keeps the engine bytes, JPG/WebP are converted in the browser at export. */
  output: OutputFormat;
  outputQuality: number;
  /** "fit": each JPG/WebP export is re-encoded to land between 1 and 1.9 MB; "quality": use outputQuality as is. */
  outputSize: "fit" | "quality";
  /** Economy mode: Google Flex tier at half price with slower, queued delivery. Google models only. */
  economy: boolean;
  /** Backdrop-colour mode: comma-separated colours, one image per colour. */
  colors: string;
  /** Skill workflow: which ready-made prompt-builder skill writes the per-image prompt. */
  skill: string;
  /** Skill workflow: look of a generated face when the reference face is not visible. */
  market: Market;
  /** Skill workflow: id of a saved look whose prompt leads the direction instead of the reference photos. */
  look?: string;
  /** Studio backdrop for mode 1 cards 2-5; identical across the set. */
  backdrop: string;
  identity?: string;
  modelDescription: string;
  center: boolean;
}

export const FABRIC_CARD = 6;
export const MODE1_CARDS = 6;

/** Colours for the backdrop-colour workflow, in order, at most MAX_COUNT. */
export function backdropColors(c: Config): string[] {
  const list = (c.colors || "")
    .split(/[,\n;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return (list.length ? list : ["pure white"]).slice(0, MAX_COUNT);
}

/** How many generation tasks one lead upload creates. */
export function cardsPerSource(c: Config): number {
  if (c.mode === "1") return MODE1_CARDS;
  if (c.mode === "6") return backdropColors(c).length;
  return Math.min(MAX_COUNT, Math.max(1, c.count || 1));
}

/** Default lifestyle/background direction; editable per batch. */
export const DEFAULT_PROMPT =
  "Premium lifestyle environment with natural lighting and uncluttered surroundings. Preserve the exact product.";

/** Distinct background scenes, one per card, for "fresh background" and lifestyle variety. */
export const SCENES = [
  "Sunlit city street with pale stone facades and soft morning light.",
  "Modern glass-and-concrete building entrance, bright overcast daylight.",
  "Minimal cafe terrace with warm wood and neutral walls.",
  "Quiet residential lane with white walls and green foliage.",
  "Rooftop with a hazy skyline and golden-hour light.",
  "Contemporary art-gallery interior with white walls and soft daylight.",
];

/** What must never change on the garment. */
export const FIDELITY = "colour, print, seams, silhouette and fit";

export const DEFAULT_CONFIG: Config = {
  mode: "5",
  input: "model",
  /** The skill workflow writes its own scene text, so the default prompt is empty there. */
  prompt: "",
  ratio: "1:1",
  size: "2K",
  count: 1,
  backdrop: "warm beige seamless paper backdrop",
  market: "auto",
  skill: "editorial",
  economy: false,
  output: "jpg",
  outputQuality: 90,
  outputSize: "fit",
  colors: "pure white, warm beige, light grey",
  modelDescription: "Adult model, natural proportions, understated fashion styling.",
  center: true,
};

/** Validation that depends on more than one field. Returns an error message or null. */
export function validateConfig(c: Config): string | null {
  if (c.mode === "4" && c.input !== "model") return "Fresh backgrounds need a real model photo.";
  if (c.mode === "3" && c.input !== "model") return "New poses need a real model photo.";
  if (c.mode === "2" && c.input !== "model") return "New face lifestyle needs a real model photo.";
  if (c.mode === "5" && c.input !== "model") return "Skill campaign needs a real model photo.";
  if (c.mode === "8" && c.input !== "model")
    return "Skill campaign (new model) needs a real model photo.";
  if (c.mode === "7" && c.input !== "model") return "Creative direction needs a real model photo.";
  return null;
}

/** Whether an uploaded file with this role creates generation tasks under this config. */
export function createsTasks(c: Config, role: "lead" | "supporting"): boolean {
  // A month of posts creates its tasks from the plan, not from the product uploads.
  if (c.mode === "post") return false;
  return role !== "supporting";
}

/** Engine aspect ratio for a post format. */
export function ratioForFormat(format: Format | undefined): Ratio {
  return format === "9:16" ? "9:16" : format === "4:5" ? "4:5" : "1:1";
}

/** Modes that ship the untouched originals inside the export ZIP. */
export function exportsOriginals(c: Config): boolean {
  return c.mode !== "1" && c.mode !== "post";
}

/** Settings of a new month of posts for a client. */
export function postConfig(
  client: string,
  month: string,
  patch: Partial<Config> = {},
): Config {
  return {
    ...DEFAULT_CONFIG,
    mode: "post",
    client,
    month,
    postCount: 12,
    format: "4:5",
    ratio: "4:5",
    prompt: "",
    skill: "",
    center: false,
    count: 1,
    ...patch,
  };
}
