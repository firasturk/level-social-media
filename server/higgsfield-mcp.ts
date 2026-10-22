/**
 * Higgsfield MCP adapter: videos made on the owner's Higgsfield *subscription credits* through
 * https://mcp.higgsfield.ai/mcp, on the signed-in Higgsfield account, instead of the pay-per-clip
 * Cloud API key (server/higgsfield.ts). docs/higgsfield-mcp.md says what is verified and what is
 * assumed.
 *
 * Sign-in (OAuth 2.0, nothing pasted by anyone):
 *   1. Discovery: the protected-resource metadata of the MCP server names its authorization server
 *      (clerk.higgsfield.ai); that server's metadata gives the endpoints (verified 22 Oct 2026).
 *   2. Dynamic client registration (RFC 7591), once; the client id (and secret, if issued) is kept
 *      as an encrypted setting.
 *   3. Authorization code + PKCE (S256) with the redirect `${PUBLIC_BASE_URL}/api/studio/higgsfield/mcp/callback`,
 *      scopes `openid email offline_access`; the tokens are kept encrypted; the access token is
 *      refreshed before expiry and once on a 401.
 *   4. When registration with a redirect is refused, the device flow is the fallback behind the
 *      same button: the user code and the link are shown, the token endpoint is polled.
 *
 * Videos: `balance` before a run, `media_import_url` of the post's picture (cached an hour per
 * picture key), `generate_video` with `get_cost: true` for the estimate (nothing submitted), then
 * `generate_video_batch` (headless) for the real job, `jobs_wait` from `settlePending`, the mp4
 * into R2 as a version with `provider = 'higgsfield-mcp'`. An `unlim_choice` answer is handed to
 * the admin as a 409 and never answered here. A transport timeout keeps the claim and the row and
 * never resubmits. The same governance as every integration: admins only, the `higgsfield`
 * switch, one ledger row per operation (in credits, said so in the note), confirm before spend.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { first, now, run, uuid } from "./db";
import { deleteSetting, getSetting, setSetting, resolveEngineKey, HIGGSFIELD_BILLING_SETTING, HIGGSFIELD_MCP_CLIENT_SETTING, HIGGSFIELD_MCP_MODELS_SETTING, HIGGSFIELD_MCP_PENDING_SETTING, HIGGSFIELD_MCP_TOKENS_SETTING } from "./settings";
import { CLOUD_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { signObjectUrl } from "./signed";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { McpClient, findNumber, findString, findValue, firstUrl, jsonOf, objectsWith, resultText, type McpCallResult } from "./mcp-client";
import { dataUrlBytes, GIVE_UP_MS, parseSettings, postRows, registerPendingSettler, sha256, storeFinishedClip, versionNumbers, videoItem, type VideoItem, type VideoRow, type VideoStatus } from "./video";
import type { User } from "@shared/types";

export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
export const HIGGSFIELD_RESOURCE_METADATA = "https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp";
export const MCP_SCOPES = "openid email offline_access";
/** The `videos.provider` value of a clip made on the subscription credits. */
export const MCP_PROVIDER = "higgsfield-mcp";
export const NOT_SIGNED_IN = "Not signed in: Connection → Higgsfield → Sign in to Higgsfield. Videos on the subscription credits run on that sign-in.";
export const CALLBACK_PATH = "/api/studio/higgsfield/mcp/callback";
/** The tools the adapter calls, by the names the live server lists (docs/higgsfield-mcp.md). */
export const REQUIRED_TOOLS = ["balance", "models_explore", "media_import_url", "generate_video", "generate_video_batch", "jobs_wait"] as const;
/** The same clip (post, engine, idea, settings, source, picture) is not submitted twice within this window. */
const CLAIM_TTL_MS = 10 * 60 * 1000;
const BALANCE_TTL_MS = 60_000;
const MEDIA_TTL_MS = 60 * 60 * 1000;
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
const TOOLS_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const POLL_LIMIT = 6;

/* ───────────── Fetch injection and caches ───────────── */

let fetchForTests: typeof fetch | null = null;
export function useHiggsfieldMcpFetch(fn: typeof fetch | null): void {
  fetchForTests = fn;
}
const fetcher = (): typeof fetch => fetchForTests ?? ((input, init) => fetch(input, init));

let discovered: { at: number; as: AuthServer; resource: string } | null = null;
let toolsCache: { at: number; names: string[] } | null = null;
let balanceCache: { at: number; credits: number | null; plan: string | null } | null = null;
const mediaCache = new Map<string, { id: string; at: number }>();
let modelsMemo: { at: number; models: McpVideoModel[] } | null = null;

/** Tests start from nothing; a sign-out drops everything the token had filled. */
export function resetHiggsfieldMcpCaches(): void {
  discovered = null;
  toolsCache = null;
  balanceCache = null;
  mediaCache.clear();
  modelsMemo = null;
}

/* ───────────── Discovery: the metadata documents ───────────── */

export interface AuthServer {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  grant_types_supported?: string[];
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const r = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new StudioError(`Higgsfield's metadata could not be read (${r.status} at ${url}).`, 502);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StudioError(`Higgsfield's metadata at ${url} is not JSON.`, 502);
  }
}

/** The authorization server the MCP server names, and its endpoints; read once an hour. */
export async function discover(fetchFn: typeof fetch = fetcher()): Promise<{ as: AuthServer; resource: string }> {
  if (discovered && Date.now() - discovered.at < 60 * 60 * 1000) return discovered;
  const pr = await getJson(fetchFn, HIGGSFIELD_RESOURCE_METADATA);
  const resource = typeof pr.resource === "string" ? pr.resource : HIGGSFIELD_MCP_URL;
  const servers = Array.isArray(pr.authorization_servers) ? pr.authorization_servers.filter((s): s is string => typeof s === "string") : [];
  if (!servers.length) throw new StudioError("Higgsfield's MCP metadata names no authorization server, so the sign-in cannot start (see docs/higgsfield-mcp.md).", 502);
  const base = servers[0].replace(/\/$/, "");
  let as = (await getJson(fetchFn, `${base}/.well-known/oauth-authorization-server`).catch(() => null)) as AuthServer | null;
  if (!as?.token_endpoint) as = (await getJson(fetchFn, `${base}/.well-known/openid-configuration`)) as unknown as AuthServer;
  if (typeof as?.authorization_endpoint !== "string" || typeof as?.token_endpoint !== "string") throw new StudioError(`${base} publishes no authorization and token endpoints; the sign-in cannot start.`, 502);
  discovered = { at: Date.now(), as, resource };
  return discovered;
}

