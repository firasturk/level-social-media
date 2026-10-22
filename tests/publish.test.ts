import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import { setSetting } from "../server/settings";
import { StudioError } from "../server/errors";
import { clearPermissionCache, GRAPH, POLL, publishDue, publishRoutes, publishStatus, RECONNECT_HELP } from "../server/publish";
import { buildCaption, defaultPublishAt, publicationFor, slidesOf, type Publication } from "../shared/publish";

/**
 * Publishing to Instagram against a fake Graph API: the status when the permission is missing, a
 * single picture (container, poll, publish, permalink), a carousel (children, parent, publish), a
 * Graph error kept on the row as failed, the cron claiming and publishing due rows exactly once, and
 * cancel and retry. Any call to a host other than graph.facebook.com fails the test.
 */

type FakeEnv = ReturnType<typeof fakeEnv>;
type Call = { path: string; method: string; params: Record<string, string> };

interface GraphFake {
  calls: Call[];
  /** Answers by path (without the version and the query); a function may answer by call. */
  answer: Record<string, unknown | ((call: Call) => unknown)>;
  permissions: string[];
  pollsUntilFinished: number;
}

/** A Graph API that answers like Meta's content publishing, recording every call. */
function fakeGraph(overrides: Partial<GraphFake> = {}): GraphFake {
  const g: GraphFake = { calls: [], answer: {}, permissions: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"], pollsUntilFinished: 1, ...overrides };
  const polls = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(GRAPH + "/")) throw new Error(`A network call was made without the test asking for it: ${url}`);
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v23\.0\//, "");
      const params: Record<string, string> = {};
      u.searchParams.forEach((v, k) => (params[k] = v));
      if (init?.body instanceof URLSearchParams) init.body.forEach((v, k) => (params[k] = v));
      const call: Call = { path, method: init?.method ?? "GET", params };
      g.calls.push(call);
      expect(params.access_token).toBe("EAAG-test-token-" + "x".repeat(30));
      const body = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      const custom = g.answer[path];
      if (custom !== undefined) {
        const d = typeof custom === "function" ? (custom as (c: Call) => unknown)(call) : custom;
        const err = (d as { error?: unknown }).error;
        return body(d, err ? 400 : 200);
      }
      if (path === "me/permissions") return body({ data: g.permissions.map((p) => ({ permission: p, status: "granted" })) });
      if (/^\d+\/media$/.test(path)) return body({ id: `c${g.calls.filter((c) => /\/media$/.test(c.path)).length}` });
      if (/^\d+\/media_publish$/.test(path)) return body({ id: `m${g.calls.filter((c) => /media_publish$/.test(c.path)).length}` });
      if (/^c\d+$/.test(path) && params.fields === "status_code,status") {
        const n = (polls.get(path) ?? 0) + 1;
        polls.set(path, n);
        return body({ status_code: n >= g.pollsUntilFinished ? "FINISHED" : "IN_PROGRESS", id: path });
      }
      if (/^m\d+$/.test(path) && params.fields === "permalink") return body({ permalink: `https://www.instagram.com/p/${path}/`, id: path });
      return body({ error: { message: `Unexpected call ${path}` } }, 400);
    }),
  );
  return g;
}

const TOKEN = "EAAG-test-token-" + "x".repeat(30);
const JSON_HEADERS = { "content-type": "application/json" };
const JPEG = "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4));
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

