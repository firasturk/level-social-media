import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { PHOTO_LAB_PRICES } from "../shared/pricing";
import { VIDEO_MODELS } from "../shared/qa";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { adminRoutes } from "../server/admin";
import { usePhotoLabFetch, FREEPIK } from "../server/photolab";
import { FREEPIK_KEY_SETTING, setSetting } from "../server/settings";
import { claimSubmission, integrationSwitch, listIntegrationOps, noRetry, requireIntegrationAdmin, requireIntegrationUser, teamMayRun } from "../server/integrations";

/**
 * Integration governance (docs/integrations.md): the Photo lab, the Freepik key and videos are
 * admins-only; each provider has a switch; every operation is a ledger row; a paid run is proposed
 * with its estimate and executed only with {opId, confirm: true}; an unknown cost blocks the run;
 * the same submission cannot go out twice; viewing stays open to members. Nothing here reaches a
 * real vendor: the guard fails the test on any call the test did not ask for.
 */

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const PICTURE = new Uint8Array([80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
const JSON_HEADERS = { "content-type": "application/json" };
const KEY = "FPSX0123456789abcdef0123456789abcdef";
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

/** A month owned by the member, so viewing routes can be tried as them; the admin sees every month. */
async function seed(overrides: Record<string, string> = {}) {
  const env = fakeEnv({ HIGGSFIELD_API_KEY: "key-id:key-secret", ...overrides } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Mona', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [{ index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only" } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, updated, post) VALUES ('t1', 'b1', 's1', 1, 'review', 'u2/b1/output/t1/a.png', '', ?, 1)").bind(t).run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", PICTURE, { httpMetadata: { contentType: "image/png" } });
  return env;
}

const RUN = { client: "c1", source: { kind: "task", batch: "b1", id: "t1" }, op: "remove-bg" };
const VIDEO = { batch: "b1", index: 1, prompt: "The steam rises slowly from the kunafa.", model: VIDEO_MODELS[0].slug };

const postJson = (user: User, env: FakeEnv, path: string, body: unknown) => app(user).request(path, { method: "POST", body: JSON.stringify(body), headers: JSON_HEADERS }, env);

let reached: Reached[];
let stub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const g = guardFetch();
  reached = g.reached;
  stub = g.stub;
  usePhotoLabFetch(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  usePhotoLabFetch(null);
});

describe("who may run what (24 Oct: the team runs Higgsfield and Freepik / Magnific tools)", () => {
  it("keeps the Freepik key with admins: a member is refused with 403 before anything is read", async () => {
    const env = await seed();
    const r = await postJson(MEMBER, env, "/api/studio/photolab/key", { key: KEY });
    expect(r.status).toBe(403);
    expect(String((await json(r)).error)).toMatch(/^Admins only for now/);
    const gone = await app(MEMBER).request("/api/studio/photolab/key", { method: "DELETE" }, env);
    expect(gone.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM integration_ops").first<{ n: number }>()).toEqual({ n: 0 });
    expect(reached).toEqual([]);
  });

  it("lets the team run the Higgsfield and Freepik tools and keeps the editor, the audio and Pinterest with admins", () => {
    for (const p of ["higgsfield", "freepik"] as const) {
      expect(teamMayRun(MEMBER, p)).toBe(true);
      expect(requireIntegrationUser({ get: () => MEMBER }, p)).toBe(MEMBER);
    }
    for (const p of ["editor", "audio", "pinterest"] as const) {
      expect(teamMayRun(MEMBER, p)).toBe(false);
      expect(teamMayRun(ADMIN, p)).toBe(true);
      expect(() => requireIntegrationUser({ get: () => MEMBER }, p)).toThrow(/Admins only for now/);
    }
  });

  it("requireIntegrationAdmin returns the admin and names the provider when it refuses", () => {
    expect(requireIntegrationAdmin({ get: () => ADMIN }, "freepik")).toBe(ADMIN);
    expect(() => requireIntegrationAdmin({ get: () => MEMBER }, "higgsfield")).toThrow(/Admins only for now: Higgsfield/);
  });

  it("tells the entry points what the viewer may do: the status and the video list carry access", async () => {
    const env = await seed();
    const s = await json(await app(MEMBER).request("/api/studio/photolab/status", {}, env));
    expect(s.access).toEqual({ admin: true, enabled: true, reason: "" });
    const v = await json(await app(MEMBER).request("/api/studio/posts/video/list?batch=b1&index=1", {}, env));
    expect(v.access).toMatchObject({ admin: true, enabled: true });
    const a = await json(await app(ADMIN).request("/api/studio/photolab/status", {}, env));
    expect(a.access).toEqual({ admin: true, enabled: true, reason: "" });
  });
});

describe("confirm before spend: the Photo lab", () => {
  it("proposes first (nothing sent, the estimate on the ledger), runs only with {opId, confirm: true}, and records who confirmed", async () => {
    const env = await seed();
    const p = await postJson(ADMIN, env, "/api/studio/photolab/run", RUN);
    expect(p.status).toBe(200);
    const proposal = (await json(p)) as { opId: string; estimate: number; needsConfirmation: boolean };
    expect(proposal).toMatchObject({ estimate: 0, needsConfirmation: true, connected: false });
    expect(await env.BUCKET.list({ prefix: "photolab/" })).toMatchObject({ objects: [] });
    let ops = await listIntegrationOps(env);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: proposal.opId, provider: "freepik", kind: "photolab.remove-bg", user_id: "u1", batch: "b1", post: 1, estimate: 0, status: "proposed" });

    // Without the confirmation the server refuses and repeats what it needs.
    const no = await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: proposal.opId });
    expect(no.status).toBe(409);
    expect(await json(no)).toMatchObject({ error: expect.stringMatching(/^Confirm the cost first/), opId: proposal.opId, needsConfirmation: true });

    const r = await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: proposal.opId, confirm: true });
    expect(r.status).toBe(200);
    const d = (await json(r)) as { opId: string; job: { id: string; status: string; provider: string } };
    expect(d.opId).toBe(proposal.opId);
    expect(d.job).toMatchObject({ status: "done", provider: "demo" });
    ops = await listIntegrationOps(env, { provider: "freepik" });
    expect(ops[0]).toMatchObject({ id: proposal.opId, status: "done", user_id: "u1", user_name: "Firas", task_id: expect.stringMatching(/^demo:/), estimate: 0, reported: 0 });

    // The same confirmation cannot run twice.
    const again = await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: proposal.opId, confirm: true });
    expect(again.status).toBe(409);
    expect(String((await json(again)).error)).toMatch(/already confirmed/);
    expect(reached).toEqual([]);
  });

  it("with Freepik connected the estimate is the price table's, the submission goes out once, and the row ends with the job", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    const calls: string[] = [];
    usePhotoLabFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith(FREEPIK.removeBackground)) return new Response(JSON.stringify({ url: "https://cdn.test/high.png", high_resolution: "https://cdn.test/high.png" }), { status: 200 });
      if (url === "https://cdn.test/high.png") return new Response(PICTURE, { headers: { "content-type": "image/png" } });
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch);
    const proposal = (await json(await postJson(ADMIN, env, "/api/studio/photolab/run", RUN))) as { opId: string; estimate: number };
    expect(proposal.estimate).toBe(PHOTO_LAB_PRICES["remove-bg"]);
    expect(calls).toEqual([]);
    const r = await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: proposal.opId, confirm: true });
    expect(r.status).toBe(200);
    expect(calls.filter((u) => u.endsWith(FREEPIK.removeBackground))).toHaveLength(1);
    const [op] = await listIntegrationOps(env, { status: "done" });
    expect(op).toMatchObject({ id: proposal.opId, estimate: PHOTO_LAB_PRICES["remove-bg"], reported: null, task_id: expect.stringMatching(/^sync:/) });
    expect(reached).toEqual([]);
  });

  it("a refused submission is not retried and the row says why", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    let submits = 0;
    usePhotoLabFetch((async () => {
      submits++;
      return new Response(JSON.stringify({ message: "Insufficient credits" }), { status: 402 });
    }) as unknown as typeof fetch);
    const proposal = (await json(await postJson(ADMIN, env, "/api/studio/photolab/run", RUN))) as { opId: string };
    const r = await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: proposal.opId, confirm: true });
    expect(r.status).toBe(200);
    expect((await json(r)).job).toMatchObject({ status: "failed", error: "Freepik (402): Insufficient credits" });
    expect(submits).toBe(1);
    const [op] = await listIntegrationOps(env);
    expect(op).toMatchObject({ id: proposal.opId, status: "failed", note: "Freepik (402): Insufficient credits" });
    expect(reached).toEqual([]);
  });

  it("the key save and removal are ledger rows", async () => {
    const env = await seed();
    usePhotoLabFetch((async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch);
    expect((await postJson(ADMIN, env, "/api/studio/photolab/key", { key: KEY })).status).toBe(200);
    expect((await app(ADMIN).request("/api/studio/photolab/key", { method: "DELETE" }, env)).status).toBe(200);
    expect((await listIntegrationOps(env)).map((o) => [o.kind, o.status, o.estimate])).toEqual([
      ["key.remove", "done", 0],
      ["key.save", "done", 0],
    ]);
  });
});

