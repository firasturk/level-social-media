/**
 * Direct to Studio (server/media-intake.ts, docs/direct-to-studio.md): Start → Edit images and
 * Start → Create or edit video put the client's own files straight onto Studio cards. Drive-only,
 * upload-only and mixed picks; one card per file, appended after the month's posts (never over
 * one); the same pick twice makes no second card; pictures for members, clips for admins; clips
 * stored as finished versions with no generation call; the Plan checks leave the cards alone; a
 * combine of chosen cards becomes one video project. The demo Drive answers (no credential), so the
 * guard proves no network call at all is made: Drive is never written, no engine is reached.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import { monthIssues } from "../shared/issues";
import { postRevision, type Post } from "../shared/posts";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { driveMock } from "../server/drive-mock";
import { sniffImage, titleOf } from "../server/media-intake";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => new Uint8Array(SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength));
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

/** A real, tiny PNG (w×h, one colour). */
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

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

/** A preview with no Drive credential (the demo Drive), a client, and a month owned by the member with one planned post. */
async function seed(withMonth = true) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  for (const u of [ADMIN, MEMBER]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES (?, ?, ?, 'x', ?, ?)").bind(u.id, u.email, u.name, u.role, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'habibah-media-test', 'active', ?, ?)").bind(t, t).run();
  if (withMonth) {
    const config = postConfig("c1", "2026-10", { postCount: 1, plannedAt: 1000, plan: [{ index: 1, type: "product", title: "Kunafa", brief: "A kunafa tray on marble", caption: "Hello", hashtags: "", product: "kunafa" } as Post] });
    await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  }
  return env;
}

type Item = { from: "drive"; id: string } | { from: "upload"; file: File; poster?: File };

function intake(env: FakeEnv, user: User, kind: "images" | "video", items: Item[], dest: Record<string, string> = { batch: "b1" }) {
  const form = new FormData();
  form.set("kind", kind);
  for (const [k, v] of Object.entries(dest)) form.set(k, v);
  const list = items.map((it, i) => {
    if (it.from === "drive") return it;
    form.set(`file${i}`, it.file, it.file.name);
    if (it.poster) form.set(`poster${i}`, it.poster, "poster.png");
    return { from: "upload", field: `file${i}`, ...(it.poster ? { poster: `poster${i}` } : {}) };
  });
  form.set("items", JSON.stringify(list));
  return app(user).request("/api/studio/media/intake", { method: "POST", body: form }, env);
}

const picture = (name: string, rgb: [number, number, number] = [200, 100, 50]) => new File([png(6, 8, rgb)], name, { type: "image/png" });
const clip = (name = "walk.mp4") => new File([sampleBytes()], name, { type: "video/mp4" });

async function monthOf(env: FakeEnv, id = "b1") {
  const row = await env.DB.prepare("SELECT config FROM batches WHERE id = ?").bind(id).first<{ config: string }>();
  return JSON.parse(row!.config) as Config;
}
const tasks = (env: FakeEnv) => env.DB.prepare("SELECT id, post, status, output, made_for FROM tasks WHERE batch = 'b1' ORDER BY post").all<{ id: string; post: number; status: string; output: string; made_for: number }>().then((r) => r.results);
const videos = (env: FakeEnv, batch = "b1") => env.DB.prepare("SELECT id, post, status, provider, source, key, poster_key, for_client FROM videos WHERE batch = ? ORDER BY post, created").bind(batch).all<{ id: string; post: number; status: string; provider: string; source: string; key: string; poster_key: string; for_client: number }>().then((r) => r.results);

let reached: Reached[];
beforeAll(() => {
  // A clip in the demo Drive's product folder, with real MP4 bytes (added before any listing is cached).
  driveMock.files.set("demo-clip", { id: "demo-clip", folder: "demo-drinks", name: "Pouring shot.mp4", mimeType: "video/mp4", modifiedTime: "2026-09-10T09:00:00.000Z", md5Checksum: "d1a0f0c0e0b0a09000000000000000c1", size: SAMPLE.byteLength, width: 1080, height: 1920, color: "#333333", media: sampleBytes() });
});
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  // No network call of any kind: Drive is only read through the demo fixture here, no engine, no provider.
  expect(reached).toEqual([]);
});