function app(role: User["role"] = "member") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role } as User);
    await next();
  });
  a.route("/api/studio/publish", publishRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed(opts: { token?: boolean; accounts?: boolean } = {}) {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?), ('u2', 'o@test', 'O', 'x', ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    plan: [
      { index: 1, type: "product", title: "Pistachio", brief: "Kunafa on marble.", caption: "Fresh every morning.", hashtags: "#kunafa #amman", headline: "Fresh", date: "2026-10-12" },
      { index: 2, type: "tip", title: "Ingredients 1", brief: "Cheese.", caption: "What goes in.", hashtags: "#kunafa", group: { id: "g1", kind: "carousel", slide: 1, of: 2 }, date: "2026-10-15" },
      { index: 3, type: "tip", title: "Ingredients 2", brief: "Syrup.", caption: "", hashtags: "", group: { id: "g1", kind: "carousel", slide: 2, of: 2 }, date: "2026-10-15" },
    ] as never,
    approvals: { "1": { status: "approved", at: t }, "2": { status: "approved", at: t } },
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b2', 'u2', 'Someone else', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  if (opts.token !== false) await setSetting(env, "meta_token", TOKEN);
  if (opts.accounts !== false)
    await setSetting(env, "meta_accounts", JSON.stringify([{ igId: "17841400000001", username: "levelmena", page: "Level" }, { igId: "17841400000002", username: "habibah", page: "Habibah" }]));
  await setSetting(env, "meta_account", JSON.stringify({ igId: "17841400000001", username: "levelmena", page: "Level" }));
  return env;
}

beforeEach(() => {
  clearPermissionCache();
  // No real waiting between two looks at a container.
  POLL.sleep = async () => {};
});
afterEach(() => vi.unstubAllGlobals());

describe("the caption and the default time", () => {
  it("joins the caption and the hashtags with a blank line, and leaves empty parts out", () => {
    expect(buildCaption("Fresh every morning.", "#kunafa #amman")).toBe("Fresh every morning.\n\n#kunafa #amman");
    expect(buildCaption("  Fresh  ", "")).toBe("Fresh");
    expect(buildCaption(undefined, "#a")).toBe("#a");
  });

  it("defaults to the post's date at 10:00, or the next 10:00 when that is past", () => {
    const now = new Date(2026, 9, 1, 9, 0);
    expect(defaultPublishAt("2026-10-12", now).getTime()).toBe(new Date(2026, 9, 12, 10, 0).getTime());
    expect(defaultPublishAt("2026-09-12", now).getTime()).toBe(new Date(2026, 9, 1, 10, 0).getTime());
    expect(defaultPublishAt(undefined, new Date(2026, 9, 1, 11, 0)).getTime()).toBe(new Date(2026, 9, 2, 10, 0).getTime());
  });

  it("finds a carousel's slides in order and its publication from any slide", () => {
    const plan = [
      { index: 1, group: undefined },
      { index: 3, group: { id: "g", kind: "carousel", slide: 2, of: 2 } },
      { index: 2, group: { id: "g", kind: "carousel", slide: 1, of: 2 } },
    ] as never;
    expect(slidesOf(plan, 3).map((p) => p.index)).toEqual([2, 3]);
    expect(slidesOf(plan, 1).map((p) => p.index)).toEqual([1]);
    const row = { id: "p", post: 2, status: "queued", created: 1 } as Publication;
    expect(publicationFor([row], plan, 3)?.id).toBe("p");
    expect(publicationFor([row], plan, 1)).toBeNull();
  });
});

describe("publishing status", () => {
  it("says what to do when no token is saved", async () => {
    fakeGraph();
    const env = await seed({ token: false });
    const s = await publishStatus(env, "c1");
    expect(s.connected).toBe(false);
    expect(s.reason).toMatch(/^Not connected/);
    expect(s.accounts).toEqual([]);
  });

  it("is not connected when the token lacks instagram_content_publish, and says to reconnect", async () => {
    fakeGraph({ permissions: ["instagram_basic", "pages_show_list"] });
    const env = await seed();
    const r = await app().request("/api/studio/publish/status?client=c1", {}, env);
    const d = (await json(r)) as { connected: boolean; reason: string; accounts: unknown[]; chosen: string };
    expect(d.connected).toBe(false);
    expect(d.reason).toContain(RECONNECT_HELP);
    expect(d.reason).toContain("Reconnect Instagram in Connection with the publishing permission");
    expect(d.accounts).toHaveLength(2);
    expect(d.chosen).toBe("17841400000001");
  });

  it("is connected with the permission, and remembers the client's account", async () => {
    fakeGraph();
    const env = await seed();
    await env.DB.prepare("INSERT INTO client_publish (client, ig_account, updated) VALUES ('c1', '17841400000002', 1)").run();
    const d = (await json(await app().request("/api/studio/publish/status?client=c1", {}, env))) as { connected: boolean; reason: null; chosen: string };
    expect(d.connected).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.chosen).toBe("17841400000002");
  });

  it("publishing is refused with the reason when the permission is missing", async () => {
    fakeGraph({ permissions: ["instagram_basic"] });
    const env = await seed();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] }) }, env);
    expect(r.status).toBe(428);
    expect((await json(r)).error).toContain(RECONNECT_HELP);
    expect(env.BUCKET.objects.size).toBe(0);
  });
});

