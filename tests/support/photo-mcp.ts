/**
 * Stand-ins for the Photo studio's provider tests: a seeded month with one post and its picture, a
 * signed-in Higgsfield, and the two MCP endpoints answering as the tool descriptions say. Nothing
 * here can reach a real host: every fetch is answered in memory, and the paid-route guard fails a
 * test on any other URL.
 */
import { Hono } from "hono";
import { expect } from "vitest";
import { fakeEnv } from "./fakes";
import { postConfig } from "../../shared/config";
import type { User } from "../../shared/types";
import { StudioError } from "../../server/errors";
import { studioRoutes } from "../../server/studio";
import { HIGGSFIELD_MCP_URL } from "../../server/higgsfield-mcp";
import { MCP_URL as MAGNIFIC_URL } from "../../server/freepik-mcp";
import { setSetting, HIGGSFIELD_MCP_CLIENT_SETTING, HIGGSFIELD_MCP_TOKENS_SETTING } from "../../server/settings";

export type FakeEnv = ReturnType<typeof fakeEnv>;
export const JSON_HEADERS = { "content-type": "application/json" };
export const MAGNIFIC_TOKEN = "tok_magnific_0123456789";
/** The bytes a provider hands back as the finished picture (the test checks they land in storage, not that they decode). */
export const RESULT_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]).buffer;
export const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

export function app(role: "admin" | "member" = "admin") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: role === "admin" ? "u1" : "u2", email: `${role}@test`, name: role, role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

export const postJson = (a: ReturnType<typeof app>, env: FakeEnv, path: string, body: unknown = {}) => a.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env);
export const ops = (env: FakeEnv) => env.DB.prepare("SELECT provider, kind, status, estimate, reported, task_id, note FROM integration_ops ORDER BY created, rowid").all() as Promise<{ results: { provider: string; kind: string; status: string; estimate: number | null; reported: number | null; task_id: string | null; note: string }[] }>;

export async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "product", title: "Cup", brief: "A cup", caption: "", hashtags: "", ideaAt: 1 } as never] });
  // The member owns the month, so they may browse it; the admin sees every month.
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'cup.jpg', 'cup', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u2/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  // A PNG header the size reader understands: 1080 × 1350 (the tools that require the source size read it).
  await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 56, 0, 0, 5, 70, 8, 6, 0, 0, 0]).buffer, { httpMetadata: { contentType: "image/png" } });
  return env;
}

export async function signedInHiggsfield(env: FakeEnv) {
  await setSetting(env, HIGGSFIELD_MCP_CLIENT_SETTING, JSON.stringify({ client_id: "cid_1", issuer: "https://clerk.test", redirect_uri: "https://studio.test/cb", registered: Date.now() }));
  await setSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify({ access: "tok_1", refresh: "ref_1", expiresAt: Date.now() + 3600_000, scope: "openid email offline_access", email: "owner@test", obtained: Date.now() }));
}

export type Rpc = { method: string; name?: string; args?: Record<string, unknown> };
const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError } });

/* ───────────── Higgsfield: Soul styles, product shots, recipes, the picture tools ───────────── */

/** Soul 2.0 styles as `get_presets {source: "soul"}` might list them, with two pseudo entries the gallery must drop. */
export const SOUL_STYLES = [
  { id: "soul_film", name: "Film grain", description: "Soft film colours and a little grain.", type: "image", preview: { image_url: "https://cdn.test/soul/film.jpg" }, prompt: "film photograph, soft grain" },
  { id: "soul_editorial", name: "Editorial", description: "Magazine light, clean shadows.", type: "image", preview_url: "https://cdn.test/soul/editorial.webp" },
  { id: "all", name: "All", preview_url: "https://cdn.test/soul/all.jpg" },
  { id: "motion", name: "Motion", description: "Moving styles", type: "video", preview_url: "https://cdn.test/soul/motion.mp4" },
  { id: "soul_noimg", name: "No sample", description: "A style the answer lists with no preview." },
];
export const HERO = {
  id: "hero_shot",
  name: "Hero Shot",
  description: "The product on a marble pedestal, studio light.",
  type: "image",
  category: "product-shot",
  source: "marketing_studio",
  command: "/hero-shot",
  preview: { image_url: "https://cdn.test/presets/hero.jpg", video_url: "https://cdn.test/presets/hero.mp4" },
  price: 6,
  execution: {
    available: true,
    input_schema: { type: "object", properties: { product_image: { type: "string", format: "media", description: "The product picture" }, prompt: { type: "string", description: "A few words on the mood" } }, required: ["product_image"] },
    readiness: { ready: false, missing: ["product_image"] },
  },
};
export const PRODUCT_SHOTS = [HERO, { id: "spin_reveal", name: "Spin reveal", description: "A video of the product turning.", type: "video", category: "product-shot", preview: { video_url: "https://cdn.test/presets/spin.mp4", image_url: "https://cdn.test/presets/spin.jpg" } }, { id: "product-shot", name: "Product shot", preview_url: "https://cdn.test/presets/cat.jpg" }, { id: "no_preview", name: "No preview", description: "An entry with no sample", type: "image" }];