describe("Edit images: one card per picture", () => {
  it("Drive only: two pictures become two ready cards after the month's post, copied under the month", async () => {
    const env = await seed();
    const before = await monthOf(env);
    const r = await intake(env, MEMBER, "images", [{ from: "drive", id: "demo-mango" }, { from: "drive", id: "demo-pistachio" }]);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { batch: string; created: { index: number; kind: string; from: string; name: string }[]; existing: unknown[] };
    expect(d.batch).toBe("b1");
    expect(d.created.map((x) => [x.index, x.kind, x.from])).toEqual([
      [2, "image", "drive"],
      [3, "image", "drive"],
    ]);
    expect(d.existing).toEqual([]);
    const config = await monthOf(env);
    // The month's own post is untouched; the new cards follow it.
    expect(config.plan![0]).toEqual(before.plan![0]);
    const cards = config.plan!.slice(1);
    expect(cards.map((p) => [p.index, p.source, p.media?.kind, p.media?.from, p.media?.drive?.id, p.brief, p.title])).toEqual([
      [2, "media", "image", "drive", "demo-mango", "", "Mango sunrise cup"],
      [3, "media", "image", "drive", "demo-pistachio", "", "Pistachio shake"],
    ]);
    expect(config.postCount).toBe(3);
    const ts = await tasks(env);
    expect(ts.map((t) => [t.post, t.status])).toEqual([
      [2, "ready"],
      [3, "ready"],
    ]);
    for (const t of ts) {
      expect(t.output).toMatch(new RegExp(`^u2/b1/output/${t.id}/[0-9a-f-]+\\.png$`));
      const obj = await env.BUCKET.get(t.output);
      expect(obj?.httpMetadata?.contentType).toBe("image/png");
      expect(sniffImage(await obj!.arrayBuffer())).toBe("image/png");
      // The picture is the idea as it is now: never an "older idea", never due to be made again.
      expect(t.made_for).toBe(postRevision(config.plan!.find((p) => p.index === t.post)!, config));
    }
    // A take each, free, saying where it came from.
    const takes = await env.DB.prepare("SELECT post, cost, note FROM post_takes WHERE batch = 'b1' ORDER BY post").all<{ post: number; cost: number; note: string }>();
    expect(takes.results).toEqual([
      { post: 2, cost: 0, note: "Copied from the client's Drive: Mango sunrise cup.jpg" },
      { post: 3, cost: 0, note: "Copied from the client's Drive: Pistachio shake.jpg" },
    ]);
  });

  it("Upload only: one picture and then three pictures make one and three cards, the bytes as sent", async () => {
    const env = await seed();
    const one = (await json(await intake(env, MEMBER, "images", [{ from: "upload", file: picture("IMG_2041.png") }]))) as { created: { index: number }[] };
    expect(one.created.map((x) => x.index)).toEqual([2]);
    const three = (await json(await intake(env, MEMBER, "images", [{ from: "upload", file: picture("a.png", [1, 2, 3]) }, { from: "upload", file: picture("b.png", [4, 5, 6]) }, { from: "upload", file: picture("c.png", [7, 8, 9]) }]))) as { created: { index: number; name: string }[] };
    expect(three.created.map((x) => [x.index, x.name])).toEqual([
      [3, "a.png"],
      [4, "b.png"],
      [5, "c.png"],
    ]);
    const ts = await tasks(env);
    expect(ts.length).toBe(4);
    const first = await env.BUCKET.get(ts[0].output);
    expect(new Uint8Array(await first!.arrayBuffer())).toEqual(png(6, 8, [200, 100, 50]));
    expect((await monthOf(env)).plan!.find((p) => p.index === 2)?.title).toBe("IMG 2041");
  });

  it("Mixed: Drive and computer files in one selection, in the order picked", async () => {
    const env = await seed();
    const r = (await json(await intake(env, MEMBER, "images", [{ from: "upload", file: picture("shop.png") }, { from: "drive", id: "demo-mango" }, { from: "upload", file: picture("door.png", [9, 9, 9]) }]))) as { created: { index: number; from: string; name: string }[] };
    expect(r.created.map((x) => [x.index, x.from, x.name])).toEqual([
      [2, "upload", "shop.png"],
      [3, "drive", "Mango sunrise cup.jpg"],
      [4, "upload", "door.png"],
    ]);
  });

  it("the same pick twice in a row makes no second card (and a file twice in one pick is one card)", async () => {
    const env = await seed();
    const pick = (): Item[] => [{ from: "drive", id: "demo-mango" }, { from: "upload", file: picture("shop.png") }, { from: "upload", file: picture("shop copy.png") }];
    const a = (await json(await intake(env, MEMBER, "images", pick()))) as { created: unknown[] };
    expect(a.created.length).toBe(2);
    const b = (await json(await intake(env, MEMBER, "images", pick()))) as { created: unknown[]; existing: { index: number; name: string }[] };
    expect(b.created).toEqual([]);
    expect(b.existing.map((x) => x.index)).toEqual([2, 3, 3]);
    expect((await monthOf(env)).plan!.length).toBe(3);
    expect((await tasks(env)).length).toBe(2);
  });

  it("refuses a clip, a file that is not a picture, a file too large and a Drive id outside the client's folders, writing nothing", async () => {
    const env = await seed();
    expect((await intake(env, ADMIN, "images", [{ from: "upload", file: clip() }])).status).toBe(415);
    expect((await intake(env, MEMBER, "images", [{ from: "upload", file: new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" }) }])).status).toBe(415);
    expect((await intake(env, MEMBER, "images", [{ from: "upload", file: new File(["x"], "x.gif", { type: "image/gif" }) }])).status).toBe(415);
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    expect((await intake(env, MEMBER, "images", [{ from: "upload", file: big }])).status).toBe(413);
    expect((await intake(env, MEMBER, "images", [{ from: "drive", id: "someone-elses-file" }])).status).toBe(403);
    expect((await monthOf(env)).plan!.length).toBe(1);
    expect((await tasks(env)).length).toBe(0);
  });

  it("a member cannot add cards to another member's month", async () => {
    const env = await seed();
    await env.DB.prepare("UPDATE batches SET owner = 'u1' WHERE id = 'b1'").run();
    expect((await intake(env, MEMBER, "images", [{ from: "upload", file: picture("a.png") }])).status).toBe(404);
  });

  it("asks for the client and the month when neither the month nor both are given; with both, uses or makes the month", async () => {
    const env = await seed(false);
    const r = await intake(env, MEMBER, "images", [{ from: "upload", file: picture("a.png") }], {});
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe("Choose the client and the month first.");
    const made = (await json(await intake(env, MEMBER, "images", [{ from: "upload", file: picture("a.png") }], { client: "c1", month: "2026-11" }))) as { batch: string; created: { index: number }[] };
    expect(made.created.map((x) => x.index)).toEqual([1]);
    const row = await env.DB.prepare("SELECT owner, client, month, name FROM batches WHERE id = ?").bind(made.batch).first();
    expect(row).toEqual({ owner: "u2", client: "c1", month: "2026-11", name: "Habibah · 2026-11" });
    // The same month again: the cards join it, no second month.
    const again = (await json(await intake(env, MEMBER, "images", [{ from: "upload", file: picture("b.png", [1, 1, 1]) }], { client: "c1", month: "2026-11" }))) as { batch: string; created: { index: number }[] };
    expect(again.batch).toBe(made.batch);
    expect(again.created.map((x) => x.index)).toEqual([2]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM batches").first<{ n: number }>())?.n).toBe(1);
    const config = await monthOf(env, made.batch);
    expect(config.postCount).toBe(2);
  });

  it("raises no idea, brief, shot or product issue for media cards, and Generate never makes them", async () => {
    const env = await seed(false);
    const made = (await json(await intake(env, MEMBER, "images", [{ from: "upload", file: picture("a.png") }], { client: "c1", month: "2026-12" }))) as { batch: string };
    const config = await monthOf(env, made.batch);
    const issues = monthIssues({ config, client: { logo: true, tone: "warm", colors: [{ hex: "#000000" }] } as never, theme: null, products: [], cast: [] });
    // Only calendar notes may remain (a big day without a post): nothing about ideas, briefs, shots or products.
    expect(issues.filter((i) => i.code !== "occasion").map((i) => i.code)).toEqual([]);
    expect(issues.some((i) => i.post)).toBe(false);
    const r = await app(MEMBER).request("/api/studio/posts/generate", { method: "POST", body: JSON.stringify({ batch: made.batch }), headers: { "content-type": "application/json" } }, env);
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/^Every post already has its picture/);
    const t = await env.DB.prepare("SELECT status FROM tasks WHERE batch = ?").bind(made.batch).all<{ status: string }>();
    expect(t.results.map((x) => x.status)).toEqual(["ready"]);
  });
});

describe("Create or edit video: pictures and clips as their own cards", () => {
  it("an admin's clips (Drive and computer) and pictures become clip and picture cards, without any generation", async () => {
    const env = await seed();
    const poster = new File([png(9, 16, [20, 20, 20])], "poster.png", { type: "image/png" });
    const r = await intake(env, ADMIN, "video", [{ from: "drive", id: "demo-clip" }, { from: "upload", file: picture("still.png") }, { from: "upload", file: clip("walk.mp4"), poster }]);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { created: { index: number; kind: string; from: string }[] };
    expect(d.created.map((x) => [x.index, x.kind, x.from])).toEqual([
      [2, "video", "drive"],
      [3, "image", "upload"],
      [4, "video", "upload"],
    ]);
    const vs = await videos(env);
    expect(vs.map((v) => [v.post, v.status, v.provider, v.source, v.for_client])).toEqual([
      [2, "done", "upload", "upload", 1],
      [4, "done", "upload", "upload", 1],
    ]);
    const ts = await tasks(env);
    for (const v of vs) {
      expect(new Uint8Array(await (await env.BUCKET.get(v.key))!.arrayBuffer())).toEqual(sampleBytes());
      // The card's picture is the clip's still: the poster sent, else a dark frame.
      expect(v.poster_key).toBe(ts.find((t) => t.post === v.post)!.output);
    }
    expect(new Uint8Array(await (await env.BUCKET.get(vs[1].poster_key))!.arrayBuffer())).toEqual(png(9, 16, [20, 20, 20]));
    // Nothing queued for an engine, no ledger spend.
    expect(ts.map((t) => t.status)).toEqual(["ready", "ready", "ready"]);
    expect((await env.DB.prepare("SELECT state FROM batches WHERE id = 'b1'").first<{ state: string }>())?.state).toBe("idle");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM integration_ops").first<{ n: number }>())?.n).toBe(0);
    expect((await monthOf(env)).plan!.filter((p) => p.media?.kind === "video").map((p) => p.index)).toEqual([2, 4]);
  });

  it("a member may add pictures and clips on the video route (open to the team since 24 Oct)", async () => {
    const env = await seed();
    const ok = (await json(await intake(env, MEMBER, "video", [{ from: "upload", file: picture("a.png") }, { from: "upload", file: clip() }]))) as { created: unknown[] };
    expect(ok.created.length).toBe(2);
  });

  it("refuses a clip that is not H.264 MP4", async () => {
    const env = await seed();
    const r = await intake(env, ADMIN, "video", [{ from: "upload", file: new File([new Uint8Array(64)], "x.mp4", { type: "video/mp4" }) }]);
    expect(r.status).toBe(415);
    expect((await tasks(env)).length).toBe(0);
    expect((await videos(env)).length).toBe(0);
  });
});

describe("Combine into one video", () => {
  async function twoClips(env: FakeEnv) {
    await intake(env, ADMIN, "video", [{ from: "upload", file: clip("one.mp4") }, { from: "upload", file: new File([sampleBytes(), new Uint8Array([0])], "two.mp4", { type: "video/mp4" }) }]);
  }
  const combine = (env: FakeEnv, user: User, items: { post: number; still?: File }[], target = "new") => {
    const form = new FormData();
    form.set("batch", "b1");
    form.set("target", target);
    form.set("items", JSON.stringify(items.map((it, i) => ({ post: it.post, ...(it.still ? { still: `still${i}` } : {}) }))));
    items.forEach((it, i) => it.still && form.set(`still${i}`, it.still, "still.mp4"));
    return app(user).request("/api/studio/media/combine", { method: "POST", body: form }, env);
  };

  it("puts the chosen clips, in the order chosen, in one project on a new card, with a free ledger line", async () => {
    const env = await seed();
    await twoClips(env);
    const r = await combine(env, ADMIN, [{ post: 3 }, { post: 2 }]);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { target: number; created: boolean; project: string; clips: string[] };
    expect(d).toMatchObject({ target: 4, created: true });
    const config = await monthOf(env);
    expect(config.plan!.find((p) => p.index === 4)).toMatchObject({ source: "media", media: { kind: "video", from: "combine" } });
    const row = await env.DB.prepare("SELECT post, project, rev FROM video_projects WHERE id = ?").bind(d.project).first<{ post: number; project: string; rev: number }>();
    expect(row?.post).toBe(4);
    const doc = JSON.parse(row!.project) as { clips: { source: { kind: string; videoId: string } }[] };
    expect(doc.clips.map((c) => c.source.videoId)).toEqual(d.clips);
    // The clips are now versions of the new card, copied from posts 3 and 2 in that order.
    const onTarget = (await videos(env)).filter((v) => v.post === 4);
    expect(onTarget.map((v) => v.id).sort()).toEqual([...d.clips].sort());
    const settings = await env.DB.prepare("SELECT settings FROM videos WHERE id = ?").bind(d.clips[0]).first<{ settings: string }>();
    expect(JSON.parse(settings!.settings).combinedFrom).toBe(3);
    const ops = await env.DB.prepare("SELECT provider, kind, estimate, status, post FROM integration_ops").all();
    expect(ops.results).toEqual([{ provider: "editor", kind: "editor.save", estimate: 0, status: "done", post: 4 }]);
  });

  it("uses a target card's own clip as it is, and takes a picture card as the clip rendered for it", async () => {
    const env = await seed();
    await twoClips(env);
    await intake(env, ADMIN, "video", [{ from: "upload", file: picture("still.png") }]);
    const own = (await videos(env)).find((v) => v.post === 2)!;
    const r = (await json(await combine(env, ADMIN, [{ post: 2 }, { post: 4, still: clip("still.mp4") }], "2"))) as { target: number; created: boolean; clips: string[] };
    expect(r).toMatchObject({ target: 2, created: false });
    expect(r.clips[0]).toBe(own.id);
    expect((await videos(env)).filter((v) => v.post === 2).length).toBe(2);
    // A picture card with no clip and no rendered still cannot join.
    expect((await combine(env, ADMIN, [{ post: 2 }, { post: 4 }])).status).toBe(409);
  });

  it("lets a member combine clips too (24 Oct: the editor is the team's)", async () => {
    const env = await seed();
    await twoClips(env);
    const r = await combine(env, MEMBER, [{ post: 2 }, { post: 3 }]);
    expect(r.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM video_projects").first<{ n: number }>())?.n).toBe(1);
    expect((await monthOf(env)).plan!.length).toBe(4);
  });
});

describe("helpers", () => {
  it("names cards from their files and reads picture types from their bytes", () => {
    expect(titleOf("IMG_2041.JPG")).toBe("IMG 2041");
    expect(titleOf("Pouring shot.mp4")).toBe("Pouring shot");
    expect(sniffImage(png(1, 1, [0, 0, 0]).buffer as ArrayBuffer)).toBe("image/png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer)).toBe("image/jpeg");
    expect(sniffImage(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
  });
});