describe("the switch", () => {
  it("an admin turns a provider off and every run answers 503 with a readable message; the admin routes refuse members", async () => {
    const env = await seed();
    expect(await integrationSwitch(env, "freepik")).toBe(true);
    const off = await postJson(ADMIN, env, "/api/admin/integrations/switch", { provider: "freepik", enabled: false });
    expect(off.status).toBe(200);
    expect((await json(off)).providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "freepik", enabled: false }), expect.objectContaining({ provider: "higgsfield", enabled: true })]));
    const r = await postJson(ADMIN, env, "/api/studio/photolab/run", RUN);
    expect(r.status).toBe(503);
    expect((await json(r)).error).toBe("Freepik is switched off by an admin. Nothing was sent or charged. Turn it back on under Admin → Integrations.");
    // A key can still be removed while the switch is off; it cannot be saved.
    expect((await postJson(ADMIN, env, "/api/studio/photolab/key", { key: KEY })).status).toBe(503);
    expect((await app(ADMIN).request("/api/studio/photolab/key", { method: "DELETE" }, env)).status).toBe(200);
    // Viewing is untouched by the switch.
    expect((await app(MEMBER).request("/api/studio/photolab/jobs?client=c1", {}, env)).status).toBe(200);
    // The video switch is separate.
    await postJson(ADMIN, env, "/api/admin/integrations/switch", { provider: "higgsfield", enabled: false });
    const v = await postJson(ADMIN, env, "/api/studio/posts/video", VIDEO);
    expect(v.status).toBe(503);
    expect(String((await json(v)).error)).toMatch(/^Higgsfield is switched off by an admin/);
    expect((await postJson(MEMBER, env, "/api/admin/integrations/switch", { provider: "freepik", enabled: true })).status).toBe(403);
    const ledger = await json(await app(ADMIN).request("/api/admin/integrations", {}, env));
    expect((ledger.ops as { kind: string }[]).map((o) => o.kind)).toEqual(["switch.off", "key.remove", "switch.off"]);
    expect(reached).toEqual([]);
  });
});

