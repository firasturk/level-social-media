/**
 * The Video studio's preset gallery (server/video-presets.ts) against a stand-in for the Higgsfield
 * MCP that answers as the tool descriptions say: the cards normalised (reference video, poster,
 * command, needs, price), the categories mapped to `get_presets` asks and the recipes to
 * `get_preset_instructions`, a day's cache in an encrypted settings row with `?refresh=1`, members
 * browsing and refused to run, a run that needs the confirm (a known price, or "cost not known"),
 * `execute_preset` → job ids → `jobs_wait` → the mp4 in R2 as a `higgsfield-mcp` version with the
 * preset noted, the billing choice and the switch. No call leaves the test: the guard fails it on
 * any fetch the stub did not answer.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { dropReason, isVideoFromPictureRecipe, PRESET_CATEGORIES } from "../shared/video-presets";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { HIGGSFIELD_MCP_URL, MCP_PROVIDER, NOT_SIGNED_IN, resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { cacheKey, mediaOf, needsOf, parsePresets, parseRecipes, resetPresetCaches } from "../server/video-presets";
import { getSetting, setSetting, HIGGSFIELD_BILLING_SETTING, HIGGSFIELD_MCP_CLIENT_SETTING, HIGGSFIELD_MCP_TOKENS_SETTING } from "../server/settings";
import { setIntegrationSwitch } from "../server/integrations";

type FakeEnv = ReturnType<typeof fakeEnv>;
const JSON_HEADERS = { "content-type": "application/json" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

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
  // The member owns the month, so they may browse it; the admin sees every month.
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'cup.jpg', 'cup', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u2/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer, { httpMetadata: { contentType: "image/png" } });
  return env;
}

/** A signed-in studio on the subscription credits. */
async function signedIn(env: FakeEnv) {
  await setSetting(env, HIGGSFIELD_MCP_CLIENT_SETTING, JSON.stringify({ client_id: "cid_1", issuer: "https://clerk.test", redirect_uri: "https://studio.test/cb", registered: Date.now() }));
  await setSetting(env, HIGGSFIELD_MCP_TOKENS_SETTING, JSON.stringify({ access: "tok_1", refresh: "ref_1", expiresAt: Date.now() + 3600_000, scope: "openid email offline_access", email: "owner@test", obtained: Date.now() }));
  await setSetting(env, HIGGSFIELD_BILLING_SETTING, "credits");
}

/** Presets shaped as the `get_presets` description says: an id, a name, a description, a type, a category, a preview, the slash command, and for a detail the execution block. */
const HERO = {
  id: "hero_shot",
  name: "Hero Shot",
  description: "A cinematic reveal of the product on a turning pedestal.",
  type: "product",
  category: "product-shot",
  source: "marketing_studio",
  command: "/hero-shot",
  preview: { video_url: "https://cdn.test/presets/hero.mp4", image_url: "https://cdn.test/presets/hero.jpg" },
  price: 20,
  execution: {
    available: true,
    input_schema: { type: "object", properties: { product_image: { type: "string", format: "media", description: "The product picture" }, prompt: { type: "string", description: "A few words on the mood" } }, required: ["product_image"] },
    readiness: { ready: false, missing: ["product_image"] },
  },
};
const GLITCH = { id: "glitch", name: "Glitch Pop", description: "A viral glitch effect.", type: "effect", category: "viral", preview_url: "https://cdn.test/presets/glitch.mp4", thumbnail: "https://cdn.test/presets/glitch.png", execution: { available: true, input_schema: { type: "object", properties: { image: { type: "array", items: { type: "media" }, minItems: 2 } }, required: ["image"] } } };
const KATANA = { slug: "launch-day", title: "Launch day", description: "A six-shot product launch story.", type: "production", previews: [{ type: "video", url: "https://cdn.test/katana/launch" }] };

interface StubOptions {
  /** `get_presets` answers nothing for these sources. */
  emptyFor?: string[];
  /** The hero preset carries no price. */
  noPrice?: boolean;
  /** What `jobs_wait` says, in order. */
  waits?: Record<string, unknown>[];
}

