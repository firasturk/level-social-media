/**
 * AI influencers (docs/influencers.md): a client's own AI person, designed in the studio and made
 * once as a Higgsfield character sheet (about 1.1 credits, or one of the account's free generations).
 * Admins only, with the usual rules: the switch, the price asked first and confirmed
 * (`ai_influencer_prepare` quotes the sheet and makes nothing), one claim per ask, a ledger row, no
 * retry. The sheet is collected into R2 when the list is read. A finished influencer is one of the
 * characters trends can use (server/ambassador-trends.ts), and can join the client's ambassadors.
 *
 * Routes (mounted at /api/studio/influencers):
 *   GET  /?client=                      the client's influencers (collects finished sheets)
 *   POST /prepare {client, name, traits, hijab?, notes?, city?}   design and price, nothing made
 *   POST /:id/make {confirm?, free?}    the character sheet, after the confirm (free: a free generation)
 *   GET  /:id/image                     the finished sheet
 *   POST /:id/cast                      added to the client's ambassadors (the campaigns' cast)
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
import { MAX_AMBASSADORS } from "./ambassadors";
import { cleanSelection, influencerBrief, type Influencer, type InfluencerStatus } from "@shared/influencers";
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
  free_gens: number | null;
  job_id: string | null;
  image_key: string | null;
  op_id: string | null;
  error: string | null;
  created_by: string;
  created: number;
  updated: number;
}

/* ───────────── Reading Higgsfield's answers ───────────── */

