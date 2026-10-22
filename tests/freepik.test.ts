import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import type { User } from "../shared/types";
import { DEMO_CATALOGUE, FREEPIK_STOCK, NOT_CONNECTED, freepikRoutes, useFreepikFetch, type AssetJson, type StockItem } from "../server/freepik";
import { DEMO_TOOLS, MCP_NOT_CONNECTED, MCP_URL, freepikMcpRoutes, useMcpFetch } from "../server/freepik-mcp";
import { FREEPIK_KEY_SETTING, FREEPIK_MCP_TOKEN_SETTING, FREEPIK_PLAN_SETTING, setSetting } from "../server/settings";
import { StudioError } from "../server/errors";
import * as integrations from "../server/integrations";

/**
 * Freepik assets: with no key the demo catalogue answers and nothing is sent anywhere (the guard
 * fails the test otherwise); members are refused; a download is proposed, confirmed, stored once
 * and reused; a stored asset becomes a post's reference picture or an image layer's file; the
 * MCP adapter speaks JSON-RPC to a mocked server and says "Not connected" without a token.
 */

vi.mock("../server/integrations", async (orig) => {
  const m = (await orig()) as typeof integrations;
  return { ...m, recordIntegrationOp: vi.fn(m.recordIntegrationOp), updateIntegrationOp: vi.fn(m.updateIntegrationOp) };
});

