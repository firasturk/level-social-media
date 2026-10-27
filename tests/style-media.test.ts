import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import * as posts from "../server/posts";
import { productCountInstruction, styleProductCount } from "../server/style-media";

/**
 * A client's own picture made in a style for real (27 Oct): each chosen card's photo becomes a
 * product of the month, the post a planned post again written in the style (exact when the style
 * shows one product; other products of the month, rotated, when it shows several), ready for the
 * usual Generate. Nothing is made or paid here: the guard fails any network call; the demo fixture
 * writes the style's shot.
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

const media = (index: number, title: string, ext: string): Post => ({ index, type: "product", title, brief: "", caption: "", hashtags: "", source: "media", media: { kind: "image", from: "drive", name: `${title}.${ext}`, fp: `drive:${index}`, at: 1 } }) as Post;

async function seed(products: number) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Abu Saleh', 'test-abu-saleh-styles', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [media(1, "فخارة شعيرية", "png"), media(2, "شهيرة", "jpg"), { index: 3, type: "tip", title: "Planned", brief: "A tip card.", caption: "", hashtags: "" } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Abu Saleh · October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  // One product of the month already: the pool for a style that shows several products.
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind, role, note) VALUES ('s0', 'b1', 'Spanish latte.png', 'spanish latte', 'u1/b1/src/s0.png', 'image/png', 10, ?, 'product', 'lead', 'a tall latte')").bind(t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind, role) VALUES ('sm', 'b1', 'media/intake', 'media-intake', 'u1/b1/src/sm.png', 'image/png', 0, ?, 'reference', 'supporting')").bind(t).run();
  for (const [i, ext] of [[1, "png"], [2, "jpg"]] as const) await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES (?, 'b1', 'sm', ?, 'ready', ?, '', ?, ?)").bind(`t${i}`, i, `u1/b1/output/t${i}/a.${ext}`, i, t).run();
  await env.DB.prepare("INSERT INTO styles (id, kind, status, title, prompt, tags, source, note, created, updated, products) VALUES ('st1', 'product', 'active', 'Claw Machine Grab', 'the product held by a claw inside a glass arcade machine, neon light, 35 mm, shallow depth of field', 'arcade, neon', '', '', ?, ?, ?)").bind(t, t, products).run();
  return env;
}

const apply = (env: FakeEnv, indexes: number[], style = "st1") => app().request("/api/studio/posts/style-media", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", assign: indexes.map((index) => ({ index, style })) }) }, env);
const applyMixed = (env: FakeEnv, assign: { index: number; style: string }[]) => app().request("/api/studio/posts/style-media", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", assign }) }, env);
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] }).plan;
const productsOf = (env: FakeEnv) => env.DB.prepare("SELECT name, key, stem FROM sources WHERE kind = 'product' ORDER BY name").all<{ name: string; key: string; stem: string }>().then((r) => r.results);

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  // The products' notes are written by a vision call elsewhere: stood in for here.
  vi.spyOn(posts, "describeProducts").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("a style that shows one product", () => {
  it("makes each card's photo a product and the post a planned post in the style, exact, the photo kept", async () => {
    const env = await seed(1);
    const r = await apply(env, [1, 2]);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { prepared: { index: number; product: string; extras: string[]; exact: boolean }[]; counts: Record<string, number> };
    expect(d.counts).toEqual({ st1: 1 });
    expect(d.prepared).toEqual([
      { index: 1, product: "فخارة شعيرية", extras: [], exact: true },
      { index: 2, product: "شهيرة", extras: [], exact: true },
    ]);
    expect(await productsOf(env)).toEqual([
      { name: "Spanish latte.png", key: "u1/b1/src/s0.png", stem: "spanish latte" },
      { name: "شهيرة.jpg", key: "u1/b1/output/t2/a.jpg", stem: "شهيرة" },
      { name: "فخارة شعيرية.png", key: "u1/b1/output/t1/a.png", stem: "فخارة شعيرية" },
    ]);
    const plan = await planOf(env);
    const one = plan.find((p) => p.index === 1)!;
    expect(one.source).toBeUndefined();
    expect(one.media).toBeUndefined();
    expect(one).toMatchObject({ product: "فخارة شعيرية", exact: true, style: "st1" });
    expect(one.products).toBeUndefined();
    expect(one.scene).toMatch(/\S/);
    // The planned post was not touched.
    expect(plan.find((p) => p.index === 3)).toMatchObject({ title: "Planned", brief: "A tip card." });
  });

  it("does not add the same photo as a product twice, and refuses a card still being made", async () => {
    const env = await seed(1);
    await apply(env, [1]);
    await apply(env, [1]);
    expect((await productsOf(env)).filter((s) => s.key === "u1/b1/output/t1/a.png")).toHaveLength(1);
    await env.DB.prepare("UPDATE tasks SET status = 'processing' WHERE id = 't2'").run();
    expect((await apply(env, [2])).status).toBe(409);
  });
});

describe("a style that shows several products", () => {
  it("gives each card other products of the month, rotated so the cards differ, drawn from their photos", async () => {
    const env = await seed(2);
    const d = (await (await apply(env, [1, 2])).json()) as { prepared: { index: number; product: string; extras: string[]; exact: boolean }[] };
    expect(d.prepared[0]).toMatchObject({ index: 1, product: "فخارة شعيرية", exact: false });
    expect(d.prepared[1]).toMatchObject({ index: 2, product: "شهيرة", exact: false });
    expect(d.prepared[0].extras).toHaveLength(1);
    expect(d.prepared[1].extras).toHaveLength(1);
    expect(d.prepared[0].extras[0]).not.toBe("فخارة شعيرية");
    expect(d.prepared[1].extras[0]).not.toBe("شهيرة");
    // Two cards, two other products: each card took a different one.
    expect(d.prepared[0].extras[0]).not.toBe(d.prepared[1].extras[0]);
    const plan = await planOf(env);
    expect(plan.find((p) => p.index === 1)!.products).toEqual(d.prepared[0].extras);
    expect(plan.find((p) => p.index === 1)!.exact).toBeUndefined();
  });
  it("takes at most the products the month has", async () => {
    const env = await seed(6);
    const d = (await (await apply(env, [1, 2])).json()) as { prepared: { extras: string[] }[] };
    // The month holds three products once both cards joined: each card and two others, never six.
    expect(d.prepared[0].extras).toHaveLength(2);
    expect(d.prepared[1].extras).toHaveLength(2);
  });
});

describe("several styles in one request", () => {
  it("writes each card its own style, counts every style once, and rotates the extras across the cards", async () => {
    const env = await seed(4);
    const t = Date.now();
    await env.DB.prepare("INSERT INTO styles (id, kind, status, title, prompt, tags, source, note, created, updated, products) VALUES ('st2', 'product', 'active', 'Starry Slush', 'the product alone under a starry sky, low angle', 'night', '', '', ?, ?, 1)").bind(t, t).run();
    const r = await applyMixed(env, [
      { index: 1, style: "st1" },
      { index: 2, style: "st2" },
    ]);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { prepared: { index: number; extras: string[]; exact: boolean }[]; counts: Record<string, number> };
    expect(d.counts).toEqual({ st1: 4, st2: 1 });
    // Card 1's style shows four products: the month's other two join it. Card 2's shows one: exact.
    expect(d.prepared[0]).toMatchObject({ index: 1, exact: false });
    expect(d.prepared[0].extras.sort()).toEqual(["Spanish latte", "شهيرة"]);
    expect(d.prepared[1]).toMatchObject({ index: 2, extras: [], exact: true });
    const plan = await planOf(env);
    expect(plan.find((p) => p.index === 1)!.style).toBe("st1");
    expect(plan.find((p) => p.index === 2)!.style).toBe("st2");
  });
});

describe("how many products a style shows", () => {
  it("is kept on the style once read; a style with no picture counts as one, with no call", async () => {
    const env = await seed(0);
    const row = (await env.DB.prepare("SELECT * FROM styles WHERE id = 'st1'").first())! as never;
    expect(await styleProductCount(env, row)).toBe(1);
    expect((await env.DB.prepare("SELECT products FROM styles WHERE id = 'st1'").first<{ products: number }>())!.products).toBe(1);
    expect(await styleProductCount(env, { ...(row as object), products: 3 } as never)).toBe(3);
  });
  it("asks the vision model to count product units, not props or hands", () => {
    const text = productCountInstruction({ title: "Claw Machine Grab", prompt: "the product held by a claw" });
    expect(text).toMatch(/Count the separate product units/);
    expect(text).toMatch(/Props, ingredients, hands and people do not count/);
    expect(text).toContain('{"count": 1, "same": true}');
  });
});
