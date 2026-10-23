/**
 * Campaign Autopilot (docs/campaign-autopilot.md), admin-only while it is tested: a whole campaign
 * planned by the text model from the client's real products, the admin's references and the
 * client's Drive; reviewed and edited; priced per provider in its own units; approved for a cap
 * tied to the plan's revision; then produced step by step (server/campaign-runner.ts).
 *
 * Nothing paid happens on these routes before approval: the planner is a text call (billed by the
 * text provider, said apart), the estimates are free questions (`get_cost`, `simulate_cost`, the
 * catalog), and approval only writes allowances into the campaign's ledger scopes.
 *
 * Routes (mounted at /api/studio/campaigns):
 *   GET    /sources?batch=          the products, client media, looks and tracks a plan may use
 *   GET    /engines                 the image and clip engines a plan may name
 *   GET    /?batch=                 the month's campaigns
 *   POST   /                        {batch, setup}: a new plan (planner call)
 *   GET    /:id?items=&retries=     the plan, counts, costs, caps, what approval would cover, steps
 *   PUT    /:id/plan                {plan, rev}: an edit (material edits pause affected unfinished work)
 *   POST   /:id/regenerate          {item, shot?, note?}: one item or one shot written again
 *   POST   /:id/prices              estimates asked again (free)
 *   POST   /:id/approve             {items, retries, signature, acceptedUnknown}: approve and start
 *   POST   /:id/tick                one pass of the runner (the page calls it while open; the cron too)
 *   POST   /:id/pause | /:id/resume
 *   POST   /:id/steps/:step/retry   {extra?}: a failed step again (one more attempt approved when asked)
 *   POST   /:id/steps/:step/rendered {videoId}: the browser stored the Reel on its card
 *   POST   /:id/discard
 *   GET    /:id/file?step=          a step's picture (start images, simulated pictures)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { askText, ownedPlan, parseJson, type BatchRow } from "./posts";
import { resolveEngineModel, getSetting } from "./settings";
import { listClient } from "./drive";
import { approveSpend, spendStatus } from "./spend";
import { higgsfieldBilling } from "./higgsfield-billing";
import { advanceCampaign, campaignScope } from "./campaign-runner";
import { LOOKS } from "@shared/video-project";
import { estimateCost } from "@shared/pricing";
import { VIDEO_MODELS, videoModel, videoPriceSetting, durationChoices } from "@shared/video-models";
import type { Config } from "@shared/config";
import type { User } from "@shared/types";
import {
  approvalSignature,
  budgetCaps,
  normalizePlan,
  normalizeSetup,
  OUTSIDE_THE_CAP,
  planChanges,
  planCosts,
  planCounts,
  planSteps,
  stepSignature,
  UNIT_LABEL,
  type ApprovalTerms,
  type BudgetCap,
  type CampaignPlan,
  type CampaignSetup,
  type ClipEngine,
  type CostUnit,
  type PriceBook,
  type StepSpec,
} from "../shared/campaign-plan";
import { applyRetarget, stripListIdRefs, type CastMember, CAMPAIGN_PLAN_SCHEMA, campaignInstruction, planFromAnswer, RETARGET_SCHEMA, retargetInstruction, type PlanDefaults, type PlannerInput } from "../shared/campaign-planner";

type Variables = { user: User };
export const campaignRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const ADMIN_ONLY = "Campaign Autopilot is for admins while it is tested.";

export type CampaignStatus = "draft" | "approved" | "producing" | "paused" | "done" | "failed" | "discarded";

export interface CampaignRow {
  id: string;
  batch: string;
  client: string | null;
  owner: string;
  status: CampaignStatus;
  setup: string;
  plan: string;
  rev: number;
  prices: string;
  prices_at: number | null;
  approval: string | null;
  approved_sig: string | null;
  approved_at: number | null;
  approved_by: string | null;
  pause_reason: string | null;
  simulate: number;
  error: string | null;
  created: number;
  updated: number;
}

export type StepStatus = "waiting" | "ready" | "running" | "done" | "failed" | "paused" | "skipped";

export interface StepRow {
  campaign: string;
  step: string;
  item: string;
  shot: string | null;
  kind: StepSpec["kind"];
  deps: string;
  label: string;
  status: StepStatus;
  unit: CostUnit | null;
  price_key: string | null;
  estimate: number | null;
  reserved: number;
  spent: number;
  attempts: number;
  max_attempts: number;
  sig: string | null;
  run_sig: string | null;
  post: number | null;
  ref_kind: string | null;
  ref_id: string | null;
  output_key: string | null;
  note: string | null;
  data: string | null;
  error: string | null;
  started: number | null;
  finished: number | null;
  updated: number;
}

/** The approval in force: the terms, their signature, and the items an edit since then paused. */
export interface StoredApproval {
  terms: ApprovalTerms;
  signature: string;
  /** Items whose production changed after approval: their unfinished paid steps wait for a new approval. */
  needsApproval: string[];
}

function requireAdmin(user: User): User {
  if (user.role !== "admin") throw new StudioError(ADMIN_ONLY, 403);
  return user;
}

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

export async function campaignOf(env: Env, user: User, id: string): Promise<{ row: CampaignRow; b: BatchRow }> {
  requireAdmin(user);
  const row = await first<CampaignRow>(env.DB, "SELECT * FROM campaign_plans WHERE id = ?", id);
  if (!row || row.status === "discarded") throw new StudioError("Campaign not found.", 404);
  const b = await ownedPlan(env, user, row.batch);
  return { row, b };
}

/** The stored plan, read clean (a bracketed list id an older plan kept in its words is taken out, the same for every reader). */
export const planOf = (row: CampaignRow) => stripListIdRefs(JSON.parse(row.plan) as CampaignPlan);
export const setupOf = (row: CampaignRow) => JSON.parse(row.setup) as CampaignSetup;
export const pricesOf = (row: CampaignRow) => JSON.parse(row.prices || "{}") as PriceBook;
export const approvalOf = (row: CampaignRow) => (row.approval ? (JSON.parse(row.approval) as StoredApproval) : null);

/* ───────────── What a plan may use ───────────── */

interface ClientBrand {
  id: string;
  name: string;
  tone: string;
  audience: string | null;
  language: string;
  dos: string;
  donts: string;
  style: string;
}

