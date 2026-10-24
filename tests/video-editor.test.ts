/**
 * The video editor's server side: who may save and render (admins; members get 403 and may still
 * look), the switch (503), the ledger rows a save and an export write, the stale-save guard (409),
 * and the export stored as a version of the post with provider = 'editor' and linked back to its
 * project. Nothing leaves the test: the guard fails on any network call.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { newClip, newProject } from "../shared/video-project";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { adminRoutes } from "../server/admin";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const JSON_HEADERS = { "content-type": "application/json" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.route("/api/admin", adminRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

/** A month owned by the member (so they may view it), with one post that has a picture and one uploaded clip. */
async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Mona', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Kunafa test', 'kunafa-test', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "product", title: "Kunafa", brief: "A kunafa", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'k.jpg', 'k', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u2/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71]).buffer, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare("INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES ('v1', 'b1', 1, 't1', 'u1', 'upload', 'raw.mp4', 'done', NULL, 'u2/b1/video/t1/v1.mp4', NULL, ?, ?, 'upload', '{\"duration\":1}', 'u2/b1/output/t1/a.png', 'upload', 0, NULL)").bind(t, t).run();
  await env.BUCKET.put("u2/b1/video/t1/v1.mp4", sampleBytes(), { httpMetadata: { contentType: "video/mp4" } });
  return env;
}

const doc = () => ({ ...newProject("First cut", 1000), clips: [newClip({ kind: "version", batch: "b1", videoId: "v1" }, 1, "a")] });
const postJson = (user: User, env: FakeEnv, path: string, body: unknown) => app(user).request(path, { method: "POST", body: JSON.stringify(body), headers: JSON_HEADERS }, env);
const putJson = (user: User, env: FakeEnv, path: string, body: unknown) => app(user).request(path, { method: "PUT", body: JSON.stringify(body), headers: JSON_HEADERS }, env);
const create = (user: User, env: FakeEnv, body: object = {}) => postJson(user, env, "/api/studio/posts/video/editor/projects", { batch: "b1", post: 1, name: "First cut", project: doc(), sourceVideo: "v1", ...body });
const render = (user: User, env: FakeEnv, projectId: string, file: ArrayBuffer = sampleBytes()) => {
  const form = new FormData();
  form.set("batch", "b1");
  form.set("post", "1");
  form.set("projectId", projectId);
  form.set("note", "Export 1");
  form.set("file", new File([file], "export.mp4", { type: "video/mp4" }));
  return app(user).request("/api/studio/posts/video/editor/render", { method: "POST", body: form }, env);
};
const ops = (env: FakeEnv) => env.DB.prepare("SELECT provider, kind, user_id, batch, post, estimate, status, task_id FROM integration_ops ORDER BY created, rowid").all() as Promise<{ results: Record<string, unknown>[] }>;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached).toEqual([]);
});

describe("who may write", () => {
  it("lets a member save and update a project too (24 Oct: the team), under their name", async () => {
    const env = await seed();
    const r = await create(MEMBER, env);
    expect(r.status).toBe(200);
    const d = await json(r);
    expect(d.project).toMatchObject({ name: "First cut", rev: 1, createdBy: "u2" });
    const id = (d.project as { id: string }).id;
    expect((await putJson(MEMBER, env, `/api/studio/posts/video/editor/projects/${id}`, { project: doc(), rev: 1 })).status).toBe(200);
    expect((await ops(env)).results.length).toBeGreaterThan(0);
  });

  it("tells a member they may edit: access says admin (may run) with no reason", async () => {
    const env = await seed();
    const made = await json(await create(ADMIN, env));
    const id = (made.project as { id: string }).id;
    const list = await json(await app(MEMBER).request("/api/studio/posts/video/editor/projects?batch=b1&post=1", {}, env));
    expect((list.projects as { id: string; name: string; clips: number; rev: number }[]).map((p) => [p.id, p.name, p.clips, p.rev])).toEqual([[id, "First cut", 1, 1]]);
    expect(list.access).toMatchObject({ admin: true, enabled: true, reason: "" });
    const one = await json(await app(MEMBER).request(`/api/studio/posts/video/editor/projects/${id}`, {}, env));
    expect((one.document as { name: string; rev: number }).name).toBe("First cut");
    expect((one.document as { rev: number }).rev).toBe(1);
  });
});

