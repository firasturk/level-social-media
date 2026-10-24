/**
 * Videos on the Higgsfield subscription credits through the MCP server (server/higgsfield-mcp.ts),
 * end to end against stand-ins for the metadata documents, the authorization server and the MCP
 * endpoint: discovery, one client registration, PKCE, the callback and the encrypted tokens, a
 * refresh on 401 (one, then the same call once), sign-out; the tool names mapped by name; the
 * estimate with `get_cost` (nothing submitted), the unlimited-allowance question surfaced and
 * never answered here, the job through `generate_video_batch` → `jobs_wait` → the mp4 in R2 as a
 * `higgsfield-mcp` version with the credits in the ledger; a transport timeout that keeps the claim
 * and never resubmits; the billing choice gating both paths; members refused; the switch. No call
 * leaves the test: the guard fails it on any fetch the stub did not answer.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { CALLBACK_PATH, engineList, HIGGSFIELD_MCP_URL, HIGGSFIELD_RESOURCE_METADATA, MCP_PROVIDER, NOT_SIGNED_IN, resetHiggsfieldMcpCaches, storedTokens, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { CLOUD_CHOSEN, CREDITS_CHOSEN } from "../server/higgsfield-billing";
import { getSetting, setSetting, HIGGSFIELD_BILLING_SETTING, HIGGSFIELD_MCP_CLIENT_SETTING, HIGGSFIELD_MCP_TOKENS_SETTING } from "../server/settings";
import * as integrations from "../server/integrations";

vi.mock("../server/integrations", async (orig) => {
  const m = (await orig()) as typeof integrations;
  return { ...m, recordIntegrationOp: vi.fn(m.recordIntegrationOp), updateIntegrationOp: vi.fn(m.updateIntegrationOp) };
});

type FakeEnv = ReturnType<typeof fakeEnv>;
const JSON_HEADERS = { "content-type": "application/json" };
const AS = "https://clerk.test";
const REDIRECT = `https://studio.test${CALLBACK_PATH}`;
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const ID_TOKEN = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"u","email":"owner@test"}')}.sig`;

function app(role: "admin" | "member" = "admin") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: role === "admin" ? "u1" : "u2", email: `${role}@test`, name: role, role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "product", title: "Cup", brief: "A cup", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'cup.jpg', 'cup', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u1/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  await env.BUCKET.put("u1/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer, { httpMetadata: { contentType: "image/png" } });
  return env;
}

/** A signed-in studio: the registered client and fresh tokens, as the callback would have stored them. */
async function signedIn(env: FakeEnv, tokens: Partial<{ access: string; refresh: string | null; expiresAt: number | null }> = {}) {
  await setSetting(env, HIGGSFIELD_MCP_CLIENT_SETTING, JSON.stringify({ client_id: "cid_1", issuer: AS, redirect_uri: REDIRECT, registered: Date.now() }));
  await setSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify({ access: "tok_1", refresh: "ref_1", expiresAt: Date.now() + 3600_000, scope: "openid email offline_access", email: "owner@test", obtained: Date.now(), ...tokens }));
}

interface StubOptions {
  /** Registration with a redirect is refused with this body (the device flow is then the fallback). */
  refuseRedirectRegistration?: string;
  /** Bearer tokens the MCP endpoint accepts. */
  valid?: string[];
  /** The tools the server lists. */
  tools?: string[];
  /** `generate_video` with get_cost answers the unlimited-allowance question instead of a cost. */
  unlimOnCost?: boolean;
  /** `generate_video_batch` answers the unlimited-allowance question unless use_unlim is set. */
  unlimOnBatch?: boolean;
  /** `generate_video_batch` never answers (a transport timeout). */
  timeoutBatch?: boolean;
  /** What each `jobs_wait` says about job-1, in order. */
  waits?: Record<string, unknown>[];
  /** Device-flow polls answer pending this many times before the tokens. */
  devicePending?: number;
}

