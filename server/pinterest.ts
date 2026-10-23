/**
 * Pinterest's official API (v5), connected under Connection → Pinterest. It is used to read a
 * pin's video for the video editor's "Edit like this video" (server/video-reference.ts), because
 * Pinterest's pin pages carry no pin data for a server and its internal endpoints refuse servers.
 *
 * What is kept (one encrypted setting, `pinterest_connection`, never sent to the browser):
 *   - the access token (Pinterest's tokens start with `pina`, last 30 days);
 *   - optionally the app id and app secret of the admin's Pinterest app, and a refresh token
 *     (`pinr…`, 60 days, renewed on every refresh): with all three the access token is renewed
 *     by itself before it expires (POST /v5/oauth/token, grant_type=refresh_token, Basic auth of
 *     app id:secret), and once more when Pinterest answers 401.
 * With the app id and secret saved, "Sign in with Pinterest" runs the authorization-code flow
 * (redirect `${PUBLIC_BASE_URL}/api/studio/pinterest/callback`, which must be listed in the app's
 * redirect URIs) and keeps both tokens, so nothing has to be copied by hand.
 *
 * The scopes asked for: boards:read and pins:read (GET /v5/pins/{id} demands both) and
 * user_accounts:read (GET /v5/user_account, the test). Pinterest's API reads the pins the
 * connected account can see as their owner (its boards and group boards shared with it), so a
 * stranger's pin answers "not found" until it is saved to one of the account's boards.
 *
 * Routes (mounted at /api/studio/pinterest), admins only except the status:
 *   GET    /status          connected / not connected / expired, the account, until when (every member; secrets never)
 *   PUT    /                {accessToken?, appId?, appSecret?, refreshToken?} kept after Pinterest accepted them
 *   POST   /test            GET /v5/user_account; the account name
 *   DELETE /                drops everything
 *   POST   /signin/start    the authorize link (app id and secret saved first)
 *   GET    /callback        Pinterest's redirect: the code exchanged, the tokens kept, back to `/?pinterest=…`
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { assertIntegrationEnabled, integrationAccess, recordIntegrationOp, requireIntegrationAdmin } from "./integrations";
import { PINTEREST_PENDING_SETTING, PINTEREST_SETTING, deleteSetting, getSetting, setSetting } from "./settings";
import type { User } from "@shared/types";

export const PINTEREST_API = "https://api.pinterest.com/v5";
export const PINTEREST_TOKEN_URL = `${PINTEREST_API}/oauth/token`;
export const PINTEREST_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
export const PINTEREST_SCOPES = "boards:read,pins:read,user_accounts:read";
export const PINTEREST_CALLBACK_PATH = "/api/studio/pinterest/callback";
/** The access token is renewed when it has less than this left. */
export const REFRESH_MARGIN_MS = 24 * 3600 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;

export const NOT_CONNECTED_HINT = "Connect Pinterest in Connection for reliable links.";
export const EXPIRED_MESSAGE = "The Pinterest connection has expired: an admin pastes a new access token (or signs in with Pinterest again) under Connection → Pinterest. With the app id, app secret and refresh token saved, it renews itself.";
export const PIN_NOT_FOUND_MESSAGE = "Pin not found or private: Pinterest's API only reads pins the connected account can see on its own boards (or group boards shared with it). Save the pin to one of the connected account's boards and paste the link of the saved pin, or save the video and use Upload.";
export const PICTURE_PIN_MESSAGE = "This pin is a picture, not a video. Paste the link of a video pin, or use Upload or the client's Drive.";
export const VIDEO_WITHHELD_MESSAGE = "This pin is a video, but Pinterest did not give the studio's app its video file (Pinterest limits the video link to approved apps). Save the video from Pinterest and use Upload, or pick it from the client's Drive.";

export interface PinterestConnection {
  accessToken: string;
  /** When the access token expires (ms); null when not known (a pasted token). */
  expires: number | null;
  refreshToken: string | null;
  /** When the refresh token expires (ms); null when not known. */
  refreshExpires: number | null;
  appId: string | null;
  appSecret: string | null;
  account: { username: string; name: string } | null;
  scope: string | null;
  saved: number;
  refreshed: number | null;
  /** Set when Pinterest refused the token and it could not be renewed: the status says "expired". */
  rejected: number | null;
}

export type PinterestState = "connected" | "not_connected" | "expired";

type Fetch = typeof fetch;

