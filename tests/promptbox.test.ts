import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { intentRunnable, intentSummary, resolveIntent, validateIntent, type PromptContext, type ToolIntent } from "../shared/promptbox";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";

/**
 * The Prompt Box: a sentence in the planner chat becomes an intent card (what, where, through
 * which provider, for how much) that a person confirms; nothing runs from the sentence alone.
 * Members read the card but cannot run a provider tool; unknown cost blocks the run; browsing
 * Freepik is free and makes nothing. No vendor is reached anywhere in this file.
 */
const KLING = "kling-video/v3.0/std/image-to-video";

const ctx = (over: Partial<PromptContext> = {}): PromptContext => ({
  batch: "b1",
  posts: [
    { index: 1, title: "Blue mojito on the sign" },
    { index: 2, title: "Pistachio cup" },
    { index: 3, title: "Kiwi mojito" },
  ],
  openPost: null,
  lastAsset: null,
  ...over,
});

describe("the deterministic resolver", () => {
  it("“Find a minimal background from Freepik for post 3” searches Freepik for post 3, free, no confirmation", () => {
    const i = resolveIntent("Find a minimal background from Freepik for post 3", ctx());
    expect(i.tool).toBe("freepik.search");
    expect(i.provider).toBe("freepik");
    expect(i.target).toEqual({ batch: "b1", post: 3, slide: null });
    expect(i.settings).toMatchObject({ q: "minimal background", type: "photo", page: 1 });
    expect(i.estimate).toBe(0);
    expect(i.needsConfirmation).toBe(false);
    expect(i.questions).toEqual([]);
    expect(intentRunnable(i).ok).toBe(true);
  });
  it("“Add this asset behind the headline” adds the last shown asset to the open post's design", () => {
    const asset = { id: "fp-1", source: "freepik", url: "https://img.test/1.jpg" };
    const i = resolveIntent("Add this asset behind the headline", ctx({ openPost: 2, lastAsset: asset }));
    expect(i.tool).toBe("freepik.use");
    expect(i.asset).toEqual(asset);
    expect(i.target.post).toBe(2);
    expect(i.settings).toEqual({ role: "design", placement: "behind the headline" });
    expect(i.needsConfirmation).toBe(true);
    expect(i.questions).toEqual([]);
  });
  it("asks which post when no post is open for “this asset”, and which asset when none was shown", () => {
    const noPost = resolveIntent("Add this asset behind the headline", ctx({ lastAsset: { id: "fp-1", source: "freepik" } }));
    expect(noPost.tool).toBe("freepik.use");
    expect(noPost.target.post).toBeNull();
    expect(noPost.questions).toHaveLength(1);
    expect(noPost.questions[0]).toMatch(/Which post/);
    expect(intentRunnable(noPost).ok).toBe(false);
    const noAsset = resolveIntent("Add this asset behind the headline", ctx({ openPost: 2 }));
    expect(noAsset.questions[0]).toMatch(/Which asset/);
  });
  it("“Animate this post using Kling through Higgsfield” targets the open post with the Kling model and no known cost", () => {
    const i = resolveIntent("Animate this post using Kling through Higgsfield", ctx({ openPost: 1 }));
    expect(i.tool).toBe("video.generate");
    expect(i.provider).toBe("higgsfield");
    expect(i.target.post).toBe(1);
    expect(i.settings).toMatchObject({ model: KLING, modelName: "Kling 3.0", duration: 5, aspect: "1:1", source: "picture" });
    expect(i.estimate).toBeNull();
    expect(i.estimateNote).toMatch(/^Cost not known yet/);
    expect(i.needsConfirmation).toBe(true);
    expect(intentRunnable(i)).toEqual({ ok: false, why: "Cost not known yet · blocked until clarified" });
  });
  it("takes the estimate from the catalog when it knows the price", () => {
    const i = resolveIntent("Animate post 2 with Kling, 8 seconds, 9:16", ctx({ videoModels: [{ slug: KLING, name: "Kling 3.0", credits: 12 }] }));
    expect(i.estimate).toBe(12);
    expect(i.settings).toMatchObject({ duration: 8, aspect: "9:16" });
    expect(intentRunnable(i).ok).toBe(true);
  });
  it("ambiguity yields one focused question, never a guess", () => {
    const i = resolveIntent("Animate the mojito post with Kling", ctx());
    expect(i.tool).toBe("video.generate");
    expect(i.target.post).toBeNull();
    expect(i.questions).toEqual(["Which post should be animated: 1 (Blue mojito on the sign) or 3 (Kiwi mojito)?"]);
    const none = resolveIntent("Animate it", ctx());
    expect(none.questions).toHaveLength(1);
    const missing = resolveIntent("Animate post 9", ctx());
    expect(missing.questions[0]).toMatch(/no post 9/);
  });
  it("a sentence about the ideas is not a tool", () => {
    expect(resolveIntent("Post 3 on the kiwi mojito instead, same idea.", ctx()).tool).toBe("none");
    expect(resolveIntent("All the captions in Jordanian Arabic", ctx()).tool).toBe("none");
  });
  it("reads Arabic numerals and a title that names one post", () => {
    expect(resolveIntent("Find a kiwi texture from Freepik for بوست ٣", ctx()).target.post).toBe(3);
    expect(resolveIntent("Animate the pistachio post", ctx()).target.post).toBe(2);
  });
  it("Photo Lab edits are a card with no known cost", () => {
    const i = resolveIntent("Remove the background of post 2", ctx());
    expect(i.tool).toBe("photolab.run");
    expect(i.target.post).toBe(2);
    expect(i.estimate).toBeNull();
  });
  it("a model's proposal is only accepted through the same rules", () => {
    const c = ctx({ lastAsset: { id: "fp-9", source: "freepik" } });
    expect(validateIntent({ tool: "freepik.search", q: "noon street", post: 3 }, c)).toMatchObject({ tool: "freepik.search", target: { post: 3 }, settings: { q: "noon street" }, estimate: 0 });
    expect(validateIntent({ tool: "video.generate", post: 7, model: KLING }, c)!.questions).toHaveLength(1);
    expect(validateIntent({ tool: "video.generate", post: 1, model: "made-up", estimate: 3 }, c)).toMatchObject({ estimate: null, questions: ["Which video engine? Name one from the catalog."] });
    expect(validateIntent({ tool: "freepik.use", post: 1, asset: { id: "other", source: "freepik" } }, c)!.questions[0]).toMatch(/Which asset/);
    expect(validateIntent({ tool: "explode" }, c)).toBeNull();
    expect(validateIntent({ tool: "none" }, c)!.tool).toBe("none");
  });
  it("summarises a card in one plain line", () => {
    const i = resolveIntent("Find a minimal background from Freepik for post 3", ctx());
    expect(intentSummary(i, ctx().posts)).toBe("Search Freepik: “minimal background” · post 3 (Kiwi mojito) · free.");
  });
});