/** Higgsfield's metadata, Clerk's authorization server and the MCP endpoint, answering as the documents and the tool descriptions say. */
function higgsfieldStub(opts: StubOptions = {}) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const rpc: { method: string; name?: string; args?: Record<string, unknown>; token: string }[] = [];
  const state = { registrations: 0, refreshes: 0, balance: 1500, codeChallenge: "", devicePolls: 0, valid: new Set(opts.valid ?? ["tok_1"]) };
  const tools = opts.tools ?? ["balance", "models_explore", "media_import_url", "media_upload", "media_confirm", "generate_video", "generate_video_batch", "jobs_wait", "show_generation_by_ids", "show_result"];
  const waits = [...(opts.waits ?? [{ status: "running" }, { status: "completed", result: { url: "https://cdn.test/out.mp4" } }])];
  const text = (r: McpText) => Response.json({ jsonrpc: "2.0", id: r.id, result: { content: [{ type: "text", text: JSON.stringify(r.body) }], isError: !!r.isError } }, { headers: r.headers });
  type McpText = { id: unknown; body: unknown; isError?: boolean; headers?: Record<string, string> };
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body ? String(init.body) : "";
    let body: unknown = rawBody;
    if (/^application\/json/.test(headers["Content-Type"] ?? "")) body = rawBody ? JSON.parse(rawBody) : {};
    else if (/x-www-form-urlencoded/.test(headers["Content-Type"] ?? "")) body = Object.fromEntries(new URLSearchParams(rawBody));
    calls.push({ url, method: init?.method ?? "GET", body, headers });
    if (url === HIGGSFIELD_RESOURCE_METADATA) return Response.json({ resource: HIGGSFIELD_MCP_URL, authorization_servers: [AS], scopes_supported: ["openid", "email", "offline_access"], bearer_methods_supported: ["header"] });
    if (url === `${AS}/.well-known/oauth-authorization-server`)
      return Response.json({ issuer: AS, authorization_endpoint: `${AS}/oauth/authorize`, token_endpoint: `${AS}/oauth/token`, registration_endpoint: `${AS}/oauth/register`, device_authorization_endpoint: `${AS}/oauth/device_authorization`, code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"] });
    if (url === `${AS}/oauth/register`) {
      const b = body as { redirect_uris?: string[]; grant_types: string[]; token_endpoint_auth_method: string };
      if (b.redirect_uris && opts.refuseRedirectRegistration) return new Response(JSON.stringify({ error: "invalid_redirect_uri", error_description: opts.refuseRedirectRegistration }), { status: 400, headers: JSON_HEADERS });
      state.registrations++;
      return new Response(JSON.stringify({ client_id: `cid_${state.registrations}`, client_name: "Level Studio", redirect_uris: b.redirect_uris ?? [] }), { status: 201, headers: JSON_HEADERS });
    }
    if (url === `${AS}/oauth/device_authorization`) return Response.json({ device_code: "dev_1", user_code: "ABCD-EFGH", verification_uri: `${AS}/activate`, verification_uri_complete: `${AS}/activate?user_code=ABCD-EFGH`, expires_in: 600, interval: 5 });
    if (url === `${AS}/oauth/token`) {
      const b = body as Record<string, string>;
      const issue = (access: string) => {
        state.valid.add(access);
        return Response.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: "ref_2", scope: "openid email offline_access", id_token: ID_TOKEN });
      };
      if (b.grant_type === "authorization_code") {
        const challenge = createHash("sha256").update(b.code_verifier).digest("base64url");
        if (b.code !== "code_1" || challenge !== state.codeChallenge || b.redirect_uri !== REDIRECT) return new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad code or verifier" }), { status: 400, headers: JSON_HEADERS });
        return issue("tok_1");
      }
      if (b.grant_type === "refresh_token") {
        state.refreshes++;
        if (b.refresh_token !== "ref_1" && b.refresh_token !== "ref_2") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: JSON_HEADERS });
        return issue("tok_2");
      }
      if (b.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        state.devicePolls++;
        if (state.devicePolls <= (opts.devicePending ?? 1)) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400, headers: JSON_HEADERS });
        return issue("tok_1");
      }
      return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400, headers: JSON_HEADERS });
    }
    if (url === "https://cdn.test/out.mp4") return new Response(sampleBytes(), { status: 200, headers: { "content-type": "video/mp4" } });
    if (url === HIGGSFIELD_MCP_URL) {
      const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
      const b = body as { id?: number; method: string; params: Record<string, unknown> };
      rpc.push({ method: b.method, name: b.params?.name as string | undefined, args: b.params?.arguments as Record<string, unknown> | undefined, token });
      if (!state.valid.has(token)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": `Bearer resource_metadata="${HIGGSFIELD_RESOURCE_METADATA}", scope="openid email offline_access"` } });
      if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "higgsfield", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "hf-sess-1" } });
      expect(headers["Mcp-Session-Id"]).toBe("hf-sess-1");
      if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (b.method === "tools/list") {
        const half = Math.ceil(tools.length / 2);
        const page = b.params.cursor ? tools.slice(half) : tools.slice(0, half);
        return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: page.map((name) => ({ name, description: name, inputSchema: { type: "object" } })), ...(b.params.cursor ? {} : { nextCursor: "p2" }) } });
      }
      if (b.method === "tools/call") {
        const name = b.params.name as string;
        const args = (b.params.arguments ?? {}) as Record<string, unknown>;
        if (name === "balance") return text({ id: b.id, body: { credits: state.balance, plan: "Creator", renews_at: "2026-11-01" } });
        if (name === "models_explore")
          return text({
            id: b.id,
            body: {
              models: [
                { id: "seedance_2_5", name: "Seedance 2.5", type: "video", description: "Natural motion", durations: [5, 10], aspect_ratios: ["9:16", "1:1", "16:9"], supports_unlim: false },
                { id: "kling3_0", name: "Kling 3.0", type: "video", description: "Cinematic", durations: [5, 10], aspect_ratios: [], supports_unlim: true },
              ],
            },
          });
        if (name === "media_import_url") {
          expect(String(args.url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
          return text({ id: b.id, body: { media_id: "med_1", type: "image", status: "ready" } });
        }
        if (name === "generate_video") {
          const params = args.params as Record<string, unknown>;
          expect(params.get_cost).toBe(true);
          if (opts.unlimOnCost && params.use_unlim === undefined) return text({ id: b.id, body: { unlim_choice: { model: params.model, options: ["use_unlim", "credits"], message: "This model is covered by your unlimited plan." } } });
          return text({ id: b.id, body: { cost: params.use_unlim ? 0 : 12, currency: "credits", model: params.model } });
        }
        if (name === "generate_video_batch") {
          if (opts.timeoutBatch) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          const req = (args.requests as { index: number; params: Record<string, unknown> }[])[0];
          if (opts.unlimOnBatch && req.params.use_unlim === undefined) return text({ id: b.id, body: { unlim_choice: { model: req.params.model, options: ["use_unlim", "credits"] } } });
          return text({ id: b.id, body: { jobs: [{ index: req.index, job_id: "job-1", status: "queued" }] } });
        }
        if (name === "jobs_wait") {
          const next = waits.length > 1 ? waits.shift()! : waits[0];
          if (next.status === "completed") state.balance = 1488;
          const jobs = (args.jobs as { index: number; job_id: string }[]).map((j) => ({ index: j.index, job_id: j.job_id, ...next }));
          return text({ id: b.id, body: { all_terminal: next.status === "completed" || next.status === "failed", poll_after_seconds: 5, results: jobs } });
        }
        if (name === "show_generation_by_ids") return text({ id: b.id, body: { generations: [{ job_id: "job-1", status: "completed", result: { url: "https://cdn.test/out.mp4" } }] } });
        return text({ id: b.id, body: { error: `no such tool ${name}` }, isError: true });
      }
      return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fn, calls, rpc, state };
}