/** The month's product photos and the client's Drive (products, other photos and clips), as the lists the planner picks from. */
export async function planSources(env: Env, b: BatchRow): Promise<{ products: PlannerInput["products"]; media: PlannerInput["media"] }> {
  const config = JSON.parse(b.config) as Config;
  const rows = await all<{ id: string; name: string; note: string | null }>(env.DB, "SELECT id, name, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY created LIMIT 60", b.id);
  const products: PlannerInput["products"] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.name.replace(/\.[a-z0-9]{2,5}$/i, "").split("/").pop() ?? r.name;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    products.push({ listId: `P${products.length + 1}`, id: r.id, name, from: "library", thumb: `/api/studio/file?batch=${encodeURIComponent(b.id)}&id=${encodeURIComponent(r.id)}&kind=reference`, ...(r.note ? { note: r.note.slice(0, 240) } : {}) });
  }
  const media: PlannerInput["media"] = [];
  if (config.client) {
    const listing = await listClient(env, config.client).catch((e) => {
      console.error("[campaign] drive", errorMessage(e));
      return null;
    });
    for (const p of listing?.photos ?? []) {
      const thumb = `/api/studio/drive/photo/${encodeURIComponent(p.id)}?size=480`;
      if (!p.video && (p.role ?? "product") === "product") {
        if (seen.has(p.name.toLowerCase()) || products.length >= 60) continue;
        seen.add(p.name.toLowerCase());
        products.push({ listId: `P${products.length + 1}`, id: p.id, name: p.name, from: "drive", thumb, ...(p.note ? { note: p.note.slice(0, 240) } : {}) });
      } else if (media.length < 40) {
        media.push({ listId: `M${media.length + 1}`, kind: "asset", id: p.id, label: `${p.note || p.file}`.slice(0, 160), thumb, from: `the client's Drive (${p.folder})`.slice(0, 120), media: p.video ? "clip" : "photo" });
      }
    }
  }
  return { products, media };
}

/** The client's cast (its ambassadors): the only people a campaign may show. */
export async function castOf(env: Env, client: string | null): Promise<CastMember[]> {
  if (!client) return [];
  const rows = await all<{ name: string; gender: string | null; modest: number | null }>(env.DB, "SELECT name, gender, modest FROM ambassadors WHERE client = ? ORDER BY position", client).catch(() => []);
  return rows.map((r) => ({ name: r.name, gender: r.gender, modest: !!r.modest }));
}

async function brandOf(env: Env, config: Config): Promise<ClientBrand | null> {
  if (!config.client) return null;
  return first<ClientBrand>(env.DB, "SELECT id, name, tone, audience, language, dos, donts, style FROM clients WHERE id = ?", config.client);
}

/** The engines a new plan starts on: the month's image engine, Magnific "Change camera" for other angles, Higgsfield on the billing the admin chose. */
export async function planDefaults(env: Env, config: Config, setup: CampaignSetup): Promise<PlanDefaults> {
  const model = config.model || (await resolveEngineModel(env));
  const billing = await higgsfieldBilling(env);
  const cloud = videoModel(VIDEO_MODELS[0].slug)!;
  let clipEngine: ClipEngine = billing === "credits" ? { provider: "higgsfield-mcp", model: "seedance", name: "Seedance (subscription credits)" } : { provider: "higgsfield", model: cloud.slug, name: `${cloud.name} (Cloud API)` };
  if (billing === "credits") {
    // The subscription catalog as last read (no call here): the plan names one exact engine, never a family.
    const { readJsonSetting } = await import("./oauth-signin");
    const { HIGGSFIELD_MCP_MODELS_SETTING } = await import("./settings");
    const { matchMcpModel } = await import("./higgsfield-mcp");
    const stored = await readJsonSetting<{ models: { id: string; name: string; durations: number[]; aspects: string[] }[] }>(env, HIGGSFIELD_MCP_MODELS_SETTING).catch(() => null);
    const m = stored?.models?.length ? matchMcpModel(stored.models as Parameters<typeof matchMcpModel>[0], cloud.name) : null;
    if (m) clipEngine = { provider: "higgsfield-mcp", model: m.id, name: `${m.name} (subscription credits)` };
  }
  return { imageEngine: { kind: "engine", model }, frameEngine: { kind: "mg-camera", model: "images_change_camera" }, clipEngine, frame: setup.videoFrame, videoSeconds: setup.videoSeconds };
}

/** The lengths a clip engine makes, for rounding each shot up to a clip it can make. */
export function clipLengths(e: ClipEngine): number[] {
  if (e.provider === "higgsfield") {
    const m = videoModel(e.model);
    if (m) {
      const all = durationChoices(m);
      const tidy = all.filter((s) => s === 5 || s === 10);
      return tidy.length ? tidy : all.slice(0, 2);
    }
  }
  return [5, 10];
}

/* ───────────── Prices (free questions only) ───────────── */

/** The preview's fixture prices: shown labelled, never as a live price. */
export const DEMO_PRICES: Record<"magnific" | "higgsfield-credits" | "cloud", number> = { magnific: 10, "higgsfield-credits": 30, cloud: 0.5 };

/**
 * One price per price key the plan needs. Image engines: the maintained list price
 * (shared/pricing.ts). Higgsfield Cloud: the catalog, the admin's price setting, else unknown
 * (the provider's estimate is asked at submission). Subscription credits and Magnific: the
 * provider's own free estimate when connected, else unknown. The preview uses labelled fixtures.
 */