/* ───────────── The registered client and the tokens (encrypted settings) ───────────── */

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

type Pending = { kind: "code"; state: string; verifier: string; user: string; created: number; opId: string; redirectUri: string } | { kind: "device"; deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expires: number; user: string; created: number; opId: string; refused: string };

async function readJsonSetting<T>(env: Env, key: string): Promise<T | null> {
  const v = await getSetting(env, key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}
const storedClient = (env: Env) => readJsonSetting<StoredClient>(env, HIGGSFIELD_MCP_CLIENT_SETTING);
export const storedTokens = (env: Env) => readJsonSetting<StoredTokens>(env, HIGGSFIELD_MCP_TOKENS_SETTING);
const readPending = async (env: Env): Promise<Pending | null> => {
  const p = await readJsonSetting<Pending>(env, HIGGSFIELD_MCP_PENDING_SETTING);
  return p && Date.now() - p.created < PENDING_TTL_MS ? p : null;
};

function redirectUri(env: Env): string {
  if (!env.PUBLIC_BASE_URL) throw new StudioError("Server is missing PUBLIC_BASE_URL (needed for the Higgsfield sign-in redirect).", 503);
  return new URL(CALLBACK_PATH, env.PUBLIC_BASE_URL).toString();
}

class RegistrationRefused extends StudioError {
  constructor(status: number, body: string, withRedirect: boolean) {
    super(`Higgsfield refused to register the studio as an OAuth client${withRedirect ? " with a redirect" : " for the device flow"} (${status}): ${body.slice(0, 300) || "no detail"}.`, 502, false, { refused: body.slice(0, 300), status });
  }
}

/** RFC 7591 registration: a public client (PKCE) with the redirect, or a device-flow client without one. */
async function registerClient(env: Env, fetchFn: typeof fetch, as: AuthServer, redirect: string | null): Promise<StoredClient> {
  if (!as.registration_endpoint) throw new StudioError("Higgsfield's authorization server publishes no registration endpoint; the studio cannot register itself as a client.", 502);
  const body: Record<string, unknown> = {
    client_name: "Level Studio",
    client_uri: env.PUBLIC_BASE_URL,
    token_endpoint_auth_method: "none",
    scope: MCP_SCOPES,
    grant_types: redirect ? ["authorization_code", "refresh_token"] : ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  };
  if (redirect) {
    body.redirect_uris = [redirect];
    body.response_types = ["code"];
    body.application_type = "web";
  }
  const r = await fetchFn(as.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new RegistrationRefused(r.status, text, !!redirect);
  let d: { client_id?: unknown; client_secret?: unknown };
  try {
    d = JSON.parse(text) as typeof d;
  } catch {
    throw new StudioError("Higgsfield's registration answer is not JSON.", 502);
  }
  if (typeof d.client_id !== "string" || !d.client_id) throw new StudioError("Higgsfield's registration answer carries no client id.", 502);
  const client: StoredClient = { client_id: d.client_id, issuer: as.issuer ?? as.token_endpoint, redirect_uri: redirect, registered: Date.now() };
  if (typeof d.client_secret === "string" && d.client_secret) client.client_secret = d.client_secret;
  await setSetting(env, HIGGSFIELD_MCP_CLIENT_SETTING, JSON.stringify(client));
  return client;
}

/** The client registered once for this redirect (and this issuer); registered now when none fits. */
async function ensureClient(env: Env, fetchFn: typeof fetch, as: AuthServer, redirect: string | null): Promise<StoredClient> {
  const have = await storedClient(env);
  if (have && have.issuer === (as.issuer ?? as.token_endpoint) && have.redirect_uri === redirect) return have;
  return registerClient(env, fetchFn, as, redirect);
}

/* ───────────── Tokens ───────────── */

function b64url(bytes: Uint8Array): string {
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
function emailOf(idToken: unknown): string | null {
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

class TokenRefused extends StudioError {
  constructor(
    status: number,
    public readonly oauthError: string,
    description: string,
  ) {
    super(`Higgsfield's token endpoint refused (${status}): ${oauthError}${description ? ` · ${description}` : ""}.`, 502, false, { oauthError });
  }
}

/** One request to the token endpoint (code exchange, refresh, device poll), form-encoded as RFC 6749 says. */
async function tokenRequest(fetchFn: typeof fetch, as: AuthServer, client: StoredClient, params: Record<string, string>, previous: StoredTokens | null): Promise<StoredTokens> {
  const body = new URLSearchParams({ ...params, client_id: client.client_id });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  const r = await fetchFn(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString(), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new TokenRefused(r.status, typeof d.error === "string" ? d.error : text.slice(0, 120) || r.statusText, typeof d.error_description === "string" ? d.error_description : "");
  if (typeof d.access_token !== "string" || !d.access_token) throw new StudioError("Higgsfield's token answer carries no access token.", 502);
  const expiresIn = Number(d.expires_in);
  return {
    access: d.access_token,
    refresh: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : (previous?.refresh ?? null),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    scope: typeof d.scope === "string" ? d.scope : (previous?.scope ?? null),
    email: emailOf(d.id_token) ?? previous?.email ?? null,
    obtained: Date.now(),
  };
}

const SIGN_IN_EXPIRED = "Higgsfield sign-in expired: sign in again under Connection → Higgsfield.";

/**
 * A usable access token: the stored one while it has a minute left, else refreshed with the
 * refresh token (and stored). `force` refreshes now (after a 401). An `invalid_grant` means the
 * sign-in is over: the tokens are dropped and the admin is asked to sign in again.
 */
export async function freshAccessToken(env: Env, fetchFn: typeof fetch, force = false): Promise<string> {
  const t = await storedTokens(env);
  if (!t) throw new StudioError(NOT_SIGNED_IN, 409, false, { notSignedIn: true });
  if (!force && (t.expiresAt === null || t.expiresAt - 60_000 > Date.now())) return t.access;
  if (!t.refresh) {
    if (force) throw new StudioError(SIGN_IN_EXPIRED, 409, false, { notSignedIn: true });
    return t.access;
  }
  const { as, resource } = await discover(fetchFn);
  const client = await storedClient(env);
  if (!client) throw new StudioError(SIGN_IN_EXPIRED, 409, false, { notSignedIn: true });
  try {
    const next = await tokenRequest(fetchFn, as, client, { grant_type: "refresh_token", refresh_token: t.refresh, resource }, t);
    await setSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify(next));
    return next.access;
  } catch (e) {
    if (e instanceof TokenRefused && /^(invalid_grant|invalid_token|unauthorized_client)$/.test(e.oauthError)) {
      await deleteSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING);
      resetHiggsfieldMcpCaches();
      throw new StudioError(SIGN_IN_EXPIRED, 409, false, { notSignedIn: true, refused: e.message });
    }
    throw e;
  }
}

/* ───────────── The MCP session: tools by name, one refresh on 401 ───────────── */

export class HiggsfieldMcp {
  private client: McpClient | null = null;
  private refreshed = false;
  constructor(
    private readonly env: Env,
    private readonly fetchFn: typeof fetch = fetcher(),
  ) {}

  /** Signed in, or a 409 saying so; no call to the MCP server yet. */
  async connect(force = false): Promise<void> {
    const token = await freshAccessToken(this.env, this.fetchFn, force);
    this.client = new McpClient(token, this.fetchFn, HIGGSFIELD_MCP_URL, { label: "Higgsfield MCP", unauthorizedHint: "the sign-in may have expired; sign in again under Connection → Higgsfield." });
  }

  private async withAuth<T>(fn: (c: McpClient) => Promise<T>): Promise<T> {
    if (!this.client) await this.connect();
    try {
      return await fn(this.client!);
    } catch (e) {
      // One token refresh, then the same call once more. This is not a job retry: nothing was submitted.
      if (e instanceof StudioError && e.status === 401 && e.data?.httpStatus === 401 && !this.refreshed) {
        this.refreshed = true;
        await this.connect(true);
        return fn(this.client!);
      }
      throw e;
    }
  }

  /** The tool names the live server lists, cached ten minutes. */
  async toolNames(fresh = false): Promise<string[]> {
    if (!fresh && toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.names;
    const tools = await this.withAuth((c) => c.listTools());
    toolsCache = { at: Date.now(), names: tools.map((t) => t.name) };
    return toolsCache.names;
  }

  async hasTool(name: string): Promise<boolean> {
    return (await this.toolNames()).includes(name);
  }

  async requireTool(name: string): Promise<void> {
    const names = await this.toolNames();
    if (!names.includes(name)) throw new StudioError(`Higgsfield MCP lists no tool named "${name}" (it lists ${names.length}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}). The studio was written for the tool names in docs/higgsfield-mcp.md; nothing was run.`, 502, false, { missingTool: name });
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.requireTool(name);
    return this.withAuth((c) => c.callTool(name, args));
  }
}

/* ───────────── Reading the answers ───────────── */

export interface Balance {
  credits: number | null;
  plan: string | null;
  text: string;
}

export function parseBalance(r: McpCallResult): Balance {
  const j = jsonOf(r);
  const text = resultText(r);
  let credits = findNumber(j, ["credits", "balance", "credits_remaining", "remaining_credits", "available_credits", "available", "total_credits", "amount"]);
  if (credits === null) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*credits?/i.exec(text);
    credits = m ? Number(m[1].replace(/,/g, "")) : null;
  }
  const plan = findString(j, ["plan", "plan_name", "subscription", "tier", "subscription_plan"]) ?? (/plan[:\s]+([A-Za-z][\w+ -]{1,30})/i.exec(text)?.[1]?.trim() ?? null);
  return { credits, plan, text };
}

/** The credits a `get_cost` answer names, or null; a numeric string counts. */
export function parseCost(r: McpCallResult): number | null {
  const j = jsonOf(r);
  const n = findNumber(j, ["cost", "credits", "cost_credits", "credits_cost", "total_cost", "estimated_cost", "estimate", "price", "total"]);
  if (n !== null) return n;
  const m = /(\d+(?:\.\d+)?)\s*credits?/i.exec(resultText(r));
  return m ? Number(m[1]) : null;
}

/** The `unlim_choice` question in an answer (the server asks instead of submitting), as it came; null when none. */
export function unlimChoiceIn(r: McpCallResult): unknown {
  const j = jsonOf(r);
  const direct = findValue(j, ["unlim_choice"], (v): v is unknown => v !== null && v !== undefined && v !== false);
  if (direct !== null) return direct;
  const o = j as Record<string, unknown> | null;
  if (o && typeof o === "object" && !Array.isArray(o) && (o.type === "unlim_choice" || o.question === "unlim_choice" || o.choice === "unlim")) return o;
  const text = resultText(r);
  return /unlim_choice/i.test(text) ? { text: text.slice(0, 500) } : null;
}

/** A media id out of `media_import_url` / `media_confirm`. */
export function parseMediaId(r: McpCallResult): string | null {
  const j = jsonOf(r);
  const id = findString(j, ["media_id", "mediaId"]) ?? findString((j as Record<string, unknown> | null)?.media ?? null, ["id"]) ?? findString(j, ["id"]);
  if (id) return id;
  const m = /media[_ ]id\W+([A-Za-z0-9_-]{6,})/i.exec(resultText(r));
  return m ? m[1] : null;
}

export interface JobEntry {
  index: number | null;
  jobId: string;
  status: string;
  url: string | null;
  error: string | null;
}

const DONE = /^(completed|complete|succeeded|success|successful|done|finished|ready)$/i;
const FAILED = /^(failed|failure|error|errored|cancelled|canceled|nsfw|rejected|moderated|timeout|timed_out)$/i;

/** The jobs an answer (`generate_video_batch`, `jobs_wait`, `show_generation_by_ids`) names, with what each says. */
export function parseJobs(r: McpCallResult): JobEntry[] {
  const j = jsonOf(r);
  const out: JobEntry[] = [];
  for (const o of objectsWith(j, "job_id")) {
    const jobId = String(o.job_id);
    const index = typeof o.index === "number" ? o.index : null;
    const status = String(findString(o, ["status", "state"]) ?? "").toLowerCase();
    const url = firstUrl(findValue(o, ["result", "results", "output", "outputs", "video", "media", "url", "video_url", "result_url", "download_url"], (v): v is unknown => v !== null && v !== undefined) ?? null, "");
    const error = findString(o, ["error", "error_message", "failure_reason", "reason", "message"]);
    if (!out.some((x) => x.jobId === jobId)) out.push({ index, jobId, status, url, error });
  }
  return out;
}

/** True when `jobs_wait` says every job is terminal (or no job is still running). */
export function allTerminal(r: McpCallResult, jobs: JobEntry[]): boolean {
  const j = jsonOf(r) as Record<string, unknown> | null;
  if (j && typeof j === "object" && typeof j.all_terminal === "boolean") return j.all_terminal;
  return jobs.every((x) => DONE.test(x.status) || FAILED.test(x.status));
}

/* ───────────── The engine catalog ───────────── */

export interface McpVideoModel {
  id: string;
  name: string;
  description: string;
  durations: number[];
  aspects: string[];
  supportsUnlim: boolean;
}

const numbersOf = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "number" ? x : typeof x === "string" ? Number(x.replace(/s$/i, "")) : typeof x === "object" && x ? Number((x as Record<string, unknown>).value ?? (x as Record<string, unknown>).seconds) : NaN)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as Record<string, unknown>).value ?? (x as Record<string, unknown>).id ?? "") : "")).filter(Boolean) : []);

