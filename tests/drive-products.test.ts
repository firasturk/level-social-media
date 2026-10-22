import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { parseBriefPlan } from "../shared/campaign";
import { productLibrary, type DriveFolder } from "../shared/drive";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";

/**
 * Product images chosen from the client's Drive: a Quick Campaign draft that picked a Drive photo
 * puts that product on its posts when it is applied (the confirmed bug), the plan preview never
 * says "blocked" where the run would bring the product in, and the three ways of choosing product
 * images (for me from Drive, from Drive, upload) work over the routes on the demo Drive. No vendor
 * is reached: the text calls are the demo fixture, the Drive is the fixture, nothing is paid.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

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

const post = (index: number, extra: Partial<Post> = {}): Post =>
  ({ index, type: "product", title: `Post ${index}`, brief: `A post, number ${index}.`, caption: `Caption ${index}`, hashtags: "#a", date: `2026-10-${String(index * 3).padStart(2, "0")}`, ideaAt: 1_700_000_000_000, ...extra }) as Post;

/** A month of the client "Habibah" on the demo Drive, whose camera-named photo vision read as the kunafa plate. */
async function seed(plan: Post[] = [], withPistachio = false) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'habibah-test', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", { model: "nano-banana-pro", plan, plannedAt: plan.length ? 1_700_000_000_000 : undefined });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare(
    "INSERT INTO drive_photos (id, client, file, folder, role, name, kind, note, status, md5, modified, version, updated) VALUES ('demo-cold-brew', 'c1', 'DSC01838.JPG', 'Demo drinks (product photos)', 'product', 'Fine Kunafa plate', 'product', 'a round kunafa on a white plate', 'read', 'd1a0f0c0e0b0a0900000000000000005', '2026-09-06T09:00:00.000Z', 99, ?)",
  )
    .bind(t)
    .run();
  if (withPistachio) {
    await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind, note) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product', 'a green cup')").bind(t).run();
    await env.BUCKET.put("u1/b1/src/s1.jpg", new Uint8Array([1, 2, 3]).buffer, { httpMetadata: { contentType: "image/jpeg" } });
  }
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: Post[] }).plan;
const products = (env: FakeEnv) => env.DB.prepare("SELECT name, stem, kind, role FROM sources WHERE batch = 'b1' AND kind = 'product' ORDER BY name").all<{ name: string; stem: string; kind: string; role: string }>().then((r) => r.results);
const call = (a: Hono<never>, env: FakeEnv, path: string, data: unknown) =>
  a.request(`/api/studio/posts${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }, env, ctx);
type Preview = { posts: { index: number; status: string; why?: string; changes?: string[] }[]; blocked: { index: number; why: string }[] };
const preview = async (a: Hono<never>, env: FakeEnv) => (await json(await call(a, env, "/plan-preview", { batch: "b1" }))) as unknown as Preview;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("a Quick Campaign draft that picked a product from Drive", () => {
  it("the planner's post keeps its product when the field is empty but the product is named on the post", () => {
    const products = ["pistachio", "Fine Kunafa plate"];
    const raw = {
      summary: "",
      posts: [
        { type: "product", group: "single", slide: 1, of: 1, role: "", title: "Golden plate", headline: "x", subline: "", brief: "The plate.", product: "", products: ["Fine Kunafa plate"], ingredients: "", exact: false, reference: 0, caption: "c", hashtags: "#a" },
        { type: "product", group: "single", slide: 1, of: 1, role: "", title: "Fine Kunafa plate at dusk", headline: "x", subline: "", brief: "The plate.", product: "", products: [], ingredients: "", exact: false, reference: 0, caption: "c", hashtags: "#a" },
        { type: "product", group: "single", slide: 1, of: 1, role: "", title: "A quiet morning", headline: "x", subline: "", brief: "Nothing named.", product: "", products: [], ingredients: "", exact: false, reference: 0, caption: "c", hashtags: "#a" },
      ],
    };
    const r = parseBriefPlan(raw, products, 1, () => "g");
    expect(r.posts[0].post.product).toBe("Fine Kunafa plate");
    expect(r.posts[0].post.products).toBeUndefined();
    expect(r.posts[1].post.product).toBe("Fine Kunafa plate");
    expect(r.posts[2].post.product).toBeUndefined();
  });

  it("draft with two posts and one Drive pick → apply → both posts have the product and are not blocked", async () => {
    const env = await seed();
    const a = (await app()) as unknown as Hono<never>;
    const f = new FormData();
    f.set("batch", "b1");
    f.set("brief", "Plan 2 posts of the Fine Kunafa plate on the street, a headline on each.");
    const r = await a.request("/api/studio/posts/campaign/draft", { method: "POST", body: f }, env);
    expect(r.status).toBe(200);
    const { draft } = (await json(r)) as unknown as { draft: { id: string; posts: Post[]; summary: string } };
    expect(draft.posts).toHaveLength(2);
    // The Drive photo is the draft's pick: both posts name it, the summary says it joins the month when applied.
    expect(draft.posts.map((p) => p.product)).toEqual(["Fine Kunafa plate", "Fine Kunafa plate"]);
    expect(draft.summary).toMatch(/From the client's Drive: Fine Kunafa plate/);
    expect(await products(env)).toEqual([]);
    const applied = await a.request(`/api/studio/posts/drafts/${draft.id}/apply`, { method: "POST" }, env, ctx);
    expect(applied.status).toBe(200);
    // The product photo joined the month once, as a product, and both posts point at it.
    const rows = await products(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "product", role: "lead", stem: "fine kunafa plate" });
    const plan = await planOf(env);
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.product)).toEqual(["Fine Kunafa plate", "Fine Kunafa plate"]);
    const pv = await preview(a, env);
    expect(pv.blocked).toEqual([]);
    expect(pv.posts.map((p) => p.status)).toEqual(["ready", "ready"]);
  });

  it("the exact failing shape: a draft whose posts carry the product among their products only, applied, puts it on both posts", async () => {
    const env = await seed();
    const a = (await app()) as unknown as Hono<never>;
    const posts = [
      post(1, { title: "Golden plate", brief: "The plate under warm light.", products: ["Fine Kunafa plate"] }),
      post(2, { title: "Shared plate", brief: "Two forks, one plate.", products: ["Fine Kunafa plate"] }),
    ].map((p) => ({ ...p, product: undefined }));
    const input = { text: "Two posts of the kunafa plate.", references: 0, colours: [], styleIds: [], briefColours: [], imports: [{ name: "Fine Kunafa plate", photoId: "demo-cold-brew", note: "a round kunafa on a white plate", kind: "product" }], summary: "Planned 2 posts." };
    await env.DB.prepare("INSERT INTO plan_drafts (id, batch, kind, mode, input, posts, summary, diff, status, created, by) VALUES ('d1', 'b1', 'campaign', 'replace', ?, ?, 'Planned 2 posts.', '{}', 'draft', ?, 'u1')")
      .bind(JSON.stringify(input), JSON.stringify(posts), Date.now())
      .run();
    const applied = await a.request("/api/studio/posts/drafts/d1/apply", { method: "POST" }, env, ctx);
    expect(applied.status).toBe(200);
    expect((await products(env)).map((r) => r.name)).toEqual(["Fine Kunafa plate.svg"]);
    const plan = await planOf(env);
    expect(plan.map((p) => [p.product, p.products])).toEqual([
      ["Fine Kunafa plate", undefined],
      ["Fine Kunafa plate", undefined],
    ]);
    const pv = await preview(a, env);
    expect(pv.blocked).toEqual([]);
    expect(pv.posts.every((p) => p.status === "ready")).toBe(true);
  });

  it("a post that names products but has none selected is blocked for a clear choice, never made with a reference in their place", async () => {
    const env = await seed([{ ...post(1, { products: ["pistachio"] }), product: undefined } as Post], true);
    const a = (await app()) as unknown as Hono<never>;
    const pv = await preview(a, env);
    expect(pv.blocked).toHaveLength(1);
    expect(pv.blocked[0].why).toMatch(/has no product selected: it names pistachio/);
  });

  it("the preview counts a product that joins from Drive at run time as ready, and says so on the post", async () => {
    const env = await seed([post(1, { product: "Fine Kunafa plate" })]);
    const a = (await app()) as unknown as Hono<never>;
    const pv = await preview(a, env);
    expect(pv.blocked).toEqual([]);
    expect(pv.posts[0].status).toBe("ready");
    expect(pv.posts[0].changes).toContain("Fine Kunafa plate comes from the client's Drive when the run starts.");
    // Nothing was copied: the preview never writes the month.
    expect(await products(env)).toEqual([]);
  });
});

describe("choosing product images: for me from Drive, from Drive, upload", () => {
  it("proposes an image per post without writing anything: a named product is kept, the rest come from the Drive listing", async () => {
    const env = await seed([post(1, { product: "pistachio", brief: "The pistachio cup." }), post(2, { brief: "The kunafa plate on a marble table.", title: "Plate" }), post(3, { type: "quote", brief: "A quote.", tileSpec: { kind: "text", items: "", background: "cream", text: { position: "center", align: "center", size: "huge", color: "#fff", style: "bold" } } as never })], true);
    const a = (await app()) as unknown as Hono<never>;
    const r = await call(a, env, "/products/propose", { batch: "b1", drive: true });
    expect(r.status).toBe(200);
    const d = (await json(r)) as unknown as { proposals: { index: number; pick: { source: string; name: string; confident: boolean; id: string } | null; alternatives: unknown[]; locked: boolean; current?: string }[]; drive: number };
    expect(d.drive).toBeGreaterThan(0);
    // The text tile shows no product: it is not in the proposal at all.
    expect(d.proposals.map((p) => p.index)).toEqual([1, 2]);
    expect(d.proposals[0].pick).toMatchObject({ source: "month", name: "pistachio", confident: true });
    expect(d.proposals[0].current).toBe("pistachio");
    expect(d.proposals[1].pick).toMatchObject({ source: "drive", name: "Fine Kunafa plate", confident: false, id: "demo-cold-brew" });
    // Nothing joined the month, nothing changed on the posts.
    expect((await products(env)).map((x) => x.name)).toEqual(["pistachio.jpg"]);
    expect((await planOf(env))[1].product).toBeUndefined();
  });

  it("applying the choices brings each photo in once, puts it on its posts, locks what was locked, and the lock holds against later proposals", async () => {
    const env = await seed([post(1, { brief: "The kunafa plate, close." }), post(2, { brief: "The kunafa plate, far." }), post(3, { product: "pistachio", brief: "The cup." })], true);
    const a = (await app()) as unknown as Hono<never>;
    const r = await call(a, env, "/products/choose", {
      batch: "b1",
      choices: [
        { index: 1, source: "drive", id: "demo-cold-brew", name: "Fine Kunafa plate", lock: true },
        { index: 2, source: "drive", id: "demo-cold-brew", name: "Fine Kunafa plate" },
      ],
    });
    expect(r.status).toBe(200);
    const d = (await json(r)) as unknown as { filled: { index: number; product: string; source: string }[]; failed: string[] };
    expect(d.failed).toEqual([]);
    expect(d.filled).toEqual([
      { index: 1, product: "Fine Kunafa plate", source: "drive" },
      { index: 2, product: "Fine Kunafa plate", source: "drive" },
    ]);
    // One copy for the two posts; the untouched post keeps its product.
    expect((await products(env)).map((x) => x.name)).toEqual(["Fine Kunafa plate.svg", "pistachio.jpg"]);
    const plan = await planOf(env);
    expect(plan.map((p) => [p.product, !!p.productLock])).toEqual([
      ["Fine Kunafa plate", true],
      ["Fine Kunafa plate", false],
      ["pistachio", false],
    ]);
    const pv = await preview(a, env);
    expect(pv.blocked).toEqual([]);
    // A later proposal leaves the locked post alone and says so.
    const again = (await json(await call(a, env, "/products/propose", { batch: "b1", drive: true }))) as unknown as { proposals: { index: number; locked: boolean; pick: { name: string; reason: string } | null }[] };
    expect(again.proposals[0]).toMatchObject({ index: 1, locked: true, pick: { name: "Fine Kunafa plate", reason: "Locked by the team." } });
    // Fill from Drive skips it too.
    const fill = (await json(await call(a, env, "/products/fill", { batch: "b1", drive: true }))) as unknown as { filled: { index: number }[] };
    expect(fill.filled.some((f) => f.index === 1)).toBe(false);
    // Unlocking keeps the product.
    const un = await call(a, env, "/products/lock", { batch: "b1", index: 1, lock: false });
    expect(un.status).toBe(200);
    const after = (await planOf(env)).find((p) => p.index === 1)!;
    expect([after.product, after.productLock]).toEqual(["Fine Kunafa plate", undefined]);
  });

  it("Choose from Drive: the picked photos join the month as product photos, like an upload", async () => {
    const env = await seed([post(1)]);
    const a = (await app()) as unknown as Hono<never>;
    const r = await call(a, env, "/products/drive", { batch: "b1", photos: [{ id: "demo-cold-brew", name: "Fine Kunafa plate" }, { id: "demo-mango", name: "Mango sunrise cup" }] });
    expect(r.status).toBe(200);
    const d = (await json(r)) as unknown as { added: string[]; failed: string[] };
    expect(d.added).toEqual(["Fine Kunafa plate", "Mango sunrise cup"]);
    expect(d.failed).toEqual([]);
    expect((await products(env)).map((x) => x.kind)).toEqual(["product", "product"]);
  });
});

describe("the state of the three choices: upload is optional once a product library is connected", () => {
  const folder = (extra: Partial<DriveFolder>): DriveFolder => ({ id: "f", name: "Photos", role: "product", approved: true, link: "", ...extra });
  it("reads the library from the folder listing: approved product folders count, waiting or brand folders do not", () => {
    expect(productLibrary([])).toEqual({ connected: false, folders: 0, demo: false });
    expect(productLibrary([folder({ approved: false })])).toEqual({ connected: false, folders: 0, demo: false });
    expect(productLibrary([folder({ role: "brand" })])).toEqual({ connected: false, folders: 0, demo: false });
    expect(productLibrary([folder({}), folder({ id: "g", default: true })])).toEqual({ connected: true, folders: 2, demo: false });
    expect(productLibrary([folder({ demo: true, default: true })])).toEqual({ connected: true, folders: 1, demo: true });
  });

  it("over the route: a client with an approved folder or a profile folder is connected; one with neither is not (outside the demo)", async () => {
    const env = await seed();
    const a = (await app()) as unknown as Hono<never>;
    // The demo Drive stands in for an unconnected client only on a preview with no credential: here it does.
    const demo = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as unknown as { folders: DriveFolder[]; demo: boolean };
    expect(demo.demo).toBe(true);
    expect(productLibrary(demo.folders).connected).toBe(true);
    // An approved folder of the team's own: the library is that folder, the demo listing steps back.
    await env.DB.prepare("INSERT INTO drive_folders (id, client, name, role, approved, added_by, created, updated) VALUES ('fold-1', 'c1', 'Habibah photos', 'product', 1, 'u1', 1, 1)").run();
    const own = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as unknown as { folders: DriveFolder[] };
    expect(own.folders.map((f) => f.id)).toEqual(["fold-1"]);
    expect(productLibrary(own.folders)).toEqual({ connected: true, folders: 1, demo: false });
    // Waiting for approval: not a library yet; the profile's folder stands in when there is one.
    await env.DB.prepare("UPDATE drive_folders SET approved = 0 WHERE id = 'fold-1'").run();
    await env.DB.prepare("INSERT INTO client_profiles (client, drive, updated) VALUES ('c1', 'https://drive.google.com/drive/folders/1vE6i36TSE9y6eFc-HH6AAJNU4yFjfTeo', 1)").run();
    const profile = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as unknown as { folders: DriveFolder[] };
    expect(profile.folders.map((f) => [f.id, f.approved, !!f.default])).toEqual([
      ["fold-1", false, false],
      ["1vE6i36TSE9y6eFc-HH6AAJNU4yFjfTeo", true, true],
    ]);
    expect(productLibrary(profile.folders)).toEqual({ connected: true, folders: 1, demo: false });
  });
});
