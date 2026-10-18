/**
 * The system check: runs against production and reports what is wrong, with a fix for each.
 * Quick: the stored state (connections on file, crons, clients, months, library, storage).
 * Deep: the live tools too (the text model, Instagram, Drive) and a review of a month's writing.
 * Runs daily from the cron and tells the admin when something fails.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now } from "./db";
import { getSetting, resolveGoogleAuth, resolveOpenAIKey, resolveVertex, setSetting } from "./settings";
import { askText, parseJson } from "./posts";
import { clientDrivePhotos } from "./drive";
import { instagramProfile } from "./meta";
import { notify } from "./notify";
import { stemOf } from "@shared/naming";
import { decodeEntities } from "@shared/posts";
import type { Config } from "@shared/config";
import type { Post } from "@shared/posts";
import type { QA, User } from "@shared/types";
import { parseWritingReview, WRITING_REVIEW_SCHEMA, writingReviewInstruction, type AuditFinding, type AuditReport } from "@shared/audit";

const LAST_AUDIT = "audit_last";
const DAILY_AUDIT = "audit_daily";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

type Variables = { user: User };
export const auditRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

auditRoutes.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admin only.", 403);
  await next();
});

/** The last report, if one was stored. */
auditRoutes.get("/", async (c) => {
  const raw = await getSetting(c.env, LAST_AUDIT);
  return c.json({ ok: true, report: raw ? (JSON.parse(raw) as AuditReport) : null });
});

/** A fresh check now (deep calls the live tools: a minute or two). */
auditRoutes.post("/", async (c) => {
  const d = z.object({ deep: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
  const report = await runAudit(c.env, !!d.deep);
  await setSetting(c.env, LAST_AUDIT, JSON.stringify(report));
  return c.json({ ok: true, report });
});

/** The daily check from the cron: once a day, quick, and a message to the admin when something fails. */
export async function dailyAudit(env: Env): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if ((await getSetting(env, DAILY_AUDIT)) === day) return;
  await setSetting(env, DAILY_AUDIT, day);
  const report = await runAudit(env, false);
  await setSetting(env, LAST_AUDIT, JSON.stringify(report));
  const errors = report.findings.filter((f) => f.severity === "error");
  if (errors.length)
    await notify(
      env,
      `Level Social Media: ${errors.length} thing${errors.length > 1 ? "s" : ""} to fix`,
      errors.map((f) => `• ${f.title}${f.about ? ` (${f.about})` : ""}: ${f.detail ?? ""}${f.fix ? ` → ${f.fix}` : ""}`).join("\n"),
    ).catch(() => undefined);
}

export async function runAudit(env: Env, deep: boolean): Promise<AuditReport> {
  const t0 = Date.now();
  const findings: AuditFinding[] = [];
  const add = (f: AuditFinding) => findings.push(f);
  const guarded = async (area: AuditFinding["area"], title: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      add({ area, severity: "error", title: `${title} could not be checked`, detail: errorMessage(e).slice(0, 300) });
    }
  };
  await guarded("connections", "Connected tools", () => checkConnections(env, add, deep));
  await guarded("crons", "Background jobs", () => checkCrons(env, add));
  await guarded("clients", "Clients", () => checkClients(env, add));
  await guarded("months", "Months", () => checkMonths(env, add));
  await guarded("library", "Style library", () => checkLibrary(env, add));
  await guarded("storage", "Storage", () => checkStorage(env, add));
  if (deep) await guarded("writing", "Writing", () => checkWriting(env, add));
  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { at: now(), ms: Date.now() - t0, deep, findings };
}

/* ───────────── Connected tools ───────────── */