/* ───────────── Over the routes: the chat proposes, execute runs, nothing is paid ───────────── */

type FakeEnv = ReturnType<typeof fakeEnv>;

async function app(role: User["role"] = "admin") {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const post = (index: number, title: string): Post => ({ index, type: "product", title, brief: `The cup, post ${index}.`, caption: `Caption ${index}`, hashtags: "#a", product: "pistachio", date: `2026-10-${String(index * 3).padStart(2, "0")}` }) as Post;

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { model: "nano-banana-pro", plan: [post(1, "Blue mojito on the sign"), post(2, "Pistachio cup"), post(3, "Kiwi mojito")], plannedAt: 1_700_000_000_000 });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind, note) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product', 'a green cup')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, prompt, attempts, updated, post, output, made_for) VALUES ('t1', 'b1', 's1', 1, 'ready', 'p', 1, ?, 1, 'u1/b1/output/t1/a.jpg', 1700000000000)").bind(t).run();
  return env;
}

type App = Awaited<ReturnType<typeof app>>;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const send = (a: App, env: FakeEnv, path: string, body: unknown) => a.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const chat = (a: App, env: FakeEnv, message: string, context?: unknown) => send(a, env, "/api/studio/posts/chat", { batch: "b1", message, context });
const execute = (a: App, env: FakeEnv, body: unknown) => send(a, env, "/api/studio/promptbox/execute", body);
const videos = async (env: FakeEnv) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM videos").first<{ n: number }>())!.n;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the chat proposes a card and never runs it", () => {
  it("answers {kind: intent} with the resolved card and keeps the thread", async () => {
    const env = await seed();
    const a = await app();
    const r = await json(await chat(a, env, "Find a minimal background from Freepik for post 3"));
    expect(r.kind).toBe("intent");
    expect(r.canRun).toBe(true);
    const intent = r.intent as ToolIntent;
    expect(intent.tool).toBe("freepik.search");
    expect(intent.target.post).toBe(3);
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { chat: { role: string; text: string }[] };
    expect(cfg.chat.map((t) => t.role)).toEqual(["user", "studio"]);
    expect(cfg.chat[1].text).toContain("Confirm it on the card");
  });
  it("a member reads the card but is told it is admins only, with no execute", async () => {
    const env = await seed();
    const a = await app("member");
    const r = await json(await chat(a, env, "Animate this post using Kling through Higgsfield", { post: 1 }));
    expect(r.kind).toBe("intent");
    expect(r.canRun).toBe(false);
    expect(String(r.reply)).toContain("Admins only for now");
    expect((r.intent as ToolIntent).settings.model).toBe(KLING);
  });
  it("a sentence about the ideas still goes to the planner (the demo fixture here)", async () => {
    const env = await seed();
    const a = await app();
    const r = await json(await chat(a, env, "Post 3 on the kiwi mojito instead, same idea."));
    expect(r.kind).toBe("ideas");
    expect(r.intent).toBeUndefined();
  });
});

