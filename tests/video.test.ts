/**
 * Video versions of a post, end to end against a mocked Higgsfield: the catalog, who may submit,
 * what a submission records, how a refreshed studio reconnects to a running job, how the mp4 is
 * served (Range, HEAD, 416), the labelled upload, and what the client's link exposes and keeps.
 * No network call leaves the test: the provider is a fetch stub.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import { checkVideoSettings, DEFAULT_VIDEO_MODEL, VIDEO_MODELS, videoModel, videoRequestInput } from "../shared/video-models";
import type { User } from "../shared/types";

// The governance stub is observed: ops recorded, claims answered as the test says.
const ops = vi.hoisted(() => ({
  record: vi.fn(async () => "op-1"),
  update: vi.fn(async () => undefined),
  claim: vi.fn(async () => true),
}));
vi.mock("../server/integrations", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/integrations")>();
  return { ...real, recordIntegrationOp: ops.record, updateIntegrationOp: ops.update, claimSubmission: ops.claim };
});

type FakeEnv = ReturnType<typeof fakeEnv>;
const TOKEN = "b".repeat(32);
const SEEDANCE = "bytedance/seedance-2.5/image-to-video";
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;

async function app(role: User["role"] = "admin") {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const { shareRoutes } = await import("../server/share");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("/api/studio/*", async (c, next) => {
    c.set("user", { id: role === "admin" ? "u1" : "u2", email: "x@y", name: "X", role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.route("/api/share", shareRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}
type App = Awaited<ReturnType<typeof app>>;

async function seed() {
  const env = fakeEnv({ HIGGSFIELD_API_KEY: "id:secret" });
  const t = Date.now();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', 0, ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', 0, ?)").bind(t).run();
  const config = postConfig("c1", "2026-10", { shareToken: TOKEN, plan: [{ index: 1, type: "product", title: "Cup", brief: "A cup", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'cup.jpg', 'cup', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u1/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  await env.BUCKET.put("u1/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer, { httpMetadata: { contentType: "image/png" } });
  return env;
}

/** The provider, answering as Higgsfield does; `statuses` is what each status poll says, in order. */
function provider(opts: { estimate?: { credits: string; usd: string } | null; statuses: Record<string, unknown>[] } = { statuses: [] }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const statuses = [...opts.statuses];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (url.startsWith("https://higgsfield.test/estimate/")) return opts.estimate === null ? json({ detail: "no estimate" }, 404) : json(opts.estimate ?? { credits: "1.500", usd: "0.094" });
    if (url.startsWith("https://higgsfield.test/requests/")) return json(statuses.length > 1 ? statuses.shift() : (statuses[0] ?? { status: "in_progress" }));
    if (url.startsWith("https://higgsfield.test/")) return json({ request_id: "req-1", status: "queued" });
    if (url === "https://cdn.test/out.mp4") return new Response(sampleBytes(), { status: 200, headers: { "content-type": "video/mp4" } });
    throw new Error(`A network call was made without the test asking for it: ${url}`);
  });
  vi.stubGlobal("fetch", stub);
  return { calls };
}

