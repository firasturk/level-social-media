/**
 * Trend videos with a character (docs/ambassador-trends.md): a Genjutsu motion preset where the
 * character takes the place of the person in the video. The character is one of the client's
 * ambassadors (its portrait), one of the client's AI influencers (its character sheet, the native
 * Genjutsu reference) or a Soul character made on the Higgsfield account. The whole team (24 Oct), on the
 * subscription credits, with the usual rules: the switch, the price from the preset's detail with
 * this character and the confirm, one claim per ask, a ledger row, no retry. Browsing the characters
 * and the galleries spends nothing. The videos are collected into R2 when the list is read.
 *
 * Routes (mounted at /api/studio/ambassadors/trends):
 *   GET  /?client=                          the characters and the client's trends (collects finished jobs)
 *   GET  /gallery?character=&category=      the Genjutsu gallery with this character (browsing)
 *   POST /make {client, character, presetId, confirm?}   one trend video, after the confirm
 *   GET  /:tid/video                        the finished video
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { assertIntegrationEnabled, claimSubmission, recordIntegrationOp, requireIntegrationUser, updateIntegrationOp } from "./integrations";
import { balanceOf, DONE, FAILED, fetcher, HiggsfieldMcp, higgsfieldSignIn, mediaFor, NOT_SIGNED_IN, parseJobs, parseMediaId } from "./higgsfield-mcp";
import { CLOUD_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { firstUrl, jsonOf, objectsWith, resultText, type McpCallResult } from "./mcp-client";
import { fetchDetail, parsePresets } from "./video-presets";
import { isTrendCategory, parseCharacterId, type Trend, type TrendCharacter, type TrendStatus } from "@shared/ambassador-trends";
import type { PresetCard } from "@shared/video-presets";
import type { User } from "@shared/types";

type Variables = { user: User };
export const ambassadorTrendRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CLAIM_TTL_MS = 10 * 60 * 1000;
/** A trend not finished in this long is given up (nothing is submitted again). */
const GIVE_UP_MS = 45 * 60 * 1000;
const SOUL_TTL_MS = 10 * 60 * 1000;

