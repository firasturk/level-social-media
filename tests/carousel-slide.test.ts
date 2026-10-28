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

describe("a card dropped onto another", () => {
  it("makes the dropped post the next slide of the target's carousel, picture and words kept", async () => {
    const env = await seed();
    const t = Date.now();
    // A second single post with its own picture.
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    cfg.plan.push({ index: 3, type: "product", title: "Sakina", brief: "The green smoothie.", caption: "سكينة", hashtags: "", product: "sakina" } as never);
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t3', 'b1', 's1', 3, 'ready', 'u1/b1/output/t3/a.png', '', 3, ?)").bind(t).run();
    const r = await app().request("/api/studio/posts/carousel-join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 3, into: 1 }) }, env);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { group: string; slide: number };
    expect(d.slide).toBe(2);
    const plan = await planOf(env);
    expect(plan.find((p) => p.index === 1)!.group).toEqual({ id: d.group, kind: "carousel", slide: 1, of: 2 });
    expect(plan.find((p) => p.index === 3)).toMatchObject({ title: "Sakina", caption: "سكينة", group: { id: d.group, kind: "carousel", slide: 2, of: 2 } });
    // The dropped post's own picture stays its own.
    expect((await tasksOf(env)).find((x) => x.post === 3)!.output).toBe("u1/b1/output/t3/a.png");
    // Dropping a third single onto any slide of the carousel appends slide 3.
    cfg.plan = plan;
    cfg.plan.push({ index: 4, type: "tip", title: "Tip", brief: "x", caption: "", hashtags: "" } as never);
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    const r2 = (await (await app().request("/api/studio/posts/carousel-join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 4, into: 3 }) }, env)).json()) as { slide: number };
    expect(r2.slide).toBe(3);
    expect((await planOf(env)).filter((p) => p.group?.id === d.group).map((p) => p.group!.of)).toEqual([3, 3, 3]);
  });
  it("refuses a series part and a post already in a carousel", async () => {
    const env = await seed();
    expect((await app().request("/api/studio/posts/carousel-join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 2, into: 1 }) }, env)).status).toBe(409);
    await slide(env, 1);
    expect((await app().request("/api/studio/posts/carousel-join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 3, into: 1 }) }, env)).status).toBe(409);
  });
});

describe("Add a post from a product", () => {
  it("adds a planned post whose card shows the product's own photo, no spend", async () => {
    const env = await seed();
    const r = await app().request("/api/studio/posts/add-from-product", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", source: "s1" }) }, env);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { index: number; product: string };
    expect(d).toEqual({ ok: true, index: 3, product: "drive" });
    const plan = await planOf(env);
    expect(plan.find((p) => p.index === 3)).toMatchObject({ type: "product", title: "drive", product: "drive", brief: "" });
    const task = (await tasksOf(env)).find((x) => x.post === 3)!;
    expect(task).toMatchObject({ status: "ready", output: "u1/b1/src/s1.png", source: "s1" });
    const takes = await env.DB.prepare("SELECT post, status, cost, note FROM post_takes WHERE post = 3").all<{ post: number; status: string; cost: number; note: string }>();
    expect(takes.results).toEqual([{ post: 3, status: "made", cost: 0, note: "The product's own photo (drive), no spend" }]);
    expect((await app().request("/api/studio/posts/add-from-product", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", source: "nope" }) }, env)).status).toBe(404);
  });
});

describe("Moving a card", () => {
  it("numbers the posts again in the new order and moves everything filed under a number", async () => {
    const env = await seed();
    const t = Date.now();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[]; approvals?: Record<string, unknown> };
    cfg.plan.push({ index: 3, type: "product", title: "Third", brief: "x", caption: "", hashtags: "", product: "sakina" } as never);
    cfg.approvals = { "1": { status: "approved" } };
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t3', 'b1', 's1', 3, 'ready', 'u1/b1/output/t3/a.png', '', 3, ?)").bind(t).run();
    await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, created) VALUES ('k1', 'b1', 1, 't1', 'made', 'u1/b1/output/t1/a.png', 0, 'first', ?)").bind(t).run();
    // Post 1 goes to the end: the order becomes 2, 3, 1 and the numbers 1, 2, 3.
    const r = await app().request("/api/studio/posts/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, before: null }) }, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, index: 3, order: [1, 2, 3] });
    const plan = await planOf(env);
    expect(plan.map((p) => [p.index, p.title])).toEqual([
      [1, "Series one"],
      [2, "Third"],
      [3, "فخارة شعيرية"],
    ]);
    const rows = await tasksOf(env);
    expect(rows.map((x) => [x.post, x.output])).toEqual([
      [2, "u1/b1/output/t3/a.png"],
      [3, "u1/b1/output/t1/a.png"],
    ]);
    expect((await env.DB.prepare("SELECT post FROM post_takes WHERE id = 'k1'").first<{ post: number }>())!.post).toBe(3);
    const after = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { approvals?: Record<string, unknown> };
    expect(Object.keys(after.approvals ?? {})).toEqual(["3"]);
    // And back before post 1: the order 3, 1, 2.
    const r2 = (await (await app().request("/api/studio/posts/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 3, before: 1 }) }, env)).json()) as { index: number };
    expect(r2.index).toBe(1);
    expect((await planOf(env)).map((p) => p.title)).toEqual(["فخارة شعيرية", "Series one", "Third"]);
  });
  it("makes a later slide the cover when it is moved before slide 1 (28 Oct)", async () => {
    const env = await seed();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    const g = { id: "car", kind: "carousel" as const };
    cfg.plan = [
      { ...cfg.plan[0], group: { ...g, slide: 1, of: 3 } },
      { index: 2, type: "product", title: "Two", brief: "x", caption: "", hashtags: "", product: "sakina", group: { ...g, slide: 2, of: 3 } } as never,
      { index: 3, type: "product", title: "Three", brief: "x", caption: "", hashtags: "", product: "sakina", group: { ...g, slide: 3, of: 3 } } as never,
    ];
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    const r = await app().request("/api/studio/posts/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 3, before: 1 }) }, env);
    expect(r.status).toBe(200);
    const plan = await planOf(env);
    expect(plan.map((p) => [p.index, p.title, p.group?.slide, p.group?.of])).toEqual([
      [1, "Three", 1, 3],
      [2, "فخارة شعيرية", 2, 3],
      [3, "Two", 3, 3],
    ]);
  });
});

describe("Removed posts come back (28 Oct)", () => {
  it("keeps a removed slide whole and restores it to its carousel, picture included", async () => {
    const env = await seed();
    const t = Date.now();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    const g = { id: "car", kind: "carousel" as const };
    cfg.plan = [
      { ...cfg.plan[0], group: { ...g, slide: 1, of: 3 } },
      { index: 2, type: "product", title: "Spicy hot chocolate · slide 2", brief: "x", caption: "c2", hashtags: "", product: "sakina", headline: "H2", group: { ...g, slide: 2, of: 3 } } as never,
      { index: 3, type: "product", title: "Spicy hot chocolate · slide 3", brief: "x", caption: "c3", hashtags: "", product: "sakina", headline: "H3", group: { ...g, slide: 3, of: 3 } } as never,
    ];
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t2', 'b1', 's1', 2, 'ready', 'u1/b1/output/t2/v.png', '', 2, ?)").bind(t).run();
    // Slide 2 goes by mistake.
    const gone = await app().request("/api/studio/posts/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 2 }) }, env);
    expect(gone.status).toBe(200);
    expect((await planOf(env)).map((p) => [p.title, p.group?.slide, p.group?.of])).toEqual([
      ["فخارة شعيرية", 1, 2],
      ["Spicy hot chocolate · slide 3", 2, 2],
    ]);
    const list = (await (await app().request("/api/studio/posts/removed?batch=b1", {}, env)).json()) as { removed: { id: string; title: string; key: string | null; exact: boolean; slide: boolean }[] };
    expect(list.removed).toHaveLength(1);
    expect(list.removed[0]).toMatchObject({ title: "Spicy hot chocolate · slide 2", key: "u1/b1/output/t2/v.png", exact: true, slide: true });
    // And back, as the carousel's last slide, with its words and its picture.
    const r = await app().request("/api/studio/posts/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", version: list.removed[0].id }) }, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, index: 3, slide: 3, of: 3 });
    const plan = await planOf(env);
    expect(plan.map((p) => [p.index, p.title, p.group?.slide, p.group?.of])).toEqual([
      [1, "فخارة شعيرية", 1, 3],
      [2, "Spicy hot chocolate · slide 3", 2, 3],
      [3, "Spicy hot chocolate · slide 3", 3, 3],
    ]);
    expect(plan[2].headline).toBe("H2");
    expect(plan[2].caption).toBe("c2");
    const rows = await tasksOf(env);
    expect(rows.find((x) => x.post === 3)?.output).toBe("u1/b1/output/t2/v.png");
    // Restored once: the list is empty now.
    const again = (await (await app().request("/api/studio/posts/removed?batch=b1", {}, env)).json()) as { removed: unknown[] };
    expect(again.removed).toHaveLength(0);
  });
  it("brings an older removal (picture and title only) back as a post of its own, never into a carousel by its title, and clears stale rows", async () => {
    const env = await seed();
    const t = Date.now();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    const g = { id: "car", kind: "carousel" as const };
    cfg.plan = [{ ...cfg.plan[0], title: "Spicy hot chocolate", group: { ...g, slide: 1, of: 2 } }, { index: 2, type: "product", title: "Spicy hot chocolate · slide 2", brief: "x", caption: "", hashtags: "", product: "sakina", group: { ...g, slide: 2, of: 2 } } as never];
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    await env.DB.prepare("INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES ('v-old', 'b1', 'snapshot', 'Removed: Spicy hot chocolate · slide 3', ?, '[]', ?)").bind(JSON.stringify({ "9": "u1/b1/output/old/x.png" }), t).run();
    // A row left behind under number 3 by an earlier removal must not become the restored post's picture.
    await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('stale', 'b1', 's1', 3, 'ready', 'u1/b1/output/stale.png', '', 3, ?)").bind(t).run();
    const r = await app().request("/api/studio/posts/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", version: "v-old" }) }, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ index: 3, slide: null });
    const plan = await planOf(env);
    expect(plan.map((p) => [p.title, p.group?.slide ?? null, p.group?.of ?? null])).toEqual([
      ["Spicy hot chocolate", 1, 2],
      ["Spicy hot chocolate · slide 2", 2, 2],
      ["Spicy hot chocolate", null, null],
    ]);
    const rows = (await tasksOf(env)).filter((x) => x.post === 3);
    expect(rows.map((x) => x.output)).toEqual(["u1/b1/output/old/x.png"]);
  });
  it("takes a slide out of its carousel: a post of its own in its place, the others numbered again", async () => {
    const env = await seed();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    const g = { id: "car", kind: "carousel" as const };
    cfg.plan = [
      { ...cfg.plan[0], group: { ...g, slide: 1, of: 3 } },
      { index: 2, type: "product", title: "Spicy hot chocolate · slide 2", brief: "x", caption: "", hashtags: "", product: "sakina", group: { ...g, slide: 2, of: 3 } } as never,
      { index: 3, type: "product", title: "Spicy hot chocolate · slide 3", brief: "x", caption: "", hashtags: "", product: "sakina", group: { ...g, slide: 3, of: 3 } } as never,
    ];
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    const r = await app().request("/api/studio/posts/unslide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 2 }) }, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ index: 2, title: "Spicy hot chocolate" });
    expect((await planOf(env)).map((p) => [p.index, p.title, p.group?.slide ?? null, p.group?.of ?? null])).toEqual([
      [1, "فخارة شعيرية", 1, 2],
      [2, "Spicy hot chocolate", null, null],
      [3, "Spicy hot chocolate · slide 3", 2, 2],
    ]);
    // The last slide out too: nothing is a carousel any more.
    await app().request("/api/studio/posts/unslide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 3 }) }, env);
    expect((await planOf(env)).every((p) => !p.group)).toBe(true);
    const no = await app().request("/api/studio/posts/unslide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1 }) }, env);
    expect(no.status).toBe(409);
  });
});

describe("a slide dragged onto another post moves carousel (28 Oct)", () => {
  it("leaves its carousel and joins the target's", async () => {
    const env = await seed();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    const a = { id: "car-a", kind: "carousel" as const };
    cfg.plan = [
      { ...cfg.plan[0], group: { ...a, slide: 1, of: 2 } },
      { index: 2, type: "product", title: "Spicy hot chocolate · slide 2", brief: "x", caption: "", hashtags: "", product: "sakina", group: { ...a, slide: 2, of: 2 } } as never,
      { index: 3, type: "product", title: "Other", brief: "x", caption: "", hashtags: "", product: "sakina" } as never,
    ];
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    const r = await app().request("/api/studio/posts/carousel-join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 2, into: 3 }) }, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ slide: 2 });
    const plan = await planOf(env);
    expect(plan.map((p) => [p.index, p.group?.id ?? null, p.group?.slide ?? null, p.group?.of ?? null])).toEqual([
      [1, null, null, null],
      [2, plan[2].group!.id, 2, 2],
      [3, plan[2].group!.id, 1, 2],
    ]);
    const same = await app().request("/api/studio/posts/carousel-join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 2, into: 3 }) }, env);
    expect(same.status).toBe(409);
  });
});

import { withWords } from "../shared/layers";
import type { TextDesign } from "../shared/layers";

describe("words typed on the card reach the design (post 1 of Abu Saleh, 28 Oct)", () => {
  const design: TextDesign = {
    version: 1,
    layers: [
      { id: "logo", type: "logo", x: 0.4, y: 0.03, w: 0.16 },
      { id: "h", type: "text", name: "Headline", text: "", x: 0.1, y: 0.15, w: 0.8, font: "Graphic School", weight: 700, size: 0.08, lineHeight: 1.1, align: "center", fill: { type: "solid", color: "#fff" } },
      { id: "s", type: "text", text: "", x: 0.1, y: 0.25, w: 0.8, font: "Graphic School", weight: 400, size: 0.05, lineHeight: 1.1, align: "center", fill: { type: "solid", color: "#fff" } },
    ],
  };
  it("fills empty layers, keeps typed ones unless the words changed", () => {
    const filled = withWords(design, { headline: "حرّاقة", subline: "من أبو صالح" }, { onlyEmpty: true });
    expect(filled.layers.map((l) => (l.type === "text" ? l.text : l.type))).toEqual(["logo", "حرّاقة", "من أبو صالح"]);
    expect(withWords(filled, { headline: "x" }, { onlyEmpty: true })).toBe(filled);
    const changed = withWords(filled, { headline: "جديد" });
    expect((changed.layers[1] as { text: string }).text).toBe("جديد");
    expect((changed.layers[2] as { text: string }).text).toBe("من أبو صالح");
  });
  it("saves the words into the design when the card's headline changes", async () => {
    const env = await seed();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] };
    cfg.plan[0] = { ...cfg.plan[0], ov: { design } } as Post;
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
    const edited = (await planOf(env)).map((p) => (p.index === 1 ? { ...p, headline: "فخارة شعيرية", subline: "بتدفي القلب" } : p));
    const r = await app().request("/api/studio/posts/plan", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", plan: edited }) }, env);
    expect(r.status).toBe(200);
    const saved = (await planOf(env))[0];
    expect(saved.ov?.design?.layers.map((l) => (l.type === "text" ? l.text : l.type))).toEqual(["logo", "فخارة شعيرية", "بتدفي القلب"]);
  });
});