describe("publishing a single picture now", () => {
  it("stores the JPEG, makes the container, polls it, publishes and keeps the permalink", async () => {
    const g = fakeGraph({ pollsUntilFinished: 2 });
    const env = await seed();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] }) }, env);
    expect(r.status).toBe(200);
    const { publication: p } = (await json(r)) as { publication: Publication };
    expect(p.status).toBe("published");
    expect(p.kind).toBe("single");
    expect(p.post).toBe(1);
    expect(p.mediaId).toBe("m1");
    expect(p.permalink).toBe("https://www.instagram.com/p/m1/");
    expect(p.caption).toBe("Fresh every morning.\n\n#kunafa #amman");
    expect(p.slides).toBe(1);
    expect(p.publishedAt).toBeGreaterThan(0);
    // The artwork is in R2 as a JPEG and Instagram was given a signed studio URL to fetch it.
    const key = `publish/${p.id}-1.jpg`;
    expect(env.BUCKET.objects.get(key)?.httpMetadata?.contentType).toBe("image/jpeg");
    const steps = g.calls.filter((c) => c.path !== "me/permissions").map((c) => `${c.method} ${c.path}`);
    expect(steps).toEqual(["POST 17841400000002/media", "GET c1", "GET c1", "POST 17841400000002/media_publish", "GET m1"]);
    const container = g.calls.find((c) => c.path === "17841400000002/media")!;
    expect(container.params.caption).toBe("Fresh every morning.\n\n#kunafa #amman");
    expect(container.params.image_url).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=publish%2F.*-1\.jpg&e=\d+&s=[0-9a-f]+$/);
    expect(container.params.is_carousel_item).toBeUndefined();
    expect(g.calls.find((c) => c.path.endsWith("media_publish"))!.params.creation_id).toBe("c1");
    // The client's account is remembered.
    expect((await env.DB.prepare("SELECT ig_account FROM client_publish WHERE client = 'c1'").first<{ ig_account: string }>())?.ig_account).toBe("17841400000002");
    // The month lists it.
    const list = (await json(await app().request("/api/studio/publish?batch=b1", {}, env))) as { publications: Publication[] };
    expect(list.publications.map((x) => x.id)).toEqual([p.id]);
  });

  it("refuses a second publication of a post that is already out, and a PNG", async () => {
    fakeGraph();
    const env = await seed();
    const body = { batch: "b1", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] };
    expect((await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env)).status).toBe(200);
    const again = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, env);
    expect(again.status).toBe(409);
    expect((await json(again)).error).toContain("already published");
    const png = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...body, artwork: ["data:image/png;base64,AAAA"] }) }, env);
    expect(png.status).toBe(400);
    expect((await json(png)).error).toContain("JPEG");
  });

  it("another member's month is not reachable", async () => {
    fakeGraph();
    const env = await seed();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b2", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] }) }, env);
    expect(r.status).toBe(404);
  });
});