interface TrendRow {
  id: string;
  client: string;
  character: string;
  character_name: string;
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

const videoUrl = (id: string) => `/api/studio/ambassadors/trends/${id}/video`;
const trendOf = (t: TrendRow): Trend => ({ id: t.id, character: t.character, characterName: t.character_name, presetId: t.preset_id, presetName: t.preset_name, preview: t.preview, status: t.status, credits: t.credits, video: t.video_key ? videoUrl(t.id) : null, error: t.error, created: t.created });

/* ───────────── The characters ───────────── */

interface Soul {
  id: string;
  name: string;
  image: string | null;
}

let soulMemo: { at: number; souls: Soul[] } | null = null;
const importMemo = new Map<string, string>();

/** Tests start from nothing. */
export function resetTrendCaches(): void {
  soulMemo = null;
  importMemo.clear();
}

/** The ready Soul characters a `show_characters` answer lists (`{items: [{id, name, status, preview_url}]}`, read live on 24 Oct). */
export function parseSouls(r: McpCallResult): Soul[] {
  const out: Soul[] = [];
  for (const o of objectsWith(jsonOf(r), "soul_id")) {
    const id = String(o.soul_id ?? o.id ?? "");
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!id || !name || (typeof o.status === "string" && o.status !== "ready")) continue;
    const image = [o.preview_url, o.url, o.thumbnail_url].find((u): u is string => typeof u === "string" && /^https:\/\//.test(u)) ?? null;
    out.push({ id, name: name.slice(0, 80), image });
  }
  return out;
}

/** The account's Soul characters (Soul 2 first, then legacy Soul), one per name. */
async function souls(mcp: HiggsfieldMcp): Promise<Soul[]> {
  if (soulMemo && Date.now() - soulMemo.at < SOUL_TTL_MS) return soulMemo.souls;
  if (!(await mcp.hasTool("show_characters"))) return [];
  const found: Soul[] = [];
  for (const type of ["soul_2", "soul"]) {
    const r = await mcp.call("show_characters", { action: "list", type, status: "ready", size: 50 });
    if (r.isError) continue;
    for (const s of parseSouls(r)) if (!found.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) found.push(s);
  }
  soulMemo = { at: Date.now(), souls: found };
  return found;
}

/** The client's ambassadors with a portrait. */
async function ambassadorsOf(env: Env, client: string): Promise<{ id: string; name: string; image_key: string }[]> {
  return all<{ id: string; name: string; image_key: string }>(env.DB, "SELECT id, name, image_key FROM ambassadors WHERE client = ? AND image_key IS NOT NULL ORDER BY position, created", client);
}

/** The character as Genjutsu takes it: a character sheet's job, or an uploaded picture. */
type CharacterInput = { id: string; type: "image_job" | "media_input" }[];

/** A character by its id, with what Higgsfield takes as its reference. Imports a picture when needed (free). */
async function characterRef(env: Env, mcp: HiggsfieldMcp, client: string, id: string): Promise<{ name: string; input: CharacterInput }> {
  const c = parseCharacterId(id);
  if (!c) throw new StudioError("Unknown character.");
  if (c.kind === "ambassador") {
    const a = await first<{ name: string; image_key: string | null }>(env.DB, "SELECT name, image_key FROM ambassadors WHERE id = ? AND client = ?", c.ref, client);
    if (!a?.image_key) throw new StudioError("That ambassador has no portrait yet.", 409);
    return { name: a.name, input: [{ id: await mediaFor(env, mcp, a.image_key, "image"), type: "media_input" }] };
  }
  if (c.kind === "influencer") {
    const i = await first<{ name: string; job_id: string | null; status: string }>(env.DB, "SELECT name, job_id, status FROM influencers WHERE id = ? AND client = ?", c.ref, client);
    if (!i?.job_id || i.status !== "ready") throw new StudioError("That influencer is not made yet.", 409);
    return { name: i.name, input: [{ id: i.job_id, type: "image_job" }] };
  }
  const soul = (await souls(mcp)).find((s) => s.id === c.ref);
  if (!soul?.image) throw new StudioError("That Higgsfield character is not on the account (or has no picture).", 404);
  let mediaId = importMemo.get(soul.image);
  if (!mediaId) {
    const r = await mcp.call("media_import_url", { url: soul.image, type: "image" });
    mediaId = (r.isError ? null : parseMediaId(r)) ?? undefined;
    if (!mediaId) throw new StudioError(`Higgsfield could not take the character's picture: ${resultText(r).slice(0, 200)}`, 502);
    importMemo.set(soul.image, mediaId);
  }
  return { name: soul.name, input: [{ id: mediaId, type: "media_input" }] };
}

/** The input a Genjutsu preset takes the character in: its schema's character field, else `character_sheet`. */
export function characterField(schema: Record<string, unknown> | null): string {
  const props = (schema?.properties ?? {}) as Record<string, unknown>;
  return Object.keys(props).find((k) => /character/i.test(k)) ?? "character_sheet";
}

/* ───────────── Collecting finished videos ───────────── */

/** The client's trends still being made, asked about with one short `jobs_wait`: finished ones copied to R2, failed ones keep the message. Nothing is submitted. */
export async function collectTrends(env: Env, client: string, fetchFn: typeof fetch = fetcher()): Promise<void> {
  const pending = (await all<TrendRow>(env.DB, "SELECT * FROM ambassador_trends WHERE client = ? AND status IN ('queued', 'generating') ORDER BY created", client)).slice(0, 6);
  if (!pending.length) return;
  const fail = async (t: TrendRow, message: string) => {
    await run(env.DB, "UPDATE ambassador_trends SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), t.id);
    if (t.op_id) await updateIntegrationOp(env, t.op_id, { status: "failed", note: message });
  };
  const old = (t: TrendRow) => now() - t.created > GIVE_UP_MS;
  for (const t of pending) if (!t.job_id && old(t)) await fail(t, "The submission's outcome was never learned and nothing was sent again. Check the Higgsfield history.");
  const withJob = pending.filter((t) => t.job_id);
  if (!withJob.length) return;
  const mcp = new HiggsfieldMcp(env, fetchFn);
  let answer: McpCallResult;
  try {
    await mcp.connect();
    answer = await mcp.call("jobs_wait", { jobs: withJob.map((t, i) => ({ index: i, job_id: t.job_id })), timeout_seconds: 1 });
  } catch (e) {
    console.error("[trends] jobs_wait", errorMessage(e));
    for (const t of withJob) if (old(t)) await fail(t, "Higgsfield could not be asked about the job for too long.");
    return;
  }
  const jobs = parseJobs(answer);
  for (const [i, t] of withJob.entries()) {
    const job = jobs.find((x) => x.jobId === t.job_id) ?? jobs.find((x) => x.index === i);
    try {
      if (!job) {
        if (old(t)) await fail(t, "Higgsfield no longer lists this job.");
      } else if (DONE.test(job.status)) {
        let url = job.url;
        if (!url && (await mcp.hasTool("show_generation_by_ids"))) {
          const shown = await mcp.call("show_generation_by_ids", { jobs: [{ index: 0, job_id: t.job_id }] });
          url = parseJobs(shown).find((x) => x.jobId === t.job_id)?.url ?? firstUrl(jsonOf(shown), resultText(shown));
        }
        if (!url) {
          await fail(t, "The video finished without a link.");
          continue;
        }
        const r = await fetchFn(url, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) throw new StudioError(`The video could not be fetched (${r.status}).`, 502);
        const key = `trends/${client}/${t.id}.mp4`;
        await env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: "video/mp4" } });
        await run(env.DB, "UPDATE ambassador_trends SET status = 'done', video_key = ?, error = NULL, updated = ? WHERE id = ?", key, now(), t.id);
        if (t.op_id) await updateIntegrationOp(env, t.op_id, { status: "done" });
      } else if (FAILED.test(job.status)) {
        await fail(t, job.error ? `Higgsfield could not make it: ${job.error}` : "Higgsfield could not make it.");
      } else if (old(t)) {
        await fail(t, "Higgsfield did not finish in 45 minutes.");
      } else if (/^(running|processing|in_progress|generating|started)$/.test(job.status)) {
        await run(env.DB, "UPDATE ambassador_trends SET status = 'generating', updated = ? WHERE id = ? AND status = 'queued'", now(), t.id);
      }
    } catch (e) {
      console.error("[trends] collect", t.id, errorMessage(e));
    }
  }
}

