/**
 * Pinterest's official API (server/pinterest.ts) and its use by "Edit like this video"
 * (server/video-reference.ts), with every request answered by a fake: nothing reaches Pinterest.
 * Pin ids from every link form (pin.it read from its redirect only), the v5 pin call with its
 * Bearer token, the token renewed with the refresh token (Basic auth of app id:secret) when it is
 * due or refused, the first video of a video or multi-item pin, plain refusals (not found or
 * private, a picture, a withheld video, expired), the connection kept encrypted, its status and
 * test, the sign-in, members refused with 403, and the old page reading kept when not connected.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { adminRoutes } from "../server/admin";
import { getSetting, setSetting, PINTEREST_SETTING } from "../server/settings";
import {
  EXPIRED_MESSAGE,
  NOT_CONNECTED_HINT,
  PICTURE_PIN_MESSAGE,
  PIN_NOT_FOUND_MESSAGE,
  VIDEO_WITHHELD_MESSAGE,
  parsePinLink,
  pinMediaVideo,
  readPinterest,
  resolveShortLink,
  type PinterestConnection,
} from "../server/pinterest";
import { fetchPinterestVideoViaApi } from "../server/video-reference";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const MP4 = () => SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer;
const mp4Response = () => new Response(MP4(), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(SAMPLE.byteLength) } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PIN_ID = "123456789012";
const PIN = `https://www.pinterest.com/pin/${PIN_ID}/`;
const V720 = "https://v1.pinimg.com/videos/mc/720p/ab/cd/ef/abcdef0123.mp4";
const API = "https://api.pinterest.com/v5";
const TOKEN = "pina_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEW_TOKEN = "pina_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const REFRESH = "pinr_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const NEW_REFRESH = "pinr_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const APP_ID = "1234567";
const APP_SECRET = "s3cr3t-app-secret";
const VIDEO_PIN = { id: PIN_ID, media: { media_type: "video", video_url: V720, cover_image_url: "https://i.pinimg.com/c.jpg", duration: 9000, width: 720, height: 1280 } };

type Call = { url: string; method: string; headers: Headers; body: string; redirect?: RequestInit["redirect"] };
type Route = (call: Call) => Response | Promise<Response>;
let calls: Call[] = [];
function mockFetch(route: Route) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "", redirect: init?.redirect };
      calls.push(call);
      return route(call);
    }),
  );
}
const hosts = () => calls.map((c) => new URL(c.url).hostname);

/** Pinterest as the fake answers it: the token endpoint, the account, one video pin, its video. */
function pinterestApi(opts: { pin?: unknown; pinStatus?: number; validTokens?: string[] } = {}): Route {
  const valid = opts.validTokens ?? [TOKEN, NEW_TOKEN];
  return (c) => {
    if (c.url === `${API}/oauth/token` && c.method === "POST") {
      if (c.headers.get("authorization") !== `Basic ${btoa(`${APP_ID}:${APP_SECRET}`)}`) return json({ code: 2, message: "Authentication failed." }, 401);
      return json({ access_token: NEW_TOKEN, token_type: "bearer", expires_in: 2592000, refresh_token: NEW_REFRESH, refresh_token_expires_in: 5184000, scope: "boards:read,pins:read,user_accounts:read" });
    }
    if (c.url.startsWith(`${API}/`)) {
      const bearer = c.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!valid.includes(bearer)) return json({ code: 2, message: "Authentication failed." }, 401);
      if (c.url === `${API}/user_account`) return json({ username: "levelmena", business_name: "Level MENA", account_type: "BUSINESS" });
      if (c.url === `${API}/pins/${PIN_ID}`) return opts.pinStatus ? json({ code: 50, message: "Pin not found." }, opts.pinStatus) : json(opts.pin ?? VIDEO_PIN);
      return json({ code: 50, message: "Pin not found." }, 404);
    }
    if (c.url === V720) return mp4Response();
    return new Response("not here", { status: 404 });
  };
}

async function connect(env: FakeEnv, c: Partial<PinterestConnection>) {
  const full: PinterestConnection = { accessToken: TOKEN, expires: Date.now() + 20 * 24 * 3600 * 1000, refreshToken: null, refreshExpires: null, appId: null, appSecret: null, account: null, scope: null, saved: Date.now(), refreshed: null, rejected: null, ...c };
  await setSetting(env, PINTEREST_SETTING, JSON.stringify(full));
}

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
const send = (user: User, env: FakeEnv, method: string, path: string, body?: unknown) =>
  app(user).request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env);

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Mona', 'x', 'member', ?)").bind(t).run();
  return env;
}

