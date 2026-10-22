/**
 * The Magnific MCP sign-in (server/magnific-signin.ts on the shared server/oauth-signin.ts), end
 * to end against stand-ins for the metadata documents, the Keycloak realm and the MCP endpoint:
 * discovery, one client registration, PKCE with S256 and the scopes the resource demands (plus
 * offline_access only when the realm lists it), the callback and the encrypted tokens, the
 * "signed in until …" path when no refresh token comes, the e-mail from userinfo when the id token
 * carries none, a refresh ahead of expiry and once on a 401 (then the same call once), sign-out,
 * the device-flow fallback, members refused, the switch, and the tools running on the sign-in's
 * token with the pasted token as the fallback. No call leaves the test: the guard fails it on any
 * fetch the stub did not answer.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { freepikRoutes } from "../server/freepik";
import { MCP_NOT_CONNECTED, MCP_URL, freepikMcpRoutes, useMcpFetch } from "../server/freepik-mcp";
import { MAGNIFIC_CALLBACK_PATH, MAGNIFIC_RESOURCE_METADATA, MAGNIFIC_SCOPES, magnificSignIn } from "../server/magnific-signin";
import { FREEPIK_MCP_CLIENT_SETTING, FREEPIK_MCP_TOKEN_SETTING, FREEPIK_MCP_TOKENS_SETTING, getSetting, setSetting } from "../server/settings";
import * as integrations from "../server/integrations";

vi.mock("../server/integrations", async (orig) => {
  const m = (await orig()) as typeof integrations;
  return { ...m, recordIntegrationOp: vi.fn(m.recordIntegrationOp), updateIntegrationOp: vi.fn(m.updateIntegrationOp) };
});

type FakeEnv = ReturnType<typeof fakeEnv>;
const JSON_HEADERS = { "content-type": "application/json" };
const AS = "https://auth.test/realms/mcp";
const REDIRECT = `https://studio.test${MAGNIFIC_CALLBACK_PATH}`;
const PASTED = "tok_pasted_0123456789abcdef";
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const ID_TOKEN = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"u","email":"owner@test"}')}.sig`;

function app(role: "admin" | "member" = "admin") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: role === "admin" ? "u1" : "u2", email: `${role}@test`, name: role, role } as User);
    await next();
  });
  a.route("/api/studio/freepik/mcp", freepikMcpRoutes);
  a.route("/api/studio/freepik", freepikRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', ?)").bind(t).run();
  return env;
}

/** A signed-in studio: the registered client and fresh tokens, as the callback would have stored them. */
async function signedIn(env: FakeEnv, tokens: Partial<{ access: string; refresh: string | null; expiresAt: number | null }> = {}) {
  await setSetting(env, FREEPIK_MCP_CLIENT_SETTING, JSON.stringify({ client_id: "cid_1", issuer: AS, redirect_uri: REDIRECT, registered: Date.now() }));
  await setSetting(env, FREEPIK_MCP_TOKENS_SETTING, JSON.stringify({ access: "tok_1", refresh: "ref_1", expiresAt: Date.now() + 3600_000, scope: `${MAGNIFIC_SCOPES} offline_access`, email: "owner@test", obtained: Date.now(), ...tokens }));
}

interface StubOptions {
  /** Registration with a redirect is refused with this body (the device flow is then the fallback). */
  refuseRedirectRegistration?: string;
  /** Bearer tokens the MCP endpoint accepts. */
  valid?: string[];
  /** The realm lists offline_access in scopes_supported (true by default, as auth.magnific.com does). */
  offline?: boolean;
  /** The token answers carry no refresh token. */
  noRefresh?: boolean;
  /** The token answers carry no id token (the e-mail then comes from userinfo). */
  noIdToken?: boolean;
  /** Device-flow polls answer pending this many times before the tokens. */
  devicePending?: number;
}