describe("saving a project", () => {
  it("writes the row and a ledger line with no spend for an admin, and refuses a bad document", async () => {
    const env = await seed();
    const r = await create(ADMIN, env);
    expect(r.status).toBe(200);
    const d = await json(r);
    expect(d.project).toMatchObject({ batch: "b1", post: 1, name: "First cut", rev: 1, sourceVideo: "v1", renderedVideo: null, createdBy: "u1", clips: 1 });
    const row = await env.DB.prepare("SELECT * FROM video_projects").first<{ project: string; rev: number; source_video: string }>();
    expect(row).toMatchObject({ rev: 1, source_video: "v1" });
    expect(JSON.parse(row!.project)).toMatchObject({ name: "First cut", clips: [{ id: "a" }] });
    expect((await ops(env)).results).toEqual([expect.objectContaining({ provider: "editor", kind: "editor.save", user_id: "u1", batch: "b1", post: 1, estimate: 0, status: "done" })]);
    const bad = await create(ADMIN, env, { project: { ...doc(), clips: [{ id: "a", source: { kind: "version", batch: "b1", videoId: "v1" }, duration: 1, in: 0.9, out: 0.2, speed: 1, transition: "cut" }] } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatch(/cannot be saved: clip 1/);
    const wrongVersion = await create(ADMIN, env, { sourceVideo: "nope" });
    expect(wrongVersion.status).toBe(404);
  });

  it("bumps rev on each save and answers 409 with the current rev to a stale tab", async () => {
    const env = await seed();
    const id = ((await json(await create(ADMIN, env))).project as { id: string }).id;
    const path = `/api/studio/posts/video/editor/projects/${id}`;
    const first = await putJson(ADMIN, env, path, { project: { ...doc(), name: "Second pass" }, rev: 1 });
    expect(first.status).toBe(200);
    expect((await json(first)).project).toMatchObject({ rev: 2, name: "Second pass", updatedBy: "u1" });
    const stale = await putJson(ADMIN, env, path, { project: doc(), rev: 1 });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ rev: 2, stale: true, error: expect.stringContaining("saved elsewhere") });
    const row = await env.DB.prepare("SELECT rev, name FROM video_projects WHERE id = ?").bind(id).first<{ rev: number; name: string }>();
    expect(row).toEqual({ rev: 2, name: "Second pass" });
    expect((await ops(env)).results.filter((o) => o.kind === "editor.save")).toHaveLength(2);
    expect((await putJson(ADMIN, env, "/api/studio/posts/video/editor/projects/missing", { project: doc(), rev: 1 })).status).toBe(404);
  });
});

