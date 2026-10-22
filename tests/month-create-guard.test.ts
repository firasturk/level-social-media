import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { inFlight } from "../shared/inflight";
import type { User } from "../shared/types";

/**
 * One month per click. On production five months named "Habibah · 2026-10 · grid 6" were created
 * within four seconds, four of them empty: the create request ran five times before the first
 * answered. Two guards now: the browser shares one in-flight request per action, and the server
 * answers the same month for the same client, month and name asked again within a minute.
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
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'habibah-test', 'active', ?, ?)").bind(t, t).run();
  return env;
}
async function create(a: Awaited<ReturnType<typeof app>>, env: FakeEnv, name?: string, month = "2026-10"): Promise<{ id: string; existing?: boolean }> {
  const r = await a.request("/api/studio/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: postConfig("c1", month), ...(name ? { name } : {}) }) }, env);
  return (await r.json()) as { id: string; existing?: boolean };
}
const count = async (env: FakeEnv) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM batches").first<{ n: number }>())!.n;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the browser sends one create request at a time", () => {
  it("five calls while the first is in flight share one request and one id", async () => {
    let calls = 0;
    let release!: (id: string) => void;
    const fn = inFlight(() => {
      calls++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const all = Promise.all([fn(), fn(), fn(), fn(), fn()]);
    release("m1");
    expect(await all).toEqual(["m1", "m1", "m1", "m1", "m1"]);
    expect(calls).toBe(1);
    // Once answered, the next click is a new request again.
    const next = fn();
    release("m2");
    expect(await next).toBe("m2");
    expect(calls).toBe(2);
  });
  it("a failed request frees the guard", async () => {
    let n = 0;
    const fn = inFlight(async () => {
      n++;
      if (n === 1) throw new Error("no");
      return "ok";
    });
    await expect(fn()).rejects.toThrow("no");
    expect(await fn()).toBe("ok");
  });
});

describe("the server makes one month for the same client, month and name within a minute", () => {
  it("the burst of five 'grid 6' creates gives one month", async () => {
    const env = await seed();
    const a = await app();
    const ids = await Promise.all(Array.from({ length: 5 }, () => create(a, env, "Habibah · 2026-10 · grid 6")));
    expect(new Set(ids.map((r) => r.id)).size).toBe(1);
    expect(ids.filter((r) => r.existing).length).toBe(4);
    expect(await count(env)).toBe(1);
  });
  it("the same month asked for twice without a name is one month too", async () => {
    const env = await seed();
    const a = await app();
    const first = await create(a, env);
    const again = await create(a, env);
    expect(again.id).toBe(first.id);
    expect(again.existing).toBe(true);
    expect(await count(env)).toBe(1);
  });
  it("a different name, month or a binned month is a new month", async () => {
    const env = await seed();
    const a = await app();
    const g6 = await create(a, env, "Habibah · 2026-10 · grid 6");
    const g7 = await create(a, env, "Habibah · 2026-10 · grid 7");
    const nov = await create(a, env, "Habibah · 2026-11 · grid 6", "2026-11");
    expect(new Set([g6.id, g7.id, nov.id]).size).toBe(3);
    // The month binned and asked for again inside the minute is made afresh: the bin keeps the old one.
    await env.DB.prepare("UPDATE batches SET deleted = ? WHERE id = ?").bind(Date.now(), g6.id).run();
    const fresh = await create(a, env, "Habibah · 2026-10 · grid 6");
    expect(fresh.id).not.toBe(g6.id);
    expect(fresh.existing).toBeUndefined();
    expect(await count(env)).toBe(4);
  });
  it("a month made more than a minute ago is not reused", async () => {
    const env = await seed();
    const a = await app();
    const old = await create(a, env, "Habibah · 2026-10 · grid 6");
    await env.DB.prepare("UPDATE batches SET created = ? WHERE id = ?").bind(Date.now() - 120_000, old.id).run();
    const later = await create(a, env, "Habibah · 2026-10 · grid 6");
    expect(later.id).not.toBe(old.id);
  });
});
