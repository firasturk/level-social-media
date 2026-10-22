/** The studio's view of a post's video versions: the routes under /api/studio/posts/video and their shapes. */
import { get, post, postForm } from "@/api";
import type { VideoModel } from "@shared/video-models";
import { audioChoiceLine, type AudioChoice } from "@shared/video-audio";

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
  /** "Video 2": the clip's number among the post's clips, oldest first. */
  version: number;
  warnings: string[];
  /** The version's audio choice (shared/video-audio.ts), or what the generation settings imply; null when neither. */
  audioChoice: AudioChoice | null;
  audioId: string | null;
  audioName: string | null;
}

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
}

export interface VideoSummary {
  posts: Record<string, { latest: VideoItem; client: VideoItem | null; done: VideoItem | null }>;
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
