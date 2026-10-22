/**
 * One OAuth 2.0 sign-in for every MCP server the studio talks to on a signed-in account
 * (Higgsfield at mcp.higgsfield.ai, Magnific at mcp.magnific.com). Nothing is pasted by anyone:
 *
 *   1. Discovery: the protected-resource metadata of the MCP server names its authorization
 *      server; that server's metadata (`/.well-known/oauth-authorization-server`, else
 *      `/.well-known/openid-configuration`) gives the endpoints. Cached an hour per instance.
 *   2. Dynamic client registration (RFC 7591), once per issuer and redirect; the client id (and
 *      secret, if issued) is kept as an encrypted setting.
 *   3. Authorization code + PKCE (S256) with the redirect `${PUBLIC_BASE_URL}${redirectPath}`,
 *      the scopes the resource demands (plus the optional ones the server lists, offline_access
 *      for a refresh token); the tokens are kept encrypted; the access token is refreshed before
 *      expiry and once on a 401. Without a refresh token the sign-in simply ends at expiry and the
 *      status says until when it lasts.
 *   4. When registration with a redirect is refused, the device flow is the fallback behind the
 *      same button: the user code and the link are shown, the token endpoint is polled.
 *
 * The e-mail shown comes from the `id_token` payload (or `userinfo` when the server has one); it is
 * shown, never trusted for access. Every sign-in and sign-out is a ledger row (`mcp.signin`,
 * `mcp.signout`) under the provider's name. `useFetch` injects fetch so a test never reaches a host.
 */
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { deleteSetting, getSetting, setSetting } from "./settings";
import { recordIntegrationOp, updateIntegrationOp, type IntegrationProvider } from "./integrations";
import type { User } from "@shared/types";

export interface OAuthSignInConfig {
  /** How the provider is named in messages ("Higgsfield", "Magnific"). */
  label: string;
  /** The ledger provider the `mcp.signin` / `mcp.signout` rows go under. */
  ledgerProvider: IntegrationProvider;
  /** The MCP server (the RFC 8707 resource); the protected-resource document may name it too. */
  resource: string;
  protectedResourceUrl: string;
  /** The scopes the resource demands, as its Bearer challenge says. */
  scopes: string;
  /** Scopes asked for only when the authorization server lists them in `scopes_supported` (offline_access for a refresh token). */
  optionalScopes?: string[];
  /** The callback path under PUBLIC_BASE_URL. */
  redirectPath: string;
  /** Settings keys `${prefix}_client`, `${prefix}_tokens`, `${prefix}_pending`. */
  settingsPrefix: string;
  clientName: string;
  /** The query key of the redirect back to the studio (`/?higgsfield=connected`). */
  returnParam: string;
  /** Where the admin signs in, for messages ("Connection → Higgsfield"). */
  signInHint: string;
  /** The 409 when nothing is signed in. */
  notSignedIn: string;
  /** Called when the tokens change hands (sign-in, sign-out, a refresh the server refused): the provider drops what the old token had filled. */
  onReset?: () => void;
}

export interface AuthServer {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
  userinfo_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  grant_types_supported?: string[];
}

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  issuer: string;
  /** Null for a client registered for the device flow only. */
  redirect_uri: string | null;
  registered: number;
}

export interface StoredTokens {
  access: string;
  refresh: string | null;
  /** Epoch ms, null when the server gave no expiry. */
  expiresAt: number | null;
  scope: string | null;
  email: string | null;
  obtained: number;
}

export type DeviceStart = { mode: "device"; userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expires: number; refused: string };
export type SignInStart = { mode: "redirect"; url: string } | DeviceStart;

export interface SignInStatus {
  signedIn: boolean;
  /** True when the access token has expired and no refresh token can renew it: sign in again. */
  expired: boolean;
  email: string | null;
  signedInAt: number | null;
  expiresAt: number | null;
  /** Whether a refresh token exists (the sign-in renews itself) or the sign-in ends at `expiresAt`. */
  refresh: boolean;
  scope: string | null;
  /** A device-flow sign-in in progress (admins only; the fallback when the redirect registration is refused). */
  device: Omit<DeviceStart, "mode"> | null;
}

type Pending = { kind: "code"; state: string; verifier: string; user: string; created: number; opId: string; redirectUri: string } | { kind: "device"; deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expires: number; user: string; created: number; opId: string; refused: string };