/** Magnific's metadata, the Keycloak realm and the MCP endpoint, answering as the documents read on 22 Oct 2026 say. */
function magnificStub(opts: StubOptions = {}) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const rpc: { method: string; name?: string; token: string }[] = [];
  const state = { registrations: 0, refreshes: 0, codeChallenge: "", devicePolls: 0, userinfo: 0, valid: new Set(opts.valid ?? ["tok_1", PASTED]) };
  const scopes = ["profile", "openid", "mcp:custom-audience", "email", "basic", ...(opts.offline === false ? [] : ["offline_access"])];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body ? String(init.body) : "";
    let body: unknown = rawBody;
    if (/^application\/json/.test(headers["Content-Type"] ?? "")) body = rawBody ? JSON.parse(rawBody) : {};
    else if (/x-www-form-urlencoded/.test(headers["Content-Type"] ?? "")) body = Object.fromEntries(new URLSearchParams(rawBody));
    calls.push({ url, method: init?.method ?? "GET", body, headers });
    const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (url === MAGNIFIC_RESOURCE_METADATA) return Response.json({ resource: MCP_URL, authorization_servers: [AS], jwks_uri: `${AS}/protocol/openid-connect/certs`, scopes_supported: ["openid", "profile", "email", "mcp:custom-audience"], bearer_methods_supported: ["header"] });
    if (url === `${AS}/.well-known/oauth-authorization-server`)
      return Response.json({
        issuer: AS,
        authorization_endpoint: `${AS}/protocol/openid-connect/auth`,
        token_endpoint: `${AS}/protocol/openid-connect/token`,
        userinfo_endpoint: `${AS}/protocol/openid-connect/userinfo`,
        registration_endpoint: `${AS}/clients-registrations/openid-connect`,
        device_authorization_endpoint: `${AS}/protocol/openid-connect/auth/device`,
        revocation_endpoint: `${AS}/protocol/openid-connect/revoke`,
        scopes_supported: scopes,
        code_challenge_methods_supported: ["plain", "S256"],
        grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      });
    if (url === `${AS}/clients-registrations/openid-connect`) {
      const b = body as { redirect_uris?: string[]; grant_types: string[]; token_endpoint_auth_method: string };
      if (b.redirect_uris && opts.refuseRedirectRegistration) return new Response(JSON.stringify({ error: "invalid_redirect_uri", error_description: opts.refuseRedirectRegistration }), { status: 400, headers: JSON_HEADERS });
      state.registrations++;
      return new Response(JSON.stringify({ client_id: `cid_${state.registrations}`, client_name: "Level Studio", redirect_uris: b.redirect_uris ?? [], registration_access_token: "reg_secret", registration_client_uri: `${AS}/clients-registrations/openid-connect/cid_${state.registrations}` }), { status: 201, headers: JSON_HEADERS });
    }
    if (url === `${AS}/protocol/openid-connect/auth/device`) return Response.json({ device_code: "dev_1", user_code: "ABCD-EFGH", verification_uri: `${AS}/device`, verification_uri_complete: `${AS}/device?user_code=ABCD-EFGH`, expires_in: 600, interval: 5 });
    if (url === `${AS}/protocol/openid-connect/userinfo`) {
      state.userinfo++;
      return state.valid.has(bearer) ? Response.json({ sub: "u", email: "owner@test", preferred_username: "owner" }) : new Response("{}", { status: 401, headers: JSON_HEADERS });
    }
    if (url === `${AS}/protocol/openid-connect/token`) {
      const b = body as Record<string, string>;
      const issue = (access: string) => {
        state.valid.add(access);
        return Response.json({ access_token: access, token_type: "Bearer", expires_in: 300, scope: scopes.filter((s) => s !== "basic").join(" "), ...(opts.noRefresh ? {} : { refresh_token: "ref_2", refresh_expires_in: 1800 }), ...(opts.noIdToken ? {} : { id_token: ID_TOKEN }) });
      };
      if (b.grant_type === "authorization_code") {
        const challenge = createHash("sha256").update(b.code_verifier).digest("base64url");
        if (b.code !== "code_1" || challenge !== state.codeChallenge || b.redirect_uri !== REDIRECT) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Code not valid" }), { status: 400, headers: JSON_HEADERS });
        return issue("tok_1");
      }
      if (b.grant_type === "refresh_token") {
        state.refreshes++;
        if (b.refresh_token !== "ref_1" && b.refresh_token !== "ref_2") return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid refresh token" }), { status: 400, headers: JSON_HEADERS });
        return issue("tok_2");
      }
      if (b.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        state.devicePolls++;
        if (state.devicePolls <= (opts.devicePending ?? 1)) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400, headers: JSON_HEADERS });
        return issue("tok_1");
      }
      return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400, headers: JSON_HEADERS });
    }
    if (url === MCP_URL) {
      const b = body as { id?: number; method: string; params: Record<string, unknown> };
      rpc.push({ method: b.method, name: b.params?.name as string | undefined, token: bearer });
      if (!state.valid.has(bearer)) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": `Bearer error="invalid_token", resource_metadata="${MAGNIFIC_RESOURCE_METADATA}", scope="${MAGNIFIC_SCOPES}"` } });
      if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "magnific", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "mg-sess-1" } });
      expect(headers["Mcp-Session-Id"]).toBe("mg-sess-1");
      if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (b.method === "tools/list")
        return b.params.cursor
          ? Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "images_generate", description: "Make a picture", inputSchema: { type: "object" } }, { name: "stock_download", description: "Download", inputSchema: { type: "object" } }] } })
          : Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "stock_search", description: "Search stock", inputSchema: { type: "object" } }, { name: "account_balance", description: "Balance" }], nextCursor: "p2" } });
      if (b.method === "tools/call") {
        const name = b.params.name as string;
        const text = (v: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: JSON.stringify(v) }] } });
        if (name === "stock_search") return text({ items: [{ id: 123, title: "Kunafa on marble", type: "photo", preview: "https://img.test/123.jpg", license: "premium", author: { name: "Studio A" } }] });
        if (name === "account_balance") return text({ credits: 100 });
        return Response.json({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: "no such tool" }], isError: true } });
      }
      return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fn, calls, rpc, state };
}