export async function readPinterest(env: Env): Promise<PinterestConnection | null> {
  const raw = await getSetting(env, PINTEREST_SETTING);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<PinterestConnection>;
    return {
      accessToken: c.accessToken ?? "",
      expires: c.expires ?? null,
      refreshToken: c.refreshToken ?? null,
      refreshExpires: c.refreshExpires ?? null,
      appId: c.appId ?? null,
      appSecret: c.appSecret ?? null,
      account: c.account ?? null,
      scope: c.scope ?? null,
      saved: c.saved ?? 0,
      refreshed: c.refreshed ?? null,
      rejected: c.rejected ?? null,
    };
  } catch {
    return null;
  }
}

async function keep(env: Env, c: PinterestConnection): Promise<void> {
  await setSetting(env, PINTEREST_SETTING, JSON.stringify(c));
}

/** The access token can be renewed: app id, app secret and a refresh token that has not expired. */
export function canRefresh(c: PinterestConnection, t = Date.now()): boolean {
  return !!(c.appId && c.appSecret && c.refreshToken && (c.refreshExpires == null || c.refreshExpires > t));
}

export function pinterestState(c: PinterestConnection | null, t = Date.now()): PinterestState {
  if (!c || !c.accessToken) return c && canRefresh(c, t) ? "connected" : "not_connected";
  if (canRefresh(c, t)) return "connected";
  if (c.rejected) return "expired";
  if (c.expires != null && c.expires <= t) return "expired";
  return "connected";
}

/** A usable connection exists (or can be renewed): the API path is taken instead of the page. */
export async function pinterestConnected(env: Env): Promise<boolean> {
  const c = await readPinterest(env);
  return !!c && (!!c.accessToken || canRefresh(c));
}

const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;

interface TokenAnswer {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  refresh_token_expires_at?: number;
  scope?: string;
}

