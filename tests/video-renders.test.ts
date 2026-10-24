/**
 * "Render & update card": the render jobs (migration 0076) and where a finished render goes.
 *
 * The reported bug, reproduced first: a post whose client version was already chosen kept showing
 * that version on the card (and the client link) after an export, because an export only became
 * the client's version when the post had none. Then the fix: a job per render, of a frozen saved
 * revision; after the upload the version goes on the card and the client link unless the client
 * approved the current version (it waits for "Send for review") or a newer render / a later
 * explicit choice is there (it is kept, never silently replaces). Interrupted renders, a file of
 * the wrong size, the poster and the precise length are checked too. Nothing leaves the test.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Approval } from "../shared/config";
import { newClip, newProject } from "../shared/video-project";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { shareRoutes } from "../server/share";
import { clientAnswered, decidePromotion, RENDER_STALE_MS, renderStatus } from "../server/video-editor";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const TOKEN = "b".repeat(32);
const JSON_HEADERS = { "content-type": "application/json" };
// 64×80 (4:5), H.264 + AAC, one second: stands in for a rendered file (the server never decodes).
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const POSTER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("/api/studio/*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.route("/api/share", shareRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

/** A month with one post (a picture) and one clip, "v1", already the client's version. */
async function seed(opts: { approval?: Approval } = {}) {
  const env = fakeEnv();
  const t = Date.now() - 60_000;
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Mona', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Kunafa test', 'kunafa-test', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { shareToken: TOKEN, plan: [{ index: 1, type: "product", title: "Kunafa", brief: "A kunafa", caption: "", hashtags: "" } as never], ...(opts.approval ? { approvals: { "1": opts.approval } } : {}) });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'k.jpg', 'k', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u2/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71]).buffer, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES ('v1', 'b1', 1, 't1', 'u1', 'kling', 'idea', 'done', NULL, 'u2/b1/video/t1/v1.mp4', NULL, ?, ?, 'higgsfield', '{\"duration\":5,\"frame\":\"9:16\",\"width\":1920,\"height\":1080}', 'u2/b1/output/t1/a.png', 'picture', 1, NULL)",
  )
    .bind(t, t)
    .run();
  await env.BUCKET.put("u2/b1/video/t1/v1.mp4", sampleBytes(), { httpMetadata: { contentType: "video/mp4" } });
  return env;
}

/** The project: one clip of v1, output at the sample's 64×80 so the stored file matches the frozen revision. */
const doc = (w = 64, h = 80) => ({ ...newProject("Cut", 1000), clips: [newClip({ kind: "version", batch: "b1", videoId: "v1" }, 1, "a")], output: { width: w, height: h, fps: 30, bitrate: 4_000_000 } });
const call = (user: User, env: FakeEnv, method: string, path: string, body?: unknown) => app(user).request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: JSON_HEADERS } : {}) }, env);
const E = "/api/studio/posts/video/editor";

async function project(env: FakeEnv, d = doc()) {
  const r = await json(await call(ADMIN, env, "POST", `${E}/projects`, { batch: "b1", post: 1, name: "Cut", project: d, sourceVideo: "v1" }));
  return r.project as { id: string; rev: number };
}
async function save(env: FakeEnv, id: string, rev: number, d = doc()) {
  const r = await json(await call(ADMIN, env, "PUT", `${E}/projects/${id}`, { project: d, rev }));
  return (r.project as { rev: number }).rev;
}
async function startRender(env: FakeEnv, projectId: string, rev: number) {
  const r = await call(ADMIN, env, "POST", `${E}/renders`, { projectId, rev });
  return { status: r.status, body: await json(r) };
}
function upload(env: FakeEnv, projectId: string, renderId: string | null, opts: { poster?: boolean } = {}) {
  const form = new FormData();
  form.set("batch", "b1");
  form.set("post", "1");
  form.set("projectId", projectId);
  if (renderId) form.set("renderId", renderId);
  form.set("note", "Render");
  form.set("file", new File([sampleBytes()], "export.mp4", { type: "video/mp4" }));
  if (opts.poster) form.set("still", new File([POSTER], "still.jpg", { type: "image/jpeg" }));
  return app(ADMIN).request(`${E}/render`, { method: "POST", body: form }, env);
}
const summary = async (env: FakeEnv) => ((await json(await call(ADMIN, env, "GET", "/api/studio/posts/video/summary?batch=b1"))).posts as Record<string, { card: { id: string } | null; client: { id: string } | null; done: { id: string } | null }>)["1"];
const cardOf = (s: Awaited<ReturnType<typeof summary>>) => (s.card ?? s.client ?? s.done)?.id;
const shareVideo = async (env: FakeEnv) => ((await json(await app(ADMIN).request(`/api/share/${TOKEN}`, {}, env))).posts as { video: { id: string; url: string } | null }[])[0].video;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  vi.useRealTimers();
  expect(reached).toEqual([]);
});