const ops = () => (integrations.recordIntegrationOp as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { kind: string; status: string; estimate?: number | null; note?: string; provider: string });
const updates = () => (integrations.updateIntegrationOp as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as { status?: string; reported?: number | null; note?: string; taskId?: string | null });
const ask = { batch: "b1", index: 1, model: "seedance_2_5", prompt: "The steam rises and the cup turns slowly", duration: 5, source: "picture" };
const postJson = (a: ReturnType<typeof app>, env: FakeEnv, path: string, body: unknown = {}) => a.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env);
const list = async (env: FakeEnv) => ((await json(await app().request("/api/studio/posts/video/list?batch=b1&index=1", {}, env))) as { videos: { id: string; status: string; url: string | null; requestId: string | null; error: string | null; provider: string; estimate: number | null; forClient: boolean }[]; billing: string }).videos;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  resetHiggsfieldMcpCaches();
  (integrations.recordIntegrationOp as unknown as ReturnType<typeof vi.fn>).mockClear();
  (integrations.updateIntegrationOp as unknown as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useHiggsfieldMcpFetch(null);
});

describe("before any sign-in", () => {
  it("reports Not signed in, the Cloud billing by default, and refuses an estimate without a call", async () => {
    const env = await seed();
    const s = await json(await app().request("/api/studio/higgsfield/mcp/status", {}, env));
    expect(s).toMatchObject({ signedIn: false, email: null, credits: null, billing: "cloud", billingChosen: false, admin: true, switch: { enabled: true }, cloudConfigured: false });
    const m = await json(await app("member").request("/api/studio/higgsfield/mcp/status", {}, env));
    expect(m).toMatchObject({ signedIn: false, admin: false });
    const e = await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", ask);
    expect(e.status).toBe(409);
    expect(await json(e)).toMatchObject({ notSignedIn: true, error: NOT_SIGNED_IN });
    expect(reached).toEqual([]);
  });

  it("keeps the sign-in and the billing with admins, lets a member through the runs (24 Oct), and answers 503 while the switch is off", async () => {
    const env = await seed();
    for (const [path, init] of [
      ["/api/studio/higgsfield/mcp/signin/start", { method: "POST" }],
      ["/api/studio/higgsfield/mcp/signout", { method: "POST" }],
      ["/api/studio/higgsfield/mcp/billing", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ billing: "cloud" }) }],
      ["/api/studio/higgsfield/mcp/models", {}],
      ["/api/studio/higgsfield/mcp/estimate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(ask) }],
      ["/api/studio/higgsfield/mcp/generate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...ask, confirm: true }) }],
    ] as [string, RequestInit][]) {
      const r = await app("member").request(path, init, env);
      const account = /signin|signout|billing/.test(path);
      expect(r.status === 403, path).toBe(account);
      if (account) expect(((await json(r)) as { error: string }).error).toMatch(/Admins only for now/);
    }
    await integrations.setIntegrationSwitch(env, "higgsfield", false);
    for (const [path, init] of [
      ["/api/studio/higgsfield/mcp/signin/start", { method: "POST" }],
      ["/api/studio/higgsfield/mcp/models", {}],
      ["/api/studio/higgsfield/mcp/estimate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(ask) }],
      ["/api/studio/higgsfield/mcp/generate", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...ask, confirm: true }) }],
    ] as [string, RequestInit][]) {
      const r = await app().request(path, init, env);
      expect(r.status, path).toBe(503);
      expect(((await json(r)) as { error: string }).error).toMatch(/switched off/);
    }
    expect(reached).toEqual([]);
  });
});