async function tokenRequest(f: Fetch, appId: string, appSecret: string, form: Record<string, string>): Promise<TokenAnswer> {
  let r: Response;
  try {
    r = await f(PINTEREST_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basic(appId, appSecret), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new StudioError(`Pinterest could not be reached to renew the token: ${errorMessage(e)}`, 502);
  }
  const text = await r.text();
  let d: TokenAnswer & { message?: string; error_description?: string } = {};
  try {
    d = JSON.parse(text) as typeof d;
  } catch {
    /* not JSON */
  }
  if (!r.ok || !d.access_token) {
    const why = d.message || d.error_description || text.slice(0, 160) || `HTTP ${r.status}`;
    throw new StudioError(`Pinterest refused the token request (${r.status}): ${why}. Check the app id and app secret, or sign in with Pinterest again.`, r.status === 400 || r.status === 401 ? 409 : 502);
  }
  return d;
}

function applyTokens(c: PinterestConnection, d: TokenAnswer, t = Date.now()): PinterestConnection {
  return {
    ...c,
    accessToken: d.access_token!,
    expires: d.expires_in ? t + d.expires_in * 1000 : null,
    refreshToken: d.refresh_token ?? c.refreshToken,
    refreshExpires: d.refresh_token_expires_at ? d.refresh_token_expires_at * 1000 : d.refresh_token_expires_in ? t + d.refresh_token_expires_in * 1000 : d.refresh_token ? null : c.refreshExpires,
    scope: d.scope ?? c.scope,
    refreshed: t,
    rejected: null,
  };
}

/** Renews the access token with the refresh token (Pinterest hands a new refresh token too) and keeps both. */
export async function refreshPinterest(env: Env, c: PinterestConnection, f: Fetch = fetch): Promise<PinterestConnection> {
  if (!canRefresh(c)) throw new StudioError(EXPIRED_MESSAGE, 409);
  let d: TokenAnswer;
  try {
    d = await tokenRequest(f, c.appId!, c.appSecret!, { grant_type: "refresh_token", refresh_token: c.refreshToken! });
  } catch (e) {
    if (e instanceof StudioError && e.status === 409) await keep(env, { ...c, rejected: Date.now() });
    throw e;
  }
  const next = applyTokens(c, d);
  await keep(env, next);
  return next;
}

/** A current access token, renewed first when it is close to expiry. Null when nothing is connected. */
export async function pinterestAccessToken(env: Env, f: Fetch = fetch): Promise<{ token: string; conn: PinterestConnection } | null> {
  let c = await readPinterest(env);
  if (!c || (!c.accessToken && !canRefresh(c))) return null;
  const t = Date.now();
  const due = !c.accessToken || (c.expires != null && c.expires - t < REFRESH_MARGIN_MS);
  if (due && canRefresh(c, t)) c = await refreshPinterest(env, c, f);
  else if (!c.accessToken || (c.expires != null && c.expires <= t)) throw new StudioError(EXPIRED_MESSAGE, 409);
  return { token: c.accessToken, conn: c };
}

/**
 * One GET on the Pinterest API with the Bearer token; a 401 renews the token once (when it can)
 * and asks again; a 401 that stays marks the connection expired. Reads only, nothing is paid.
 */
export async function pinterestGet(env: Env, path: string, f: Fetch = fetch): Promise<Response> {
  const got = await pinterestAccessToken(env, f);
  if (!got) throw new StudioError(`Pinterest is not connected. ${NOT_CONNECTED_HINT}`, 409);
  const ask = (token: string) => f(`${PINTEREST_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  let r = await ask(got.token);
  if (r.status === 401) {
    if (canRefresh(got.conn)) {
      const next = await refreshPinterest(env, got.conn, f);
      r = await ask(next.accessToken);
    }
    if (r.status === 401) {
      const now = await readPinterest(env);
      if (now) await keep(env, { ...now, rejected: Date.now() });
      throw new StudioError(EXPIRED_MESSAGE, 409);
    }
  }
  return r;
}

/** GET /v5/user_account: who the token belongs to. */
export async function pinterestAccount(env: Env, f: Fetch = fetch): Promise<{ username: string; name: string }> {
  const r = await pinterestGet(env, "/user_account", f);
  if (r.status === 403) throw new StudioError("Pinterest refused to read the account: the token needs the user_accounts:read scope.", 409);
  if (!r.ok) throw new StudioError(`Pinterest answered ${r.status} when the account was read.`, 502);
  const d = (await r.json().catch(() => ({}))) as { username?: string; business_name?: string | null };
  return { username: d.username ?? "", name: d.business_name || d.username || "" };
}

/* ───────────── Pins ───────────── */

/** pinterest.com and its country sites (in.pinterest.com, pinterest.co.uk, br.pinterest.com, pinterest.com.au…). Only the pin id is read from such a link; the link itself is never fetched. */
const PINTEREST_HOST = /^(?:[a-z]{2,3}\.)?pinterest\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2})$/i;

/** A pin link read: its id, or a pin.it short link to resolve. Throws a plain StudioError for anything else. */
export function parsePinLink(link: string): { pinId: string } | { short: string } {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new StudioError("That is not a link.", 400);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new StudioError("That is not a link.", 400);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "pin.it") {
    if (!/^\/[A-Za-z0-9_-]{2,40}\/?$/.test(u.pathname)) throw new StudioError("That pin.it link is not complete.", 400);
    return { short: `https://pin.it${u.pathname}` };
  }
  if (!PINTEREST_HOST.test(host)) throw new StudioError("Paste a Pinterest pin link (pinterest.com/pin/… or pin.it/…).", 400);
  const id = pinIdFromPath(u.pathname);
  if (!id) throw new StudioError("That Pinterest link is not a pin (it should look like pinterest.com/pin/1234…).", 400);
  return { pinId: id };
}

/** `/pin/123…/`, `/pin/some-title--123…/`, `/pin/123…/sent/…`. */
export function pinIdFromPath(path: string): string | null {
  return /^\/pin\/(?:[^/]*--)?(\d{6,25})(?:\/|$)/i.exec(path)?.[1] ?? null;
}

/**
 * A pin.it short link's pin id, read from the redirect it answers: only pin.it is asked (and
 * Pinterest's own shortener hop on api.pinterest.com, when pin.it points there), never the pin
 * page; redirects are read, not followed, three hops at most.
 */
export async function resolveShortLink(short: string, f: Fetch = fetch): Promise<string> {
  let at = short;
  for (let hop = 0; hop < 3; hop++) {
    let r: Response;
    try {
      r = await f(at, { method: "GET", redirect: "manual", headers: { Accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new StudioError(`The pin.it link could not be opened: ${errorMessage(e)}`, 502);
    }
    await r.body?.cancel().catch(() => undefined);
    const loc = r.headers.get("location");
    if (r.status < 300 || r.status >= 400 || !loc) break;
    let next: URL;
    try {
      next = new URL(loc, at);
    } catch {
      break;
    }
    const host = next.hostname.toLowerCase().replace(/^www\./, "");
    if (PINTEREST_HOST.test(host)) {
      const id = pinIdFromPath(next.pathname);
      if (id) return id;
    }
    // Pinterest's shortener hop: pin.it → api.pinterest.com/url_shortener/<code>/redirect/ → the pin.
    if (next.protocol === "https:" && (host === "pin.it" || (host === "api.pinterest.com" && next.pathname.startsWith("/url_shortener/")))) {
      at = next.toString();
      continue;
    }
    break;
  }
  throw new StudioError("The pin.it link did not lead to a pin.", 400);
}

export async function pinIdOfLink(link: string, f: Fetch = fetch): Promise<string> {
  const p = parsePinLink(link);
  return "pinId" in p ? p.pinId : resolveShortLink(p.short, f);
}

/** What a v5 pin's `media` holds: a video's 720p link, a video whose link Pinterest withheld, or no video at all. */
export type PinMediaVideo = { kind: "video"; url: string } | { kind: "withheld" } | { kind: "picture" };

interface MediaItem {
  item_type?: string;
  video_url?: string | null;
}

/**
 * The first video of a pin (v5 schema): media_type "video" carries `video_url` (720p) itself;
 * "multiple_videos" and "multiple_mixed" carry `items`, the videos marked item_type "video".
 */
export function pinMediaVideo(pin: unknown): PinMediaVideo {
  const media = (pin as { media?: { media_type?: string; video_url?: string | null; items?: MediaItem[] } } | null)?.media;
  if (!media) return { kind: "picture" };
  if (media.media_type === "video") return media.video_url ? { kind: "video", url: media.video_url } : { kind: "withheld" };
  if (media.media_type === "multiple_videos" || media.media_type === "multiple_mixed") {
    const videos = (Array.isArray(media.items) ? media.items : []).filter((i) => i && (i.item_type === "video" || (media.media_type === "multiple_videos" && i.item_type !== "image")));
    const withUrl = videos.find((i) => i.video_url);
    if (withUrl) return { kind: "video", url: withUrl.video_url! };
    return videos.length ? { kind: "withheld" } : { kind: "picture" };
  }
  return { kind: "picture" };
}

/** GET /v5/pins/{id}: the pin's first video, or a plain refusal (not found or private / a picture / withheld). */
export async function pinVideoViaApi(env: Env, pinId: string, f: Fetch = fetch): Promise<string> {
  if (!/^\d{6,25}$/.test(pinId)) throw new StudioError("That is not a pin id.", 400);
  const r = await pinterestGet(env, `/pins/${pinId}`, f);
  if (r.status === 404 || r.status === 403) throw new StudioError(PIN_NOT_FOUND_MESSAGE, 404);
  if (r.status === 429) throw new StudioError("Pinterest is limiting requests right now: try again in a minute.", 429);
  if (!r.ok) throw new StudioError(`Pinterest answered ${r.status} for this pin. Try again, or save the video and use Upload.`, 502);
  const pin = await r.json().catch(() => null);
  const v = pinMediaVideo(pin);
  if (v.kind === "picture") throw new StudioError(PICTURE_PIN_MESSAGE, 422);
  if (v.kind === "withheld") throw new StudioError(VIDEO_WITHHELD_MESSAGE, 502);
  return v.url;
}

/* ───────────── Routes: /api/studio/pinterest ───────────── */

type Variables = { user: User };
export const pinterestRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "pinterest");
  await assertIntegrationEnabled(c.env, "pinterest");
  return u;
}

function redirectUri(env: Env, requestUrl: string): string {
  return new URL(PINTEREST_CALLBACK_PATH, env.PUBLIC_BASE_URL || new URL(requestUrl).origin).toString();
}

/** What the page shows. Secrets never leave the server; a member sees only whether it is connected. */
export async function pinterestStatus(env: Env, user: User, requestUrl: string) {
  const c = await readPinterest(env);
  const state = pinterestState(c);
  const access = await integrationAccess(env, user, "pinterest");
  if (user.role !== "admin") return { state, admin: false, access };
  return {
    state,
    admin: true,
    access,
    account: c?.account ?? null,
    expires: c?.expires ?? null,
    refreshExpires: c?.refreshExpires ?? null,
    autoRenew: !!c && canRefresh(c),
    hasToken: !!c?.accessToken,
    hasRefreshToken: !!c?.refreshToken,
    appId: c?.appId ?? null,
    hasAppSecret: !!c?.appSecret,
    refreshed: c?.refreshed ?? null,
    saved: c?.saved ?? null,
    scopes: PINTEREST_SCOPES,
    redirectUri: redirectUri(env, requestUrl),
  };
}

pinterestRoutes.get("/status", async (c) => c.json(await pinterestStatus(c.env, c.get("user"), c.req.url)));

const saveBody = z.object({
  accessToken: z.string().trim().max(4000).optional(),
  appId: z.string().trim().max(200).optional(),
  appSecret: z.string().trim().max(400).optional(),
  refreshToken: z.string().trim().max(4000).optional(),
});

/**
 * Keeps what was pasted (an empty field keeps what was saved). A refresh token with the app id
 * and secret is used at once, so the access token's end date is known; a pasted access token is
 * checked with GET /v5/user_account before it is kept. Nothing is kept when Pinterest refuses.
 */
pinterestRoutes.put("/", async (c) => {
  const user = await gate(c);
  const parsed = saveBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Paste the access token, or the app id, app secret and refresh token.", 400);
  const d = parsed.data;
  if (d.accessToken && !/^[A-Za-z0-9._~+/=-]{20,}$/.test(d.accessToken)) throw new StudioError("That does not look like a Pinterest access token (it starts with pina…).", 400);
  if (d.refreshToken && !/^[A-Za-z0-9._~+/=-]{20,}$/.test(d.refreshToken)) throw new StudioError("That does not look like a Pinterest refresh token (it starts with pinr…).", 400);
  if (d.appId && !/^\d{4,30}$/.test(d.appId)) throw new StudioError("The app id is the number shown on the app's page at developers.pinterest.com.", 400);
  const before = await readPinterest(c.env);
  const t = Date.now();
  let next: PinterestConnection = {
    accessToken: d.accessToken || before?.accessToken || "",
    expires: d.accessToken ? null : (before?.expires ?? null),
    refreshToken: d.refreshToken || before?.refreshToken || null,
    refreshExpires: d.refreshToken ? null : (before?.refreshExpires ?? null),
    appId: d.appId || before?.appId || null,
    appSecret: d.appSecret || before?.appSecret || null,
    account: d.accessToken ? null : (before?.account ?? null),
    scope: before?.scope ?? null,
    saved: t,
    refreshed: before?.refreshed ?? null,
    rejected: null,
  };
  if (!d.accessToken && !d.appId && !d.appSecret && !d.refreshToken) throw new StudioError("Paste the access token, or the app id, app secret and refresh token.", 400);
  if (d.refreshToken && !(next.appId && next.appSecret)) throw new StudioError("A refresh token needs the app id and app secret too (they renew the access token).", 400);
  const f = fetch;
  if (d.refreshToken || ((d.appId || d.appSecret) && next.refreshToken && !d.accessToken)) {
    const tokens = await tokenRequest(f, next.appId!, next.appSecret!, { grant_type: "refresh_token", refresh_token: next.refreshToken! });
    next = applyTokens(next, tokens, t);
  }
  if (next.accessToken) {
    const r = await f(`${PINTEREST_API}/user_account`, { headers: { Authorization: `Bearer ${next.accessToken}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401) throw new StudioError("Pinterest refused this access token (401): it may have expired or been revoked. Nothing was saved.", 409);
    if (r.status === 403) throw new StudioError("Pinterest accepted the token but refused to read the account: the token needs the user_accounts:read scope (and boards:read, pins:read for pins). Nothing was saved.", 409);
    if (!r.ok) throw new StudioError(`Pinterest answered ${r.status} when the token was checked. Nothing was saved.`, 502);
    const a = (await r.json().catch(() => ({}))) as { username?: string; business_name?: string | null };
    next.account = { username: a.username ?? "", name: a.business_name || a.username || "" };
  }
  await keep(c.env, next);
  await recordIntegrationOp(c.env, { provider: "pinterest", kind: "connect", user: user.id, estimate: 0, reported: 0, status: "done", note: next.account ? `connected as @${next.account.username}${canRefresh(next) ? " · renews itself" : ""}` : "app id and secret saved (no token yet)" });
  return c.json({ ok: true, ...(await pinterestStatus(c.env, user, c.req.url)) });
});

/** "Test the connection": GET /v5/user_account with the saved token (renewed first when due). */
pinterestRoutes.post("/test", async (c) => {
  const user = await gate(c);
  try {
    const account = await pinterestAccount(c.env);
    const now = await readPinterest(c.env);
    if (now) await keep(c.env, { ...now, account, rejected: null });
    await recordIntegrationOp(c.env, { provider: "pinterest", kind: "verify", user: user.id, estimate: 0, reported: 0, status: "done", note: `@${account.username}` });
    return c.json({ ok: true, account, message: `Connected to Pinterest as ${account.name}${account.name !== account.username ? ` (@${account.username})` : ""}.` });
  } catch (e) {
    await recordIntegrationOp(c.env, { provider: "pinterest", kind: "verify", user: user.id, estimate: 0, reported: 0, status: "failed", note: errorMessage(e).slice(0, 300) });
    throw e;
  }
});

pinterestRoutes.delete("/", async (c) => {
  const user = requireIntegrationAdmin(c, "pinterest");
  await deleteSetting(c.env, PINTEREST_SETTING);
  await deleteSetting(c.env, PINTEREST_PENDING_SETTING);
  await recordIntegrationOp(c.env, { provider: "pinterest", kind: "disconnect", user: user.id, estimate: 0, reported: 0, status: "done", note: "Pinterest disconnected" });
  return c.json({ ok: true });
});

interface Pending {
  state: string;
  user: string;
  created: number;
  redirect: string;
}

/** The authorize link for a new tab; the app id and secret must be saved first. */
pinterestRoutes.post("/signin/start", async (c) => {
  const user = await gate(c);
  const conn = await readPinterest(c.env);
  if (!conn?.appId || !conn.appSecret) throw new StudioError("Save the app id and app secret first: the sign-in uses them.", 409);
  const state = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, "x");
  const redirect = redirectUri(c.env, c.req.url);
  const pending: Pending = { state, user: user.id, created: Date.now(), redirect };
  await setSetting(c.env, PINTEREST_PENDING_SETTING, JSON.stringify(pending));
  const u = new URL(PINTEREST_AUTHORIZE_URL);
  u.searchParams.set("client_id", conn.appId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", PINTEREST_SCOPES);
  u.searchParams.set("state", state);
  return c.json({ ok: true, url: u.toString(), redirectUri: redirect });
});

const back = (r: { ok: true } | { ok: false; reason: string }) => (r.ok ? "/?pinterest=connected" : `/?pinterest=error&reason=${encodeURIComponent(r.reason.slice(0, 300))}`);

/** Pinterest's redirect after the sign-in: the code is exchanged for both tokens, kept, and the browser goes back to the studio. */
pinterestRoutes.get("/callback", async (c) => {
  const user = c.get("user");
  const q = c.req.query();
  const raw = await getSetting(c.env, PINTEREST_PENDING_SETTING);
  const pending = raw ? (JSON.parse(raw) as Pending) : null;
  if (!user || user.role !== "admin") return c.redirect(back({ ok: false, reason: "Only an admin can finish the Pinterest sign-in." }), 302);
  if (q.error) {
    await deleteSetting(c.env, PINTEREST_PENDING_SETTING);
    return c.redirect(back({ ok: false, reason: `Pinterest said: ${q.error}${q.error_description ? ` (${q.error_description})` : ""}` }), 302);
  }
  if (!pending || Date.now() - pending.created > PENDING_TTL_MS) return c.redirect(back({ ok: false, reason: "No sign-in was in progress (or it took more than fifteen minutes): press Sign in with Pinterest again." }), 302);
  if (!q.state || q.state !== pending.state || pending.user !== user.id) return c.redirect(back({ ok: false, reason: "The sign-in did not match the one started here: press Sign in with Pinterest again." }), 302);
  if (!q.code) return c.redirect(back({ ok: false, reason: "Pinterest sent no code back." }), 302);
  await deleteSetting(c.env, PINTEREST_PENDING_SETTING);
  try {
    const conn = await readPinterest(c.env);
    if (!conn?.appId || !conn.appSecret) throw new StudioError("The app id and secret are gone: save them and sign in again.", 409);
    const tokens = await tokenRequest(fetch, conn.appId, conn.appSecret, { grant_type: "authorization_code", code: q.code, redirect_uri: pending.redirect, continuous_refresh: "true" });
    let next = applyTokens({ ...conn, account: null, saved: Date.now() }, tokens);
    await keep(c.env, next);
    const account = await pinterestAccount(c.env).catch(() => null);
    if (account) {
      next = { ...next, account };
      await keep(c.env, next);
    }
    await recordIntegrationOp(c.env, { provider: "pinterest", kind: "connect", user: user.id, estimate: 0, reported: 0, status: "done", note: `signed in with Pinterest${account ? ` as @${account.username}` : ""}${next.refreshToken ? " · renews itself" : " · no refresh token"}` });
    return c.redirect(back({ ok: true }), 302);
  } catch (e) {
    return c.redirect(back({ ok: false, reason: errorMessage(e) }), 302);
  }
});