describe("no duplicates", () => {
  it("claimSubmission refuses the same key within its time to live and allows it after", async () => {
    const env = await seed();
    expect(await claimSubmission(env, "video:b1:1", 60_000)).toBe(true);
    expect(await claimSubmission(env, "video:b1:1", 60_000)).toBe(false);
    expect(await claimSubmission(env, "video:b1:2", 60_000)).toBe(true);
    // A claim older than the time to live is taken over.
    await env.DB.prepare("UPDATE integration_claims SET created = ? WHERE key = 'video:b1:1'").bind(Date.now() - 120_000).run();
    expect(await claimSubmission(env, "video:b1:1", 60_000)).toBe(true);
    expect(await claimSubmission(env, "video:b1:1", 60_000)).toBe(false);
  });

  it("noRetry runs the call exactly once and lets its failure stand", async () => {
    let n = 0;
    await expect(
      noRetry(async () => {
        n++;
        throw new Error("engine down");
      }),
    ).rejects.toThrow("engine down");
    expect(n).toBe(1);
    expect(await noRetry(async () => "ok")).toBe("ok");
  });
});

describe("confirm before spend: videos", () => {
  it("blocks a video whose cost is not known, runs once an admin sets the estimate, and keeps the ledger", async () => {
    const env = await seed();
    const blocked = await postJson(ADMIN, env, "/api/studio/posts/video", VIDEO);
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({ needsEstimate: true, model: VIDEO.model });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM videos").first<{ n: number }>()).toEqual({ n: 0 });
    // The only call made was the provider's free estimate (refused by the guard here), never a generation.
    expect(reached.map((x) => x.url)).toEqual([`https://higgsfield.test/estimate/${VIDEO_MODELS[0].slug}`]);
    reached.length = 0;

    // The admin enters the estimate under Admin → Integrations; the Higgsfield answer is stubbed and the only call allowed.
    const set = await postJson(ADMIN, env, "/api/admin/integrations/estimate", { provider: "higgsfield", kind: "video", usd: 0.5 });
    expect(set.status).toBe(200);
    expect((await json(set)).providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "higgsfield", estimates: { video: 0.5 } })]));
    stub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      reached.push({ url, init });
      if (url.startsWith("https://higgsfield.test/")) return new Response(JSON.stringify({ request_id: "req-1", status: "queued" }), { status: 200, headers: JSON_HEADERS });
      throw new Error("A network call was made without the test asking for it: " + url);
    });
    const r = await postJson(ADMIN, env, "/api/studio/posts/video", VIDEO);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { video: { id: string; status: string; estimate: number | null } };
    expect(d.video.status).toBe("queued");
    expect(d.video.estimate).toBe(0.5);
    expect(reached.map((x) => x.url)).toEqual([`https://higgsfield.test/${VIDEO_MODELS[0].slug}`]);
    const body = JSON.parse(String(reached[0].init?.body));
    expect(body).toMatchObject({ prompt: VIDEO.prompt, duration: 5 });
    const op = (await listIntegrationOps(env, { status: "running" }))[0];
    expect(op).toMatchObject({ provider: "higgsfield", kind: "video", user_id: "u1", batch: "b1", post: 1, task_id: "req-1", estimate: 0.5, reported: null });
    // The same clip asked again within the claim window is refused; nothing is sent twice.
    expect((await postJson(ADMIN, env, "/api/studio/posts/video", VIDEO)).status).toBe(409);
    expect(reached).toHaveLength(1);
  });

  it("a confirmation for an operation that is not known is refused", async () => {
    const env = await seed();
    const other = await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: "not-an-op", confirm: true });
    expect(other.status).toBe(404);
    expect(reached).toEqual([]);
  });
});