describe("the sign-in", () => {
  it("discovers the metadata, registers the client once, starts PKCE with S256, exchanges the code at the callback and stores the tokens encrypted", async () => {
    const env = await seed();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const start = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/signin/start"));
    expect(start).toMatchObject({ ok: true, mode: "redirect" });
    const u = new URL(String(start.url));
    expect(u.origin + u.pathname).toBe(`${AS}/oauth/authorize`);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cid_1");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("scope")).toBe("openid email offline_access");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("resource")).toBe(HIGGSFIELD_MCP_URL);
    expect(u.searchParams.get("prompt")).toBeNull();
    // "Use a different account" asks the provider for its sign-in screen instead of the browser's current session.
    const fresh = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/signin/start", { fresh: true }));
    const fu = new URL(String(fresh.url));
    expect(fu.searchParams.get("prompt")).toBe("login");
    expect(fu.searchParams.get("max_age")).toBe("0");
    const state = u.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    stub.state.codeChallenge = u.searchParams.get("code_challenge")!;
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET " + HIGGSFIELD_RESOURCE_METADATA, `GET ${AS}/.well-known/oauth-authorization-server`, `POST ${AS}/oauth/register`]);
    const reg = stub.calls[2].body as Record<string, unknown>;
    expect(reg).toMatchObject({ client_name: "Level Studio", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    // A second start reuses the registered client (no second registration) and a new state.
    const again = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/signin/start"));
    const u2 = new URL(String(again.url));
    expect(stub.state.registrations).toBe(1);
    expect(u2.searchParams.get("state")).not.toBe(state);
    stub.state.codeChallenge = u2.searchParams.get("code_challenge")!;

    // A callback with another state is refused without touching the token endpoint.
    const bad = await app().request(`${CALLBACK_PATH}?code=code_1&state=${state}`, {}, env);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/^\/\?higgsfield=error&reason=/);
    expect(stub.calls.some((c) => c.url === `${AS}/oauth/token`)).toBe(false);
    // A member cannot finish it.
    const notAdmin = await app("member").request(`${CALLBACK_PATH}?code=code_1&state=${u2.searchParams.get("state")}`, {}, env);
    expect(notAdmin.headers.get("location")).toMatch(/Only%20an%20admin/);

    const cb = await app().request(`${CALLBACK_PATH}?code=code_1&state=${u2.searchParams.get("state")}`, {}, env);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?higgsfield=connected");
    const exchange = stub.calls.find((c) => c.url === `${AS}/oauth/token`)!.body as Record<string, string>;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: "code_1", redirect_uri: REDIRECT, client_id: "cid_1", resource: HIGGSFIELD_MCP_URL });
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const tokens = await storedTokens(env);
    expect(tokens).toMatchObject({ access: "tok_1", refresh: "ref_2", email: "owner@test" });
    expect(tokens!.expiresAt).toBeGreaterThan(Date.now() + 3000_000);
    const raw = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(HIGGSFIELD_MCP_TOKENS_SETTING).first<{ value: string }>();
    expect(raw!.value).not.toContain("tok_1");
    expect(raw!.value).not.toContain("owner@test");
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'higgsfield_mcp_pending'").first()) ?? null).toBeNull();

    // Signed in: the status reads the balance once (cached a minute) and the billing defaults to the credits.
    const s = await json(await app().request("/api/studio/higgsfield/mcp/status", {}, env));
    expect(s).toMatchObject({ signedIn: true, email: "owner@test", plan: "Creator", credits: 1500, billing: "credits", billingChosen: false });
    await app().request("/api/studio/higgsfield/mcp/status", {}, env);
    expect(stub.rpc.filter((r) => r.name === "balance")).toHaveLength(1);
    expect(stub.rpc.map((r) => r.method).slice(0, 5)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call"]);
    const signin = ops().filter((o) => o.kind === "mcp.signin");
    expect(signin).toHaveLength(3);
    expect(updates().some((u) => u.status === "done" && /signed in \(authorization code \+ PKCE\) as owner@test/.test(u.note ?? ""))).toBe(true);
    expect(reached).toEqual([]);
  });

  it("falls back to the device flow when the redirect registration is refused, saying what was refused, and polls the token endpoint", async () => {
    const env = await seed();
    const stub = higgsfieldStub({ refuseRedirectRegistration: "redirect_uris not allowed for dynamic clients", devicePending: 1 });
    useHiggsfieldMcpFetch(stub.fn);
    const start = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/signin/start"));
    expect(start).toMatchObject({ ok: true, mode: "device", userCode: "ABCD-EFGH", verificationUri: `${AS}/activate`, interval: 5 });
    expect(String(start.refused)).toMatch(/refused to register the studio as an OAuth client with a redirect \(400\): .*redirect_uris not allowed/);
    const registrations = stub.calls.filter((c) => c.url === `${AS}/oauth/register`);
    expect(registrations).toHaveLength(2);
    expect((registrations[1].body as Record<string, unknown>).redirect_uris).toBeUndefined();
    expect((registrations[1].body as Record<string, unknown>).grant_types).toEqual(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]);
    const device = stub.calls.find((c) => c.url === `${AS}/oauth/device_authorization`)!.body as Record<string, string>;
    expect(device).toMatchObject({ client_id: "cid_1", scope: "openid email offline_access" });
    const s = await json(await app().request("/api/studio/higgsfield/mcp/status", {}, env));
    expect(s).toMatchObject({ signedIn: false, device: { userCode: "ABCD-EFGH" } });
    const first = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/signin/poll"));
    expect(first).toMatchObject({ signedIn: false, pending: true });
    const second = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/signin/poll"));
    expect(second).toMatchObject({ signedIn: true, email: "owner@test" });
    expect((stub.calls.filter((c) => c.url === `${AS}/oauth/token`).pop()!.body as Record<string, string>).grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect((await storedTokens(env))?.access).toBe("tok_1");
    expect(updates().some((u) => u.status === "done" && /device flow/.test(u.note ?? ""))).toBe(true);
    expect(reached).toEqual([]);
  });

  it("refreshes the token once on a 401 and repeats the same call once (a token refresh, never a job retry); before expiry it refreshes ahead", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub({ valid: ["tok_2"] });
    useHiggsfieldMcpFetch(stub.fn);
    const r = await json(await app().request("/api/studio/higgsfield/mcp/models", {}, env));
    expect((r.models as { id: string }[]).map((m) => m.id)).toEqual(["seedance_2_5", "kling3_0"]);
    expect(stub.rpc[0]).toMatchObject({ method: "initialize", token: "tok_1" });
    expect(stub.rpc[1]).toMatchObject({ method: "initialize", token: "tok_2" });
    expect(stub.state.refreshes).toBe(1);
    expect((stub.calls.find((c) => c.url === `${AS}/oauth/token`)!.body as Record<string, string>)).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref_1", client_id: "cid_1" });
    expect((await storedTokens(env))?.access).toBe("tok_2");
    expect(stub.rpc.filter((x) => x.name === "models_explore")).toHaveLength(1);

    // An access token about to expire is refreshed before the call, with no 401 at all.
    resetHiggsfieldMcpCaches();
    await signedIn(env, { access: "tok_old", refresh: "ref_1", expiresAt: Date.now() + 10_000 });
    const stub2 = higgsfieldStub({ valid: ["tok_2"] });
    useHiggsfieldMcpFetch(stub2.fn);
    expect((await app().request("/api/studio/higgsfield/mcp/models", {}, env)).status).toBe(200);
    expect(stub2.rpc.every((x) => x.token === "tok_2")).toBe(true);
    expect(stub2.state.refreshes).toBe(1);

    // A refresh the server refuses as invalid_grant ends the sign-in.
    resetHiggsfieldMcpCaches();
    await signedIn(env, { access: "tok_old", refresh: "ref_gone", expiresAt: Date.now() - 1 });
    useHiggsfieldMcpFetch(higgsfieldStub().fn);
    const gone = await app().request("/api/studio/higgsfield/mcp/models", {}, env);
    expect(gone.status).toBe(409);
    expect(await json(gone)).toMatchObject({ notSignedIn: true });
    expect(await storedTokens(env)).toBeNull();
    expect(reached).toEqual([]);
  });

  it("signs out: the tokens are gone, the client stays, the ledger says who", async () => {
    const env = await seed();
    await signedIn(env);
    const r = await postJson(app(), env, "/api/studio/higgsfield/mcp/signout");
    expect(r.status).toBe(200);
    expect(await storedTokens(env)).toBeNull();
    expect(await getSetting(env, HIGGSFIELD_MCP_CLIENT_SETTING)).toContain("cid_1");
    expect((await json(await app().request("/api/studio/higgsfield/mcp/status", {}, env))).signedIn).toBe(false);
    expect(ops().filter((o) => o.kind === "mcp.signout")).toMatchObject([{ status: "done", note: "signed out (owner@test)" }]);
    expect(reached).toEqual([]);
  });
});

