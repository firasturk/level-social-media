/**
 * "Add as new posts" (POST /api/studio/photo/tools/jobs/:id/posts): a finished result kept beside the
 * post it was made on. Variations: Magnific lists the grid's pictures one by one (`results.tiles`),
 * each becomes a post; any other tool: the result becomes one post. The original post keeps its
 * picture; the new posts copy its idea and words, never its client answers; a second press adds
 * nothing; nothing is run. Variations ask for the post's own frame. (Live: a variations run gave one
 * 3×3 picture that "Use as the post's picture" put on the post as a grid.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, magnificStub, MAGNIFIC_TOKEN, postJson, seed, type FakeEnv } from "./support/photo-mcp";
import { useMcpFetch } from "../server/freepik-mcp";
import { resetPhotoToolCaches, siblingPost, variationTiles, withPostFrame } from "../server/photo-tools";
import { setSetting, FREEPIK_MCP_TOKEN_SETTING } from "../server/settings";
import { photoTool } from "../shared/photo-tools";
import type { Config } from "../shared/config";
import type { Post } from "../shared/posts";

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useMcpFetch(null);
  resetPhotoToolCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useMcpFetch(null);
});

const TILES = Array.from({ length: 9 }, (_, i) => ({ identifier: `tile_${i}`, url: `https://cdn.test/magnific/tile${i}.jpg` }));

async function doneJob(env: FakeEnv, tool: string, label: string, providerJob: string) {
  const key = `u2/b1/output/t1/job-${tool}.png`;
  await env.BUCKET.put(key, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]).buffer, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare("INSERT INTO photo_tool_jobs (id, batch, post, task, owner, provider, tool, label, options, input_key, output_key, status, provider_job, estimate, reported, settings, created, updated) VALUES (?, 'b1', 1, 't1', 'u1', 'magnific', ?, ?, '{}', 'u2/b1/output/t1/a.png', ?, 'done', ?, 150, 150, '{}', 1, 1)")
    .bind(`job-${tool}`, tool, label, key, providerJob)
    .run();
  return `job-${tool}`;
}

const plan = async (env: FakeEnv) => (JSON.parse(((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first()) as { config: string }).config) as Config).plan ?? [];
const outputOf = async (env: FakeEnv, post: number) => ((await env.DB.prepare("SELECT output FROM tasks WHERE batch = 'b1' AND post = ?").bind(post).first()) as { output: string } | null)?.output;
const add = (env: FakeEnv, id: string) => postJson(app(), env, `/api/studio/photo/tools/jobs/${id}/posts`, { batch: "b1" });

describe("a result as new posts", () => {
  it("makes each picture of a variations grid its own post, after the month's posts, and keeps the original", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub({ waits: [{ status: "completed", results: { url: "https://cdn.test/magnific/out.jpg", tiles: TILES } }] });
    useMcpFetch(stub.fn);
    const id = await doneJob(env, "mg-variations", "Variations (Magnific)", "cr_var_1");
    const r = await add(env, id);
    expect(r.status).toBe(200);
    expect(((await json(r)) as { posts: number[] }).posts).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stub.rpc.filter((x) => x.method === "tools/call").map((x) => x.name)).toEqual(["creations_wait"]);
    const posts = await plan(env);
    expect(posts.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(posts[1]).toMatchObject({ title: "Cup · variations 1", brief: "A cup", type: "product" });
    expect(await outputOf(env, 1)).toBe("u2/b1/output/t1/a.png");
    const tile = await env.BUCKET.get((await outputOf(env, 5))!);
    expect(new Uint8Array(await tile!.arrayBuffer()).at(-1)).toBe(3);
    expect(tile!.httpMetadata?.contentType).toBe("image/jpeg");
    // A second press adds nothing.
    const again = await add(env, id);
    expect(again.status).toBe(409);
    expect((await plan(env)).length).toBe(10);
    const jobs = (await json(await app().request("/api/studio/photo/tools/jobs?batch=b1&index=1", {}, env))) as { jobs: { id: string; addedAs: number[] }[] };
    expect(jobs.jobs.find((j) => j.id === id)?.addedAs).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("adds a restyle (or any other result) as one new post from the stored picture, without asking the provider", async () => {
    const env = await seed();
    const id = await doneJob(env, "mg-restyle", "Restyle (Magnific)", "cr_rs_1");
    const r = await add(env, id);
    expect(((await json(r)) as { posts: number[] }).posts).toEqual([2]);
    expect((await plan(env))[1].title).toBe("Cup · restyle");
    expect(await outputOf(env, 2)).toMatch(/^u2\/b1\/output\/[0-9a-f-]+\/[0-9a-f-]+\.png$/);
    expect(await outputOf(env, 1)).toBe("u2/b1/output/t1/a.png");
  });

  it("when Magnific lists no separate pictures nothing is added", async () => {
    const env = await seed();
    const id = await doneJob(env, "mg-restyle", "Restyle (Magnific)", "cr_rs_1");
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    useMcpFetch(magnificStub({ waits: [{ status: "completed", url: "https://cdn.test/magnific/out.jpg" }] }).fn);
    const v = await doneJob(env, "mg-variations", "Variations (Magnific)", "cr_var_2");
    expect((await add(env, v)).status).toBe(502);
    expect((await plan(env)).length).toBe(1);
  });
});

describe("a result as a carousel", () => {
  it("makes the post slide 1 and the grid's pictures the next slides, ten at most", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    useMcpFetch(magnificStub({ waits: [{ status: "completed", results: { url: "https://cdn.test/magnific/out.jpg", tiles: TILES } }] }).fn);
    const id = await doneJob(env, "mg-variations", "Variations (Magnific)", "cr_var_1");
    const r = await postJson(app(), env, `/api/studio/photo/tools/jobs/${id}/posts`, { batch: "b1", as: "carousel" });
    expect(await json(r)).toMatchObject({ posts: [2, 3, 4, 5, 6, 7, 8, 9, 10], carousel: true });
    const posts = await plan(env);
    const gid = posts[0].group!.id;
    expect(posts.map((p) => [p.index, p.group?.id === gid, p.group?.slide, p.group?.of])).toEqual(posts.map((p, i) => [p.index, true, i + 1, 10]));
    expect(posts[1].title).toBe("Cup · slide 2");
    expect(await outputOf(env, 1)).toBe("u2/b1/output/t1/a.png");
  });

  it("adds a restyle as the next slide of a carousel the post is already in, and refuses past ten slides", async () => {
    const env = await seed();
    const rs = await doneJob(env, "mg-restyle", "Restyle (Magnific)", "cr_rs_1");
    expect(await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${rs}/posts`, { batch: "b1", as: "carousel" }))).toMatchObject({ posts: [2] });
    let posts = await plan(env);
    expect(posts.map((p) => [p.group?.slide, p.group?.of])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    const rl = await doneJob(env, "mg-relight", "Relight (Magnific)", "cr_rl_1");
    expect(await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${rl}/posts`, { batch: "b1", as: "carousel" }))).toMatchObject({ posts: [3] });
    posts = await plan(env);
    expect(new Set(posts.map((p) => p.group?.id)).size).toBe(1);
    expect(posts.map((p) => [p.group?.slide, p.group?.of])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    useMcpFetch(magnificStub({ waits: [{ status: "completed", results: { tiles: TILES } }] }).fn);
    const v = await doneJob(env, "mg-variations", "Variations (Magnific)", "cr_var_9");
    const over = await postJson(app(), env, `/api/studio/photo/tools/jobs/${v}/posts`, { batch: "b1", as: "carousel" });
    expect(over.status).toBe(409);
    expect(((await json(over)) as { error: string }).error).toContain("at most 10");
    expect((await plan(env)).length).toBe(3);
  });

  it("refuses a carousel on a post that is part of a series", async () => {
    const env = await seed();
    await env.DB.prepare(`UPDATE batches SET config = json_set(config, '$.plan[0].group', json('{"id":"s1","kind":"series","slide":1,"of":2}')) WHERE id = 'b1'`).run();
    const rs = await doneJob(env, "mg-restyle", "Restyle (Magnific)", "cr_rs_1");
    expect((await postJson(app(), env, `/api/studio/photo/tools/jobs/${rs}/posts`, { batch: "b1", as: "carousel" })).status).toBe(409);
  });
});

describe("the pieces", () => {
  it("reads the tiles of the asked creation only", () => {
    const raw = { results: [{ identifier: "other", results: { tiles: [{ url: "https://x.test/o.jpg" }] } }, { identifier: "cr_var_1", status: "completed", results: { url: "https://x.test/grid.png", tiles: TILES } }] };
    expect(variationTiles(raw, "cr_var_1")).toHaveLength(9);
    expect(variationTiles(raw, "missing")).toEqual([]);
  });

  it("copies the post's idea and words but not its client answers, checks, date or grid place", () => {
    const from = { index: 3, type: "product", title: "Mango", brief: "b", caption: "c", hashtags: "#h", headline: "H", clientNote: { note: "change it", at: 1 }, date: "2026-10-03", tile: "x", group: { id: "g", kind: "carousel", slide: 1, of: 3 }, textCheck: { ok: true, note: "", for: "", at: 1 } } as unknown as Post;
    const p = siblingPost(from, 12, "Mango · restyle", "tool:j:0", 5);
    expect(p).toMatchObject({ index: 12, title: "Mango · restyle", brief: "b", caption: "c", headline: "H", ideaAt: 5 });
    for (const k of ["clientNote", "date", "tile", "group", "textCheck"]) expect(p).not.toHaveProperty(k);
    const media = siblingPost({ ...from, source: "media", media: { kind: "image", from: "drive", name: "a.jpg", fp: "drive:1", at: 1 } } as Post, 13, "t", "tool:j:1", 9);
    expect(media.media).toMatchObject({ fp: "tool:j:1", from: "drive" });
  });

  it("asks variations for the post's frame unless one was picked", () => {
    const b = { config: JSON.stringify({ format: "4:5", plan: [{ index: 1 }, { index: 2, format: "9:16" }] }) };
    const v = photoTool("mg-variations")!;
    expect(withPostFrame(v, {}, b, 1)).toEqual({ aspect: "4:5" });
    expect(withPostFrame(v, {}, b, 2)).toEqual({ aspect: "9:16" });
    expect(withPostFrame(v, { aspect: "1:1" }, b, 1)).toEqual({ aspect: "1:1" });
    expect(withPostFrame(photoTool("mg-restyle")!, {}, b, 1)).toEqual({});
  });
});
