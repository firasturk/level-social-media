/**
 * Phase 3 through the editor's routes (in-memory D1/R2, every migration applied, the paid-route
 * guard on): a phase-1 draft saved and reopened as version 2, the LUT table and a colour match and
 * a music library source kept with the draft and given back exactly, a 33³ table inside the size
 * limit, and members still unable to write. Nothing leaves the test.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { musicSourceFromTrack, newClip, newProject, PROJECT_VERSION, type VideoProject } from "../shared/video-project";
import { serialiseCube } from "../shared/cube-lut";
import { applyTemplate, TEMPLATES } from "../shared/video-templates";
import { catalogEntry } from "../shared/music-catalog";
import { catalogTrack } from "../server/music";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const E = "/api/studio/posts/video/editor";

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Mona', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Kunafa test', 'kunafa-test', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "product", title: "Kunafa", brief: "A kunafa", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}

const call = (user: User, env: FakeEnv, method: string, path: string, body?: unknown) => app(user).request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env);
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

/** A 17³ table that warms: red up, blue down. */
function warmLut() {
  const n = 17;
  const data = new Float32Array(n * n * n * 3);
  let i = 0;
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        data[i++] = Math.min(1, (r / (n - 1)) * 1.1);
        data[i++] = g / (n - 1);
        data[i++] = (b / (n - 1)) * 0.9;
      }
  return serialiseCube({ title: "warm", size: n, data });
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached).toEqual([]);
});

describe("phase 3 documents through the editor's routes", () => {
  it("saves a phase-1 (version 1) draft and gives it back as version 2 with the same colour", async () => {
    const env = await seed();
    const v1 = { ...newProject("Old cut", 1000), v: 1, look: "warm", clips: [newClip({ kind: "version", batch: "b1", videoId: "v1" }, 2, "a")] } as Record<string, unknown>;
    delete v1.lookAmount;
    delete v1.protectSkin;
    const r = await call(ADMIN, env, "POST", `${E}/projects`, { batch: "b1", post: 1, name: "Old cut", project: v1 });
    expect(r.status).toBe(200);
    const d = await json(r);
    expect(d.document).toMatchObject({ v: PROJECT_VERSION, look: "warm", lookAmount: 1, protectSkin: false, rev: 1 });
    const id = (d.project as { id: string }).id;
    const row = await env.DB.prepare("SELECT project FROM video_projects WHERE id = ?").bind(id).first<{ project: string }>();
    expect(JSON.parse(row!.project)).toMatchObject({ v: PROJECT_VERSION, lookAmount: 1, protectSkin: false });
    // A row written by phase 1 (version 1 in the database) still opens.
    await env.DB.prepare("UPDATE video_projects SET project = ? WHERE id = ?").bind(JSON.stringify({ ...v1, rev: 1 }), id).run();
    const open = await json(await call(MEMBER, env, "GET", `${E}/projects/${id}`));
    expect(open.document).toMatchObject({ v: PROJECT_VERSION, look: "warm", lookAmount: 1 });
  });

  it("keeps the LUT table, a colour match, a clip's own preset, the template and a catalog track, and gives them back exactly", async () => {
    const env = await seed();
    const lut = warmLut();
    const base = { ...newProject("Looks", 1000), clips: [newClip({ kind: "version", batch: "b1", videoId: "v1" }, 3, "a"), newClip({ kind: "version", batch: "b1", videoId: "v2" }, 3, "b")] };
    const p: VideoProject = {
      ...applyTemplate(TEMPLATES[0], base, [{ source: { kind: "version", batch: "b1", videoId: "v1" }, duration: 3 }], { now: 7 }),
      lut: { name: "warm.cube", size: lut.size, strength: 0.8, data: lut.data },
      music: { source: musicSourceFromTrack(catalogTrack(catalogEntry("desert-city")!)), offset: 0, volume: 0.9, fadeIn: 0.5, fadeOut: 1 },
    };
    p.clips[0] = { ...p.clips[0], look: { id: "warm-film", amount: 0.6 }, match: { ref: { kind: "studio", id: "ref1", name: "Pin" }, scale: [1.05, 0.9, 1.1], offset: [2, 4, -3], amount: 0.75, frames: 5, at: 9 } };
    p.clips[1] = { ...p.clips[1], look: { id: "bold-sport", amount: 1 } };
    const r = await call(ADMIN, env, "POST", `${E}/projects`, { batch: "b1", post: 1, name: "Looks", project: p });
    expect(r.status).toBe(200);
    const id = ((await json(r)).project as { id: string }).id;
    const back = (await json(await call(MEMBER, env, "GET", `${E}/projects/${id}`))).document as VideoProject;
    expect(back.lut).toEqual(p.lut);
    expect(back.clips[0].match).toEqual(p.clips[0].match);
    expect(back.clips[0].look).toEqual({ id: "warm-film", amount: 0.6 });
    expect(back.clips[1].look).toEqual({ id: "bold-sport", amount: 1 });
    expect(back.template).toEqual({ id: "product-launch", at: 7 });
    expect(back.music?.source).toEqual(p.music!.source);
    expect(back.music?.source.kind === "catalog" && back.music.source.rights.attributionRequired).toBe(true);
  });

  it("accepts a 33³ table inside the save limit and refuses a table whose data does not match", async () => {
    const env = await seed();
    const n = 33;
    const big = serialiseCube({ title: "big", size: n, data: new Float32Array(n * n * n * 3).fill(0.5) });
    const ok = await call(ADMIN, env, "POST", `${E}/projects`, { batch: "b1", post: 1, name: "Big", project: { ...newProject("Big", 1000), lut: { name: "big.cube", size: 33, strength: 1, data: big.data } } });
    expect(ok.status).toBe(200);
    const bad = await call(ADMIN, env, "POST", `${E}/projects`, { batch: "b1", post: 1, name: "Bad", project: { ...newProject("Bad", 1000), lut: { name: "bad.cube", size: 17, strength: 1, data: big.data } } });
    expect(bad.status).toBe(400);
    expect(String((await json(bad)).error)).toContain("lut.data");
  });

  it("keeps saving admin-only: a member cannot save a colour change", async () => {
    const env = await seed();
    const r = await call(MEMBER, env, "POST", `${E}/projects`, { batch: "b1", post: 1, name: "x", project: { ...newProject("x", 1000), look: "bold-sport", lookAmount: 0.6 } });
    expect(r.status).toBe(403);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM video_projects").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