/** The image-to-video engines a `models_explore` answer lists; the shape is read defensively. */
export function parseModels(r: McpCallResult): McpVideoModel[] {
  const j = jsonOf(r);
  const out: McpVideoModel[] = [];
  const seen = new Set<string>();
  const candidates = [...objectsWith(j, "model_id"), ...objectsWith(j, "id"), ...objectsWith(j, "model")];
  for (const o of candidates) {
    const id = [o.model_id, o.id, o.model].find((v) => typeof v === "string" && /^[a-z0-9][a-z0-9_.-]{1,60}$/i.test(v)) as string | undefined;
    if (!id || seen.has(id)) continue;
    const type = String(o.type ?? o.kind ?? o.category ?? "").toLowerCase();
    if (type && !/video/.test(type)) continue;
    const name = [o.name, o.title, o.display_name, o.label].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const params = (o.parameters ?? o.params ?? o.options ?? {}) as Record<string, unknown>;
    const durations = numbersOf(o.durations ?? o.duration_options ?? o.durations_supported ?? params.duration ?? (params.durations as unknown) ?? (o.duration as unknown));
    const aspects = stringsOf(o.aspect_ratios ?? o.aspects ?? params.aspect_ratio ?? (params.aspect_ratios as unknown));
    const describable = name || durations.length || aspects.length || typeof o.description === "string" || type;
    if (!describable) continue;
    seen.add(id);
    out.push({
      id,
      name: (name ?? id).slice(0, 80),
      description: typeof o.description === "string" ? o.description.slice(0, 300) : "",
      durations,
      aspects,
      supportsUnlim: o.supports_unlim === true || o.unlim === true || o.supports_unlimited === true,
    });
  }
  return out;
}