/** The Higgsfield MCP endpoint answering as the tool descriptions say. */
function higgsfieldStub(opts: StubOptions = {}) {
  const rpc: { method: string; name?: string; args?: Record<string, unknown> }[] = [];
  const waits = [...(opts.waits ?? [{ status: "running" }, { status: "completed", result: { url: "https://cdn.test/out.mp4" } }])];
  const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body) }], isError } });
  const tools = ["balance", "models_explore", "media_import_url", "generate_video", "generate_video_batch", "jobs_wait", "show_generation_by_ids", "get_presets", "get_preset_instructions", "execute_preset"];
  const hero = opts.noPrice ? { ...HERO, price: undefined } : HERO;
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.test/out.mp4") return new Response(sampleBytes(), { status: 200, headers: { "content-type": "video/mp4" } });
    if (url !== HIGGSFIELD_MCP_URL) throw new Error(`unexpected ${url}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const b = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    rpc.push({ method: b.method, name: b.params?.name as string | undefined, args: b.params?.arguments as Record<string, unknown> | undefined });
    if ((headers.Authorization ?? "") !== "Bearer tok_1") return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
    if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "higgsfield", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "hf-sess-1" } });
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (b.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } });
    if (b.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } });
    const name = b.params.name as string;
    const args = (b.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "balance") return text(b.id, { credits: 1500, plan: "Creator" });
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
      const source = String(args.source ?? "");
      if (opts.emptyFor?.includes(source || "combined")) return text(b.id, { presets: [], next_cursor: null });
      if (source === "katana") {
        expect(args.katana_source).toBe("higgsfield");
        return text(b.id, { items: [KATANA] });
      }
      if (source === "marketing_studio") return text(b.id, { presets: args.category === "ads" ? [{ ...hero, id: "ad_hook", name: "Ad hook", category: "ads" }] : [hero], next_cursor: args.cursor ? null : "page-2" });
      if (source === "viral") return text(b.id, { presets: [GLITCH] });
      // The combined feed: both, with a page cursor.
      return text(b.id, { presets: [hero, GLITCH], next_cursor: "page-2" });
    }
    if (name === "get_preset_instructions") {
      if (args.preset) return text(b.id, { preset: args.preset, instructions: `How ${args.preset} works: upload the product picture, pick the mood, run.`, reference_video: "https://cdn.test/presets/hero-ref.mp4" });
      // Two recipes that make a video from a picture, and the kinds Firas saw that are not the Video studio's (dropped).
      return text(b.id, {
        recipes: [
          { command: "/hero-shot", title: "Hero shot", description: "A product reveal clip from one picture, in one command." },
          { slash: "katana/launch-day", title: "Launch day", description: "A six-shot video production from the product pictures." },
          { command: "/cartoon-shaders", title: "Cartoon shaders", description: "Toon shaders for Blender scenes." },
          { command: "/color-grading", title: "Color grading", description: "DaVinci Resolve colour grading of your footage." },
          { command: "/create-website", title: "Create website", description: "Build and deploy a website for the brand." },
          { command: "/build-ai-influencer", title: "Build AI influencer", description: "A character sheet and voice for an AI influencer." },
          { command: "/exploded-view", title: "Exploded view", description: "An exploded view render of a product." },
          { command: "/faceless", title: "Faceless", description: "A faceless video from your script and a voice." },
        ],
      });
    }
    if (name === "execute_preset") {
      expect(args).toMatchObject({ source: "marketing_studio", preset_id: "hero_shot" });
      return text(b.id, { jobs: [{ index: 0, job_id: "job-p1", status: "queued" }, { index: 1, job_id: "job-p2", status: "queued" }] });
    }
    if (name === "jobs_wait") {
      const next = waits.length > 1 ? waits.shift()! : waits[0];
      const jobs = (args.jobs as { index: number; job_id: string }[]).map((j) => ({ index: j.index, job_id: j.job_id, ...next }));
      return text(b.id, { all_terminal: next.status === "completed", results: jobs });
    }
    return text(b.id, { error: `no such tool ${name}` }, true);
  };
  return { fn, rpc };
}

const browse = (env: FakeEnv, qs: string, role: "admin" | "member" = "member") => app(role).request(`/api/studio/video/presets?${qs}`, {}, env);
const postJson = (a: ReturnType<typeof app>, env: FakeEnv, path: string, body: unknown = {}) => a.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env);
const ops = (env: FakeEnv) => env.DB.prepare("SELECT kind, status, estimate, reported, task_id, note FROM integration_ops ORDER BY created, rowid").all() as Promise<{ results: { kind: string; status: string; estimate: number | null; reported: number | null; task_id: string | null; note: string }[] }>;
const listVideos = async (env: FakeEnv) => ((await json(await app().request("/api/studio/posts/video/list?batch=b1&index=1", {}, env))) as { videos: { id: string; status: string; url: string | null; requestId: string | null; provider: string; estimate: number | null; label: string | null; error: string | null }[] }).videos;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  resetHiggsfieldMcpCaches();
  resetPresetCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useHiggsfieldMcpFetch(null);
});

describe("normalising the answers", () => {
  it("reads the reference video, the poster, the command, the needs and the price from a preset object", () => {
    const cards = parsePresets({ content: [{ type: "text", text: JSON.stringify({ presets: [HERO, GLITCH, KATANA] }) }] }, "viral");
    expect(cards.map((c) => c.id)).toEqual(["hero_shot", "glitch", "launch-day"]);
    expect(cards[0]).toMatchObject({ source: "marketing_studio", title: "Hero Shot", command: "/hero-shot", category: "product-shot", video: "https://cdn.test/presets/hero.mp4", poster: "https://cdn.test/presets/hero.jpg", price: 20, needs: ["1 product picture"], runnable: true });
    expect(cards[1]).toMatchObject({ source: "viral", video: "https://cdn.test/presets/glitch.mp4", poster: "https://cdn.test/presets/glitch.png", price: null, needs: ["2 pictures"], runnable: true, command: null });
    // A bare CDN link under a video-typed preview is the reference video; a Katana item is not runnable from here.
    expect(cards[2]).toMatchObject({ source: "viral", video: "https://cdn.test/katana/launch", poster: null, runnable: true });
    expect(parsePresets({ content: [{ type: "text", text: JSON.stringify({ items: [KATANA] }) }] }, "katana")[0].runnable).toBe(false);
  });

  it("tells pictures, clips and words apart in a schema, and reads previews of several shapes", () => {
    expect(needsOf({ properties: { video: { type: "string", format: "media" }, idea: { type: "string" }, count: { type: "integer" } }, required: ["video", "idea", "count"] })).toEqual(["a video clip", "a few words of prompt", "count"]);
    expect(needsOf([{ name: "reference_image", type: "image", required: true }, { name: "style", type: "string", required: false }])).toEqual(["1 product picture"]);
    expect(mediaOf({ media: [{ type: "image", url: "https://x.test/a.webp" }, { type: "video", url: "https://x.test/a" }] })).toEqual({ video: "https://x.test/a", poster: "https://x.test/a.webp" });
    expect(mediaOf({ video: { url: "https://x.test/v.mp4" }, poster: "https://x.test/p.jpg" })).toEqual({ video: "https://x.test/v.mp4", poster: "https://x.test/p.jpg" });
    expect(mediaOf({ name: "no media" })).toEqual({ video: null, poster: null });
  });

  it("reads recipes from a list of commands or from lines of text, keeping only the ones that make a video from a picture", () => {
    const fromList = parseRecipes({ content: [{ type: "text", text: JSON.stringify({ recipes: [{ command: "hero-shot", title: "Hero shot", description: "A product reveal clip from the picture." }] }) }] });
    expect(fromList).toHaveLength(1);
    expect(fromList[0]).toMatchObject({ id: "/hero-shot", command: "/hero-shot", source: "recipe", runnable: false, title: "Hero shot", output: "video" });
    const fromText = parseRecipes({ content: [{ type: "text", text: "Recipes:\n- /hero-shot — A product reveal clip from one picture\n- `/katana/launch-day`: Six video shots with a story from the product pictures\n- /2d-character — A 2D character sheet\n- /3d-jutsu — New camera angles of a 3D scene\n- /ads-studio — Ad copy and layouts for a brand\n- /destruction-studio — Blender destruction simulations in video\nNothing else." }] });
    expect(fromText.map((c) => [c.command, c.description])).toEqual([
      ["/hero-shot", "A product reveal clip from one picture"],
      ["/katana/launch-day", "Six video shots with a story from the product pictures"],
    ]);
    // Each dropped shape: no video words; another tool named; a video with no picture to start from; the provider's own "not runnable".
    expect(isVideoFromPictureRecipe("/cartoon-shaders Cartoon shaders for Blender scenes")).toBe(false);
    expect(isVideoFromPictureRecipe("/color-grading DaVinci colour grading of your footage")).toBe(false);
    expect(isVideoFromPictureRecipe("/create-website Build a website with a video hero from your pictures")).toBe(false);
    expect(isVideoFromPictureRecipe("/faceless A faceless video from your script and a voice")).toBe(false);
    expect(isVideoFromPictureRecipe("/turntable A turntable clip", { runnable: false })).toBe(false);
    // Kept: the words say video and a picture, or the inputs name an image.
    expect(isVideoFromPictureRecipe("/turntable A slow turntable clip of the product picture")).toBe(true);
    expect(isVideoFromPictureRecipe("/reveal A cinematic reveal video", { inputs: [{ name: "product_image", type: "image" }] })).toBe(true);
    expect(isVideoFromPictureRecipe("/reveal A cinematic reveal video", { needs: ["1 product picture"] })).toBe(true);
    // `all: true` (a detail lookup) keeps every recipe.
    expect(parseRecipes({ content: [{ type: "text", text: JSON.stringify({ recipes: [{ command: "/create-website", title: "Create website", description: "Build a website." }] }) }] }, { all: true })).toHaveLength(1);
  });

  it("keeps videos only: drops the provider's category entries, cards with no preview and no description, picture presets, and cards with neither a video nor a video output", () => {
    const answer = {
      // The filter list of the presets page, which came back as four cards titled All, Motion, Product shot, Effects.
      categories: [
        { id: "all", name: "All" },
        { id: "motion", name: "Motion" },
        { id: "product-shot", name: "Product shot" },
        { id: "effects", name: "Effects" },
      ],
      presets: [
        HERO,
        { name: "No id at all", description: "A preset with no id", preview_url: "https://cdn.test/presets/x.mp4" },
        { id: "mystery", name: "Mystery" },
        { id: "brushed_tin", name: "Brushed Tin", description: "A brushed metal look on the product.", thumbnail: "https://cdn.test/presets/tin.png", category: "effects" },
        { id: "still_life", name: "Still life", description: "A still life picture of the product.", thumbnail: "https://cdn.test/presets/still.png", execution: { available: true, output_type: "image" } },
        { id: "logo_spin", name: "Logo spin", description: "The logo spins in.", source: "marketing_studio", category: "motion", preview_image: "https://cdn.test/presets/spin.png", execution: { available: true, output_type: "video", input_schema: { type: "object", properties: { image: { type: "string", format: "media" } }, required: ["image"] } } },
        { id: "rise", name: "Rise", description: "The product rises.", source: "marketing_studio", category: "product-shot", poster: "https://cdn.test/presets/rise.jpg", execution: { available: true, output: "video" } },
      ],
    };
    const r = { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
    const kept = parsePresets(r, "viral");
    expect(kept.map((c) => c.id)).toEqual(["hero_shot", "logo_spin", "rise"]);
    expect(kept[1]).toMatchObject({ video: null, poster: "https://cdn.test/presets/spin.png", output: "video", needs: ["1 product picture"] });
    expect(kept[2]).toMatchObject({ video: null, poster: "https://cdn.test/presets/rise.jpg", output: "video" });
    // Why each one went, in plain words.
    expect(dropReason({ id: "all", title: "All", description: "", video: null, poster: null, output: null, source: "viral", category: null })).toBe("a category name, not a preset");
    expect(dropReason({ id: "x", title: "Product-shot", description: "", video: null, poster: "https://x/p.png", output: null, source: "viral", category: null })).toBe("a category name, not a preset");
    expect(dropReason({ id: "", title: "Nameless", description: "d", video: "https://x/v.mp4", poster: null, output: null, source: "viral", category: null })).toBe("no id");
    expect(dropReason({ id: "mystery", title: "Mystery", description: "", video: null, poster: null, output: null, source: "viral", category: null })).toBe("no preview and no description");
    expect(dropReason({ id: "tin", title: "Brushed Tin", description: "Metal", video: null, poster: "https://x/p.png", output: null, source: "viral", category: "effects" })).toBe("no reference video and no video output declared");
    expect(dropReason({ id: "still", title: "Still life", description: "A picture", video: "https://x/v.mp4", poster: null, output: "image", source: "marketing_studio", category: null })).toBe("makes a picture, not a video");
    expect(dropReason({ id: "spin", title: "Logo spin", description: "", video: null, poster: "https://x/p.png", output: null, source: "marketing_studio", category: "motion" })).toBeNull();
    // A detail lookup keeps everything preset-shaped, so a preset can still be opened.
    expect(parsePresets(r, "viral", { all: true }).map((c) => c.id)).toEqual(["all", "motion", "product-shot", "effects", "hero_shot", "mystery", "brushed_tin", "still_life", "logo_spin", "rise"]);
  });
});

describe("browsing the gallery", () => {
  it("says Not signed in with no call before the sign-in, and lists the categories", async () => {
    const env = await seed();
    const r = await json(await browse(env, "category=popular"));
    expect(r).toMatchObject({ signedIn: false, items: [], reason: NOT_SIGNED_IN, admin: false });
    expect((r.categories as unknown[]).length).toBe(PRESET_CATEGORIES.length);
    expect(await browse(env, "category=nope")).toHaveProperty("status", 400);
  });

  it("lets a member browse the combined feed, caches it a day in an encrypted row, and asks again only on refresh", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const r = (await json(await browse(env, "category=popular"))) as { items: { id: string; video: string; command: string | null }[]; nextCursor: string; cached: boolean; signedIn: boolean; admin: boolean };
    expect(r.signedIn).toBe(true);
    expect(r.admin).toBe(false);
    expect(r.cached).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(["hero_shot", "glitch"]);
    expect(r.items[0].video).toBe("https://cdn.test/presets/hero.mp4");
    expect(r.nextCursor).toBe("page-2");
    const asks = stub.rpc.filter((x) => x.name === "get_presets");
    expect(asks).toHaveLength(1);
    expect(asks[0].args).toEqual({ limit: 24 });
    // Cached: no second call, from this isolate or from the stored row.
    const raw = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(cacheKey("popular", "")).first<{ value: string }>();
    expect(raw?.value).toBeTruthy();
    expect(raw!.value).not.toContain("Hero Shot");
    expect(JSON.parse((await getSetting(env, cacheKey("popular", "")))!).items).toHaveLength(2);
    const again = (await json(await browse(env, "category=popular"))) as { cached: boolean; items: unknown[] };
    expect(again.cached).toBe(true);
    expect(again.items).toHaveLength(2);
    resetPresetCaches();
    const fromRow = (await json(await browse(env, "category=popular"))) as { cached: boolean };
    expect(fromRow.cached).toBe(true);
    expect(stub.rpc.filter((x) => x.name === "get_presets")).toHaveLength(1);
    await browse(env, "category=popular&refresh=1");
    expect(stub.rpc.filter((x) => x.name === "get_presets")).toHaveLength(2);
    // The next page is asked with the cursor and not cached.
    const page2 = (await json(await browse(env, "category=popular&cursor=page-2"))) as { cached: boolean };
    expect(page2.cached).toBe(false);
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).toMatchObject({ cursor: "page-2" });
    const browsed = (await ops(env)).results.filter((o) => o.kind === "preset.browse");
    expect(browsed.length).toBe(3);
    expect(browsed.every((o) => o.estimate === 0 && o.status === "done")).toBe(true);
  });

  it("maps every category to its asks: two Marketing Studio asks for Marketing, Katana for Production, the recipes list, and says when a category has nothing", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub({ emptyFor: ["genjutsu"] });
    useHiggsfieldMcpFetch(stub.fn);
    const marketing = (await json(await browse(env, "category=marketing"))) as { items: { id: string; category: string }[] };
    expect(marketing.items.map((i) => i.id)).toEqual(["hero_shot", "ad_hook"]);
    const marketingAsks = stub.rpc.filter((x) => x.name === "get_presets").map((x) => x.args);
    expect(marketingAsks).toEqual([
      { source: "marketing_studio", category: "product-shot", limit: 24 },
      { source: "marketing_studio", category: "ads", limit: 24 },
    ]);
    const production = (await json(await browse(env, "category=production"))) as { items: { id: string; source: string; runnable: boolean }[] };
    expect(production.items).toHaveLength(1);
    expect(production.items[0]).toMatchObject({ id: "launch-day", source: "katana", runnable: false });
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).toEqual({ source: "katana", katana_source: "higgsfield", limit: 20 });
    const ugc = await json(await browse(env, "category=ugc"));
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).toEqual({ query: "ugc", limit: 24 });
    expect((ugc.items as unknown[]).length).toBe(2);
    const effects = (await json(await browse(env, "category=effects"))) as { items: { id: string }[] };
    expect(effects.items.map((i) => i.id)).toEqual(["glitch"]);
    const recipes = (await json(await browse(env, "category=recipes"))) as { items: { id: string; source: string; runnable: boolean; description: string }[] };
    expect(stub.rpc.filter((x) => x.name === "get_preset_instructions").at(-1)?.args).toEqual({});
    // Only the recipes that make a video from a picture: the Blender, DaVinci, website, influencer, render and script ones go.
    expect(recipes.items.map((i) => i.id)).toEqual(["/hero-shot", "/katana/launch-day"]);
    expect(recipes.items.every((i) => i.source === "recipe" && !i.runnable)).toBe(true);
    const genjutsu = (await json(await browse(env, "category=genjutsu"))) as { items: unknown[]; empty: string };
    expect(genjutsu.items).toEqual([]);
    expect(genjutsu.empty).toMatch(/Nothing in this category/);
    // A search goes to the provider as `query` (Katana is searched here instead).
    await browse(env, "category=paid-ads&q=hook");
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).toEqual({ source: "marketing_studio", query: "hook", limit: 24 });
    await browse(env, "category=production&q=zzz");
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).not.toHaveProperty("query");
  });

  it("opens one preset with its inputs, instructions and, for an admin on a post, the readiness with the picture prefilled", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const asMember = (await json(await app("member").request("/api/studio/video/presets/hero_shot?source=marketing_studio", {}, env))) as { preset: Record<string, unknown>; admin: boolean };
    expect(asMember.admin).toBe(false);
    expect(asMember.preset).toMatchObject({ id: "hero_shot", title: "Hero Shot", command: "/hero-shot", price: 20, needs: ["1 product picture"], runnable: true, available: true, readiness: { ready: false, missing: ["product_image"] } });
    expect((asMember.preset.inputSchema as { required: string[] }).required).toEqual(["product_image"]);
    expect(asMember.preset.instructions).toMatch(/How \/hero-shot works/);
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(0);
    const asAdmin = (await json(await app().request("/api/studio/video/presets/hero_shot?source=marketing_studio&batch=b1&index=1", {}, env))) as { preset: Record<string, unknown>; readinessError: string };
    expect(asAdmin.readinessError).toBe("");
    expect(asAdmin.preset.readiness).toEqual({ ready: true, missing: [] });
    const prefilled = stub.rpc.filter((x) => x.name === "get_presets" && x.args?.initial_inputs);
    expect(prefilled).toHaveLength(1);
    expect(prefilled[0].args).toMatchObject({ preset_id: "hero_shot", category: "all", source: "marketing_studio", initial_inputs: { product_image: [{ id: "med_1", type: "image" }] } });
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(1);
    // A recipe opens from its instructions alone.
    const recipe = (await json(await app("member").request(`/api/studio/video/presets/${encodeURIComponent("/hero-shot")}?source=recipe`, {}, env))) as { preset: Record<string, unknown> };
    expect(recipe.preset).toMatchObject({ source: "recipe", command: "/hero-shot", runnable: false, video: "https://cdn.test/presets/hero-ref.mp4" });
    expect(recipe.preset.instructions).toMatch(/How \/hero-shot works/);
  });
});

describe("running a preset", () => {
  const run = (env: FakeEnv, body: Record<string, unknown> = {}, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/video/presets/run", { batch: "b1", index: 1, presetId: "hero_shot", source: "marketing_studio", inputs: { prompt: "slow and warm" }, ...body });

  it("refuses a member, the Cloud billing, a recipe, and the switch off; browsing stays open", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const member = await run(env, {}, "member");
    expect(member.status).toBe(403);
    expect((await json(member)).error).toMatch(/Admins only for now/);
    const recipe = await run(env, { source: "recipe", presetId: "/hero-shot" });
    expect(recipe.status).toBe(400);
    expect(await json(recipe)).toMatchObject({ notRunnable: true });
    await setSetting(env, HIGGSFIELD_BILLING_SETTING, "cloud");
    const cloud = await run(env, { confirm: true });
    expect(cloud.status).toBe(409);
    expect(await json(cloud)).toMatchObject({ billing: "cloud" });
    await setSetting(env, HIGGSFIELD_BILLING_SETTING, "credits");
    await setIntegrationSwitch(env, "higgsfield", false);
    const off = await run(env, { confirm: true });
    expect(off.status).toBe(503);
    const browsed = (await json(await browse(env, "category=effects"))) as { items: unknown[]; reason: string };
    expect(browsed.items).toEqual([]);
    expect(browsed.reason).toMatch(/switched off/);
    expect(stub.rpc.filter((x) => x.name === "execute_preset")).toHaveLength(0);
    expect(await listVideos(env)).toEqual([]);
  });

  it("asks for the confirm with the detail's price, then runs execute_preset with the picture in the preset's input, and the job becomes a version", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const ask = await run(env);
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 20, balance: 1500 });
    expect(stub.rpc.filter((x) => x.name === "execute_preset")).toHaveLength(0);
    const go = (await json(await run(env, { confirm: true }))) as { video: { id: string; status: string; provider: string; requestId: string; estimate: number; label: string; prompt: string } };
    expect(go.video).toMatchObject({ status: "queued", provider: MCP_PROVIDER, requestId: "job-p1", estimate: 20, label: "Preset · Hero Shot", prompt: "slow and warm" });
    const exec = stub.rpc.find((x) => x.name === "execute_preset")!;
    expect(exec.args).toEqual({ source: "marketing_studio", preset_id: "hero_shot", inputs: { prompt: "slow and warm", product_image: "med_1" } });
    const row = await env.DB.prepare("SELECT settings, model FROM videos WHERE id = ?").bind(go.video.id).first<{ settings: string; model: string }>();
    expect(row!.model).toBe("preset:hero_shot");
    expect(JSON.parse(row!.settings)).toMatchObject({ preset: { id: "hero_shot", name: "Hero Shot", source: "marketing_studio", command: "/hero-shot" }, jobIds: ["job-p1", "job-p2"], credits: 20, unit: "credits", balanceBefore: 1500 });
    // The same ask again within ten minutes is refused.
    const twice = await run(env, { confirm: true });
    expect(twice.status).toBe(409);
    expect((await json(twice)).error).toMatch(/a moment ago/);
    // The list polls with jobs_wait; the second poll finds it done and stores the mp4.
    let vids = await listVideos(env);
    expect(vids[0]).toMatchObject({ status: "generating", url: null });
    vids = await listVideos(env);
    expect(vids[0]).toMatchObject({ status: "done", provider: MCP_PROVIDER, label: "Preset · Hero Shot" });
    expect(vids[0].url).toMatch(/\/api\/studio\/posts\/video\/file\?/);
    const file = await app().request(vids[0].url!, {}, env);
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe(sampleBytes().byteLength);
    const runOps = (await ops(env)).results.filter((o) => o.kind === "preset.run");
    expect(runOps).toHaveLength(1);
    expect(runOps[0]).toMatchObject({ status: "done", estimate: 20, task_id: "job-p1" });
    expect(runOps[0].note).toMatch(/credits reported/);
  });

  it("blocks a preset with no price as cost not known until the admin confirms it anyway", async () => {
    const env = await seed();
    await signedIn(env);
    const stub = higgsfieldStub({ noPrice: true });
    useHiggsfieldMcpFetch(stub.fn);
    const ask = await run(env);
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsEstimate: true, presetId: "hero_shot" });
    expect(stub.rpc.filter((x) => x.name === "execute_preset")).toHaveLength(0);
    const go = (await json(await run(env, { confirm: true }))) as { video: { status: string; estimate: number | null } };
    expect(go.video).toMatchObject({ status: "queued", estimate: null });
    const runOps = (await ops(env)).results.filter((o) => o.kind === "preset.run");
    expect(runOps[0].estimate).toBeNull();
    expect(runOps[0].note).toMatch(/cost unknown, confirmed/);
  });
});