const PENDING_TTL_MS = 15 * 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export class RegistrationRefused extends StudioError {
  constructor(label: string, status: number, body: string, withRedirect: boolean) {
    super(`${label} refused to register the studio as an OAuth client${withRedirect ? " with a redirect" : " for the device flow"} (${status}): ${body.slice(0, 300) || "no detail"}.`, 502, false, { refused: body.slice(0, 300), status });
  }
}

export class TokenRefused extends StudioError {
  constructor(
    label: string,
    status: number,
    public readonly oauthError: string,
    description: string,
  ) {
    super(`${label}'s token endpoint refused (${status}): ${oauthError}${description ? ` · ${description}` : ""}.`, 502, false, { oauthError });
  }
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** The e-mail in an id token's payload (not verified: shown, never trusted for access). */
export function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/** An encrypted setting that holds JSON; null when absent or unreadable (a changed SESSION_SECRET, a hand edit). */
export async function readJsonSetting<T>(env: Env, key: string): Promise<T | null> {
  const v = await getSetting(env, key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

const FORM = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };

export class OAuthSignIn {
  private fetchForTests: typeof fetch | null = null;
  private discovered: { at: number; as: AuthServer; resource: string } | null = null;
  readonly keys: { client: string; tokens: string; pending: string };

  constructor(readonly cfg: OAuthSignInConfig) {
    this.keys = { client: `${cfg.settingsPrefix}_client`, tokens: `${cfg.settingsPrefix}_tokens`, pending: `${cfg.settingsPrefix}_pending` };
  }

  /** Tests inject fetch; null restores the real one. */
  useFetch(fn: typeof fetch | null): void {
    this.fetchForTests = fn;
  }
  /** Always a plain call: Workers refuse the global `fetch` invoked as a method of another object. */
  fetcher(): typeof fetch {
    return this.fetchForTests ?? ((input, init) => fetch(input, init));
  }
  /** The metadata is read again on the next call (tests, a sign-out). */
  resetDiscovery(): void {
    this.discovered = null;
  }

  /* ───────────── Discovery ───────────── */

  private async getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
    const r = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    if (!r.ok) throw new StudioError(`${this.cfg.label}'s metadata could not be read (${r.status} at ${url}).`, 502);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new StudioError(`${this.cfg.label}'s metadata at ${url} is not JSON.`, 502);
    }
  }

  /** The authorization server the MCP server names, and its endpoints; read once an hour. */
  async discover(fetchFn: typeof fetch = this.fetcher()): Promise<{ as: AuthServer; resource: string }> {
    if (this.discovered && Date.now() - this.discovered.at < DISCOVERY_TTL_MS) return this.discovered;
    const pr = await this.getJson(fetchFn, this.cfg.protectedResourceUrl);
    const resource = typeof pr.resource === "string" ? pr.resource : this.cfg.resource;
    const servers = Array.isArray(pr.authorization_servers) ? pr.authorization_servers.filter((s): s is string => typeof s === "string") : [];
    if (!servers.length) throw new StudioError(`${this.cfg.label}'s MCP metadata names no authorization server, so the sign-in cannot start.`, 502);
    const base = servers[0].replace(/\/$/, "");
    let as = (await this.getJson(fetchFn, `${base}/.well-known/oauth-authorization-server`).catch(() => null)) as AuthServer | null;
    if (!as?.token_endpoint) as = (await this.getJson(fetchFn, `${base}/.well-known/openid-configuration`)) as unknown as AuthServer;
    if (typeof as?.authorization_endpoint !== "string" || typeof as?.token_endpoint !== "string") throw new StudioError(`${base} publishes no authorization and token endpoints; the sign-in cannot start.`, 502);
    this.discovered = { at: Date.now(), as, resource };
    return this.discovered;
  }

  /** The scopes asked for: what the resource demands, plus the optional ones the server says it supports. */
  scopeFor(as: AuthServer): string {
    const extra = (this.cfg.optionalScopes ?? []).filter((s) => as.scopes_supported?.includes(s) && !this.cfg.scopes.split(" ").includes(s));
    return [this.cfg.scopes, ...extra].join(" ");
  }

  /* ───────────── The registered client and the tokens (encrypted settings) ───────────── */

  storedClient(env: Env): Promise<StoredClient | null> {
    return readJsonSetting<StoredClient>(env, this.keys.client);
  }
  storedTokens(env: Env): Promise<StoredTokens | null> {
    return readJsonSetting<StoredTokens>(env, this.keys.tokens);
  }
  private async readPending(env: Env): Promise<Pending | null> {
    const p = await readJsonSetting<Pending>(env, this.keys.pending);
    return p && Date.now() - p.created < PENDING_TTL_MS ? p : null;
  }