/** The catalog: the stored copy for a day, else `models_explore` (type video, image input); `refresh` asks again. */
export async function mcpModels(env: Env, mcp: HiggsfieldMcp, refresh = false): Promise<{ models: McpVideoModel[]; at: number }> {
  if (!refresh && modelsMemo && Date.now() - modelsMemo.at < MODELS_TTL_MS) return modelsMemo;
  if (!refresh) {
    const stored = await readJsonSetting<{ at: number; models: McpVideoModel[] }>(env, HIGGSFIELD_MCP_MODELS_SETTING);
    if (stored && Array.isArray(stored.models) && Date.now() - stored.at < MODELS_TTL_MS) {
      modelsMemo = stored;
      return stored;
    }
  }
  const r = await mcp.call("models_explore", { action: "list", type: "video", input: "image", limit: 60 });
  const models = parseModels(r);
  if (!models.length) throw new StudioError(`Higgsfield listed no image-to-video engine the studio could read. Answer: ${resultText(r).slice(0, 200)}`, 502);
  modelsMemo = { at: Date.now(), models };
  await setSetting(env, HIGGSFIELD_MCP_MODELS_SETTING, JSON.stringify(modelsMemo));
  return modelsMemo;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The subscription engine for a name or id the Prompt Box gives (a Cloud API slug such as
 * `bytedance/seedance-2.5/image-to-video`, a catalog name such as "Seedance 2.5", or an MCP id).
 */
export function matchMcpModel(models: McpVideoModel[], wanted: string): McpVideoModel | null {
  const w = squash(wanted);
  const exact = models.find((m) => m.id === wanted || squash(m.id) === w || squash(m.name) === w);
  if (exact) return exact;
  const tail = squash(wanted.replace(/\/(image|text)-to-video.*$/i, "").split("/").pop() ?? "");
  return models.find((m) => tail && (squash(m.id) === tail || squash(m.name) === tail || squash(m.name).includes(tail) || squash(m.id).includes(tail))) ?? models.find((m) => w.includes(squash(m.name)) || w.includes(squash(m.id))) ?? null;
}

/* ───────────── Balance and media ───────────── */

export async function balanceOf(mcp: HiggsfieldMcp, fresh = false): Promise<Balance> {
  if (!fresh && balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return { ...balanceCache, text: "" };
  const b = parseBalance(await mcp.call("balance", {}));
  balanceCache = { at: Date.now(), credits: b.credits, plan: b.plan };
  return b;
}

/** The post's picture (or artwork) as a Higgsfield media id, imported through a short-lived signed link, once an hour per key. */
export async function mediaFor(env: Env, mcp: HiggsfieldMcp, key: string): Promise<string> {
  const hit = mediaCache.get(key);
  if (hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.id;
  const url = await signObjectUrl(env, key, 2 * 60 * 60 * 1000);
  const r = await mcp.call("media_import_url", { url, type: "image" });
  const id = r.isError ? null : parseMediaId(r);
  if (!id) throw new StudioError(`Higgsfield could not import the picture: ${resultText(r).slice(0, 200) || "no media id in the answer"}.`, 502);
  mediaCache.set(key, { id, at: Date.now() });
  return id;
}

/* ───────────── Estimate and generate ───────────── */

const askSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(200),
  model: z.string().min(1).max(80),
  prompt: z.string().trim().max(5000).default(""),
  duration: z.number().int().min(1).max(60).optional(),
  aspect: z.string().max(10).optional(),
  source: z.enum(["picture", "artwork"]).default("picture"),
  /** The composed post (words and logo drawn by the browser) as a data URL, when source is "artwork". */
  artwork: z.string().max(17 * 1024 * 1024).optional(),
  useUnlim: z.boolean().optional(),
});
const generateSchema = askSchema.extend({ confirm: z.boolean().optional(), note: z.string().trim().max(200).optional() });
export type McpAsk = z.infer<typeof askSchema>;
export type McpGenerateInput = z.infer<typeof generateSchema>;

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** The still the clip starts from: the task's picture, or the artwork stored under a key made from its bytes (so an estimate and its run share one import). */
async function posterFor(env: Env, b: { id: string; owner: string }, t: { id: string; output: string }, d: McpAsk): Promise<string> {
  if (d.source !== "artwork") return t.output;
  if (!d.artwork) throw new StudioError("Send the artwork (the post with its words and logo) to make the clip from it.");
  const art = dataUrlBytes(d.artwork);
  const key = `${b.owner}/${b.id}/video/${t.id}/${(await sha256(d.artwork)).slice(0, 24)}.artwork.${art.mime === "image/png" ? "png" : art.mime === "image/webp" ? "webp" : "jpg"}`;
  if (!(await env.BUCKET.head(key))) await env.BUCKET.put(key, art.bytes, { httpMetadata: { contentType: art.mime } });
  return key;
}

/** The engine's catalog entry, with the asked settings checked against what it offers. */
async function engineFor(env: Env, mcp: HiggsfieldMcp, d: McpAsk): Promise<{ engine: McpVideoModel; duration: number | undefined; aspect: string | undefined }> {
  const { models } = await mcpModels(env, mcp);
  const engine = models.find((m) => m.id === d.model) ?? matchMcpModel(models, d.model);
  if (!engine) throw new StudioError(`"${d.model}" is not on the Higgsfield subscription catalog. Pick an engine from the list (refresh it under the Video dialog if it looks stale).`, 400, false, { unknownEngine: d.model });
  const duration = d.duration;
  if (duration !== undefined && engine.durations.length && !engine.durations.includes(duration)) throw new StudioError(`${engine.name} makes clips of ${engine.durations.join(", ")} seconds.`);
  const aspect = d.aspect || undefined;
  if (aspect && engine.aspects.length && !engine.aspects.includes(aspect)) throw new StudioError(`${engine.name} offers these frames: ${engine.aspects.join(", ")}.`);
  return { engine, duration, aspect };
}

function videoParams(engine: McpVideoModel, d: McpAsk, mediaId: string, duration: number | undefined, aspect: string | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = { model: engine.id, medias: [{ value: mediaId, role: "image" }], count: 1 };
  if (d.prompt.trim()) params.prompt = d.prompt.trim();
  if (duration !== undefined) params.duration = duration;
  if (aspect) params.aspect_ratio = aspect;
  if (d.useUnlim !== undefined) params.use_unlim = d.useUnlim;
  return params;
}

export interface McpEstimate {
  credits: number | null;
  balance: number | null;
  plan: string | null;
  unlimChoice: unknown;
  engine: McpVideoModel;
  mediaId: string;
  params: Record<string, unknown>;
  text: string;
}

/** The cost in credits of exactly this clip (`get_cost: true` submits nothing), with the balance. */
export async function estimateMcpVideo(env: Env, user: User, d: McpAsk, record = true): Promise<McpEstimate> {
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const mcp = new HiggsfieldMcp(env, fetcher());
  await mcp.connect();
  const { engine, duration, aspect } = await engineFor(env, mcp, d);
  const posterKey = await posterFor(env, b, { id: t.id, output: t.output }, d);
  const mediaId = await mediaFor(env, mcp, posterKey);
  const params = videoParams(engine, d, mediaId, duration, aspect);
  const r = await mcp.call("generate_video", { params: { ...params, get_cost: true } });
  const unlimChoice = unlimChoiceIn(r);
  const credits = r.isError ? null : parseCost(r);
  const bal = await balanceOf(mcp, !record).catch(() => ({ credits: null, plan: null, text: "" }));
  if (record)
    await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "mcp.estimate",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: credits,
    reported: 0,
    status: credits === null && !unlimChoice ? "refused" : "done",
    note: `${credits ?? "?"} credits · ${engine.name} · ${duration ?? "default"}s · ${d.source}${unlimChoice ? " · unlimited-allowance question" : ""}${credits === null ? ` · answer: ${resultText(r).slice(0, 200)}` : ""}`,
  });
  return { credits, balance: bal.credits, plan: bal.plan, unlimChoice, engine, mediaId, params, text: resultText(r) };
}

