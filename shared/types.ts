import type { Config } from "./config";
import type { OverlaySpec } from "./overlay";

export type TaskStatus = "queued" | "processing" | "ready" | "review" | "approved" | "failed";
export type BatchState = "idle" | "running" | "paused";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export interface Preset {
  id: string;
  name: string;
  config: string;
  created: number;
}

export interface Batch {
  id: string;
  name: string;
  config: string; // JSON of Config
  /** Client the batch is produced for (clients.id); null for batches saved before clients existed. */
  client?: string | null;
  /** Month of a plan of posts (YYYY-MM). */
  month?: string | null;
  theme?: string | null;
  state: BatchState;
  last_error?: string | null;
  created: number;
  updated: number;
  /** Present on the batches list only. */
  spent?: number;
  total?: number;
  completed?: number;
  review?: number;
  failed?: number;
  queued?: number;
  /** Up to three latest result task ids, for previews on the batches page. */
  thumbs?: string[];
}

export interface EngineModel {
  slug: string;
  name: string;
  enabled: boolean;
  reason: string;
}

export interface Source {
  id: string;
  name: string;
  mime: string;
  size: number;
  role: "lead" | "supporting";
  /** product (an upload) or reference (a theme photo standing in for a post without a product). */
  kind?: "product" | "reference";
  created: number;
  /** Skill this photo runs with inside a Zaid creative direction batch; null = the batch's skill. */
  skill?: string | null;
}

export interface QA {
  found: boolean;
  count: number;
  box: number[];
  productConcern: boolean;
  /** false when the studio card does not show the same face as card 1 */
  sameFace?: boolean;
  notes: string;
  offset?: number;
  centered?: boolean;
  automated: boolean;
}

export interface Task {
  id: string;
  source: string;
  card: number;
  status: TaskStatus;
  output: string | null;
  qa: string | null;
  error: string | null;
  prompt: string;
  attempts: number;
  request_id: string | null;
  /** JSON EditorialBrief for editorial-mode tasks. */
  brief: string | null;
  /** Estimated spend so far on this task (all attempts). */
  cost: number;
  updated: number;
  /** Index of the plan post this image belongs to (month of posts). */
  post?: number | null;
  /** Caption and hashtags of the post, editable: JSON {text, hashtags}. */
  caption?: string | null;
}

/** A theme: a client's visual direction with its reference library (stored as a skill row). */
export interface Theme {
  id: string;
  client: string;
  title: string;
  caption: string;
  description: string;
  /** Direction text (goal) the ideas and prompts follow. */
  direction: string;
  /** Visual language written by "Analyse theme" from the references. */
  library: string;
  /** Props the designer wants in the scenes (autumn leaves, pumpkins...). */
  props: string;
  /** One ready shot per reference picture (collage tiles count), written by Analyse theme. */
  shots: string[];
  /** The month's colours: suggested by Analyse, editable; they replace the references' colours. */
  palette: { name: string; hex: string }[];
  /** true while the palette is still the suggestion; false once the designer changed it. */
  paletteAuto: boolean;
  hidden: boolean;
  references: number;
  thumb?: string;
  updated: number;
}

/** A prompt the team liked, saved under a skill to reuse as the direction of later batches. */
export interface LookInfo {
  id: string;
  skill: string;
  name: string;
  scene: string;
  pose: string;
  light: string;
  /** true when a reminder image (the result it was saved from) is stored with it. */
  image: boolean;
  created: number;
}

/** A skill as the team sees and edits it. */
/** The Mood board entry of Creative direction: a built-in the team can rename, hide and star. */
export interface MoodBoardInfo {
  title: string;
  caption: string;
  description: string;
  hidden: boolean;
  favourite: boolean;
}

export interface SkillInfo {
  id: string;
  title: string;
  caption: string;
  description: string;
  goal: string;
  library: string;
  builtIn: boolean;
  edited: boolean;
  /** Text is written from the reference photos and refreshed when they change. */
  auto: boolean;
  /** Starred by the current user. */
  favourite: boolean;
  /** Reference-library photo shown on the card, if the skill has any. */
  thumb?: string;
}

/** A client (brand) Level produces posts for, with its brand kit. */
export interface Client {
  id: string;
  /** Used in export file names: lowercase a-z0-9-. */
  slug: string;
  name: string;
  /** true when a primary logo is stored; served at /clients/:id/logo. */
  logo: boolean;
  /** true when a corner logo (parent or partner mark) is stored; served at /clients/:id/badge. */
  badge: boolean;
  colors: { name: string; hex: string }[];
  fonts: { headline?: string; body?: string };
  tone: string;
  dos: string;
  donts: string;
  /** "Analyse identity" result, editable. */
  style: string;
  gridRhythm: string;
  language: "ar" | "en" | "both";
  status: "active" | "archived";
  position: number;
  /** Number of batches filed under this client. */
  batches: number;
  updated: number;
  /** Headline and logo placement drawn over each post; null = the Clean template. */
  overlay: Partial<OverlaySpec> | null;
  /** Uploaded brand font files, served at /clients/:id/fonts/:id/file. */
  fontFiles: { id: string; name: string }[];
}

/** Team overrides for a production approach card. */
export interface ModeOverride {
  title?: string;
  caption?: string;
  hidden?: boolean;
}

export interface StateResponse {
  user: User;
  batches: Batch[];
  spendThreshold: number;
  zaidDirection: string;
  /** Creative direction's Mood board entry (name, tagline, hidden, starred). */
  moodBoard?: MoodBoardInfo;
  /** Renamed or hidden production approaches, keyed by mode id. */
  modes: Record<string, ModeOverride>;
  /** Active clients in card order. */
  clients: Client[];
  /** Version stamp of the uploaded hero video, empty when none. */
  hero: string;
  engine: {
    model: string;
    configured: boolean;
    source: "secret" | "stored" | "none";
    openai: "secret" | "stored" | "none";
    google: "secret" | "stored" | "none";
    fal: "secret" | "stored" | "none";
    review: boolean;
    /** Google Cloud (Vertex AI) service account, when one is saved; it takes over every Google call. */
    vertex?: { project: string; location: string } | null;
  };
}

export interface BatchResponse {
  batch: Batch;
  sources: Source[];
  tasks: Task[];
}

export interface BatchSummary {
  total: number;
  completed: number;
  queued: number;
  processing: number;
  review: number;
  ready: number;
  failed: number;
}

export type { Config };

/** A recurring AI person of a client's posts; the portrait keeps the face the same everywhere. */
export interface Ambassador {
  id: string;
  client: string;
  name: string;
  /** Look: gender, age, features, hair, styling. Written by the designer. */
  description: string;
  /** true when a portrait is stored; served at /ambassadors/:id/image. */
  image: boolean;
  position: number;
  updated: number;
}