const ops = () => (integrations.recordIntegrationOp as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { kind: string; status: string; note?: string; provider: string });
const updates = () => (integrations.updateIntegrationOp as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as { status?: string; note?: string });
const postJson = (a: ReturnType<typeof app>, env: FakeEnv, path: string, body: unknown = {}) => a.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env);
const status = async (env: FakeEnv, role: "admin" | "member" = "admin") => json(await app(role).request("/api/studio/freepik/mcp/status", {}, env));
const tokenOf = (url: URL) => url.searchParams;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useMcpFetch(null);
  magnificSignIn.resetDiscovery();
  (integrations.recordIntegrationOp as unknown as ReturnType<typeof vi.fn>).mockClear();
  (integrations.updateIntegrationOp as unknown as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useMcpFetch(null);
});

describe("before any sign-in", () => {
  it("reports Not signed in with no token, the demo tools, and a member's view", async () => {
    const env = await seed();
    expect(await status(env)).toMatchObject({ signedIn: false, expired: false, email: null, refresh: false, token: false, source: null, admin: true, switch: { enabled: true }, url: MCP_URL, callback: MAGNIFIC_CALLBACK_PATH, device: null });
    expect(await status(env, "member")).toMatchObject({ signedIn: false, admin: false });
    const t = await json(await app().request("/api/studio/freepik/mcp/tools", {}, env));
    expect(t).toMatchObject({ connected: false, demo: true, source: null, reason: MCP_NOT_CONNECTED });
    const call = await postJson(app(), env, "/api/studio/freepik/mcp/call", { tool: "stock_search", arguments: {} });
    expect(call.status).toBe(409);
    expect(await json(call)).toMatchObject({ connected: false, error: MCP_NOT_CONNECTED });
    expect((await json(await app().request("/api/studio/freepik/status", {}, env))).mcp).toMatchObject({ connected: false, signedIn: false, token: false });
    expect(reached).toEqual([]);
  });

  it("refuses a member everywhere but the status, and answers 503 while the switch is off", async () => {
    const env = await seed();
    for (const path of ["/api/studio/freepik/mcp/signin/start", "/api/studio/freepik/mcp/signin/poll", "/api/studio/freepik/mcp/signout"]) {
      const r = await postJson(app("member"), env, path);
      expect(r.status, path).toBe(403);
      expect(((await json(r)) as { error: string }).error).toMatch(/Admins only for now/);
    }
    // A member cannot finish a callback either: the browser is sent back with the reason.
    const cb = await app("member").request(`${MAGNIFIC_CALLBACK_PATH}?code=code_1&state=x`, {}, env);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toMatch(/^\/\?magnific=error&reason=Only%20an%20admin/);
    await integrations.setIntegrationSwitch(env, "freepik", false);
    for (const path of ["/api/studio/freepik/mcp/signin/start", "/api/studio/freepik/mcp/signin/poll"]) {
      const r = await postJson(app(), env, path);
      expect(r.status, path).toBe(503);
      expect(((await json(r)) as { error: string }).error).toMatch(/switched off/);
    }
    expect((await status(env)).switch).toEqual({ enabled: false });
    expect(reached).toEqual([]);
  });
});

