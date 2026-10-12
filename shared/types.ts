import type { Config } from "./config";

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