describe("viewing stays open", () => {
  it("a member lists the videos of their month and fetches a stored clip, and lists Photo lab jobs with their pictures", async () => {
    const env = await seed();
    const t = Date.now();
    await env.BUCKET.put("u2/b1/video/t1/v1.mp4", PICTURE, { httpMetadata: { contentType: "video/mp4" } });
    await env.DB.prepare("INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, created, updated) VALUES ('v1', 'b1', 1, 't1', 'u1', ?, 'steam', 'done', 'req-1', 'u2/b1/video/t1/v1.mp4', ?, ?)").bind(VIDEO_MODELS[0].slug, t, t).run();
    const list = await app(MEMBER).request("/api/studio/posts/video/list?batch=b1&index=1", {}, env);
    expect(list.status).toBe(200);
    const d = (await json(list)) as { videos: { id: string; url: string }[]; access: { admin: boolean } };
    expect(d.videos.map((v) => v.id)).toEqual(["v1"]);
    expect(d.access.admin).toBe(true);
    const file = await app(MEMBER).request(d.videos[0].url, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("video/mp4");

    // A Photo lab job made by the admin is visible to the member, picture included; the member may use it (open to the team since 24 Oct).
    const p = (await json(await postJson(ADMIN, env, "/api/studio/photolab/run", RUN))) as { opId: string };
    const run = (await json(await postJson(ADMIN, env, "/api/studio/photolab/run", { ...RUN, opId: p.opId, confirm: true }))) as { job: { id: string } };
    const jobs = (await json(await app(MEMBER).request("/api/studio/photolab/jobs?client=c1", {}, env))) as { jobs: { id: string }[] };
    expect(jobs.jobs.map((j) => j.id)).toEqual([run.job.id]);
    expect((await app(MEMBER).request(`/api/studio/photolab/jobs/${run.job.id}/image?which=out`, {}, env)).status).toBe(200);
    expect((await app(MEMBER).request(`/api/studio/photolab/jobs/${run.job.id}`, {}, env)).status).toBe(200);
    expect((await postJson(MEMBER, env, `/api/studio/photolab/jobs/${run.job.id}/use`, { as: "product", batch: "b1" })).status).not.toBe(403);
    expect(reached).toEqual([]);
  });
});
