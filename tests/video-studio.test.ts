/**
 * The Video studio's provider routes beyond the gallery: Magnific's video engines (cached a day),
 * a clip made from the post's picture (`simulate_cost` → confirm → `video_generate` →
 * `creations_wait` → an mp4 version with provider `magnific`), a Magnific tool on one of our clips
 * (the clip uploaded as a creation once, then `simulate_cost` → confirm → the tool → a version),
 * Higgsfield's clip tools (a `get_cost` preflight when the schema offers one, the clip as a media
 * id or a link as the schema says, a job → a version) and the Check panel (the words kept on the
 * version; an analysis polled). Members refused, the switch, an unknown cost blocked. No call
 * leaves the test: the guard fails it on any fetch the stubs did not answer.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { HIGGSFIELD_MCP_URL, MCP_PROVIDER, resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { MCP_URL as MAGNIFIC_URL, useMcpFetch } from "../server/freepik-mcp";
import { MAGNIFIC_PROVIDER, parseCreations, parseIdentifiers, parseVideoModels, resetMagnificVideoCaches } from "../server/video-magnific";
import { setSetting, FREEPIK_MCP_TOKEN_SETTING, HIGGSFIELD_BILLING_SETTING, HIGGSFIELD_MCP_CLIENT_SETTING, HIGGSFIELD_MCP_TOKENS_SETTING } from "../server/settings";
import { setIntegrationSwitch } from "../server/integrations";

type FakeEnv = ReturnType<typeof fakeEnv>;
const JSON_HEADERS = { "content-type": "application/json" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const MAGNIFIC_TOKEN = "tok_magnific_0123456789";

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

/** A month with one post, its picture, and one finished uploaded clip (v1) to work on. */
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
  await env.DB.prepare("INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES ('v1', 'b1', 1, 't1', 'u1', 'upload', 'raw.mp4', 'done', NULL, 'u1/b1/video/t1/v1.mp4', NULL, ?, ?, 'upload', '{\"duration\":1}', 'u1/b1/output/t1/a.png', 'upload', 0, NULL)").bind(t - 1000, t - 1000).run();
  await env.BUCKET.put("u1/b1/video/t1/v1.mp4", sampleBytes(), { httpMetadata: { contentType: "video/mp4" } });
  return env;
}

async function higgsfieldSignedIn(env: FakeEnv) {
  await setSetting(env, HIGGSFIELD_MCP_CLIENT_SETTING, JSON.stringify({ client_id: "cid_1", issuer: "https://clerk.test", redirect_uri: "https://studio.test/cb", registered: Date.now() }));
  await setSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify({ access: "tok_1", refresh: "ref_1", expiresAt: Date.now() + 3600_000, scope: "openid email offline_access", email: "owner@test", obtained: Date.now() }));
  await setSetting(env, HIGGSFIELD_BILLING_SETTING, "credits");
}

/* ───────────── The Magnific MCP stand-in ───────────── */

interface MagnificOptions {
  /** `creations_upload_file` is listed and takes a `url` (else the request/finalize pair is used). */
  uploadByLink?: boolean;
  /** `simulate_cost` gives no figure. */
  noCost?: boolean;
  /** What `creations_wait` says, in order. */
  waits?: Record<string, unknown>[];
}

