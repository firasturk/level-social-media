import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import { gridMismatch, gridMonth, gridTiles } from "../shared/grid-preview";
import type { GridRead, Post } from "../shared/posts";
import type { User } from "../shared/types";

/**
 * The grid before it is applied: its tiles one by one, the month it gives, and the choice when
 * the month asks for a different number of posts than the grid has tiles. Each choice plans the
 * month to its own size; nothing is applied without it. Demo fixtures, no provider reached.
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

const tile = (n: number, kind: string, row = Math.floor((n - 1) / 3) + 1, col = ((n - 1) % 3) + 1): GridRead["tiles"][number] => ({
  position: `row ${row}, col ${col}`,
  scene: `Tile ${n}: ${kind} close up`,
  productPlacement: "centred",
  textPlacement: "bottom",
  kind: kind as never,
  items: "cup",
  background: kind === "text" ? "cream #f3ece0" : "marble",
  text: { position: kind === "text" ? "center" : "bottom", align: "center", size: kind === "text" ? "huge" : "medium", color: "#ffffff", style: "bold sans" } as never,
});
const NINE: GridRead = { world: "Noon sun.", tiles: ["product", "drink", "text", "product", "detail", "drink", "product", "texture", "text"].map((k, i) => tile(i + 1, k)) };

async function seed(opts: { read?: GridRead | null; plan?: Post[] } = {}) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { model: "nano-banana-pro", postCount: 12, plan: opts.plan });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO styles (id, kind, status, category, score, tiles, w, h, title, tags, prompt, source, note, image_key, thumb_key, position, created, updated) VALUES ('g1', 'product', 'active', 'grid', 9, 9, 1080, 1350, 'Street signs', 'cafe', '', 'upload', '', 'styles/g1.jpg', 'styles/g1-thumb.jpg', 0, ?, ?)").bind(t, t).run();
  await env.BUCKET.put("styles/g1.jpg", new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
  if (opts.read) await env.DB.prepare("INSERT INTO grid_reads (style, read, created) VALUES ('g1', ?, ?)").bind(JSON.stringify(opts.read), t).run();
  return env;
}
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config);

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the tiles of a read grid, for the preview", () => {
  it("lists each tile with its kind, purpose, words and layout; a text tile is free", () => {
    const { tiles, rows, cols } = gridTiles(NINE);
    expect(rows).toBe(3);
    expect(cols).toBe(3);
    expect(tiles.length).toBe(9);
    expect(tiles[2]).toMatchObject({ n: 3, row: 1, col: 3, kind: "text", free: true, words: "words at the center, huge, bold sans", background: "cream #f3ece0" });
    expect(tiles[0]).toMatchObject({ n: 1, kind: "product", free: false, purpose: "Tile 1: product close up" });
    expect(gridTiles(null).tiles).toEqual([]);
  });
  it("the month a grid gives: one design per tile, the text tiles drawn free", () => {
    expect(gridMonth(NINE.tiles, 9)).toEqual({ posts: 9, designs: 9, images: 7, tiles: 2 });
    expect(gridMonth(NINE.tiles, 6)).toEqual({ posts: 6, designs: 6, images: 5, tiles: 1 });
    expect(gridMonth(NINE.tiles, 12)).toEqual({ posts: 12, designs: 12, images: 9, tiles: 3 });
    expect(gridMonth(9, 9)).toEqual({ posts: 9, designs: 9, images: 9, tiles: 0 });
  });
});

describe("the grid's posts and the month's posts differ", () => {
  it("nothing to choose when they match", () => {
    expect(gridMismatch(NINE.tiles, 9)).toBeNull();
    expect(gridMismatch(0, 9)).toBeNull();
  });
  it("fewer posts than tiles: the last tiles are dropped, and it says which separators go", () => {
    const m = gridMismatch(NINE.tiles, 6)!;
    expect(m).toMatchObject({ grid: 9, requested: 6, dropped: [7, 8, 9], repeated: [], textDropped: 1, textRepeated: 0 });
    expect(m.adapt).toContain("tiles 7–9 get no post");
    expect(m.adapt).toContain("1 separator (text tile) of the grid is lost");
    expect(m.useGrid).toContain("Every one of the 9 tiles becomes one post");
    expect(m.useGrid).toContain("2 text tiles drawn here as the separators");
  });
  it("more posts than tiles: the first tiles are used again at the end, separators included", () => {
    const m = gridMismatch(NINE.tiles, 12)!;
    expect(m).toMatchObject({ grid: 9, requested: 12, dropped: [], repeated: [1, 2, 3], textDropped: 0, textRepeated: 1 });
    expect(m.adapt).toContain("tiles 1–3 are used a second time for posts 10–12");
    expect(m.adapt).toContain("1 separator appears twice");
  });
  it("works from a bare tile count when the grid was never read", () => {
    const m = gridMismatch(9, 10)!;
    expect(m.repeated).toEqual([1]);
    expect(m.adapt).toContain("tile 1 is used a second time for post 10");
  });
});

describe("the grid routes", () => {
  it("the picker's summary carries the tiles one by one once the grid was read", async () => {
    const env = await seed({ read: NINE });
    const a = await app();
    const g = await json(await a.request("/api/studio/styles/g1/grid", {}, env));
    expect(g.read).toBe(true);
    expect(g.tiles).toBe(9);
    expect(g.rows).toBe(3);
    expect((g.tileList as unknown[]).length).toBe(9);
    expect(g.layout).toBe("3 rows × 3 columns");
  });
  it("an unread grid is analysed on its own (demo fixture here) and the read is kept; nothing is planned", async () => {
    const env = await seed();
    const a = await app();
    const before = await json(await a.request("/api/studio/styles/g1/grid", {}, env));
    expect(before.read).toBe(false);
    expect(before.tileList).toEqual([]);
    const r = await a.request("/api/studio/styles/g1/grid-read", { method: "POST" }, env);
    expect(r.status).toBe(200);
    const g = await json(r);
    expect(g.read).toBe(true);
    expect(g.fresh).toBe(true);
    expect((g.tileList as { kind: string }[]).some((t) => t.kind === "text")).toBe(true);
    const kept = await env.DB.prepare("SELECT read FROM grid_reads WHERE style = 'g1'").first<{ read: string }>();
    expect(kept).not.toBeNull();
    // Asked again without ?again=1, the kept read answers: no second call.
    const again = await json(await a.request("/api/studio/styles/g1/grid-read", { method: "POST" }, env));
    expect(again.fresh).toBe(false);
    expect((await planOf(env)).plan).toBeUndefined();
  });
});

describe("each mismatch choice plans the month to its own size", () => {
  const ideas = (count: number, env: FakeEnv, a: Awaited<ReturnType<typeof app>>) =>
    a.request("/api/studio/posts/grid-ideas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", ref: "style:g1", count }) }, env);
  it("\"Use the grid's 9 posts\" gives nine posts, one per tile, and sets the month to nine", async () => {
    const env = await seed({ read: NINE });
    const a = await app();
    const r = await ideas(9, env, a);
    expect(r.status).toBe(200);
    const cfg = await planOf(env);
    expect(cfg.plan?.length).toBe(9);
    expect(cfg.postCount).toBe(9);
    expect(cfg.gridRef).toBe("style:g1");
    expect(new Set(cfg.plan!.map((p) => /^Tile (\d+)/.exec(p.tile ?? "")?.[1])).size).toBe(9);
  });
  it("\"Adapt to my 6 posts\" gives six posts from the first six tiles", async () => {
    const env = await seed({ read: NINE });
    const a = await app();
    expect((await ideas(6, env, a)).status).toBe(200);
    const cfg = await planOf(env);
    expect(cfg.plan?.length).toBe(6);
    expect(cfg.postCount).toBe(6);
    const tiles = cfg.plan!.map((p) => Number(/^Tile (\d+)/.exec(p.tile ?? "")?.[1])).sort((x, y) => x - y);
    expect(tiles).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("\"Adapt to my 12 posts\" gives twelve, the first tiles used twice", async () => {
    const env = await seed({ read: NINE });
    const a = await app();
    expect((await ideas(12, env, a)).status).toBe(200);
    const cfg = await planOf(env);
    expect(cfg.plan?.length).toBe(12);
    expect(cfg.postCount).toBe(12);
    const tiles = cfg.plan!.map((p) => Number(/^Tile (\d+)/.exec(p.tile ?? "")?.[1]));
    expect(tiles.filter((t) => t === 1).length).toBe(2);
    expect(tiles.filter((t) => t === 9).length).toBe(1);
  });
});
