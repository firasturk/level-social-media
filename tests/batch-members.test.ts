import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";

/**
 * A month assigned to a team member (28 Oct): the copywriter opens it with full access like its
 * owner, sees it in their months, and loses it when taken off. Only admins assign.
 */
const { studioRoutes } = await import("../server/studio");
type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const WRITER: User = { id: "u2", email: "writer@test", name: "Mona", role: "member" };
const OTHER: User = { id: "u3", email: "other@test", name: "Sami", role: "member" };

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  for (const u of [ADMIN, WRITER, OTHER]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES (?, ?, ?, 'x', ?, ?)").bind(u.id, u.email, u.name, u.role, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Abu Saleh', 'test-abu-saleh-members', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "tip", title: "P", brief: "b", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Abu Saleh · October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const open = (env: FakeEnv, user: User) => app(user).request("/api/studio/batch?batch=b1", {}, env);
const assign = (env: FakeEnv, user: User, users: string[]) => app(user).request("/api/studio/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", users }) }, env);

describe("a month assigned to a team member", () => {
  it("opens for the member with full access, lists in their months, and closes again when taken off", async () => {
    const env = await seed();
    expect((await open(env, WRITER)).status).toBe(404);
    const r = await assign(env, ADMIN, ["u2"]);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true, users: ["u2"] });
    expect((await open(env, WRITER)).status).toBe(200);
    expect((await open(env, OTHER)).status).toBe(404);
    // The member edits the plan like the owner.
    const saved = await app(WRITER).request("/api/studio/posts/plan", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", plan: [{ index: 1, type: "tip", title: "Fixed by Mona", brief: "b", caption: "c", hashtags: "" }] }) }, env);
    expect(saved.status).toBe(200);
    const list = (await (await app(WRITER).request("/api/studio/state", {}, env)).json()) as { batches: { id: string }[] };
    expect(list.batches.map((b) => b.id)).toEqual(["b1"]);
    const who = (await (await app(WRITER).request("/api/studio/members?batch=b1", {}, env)).json()) as { members: { id: string }[]; team: unknown[] };
    expect(who.members.map((m) => m.id)).toEqual(["u2"]);
    expect(who.team).toEqual([]);
    await assign(env, ADMIN, []);
    expect((await open(env, WRITER)).status).toBe(404);
  });
  it("is assigned by admins only, never to its owner, and lists the team for the admin", async () => {
    const env = await seed();
    expect((await assign(env, WRITER, ["u3"])).status).toBe(403);
    expect(await json(await assign(env, ADMIN, ["u1", "u3", "nobody"]))).toEqual({ ok: true, users: ["u3"] });
    const who = (await (await app(ADMIN).request("/api/studio/members?batch=b1", {}, env)).json()) as { owner: string; team: { id: string }[] };
    expect(who.owner).toBe("u1");
    expect(who.team.map((u) => u.id).sort()).toEqual(["u2", "u3"]);
  });
});
