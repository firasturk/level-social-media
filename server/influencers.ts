/**
 * AI influencers (docs/influencers.md): a client's own AI person, designed in the studio and made
 * once as a Higgsfield character sheet, then put into trend videos (Genjutsu motion presets with the
 * sheet as the character). Admins only, on the Higgsfield subscription credits, with the usual rules:
 * the switch, the price asked first and confirmed (`ai_influencer_prepare` quotes the sheet and makes
 * nothing; a trend's price comes from its detail), one claim per ask, a ledger row, no retry. The jobs
 * are collected when the list is read: the sheet and the videos are copied to R2.
 *
 * Routes (mounted at /api/studio/influencers):
 *   GET  /?client=                      the client's influencers with their trends (collects finished jobs)
 *   POST /prepare {client, name, traits, hijab?, notes?, city?}   design and price, nothing made
 *   POST /:id/make {confirm?}           the character sheet, after the confirm
 *   GET  /:id/image                     the finished sheet
 *   POST /:id/cast                      added to the client's ambassadors (the campaigns' cast)
 *   GET  /:id/trends?category=          the Genjutsu gallery with this character (browsing)
 *   POST /:id/trend {presetId, confirm?}   one trend video, after the confirm
 *   GET  /trends/:tid/video             the finished video
 *   DELETE /:id                         a draft or a failed one removed
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { assertIntegrationEnabled, claimSubmission, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { balanceOf, DONE, FAILED, fetcher, HiggsfieldMcp, higgsfieldSignIn, NOT_SIGNED_IN, parseJobs } from "./higgsfield-mcp";
import { CLOUD_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { findNumber, findString, findValue, firstUrl, jsonOf, resultText, type McpCallResult } from "./mcp-client";
import { fetchDetail, parsePresets } from "./video-presets";
import { MAX_AMBASSADORS } from "./ambassadors";
import { cleanSelection, influencerBrief, isTrendCategory, type Influencer, type InfluencerStatus, type InfluencerTrend, type TrendStatus } from "@shared/influencers";
import type { PresetCard } from "@shared/video-presets";
import type { User } from "@shared/types";

type Variables = { user: User };
export const influencerRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CLAIM_TTL_MS = 10 * 60 * 1000;
/** A job not finished in this long is given up (nothing is submitted again). */
const GIVE_UP_MS = 45 * 60 * 1000;

interface InfluencerRow {
  id: string;
  client: string;
  name: string;
  brief: string;
  gender: string;
  status: InfluencerStatus;
  params: string | null;
  design: string | null;
  credits: number | null;
  job_id: string | null;
  image_key: string | null;
  op_id: string | null;
  error: string | null;
  created_by: string;
  created: number;
  updated: number;
}

interface TrendRow {
  id: string;
  influencer: string;
  preset_id: string;
  preset_name: string;
  preview: string | null;
  status: TrendStatus;
  job_id: string | null;
  video_key: string | null;
  credits: number | null;
  op_id: string | null;
  error: string | null;
  created_by: string;
  created: number;
  updated: number;
}

/* ───────────── Reading Higgsfield's answers ───────────── */

