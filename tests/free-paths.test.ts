import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";

/**
 * The free paths of the workflow never reach a vendor: reading the plan, the art director's reading
 * in demo mode, the takes and versions, the ideas chat in demo mode, saving a plan. A fetch guard
 * fails the test the moment anything is called on the network. No key is stored in this
 * environment, so every text call is answered by the demo fixture.
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

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "product", title: "Pistachio crossing", brief: "The green shake in the crossing sign, pistachios on the stripes.", caption: "", hashtags: "", product: "pistachio" } as never,
      { index: 2, type: "tip", title: "Tip", brief: "A tip card on a wooden table.", caption: "", hashtags: "" } as never,
    ],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.BUCKET.put("u1/b1/src/s1.jpg", new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES ('tk1', 'b1', 1, 'task-1', 'made', 'u1/b1/output/task-1/a.jpg', 0.13, '', 1, ?)").bind(t).run();
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
let reached: Reached[];

beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the free paths reach no vendor", () => {
  it("reads the plan: scope, estimate, per-post changes, no network", async () => {
    const env = await seed();
    const a = await app();
    const r = await a.request("/api/studio/posts/plan-preview", { method: "POST", body: JSON.stringify({ batch: "b1" }), headers: { "content-type": "application/json" } }, env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { posts: { index: number; status: string; changes?: string[] }[]; paid: number; estimate: { total: number } };
    expect(d.posts.find((p) => p.index === 1)?.status).toBe("ready");
    expect(d.paid).toBeGreaterThan(0);
    expect(d.estimate.total).toBeGreaterThan(0);
  });

  it("reads the scenes before paying from the demo fixture and the preview shows the reading", async () => {
    const env = await seed();
    const a = await app();
    const r = await a.request("/api/studio/posts/plan-preflight", { method: "POST", body: JSON.stringify({ batch: "b1" }), headers: { "content-type": "application/json" } }, env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { read: { index: number; notes: string[] }[] };
    expect(d.read.length).toBeGreaterThan(0);
    const rows = await env.DB.prepare("SELECT post, revision FROM plan_preflights WHERE batch = 'b1'").all<{ post: number }>();
    expect(rows.results.map((x) => x.post)).toContain(1);
    const again = (await json(await a.request("/api/studio/posts/plan-preview", { method: "POST", body: JSON.stringify({ batch: "b1" }), headers: { "content-type": "application/json" } }, env))) as { posts: { index: number; preflight?: { notes: string[] } | null }[] };
    expect(again.posts.find((p) => p.index === 1)?.preflight).toBeTruthy();
  });

  it("lists the takes and the versions without touching the network", async () => {
    const env = await seed();
    const a = await app();
    const takes = (await json(await a.request("/api/studio/posts/takes?batch=b1&index=1", {}, env))) as { takes: { id: string; cost: number; current: boolean }[] };
    expect(takes.takes.map((t) => [t.id, t.cost, t.current])).toEqual([["tk1", 0.13, false]]);
    const versions = await a.request("/api/studio/posts/versions?batch=b1", {}, env);
    expect(versions.status).toBe(200);
  });

  it("saves a plan edit (keepRef) and the ideas chat answers from the fixture", async () => {
    const env = await seed();
    const a = await app();
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: { index: number; keepRef?: boolean }[] };
    const plan = cfg.plan.map((p) => (p.index === 1 ? { ...p, keepRef: true } : p));
    const put = await a.request("/api/studio/posts/plan", { method: "PUT", body: JSON.stringify({ batch: "b1", plan }), headers: { "content-type": "application/json" } }, env);
    expect(put.status).toBe(200);
    const saved = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: { index: number; keepRef?: boolean }[] };
    expect(saved.plan.find((p) => p.index === 1)?.keepRef).toBe(true);
    const chat = await a.request("/api/studio/posts/chat", { method: "POST", body: JSON.stringify({ batch: "b1", message: "Post 2 on the pistachio instead." }), headers: { "content-type": "application/json" } }, env);
    expect([200, 409]).toContain(chat.status);
  });
});
