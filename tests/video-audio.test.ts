/**
 * Audio for a post's video versions (docs/video.md "Audio"): who may upload a track or choose a
 * version's audio (admins), what the upload keeps and lists, how the track is served (Range, HEAD),
 * what a choice writes on the version and in the ledger, and that generated music is refused as
 * "not connected" with a refused ledger row. No network call leaves the test: the guard fails any.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { AUDIO_MAX_BYTES, GENERATED_NOT_CONNECTED, audioChoiceLine } from "../shared/video-audio";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { listIntegrationOps, setIntegrationSwitch } from "../server/integrations";
import { audioFormat, wavDurationMs } from "../server/video-audio";

type FakeEnv = ReturnType<typeof fakeEnv>;
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;

/** A one-second 8 kHz mono 8-bit WAV: 44-byte header, 8000 bytes of samples (a plain ramp). */
function wav(seconds = 1, rate = 8000): ArrayBuffer {
  const data = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  tag(36, "data");
  v.setUint32(40, data, true);
  for (let i = 0; i < data; i++) v.setUint8(44 + i, i % 256);
  return buf;
}

function app(role: User["role"]) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: role === "admin" ? "u1" : "u2", email: "x@y", name: "X", role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}
type App = ReturnType<typeof app>;

/** A month owned by the member, so viewing can be tried as them; the admin sees every month. */
async function seed() {
  const env = fakeEnv({ HIGGSFIELD_API_KEY: "id:secret" });
  const t = Date.now();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', 0, ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', 0, ?)").bind(t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "product", title: "Cup", brief: "A cup", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'cup.jpg', 'cup', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('t1', 'b1', 's1', 1, 'ready', 'u2/b1/output/t1/a.png', '', 1, ?)").bind(t).run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer, { httpMetadata: { contentType: "image/png" } });
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const postJson = (a: App, env: FakeEnv, path: string, body: unknown) => a.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

async function uploadTrack(a: App, env: FakeEnv, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("batch", "b1");
  form.set("post", "1");
  form.set("name", "Summer loop");
  form.set("license", "Epidemic Sound, Level MENA account");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", file);
  return a.request("/api/studio/posts/video/audio/upload", { method: "POST", body: form }, env);
}
const wavFile = () => new File([wav()], "summer-loop.wav", { type: "audio/wav" });

/** A finished version to choose audio for: the labelled mp4 upload (no provider call). */
async function videoVersion(a: App, env: FakeEnv): Promise<string> {
  const form = new FormData();
  form.set("batch", "b1");
  form.set("index", "1");
  form.set("note", "sample");
  form.set("file", new File([sampleBytes()], "sample-1s.mp4", { type: "video/mp4" }));
  const r = await a.request("/api/studio/posts/video/upload", { method: "POST", body: form }, env);
  expect(r.status).toBe(200);
  return ((await json(r)).video as { id: string }).id;
}

let guard: ReturnType<typeof guardFetch>;
beforeEach(() => {
  guard = guardFetch();
});

describe("who may write", () => {
  it("lets a member upload a track too (24 Oct: the team), recorded under their name", async () => {
    const env = await seed();
    const up = await uploadTrack(app("member"), env, wavFile());
    expect(up.status).toBe(200);
    const ops = await listIntegrationOps(env, { provider: "audio" });
    expect(ops).toHaveLength(1);
    expect(ops[0].user_id).toBe("u2");
    expect(guard.stub).not.toHaveBeenCalled();
  });

  it("answers 503 while the audio switch is off, and still lists for everyone", async () => {
    const env = await seed();
    await setIntegrationSwitch(env, "audio", false);
    const up = await uploadTrack(app("admin"), env, wavFile());
    expect(up.status).toBe(503);
    expect((await json(up)).error).toMatch(/switched off/);
    const list = await app("member").request("/api/studio/posts/video/audio/list?batch=b1&post=1", {}, env);
    expect(list.status).toBe(200);
    expect((await json(list)).access).toMatchObject({ admin: true, enabled: false });
    expect(guard.stub).not.toHaveBeenCalled();
  });
});