describe("the tools", () => {
  it("maps the tools by name from tools/list and refuses clearly when one is missing, running nothing", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub({ tools: ["balance", "models_explore", "media_import_url", "generate_video", "jobs_wait"] });
    useHiggsfieldMcpFetch(stub.fn);
    const est = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", ask));
    expect(est).toMatchObject({ credits: 12, balance: 1500 });
    const r = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true });
    expect(r.status).toBe(502);
    const body = await json(r);
    expect(body.missingTool).toBe("generate_video_batch");
    expect(String(body.error)).toMatch(/lists no tool named "generate_video_batch" \(it lists 5: balance, models_explore/);
    expect(stub.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM videos").first<{ n: number }>())!.n).toBe(0);
    expect(reached).toEqual([]);
  });

  it("lists the subscription engines from models_explore, caches them, and refreshes on request", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const r = await json(await app().request("/api/studio/higgsfield/mcp/models", {}, env));
    expect(r.models).toEqual([
      { id: "seedance_2_5", name: "Seedance 2.5", description: "Natural motion", durations: [5, 10], aspects: ["9:16", "1:1", "16:9"], supportsUnlim: false },
      { id: "kling3_0", name: "Kling 3.0", description: "Cinematic", durations: [5, 10], aspects: [], supportsUnlim: true },
    ]);
    expect((stub.rpc.find((x) => x.name === "models_explore")!.args as Record<string, unknown>)).toMatchObject({ action: "list", type: "video", input: "image" });
    await app().request("/api/studio/higgsfield/mcp/models", {}, env);
    expect(stub.rpc.filter((x) => x.name === "models_explore")).toHaveLength(1);
    await app().request("/api/studio/higgsfield/mcp/models?refresh=1", {}, env);
    expect(stub.rpc.filter((x) => x.name === "models_explore")).toHaveLength(2);
    expect(reached).toEqual([]);
  });
});