const isTimeout = (e: unknown) => e instanceof Error && (/TimeoutError|AbortError/.test(e.name) || /timed? ?out/i.test(e.message));

/**
 * One clip on the subscription credits: the estimate is asked with `get_cost` (an unlimited-
 * allowance question goes back to the admin), the person confirms the credits shown, the same ask
 * within ten minutes is refused, the op is recorded, the job goes out as a one-item batch. Nothing
 * retries by itself: a timeout keeps the row and the claim and says the outcome is unknown.
 */
export async function submitMcpVideo(env: Env, user: User, d: McpGenerateInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  if ((await higgsfieldBilling(env)) !== "credits") throw new StudioError(CLOUD_CHOSEN, 409, false, { billing: "cloud" });
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  // The estimate is asked again with the same body the job gets (the balance fresh, for the reported cost); the run's own row is the `video` op below.
  const est = await estimateMcpVideo(env, user, d, false);
  const { engine, params } = est;
  if (est.unlimChoice && d.useUnlim === undefined) throw new StudioError(`Higgsfield asks whether this ${engine.name} clip should use the unlimited allowance or pay credits${est.credits !== null ? ` (${est.credits})` : ""}. Choose, then run again.`, 409, false, { unlimChoice: est.unlimChoice, credits: est.credits });
  if (est.credits === null && !d.confirm) throw new StudioError(`The cost of a ${engine.name} clip is not known: Higgsfield gave no figure. Confirm it at an unknown cost, or pick another engine.`, 409, false, { needsEstimate: true, model: engine.id });
  if (!d.confirm) throw new StudioError(`Confirm the clip: about ${est.credits} credits from the subscription balance${est.balance !== null ? ` (${est.balance} available)` : ""}.`, 409, false, { needsConfirm: true, credits: est.credits, balance: est.balance });
  const posterKey = await posterFor(env, b, { id: t.id, output: t.output }, d);
  const duration = typeof params.duration === "number" ? params.duration : undefined;
  const aspect = typeof params.aspect_ratio === "string" ? params.aspect_ratio : undefined;
  const mcp = new HiggsfieldMcp(env, fetcher());
  // The submission tool must exist before anything is claimed or recorded: a missing name is a clear refusal, not a failed version.
  await mcp.requireTool("generate_video_batch");
  const fingerprint = await sha256([MCP_PROVIDER, engine.id, d.prompt.trim(), duration ?? "", aspect ?? "", d.source, posterKey, String(d.useUnlim ?? "")].join("\n"));
  if (!(await claimSubmission(env, `video:${b.id}:${d.index}:${fingerprint}`, CLAIM_TTL_MS))) throw new StudioError("This exact clip was asked for a moment ago. Wait for it, or change the idea or the settings.", 409);
  const before = est.balance;
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "video",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: est.credits,
    status: "confirmed",
    note: `${engine.name} · ${duration ?? "default"}s · ${d.source} · ${est.credits ?? "unknown"} credits (subscription, MCP)${d.useUnlim ? " · unlimited allowance" : ""}${before !== null ? ` · balance before ${before}` : ""}${d.note ? ` · ${d.note}` : ""}`,
  });
  const id = uuid();
  const stored = { duration, aspect, estimate: est.credits, credits: est.credits, estimateSource: est.credits === null ? "confirmed" : "provider", unit: "credits", mcpModel: engine.id, engineName: engine.name, useUnlim: d.useUnlim ?? null, balanceBefore: before, plan: est.plan, note: d.note, outcomeUnknown: false };
  const ts = now();
  const insert = (status: VideoStatus, requestId: string | null, error: string | null, extra: Record<string, unknown> = {}) =>
    run(
      env.DB,
      "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      id,
      b.id,
      d.index,
      t.id,
      user.id,
      engine.id,
      d.prompt.trim(),
      status,
      requestId,
      error,
      ts,
      ts,
      MCP_PROVIDER,
      JSON.stringify({ ...stored, ...extra }),
      posterKey,
      d.source,
      opId,
    );
  let r: McpCallResult;
  try {
    r = await mcp.call("generate_video_batch", { requests: [{ index: 0, params }] });
  } catch (e) {
    if (isTimeout(e)) {
      const note = "Higgsfield did not answer in time: the clip may still have started, so nothing was sent again. The version stays queued and is given up after half an hour if no job id can be learned; check the balance and the Higgsfield history.";
      await insert("queued", null, null, { outcomeUnknown: true });
      await updateIntegrationOp(env, opId, { status: "running", note: `outcome unknown (timeout) · ${note}` });
      throw new StudioError(note, 504, false, { outcomeUnknown: true, videoId: id });
    }
    const message = errorMessage(e).slice(0, 400);
    await insert("failed", null, message);
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  const unlim = unlimChoiceIn(r);
  if (unlim && d.useUnlim === undefined) {
    await updateIntegrationOp(env, opId, { status: "proposed", note: "waiting for the unlimited-allowance choice; nothing submitted" });
    throw new StudioError(`Higgsfield asks whether this ${engine.name} clip should use the unlimited allowance or pay credits. Choose, then run again.`, 409, false, { unlimChoice: unlim, credits: est.credits });
  }
  const job = parseJobs(r).find((x) => x.index === 0 || x.index === null);
  if (r.isError || !job) {
    const message = `Higgsfield did not start the clip: ${resultText(r).slice(0, 300) || "no job id in the answer"}`;
    await insert("failed", null, message);
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insert("queued", job.jobId, null);
  await updateIntegrationOp(env, opId, { taskId: job.jobId, status: "running" });
  const rows = await postRows(env, b.id, d.index);
  const row = rows.find((v) => v.id === id)!;
  return videoItem(row, versionNumbers(rows).get(id) ?? rows.length);
}

/* ───────────── Polling, from settlePending ───────────── */

/**
 * The in-flight subscription clips asked about with one `jobs_wait` (a short wait), six at most:
 * a finished one is fetched into R2 and marked done with the credits the balance moved by, a
 * failed one keeps the message, one with no job id (a timed-out submission) or older than half an
 * hour is given up. Nothing is submitted again here.
 */
export async function settleMcpPending(env: Env, b: { id: string; owner: string }, rows: VideoRow[]): Promise<void> {
  const pending = rows.filter((v) => (v.status === "queued" || v.status === "generating") && v.provider === MCP_PROVIDER).slice(0, POLL_LIMIT);
  if (!pending.length) return;
  const fail = async (v: VideoRow, message: string) => {
    await run(env.DB, "UPDATE videos SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), v.id);
    v.status = "failed";
    v.error = message;
    if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "failed", note: message });
  };
  const old = (v: VideoRow) => now() - v.created > GIVE_UP_MS;
  const withJob: VideoRow[] = [];
  for (const v of pending) {
    if (v.request_id) withJob.push(v);
    else if (old(v)) await fail(v, "The submission's outcome was never learned (Higgsfield did not answer in time) and nothing was sent again. Check the Higgsfield history and balance.");
  }
  if (!withJob.length) return;
  const mcp = new HiggsfieldMcp(env, fetcher());
  try {
    await mcp.connect();
  } catch {
    for (const v of withJob) if (old(v)) await fail(v, "Higgsfield is not signed in; the clip could not be collected in half an hour.");
    return;
  }
  let answer: McpCallResult;
  try {
    answer = await mcp.call("jobs_wait", { jobs: withJob.map((v, i) => ({ index: i, job_id: v.request_id })), timeout_seconds: 1 });
  } catch (e) {
    console.error("[higgsfield-mcp] jobs_wait", errorMessage(e));
    for (const v of withJob) if (old(v)) await fail(v, "The engine could not be asked for half an hour.");
    return;
  }
  const jobs = parseJobs(answer);
  for (const [i, v] of withJob.entries()) {
    const job = jobs.find((x) => x.jobId === v.request_id) ?? jobs.find((x) => x.index === i);
    try {
      if (!job) {
        if (old(v)) await fail(v, "Higgsfield no longer lists this job.");
        continue;
      }
      if (DONE.test(job.status)) {
        let url = job.url;
        if (!url && (await mcp.hasTool("show_generation_by_ids"))) {
          const shown = await mcp.call("show_generation_by_ids", { jobs: [{ index: 0, job_id: v.request_id }] });
          url = parseJobs(shown).find((x) => x.jobId === v.request_id)?.url ?? firstUrl(jsonOf(shown), resultText(shown));
        }
        if (!url) {
          await fail(v, "The clip finished without a video link.");
          continue;
        }
        await storeFinishedClip(env, b, v, url, fetcher());
        const s = parseSettings(v) as ReturnType<typeof parseSettings> & { balanceBefore?: number | null };
        const after = await balanceOf(mcp, true).catch(() => ({ credits: null as number | null }));
        const reported = typeof s.balanceBefore === "number" && after.credits !== null && after.credits <= s.balanceBefore ? s.balanceBefore - after.credits : (s.estimate ?? null);
        if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "done", reported, note: `${reported ?? "?"} credits reported${typeof s.balanceBefore === "number" && after.credits !== null ? ` (balance ${s.balanceBefore} → ${after.credits})` : " (from the estimate; the balance could not be read)"}` });
      } else if (FAILED.test(job.status)) {
        await fail(v, job.error ? `Generation failed on Higgsfield: ${job.error}` : "Generation failed on Higgsfield.");
      } else if (old(v)) {
        await fail(v, "The engine did not finish in half an hour.");
      } else if (v.status === "queued" && /^(running|processing|in_progress|generating|started)$/.test(job.status)) {
        await run(env.DB, "UPDATE videos SET status = 'generating', updated = ? WHERE id = ?", now(), v.id);
        v.status = "generating";
      }
    } catch (e) {
      console.error("[higgsfield-mcp] settle", v.id, errorMessage(e));
    }
  }
}

