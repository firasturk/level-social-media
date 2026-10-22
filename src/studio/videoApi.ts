/** The studio's view of a post's video versions: the routes under /api/studio/posts/video and their shapes. */
import { get, post } from "@/api";
import type { VideoModel } from "@shared/video-models";

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