describe("the reported bug, reproduced", () => {
  it("an export without a render job leaves the card on the old client version (the behaviour before the fix)", async () => {
    const env = await seed();
    const p = await project(env);
    const r = await upload(env, p.id, null);
    expect(r.status).toBe(200);
    const made = (await json(r)).video as { id: string; forClient: boolean };
    expect(made.forClient).toBe(false);
    // The card plays the client's version ("v1", 1920×1080) while the editor showed a different frame: the reported symptom.
    expect(cardOf(await summary(env))).toBe("v1");
    expect((await shareVideo(env))?.id).toBe("v1");
  });
});

describe("Render & update card", () => {
  it("renders a frozen saved revision, then puts the new version on the card and the client link", async () => {
    const env = await seed();
    const p = await project(env);
    const job = await startRender(env, p.id, p.rev);
    expect(job.status).toBe(200);
    const render = job.body.render as { id: string; status: string; projectRev: number };
    expect(render).toMatchObject({ status: "rendering", projectRev: 1 });
    const frozen = await env.DB.prepare("SELECT document FROM video_renders WHERE id = ?").bind(render.id).first<{ document: string }>();
    expect(JSON.parse(frozen!.document)).toMatchObject({ output: { width: 64, height: 80 } });
    // The person keeps editing while it renders: the job still renders save 1.
    await save(env, p.id, 1, { ...doc(), name: "Cut, edited" });
    expect((await json(await call(ADMIN, env, "POST", `${E}/renders/${render.id}/progress`, { progress: 0.42, phase: "frames" }))).render).toMatchObject({ status: "rendering", progress: 0.42 });
    const up = await json(await upload(env, p.id, render.id, { poster: true }));
    expect(up.outcome).toBe("card");
    const video = up.video as { id: string; forClient: boolean; width: number; height: number; duration: number; frame: string; poster: string; project: { id: string; rev: number } };
    expect(video).toMatchObject({ forClient: true, width: 64, height: 80, duration: 1, frame: "4:5", project: { id: p.id, rev: 1 } });
    expect(up.render).toMatchObject({ status: "done", outcome: "card", videoId: video.id, width: 64, height: 80 });
    // The card and the client link play the same new version; the old one is kept.
    const s = await summary(env);
    expect(cardOf(s)).toBe(video.id);
    expect(s.client?.id).toBe(video.id);
    const shared = await shareVideo(env);
    expect(shared?.id).toBe(video.id);
    expect(shared?.url).toContain(`v=${video.id.slice(0, 8)}.`);
    const served = await app(ADMIN).request(shared!.url, {}, env);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer()).byteLength).toBe(SAMPLE.byteLength);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE post = 1").first<{ n: number }>())?.n).toBe(2);
    // The poster is the render's own frame, not the post's picture.
    const row = await env.DB.prepare("SELECT settings FROM videos WHERE id = ?").bind(video.id).first<{ settings: string }>();
    expect(JSON.parse(row!.settings).stillKey).toMatch(/\.still\.jpg$/);
    const poster = await app(ADMIN).request(video.poster, {}, env);
    expect(new Uint8Array(await poster.arrayBuffer())).toEqual(POSTER);
    // The project points at the version, and a second upload of the same job is refused.
    expect((await json(await call(ADMIN, env, "GET", `${E}/projects/${p.id}`))).project).toMatchObject({ renderedVideo: video.id, rev: 2 });
    expect((await upload(env, p.id, render.id)).status).toBe(409);
  });

  it("refuses a render of an unsaved revision and a file whose size is not the project's frame", async () => {
    const env = await seed();
    const p = await project(env, doc(1080, 1920));
    expect((await startRender(env, p.id, 7)).status).toBe(409);
    const job = (await startRender(env, p.id, 1)).body.render as { id: string };
    const r = await upload(env, p.id, job.id);
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe("The rendered file is 64×80 but the project asks for 1080×1920.");
    const row = await env.DB.prepare("SELECT status, error FROM video_renders WHERE id = ?").bind(job.id).first<{ status: string; error: string }>();
    expect(row).toMatchObject({ status: "failed", error: expect.stringContaining("64×80") });
    // Nothing stored, the card keeps its video.
    expect(cardOf(await summary(env))).toBe("v1");
  });

  it("keeps a client-approved version on the client link: the render waits for Send for review", async () => {
    const approval: Approval = { status: "approved", at: 1, answers: [{ rid: "r1", status: "approved", at: 1, version: { kind: "video", id: "v1" } }] };
    const env = await seed({ approval });
    const p = await project(env);
    const job = (await startRender(env, p.id, 1)).body.render as { id: string };
    const up = await json(await upload(env, p.id, job.id));
    expect(up.outcome).toBe("review");
    const id = (up.video as { id: string; forClient: boolean }).id;
    expect((up.video as { forClient: boolean }).forClient).toBe(false);
    const s = await summary(env);
    expect(s.card?.id).toBe(id);
    expect(s.client?.id).toBe("v1");
    expect((await shareVideo(env))?.id).toBe("v1");
    // "Send for review": the explicit choice makes it the client's version (and the card's).
    await call(ADMIN, env, "POST", "/api/studio/posts/video/select", { batch: "b1", index: 1, id });
    expect((await shareVideo(env))?.id).toBe(id);
  });

  it("keeps the client's version when the client asked for a change on it: the render waits, and Send for review clears the answer", async () => {
    const approval: Approval = { status: "changes", note: "Slower please", at: 1, answers: [{ rid: "r1", status: "changes", note: "Slower please", at: 1, version: { kind: "video", id: "v1" } }] };
    const env = await seed({ approval });
    const p = await project(env);
    const job = (await startRender(env, p.id, 1)).body.render as { id: string };
    const up = await json(await upload(env, p.id, job.id));
    expect(up.outcome).toBe("review");
    const id = (up.video as { id: string }).id;
    expect((up.video as { forClient: boolean }).forClient).toBe(false);
    expect((await summary(env)).card?.id).toBe(id);
    expect((await shareVideo(env))?.id).toBe("v1");
    // "Send for review" (the editor's button): the clip becomes the client's, the answer is cleared.
    await call(ADMIN, env, "POST", "/api/studio/posts/video/select", { batch: "b1", index: 1, id });
    expect((await call(ADMIN, env, "POST", "/api/studio/posts/versions/send-for-review", { batch: "b1", index: 1 })).status).toBe(200);
    expect((await shareVideo(env))?.id).toBe(id);
    const config = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { approvals?: Record<string, unknown> };
    expect(config.approvals?.["1"]).toBeUndefined();
    // Unanswered now: the next render goes straight to the client's link.
    const again = (await startRender(env, p.id, 1)).body.render as { id: string };
    const next = await json(await upload(env, p.id, again.id));
    expect(next.outcome).toBe("card");
    expect((await shareVideo(env))?.id).toBe((next.video as { id: string }).id);
  });

  it("a post's first finished clip goes to the client by itself only while the client has not answered the post", async () => {
    const uploadClip = (env: FakeEnv) => {
      const form = new FormData();
      form.set("batch", "b1");
      form.set("index", "1");
      form.set("file", new File([sampleBytes()], "clip.mp4", { type: "video/mp4" }));
      return app(ADMIN).request("/api/studio/posts/video/upload", { method: "POST", body: form }, env);
    };
    // The client approved the picture (no clip is theirs): the new clip waits beside it.
    const onPicture: Approval = { status: "approved", at: 1, answers: [{ rid: "r1", status: "approved", at: 1, version: { kind: "image", id: "1" } }] };
    const held = await seed({ approval: onPicture });
    await held.DB.prepare("UPDATE videos SET for_client = 0").run();
    const kept = (await json(await uploadClip(held))).video as { forClient: boolean };
    expect(kept.forClient).toBe(false);
    expect(await shareVideo(held)).toBeNull();
    // Unanswered (the link is out): the first clip is the client's at once.
    const open = await seed();
    await open.DB.prepare("UPDATE videos SET for_client = 0").run();
    const live = (await json(await uploadClip(open))).video as { id: string; forClient: boolean };
    expect(live.forClient).toBe(true);
    expect((await shareVideo(open))?.id).toBe(live.id);
  });

  it("an older revision finishing last never replaces a newer render on the card", async () => {
    const env = await seed();
    const p = await project(env);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1000);
    const older = (await startRender(env, p.id, 1)).body.render as { id: string };
    const rev2 = await save(env, p.id, 1);
    vi.setSystemTime(Date.now() + 1000);
    const newer = (await startRender(env, p.id, rev2)).body.render as { id: string };
    vi.setSystemTime(Date.now() + 1000);
    const first = await json(await upload(env, p.id, newer.id));
    expect(first.outcome).toBe("card");
    const newerId = (first.video as { id: string }).id;
    vi.setSystemTime(Date.now() + 1000);
    const late = await json(await upload(env, p.id, older.id));
    expect(late.outcome).toBe("superseded");
    expect((late.video as { forClient: boolean }).forClient).toBe(false);
    const s = await summary(env);
    expect(cardOf(s)).toBe(newerId);
    expect(s.client?.id).toBe(newerId);
    expect((await shareVideo(env))?.id).toBe(newerId);
  });

  it("in the other order, the newer render replaces the older one", async () => {
    const env = await seed();
    const p = await project(env);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1000);
    const older = (await startRender(env, p.id, 1)).body.render as { id: string };
    const rev2 = await save(env, p.id, 1);
    vi.setSystemTime(Date.now() + 1000);
    const newer = (await startRender(env, p.id, rev2)).body.render as { id: string };
    expect((await json(await upload(env, p.id, older.id))).outcome).toBe("card");
    vi.setSystemTime(Date.now() + 1000);
    const up = await json(await upload(env, p.id, newer.id));
    expect(up.outcome).toBe("card");
    expect(cardOf(await summary(env))).toBe((up.video as { id: string }).id);
  });

  it("a choice made while a render runs wins over that render", async () => {
    const env = await seed();
    const p = await project(env);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1000);
    const job = (await startRender(env, p.id, 1)).body.render as { id: string };
    vi.setSystemTime(Date.now() + 1000);
    await call(ADMIN, env, "POST", "/api/studio/posts/video/select", { batch: "b1", index: 1, id: "v1" });
    vi.setSystemTime(Date.now() + 1000);
    expect((await json(await upload(env, p.id, job.id))).outcome).toBe("superseded");
    expect(cardOf(await summary(env))).toBe("v1");
  });

  it("reads a render whose tab went quiet as interrupted, keeps the card's video, and accepts a new render", async () => {
    const env = await seed();
    const p = await project(env);
    const job = (await startRender(env, p.id, 1)).body.render as { id: string };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + RENDER_STALE_MS + 5000);
    const list = await json(await call(ADMIN, env, "GET", `${E}/renders?project=${p.id}`));
    expect((list.renders as { id: string; status: string }[])[0]).toMatchObject({ id: job.id, status: "interrupted" });
    expect(cardOf(await summary(env))).toBe("v1");
    const again = (await startRender(env, p.id, 1)).body.render as { id: string };
    expect((await json(await upload(env, p.id, again.id))).outcome).toBe("card");
    // A member reads the jobs and may start, report and fail one too (24 Oct: the team).
    expect((await call(MEMBER, env, "GET", `${E}/renders?project=${p.id}`)).status).toBe(200);
    const mine = (await json(await call(MEMBER, env, "POST", `${E}/renders`, { projectId: p.id, rev: 1 }))).render as { id: string };
    expect((await call(MEMBER, env, "POST", `${E}/renders/${mine.id}/progress`, { progress: 0.5 })).status).toBe(200);
    expect((await call(MEMBER, env, "POST", `${E}/renders/${mine.id}/fail`, { error: "x" })).status).toBe(200);
  });

  it("records a failure from the tab and leaves the card alone", async () => {
    const env = await seed();
    const p = await project(env);
    const job = (await startRender(env, p.id, 1)).body.render as { id: string };
    const r = await json(await call(ADMIN, env, "POST", `${E}/renders/${job.id}/fail`, { error: "H.264 encoding failed: out of memory" }));
    expect(r.render).toMatchObject({ status: "failed", error: "H.264 encoding failed: out of memory" });
    expect(cardOf(await summary(env))).toBe("v1");
  });
});