registerPendingSettler(MCP_PROVIDER, settleMcpPending);

/* ───────────── Routes: /api/studio/higgsfield/mcp ───────────── */

type Variables = { user: User };
export const higgsfieldMcpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  return u;
}

/** Signed in?, the account, the plan and credits (cached a minute), the billing choice, the switch. Every member. */
higgsfieldMcpRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const tokens = await storedTokens(c.env);
  const access = await integrationAccess(c.env, user, "higgsfield");
  const billingSet = await getSetting(c.env, HIGGSFIELD_BILLING_SETTING);
  let credits: number | null = null;
  let plan: string | null = null;
  let balanceError = "";
  if (tokens && access.enabled) {
    try {
      const mcp = new HiggsfieldMcp(c.env, fetcher());
      const bal = await balanceOf(mcp, c.req.query("fresh") === "1");
      credits = bal.credits;
      plan = bal.plan;
    } catch (e) {
      balanceError = errorMessage(e);
    }
  }
  const pending = user.role === "admin" ? await readPending(c.env) : null;
  return c.json({
    signedIn: !!tokens,
    email: tokens?.email ?? null,
    signedInAt: tokens?.obtained ?? null,
    plan,
    credits,
    creditsAt: balanceCache?.at ?? null,
    balanceError,
    billing: await higgsfieldBilling(c.env),
    billingChosen: billingSet === "credits" || billingSet === "cloud",
    cloudConfigured: (await resolveEngineKey(c.env)).key !== null,
    admin: user.role === "admin",
    switch: { enabled: access.enabled },
    access,
    url: HIGGSFIELD_MCP_URL,
    device: pending?.kind === "device" ? { userCode: pending.userCode, verificationUri: pending.verificationUri, verificationUriComplete: pending.verificationUriComplete, interval: pending.interval, expires: pending.expires, refused: pending.refused } : null,
  });
});