/** What `ai_influencer_prepare` answers: the exact params to generate with, the price, the free generations left (when known), and the design in words. */
export function parsePrepared(r: McpCallResult): { params: Record<string, unknown> | null; credits: number | null; freeGens: number | null; design: string } {
  const j = jsonOf(r);
  const params = findValue(j, ["params", "prepared_params"], (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  const credits = findNumber(j, ["credits", "total_credits", "price", "cost", "cost_credits"]);
  const design = (findString(j, ["design", "summary", "description"]) ?? (params && typeof params.brief === "string" ? params.brief : "") ?? "").slice(0, 2000);
  const freeGens = findNumber(j, ["free_gens_remaining"]);
  return { params: params ?? null, credits: credits !== null && credits >= 0 ? credits : null, freeGens: freeGens !== null && freeGens >= 0 ? freeGens : null, design };
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
async function influencerOf(env: Env, r: InfluencerRow): Promise<Influencer> {
  const inCast = r.image_key ? !!(await first<{ id: string }>(env.DB, "SELECT id FROM ambassadors WHERE client = ? AND image_key = ?", r.client, r.image_key)) : false;
  return { id: r.id, client: r.client, name: r.name, brief: r.brief, gender: r.gender, status: r.status, design: r.design ?? "", credits: r.credits, image: r.image_key ? imageUrl(r.id) : null, freeGens: r.free_gens, inCast, error: r.error, created: r.created };
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
 * The client's sheets still being made, asked about with one short `jobs_wait`: a finished one is
 * copied to R2, a failed one keeps the message, one too old is given up. Nothing is submitted.
 */
export async function collectInfluencerJobs(env: Env, client: string, fetchFn: typeof fetch = fetcher()): Promise<void> {
  const pending = (await all<InfluencerRow>(env.DB, "SELECT * FROM influencers WHERE client = ? AND status = 'making' ORDER BY updated", client)).slice(0, 6);
  if (!pending.length) return;
  const fail = async (p: InfluencerRow, message: string) => {
    await run(env.DB, "UPDATE influencers SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), p.id);
    if (p.op_id) await updateIntegrationOp(env, p.op_id, { status: "failed", note: message });
  };
  const old = (p: InfluencerRow) => now() - p.updated > GIVE_UP_MS;
  for (const p of pending) if (!p.job_id && old(p)) await fail(p, "The submission's outcome was never learned and nothing was sent again. Check the Higgsfield history.");
  const withJob = pending.filter((p) => p.job_id);
  if (!withJob.length) return;
  const mcp = new HiggsfieldMcp(env, fetchFn);
  let answer: McpCallResult;
  try {
    await mcp.connect();
    answer = await mcp.call("jobs_wait", { jobs: withJob.map((p, i) => ({ index: i, job_id: p.job_id })), timeout_seconds: 1 });
  } catch (e) {
    console.error("[influencers] jobs_wait", errorMessage(e));
    for (const p of withJob) if (old(p)) await fail(p, "Higgsfield could not be asked about the job for too long.");
    return;
  }
  const jobs = parseJobs(answer);
  for (const [i, p] of withJob.entries()) {
    const job = jobs.find((x) => x.jobId === p.job_id) ?? jobs.find((x) => x.index === i);
    try {
      if (!job) {
        if (old(p)) await fail(p, "Higgsfield no longer lists this job.");
      } else if (DONE.test(job.status)) {
        const url = await resultUrl(mcp, p.job_id!, job.url);
        if (!url) {
          await fail(p, "The job finished without a picture.");
          continue;
        }
        const key = `influencers/${client}/${p.id}.png`;
        await copyToR2(env, url, key, "image/png", fetchFn);
        await run(env.DB, "UPDATE influencers SET status = 'ready', image_key = ?, error = NULL, updated = ? WHERE id = ?", key, now(), p.id);
        if (p.op_id) await updateIntegrationOp(env, p.op_id, { status: "done" });
      } else if (FAILED.test(job.status)) {
        await fail(p, job.error ? `Higgsfield could not make it: ${job.error}` : "Higgsfield could not make it.");
      } else if (old(p)) {
        await fail(p, "Higgsfield did not finish in 45 minutes.");
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
  return c.json({ ok: true, influencers: await Promise.all(rows.map((r) => influencerOf(c.env, r))) });
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
  await run(c.env.DB, "INSERT INTO influencers (id, client, name, brief, gender, status, params, design, credits, free_gens, created_by, created, updated) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)", id, d.client, d.name, brief, gender, JSON.stringify(prepared.params), prepared.design, prepared.credits, prepared.freeGens, user.id, t, t);
  await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "influencer.prepare", user: user.id, estimate: 0, reported: 0, status: "done", note: `${d.name} for ${brand.name} · quoted ${prepared.credits ?? "?"} credits${prepared.freeGens !== null ? ` · ${prepared.freeGens} free generations left` : ""} (preparing, nothing spent)` });
  return c.json({ ok: true, influencer: await influencerOf(c.env, await rowOf(c.env, id)) });
});

/** The character sheet, after the confirm: `ai_influencer_generate` with the prepared params unchanged and the quote as the ceiling. */
influencerRoutes.post("/:id/make", async (c) => {
  const user = await gate(c, true);
  const d = await body(c, z.object({ confirm: z.boolean().optional(), free: z.boolean().optional() }));
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "draft" && row.status !== "failed") throw new StudioError(row.status === "ready" ? "This influencer is made already." : "This influencer is being made.", 409);
  if (!row.params) throw new StudioError("Prepare the design first.", 409);
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  await mcp.requireTool("ai_influencer_generate");
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  // A free generation only when asked and when Higgsfield said some are left; it never falls back to credits.
  if (d.free && !(row.free_gens && row.free_gens > 0)) throw new StudioError("No free generation is left for influencers (Higgsfield said so when it was designed): make it with credits, or design it again.", 409, false, { noFreeGens: true });
  if (!d.free && row.credits === null) throw new StudioError("Higgsfield named no price for this influencer, so it is not made: prepare it again.", 409, false, { needsEstimate: true });
  const cost = d.free ? 0 : row.credits!;
  if (!d.confirm) throw new StudioError(d.free ? `Confirm the influencer: one of the ${row.free_gens} free generations, no credits.` : `Confirm the influencer: about ${cost} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits: cost, free: !!d.free, balance: bal.credits });
  if (!(await claimSubmission(c.env, `influencer:${row.id}`, CLAIM_TTL_MS))) throw new StudioError("This influencer was asked for a moment ago. Wait for it.", 409);
  const opId = await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "influencer.sheet", user: user.id, estimate: cost, status: "confirmed", note: `AI influencer ${row.name} (${row.client}) · ${d.free ? "a free generation, no credits" : `${cost} credits (subscription, MCP)`}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}` });
  let r: McpCallResult;
  try {
    r = await mcp.call("ai_influencer_generate", { params: JSON.parse(row.params), max_credits: cost, ...(d.free ? { use_free_gens: true } : {}) });
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
  await run(c.env.DB, "UPDATE influencers SET status = 'making', job_id = ?, op_id = ?, error = NULL, free_gens = CASE WHEN ? AND free_gens > 0 THEN free_gens - 1 ELSE free_gens END, updated = ? WHERE id = ?", job, opId, d.free ? 1 : 0, now(), row.id);
  await updateIntegrationOp(c.env, opId, { taskId: job, status: "running" });
  return c.json({ ok: true, influencer: await influencerOf(c.env, await rowOf(c.env, row.id)) });
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

/** A draft or a failed influencer removed (a made one is kept: it was paid for). */
influencerRoutes.delete("/:id", async (c) => {
  requireIntegrationAdmin(c, "higgsfield");
  const row = await rowOf(c.env, c.req.param("id"));
  if (row.status !== "draft" && row.status !== "failed") throw new StudioError("A made influencer is kept.", 409);
  await run(c.env.DB, "DELETE FROM influencers WHERE id = ?", row.id);
  return c.json({ ok: true });
});