describe("a carousel", () => {
  it("makes one child container per slide, then the carousel container, then publishes once", async () => {
    const g = fakeGraph();
    const env = await seed();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 3, igAccount: "17841400000001", when: "now", artwork: [JPEG, JPEG] }) }, env);
    expect(r.status).toBe(200);
    const { publication: p } = (await json(r)) as { publication: Publication };
    expect(p.status).toBe("published");
    expect(p.kind).toBe("carousel");
    expect(p.post).toBe(2); // the first slide stands for the group, whichever slide was clicked
    expect(p.slides).toBe(2);
    expect(p.caption).toBe("What goes in.\n\n#kunafa");
    expect(env.BUCKET.objects.has(`publish/${p.id}-1.jpg`) && env.BUCKET.objects.has(`publish/${p.id}-2.jpg`)).toBe(true);
    const media = g.calls.filter((c) => c.path === "17841400000001/media");
    expect(media).toHaveLength(3);
    expect(media[0].params.is_carousel_item).toBe("true");
    expect(media[1].params.is_carousel_item).toBe("true");
    expect(media[0].params.caption).toBeUndefined();
    expect(media[2].params).toMatchObject({ media_type: "CAROUSEL", children: "c1,c2", caption: "What goes in.\n\n#kunafa" });
    expect(g.calls.filter((c) => c.path.endsWith("media_publish"))).toHaveLength(1);
    expect(g.calls.find((c) => c.path.endsWith("media_publish"))!.params.creation_id).toBe("c3");
  });

  it("wants one picture per slide", async () => {
    fakeGraph();
    const env = await seed();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 2, igAccount: "17841400000001", when: "now", artwork: [JPEG] }) }, env);
    expect(r.status).toBe(400);
    expect((await json(r)).error).toContain("2 slides");
  });
});

describe("when Meta refuses", () => {
  it("keeps the row as failed with Meta's message, and retry publishes it", async () => {
    const g = fakeGraph();
    let refuse = true;
    g.answer["17841400000002/media_publish"] = () => (refuse ? { error: { message: "The image aspect ratio is not supported.", code: 36003, error_user_msg: "Only photos with an aspect ratio between 4:5 and 1.91:1 can be published." } } : { id: "m9" });
    const env = await seed();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] }) }, env);
    expect(r.status).toBe(200);
    const { publication: p } = (await json(r)) as { publication: Publication };
    expect(p.status).toBe("failed");
    expect(p.error).toBe("Meta: Only photos with an aspect ratio between 4:5 and 1.91:1 can be published.");
    expect(p.mediaId).toBeNull();
    refuse = false;
    const retried = (await json(await app().request(`/api/studio/publish/${p.id}/retry`, { method: "POST" }, env))) as { publication: Publication };
    expect(retried.publication.status).toBe("published");
    expect(retried.publication.mediaId).toBe("m9");
    expect(retried.publication.error).toBeNull();
  });

  it("an expired token is said in plain words", async () => {
    const g = fakeGraph();
    g.answer["17841400000002/media"] = { error: { message: "Error validating access token: Session has expired", code: 190 } };
    const env = await seed();
    const { publication: p } = (await json(await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] }) }, env))) as { publication: Publication };
    expect(p.status).toBe("failed");
    expect(p.error).toBe("The Meta token no longer works. Paste a new one in Connection.");
  });
});

