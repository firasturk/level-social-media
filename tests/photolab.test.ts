import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { PHOTO_LAB_PRICES } from "../shared/pricing";
import type { User } from "../shared/types";
import { FREEPIK, FreepikClient, NOT_CONNECTED, photoLabRoutes, usePhotoLabFetch, type JobJson } from "../server/photolab";
import { FREEPIK_KEY_SETTING, setSetting } from "../server/settings";
import { StudioError } from "../server/errors";

/**
 * Photo lab: with no key the demo provider answers and nothing is sent anywhere (the guard fails the
 * test otherwise); with a key each operation submits the documented Freepik shape against a stubbed
 * fetch that only the Freepik host and its CDN may reach, polling completes a task into a stored
 * result, a failed task is readable, and a result becomes a product photo (a sources row) or a
 * post's picture with the previous one kept.
 */

type FakeEnv = ReturnType<typeof fakeEnv>;
const KEY = "FPSX0123456789abcdef0123456789abcdef";
const PICTURE = new Uint8Array([80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
const RESULT = new Uint8Array([80, 78, 71, 9, 9, 9]).buffer;
const JSON_HEADERS = { "content-type": "application/json" };
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

function app() {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio/photolab", photoLabRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [{ index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only" } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, updated, post) VALUES ('t1', 'b1', 's1', 1, 'review', 'u1/b1/output/t1/a.png', '', ?, 1)").bind(t).run();
  await env.BUCKET.put("u1/b1/output/t1/a.png", PICTURE, { httpMetadata: { contentType: "image/png" } });
  return env;
}

const TASK_SOURCE = { kind: "task", batch: "b1", id: "t1" };

/** A run is two requests: the proposal (nothing sent, the estimate written) and its confirmation. */
async function runJob(env: FakeEnv, body: Record<string, unknown>): Promise<{ status: number; job: JobJson; connected: boolean; provider: string; reason: string }> {
  const payload = { client: "c1", source: TASK_SOURCE, ...body };
  const p = await app().request("/api/studio/photolab/run", { method: "POST", body: JSON.stringify(payload), headers: JSON_HEADERS }, env);
  const proposal = (await json(p)) as { opId?: string; estimate?: number | null; needsConfirmation?: boolean; error?: string };
  if (!p.ok || !proposal.needsConfirmation) return { status: p.status, ...(proposal as unknown as { job: JobJson; connected: boolean; provider: string; reason: string }) };
  expect(proposal.estimate).not.toBeNull();
  const r = await app().request("/api/studio/photolab/run", { method: "POST", body: JSON.stringify({ ...payload, opId: proposal.opId, confirm: true }), headers: JSON_HEADERS }, env);
  const d = (await json(r)) as unknown as { job: JobJson; connected: boolean; provider: string; reason: string; error?: string };
  return { status: r.status, ...d };
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  usePhotoLabFetch(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  usePhotoLabFetch(null);
});

describe("Photo lab with nothing connected (demo)", () => {
  it("reports Not connected with the demo provider and the approximate prices", async () => {
    const env = await seed();
    const r = await app().request("/api/studio/photolab/status", {}, env);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ connected: false, provider: "demo", reason: NOT_CONNECTED, prices: PHOTO_LAB_PRICES, approximate: true, access: { admin: true, enabled: true, reason: "" } });
    expect(reached).toEqual([]);
  });

  it("completes a demo job at once with the input copied to the output, cost 0, and never calls out", async () => {
    const env = await seed();
    const d = await runJob(env, { op: "remove-bg" });
    expect(d.status).toBe(200);
    expect(d.connected).toBe(false);
    expect(d.provider).toBe("demo");
    expect(d.job).toMatchObject({ status: "done", provider: "demo", demo: true, cost: 0, op: "remove-bg", batch: "b1", post: 1, inputLabel: "Post 1 picture" });
    expect(d.job.output).toMatch(/\/api\/studio\/photolab\/jobs\/.+\/image\?which=out/);
    const out = await env.BUCKET.get(`photolab/${d.job.id}-out.png`);
    expect(out && new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array(PICTURE));
    const img = await app().request(`/api/studio/photolab/jobs/${d.job.id}/image?which=in`, {}, env);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const list = (await json(await app().request("/api/studio/photolab/jobs?client=c1", {}, env))) as { jobs: JobJson[] };
    expect(list.jobs.map((j) => j.id)).toEqual([d.job.id]);
    expect(reached).toEqual([]);
  });

  it("takes a client's demo Drive photo as the input", async () => {
    const env = await seed();
    const d = await runJob(env, { op: "upscale", source: { kind: "drive", id: "demo-mango" } });
    expect(d.status).toBe(200);
    expect(d.job.status).toBe("done");
    expect(await env.BUCKET.head(`photolab/${d.job.id}-in.svg`)).toBeTruthy();
    expect(reached).toEqual([]);
  });

  it("asks for a prompt before replacing a background, and refuses a month of another client", async () => {
    const env = await seed();
    const d = await runJob(env, { op: "background" });
    expect(d.status).toBe(400);
    const other = await app().request("/api/studio/photolab/run", { method: "POST", body: JSON.stringify({ client: "c2", source: TASK_SOURCE, op: "relight" }), headers: JSON_HEADERS }, env);
    expect(other.status).toBe(409);
    expect(reached).toEqual([]);
  });
});