type FakeEnv = ReturnType<typeof fakeEnv>;
const KEY = "FPSX0123456789abcdef0123456789abcdef";
const JSON_HEADERS = { "content-type": "application/json" };
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
/** A real 1×1 PNG, so the reference storage can decode it. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)).buffer;

function app(role: "admin" | "member" = "admin") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role } as User);
    await next();
  });
  a.route("/api/studio/freepik/mcp", freepikMcpRoutes);
  a.route("/api/studio/freepik", freepikRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only" } as never,
      { index: 2, type: "offer", title: "Mango days", brief: "Mango splash.", caption: "", hashtags: "", product: "mango", headline: "Mango days", subline: "" } as never,
    ],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}

async function planOf(env: FakeEnv): Promise<NonNullable<Config["plan"]>> {
  const row = (await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first()) as { config: string };
  return (JSON.parse(row.config) as Config).plan ?? [];
}

const ops = () => (integrations.recordIntegrationOp as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { kind: string; status: string; estimate?: number | null; note?: string });

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useFreepikFetch(null);
  useMcpFetch(null);
  (integrations.recordIntegrationOp as unknown as ReturnType<typeof vi.fn>).mockClear();
  (integrations.updateIntegrationOp as unknown as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useFreepikFetch(null);
  useMcpFetch(null);
});

async function download(env: FakeEnv, body: Record<string, unknown>, role: "admin" | "member" = "admin") {
  const r = await app(role).request("/api/studio/freepik/download", { method: "POST", body: JSON.stringify(body), headers: JSON_HEADERS }, env);
  return { status: r.status, body: (await json(r)) as { asset?: AssetJson; reused?: boolean; estimate?: number; needsConfirm?: boolean; blocked?: boolean; error?: string } };
}

describe("Freepik with nothing connected (demo catalogue)", () => {
  it("reports Not connected, the demo provider, the plan and what a member may do", async () => {
    const env = await seed();
    const s = await json(await app().request("/api/studio/freepik/status", {}, env));
    expect(s).toMatchObject({ connected: false, demo: true, provider: "demo", reason: NOT_CONNECTED, admin: true, plan: "unknown", downloadEstimate: 0, mcp: { connected: false }, switch: { enabled: true } });
    const m = await json(await app("member").request("/api/studio/freepik/status", {}, env));
    expect(m).toMatchObject({ admin: false, access: "Admins only for now" });
    expect(reached).toEqual([]);
  });

  it("searches the labelled fixtures with the filters and records a free op, never calling out", async () => {
    const env = await seed();
    const all = (await json(await app().request("/api/studio/freepik/search?q=", {}, env))) as { items: StockItem[]; demo: boolean; total: number };
    expect(all.demo).toBe(true);
    expect(all.items).toHaveLength(DEMO_CATALOGUE.length);
    expect(all.items[0]).toMatchObject({ id: "demo-1", kind: "photo", title: "Pistachio dessert on marble (demo)", license: { type: "freemium", attribution: true }, flattened: true, demo: true, preview: "/api/studio/freepik/demo/demo-1.svg" });
    const mango = (await json(await app().request("/api/studio/freepik/search?q=mango", {}, env))) as { items: StockItem[] };
    expect(mango.items.map((i) => i.id)).toEqual(["demo-6"]);
    const vectors = (await json(await app().request("/api/studio/freepik/search?type=vector", {}, env))) as { items: StockItem[] };
    expect(vectors.items.map((i) => i.kind)).toEqual(["vector", "vector"]);
    expect(vectors.items[0].flattened).toBe(false);
    const portraitGreen = (await json(await app().request("/api/studio/freepik/search?orientation=portrait&color=green", {}, env))) as { items: StockItem[] };
    expect(portraitGreen.items.map((i) => i.id)).toEqual(["demo-1"]);
    const templates = (await json(await app().request("/api/studio/freepik/search?type=template", {}, env))) as { items: StockItem[] };
    expect(templates.items.map((i) => i.id)).toEqual(["demo-5"]);
    const bad = await app().request("/api/studio/freepik/search?color=beige", {}, env);
    expect(bad.status).toBe(400);
    expect(ops().filter((o) => o.kind === "search")).toHaveLength(5);
    expect(ops().every((o) => o.estimate === 0)).toBe(true);
    const card = await app().request("/api/studio/freepik/demo/demo-1.svg", {}, env);
    expect(card.headers.get("content-type")).toBe("image/svg+xml");
    expect(await card.text()).toContain("DEMO FIXTURE");
    expect(reached).toEqual([]);
  });

  it("refuses a member everywhere but the status and a stored file", async () => {
    const env = await seed();
    for (const [path, init] of [
      ["/api/studio/freepik/search?q=mango", {}],
      ["/api/studio/freepik/resource/demo-1", {}],
      ["/api/studio/freepik/assets?client=c1", {}],
      ["/api/studio/freepik/download", { method: "POST", body: JSON.stringify({ id: "demo-1", confirm: true }), headers: JSON_HEADERS }],
      ["/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: "x", batch: "b1", post: 1, role: "reference" }), headers: JSON_HEADERS }],
      ["/api/studio/freepik/mcp/tools", {}],
      ["/api/studio/freepik/mcp/call", { method: "POST", body: JSON.stringify({ tool: "stock_search", arguments: {} }), headers: JSON_HEADERS }],
    ] as [string, RequestInit][]) {
      const r = await app("member").request(path, init, env);
      expect(r.status, path).toBe(403);
      expect(((await json(r)) as { error: string }).error).toMatch(/Admins only for now/);
    }
    expect(reached).toEqual([]);
  });

  it("proposes a download, stores it once on confirm, and reuses the file afterwards", async () => {
    const env = await seed();
    const proposed = await download(env, { id: "demo-6", client: "c1", batch: "b1", post: 2 });
    expect(proposed.status).toBe(409);
    expect(proposed.body).toMatchObject({ needsConfirm: true, estimate: 0 });
    expect(proposed.body.asset).toMatchObject({ providerId: "demo-6", stored: false, file: null });
    expect(ops().filter((o) => o.kind === "download").map((o) => o.status)).toEqual(["proposed"]);

    const done = await download(env, { id: "demo-6", client: "c1", batch: "b1", post: 2, confirm: true });
    expect(done.status).toBe(200);
    expect(done.body.reused).toBe(false);
    expect(done.body.asset).toMatchObject({ providerId: "demo-6", kind: "photo", stored: true, mime: "image/svg+xml", client: "c1", demo: true, license: { type: "freemium", attribution: true } });
    expect(done.body.asset!.file).toBe(`/api/studio/freepik/assets/${done.body.asset!.id}/file`);
    expect(await env.BUCKET.head("assets/demo-6.svg")).toBeTruthy();
    const writes = env.BUCKET.objects.size;

    const again = await download(env, { id: "demo-6", confirm: true });
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(again.body.asset!.id).toBe(done.body.asset!.id);
    expect(env.BUCKET.objects.size).toBe(writes);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const downloads = ops().filter((o) => o.kind === "download");
    expect(downloads.map((o) => o.status)).toEqual(["proposed", "running", "done"]);
    expect(downloads[2]?.note).toMatch(/Reused/);
    expect((integrations.updateIntegrationOp as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ status: "done", reported: 0 });

    const list = (await json(await app().request("/api/studio/freepik/assets?client=c1", {}, env))) as { assets: AssetJson[] };
    expect(list.assets.map((a) => a.providerId)).toEqual(["demo-6"]);
    const file = await app("member").request(`/api/studio/freepik/assets/${done.body.asset!.id}/file`, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/svg+xml");
    expect(reached).toEqual([]);
  });

  it("attaches a stored asset as the post's reference picture and records the use", async () => {
    const env = await seed();
    const d = await download(env, { id: "demo-1", client: "c1", confirm: true });
    const before = (await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: "nope", batch: "b1", post: 1, role: "reference" }), headers: JSON_HEADERS }, env)).status;
    expect(before).toBe(404);
    const r = await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: d.body.asset!.id, batch: "b1", post: 1, role: "reference" }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    const out = (await json(r)) as { reference: { key: string; thumb: string; name: string }; use: { role: string; post: number } };
    expect(out.use).toMatchObject({ role: "reference", post: 1 });
    expect(out.reference.key).toMatch(/^styles\/.+\.svg$/);
    expect(out.reference.name).toBe("Pistachio dessert on marble (demo)");
    const plan = await planOf(env);
    expect(plan.find((p) => p.index === 1)?.reference?.key).toBe(out.reference.key);
    expect(plan.find((p) => p.index === 2)?.reference).toBeUndefined();
    expect(await env.BUCKET.head(out.reference.key)).toBeTruthy();
    const uses = await env.DB.prepare("SELECT asset, batch, post, role, layer_id FROM asset_uses").all<{ asset: string; batch: string; post: number; role: string; layer_id: string | null }>();
    expect(uses.results).toEqual([{ asset: d.body.asset!.id, batch: "b1", post: 1, role: "reference", layer_id: null }]);
    expect(ops().filter((o) => o.kind === "use")).toHaveLength(1);
    expect(reached).toEqual([]);
  });

  it("makes a thumbnail for a raster asset used as a reference, through the reference storage", async () => {
    const env = await seed();
    const t = Date.now();
    await env.BUCKET.put("assets/555.png", PNG, { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare("INSERT INTO assets (id, client, source, provider_id, kind, title, author, license, preview_url, file_key, mime, width, height, flattened, added_by, created) VALUES ('a555', 'c1', 'freepik', '555', 'photo', 'Marble top', 'Someone', '{\"type\":\"premium\",\"attribution\":false,\"uses\":[]}', 'https://img.test/555.jpg', 'assets/555.png', 'image/png', 1, 1, 1, 'u1', ?)").bind(t).run();
    const r = await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: "a555", batch: "b1", post: 2, role: "reference" }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    const out = (await json(r)) as { reference: { key: string; thumb: string } };
    expect(out.reference.key).toMatch(/^styles\/.+\.png$/);
    expect(out.reference.thumb).toMatch(/^styles\/.+-thumb\.jpg$/);
    expect(await env.BUCKET.head(out.reference.thumb)).toBeTruthy();
    expect(reached).toEqual([]);
  });

  it("answers the layer file for a design use, records the layer, and refuses a bundle", async () => {
    const env = await seed();
    const d = await download(env, { id: "demo-3", client: "c1", confirm: true });
    const r = await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: d.body.asset!.id, batch: "b1", post: 1, slide: 2, role: "design", layerId: "L1" }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    const out = (await json(r)) as { layer: { src: string; name: string; flattened: boolean }; use: { layerId: string; slide: number } };
    expect(out.layer).toEqual({ src: `/api/studio/freepik/assets/${d.body.asset!.id}/file`, name: "Lantern pattern, Ramadan (demo)", flattened: false, layerable: true });
    expect(out.use).toMatchObject({ layerId: "L1", slide: 2 });
    const uses = await env.DB.prepare("SELECT role, layer_id, slide FROM asset_uses").all<{ role: string; layer_id: string; slide: number }>();
    expect(uses.results).toEqual([{ role: "design", layer_id: "L1", slide: 2 }]);
    expect((await planOf(env)).find((p) => p.index === 1)?.reference).toBeUndefined();

    // A bundle (a vector's ZIP) with no preview picture is refused for both roles.
    await env.BUCKET.put("assets/777.zip", new Uint8Array([80, 75, 3, 4]).buffer, { httpMetadata: { contentType: "application/zip" } });
    await env.DB.prepare("INSERT INTO assets (id, client, source, provider_id, kind, title, author, license, preview_url, file_key, mime, width, height, flattened, added_by, created) VALUES ('a777', 'c1', 'freepik', '777', 'vector', 'Badges', 'V', '{}', '', 'assets/777.zip', 'application/zip', 1, 1, 0, 'u1', ?)").bind(Date.now()).run();
    for (const role of ["design", "reference"]) {
      const z = await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: "a777", batch: "b1", post: 1, role }), headers: JSON_HEADERS }, env);
      expect(z.status, role).toBe(415);
    }
    expect(reached).toEqual([]);
  });

  it("a bundle with a preview picture is used through that picture: fetched once, kept next to the bundle, flattened", async () => {
    const env = await seed();
    await env.BUCKET.put("assets/778.zip", new Uint8Array([80, 75, 3, 4]).buffer, { httpMetadata: { contentType: "application/zip" } });
    await env.DB.prepare("INSERT INTO assets (id, client, source, provider_id, kind, title, author, license, preview_url, file_key, mime, width, height, flattened, added_by, created) VALUES ('a778', 'c1', 'freepik', '778', 'vector', 'Halloween word logo', 'V', '{}', 'https://img.freepik.test/preview/778.jpg', 'assets/778.zip', 'application/zip', 1, 1, 0, 'u1', ?)").bind(Date.now()).run();
    let fetched = 0;
    useFreepikFetch(async (input) => {
      const url = String(input);
      if (url === "https://img.freepik.test/preview/778.jpg") {
        fetched++;
        return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error("unexpected " + url);
    });
    try {
      const ref = await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: "a778", batch: "b1", post: 1, role: "reference" }), headers: JSON_HEADERS }, env);
      expect(ref.status).toBe(200);
      const out = (await json(ref)) as { reference: { name: string; key: string } };
      expect(out.reference.name).toBe("Halloween word logo (preview picture)");
      expect(await env.BUCKET.head("assets/778.preview")).toBeTruthy();
      const design = await app().request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: "a778", batch: "b1", post: 1, role: "design", layerId: "L2" }), headers: JSON_HEADERS }, env);
      expect(design.status).toBe(200);
      const d = (await json(design)) as { layer: { src: string; flattened: boolean; layerable: boolean } };
      expect(d.layer).toMatchObject({ src: "/api/studio/freepik/assets/a778/file?preview=1", flattened: true, layerable: true });
      expect(fetched).toBe(1);
      const file = await app().request("/api/studio/freepik/assets/a778/file?preview=1", {}, env);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/png");
    } finally {
      useFreepikFetch(null);
    }
    expect(reached).toEqual([]);
  });
});

/** A Freepik stand-in: the documented list, detail and download shapes, and the file host. */
function freepikStub() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const u = new URL(url);
    if (u.host === "files.test") return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    expect(u.origin).toBe(FREEPIK_STOCK.base);
    expect((init?.headers as Record<string, string>)["x-magnific-api-key"]).toBe(KEY);
    if (u.pathname === "/v1/resources")
      return Response.json({
        data: [
          { id: 123, title: "Kunafa on marble", url: "https://www.freepik.com/premium-photo/kunafa_123.htm", filename: "kunafa.jpg", licenses: [{ type: "premium", url: "https://www.freepik.com/legal/terms-of-use" }], image: { type: "photo", orientation: "vertical", source: { url: "https://img.test/123.jpg", size: "740x1110" } }, author: { name: "Studio A" }, meta: { available_formats: { jpg: { total: 1, items: [] } } } },
          { id: 456, title: "Lantern set", url: "https://www.freepik.com/free-vector/lantern_456.htm", licenses: [{ type: "freemium", url: "https://www.freepik.com/legal/terms-of-use" }], image: { type: "vector", orientation: "square", source: { url: "https://img.test/456.jpg", size: "626x626" } }, author: { name: "Vectorist" }, meta: { available_formats: { ai: {}, eps: {}, svg: {} } } },
        ],
        meta: { current_page: 1, last_page: 7, total: 150, clean_search: true },
      });
    if (u.pathname === "/v1/resources/123")
      return Response.json({ data: { id: 123, name: "Kunafa on marble", type: "photo", vertical: "photo", url: "https://www.freepik.com/premium-photo/kunafa_123.htm", license: "https://www.freepik.com/legal/terms-of-use", premium: true, preview: { url: "https://img.test/123.jpg", width: 740, height: 1110 }, dimensions: { width: 4000, height: 6000 }, available_formats: { jpg: { total: 1, items: [] } }, author: { name: "Studio A" } } });
    if (u.pathname === "/v1/resources/123/download") return Response.json({ data: { filename: "kunafa_123.jpg", url: "https://files.test/kunafa_123.jpg", signed_url: null } });
    return new Response(JSON.stringify({ message: "Resource not found" }), { status: 404, headers: JSON_HEADERS });
  };
  return { fn, calls };
}