export async function priceBook(env: Env, config: Config, batchId: string, plan: CampaignPlan, simulate: boolean, ask: PriceAsker = defaultAsker): Promise<{ prices: PriceBook; notes: string[] }> {
  const steps = planSteps(plan, undefined, clipLengths);
  const keys = new Map<string, StepSpec>();
  for (const s of steps) if (s.priceKey && !keys.has(s.priceKey)) keys.set(s.priceKey, s);
  // Unselected items are priced too, so selecting one needs no new round of questions.
  for (const s of planSteps({ ...plan, images: plan.images.map((i) => ({ ...i, selected: true })), videos: plan.videos.map((v) => ({ ...v, selected: true })) }, undefined, clipLengths)) if (s.priceKey && !keys.has(s.priceKey)) keys.set(s.priceKey, s);
  const prices: PriceBook = {};
  const notes: string[] = [];
  for (const [key, s] of keys) {
    if (key.startsWith("image:")) {
      const model = key.slice(6);
      const est = estimateCost({ ...config, model }, 1);
      prices[key] = est.known ? { amount: Math.round(est.perImage * 10000) / 10000, unit: "usd", source: "catalog", note: `list price of ${model} (shared/pricing.ts)` } : { amount: null, unit: "usd", source: null, note: `${model} has no list price in the studio's table` };
      continue;
    }
    if (key === "tool:mg-camera") {
      if (simulate) prices[key] = { amount: DEMO_PRICES.magnific, unit: "magnific-credits", source: "demo", note: "preview fixture, not a Magnific price" };
      else {
        const r = await ask.magnificCamera(env, batchId).catch((e) => ({ credits: null as number | null, note: errorMessage(e) }));
        prices[key] = { amount: r.credits, unit: "magnific-credits", source: r.credits === null ? null : "provider", note: r.note };
        if (r.credits === null) notes.push(`Magnific "Change camera": ${r.note}`);
      }
      continue;
    }
    if (key.startsWith("clip:")) {
      const [, provider, ...rest] = key.split(":");
      const frame = rest.pop()!;
      const seconds = Number(rest.pop());
      const model = rest.join(":");
      if (provider === "higgsfield") {
        const m = videoModel(model);
        const setting = Number((await getSetting(env, videoPriceSetting(model))) ?? "");
        if (m && typeof m.price === "number") prices[key] = { amount: m.price, unit: "usd", source: "catalog" };
        else if (Number.isFinite(setting) && setting > 0) prices[key] = { amount: setting, unit: "usd", source: "setting", note: "the admin's price per clip (Connection → Higgsfield)" };
        else if (simulate) prices[key] = { amount: DEMO_PRICES.cloud, unit: "usd", source: "demo", note: "preview fixture, not a Higgsfield price" };
        else {
          prices[key] = { amount: null, unit: "usd", source: null, note: `${m?.name ?? model}: Higgsfield publishes no price per clip; set one under Connection → Higgsfield or accept this step at a stated amount` };
          notes.push(`${m?.name ?? model} clips (${seconds} s): no price known before submission.`);
        }
      } else {
        if (simulate) prices[key] = { amount: DEMO_PRICES["higgsfield-credits"], unit: "higgsfield-credits", source: "demo", note: "preview fixture, not a Higgsfield price" };
        else {
          const r = await ask.higgsfieldCredits(env, batchId, model, seconds, frame).catch((e) => ({ credits: null as number | null, note: errorMessage(e) }));
          prices[key] = { amount: r.credits, unit: "higgsfield-credits", source: r.credits === null ? null : "provider", note: r.note };
          if (r.credits === null) notes.push(`Higgsfield ${model} (${seconds} s): ${r.note}`);
        }
      }
      void s;
    }
  }
  return { prices, notes };
}

/** The provider questions, apart so tests answer them without a network. */
export interface PriceAsker {
  magnificCamera(env: Env, batchId: string): Promise<{ credits: number | null; note: string }>;
  higgsfieldCredits(env: Env, batchId: string, model: string, seconds: number, frame: string): Promise<{ credits: number | null; note: string }>;
}

/** A picture of the month to ask an estimate with (the estimate does not depend on what it shows). */
async function anyPictureKey(env: Env, batch: string): Promise<string | null> {
  const t = await first<{ output: string }>(env.DB, "SELECT output FROM tasks WHERE batch = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", batch);
  if (t?.output) return t.output;
  const s = await first<{ key: string; reference_key: string | null }>(env.DB, "SELECT key, reference_key FROM sources WHERE batch = ? AND kind = 'product' LIMIT 1", batch);
  return s ? (s.reference_key ?? s.key) : null;
}

export const defaultAsker: PriceAsker = {
  async magnificCamera(env, batchId) {
    const { MagnificMcp } = await import("./freepik-mcp");
    const { magnificTools, magnificPicture, magnificOptionArgs } = await import("./photo-tools");
    const { photoTool } = await import("@shared/photo-tools");
    const { creditsIn } = await import("./freepik-mcp");
    const mcp = await MagnificMcp.open(env);
    if (!mcp) return { credits: null, note: "Magnific is not signed in (Connection → Magnific)" };
    const tools = await magnificTools(mcp);
    const tool = photoTool("mg-camera")!;
    if (!tools.has(tool.mcpTool) || !tools.has("simulate_cost")) return { credits: null, note: "Magnific lists no images_change_camera or simulate_cost" };
    const key = await anyPictureKey(env, batchId);
    if (!key) return { credits: null, note: "the month has no picture to ask the estimate with yet" };
    const params = tools.get(tool.mcpTool)!;
    const opts = magnificOptionArgs(tool, params, { camera: "left" });
    const pic = await magnificPicture(env, mcp, tool.mcpTool, params, key, tools);
    const sim = await mcp.callTool("simulate_cost", { tool: tool.mcpTool, arguments: { ...opts.args, ...pic.args } });
    const credits = sim.isError ? null : creditsIn(sim);
    return { credits, note: credits === null ? "simulate_cost gave no figure" : "Magnific simulate_cost (free)" };
  },
  async higgsfieldCredits(env, batchId, model, seconds, frame) {
    const mcpMod = await import("./higgsfield-mcp");
    const mcp = new mcpMod.HiggsfieldMcp(env, mcpMod.fetcher());
    await mcp.connect();
    const { models } = await mcpMod.mcpModels(env, mcp);
    const engine = models.find((m) => m.id === model) ?? mcpMod.matchMcpModel(models, model);
    if (!engine) return { credits: null, note: `"${model}" is not on the subscription catalog` };
    const key = await anyPictureKey(env, batchId);
    if (!key) return { credits: null, note: "the month has no picture to ask the estimate with yet" };
    const mediaId = await mcpMod.mediaFor(env, mcp, key);
    const params: Record<string, unknown> = { model: engine.id, medias: [{ value: mediaId, role: "image" }], count: 1, prompt: "estimate", get_cost: true };
    if (!engine.durations.length || engine.durations.includes(seconds)) params.duration = seconds;
    if (!engine.aspects.length || engine.aspects.includes(frame)) params.aspect_ratio = frame;
    const r = await mcp.call("generate_video", { params });
    const credits = r.isError || mcpMod.unlimChoiceIn(r) ? null : mcpMod.parseCost(r);
    return { credits, note: credits === null ? "get_cost gave no figure" : `Higgsfield get_cost for ${engine.name} (free)` };
  },
};

/* ───────────── What approval would cover ───────────── */

export interface Proposal {
  items: string[];
  retries: number;
  /** Steps approval would (re)run; finished steps whose inputs are unchanged are kept and not counted. */
  steps: StepSpec[];
  kept: string[];
  counts: ReturnType<typeof planCounts>;
  costs: ReturnType<typeof planCosts>;
  caps: BudgetCap[];
  terms: ApprovalTerms;
  signature: string;
  /** Unknown-cost steps not accepted: approval is refused until each is accepted at an amount. */
  unaccepted: { step: string; label: string; unit: CostUnit }[];
}

