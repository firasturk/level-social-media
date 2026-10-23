/**
 * The client's page draws a post's image layers (a stock icon, a background, an uploaded graphic,
 * a product photo) without a sign-in: the page gets each layer through the review link, and the
 * link serves only layers that are on that post of that month.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const TOKEN = "b".repeat(32);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#ff0000" d="M0 0h10v10H0z"/></svg>`;

async function app() {
  const { StudioError } = await import("../server/errors");
  const { shareRoutes } = await import("../server/share");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.route("/api/share", shareRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', 0, ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO assets (id, source, provider_id, kind, title, file_key, layer_key, layer_mime, mime, created) VALUES ('as1', 'freepik', 'fp-1', 'vector', 'Bolt', 'assets/fp-1.zip', 'assets/fp-1.svg', 'image/svg+xml', 'application/zip', ?)").bind(t).run();
  await env.BUCKET.put("assets/fp-1.svg", new TextEncoder().encode(SVG), { httpMetadata: { contentType: "image/svg+xml" } });
  await env.BUCKET.put("u1/b1/graphics/0123456789abcdef", new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
  const design = {
    version: 1,
    layers: [
      { id: "L-icon", type: "image", src: "/api/studio/freepik/assets/as1/file?layer=1", x: 0.6, y: 0.1, w: 0.2, h: 0.2 },
      { id: "L-gfx", type: "image", src: "/api/studio/posts/graphic?batch=b1&id=0123456789abcdef", x: 0, y: 0, w: 1, h: 1, behind: true },
      // Someone else's month: refused even though the layer is on this post.
      { id: "L-other", type: "image", src: "/api/studio/posts/graphic?batch=b2&id=0123456789abcdef", x: 0, y: 0, w: 1, h: 1 },
      { id: "L-text", type: "text", text: "Move", x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
    ],
  };
  const config = postConfig("c1", "2026-10", { shareToken: TOKEN, plan: [{ index: 1, type: "product", title: "Cup", brief: "", caption: "", hashtags: "", ov: { design } } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}

beforeEach(() => {
  guardFetch();
});

describe("image layers on the client's page", () => {
  it("points every studio-addressed image layer at the review link, and serves only the post's own layers", async () => {
    const env = await seed();
    const a = await app();
    const page = (await (await a.request(`/api/share/${TOKEN}`, {}, env)).json()) as { posts: { ov: { design: { layers: { id: string; type: string; src?: string }[] } } }[] };
    const layers = page.posts[0].ov.design.layers;
    expect(layers.find((l) => l.id === "L-icon")?.src).toBe(`/api/share/${TOKEN}/layer/1/L-icon`);
    expect(layers.find((l) => l.id === "L-gfx")?.src).toBe(`/api/share/${TOKEN}/layer/1/L-gfx`);
    expect(layers.find((l) => l.id === "L-text")?.type).toBe("text");
    // No studio address reaches the client's page.
    expect(JSON.stringify(page)).not.toContain("/api/studio/");

    const icon = await a.request(`/api/share/${TOKEN}/layer/1/L-icon`, {}, env);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(await icon.text()).toBe(SVG);
    const gfx = await a.request(`/api/share/${TOKEN}/layer/1/L-gfx`, {}, env);
    expect(gfx.status).toBe(200);
    expect(gfx.headers.get("content-type")).toBe("image/png");

    // Another month's file, a layer that is not on the post, a text layer, a wrong post, a wrong token: refused.
    expect((await a.request(`/api/share/${TOKEN}/layer/1/L-other`, {}, env)).status).toBe(404);
    expect((await a.request(`/api/share/${TOKEN}/layer/1/L-none`, {}, env)).status).toBe(404);
    expect((await a.request(`/api/share/${TOKEN}/layer/1/L-text`, {}, env)).status).toBe(404);
    expect((await a.request(`/api/share/${TOKEN}/layer/2/L-icon`, {}, env)).status).toBe(404);
    expect((await a.request(`/api/share/${"c".repeat(32)}/layer/1/L-icon`, {}, env)).status).toBe(404);
  });
});