async function checkConnections(env: Env, add: (f: AuditFinding) => void, deep: boolean) {
  const vertex = await resolveVertex(env);
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  if (vertex) add({ area: "connections", severity: "ok", title: "Google Cloud (Vertex) connected", detail: "Writing, reading pictures and the image engine run through the service account." });
  else if (google) add({ area: "connections", severity: "warn", title: "Google through an API key, not a service account", detail: "Drive and the Vertex models are off without a service account.", fix: "Connect the Google Cloud service account in Connection." });
  else add({ area: "connections", severity: "error", title: "No Google connection", detail: "Nothing can be written, read or generated.", fix: "Connect Google Cloud in Connection." });
  add({ area: "connections", severity: "info", title: openai ? "OpenAI connected (fallback for writing)" : "No OpenAI key", detail: openai ? undefined : "Only Google writes and reads; fine while Google is up." });

  // Instagram (Meta): the token on file and how long it lasts.
  const token = await getSetting(env, "meta_token");
  const account = await getSetting(env, "meta_account");
  if (!token) add({ area: "connections", severity: "error", title: "Instagram is not connected", detail: "The Analysis cannot read clients' Instagram accounts; Autopilot and the profile stop at the brand kit.", fix: "Paste a Meta token in Connection → Instagram." });
  else {
    let username = "";
    let expires = 0;
    try {
      const a = JSON.parse(account ?? "{}") as { username?: string; expires?: number };
      username = a.username ?? "";
      expires = a.expires ?? 0;
    } catch {
      /* no account on file */
    }
    const left = expires ? expires - now() : 0;
    if (expires && left < 0) add({ area: "connections", severity: "error", title: "The Meta token has expired", detail: `It stopped on ${new Date(expires).toLocaleDateString("en-GB")}.`, fix: "Paste a new long-lived token in Connection → Instagram." });
    else if (expires && left < 7 * DAY) add({ area: "connections", severity: "warn", title: "The Meta token expires soon", detail: `${Math.max(1, Math.round(left / DAY))} day${left > DAY * 1.5 ? "s" : ""} left.`, fix: "Extend it in the Access Token Debugger and paste it in Connection." });
    else add({ area: "connections", severity: "ok", title: `Instagram connected${username ? ` as @${username}` : ""}`, detail: expires ? `Token good until ${new Date(expires).toLocaleDateString("en-GB")}.` : "Token with no set end." });
  }

  // Drive: the service account and the clients' folders.
  const drives = await all<{ client: string; drive: string }>(env.DB, "SELECT client, drive FROM client_profiles WHERE drive != ''");
  if (!vertex) add({ area: "connections", severity: "warn", title: "Drive is off", detail: "Drive reads through the Google service account.", fix: "Connect the service account in Connection." });
  else if (!drives.length) add({ area: "connections", severity: "info", title: "No client has a Drive folder yet", fix: "Products → Drive on the journey, paste the client's folder link." });
  else add({ area: "connections", severity: "ok", title: `Drive connected for ${drives.length} client${drives.length > 1 ? "s" : ""}`, detail: drives.map((d) => d.client).join(", ") });

  if (!deep) return;
  // Live: the text model answers.
  const t = Date.now();
  try {
    const raw = await askText(env, 'Answer with the JSON {"ok": true} and nothing else.', { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    const ok = parseJson<{ ok?: boolean }>(raw).ok === true;
    add({ area: "connections", severity: ok ? "ok" : "warn", title: `The text model answers (${((Date.now() - t) / 1000).toFixed(1)} s)`, detail: ok ? undefined : "It answered, but not what was asked." });
  } catch (e) {
    add({ area: "connections", severity: "error", title: "The text model does not answer", detail: errorMessage(e).slice(0, 200), fix: "Check the Google connection and the model names in Connection." });
  }
  // Live: Instagram reads a client's account.
  const handle = await first<{ client: string; instagram: string }>(env.DB, "SELECT client, instagram FROM client_profiles WHERE instagram != '' LIMIT 1");
  if (token && handle) {
    const t2 = Date.now();
    try {
      const p = await instagramProfile(env, handle.instagram, 1);
      add({ area: "connections", severity: "ok", title: `Instagram reads @${handle.instagram} (${((Date.now() - t2) / 1000).toFixed(1)} s)`, detail: `${p.followers ?? "?"} followers, ${p.posts ?? "?"} posts.`, about: handle.client });
    } catch (e) {
      add({ area: "connections", severity: "error", title: `Instagram cannot read @${handle.instagram}`, detail: errorMessage(e).slice(0, 200), fix: "Paste a new token in Connection → Instagram, or check the handle on the client's profile.", about: handle.client });
    }
  }
  // Live: Drive lists a client's folder.
  if (vertex && drives.length) {
    const d = drives[0];
    const t3 = Date.now();
    try {
      const photos = await clientDrivePhotos(env, d.client);
      add({ area: "connections", severity: photos.length ? "ok" : "warn", title: `Drive lists ${photos.length} photos for ${d.client} (${((Date.now() - t3) / 1000).toFixed(1)} s)`, detail: photos.length ? undefined : "The folder is empty or not shared with the service account.", fix: photos.length ? undefined : "Share the folder with the service account as Viewer.", about: d.client });
    } catch (e) {
      add({ area: "connections", severity: "error", title: `Drive cannot list ${d.client}'s folder`, detail: errorMessage(e).slice(0, 200), about: d.client });
    }
  }
}

/* ───────────── Background jobs ───────────── */

async function checkCrons(env: Env, add: (f: AuditFinding) => void) {
  // Drive folders are listed every six hours; photos are read a few a minute.
  const stale = await all<{ client: string; drive_listed: number | null }>(env.DB, "SELECT client, drive_listed FROM client_profiles WHERE drive != '' AND (drive_listed IS NULL OR drive_listed < ?)", now() - 8 * HOUR);
  for (const s of stale) add({ area: "crons", severity: "warn", title: "Drive folder not listed lately", detail: s.drive_listed ? `Last listed ${Math.round((now() - s.drive_listed) / HOUR)} h ago.` : "Never listed.", fix: "Open the client's Drive in the journey and press Refresh; if it stays, the cron is not running.", about: s.client });
  const unread = await first<{ n: number; oldest: number | null }>(env.DB, "SELECT COUNT(*) AS n, MIN(updated) AS oldest FROM drive_photos WHERE status = 'new'");
  if (unread?.n && unread.oldest && now() - unread.oldest > 2 * HOUR) add({ area: "crons", severity: "warn", title: `${unread.n} Drive photos wait to be read`, detail: `The oldest has waited ${Math.round((now() - unread.oldest) / HOUR)} h; the reader does about 36 a minute.`, fix: "If this grows, the cron or the vision model is failing: check the worker's logs." });
  else if (unread?.n) add({ area: "crons", severity: "info", title: `${unread.n} Drive photos being read`, detail: "They are named and sorted by the cron, a few a minute." });
  const failed = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM drive_photos WHERE status = 'failed'");
  if (failed?.n) add({ area: "crons", severity: "info", title: `${failed.n} Drive photos could not be read`, detail: "Drive gave no preview of them (too big, or a format the preview does not make). They are not offered as products.", fix: "Export them as JPG under 25 MB in Drive to have them read." });

  const styles = await getSetting(env, "styles_daily");
  const day = styles?.split("|")[0] ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  if (!styles) add({ area: "crons", severity: "warn", title: "The style library never refreshed", fix: "The daily refresh runs from the cron; check that the worker's schedule is on." });
  else if (day !== today && day !== yesterday) add({ area: "crons", severity: "warn", title: "The style library stopped refreshing", detail: `Last refresh ${day}.`, fix: "Check the worker's logs for [styles] errors (Pinterest or the vision model)." });
  else add({ area: "crons", severity: "ok", title: "Style library refreshing daily", detail: `Last refresh ${day}.` });

  const cleanup = Number((await getSetting(env, "last_cleanup")) ?? 0);
  if (cleanup && now() - cleanup > 3 * DAY) add({ area: "crons", severity: "warn", title: "Old months not cleaned up lately", detail: `Last cleanup ${Math.round((now() - cleanup) / DAY)} days ago.` });

  // Tasks that got stuck in the engine.
  const stuck = await all<{ batch: string; post: number | null; status: string; updated: number }>(env.DB, "SELECT batch, post, status, updated FROM tasks WHERE status IN ('processing','finalizing') AND updated < ?", now() - 30 * 60_000);
  for (const t of stuck) add({ area: "crons", severity: "error", title: `A post is stuck ${t.status}`, detail: `Post ${t.post ?? "?"}, since ${Math.round((now() - t.updated) / 60_000)} min.`, fix: "Open the month and press Make it again on that post; it resets the task.", about: await monthLabelOf(env, t.batch) });
  const queued = await all<{ batch: string; n: number }>(env.DB, "SELECT t.batch, COUNT(*) AS n FROM tasks t JOIN batches b ON b.id = t.batch WHERE t.status = 'queued' AND b.state != 'running' AND t.updated < ? GROUP BY t.batch", now() - 20 * 60_000);
  for (const q of queued) add({ area: "crons", severity: "warn", title: `${q.n} post${q.n > 1 ? "s" : ""} queued but the month is not running`, fix: "Open the month and press Resume (or Generate again).", about: await monthLabelOf(env, q.batch) });
}

/* ───────────── Clients ───────────── */

async function checkClients(env: Env, add: (f: AuditFinding) => void) {
  const clients = await all<{ id: string; name: string; logo_key: string | null; colors: string; tone: string; service: string | null }>(env.DB, "SELECT id, name, logo_key, colors, tone, service FROM clients WHERE status = 'active'");
  const profiles = new Map((await all<{ client: string; instagram: string; website: string; profile: string | null; analysed: number | null; drive: string }>(env.DB, "SELECT client, instagram, website, profile, analysed, drive FROM client_profiles")).map((p) => [p.client, p]));
  const portraits = new Map((await all<{ client: string; n: number }>(env.DB, "SELECT client, COUNT(*) AS n FROM ambassadors WHERE image_key IS NOT NULL GROUP BY client")).map((r) => [r.client, r.n]));
  const places = new Map((await all<{ client: string; n: number }>(env.DB, "SELECT client, COUNT(*) AS n FROM drive_photos WHERE status = 'read' AND kind IN ('place','factory') GROUP BY client")).map((r) => [r.client, r.n]));
  const uploadedPlaces = new Map((await all<{ client: string; n: number }>(env.DB, "SELECT client, COUNT(*) AS n FROM brand_assets WHERE kind = 'place' GROUP BY client")).map((r) => [r.client, r.n]));
  const realRefs = new Map((await all<{ client: string; n: number }>(env.DB, "SELECT client, COUNT(*) AS n FROM brand_assets WHERE kind = 'realref' GROUP BY client")).map((r) => [r.client, r.n]));
  const months = new Map((await all<{ client: string; n: number }>(env.DB, "SELECT client, COUNT(*) AS n FROM batches GROUP BY client")).map((r) => [r.client, r.n]));
  let complete = 0;
  for (const c of clients) {
    const about = c.name;
    const missing: string[] = [];
    if (!c.logo_key) missing.push("logo");
    let colours = 0;
    try {
      colours = (JSON.parse(c.colors) as unknown[]).length;
    } catch {
      colours = 0;
    }
    if (!colours) missing.push("brand colours");
    if (!c.tone?.trim()) missing.push("tone of voice");
    const p = profiles.get(c.id);
    if (missing.length) add({ area: "clients", severity: months.get(c.id) ? "warn" : "info", title: `Brand kit incomplete: no ${missing.join(", ")}`, detail: months.get(c.id) ? "Its posts go out without them." : "No month yet; fill it before the first one.", fix: "Studio → Brand kit, or the journey's Brand kit screen.", about });
    if (!p?.profile) add({ area: "clients", severity: months.get(c.id) ? "warn" : "info", title: "No Analysis (client profile)", detail: p?.instagram || p?.website ? "The Instagram or website is on file but was never read." : "No Instagram handle or website on file either.", fix: "Journey's first screen → the profile card → Analysis (add the Instagram handle first).", about });
    else if (p.analysed && now() - p.analysed > 90 * DAY) add({ area: "clients", severity: "info", title: "The Analysis is over three months old", fix: "Run it again from the profile card.", about });
    if (!p?.drive) add({ area: "clients", severity: "info", title: "No Drive folder", detail: "Products come only from uploads and the gallery.", fix: "Products → Drive on the journey.", about });
    else if (!places.get(c.id) && !uploadedPlaces.get(c.id)) add({ area: "clients", severity: "info", title: "No photos of the shop or kitchen", detail: "Place tiles become product tiles; no behind-the-scenes posts in the real place.", fix: "Add a shop/kitchen folder in Drive, or upload Place photos in the brand kit.", about });
    if (!portraits.get(c.id)) add({ area: "clients", severity: "info", title: "No ambassador with a portrait", detail: "Posts with people cannot be made for this client.", fix: "Visual identity → Brand ambassadors → create a portrait.", about });
    if (portraits.get(c.id) && !realRefs.get(c.id)) add({ area: "clients", severity: "info", title: "No real-people references", detail: "The people in its posts follow the realism rules only, with no real photo to copy.", fix: "Brand kit → Real people → paste Pinterest links of real models.", about });
    if (!missing.length && p?.profile) complete++;
  }
  add({ area: "clients", severity: "ok", title: `${complete} of ${clients.length} active clients complete`, detail: "Logo, colours, tone and an Analysis." });
}

/* ───────────── Months ───────────── */

async function monthLabelOf(env: Env, batch: string): Promise<string> {
  const b = await first<{ client: string | null; month: string | null }>(env.DB, "SELECT client, month FROM batches WHERE id = ?", batch);
  const name = b?.client ? ((await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", b.client))?.name ?? b.client) : "?";
  return `${name} · ${b?.month ?? "?"}`;
}

async function checkMonths(env: Env, add: (f: AuditFinding) => void) {
  const batches = await all<{ id: string; client: string | null; month: string | null; state: string; config: string; updated: number }>(env.DB, "SELECT id, client, month, state, config, updated FROM batches WHERE updated > ? ORDER BY updated DESC LIMIT 20", now() - 120 * DAY);
  const names = new Map((await all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM clients")).map((c) => [c.id, c.name]));
  for (const b of batches) {
    let config: Config;
    try {
      config = JSON.parse(b.config) as Config;
    } catch {
      add({ area: "months", severity: "error", title: "The month's settings cannot be read", detail: "Its config is not valid JSON.", about: `${names.get(b.client ?? "") ?? b.client} · ${b.month}` });
      continue;
    }
    if (config.mode !== "post") continue;
    const about = `${names.get(b.client ?? "") ?? b.client} · ${b.month}`;
    const plan: Post[] = config.plan ?? [];
    if (!plan.length) {
      add({ area: "months", severity: "info", title: "No ideas yet", detail: "The month was started but has no posts.", fix: "Open it and go through the journey, or delete it from Months.", about });
      continue;
    }
    const tasks = await all<{ post: number | null; status: string; output: string | null; qa: string | null; caption: string | null; error: string | null }>(env.DB, "SELECT post, status, output, qa, caption, error FROM tasks WHERE batch = ? AND post IS NOT NULL", b.id);
    const sources = await all<{ name: string }>(env.DB, "SELECT name FROM sources WHERE batch = ? AND kind = 'product'", b.id);
    const productNames = new Set(sources.map((s) => decodeEntities(stemOf(s.name).split("/").pop() ?? s.name).toLowerCase()));
    const made = tasks.filter((t) => t.output).length;
    const failed = tasks.filter((t) => t.error && !["queued", "processing", "finalizing"].includes(t.status));
    if (failed.length) add({ area: "months", severity: "warn", title: `${failed.length} post${failed.length > 1 ? "s" : ""} failed`, detail: failed.map((t) => `post ${t.post}: ${(t.error ?? "").slice(0, 90)}`).join("; "), fix: "Open the month and press Make it again on each.", about });
    if (made && made < plan.length) add({ area: "months", severity: "info", title: `${plan.length - made} of ${plan.length} posts not generated yet`, fix: "Journey → Test grid → Generate.", about });
    // The review's flags on the finished pictures.
    const byKind = new Map<string, number[]>();
    for (const t of tasks) {
      if (!t.output || !t.qa) continue;
      try {
        const qa = JSON.parse(t.qa) as QA;
        for (const f of qa.flags ?? []) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), t.post!]);
      } catch {
        /* unreadable review */
      }
    }
    const labels: Record<string, string> = { product: "product not like its photo", size: "wrong size or hold", invented: "invented items", text: "writing in the picture", bag: "bags", foreign: "foreign drinks or food", people: "people problems", tile: "drift from the grid tile", ailook: "AI-looking people" };
    for (const [kind, posts] of byKind) add({ area: "months", severity: kind === "tile" ? "info" : "warn", title: `${posts.length} post${posts.length > 1 ? "s" : ""} flagged: ${labels[kind] ?? kind}`, detail: `Post${posts.length > 1 ? "s" : ""} ${[...new Set(posts)].sort((x, y) => x - y).join(", ")}.`, fix: "Open the Generate step: Fix it on each, or Fix all for me.", about });
    // Captions and products.
    const noCaption = plan.filter((p) => tasks.some((t) => t.post === p.index && t.output) && !p.caption?.trim() && !tasks.find((t) => t.post === p.index)?.caption);
    if (noCaption.length) add({ area: "months", severity: "warn", title: `${noCaption.length} finished post${noCaption.length > 1 ? "s have" : " has"} no caption`, detail: `Post${noCaption.length > 1 ? "s" : ""} ${noCaption.map((p) => p.index).join(", ")}.`, fix: "Journey → Captions → Write from the pictures.", about });
    const missingProduct = plan.filter((p) => p.product && !productNames.has(p.product.trim().toLowerCase()) && p.type !== "offer" && p.type !== "greeting");
    if (missingProduct.length) add({ area: "months", severity: made ? "info" : "warn", title: `${missingProduct.length} post${missingProduct.length > 1 ? "s name" : " names"} a product with no photo in the month`, detail: missingProduct.map((p) => `post ${p.index}: ${p.product}`).join("; "), fix: "Props and shots → Recommended products, or Fill from Drive.", about });
    // The client's answers on the approval link.
    const changes = Object.entries(config.approvals ?? {}).filter(([, a]) => a.status === "changes");
    if (changes.length) add({ area: "months", severity: "info", title: `The client asked for changes on ${changes.length} post${changes.length > 1 ? "s" : ""}`, detail: changes.map(([i, a]) => `post ${i}: ${(a.note ?? "").slice(0, 80)}`).join("; "), fix: "Feed step → Client's answers → Make the change.", about });
    const oldTypo = plan.filter((p) => p.ov?.typo && p.ov.typoFor && tasks.find((t) => t.post === p.index)?.output !== p.ov.typoFor);
    if (oldTypo.length) add({ area: "months", severity: "info", title: `Typography set for an older picture on ${oldTypo.length} post${oldTypo.length > 1 ? "s" : ""}`, fix: "Typography styles → set it again.", about });
    if (!byKind.size && !failed.length && made === plan.length && !noCaption.length) add({ area: "months", severity: "ok", title: `${plan.length} posts made, reviewed and captioned`, about });
  }
  if (!batches.length) add({ area: "months", severity: "info", title: "No months in the last four months" });
}

/* ───────────── Style library ───────────── */

async function checkLibrary(env: Env, add: (f: AuditFinding) => void) {
  const rows = await all<{ status: string; grid: number; n: number }>(env.DB, "SELECT status, category = 'grid' AS grid, COUNT(*) AS n FROM styles GROUP BY status, category = 'grid'");
  const n = (status: string, grid: boolean) => rows.find((r) => r.status === status && !!r.grid === grid)?.n ?? 0;
  add({ area: "library", severity: "ok", title: `${n("active", false)} styles and ${n("active", true)} grids in the library` });
  const review = n("review", false) + n("review", true);
  if (review) add({ area: "library", severity: review > 40 ? "warn" : "info", title: `${review} new style${review > 1 ? "s" : ""} wait for approval`, fix: "Approvals in the journey's top bar, or the Approvals page." });
  const pool = n("pool", false) + n("pool", true);
  if (pool > 3000) add({ area: "library", severity: "info", title: `${pool} pins collected and not read yet`, detail: "The reader does a few a minute; the pool keeps the library fresh." });
  const noImage = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'active' AND (image_key IS NULL OR thumb_key IS NULL)");
  if (noImage?.n) add({ area: "library", severity: "warn", title: `${noImage.n} active style${noImage.n > 1 ? "s" : ""} without a picture`, fix: "Remove them from Styles; they cannot be used." });
}

/* ───────────── Storage ───────────── */

async function checkStorage(env: Env, add: (f: AuditFinding) => void) {
  const users = new Set((await all<{ id: string }>(env.DB, "SELECT id FROM users")).map((u) => u.id));
  const batches = new Set((await all<{ id: string }>(env.DB, "SELECT id FROM batches")).map((b) => b.id));
  const top = await env.BUCKET.list({ delimiter: "/" });
  const known = new Set(["clients/", "drive-place/", "styles/", "refs/", "hero/", "seed/", "public/"]);
  let orphanBatches = 0;
  const strangers: string[] = [];
  for (const prefix of top.delimitedPrefixes) {
    const owner = prefix.replace(/\/$/, "");
    if (users.has(owner)) {
      const inner = await env.BUCKET.list({ prefix, delimiter: "/" });
      for (const bp of inner.delimitedPrefixes) if (!batches.has(bp.split("/")[1] ?? "")) orphanBatches++;
    } else if (!known.has(prefix) && !/^tmp-/.test(prefix)) strangers.push(prefix);
    else if (/^tmp-/.test(prefix)) strangers.push(prefix);
  }
  if (orphanBatches) add({ area: "storage", severity: "warn", title: `${orphanBatches} deleted month${orphanBatches > 1 ? "s" : ""} still have files in storage`, detail: "They cost storage and nothing uses them.", fix: "A developer can remove them with the bucket's prefix delete." });
  if (strangers.length) add({ area: "storage", severity: "info", title: `${strangers.length} folder${strangers.length > 1 ? "s" : ""} in storage belong to nothing`, detail: strangers.slice(0, 6).join(", ") });
  if (!orphanBatches && !strangers.length) add({ area: "storage", severity: "ok", title: "Storage holds only what the studio uses" });
}

/* ───────────── Writing (deep) ───────────── */

async function checkWriting(env: Env, add: (f: AuditFinding) => void) {
  const b = await first<{ id: string; client: string | null; month: string | null; config: string }>(env.DB, "SELECT id, client, month, config FROM batches WHERE config LIKE '%\"plan\":[{%' ORDER BY updated DESC LIMIT 1");
  if (!b) return;
  const config = JSON.parse(b.config) as Config;
  const client = await first<{ name: string; tone: string; language: string }>(env.DB, "SELECT name, tone, language FROM clients WHERE id = ?", b.client ?? "");
  if (!client) return;
  const captions = new Map((await all<{ post: number | null; caption: string | null }>(env.DB, "SELECT post, caption FROM tasks WHERE batch = ? AND caption IS NOT NULL", b.id)).map((t) => [t.post, t.caption]));
  const posts = (config.plan ?? []).map((p) => {
    let caption = p.caption;
    let hashtags = p.hashtags;
    try {
      const c = captions.get(p.index) ? (JSON.parse(captions.get(p.index)!) as { text?: string; hashtags?: string }) : null;
      if (c?.text) caption = c.text;
      if (c?.hashtags) hashtags = c.hashtags;
    } catch {
      /* the plan's caption */
    }
    return { index: p.index, type: p.type, headline: p.headline, subline: p.subline, caption, hashtags };
  });
  const about = `${client.name} · ${b.month}`;
  const raw = await askText(env, writingReviewInstruction({ client: client.name, tone: client.tone, language: client.language, posts }), WRITING_REVIEW_SCHEMA);
  const r = parseWritingReview(parseJson<unknown>(raw));
  if (!r) throw new StudioError("The writing review returned nothing usable.");
  add({ area: "writing", severity: r.score >= 8 ? "ok" : r.score >= 6 ? "info" : "warn", title: `Writing scored ${r.score}/10 on the latest month`, detail: r.summary, about });
  for (const i of r.issues) add({ area: "writing", severity: "warn", title: `Post ${i.post}: ${i.issue.slice(0, 160)}`, fix: "Edit the headline or caption in the studio (it saves when you click out).", about });
}