/** The billing choice: the subscription credits (sign-in) or the Cloud API key. Admins. */
higgsfieldMcpRoutes.post("/billing", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  const d = await parseBody(c, z.object({ billing: z.enum(["credits", "cloud"]) }));
  await setSetting(c.env, HIGGSFIELD_BILLING_SETTING, d.billing);
  await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "mcp.billing", user: user.id, estimate: 0, reported: 0, status: "done", note: d.billing === "credits" ? "Videos billed to the subscription credits (Higgsfield sign-in)" : "Videos billed to the Cloud API key (pay per clip)" });
  return c.json({ ok: true, billing: d.billing });
});

/**
 * Starts the sign-in: the client is registered once, PKCE state and verifier are kept short-lived,
 * the authorize link comes back for a new tab. When registration with a redirect is refused, the
 * device flow is tried and its user code comes back instead, with what was refused.
 */
higgsfieldMcpRoutes.post("/signin/start", async (c) => {
  const user = await gate(c);
  const fetchFn = fetcher();
  const { as, resource } = await discover(fetchFn);
  const redirect = redirectUri(c.env);
  const opId = await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "mcp.signin", user: user.id, estimate: 0, reported: 0, status: "running", note: `sign-in started at ${as.issuer ?? as.authorization_endpoint}` });
  let refusal: RegistrationRefused | null = null;
  try {
    const client = await ensureClient(c.env, fetchFn, as, redirect);
    const { verifier, challenge } = await pkcePair();
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const pending: Pending = { kind: "code", state, verifier, user: user.id, created: Date.now(), opId, redirectUri: redirect };
    await setSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING, JSON.stringify(pending));
    const u = new URL(as.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", client.client_id);
    u.searchParams.set("redirect_uri", redirect);
    u.searchParams.set("scope", MCP_SCOPES);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("resource", resource);
    return c.json({ ok: true, mode: "redirect", url: u.toString() });
  } catch (e) {
    if (!(e instanceof RegistrationRefused)) {
      await updateIntegrationOp(c.env, opId, { status: "failed", note: errorMessage(e) });
      throw e;
    }
    refusal = e;
  }
  // The fallback: the device flow, when the authorization server offers one.
  if (!as.device_authorization_endpoint) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: refusal.message });
    throw new StudioError(`${refusal.message} The authorization server lists no device flow either, so the studio cannot sign in by itself.`, 502, false, { refused: refusal.data?.refused });
  }
  let client: StoredClient;
  try {
    client = await ensureClient(c.env, fetchFn, as, null);
  } catch (e) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: `${refusal.message} ${errorMessage(e)}` });
    throw new StudioError(`${refusal.message} ${errorMessage(e)}`, 502, false, { refused: refusal.data?.refused, deviceRefused: e instanceof StudioError ? e.data?.refused : errorMessage(e) });
  }
  const body = new URLSearchParams({ client_id: client.client_id, scope: MCP_SCOPES, resource });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  const r = await fetchFn(as.device_authorization_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString(), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: `${refusal.message} device flow refused (${r.status}): ${text.slice(0, 200)}` });
    throw new StudioError(`${refusal.message} The device flow was refused too (${r.status}): ${text.slice(0, 200)}.`, 502, false, { refused: refusal.data?.refused });
  }
  const d = JSON.parse(text) as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
  if (!d.device_code || !d.user_code || !d.verification_uri) throw new StudioError("Higgsfield's device-flow answer is missing the code or the link.", 502);
  const pending: Pending = { kind: "device", deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri, verificationUriComplete: d.verification_uri_complete ?? null, interval: Math.max(5, Number(d.interval) || 5), expires: Date.now() + (Number(d.expires_in) || 600) * 1000, user: user.id, created: Date.now(), opId, refused: refusal.message };
  await setSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING, JSON.stringify(pending));
  return c.json({ ok: true, mode: "device", userCode: pending.userCode, verificationUri: pending.verificationUri, verificationUriComplete: pending.verificationUriComplete, interval: pending.interval, expires: pending.expires, refused: refusal.message });
});