/* ───────────── Routes ───────────── */

/** Admins, Higgsfield signed in and switched on; a paid step also needs the subscription credits chosen. */
async function gate(c: { get(k: "user"): User; env: Env }, paid: boolean): Promise<User> {
  const user = requireIntegrationUser(c, "higgsfield");
  if (!(await higgsfieldSignIn.isSignedIn(c.env))) throw new StudioError(NOT_SIGNED_IN, 409, false, { notSignedIn: true });
  await assertIntegrationEnabled(c.env, "higgsfield");
  if (paid) {
    if (previewNoImages(c.env)) throw new StudioError(PREVIEW_MESSAGE, 403);
    if ((await higgsfieldBilling(c.env)) !== "credits") throw new StudioError(CLOUD_CHOSEN, 409, false, { billing: "cloud" });
  }
  return user;
}

/** The characters (the client's ambassadors with a portrait, the account's Soul characters) and the client's trends. */
ambassadorTrendRoutes.get("/", async (c) => {
  requireIntegrationUser(c, "higgsfield");
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Which client?");
  const characters: TrendCharacter[] = (await ambassadorsOf(c.env, client)).map((a) => ({ id: `ambassador:${a.id}`, name: a.name, from: "ambassador", image: `/api/studio/ambassadors/${a.id}/image` }));
  const influencers = await all<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM influencers WHERE client = ? AND status = 'ready' AND job_id IS NOT NULL ORDER BY created DESC", client);
  characters.push(...influencers.map((i): TrendCharacter => ({ id: `influencer:${i.id}`, name: i.name, from: "influencer", image: `/api/studio/influencers/${i.id}/image` })));
  let reason = "";
  if (await higgsfieldSignIn.isSignedIn(c.env)) {
    try {
      const mcp = new HiggsfieldMcp(c.env, fetcher());
      await mcp.connect();
      for (const s of await souls(mcp)) characters.push({ id: `soul:${s.id}`, name: s.name, from: "higgsfield", image: s.image });
    } catch (e) {
      reason = `The Higgsfield characters could not be read: ${errorMessage(e).slice(0, 200)}`;
    }
    await collectTrends(c.env, client).catch((e) => console.error("[trends]", errorMessage(e)));
  } else reason = NOT_SIGNED_IN;
  const trends = await all<TrendRow>(c.env.DB, "SELECT * FROM ambassador_trends WHERE client = ? ORDER BY created DESC LIMIT 60", client);
  return c.json({ ok: true, characters, trends: trends.map(trendOf), reason });
});

