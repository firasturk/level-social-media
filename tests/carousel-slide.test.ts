import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { copyPost, slideTitle } from "../shared/carousel";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";

/**
 * "Add a slide" (27 Oct): the next slide is a copy of slide 1, picture included (a task of its own
 * on the same stored picture), whichever slide was on screen; a single post becomes slide 1 of a
 * new carousel; a series part is refused. Nothing is made or paid: the guard fails any network call.
 */
const { studioRoutes } = await import("../server/studio");
type FakeEnv = ReturnType<typeof fakeEnv>;

function app() {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "member" } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Abu Saleh', 'test-abu-saleh-slides', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "product", title: "فخارة شعيرية", brief: "", caption: "كنافة بالفخار", hashtags: "#abusaleh", date: "2026-10-03", source: "media", media: { kind: "image", from: "drive", name: "فخارة شعيرية.png", fp: "drive:1", at: 1 }, style: "s-1" } as never,
      { index: 2, type: "tip", title: "Series one", brief: "x", caption: "", hashtags: "", group: { id: "ser", kind: "series", slide: 1, of: 1 } } as never,
    ],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Abu Saleh · October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'drive.png', 'drive', 'u1/b1/src/s1.png', 'image/png', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, qa, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u1/b1/output/t1/a.png', '', 1, ?, ?)").bind(JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [] }), t).run();
  return env;
}

const slide = (env: FakeEnv, index: number) => app().request("/api/studio/posts/slide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index }) }, env);
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[]; postCount?: number }).plan;
const tasksOf = (env: FakeEnv) => env.DB.prepare("SELECT post, status, output, source, qa FROM tasks ORDER BY post").all<{ post: number; status: string; output: string; source: string; qa: string | null }>().then((r) => r.results);

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("copying a post", () => {
  it("keeps the idea, words, product, style and file, drops what the original earned", () => {
    const from = { index: 1, type: "product", title: "Mango", brief: "b", caption: "c", hashtags: "#h", product: "mango", style: "s", date: "2026-10-01", clientNotes: [{ note: "x", at: 1, done: 2 }], group: { id: "g", kind: "carousel", slide: 1, of: 2 }, source: "media", media: { kind: "image", from: "drive", name: "m.png", fp: "drive:1", at: 1 } } as unknown as Post;
    const p = copyPost(from, 5, "Mango · slide 2", "slide:x", 9);
    expect(p).toMatchObject({ index: 5, title: "Mango · slide 2", brief: "b", caption: "c", product: "mango", style: "s", ideaAt: 9, media: { fp: "slide:x", at: 9, name: "m.png" } });
    expect(p.group).toBeUndefined();
    expect(p.clientNotes).toBeUndefined();
    expect(p.date).toBeUndefined();
  });
  it("titles a slide from any slide's title without stacking", () => {
    expect(slideTitle("Kunafa", 2)).toBe("Kunafa · slide 2");
    expect(slideTitle("Kunafa · slide 2", 3)).toBe("Kunafa · slide 3");
    expect(slideTitle("Kunafa · slide 2 · slide 3", 4)).toBe("Kunafa · slide 4");
  });
});

describe("Add a slide", () => {
  it("makes a single post slide 1 and adds slide 2 as its copy, picture included, on the same day", async () => {
    const env = await seed();
    const r = await slide(env, 1);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { index: number; slide: number; group: string; copied: boolean };
    expect(d).toMatchObject({ index: 3, slide: 2, copied: true });
    const plan = await planOf(env);
    const one = plan.find((p) => p.index === 1)!;
    const two = plan.find((p) => p.index === 3)!;
    expect(one.group).toEqual({ id: d.group, kind: "carousel", slide: 1, of: 2 });
    expect(two.group).toEqual({ id: d.group, kind: "carousel", slide: 2, of: 2 });
    expect(two).toMatchObject({ title: "فخارة شعيرية · slide 2", caption: "كنافة بالفخار", style: "s-1", date: "2026-10-03" });
    expect((two.media as { fp: string }).fp).not.toBe("drive:1");
    const tasks = await tasksOf(env);
    expect(tasks.map((t) => [t.post, t.status, t.output, t.source])).toEqual([
      [1, "ready", "u1/b1/output/t1/a.png", "s1"],
      [3, "ready", "u1/b1/output/t1/a.png", "s1"],
    ]);
    expect(JSON.parse(tasks[1].qa!)).toMatchObject({ found: true });
    const takes = await env.DB.prepare("SELECT post, status, key, cost, note FROM post_takes").all<{ post: number; status: string; key: string; cost: number; note: string }>();
    expect(takes.results).toEqual([{ post: 3, status: "made", key: "u1/b1/output/t1/a.png", cost: 0, note: "Slide 2: a copy of slide 1 (post 1), no spend" }]);
  });

  it("copies slide 1 again whichever slide is on screen, and titles it right", async () => {
    const env = await seed();
    await slide(env, 1);
    // Slide 2 (post 3) is on screen: the new slide is still a copy of slide 1.
    const r = (await (await slide(env, 3)).json()) as { index: number; slide: number };
    expect(r).toMatchObject({ index: 4, slide: 3 });
    const plan = await planOf(env);
    expect(plan.filter((p) => p.group?.kind === "carousel").map((p) => [p.index, p.group!.slide, p.group!.of, p.title])).toEqual([
      [1, 1, 3, "فخارة شعيرية"],
      [3, 2, 3, "فخارة شعيرية · slide 2"],
      [4, 3, 3, "فخارة شعيرية · slide 3"],
    ]);
  });

  it("refuses a series part, and an unknown post", async () => {
    const env = await seed();
    expect((await slide(env, 2)).status).toBe(409);
    expect((await slide(env, 9)).status).toBe(404);
    expect(await tasksOf(env)).toHaveLength(1);
  });
});