  redirectUri(env: Env): string {
    if (!env.PUBLIC_BASE_URL) throw new StudioError(`Server is missing PUBLIC_BASE_URL (needed for the ${this.cfg.label} sign-in redirect).`, 503);
    return new URL(this.cfg.redirectPath, env.PUBLIC_BASE_URL).toString();
  }

  /** RFC 7591 registration: a public client (PKCE) with the redirect, or a device-flow client without one. */
  private async registerClient(env: Env, fetchFn: typeof fetch, as: AuthServer, redirect: string | null): Promise<StoredClient> {
    if (!as.registration_endpoint) throw new StudioError(`${this.cfg.label}'s authorization server publishes no registration endpoint; the studio cannot register itself as a client.`, 502);
    const body: Record<string, unknown> = {
      client_name: this.cfg.clientName,
      client_uri: env.PUBLIC_BASE_URL,
      token_endpoint_auth_method: "none",
      scope: this.scopeFor(as),
      grant_types: redirect ? ["authorization_code", "refresh_token"] : ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    };
    if (redirect) {
      body.redirect_uris = [redirect];
      body.response_types = ["code"];
      body.application_type = "web";
    }
    const r = await fetchFn(as.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    if (!r.ok) throw new RegistrationRefused(this.cfg.label, r.status, text, !!redirect);
    let d: { client_id?: unknown; client_secret?: unknown };
    try {
      d = JSON.parse(text) as typeof d;
    } catch {
      throw new StudioError(`${this.cfg.label}'s registration answer is not JSON.`, 502);
    }
    if (typeof d.client_id !== "string" || !d.client_id) throw new StudioError(`${this.cfg.label}'s registration answer carries no client id.`, 502);
    const client: StoredClient = { client_id: d.client_id, issuer: as.issuer ?? as.token_endpoint, redirect_uri: redirect, registered: Date.now() };
    if (typeof d.client_secret === "string" && d.client_secret) client.client_secret = d.client_secret;
    await setSetting(env, this.keys.client, JSON.stringify(client));
    return client;
  }

  /** The client registered once for this redirect (and this issuer); registered now when none fits. */
  private async ensureClient(env: Env, fetchFn: typeof fetch, as: AuthServer, redirect: string | null): Promise<StoredClient> {
    const have = await this.storedClient(env);
    if (have && have.issuer === (as.issuer ?? as.token_endpoint) && have.redirect_uri === redirect) return have;
    return this.registerClient(env, fetchFn, as, redirect);
  }

  /* ───────────── Tokens ───────────── */

  /** The signed-in account's e-mail from `userinfo`, when the id token carried none; a failure is just no e-mail. */
  private async userinfoEmail(fetchFn: typeof fetch, as: AuthServer, access: string): Promise<string | null> {
    if (!as.userinfo_endpoint) return null;
    try {
      const r = await fetchFn(as.userinfo_endpoint, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return null;
      const d = (await r.json()) as { email?: unknown };
      return typeof d.email === "string" ? d.email : null;
    } catch {
      return null;
    }
  }

  /** One request to the token endpoint (code exchange, refresh, device poll), form-encoded as RFC 6749 says. */
  private async tokenRequest(fetchFn: typeof fetch, as: AuthServer, client: StoredClient, params: Record<string, string>, previous: StoredTokens | null): Promise<StoredTokens> {
    const body = new URLSearchParams({ ...params, client_id: client.client_id });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    const r = await fetchFn(as.token_endpoint, { method: "POST", headers: FORM, body: body.toString(), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new TokenRefused(this.cfg.label, r.status, typeof d.error === "string" ? d.error : text.slice(0, 120) || r.statusText, typeof d.error_description === "string" ? d.error_description : "");
    if (typeof d.access_token !== "string" || !d.access_token) throw new StudioError(`${this.cfg.label}'s token answer carries no access token.`, 502);
    const expiresIn = Number(d.expires_in);
    const email = emailOf(d.id_token) ?? previous?.email ?? (await this.userinfoEmail(fetchFn, as, d.access_token));
    return {
      access: d.access_token,
      refresh: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : (previous?.refresh ?? null),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      scope: typeof d.scope === "string" ? d.scope : (previous?.scope ?? null),
      email,
      obtained: Date.now(),
    };
  }

  private expiredError(detail?: string): StudioError {
    return new StudioError(`${this.cfg.label} sign-in expired: sign in again under ${this.cfg.signInHint}.`, 409, false, { notSignedIn: true, expired: true, ...(detail ? { refused: detail } : {}) });
  }

  private async dropTokens(env: Env): Promise<void> {
    await deleteSetting(env, this.keys.tokens);
    this.cfg.onReset?.();
  }

  /**
   * A usable access token: the stored one while it has a minute left, else refreshed with the
   * refresh token (and stored). `force` refreshes now (after a 401). Without a refresh token the
   * sign-in ends when the access token does. An `invalid_grant` means the sign-in is over: the
   * tokens are dropped and the admin is asked to sign in again.
   */
  async accessToken(env: Env, force = false): Promise<string> {
    const t = await this.storedTokens(env);
    if (!t) throw new StudioError(this.cfg.notSignedIn, 409, false, { notSignedIn: true });
    const due = t.expiresAt !== null && t.expiresAt - 60_000 <= Date.now();
    if (!force && !due) return t.access;
    if (!t.refresh) {
      if (force || (t.expiresAt !== null && t.expiresAt <= Date.now())) {
        await this.dropTokens(env);
        throw this.expiredError();
      }
      return t.access;
    }
    const fetchFn = this.fetcher();
    const { as, resource } = await this.discover(fetchFn);
    const client = await this.storedClient(env);
    if (!client) throw this.expiredError();
    try {
      const next = await this.tokenRequest(fetchFn, as, client, { grant_type: "refresh_token", refresh_token: t.refresh, resource }, t);
      await setSetting(env, this.keys.tokens, JSON.stringify(next));
      return next.access;
    } catch (e) {
      if (e instanceof TokenRefused && /^(invalid_grant|invalid_token|unauthorized_client)$/.test(e.oauthError)) {
        await this.dropTokens(env);
        throw this.expiredError(e.message);
      }
      throw e;
    }
  }

  /** Signed in with a token that can still be used (or renewed). */
  async isSignedIn(env: Env): Promise<boolean> {
    const t = await this.storedTokens(env);
    return !!t && (!!t.refresh || t.expiresAt === null || t.expiresAt > Date.now());
  }

  /* ───────────── The flows ───────────── */

  async status(env: Env, user: User | undefined): Promise<SignInStatus> {
    const t = await this.storedTokens(env);
    const expired = !!t && !t.refresh && t.expiresAt !== null && t.expiresAt <= Date.now();
    const pending = user?.role === "admin" ? await this.readPending(env) : null;
    return {
      signedIn: !!t && !expired,
      expired,
      email: t?.email ?? null,
      signedInAt: t?.obtained ?? null,
      expiresAt: t?.expiresAt ?? null,
      refresh: !!t?.refresh,
      scope: t?.scope ?? null,
      device: pending?.kind === "device" ? { userCode: pending.userCode, verificationUri: pending.verificationUri, verificationUriComplete: pending.verificationUriComplete, interval: pending.interval, expires: pending.expires, refused: pending.refused } : null,
    };
  }

  /**
   * Starts the sign-in: the client is registered once, PKCE state and verifier are kept short-lived,
   * the authorize link comes back for a new tab. When registration with a redirect is refused, the
   * device flow is tried and its user code comes back instead, with what was refused.
   */
  async start(env: Env, user: User, opts: { fresh?: boolean } = {}): Promise<SignInStart> {
    const fetchFn = this.fetcher();
    const { as, resource } = await this.discover(fetchFn);
    const redirect = this.redirectUri(env);
    const scope = this.scopeFor(as);
    const opId = await recordIntegrationOp(env, { provider: this.cfg.ledgerProvider, kind: "mcp.signin", user: user.id, estimate: 0, reported: 0, status: "running", note: `sign-in started at ${as.issuer ?? as.authorization_endpoint}` });
    let refusal: RegistrationRefused;
    try {
      const client = await this.ensureClient(env, fetchFn, as, redirect);
      const { verifier, challenge } = await pkcePair();
      const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const pending: Pending = { kind: "code", state, verifier, user: user.id, created: Date.now(), opId, redirectUri: redirect };
      await setSetting(env, this.keys.pending, JSON.stringify(pending));
      const u = new URL(as.authorization_endpoint);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", client.client_id);
      u.searchParams.set("redirect_uri", redirect);
      u.searchParams.set("scope", scope);
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      u.searchParams.set("resource", resource);
      if (opts.fresh) {
        // "Use a different account": the provider must show its sign-in screen instead of reusing the
        // browser's current session (OpenID Connect `prompt=login`; `max_age=0` for servers that honour that one).
        u.searchParams.set("prompt", "login");
        u.searchParams.set("max_age", "0");
      }
      return { mode: "redirect", url: u.toString() };
    } catch (e) {
      if (!(e instanceof RegistrationRefused)) {
        await updateIntegrationOp(env, opId, { status: "failed", note: errorMessage(e) });
        throw e;
      }
      refusal = e;
    }
    // The fallback: the device flow, when the authorization server offers one.
    if (!as.device_authorization_endpoint) {
      await updateIntegrationOp(env, opId, { status: "failed", note: refusal.message });
      throw new StudioError(`${refusal.message} The authorization server lists no device flow either, so the studio cannot sign in by itself.`, 502, false, { refused: refusal.data?.refused });
    }
    let client: StoredClient;
    try {
      client = await this.ensureClient(env, fetchFn, as, null);
    } catch (e) {
      await updateIntegrationOp(env, opId, { status: "failed", note: `${refusal.message} ${errorMessage(e)}` });
      throw new StudioError(`${refusal.message} ${errorMessage(e)}`, 502, false, { refused: refusal.data?.refused, deviceRefused: e instanceof StudioError ? e.data?.refused : errorMessage(e) });
    }
    const body = new URLSearchParams({ client_id: client.client_id, scope, resource });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    const r = await fetchFn(as.device_authorization_endpoint, { method: "POST", headers: FORM, body: body.toString(), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    if (!r.ok) {
      await updateIntegrationOp(env, opId, { status: "failed", note: `${refusal.message} device flow refused (${r.status}): ${text.slice(0, 200)}` });
      throw new StudioError(`${refusal.message} The device flow was refused too (${r.status}): ${text.slice(0, 200)}.`, 502, false, { refused: refusal.data?.refused });
    }
    const d = JSON.parse(text) as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
    if (!d.device_code || !d.user_code || !d.verification_uri) throw new StudioError(`${this.cfg.label}'s device-flow answer is missing the code or the link.`, 502);
    const pending: Pending = { kind: "device", deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri, verificationUriComplete: d.verification_uri_complete ?? null, interval: Math.max(5, Number(d.interval) || 5), expires: Date.now() + (Number(d.expires_in) || 600) * 1000, user: user.id, created: Date.now(), opId, refused: refusal.message };
    await setSetting(env, this.keys.pending, JSON.stringify(pending));
    return { mode: "device", userCode: pending.userCode, verificationUri: pending.verificationUri, verificationUriComplete: pending.verificationUriComplete, interval: pending.interval, expires: pending.expires, refused: refusal.message };
  }

  /** The device flow's poll: one token request per call; the page calls it every `interval` seconds. */
  async poll(env: Env, user: User): Promise<{ signedIn: true; email: string | null } | { signedIn: false; pending: true; interval: number }> {
    const pending = await this.readPending(env);
    if (!pending || pending.kind !== "device") throw new StudioError(`No device sign-in is in progress: press Sign in to ${this.cfg.label} again.`, 409);
    if (pending.user !== user.id) throw new StudioError("Another admin started this sign-in.", 403);
    if (Date.now() > pending.expires) {
      await deleteSetting(env, this.keys.pending);
      await updateIntegrationOp(env, pending.opId, { status: "failed", note: "device code expired" });
      throw new StudioError(`The sign-in code expired: press Sign in to ${this.cfg.label} again.`, 410);
    }
    const fetchFn = this.fetcher();
    const { as, resource } = await this.discover(fetchFn);
    const client = await this.storedClient(env);
    if (!client) throw new StudioError(`The registered client is gone: press Sign in to ${this.cfg.label} again.`, 409);
    try {
      const tokens = await this.tokenRequest(fetchFn, as, client, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode, resource }, null);
      await this.keepTokens(env, tokens);
      await updateIntegrationOp(env, pending.opId, { status: "done", note: `signed in (device flow)${tokens.email ? ` as ${tokens.email}` : ""}${tokens.refresh ? "" : " · no refresh token"}` });
      return { signedIn: true, email: tokens.email };
    } catch (e) {
      if (e instanceof TokenRefused && (e.oauthError === "authorization_pending" || e.oauthError === "slow_down")) return { signedIn: false, pending: true, interval: e.oauthError === "slow_down" ? pending.interval + 5 : pending.interval };
      await deleteSetting(env, this.keys.pending);
      await updateIntegrationOp(env, pending.opId, { status: "failed", note: errorMessage(e) });
      throw e;
    }
  }

  private async keepTokens(env: Env, tokens: StoredTokens): Promise<void> {
    await setSetting(env, this.keys.tokens, JSON.stringify(tokens));
    await deleteSetting(env, this.keys.pending);
    this.cfg.onReset?.();
  }

  /**
   * Where the browser lands after the provider: the code is exchanged, the tokens kept. The
   * answer says where to send the browser (`returnPath`).
   */
  async callback(env: Env, user: User | undefined, q: Record<string, string | undefined>): Promise<{ ok: true; email: string | null } | { ok: false; reason: string }> {
    const label = this.cfg.label;
    const pending = await this.readPending(env);
    if (!user || user.role !== "admin") return { ok: false, reason: `Only an admin can finish the ${label} sign-in.` };
    if (q.error) {
      if (pending) {
        await deleteSetting(env, this.keys.pending);
        await updateIntegrationOp(env, pending.opId, { status: "failed", note: `${q.error}${q.error_description ? `: ${q.error_description}` : ""}` });
      }
      return { ok: false, reason: `${label} said: ${q.error}${q.error_description ? ` (${q.error_description})` : ""}` };
    }
    if (!pending || pending.kind !== "code") return { ok: false, reason: `No sign-in was in progress (or it took more than fifteen minutes): press Sign in to ${label} again.` };
    if (!q.state || q.state !== pending.state) return { ok: false, reason: `The sign-in did not match the one started here: press Sign in to ${label} again.` };
    if (pending.user !== user.id) return { ok: false, reason: "Another admin started this sign-in; finish it from their session or start again." };
    if (!q.code) return { ok: false, reason: `${label} sent no code back.` };
    const fetchFn = this.fetcher();
    try {
      const { as, resource } = await this.discover(fetchFn);
      // RFC 9207: a server that names itself in the answer must be the one the sign-in started at.
      if (q.iss && as.issuer && q.iss !== as.issuer) throw new StudioError(`The answer came from ${q.iss}, not from ${as.issuer}: press Sign in to ${label} again.`, 502);
      const client = await this.storedClient(env);
      if (!client) throw new StudioError(`The registered client is gone: press Sign in to ${label} again.`, 409);
      const tokens = await this.tokenRequest(fetchFn, as, client, { grant_type: "authorization_code", code: q.code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, resource }, null);
      await this.keepTokens(env, tokens);
      await updateIntegrationOp(env, pending.opId, { status: "done", note: `signed in (authorization code + PKCE)${tokens.email ? ` as ${tokens.email}` : ""}${tokens.refresh ? "" : " · no refresh token"}` });
      return { ok: true, email: tokens.email };
    } catch (e) {
      await deleteSetting(env, this.keys.pending);
      await updateIntegrationOp(env, pending.opId, { status: "failed", note: errorMessage(e) });
      return { ok: false, reason: errorMessage(e) };
    }
  }

  /** `/?higgsfield=connected` or `/?higgsfield=error&reason=…`, for the 302 after the callback. */
  returnPath(result: { ok: true } | { ok: false; reason: string }): string {
    return result.ok ? `/?${this.cfg.returnParam}=connected` : `/?${this.cfg.returnParam}=error&reason=${encodeURIComponent(result.reason.slice(0, 300))}`;
  }

  /** The tokens are dropped (the registered client stays); `also` names the provider's own settings to drop; a ledger row says who. */
  async signOut(env: Env, user: User, also: string[] = []): Promise<void> {
    const tokens = await this.storedTokens(env);
    await deleteSetting(env, this.keys.tokens);
    await deleteSetting(env, this.keys.pending);
    for (const k of also) await deleteSetting(env, k);
    this.resetDiscovery();
    this.cfg.onReset?.();
    await recordIntegrationOp(env, { provider: this.cfg.ledgerProvider, kind: "mcp.signout", user: user.id, estimate: 0, reported: 0, status: "done", note: tokens ? `signed out${tokens.email ? ` (${tokens.email})` : ""}` : "nothing was signed in" });
  }
}