const submit = (a: App, env: FakeEnv, body: object) =>
  a.request("/api/studio/posts/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, model: SEEDANCE, prompt: "The steam rises and the cup turns slowly", duration: 5, source: "picture", ...body }) }, env);
const list = async (a: App, env: FakeEnv) => (await (await a.request("/api/studio/posts/video/list?batch=b1&index=1", {}, env)).json()) as { videos: { id: string; status: string; url: string | null; requestId: string | null; error: string | null; version: number; forClient: boolean; prompt: string }[] };
const upload = async (a: App, env: FakeEnv, note = "sample") => {
  const form = new FormData();
  form.set("batch", "b1");
  form.set("index", "1");
  form.set("note", note);
  form.set("file", new File([sampleBytes()], "sample-1s.mp4", { type: "video/mp4" }));
  return a.request("/api/studio/posts/video/upload", { method: "POST", body: form }, env);
};

beforeEach(() => {
  ops.record.mockClear();
  ops.update.mockClear();
  ops.claim.mockReset();
  ops.claim.mockResolvedValue(true);
  guardFetch();
});

describe("the model catalog", () => {
  it("loads from shared/video-models with the two engines that worked before, and checks settings per model", () => {
    expect(VIDEO_MODELS.length).toBeGreaterThanOrEqual(2);
    expect(VIDEO_MODELS.map((m) => m.slug)).toEqual(expect.arrayContaining([SEEDANCE, "kling-video/v3.0/std/image-to-video"]));
    expect(DEFAULT_VIDEO_MODEL).toBe(SEEDANCE);
    for (const m of VIDEO_MODELS) {
      expect(m.price).toBeNull();
      expect(m.docs).toMatch(/^https:\/\/docs\.higgsfield\.ai\//);
      expect(checkVideoSettings(m, {}).ok).toBe(true);
    }
    const seedance = videoModel(SEEDANCE)!;
    expect(checkVideoSettings(seedance, { duration: 31 })).toMatchObject({ ok: false });
    expect(checkVideoSettings(seedance, { aspect: "9:16" })).toMatchObject({ ok: false });
    const kling26 = videoModel("kling-video/v2.6/pro/image-to-video")!;
    expect(checkVideoSettings(kling26, { duration: 7 })).toMatchObject({ ok: false });
    expect(checkVideoSettings(kling26, { duration: 10, aspect: "9:16" })).toMatchObject({ ok: true, settings: { duration: 10, aspect: "9:16" } });
    expect(videoRequestInput(seedance, "p", "https://x/y.jpg", { duration: 5, resolution: "720p", audio: false })).toEqual({ image_url: "https://x/y.jpg", duration: 5, prompt: "p", resolution: "720p", generate_audio: false });
    expect(videoRequestInput(videoModel("kling-video/v3.0/std/image-to-video")!, "p", "https://x/y.jpg", { duration: 5, audio: false })).toEqual({ image_url: "https://x/y.jpg", duration: 5, prompt: "p", sound: "off" });
  });
});

describe("submitting a clip", () => {
  it("refuses a member", async () => {
    const env = await seed();
    const r = await submit(await app("member"), env, {});
    expect(r.status).toBe(403);
    expect(ops.record).not.toHaveBeenCalled();
  });

  it("records the op with the provider's estimate and the request id for an admin", async () => {
    const env = await seed();
    const { calls } = provider();
    const r = await submit(await app(), env, { source: "picture", resolution: "720p" });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { video: { id: string; status: string; requestId: string; estimate: number; version: number; poster: string } };
    expect(d.video).toMatchObject({ status: "queued", requestId: "req-1", estimate: 0.094, version: 1 });
    expect(d.video.poster).toContain("/api/studio/posts/video/poster?");
    expect(ops.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: "higgsfield", kind: "video", user: "u1", batch: "b1", post: 1, estimate: 0.094, status: "confirmed" }));
    expect(ops.update).toHaveBeenCalledWith(expect.anything(), "op-1", expect.objectContaining({ taskId: "req-1", status: "running" }));
    expect(ops.claim).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^video:b1:1:[0-9a-f]{64}$/), expect.any(Number));
    const sent = calls.find((c) => c.url === `https://higgsfield.test/${SEEDANCE}`)!;
    const body = JSON.parse(String(sent.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ duration: 5, resolution: "720p", prompt: "The steam rises and the cup turns slowly" });
    expect(String(body.image_url)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=u1%2Fb1%2Foutput%2Ft1%2Fa\.png/);
    expect((sent.init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(d.video.id);
    const row = await env.DB.prepare("SELECT provider, source, poster_key, op_id, request_id FROM videos WHERE id = ?").bind(d.video.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ provider: "higgsfield", source: "picture", poster_key: "u1/b1/output/t1/a.png", op_id: "op-1", request_id: "req-1" });
  });

  it("refuses the same clip asked again within the claim window", async () => {
    const env = await seed();
    provider();
    ops.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await submit(await app(), env, {})).status).toBe(200);
    const again = await submit(await app(), env, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/asked for a moment ago/);
    expect(ops.record).toHaveBeenCalledTimes(1);
  });

  it("blocks a clip whose cost nobody knows until it is confirmed, and takes the admin's fallback price", async () => {
    const env = await seed();
    provider({ estimate: null, statuses: [] });
    const blocked = await submit(await app(), env, {});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ needsEstimate: true, model: SEEDANCE });
    expect(ops.record).not.toHaveBeenCalled();
    const confirmed = await submit(await app(), env, { confirm: true });
    expect(confirmed.status).toBe(200);
    expect(ops.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ estimate: null, status: "confirmed" }));
    // The admin sets a price in Connection: the next clip goes through with it.
    const set = await (await app()).request("/api/studio/engine/video-price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: SEEDANCE, usd: 0.5 }) }, env);
    expect(set.status).toBe(200);
    const priced = await submit(await app(), env, { prompt: "Another idea entirely" });
    expect(priced.status).toBe(200);
    expect(ops.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ estimate: 0.5 }));
    const prices = (await (await (await app("member")).request("/api/studio/engine/video-prices", {}, env)).json()) as { prices: Record<string, number | null> };
    expect(prices.prices[SEEDANCE]).toBe(0.5);
  });

  it("takes the composed artwork as the first frame when asked, and stores it as the poster", async () => {
    const env = await seed();
    const { calls } = provider();
    const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const r = await submit(await app(), env, { source: "artwork", artwork: png });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { video: { id: string } };
    const row = await env.DB.prepare("SELECT source, poster_key FROM videos WHERE id = ?").bind(d.video.id).first<{ source: string; poster_key: string }>();
    expect(row!.source).toBe("artwork");
    expect(row!.poster_key).toMatch(/\.artwork\.png$/);
    expect(env.BUCKET.objects.has(row!.poster_key)).toBe(true);
    const body = JSON.parse(String(calls.find((c) => c.url === `https://higgsfield.test/${SEEDANCE}`)!.init?.body)) as { image_url: string };
    expect(body.image_url).toContain(encodeURIComponent(row!.poster_key));
    expect((await submit(await app(), env, { source: "artwork", prompt: "Without the artwork itself" })).status).toBe(400);
  });

  it("keeps the frame on the version: handed to an engine with that frame option, or composed into the artwork for one that follows the picture", async () => {
    const env = await seed();
    const { calls } = provider();
    const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    // Seedance follows the picture: the browser composed a 9:16 picture (crop to fit) and sent it as the artwork, bare of words.
    const composed = await submit(await app(), env, { source: "artwork", artwork: png, frame: "9:16", fill: "crop", words: false });
    expect(composed.status).toBe(200);
    const c = (await composed.json()) as { video: { id: string; frame: string; frameFill: string; words: boolean; aspect: string | null } };
    expect(c.video).toMatchObject({ frame: "9:16", frameFill: "crop", words: false, aspect: null });
    expect(JSON.parse((await env.DB.prepare("SELECT settings FROM videos WHERE id = ?").bind(c.video.id).first<{ settings: string }>())!.settings)).toMatchObject({ frame: "9:16", frameFill: "crop", words: false });
    expect(JSON.parse(String(calls.find((x) => x.url === `https://higgsfield.test/${SEEDANCE}`)!.init?.body))).not.toHaveProperty("aspect_ratio");
    expect(ops.record).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ note: expect.stringContaining("frame 9:16 (crop)") }));
    // Kling 2.6 Pro takes the frame itself: the aspect goes to the engine, the picture goes as it is.
    const second = provider();
    const kling = "kling-video/v2.6/pro/image-to-video";
    const handed = await submit(await app(), env, { model: kling, prompt: "The cup turns slowly in the light", duration: 5, aspect: "9:16", frame: "9:16", words: false });
    expect(handed.status).toBe(200);
    const h = (await handed.json()) as { video: { frame: string; frameFill: string | null; words: boolean; aspect: string } };
    expect(h.video).toMatchObject({ frame: "9:16", frameFill: null, words: false, aspect: "9:16" });
    expect(JSON.parse(String(second.calls.find((x) => x.url === `https://higgsfield.test/${kling}`)!.init?.body))).toMatchObject({ aspect_ratio: "9:16" });
    // An unknown frame or fill is refused before anything is sent.
    expect((await submit(await app(), env, { frame: "3:4" })).status).toBe(400);
    expect((await submit(await app(), env, { frame: "1:1", fill: "stretch" })).status).toBe(400);
    // A version made before the frame control carries no frame; an artwork of that time means the words were in.
    const old = (await list(await app(), env)).videos.at(-1)!;
    expect(old).toMatchObject({ frame: "9:16" });
    expect((await submit(await app(), env, { prompt: "No frame asked at all" })).status).toBe(200);
    const plain = (await list(await app(), env)).videos[0];
    expect(plain).toMatchObject({ frame: null, frameFill: null, words: false });
  });

  it("keeps a submission the provider rejected as a failed version, and tries it again as a new job", async () => {
    const env = await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/estimate/")) return new Response(JSON.stringify({ usd: "0.1" }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ detail: "model_disabled" }), { status: 400, headers: { "content-type": "application/json" } });
      }),
    );
    const r = await submit(await app(), env, {});
    expect(r.status).toBe(502);
    const failed = (await list(await app(), env)).videos[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/disabled/);
    expect(ops.update).toHaveBeenCalledWith(expect.anything(), "op-1", expect.objectContaining({ status: "failed" }));
    // Try again: a new job and a new op, nothing automatic in between.
    provider();
    const retry = await (await app()).request("/api/studio/posts/video/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", id: failed.id }) }, env);
    expect(retry.status).toBe(200);
    const after = (await list(await app(), env)).videos;
    expect(after).toHaveLength(2);
    // The list asked the provider straight away, so the new job is queued or already generating.
    expect(after[0]).toMatchObject({ status: expect.stringMatching(/^(queued|generating)$/), requestId: "req-1", version: 2 });
    expect(ops.record).toHaveBeenCalledTimes(2);
  });
});