describe("Freepik with a key", () => {
  it("sends the documented search query and maps the list items", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    const stub = freepikStub();
    useFreepikFetch(stub.fn);
    const r = (await json(await app().request("/api/studio/freepik/search?q=kunafa&type=photo&orientation=portrait&color=green&page=2", {}, env))) as { items: StockItem[]; demo: boolean; lastPage: number; total: number; connected: boolean; downloadEstimate: number | null };
    const q = new URL(stub.calls[0].url).searchParams;
    expect(q.get("term")).toBe("kunafa");
    expect(q.get("filters[content_type][photo]")).toBe("1");
    expect(q.get("filters[orientation][portrait]")).toBe("1");
    expect(q.get("filters[color]")).toBe("green");
    expect(q.get("page")).toBe("2");
    expect(r).toMatchObject({ demo: false, connected: true, lastPage: 7, total: 150, downloadEstimate: null });
    expect(r.items[0]).toMatchObject({ id: "123", kind: "photo", title: "Kunafa on marble", author: "Studio A", license: { type: "premium", attribution: false, url: "https://www.freepik.com/legal/terms-of-use" }, preview: "https://img.test/123.jpg", width: 740, height: 1110, orientation: "portrait", flattened: true, formats: ["jpg"] });
    expect(r.items[1]).toMatchObject({ id: "456", kind: "vector", license: { type: "freemium", attribution: true }, flattened: false, formats: ["ai", "eps", "svg"] });
    expect(reached).toEqual([]);
  });

  it("blocks a download while the plan (and so the cost) is not known, then downloads once the plan says it is included", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    const stub = freepikStub();
    useFreepikFetch(stub.fn);
    const blocked = await download(env, { id: "123", client: "c1", confirm: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ blocked: true, plan: "unknown" });
    expect(blocked.body.error).toMatch(/Cost not known/);
    expect(stub.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/resources/123"]);
    expect(ops().filter((o) => o.kind === "download").map((o) => o.status)).toEqual(["refused"]);

    const plan = await app().request("/api/studio/freepik/plan", { method: "POST", body: JSON.stringify({ plan: "premium" }), headers: JSON_HEADERS }, env);
    expect(await json(plan)).toMatchObject({ ok: true, plan: "premium", downloadEstimate: 0 });
    const proposed = await download(env, { id: "123", client: "c1" });
    expect(proposed.status).toBe(409);
    expect(proposed.body).toMatchObject({ needsConfirm: true, estimate: 0 });
    const done = await download(env, { id: "123", client: "c1", confirm: true });
    expect(done.status).toBe(200);
    expect(done.body.asset).toMatchObject({ providerId: "123", kind: "photo", title: "Kunafa on marble", stored: true, mime: "image/png", flattened: true, width: 4000, height: 6000, license: { type: "premium", attribution: false } });
    expect(stub.calls.map((c) => new URL(c.url).pathname).slice(-2)).toEqual(["/v1/resources/123/download", "/kunafa_123.jpg"]);
    expect(await env.BUCKET.head("assets/123.png")).toBeTruthy();
    const again = await download(env, { id: "123", confirm: true });
    expect(again.body.reused).toBe(true);
    expect(stub.calls.filter((c) => c.url.includes("/download"))).toHaveLength(1);
    expect(reached).toEqual([]);
  });

  it("bills nothing and knows nothing on a Business plan: the download stays blocked with the reason", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    await setSetting(env, FREEPIK_PLAN_SETTING, "business");
    useFreepikFetch(freepikStub().fn);
    const r = await download(env, { id: "123", confirm: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Business or Enterprise/);
    expect(reached).toEqual([]);
  });
});

