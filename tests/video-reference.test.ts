/**
 * "Edit like this video": the server's copy of a reference video (server/video-reference.ts), with
 * Pinterest mocked. The pin's id from its links, its MP4 renditions found in Pinterest's JSON and
 * page (escaped or not, 720p first, the HLS playlist and other hosts ignored), the bytes taken from
 * Pinterest's video host only, as an MP4 within 60 MB; a refusal said plainly with the
 * alternatives; admins only behind the editor switch, a ledger row at estimate 0; the copy kept
 * in R2 under editor-refs/ with an expiry, served with Range, 410 once expired. No real network:
 * every request goes to the fake, and the test checks which hosts were asked.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { postConfig } from "../shared/config";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { adminRoutes } from "../server/admin";
import { BLOCKED_MESSAGE, fetchPinterestVideo, isPinVideoUrl, NO_VIDEO_MESSAGE, pinIdOf, pinVideoUrls, readVideoBody, REFERENCE_PREFIX, REFERENCE_TTL_MS, sweepReferences } from "../server/video-reference";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const MP4 = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const V720 = "https://v1.pinimg.com/videos/mc/720p/ab/cd/ef/abcdef0123.mp4";
const V540 = "https://v1.pinimg.com/videos/mc/540p/ab/cd/ef/abcdef0123.mp4";
const HLS = "https://v1.pinimg.com/videos/mc/hls/ab/cd/ef/abcdef0123.m3u8";
/** Pinterest's pin endpoint as it answers for a video pin (shape kept, values made up), with its slashes escaped. */
const PIN_INFO = JSON.stringify({ status: "success", data: [{ id: "123456789012", videos: { video_list: { V_HLSV4: { url: HLS }, V_720P: { url: V720, width: 720, height: 1280 }, V_540P: { url: V540 } } } }] }).replace(/\//g, "\\/");

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
let reached: string[] = [];
function mockFetch(route: Route) {
  reached = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      reached.push(url);
      return route(url, init);
    }),
  );
}
const mp4Response = (bytes = MP4(), headers: Record<string, string> = {}) => new Response(bytes, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength), ...headers } });

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
const post = (user: User, env: FakeEnv, body: unknown) => app(user).request("/api/studio/posts/video/editor/reference", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
const PIN = "https://www.pinterest.com/pin/123456789012/";
const pinterest: Route = (url) => {
  if (url.startsWith("https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=123456789012")) return new Response(PIN_INFO, { status: 200, headers: { "content-type": "application/json" } });
  if (url === V720) return mp4Response();
  return new Response("not here", { status: 404 });
};

afterEach(() => vi.unstubAllGlobals());

describe("reading a pin", () => {
  it("finds the pin's id in its links", () => {
    expect(pinIdOf("https://www.pinterest.com/pin/123456789012/")).toBe("123456789012");
    expect(pinIdOf("https://uk.pinterest.co.uk/pin/some-title--998877665544/")).toBe("998877665544");
    expect(pinIdOf("https://pin.it/3xYz")).toBeNull();
  });

  it("finds the MP4 renditions in escaped JSON and in HTML, 720p first, never the playlist or another host", () => {
    expect(pinVideoUrls(PIN_INFO)).toEqual([V720, V540]);
    const html = `<script>{"url":"${V540}"}</script><video src="https://evil.example/videos/x.mp4"></video><a href="https://v1.pinimg.com.evil.example/videos/a.mp4">`;
    expect(pinVideoUrls(html)).toEqual([V540]);
    expect(isPinVideoUrl(V720)).toBe(true);
    expect(isPinVideoUrl("http://v1.pinimg.com/videos/a.mp4")).toBe(false);
    expect(isPinVideoUrl("https://i.pinimg.com/originals/a.mp4")).toBe(false);
    expect(isPinVideoUrl(HLS)).toBe(false);
  });

  it("checks the bytes: an MP4 within the limit, by its ftyp box, whatever the headers say", async () => {
    expect(await readVideoBody(mp4Response())).toBeInstanceOf(ArrayBuffer);
    expect(await readVideoBody(new Response("<html>", { headers: { "content-type": "text/html" } }))).toMatch(/not an MP4/);
    expect(await readVideoBody(new Response(new Uint8Array(64), { headers: { "content-type": "video/mp4" } }))).toBe("the file is not an MP4");
    expect(await readVideoBody(mp4Response(MP4(), { "content-length": String(200 * 1024 * 1024) }))).toMatch(/200 MB/);
    expect(await readVideoBody(new Response(MP4(), { headers: { "content-type": "video/mp4" } }), 1000)).toMatch(/larger than/);
    expect(await readVideoBody(new Response("no", { status: 403 }))).toBe("answered 403");
  });

  it("downloads the 720p rendition from Pinterest's video host", async () => {
    mockFetch(pinterest);
    const v = await fetchPinterestVideo(PIN);
    expect(v).toMatchObject({ pinId: "123456789012", videoUrl: V720 });
    expect(v.bytes.byteLength).toBe(SAMPLE.byteLength);
    expect(reached.map((u) => new URL(u).hostname)).toEqual(["widgets.pinterest.com", "v1.pinimg.com"]);
  });

  it("follows a pin.it short link and falls back to the pin page", async () => {
    mockFetch((url) => {
      if (url === "https://pin.it/3xYz") {
        const r = new Response(`<html>no video here</html>`, { status: 200, headers: { "content-type": "text/html" } });
        Object.defineProperty(r, "url", { value: PIN });
        return r;
      }
      if (url.includes("pidgets")) return new Response("{}", { status: 200 });
      if (url === PIN) return new Response(`<script>"V_720P":{"url":"${V720}"}</script>`, { status: 200 });
      if (url === V720) return mp4Response();
      return new Response("", { status: 404 });
    });
    const v = await fetchPinterestVideo("https://pin.it/3xYz");
    expect(v.pinId).toBe("123456789012");
    expect(reached).toContain(PIN);
  });

  it("says plainly when Pinterest refuses, or when the pin has no video, and names the alternatives", async () => {
    mockFetch((url) => (url.includes("pidgets") ? new Response(PIN_INFO, { status: 200 }) : new Response("Forbidden", { status: 403 })));
    await expect(fetchPinterestVideo(PIN)).rejects.toThrow(BLOCKED_MESSAGE);
    mockFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(fetchPinterestVideo(PIN)).rejects.toThrow(BLOCKED_MESSAGE);
    mockFetch((url) => (url.includes("pidgets") ? new Response(`{"data":[{"images":{}}]}`, { status: 200 }) : new Response("<html>a picture pin</html>", { status: 200 })));
    await expect(fetchPinterestVideo(PIN)).rejects.toThrow(NO_VIDEO_MESSAGE);
    expect(BLOCKED_MESSAGE).toMatch(/Upload/);
    expect(BLOCKED_MESSAGE).toMatch(/Drive/);
    await expect(fetchPinterestVideo("https://example.com/pin/123456789012/")).rejects.toThrow(/Pinterest pin link/);
  });
});

describe("the routes", () => {
  let env: FakeEnv;
  beforeEach(async () => {
    env = await seed();
  });

  it("copies the pin's video for a member too (24 Oct: the team), under their name", async () => {
    mockFetch(pinterest);
    const r = await post(MEMBER, env, { from: "pinterest", url: PIN, batch: "b1" });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: string };
    expect(env.BUCKET.objects.get(`${REFERENCE_PREFIX}${d.id}.mp4`)!.customMetadata).toMatchObject({ owner: "u2" });
  });

  it("copies the pin's video for an admin, with an expiry and a ledger row at no cost, and serves it with Range", async () => {
    mockFetch(pinterest);
    const r = await post(ADMIN, env, { from: "pinterest", url: PIN, batch: "b1" });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: string; url: string; expires: number; size: number; name: string };
    expect(d).toMatchObject({ name: "Pinterest pin 123456789012", size: SAMPLE.byteLength });
    const key = `${REFERENCE_PREFIX}${d.id}.mp4`;
    const stored = env.BUCKET.objects.get(key)!;
    expect(stored.customMetadata).toMatchObject({ owner: "u1", batch: "b1", from: "pinterest", source: "123456789012" });
    expect(Number(stored.customMetadata!.expires) - Date.now()).toBeGreaterThan(REFERENCE_TTL_MS - 60_000);
    const ops = await env.DB.prepare("SELECT provider, kind, estimate, status FROM integration_ops").all();
    expect(ops.results).toEqual([{ provider: "editor", kind: "editor.reference", estimate: 0, status: "done" }]);
    // The member who owns the month may play it (read-only); a Range asks for a slice.
    const part = await app(MEMBER).request(d.url, { headers: { range: "bytes=0-99" } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${SAMPLE.byteLength}`);
    // Expired: 410 and deleted.
    stored.customMetadata!.expires = String(Date.now() - 1);
    expect((await app(ADMIN).request(d.url, {}, env)).status).toBe(410);
    expect(env.BUCKET.objects.has(key)).toBe(false);
  });

  it("answers Pinterest's refusal with the plain message (502) and stores nothing", async () => {
    mockFetch(() => new Response("Forbidden", { status: 403 }));
    const r = await post(ADMIN, env, { from: "pinterest", url: PIN });
    expect(r.status).toBe(502);
    // Pinterest is not connected here: the old page reading ran, and the hint to connect it follows.
    expect(((await r.json()) as { error: string }).error).toBe(`${BLOCKED_MESSAGE} Connect Pinterest in Connection for reliable links.`);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("refuses a Drive file outside the client's folders", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('drive_demo', '1')").run().catch(() => undefined);
    const r = await post(ADMIN, env, { from: "drive", client: "c1", fileId: "notInFolder01" });
    expect([404, 409, 502]).toContain(r.status);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("is closed when the editor is switched off", async () => {
    mockFetch(pinterest);
    expect((await app(ADMIN).request("/api/admin/integrations/switch", { method: "POST", body: JSON.stringify({ provider: "editor", enabled: false }), headers: { "content-type": "application/json" } }, env)).status).toBe(200);
    expect((await post(ADMIN, env, { from: "pinterest", url: PIN })).status).toBe(503);
    expect(reached).toEqual([]);
  });

  it("sweeps expired copies", async () => {
    await env.BUCKET.put(`${REFERENCE_PREFIX}old.mp4`, MP4(), { customMetadata: { expires: "1" } });
    await env.BUCKET.put(`${REFERENCE_PREFIX}new.mp4`, MP4(), { customMetadata: { expires: String(Date.now() + 1000) } });
    expect(await sweepReferences(env.BUCKET as unknown as R2Bucket)).toBe(1);
    expect([...env.BUCKET.objects.keys()]).toEqual([`${REFERENCE_PREFIX}new.mp4`]);
  });
});