function magnificStub(opts: MagnificOptions = {}) {
  const rpc: { method: string; name?: string; args?: Record<string, unknown> }[] = [];
  const puts: { url: string; bytes: number; type: string }[] = [];
  const waits = [...(opts.waits ?? [{ status: "processing" }, { status: "completed", url: "https://cdn.test/magnific/out.mp4" }])];
  const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError } });
  const tools: { name: string; inputSchema: Record<string, unknown> }[] = [
    { name: "simulate_cost", inputSchema: { type: "object", properties: { tool: {}, arguments: {} } } },
    { name: "video_models_list", inputSchema: { type: "object", properties: { search: {}, onlyRecommended: {} } } },
    { name: "video_generate", inputSchema: { type: "object", properties: { slug: {}, prompt: {}, duration: {}, aspectRatio: {}, keyframes: {} } } },
    { name: "creations_wait", inputSchema: { type: "object", properties: { identifiers: {}, timeoutSeconds: {} } } },
    { name: "video_upscale", inputSchema: { type: "object", properties: { mode: {}, creationIdentifier: {}, videoUrl: {} } } },
    { name: "video_color_grade", inputSchema: { type: "object", properties: { creationIdentifier: {}, lutId: {}, intensity: {}, adjustments: {} } } },
    { name: "video_hdr", inputSchema: { type: "object", properties: { creationIdentifier: {} } } },
    { name: "video_luts_list", inputSchema: { type: "object", properties: {} } },
    { name: "creations_request_upload", inputSchema: { type: "object", properties: { fileName: {}, contentType: {}, size: {} } } },
    { name: "creations_finalize_upload", inputSchema: { type: "object", properties: { identifier: {} } } },
  ];
  if (opts.uploadByLink) tools.push({ name: "creations_upload_file", inputSchema: { type: "object", properties: { url: {}, fileName: {} } } });
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.test/magnific/out.mp4") return new Response(sampleBytes(), { status: 200, headers: { "content-type": "video/mp4" } });
    if (url === "https://upload.test/put/1") {
      puts.push({ url, bytes: (init?.body as ArrayBuffer).byteLength, type: (init?.headers as Record<string, string>)["Content-Type"] });
      return new Response(null, { status: 200 });
    }
    if (url !== MAGNIFIC_URL) throw new Error(`unexpected ${url}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${MAGNIFIC_TOKEN}`);
    const b = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    rpc.push({ method: b.method, name: b.params?.name as string | undefined, args: b.params?.arguments as Record<string, unknown> | undefined });
    if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "magnific", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "mg-sess-1" } });
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (b.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: tools.map((t) => ({ ...t, description: t.name })) } });
    if (b.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
    const name = b.params.name as string;
    const args = (b.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "video_models_list")
      return text(b.id, {
        models: [
          { slug: "kling-v2-1-master", name: "Kling 2.1 Master", description: "Cinematic motion", durations: [5, 10], aspectRatios: ["16:9", "9:16", "1:1"], agentRecommendation: "Best for product reveals" },
          { slug: "minimax-hailuo-02", name: "Hailuo 02", durations: [6, 10], aspectRatios: [] },
        ],
      });
    if (name === "video_luts_list") return text(b.id, { luts: [{ id: "lut-teal", name: "Teal & Orange" }, { id: "lut-film", name: "Film 400" }] });
    if (name === "simulate_cost") return text(b.id, opts.noCost ? "The cost could not be simulated." : { tool: args.tool, credits: args.tool === "video_generate" ? 30 : 8, currency: "credits" });
    if (name === "video_generate") return text(b.id, { creations: [{ identifier: "cr_gen_1", status: "queued" }] });
    if (name === "creations_wait") {
      const next = waits.length > 1 ? waits.shift()! : waits[0];
      return text(b.id, { results: (args.identifiers as string[]).map((identifier) => ({ identifier, ...next })) });
    }
    if (name === "creations_upload_file") return text(b.id, { creation: { identifier: "cr_up_link", status: "ready" } });
    if (name === "creations_request_upload") return text(b.id, { uploadUrl: "https://upload.test/put/1", identifier: "up_1" });
    if (name === "creations_finalize_upload") return text(b.id, { creation: { identifier: "cr_up_1", status: "ready" } });
    if (name === "video_upscale" || name === "video_color_grade" || name === "video_hdr") return text(b.id, { identifier: `cr_${name}_1`, status: "queued" });
    return text(b.id, `no such tool ${name}`, true);
  };
  return { fn, rpc, puts };
}

/* ───────────── The Higgsfield MCP stand-in: clip tools with and without a get_cost ───────────── */