/** A Magnific MCP stand-in over the streamable HTTP transport: JSON answers, a session id, two tool pages. */
function mcpStub(opts: { sse?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const answer = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
    opts.sse
      ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
      : Response.json({ jsonrpc: "2.0", id, result }, { headers });
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://files.test/")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    expect(url).toBe(MCP_URL);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_0123456789abcdefghij");
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    calls.push({ method: body.method, params: body.params, headers });
    if (body.method === "initialize") return answer(body.id, { protocolVersion: "2025-06-18", serverInfo: { name: "magnific", version: "1" }, capabilities: { tools: {} } }, { "mcp-session-id": "sess-1" });
    expect(headers["Mcp-Session-Id"]).toBe("sess-1");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list")
      return body.params.cursor
        ? answer(body.id, { tools: [{ name: "images_generate", description: "Make a picture", inputSchema: { type: "object" } }, { name: "stock_download", description: "Download", inputSchema: { type: "object" } }] })
        : answer(body.id, { tools: [{ name: "stock_search", description: "Search stock", inputSchema: { type: "object" } }, { name: "simulate_cost", description: "Estimate" }], nextCursor: "p2" });
    if (body.method === "tools/call") {
      const name = body.params.name as string;
      const args = body.params.arguments as Record<string, unknown>;
      if (name === "stock_search") return answer(body.id, { content: [{ type: "text", text: JSON.stringify({ items: [{ id: 123, title: "Kunafa on marble", type: "photo", preview: "https://img.test/123.jpg", license: "premium", author: { name: "Studio A" } }], relatedKeywords: ["dessert"] }) }] });
      if (name === "simulate_cost") return answer(body.id, { content: [{ type: "text", text: args.tool === "images_generate" ? "This call costs 12 credits." : "unknown" }] });
      if (name === "images_generate") return answer(body.id, { content: [{ type: "text", text: "Generated creation 9" }] });
      if (name === "stock_download") return answer(body.id, { content: [{ type: "text", text: JSON.stringify({ id: 123, url: "https://files.test/kunafa_123.png", filename: "kunafa_123.png" }) }] });
      return answer(body.id, { content: [{ type: "text", text: "no such tool" }], isError: true });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  };
  return { fn, calls };
}

async function call(env: FakeEnv, body: Record<string, unknown>) {
  const r = await app().request("/api/studio/freepik/mcp/call", { method: "POST", body: JSON.stringify(body), headers: JSON_HEADERS }, env);
  return { status: r.status, body: (await json(r)) as Record<string, unknown> & { assets?: AssetJson[]; error?: string } };
}

describe("Magnific MCP adapter", () => {
  it("says Not connected without a token and lists the labelled demo tools", async () => {
    const env = await seed();
    const t = (await json(await app().request("/api/studio/freepik/mcp/tools", {}, env))) as { connected: boolean; demo: boolean; reason: string; tools: typeof DEMO_TOOLS };
    expect(t).toMatchObject({ connected: false, demo: true, reason: MCP_NOT_CONNECTED });
    expect(t.tools.map((x) => x.name)).toEqual(DEMO_TOOLS.map((x) => x.name));
    expect(t.tools.every((x) => x.demo)).toBe(true);
    const c = await call(env, { tool: "stock_search", arguments: { query: "mango" } });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ connected: false, error: MCP_NOT_CONNECTED });
    expect(reached).toEqual([]);
  });

  it("verifies a token with initialize and tools/list before saving it", async () => {
    const env = await seed();
    const stub = mcpStub();
    useMcpFetch(stub.fn);
    const r = await app().request("/api/studio/freepik/mcp/token", { method: "POST", body: JSON.stringify({ token: "tok_0123456789abcdefghij" }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ ok: true, server: { name: "magnific" }, tools: 4 });
    expect(stub.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(stub.calls[0].headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    const s = await json(await app().request("/api/studio/freepik/status", {}, env));
    expect(s).toMatchObject({ mcp: { connected: true } });
    expect(reached).toEqual([]);
  });

  it("initialises, pages tools/list, classifies costs, and reads event-stream answers too", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, "tok_0123456789abcdefghij");
    const stub = mcpStub({ sse: true });
    useMcpFetch(stub.fn);
    const t = (await json(await app().request("/api/studio/freepik/mcp/tools", {}, env))) as { connected: boolean; tools: { name: string; cost: string }[] };
    expect(t.connected).toBe(true);
    expect(t.tools.map((x) => [x.name, x.cost])).toEqual([["stock_search", "free"], ["simulate_cost", "free"], ["images_generate", "credits"], ["stock_download", "download"]]);
    expect(stub.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(stub.calls[3].params).toEqual({ cursor: "p2" });
    expect(reached).toEqual([]);
  });

  it("runs a browsing tool at once and brings its stock items into the one library", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, "tok_0123456789abcdefghij");
    const stub = mcpStub();
    useMcpFetch(stub.fn);
    const c = await call(env, { tool: "stock_search", arguments: { query: "kunafa" }, client: "c1" });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ ok: true, cost: "free", estimate: 0 });
    expect(c.body.assets).toHaveLength(1);
    expect(c.body.assets![0]).toMatchObject({ providerId: "123", title: "Kunafa on marble", kind: "photo", stored: false, preview: "https://img.test/123.jpg", license: { type: "premium", attribution: false }, client: "c1" });
    expect(stub.calls.filter((x) => x.method === "tools/call").map((x) => x.params.name)).toEqual(["stock_search"]);
    expect(ops().filter((o) => o.kind === "mcp:stock_search")).toHaveLength(1);
    expect(reached).toEqual([]);
  });

  it("estimates a generative tool with simulate_cost, asks for confirmation, then runs it", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, "tok_0123456789abcdefghij");
    const stub = mcpStub();
    useMcpFetch(stub.fn);
    const ask = await call(env, { tool: "images_generate", arguments: { prompt: "a mango" } });
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ needsConfirm: true, estimate: 12, cost: "credits" });
    expect(stub.calls.filter((x) => x.method === "tools/call").map((x) => x.params.name)).toEqual(["simulate_cost"]);
    const run = await call(env, { tool: "images_generate", arguments: { prompt: "a mango" }, confirm: true });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ ok: true, estimate: 12 });
    expect(stub.calls.filter((x) => x.method === "tools/call").map((x) => x.params.name)).toEqual(["simulate_cost", "simulate_cost", "images_generate"]);
    const unknown = await call(env, { tool: "video_generate", arguments: {}, confirm: true });
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ blocked: true });
    expect(ops().filter((o) => o.kind === "mcp:images_generate").map((o) => o.status)).toEqual(["proposed", "running"]);
    expect(reached).toEqual([]);
  });

  it("stores an MCP stock download on the same library row the search made", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, "tok_0123456789abcdefghij");
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    await setSetting(env, FREEPIK_PLAN_SETTING, "premium");
    const stub = mcpStub();
    useMcpFetch(stub.fn);
    useFreepikFetch(stub.fn);
    await call(env, { tool: "stock_search", arguments: { query: "kunafa" } });
    const ask = await call(env, { tool: "stock_download", arguments: { id: 123 } });
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ needsConfirm: true, estimate: 0, cost: "download" });
    const dl = await call(env, { tool: "stock_download", arguments: { id: 123 }, confirm: true });
    expect(dl.status).toBe(200);
    expect(dl.body.assets![0]).toMatchObject({ providerId: "123", title: "Kunafa on marble", stored: true, mime: "image/png" });
    expect(await env.BUCKET.head("assets/123.png")).toBeTruthy();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(reached).toEqual([]);
  });

  it("refuses a bad token with a clear message", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, "tok_0123456789abcdefghij");
    useMcpFetch(async () => new Response(JSON.stringify({ message: "Unauthenticated." }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' } }));
    const t = await app().request("/api/studio/freepik/mcp/tools", {}, env);
    expect(t.status).toBe(401);
    expect(((await json(t)) as { error: string }).error).toMatch(/refused the token/);
    expect(reached).toEqual([]);
  });
});