afterEach(() => vi.unstubAllGlobals());

describe("pin links", () => {
  it("reads the pin id from every pinterest.com form, regional sites included", () => {
    const id = (u: string) => {
      const p = parsePinLink(u);
      return "pinId" in p ? p.pinId : null;
    };
    expect(id(PIN)).toBe(PIN_ID);
    expect(id(`https://pinterest.com/pin/${PIN_ID}`)).toBe(PIN_ID);
    expect(id(`https://in.pinterest.com/pin/${PIN_ID}/`)).toBe(PIN_ID);
    expect(id(`https://uk.pinterest.co.uk/pin/some-title--998877665544/`)).toBe("998877665544");
    expect(id(`https://www.pinterest.com.au/pin/${PIN_ID}/?utm_source=share`)).toBe(PIN_ID);
    expect(id(`https://www.pinterest.de/pin/${PIN_ID}/sent/?invite_code=abc&sender=1`)).toBe(PIN_ID);
    expect(id(`https://br.pinterest.com/pin/${PIN_ID}/#comments`)).toBe(PIN_ID);
    expect(parsePinLink("https://pin.it/3xYzAbC")).toEqual({ short: "https://pin.it/3xYzAbC" });
  });

  it("refuses links that are not pins, plainly", () => {
    expect(() => parsePinLink("not a link")).toThrow("That is not a link.");
    expect(() => parsePinLink(`https://example.com/pin/${PIN_ID}/`)).toThrow(/Pinterest pin link/);
    expect(() => parsePinLink(`https://pinterest.com.evil.example/pin/${PIN_ID}/`)).toThrow(/Pinterest pin link/);
    expect(() => parsePinLink("https://www.pinterest.com/levelmena/moodboard/")).toThrow(/not a pin/);
    expect(() => parsePinLink("https://pin.it/")).toThrow(/not complete/);
  });

  it("resolves a pin.it link from its redirects, asking pin.it (and Pinterest's shortener) only, never the pin page", async () => {
    mockFetch((c) => {
      if (c.url === "https://pin.it/3xYzAbC") return new Response(null, { status: 301, headers: { location: "https://api.pinterest.com/url_shortener/3xYzAbC/redirect/" } });
      if (c.url === "https://api.pinterest.com/url_shortener/3xYzAbC/redirect/") return new Response(null, { status: 302, headers: { location: `https://www.pinterest.com/pin/${PIN_ID}/sent/?invite_code=x` } });
      return new Response("should not be asked", { status: 500 });
    });
    expect(await resolveShortLink("https://pin.it/3xYzAbC")).toBe(PIN_ID);
    expect(calls.map((c) => c.url)).toEqual(["https://pin.it/3xYzAbC", "https://api.pinterest.com/url_shortener/3xYzAbC/redirect/"]);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("stops at a pin.it redirect that leaves Pinterest", async () => {
    mockFetch((c) => (c.url.startsWith("https://pin.it/") ? new Response(null, { status: 302, headers: { location: "https://evil.example/pin/123456789012/" } }) : new Response("no", { status: 500 })));
    await expect(resolveShortLink("https://pin.it/3xYzAbC")).rejects.toThrow("The pin.it link did not lead to a pin.");
    expect(hosts()).toEqual(["pin.it"]);
  });
});

describe("a pin's media (v5 schema)", () => {
  it("takes a video pin's video_url", () => {
    expect(pinMediaVideo(VIDEO_PIN)).toEqual({ kind: "video", url: V720 });
  });

  it("takes the first video item of a multi-item pin, skipping pictures", () => {
    const mixed = { media: { media_type: "multiple_mixed", items: [{ item_type: "image", images: {} }, { item_type: "video", video_url: V720 }, { item_type: "video", video_url: "https://v1.pinimg.com/videos/mc/720p/second.mp4" }] } };
    expect(pinMediaVideo(mixed)).toEqual({ kind: "video", url: V720 });
    const videos = { media: { media_type: "multiple_videos", items: [{ item_type: "video", video_url: null }, { item_type: "video", video_url: V720 }] } };
    expect(pinMediaVideo(videos)).toEqual({ kind: "video", url: V720 });
  });

  it("tells a picture from a video whose link Pinterest withheld", () => {
    expect(pinMediaVideo({ media: { media_type: "image", images: {} } })).toEqual({ kind: "picture" });
    expect(pinMediaVideo({ media: { media_type: "multiple_images", items: [{ item_type: "image" }] } })).toEqual({ kind: "picture" });
    expect(pinMediaVideo({ media: { media_type: "multiple_mixed", items: [{ item_type: "image" }] } })).toEqual({ kind: "picture" });
    expect(pinMediaVideo({ id: PIN_ID })).toEqual({ kind: "picture" });
    expect(pinMediaVideo({ media: { media_type: "video", video_url: null } })).toEqual({ kind: "withheld" });
    expect(pinMediaVideo({ media: { media_type: "multiple_mixed", items: [{ item_type: "video" }] } })).toEqual({ kind: "withheld" });
  });
});

describe("the pin through the API", () => {
  let env: FakeEnv;
  beforeEach(async () => {
    env = await seed();
  });

  it("asks GET /v5/pins/{id} with the Bearer token, then downloads the video from Pinterest's video host", async () => {
    await connect(env, {});
    mockFetch(pinterestApi());
    const v = await fetchPinterestVideoViaApi(env, PIN);
    expect(v).toMatchObject({ pinId: PIN_ID, videoUrl: V720 });
    expect(v.bytes.byteLength).toBe(SAMPLE.byteLength);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/pins/${PIN_ID}`, `GET ${V720}`]);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    // The token never travels to the video host.
    expect(calls[1].headers.get("authorization")).toBeNull();
  });

  it("renews an expired access token with the refresh token (Basic auth of app id:secret) and keeps both new tokens", async () => {
    await connect(env, { expires: Date.now() - 1000, refreshToken: REFRESH, appId: APP_ID, appSecret: APP_SECRET });
    mockFetch(pinterestApi({ validTokens: [NEW_TOKEN] }));
    await fetchPinterestVideoViaApi(env, PIN);
    const refresh = calls[0];
    expect(`${refresh.method} ${refresh.url}`).toBe(`POST ${API}/oauth/token`);
    expect(refresh.headers.get("authorization")).toBe(`Basic ${btoa(`${APP_ID}:${APP_SECRET}`)}`);
    expect(refresh.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH });
    expect(calls[1].headers.get("authorization")).toBe(`Bearer ${NEW_TOKEN}`);
    const kept = (await readPinterest(env))!;
    expect(kept).toMatchObject({ accessToken: NEW_TOKEN, refreshToken: NEW_REFRESH, rejected: null });
    expect(kept.expires! - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(kept.refreshExpires! - Date.now()).toBeGreaterThan(59 * 24 * 3600 * 1000);
  });

  it("renews a token that is close to expiry before using it", async () => {
    await connect(env, { expires: Date.now() + 3600 * 1000, refreshToken: REFRESH, appId: APP_ID, appSecret: APP_SECRET });
    mockFetch(pinterestApi());
    await fetchPinterestVideoViaApi(env, PIN);
    expect(calls[0].url).toBe(`${API}/oauth/token`);
  });

  it("renews once when Pinterest answers 401 to a token of unknown age", async () => {
    await connect(env, { expires: null, refreshToken: REFRESH, appId: APP_ID, appSecret: APP_SECRET });
    mockFetch(pinterestApi({ validTokens: [NEW_TOKEN] }));
    await fetchPinterestVideoViaApi(env, PIN);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`GET /v5/pins/${PIN_ID}`, "POST /v5/oauth/token", `GET /v5/pins/${PIN_ID}`, "GET /videos/mc/720p/ab/cd/ef/abcdef0123.mp4"]);
  });

  it("says the connection expired when the token ran out and cannot be renewed, without asking Pinterest", async () => {
    await connect(env, { expires: Date.now() - 1000 });
    mockFetch(pinterestApi());
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(EXPIRED_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("marks the connection expired when Pinterest refuses the token for good", async () => {
    await connect(env, { expires: null });
    mockFetch(pinterestApi({ validTokens: [] }));
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(EXPIRED_MESSAGE);
    expect((await readPinterest(env))!.rejected).toBeGreaterThan(0);
    const s = (await (await send(ADMIN, env, "GET", "/api/studio/pinterest/status")).json()) as { state: string };
    expect(s.state).toBe("expired");
  });

  it("tells a pin that is not found or private from a picture pin and from a withheld video", async () => {
    await connect(env, {});
    mockFetch(pinterestApi({ pinStatus: 404 }));
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(PIN_NOT_FOUND_MESSAGE);
    mockFetch(pinterestApi({ pinStatus: 403 }));
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(PIN_NOT_FOUND_MESSAGE);
    mockFetch(pinterestApi({ pin: { id: PIN_ID, media: { media_type: "image", images: { "600x": { url: "https://i.pinimg.com/600x/a.jpg" } } } } }));
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(PICTURE_PIN_MESSAGE);
    mockFetch(pinterestApi({ pin: { id: PIN_ID, media: { media_type: "video", video_url: null } } }));
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(VIDEO_WITHHELD_MESSAGE);
    expect(PIN_NOT_FOUND_MESSAGE).toMatch(/^Pin not found or private/);
    expect(PICTURE_PIN_MESSAGE).toMatch(/picture, not a video/);
  });

  it("never downloads a video link outside Pinterest's video host", async () => {
    await connect(env, {});
    mockFetch(pinterestApi({ pin: { id: PIN_ID, media: { media_type: "video", video_url: "https://evil.example/videos/a.mp4" } } }));
    await expect(fetchPinterestVideoViaApi(env, PIN)).rejects.toThrow(/outside its video host/);
    expect(hosts()).toEqual(["api.pinterest.com"]);
  });
});

describe("Connection → Pinterest", () => {
  let env: FakeEnv;
  beforeEach(async () => {
    env = await seed();
  });

  it("refuses members with 403 on every change, the test and the sign-in, and reaches nothing", async () => {
    mockFetch(pinterestApi());
    for (const [method, path, body] of [
      ["PUT", "/api/studio/pinterest", { accessToken: TOKEN }],
      ["POST", "/api/studio/pinterest/test", {}],
      ["DELETE", "/api/studio/pinterest", undefined],
      ["POST", "/api/studio/pinterest/signin/start", {}],
    ] as const) {
      const r = await send(MEMBER, env, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(calls).toEqual([]);
    expect(await getSetting(env, PINTEREST_SETTING)).toBeNull();
    // A member sees whether it is connected, nothing more.
    await connect(env, { refreshToken: REFRESH, appId: APP_ID, appSecret: APP_SECRET, account: { username: "levelmena", name: "Level MENA" } });
    const s = (await (await send(MEMBER, env, "GET", "/api/studio/pinterest/status")).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ state: "connected", admin: false });
    expect(s).not.toHaveProperty("account");
    expect(s).not.toHaveProperty("appId");
  });

  it("checks a pasted access token with GET /v5/user_account and keeps it encrypted; the status shows the account", async () => {
    mockFetch(pinterestApi());
    expect(((await (await send(ADMIN, env, "GET", "/api/studio/pinterest/status")).json()) as { state: string }).state).toBe("not_connected");
    const r = await send(ADMIN, env, "PUT", "/api/studio/pinterest", { accessToken: TOKEN });
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`${API}/user_account`]);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const raw = (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(PINTEREST_SETTING).first<{ value: string }>())!.value;
    expect(raw).not.toContain("pina_");
    const s = (await (await send(ADMIN, env, "GET", "/api/studio/pinterest/status")).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ state: "connected", account: { username: "levelmena", name: "Level MENA" }, hasToken: true, autoRenew: false });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    const ops = await env.DB.prepare("SELECT provider, kind, status FROM integration_ops").all();
    expect(ops.results).toEqual([{ provider: "pinterest", kind: "connect", status: "done" }]);
  });

  it("uses a pasted refresh token with the app id and secret at once, so the token renews itself", async () => {
    mockFetch(pinterestApi());
    const r = await send(ADMIN, env, "PUT", "/api/studio/pinterest", { appId: APP_ID, appSecret: APP_SECRET, refreshToken: REFRESH });
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`${API}/oauth/token`, `${API}/user_account`]);
    const s = (await r.json()) as Record<string, unknown>;
    expect(s).toMatchObject({ state: "connected", autoRenew: true, appId: APP_ID, hasAppSecret: true });
    expect(JSON.stringify(s)).not.toContain(APP_SECRET);
    expect((await readPinterest(env))!.accessToken).toBe(NEW_TOKEN);
  });

  it("keeps nothing when Pinterest refuses the pasted token, and asks for the app id and secret with a refresh token", async () => {
    mockFetch(pinterestApi({ validTokens: [] }));
    const r = await send(ADMIN, env, "PUT", "/api/studio/pinterest", { accessToken: TOKEN });
    expect(r.status).toBe(409);
    expect(await getSetting(env, PINTEREST_SETTING)).toBeNull();
    const r2 = await send(ADMIN, env, "PUT", "/api/studio/pinterest", { refreshToken: REFRESH });
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toMatch(/app id and app secret/);
  });

  it("tests the connection with GET /v5/user_account and names the account", async () => {
    await connect(env, {});
    mockFetch(pinterestApi());
    const r = await send(ADMIN, env, "POST", "/api/studio/pinterest/test", {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, account: { username: "levelmena", name: "Level MENA" }, message: "Connected to Pinterest as Level MENA (@levelmena)." });
    expect(calls.map((c) => c.url)).toEqual([`${API}/user_account`]);
  });

  it("signs in with Pinterest: the authorize link, then the code exchanged for both tokens", async () => {
    mockFetch(pinterestApi());
    expect((await send(ADMIN, env, "POST", "/api/studio/pinterest/signin/start", {})).status).toBe(409);
    await connect(env, { accessToken: "", expires: null, appId: APP_ID, appSecret: APP_SECRET });
    const start = (await (await send(ADMIN, env, "POST", "/api/studio/pinterest/signin/start", {})).json()) as { url: string };
    const u = new URL(start.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://www.pinterest.com/oauth/");
    expect(u.searchParams.get("client_id")).toBe(APP_ID);
    expect(u.searchParams.get("redirect_uri")).toBe("https://studio.test/api/studio/pinterest/callback");
    expect(u.searchParams.get("scope")).toBe("boards:read,pins:read,user_accounts:read");
    const state = u.searchParams.get("state")!;
    const wrong = await send(ADMIN, env, "GET", `/api/studio/pinterest/callback?code=abc&state=nope`);
    expect(wrong.headers.get("location")).toMatch(/^\/\?pinterest=error/);
    const cb = await send(ADMIN, env, "GET", `/api/studio/pinterest/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?pinterest=connected");
    const exchange = calls.find((c) => c.url === `${API}/oauth/token`)!;
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({ grant_type: "authorization_code", code: "abc", redirect_uri: "https://studio.test/api/studio/pinterest/callback" });
    expect(await readPinterest(env)).toMatchObject({ accessToken: NEW_TOKEN, refreshToken: NEW_REFRESH, account: { username: "levelmena" } });
  });

  it("disconnects", async () => {
    await connect(env, {});
    expect((await send(ADMIN, env, "DELETE", "/api/studio/pinterest")).status).toBe(200);
    expect(await getSetting(env, PINTEREST_SETTING)).toBeNull();
  });
});

describe("Edit like this video with Pinterest", () => {
  let env: FakeEnv;
  beforeEach(async () => {
    env = await seed();
  });
  const reference = (user: User, url = PIN) => send(user, env, "POST", "/api/studio/posts/video/editor/reference", { from: "pinterest", url });

  it("goes through the API when Pinterest is connected, and says so in the ledger", async () => {
    await connect(env, {});
    mockFetch(pinterestApi());
    const r = await reference(ADMIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: `Pinterest pin ${PIN_ID}`, sourceId: PIN_ID, size: SAMPLE.byteLength });
    expect(hosts()).toEqual(["api.pinterest.com", "v1.pinimg.com"]);
    const op = await env.DB.prepare("SELECT kind, note FROM integration_ops WHERE provider = 'editor'").first<{ kind: string; note: string }>();
    expect(op).toMatchObject({ kind: "editor.reference" });
    expect(op!.note).toMatch(/through the Pinterest API/);
  });

  it("answers a picture pin plainly and stores nothing", async () => {
    await connect(env, {});
    mockFetch(pinterestApi({ pin: { id: PIN_ID, media: { media_type: "image" } } }));
    const r = await reference(ADMIN);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toBe(PICTURE_PIN_MESSAGE);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("refuses a member with 403 before anything is asked", async () => {
    await connect(env, {});
    mockFetch(pinterestApi());
    expect((await reference(MEMBER)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("keeps the old page reading when Pinterest is not connected, with the hint to connect it", async () => {
    mockFetch(() => new Response("Forbidden", { status: 403 }));
    const r = await reference(ADMIN);
    expect(r.status).toBe(502);
    const d = (await r.json()) as { error: string; pinterest: string };
    expect(d.error).toMatch(/Connect Pinterest in Connection for reliable links\.$/);
    expect(d.pinterest).toBe("not_connected");
    expect(NOT_CONNECTED_HINT).toBe("Connect Pinterest in Connection for reliable links.");
    expect(hosts()).not.toContain("api.pinterest.com");
    expect(hosts()).toContain("widgets.pinterest.com");
  });

  it("refuses pin links while Pinterest is switched off, and asks nothing", async () => {
    await connect(env, {});
    mockFetch(pinterestApi());
    expect((await send(ADMIN, env, "POST", "/api/admin/integrations/switch", { provider: "pinterest", enabled: false })).status).toBe(200);
    expect((await reference(ADMIN)).status).toBe(503);
    expect(calls).toEqual([]);
  });
});