describe("the export", () => {
  it("stores the rendered mp4 as a done version with provider editor, links it to the project and closes the ledger row", async () => {
    const env = await seed();
    const id = ((await json(await create(ADMIN, env))).project as { id: string }).id;
    const r = await render(ADMIN, env, id);
    expect(r.status).toBe(200);
    const d = await json(r);
    // The post had no client version (the seeded upload was never selected): the export becomes it by itself.
    expect(d.video).toMatchObject({ provider: "editor", source: "editor", status: "done", post: 1, version: 2, forClient: true, prompt: "Export 1" });
    expect(d.info).toMatchObject({ isMp4: true, video: "h264", audio: "aac", faststart: true });
    const videoId = (d.video as { id: string }).id;
    expect(d.project).toMatchObject({ id, renderedVideo: videoId });
    const v = await env.DB.prepare("SELECT provider, source, model, status, settings, op_id FROM videos WHERE id = ?").bind(videoId).first<{ provider: string; source: string; model: string; status: string; settings: string; op_id: string }>();
    expect(v).toMatchObject({ provider: "editor", source: "editor", model: `editor:${id}`, status: "done" });
    expect(JSON.parse(v!.settings)).toMatchObject({ project: id, rev: 1, codecs: expect.arrayContaining(["avc1", "mp4a"]), estimate: 0 });
    const rows = (await ops(env)).results;
    expect(rows.find((o) => o.kind === "editor.render")).toMatchObject({ provider: "editor", status: "done", task_id: videoId, estimate: 0 });
    expect(v!.op_id).toBe((await env.DB.prepare("SELECT id FROM integration_ops WHERE kind = 'editor.render'").first<{ id: string }>())!.id);
    // The new version is listed with the post's others; being the first finished clip the post shows the client, it is the client's version.
    const list = await json(await app(MEMBER).request("/api/studio/posts/video/list?batch=b1&index=1", {}, env));
    expect((list.videos as { id: string; provider: string; forClient: boolean }[]).map((x) => [x.provider, x.forClient])).toEqual([
      ["editor", true],
      ["upload", false],
    ]);
    // The stored file serves with Range like any version.
    const slice = await app(MEMBER).request(`/api/studio/posts/video/file?batch=b1&id=${videoId}`, { headers: { Range: "bytes=0-3" } }, env);
    expect(slice.status).toBe(206);
    expect(new Uint8Array(await slice.arrayBuffer())).toEqual(new Uint8Array(sampleBytes().slice(0, 4)));
    // No preview rendition came with this export: cards play the full file.
    expect((d.video as { preview: string | null }).preview).toBeNull();
  });

  it("keeps the preview rendition the browser made at export time, for cards and galleries", async () => {
    const env = await seed();
    const id = ((await json(await create(ADMIN, env))).project as { id: string }).id;
    const form = new FormData();
    form.set("batch", "b1");
    form.set("post", "1");
    form.set("projectId", id);
    form.set("note", "Export 2");
    form.set("file", new File([sampleBytes()], "export.mp4", { type: "video/mp4" }));
    form.set("preview", new File([sampleBytes()], "preview.mp4", { type: "video/mp4" }));
    form.set("still", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2])], "still.jpg", { type: "image/jpeg" }));
    const r = await app(ADMIN).request("/api/studio/posts/video/editor/render", { method: "POST", body: form }, env);
    expect(r.status).toBe(200);
    const video = (await json(r)).video as { id: string; preview: string | null };
    expect(video.preview).toBe(`/api/studio/posts/video/preview?batch=b1&id=${video.id}`);
    const settings = JSON.parse((await env.DB.prepare("SELECT settings FROM videos WHERE id = ?").bind(video.id).first<{ settings: string }>())!.settings) as { previewKey: string; stillKey: string };
    expect(settings.previewKey).toMatch(new RegExp(`${video.id}\\.preview\\.mp4$`));
    expect(settings.stillKey).toMatch(new RegExp(`${video.id}\\.still\\.jpg$`));
    expect((await app(MEMBER).request(video.preview!, { headers: { Range: "bytes=0-3" } }, env)).status).toBe(206);
  });

  it("refuses a file that is not an H.264 MP4 and marks the ledger row failed", async () => {
    const env = await seed();
    const id = ((await json(await create(ADMIN, env))).project as { id: string }).id;
    const r = await render(ADMIN, env, id, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]).buffer);
    expect(r.status).toBe(400);
    expect((await json(r)).error).toContain("not an MP4");
    expect((await ops(env)).results.find((o) => o.kind === "editor.render")).toMatchObject({ status: "failed" });
    expect((await env.DB.prepare("SELECT rendered_video FROM video_projects WHERE id = ?").bind(id).first<{ rendered_video: string | null }>())?.rendered_video).toBeNull();
    expect((await render(ADMIN, env, "missing")).status).toBe(404);
  });
});

describe("the switch", () => {
  it("off, saves and exports answer 503 and viewing stays open", async () => {
    const env = await seed();
    const id = ((await json(await create(ADMIN, env))).project as { id: string }).id;
    const off = await postJson(ADMIN, env, "/api/admin/integrations/switch", { provider: "editor", enabled: false });
    expect(off.status).toBe(200);
    const r = await create(ADMIN, env);
    expect(r.status).toBe(503);
    expect((await json(r)).error).toBe("Video editor is switched off by an admin. Nothing was sent or charged. Turn it back on under Admin → Integrations.");
    expect((await putJson(ADMIN, env, `/api/studio/posts/video/editor/projects/${id}`, { project: doc(), rev: 1 })).status).toBe(503);
    expect((await render(ADMIN, env, id)).status).toBe(503);
    const list = await json(await app(MEMBER).request("/api/studio/posts/video/editor/projects?batch=b1&post=1", {}, env));
    expect((list.projects as unknown[]).length).toBe(1);
    expect(list.access).toMatchObject({ enabled: false });
    expect((await app(ADMIN).request(`/api/studio/posts/video/editor/projects/${id}`, {}, env)).status).toBe(200);
  });
});