export function proposalFor(plan: CampaignPlan, prices: PriceBook, existing: StepRow[], items: string[], retries: number, acceptedUnknown: ApprovalTerms["acceptedUnknown"]): Proposal {
  const r = Math.max(0, Math.min(3, Math.round(retries)));
  const selected = new Set(items);
  const all = planSteps(plan, selected, clipLengths);
  const done = new Map(existing.filter((s) => s.status === "done").map((s) => [s.step, s]));
  const kept: string[] = [];
  const steps = all.filter((s) => {
    const d = done.get(s.id);
    if (d && d.run_sig === stepSignature(plan, s)) {
      kept.push(s.id);
      return false;
    }
    return true;
  });
  const costs = planCosts(steps, prices);
  const caps = budgetCaps(costs, r);
  const accepted = acceptedUnknown.filter((a) => costs.unknown.some((u) => u.step === a.step && u.unit === a.unit) && a.amount > 0);
  for (const a of accepted) {
    let cap = caps.find((c) => c.unit === a.unit);
    if (!cap) caps.push((cap = { unit: a.unit, estimate: 0, retries: r, retryAllowance: 0, cap: 0, unknown: 0 }));
    const round = (n: number) => (a.unit === "usd" ? Math.round(n * 10000) / 10000 : Math.round(n * 100) / 100);
    cap.estimate = round(cap.estimate + a.amount);
    cap.retryAllowance = round(cap.retryAllowance + a.amount * r);
    cap.cap = round(cap.cap + a.amount * (1 + r));
    cap.unknown = Math.max(0, cap.unknown - 1);
  }
  const terms: ApprovalTerms = { rev: plan.rev, items: [...selected].sort(), retries: r, caps, acceptedUnknown: accepted };
  const unaccepted = costs.unknown.filter((u) => !accepted.some((a) => a.step === u.step)).map((u) => ({ step: u.step, label: u.label, unit: u.unit }));
  return { items: terms.items, retries: r, steps, kept, counts: planCounts(plan, selected), costs, caps, terms, signature: approvalSignature(plan, terms), unaccepted };
}

/* ───────────── The plan as the page sees it ───────────── */

export async function campaignJson(env: Env, row: CampaignRow, items?: string[], retries?: number) {
  const plan = planOf(row);
  const prices = pricesOf(row);
  const steps = await all<StepRow>(env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? ORDER BY rowid", row.id);
  const approval = approvalOf(row);
  const selected = items ?? [...plan.images, ...plan.videos].filter((x) => x.selected).map((x) => x.key);
  const p = proposalFor(plan, prices, steps, selected, retries ?? approval?.terms.retries ?? 1, approval?.terms.acceptedUnknown ?? []);
  const ledger: Record<string, Awaited<ReturnType<typeof spendStatus>>> = {};
  for (const u of ["usd", "higgsfield-credits", "magnific-credits"] as CostUnit[]) {
    const s = await spendStatus(env, campaignScope(row.id, u));
    if (s.approved || s.reserved) ledger[u] = s;
  }
  return {
    id: row.id,
    batch: row.batch,
    status: row.status,
    simulate: !!row.simulate,
    pauseReason: row.pause_reason,
    error: row.error,
    setup: setupOf(row),
    plan,
    prices,
    pricesAt: row.prices_at,
    approval: approval ? { ...approval, at: row.approved_at, by: row.approved_by, current: approval.signature === p.signature } : null,
    proposal: { ...p, steps: undefined, stepCount: p.steps.length },
    outsideTheCap: OUTSIDE_THE_CAP,
    units: UNIT_LABEL,
    ledger,
    steps: steps.map((s) => ({
      step: s.step,
      item: s.item,
      shot: s.shot,
      kind: s.kind,
      label: s.label,
      status: s.status,
      unit: s.unit,
      estimate: s.estimate,
      spent: s.spent,
      reserved: s.reserved,
      attempts: s.attempts,
      maxAttempts: s.max_attempts,
      post: s.post,
      ref: s.ref_kind && s.ref_id ? { kind: s.ref_kind, id: s.ref_id } : null,
      output: s.output_key ? `/api/studio/campaigns/${row.id}/file?step=${encodeURIComponent(s.step)}&v=${s.finished ?? s.updated}` : null,
      note: s.note,
      stills: s.kind === "render" && s.data ? (JSON.parse(s.data) as { stills?: unknown[] }).stills ?? [] : undefined,
      error: s.error,
      stale: s.status === "done" && !!s.run_sig && s.run_sig !== stepSignature(plan, s),
    })),
    created: row.created,
    updated: row.updated,
  };
}

/* ───────────── Routes ───────────── */

campaignRoutes.use("*", async (c, next) => {
  requireAdmin(c.get("user"));
  await next();
});

campaignRoutes.get("/sources", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const { products, media } = await planSources(c.env, b);
  const config = JSON.parse(b.config) as Config;
  const { libraryTrack, catalogTrack } = await import("./music");
  const { CATALOG } = await import("@shared/music-catalog");
  const lib = config.client ? await all<import("./music").MusicTrackRow>(c.env.DB, "SELECT * FROM music_tracks WHERE client = ? AND archived IS NULL ORDER BY created DESC LIMIT 60", config.client).catch(() => []) : [];
  const tracks = [...lib.map(libraryTrack), ...CATALOG.filter((e) => !e.test).map((e) => catalogTrack(e))];
  return c.json({ ok: true, products, media, looks: LOOKS.filter((l) => l.id !== "none").map((l) => ({ id: l.id, name: l.name })), tracks: tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, moods: t.moods, bpm: t.bpm, licence: t.licence.name })) });
});

campaignRoutes.get("/engines", async (c) => {
  const billing = await higgsfieldBilling(c.env);
  let mcp: { id: string; name: string; durations: number[] }[] = [];
  if (billing === "credits" && !previewNoImages(c.env)) {
    try {
      const m = await import("./higgsfield-mcp");
      const client = new m.HiggsfieldMcp(c.env, m.fetcher());
      await client.connect();
      mcp = (await m.mcpModels(c.env, client)).models.map((x) => ({ id: x.id, name: x.name, durations: x.durations }));
    } catch (e) {
      console.error("[campaign] mcp models", errorMessage(e));
    }
  }
  const { listEngineModels } = await import("./campaign-runner");
  return c.json({ ok: true, billing, images: listEngineModels(), frames: [{ kind: "mg-camera", model: "images_change_camera", name: "Magnific Change camera (Magnific credits)" }], clips: billing === "credits" ? mcp.map((x) => ({ provider: "higgsfield-mcp", model: x.id, name: `${x.name} (subscription credits)` })) : VIDEO_MODELS.map((m) => ({ provider: "higgsfield", model: m.slug, name: `${m.name} (Cloud API)` })) });
});

campaignRoutes.get("/", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const rows = await all<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE batch = ? AND status != 'discarded' ORDER BY created DESC LIMIT 20", b.id);
  return c.json({ ok: true, campaigns: rows.map((r) => ({ id: r.id, status: r.status, created: r.created, updated: r.updated, summary: planOf(r).summary.concept.slice(0, 200), simulate: !!r.simulate })) });
});