describe("the sign-in", () => {
  it("discovers the metadata, registers the client once, starts PKCE with S256 and the scopes the resource demands (plus offline_access, which the realm lists), exchanges the code at the callback and stores the tokens encrypted", async () => {
    const env = await seed();
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const start = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/start"));
    expect(start).toMatchObject({ ok: true, mode: "redirect" });
    const u = new URL(String(start.url));
    expect(u.origin + u.pathname).toBe(`${AS}/protocol/openid-connect/auth`);
    expect(tokenOf(u).get("response_type")).toBe("code");
    expect(tokenOf(u).get("client_id")).toBe("cid_1");
    expect(tokenOf(u).get("redirect_uri")).toBe(REDIRECT);
    expect(tokenOf(u).get("scope")).toBe("openid profile email mcp:custom-audience offline_access");
    expect(tokenOf(u).get("code_challenge_method")).toBe("S256");
    expect(tokenOf(u).get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(u).get("resource")).toBe(MCP_URL);
    const state = tokenOf(u).get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    stub.state.codeChallenge = tokenOf(u).get("code_challenge")!;
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${MAGNIFIC_RESOURCE_METADATA}`, `GET ${AS}/.well-known/oauth-authorization-server`, `POST ${AS}/clients-registrations/openid-connect`]);
    expect(stub.calls[2].body).toMatchObject({ client_name: "Level Studio", client_uri: "https://studio.test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid profile email mcp:custom-audience offline_access" });
    // A second start reuses the registered client (no second registration) and a new state.
    const again = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/start"));
    const u2 = new URL(String(again.url));
    expect(stub.state.registrations).toBe(1);
    expect(tokenOf(u2).get("state")).not.toBe(state);
    stub.state.codeChallenge = tokenOf(u2).get("code_challenge")!;
    // The registered client is stored encrypted, never its id in clear.
    const rawClient = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(FREEPIK_MCP_CLIENT_SETTING).first<{ value: string }>();
    expect(rawClient!.value).not.toContain("cid_1");

    // A callback with the first (superseded) state is refused without touching the token endpoint.
    const bad = await app().request(`${MAGNIFIC_CALLBACK_PATH}?code=code_1&state=${state}`, {}, env);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/^\/\?magnific=error&reason=The%20sign-in%20did%20not%20match/);
    expect(stub.calls.some((c) => c.url === `${AS}/protocol/openid-connect/token`)).toBe(false);
    // An answer from another issuer is refused too (RFC 9207).
    const wrongIss = await app().request(`${MAGNIFIC_CALLBACK_PATH}?code=code_1&state=${tokenOf(u2).get("state")}&iss=https://elsewhere.test`, {}, env);
    expect(wrongIss.headers.get("location")).toMatch(/elsewhere\.test/);
    expect(stub.calls.some((c) => c.url === `${AS}/protocol/openid-connect/token`)).toBe(false);
    // The refused callback dropped the pending sign-in: start once more for the real one.
    const third = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/start"));
    const u3 = new URL(String(third.url));
    stub.state.codeChallenge = tokenOf(u3).get("code_challenge")!;

    const cb = await app().request(`${MAGNIFIC_CALLBACK_PATH}?code=code_1&state=${tokenOf(u3).get("state")}&iss=${encodeURIComponent(AS)}`, {}, env);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?magnific=connected");
    const exchange = stub.calls.find((c) => c.url === `${AS}/protocol/openid-connect/token`)!.body as Record<string, string>;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: "code_1", redirect_uri: REDIRECT, client_id: "cid_1", resource: MCP_URL });
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(exchange.client_secret).toBeUndefined();
    const tokens = await magnificSignIn.storedTokens(env);
    expect(tokens).toMatchObject({ access: "tok_1", refresh: "ref_2", email: "owner@test", scope: "profile openid mcp:custom-audience email offline_access" });
    expect(tokens!.expiresAt).toBeGreaterThan(Date.now() + 240_000);
    expect(stub.state.userinfo).toBe(0);
    const raw = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(FREEPIK_MCP_TOKENS_SETTING).first<{ value: string }>();
    expect(raw!.value).not.toContain("tok_1");
    expect(raw!.value).not.toContain("ref_2");
    expect(raw!.value).not.toContain("owner@test");
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'freepik_mcp_pending'").first()) ?? null).toBeNull();

    // Signed in: the status says who and that the sign-in renews itself; the Freepik status says connected.
    expect(await status(env)).toMatchObject({ signedIn: true, expired: false, email: "owner@test", refresh: true, token: false, source: "signin" });
    expect((await json(await app().request("/api/studio/freepik/status", {}, env))).mcp).toMatchObject({ connected: true, signedIn: true, token: false, url: MCP_URL });
    // The tools run on the sign-in's token.
    const t = (await json(await app().request("/api/studio/freepik/mcp/tools", {}, env))) as { connected: boolean; source: string; tools: { name: string; cost: string }[] };
    expect(t).toMatchObject({ connected: true, demo: false, source: "signin" });
    expect(t.tools.map((x) => [x.name, x.cost])).toEqual([["stock_search", "free"], ["account_balance", "free"], ["images_generate", "credits"], ["stock_download", "download"]]);
    expect(stub.rpc.map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(stub.rpc.every((r) => r.token === "tok_1")).toBe(true);
    // The ledger: one `mcp.signin` row per start, under the Freepik provider, the last one done with the account.
    const signin = ops().filter((o) => o.kind === "mcp.signin");
    expect(signin).toHaveLength(3);
    expect(signin.every((o) => o.provider === "freepik" && o.status === "running")).toBe(true);
    expect(updates().some((u) => u.status === "done" && /^signed in \(authorization code \+ PKCE\) as owner@test$/.test(u.note ?? ""))).toBe(true);
    expect(reached).toEqual([]);
  });

  it("asks only the demanded scopes when the realm lists no offline_access; without a refresh token the status says until when, the e-mail comes from userinfo, and expiry ends the sign-in", async () => {
    const env = await seed();
    const stub = magnificStub({ offline: false, noRefresh: true, noIdToken: true });
    useMcpFetch(stub.fn);
    const start = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/start"));
    const u = new URL(String(start.url));
    expect(tokenOf(u).get("scope")).toBe(MAGNIFIC_SCOPES);
    expect((stub.calls[2].body as { scope: string }).scope).toBe(MAGNIFIC_SCOPES);
    stub.state.codeChallenge = tokenOf(u).get("code_challenge")!;
    const cb = await app().request(`${MAGNIFIC_CALLBACK_PATH}?code=code_1&state=${tokenOf(u).get("state")}`, {}, env);
    expect(cb.headers.get("location")).toBe("/?magnific=connected");
    // No id token: userinfo is asked once with the new access token.
    expect(stub.state.userinfo).toBe(1);
    expect(stub.calls.find((c) => c.url === `${AS}/protocol/openid-connect/userinfo`)!.headers.Authorization).toBe("Bearer tok_1");
    const tokens = await magnificSignIn.storedTokens(env);
    expect(tokens).toMatchObject({ access: "tok_1", refresh: null, email: "owner@test" });
    const s = await status(env);
    expect(s).toMatchObject({ signedIn: true, expired: false, refresh: false, email: "owner@test", source: "signin" });
    expect(s.expiresAt as number).toBeGreaterThan(Date.now() + 240_000);
    expect(s.expiresAt as number).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(updates().some((u) => u.status === "done" && /signed in \(authorization code \+ PKCE\) as owner@test · no refresh token/.test(u.note ?? ""))).toBe(true);
    // The tools run while the token lasts.
    expect((await json(await app().request("/api/studio/freepik/mcp/tools", {}, env))).connected).toBe(true);

    // Past the expiry, with nothing to refresh: the sign-in is over and nothing reaches the server.
    await setSetting(env, FREEPIK_MCP_TOKENS_SETTING, JSON.stringify({ ...tokens, expiresAt: Date.now() - 1000 }));
    const rpcBefore = stub.rpc.length;
    expect(await status(env)).toMatchObject({ signedIn: false, expired: true, refresh: false, source: null });
    expect((await json(await app().request("/api/studio/freepik/status", {}, env))).mcp).toMatchObject({ connected: false, signedIn: false });
    const t = await json(await app().request("/api/studio/freepik/mcp/tools", {}, env));
    expect(t).toMatchObject({ connected: false, demo: true });
    expect(stub.rpc).toHaveLength(rpcBefore);
    expect(stub.state.refreshes).toBe(0);
    // A direct ask for the token says the sign-in expired and drops it.
    await expect(magnificSignIn.accessToken(env)).rejects.toMatchObject({ status: 409, data: { notSignedIn: true, expired: true } });
    expect(await magnificSignIn.storedTokens(env)).toBeNull();
    expect(reached).toEqual([]);
  });

  it("refreshes the token once on a 401 and repeats the same call once; before expiry it refreshes ahead; an invalid_grant ends the sign-in", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = magnificStub({ valid: ["tok_2"] });
    useMcpFetch(stub.fn);
    const t = (await json(await app().request("/api/studio/freepik/mcp/tools", {}, env))) as { connected: boolean; tools: unknown[] };
    expect(t.connected).toBe(true);
    expect(t.tools).toHaveLength(4);
    expect(stub.rpc[0]).toMatchObject({ method: "initialize", token: "tok_1" });
    expect(stub.rpc[1]).toMatchObject({ method: "initialize", token: "tok_2" });
    expect(stub.rpc.slice(1).every((r) => r.token === "tok_2")).toBe(true);
    expect(stub.state.refreshes).toBe(1);
    const refresh = stub.calls.find((c) => c.url === `${AS}/protocol/openid-connect/token`)!.body as Record<string, string>;
    expect(refresh).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref_1", client_id: "cid_1", resource: MCP_URL });
    expect(await magnificSignIn.storedTokens(env)).toMatchObject({ access: "tok_2", refresh: "ref_2" });
    expect(stub.rpc.filter((r) => r.method === "tools/list")).toHaveLength(2);

    // An access token about to expire is refreshed before the call, with no 401 at all.
    magnificSignIn.resetDiscovery();
    await signedIn(env, { access: "tok_old", refresh: "ref_1", expiresAt: Date.now() + 10_000 });
    const stub2 = magnificStub({ valid: ["tok_2"] });
    useMcpFetch(stub2.fn);
    const call = await postJson(app(), env, "/api/studio/freepik/mcp/call", { tool: "account_balance", arguments: {} });
    expect(call.status).toBe(200);
    expect(stub2.rpc.every((r) => r.token === "tok_2")).toBe(true);
    expect(stub2.state.refreshes).toBe(1);
    expect(stub2.rpc.filter((r) => r.name === "account_balance")).toHaveLength(1);

    // A refresh the server refuses as invalid_grant ends the sign-in: 409, tokens gone, nothing reached the MCP server.
    magnificSignIn.resetDiscovery();
    await signedIn(env, { access: "tok_old", refresh: "ref_gone", expiresAt: Date.now() - 1 });
    const stub3 = magnificStub();
    useMcpFetch(stub3.fn);
    const gone = await postJson(app(), env, "/api/studio/freepik/mcp/call", { tool: "account_balance", arguments: {} });
    expect(gone.status).toBe(409);
    expect(await json(gone)).toMatchObject({ notSignedIn: true, expired: true });
    expect(await magnificSignIn.storedTokens(env)).toBeNull();
    expect(stub3.rpc).toHaveLength(0);
    expect(reached).toEqual([]);
  });

  it("falls back to the device flow when the redirect registration is refused, saying what was refused, and polls the token endpoint", async () => {
    const env = await seed();
    const stub = magnificStub({ refuseRedirectRegistration: "Redirect URIs are not permitted for anonymous registration", devicePending: 1 });
    useMcpFetch(stub.fn);
    const start = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/start"));
    expect(start).toMatchObject({ ok: true, mode: "device", userCode: "ABCD-EFGH", verificationUri: `${AS}/device`, interval: 5 });
    expect(String(start.refused)).toMatch(/^Magnific refused to register the studio as an OAuth client with a redirect \(400\): .*not permitted/);
    const registrations = stub.calls.filter((c) => c.url === `${AS}/clients-registrations/openid-connect`);
    expect(registrations).toHaveLength(2);
    expect((registrations[1].body as Record<string, unknown>).redirect_uris).toBeUndefined();
    expect((registrations[1].body as Record<string, unknown>).grant_types).toEqual(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]);
    const device = stub.calls.find((c) => c.url === `${AS}/protocol/openid-connect/auth/device`)!.body as Record<string, string>;
    expect(device).toMatchObject({ client_id: "cid_1", scope: "openid profile email mcp:custom-audience offline_access", resource: MCP_URL });
    expect(await status(env)).toMatchObject({ signedIn: false, device: { userCode: "ABCD-EFGH", verificationUri: `${AS}/device` } });
    expect((await status(env, "member")).device).toBeNull();
    const first = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/poll"));
    expect(first).toMatchObject({ ok: true, signedIn: false, pending: true, interval: 5 });
    const second = await json(await postJson(app(), env, "/api/studio/freepik/mcp/signin/poll"));
    expect(second).toMatchObject({ ok: true, signedIn: true, email: "owner@test" });
    expect((stub.calls.filter((c) => c.url === `${AS}/protocol/openid-connect/token`).pop()!.body as Record<string, string>).grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect((await magnificSignIn.storedTokens(env))?.access).toBe("tok_1");
    expect((await status(env)).device).toBeNull();
    expect(updates().some((u) => u.status === "done" && /device flow.*owner@test/.test(u.note ?? ""))).toBe(true);
    expect(reached).toEqual([]);
  });

  it("signs out: the tokens are gone, the client and a pasted token stay, the ledger says who", async () => {
    const env = await seed();
    await signedIn(env);
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, PASTED);
    const r = await postJson(app(), env, "/api/studio/freepik/mcp/signout");
    expect(r.status).toBe(200);
    expect(await magnificSignIn.storedTokens(env)).toBeNull();
    expect(await getSetting(env, FREEPIK_MCP_CLIENT_SETTING)).toContain("cid_1");
    expect(await getSetting(env, FREEPIK_MCP_TOKEN_SETTING)).toBe(PASTED);
    expect(await status(env)).toMatchObject({ signedIn: false, token: true, source: "token" });
    expect(ops().filter((o) => o.kind === "mcp.signout")).toMatchObject([{ provider: "freepik", status: "done", note: "signed out (owner@test)" }]);
    // Signing out with nothing signed in is still recorded.
    await postJson(app(), env, "/api/studio/freepik/mcp/signout");
    expect(ops().filter((o) => o.kind === "mcp.signout").pop()).toMatchObject({ note: "nothing was signed in" });
    expect(reached).toEqual([]);
  });
});

