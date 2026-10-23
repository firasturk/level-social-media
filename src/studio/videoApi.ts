/** The studio's view of a post's video versions: the routes under /api/studio/posts/video and their shapes. */
import { get, post, postForm } from "@/api";
import type { VideoModel } from "@shared/video-models";
import { audioChoiceLine, type AudioChoice } from "@shared/video-audio";
import { frameLabel, type FrameFill, type FrameId } from "@shared/video-frame";

export type VideoStatus = "queued" | "generating" | "done" | "failed";

export interface VideoItem {
  id: string;
  post: number;
  model: string;
  provider: string;
  source: "picture" | "artwork" | "upload" | "editor";
  prompt: string;
  status: VideoStatus;
  error: string | null;
  created: number;
  updated: number;
  duration: number | null;
  aspect: string | null;
  resolution: string | null;
  estimate: number | null;
  forClient: boolean;
  requestId: string | null;
  url: string | null;
  poster: string | null;
  /** The lightweight preview rendition (small, short, muted) for cards and galleries; null or absent: play `url`. */
  preview?: string | null;
  /** "Video 2": the clip's number among the post's clips, oldest first. */
  version: number;
  warnings: string[];
  /** The version's audio choice (shared/video-audio.ts), or what the generation settings imply; null when neither. */
  audioChoice: AudioChoice | null;
  audioId: string | null;
  audioName: string | null;
  /** What made this version, when the maker said ("Preset · Hero shot", "Magnific · Kling"); null for the plain engines. */
  label: string | null;
  /** The last Check answer kept on this version (the Video studio). */
  check: { tool: string; at: number; text: string; credits: number | null } | null;
  analysis: { id: string; status: string; text: string; at: number } | null;
  /** The frame asked for ("9:16"); null for older versions and uploads. */
  frame: FrameId | null;
  /** How the picture was fitted to the frame in the browser ("crop" | "blur"); null when the engine took the frame itself. */
  frameFill: FrameFill | null;
  /** True when the words and logo are in the first frame, false for the bare picture, null when not known. */
  words: boolean | null;
  /** The encoded size read from the stored file, when known. */
  width?: number | null;
  height?: number | null;
  /** The editor project and saved revision an editor render was made from. */
  project?: { id: string; rev: number } | null;
}

/** "Reel 9:16", "Reel 9:16 · blurred edges", or "" when the version carries no frame. */
export function frameLine(v: VideoItem): string {
  const label = frameLabel(v.frame);
  if (!label) return "";
  return v.frameFill === "blur" ? `${label} · blurred edges` : v.frameFill === "crop" ? `${label} · cropped to fit` : label;
}

/** "with words and logo", "bare picture", or "" (an upload or a cut). */
export function inputLine(v: VideoItem): string {
  if (v.words === true) return "with words and logo";
  if (v.words === false) return "bare picture";
  return "";
}

/** The `provider` of a clip made or changed by Magnific. */
export const MAGNIFIC_PROVIDER = "magnific";

/** A track kept with the post: an upload the team licensed (generated ones come when a provider is connected). */
export interface AudioTrack {
  id: string;
  post: number;
  kind: "upload" | "generated";
  name: string;
  mime: string | null;
  durationMs: number | null;
  license: string;
  provider: string | null;
  created: number;
  createdBy: string;
  url: string | null;
}

export interface AudioList {
  tracks: AudioTrack[];
  access: { admin: boolean; enabled: boolean; reason: string };
  generated: { connected: boolean; reason: string };
}

export interface VideoList {
  videos: VideoItem[];
  engines: VideoModel[];
  /** The known price per clip of each engine (catalog or the admin's setting), null when unknown. */
  prices: Record<string, number | null>;
  admin: boolean;
  /** Which Higgsfield account pays: the subscription credits (sign-in) or the Cloud API key. */
  billing: HiggsfieldBilling;
}

/* ───────────── Higgsfield subscription credits (the MCP sign-in, docs/higgsfield-mcp.md) ───────────── */

export type HiggsfieldBilling = "credits" | "cloud";
/** The `provider` of a clip made on the subscription credits. */
export const MCP_PROVIDER = "higgsfield-mcp";

export interface HiggsfieldMcpStatus {
  signedIn: boolean;
  email: string | null;
  signedInAt: number | null;
  plan: string | null;
  credits: number | null;
  creditsAt: number | null;
  balanceError: string;
  billing: HiggsfieldBilling;
  /** False while the admin has not chosen: the choice shown is the default (credits once signed in). */
  billingChosen: boolean;
  cloudConfigured: boolean;
  admin: boolean;
  switch: { enabled: boolean };
  access: { admin: boolean; enabled: boolean; reason: string };
  url: string;
  /** A device-flow sign-in in progress (the fallback when the redirect registration is refused). */
  device: { userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expires: number; refused: string } | null;
}

export interface McpVideoModel {
  id: string;
  name: string;
  description: string;
  durations: number[];
  aspects: string[];
  supportsUnlim: boolean;
}

export interface McpAsk {
  batch: string;
  index: number;
  model: string;
  prompt: string;
  duration?: number;
  aspect?: string;
  source: "picture" | "artwork";
  artwork?: string;
  useUnlim?: boolean;
  /** The frame asked for, how the picture was fitted to it (when the browser did), and whether the words are in it. */
  frame?: FrameId;
  fill?: FrameFill;
  words?: boolean;
}