/** The planner's call for a setup, mapped to a plan (ids resolved against the real lists). */
async function writePlan(env: Env, b: BatchRow, setup: CampaignSetup, rev: number, extra = ""): Promise<{ plan: CampaignPlan; input: PlannerInput; defaults: PlanDefaults }> {
  const config = JSON.parse(b.config) as Config;
  const brand = await brandOf(env, config);
  const { products, media } = await planSources(env, b);
  // Hand-picked products are the only ones offered; "suggest" offers the client's products.
  const picked = setup.productMode === "manual" && setup.products.length ? products.filter((p) => setup.products.some((q) => q.id === p.id)).map((p, n) => ({ ...p, listId: `P${n + 1}` })) : products.slice(0, 40);
  const references = setup.direction.references.map((r, n) => ({ ...r, kind: "reference" as const, listId: `R${n + 1}` }));
  const input: PlannerInput = {
    setup,
    brand: { name: brand?.name ?? "the brand", tone: brand?.tone ?? "", audience: brand?.audience ?? "", language: brand?.language ?? "", dos: brand?.dos ?? "", donts: brand?.donts ?? "", style: brand?.style ?? "" },
    products: picked,
    media,
    references,
    looks: LOOKS.filter((l) => l.id !== "none").map((l) => l.id),
    month: config.month ?? "",
    cast: await castOf(env, config.client ?? null),
    rules: config.client ? await (await import("./lessons")).lessonsFor(env, config.client, { batch: b.id }).catch(() => []) : [],
  };
  const defaults = await planDefaults(env, config, setup);
  const answer = parseJson<unknown>(await askText(env, campaignInstruction(input) + (extra ? `\n\n${extra}` : ""), CAMPAIGN_PLAN_SCHEMA));
  return { plan: planFromAnswer(answer, input, defaults, rev), input, defaults };
}

campaignRoutes.post("/", async (c) => {
  const user = c.get("user");
  const d = await parseBody(c, z.object({ batch: z.string().min(1), setup: z.record(z.string(), z.unknown()) }));
  const b = await ownedPlan(c.env, user, d.batch);
  const setup = normalizeSetup(d.setup as Partial<CampaignSetup>);
  if (!setup.imagePosts && !setup.videos) throw new StudioError("Ask for at least one image post or one video.");
  const { plan } = await writePlan(c.env, b, setup, 1);
  const simulate = previewNoImages(c.env);
  plan.planningNotes = [...plan.planningNotes, simulate ? "Planned on the preview: the text model's answer is the preview's fixture unless a text key is connected; no picture or clip is made here." : "Planning used one text-model call (billed by the text provider, outside the production cap)."];
  const config = JSON.parse(b.config) as Config;
  const { prices, notes } = await priceBook(c.env, config, b.id, plan, simulate);
  if (notes.length) plan.planningNotes.push(...notes.map((n) => `Estimate not known: ${n}`));
  const id = uuid();
  const t = now();
  await run(c.env.DB, "INSERT INTO campaign_plans (id, batch, client, owner, status, setup, plan, rev, prices, prices_at, simulate, created, updated) VALUES (?, ?, ?, ?, 'draft', ?, ?, 1, ?, ?, ?, ?, ?)", id, b.id, config.client ?? null, user.id, JSON.stringify(setup), JSON.stringify(plan), JSON.stringify(prices), t, simulate ? 1 : 0, t, t);
  const row = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", id))!;
  return c.json({ ok: true, campaign: await campaignJson(c.env, row) });
});

campaignRoutes.get("/:id", async (c) => {
  const { row } = await campaignOf(c.env, c.get("user"), c.req.param("id"));
  const items = c.req.query("items");
  const retries = c.req.query("retries");
  return c.json({ ok: true, campaign: await campaignJson(c.env, row, items !== undefined ? items.split(",").filter(Boolean) : undefined, retries !== undefined ? Number(retries) : undefined) });
});

/**
 * An edit. The plan comes back whole at the revision the page read (a stale page is refused).
 * Material changes to an approved item (idea, product, reference, shot, duration, engine) pause
 * that item's unfinished paid steps until the item is approved again; a words-only change is
 * applied at once (the card's words follow; the Reel is assembled and rendered again, free).
 */
campaignRoutes.put("/:id/plan", async (c) => {
  const user = c.get("user");
  const d = await parseBody(c, z.object({ plan: z.record(z.string(), z.unknown()), rev: z.number().int().min(1) }));
  const { row, b } = await campaignOf(c.env, user, c.req.param("id"));
  const r = await editPlan(c.env, user, row, b, d.plan as Partial<CampaignPlan>, d.rev);
  return c.json({ ok: true, ...r });
});