describe("an uploaded track", () => {
  it("is stored in R2, listed with its name, licence and length, and written to the ledger at estimate 0", async () => {
    const env = await seed();
    const admin = app("admin");
    const r = await uploadTrack(admin, env, wavFile());
    expect(r.status).toBe(200);
    const d = (await json(r)) as { track: { id: string; name: string; license: string; durationMs: number; mime: string; url: string; kind: string } };
    expect(d.track).toMatchObject({ name: "Summer loop", license: "Epidemic Sound, Level MENA account", durationMs: 1000, mime: "audio/wav", kind: "upload" });
    expect(d.track.url).toBe(`/api/studio/posts/video/audio/file?batch=b1&id=${d.track.id}`);
    const keys = [...env.BUCKET.objects.keys()].filter((k) => k.includes("/audio/"));
    expect(keys).toEqual([`u2/b1/audio/1/${d.track.id}.wav`]);
    expect(env.BUCKET.objects.get(keys[0])?.httpMetadata?.contentType).toBe("audio/wav");
    // Members see the list.
    const list = await app("member").request("/api/studio/posts/video/audio/list?batch=b1&post=1", {}, env);
    expect(list.status).toBe(200);
    const l = (await json(list)) as { tracks: { id: string }[]; access: { admin: boolean }; generated: { connected: boolean; reason: string } };
    expect(l.tracks.map((t) => t.id)).toEqual([d.track.id]);
    expect(l.access.admin).toBe(true);
    expect(l.generated).toEqual({ connected: false, reason: GENERATED_NOT_CONNECTED });
    const ops = await listIntegrationOps(env, { provider: "audio" });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "audio.upload", user_id: "u1", batch: "b1", post: 1, estimate: 0, status: "done" });
    expect(ops[0].note).toContain("Summer loop");
    expect(guard.stub).not.toHaveBeenCalled();
  });

  it("takes the file's name when no name is given, and the browser's length for an mp3", async () => {
    const env = await seed();
    const mp3 = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4])], "brand-sting.mp3", { type: "audio/mpeg" });
    const r = await uploadTrack(app("admin"), env, mp3, { name: "", license: "", duration: "32500" });
    expect(r.status).toBe(200);
    const d = (await json(r)) as { track: { name: string; durationMs: number; mime: string; license: string } };
    expect(d.track).toMatchObject({ name: "brand-sting", durationMs: 32500, mime: "audio/mpeg", license: "" });
  });

  it("refuses a file that is not mp3, m4a, aac or wav with 415", async () => {
    const env = await seed();
    const admin = app("admin");
    const txt = await uploadTrack(admin, env, new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" }));
    expect(txt.status).toBe(415);
    const lying = await uploadTrack(admin, env, new File([new Uint8Array([1, 2, 3])], "clip.mp3", { type: "video/mp4" }));
    expect(lying.status).toBe(415);
    const ogg = await uploadTrack(admin, env, new File([new Uint8Array([1, 2, 3])], "clip.ogg", { type: "audio/ogg" }));
    expect(ogg.status).toBe(415);
    expect([...env.BUCKET.objects.keys()].filter((k) => k.includes("/audio/"))).toEqual([]);
    expect(await listIntegrationOps(env, { provider: "audio" })).toEqual([]);
  });

  it("refuses a track over 25 MB with 413", async () => {
    const env = await seed();
    const big = new File([new Uint8Array(AUDIO_MAX_BYTES + 1)], "long.mp3", { type: "audio/mpeg" });
    const r = await uploadTrack(app("admin"), env, big);
    expect(r.status).toBe(413);
    expect((await json(r)).error).toMatch(/25 MB/);
    expect([...env.BUCKET.objects.keys()].filter((k) => k.includes("/audio/"))).toEqual([]);
  });

  it("reads formats and WAV lengths", () => {
    expect(audioFormat("a.mp3", "audio/mpeg")).toEqual({ ext: "mp3", mime: "audio/mpeg" });
    expect(audioFormat("a.M4A", "audio/x-m4a")).toEqual({ ext: "m4a", mime: "audio/mp4" });
    expect(audioFormat("a.aac", "")).toEqual({ ext: "aac", mime: "audio/aac" });
    expect(audioFormat("a.wav", "audio/x-wav")).toEqual({ ext: "wav", mime: "audio/wav" });
    expect(audioFormat("a.flac", "audio/flac")).toBeNull();
    expect(audioFormat("a.mp3", "image/png")).toBeNull();
    expect(wavDurationMs(wav(2.5, 16000))).toBe(2500);
    expect(wavDurationMs(new Uint8Array(10).buffer)).toBeNull();
  });
});

describe("the stored track", () => {
  it("answers GET with the whole file, a Range with 206 and the exact slice, and HEAD with the size", async () => {
    const env = await seed();
    const admin = app("admin");
    const d = (await json(await uploadTrack(admin, env, wavFile()))) as { track: { id: string } };
    const url = `/api/studio/posts/video/audio/file?batch=b1&id=${d.track.id}`;
    const bytes = wav();
    // A member of the month can play it.
    const whole = await app("member").request(url, {}, env);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array(bytes));
    const part = await admin.request(url, { headers: { Range: "bytes=100-199" } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${bytes.byteLength}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array(bytes.slice(100, 200)));
    const head = await admin.request(url, { method: "HEAD" }, env);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
    const bad = await admin.request(url, { headers: { Range: `bytes=${bytes.byteLength + 10}-` } }, env);
    expect(bad.status).toBe(416);
    const missing = await admin.request("/api/studio/posts/video/audio/file?batch=b1&id=nope", {}, env);
    expect(missing.status).toBe(404);
    expect(guard.stub).not.toHaveBeenCalled();
  });
});

