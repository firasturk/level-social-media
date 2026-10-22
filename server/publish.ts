/**
 * Publishing approved posts to Instagram (Meta Graph content publishing). The browser composes the
 * final artwork (words and logo over the picture) and sends it as JPEG; it is kept in R2 and
 * Instagram fetches it by a signed URL. A publication is queued for a time or published at once; the
 * cron publishes the queued ones when their time comes, claiming each row first so two passes
 * never publish the same post twice. The token is the Meta connection's (server/meta.ts); it must
 * carry instagram_content_publish, which the reading connection does not need.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { getSetting } from "./settings";
import { signObjectUrl } from "./signed";
import { ownedPlan } from "./posts";
import type { User } from "@shared/types";
import type { Config } from "@shared/config";
import type { Post } from "@shared/posts";
import { buildCaption, CAPTION_MAX, CAROUSEL_MAX, CAROUSEL_MIN, slidesOf, type Publication, type PublicationKind, type PublicationStatus } from "@shared/publish";

type Variables = { user: User };
export const publishRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** One Graph API version for every call; the same as the reading connection's. */
export const GRAPH = "https://graph.facebook.com/v23.0";
const TOKEN_SETTING = "meta_token";
const ACCOUNT_SETTING = "meta_account";
const ACCOUNTS_SETTING = "meta_accounts";
const PERMISSION = "instagram_content_publish";
/** How long Instagram has to fetch a picture (it fetches when the container is made, not later). */
const IMAGE_URL_TTL = 24 * 60 * 60 * 1000;
/** How many queued rows one cron pass publishes. */
export const PER_PASS = 3;
/** A row left 'publishing' this long was interrupted (the Worker died mid-call): it is marked failed so it can be retried. */
const STUCK_AFTER = 15 * 60 * 1000;
const MAX_ARTWORK = 15 * 1024 * 1024;

export const RECONNECT_HELP = "Reconnect Instagram in Connection with the publishing permission (instagram_content_publish).";
export const NOT_CONNECTED = "Not connected. An admin pastes a Meta token in Connection, Instagram tab, generated with the publishing permission (instagram_content_publish).";

/* ───────────── Graph ───────────── */

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  error_user_title?: string;
}

function graphFailure(status: number, err: GraphError | undefined): StudioError {
  const m = err?.error_user_msg || err?.message || `Meta answered ${status}`;
  if (err?.code === 190) return new StudioError("The Meta token no longer works. Paste a new one in Connection.", 401);
  if (err?.code === 10 || err?.code === 200 || /permission/i.test(m)) return new StudioError(`Meta refused: ${m.replace(/\.?$/, ".")} ${RECONNECT_HELP}`, 403);
  return new StudioError(`Meta: ${m}`, status >= 400 && status < 500 ? 400 : 502);
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const url = `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  const d = (await r.json().catch(() => ({}))) as { error?: GraphError } & T;
  if (!r.ok || d.error) throw graphFailure(r.status, d.error);
  return d;
}

async function graphPost<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}`, { method: "POST", body, signal: AbortSignal.timeout(25_000) });
  const d = (await r.json().catch(() => ({}))) as { error?: GraphError } & T;
  if (!r.ok || d.error) throw graphFailure(r.status, d.error);
  return d;
}

/* ───────────── The connection ───────────── */

export interface PublishAccount {
  igId: string;
  username: string;
}

export interface PublishStatus {
  connected: boolean;
  /** When not connected: what to do, in plain words. */
  reason: string | null;
  accounts: PublishAccount[];
  /** The account this client publishes to (remembered), or the connection's own. */
  chosen: string | null;
}

/** Whether a token carries the publishing permission, remembered a few minutes per isolate. */
const permissionCache = new Map<string, { granted: boolean; at: number }>();
const PERMISSION_TTL = 5 * 60 * 1000;
export function clearPermissionCache(): void {
  permissionCache.clear();
}

async function hasPublishPermission(token: string): Promise<boolean> {
  const hit = permissionCache.get(token);
  if (hit && Date.now() - hit.at < PERMISSION_TTL) return hit.granted;
  const d = await graphGet<{ data?: { permission: string; status: string }[] }>("me/permissions", token);
  const granted = (d.data ?? []).some((p) => p.permission === PERMISSION && p.status === "granted");
  permissionCache.set(token, { granted, at: Date.now() });
  return granted;
}

async function savedAccounts(env: Env): Promise<PublishAccount[]> {
  try {
    const list = JSON.parse((await getSetting(env, ACCOUNTS_SETTING)) ?? "[]") as { igId: string; username?: string }[];
    return list.filter((a) => a?.igId).map((a) => ({ igId: a.igId, username: a.username ?? "" }));
  } catch {
    return [];
  }
}