export async function editPlan(env: Env, user: User, row: CampaignRow, b: BatchRow, edited: Partial<CampaignPlan>, rev: number) {
  if (rev !== row.rev) throw new StudioError(`The plan changed since you opened it (now revision ${row.rev}, you have ${rev}). Reload it.`, 409, false, { rev: row.rev, stale: true });
  if (row.status === "done" || row.status === "failed") throw new StudioError("This campaign is finished: its posts and Reels are edited in the Studio and the editors now.", 409);
  const before = planOf(row);
  const config = JSON.parse(b.config) as Config;
  const defaults = await planDefaults(env, config, setupOf(row));
  const after = normalizePlan(edited, defaults, row.rev + 1);
  const changes = planChanges(before, after);
  const approval = approvalOf(row);
  if (approval) {
    const approvedItems = new Set(approval.terms.items);
    const paused = changes.material.filter((k) => approvedItems.has(k));
    if (paused.length) {
      approval.needsApproval = [...new Set([...approval.needsApproval, ...paused])];
      for (const item of paused)
        await run(env.DB, "UPDATE campaign_steps SET status = 'paused', note = ?, updated = ? WHERE campaign = ? AND item = ? AND status IN ('waiting', 'ready', 'failed')", "Paused: this item changed after approval. Approve the changes to make it.", now(), row.id, item);
    }
    // Words only: the card's words follow now; the assembly and the render are free and run again.
    const { applyWords } = await import("./campaign-runner");
    for (const item of changes.words) if (approvedItems.has(item)) await applyWords(env, user, row, b, after, item);
    await run(env.DB, "UPDATE campaign_plans SET approval = ? WHERE id = ?", JSON.stringify(approval), row.id);
  }
  const t = now();
  const changed = await run(env.DB, "UPDATE campaign_plans SET plan = ?, rev = ?, updated = ? WHERE id = ? AND rev = ?", JSON.stringify(after), row.rev + 1, t, row.id, row.rev);
  if (!changed) throw new StudioError("The plan was saved elsewhere a moment ago. Reload it.", 409, false, { stale: true });
  // New engines or lengths: their maintained prices are filled in now; provider estimates wait for "Refresh estimates".
  const prices = pricesOf(row);
  const later = async () => ({ credits: null, note: "not asked yet: press Refresh estimates" });
  const fresh = await priceBook(env, config, b.id, after, !!row.simulate, { magnificCamera: later, higgsfieldCredits: later });
  for (const [k, v] of Object.entries(fresh.prices)) if (!prices[k] || (prices[k].amount === null && v.amount !== null)) prices[k] = v;
  await run(env.DB, "UPDATE campaign_plans SET prices = ? WHERE id = ?", JSON.stringify(prices), row.id);
  const next = (await first<CampaignRow>(env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return { changes, campaign: await campaignJson(env, next) };
}

/** One item, or one shot of a video, written again by the planner; the rest of the plan stays as it is. */
campaignRoutes.post("/:id/regenerate", async (c) => {
  const user = c.get("user");
  const d = await parseBody(c, z.object({ item: z.string().min(1).max(20), shot: z.string().max(10).optional(), note: z.string().trim().max(600).optional(), rev: z.number().int().min(1) }));
  const { row, b } = await campaignOf(c.env, user, c.req.param("id"));
  if (d.rev !== row.rev) throw new StudioError(`The plan changed since you opened it. Reload it.`, 409, false, { rev: row.rev, stale: true });
  const plan = planOf(row);
  const setup = setupOf(row);
  const img = plan.images.find((i) => i.key === d.item);
  const vid = plan.videos.find((v) => v.key === d.item);
  if (!img && !vid) throw new StudioError("That item is not in the plan.", 404);
  const others = [...plan.images, ...plan.videos].filter((x) => x.key !== d.item).map((x) => ("idea" in x ? x.idea : x.concept)).join(" | ");
  let next: CampaignPlan;
  if (img) {
    const { plan: one } = await writePlan(c.env, b, { ...setup, imagePosts: 1, videos: 0 }, row.rev + 1, `Write ONE image post that replaces this one: "${img.idea}". Make it different from it and from the rest of the campaign: ${others.slice(0, 1500)}.${d.note ? ` The admin asks: ${d.note}` : ""}`);
    if (!one.images[0]) throw new StudioError("The planner wrote no post. Try again.", 502);
    next = { ...plan, rev: row.rev + 1, images: plan.images.map((i) => (i.key === d.item ? { ...one.images[0], key: i.key, selected: i.selected, engine: i.engine } : i)) };
  } else if (d.shot) {
    const shot = vid!.shots.find((s) => s.key === d.shot);
    if (!shot) throw new StudioError("That shot is not in the video.", 404);
    const { plan: one } = await writePlan(c.env, b, { ...setup, imagePosts: 0, videos: 1, shotsPerVideo: 1, videoSeconds: Math.round(shot.seconds) }, row.rev + 1, `Write ONE video with ONE shot that replaces shot ${d.shot} of this video: "${vid!.concept}". The shot it replaces: "${shot.action}". Keep the same product, place and people as the rest of the video.${d.note ? ` The admin asks: ${d.note}` : ""}`);
    const s = one.videos[0]?.shots[0];
    if (!s) throw new StudioError("The planner wrote no shot. Try again.", 502);
    next = { ...plan, rev: row.rev + 1, videos: plan.videos.map((v) => (v.key === d.item ? { ...v, shots: v.shots.map((x) => (x.key === d.shot ? { ...s, key: x.key } : x)) } : v)) };
  } else {
    const { plan: one } = await writePlan(c.env, b, { ...setup, imagePosts: 0, videos: 1, shotsPerVideo: Math.max(1, vid!.shots.length) }, row.rev + 1, `Write ONE video that replaces this one: "${vid!.concept}". Make it different from it and from the rest of the campaign: ${others.slice(0, 1500)}.${d.note ? ` The admin asks: ${d.note}` : ""}`);
    if (!one.videos[0]) throw new StudioError("The planner wrote no video. Try again.", 502);
    next = { ...plan, rev: row.rev + 1, videos: plan.videos.map((v) => (v.key === d.item ? { ...one.videos[0], key: v.key, selected: v.selected, keyFrameEngine: v.keyFrameEngine, frameEngine: v.frameEngine, clipEngine: v.clipEngine } : v)) };
  }
  next.planningNotes = [...plan.planningNotes, `${d.shot ? `Shot ${d.shot} of ${d.item}` : d.item} written again (one text-model call, outside the production cap).`].slice(-12);
  // The same edit rules as a hand edit.
  return c.json({ ok: true, ...(await editPlan(c.env, user, row, b, next, row.rev)) });
});

/**
 * A new product on one item: its words rewritten for that product (one text call, outside the
 * production cap), nothing saved. The page sends the item as it is on screen (unsaved edits
 * included) and puts the answer back in its draft; the admin saves it like any edit.
 */
campaignRoutes.post("/:id/retarget", async (c) => {
  const user = c.get("user");
  const d = await parseBody(c, z.object({ item: z.record(z.string(), z.unknown()), product: z.record(z.string(), z.unknown()).nullable() }));
  const { row, b } = await campaignOf(c.env, user, c.req.param("id"));
  const config = JSON.parse(b.config) as Config;
  const setup = setupOf(row);
  const defaults = await planDefaults(c.env, config, setup);
  const isVideo = Array.isArray((d.item as { shots?: unknown }).shots);
  // The item and the product checked the way any plan edit is.
  const checked = normalizePlan({ images: isVideo ? [] : [d.item as never], videos: isVideo ? [d.item as never] : [] }, defaults, row.rev);
  const before = (isVideo ? checked.videos[0] : checked.images[0]) ?? null;
  if (!before) throw new StudioError("That item could not be read.", 400);
  const after = normalizePlan({ images: isVideo ? [] : [{ ...before, product: d.product } as never], videos: isVideo ? [{ ...before, product: d.product } as never] : [] }, defaults, row.rev);
  const product = (isVideo ? after.videos[0] : after.images[0])?.product ?? null;
  const known = (await planSources(c.env, b)).products;
  if (product && !known.some((p) => p.id === product.id && p.from === product.from)) throw new StudioError("That product is not one of the client's.", 409);
  const original = [...planOf(row).images, ...planOf(row).videos].find((x) => x.key === before.key);
  const { peopleRule } = await import("../shared/campaign-planner");
  const answer = parseJson<unknown>(await askText(c.env, `${retargetInstruction(before, before.product ?? original?.product ?? null, product, setup.language)}\n${peopleRule(await castOf(c.env, config.client ?? null))}`, RETARGET_SCHEMA));
  const item = applyRetarget({ ...before, key: String((d.item as { key?: string }).key ?? before.key) }, answer, product);
  return c.json({ ok: true, item, note: "The words were rewritten for the new product (one text call, outside the production budget). Review them, then save." });
});

/** The estimates asked again: free questions to the providers, the maintained prices for the rest. */
campaignRoutes.post("/:id/prices", async (c) => {
  const { row, b } = await campaignOf(c.env, c.get("user"), c.req.param("id"));
  const config = JSON.parse(b.config) as Config;
  const { prices, notes } = await priceBook(c.env, config, b.id, planOf(row), !!row.simulate);
  await run(c.env.DB, "UPDATE campaign_plans SET prices = ?, prices_at = ?, updated = ? WHERE id = ?", JSON.stringify(prices), now(), now(), row.id);
  const next = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return c.json({ ok: true, notes, campaign: await campaignJson(c.env, next) });
});

/** Sets a ledger scope's allowance to what is already reserved plus the new cap (never below what is reserved). */
export async function setAllowance(env: Env, scope: string, cap: number, runId: string): Promise<void> {
  const fresh = await run(env.DB, "INSERT OR IGNORE INTO spend_runs (run, scope, amount, created) VALUES (?, ?, ?, ?)", runId, scope, cap, now());
  if (!fresh) return;
  const s = await spendStatus(env, scope);
  const target = Math.round((s.reserved + cap) * 1000) / 1000;
  if (!s.approved && !s.reserved) {
    await approveSpend(env, scope, target);
    return;
  }
  await run(env.DB, "UPDATE spend SET approved = MAX(reserved, ?), updated = ? WHERE scope = ?", target, now(), scope);
}

/**
 * "Approve plan & start production" (or "Approve selected"): the page sends the signature of the
 * terms it showed; the server works the terms out again from the plan as stored, and a different
 * signature means something changed since (nothing is approved). The same approval twice changes
 * nothing. Each unit's cap becomes the campaign's allowance in that unit; the steps are written.
 */
campaignRoutes.post("/:id/approve", async (c) => {
  const user = c.get("user");
  const d = await parseBody(
    c,
    z.object({
      items: z.array(z.string().max(20)).min(1).max(40),
      retries: z.number().int().min(0).max(3),
      signature: z.string().min(8).max(64),
      acceptedUnknown: z.array(z.object({ step: z.string().max(80), unit: z.enum(["usd", "higgsfield-credits", "magnific-credits"]), amount: z.number().positive().max(100000) })).max(80).default([]),
    }),
  );
  const { row } = await campaignOf(c.env, user, c.req.param("id"));
  if (row.status === "done" || row.status === "failed") throw new StudioError(`This campaign is ${row.status}; start a new one.`, 409);
  const plan = planOf(row);
  const keys = new Set([...plan.images, ...plan.videos].map((x) => x.key));
  for (const k of d.items) if (!keys.has(k)) throw new StudioError(`${k} is not in the plan.`, 409);
  const existing = await all<StepRow>(c.env.DB, "SELECT * FROM campaign_steps WHERE campaign = ?", row.id);
  const p = proposalFor(plan, pricesOf(row), existing, d.items, d.retries, d.acceptedUnknown);
  if (p.signature !== d.signature) throw new StudioError("The plan, its prices or the selection changed since this page showed them. Review the new figures and approve again.", 409, false, { signature: p.signature, stale: true });
  if (p.unaccepted.length) throw new StudioError(`${p.unaccepted.length} step${p.unaccepted.length === 1 ? "" : "s"} have no known cost: accept each at an amount, refresh the estimates, or change the engine.`, 409, false, { unaccepted: p.unaccepted });
  const prior = approvalOf(row);
  if (prior?.signature === p.signature && !prior.needsApproval.length) return c.json({ ok: true, already: true, campaign: await campaignJson(c.env, row) });
  // One approval at a time: the row moves to the new signature with one conditional update.
  const t = now();
  const stored: StoredApproval = { terms: p.terms, signature: p.signature, needsApproval: [] };
  const claimed = await run(c.env.DB, "UPDATE campaign_plans SET approval = ?, approved_sig = ?, approved_at = ?, approved_by = ?, status = 'producing', pause_reason = NULL, updated = ? WHERE id = ? AND rev = ? AND (approved_sig IS NULL OR approved_sig != ? OR approval LIKE '%\"needsApproval\":[\"%')", JSON.stringify(stored), p.signature, t, user.id, t, row.id, row.rev, p.signature);
  if (!claimed) return c.json({ ok: true, already: true, campaign: await campaignJson(c.env, (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!) });
  for (const cap of p.caps) await setAllowance(c.env, campaignScope(row.id, cap.unit), cap.cap, `${row.id}:${p.signature}:${cap.unit}`);
  // The steps: new ones written, changed ones made ready again (their earlier results stay as versions), unchanged finished ones kept.
  const prices = pricesOf(row);
  const accepted = new Map(p.terms.acceptedUnknown.map((a) => [a.step, a.amount]));
  const byId = new Map(existing.map((s) => [s.step, s]));
  const want = planSteps(plan, new Set(p.items), clipLengths);
  for (const s of want) {
    const sig = stepSignature(plan, s);
    const price = s.priceKey ? prices[s.priceKey] : null;
    const estimate = s.priceKey ? (typeof price?.amount === "number" ? price.amount : (accepted.get(s.id) ?? null)) : 0;
    const old = byId.get(s.id);
    if (!old) {
      await run(c.env.DB, "INSERT INTO campaign_steps (campaign, step, item, shot, kind, deps, label, status, unit, price_key, estimate, max_attempts, sig, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)", row.id, s.id, s.item, s.shot, s.kind, JSON.stringify(s.deps), s.label, s.unit, s.priceKey, estimate, 1 + p.retries, sig, t);
    } else if (old.status === "done" && old.run_sig === sig) {
      await run(c.env.DB, "UPDATE campaign_steps SET sig = ?, updated = ? WHERE campaign = ? AND step = ?", sig, t, row.id, s.id);
    } else if (old.status === "running") {
      // In flight at the provider: it finishes; the runner then sees whether it still matches.
      await run(c.env.DB, "UPDATE campaign_steps SET sig = ?, deps = ?, label = ?, unit = ?, price_key = ?, estimate = ?, max_attempts = attempts + ?, updated = ? WHERE campaign = ? AND step = ?", sig, JSON.stringify(s.deps), s.label, s.unit, s.priceKey, estimate, 1 + p.retries, t, row.id, s.id);
    } else {
      await run(c.env.DB, "UPDATE campaign_steps SET status = 'waiting', sig = ?, deps = ?, label = ?, unit = ?, price_key = ?, estimate = ?, attempts = 0, max_attempts = ?, error = NULL, note = NULL, updated = ? WHERE campaign = ? AND step = ?", sig, JSON.stringify(s.deps), s.label, s.unit, s.priceKey, estimate, 1 + p.retries, t, row.id, s.id);
    }
  }
  const wanted = new Set(want.map((s) => s.id));
  for (const old of existing) if (!wanted.has(old.step) && old.status !== "done" && old.status !== "running") await run(c.env.DB, "UPDATE campaign_steps SET status = 'skipped', note = 'Not in the approved selection.', updated = ? WHERE campaign = ? AND step = ?", t, row.id, old.step);
  const fresh = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  c.executionCtx.waitUntil(advanceCampaign(c.env, user, fresh.id, (p2) => c.executionCtx.waitUntil(p2)).catch((e) => console.error("[campaign] first pass", errorMessage(e))));
  return c.json({ ok: true, campaign: await campaignJson(c.env, fresh) });
});

campaignRoutes.post("/:id/tick", async (c) => {
  const user = c.get("user");
  const { row } = await campaignOf(c.env, user, c.req.param("id"));
  if (row.status === "producing") await advanceCampaign(c.env, user, row.id, (p) => c.executionCtx.waitUntil(p));
  const next = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return c.json({ ok: true, campaign: await campaignJson(c.env, next) });
});

campaignRoutes.post("/:id/pause", async (c) => {
  const { row } = await campaignOf(c.env, c.get("user"), c.req.param("id"));
  await run(c.env.DB, "UPDATE campaign_plans SET status = 'paused', pause_reason = 'Paused by the admin.', updated = ? WHERE id = ? AND status = 'producing'", now(), row.id);
  const next = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return c.json({ ok: true, campaign: await campaignJson(c.env, next) });
});

campaignRoutes.post("/:id/resume", async (c) => {
  const user = c.get("user");
  const { row } = await campaignOf(c.env, user, c.req.param("id"));
  if (!row.approved_sig) throw new StudioError("Approve the plan first.", 409);
  await run(c.env.DB, "UPDATE campaign_plans SET status = 'producing', pause_reason = NULL, updated = ? WHERE id = ? AND status = 'paused'", now(), row.id);
  // Steps a budget stop paused go back to the queue; steps an edit paused wait for their approval.
  const approval = approvalOf(row);
  const held = new Set(approval?.needsApproval ?? []);
  for (const s of await all<StepRow>(c.env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? AND status = 'paused'", row.id)) if (!held.has(s.item)) await run(c.env.DB, "UPDATE campaign_steps SET status = 'waiting', note = NULL, updated = ? WHERE campaign = ? AND step = ?", now(), row.id, s.step);
  await advanceCampaign(c.env, user, row.id, (p) => c.executionCtx.waitUntil(p));
  const next = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return c.json({ ok: true, campaign: await campaignJson(c.env, next) });
});

/**
 * A failed step tried again, alone: everything that succeeded stays. Within the approved attempts
 * it just goes back to the queue; past them, `extra: true` approves one more attempt at the
 * step's estimate (the page shows that amount first).
 */
campaignRoutes.post("/:id/steps/:step/retry", async (c) => {
  const user = c.get("user");
  const d = await parseBody(c, z.object({ extra: z.boolean().optional() }));
  const { row } = await campaignOf(c.env, user, c.req.param("id"));
  const s = await first<StepRow>(c.env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, c.req.param("step"));
  if (!s) throw new StudioError("Step not found.", 404);
  if (s.status !== "failed") throw new StudioError("Only a failed step is tried again.", 409);
  if ((approvalOf(row)?.needsApproval ?? []).includes(s.item)) throw new StudioError("This item changed after approval: approve the changes first.", 409);
  if (s.attempts >= s.max_attempts) {
    if (!d.extra) throw new StudioError(`The approved attempts for this step are used (${s.attempts} of ${s.max_attempts}). One more attempt costs about ${s.estimate ?? "an unknown amount"} ${s.unit ?? ""}: confirm to approve it.`, 409, false, { needsExtra: true, estimate: s.estimate, unit: s.unit });
    if (s.unit && s.estimate) await approveSpend(c.env, campaignScope(row.id, s.unit), s.estimate, `${row.id}:${s.step}:extra:${s.attempts}`);
    await run(c.env.DB, "UPDATE campaign_steps SET max_attempts = max_attempts + 1 WHERE campaign = ? AND step = ? AND attempts >= max_attempts", row.id, s.step);
  }
  await run(c.env.DB, "UPDATE campaign_steps SET status = 'waiting', error = NULL, updated = ? WHERE campaign = ? AND step = ? AND status = 'failed'", now(), row.id, s.step);
  await run(c.env.DB, "UPDATE campaign_plans SET status = 'producing', pause_reason = NULL, updated = ? WHERE id = ? AND status IN ('paused', 'failed', 'done')", now(), row.id);
  await advanceCampaign(c.env, user, row.id, (p) => c.executionCtx.waitUntil(p));
  const next = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return c.json({ ok: true, campaign: await campaignJson(c.env, next) });
});

/** The browser rendered a Reel and stored it on its card (the editor's own render job): the step is done. */
campaignRoutes.post("/:id/steps/:step/rendered", async (c) => {
  const user = c.get("user");
  const d = await parseBody(c, z.object({ videoId: z.string().min(1).max(80) }));
  const { row } = await campaignOf(c.env, user, c.req.param("id"));
  const { finishRender } = await import("./campaign-runner");
  await finishRender(c.env, row, c.req.param("step"), d.videoId);
  await advanceCampaign(c.env, user, row.id, (p) => c.executionCtx.waitUntil(p));
  const next = (await first<CampaignRow>(c.env.DB, "SELECT * FROM campaign_plans WHERE id = ?", row.id))!;
  return c.json({ ok: true, campaign: await campaignJson(c.env, next) });
});

campaignRoutes.post("/:id/discard", async (c) => {
  const { row } = await campaignOf(c.env, c.get("user"), c.req.param("id"));
  if (row.status === "producing") throw new StudioError("Pause production before discarding the plan.", 409);
  await run(c.env.DB, "UPDATE campaign_plans SET status = 'discarded', updated = ? WHERE id = ?", now(), row.id);
  return c.json({ ok: true });
});

campaignRoutes.get("/:id/file", async (c) => {
  const { row } = await campaignOf(c.env, c.get("user"), c.req.param("id"));
  const s = await first<{ output_key: string | null }>(c.env.DB, "SELECT output_key FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, c.req.query("step") ?? "");
  if (!s?.output_key) throw new StudioError("Not found.", 404);
  const obj = await c.env.BUCKET.get(s.output_key);
  if (!obj) throw new StudioError("Not found.", 404);
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": c.req.query("v") ? "private, max-age=31536000, immutable" : "private, max-age=600", "X-Content-Type-Options": "nosniff" } });
});