/** The device flow's poll: one token request per call; the page calls it every `interval` seconds. */
higgsfieldMcpRoutes.post("/signin/poll", async (c) => {
  const user = await gate(c);
  const pending = await readPending(c.env);
  if (!pending || pending.kind !== "device") throw new StudioError("No device sign-in is in progress: press Sign in to Higgsfield again.", 409);
  if (pending.user !== user.id) throw new StudioError("Another admin started this sign-in.", 403);
  if (Date.now() > pending.expires) {
    await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
    await updateIntegrationOp(c.env, pending.opId, { status: "failed", note: "device code expired" });
    throw new StudioError("The sign-in code expired: press Sign in to Higgsfield again.", 410);
  }
  const fetchFn = fetcher();
  const { as, resource } = await discover(fetchFn);
  const client = await storedClient(c.env);
  if (!client) throw new StudioError("The registered client is gone: press Sign in to Higgsfield again.", 409);
  try {
    const tokens = await tokenRequest(fetchFn, as, client, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode, resource }, null);
    await setSetting(c.env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify(tokens));
    await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
    resetHiggsfieldMcpCaches();
    await updateIntegrationOp(c.env, pending.opId, { status: "done", note: `signed in (device flow)${tokens.email ? ` as ${tokens.email}` : ""}` });
    return c.json({ ok: true, signedIn: true, email: tokens.email });
  } catch (e) {
    if (e instanceof TokenRefused && (e.oauthError === "authorization_pending" || e.oauthError === "slow_down")) return c.json({ ok: true, signedIn: false, pending: true, interval: e.oauthError === "slow_down" ? pending.interval + 5 : pending.interval });
    await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
    await updateIntegrationOp(c.env, pending.opId, { status: "failed", note: errorMessage(e) });
    throw e;
  }
});

/** Where the browser lands after Higgsfield: the code is exchanged, the tokens kept, back to the studio. */
higgsfieldMcpRoutes.get("/callback", async (c) => {
  const user = c.get("user");
  const back = (q: string) => c.redirect(`/?${q}`, 302);
  const failed = (reason: string) => back(`higgsfield=error&reason=${encodeURIComponent(reason.slice(0, 300))}`);
  const q = c.req.query();
  const pending = await readPending(c.env);
  if (!user || user.role !== "admin") return failed("Only an admin can finish the Higgsfield sign-in.");
  if (q.error) {
    if (pending) {
      await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
      await updateIntegrationOp(c.env, pending.opId, { status: "failed", note: `${q.error}${q.error_description ? `: ${q.error_description}` : ""}` });
    }
    return failed(`Higgsfield said: ${q.error}${q.error_description ? ` (${q.error_description})` : ""}`);
  }
  if (!pending || pending.kind !== "code") return failed("No sign-in was in progress (or it took more than fifteen minutes): press Sign in to Higgsfield again.");
  if (!q.state || q.state !== pending.state) return failed("The sign-in did not match the one started here: press Sign in to Higgsfield again.");
  if (pending.user !== user.id) return failed("Another admin started this sign-in; finish it from their session or start again.");
  if (!q.code) return failed("Higgsfield sent no code back.");
  const fetchFn = fetcher();
  try {
    const { as, resource } = await discover(fetchFn);
    const client = await storedClient(c.env);
    if (!client) throw new StudioError("The registered client is gone: press Sign in to Higgsfield again.", 409);
    const tokens = await tokenRequest(fetchFn, as, client, { grant_type: "authorization_code", code: q.code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, resource }, null);
    await setSetting(c.env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify(tokens));
    await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
    resetHiggsfieldMcpCaches();
    await updateIntegrationOp(c.env, pending.opId, { status: "done", note: `signed in (authorization code + PKCE)${tokens.email ? ` as ${tokens.email}` : ""}` });
    return back("higgsfield=connected");
  } catch (e) {
    await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
    await updateIntegrationOp(c.env, pending.opId, { status: "failed", note: errorMessage(e) });
    return failed(errorMessage(e));
  }
});

/** The tokens are dropped (the registered client stays); a ledger row says who. Admins. */
higgsfieldMcpRoutes.post("/signout", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  const tokens = await storedTokens(c.env);
  await deleteSetting(c.env, HIGGSFIELD_MCP_TOKENS_SETTING);
  await deleteSetting(c.env, HIGGSFIELD_MCP_PENDING_SETTING);
  await deleteSetting(c.env, HIGGSFIELD_MCP_MODELS_SETTING);
  resetHiggsfieldMcpCaches();
  await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "mcp.signout", user: user.id, estimate: 0, reported: 0, status: "done", note: tokens ? `signed out${tokens.email ? ` (${tokens.email})` : ""}` : "nothing was signed in" });
  return c.json({ ok: true });
});

/** The subscription's image-to-video engines, cached per sign-in; `?refresh=1` asks again. Admins. */
higgsfieldMcpRoutes.get("/models", async (c) => {
  await gate(c);
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  const { models, at } = await mcpModels(c.env, mcp, c.req.query("refresh") === "1");
  return c.json({ ok: true, models, at });
});

/** The cost in credits of exactly this clip (nothing is submitted), with the balance. Admins. */
higgsfieldMcpRoutes.post("/estimate", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, askSchema);
  const e = await estimateMcpVideo(c.env, user, d);
  return c.json({ ok: true, credits: e.credits, balance: e.balance, plan: e.plan, unlimChoice: e.unlimChoice ?? null, engine: e.engine, mediaId: e.mediaId });
});

/** The clip, with `confirm: true` for the credits shown and `useUnlim` when Higgsfield asked. Admins. */
higgsfieldMcpRoutes.post("/generate", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, generateSchema);
  return c.json({ ok: true, video: await submitMcpVideo(c.env, user, d) });
});