describe("estimate and generate on the credits", () => {
  it("imports the picture once, asks the cost with get_cost (nothing submitted), and records the estimate in credits", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const r = await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", { ...ask, aspect: "9:16" });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ credits: 12, balance: 1500, plan: "Creator", unlimChoice: null, engine: { id: "seedance_2_5" }, mediaId: "med_1" });
    const cost = stub.rpc.find((x) => x.name === "generate_video")!.args as { params: Record<string, unknown> };
    expect(cost.params).toEqual({ model: "seedance_2_5", prompt: ask.prompt, medias: [{ value: "med_1", role: "start_image" }], duration: 5, aspect_ratio: "9:16", count: 1, get_cost: true });
    await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", { ...ask, duration: 10 });
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(1);
    expect(stub.rpc.filter((x) => x.name === "generate_video")).toHaveLength(2);
    expect(stub.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(0);
    expect(ops().filter((o) => o.kind === "mcp.estimate")).toMatchObject([{ status: "done", estimate: 12, note: expect.stringMatching(/^12 credits · Seedance 2\.5 · 5s · picture/) }, { status: "done", estimate: 12 }]);
    const bad = await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", { ...ask, duration: 7 });
    expect(bad.status).toBe(400);
    expect(((await json(bad)) as { error: string }).error).toMatch(/clips of 5, 10 seconds/);
    expect(reached).toEqual([]);
  });

  it("asks for confirmation with the credits, submits a one-item batch, then collects the job through jobs_wait into R2 with the credits reported", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const proposed = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", ask);
    expect(proposed.status).toBe(409);
    expect(await json(proposed)).toMatchObject({ needsConfirm: true, credits: 12, balance: 1500 });
    expect(stub.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(0);

    // The frame goes with the ask: this engine takes 9:16 itself (its aspect option), so the picture goes as it is and the frame is kept on the version.
    const r = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true, frame: "9:16", words: false });
    expect(r.status).toBe(200);
    const d = (await json(r)) as { video: { id: string; status: string; requestId: string; provider: string; estimate: number; version: number; model: string; frame: string; frameFill: string | null; words: boolean } };
    expect(d.video).toMatchObject({ status: "queued", requestId: "job-1", provider: MCP_PROVIDER, estimate: 12, version: 1, model: "seedance_2_5", frame: "9:16", frameFill: null, words: false });
    const batch = stub.rpc.find((x) => x.name === "generate_video_batch")!.args as { requests: { index: number; params: Record<string, unknown> }[] };
    expect(batch.requests).toEqual([{ index: 0, params: { model: "seedance_2_5", prompt: ask.prompt, medias: [{ value: "med_1", role: "start_image" }], duration: 5, count: 1 } }]);
    const row = await env.DB.prepare("SELECT provider, model, request_id, settings, op_id FROM videos WHERE id = ?").bind(d.video.id).first<{ provider: string; model: string; request_id: string; settings: string; op_id: string }>();
    expect(row).toMatchObject({ provider: MCP_PROVIDER, model: "seedance_2_5", request_id: "job-1" });
    expect(JSON.parse(row!.settings)).toMatchObject({ duration: 5, estimate: 12, credits: 12, unit: "credits", mcpModel: "seedance_2_5", estimateSource: "provider", balanceBefore: 1500, useUnlim: null, frame: "9:16", words: false });
    expect(JSON.parse(row!.settings)).not.toHaveProperty("frameFill");
    const videoOp = ops().find((o) => o.kind === "video")!;
    expect(videoOp).toMatchObject({ provider: "higgsfield", status: "confirmed", estimate: 12 });
    expect(videoOp.note).toMatch(/Seedance 2\.5 · 5s · picture · frame 9:16 · 12 credits \(subscription, MCP\) · balance before 1500/);
    expect((await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true, frame: "3:4" })).status).toBe(400);
    expect(updates()).toContainEqual(expect.objectContaining({ taskId: "job-1", status: "running" }));

    // A refreshed studio lists the post: jobs_wait says running, then completed; the mp4 lands in R2 and the balance says what it cost.
    const first = (await list(env))[0];
    expect(first).toMatchObject({ status: "generating", url: null, requestId: "job-1" });
    const wait = stub.rpc.find((x) => x.name === "jobs_wait")!.args as Record<string, unknown>;
    expect(wait).toEqual({ jobs: [{ index: 0, job_id: "job-1" }], timeout_seconds: 1 });
    const done = (await list(env))[0];
    // Finished and the first clip of the post: the client sees it without anyone selecting it.
    expect(done).toMatchObject({ status: "done", provider: MCP_PROVIDER, estimate: 12, forClient: true });
    expect(done.url).toBe(`/api/studio/posts/video/file?batch=b1&id=${done.id}`);
    const stored = await env.DB.prepare("SELECT key, settings FROM videos WHERE id = ?").bind(done.id).first<{ key: string; settings: string }>();
    expect(stored!.key).toBe(`u1/b1/video/t1/${done.id}.mp4`);
    expect(env.BUCKET.objects.get(stored!.key)!.bytes.byteLength).toBe(SAMPLE.byteLength);
    expect(JSON.parse(stored!.settings)).toMatchObject({ faststart: true, codecs: expect.arrayContaining(["avc1"]) });
    expect(updates()).toContainEqual(expect.objectContaining({ status: "done", reported: 12, note: "12 credits reported (balance 1500 → 1488)" }));
    expect(stub.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(1);
    // The Cloud API path is closed while the credits are chosen.
    const cloud = await postJson(app(), env, "/api/studio/posts/video", { batch: "b1", index: 1, model: "bytedance/seedance-2.5/image-to-video", prompt: ask.prompt, duration: 5 });
    expect(cloud.status).toBe(409);
    expect(await json(cloud)).toMatchObject({ billing: "credits", error: CREDITS_CHOSEN });
    expect(reached).toEqual([]);
  });

  it("hands the unlimited-allowance question to the admin as a 409 and never answers it; the run goes out once the admin chose", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub({ unlimOnBatch: true });
    useHiggsfieldMcpFetch(stub.fn);
    const r = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, model: "kling3_0", confirm: true });
    expect(r.status).toBe(409);
    const body = await json(r);
    expect(body.unlimChoice).toMatchObject({ model: "kling3_0", options: ["use_unlim", "credits"] });
    expect(String(body.error)).toMatch(/unlimited allowance or pay credits/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM videos").first<{ n: number }>())!.n).toBe(0);
    expect(updates()).toContainEqual(expect.objectContaining({ status: "proposed" }));
    const chosen = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, model: "kling3_0", confirm: true, useUnlim: true });
    expect(chosen.status).toBe(200);
    const batches = stub.rpc.filter((x) => x.name === "generate_video_batch").map((x) => (x.args as { requests: { params: Record<string, unknown> }[] }).requests[0].params.use_unlim);
    expect(batches).toEqual([undefined, true]);
    expect(JSON.parse((await env.DB.prepare("SELECT settings FROM videos").first<{ settings: string }>())!.settings)).toMatchObject({ useUnlim: true, mcpModel: "kling3_0" });

    // The question can also come back from the cost step: the estimate surfaces it.
    resetHiggsfieldMcpCaches();
    useHiggsfieldMcpFetch(higgsfieldStub({ unlimOnCost: true }).fn);
    const est = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", { ...ask, model: "kling3_0" }));
    expect(est.unlimChoice).toMatchObject({ options: ["use_unlim", "credits"] });
    expect(est.credits).toBeNull();
    const withChoice = await json(await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", { ...ask, model: "kling3_0", useUnlim: true }));
    expect(withChoice).toMatchObject({ credits: 0, unlimChoice: null });
    expect(reached).toEqual([]);
  });

  it("keeps the claim and the row on a transport timeout, never resubmits, and gives the unknown outcome up after half an hour", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub({ timeoutBatch: true });
    useHiggsfieldMcpFetch(stub.fn);
    const r = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true });
    expect(r.status).toBe(504);
    const body = await json(r);
    expect(body.outcomeUnknown).toBe(true);
    expect(String(body.error)).toMatch(/nothing was sent again/);
    const rows = await list(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", requestId: null, provider: MCP_PROVIDER });
    expect(updates()).toContainEqual(expect.objectContaining({ status: "running", note: expect.stringMatching(/^outcome unknown \(timeout\)/) }));
    // The same ask again within the window is a duplicate: refused before any call, so nothing goes out twice.
    const again = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true });
    expect(again.status).toBe(409);
    expect(String((await json(again)).error)).toMatch(/asked for a moment ago/);
    expect(stub.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(1);
    // Listing does not ask jobs_wait for a row without a job id; after half an hour it is given up.
    expect((await list(env))[0].status).toBe("queued");
    expect(stub.rpc.filter((x) => x.name === "jobs_wait")).toHaveLength(0);
    await env.DB.prepare("UPDATE videos SET created = created - 31 * 60 * 1000").run();
    const old = (await list(env))[0];
    expect(old.status).toBe("failed");
    expect(old.error).toMatch(/outcome was never learned/);
    expect(stub.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(1);
    expect(reached).toEqual([]);
  });

  it("keeps a failed job's message and gives a slow one up after half an hour", async () => {
    const env = await seed();
    await signedIn(env);
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "failed", error: "GPU on fire" }] }).fn);
    expect((await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true })).status).toBe(200);
    const failed = (await list(env))[0];
    expect(failed).toMatchObject({ status: "failed", error: "Generation failed on Higgsfield: GPU on fire" });
    expect(updates()).toContainEqual(expect.objectContaining({ status: "failed", note: "Generation failed on Higgsfield: GPU on fire" }));
    resetHiggsfieldMcpCaches();
    const slow = higgsfieldStub({ waits: [{ status: "queued" }] });
    useHiggsfieldMcpFetch(slow.fn);
    expect((await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, prompt: "A slow push-in on the cup", confirm: true })).status).toBe(200);
    await env.DB.prepare("UPDATE videos SET created = created - 31 * 60 * 1000 WHERE status = 'queued'").run();
    const old = (await list(env)).find((v) => v.status === "failed" && /half an hour/.test(v.error ?? ""));
    expect(old).toBeTruthy();
    expect(slow.rpc.filter((x) => x.name === "generate_video_batch")).toHaveLength(1);
    expect(reached).toEqual([]);
  });
});