/** A Freepik stand-in: records every request; answers the documented shapes. */
function freepikStub(opts: { fail?: boolean; pendingPolls?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let polls = 0;
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.startsWith(FREEPIK.base)) {
      expect(headers["x-freepik-api-key"]).toBe(KEY);
      expect(headers["x-magnific-api-key"]).toBe(KEY);
      if (url.endsWith(FREEPIK.verify)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.endsWith(FREEPIK.removeBackground))
        return new Response(JSON.stringify({ original: "https://cdn.test/o.jpg", high_resolution: "https://cdn.test/high.png", preview: "https://cdn.test/p.png", url: "https://cdn.test/high.png" }), { status: 200 });
      if (url.endsWith(FREEPIK.relight) || url.endsWith(FREEPIK.upscale))
        return new Response(JSON.stringify({ data: { task_id: "task-1", status: "CREATED", generated: [] } }), { status: 200 });
      if (url.endsWith("/task-1")) {
        polls++;
        if (opts.fail) return new Response(JSON.stringify({ data: { task_id: "task-1", status: "FAILED", generated: [] } }));
        if (polls <= (opts.pendingPolls ?? 0)) return new Response(JSON.stringify({ data: { task_id: "task-1", status: "IN_PROGRESS", generated: [] } }));
        return new Response(JSON.stringify({ data: { task_id: "task-1", status: "COMPLETED", generated: ["https://cdn.test/result.jpg"] } }));
      }
    }
    if (url === "https://cdn.test/high.png") return new Response(RESULT, { headers: { "content-type": "image/png" } });
    if (url === "https://cdn.test/result.jpg") return new Response(RESULT, { headers: { "content-type": "image/jpeg" } });
    throw new Error("A network call was made that the test did not expect: " + url);
  });
  return { stub: stub as unknown as typeof fetch, calls };
}

async function connected() {
  const env = await seed();
  await setSetting(env, FREEPIK_KEY_SETTING, KEY);
  return env;
}

