/**
 * Writing a month's ideas again replaces the ideas, never the client's own pictures and clips: they
 * are not ideas and nothing would write them back. Found in the QA round: "Regenerate ideas" on a
 * month of Drive photos dropped every photo card. Demo answers; no provider is reached.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";

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
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const photo = (index: number, name: string): Post =>
  ({ index, type: "lifestyle", title: name, brief: "", caption: "", hashtags: "", source: "media", media: { kind: "image", from: "drive", name: `${name}.jpg`, fp: `drive:${name}:1`, at: 1 } }) as unknown as Post;

async function seed(plan: Post[]) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2027-03", { postCount: 3, plan });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2027-03')").bind(JSON.stringify(config), t, t).run();
  return env;
}
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config).plan ?? [];

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});

describe("writing the ideas again on a month with the client's own pictures", () => {
  it("keeps every picture card with its number and puts the new ideas after them", async () => {
    const env = await seed([photo(1, "ZEKO5837"), photo(2, "ZEKO5846")]);
    const a = await app();
    const r = await a.request("/api/studio/posts/ideas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", count: 3 }) }, env);
    expect(r.status, await r.clone().text()).toBe(200);
    const plan = await planOf(env);
    expect(plan.slice(0, 2).map((p) => [p.index, p.title, p.source])).toEqual([
      [1, "ZEKO5837", "media"],
      [2, "ZEKO5846", "media"],
    ]);
    const ideas = plan.slice(2);
    expect(ideas.length).toBeGreaterThanOrEqual(1);
    expect(ideas.every((p) => p.source !== "media")).toBe(true);
    // Numbers stay unique: the ideas start after the last picture.
    expect(new Set(plan.map((p) => p.index)).size).toBe(plan.length);
    expect(Math.min(...ideas.map((p) => p.index))).toBe(3);
    expect(reached).toEqual([]);
  });
});
