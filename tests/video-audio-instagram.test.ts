/**
 * "Sound from an Instagram link" and "Sound from a video file" (server/video-audio.ts, the reel
 * read in server/meta.ts `instagramVideo`): who may ask, what a reel's sound is kept as (its mp4,
 * the same track row an upload writes, the licence line about Instagram's rights, a ledger row at
 * estimate 0), and each refusal: Instagram not connected, a picture instead of a video, a reel
 * outside the account's last 50 posts, a private or personal account. A video file is taken as a
 * post's track; the music library still takes audio files only.
 *
 * Nothing leaves the test: Instagram's oEmbed, the Graph API and the CDN are answered by a fake
 * that fails on any other address (tests/support/paid-guard.ts). The real Meta read cannot be
 * checked here.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { INSTAGRAM_SOUND_WARNING, instagramSoundLicence, instagramSoundName } from "../shared/video-audio";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { listIntegrationOps } from "../server/integrations";
import { setSetting } from "../server/settings";
import { audioFormat } from "../server/video-audio";
import { instagramShortcode } from "../server/meta";

type FakeEnv = ReturnType<typeof fakeEnv>;
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;

const TOKEN = "EAAG-test-token-" + "x".repeat(30);
const IG_ID = "17841400000001";
const CODE = "DAbCdEf1234";
const LINK = `https://www.instagram.com/reel/${CODE}/?igsh=abc`;
const PERMALINK = `https://www.instagram.com/reel/${CODE}/`;
const CDN = "https://scontent.cdninstagram.com/o1/v/t16/reel.mp4?efg=1";

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

/** A month owned by the member; the admin sees every month. `connected` stores the agency's Meta connection. */
async function seed(opts: { connected?: boolean } = {}) {
  const env = fakeEnv({ HIGGSFIELD_API_KEY: "id:secret" });
  const t = Date.now();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', 0, ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', 0, ?)").bind(t).run();
  const config = postConfig("c1", "2026-10", { plan: [{ index: 1, type: "product", title: "Cup", brief: "A cup", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  if (opts.connected !== false) {
    await setSetting(env, "meta_token", TOKEN);
    await setSetting(env, "meta_account", JSON.stringify({ igId: IG_ID, username: "levelmena", page: "Level", connected: t, expires: 0 }));
  }
  return env;
}

interface Fake {
  /** The oEmbed answer (status and body). */
  oembed?: { status: number; body: unknown };
  /** The Business Discovery answer (status and body). */
  graph?: { status: number; body: unknown };
  /** The CDN's file. */
  file?: { status: number; type: string; bytes: ArrayBuffer };
}

const reelPost = (patch: Record<string, unknown> = {}) => ({ id: "180001", permalink: PERMALINK, media_type: "VIDEO", media_url: CDN, timestamp: "2026-10-01T10:00:00+0000", ...patch });
const otherPost = { id: "180002", permalink: "https://www.instagram.com/p/ZZotherZZ/", media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/o1/x.jpg" };

/**
 * Instagram and Meta as the test wants them to answer. Built on the paid-call guard: only the
 * three addresses below are answered, anything else fails the test.
 */
function fakeInstagram(f: Fake = {}) {
  const hosts = ["https://www.instagram.com/api/v1/oembed/", "https://graph.facebook.com/v23.0/", "https://scontent.cdninstagram.com/"];
  const guard = guardFetch((url) => hosts.some((h) => url.startsWith(h)));
  guard.stub.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    guard.reached.push({ url });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith(hosts[0])) {
      const o = f.oembed ?? { status: 200, body: { author_name: "brand.reels", title: "New drop", thumbnail_url: "https://scontent.cdninstagram.com/o1/cover.jpg" } };
      return json(o.status, o.body);
    }
    if (url.startsWith(hosts[1])) {
      const g = f.graph ?? { status: 200, body: { business_discovery: { media: { data: [otherPost, reelPost()] } }, id: IG_ID } };
      return json(g.status, g.body);
    }
    if (url.startsWith(hosts[2])) {
      const file = f.file ?? { status: 200, type: "video/mp4", bytes: sampleBytes() };
      return new Response(file.bytes, { status: file.status, headers: { "content-type": file.type, "content-length": String(file.bytes.byteLength) } });
    }
    throw new Error(`A network call was made without the test asking for it: ${url}`);
  });
  return guard;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const askReel = (a: App, env: FakeEnv, link = LINK) =>
  a.request("/api/studio/posts/video/audio/instagram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, link }) }, env);
const audioKeys = (env: FakeEnv) => [...env.BUCKET.objects.keys()].filter((k) => k.includes("/audio/"));

beforeEach(() => {
  guardFetch();
});

describe("sound from an Instagram link", () => {
  it("keeps the reel's mp4 as one of the post's tracks, with the Instagram licence line and a ledger row at estimate 0", async () => {
    const env = await seed();
    const ig = fakeInstagram();
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { track: { id: string; name: string; license: string; mime: string; kind: string; provider: string; durationMs: number; url: string }; tracks: { id: string }[]; warning: string };
    expect(d.track).toMatchObject({ name: "Sound of @brand.reels's reel", mime: "video/mp4", kind: "upload", provider: "instagram" });
    expect(d.track.name).toBe(instagramSoundName("brand.reels"));
    expect(d.track.license).toBe(`From Instagram (@brand.reels, ${PERMALINK}). Sound from Instagram is licensed for use on Instagram only: confirm the rights before publishing it elsewhere.`);
    expect(d.track.license).toBe(instagramSoundLicence("brand.reels", PERMALINK));
    expect(d.track.durationMs).toBeGreaterThan(500);
    expect(d.warning).toBe(INSTAGRAM_SOUND_WARNING);
    expect(d.tracks.map((t) => t.id)).toEqual([d.track.id]);
    // The file as Instagram's CDN sent it, under the post's audio, typed as an mp4.
    expect(audioKeys(env)).toEqual([`u2/b1/audio/1/${d.track.id}.mp4`]);
    const stored = env.BUCKET.objects.get(audioKeys(env)[0]);
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
    // The calls: oEmbed for the account, Business Discovery for its posts, then the CDN file.
    const urls = ig.reached.map((x) => x.url);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain(encodeURIComponent(`https://www.instagram.com/p/${CODE}/`));
    expect(decodeURIComponent(urls[1])).toContain(`${IG_ID}?fields=business_discovery.username(brand.reels){media.limit(50){permalink,media_type,media_url`);
    expect(urls[2]).toBe(CDN);
    // The token never comes back in the answer.
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    const ops = await listIntegrationOps(env, { provider: "audio" });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "audio.instagram", user_id: "u1", batch: "b1", post: 1, estimate: 0, status: "done" });
    // Every signed-in user lists it and the file route serves the mp4 (the editor decodes its sound).
    const list = (await json(await app("member").request("/api/studio/posts/video/audio/list?batch=b1&post=1", {}, env))) as { tracks: { id: string; mime: string }[] };
    expect(list.tracks).toEqual([expect.objectContaining({ id: d.track.id, mime: "video/mp4" })]);
    const file = await app("member").request(d.track.url, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("video/mp4");
    expect((await file.arrayBuffer()).byteLength).toBe(SAMPLE.byteLength);
  });

  it("refuses with a plain way forward when Instagram is not connected, before any call", async () => {
    const env = await seed({ connected: false });
    const ig = fakeInstagram();
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(428);
    expect((await json(r)).error).toBe("Connect Instagram under Connection → Meta to read a reel's sound, or download the reel and use Sound from a video file.");
    expect(ig.reached).toEqual([]);
    expect(audioKeys(env)).toEqual([]);
    expect(await listIntegrationOps(env, { provider: "audio" })).toEqual([]);
  });

  it("refuses a post that is a picture, not a video, and downloads nothing", async () => {
    const env = await seed();
    const ig = fakeInstagram({ graph: { status: 200, body: { business_discovery: { media: { data: [reelPost({ media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/o1/p.jpg" })] } } } } });
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(415);
    expect((await json(r)).error).toMatch(/a picture, not a video: it has no sound to take/);
    expect(ig.reached.some((x) => x.url.startsWith("https://scontent."))).toBe(false);
    expect(audioKeys(env)).toEqual([]);
  });

  it("says when the reel is not among the account's last 50 posts", async () => {
    const env = await seed();
    fakeInstagram({ graph: { status: 200, body: { business_discovery: { media: { data: [otherPost] } } } } });
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(404);
    expect((await json(r)).error).toBe("This reel is not among @brand.reels's last 50 posts, the most the Meta connection reads. Download the reel and use Sound from a video file instead.");
    expect(audioKeys(env)).toEqual([]);
  });

  it("says a private or personal account cannot be read", async () => {
    const env = await seed();
    fakeInstagram({ graph: { status: 400, body: { error: { message: "(#110) Cannot find User", code: 110 } } } });
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(404);
    expect((await json(r)).error).toMatch(/@brand\.reels's reels cannot be read through the Meta connection: only public business and creator accounts can be, not a private or personal account/);
  });

  it("says when Instagram does not give the reel up (private, deleted, wrong link)", async () => {
    const env = await seed();
    fakeInstagram({ oembed: { status: 404, body: {} } });
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(404);
    expect((await json(r)).error).toMatch(/Instagram did not give that reel up/);
  });

  it("refuses a file Instagram's CDN sends that is not a video", async () => {
    const env = await seed();
    fakeInstagram({ file: { status: 200, type: "text/html", bytes: new TextEncoder().encode("<html></html>").buffer as ArrayBuffer } });
    const r = await askReel(app("admin"), env);
    expect(r.status).toBe(502);
    expect((await json(r)).error).toMatch(/instead of the reel's video/);
    expect(audioKeys(env)).toEqual([]);
  });

  it("refuses a link that is not a reel or a post, and a member", async () => {
    const env = await seed();
    const ig = fakeInstagram();
    const bad = await askReel(app("admin"), env, "https://www.instagram.com/brand.reels/");
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatch(/not a link to an Instagram reel or post/);
    const member = await askReel(app("member"), env);
    expect(member.status).toBe(403);
    expect(ig.reached).toEqual([]);
  });

  it("reads the shortcode of reel, post and tv links", () => {
    expect(instagramShortcode("https://www.instagram.com/reel/DAbCdEf1234/?igsh=x")).toBe("DAbCdEf1234");
    expect(instagramShortcode("instagram.com/p/DAbCdEf1234")).toBe("DAbCdEf1234");
    expect(instagramShortcode("https://instagram.com/tv/DAbCdEf1234/")).toBe("DAbCdEf1234");
    expect(instagramShortcode("https://www.instagram.com/brand.reels/reels/DAbCdEf1234/")).toBe("DAbCdEf1234");
    expect(instagramShortcode("https://www.instagram.com/brand.reels/")).toBeNull();
  });
});

describe("sound from a video file", () => {
  it("keeps an mp4 as a post's track (video/mp4), so the editor can read its sound back", async () => {
    const env = await seed();
    const form = new FormData();
    form.set("batch", "b1");
    form.set("post", "1");
    form.set("name", "Downloaded reel");
    form.set("license", "Our own reel");
    form.set("file", new File([sampleBytes()], "reel.mp4", { type: "video/mp4" }));
    const r = await app("admin").request("/api/studio/posts/video/audio/upload", { method: "POST", body: form }, env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { track: { id: string; mime: string; durationMs: number } };
    expect(d.track.mime).toBe("video/mp4");
    expect(d.track.durationMs).toBeGreaterThan(500);
    expect(audioKeys(env)).toEqual([`u2/b1/audio/1/${d.track.id}.mp4`]);
  });

  it("refuses a file named .mp4 that is not an MP4", async () => {
    const env = await seed();
    const form = new FormData();
    form.set("batch", "b1");
    form.set("post", "1");
    form.set("file", new File([new Uint8Array(64)], "fake.mp4", { type: "video/mp4" }));
    const r = await app("admin").request("/api/studio/posts/video/audio/upload", { method: "POST", body: form }, env);
    expect(r.status).toBe(415);
    expect((await json(r)).error).toMatch(/not an MP4 or MOV video/);
  });

  it("takes video formats for a post's track only: the music library keeps to audio files", () => {
    expect(audioFormat("reel.mp4", "video/mp4", { video: true })).toEqual({ ext: "mp4", mime: "video/mp4" });
    expect(audioFormat("clip.MOV", "video/quicktime", { video: true })).toEqual({ ext: "mov", mime: "video/quicktime" });
    expect(audioFormat("reel.mp4", "video/mp4")).toBeNull();
    expect(audioFormat("reel.mp4", "image/png", { video: true })).toBeNull();
    expect(audioFormat("x.constructor", "", { video: true })).toBeNull();
  });
});