describe("the billing choice", () => {
  it("routes by the choice: credits close the Cloud path, cloud closes the credits path; an admin sets it and the ledger notes it", async () => {
    const env = await seed();
    await signedIn(env);
    useHiggsfieldMcpFetch(higgsfieldStub().fn);
    expect((await json(await app().request("/api/studio/posts/video/list?batch=b1&index=1", {}, env))).billing).toBe("credits");
    const set = await postJson(app(), env, "/api/studio/higgsfield/mcp/billing", { billing: "cloud" });
    expect(await json(set)).toEqual({ ok: true, billing: "cloud" });
    expect(await getSetting(env, HIGGSFIELD_BILLING_SETTING)).toBe("cloud");
    expect(ops().filter((o) => o.kind === "mcp.billing")).toMatchObject([{ status: "done", note: "Videos billed to the Cloud API key (pay per clip)" }]);
    const mcp = await postJson(app(), env, "/api/studio/higgsfield/mcp/generate", { ...ask, confirm: true });
    expect(mcp.status).toBe(409);
    expect(await json(mcp)).toMatchObject({ billing: "cloud", error: CLOUD_CHOSEN });
    expect((await json(await app().request("/api/studio/higgsfield/mcp/status", {}, env))).billing).toBe("cloud");
    // The estimate stays available either way (it costs nothing); the Cloud path is open again (it fails only on its own missing key).
    expect((await postJson(app(), env, "/api/studio/higgsfield/mcp/estimate", ask)).status).toBe(200);
    const cloud = await postJson(app(), env, "/api/studio/posts/video", { batch: "b1", index: 1, model: "bytedance/seedance-2.5/image-to-video", prompt: ask.prompt, duration: 5 });
    expect(cloud.status).toBe(428);
    expect(String((await json(cloud)).error)).toMatch(/not connected/i);
    expect(reached).toEqual([]);
  });
});

describe("the engine list the dialog shows", () => {
  it("keeps the engines that make a clip from a picture, favourites first, and drops the tools on an existing video", () => {
    const m = (id: string, name: string) => ({ id, name, description: "", durations: [], aspects: [], supportsUnlim: false });
    const list = engineList([
      m("video_upscale", "Video Upscale"),
      m("wan_2_6", "Wan 2.6 Video"),
      m("dubbing", "dubbing"),
      m("kling3_0", "Kling v3.0"),
      m("voice_change", "voice_change"),
      m("seedance_2_5", "Seedance 2.5"),
      m("sync_lipsync_3", "Sync Lipsync 3"),
      m("ad_multiplier", "Ad Multiplier"),
      m("minimax_h3", "MiniMax H3"),
      m("cinema_studio_4", "Cinema Studio 4.0"),
      m("video_deflicker", "Video Deflicker"),
      m("draw_to_video", "Draw To Video"),
    ]);
    expect(list.map((x) => x.id)).toEqual(["seedance_2_5", "kling3_0", "minimax_h3", "wan_2_6", "cinema_studio_4"]);
  });
});
