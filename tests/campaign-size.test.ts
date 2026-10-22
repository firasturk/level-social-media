import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import { configSchema } from "../shared/config-schema";
import { campaignSizeOf, DEFAULT_CAMPAIGN_SIZE, monthNumbers, normalizeSize, sizeBriefLine, sizeChange, sizeCounts, sizeLine, sizeOfPlan, withoutSizeLine } from "../shared/campaign-size";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";

/**
 * The campaign's size on the Start board: it defaults so old months load unchanged, round-trips
 * through the config schema and the settings route, and its three numbers (posts, designs, images
 * still to generate) are always told apart. A change of size never removes a post by itself.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;

async function app() {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const post = (index: number, extra: Partial<Post> = {}): Post => ({ index, type: "product", title: `Post ${index}`, brief: `Idea ${index}.`, caption: "", hashtags: "", product: "pistachio", ...extra }) as Post;

async function seed(config: Config) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}
const configOf = async (env: FakeEnv) => JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the campaign size defaults and round-trips", () => {
  it("a month saved before the size existed loads unchanged: its post count as single pictures", () => {
    const old = postConfig("c1", "2026-10");
    expect(old.campaignSize).toBeUndefined();
    expect(configSchema.parse(old).campaignSize).toBeUndefined();
    expect(campaignSizeOf(old)).toEqual({ ...DEFAULT_CAMPAIGN_SIZE, posts: 12 });
    expect(campaignSizeOf({ postCount: 7 })).toEqual({ ...DEFAULT_CAMPAIGN_SIZE, posts: 7 });
    expect(campaignSizeOf(null)).toEqual(DEFAULT_CAMPAIGN_SIZE);
  });
  it("a set size survives the config schema and keeps postCount as its post count", () => {
    const cfg = postConfig("c1", "2026-10", { postCount: 10, campaignSize: { posts: 10, carousels: 2, separators: 1, slidesPerCarousel: 5, slidesPerSeparator: 2 } });
    const parsed = configSchema.parse(JSON.parse(JSON.stringify(cfg)));
    expect(parsed.campaignSize).toEqual(cfg.campaignSize);
    expect(campaignSizeOf(parsed)).toEqual(cfg.campaignSize);
    // postCount is the one post count: a size whose posts disagree follows it.
    expect(campaignSizeOf({ postCount: 8, campaignSize: { posts: 10, carousels: 2, separators: 1, slidesPerCarousel: 5, slidesPerSeparator: 2 } }).posts).toBe(8);
  });
  it("keeps every field inside its bounds", () => {
    expect(normalizeSize({ posts: 3, carousels: 5, separators: 4, slidesPerCarousel: 1, slidesPerSeparator: 0 })).toEqual({ posts: 3, carousels: 3, separators: 0, slidesPerCarousel: 2, slidesPerSeparator: 1 });
    expect(normalizeSize({ posts: 999 }).posts).toBe(60);
    expect(normalizeSize(undefined)).toEqual(DEFAULT_CAMPAIGN_SIZE);
  });
  it("rejects a size outside the schema's bounds", () => {
    const r = configSchema.safeParse({ ...postConfig("c1", "2026-10"), campaignSize: { posts: 0, carousels: 0, separators: 0, slidesPerCarousel: 4, slidesPerSeparator: 1 } });
    expect(r.success).toBe(false);
  });
});

describe("posts, designs and images are three numbers", () => {
  it("a size without posts: designs count every slide, every design is an image to generate", () => {
    const c = sizeCounts({ posts: 12, carousels: 3, separators: 1, slidesPerCarousel: 4, slidesPerSeparator: 1 });
    expect(c).toEqual({ posts: 12, singles: 8, carousels: 3, separators: 1, designs: 8 + 12 + 1 });
    expect(monthNumbers([], { posts: 12, carousels: 3, separators: 1, slidesPerCarousel: 4, slidesPerSeparator: 1 })).toEqual({ posts: 12, designs: 21, images: 21, tiles: 0, made: 0, from: "size" });
    expect(sizeLine({ posts: 12, carousels: 3, separators: 1, slidesPerCarousel: 4, slidesPerSeparator: 1 }, "4:5")).toBe("12 posts: 8 single pictures, 3 carousels of 4 slides, 1 separator · 21 designs · 4:5");
    expect(sizeLine({ posts: 5, carousels: 0, separators: 2, slidesPerCarousel: 4, slidesPerSeparator: 3 })).toBe("5 posts: 3 single pictures, 2 separators of 3 designs · 9 designs");
  });
  it("a saved plan: a carousel counts once, a text tile is free, a made picture is not made again", () => {
    const plan = [
      post(1),
      post(2, { group: { id: "g1", kind: "carousel", slide: 1, of: 3 } }),
      post(3, { group: { id: "g1", kind: "carousel", slide: 2, of: 3 } }),
      post(4, { group: { id: "g1", kind: "carousel", slide: 3, of: 3 } }),
      post(5, { product: undefined, tileSpec: { kind: "text", items: "", background: "#fff", text: { position: "center", align: "center", size: "huge", color: "", style: "" } } }),
      post(6),
    ];
    const n = monthNumbers(plan, DEFAULT_CAMPAIGN_SIZE, [1, 2, 5, 99]);
    // 3 posts (post 1, the carousel, post 6)... plus the separator tile: 4 posts, 6 designs.
    expect(n.posts).toBe(4);
    expect(n.designs).toBe(6);
    expect(n.tiles).toBe(1);
    // Pictures made: posts 1 and 2 (the tile's and the unknown post's do not count).
    expect(n.made).toBe(2);
    expect(n.images).toBe(6 - 1 - 2);
    expect(n.from).toBe("plan");
    expect(sizeOfPlan(plan)).toEqual({ posts: 4, carousels: 1, separators: 1, slidesPerCarousel: 3, slidesPerSeparator: 1 });
  });
  it("reads a brief's separator and a series back into a size", () => {
    const plan = [post(1), post(2, { group: { id: "s", kind: "series", slide: 1, of: 2 } }), post(3, { group: { id: "s", kind: "series", slide: 2, of: 2 } }), post(4, { product: undefined, group: { id: "sep", kind: "series", slide: 1, of: 1, role: "separator" } })];
    expect(sizeOfPlan(plan)).toEqual({ posts: 3, carousels: 0, separators: 2, slidesPerCarousel: 4, slidesPerSeparator: 2 });
  });
});

describe("a change of size never removes or rebuilds posts", () => {
  const plan = [post(1), post(2), post(3)];
  it("more posts: an explicit addition naming the new numbers and the posts that stay", () => {
    const c = sizeChange(plan, { ...DEFAULT_CAMPAIGN_SIZE, posts: 5 });
    expect(c?.kind).toBe("add");
    expect(c).toMatchObject({ count: 2, from: 4, to: 5 });
    expect(c?.text).toContain("Add 2 posts (4–5)");
    expect(c?.text).toContain("Posts 1–3 stay exactly as they are");
  });
  it("fewer posts: nothing is removed; the text says how posts leave the month", () => {
    const c = sizeChange(plan, { ...DEFAULT_CAMPAIGN_SIZE, posts: 2 });
    expect(c?.kind).toBe("fewer");
    expect(c?.text).toContain("never removes any by itself");
  });
  it("the same count, or no posts yet: nothing to confirm", () => {
    expect(sizeChange(plan, { ...DEFAULT_CAMPAIGN_SIZE, posts: 3 })).toBeNull();
    expect(sizeChange([], { ...DEFAULT_CAMPAIGN_SIZE, posts: 9 })).toBeNull();
  });
});

describe("the size goes with the brief only as a last paragraph the planner reads", () => {
  it("is written and taken off again so the designer sees their own words", () => {
    const line = sizeBriefLine({ posts: 6, carousels: 1, separators: 1, slidesPerCarousel: 3, slidesPerSeparator: 1 }, "1:1");
    expect(line).toContain("exactly 6 posts");
    expect(line).toContain("4 single posts");
    expect(line).toContain("1 carousel of exactly 3 slides");
    expect(line).toContain("1 separator post");
    expect(line).toContain("8 designs in all; format 1:1");
    const brief = "Three drinks on the street, Arabic headlines.";
    expect(withoutSizeLine(`${brief}\n\n${line}`)).toBe(brief);
    expect(withoutSizeLine(brief)).toBe(brief);
  });
});

describe("the settings route keeps the size on the month", () => {
  it("saves the size, follows its post count, and leaves the posts as they are", async () => {
    const env = await seed(postConfig("c1", "2026-10", { plan: [post(1), post(2)], postCount: 2 }));
    const a = await app();
    const size = { posts: 2, carousels: 1, separators: 0, slidesPerCarousel: 5, slidesPerSeparator: 1 };
    const r = await a.request("/api/studio/posts/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", campaignSize: size, format: "1:1" }) }, env);
    expect(r.status).toBe(200);
    const cfg = await configOf(env);
    expect(cfg.campaignSize).toEqual(size);
    expect(cfg.postCount).toBe(2);
    expect(cfg.format).toBe("1:1");
    expect(cfg.plan?.map((p) => p.index)).toEqual([1, 2]);
    // A size sent alone with another post count moves postCount with it; sent with postCount, postCount wins.
    await a.request("/api/studio/posts/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", campaignSize: { ...size, posts: 5 } }) }, env);
    expect((await configOf(env)).postCount).toBe(5);
    await a.request("/api/studio/posts/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: "b1", postCount: 7, campaignSize: { ...size, posts: 4 } }) }, env);
    const after = await configOf(env);
    expect(after.postCount).toBe(7);
    expect(after.campaignSize?.posts).toBe(7);
    expect(after.plan?.length).toBe(2);
  });
  it("a new month carries the size the Start board set before it existed", async () => {
    const env = await seed(postConfig("c1", "2026-09"));
    const a = await app();
    const cfg = postConfig("c1", "2026-11", { postCount: 9, campaignSize: { posts: 9, carousels: 2, separators: 1, slidesPerCarousel: 4, slidesPerSeparator: 1 } });
    const r = await a.request("/api/studio/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg }) }, env);
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    const saved = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = ?").bind(id).first<{ config: string }>())!.config) as Config;
    expect(saved.campaignSize).toEqual(cfg.campaignSize);
    expect(saved.postCount).toBe(9);
  });
});
