import type { PostFlag } from "./qa";
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
  /** Who made the month (users.name); on the batches list only. */
  ownerName?: string | null;
  /** Present on the batches list only. */
  spent?: number;
  total?: number;
  completed?: number;
  review?: number;
  failed?: number;
  queued?: number;
  /** Up to three latest result task ids, for previews on the batches page. */
  thumbs?: string[];
  /** When the month went to the bin; null or absent for a live month. */
  deleted?: number | null;
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
  /** What a product photo shows (read by vision) and its kind (gift box, tin...). */
  note?: string | null;
  category?: string | null;
}

/** A product photo of any month of the client, offered again by the journey's gallery. */
export interface GalleryItem {
  id: string;
  name: string;
  note: string;
  category: string;
  month: string;
}

export interface QA {
  found: boolean;
  count: number;
  box: number[];
  productConcern: boolean;
  /** false when the studio card does not show the same face as card 1 */
  sameFace?: boolean;
  notes: string;
  /** Faces in the picture as [x, y, w, h] fractions (from the review): the words never sit on one. */
  faces?: number[][];
  offset?: number;
  centered?: boolean;
  automated: boolean;
  /** Post review: what was found wrong (empty when the post passed). */
  flags?: PostFlag[];
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
  /** What the preflight changed before the engine was paid: JSON {at, notes}. */
  preflight?: string | null;
  /** The post revision the picture in `output` was made for; null for pictures made before lineage was kept. */
  made_for?: number | null;
  /** The post revision the running generation was submitted for. */
  making_for?: number | null;
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
  /** The outfits the brand's people wear this month, one per line. */
  wardrobe: string;
  /** One ready shot per reference picture (collage tiles count), written by Analyse theme. */
  shots: string[];
  /** The month's colours: suggested by Analyse, editable; they replace the references' colours. */
  palette: { name: string; hex: string }[];
  /** true while the palette is still the suggestion; false once the designer changed it. */
  paletteAuto: boolean;
  /** Live months on this theme: a change to its palette reaches all of them. */
  months?: number;
  hidden: boolean;
  references: number;
  thumb?: string;
  updated: number;
  /** When the pins were last read (Analyse), and when the newest pin was added. */
  analysed?: number;
  latestRef?: number;
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
  /** The client's own picture rules (an editorial spec, how its products must be kept): sent with every post. */
  imageRules?: string;
  /** Who the posts speak to, in the team's words; it stands above the Analysis. */
  audience?: string;
  /** The photography direction every picture follows: lens, light, angle (a preset or the team's own words). */
  photography?: string;
  /** "Analyse identity" result, editable. */
  style: string;
  /** A client with no products: what it offers (insurance, banking...); the posts are built around it. */
  service?: string;
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
  /** How many photos of the client's shop, kitchen or factory its Drive holds (as vision read them). */
  drivePlaces?: number;
  /** Photos of the client's own place (shop, café, kitchen), served at /clients/:id/places/:id/file. */
  places: { id: string; name: string }[];
  /** Photos of real people (from Pinterest or uploaded) that show the image model what a real photo of a person looks like. */
  realRefs?: { id: string; name: string }[];
}

/** Team overrides for a production approach card. */
export interface ModeOverride {
  title?: string;
  caption?: string;
  hidden?: boolean;
}

export interface PersonSpend {
  id: string;
  name: string;
  role: string;
  /** All time. */
  pictures: number;
  spent: number;
  months: number;
}

export interface StateResponse {
  user: User;
  batches: Batch[];
  /** Deleted months still in the bin, restorable. */
  trash?: Batch[];
  /** Admin only: what each person spent on pictures, this calendar month and in all. */
  spend?: PersonSpend[];
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
  /** The month's spending ledger (USD list-price estimates): approved by the designer, reserved by attempts. */
  spend?: { approved: number; reserved: number; remaining: number };
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
  /** Picked from a list, never guessed from the description. */
  gender: "man" | "woman" | "";
  /** Shoulders, arms, chest and knees covered (on by default for a family brand). */
  modest: boolean;
  /** A woman who wears a hijab. */
  hijab: boolean;
  /** true when a portrait is stored; served at /ambassadors/:id/image. */
  image: boolean;
  position: number;
  updated: number;
}