describe("execute", () => {
  it("requires confirm: true (a prompt alone never bypasses confirmation)", async () => {
    const env = await seed();
    const a = await app();
    const { intent } = (await json(await chat(a, env, "Find a minimal background from Freepik for post 3"))) as { intent: ToolIntent };
    const r = await execute(a, env, { intent });
    expect(r.status).toBe(428);
    expect((await json(r)).error as string).toMatch(/Confirm the card first/);
  });
  it("refuses a member every provider tool (403), even the free search", async () => {
    const env = await seed();
    const admin = await app();
    const member = await app("member");
    const { intent } = (await json(await chat(admin, env, "Find a minimal background from Freepik for post 3"))) as { intent: ToolIntent };
    const r = await execute(member, env, { intent, confirm: true });
    expect(r.status).toBe(403);
    expect((await json(r)).error as string).toMatch(/^Admins only for now/);
  });
  it("blocks an unknown cost until an admin sets the estimate", async () => {
    const env = await seed();
    const a = await app();
    const { intent } = (await json(await chat(a, env, "Animate this post using Kling through Higgsfield", { post: 1 }))) as { intent: ToolIntent };
    expect(intent.estimate).toBeNull();
    const r = await execute(a, env, { intent, confirm: true });
    expect(r.status).toBe(409);
    expect((await json(r)).error as string).toMatch(/^Cost not known yet/);
    expect(await videos(env)).toBe(0);
  });
  it("refuses a card with an open question", async () => {
    const env = await seed();
    const a = await app();
    const { intent } = (await json(await chat(a, env, "Animate the mojito post with Kling"))) as { intent: ToolIntent };
    expect(intent.questions).toHaveLength(1);
    const r = await execute(a, env, { intent, confirm: true, estimate: 10 });
    expect(r.status).toBe(409);
    expect((await json(r)).error as string).toMatch(/^Which post should be animated/);
  });
  it("search runs free: records an op with estimate 0, returns results, generates nothing", async () => {
    const env = await seed();
    const a = await app();
    const integrations = await import("../server/integrations");
    const record = vi.spyOn(integrations, "recordIntegrationOp");
    const update = vi.spyOn(integrations, "updateIntegrationOp");
    const tools = await import("../server/promptbox-tools");
    const video = vi.spyOn(tools.promptboxTools, "videoGenerate");
    const { intent } = (await json(await chat(a, env, "Find a minimal background from Freepik for post 3"))) as { intent: ToolIntent };
    expect(record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ provider: "freepik", kind: "freepik.search", status: "proposed", estimate: 0, post: 3 }));
    const r = await json(await execute(a, env, { intent, confirm: true }));
    expect(r.kind).toBe("results");
    expect(r.fixture).toBe(true);
    const results = r.results as { id: string; source: string; url: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("freepik");
    expect(record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ provider: "freepik", kind: "freepik.search", status: "confirmed", estimate: 0, batch: "b1", post: 3 }));
    expect(update).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ status: "done", reported: 0 }));
    expect(video).not.toHaveBeenCalled();
    expect(await videos(env)).toBe(0);
  });
  it("use goes through the adapter with the asset shown last, after an explicit confirm", async () => {
    const env = await seed();
    const a = await app();
    const tools = await import("../server/promptbox-tools");
    const use = vi.fn(async () => ({ ok: true as const, note: "stored", fixture: false }));
    const restore = tools.setPromptboxTools({ freepikUse: use });
    try {
      const asset = { id: "fp-7", source: "freepik", url: "https://img.freepik.test/photo/7.jpg", title: "sand" };
      const { intent } = (await json(await chat(a, env, "Add this asset behind the headline", { post: 2, asset }))) as { intent: ToolIntent };
      expect(intent.tool).toBe("freepik.use");
      expect(intent.asset).toEqual(asset);
      const r = await json(await execute(a, env, { intent, confirm: true }));
      expect(r.kind).toBe("done");
      expect(use).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "u1" }), { asset, batch: "b1", post: 2, slide: null, role: "design", placement: "behind the headline" });
    } finally {
      restore();
    }
  });
  it("video.generate calls the video adapter with the card's settings once the admin set the cost", async () => {
    const env = await seed();
    const a = await app();
    const tools = await import("../server/promptbox-tools");
    const generate = vi.fn(async () => ({ ok: true as const, video: { id: "v1", status: "queued" }, note: "queued" }));
    const restore = tools.setPromptboxTools({ videoGenerate: generate });
    const integrations = await import("../server/integrations");
    const record = vi.spyOn(integrations, "recordIntegrationOp");
    try {
      const { intent } = (await json(await chat(a, env, "Animate this post using Kling through Higgsfield, 8 seconds, 9:16", { post: 1 }))) as { intent: ToolIntent };
      const r = await json(await execute(a, env, { intent, confirm: true, estimate: 12 }));
      expect(r.kind).toBe("done");
      expect((r.intent as ToolIntent).estimate).toBe(12);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "admin" }), expect.objectContaining({ batch: "b1", index: 1, model: KLING, duration: 8, aspect: "9:16", source: "picture" }));
      expect(record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ provider: "higgsfield", kind: "video.generate", status: "confirmed", estimate: 12, post: 1 }));
      // The estimate is the admin's or the catalog's, never the card's: a card that claims a price is still blocked.
      const r2 = await execute(a, env, { intent: { ...intent, estimate: 1 }, confirm: true });
      expect(r2.status).toBe(409);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
  it("this build's video adapter refuses on the preview: the op is marked failed and nothing is paid", async () => {
    const env = await seed();
    const a = await app();
    const integrations = await import("../server/integrations");
    const update = vi.spyOn(integrations, "updateIntegrationOp");
    const { intent } = (await json(await chat(a, env, "Animate post 1 with Kling"))) as { intent: ToolIntent };
    const r = await execute(a, env, { intent, confirm: true, estimate: 5 });
    expect(r.status).toBe(403);
    expect(update).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ status: "failed" }));
    expect(await videos(env)).toBe(0);
  });
});
