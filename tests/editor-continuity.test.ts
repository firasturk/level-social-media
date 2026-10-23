/**
 * Editors that hand work to each other without losing it, and never silently change what the
 * client approved or sees on the review link:
 *
 *   - a Photo studio save on a post the client answered (approved it, or asked for a change) is
 *     kept as a new version: the post's picture, the client's answer and the share link stay as they
 *     were, until "Send it for review" makes the new version the client's (and clears their answer);
 *   - a post the client has not answered is edited directly, even with the review link out: the
 *     link shows the new picture at once;
 *   - every version is retained (the video save/render path is covered by its own tests);
 *   - the card's editing session (src/studio/editing-session.ts) knows what is pending.
 *
 * No network call leaves the test: the paid-route guard fails on any.
 */
import { deflateSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { clientHold, heldMessage } from "../shared/client-hold";
import { DEFAULT_ADJUST } from "../shared/photo-adjust";
import { newProject } from "../shared/video-project";
import { isEmptySession, pendingLabel, pendingParts, SessionStore } from "../shared/editing-session";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { shareRoutes } from "../server/share";
import type { Take, User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const TOKEN = "c".repeat(32);
const RID = "rid-rana-0001";
const OLD_KEY = "u1/b1/output/t1/a.png";
const json = <T = Record<string, unknown>>(r: Response) => r.json() as Promise<T>;

/** A real, tiny PNG the server's decoder reads. */
function png(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (1 + w * 3) + 1 + x * 3);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function app() {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("/api/studio/*", async (c, next) => {
    c.set("user", ADMIN);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.route("/api/share", shareRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const APPROVAL = (t: number) => ({ "1": { status: "approved", by: "Rana", at: t, answers: [{ rid: RID, status: "approved", by: "Rana", at: t, version: { kind: "image", id: String(t), label: "Picture (22 Oct)" } }] } });
const CHANGES = (t: number) => ({ "1": { status: "changes", note: "Warmer light", by: "Rana", at: t, answers: [{ rid: RID, status: "changes", note: "Warmer light", by: "Rana", at: t, version: { kind: "image", id: String(t), label: "Picture (22 Oct)" } }] } });

/** One month, one post with a picture; approved by the client (or a change asked) and/or on the review link as asked. */
async function seed(opts: { approved?: boolean; changes?: boolean; shared?: boolean } = {}) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now() - 60_000;
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    plannedAt: 1000,
    ...(opts.shared ? { shareToken: TOKEN } : {}),
    ...(opts.approved ? { approvals: APPROVAL(t) as never } : opts.changes ? { approvals: CHANGES(t) as never } : {}),
    plan: [{ index: 1, type: "product", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", headline: "Pistachio week", ideaAt: 5000 } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, updated, post, made_for) VALUES ('t1', 'b1', 's1', 1, 'ready', ?, '', ?, 1, 5000)").bind(OLD_KEY, t).run();
  await env.BUCKET.put(OLD_KEY, png(4, 4, [10, 20, 30]), { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES ('tk1', 'b1', 1, 't1', 'made', ?, 0.04, 'first take', 5000, ?)").bind(OLD_KEY, t - 1000).run();
  return env;
}

function upload(env: FakeEnv) {
  const form = new FormData();
  form.set("batch", "b1");
  form.set("index", "1");
  form.set("note", "Adjusted in the Photo studio: exposure +20");
  form.set("file", new Blob([png(6, 8, [200, 100, 50])], { type: "image/png" }), "adjusted.png");
  return app().request("/api/studio/posts/picture/upload", { method: "POST", body: form }, env);
}

const sendForReview = (env: FakeEnv, body: Record<string, unknown>) => app().request("/api/studio/posts/versions/send-for-review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch: "b1", index: 1, ...body }) }, env);

interface SharedPost {
  image: number | null;
  version: { kind: string; id: string } | null;
  approval: { status: string } | null;
  video: { id: string } | null;
}
const shareLink = async (env: FakeEnv) => (await json<{ posts: SharedPost[] }>(await app().request(`/api/share/${TOKEN}?rid=${RID}`, {}, env))).posts[0];
const taskRow = (env: FakeEnv) => env.DB.prepare("SELECT output, updated FROM tasks WHERE id = 't1'").first<{ output: string; updated: number }>();
const approvals = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { approvals?: Record<string, { status: string }> }).approvals ?? {};
const takes = async (env: FakeEnv) => (await json<{ takes: Take[] }>(await app().request("/api/studio/posts/takes?batch=b1&index=1", {}, env))).takes;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached).toEqual([]);
});

describe("who holds a post's current version", () => {
  it("is the client only when they answered it (approved it, or asked for a change), link or not", () => {
    expect(clientHold(null, 1)).toBeNull();
    expect(clientHold({}, 1)).toBeNull();
    expect(clientHold({ approvals: { "1": { status: "changes" } } }, 1)).toBe("changes");
    expect(clientHold({ approvals: { "1": { status: "approved" } } }, 1)).toBe("approved");
    expect(clientHold({ approvals: { "1": { status: "approved" } } }, 2)).toBeNull();
    // The review link alone holds nothing any more: an unanswered post is edited directly.
    const shared = { shareToken: TOKEN, approvals: { "2": { status: "approved" as const } } };
    expect(clientHold(shared, 1)).toBeNull();
    expect(clientHold(shared, 2)).toBe("approved");
    expect(heldMessage("approved")).toBe("The client approved the current version; your edit is saved as a new version. Send it for review to replace it.");
    expect(heldMessage("changes")).toBe("The client asked for a change on the current version; your edit is saved as a new version. Send it for review to replace it.");
    // A version held under the earlier rule still reads.
    expect(heldMessage("shared")).toMatch(/^The client's review link shows the current version/);
  });
});

describe("a picture save on a post the client holds", () => {
  it("creates a new version and leaves the approved one, the answer and the share link unchanged; Send it for review replaces it", async () => {
    const env = await seed({ approved: true, shared: true });
    const before = await shareLink(env);
    const taskBefore = await taskRow(env);
    expect(before.approval).toMatchObject({ status: "approved" });

    const r = await upload(env);
    expect(r.status).toBe(200);
    const d = await json<{ key: string; held: string; message: string; current: string; previous: string }>(r);
    expect(d.held).toBe("approved");
    expect(d.message).toBe("The client approved the current version; your edit is saved as a new version. Send it for review to replace it.");
    expect(d.key).not.toBe(OLD_KEY);
    expect(d.current).toBe(OLD_KEY);
    // The post's picture, the client's answer and what the link shows are exactly as before.
    expect(await taskRow(env)).toEqual(taskBefore);
    expect((await approvals(env))["1"]).toMatchObject({ status: "approved" });
    expect(await shareLink(env)).toEqual(before);
    const served = await app().request(`/api/share/${TOKEN}/image/1`, {}, env);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    // The new version is stored and listed beside the client's, which stays current.
    expect(await env.BUCKET.head(d.key)).toBeTruthy();
    expect((await takes(env)).map((t) => [t.key, t.current])).toEqual([
      [d.key, false],
      [OLD_KEY, true],
    ]);
    expect((await takes(env))[0].note).toContain("the client's version stays");

    // "Send it for review": the new version is the client's now, their earlier answer is cleared, nothing is lost.
    const sent = await sendForReview(env, { key: d.key });
    expect(sent.status).toBe(200);
    expect(await json(sent)).toMatchObject({ ok: true, picture: d.key, reopened: true });
    expect((await taskRow(env))!.output).toBe(d.key);
    expect((await approvals(env))["1"]).toBeUndefined();
    const after = await shareLink(env);
    expect(after.approval).toBeNull();
    expect(after.image).not.toBe(before.image);
    expect((await takes(env)).map((t) => [t.key, t.current])).toEqual([
      [d.key, true],
      [OLD_KEY, false],
    ]);
    const snap = await env.DB.prepare("SELECT outputs FROM month_versions WHERE batch = 'b1' AND kind = 'snapshot'").first<{ outputs: string }>();
    expect(JSON.parse(snap!.outputs)).toEqual({ "1": OLD_KEY });
    expect(await env.BUCKET.head(OLD_KEY)).toBeTruthy();
  });

  it("puts the edit straight on the review link when the client has not answered the post yet", async () => {
    const env = await seed({ shared: true });
    const before = await shareLink(env);
    expect(before.approval).toBeNull();
    const d = await json<{ key: string; held: string | null; current: string }>(await upload(env));
    expect(d.held).toBeNull();
    expect(d.current).toBe(d.key);
    expect((await taskRow(env))!.output).toBe(d.key);
    // The link shows the new picture at once (its version stamp moved), still unanswered.
    const after = await shareLink(env);
    expect(after.image).not.toBe(before.image);
    expect(after.version?.id).not.toBe(before.version?.id);
    expect(after.approval).toBeNull();
    const served = await app().request(`/api/share/${TOKEN}/image/1`, {}, env);
    expect(served.status).toBe(200);
    // The earlier picture stays under Versions.
    expect((await takes(env)).map((t) => [t.key, t.current])).toEqual([
      [d.key, true],
      [OLD_KEY, false],
    ]);
  });

  it("keeps the client's picture when the client asked for a change on it, until it is sent for review", async () => {
    const env = await seed({ changes: true, shared: true });
    const before = await shareLink(env);
    expect(before.approval).toMatchObject({ status: "changes" });
    const d = await json<{ key: string; held: string; message: string; current: string }>(await upload(env));
    expect(d.held).toBe("changes");
    expect(d.message).toBe("The client asked for a change on the current version; your edit is saved as a new version. Send it for review to replace it.");
    expect(d.current).toBe(OLD_KEY);
    expect((await taskRow(env))!.output).toBe(OLD_KEY);
    expect(await shareLink(env)).toEqual(before);
    expect((await approvals(env))["1"]).toMatchObject({ status: "changes" });
    // Send it for review: the client sees the new picture and answers again.
    const sent = await sendForReview(env, { key: d.key });
    expect(await json(sent)).toMatchObject({ ok: true, picture: d.key, reopened: true });
    expect((await taskRow(env))!.output).toBe(d.key);
    expect((await approvals(env))["1"]).toBeUndefined();
    const after = await shareLink(env);
    expect(after.approval).toBeNull();
    expect(after.image).not.toBe(before.image);
    // Unanswered again: the next edit goes straight to the link.
    const next = await json<{ key: string; held: string | null }>(await upload(env));
    expect(next.held).toBeNull();
    expect((await taskRow(env))!.output).toBe(next.key);
  });

  it("keeps a version held under the earlier rule until it is sent, while new edits on the unanswered post go live", async () => {
    // Before the rule changed, an edit on this shared, unanswered post was kept aside as a take.
    const env = await seed({ shared: true });
    const heldKey = "u1/b1/output/t1/held.png";
    await env.BUCKET.put(heldKey, png(5, 5, [1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES ('tk-held', 'b1', 1, 't1', 'made', ?, 0, 'Adjusted · new version (the client''s version stays)', 5000, ?)").bind(heldKey, Date.now() - 30_000).run();
    expect((await taskRow(env))!.output).toBe(OLD_KEY);
    expect((await takes(env)).find((t) => t.key === heldKey)?.current).toBe(false);
    // It is still there to send, and sending it makes it the client's picture.
    const sent = await sendForReview(env, { key: heldKey });
    expect(await json(sent)).toMatchObject({ ok: true, picture: heldKey });
    expect((await taskRow(env))!.output).toBe(heldKey);
    // A new edit on the (unanswered) post now goes live directly.
    const d = await json<{ key: string; held: string | null }>(await upload(env));
    expect(d.held).toBeNull();
    expect((await taskRow(env))!.output).toBe(d.key);
  });

  it("replaces the picture as before when the client holds nothing", async () => {
    const env = await seed();
    const d = await json<{ key: string; held: string | null; current: string }>(await upload(env));
    expect(d.held).toBeNull();
    expect(d.current).toBe(d.key);
    expect((await taskRow(env))!.output).toBe(d.key);
  });

  it("refuses to send a picture that is not one of the post's takes", async () => {
    const env = await seed({ approved: true, shared: true });
    const r = await sendForReview(env, { key: "u1/b1/output/t1/nope.png" });
    expect(r.status).toBe(404);
    expect((await taskRow(env))!.output).toBe(OLD_KEY);
    expect((await approvals(env))["1"]).toMatchObject({ status: "approved" });
  });
});

describe("the card's editing session", () => {
  const memoryStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
  };

  it("carries what each studio has not saved across switches, and says it plainly", () => {
    const st = memoryStorage();
    const s = new SessionStore(() => st);
    let told = 0;
    s.subscribe(() => told++);
    expect(s.get("b1", 1)).toBeNull();
    s.patch("b1", 1, { studio: "photo", photo: { adjust: { ...DEFAULT_ADJUST, exposure: 20 }, basis: "/pic.png", png: true } });
    expect(pendingParts(s.get("b1", 1))).toEqual(["photo"]);
    // Photo studio → Text studio → Video studio: the adjustments stay; the words and the cut join them.
    s.patch("b1", 1, { studio: "text", text: { result: { headline: "Hi", subline: "", ov: undefined }, basis: "x" } });
    s.patch("b1", 1, { studio: "video", video: { project: newProject("Cut", 1), projectId: null, rev: 0 } });
    s.patch("b1", 1, { studio: "photo" });
    const now = s.get("b1", 1)!;
    expect(now.photo?.adjust.exposure).toBe(20);
    expect(now.text?.result.headline).toBe("Hi");
    expect(now.video?.project.name).toBe("Cut");
    expect(pendingParts(now)).toEqual(["photo", "text", "video"]);
    expect(pendingLabel(pendingParts(now))).toBe("picture adjustments, words and layers and the video cut");
    expect(told).toBe(4);
    // The card's notice changes only when what the card says changes.
    const notice = s.noticeKey("b1");
    s.patch("b1", 1, { photo: { adjust: { ...DEFAULT_ADJUST, exposure: 25 }, basis: "/pic.png", png: true } });
    expect(s.noticeKey("b1")).toBe(notice);
    // A reload of the tab reads the session back.
    const again = new SessionStore(() => st);
    expect(pendingParts(again.get("b1", 1))).toEqual(["photo", "text", "video"]);
    // Default adjustments are nothing to save; another post has its own session.
    s.patch("b1", 1, { photo: { adjust: DEFAULT_ADJUST, basis: "/pic.png", png: true } });
    expect(pendingParts(s.get("b1", 1))).toEqual(["text", "video"]);
    expect(s.get("b1", 2)).toBeNull();
    // An empty session is not kept in storage; clearing is the designer's explicit Discard.
    s.patch("b1", 1, { text: null, video: null, studio: null });
    expect(isEmptySession(s.get("b1", 1)!)).toBe(true);
    expect(st.size()).toBe(0);
    s.clear("b1", 1);
    expect(s.get("b1", 1)).toBeNull();
  });

  it("keeps working in memory when the storage refuses", () => {
    const s = new SessionStore(() => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    }));
    s.patch("b2", 3, { held: { kind: "picture", reason: "approved", message: heldMessage("approved"), key: "k" } });
    expect(s.get("b2", 3)?.held?.message).toBe(heldMessage("approved"));
    expect(s.noticeKey("b2")).toContain("picture:k");
  });
});