/** The Genjutsu gallery with this character as the reference (browsing: nothing is made). */
ambassadorTrendRoutes.get("/gallery", async (c) => {
  await gate(c, false);
  const client = c.req.query("client") ?? "";
  const category = c.req.query("category") ?? "genjutsu-trending";
  if (!isTrendCategory(category)) throw new StudioError("Unknown trend gallery.");
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  const ch = await characterRef(c.env, mcp, client, c.req.query("character") ?? "");
  const items: PresetCard[] = [];
  const seen = new Set<string>();
  let cursor: unknown = null;
  // Two pages of fifty: the gallery is a community feed without end.
  for (let page = 0; page < 2; page++) {
    const args: Record<string, unknown> = { source: "genjutsu", category, limit: 50, initial_inputs: { character_sheet: ch.input } };
    if (cursor !== null) args.cursor = cursor;
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
    const next = (jsonOf(r) as { next_cursor?: unknown } | null)?.next_cursor ?? null;
    if (next === null || next === cursor) break;
    cursor = next;
  }
  return c.json({ ok: true, items });
});

const makeSchema = z.object({ client: z.string().min(1).max(80), character: z.string().min(1).max(120), presetId: z.string().min(1).max(200), confirm: z.boolean().optional() });

/** One trend video, after the confirm: the preset's price and readiness with this character, then `execute_preset` once. */
ambassadorTrendRoutes.post("/make", async (c) => {
  const user = await gate(c, true);
  const parsed = makeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError(`Invalid request: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? "is invalid"}.`);
  const d = parsed.data;
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  await mcp.requireTool("execute_preset");
  const ch = await characterRef(c.env, mcp, d.client, d.character);
  const character = ch.input;
  const detail = await fetchDetail(mcp, d.presetId, "genjutsu", { character_sheet: character });
  if (detail.available === false) throw new StudioError(`"${detail.title}" is not available to run (Higgsfield says so).`, 409, false, { notRunnable: true });
  const readiness = detail.readiness as { ready?: boolean; missing?: string[] } | null;
  if (readiness && readiness.ready === false) throw new StudioError(`"${detail.title}" still needs: ${(readiness.missing ?? []).join(", ") || "more inputs"}. Pick another trend.`, 409, false, { notReady: true });
  const credits = detail.price;
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  if (credits === null && !d.confirm) throw new StudioError(`The cost of "${detail.title}" is not known: Higgsfield names no price for it. Confirm it at an unknown cost, or pick another trend.`, 409, false, { needsEstimate: true, balance: bal.credits });
  if (!d.confirm) throw new StudioError(`Confirm the trend: about ${credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits, balance: bal.credits });
  if (!(await claimSubmission(c.env, `trend:${d.client}:${d.character}:${d.presetId}`, CLAIM_TTL_MS))) throw new StudioError("This trend was asked for a moment ago. Wait for it.", 409);
  const opId = await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "trend.video", user: user.id, estimate: credits, status: "confirmed", note: `Trend "${detail.title}" with ${ch.name} (${d.client}) · ${credits ?? "unknown"} credits (subscription, MCP)${credits === null ? " · cost unknown, confirmed" : ""}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}` });
  const id = uuid();
  const t = now();
  const insert = (status: TrendStatus, job: string | null, error: string | null) =>
    run(c.env.DB, "INSERT INTO ambassador_trends (id, client, character, character_name, preset_id, preset_name, preview, status, job_id, credits, op_id, error, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, d.client, d.character, ch.name, d.presetId, detail.title, detail.video, status, job, credits, opId, error, user.id, t, t);
  let r: McpCallResult;
  try {
    r = await mcp.call("execute_preset", { source: "genjutsu", preset_id: d.presetId, inputs: { [characterField(detail.inputSchema)]: character } });
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    // A timeout may still have started the job: it is not sent again; the row says so.
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
  return c.json({ ok: true, trend: trendOf((await first<TrendRow>(c.env.DB, "SELECT * FROM ambassador_trends WHERE id = ?", id))!) });
});

ambassadorTrendRoutes.get("/:tid/video", async (c) => {
  const t = await first<TrendRow>(c.env.DB, "SELECT * FROM ambassador_trends WHERE id = ?", c.req.param("tid"));
  const obj = t?.video_key ? await c.env.BUCKET.get(t.video_key) : null;
  if (!obj) throw new StudioError("No video yet.", 404);
  return new Response(obj.body, { headers: { "content-type": "video/mp4", "cache-control": "private, max-age=3600", ...(c.req.query("download") ? { "content-disposition": `attachment; filename="${t!.preset_name.replace(/[^\w.-]+/g, "-")}.mp4"` } : {}) } });
});