describe("the promotion rules", () => {
  it("decides card, review or superseded", () => {
    expect(decidePromotion({ renderStart: 10, project: "p", rev: 2, top: null, clientAnswered: false })).toBe("card");
    expect(decidePromotion({ renderStart: 10, project: "p", rev: 2, top: null, clientAnswered: true })).toBe("review");
    expect(decidePromotion({ renderStart: 10, project: "p", rev: 2, top: { id: "x", rank: 20, project: "p", rev: 3 }, clientAnswered: false })).toBe("superseded");
    expect(decidePromotion({ renderStart: 30, project: "p", rev: 2, top: { id: "x", rank: 20, project: "p", rev: 3 }, clientAnswered: false })).toBe("superseded");
    expect(decidePromotion({ renderStart: 30, project: "p", rev: 4, top: { id: "x", rank: 20, project: "p", rev: 3 }, clientAnswered: false })).toBe("card");
    expect(decidePromotion({ renderStart: 30, project: "p", rev: 1, top: { id: "x", rank: 20, project: "q", rev: 9 }, clientAnswered: false })).toBe("card");
  });

  it("reads the client's answer (an approval or a change asked) for the exact version", () => {
    const a = (id: string | null, status: "approved" | "changes" = "approved"): Approval => ({ status, at: 1, answers: [{ rid: "r", status, at: 1, ...(id ? { version: { kind: "video" as const, id } } : {}) }] });
    expect(clientAnswered(a("v1"), "v1")).toBe(true);
    expect(clientAnswered(a("v0"), "v1")).toBe(false);
    expect(clientAnswered(a(null), "v1")).toBe(true);
    expect(clientAnswered(a("v1"), null)).toBe(false);
    // A change asked is an answer too: the client keeps the version they asked about.
    expect(clientAnswered({ status: "changes", at: 1 }, "v1")).toBe(true);
    expect(clientAnswered(a("v1", "changes"), "v1")).toBe(true);
    expect(clientAnswered(a("v0", "changes"), "v1")).toBe(false);
    // An answer on the picture holds the picture while no clip is the client's.
    const onPicture: Approval = { status: "approved", at: 1, answers: [{ rid: "r", status: "approved", at: 1, version: { kind: "image", id: "123" } }] };
    expect(clientAnswered(onPicture, null)).toBe(true);
    expect(clientAnswered(onPicture, "v1")).toBe(false);
    expect(clientAnswered(undefined, "v1")).toBe(false);
  });

  it("reads a quiet render as interrupted", () => {
    expect(renderStatus({ status: "rendering", updated: 0 }, RENDER_STALE_MS + 1)).toBe("interrupted");
    expect(renderStatus({ status: "rendering", updated: 0 }, RENDER_STALE_MS - 1)).toBe("rendering");
    expect(renderStatus({ status: "done", updated: 0 }, RENDER_STALE_MS * 10)).toBe("done");
  });
});