describe("scheduling and the cron", () => {
  it("a future time queues the post without touching Meta; cancel takes it back", async () => {
    const g = fakeGraph();
    const env = await seed();
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const r = await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 1, igAccount: "17841400000002", when, artwork: [JPEG] }) }, env);
    expect(r.status).toBe(200);
    const { publication: p } = (await json(r)) as { publication: Publication };
    expect(p.status).toBe("queued");
    expect(p.scheduledAt).toBe(Date.parse(when));
    expect(g.calls.map((c) => c.path)).toEqual(["me/permissions"]);
    const cancelled = (await json(await app().request(`/api/studio/publish/${p.id}/cancel`, { method: "POST" }, env))) as { publication: Publication };
    expect(cancelled.publication.status).toBe("cancelled");
    expect((await app().request(`/api/studio/publish/${p.id}/cancel`, { method: "POST" }, env)).status).toBe(409);
    // The cron leaves a cancelled row alone.
    expect(await publishDue(env, { sleep: async () => {} })).toBe(0);
  });

  it("publishes due rows once, at most three per pass, and leaves the future ones", async () => {
    const g = fakeGraph();
    const env = await seed();
    const t = Date.now();
    const insert = (id: string, post: number, at: number, status = "queued") =>
      env.DB.prepare("INSERT INTO publications (id, batch, client, post, ig_account, kind, status, scheduled_at, artwork_keys, caption, created, updated) VALUES (?, 'b1', 'c1', ?, '17841400000002', 'single', ?, ?, ?, 'Hi', ?, ?)")
        .bind(id, post, status, at, JSON.stringify([`publish/${id}-1.jpg`]), t, t)
        .run();
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) await env.BUCKET.put(`publish/${id}-1.jpg`, new Uint8Array([1]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
    await insert("p1", 1, t - 60_000);
    await insert("p2", 2, t - 30_000);
    await insert("p3", 3, t - 10_000);
    await insert("p4", 4, t - 5_000);
    await insert("p5", 5, t + 3_600_000);
    // Two passes at once read the same due rows: each row is claimed and published by exactly one
    // of them (the other's claim changes nothing), never twice.
    const [a, b] = await Promise.all([publishDue(env, { sleep: async () => {} }), publishDue(env, { sleep: async () => {} })]);
    expect(a + b).toBeGreaterThanOrEqual(3);
    expect(a + b).toBeLessThanOrEqual(4);
    expect(g.calls.filter((c) => c.path.endsWith("media_publish"))).toHaveLength(a + b);
    // The next pass takes what is left; then nothing is due until p5's hour.
    expect(await publishDue(env, { sleep: async () => {} })).toBe(4 - (a + b));
    expect(g.calls.filter((c) => c.path.endsWith("media_publish"))).toHaveLength(4);
    const rows = await env.DB.prepare("SELECT id, status FROM publications ORDER BY id").all<{ id: string; status: string }>();
    expect(rows.results).toEqual([
      { id: "p1", status: "published" },
      { id: "p2", status: "published" },
      { id: "p3", status: "published" },
      { id: "p4", status: "published" },
      { id: "p5", status: "queued" },
    ]);
    expect(await publishDue(env, { sleep: async () => {} })).toBe(0);
  });

  it("one pass takes at most three rows", async () => {
    fakeGraph();
    const env = await seed();
    const t = Date.now();
    for (let i = 1; i <= 4; i++) {
      await env.BUCKET.put(`publish/q${i}-1.jpg`, new Uint8Array([1]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
      await env.DB.prepare("INSERT INTO publications (id, batch, client, post, ig_account, kind, status, scheduled_at, artwork_keys, caption, created, updated) VALUES (?, 'b1', 'c1', ?, '17841400000002', 'single', 'queued', ?, ?, 'Hi', ?, ?)")
        .bind(`q${i}`, i, t - i, JSON.stringify([`publish/q${i}-1.jpg`]), t, t)
        .run();
    }
    expect(await publishDue(env, { sleep: async () => {} })).toBe(3);
    expect(await publishDue(env, { sleep: async () => {} })).toBe(1);
  });

  it("a row stuck in 'publishing' for too long is failed so it can be retried", async () => {
    fakeGraph();
    const env = await seed();
    const old = Date.now() - 20 * 60_000;
    await env.DB.prepare("INSERT INTO publications (id, batch, client, post, ig_account, kind, status, scheduled_at, artwork_keys, caption, created, updated) VALUES ('s1', 'b1', 'c1', 1, '17841400000002', 'single', 'publishing', ?, '[]', 'Hi', ?, ?)").bind(old, old, old).run();
    await publishDue(env, { sleep: async () => {} });
    const row = await env.DB.prepare("SELECT status, error FROM publications WHERE id = 's1'").first<{ status: string; error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("interrupted");
  });

  it("a container that never finishes fails with a readable message after the bounded poll", async () => {
    fakeGraph({ pollsUntilFinished: 99 });
    const env = await seed();
    const { publication: p } = (await json(await app().request("/api/studio/publish", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ batch: "b1", index: 1, igAccount: "17841400000002", when: "now", artwork: [JPEG] }) }, env))) as { publication: Publication };
    expect(p.status).toBe("failed");
    expect(p.error).toContain("still processing");
  });
});
