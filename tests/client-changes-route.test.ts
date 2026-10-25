import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Approval } from "../shared/config";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { clientComments } from "../server/posts";

/**
 * "Do client comments" (25 Oct): the art director's proposal is shown first and nothing is saved;
 * Apply writes that proposal as shown, without a second read; the client's comments stay on the
 * posts, marked done. The demo fixture answers; the fetch guard fails the test on any network call.
 */
const { studioRoutes } = await import("../server/studio");
type FakeEnv = ReturnType<typeof fakeEnv>;

function app() {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const ASK: Approval = {
  status: "changes",
  note: "Yousef: carousel please · Ammar: a touch of blue",
  by: "Yousef, Ammar",
  at: 1000,
  answers: [
    { rid: "r1", status: "changes", note: "carousel please", by: "Yousef", at: 900 },
    { rid: "r2", status: "changes", note: "a touch of blue", by: "Ammar", at: 1000 },
  ],
};

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "product", title: "Croissant stack", brief: "Three croissants stacked on travertine.", caption: "رجعناها", hashtags: "#kunafa", headline: "Back again" } as never,
      { index: 2, type: "tip", title: "Gifting", brief: "A gift tray from above.", caption: "", hashtags: "" } as never,
    ],
  });
  config.approvals = { "1": ASK, "2": { status: "approved", at: 1000 } };
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}

const send = (env: FakeEnv, body: unknown) => app().request("/api/studio/posts/client-changes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const configOf = async (env: FakeEnv) => JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[]; approvals?: Record<string, Approval> };

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("Do client comments", () => {
  it("keeps each reviewer's comment apart, and reads an older single note", () => {
    expect(clientComments(ASK)).toEqual([
      { note: "carousel please", by: "Yousef", at: 900 },
      { note: "a touch of blue", by: "Ammar", at: 1000 },
    ]);
    expect(clientComments({ status: "changes", note: "warmer light", at: 5 })).toEqual([{ note: "warmer light", at: 5 }]);
    expect(clientComments({ status: "approved", at: 5 })).toEqual([]);
    expect(clientComments(undefined)).toEqual([]);
  });

  it("shows the proposal first and saves nothing", async () => {
    const env = await seed();
    const before = await configOf(env);
    const r = await send(env, { batch: "b1", preview: true });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { preview: { index: number; title: string; comments: { note: string; by?: string }[]; before: { headline: string; caption: string }; change: { summary: string; caption: string } }[] };
    expect(d.preview).toHaveLength(1);
    expect(d.preview[0]).toMatchObject({ index: 1, title: "Croissant stack", before: { headline: "Back again", caption: "رجعناها" } });
    expect(d.preview[0].comments.map((c) => `${c.by}: ${c.note}`)).toEqual(["Yousef: carousel please", "Ammar: a touch of blue"]);
    expect(d.preview[0].change.summary).toMatch(/applied/);
    expect(await configOf(env)).toEqual(before);
  });

  it("applies the proposal as shown and keeps the comments on the post, marked done", async () => {
    const env = await seed();
    const { preview } = (await (await send(env, { batch: "b1", preview: true })).json()) as { preview: { change: Record<string, unknown> }[] };
    const change = { ...preview[0].change, caption: "Edited by the team before applying" };
    const r = await send(env, { batch: "b1", changes: [change] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { indexes: number[] }).indexes).toEqual([1]);
    const cfg = await configOf(env);
    const p1 = cfg.plan.find((p) => p.index === 1)!;
    expect(p1.caption).toBe("Edited by the team before applying");
    expect(p1.clientNotes?.map((n) => [n.by, n.note])).toEqual([
      ["Yousef", "carousel please"],
      ["Ammar", "a touch of blue"],
    ]);
    expect(p1.clientNotes?.every((n) => n.done > 0 && /applied/.test(n.summary ?? ""))).toBe(true);
    // The request is answered (the link asks the client again); the approval of post 2 is untouched.
    expect(cfg.approvals?.["1"]).toBeUndefined();
    expect(cfg.approvals?.["2"]?.status).toBe("approved");
  });

  it("plans a carousel with the studio's carousel tools, keeps the plan on the post and offers no new picture", async () => {
    const env = await seed();
    const { preview } = (await (await send(env, { batch: "b1", preview: true })).json()) as { preview: { change: { steps: { tool: string }[] } }[] };
    expect(preview[0].change.steps.map((s) => s.tool)).toEqual(["rewrite", "carousel-camera"]);
    const r = (await (await send(env, { batch: "b1", changes: [preview[0].change] })).json()) as { indexes: number[]; remake: number[] };
    expect(r.indexes).toEqual([1]);
    expect(r.remake).toEqual([]);
    const p1 = (await configOf(env)).plan.find((p) => p.index === 1)!;
    expect(p1.clientSteps?.steps.map((s) => s.tool)).toEqual(["rewrite", "carousel-camera"]);
  });

  it("drops a step naming a tool the studio does not have, from a proposal sent back", async () => {
    const env = await seed();
    const { preview } = (await (await send(env, { batch: "b1", preview: true })).json()) as { preview: { change: Record<string, unknown> }[] };
    const r = (await (await send(env, { batch: "b1", changes: [{ ...preview[0].change, steps: [{ tool: "photoshop", what: "x" }, { tool: "remake", what: "new" }] }] })).json()) as { remake: number[] };
    expect(r.remake).toEqual([1]);
    expect((await configOf(env)).plan.find((p) => p.index === 1)!.clientSteps?.steps).toEqual([{ tool: "remake", what: "new" }]);
  });

  it("refuses a proposal whose comments were already done", async () => {
    const env = await seed();
    const { preview } = (await (await send(env, { batch: "b1", preview: true })).json()) as { preview: { change: Record<string, unknown> }[] };
    expect((await send(env, { batch: "b1", changes: [preview[0].change] })).status).toBe(200);
    const again = await send(env, { batch: "b1", changes: [preview[0].change] });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toMatch(/has not asked for a change/);
  });
});