function higgsfieldStub(opts: { waits?: Record<string, unknown>[]; analysisDoneAfter?: number } = {}) {
  const rpc: { method: string; name?: string; args?: Record<string, unknown> }[] = [];
  const waits = [...(opts.waits ?? [{ status: "completed", result: { url: "https://cdn.test/hf/out.mp4" } }])];
  let statusPolls = 0;
  const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError } });
  const tools: { name: string; inputSchema: Record<string, unknown> }[] = [
    { name: "balance", inputSchema: { type: "object" } },
    { name: "media_import_url", inputSchema: { type: "object", properties: { url: {}, type: {} } } },
    { name: "jobs_wait", inputSchema: { type: "object", properties: { jobs: {}, timeout_seconds: {} } } },
    { name: "upscale_video", inputSchema: { type: "object", properties: { media_id: {}, scale: {}, get_cost: {} } } },
    { name: "reframe", inputSchema: { type: "object", properties: { params: {} } } },
    { name: "virality_predictor", inputSchema: { type: "object", properties: { video_url: {}, platform: {} } } },
    { name: "video_analysis_create", inputSchema: { type: "object", properties: { media_id: {} } } },
    { name: "video_analysis_status", inputSchema: { type: "object", properties: { analysis_id: {} } } },
  ];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.test/hf/out.mp4") return new Response(sampleBytes(), { status: 200, headers: { "content-type": "video/mp4" } });
    if (url !== HIGGSFIELD_MCP_URL) throw new Error(`unexpected ${url}`);
    const b = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    rpc.push({ method: b.method, name: b.params?.name as string | undefined, args: b.params?.arguments as Record<string, unknown> | undefined });
    if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "higgsfield", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "hf-sess-1" } });
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (b.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: tools.map((t) => ({ ...t, description: t.name })) } });
    if (b.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
    const name = b.params.name as string;
    const args = (b.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "balance") return text(b.id, { credits: 900, plan: "Creator" });
    if (name === "media_import_url") {
      expect(args.type).toBe("video");
      expect(String(args.url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
      return text(b.id, { media_id: "vid_med_1" });
    }
    if (name === "upscale_video") {
      expect(args.media_id).toBe("vid_med_1");
      if (args.get_cost) return text(b.id, { cost: 15, currency: "credits" });
      return text(b.id, { job_id: "job-up-1", status: "queued" });
    }
    if (name === "virality_predictor") {
      expect(String(args.video_url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
      return text(b.id, "Hook strength: strong in the first second. Attention holds to 0:04; retention risk at the pack shot. Audience: 25–34.");
    }
    if (name === "video_analysis_create") return text(b.id, { analysis_id: "an_1", status: "pending" });
    if (name === "video_analysis_status") {
      statusPolls++;
      return statusPolls >= (opts.analysisDoneAfter ?? 2) ? text(b.id, { analysis_id: "an_1", status: "completed", summary: "A calm product clip; the logo appears late." }) : text(b.id, { analysis_id: "an_1", status: "running" });
    }
    if (name === "jobs_wait") {
      const next = waits.length > 1 ? waits.shift()! : waits[0];
      return text(b.id, { all_terminal: true, results: (args.jobs as { index: number; job_id: string }[]).map((j) => ({ ...j, ...next })) });
    }
    return text(b.id, `no such tool ${name}`, true);
  };
  return { fn, rpc };
}

const postJson = (a: ReturnType<typeof app>, env: FakeEnv, path: string, body: unknown = {}) => a.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env);
const ops = (env: FakeEnv) => env.DB.prepare("SELECT provider, kind, status, estimate, reported, task_id, note FROM integration_ops ORDER BY created, rowid").all() as Promise<{ results: { provider: string; kind: string; status: string; estimate: number | null; reported: number | null; task_id: string | null; note: string }[] }>;
type Listed = { id: string; status: string; url: string | null; requestId: string | null; provider: string; estimate: number | null; label: string | null; error: string | null; check: { tool: string; text: string } | null; analysis: { id: string; status: string; text: string } | null; forClient: boolean; frame: string | null; frameFill: string | null; words: boolean | null };
const listVideos = async (env: FakeEnv) => ((await json(await app().request("/api/studio/posts/video/list?batch=b1&index=1", {}, env))) as { videos: Listed[] }).videos;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useMcpFetch(null);
  useHiggsfieldMcpFetch(null);
  resetHiggsfieldMcpCaches();
  resetMagnificVideoCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useMcpFetch(null);
  useHiggsfieldMcpFetch(null);
});