export const mcpStatus = (fresh = false) => get<HiggsfieldMcpStatus>(`/api/studio/higgsfield/mcp/status${fresh ? "?fresh=1" : ""}`);
export const mcpModels = (refresh = false) => get<{ models: McpVideoModel[]; at: number }>(`/api/studio/higgsfield/mcp/models${refresh ? "?refresh=1" : ""}`);
export const mcpEstimate = (ask: McpAsk) => post<{ credits: number | null; balance: number | null; plan: string | null; unlimChoice: unknown }>("/api/studio/higgsfield/mcp/estimate", ask);
export const mcpGenerate = (ask: McpAsk & { confirm: boolean; note?: string }) => post<{ video: VideoItem }>("/api/studio/higgsfield/mcp/generate", ask);

/** "Uploaded", "Higgsfield (credits) · seedance_2_5", or the Cloud engine's name. */
export function engineLabel(v: VideoItem, cloudName: (slug: string) => string | undefined): string {
  if (v.provider === "upload") return "Uploaded";
  if (v.provider === "editor") return "Video studio cut";
  if (v.label) return `${v.provider === MCP_PROVIDER ? "Higgsfield (credits)" : v.provider === MAGNIFIC_PROVIDER ? "Magnific" : v.provider} · ${v.label}`;
  if (v.provider === MCP_PROVIDER) return `Higgsfield (credits) · ${v.model}`;
  if (v.provider === MAGNIFIC_PROVIDER) return `Magnific · ${v.model.replace(/^magnific:/, "")}`;
  return cloudName(v.model) ?? v.model;
}

/** The clip's estimate as the list shows it: "12 credits" on the subscription, "$0.094" on the Cloud API, "" when none. */
export function costLabel(v: VideoItem): string {
  if (v.estimate === null || v.estimate <= 0) return "";
  if (v.provider === MCP_PROVIDER || v.provider === MAGNIFIC_PROVIDER) return `${v.estimate} credits`;
  return `$${v.estimate.toFixed(v.estimate < 1 ? 3 : 2)}`;
}

export interface VideoSummary {
  /** Per post: the newest clip, the client's version, the newest finished clip, and the card's version (a render put there, or the last explicit choice). */
  posts: Record<string, { latest: VideoItem; client: VideoItem | null; done: VideoItem | null; card?: VideoItem | null }>;
}

export const inFlight = (v: VideoItem | null | undefined) => !!v && (v.status === "queued" || v.status === "generating");

export function listVideos(batchId: string, index: number): Promise<VideoList> {
  return get<VideoList>(`/api/studio/posts/video/list?batch=${encodeURIComponent(batchId)}&index=${index}`);
}

export function videoSummary(batchId: string): Promise<VideoSummary> {
  return get<VideoSummary>(`/api/studio/posts/video/summary?batch=${encodeURIComponent(batchId)}`);
}

/** The version the client reviews on the link: one clip by id, or null for the picture alone. */
export function selectForClient(batchId: string, index: number, id: string | null): Promise<{ videos: VideoItem[] }> {
  return post<{ videos: VideoItem[] }>("/api/studio/posts/video/select", { batch: batchId, index, id });
}

/**
 * "Send for review" on a clip held beside the client's version: it becomes the client's version and
 * the client's earlier answer on the post is cleared, so they answer the new one (as a picture sent
 * for review does). Until the client answers again, edits on the post reach the link directly.
 */
export async function sendVideoForReview(batchId: string, index: number, id: string): Promise<{ videos: VideoItem[] }> {
  const r = await selectForClient(batchId, index, id);
  await post("/api/studio/posts/versions/send-for-review", { batch: batchId, index });
  return r;
}

/** "Check again" on a clip recorded as failed: the provider is asked whether it finished after all (a status read, free; nothing is made again). Admins. */
export function recheckVideo(batchId: string, id: string): Promise<{ outcome: "done" | "running" | "failed" | "unknown"; message: string; video: VideoItem }> {
  return post("/api/studio/posts/video/check", { batch: batchId, id });
}

export function retryVideo(batchId: string, id: string, confirm = false): Promise<{ video: VideoItem }> {
  return post<{ video: VideoItem }>("/api/studio/posts/video/retry", { batch: batchId, id, confirm });
}

export const versionLabel = (v: VideoItem) => `Video ${v.version} (${new Date(v.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})`;

export const STATUS_TEXT: Record<VideoStatus, string> = {
  queued: "Queued at Higgsfield",
  generating: "Making the video",
  done: "Ready",
  failed: "Failed",
};

/* ───────────── Audio (docs/video.md "Audio") ───────────── */

export function listAudio(batchId: string, index: number): Promise<AudioList> {
  return get<AudioList>(`/api/studio/posts/video/audio/list?batch=${encodeURIComponent(batchId)}&post=${index}`);
}

/** A licensed track uploaded for the post; `durationMs` is what the browser read from the file, when it could. */
export function uploadAudio(batchId: string, index: number, file: File, meta: { name: string; license: string; durationMs: number | null }): Promise<{ track: AudioTrack; tracks: AudioTrack[] }> {
  const form = new FormData();
  form.set("batch", batchId);
  form.set("post", String(index));
  form.set("file", file);
  form.set("name", meta.name);
  form.set("license", meta.license);
  if (meta.durationMs) form.set("duration", String(meta.durationMs));
  return postForm<{ track: AudioTrack; tracks: AudioTrack[] }>("/api/studio/posts/video/audio/upload", form);
}

/** The audio choice of one version: written on the version, nothing sent anywhere. */
export function chooseAudio(batchId: string, index: number, videoId: string, choice: AudioChoice, audioId?: string): Promise<{ videos: VideoItem[] }> {
  return post<{ videos: VideoItem[] }>("/api/studio/posts/video/audio/choose", { batch: batchId, index, videoId, choice, audioId });
}

/** "Engine sound", "No sound", "Track: name", "Music added on Instagram" — or null when the version carries no choice. */
export const audioLine = (v: VideoItem) => audioChoiceLine(v.audioChoice, v.audioName);

/** The length of a track as the list shows it ("0:32"). */
export function audioDuration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
