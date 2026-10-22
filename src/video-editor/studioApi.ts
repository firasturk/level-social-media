/** The Video studio's own routes: the preset gallery, Magnific's video tools, Higgsfield's clip tools and checks. */
import { get, post } from "@/api";
import type { PresetCard, PresetCategory, PresetCategoryId, PresetDetail } from "@shared/video-presets";
import type { FrameFill, FrameId } from "@shared/video-frame";
import type { VideoItem } from "@/studio/videoApi";

export interface Access {
  admin: boolean;
  enabled: boolean;
  reason: string;
}

export interface PresetList {
  category: PresetCategoryId;
  categories: PresetCategory[];
  items: PresetCard[];
  nextCursor: string | null;
  cachedAt: number | null;
  cached: boolean;
  signedIn: boolean;
  admin: boolean;
  access: Access;
  billing: "credits" | "cloud";
  /** Why the list is empty, when it is for a reason (not signed in, switched off); "" otherwise. */
  reason: string;
  /** "Nothing in this category on your plan yet." */
  empty: string;
}

export function listPresets(category: PresetCategoryId, opts: { q?: string; cursor?: string | null; refresh?: boolean } = {}): Promise<PresetList> {
  const qs = new URLSearchParams({ category });
  if (opts.q) qs.set("q", opts.q);
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.refresh) qs.set("refresh", "1");
  return get<PresetList>(`/api/studio/video/presets?${qs}`);
}

export function presetDetail(id: string, source: string, post?: { batch: string; index: number } | null): Promise<{ preset: PresetDetail; readinessError: string; admin: boolean }> {
  const qs = new URLSearchParams({ source });
  if (post) {
    qs.set("batch", post.batch);
    qs.set("index", String(post.index));
  }
  return get(`/api/studio/video/presets/${encodeURIComponent(id)}?${qs}`);
}

export function runPreset(body: { batch: string; index: number; presetId: string; source: string; inputs?: Record<string, unknown>; confirm?: boolean }): Promise<{ video: VideoItem }> {
  return post("/api/studio/video/presets/run", body);
}

/* ───────────── Magnific ───────────── */

export interface MagnificVideoModel {
  slug: string;
  name: string;
  description: string;
  durations: number[];
  aspectRatios: string[];
  resolutions: string[];
  recommended: boolean;
  recommendation: string;
  imageToVideo: boolean;
}

export interface MagnificStatus {
  connected: boolean;
  source: "signin" | "token" | null;
  admin: boolean;
  access: Access;
  tools: { name: string; label: string; hint: string }[];
  reason: string;
}

export const magnificStatus = () => get<MagnificStatus>("/api/studio/video/magnific/status");
export const magnificModels = (refresh = false) => get<{ models: MagnificVideoModel[]; at: number }>(`/api/studio/video/magnific/models${refresh ? "?refresh=1" : ""}`);
export const magnificLuts = () => get<{ luts: { id: string; name: string }[] }>("/api/studio/video/magnific/luts");

export interface MagnificGenerateAsk {
  batch: string;
  index: number;
  slug: string;
  prompt: string;
  duration: number;
  aspectRatio?: string;
  resolution?: string;
  source: "picture" | "artwork";
  artwork?: string;
  withSoundEffects?: boolean;
  confirm?: boolean;
  /** The frame asked for, how the picture was fitted to it (when the browser did), and whether the words are in it. */
  frame?: FrameId;
  fill?: FrameFill;
  words?: boolean;
}
export const magnificGenerate = (ask: MagnificGenerateAsk) => post<{ video: VideoItem }>("/api/studio/video/magnific/generate", ask);
export const magnificEnhance = (body: { batch: string; videoId: string; tool: string; arguments: Record<string, unknown>; confirm?: boolean }) => post<{ video: VideoItem }>("/api/studio/video/magnific/enhance", body);

/* ───────────── Higgsfield clip tools and checks ───────────── */

export interface HiggsfieldTools {
  signedIn: boolean;
  billing: "credits" | "cloud";
  admin: boolean;
  access: Access;
  reason: string;
  available: Record<string, boolean>;
  tools: { name: string; label: string; hint: string; available: boolean }[];
  checks: { name: string; label: string; hint: string; available: boolean }[];
}

export const higgsfieldTools = () => get<HiggsfieldTools>("/api/studio/video/higgsfield/tools");
export const higgsfieldTool = (body: { batch: string; videoId: string; tool: string; arguments: Record<string, unknown>; confirm?: boolean }) => post<{ video: VideoItem }>("/api/studio/video/higgsfield/tool", body);
export const higgsfieldCheck = (body: { batch: string; videoId: string; tool: string; confirm?: boolean }) => post<{ video: VideoItem }>("/api/studio/video/higgsfield/check", body);
export const higgsfieldCheckStatus = (batch: string, videoId: string) => get<{ video: VideoItem }>(`/api/studio/video/higgsfield/check/status?batch=${encodeURIComponent(batch)}&videoId=${encodeURIComponent(videoId)}`);

/** A 409 answer that asks for a confirm, an estimate, a choice, or says the run is blocked. */
export interface ConfirmAsk {
  needsConfirm?: boolean;
  needsEstimate?: boolean;
  blocked?: boolean;
  credits?: number | null;
  estimate?: number | null;
  balance?: number | null;
  unlimChoice?: unknown;
  notSignedIn?: boolean;
  connected?: boolean;
  billing?: string;
  outcomeUnknown?: boolean;
  notAvailable?: boolean;
}