describe("Magnific: reading the answers", () => {
  it("reads engines, creation identifiers and wait results of several shapes", () => {
    const models = parseVideoModels({ content: [{ type: "text", text: JSON.stringify({ models: [{ slug: "kling", name: "Kling", durations: ["5s", "10s"], aspect_ratios: ["9:16"], recommended: true }, { slug: "bad slug!" }] }) }] });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ slug: "kling", durations: [5, 10], aspectRatios: ["9:16"], recommended: true });
    expect(parseIdentifiers({ content: [{ type: "text", text: JSON.stringify({ identifiers: ["a1b2c3", { identifier: "d4e5f6" }] }) }] })).toEqual(["a1b2c3", "d4e5f6"]);
    expect(parseIdentifiers({ content: [{ type: "text", text: "Queued creation with identifier 9f8e7d6c" }] })).toEqual(["9f8e7d6c"]);
    const done = parseCreations({ content: [{ type: "text", text: JSON.stringify([{ identifier: "x1", status: "completed", files: [{ url: "https://cdn.test/a.mp4" }] }, { identifier: "x2", status: "failed", error: "nsfw" }]) }] });
    expect(done).toEqual([
      { identifier: "x1", status: "completed", url: "https://cdn.test/a.mp4", error: null },
      { identifier: "x2", status: "failed", url: null, error: "nsfw" },
    ]);
  });
});

describe("Magnific: status, engines, a clip from the picture", () => {
  it("says Not connected to everyone, the team included (24 Oct), with no call", async () => {
    const env = await seed();
    expect(await json(await app("member").request("/api/studio/video/magnific/status", {}, env))).toMatchObject({ connected: false, admin: true, access: { admin: true } });
    const models = await app().request("/api/studio/video/magnific/models", {}, env);
    expect(models.status).toBe(409);
    expect(await json(models)).toMatchObject({ connected: false });
    const member = await app("member").request("/api/studio/video/magnific/models", {}, env);
    expect(member.status).toBe(409);
  });

  it("lists the engines once a day, then makes a clip from the picture after the simulated cost is confirmed, and collects it", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const m = (await json(await app().request("/api/studio/video/magnific/models", {}, env))) as { models: { slug: string; recommended: boolean; recommendation: string; durations: number[] }[] };
    expect(m.models.map((x) => x.slug)).toEqual(["kling-v2-1-master", "minimax-hailuo-02"]);
    expect(m.models[0]).toMatchObject({ recommended: true, recommendation: "Best for product reveals", durations: [5, 10] });
    await app().request("/api/studio/video/magnific/models", {}, env);
    expect(stub.rpc.filter((x) => x.name === "video_models_list")).toHaveLength(1);
    await app().request("/api/studio/video/magnific/models?refresh=1", {}, env);
    expect(stub.rpc.filter((x) => x.name === "video_models_list")).toHaveLength(2);
    const luts = (await json(await app().request("/api/studio/video/magnific/luts", {}, env))) as { luts: { id: string; name: string }[] };
    expect(luts.luts).toEqual([
      { id: "lut-teal", name: "Teal & Orange" },
      { id: "lut-film", name: "Film 400" },
    ]);

    // The frame: Kling takes 9:16 itself (its aspect option), so the frame travels as `aspectRatio` and is kept on the version.
    const ask = { batch: "b1", index: 1, slug: "kling-v2-1-master", prompt: "The cup turns slowly", duration: 5, aspectRatio: "9:16", frame: "9:16", words: false };
    const wrongLength = await postJson(app(), env, "/api/studio/video/magnific/generate", { ...ask, duration: 7 });
    expect(wrongLength.status).toBe(400);
    const first = await postJson(app(), env, "/api/studio/video/magnific/generate", ask);
    expect(first.status).toBe(409);
    expect(await json(first)).toMatchObject({ needsConfirm: true, estimate: 30 });
    const sim = stub.rpc.find((x) => x.name === "simulate_cost")!;
    expect(sim.args?.tool).toBe("video_generate");
    const simArgs = sim.args?.arguments as Record<string, unknown>;
    expect(simArgs).toMatchObject({ slug: "kling-v2-1-master", prompt: "The cup turns slowly", duration: 5, aspectRatio: "9:16" });
    expect(String((simArgs.keyframes as { start: { type: string; url: string } }).start.url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
    expect((simArgs.keyframes as { start: { type: string } }).start.type).toBe("image");
    expect(stub.rpc.filter((x) => x.name === "video_generate")).toHaveLength(0);

    const go = (await json(await postJson(app(), env, "/api/studio/video/magnific/generate", { ...ask, confirm: true }))) as { video: Listed };
    expect(go.video).toMatchObject({ status: "queued", provider: MAGNIFIC_PROVIDER, requestId: "cr_gen_1", estimate: 30, label: "Magnific · Kling 2.1 Master", frame: "9:16", frameFill: null, words: false });
    expect(JSON.parse((await env.DB.prepare("SELECT settings FROM videos WHERE id = ?").bind(go.video.id).first<{ settings: string }>())!.settings)).toMatchObject({ frame: "9:16", words: false, aspect: "9:16" });
    const gen = stub.rpc.filter((x) => x.name === "video_generate");
    expect(gen).toHaveLength(1);
    expect(gen[0].args).toMatchObject({ slug: "kling-v2-1-master", duration: 5 });
    const twice = await postJson(app(), env, "/api/studio/video/magnific/generate", { ...ask, confirm: true });
    expect(twice.status).toBe(409);
    // The list polls with creations_wait: processing, then done and stored.
    let vids = await listVideos(env);
    expect(vids[0]).toMatchObject({ status: "generating" });
    expect(stub.rpc.filter((x) => x.name === "creations_wait").at(-1)?.args).toEqual({ identifiers: ["cr_gen_1"], timeoutSeconds: 1 });
    vids = await listVideos(env);
    // Done, and the client's version at once: the seeded upload was never selected, so the post had none.
    expect(vids[0]).toMatchObject({ status: "done", provider: MAGNIFIC_PROVIDER, forClient: true });
    expect((await (await app().request(vids[0].url!, {}, env)).arrayBuffer()).byteLength).toBe(sampleBytes().byteLength);
    const genOps = (await ops(env)).results.filter((o) => o.kind === "video.generate");
    expect(genOps).toHaveLength(1);
    expect(genOps[0]).toMatchObject({ provider: "freepik", status: "done", estimate: 30, reported: 30, task_id: "cr_gen_1" });
  });

  it("blocks a clip whose cost cannot be simulated, and answers 503 while the Freepik switch is off", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub({ noCost: true });
    useMcpFetch(stub.fn);
    const r = await postJson(app(), env, "/api/studio/video/magnific/generate", { batch: "b1", index: 1, slug: "kling-v2-1-master", prompt: "x", duration: 5, confirm: true });
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ blocked: true });
    expect(stub.rpc.filter((x) => x.name === "video_generate")).toHaveLength(0);
    expect((await ops(env)).results.filter((o) => o.kind === "video.generate")[0]).toMatchObject({ status: "refused", estimate: null });
    await setIntegrationSwitch(env, "freepik", false);
    const off = await postJson(app(), env, "/api/studio/video/magnific/generate", { batch: "b1", index: 1, slug: "kling-v2-1-master", prompt: "x", duration: 5, confirm: true });
    expect(off.status).toBe(503);
    expect(await listVideos(env)).toHaveLength(1);
  });
});