describe("choosing a version's audio", () => {
  it("writes the choice and the track on the video row, lists it by name, and records a ledger row at estimate 0", async () => {
    const env = await seed();
    const admin = app("admin");
    const videoId = await videoVersion(admin, env);
    const track = ((await json(await uploadTrack(admin, env, wavFile()))) as { track: { id: string } }).track;
    const r = await postJson(admin, env, "/api/studio/posts/video/audio/choose", { batch: "b1", index: 1, videoId, choice: "upload", audioId: track.id });
    expect(r.status).toBe(200);
    const d = (await json(r)) as { videos: { id: string; audioChoice: string; audioId: string; audioName: string }[] };
    expect(d.videos.find((v) => v.id === videoId)).toMatchObject({ audioChoice: "upload", audioId: track.id, audioName: "Summer loop" });
    const row = await env.DB.prepare("SELECT audio_choice, audio_id FROM videos WHERE id = ?").bind(videoId).first<{ audio_choice: string; audio_id: string }>();
    expect(row).toEqual({ audio_choice: "upload", audio_id: track.id });
    // The list and the versions list say "Track: Summer loop".
    const list = (await json(await app("member").request("/api/studio/posts/video/list?batch=b1&index=1", {}, env))) as { videos: { id: string; audioChoice: string; audioName: string }[] };
    const item = list.videos.find((v) => v.id === videoId)!;
    expect(audioChoiceLine(item.audioChoice as "upload", item.audioName)).toBe("Track: Summer loop");
    const ops = await listIntegrationOps(env, { provider: "audio" });
    expect(ops.map((o) => o.kind)).toEqual(["audio.choose", "audio.upload"]);
    expect(ops[0]).toMatchObject({ user_id: "u1", batch: "b1", post: 1, estimate: 0, status: "done" });
    expect(ops[0].note).toContain("upload · Summer loop");
    // The mp4 itself did not change.
    const file = await admin.request(`/api/studio/posts/video/file?batch=b1&id=${videoId}`, {}, env);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(sampleBytes()));
    expect(guard.stub).not.toHaveBeenCalled();
  });

  it("takes none, provider and instagram without a track, and refuses an upload choice without one", async () => {
    const env = await seed();
    const admin = app("admin");
    const videoId = await videoVersion(admin, env);
    const choose = (body: object) => postJson(admin, env, "/api/studio/posts/video/audio/choose", { batch: "b1", index: 1, videoId, ...body });
    expect((await choose({ choice: "instagram" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT audio_choice, audio_id FROM videos WHERE id = ?").bind(videoId).first()).toEqual({ audio_choice: "instagram", audio_id: null });
    const list = (await json(await admin.request("/api/studio/posts/video/list?batch=b1&index=1", {}, env))) as { videos: { audioChoice: string; audioName: string | null }[] };
    expect(audioChoiceLine(list.videos[0].audioChoice as "instagram", list.videos[0].audioName)).toBe("Music added on Instagram");
    expect((await choose({ choice: "none" })).status).toBe(200);
    expect((await choose({ choice: "provider" })).status).toBe(200);
    const noTrack = await choose({ choice: "upload" });
    expect(noTrack.status).toBe(400);
    const unknownTrack = await choose({ choice: "upload", audioId: "nope" });
    expect(unknownTrack.status).toBe(404);
    const badChoice = await choose({ choice: "spotify" });
    expect(badChoice.status).toBe(400);
    const badVideo = await postJson(admin, env, "/api/studio/posts/video/audio/choose", { batch: "b1", index: 1, videoId: "nope", choice: "none" });
    expect(badVideo.status).toBe(404);
    expect((await listIntegrationOps(env, { provider: "audio" })).map((o) => o.kind)).toEqual(["audio.choose", "audio.choose", "audio.choose"]);
  });
});

describe("generated music", () => {
  it("is refused with 503 'not connected' and a refused ledger row; nothing is sent", async () => {
    const env = await seed();
    const r = await postJson(app("admin"), env, "/api/studio/posts/video/audio/generate", { batch: "b1", index: 1, prompt: "warm acoustic loop" });
    expect(r.status).toBe(503);
    const d = (await json(r)) as { error: string; opId: string; connected: boolean };
    expect(d.error).toBe(GENERATED_NOT_CONNECTED);
    expect(d.connected).toBe(false);
    const ops = await listIntegrationOps(env, { provider: "audio" });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: d.opId, kind: "audio.generate", status: "refused", estimate: null, batch: "b1", post: 1 });
    expect(ops[0].note).toContain("warm acoustic loop");
    expect(guard.stub).not.toHaveBeenCalled();
  });
});
