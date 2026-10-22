import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { draftDiff, draftLabel } from "../shared/draft";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";

/**
 * Planning drafts: "Plan it" writes a draft the team reviews; the month changes only when the
 * draft is applied. Adding posts keeps the existing posts, their words and their pictures exactly
 * as they were; replacing them is a separate, explicit choice. No vendor is reached.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;

async function app() {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const post = (index: number, extra: Partial<Post> = {}): Post =>
  ({ index, type: "product", title: `Post ${index}`, brief: `The pistachio cup on a plain table, post ${index}.`, caption: `Caption ${index}`, hashtags: "#a", product: "pistachio", date: `2026-10-${String(index * 3).padStart(2, "0")}`, ideaAt: 1_700_000_000_000, ...extra }) as Post;

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { model: "nano-banana-pro", plan: [post(1), post(2), post(3)], plannedAt: 1_700_000_000_000 });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind, note) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product', 'a green cup')").bind(t).run();
  await env.BUCKET.put("u1/b1/src/s1.jpg", new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, prompt, attempts, updated, post, output, made_for) VALUES ('t1', 'b1', 's1', 1, 'ready', 'p', 1, ?, 1, 'u1/b1/output/t1/a.jpg', 1700000000000)").bind(t).run();
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[]; plannedAt?: number });
const form = (brief: string, only = false) => {
  const f = new FormData();
  f.set("batch", "b1");
  f.set("brief", brief);
  if (only) f.set("only", "1");
  return f;
};

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the draft diff", () => {
  const existing = [post(1), post(2), post(3)];
  it("append: the new posts are added, the existing ones untouched, no picture left behind", () => {
    const d = draftDiff(existing, [post(4), post(5)], "append", new Set([1]));
    expect(d.added.map((p) => p.index)).toEqual([4, 5]);
    expect(d.untouched.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(d.changed).toEqual([]);
    expect(d.olderIdea).toEqual([]);
    expect(d.after).toEqual({ posts: 5, designs: 5, pictures: 5, tiles: 0 });
    expect(draftLabel(d)).toBe("Add 2 posts");
  });
  it("replace: every existing post leaves (kept as a version) and its picture belongs to an older idea", () => {
    const d = draftDiff(existing, [post(1), post(2)], "replace", new Set([1]));
    expect(d.removed.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(d.olderIdea.map((p) => p.index)).toEqual([1]);
    expect(d.after.designs).toBe(2);
    expect(draftLabel(d)).toBe("Replace the month's 3 posts with 2 designs");
  });
  it("a draft that rewrites an existing post's idea lists the change and the picture it leaves older", () => {
    const d = draftDiff(existing, [post(1, { brief: "A new idea." }), post(4)], "append", new Set([1]));
    expect(d.changed).toEqual([{ index: 1, title: "Post 1", type: "product", group: undefined, fields: ["idea"] }]);
    expect(d.olderIdea[0]?.index).toBe(1);
    expect(d.untouched.map((p) => p.index)).toEqual([2, 3]);
    expect(d.added.map((p) => p.index)).toEqual([4]);
  });
});

describe("planning drafts over the routes (demo fixture, no network)", () => {
  it("Plan it writes a draft and the month stays as it is; applying it adds the posts after the three", async () => {
    const env = await seed();
    const a = await app();
    const r = await a.request("/api/studio/posts/campaign/draft", { method: "POST", body: form("Plan 2 posts of the pistachio cup on the street, a headline on each.") }, env);
    expect(r.status).toBe(200);
    const { draft } = (await json(r)) as { draft: { id: string; mode: string; posts: Post[]; diff: { added: unknown[]; untouched: unknown[]; olderIdea: unknown[] } } };
    expect(draft.mode).toBe("append");
    expect(draft.posts.length).toBe(2);
    expect(draft.diff.added.length).toBe(2);
    expect(draft.diff.untouched.length).toBe(3);
    expect(draft.diff.olderIdea).toEqual([]);
    const before = await planOf(env);
    expect(before.plan.length).toBe(3);
    // The open draft is found again after a reload.
    const open = (await json(await a.request("/api/studio/posts/drafts?batch=b1", {}, env))) as { draft: { id: string } | null };
    expect(open.draft?.id).toBe(draft.id);
    const applied = await a.request(`/api/studio/posts/drafts/${draft.id}/apply`, { method: "POST" }, env);
    expect(applied.status).toBe(200);
    const after = await planOf(env);
    expect(after.plan.length).toBe(5);
    // The original three are exactly as they were: words, dates, revision stamp.
    for (const i of [1, 2, 3]) expect(after.plan.find((p) => p.index === i)).toEqual(before.plan.find((p) => p.index === i));
    expect(after.plannedAt).toBe(before.plannedAt);
    expect(after.plan.filter((p) => p.index > 3).every((p) => p.ideaAt && p.ideaAt > 1_700_000_000_000)).toBe(true);
    // Post 1's picture still belongs to its idea: no older-idea mark after an append.
    const { olderIdea } = await import("../shared/posts");
    const t1 = await env.DB.prepare("SELECT output, made_for FROM tasks WHERE id = 't1'").first<{ output: string; made_for: number }>();
    expect(olderIdea(t1, after.plan.find((p) => p.index === 1)!, after)).toBe(false);
    const row = await env.DB.prepare("SELECT status FROM plan_drafts WHERE id = ?").bind(draft.id).first<{ status: string }>();
    expect(row?.status).toBe("applied");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE batch = 'b1'").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("discarding a draft changes nothing, and a replace draft is an explicit separate choice kept under Versions", async () => {
    const env = await seed();
    const a = await app();
    const { draft } = (await json(await a.request("/api/studio/posts/campaign/draft", { method: "POST", body: form("Plan 2 posts of the pistachio cup on the street, a headline on each.") }, env))) as { draft: { id: string } };
    await a.request(`/api/studio/posts/drafts/${draft.id}/discard`, { method: "POST" }, env);
    expect((await planOf(env)).plan.length).toBe(3);
    expect((await json(await a.request("/api/studio/posts/drafts?batch=b1", {}, env))).draft).toBeNull();
    const again = await a.request(`/api/studio/posts/drafts/${draft.id}/apply`, { method: "POST" }, env);
    expect(again.status).toBe(409);
    const rep = (await json(await a.request("/api/studio/posts/campaign/draft", { method: "POST", body: form("Plan 2 posts of the pistachio cup on the street, a headline on each.", true) }, env))) as { draft: { id: string; mode: string; diff: { removed: unknown[]; olderIdea: { index: number }[] } } };
    expect(rep.draft.mode).toBe("replace");
    expect(rep.draft.diff.removed.length).toBe(3);
    expect(rep.draft.diff.olderIdea.map((p) => p.index)).toEqual([1]);
    expect((await planOf(env)).plan.length).toBe(3);
    await a.request(`/api/studio/posts/drafts/${rep.draft.id}/apply`, { method: "POST" }, env);
    expect((await planOf(env)).plan.length).toBe(2);
    const versions = await env.DB.prepare("SELECT plan FROM month_versions WHERE batch = 'b1'").all<{ plan: string }>();
    expect((JSON.parse(versions.results[0].plan) as Post[]).length).toBe(3);
  });
});