describe("Magnific: a tool on one of our clips", () => {
  const enhance = (env: FakeEnv, body: Record<string, unknown>, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/video/magnific/enhance", { batch: "b1", videoId: "v1", ...body });

  it("uploads the clip as a creation once (request → PUT → finalize), simulates, confirms, runs the tool and collects the new version", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    expect((await enhance(env, { tool: "video_zoom", arguments: {} })).status).toBe(400);
    const ask = await enhance(env, { tool: "video_hdr", arguments: {} });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, estimate: 8 });
    // The clip went up once, as our bytes, and the creation id is remembered on the version.
    expect(stub.rpc.filter((x) => x.name === "creations_request_upload")).toHaveLength(1);
    expect(stub.rpc.find((x) => x.name === "creations_request_upload")?.args).toMatchObject({ contentType: "video/mp4", size: sampleBytes().byteLength });
    expect(stub.puts).toEqual([{ url: "https://upload.test/put/1", bytes: sampleBytes().byteLength, type: "video/mp4" }]);
    expect(stub.rpc.find((x) => x.name === "creations_finalize_upload")?.args).toMatchObject({ identifier: "up_1" });
    const v1 = await env.DB.prepare("SELECT settings FROM videos WHERE id = 'v1'").first<{ settings: string }>();
    expect(JSON.parse(v1!.settings).magnificCreation).toBe("cr_up_1");
    expect(stub.rpc.find((x) => x.name === "simulate_cost")?.args).toEqual({ tool: "video_hdr", arguments: { creationIdentifier: "cr_up_1" } });
    expect(stub.rpc.filter((x) => x.name === "video_hdr")).toHaveLength(0);

    const go = (await json(await enhance(env, { tool: "video_hdr", arguments: {}, confirm: true }))) as { video: Listed };
    expect(go.video).toMatchObject({ status: "queued", provider: MAGNIFIC_PROVIDER, requestId: "cr_video_hdr_1", estimate: 8, label: "HDR (Magnific) of an earlier version" });
    expect(stub.rpc.filter((x) => x.name === "creations_request_upload")).toHaveLength(1);
    expect(stub.rpc.find((x) => x.name === "video_hdr")?.args).toEqual({ creationIdentifier: "cr_up_1" });
    const row = await env.DB.prepare("SELECT settings, source, poster_key FROM videos WHERE id = ?").bind(go.video.id).first<{ settings: string; source: string; poster_key: string }>();
    expect(JSON.parse(row!.settings).enhance).toMatchObject({ tool: "video_hdr", label: "HDR", from: "v1" });
    expect(row!.source).toBe("upload");
    // A colour grade with a LUT passes the LUT and the intensity; the upscale with a mode passes the mode (and the identifiers the client sends are dropped).
    const grade = await enhance(env, { tool: "video_color_grade", arguments: { lutId: "lut-teal", intensity: 0.6, creationIdentifier: "spoofed" }, confirm: true });
    expect(grade.status).toBe(200);
    expect(stub.rpc.find((x) => x.name === "video_color_grade")?.args).toEqual({ lutId: "lut-teal", intensity: 0.6, creationIdentifier: "cr_up_1" });
    await enhance(env, { tool: "video_upscale", arguments: { mode: "magnific_precision" }, confirm: true });
    expect(stub.rpc.find((x) => x.name === "video_upscale")?.args).toEqual({ mode: "magnific_precision", creationIdentifier: "cr_up_1" });
    let vids = await listVideos(env);
    expect(vids.filter((v) => v.provider === MAGNIFIC_PROVIDER)).toHaveLength(3);
    vids = await listVideos(env);
    expect(vids.filter((v) => v.provider === MAGNIFIC_PROVIDER).every((v) => v.status === "done")).toBe(true);
    const enhanceOps = (await ops(env)).results.filter((o) => o.kind === "video.enhance");
    expect(enhanceOps).toHaveLength(3);
    expect(enhanceOps.every((o) => o.provider === "freepik" && o.status === "done" && o.estimate === 8)).toBe(true);
  });

  it("hands the clip over by link when the server lists creations_upload_file with a url", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub({ uploadByLink: true });
    useMcpFetch(stub.fn);
    const go = await enhance(env, { tool: "video_hdr", arguments: {}, confirm: true });
    expect(go.status).toBe(200);
    expect(stub.rpc.filter((x) => x.name === "creations_request_upload")).toHaveLength(0);
    expect(stub.puts).toEqual([]);
    const up = stub.rpc.find((x) => x.name === "creations_upload_file")!;
    expect(String(up.args?.url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
    expect(stub.rpc.find((x) => x.name === "video_hdr")?.args).toEqual({ creationIdentifier: "cr_up_link" });
  });
});