/** What `ai_influencer_prepare` answers: the exact params to generate with, the price, and the design in words. */
export function parsePrepared(r: McpCallResult): { params: Record<string, unknown> | null; credits: number | null; design: string } {
  const j = jsonOf(r);
  const params = findValue(j, ["params", "prepared_params"], (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  const credits = findNumber(j, ["credits", "total_credits", "price", "cost", "cost_credits"]);
  const design = (findString(j, ["design", "summary", "description"]) ?? (params && typeof params.brief === "string" ? params.brief : "") ?? "").slice(0, 2000);
  return { params: params ?? null, credits: credits !== null && credits >= 0 ? credits : null, design };
}

/** The first job an answer starts (`job_id`, or `job_ids`, or a job entry). */
export function startedJob(r: McpCallResult): string | null {
  const j = jsonOf(r);
  const direct = findString(j, ["job_id"]);
  if (direct) return direct;
  const ids = findValue(j, ["job_ids"], (v): v is unknown[] => Array.isArray(v));
  if (ids?.length && typeof ids[0] === "string") return ids[0];
  return parseJobs(r)[0]?.jobId ?? null;
}

/* ───────────── Rows as the studio shows them ───────────── */

const imageUrl = (id: string) => `/api/studio/influencers/${id}/image`;
const videoUrl = (id: string) => `/api/studio/influencers/trends/${id}/video`;

function trendOf(t: TrendRow): InfluencerTrend {
  return { id: t.id, presetId: t.preset_id, presetName: t.preset_name, preview: t.preview, status: t.status, credits: t.credits, video: t.video_key ? videoUrl(t.id) : null, error: t.error, created: t.created };
}

async function influencerOf(env: Env, r: InfluencerRow, trends: TrendRow[]): Promise<Influencer> {
  const inCast = r.image_key ? !!(await first<{ id: string }>(env.DB, "SELECT id FROM ambassadors WHERE client = ? AND image_key = ?", r.client, r.image_key)) : false;
  return { id: r.id, client: r.client, name: r.name, brief: r.brief, gender: r.gender, status: r.status, design: r.design ?? "", credits: r.credits, image: r.image_key ? imageUrl(r.id) : null, inCast, error: r.error, created: r.created, trends: trends.filter((t) => t.influencer === r.id).map(trendOf) };
}

async function rowOf(env: Env, id: string): Promise<InfluencerRow> {
  const r = await first<InfluencerRow>(env.DB, "SELECT * FROM influencers WHERE id = ?", id);
  if (!r) throw new StudioError("No such influencer.", 404);
  return r;
}

/* ───────────── Collecting finished jobs ───────────── */

/** The result link of a finished job: the one `jobs_wait` gave, else `show_generation_by_ids`. */
async function resultUrl(mcp: HiggsfieldMcp, jobId: string, given: string | null): Promise<string | null> {
  if (given) return given;
  if (!(await mcp.hasTool("show_generation_by_ids"))) return null;
  const shown = await mcp.call("show_generation_by_ids", { jobs: [{ index: 0, job_id: jobId }] });
  return parseJobs(shown).find((x) => x.jobId === jobId)?.url ?? firstUrl(jsonOf(shown), resultText(shown));
}

async function copyToR2(env: Env, url: string, key: string, fallbackType: string, fetchFn: typeof fetch): Promise<void> {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new StudioError(`The result could not be fetched (${r.status}).`, 502);
  const type = r.headers.get("content-type") ?? "";
  await env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: /^(image|video)\//.test(type) ? type : fallbackType } });
}

/**
 * The client's sheets and trends still being made, asked about with one short `jobs_wait`: a finished
 * one is copied to R2, a failed one keeps the message, one too old is given up. Nothing is submitted.
 */
export async function collectInfluencerJobs(env: Env, client: string, fetchFn: typeof fetch = fetcher()): Promise<void> {
  const sheets = await all<InfluencerRow>(env.DB, "SELECT * FROM influencers WHERE client = ? AND status = 'making'", client);
  const trends = await all<TrendRow & { client: string }>(env.DB, "SELECT t.*, i.client AS client FROM influencer_trends t JOIN influencers i ON i.id = t.influencer WHERE i.client = ? AND t.status IN ('queued', 'generating')", client);
  const pending = [...sheets.map((s) => ({ kind: "sheet" as const, id: s.id, job: s.job_id, created: s.updated, op: s.op_id })), ...trends.map((t) => ({ kind: "trend" as const, id: t.id, job: t.job_id, created: t.created, op: t.op_id, influencer: t.influencer }))].slice(0, 6);
  if (!pending.length) return;
  const fail = async (p: (typeof pending)[number], message: string) => {
    await run(env.DB, p.kind === "sheet" ? "UPDATE influencers SET status = 'failed', error = ?, updated = ? WHERE id = ?" : "UPDATE influencer_trends SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), p.id);
    if (p.op) await updateIntegrationOp(env, p.op, { status: "failed", note: message });
  };
  const old = (p: (typeof pending)[number]) => now() - p.created > GIVE_UP_MS;
  const withJob = pending.filter((p) => p.job);
  for (const p of pending) if (!p.job && old(p)) await fail(p, "The submission's outcome was never learned and nothing was sent again. Check the Higgsfield history.");
  if (!withJob.length) return;
  const mcp = new HiggsfieldMcp(env, fetchFn);
  let answer: McpCallResult;
  try {
    await mcp.connect();
    answer = await mcp.call("jobs_wait", { jobs: withJob.map((p, i) => ({ index: i, job_id: p.job })), timeout_seconds: 1 });
  } catch (e) {
    console.error("[influencers] jobs_wait", errorMessage(e));
    for (const p of withJob) if (old(p)) await fail(p, "Higgsfield could not be asked about the job for too long.");
    return;
  }
  const jobs = parseJobs(answer);
  for (const [i, p] of withJob.entries()) {
    const job = jobs.find((x) => x.jobId === p.job) ?? jobs.find((x) => x.index === i);
    try {
      if (!job) {
        if (old(p)) await fail(p, "Higgsfield no longer lists this job.");
      } else if (DONE.test(job.status)) {
        const url = await resultUrl(mcp, p.job!, job.url);
        if (!url) {
          await fail(p, "The job finished without a result link.");
          continue;
        }
        if (p.kind === "sheet") {
          const key = `influencers/${client}/${p.id}.png`;
          await copyToR2(env, url, key, "image/png", fetchFn);
          await run(env.DB, "UPDATE influencers SET status = 'ready', image_key = ?, error = NULL, updated = ? WHERE id = ?", key, now(), p.id);
        } else {
          const key = `influencers/${client}/${p.influencer}/trend-${p.id}.mp4`;
          await copyToR2(env, url, key, "video/mp4", fetchFn);
          await run(env.DB, "UPDATE influencer_trends SET status = 'done', video_key = ?, error = NULL, updated = ? WHERE id = ?", key, now(), p.id);
        }
        if (p.op) await updateIntegrationOp(env, p.op, { status: "done" });
      } else if (FAILED.test(job.status)) {
        await fail(p, job.error ? `Higgsfield could not make it: ${job.error}` : "Higgsfield could not make it.");
      } else if (old(p)) {
        await fail(p, "Higgsfield did not finish in 45 minutes.");
      } else if (p.kind === "trend" && /^(running|processing|in_progress|generating|started)$/.test(job.status)) {
        await run(env.DB, "UPDATE influencer_trends SET status = 'generating', updated = ? WHERE id = ? AND status = 'queued'", now(), p.id);
      }
    } catch (e) {
      console.error("[influencers] collect", p.id, errorMessage(e));
    }
  }
}

/* ───────────── The gate ───────────── */

/** Admins, Higgsfield signed in and switched on, the subscription credits chosen (the influencer tools run on them). */
async function gate(c: { get(k: "user"): User; env: Env }, paid: boolean): Promise<User> {
  const user = requireIntegrationAdmin(c, "higgsfield");
  if (!(await higgsfieldSignIn.isSignedIn(c.env))) throw new StudioError(NOT_SIGNED_IN, 409, false, { notSignedIn: true });
  await assertIntegrationEnabled(c.env, "higgsfield");
  if (paid) {
    if (previewNoImages(c.env)) throw new StudioError(PREVIEW_MESSAGE, 403);
    if ((await higgsfieldBilling(c.env)) !== "credits") throw new StudioError(CLOUD_CHOSEN, 409, false, { billing: "cloud" });
  }
  return user;
}

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/* ───────────── Routes ───────────── */

influencerRoutes.get("/", async (c) => {
  requireIntegrationAdmin(c, "higgsfield");
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Which client?");
  if (await higgsfieldSignIn.isSignedIn(c.env)) await collectInfluencerJobs(c.env, client).catch((e) => console.error("[influencers]", errorMessage(e)));
  const rows = await all<InfluencerRow>(c.env.DB, "SELECT * FROM influencers WHERE client = ? ORDER BY created DESC", client);
  const trends = rows.length ? await all<TrendRow>(c.env.DB, `SELECT * FROM influencer_trends WHERE influencer IN (${rows.map(() => "?").join(", ")}) ORDER BY created DESC`, ...rows.map((r) => r.id)) : [];
  return c.json({ ok: true, influencers: await Promise.all(rows.map((r) => influencerOf(c.env, r, trends))) });
});

const prepareSchema = z.object({
  client: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(40),
  traits: z.record(z.string().max(40), z.string().max(40)).default({}),
  hijab: z.boolean().optional(),
  city: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(1500).default(""),
});

/** The design and its price: `ai_influencer_prepare` (nothing is made, nothing spent). The draft keeps the exact params. */
influencerRoutes.post("/prepare", async (c) => {
  const user = await gate(c, false);
  const d = await body(c, prepareSchema);
  const brand = await first<{ name: string }>(c.env.DB, "SELECT name FROM clients WHERE id = ?", d.client);
  if (!brand) throw new StudioError("No such client.", 404);
  const selection = cleanSelection(d.traits);
  const gender = selection.gender?.[0] ?? "";
  const brief = influencerBrief({ name: d.name, gender, hijab: !!d.hijab, city: d.city ?? "", notes: d.notes, brand: brand.name });
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  await mcp.requireTool("ai_influencer_prepare");
  // randomize: false keeps only the traits chosen here; left on "Any", the brief decides (random traits came back with green hair and braces, 24 Oct).
  const r = await mcp.call("ai_influencer_prepare", { tier: "normal", selection, brief, batch_size: 1, randomize: false });
  if (r.isError) throw new StudioError(`Higgsfield could not prepare the influencer: ${resultText(r).slice(0, 300)}`, 502);
  const prepared = parsePrepared(r);
  if (!prepared.params) throw new StudioError("Higgsfield prepared the influencer but returned no settings to make it with.", 502);
  const id = uuid();
  const t = now();
  await run(c.env.DB, "INSERT INTO influencers (id, client, name, brief, gender, status, params, design, credits, created_by, created, updated) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)", id, d.client, d.name, brief, gender, JSON.stringify(prepared.params), prepared.design, prepared.credits, user.id, t, t);
  await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "influencer.prepare", user: user.id, estimate: 0, reported: 0, status: "done", note: `${d.name} for ${brand.name} · quoted ${prepared.credits ?? "?"} credits (preparing, nothing spent)` });
  return c.json({ ok: true, influencer: await influencerOf(c.env, await rowOf(c.env, id), []) });
});

/** The character sheet, after the confirm: `ai_influencer_generate` with the prepared params unchanged and the quote as the ceiling. */
influencerRoutes.post("/:id/make", async (c) => {
  const user = await gate(c, true);
  const d = await body(c, z.object({ confirm: z.boolean().optional() }));
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "draft" && row.status !== "failed") throw new StudioError(row.status === "ready" ? "This influencer is made already." : "This influencer is being made.", 409);
  if (!row.params) throw new StudioError("Prepare the design first.", 409);
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  await mcp.requireTool("ai_influencer_generate");
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  if (row.credits === null) throw new StudioError("Higgsfield named no price for this influencer, so it is not made: prepare it again.", 409, false, { needsEstimate: true });
  if (!d.confirm) throw new StudioError(`Confirm the influencer: about ${row.credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits: row.credits, balance: bal.credits });
  if (!(await claimSubmission(c.env, `influencer:${row.id}`, CLAIM_TTL_MS))) throw new StudioError("This influencer was asked for a moment ago. Wait for it.", 409);
  const opId = await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "influencer.sheet", user: user.id, estimate: row.credits, status: "confirmed", note: `AI influencer ${row.name} (${row.client}) · ${row.credits} credits (subscription, MCP)${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}` });
  let r: McpCallResult;
  try {
    r = await mcp.call("ai_influencer_generate", { params: JSON.parse(row.params), max_credits: row.credits });
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    // A timeout may still have started the job: it is not sent again; the row says so.
    await run(c.env.DB, "UPDATE influencers SET status = 'making', op_id = ?, error = ?, updated = ? WHERE id = ?", opId, `Higgsfield did not answer: ${message}. Nothing was sent again; check the Higgsfield history.`, now(), row.id);
    await updateIntegrationOp(c.env, opId, { status: "running", note: `outcome unknown · ${message}` });
    throw new StudioError("Higgsfield did not answer in time: the influencer may still be made. Nothing was sent again.", 504, false, { outcomeUnknown: true });
  }
  const job = startedJob(r);
  if (r.isError || !job) {
    const message = `Higgsfield did not start the influencer: ${resultText(r).slice(0, 300) || "no job id in the answer"}`;
    await run(c.env.DB, "UPDATE influencers SET status = 'failed', op_id = ?, error = ?, updated = ? WHERE id = ?", opId, message, now(), row.id);
    await updateIntegrationOp(c.env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await run(c.env.DB, "UPDATE influencers SET status = 'making', job_id = ?, op_id = ?, error = NULL, updated = ? WHERE id = ?", job, opId, now(), row.id);
  await updateIntegrationOp(c.env, opId, { taskId: job, status: "running" });
  return c.json({ ok: true, influencer: await influencerOf(c.env, await rowOf(c.env, row.id), []) });
});

influencerRoutes.get("/:id/image", async (c) => {
  const row = await rowOf(c.env, c.req.param("id"));
  const obj = row.image_key ? await c.env.BUCKET.get(row.image_key) : null;
  if (!obj) throw new StudioError("No picture yet.", 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/png", "cache-control": "private, max-age=3600" } });
});

/** The finished influencer joins the client's ambassadors, so campaigns can cast it (its sheet is the portrait). */
influencerRoutes.post("/:id/cast", async (c) => {
  requireIntegrationAdmin(c, "higgsfield");
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "ready" || !row.image_key) throw new StudioError("The influencer is not made yet.", 409);
  const existing = await all<{ id: string; image_key: string | null }>(c.env.DB, "SELECT id, image_key FROM ambassadors WHERE client = ?", row.client);
  if (existing.some((a) => a.image_key === row.image_key)) return c.json({ ok: true, already: true });
  if (existing.length >= MAX_AMBASSADORS) throw new StudioError(`The client has ${MAX_AMBASSADORS} ambassadors already: remove one first.`, 409);
  const t = now();
  const gender = row.gender === "female" ? "woman" : row.gender === "male" ? "man" : "";
  await run(c.env.DB, "INSERT INTO ambassadors (id, client, name, description, gender, modest, image_key, position, created, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", uuid(), row.client, row.name, row.brief.slice(0, 1000), gender, row.image_key, existing.length, t, t);
  return c.json({ ok: true });
});

/** The Genjutsu gallery with this character as the reference (browsing: nothing is made). */
influencerRoutes.get("/:id/trends", async (c) => {
  await gate(c, false);
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "ready" || !row.job_id) throw new StudioError("Make the influencer first; trends use the finished character.", 409);
  const category = c.req.query("category") ?? "genjutsu-trending";
  if (!isTrendCategory(category)) throw new StudioError("Unknown trend gallery.");
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  const items: PresetCard[] = [];
  const seen = new Set<string>();
  let cursor: unknown = c.req.query("cursor") || null;
  let next: unknown = null;
  // Two pages of fifty: the gallery is a community feed without end.
  for (let page = 0; page < 2; page++) {
    const args: Record<string, unknown> = { source: "genjutsu", category, limit: 50, initial_inputs: { character_sheet: [{ id: row.job_id, type: "image_job" }] } };
    if (cursor !== null) args.cursor = typeof cursor === "string" && /^\d+$/.test(cursor) ? Number(cursor) : cursor;
    const r = await mcp.call("get_presets", args);
    if (r.isError) {
      if (page === 0) throw new StudioError(`Higgsfield refused the trend gallery: ${resultText(r).slice(0, 200)}`, 502);
      break;
    }
    for (const card of parsePresets(r, "genjutsu")) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      items.push(card);
    }
    next = (jsonOf(r) as { next_cursor?: unknown } | null)?.next_cursor ?? null;
    if (next === null || next === cursor) break;
    cursor = next;
  }
  return c.json({ ok: true, items, nextCursor: next === null || next === undefined ? null : String(next) });
});

/** The input a Genjutsu preset takes the character in: its schema's character field, else `character_sheet`. */
export function characterField(schema: Record<string, unknown> | null): string {
  const props = (schema?.properties ?? {}) as Record<string, unknown>;
  return Object.keys(props).find((k) => /character/i.test(k)) ?? "character_sheet";
}

/** One trend video, after the confirm: the preset's price and readiness with this character, then `execute_preset` once. */
influencerRoutes.post("/:id/trend", async (c) => {
  const user = await gate(c, true);
  const d = await body(c, z.object({ presetId: z.string().min(1).max(200), confirm: z.boolean().optional() }));
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "ready" || !row.job_id) throw new StudioError("Make the influencer first; trends use the finished character.", 409);
  const character = [{ id: row.job_id, type: "image_job" }];
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  await mcp.requireTool("execute_preset");
  const detail = await fetchDetail(mcp, d.presetId, "genjutsu", { character_sheet: character });
  if (detail.available === false) throw new StudioError(`"${detail.title}" is not available to run (Higgsfield says so).`, 409, false, { notRunnable: true });
  const readiness = detail.readiness as { ready?: boolean; missing?: string[] } | null;
  if (readiness && readiness.ready === false) throw new StudioError(`"${detail.title}" still needs: ${(readiness.missing ?? []).join(", ") || "more inputs"}. Pick another trend.`, 409, false, { notReady: true });
  const credits = detail.price;
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  if (credits === null && !d.confirm) throw new StudioError(`The cost of "${detail.title}" is not known: Higgsfield names no price for it. Confirm it at an unknown cost, or pick another trend.`, 409, false, { needsEstimate: true, balance: bal.credits });
  if (!d.confirm) throw new StudioError(`Confirm the trend: about ${credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits, balance: bal.credits });
  if (!(await claimSubmission(c.env, `influencer-trend:${row.id}:${d.presetId}`, CLAIM_TTL_MS))) throw new StudioError("This trend was asked for a moment ago. Wait for it.", 409);
  const opId = await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "influencer.trend", user: user.id, estimate: credits, status: "confirmed", note: `Trend "${detail.title}" with ${row.name} (${row.client}) · ${credits ?? "unknown"} credits (subscription, MCP)${credits === null ? " · cost unknown, confirmed" : ""}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}` });
  const id = uuid();
  const t = now();
  const insert = (status: TrendStatus, job: string | null, error: string | null) =>
    run(c.env.DB, "INSERT INTO influencer_trends (id, influencer, preset_id, preset_name, preview, status, job_id, credits, op_id, error, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, row.id, d.presetId, detail.title, detail.video, status, job, credits, opId, error, user.id, t, t);
  let r: McpCallResult;
  try {
    r = await mcp.call("execute_preset", { source: "genjutsu", preset_id: d.presetId, inputs: { [characterField(detail.inputSchema)]: character } });
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    await insert("queued", null, `Higgsfield did not answer: ${message}. Nothing was sent again; check the Higgsfield history.`);
    await updateIntegrationOp(c.env, opId, { status: "running", note: `outcome unknown · ${message}` });
    throw new StudioError("Higgsfield did not answer in time: the trend may still be made. Nothing was sent again.", 504, false, { outcomeUnknown: true });
  }
  const jobs = parseJobs(r);
  const submitted = jobs.length > 0 && /\bsubmitted\b/i.test(resultText(r));
  if ((r.isError && !submitted) || !jobs.length) {
    const message = `Higgsfield did not start the trend: ${resultText(r).slice(0, 300) || "no job id in the answer"}`;
    await insert("failed", jobs[0]?.jobId ?? null, message);
    await updateIntegrationOp(c.env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insert("queued", jobs[0].jobId, null);
  await updateIntegrationOp(c.env, opId, { taskId: jobs[0].jobId, status: "running" });
  return c.json({ ok: true, trend: trendOf((await first<TrendRow>(c.env.DB, "SELECT * FROM influencer_trends WHERE id = ?", id))!) });
});

influencerRoutes.get("/trends/:tid/video", async (c) => {
  const t = await first<TrendRow>(c.env.DB, "SELECT * FROM influencer_trends WHERE id = ?", c.req.param("tid"));
  const obj = t?.video_key ? await c.env.BUCKET.get(t.video_key) : null;
  if (!obj) throw new StudioError("No video yet.", 404);
  return new Response(obj.body, { headers: { "content-type": "video/mp4", "cache-control": "private, max-age=3600", ...(c.req.query("download") ? { "content-disposition": `attachment; filename="${t!.preset_name.replace(/[^\w.-]+/g, "-")}.mp4"` } : {}) } });
});

/** A draft or a failed influencer removed (a made one is kept: it was paid for). */
influencerRoutes.delete("/:id", async (c) => {
  requireIntegrationAdmin(c, "higgsfield");
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "draft" && row.status !== "failed") throw new StudioError("A made influencer is kept.", 409);
  await run(c.env.DB, "DELETE FROM influencers WHERE id = ?", row.id);
  return c.json({ ok: true });
});