describe("Photo lab connected to Freepik (stubbed fetch)", () => {
  it("saves a key only after the no-cost verification call accepts it", async () => {
    const env = await seed();
    const { stub, calls } = freepikStub();
    usePhotoLabFetch(stub);
    const r = await app().request("/api/studio/photolab/key", { method: "POST", body: JSON.stringify({ key: KEY }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`${FREEPIK.base}${FREEPIK.verify}`]);
    const s = await json(await app().request("/api/studio/photolab/status", {}, env));
    expect(s).toMatchObject({ connected: true, provider: "freepik", reason: "" });
    const bad = new FreepikClient("nope", (async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 })) as unknown as typeof fetch);
    expect(await bad.verify()).toEqual({ ok: false, message: "Freepik (401): Invalid API key" });
    const gone = await app().request("/api/studio/photolab/key", { method: "DELETE" }, env);
    expect(gone.status).toBe(200);
    expect((await json(await app().request("/api/studio/photolab/status", {}, env))).connected).toBe(false);
    expect(reached).toEqual([]);
  });

  it("remove background: form-urlencoded image_url of the signed input, synchronous, result stored", async () => {
    const env = await connected();
    const { stub, calls } = freepikStub();
    usePhotoLabFetch(stub);
    const d = await runJob(env, { op: "remove-bg" });
    expect(d.status).toBe(200);
    expect(d.job).toMatchObject({ status: "done", provider: "freepik", demo: false, cost: PHOTO_LAB_PRICES["remove-bg"] });
    const submit = calls.find((c) => c.url.endsWith(FREEPIK.removeBackground))!;
    expect(submit.init?.method).toBe("POST");
    expect((submit.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(submit.init?.body));
    expect(form.get("image_url")).toMatch(new RegExp(`^https://studio\\.test/api/public/object\\?k=photolab%2F${d.job.id}-in\\.png&e=\\d+&s=[0-9a-f]+$`));
    expect(calls.map((c) => c.url)).toContain("https://cdn.test/high.png");
    const out = await env.BUCKET.get(`photolab/${d.job.id}-out.png`);
    expect(out && new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array(RESULT));
    expect(reached).toEqual([]);
  });

  it("replace background: the relight tool with change_background and the prompt; polling completes it", async () => {
    const env = await connected();
    const { stub, calls } = freepikStub({ pendingPolls: 1 });
    usePhotoLabFetch(stub);
    const d = await runJob(env, { op: "background", prompt: "a marble counter in soft morning light" });
    expect(d.status).toBe(200);
    expect(d.job).toMatchObject({ status: "running", cost: PHOTO_LAB_PRICES.background, prompt: "a marble counter in soft morning light" });
    const submit = calls.find((c) => c.url === `${FREEPIK.base}${FREEPIK.relight}`)!;
    expect((submit.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(submit.init?.body));
    expect(body).toMatchObject({ prompt: "a marble counter in soft morning light", change_background: true, style: "standard", preserve_details: true });
    expect(body.image).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=photolab%2F/);
    // First poll: still in progress.
    let g = (await json(await app().request(`/api/studio/photolab/jobs/${d.job.id}`, {}, env))) as unknown as { job: JobJson };
    expect(g.job.status).toBe("running");
    expect(calls.filter((c) => c.url === `${FREEPIK.base}${FREEPIK.relight}/task-1`).length).toBe(1);
    // Second poll: completed, downloaded, stored as a JPEG.
    g = (await json(await app().request(`/api/studio/photolab/jobs/${d.job.id}`, {}, env))) as unknown as { job: JobJson };
    expect(g.job.status).toBe("done");
    expect(g.job.output).toContain("which=out");
    expect(await env.BUCKET.head(`photolab/${d.job.id}-out.jpg`)).toBeTruthy();
    expect(reached).toEqual([]);
  });

  it("relight: the relight tool without changing the background", async () => {
    const env = await connected();
    const { stub, calls } = freepikStub();
    usePhotoLabFetch(stub);
    const d = await runJob(env, { op: "relight", prompt: "warm evening light from the left" });
    expect(d.job.status).toBe("running");
    const body = JSON.parse(String(calls.find((c) => c.url === `${FREEPIK.base}${FREEPIK.relight}`)!.init?.body));
    expect(body).toMatchObject({ prompt: "warm evening light from the left", change_background: false });
    expect(reached).toEqual([]);
  });

  it("upscale: base64 image with a 2x scale factor, GET by task id", async () => {
    const env = await connected();
    const { stub, calls } = freepikStub();
    usePhotoLabFetch(stub);
    const d = await runJob(env, { op: "upscale" });
    expect(d.job).toMatchObject({ status: "running", cost: PHOTO_LAB_PRICES.upscale });
    const body = JSON.parse(String(calls.find((c) => c.url === `${FREEPIK.base}${FREEPIK.upscale}`)!.init?.body));
    expect(body).toMatchObject({ scale_factor: "2x", optimized_for: "films_n_photography", engine: "automatic" });
    expect(Buffer.from(body.image, "base64")).toEqual(Buffer.from(PICTURE));
    const g = (await json(await app().request(`/api/studio/photolab/jobs/${d.job.id}`, {}, env))) as unknown as { job: JobJson };
    expect(g.job.status).toBe("done");
    expect(calls.at(-2)?.url).toBe(`${FREEPIK.base}${FREEPIK.upscale}/task-1`);
    expect(calls.at(-2)?.init?.method).toBe("GET");
    expect(reached).toEqual([]);
  });

  it("a failed task is readable with its error", async () => {
    const env = await connected();
    const { stub } = freepikStub({ fail: true });
    usePhotoLabFetch(stub);
    const d = await runJob(env, { op: "relight", prompt: "x" });
    const g = (await json(await app().request(`/api/studio/photolab/jobs/${d.job.id}`, {}, env))) as unknown as { job: JobJson };
    expect(g.job.status).toBe("failed");
    expect(g.job.error).toMatch(/failed/i);
    expect(g.job.output).toBeNull();
    const use = await app().request(`/api/studio/photolab/jobs/${d.job.id}/use`, { method: "POST", body: JSON.stringify({ as: "product", batch: "b1" }), headers: JSON_HEADERS }, env);
    expect(use.status).toBe(409);
    expect(reached).toEqual([]);
  });

  it("a refused submission (bad key, no credits) fails the job with Freepik's message", async () => {
    const env = await connected();
    usePhotoLabFetch((async () => new Response(JSON.stringify({ message: "Insufficient credits" }), { status: 402 })) as unknown as typeof fetch);
    const d = await runJob(env, { op: "upscale" });
    expect(d.status).toBe(200);
    expect(d.job.status).toBe("failed");
    expect(d.job.error).toBe("Freepik (402): Insufficient credits");
    expect(reached).toEqual([]);
  });
});