/** The account a client published to last, else the connection's reading account, else the first. */
async function chosenAccount(env: Env, client: string | null, accounts: PublishAccount[]): Promise<string | null> {
  if (!accounts.length) return null;
  if (client) {
    const row = await first<{ ig_account: string }>(env.DB, "SELECT ig_account FROM client_publish WHERE client = ?", client);
    if (row && accounts.some((a) => a.igId === row.ig_account)) return row.ig_account;
  }
  try {
    const own = JSON.parse((await getSetting(env, ACCOUNT_SETTING)) ?? "null") as { igId?: string } | null;
    if (own?.igId && accounts.some((a) => a.igId === own.igId)) return own.igId;
  } catch {
    /* no reading account chosen */
  }
  return accounts[0].igId;
}

/** Is publishing possible: a token, an Instagram business account behind it, and the permission. */
export async function publishStatus(env: Env, client: string | null): Promise<PublishStatus> {
  const token = await getSetting(env, TOKEN_SETTING);
  if (!token) return { connected: false, reason: NOT_CONNECTED, accounts: [], chosen: null };
  const accounts = await savedAccounts(env);
  if (!accounts.length)
    return {
      connected: false,
      reason: "Not connected for publishing: the token sees no Facebook Page with an Instagram business account linked. Link the account to its Page, then reconnect Instagram in Connection.",
      accounts: [],
      chosen: null,
    };
  const chosen = await chosenAccount(env, client, accounts);
  try {
    if (!(await hasPublishPermission(token))) return { connected: false, reason: `Not connected for publishing. ${RECONNECT_HELP}`, accounts, chosen };
  } catch (e) {
    return { connected: false, reason: `Not connected for publishing: ${errorMessage(e)}`, accounts, chosen };
  }
  return { connected: true, reason: null, accounts, chosen };
}

/* ───────────── Rows ───────────── */

interface Row {
  id: string;
  batch: string;
  client: string | null;
  post: number;
  ig_account: string;
  kind: PublicationKind;
  status: PublicationStatus;
  scheduled_at: number;
  published_at: number | null;
  media_id: string | null;
  permalink: string | null;
  error: string | null;
  artwork_keys: string;
  caption: string;
  created: number;
  updated: number;
}