describe("Higgsfield: tools on a clip and the Check panel", () => {
  const tool = (env: FakeEnv, body: Record<string, unknown>, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/video/higgsfield/tool", { batch: "b1", videoId: "v1", ...body });
  const check = (env: FakeEnv, body: Record<string, unknown>, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/video/higgsfield/check", { batch: "b1", videoId: "v1", ...body });

  it("lists which tools the plan offers, and says so before the sign-in without a call", async () => {
    const env = await seed();
    const before = (await json(await app("member").request("/api/studio/video/higgsfield/tools", {}, env))) as { signedIn: boolean; reason: string; available: Record<string, boolean> };
    expect(before.signedIn).toBe(false);
    expect(before.reason).toMatch(/Not signed in/);
    expect(Object.values(before.available).every((v) => v === false)).toBe(true);
    await higgsfieldSignedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const after = (await json(await app("member").request("/api/studio/video/higgsfield/tools", {}, env))) as { available: Record<string, boolean>; tools: { name: string; available: boolean }[]; checks: { name: string; available: boolean }[]; admin: boolean };
    expect(after.admin).toBe(true);
    expect(after.available).toMatchObject({ upscale_video: true, reframe: true, remove_background: false, virality_predictor: true, video_analysis_create: true });
    expect(after.tools.find((t) => t.name === "remove_background")?.available).toBe(false);
    expect(after.checks.every((c) => c.available)).toBe(true);
  });

  it("imports the clip as a video media, asks get_cost when the tool offers it, confirms, and the job becomes a version", async () => {
    const env = await seed();
    await higgsfieldSignedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const ask = await tool(env, { tool: "upscale_video", arguments: { scale: 2 } });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 15, balance: 900 });
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(1);
    const pre = stub.rpc.filter((x) => x.name === "upscale_video");
    expect(pre).toHaveLength(1);
    expect(pre[0].args).toEqual({ media_id: "vid_med_1", scale: 2, get_cost: true });
    const go = (await json(await tool(env, { tool: "upscale_video", arguments: { scale: 2 }, confirm: true }))) as { video: Listed };
    expect(go.video).toMatchObject({ status: "queued", provider: MCP_PROVIDER, requestId: "job-up-1", estimate: 15, label: "Upscale (Higgsfield) of an earlier version" });
    expect(stub.rpc.filter((x) => x.name === "upscale_video").at(-1)?.args).toEqual({ media_id: "vid_med_1", scale: 2 });
    // The media import is cached per clip: one import for the preflight and the run.
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(1);
    const vids = await listVideos(env);
    expect(vids[0]).toMatchObject({ status: "done", provider: MCP_PROVIDER, label: "Upscale (Higgsfield) of an earlier version" });
    const enhanceOps = (await ops(env)).results.filter((o) => o.kind === "video.enhance");
    expect(enhanceOps[0]).toMatchObject({ provider: "higgsfield", status: "done", estimate: 15, task_id: "job-up-1" });
    // A tool with no get_cost in its schema is "cost not known" until confirmed; the Cloud billing refuses everything.
    const noCost = await tool(env, { tool: "reframe", arguments: { aspect_ratio: "1:1" } });
    expect(noCost.status).toBe(409);
    expect(await json(noCost)).toMatchObject({ needsEstimate: true, tool: "reframe" });
    await setSetting(env, HIGGSFIELD_BILLING_SETTING, "cloud");
    expect((await tool(env, { tool: "reframe", arguments: { aspect_ratio: "1:1" }, confirm: true })).status).toBe(409);
  });

  it("runs the virality check with the clip as a link, keeps the words on the version, and polls an analysis to its answer", async () => {
    const env = await seed();
    await higgsfieldSignedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const ask = await check(env, { tool: "virality_predictor" });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsEstimate: true });
    expect(stub.rpc.filter((x) => x.name === "virality_predictor")).toHaveLength(0);
    const go = (await json(await check(env, { tool: "virality_predictor", confirm: true }))) as { video: Listed };
    expect(go.video.id).toBe("v1");
    expect(go.video.check).toMatchObject({ tool: "virality_predictor" });
    expect(go.video.check!.text).toMatch(/Hook strength/);
    // The tool takes a link, so no media import was made for it.
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(0);
    const notOffered = await check(env, { tool: "remove_background", confirm: true });
    expect(notOffered.status).toBe(400);
    const analysis = (await json(await check(env, { tool: "video_analysis_create", confirm: true }))) as { video: Listed };
    expect(analysis.video.analysis).toMatchObject({ id: "an_1", status: "running" });
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(1);
    const poll1 = (await json(await app().request("/api/studio/video/higgsfield/check/status?batch=b1&videoId=v1", {}, env))) as { video: Listed };
    expect(poll1.video.analysis?.status).toBe("running");
    const poll2 = (await json(await app().request("/api/studio/video/higgsfield/check/status?batch=b1&videoId=v1", {}, env))) as { video: Listed };
    expect(poll2.video.analysis?.status).toBe("done");
    expect(poll2.video.analysis?.text).toMatch(/calm product clip/);
    expect(stub.rpc.find((x) => x.name === "video_analysis_status")?.args).toEqual({ analysis_id: "an_1" });
    const checkOps = (await ops(env)).results.filter((o) => o.kind === "video.check");
    expect(checkOps.map((o) => o.status)).toEqual(["done", "done"]);
  });
});
