import { deflateSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { Take, User } from "../shared/types";
import { postRoutes } from "../server/posts";
import { StudioError } from "../server/errors";

/**
 * The Photo studio's Adjust tool sends the picture it drew to POST /api/studio/posts/picture/upload.
 * The route is free and local: the month's permission (a member's own month, any month for an
 * admin), the file stored under the month with a thumbnail, a take row (cost 0, the note given or
 * "Adjusted in the Photo studio"), the post's current picture replaced the way a restored picture
 * is (the previous one stays a take), bad files refused by type and size. No network call ever.
 */

type FakeEnv = ReturnType<typeof fakeEnv>;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

/** A real, tiny PNG (w×h, one colour) the server's decoder reads. */
function png(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ADMIN = { id: "u1", email: "u@test", name: "U", role: "admin" } as User;
const MEMBER = { id: "u2", email: "m@test", name: "M", role: "member" } as User;

function app(user: User = ADMIN) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio/posts", postRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const OLD_KEY = "u1/b1/output/t1/a.png";

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  for (const u of [ADMIN, MEMBER]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES (?, ?, ?, 'x', ?)").bind(u.id, u.email, u.name, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plannedAt: 1000,
    plan: [{ index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only", ideaAt: 5000 } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, updated, post, made_for) VALUES ('t1', 'b1', 's1', 1, 'review', ?, '', ?, 1, 5000)").bind(OLD_KEY, t).run();
  await env.BUCKET.put(OLD_KEY, png(4, 4, [10, 20, 30]), { httpMetadata: { contentType: "image/png" } });
  // The current picture is a take already, as the engine records them.
  await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES ('tk1', 'b1', 1, 't1', 'made', ?, 0.04, 'first take', 5000, ?)").bind(OLD_KEY, t - 1000).run();
  return env;
}

function upload(env: FakeEnv, fields: Record<string, string | Blob>, user: User = ADMIN) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob) form.set(k, v, "adjusted.png");
    else form.set(k, v);
  }
  return app(user).request("/api/studio/posts/picture/upload", { method: "POST", body: form }, env);
}

const picture = () => new Blob([png(6, 8, [200, 100, 50])], { type: "image/png" });

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/studio/posts/picture/upload", () => {
  it("stores the picture under the month with a thumbnail, records a free take and makes it the post's picture", async () => {
    const env = await seed();
    const r = await upload(env, { batch: "b1", index: "1", file: picture() });
    expect(r.status).toBe(200);
    const d = (await json(r)) as { key: string; thumb: string; width: number; height: number; previous: string; task: string };
    expect(d.task).toBe("t1");
    expect(d.previous).toBe(OLD_KEY);
    expect(d.key).toMatch(/^u1\/b1\/output\/t1\/[0-9a-f-]+\.png$/);
    expect({ w: d.width, h: d.height }).toEqual({ w: 6, h: 8 });
    // The file, byte for byte, and its thumbnail.
    const obj = await env.BUCKET.get(d.key);
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(png(6, 8, [200, 100, 50]));
    expect(d.thumb).toMatch(/^styles\/.+-thumb\.jpg$/);
    expect(await env.BUCKET.head(d.thumb)).toBeTruthy();
    // The post's picture is the new one, ready, with its lineage the idea as it is now.
    const task = await env.DB.prepare("SELECT output, status, made_for, qa FROM tasks WHERE id = 't1'").first<{ output: string; status: string; made_for: number; qa: string | null }>();
    expect(task).toMatchObject({ output: d.key, status: "ready", made_for: 5000, qa: null });
    // A take row: cost 0, the default note, made for the current idea; the previous picture stays a take.
    const takes = (await json(await app().request("/api/studio/posts/takes?batch=b1&index=1", {}, env))) as { takes: Take[] };
    expect(takes.takes.map((t) => [t.key, t.cost, t.note, t.madeFor, t.current])).toEqual([
      [d.key, 0, "Adjusted in the Photo studio", 5000, true],
      [OLD_KEY, 0.04, "first take", 5000, false],
    ]);
    // The previous picture is also kept with the month's earlier pictures, as a restore keeps it.
    const snap = await env.DB.prepare("SELECT label, outputs FROM month_versions WHERE batch = 'b1' AND kind = 'snapshot'").first<{ label: string; outputs: string }>();
    expect(snap).toEqual({ label: "Post 1 before the Photo studio", outputs: JSON.stringify({ "1": OLD_KEY }) });
    // The old picture can come back the usual way.
    const back = await app().request("/api/studio/posts/versions/restore", { method: "POST", body: JSON.stringify({ batch: "b1", index: 1, key: OLD_KEY }), headers: { "content-type": "application/json" } }, env);
    expect(back.status).toBe(200);
    expect(reached).toEqual([]);
  });

  it("keeps the note given", async () => {
    const env = await seed();
    const r = await upload(env, { batch: "b1", index: "1", file: picture(), note: "Adjusted in the Photo studio: crop 4:5, exposure +20" });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare("SELECT note, cost FROM post_takes WHERE batch = 'b1' ORDER BY created DESC LIMIT 1").first<{ note: string; cost: number }>();
    expect(row).toEqual({ note: "Adjusted in the Photo studio: crop 4:5, exposure +20", cost: 0 });
    expect(reached).toEqual([]);
  });

  it("refuses another member's month the way the restore route does, and a post that is not there", async () => {
    const env = await seed();
    const r = await upload(env, { batch: "b1", index: "1", file: picture() }, MEMBER);
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ error: "Plan not found." });
    const restore = await app(MEMBER).request("/api/studio/posts/versions/restore", { method: "POST", body: JSON.stringify({ batch: "b1", index: 1, key: OLD_KEY }), headers: { "content-type": "application/json" } }, env);
    expect(restore.status).toBe(404);
    const gone = await upload(env, { batch: "b1", index: "7", file: picture() });
    expect(gone.status).toBe(404);
    // Nothing changed.
    const task = await env.DB.prepare("SELECT output FROM tasks WHERE id = 't1'").first<{ output: string }>();
    expect(task?.output).toBe(OLD_KEY);
    expect(reached).toEqual([]);
  });

  it("refuses a file that is not a PNG, JPEG or WebP (415) and one over 20 MB (413), before storing anything", async () => {
    const env = await seed();
    const svg = await upload(env, { batch: "b1", index: "1", file: new Blob(["<svg/>"], { type: "image/svg+xml" }) });
    expect(svg.status).toBe(415);
    const big = await upload(env, { batch: "b1", index: "1", file: new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: "image/png" }) });
    expect(big.status).toBe(413);
    const unreadable = await upload(env, { batch: "b1", index: "1", file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }) });
    expect(unreadable.status).toBe(415);
    const missing = await upload(env, { batch: "b1", index: "1" });
    expect(missing.status).toBe(400);
    const takes = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_takes WHERE batch = 'b1'").first<{ n: number }>();
    expect(takes?.n).toBe(1);
    expect((await env.BUCKET.list()).objects.map((o) => o.key)).toEqual([OLD_KEY]);
    expect(reached).toEqual([]);
  });

  it("waits while the post is being made", async () => {
    const env = await seed();
    await env.DB.prepare("UPDATE tasks SET status = 'processing' WHERE id = 't1'").run();
    const r = await upload(env, { batch: "b1", index: "1", file: picture() });
    expect(r.status).toBe(409);
    expect(reached).toEqual([]);
  });
});
