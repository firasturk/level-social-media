/**
 * The Prompt Box's hands: the one place the box calls a provider. Every tool the box can run
 * (Freepik search and use, a Higgsfield video, a Photo Lab edit) goes through this adapter, so the
 * sibling integrations plug in here at merge and nowhere else:
 *
 * - Freepik (int/freepik): `GET /api/studio/freepik/search`, `POST /api/studio/freepik/use` → the
 *   functions behind them replace `freepikSearch` and `freepikUse` (today: a fixture).
 * - Video (int/video): `POST /api/studio/posts/video` {batch, index, model, prompt, duration,
 *   aspect, source, artwork?} → replaces `videoGenerate` (today: the engine's image-to-video call
 *   this build already has, which ignores aspect and source).
 * - Photo Lab: not in this build; `photolabRun` refuses until it is wired.
 *
 * Tests and the merge swap a tool with `setPromptboxTools`; the routes only ever call `promptboxTools`.
 */
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { makeClient } from "./engine";
import { signObjectUrl } from "./signed";
import { VIDEO_MODELS } from "@shared/qa";
import type { User } from "@shared/types";

export interface FreepikAsset {
  id: string;
  source: "freepik";
  title: string;
  /** The preview the card and the results show. */
  url: string;
  type: string;
  premium: boolean;
}

export interface SearchQuery {
  q: string;
  type: string;
  orientation: string;
  page: number;
}
export interface SearchResult {
  results: FreepikAsset[];
  page: number;
  more: boolean;
  /** True when the answer came from the fixture, not Freepik. */
  fixture: boolean;
}

export interface UseRequest {
  asset: { id: string; source: string; url?: string; title?: string };
  batch: string;
  post: number;
  slide?: number | null;
  role: "design" | "reference";
  placement?: string;
}

export interface VideoRequest {
  batch: string;
  index: number;
  model: string;
  prompt: string;
  duration: number;
  aspect: string;
  source: "picture" | "artwork";
  artwork?: string;
}

export interface PhotolabRequest {
  batch: string;
  post: number;
  operation: string;
  prompt: string;
}

export interface PromptboxTools {
  freepikSearch(env: Env, user: User, q: SearchQuery): Promise<SearchResult>;
  freepikUse(env: Env, user: User, r: UseRequest): Promise<{ ok: true; note: string; fixture: boolean }>;
  videoGenerate(env: Env, user: User, v: VideoRequest): Promise<{ ok: true; video: { id: string; status: string } | null; note: string }>;
  videoList(env: Env, user: User, q: { batch: string; index: number }): Promise<{ videos: { id: string; post: number; status: string }[] }>;
  photolabRun(env: Env, user: User, p: PhotolabRequest): Promise<{ ok: true; note: string; fixture: boolean }>;
}

const DEMO = "DEMO FIXTURE";

/** Deterministic stock results for a query: the same words give the same six assets, no network. */
export function fixtureSearch(q: SearchQuery): SearchResult {
  const words = q.q.trim().toLowerCase() || "background";
  let seed = 0;
  for (const ch of words) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const results: FreepikAsset[] = Array.from({ length: 6 }, (_, i) => {
    const n = (seed + i * 7919 + (q.page - 1) * 6) % 100_000;
    return {
      id: `fp-${n}`,
      source: "freepik",
      title: `${DEMO}: ${words} ${i + 1}${q.orientation ? ` (${q.orientation})` : ""}`,
      url: `https://img.freepik.test/${q.type || "photo"}/${n}.jpg`,
      type: q.type || "photo",
      premium: i % 3 === 2,
    };
  });
  return { results, page: q.page, more: q.page < 3, fixture: true };
}

const defaults: PromptboxTools = {
  async freepikSearch(_env, _user, q) {
    // At merge: the search function behind GET /api/studio/freepik/search (int/freepik).
    return fixtureSearch(q);
  },
  async freepikUse(_env, _user, r) {
    // At merge: the function behind POST /api/studio/freepik/use (int/freepik): the asset is downloaded
    // (confirmed there), stored, and set on the post as a reference or a design layer.
    return { ok: true, note: `${DEMO}: asset ${r.asset.id} noted for post ${r.post} as ${r.role === "design" ? "a design layer" : "a reference"}; the Freepik route stores it once wired.`, fixture: true };
  },
  async videoGenerate(env, user, v) {
    // At merge: the function behind POST /api/studio/posts/video (int/video), which also takes aspect,
    // source and artwork. Until then: this build's image-to-video call, the same one the Video dialog makes.
    const model = VIDEO_MODELS.find((m) => m.slug === v.model);
    if (!model) throw new StudioError("Unknown video engine.", 400);
    const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", v.batch, v.index);
    if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
    if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
    const engine = await makeClient(env);
    const id = uuid();
    const requestId = await engine.submitVideo({ model: model.slug, prompt: v.prompt, imageUrl: await signObjectUrl(env, t.output, 6 * 60 * 60 * 1000), duration: v.duration, resolution: model.resolution });
    await run(env.DB, "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)", id, v.batch, v.index, t.id, user.id, model.slug, v.prompt, requestId, now(), now());
    return { ok: true, video: { id, status: "queued" }, note: `The clip is queued on ${model.name}; it appears under the post's videos when done.` };
  },
  async videoList(env, _user, q) {
    const rows = await all<{ id: string; post: number; status: string }>(env.DB, "SELECT id, post, status FROM videos WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 12", q.batch, q.index);
    return { videos: rows };
  },
  async photolabRun() {
    throw new StudioError("Photo Lab is not connected in this build yet.", 503);
  },
};

let current: PromptboxTools = { ...defaults };

/** The tools the routes call; swapped by tests and by the integrations at merge. */
export const promptboxTools: PromptboxTools = {
  freepikSearch: (...a) => current.freepikSearch(...a),
  freepikUse: (...a) => current.freepikUse(...a),
  videoGenerate: (...a) => current.videoGenerate(...a),
  videoList: (...a) => current.videoList(...a),
  photolabRun: (...a) => current.photolabRun(...a),
};

/** Replaces one or more tools; returns a function that puts the previous ones back. */
export function setPromptboxTools(patch: Partial<PromptboxTools>): () => void {
  const before = current;
  current = { ...current, ...patch };
  return () => {
    current = before;
  };
}
