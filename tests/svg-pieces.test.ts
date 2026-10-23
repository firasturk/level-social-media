/**
 * The pieces of a split vector on the Worker: every piece is sanitised before it is stored (the
 * browser's markup is never trusted), identical pieces are stored once, limits hold, only the
 * month's owner (or an admin) may write, an uploaded SVG graphic is sanitised too, and the client's
 * review link serves a piece only through the post whose design holds it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { buildPieceSvg, prepareSplit } from "../shared/svg-split";
import { sanitizeSvg } from "../shared/svg-sanitize";

type FakeEnv = ReturnType<typeof fakeEnv>;
const JSON_HEADERS = { "content-type": "application/json" };
const TOKEN = "d".repeat(32);

async function studio(user: Partial<User> = {}) {
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "member", ...user } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) =>
    e instanceof StudioError
      ? c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400)
      : c.json({ error: String(e) }, 500),
  );
  return a;
}
async function share() {
  const { shareRoutes } = await import("../server/share");
  const a = new Hono<{ Bindings: FakeEnv }>();
  a.route("/api/share", shareRoutes);
  a.onError((e, c) =>
    e instanceof StudioError
      ? c.json({ error: e.message }, e.status as 400)
      : c.json({ error: String(e) }, 500),
  );
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u2', 'v@test', 'V', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'svg-pieces-client', 'active', ?, ?)",
  )
    .bind(t, t)
    .run();
  const plan = [1, 2].map((index) => ({
    index,
    type: "offer",
    title: `Post ${index}`,
    brief: "",
    caption: "",
    hashtags: "",
    headline: "MOVE",
    subline: "",
  }));
  const config = postConfig("c1", "2026-10", { shareToken: TOKEN, plan: plan as never });
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b2', 'u2', 'Other', ?, 'idle', ?, ?, 'c1', '2026-10')",
  )
    .bind(JSON.stringify(postConfig("c1", "2026-10", { plan: plan as never })), t, t)
    .run();
  return env;
}

const badge = prepareSplit(
  sanitizeSvg(readFileSync(join(__dirname, "fixtures", "svg", "badge.svg"), "utf8")),
);
const PIECE_A = buildPieceSvg(badge, [badge.items[1]], { x: 45, y: 45, w: 310, h: 310 });
const PIECE_B = buildPieceSvg(badge, [badge.items[4]], { x: 145, y: 285, w: 110, h: 30 });
const HOSTILE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" fill="#000" onclick="x()"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><use href="https://evil.test/s.svg#a"/><rect style="fill:url(https://evil.test/p)" width="2" height="2"/></svg>';

const sendPieces = async (
  env: FakeEnv,
  pieces: unknown,
  batch = "b1",
  user: Partial<User> = {},
) => {
  const r = await (
    await studio(user)
  ).request(
    `/api/studio/posts/graphic/pieces?batch=${batch}`,
    { method: "POST", body: JSON.stringify({ pieces }), headers: JSON_HEADERS },
    env,
  );
  return {
    status: r.status,
    body: (await r.json()) as { urls?: string[]; stored?: number; reused?: number; error?: string },
  };
};
const keyOf = (url: string) => `u1/b1/graphics/${new URL(url, "https://x").searchParams.get("id")}`;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("storing the pieces of a vector", () => {
  it("stores each piece sanitised, under the month, once per identical piece", async () => {
    const env = await seed();
    const r = await sendPieces(env, [PIECE_A, PIECE_B, PIECE_A]);
    expect(r.status).toBe(200);
    expect(r.body.urls).toHaveLength(3);
    expect(r.body.urls![0]).toBe(r.body.urls![2]);
    expect(r.body.urls![0]).toMatch(/^\/api\/studio\/posts\/graphic\?batch=b1&id=[0-9a-f]{32}$/);
    expect(r.body.stored).toBe(2);
    expect(r.body.reused).toBe(1);
    const obj = await env.BUCKET.get(keyOf(r.body.urls![0]));
    expect(obj?.httpMetadata?.contentType).toBe("image/svg+xml");
    expect(await obj!.text()).toBe(sanitizeSvg(PIECE_A));
    // The same piece again (another split of the same vector): reused, nothing new written.
    const again = await sendPieces(env, [PIECE_B]);
    expect(again.body).toMatchObject({ stored: 0, reused: 1, urls: [r.body.urls![1]] });
    // Served back by the graphic route, with the SVG's CSP.
    const got = await (await studio()).request(r.body.urls![1], {}, env);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/svg+xml");
    expect(got.headers.get("content-security-policy")).toMatch(/sandbox/);
  });
  it("never writes unsanitised SVG: scripts, handlers, foreign content and outside references are gone", async () => {
    const env = await seed();
    const r = await sendPieces(env, [HOSTILE]);
    expect(r.status).toBe(200);
    const text = await (await env.BUCKET.get(keyOf(r.body.urls![0])))!.text();
    expect(text).not.toMatch(/script|onload|onclick|foreignObject|evil\.test/i);
    expect(text).toContain("<rect");
  });
  it("refuses what is not an SVG, too many pieces, a piece too large, and another owner's month", async () => {
    const env = await seed();
    expect((await sendPieces(env, ["hello"])).status).toBe(400);
    expect((await sendPieces(env, ["<html><svg/></html>"])).body.error).toMatch(/Piece 1/);
    expect((await sendPieces(env, [])).status).toBe(400);
    expect(
      (
        await sendPieces(
          env,
          Array.from({ length: 41 }, () => PIECE_A),
        )
      ).status,
    ).toBe(400);
    const big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="${"M0 0L1 1".repeat(330_000)}"/></svg>`;
    expect((await sendPieces(env, [big])).body.error).toMatch(/over 2 MB/);
    expect((await sendPieces(env, [PIECE_A], "b2")).status).toBe(404);
    // An admin may write to any month (as with every graphic).
    expect((await sendPieces(env, [PIECE_A], "b2", { role: "admin" })).status).toBe(200);
  });
  it("sanitises an uploaded SVG graphic too", async () => {
    const env = await seed();
    const form = new FormData();
    form.set("file", new File([HOSTILE], "logo.svg", { type: "image/svg+xml" }));
    const r = await (
      await studio()
    ).request("/api/studio/posts/graphic?batch=b1", { method: "POST", body: form }, env);
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    const id = new URL(url, "https://x").searchParams.get("id");
    const text = await (await env.BUCKET.get(`u1/b1/graphics/${id}`))!.text();
    expect(text).not.toMatch(/script|onload|onclick|foreignObject|evil\.test/i);
    const bad = new FormData();
    bad.set("file", new File(["not an svg"], "x.svg", { type: "image/svg+xml" }));
    expect(
      (
        await (
          await studio()
        ).request("/api/studio/posts/graphic?batch=b1", { method: "POST", body: bad }, env)
      ).status,
    ).toBe(400);
  });
});

describe("pieces on the client's review link", () => {
  it("serves a piece through the post that holds it, and refuses it anywhere else", async () => {
    const env = await seed();
    const r = await sendPieces(env, [PIECE_A, PIECE_B]);
    const [a, b] = r.body.urls!;
    const other = await sendPieces(env, [PIECE_A], "b2", { id: "u2" });
    // Post 1 holds two pieces of a split vector; post 2 holds nothing; one layer points at another month's piece.
    const row = await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{
      config: string;
    }>();
    const config = JSON.parse(row!.config);
    config.plan[0].ov = {
      design: {
        version: 1,
        layers: [
          {
            id: "P1",
            type: "image",
            src: a,
            x: 0.1,
            y: 0.1,
            w: 0.3,
            h: 0.3,
            fit: "contain",
            format: "SVG",
            piece: true,
            group: "Gv",
          },
          {
            id: "P2",
            type: "image",
            src: b,
            x: 0.2,
            y: 0.5,
            w: 0.2,
            h: 0.05,
            fit: "contain",
            format: "SVG",
            piece: true,
            group: "Gv",
            bgShape: true,
          },
          { id: "P3", type: "image", src: other.body.urls![0], x: 0, y: 0, w: 0.1, h: 0.1 },
        ],
      },
    };
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'")
      .bind(JSON.stringify(config))
      .run();
    const app = await share();
    const page = (await (await app.request(`/api/share/${TOKEN}`, {}, env)).json()) as {
      posts: {
        index: number;
        ov?: { design?: { layers: { id: string; src: string; piece?: boolean }[] } };
      }[];
    };
    const layers = page.posts.find((p) => p.index === 1)!.ov!.design!.layers;
    expect(layers.map((l) => l.src)).toEqual([
      `/api/share/${TOKEN}/layer/1/P1`,
      `/api/share/${TOKEN}/layer/1/P2`,
      `/api/share/${TOKEN}/layer/1/P3`,
    ]);
    expect(layers[0].piece).toBe(true);
    const ok = await app.request(`/api/share/${TOKEN}/layer/1/P1`, {}, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/svg+xml");
    expect(ok.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(await ok.text()).toBe(sanitizeSvg(PIECE_A));
    // The same piece asked for through post 2 (which does not hold it), another month's piece, an unknown layer: refused.
    expect((await app.request(`/api/share/${TOKEN}/layer/2/P1`, {}, env)).status).toBe(404);
    expect((await app.request(`/api/share/${TOKEN}/layer/1/P3`, {}, env)).status).toBe(404);
    expect((await app.request(`/api/share/${TOKEN}/layer/1/P9`, {}, env)).status).toBe(404);
  });
});