describe("the tools on the sign-in", () => {
  it("runs a free tool on the sign-in's token, falls back to the pasted token without a sign-in, and lets the token be removed", async () => {
    const env = await seed();
    // The old path alone: the pasted token carries the call.
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, PASTED);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    expect(await status(env)).toMatchObject({ signedIn: false, token: true, source: "token" });
    const onToken = await postJson(app(), env, "/api/studio/freepik/mcp/call", { tool: "stock_search", arguments: { query: "kunafa" } });
    expect(onToken.status).toBe(200);
    expect(await json(onToken)).toMatchObject({ ok: true, cost: "free", estimate: 0, source: "token" });
    expect(stub.rpc.every((r) => r.token === PASTED)).toBe(true);
    expect(stub.calls.every((c) => c.url === MCP_URL)).toBe(true);

    // Signed in as well: the sign-in wins, the pasted token is not sent.
    await signedIn(env);
    expect(await status(env)).toMatchObject({ signedIn: true, token: true, source: "signin" });
    const before = stub.rpc.length;
    const onSignIn = await postJson(app(), env, "/api/studio/freepik/mcp/call", { tool: "stock_search", arguments: { query: "kunafa" } });
    expect(onSignIn.status).toBe(200);
    const body = (await json(onSignIn)) as { source: string; assets: { providerId: string; title: string }[] };
    expect(body.source).toBe("signin");
    expect(body.assets).toMatchObject([{ providerId: "123", title: "Kunafa on marble" }]);
    expect(stub.rpc.slice(before).every((r) => r.token === "tok_1")).toBe(true);
    expect(stub.rpc.slice(before).map((r) => r.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(ops().filter((o) => o.kind === "mcp:stock_search")).toHaveLength(2);

    // A pasted token refused by the server is not refreshed: the message says to sign in instead.
    await magnificSignIn.signOut(env, { id: "u1", role: "admin" } as User);
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, "tok_stale_0123456789abcdef");
    const stale = await app().request("/api/studio/freepik/mcp/tools", {}, env);
    expect(stale.status).toBe(401);
    expect(((await json(stale)) as { error: string }).error).toMatch(/refused the token \(401\): the pasted token expired: sign in to Magnific/);
    expect(stub.state.refreshes).toBe(0);

    // The token can go once the sign-in is there.
    expect((await app().request("/api/studio/freepik/mcp/token", { method: "DELETE" }, env)).status).toBe(200);
    expect(await status(env)).toMatchObject({ signedIn: false, token: false, source: null });
    expect(reached).toEqual([]);
  });
});
