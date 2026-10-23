/** The Photo studio's own routes: the preset gallery (pictures only) and the AI tools on the post's picture. */
import { get, post } from "@/api";
import type { PhotoPresetCard, PhotoPresetCategory, PhotoPresetCategoryId, PhotoPresetDetail } from "@shared/photo-presets";
import type { PhotoToolJob, ToolCatalog } from "@shared/photo-tools";
import type { HoldReason } from "@shared/client-hold";

export interface Access {
  admin: boolean;
  enabled: boolean;
  reason: string;
}

export interface PhotoPresetList {
  category: PhotoPresetCategoryId;
  categories: PhotoPresetCategory[];
  provider: "higgsfield" | "magnific";
  items: PhotoPresetCard[];
  cachedAt: number | null;
  cached: boolean;
  signedIn: boolean;
  admin: boolean;
  access: Access;
  /** Why the list is empty, when it is for a reason (not signed in, switched off); "" otherwise. */
  reason: string;
  empty: string;
}

export function listPhotoPresets(category: PhotoPresetCategoryId, opts: { q?: string; refresh?: boolean } = {}): Promise<PhotoPresetList> {
  const qs = new URLSearchParams({ category });
  if (opts.q) qs.set("q", opts.q);
  if (opts.refresh) qs.set("refresh", "1");
  return get<PhotoPresetList>(`/api/studio/photo/presets?${qs}`);
}

export function photoPresetDetail(id: string, source: string, post?: { batch: string; index: number } | null): Promise<{ preset: PhotoPresetDetail; readinessError: string; admin: boolean }> {
  const qs = new URLSearchParams({ source });
  if (post) {
    qs.set("batch", post.batch);
    qs.set("index", String(post.index));
  }
  return get(`/api/studio/photo/presets/${encodeURIComponent(id)}?${qs}`);
}

/** The post's product in words (the Drive photo's name and note, the product photo, or the title; the brand kit's look), for the engine. Nothing is called or paid. */
export function presetProduct(p: { batch: string; index: number }): Promise<{ text: string; from: string[]; picture: { key: string; name: string; from: string } | null }> {
  return get(`/api/studio/photo/presets/product?batch=${encodeURIComponent(p.batch)}&index=${p.index}`);
}

export function runPhotoPreset(body: { batch: string; index: number; presetId: string; source: string; inputs?: Record<string, string>; confirm?: boolean; picture?: "product" | "post" }): Promise<{ job: PhotoToolJob }> {
  return post("/api/studio/photo/presets/run", body);
}

export const toolCatalog = (refresh = false) => get<ToolCatalog>(`/api/studio/photo/tools/catalog${refresh ? "?refresh=1" : ""}`);

export interface ToolAsk {
  batch: string;
  index: number;
  tool: string;
  options: Record<string, string>;
}

export interface ToolEstimate {
  credits: number | null;
  balance: number | null;
  unit: "credits";
  notes: string[];
  text: string;
}

export const toolEstimate = (ask: ToolAsk) => post<ToolEstimate>("/api/studio/photo/tools/estimate", ask);
export const toolRun = (ask: ToolAsk & { confirm?: boolean }) => post<{ job: PhotoToolJob }>("/api/studio/photo/tools/run", ask);
export const toolJobs = (batch: string, index: number) => get<{ jobs: PhotoToolJob[] }>(`/api/studio/photo/tools/jobs?batch=${encodeURIComponent(batch)}&index=${index}`);
/** `held`: the client answered the post, so the result was kept as a new version beside the client's (Send it for review makes it theirs). */
export const applyToolResult = (id: string, body: { as: "picture" | "product"; batch: string; post?: number }) => post<{ ok: true; key?: string; source?: { name: string }; held?: HoldReason | null; message?: string }>(`/api/studio/photo/tools/jobs/${encodeURIComponent(id)}/use`, body);
/** The result kept beside the post as new posts (variations: one post per picture of the grid). Nothing is run or paid. Admins. */
export const addResultAsPosts = (id: string, batch: string, as: "posts" | "carousel") => post<{ ok: true; posts: number[]; carousel: boolean }>(`/api/studio/photo/tools/jobs/${encodeURIComponent(id)}/posts`, { batch, as });
/** "Check again" on a job recorded as failed: the provider is asked for its status (free; nothing is run again). Admins. */
export const recheckToolJob = (id: string) => post<{ ok: true; outcome: "done" | "running" | "failed" | "unknown"; message: string; job: PhotoToolJob }>(`/api/studio/photo/tools/jobs/${encodeURIComponent(id)}/check`);

/** A 409 answer that asks for a confirm, says the cost is not known, or says the run is blocked. */
export interface ConfirmAsk {
  needsConfirm?: boolean;
  needsEstimate?: boolean;
  blocked?: boolean;
  credits?: number | null;
  balance?: number | null;
  connected?: boolean;
  notSignedIn?: boolean;
  outcomeUnknown?: boolean;
}
