/**
 * The Prompt Box's hands: the one place the box calls a provider. Every tool the box can run
 * (Freepik search and use, a Higgsfield video, a Photo lab edit) goes through this adapter:
 *
 * - Freepik: the same search and library functions as /api/studio/freepik (server/freepik.ts).
 * - Video: the same submission as POST /api/studio/posts/video (server/video.ts).
 * - Photo lab: the same propose → confirm → run as /api/studio/photolab/run (server/photolab.ts).
 *
 * The routes in server/promptbox.ts have already checked the admin, the switch and the person's
 * confirmation; each function here records the provider's own ledger row as the dialogs do.
 * Tests swap a tool with `setPromptboxTools`; the routes only ever call `promptboxTools`.
 */
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first } from "./db";
import { downloadAsset, resolveFreepik, useAsset } from "./freepik";
import { submitVideoRequest } from "./video";
import { higgsfieldBilling } from "./higgsfield-billing";
import { HiggsfieldMcp, matchMcpModel, mcpModels, submitMcpVideo } from "./higgsfield-mcp";
import { videoModel } from "@shared/video-models";
import { PHOTO_LAB_OPS, proposePhotoLab, runPhotoLabJob } from "./photolab";
import { confirmSpend } from "./integrations";
import { PHOTO_LAB_PRICES, type PhotoLabOp } from "@shared/pricing";
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

/** The Photo lab operation a sentence named: the four the lab offers, or a clear refusal. */
export function photoLabOp(operation: string): PhotoLabOp {
  const o = operation.toLowerCase();
  if (/upscal|enhance|sharpen|bigger/.test(o)) return "upscale";
  if (/remove|cut/.test(o)) return "remove-bg";
  if (/relight|light/.test(o)) return "relight";
  if (/background|replace|scene/.test(o)) return "background";
  throw new StudioError(`The Photo lab does not do "${operation}". It offers: ${PHOTO_LAB_OPS.join(", ")}.`, 400);
}

const defaults: PromptboxTools = {
  async freepikSearch(env, _user, q) {
    const fp = await resolveFreepik(env);
    const type = q.type === "photo" || q.type === "vector" || q.type === "psd" || q.type === "template" ? q.type : "";
    const orientation = q.orientation === "landscape" || q.orientation === "portrait" || q.orientation === "square" || q.orientation === "panoramic" ? q.orientation : "";
    // The box's route has already recorded this search in the ledger (estimate 0); only the provider is asked here.
    const r = await fp.provider.search({ q: q.q, type, orientation, page: q.page });
    return {
      results: r.items.map((it) => ({ id: it.id, source: "freepik" as const, title: `${r.demo ? "Demo · " : ""}${it.title}`, url: it.preview, type: it.kind, premium: it.license.type === "premium" })),
      page: r.page,
      more: r.page < r.lastPage,
      fixture: r.demo,
    };
  },
  async freepikUse(env, user, r) {
    const b = await first<{ client: string | null }>(env.DB, "SELECT client FROM batches WHERE id = ?", r.batch);
    const fp = await resolveFreepik(env);
    // The person confirmed the card; a download the plan does not include is still refused here (cost not known).
    const got = await downloadAsset(env, user, r.asset.id, { confirm: true, client: b?.client ?? null, batch: r.batch, post: r.post });
    const out = await useAsset(env, user, { asset: got.asset.id, batch: r.batch, post: r.post, slide: r.slide ?? null, role: r.role });
    const where = r.role === "design" ? "added to the design as a layer" : "set as the reference for the next take";
    return { ok: true, note: `${got.asset.title}: ${where} on post ${r.post}${got.reused ? " (already in the library)" : ""}.${out.layer?.flattened ? " It is a flattened picture, not editable layers." : ""}`, fixture: !fp.connected };
  },
  async videoGenerate(env, user, v) {
    // The box confirmed the clip (with the admin's estimate when the catalog has none), so an unknown cost is not asked about twice.
    const model = videoModel(v.model);
    if (!model) throw new StudioError("Unknown video engine.", 400);
    if ((await higgsfieldBilling(env)) === "credits") {
      // The subscription credits: the box names a Cloud catalog engine; the matching one on the subscription catalog runs it.
      const mcp = new HiggsfieldMcp(env);
      await mcp.connect();
      const { models } = await mcpModels(env, mcp);
      const engine = matchMcpModel(models, v.model) ?? matchMcpModel(models, model.name);
      if (!engine) throw new StudioError(`${model.name} is not on the Higgsfield subscription catalog. Open the Video dialog on the post to pick one of its engines, or switch the billing to the Cloud API under Connection → Higgsfield.`, 409);
      try {
        const item = await submitMcpVideo(env, user, { batch: v.batch, index: v.index, model: engine.id, prompt: v.prompt, duration: engine.durations.length && !engine.durations.includes(v.duration) ? undefined : v.duration, aspect: v.aspect && engine.aspects.includes(v.aspect) ? v.aspect : undefined, source: v.source, artwork: v.artwork, confirm: true, note: "from the Prompt Box" });
        return { ok: true, video: { id: item.id, status: item.status }, note: `Video ${item.version} is being made on ${engine.name} with the subscription credits${item.estimate !== null ? ` (about ${item.estimate} credits)` : ""}; it appears on the card and under Versions when done.` };
      } catch (e) {
        if (e instanceof StudioError && e.data?.unlimChoice) throw new StudioError(`${e.message} Open the Video dialog on post ${v.index} to choose.`, 409, false, e.data);
        throw e;
      }
    }
    // An engine without a frame choice follows the picture's own frame; the card's default frame is not forced on it.
    const aspect = model.aspect ? v.aspect : undefined;
    const item = await submitVideoRequest(env, user, { batch: v.batch, index: v.index, model: v.model, prompt: v.prompt, duration: v.duration, aspect, source: v.source, artwork: v.artwork, confirm: true, note: "from the Prompt Box" });
    return { ok: true, video: { id: item.id, status: item.status }, note: `Video ${item.version} is being made on ${model.name}${model.aspect ? "" : " (it follows the picture's own frame)"}; it appears on the card and under Versions when done.` };
  },
  async videoList(env, _user, q) {
    const rows = await all<{ id: string; post: number; status: string }>(env.DB, "SELECT id, post, status FROM videos WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 12", q.batch, q.index);
    return { videos: rows };
  },
  async photolabRun(env, user, p) {
    const b = await first<{ client: string | null }>(env.DB, "SELECT client FROM batches WHERE id = ?", p.batch);
    if (!b?.client) throw new StudioError("This month has no client, so the Photo lab cannot file its result.", 409);
    const t = await first<{ id: string }>(env.DB, "SELECT id FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", p.batch, p.post);
    if (!t) throw new StudioError("That post has no picture yet.", 409);
    const op = photoLabOp(p.operation);
    const d = { client: b.client, source: { kind: "task" as const, batch: p.batch, id: t.id }, op, prompt: p.prompt };
    const proposal = await proposePhotoLab(env, user, d);
    const confirmed = await confirmSpend(env, { provider: "freepik", user, opId: proposal.opId, confirm: true });
    const job = await runPhotoLabJob(env, d, proposal.picked, proposal.lab, proposal.lab.connected ? PHOTO_LAB_PRICES[op] : 0, confirmed.id);
    const state = job.status === "failed" ? `failed: ${job.error ?? "the provider refused the picture"}` : job.status === "done" ? "done; open the editor's Photo lab to compare and use it" : "running; it appears in the editor's Photo lab when done";
    return { ok: true, note: `${op} on post ${p.post}: ${state}.`, fixture: !proposal.lab.connected };
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