describe("status and recovery", () => {
  it("reconnects to a running job on list, then stores the mp4 when the provider finishes", async () => {
    const env = await seed();
    provider({ statuses: [{ status: "in_progress" }, { status: "completed", video: { url: "https://cdn.test/out.mp4" } }] });
    expect((await submit(await app(), env, {})).status).toBe(200);
    // A fresh studio (a new app) asks the list: the job is still running.
    const first = (await list(await app(), env)).videos[0];
    expect(first.status).toBe("generating");
    expect(first.url).toBeNull();
    // Next poll: finished, downloaded into R2, served from here.
    const done = (await list(await app(), env)).videos[0];
    expect(done.status).toBe("done");
    expect(done.url).toBe(`/api/studio/posts/video/file?batch=b1&id=${done.id}`);
    const row = await env.DB.prepare("SELECT key, settings FROM videos WHERE id = ?").bind(done.id).first<{ key: string; settings: string }>();
    expect(row!.key).toBe(`u1/b1/video/t1/${done.id}.mp4`);
    expect(env.BUCKET.objects.get(row!.key)!.bytes.byteLength).toBe(SAMPLE.byteLength);
    expect(JSON.parse(row!.settings)).toMatchObject({ faststart: true, codecs: expect.arrayContaining(["avc1", "mp4a"]) });
    expect(ops.update).toHaveBeenCalledWith(expect.anything(), "op-1", expect.objectContaining({ status: "done" }));
  });

  it("keeps the provider's message on a failed job and gives up after half an hour, never resubmitting", async () => {
    const env = await seed();
    const { calls } = provider({ statuses: [{ status: "failed", error: "GPU on fire" }] });
    expect((await submit(await app(), env, {})).status).toBe(200);
    const failed = (await list(await app(), env)).videos[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/GPU on fire/);
    // A second clip that never finishes: given up after thirty minutes.
    provider({ statuses: [{ status: "queued" }] });
    expect((await submit(await app(), env, { prompt: "A slow push-in on the cup" })).status).toBe(200);
    await env.DB.prepare("UPDATE videos SET created = created - 31 * 60 * 1000 WHERE status = 'queued'").run();
    const old = (await list(await app(), env)).videos.find((v) => v.prompt === "A slow push-in on the cup")!;
    expect(old.status).toBe("failed");
    expect(old.error).toMatch(/half an hour/);
    expect(calls.filter((c) => c.url === `https://higgsfield.test/${SEEDANCE}`)).toHaveLength(1);
  });
});