describe("using a result", () => {
  it("saves the result as a product photo of the month (a sources row named after the input and the tool)", async () => {
    const env = await seed();
    const d = await runJob(env, { op: "remove-bg" });
    const r = await app().request(`/api/studio/photolab/jobs/${d.job.id}/use`, { method: "POST", body: JSON.stringify({ as: "product", batch: "b1" }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    const a = (await json(r)) as { source: { id: string; name: string; key: string; kind: string } };
    expect(a.source.name).toBe("Post 1 picture remove background.png");
    expect(a.source.kind).toBe("product");
    expect(a.source.key).toMatch(/^u1\/b1\/source\//);
    const row = await env.DB.prepare("SELECT batch, name, stem, kind, role, mime, size, note FROM sources WHERE id = ?").bind(a.source.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ batch: "b1", name: "Post 1 picture remove background.png", stem: "post 1 picture remove background", kind: "product", role: "lead", mime: "image/png", size: PICTURE.byteLength });
    expect(String(row!.note)).toContain("Photo lab: Remove background");
    expect(await env.BUCKET.head(a.source.key)).toBeTruthy();
    // A second save takes a free name.
    const again = (await json(await app().request(`/api/studio/photolab/jobs/${d.job.id}/use`, { method: "POST", body: JSON.stringify({ as: "product", batch: "b1" }), headers: JSON_HEADERS }, env))) as { source: { name: string } };
    expect(again.source.name).toBe("Post 1 picture remove background (2).png");
    expect(reached).toEqual([]);
  });

  it("sets the result as the post's picture and keeps the previous one as a take and a version", async () => {
    const env = await seed();
    const d = await runJob(env, { op: "upscale" });
    const r = await app().request(`/api/studio/photolab/jobs/${d.job.id}/use`, { method: "POST", body: JSON.stringify({ as: "picture", batch: "b1", post: 1 }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    const a = (await json(r)) as { key: string; previous: string; task: string };
    expect(a.task).toBe("t1");
    expect(a.previous).toBe("u1/b1/output/t1/a.png");
    expect(a.key).toMatch(/^u1\/b1\/output\/t1\/.+\.png$/);
    const task = await env.DB.prepare("SELECT output, status FROM tasks WHERE id = 't1'").first<{ output: string; status: string }>();
    expect(task).toEqual({ output: a.key, status: "ready" });
    const takes = await env.DB.prepare("SELECT key, status, note, cost FROM post_takes WHERE batch = 'b1' AND post = 1").all<{ key: string; status: string; note: string; cost: number }>();
    expect(takes.results).toEqual([{ key: a.key, status: "made", note: "Photo lab: Upscale · demo", cost: 0 }]);
    const versions = await env.DB.prepare("SELECT label, outputs FROM month_versions WHERE batch = 'b1' AND kind = 'snapshot'").all<{ label: string; outputs: string }>();
    expect(versions.results).toEqual([{ label: "Post 1 before the Photo lab", outputs: JSON.stringify({ "1": "u1/b1/output/t1/a.png" }) }]);
    expect(await env.BUCKET.head(a.key)).toBeTruthy();
    expect(reached).toEqual([]);
  });
});