export interface HiggsfieldOptions {
  /** The hero preset carries no price. */
  noPrice?: boolean;
  /** What `jobs_wait` says, in order. */
  waits?: Record<string, unknown>[];
  /** `upscale_image` answers a finished result at once (a link, no job id). */
  syncUpscale?: boolean;
  /** The balance after a run, read when a job finishes. */
  balanceAfter?: number;
  /** What `show_generation_by_ids` says about a job (merged into `{job_id}`); unset: the tool answers an error. */
  shown?: Record<string, unknown>;
  /** `execute_preset` answers this prose instead of its JSON (live: "Preset submitted. Final job_ids: [...]"), flagged as an error or not. */
  presetProse?: { text: string; isError?: boolean };
}

export function higgsfieldStub(opts: HiggsfieldOptions = {}) {
  const rpc: Rpc[] = [];
  const waits = [...(opts.waits ?? [{ status: "running" }, { status: "completed", result: { url: "https://cdn.test/out.png" } }])];
  let balanceCalls = 0;
  const tools: { name: string; inputSchema: Record<string, unknown> }[] = [
    { name: "balance", inputSchema: { type: "object" } },
    { name: "media_import_url", inputSchema: { type: "object", properties: { url: {}, type: {} } } },
    { name: "jobs_wait", inputSchema: { type: "object", properties: { jobs: {}, timeout_seconds: {} } } },
    { name: "show_generation_by_ids", inputSchema: { type: "object", properties: { jobs: {} } } },
    { name: "get_presets", inputSchema: { type: "object", properties: { source: {}, category: {}, query: {}, preset_id: {}, initial_inputs: {}, limit: {} } } },
    { name: "get_preset_instructions", inputSchema: { type: "object", properties: { preset: {} } } },
    { name: "execute_preset", inputSchema: { type: "object", properties: { source: {}, preset_id: {}, inputs: {} } } },
    // The live shapes (23 Oct 2026): the picture tools nest their arguments under `params`.
    { name: "upscale_image", inputSchema: { type: "object", properties: { params: { type: "object", properties: { image_id: {}, width: {}, height: {}, resolution: {}, provider: {}, get_cost: {} }, required: ["image_id", "width", "height"] } }, required: ["params"] } },
    { name: "remove_background", inputSchema: { type: "object", properties: { params: { type: "object", properties: { media_id: {}, media_type: {} }, required: ["media_id", "media_type"] } }, required: ["params"] } },
    { name: "relight_image", inputSchema: { type: "object", properties: { media_id: {}, prompt: {}, get_cost: {} } } },
    { name: "generate_image", inputSchema: { type: "object", properties: { params: {} } } },
  ];
  const hero = opts.noPrice ? { ...HERO, price: undefined } : HERO;
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.test/out.png") return new Response(RESULT_PNG.slice(0), { status: 200, headers: { "content-type": "image/png" } });
    // A storage answer that does not say it is a picture (the bytes are one).
    if (url === "https://cdn.test/out.bin") return new Response(RESULT_PNG.slice(0), { status: 200, headers: { "content-type": "application/octet-stream" } });
    if (url !== HIGGSFIELD_MCP_URL) throw new Error(`unexpected ${url}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const b = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    rpc.push({ method: b.method, name: b.params?.name as string | undefined, args: b.params?.arguments as Record<string, unknown> | undefined });
    if ((headers.Authorization ?? "") !== "Bearer tok_1") return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
    if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "higgsfield", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "hf-sess-1" } });
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (b.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: tools.map((t) => ({ ...t, description: t.name })) } });
    if (b.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
    const name = b.params.name as string;
    const args = (b.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "balance") {
      balanceCalls++;
      return text(b.id, { credits: balanceCalls > 1 && opts.balanceAfter !== undefined ? opts.balanceAfter : 1500, plan: "Creator" });
    }
    if (name === "media_import_url") {
      expect(String(args.url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
      expect(args.type).toBe("image");
      return text(b.id, { media_id: "med_1", type: "image", status: "ready" });
    }
    if (name === "get_presets") {
      if (args.preset_id) {
        expect(args.category).toBe("all");
        const ready = args.initial_inputs ? { ready: true, missing: [] } : hero.execution.readiness;
        return text(b.id, { preset: { ...hero, execution: { ...hero.execution, readiness: ready } } });
      }
      if (args.source === "soul") return text(b.id, { presets: SOUL_STYLES });
      if (args.source === "marketing_studio") {
        expect(args.category).toBe("product-shot");
        return text(b.id, { presets: args.query ? PRODUCT_SHOTS.filter((p) => p.name.toLowerCase().includes(String(args.query).toLowerCase())) : PRODUCT_SHOTS });
      }
      return text(b.id, { presets: [] });
    }
    if (name === "get_preset_instructions") {
      if (args.preset) return text(b.id, { preset: args.preset, instructions: `How ${args.preset} works: upload the product picture, pick the mood, run.` });
      return text(b.id, { recipes: [{ command: "/hero-shot", title: "Hero shot", description: "A product picture on a pedestal in one command.", prompt: "hero shot of the product on a pedestal" }, { command: "/reel-cover", title: "Reel cover", description: "A cover picture for a reel." }, { slash: "katana/launch-day", title: "Launch day", description: "A six-shot video production." }] });
    }
    if (name === "execute_preset") {
      expect(args).toMatchObject({ source: "marketing_studio", preset_id: "hero_shot" });
      if (opts.presetProse) return text(b.id, opts.presetProse.text, !!opts.presetProse.isError);
      return text(b.id, { jobs: [{ index: 0, job_id: "job-p1", status: "queued" }] });
    }
    if (name === "upscale_image") {
      const p = args.params as Record<string, unknown>;
      expect(p).toMatchObject({ image_id: "med_1", width: 1080, height: 1350 });
      expect(args.media_id).toBeUndefined();
      if (p.get_cost) return text(b.id, { cost: 12, currency: "credits" });
      if (opts.syncUpscale) return text(b.id, { status: "completed", result: { url: "https://cdn.test/out.png" } });
      return text(b.id, { job_id: "job-up-1", status: "queued" });
    }
    if (name === "relight_image") {
      if (args.get_cost) return text(b.id, { cost: 9 });
      return text(b.id, { job_id: "job-rl-1", status: "queued" });
    }
    if (name === "remove_background") {
      const p = args.params as Record<string, unknown>;
      expect(p).toEqual({ media_id: "med_1", media_type: "image" });
      return text(b.id, { job_id: "job-bg-1", status: "queued" });
    }
    if (name === "generate_image") {
      const p = args.params as Record<string, unknown>;
      expect(p).toMatchObject({ model: "soul_2", medias: [{ value: "med_1", role: "image" }], count: 1 });
      if (p.get_cost) return text(b.id, { cost: 4 });
      return text(b.id, { jobs: [{ index: 0, job_id: "job-gen-1", status: "queued" }] });
    }
    if (name === "jobs_wait") {
      const next = waits.length > 1 ? waits.shift()! : waits[0];
      const jobs = (args.jobs as { index: number; job_id: string }[]).map((j) => ({ index: j.index, job_id: j.job_id, ...next }));
      return text(b.id, { all_terminal: next.status === "completed", results: jobs });
    }
    if (name === "show_generation_by_ids" && opts.shown) return text(b.id, { generations: (args.jobs as { job_id: string }[]).map((j) => ({ job_id: j.job_id, ...opts.shown })) });
    return text(b.id, { error: `no such tool ${name}` }, true);
  };
  return { fn, rpc };
}

/* ───────────── Magnific: the image tools, the option lists, the creations ───────────── */

export interface MagnificOptions {
  /** `simulate_cost` gives no figure. */
  noCost?: boolean;
  /** What `creations_wait` says, in order. */
  waits?: Record<string, unknown>[];
  /** The upscale presets carry no sample pictures. */
  noSamples?: boolean;
  /** What `creations_get` says about a creation (merged into `{identifier}`); unset: not listed. */
  got?: Record<string, unknown>;
}

export function magnificStub(opts: MagnificOptions = {}) {
  const rpc: Rpc[] = [];
  const puts: { url: string; bytes: number; type: string }[] = [];
  const waits = [...(opts.waits ?? [{ status: "processing" }, { status: "completed", url: "https://cdn.test/magnific/out.jpg" }])];
  /** The balance moves by the simulated figure once a tool has run. */
  let spent = 0;
  const tools: { name: string; inputSchema: Record<string, unknown> }[] = [
    { name: "simulate_cost", inputSchema: { type: "object", properties: { tool: {}, arguments: {} } } },
    { name: "account_balance", inputSchema: { type: "object", properties: {} } },
    { name: "images_models_list", inputSchema: { type: "object", properties: {} } },
    { name: "images_upscale_presets_list", inputSchema: { type: "object", properties: {} } },
    { name: "images_upscale_modes_list", inputSchema: { type: "object", properties: {} } },
    { name: "retouch_models_list", inputSchema: { type: "object", properties: {} } },
    { name: "images_upscale", inputSchema: { type: "object", properties: { imageUrl: {}, preset: {}, mode: {}, scaleFactor: {} } } },
    { name: "images_relight", inputSchema: { type: "object", properties: { creationIdentifier: {}, prompt: {} } } },
    { name: "images_remove_background", inputSchema: { type: "object", properties: { imageUrl: {} } } },
    { name: "images_replace_background", inputSchema: { type: "object", properties: { imageUrl: {}, prompt: {} } } },
    { name: "images_restyle", inputSchema: { type: "object", properties: { imageUrl: {}, prompt: {}, model: {} } } },
    { name: "creations_wait", inputSchema: { type: "object", properties: { identifiers: {}, timeoutSeconds: {} } } },
    ...(opts.got ? [{ name: "creations_get", inputSchema: { type: "object", properties: { identifier: {}, creationIdentifier: {} } } }] : []),
    { name: "creations_request_upload", inputSchema: { type: "object", properties: { fileName: {}, contentType: {}, size: {} } } },
    { name: "creations_finalize_upload", inputSchema: { type: "object", properties: { identifier: {} } } },
  ];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.test/magnific/out.jpg") return new Response(RESULT_PNG.slice(0), { status: 200, headers: { "content-type": "image/jpeg" } });
    // The separate pictures of a variations grid (`results.tiles`): JPEG bytes, a different last byte each.
    const tile = /^https:\/\/cdn\.test\/magnific\/tile(\d)\.jpg$/.exec(url);
    if (tile) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, Number(tile[1])]).buffer, { status: 200, headers: { "content-type": "image/jpeg" } });
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
    if (name === "account_balance") return text(b.id, { credits: 320 - spent });
    if (name === "images_models_list") return text(b.id, { models: [{ slug: "mystic", name: "Mystic", description: "Photoreal pictures", sample: "https://cdn.test/mg/mystic.jpg" }, { slug: "flux-video", name: "Flux video", description: "A video model" }] });
    if (name === "images_upscale_presets_list") return text(b.id, { presets: opts.noSamples ? [{ id: "portrait", name: "Portrait" }, { id: "product", name: "Product" }] : [{ id: "portrait", name: "Portrait", preview: "https://cdn.test/mg/portrait.jpg" }, { id: "product", name: "Product" }] });
    if (name === "images_upscale_modes_list") return text(b.id, { modes: [{ id: "precision", name: "Precision" }, { id: "creative", name: "Creative" }] });
    if (name === "retouch_models_list") return text(b.id, { models: [{ slug: "retouch-v2", name: "Retouch v2" }] });
    if (name === "simulate_cost") return text(b.id, opts.noCost ? "The cost could not be simulated." : { tool: args.tool, credits: args.tool === "images_upscale" ? 8 : 5, currency: "credits" });
    if (name === "images_upscale") {
      expect(String(args.imageUrl)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
      spent += 8;
      return text(b.id, { creations: [{ identifier: "cr_up_1", status: "queued" }] });
    }
    if (name === "images_relight") {
      expect(args.creationIdentifier).toBe("cr_pic_1");
      spent += 5;
      return text(b.id, { identifier: "cr_rl_1", status: "queued" });
    }
    if (name === "images_remove_background" || name === "images_replace_background" || name === "images_restyle") {
      spent += 5;
      return text(b.id, { identifier: `cr_${name}_1`, status: "queued" });
    }
    if (name === "creations_request_upload") return text(b.id, { uploadUrl: "https://upload.test/put/1", identifier: "up_1" });
    if (name === "creations_finalize_upload") return text(b.id, { creation: { identifier: "cr_pic_1", status: "ready" } });
    if (name === "creations_wait") {
      const next = waits.length > 1 ? waits.shift()! : waits[0];
      return text(b.id, { results: (args.identifiers as string[]).map((identifier) => ({ identifier, ...next })) });
    }
    if (name === "creations_get" && opts.got) return text(b.id, { creation: { identifier: args.identifier, ...opts.got } });
    return text(b.id, `no such tool ${name}`, true);
  };
  return { fn, rpc, puts };
}