describe("the stored file", () => {
  async function stored(env: FakeEnv) {
    const r = await upload(await app(), env);
    expect(r.status).toBe(200);
    return ((await r.json()) as { video: { id: string } }).video.id;
  }

  it("serves the whole mp4 with the headers a player needs", async () => {
    const env = await seed();
    const id = await stored(env);
    const r = await (await app()).request(`/api/studio/posts/video/file?batch=b1&id=${id}`, {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("cache-control")).toMatch(/^private/);
    expect(r.headers.get("content-length")).toBe(String(SAMPLE.byteLength));
    expect((await r.arrayBuffer()).byteLength).toBe(SAMPLE.byteLength);
  });

  it("answers a Range with 206 and the right slice, HEAD with the size, and a bad range with 416", async () => {
    const env = await seed();
    const id = await stored(env);
    const a = await app();
    const part = await a.request(`/api/studio/posts/video/file?batch=b1&id=${id}`, { headers: { Range: "bytes=100-199" } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${SAMPLE.byteLength}`);
    expect(part.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array(sampleBytes().slice(100, 200)));
    const tail = await a.request(`/api/studio/posts/video/file?batch=b1&id=${id}`, { headers: { Range: "bytes=3000-" } }, env);
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes 3000-${SAMPLE.byteLength - 1}/${SAMPLE.byteLength}`);
    const head = await a.request(`/api/studio/posts/video/file?batch=b1&id=${id}`, { method: "HEAD" }, env);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(SAMPLE.byteLength));
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    const bad = await a.request(`/api/studio/posts/video/file?batch=b1&id=${id}`, { headers: { Range: "bytes=999999-" } }, env);
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${SAMPLE.byteLength}`);
  });

  it("stores an uploaded sample as a done version (admins only) and reads what it is", async () => {
    const env = await seed();
    expect((await upload(await app("member"), env)).status).toBe(403);
    const r = await upload(await app(), env, "iPhone test");
    expect(r.status).toBe(200);
    const d = (await r.json()) as { video: { status: string; provider: string; source: string; duration: number; poster: string; warnings: string[] }; info: { video: string; audio: string; faststart: boolean; duration: number } };
    expect(d.video).toMatchObject({ status: "done", provider: "upload", source: "upload", duration: 1, warnings: [] });
    expect(d.video.poster).toContain("/api/studio/posts/video/poster?");
    expect(d.info).toMatchObject({ video: "h264", audio: "aac", faststart: true, duration: 1 });
    // Not an mp4: refused before anything is stored.
    const form = new FormData();
    form.set("batch", "b1");
    form.set("index", "1");
    form.set("file", new File([new Uint8Array(64)], "x.mp4", { type: "video/mp4" }));
    const bad = await (await app()).request("/api/studio/posts/video/upload", { method: "POST", body: form }, env);
    expect(bad.status).toBe(400);
    expect(env.BUCKET.objects.size).toBe(2);
  });
});

describe("the client's link", () => {
  const read = async (a: App, env: FakeEnv) => (await (await a.request(`/api/share/${TOKEN}?rid=rid-nada-01`, {}, env)).json()) as { posts: { video: { id: string; url: string; poster: string; duration: number; version: { kind: string; id: string; label: string } } | null; version: { kind: string; id: string; label: string } | null }[] };

  it("shows the first finished clip to the client by itself, keeps a chosen one when a later clip lands, serves it with Range, and never a draft", async () => {
    const env = await seed();
    const a = await app();
    // No clip yet: the client sees the picture, and the file is not there.
    const none = await read(a, env);
    expect(none.posts[0].video).toBeNull();
    expect(none.posts[0].version).toMatchObject({ kind: "image", label: expect.stringMatching(/^Picture \(/) });
    expect((await a.request(`/api/share/${TOKEN}/video/1`, {}, env)).status).toBe(404);
    // The first finished clip goes to the client without anyone selecting it.
    const first = (await (await upload(a, env, "first")).json()) as { video: { id: string; forClient: boolean } };
    expect(first.video.forClient).toBe(true);
    const firstId = first.video.id;
    const auto = await read(a, env);
    expect(auto.posts[0].video).toMatchObject({ id: firstId, version: { kind: "video", id: firstId } });
    // A later clip does not replace the one the client already sees.
    const second = (await (await upload(a, env, "second")).json()) as { video: { id: string; forClient: boolean } };
    expect(second.video.forClient).toBe(false);
    const secondId = second.video.id;
    expect((await read(a, env)).posts[0].video!.id).toBe(firstId);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE for_client = 1").first<{ n: number }>())!.n).toBe(1);
    // The team may still pick the first by hand (a no-op here) and sees who the client sees.
    const sel = await a.request("/api/studio/posts/video/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, id: firstId }) }, env);
    expect(sel.status).toBe(200);
    expect(((await sel.json()) as { videos: { id: string; forClient: boolean }[] }).videos.map((v) => [v.id, v.forClient])).toEqual([
      [secondId, false],
      [firstId, true],
    ]);
    const after = await read(a, env);
    expect(after.posts[0].video).toMatchObject({ id: firstId, url: expect.stringMatching(new RegExp(`^/api/share/${TOKEN}/video/1\\?v=\\d+$`)), poster: expect.stringContaining(`/api/share/${TOKEN}/video/1/poster`), duration: 1, version: { kind: "video", id: firstId, label: expect.stringMatching(/^Video 1 \(/) } });
    expect(after.posts[0].version).toEqual(after.posts[0].video!.version);
    const part = await a.request(`/api/share/${TOKEN}/video/1`, { headers: { Range: "bytes=0-9" } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${SAMPLE.byteLength}`);
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect(part.headers.get("cache-control")).toMatch(/^private/);
    expect((await a.request(`/api/share/${TOKEN}/video/1/poster`, {}, env)).status).toBe(200);
    expect((await a.request(`/api/share/${"c".repeat(32)}/video/1`, {}, env)).status).toBe(404);
    // Only one version per post goes to the client: selecting the second takes the first off.
    await a.request("/api/studio/posts/video/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, id: secondId }) }, env);
    expect((await read(a, env)).posts[0].video!.version.label).toMatch(/^Video 2 \(/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE for_client = 1").first<{ n: number }>())!.n).toBe(1);
    // "Show the picture instead": the picture again, and a third clip now becomes the client's (the post had none).
    await a.request("/api/studio/posts/video/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, id: null }) }, env);
    expect((await read(a, env)).posts[0].video).toBeNull();
    expect((await a.request(`/api/share/${TOKEN}/video/1`, {}, env)).status).toBe(404);
    const third = (await (await upload(a, env, "third")).json()) as { video: { id: string; forClient: boolean } };
    expect(third.video.forClient).toBe(true);
    expect((await read(a, env)).posts[0].video!.id).toBe(third.video.id);
  });

  it("marks a clip the provider finishes as the client's version when the post has none, and the summary says so", async () => {
    const env = await seed();
    provider({ statuses: [{ status: "in_progress" }, { status: "completed", video: { url: "https://cdn.test/out.mp4" } }] });
    expect((await submit(await app(), env, {})).status).toBe(200);
    const queued = (await list(await app(), env)).videos[0];
    expect(queued).toMatchObject({ status: "generating", forClient: false });
    // The list collects the finished clip: stored, done, and the client's version at once.
    const done = (await list(await app(), env)).videos[0];
    expect(done).toMatchObject({ status: "done", forClient: true });
    const shared = await read(await app(), env);
    expect(shared.posts[0].video).toMatchObject({ id: done.id, version: { kind: "video", id: done.id } });
    const summary = (await (await (await app()).request("/api/studio/posts/video/summary?batch=b1", {}, env)).json()) as { posts: Record<string, { client: { id: string } | null }> };
    expect(summary.posts["1"].client?.id).toBe(done.id);
  });

  it("stores the version each answer referred to, and keeps earlier answers on older versions", async () => {
    const env = await seed();
    const a = await app();
    const answer = (body: object) => a.request(`/api/share/${TOKEN}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
    const pic = (await read(a, env)).posts[0].version!;
    expect((await answer({ index: 1, status: "changes", note: "Bigger cup", by: "Nada", rid: "rid-nada-01", version: pic })).status).toBe(200);
    const id = ((await (await upload(a, env)).json()) as { video: { id: string } }).video.id;
    await a.request("/api/studio/posts/video/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, id }) }, env);
    const vid = (await read(a, env)).posts[0].version!;
    expect(vid.kind).toBe("video");
    const r = await answer({ index: 1, status: "approved", by: "Ahmad", rid: "rid-ahmad-01", version: vid });
    expect(((await r.json()) as { approval: { version: unknown } }).approval.version).toEqual(vid);
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    const answers = cfg.approvals!["1"].answers!;
    expect(answers.map((x) => [x.by, x.version?.kind, x.version?.label])).toEqual([
      ["Nada", "image", expect.stringMatching(/^Picture \(/)],
      ["Ahmad", "video", expect.stringMatching(/^Video 1 \(/)],
    ]);
    expect(answers[1].version?.id).toBe(id);
  });
});