function keysOf(row: Row): string[] {
  try {
    const k = JSON.parse(row.artwork_keys) as unknown;
    return Array.isArray(k) ? k.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toPublication(row: Row): Publication {
  return {
    id: row.id,
    batch: row.batch,
    post: row.post,
    igAccount: row.ig_account,
    kind: row.kind,
    status: row.status,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    mediaId: row.media_id,
    permalink: row.permalink,
    error: row.error,
    slides: keysOf(row).length,
    caption: row.caption,
    created: row.created,
    updated: row.updated,
  };
}

async function rowOf(env: Env, id: string): Promise<Row | null> {
  return first<Row>(env.DB, "SELECT * FROM publications WHERE id = ?", id);
}

/** The month's publications, newest first. */
export async function listPublications(env: Env, batch: string): Promise<Publication[]> {
  return (await all<Row>(env.DB, "SELECT * FROM publications WHERE batch = ? ORDER BY created DESC", batch)).map(toPublication);
}

/* ───────────── Publishing one row ───────────── */

export interface PublishDeps {
  /** How the poll waits between two looks at a container (a test passes a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** How many times a container is looked at before giving up. */
  pollAttempts?: number;
  pollWaitMs?: number;
}

/** How a container is polled by default (a test shortens the wait). */
export const POLL = {
  attempts: 12,
  waitMs: 2500,
  sleep: (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)),
};

/** Waits until Instagram has fetched and processed a container; throws Meta's reason when it did not. */
async function waitForContainer(id: string, token: string, deps: PublishDeps): Promise<void> {
  const sleep = deps.sleep ?? POLL.sleep;
  const attempts = deps.pollAttempts ?? POLL.attempts;
  const wait = deps.pollWaitMs ?? POLL.waitMs;
  for (let i = 0; i < attempts; i++) {
    const d = await graphGet<{ status_code?: string; status?: string }>(`${id}?fields=status_code,status`, token);
    const code = d.status_code ?? "";
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new StudioError(`Instagram could not take the picture: ${d.status || code}. Check it is a JPEG between 4:5 and 1.91:1, under 8 MB.`, 400);
    await sleep(wait);
  }
  throw new StudioError("Instagram was still processing the picture after half a minute. Retry in a minute.", 504);
}

async function publishGraph(env: Env, row: Row, token: string, deps: PublishDeps): Promise<{ mediaId: string; permalink: string | null }> {
  const keys = keysOf(row);
  if (!keys.length) throw new StudioError("This publication has no artwork stored.", 409);
  const urls = await Promise.all(keys.map((k) => signObjectUrl(env, k, IMAGE_URL_TTL)));
  let creation: string;
  if (row.kind === "carousel") {
    const children: string[] = [];
    for (const url of urls) {
      const c = await graphPost<{ id: string }>(`${row.ig_account}/media`, { image_url: url, is_carousel_item: "true" }, token);
      children.push(c.id);
    }
    for (const c of children) await waitForContainer(c, token, deps);
    const parent = await graphPost<{ id: string }>(`${row.ig_account}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: row.caption }, token);
    creation = parent.id;
  } else {
    const c = await graphPost<{ id: string }>(`${row.ig_account}/media`, { image_url: urls[0], caption: row.caption }, token);
    creation = c.id;
  }
  await waitForContainer(creation, token, deps);
  const published = await graphPost<{ id: string }>(`${row.ig_account}/media_publish`, { creation_id: creation }, token);
  let permalink: string | null = null;
  try {
    permalink = (await graphGet<{ permalink?: string }>(`${published.id}?fields=permalink`, token)).permalink ?? null;
  } catch {
    /* the post is out; the link can be read later */
  }
  return { mediaId: published.id, permalink };
}

/**
 * Claims a queued row and publishes it. False when another pass took it first (or it was cancelled
 * meanwhile). The outcome, published or failed with Meta's words, is written on the row.
 */
export async function publishRow(env: Env, id: string, deps: PublishDeps = {}): Promise<boolean> {
  const claimed = await run(env.DB, "UPDATE publications SET status = 'publishing', updated = ? WHERE id = ? AND status = 'queued'", now(), id);
  if (claimed !== 1) return false;
  const row = await rowOf(env, id);
  if (!row) return false;
  try {
    const token = await getSetting(env, TOKEN_SETTING);
    if (!token) throw new StudioError(NOT_CONNECTED, 428);
    const { mediaId, permalink } = await publishGraph(env, row, token, deps);
    await run(env.DB, "UPDATE publications SET status = 'published', media_id = ?, permalink = ?, published_at = ?, error = NULL, updated = ? WHERE id = ?", mediaId, permalink, now(), now(), id);
  } catch (e) {
    await run(env.DB, "UPDATE publications SET status = 'failed', error = ?, updated = ? WHERE id = ?", errorMessage(e).slice(0, 1000), now(), id);
  }
  return true;
}

/** The cron's pass: the queued rows whose time has come, a few per minute, each claimed before it goes. */
export async function publishDue(env: Env, deps: PublishDeps = {}): Promise<number> {
  const t = now();
  await run(
    env.DB,
    "UPDATE publications SET status = 'failed', error = 'The publish was interrupted before Instagram answered. Retry it.', updated = ? WHERE status = 'publishing' AND updated < ?",
    t,
    t - STUCK_AFTER,
  );
  const due = await all<{ id: string }>(env.DB, "SELECT id FROM publications WHERE status = 'queued' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?", t, PER_PASS);
  let n = 0;
  for (const { id } of due) if (await publishRow(env, id, deps)) n++;
  return n;
}

/* ───────────── Routes ───────────── */

const dataUrl = z.string().regex(/^data:image\/jpeg;base64,/i, "Each picture must be a JPEG data URL.");

const createSchema = z.object({
  batch: z.string().min(1),
  index: z.coerce.number().int().min(0),
  igAccount: z.string().min(1).max(40),
  when: z.union([z.literal("now"), z.string().datetime({ offset: true })]),
  artwork: z.array(dataUrl).min(1).max(CAROUSEL_MAX),
});

function jpegBytes(url: string): ArrayBuffer {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  if (bin.length > MAX_ARTWORK) throw new StudioError("A picture is too large (up to 15 MB).");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Where to publish: the request's time, or now. A time already past publishes now. */
function scheduledTime(when: string): { at: number; immediate: boolean } {
  if (when === "now") return { at: now(), immediate: true };
  const at = Date.parse(when);
  if (!Number.isFinite(at)) throw new StudioError("The time to publish is not a date.");
  return at <= now() ? { at: now(), immediate: true } : { at, immediate: false };
}

publishRoutes.get("/status", async (c) => {
  const client = c.req.query("client") || null;
  return c.json(await publishStatus(c.env, client));
});

publishRoutes.get("/", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  return c.json({ publications: await listPublications(c.env, b.id) });
});

publishRoutes.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError(parsed.error.issues[0]?.message || "The request is not complete.");
  const d = parsed.data;
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan: Post[] = config.plan ?? [];
  const slides = slidesOf(plan, d.index);
  if (!slides.length) throw new StudioError("That post is not in the month.", 404);
  const lead = slides[0];
  const kind: PublicationKind = lead.group?.kind === "carousel" ? "carousel" : "single";
  if (kind === "carousel") {
    if (slides.length < CAROUSEL_MIN || slides.length > CAROUSEL_MAX) throw new StudioError(`A carousel takes ${CAROUSEL_MIN} to ${CAROUSEL_MAX} pictures; this one has ${slides.length}.`);
    if (d.artwork.length !== slides.length) throw new StudioError(`This carousel has ${slides.length} slides; send one picture per slide.`);
  } else if (d.artwork.length !== 1) throw new StudioError("A single post takes exactly one picture.");

  const status = await publishStatus(c.env, b.client);
  if (!status.connected) throw new StudioError(status.reason ?? NOT_CONNECTED, 428);
  if (!status.accounts.some((a) => a.igId === d.igAccount)) throw new StudioError("That Instagram account is not behind the saved token.", 404);

  const caption = buildCaption(lead.caption, lead.hashtags);
  if (caption.length > CAPTION_MAX) throw new StudioError(`The caption is ${caption.length} characters; Instagram takes ${CAPTION_MAX}. Shorten it or the hashtags.`);

  const indexes = slides.map((p) => p.index);
  const live = await all<{ post: number; status: string }>(
    c.env.DB,
    `SELECT post, status FROM publications WHERE batch = ? AND status IN ('queued', 'publishing', 'published') AND post IN (${indexes.map(() => "?").join(",")})`,
    b.id,
    ...indexes,
  );
  if (live.length) throw new StudioError(live[0].status === "published" ? "This post is already published on Instagram." : "This post is already scheduled; cancel it first to change it.", 409);

  const id = uuid();
  const keys: string[] = [];
  for (let i = 0; i < d.artwork.length; i++) {
    const key = `publish/${id}-${i + 1}.jpg`;
    await c.env.BUCKET.put(key, jpegBytes(d.artwork[i]), { httpMetadata: { contentType: "image/jpeg" } });
    keys.push(key);
  }
  const { at, immediate } = scheduledTime(d.when);
  const t = now();
  await run(
    c.env.DB,
    "INSERT INTO publications (id, batch, client, post, ig_account, kind, status, scheduled_at, artwork_keys, caption, created, updated) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
    id,
    b.id,
    b.client,
    lead.index,
    d.igAccount,
    kind,
    at,
    JSON.stringify(keys),
    caption,
    t,
    t,
  );
  if (b.client)
    await run(c.env.DB, "INSERT INTO client_publish (client, ig_account, updated) VALUES (?, ?, ?) ON CONFLICT(client) DO UPDATE SET ig_account = excluded.ig_account, updated = excluded.updated", b.client, d.igAccount, t);
  if (immediate) await publishRow(c.env, id);
  const row = await rowOf(c.env, id);
  return c.json({ ok: true, publication: toPublication(row!) });
});

/** A publication the user may act on: its month must be theirs (or they are an admin). */
async function ownedRow(c: { env: Env; get(k: "user"): User; req: { param(k: "id"): string } }): Promise<Row> {
  const row = await rowOf(c.env, c.req.param("id"));
  if (!row) throw new StudioError("That publication does not exist.", 404);
  await ownedPlan(c.env, c.get("user"), row.batch);
  return row;
}

publishRoutes.post("/:id/cancel", async (c) => {
  const row = await ownedRow(c);
  const changed = await run(c.env.DB, "UPDATE publications SET status = 'cancelled', updated = ? WHERE id = ? AND status = 'queued'", now(), row.id);
  if (!changed) throw new StudioError(row.status === "published" ? "This post is already on Instagram; delete it there." : "Only a scheduled post can be cancelled.", 409);
  return c.json({ ok: true, publication: toPublication((await rowOf(c.env, row.id))!) });
});

publishRoutes.post("/:id/retry", async (c) => {
  const row = await ownedRow(c);
  if (row.status !== "failed" && row.status !== "cancelled") throw new StudioError("Only a failed or cancelled publication can be retried.", 409);
  const status = await publishStatus(c.env, row.client);
  if (!status.connected) throw new StudioError(status.reason ?? NOT_CONNECTED, 428);
  await run(c.env.DB, "UPDATE publications SET status = 'queued', error = NULL, scheduled_at = ?, updated = ? WHERE id = ?", now(), now(), row.id);
  await publishRow(c.env, row.id);
  return c.json({ ok: true, publication: toPublication((await rowOf(c.env, row.id))!) });
});
