import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import type { User } from "../shared/types";
import { CATEGORY_RULES, FREEPIK_STOCK, freepikRoutes, isLettering, searchQuery, useFreepikFetch, type AssetJson, type DesignLayerInfo, type StockItem } from "../server/freepik";
import { FREEPIK_KEY_SETTING, FREEPIK_PLAN_SETTING, setSetting } from "../server/settings";
import { StudioError } from "../server/errors";
import { imageLayerFromAsset, setBackground } from "../shared/layer-ops";
import type { TextDesign } from "../shared/layers";

/**
 * Freepik assets as design elements: the filter chips map onto the documented search filters; a
 * vector ZIP with an SVG becomes an editable layer (sanitised, with its colours); an EPS-only
 * bundle is placed as its preview and says so; the library downloads a file once; members are
 * refused; and placing a layer or a background, then saving the design, reaches no vendor at all.
 */

type FakeEnv = ReturnType<typeof fakeEnv>;
const KEY = "FPSX0123456789abcdef0123456789abcdef";
const JSON_HEADERS = { "content-type": "application/json" };
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const enc = (s: string) => new TextEncoder().encode(s);

function app(role: "admin" | "member" = "admin") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role } as User);
    await next();
  });
  a.route("/api/studio/freepik", freepikRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function studio(role: "admin" | "member" = "admin") {
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
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
    plan: [{ index: 1, type: "offer", title: "Move your way", brief: "A runner in the studio.", caption: "", hashtags: "", headline: "MOVE YOUR WAY", subline: "" } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}

const download = async (env: FakeEnv, id: string, role: "admin" | "member" = "admin") => {
  const r = await app(role).request("/api/studio/freepik/download", { method: "POST", body: JSON.stringify({ id, client: "c1", batch: "b1", post: 1, confirm: true }), headers: JSON_HEADERS }, env);
  return { status: r.status, body: (await json(r)) as { asset: AssetJson; reused: boolean; error?: string } };
};
const use = async (env: FakeEnv, asset: string, role: "reference" | "design", who: "admin" | "member" = "admin") => {
  const r = await app(who).request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset, batch: "b1", post: 1, role, layerId: "L1" }), headers: JSON_HEADERS }, env);
  return { status: r.status, body: (await json(r)) as { layer?: DesignLayerInfo; reference?: { key: string; source?: string }; error?: string } };
};

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useFreepikFetch(null);
});
afterEach(() => {
  useFreepikFetch(null);
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("filter chips", () => {
  it("map onto the documented filters: content type, words, SVG vectors first", () => {
    const icons = searchQuery({ q: "lightning", category: "icons" });
    expect(icons.get("term")).toBe("lightning icon");
    expect(icons.get("filters[content_type][vector]")).toBe("1");
    expect(icons.get("filters[vector][type][svg]")).toBe("1");
    const type = searchQuery({ q: "sale", category: "typography" });
    expect(type.get("term")).toBe("sale lettering");
    expect(type.get("filters[vector][type][svg]")).toBe("1");
    const tex = searchQuery({ q: "", category: "textures" });
    expect(tex.get("term")).toBe("texture");
    expect(tex.get("filters[content_type][photo]")).toBe("1");
    const bg = searchQuery({ q: "pink backdrop", category: "backgrounds" });
    expect(bg.get("term")).toBe("pink backdrop background");
    expect([...bg.keys()].some((k) => k.startsWith("filters[content_type]"))).toBe(false);
    // An explicit type wins over the chip's; the chip's words are not repeated.
    const photoIcons = searchQuery({ q: "icon set", category: "icons", type: "photo" });
    expect(photoIcons.get("term")).toBe("icon set");
    expect(photoIcons.get("filters[content_type][photo]")).toBe("1");
    expect(photoIcons.has("filters[vector][type][svg]")).toBe(false);
    expect(Object.keys(CATEGORY_RULES)).toEqual(["icons", "photos", "backgrounds", "textures", "typography"]);
  });

  it("filter the demo catalogue and reach Freepik with the chip's query when a key is set", async () => {
    const env = await seed();
    const icons = (await json(await app().request("/api/studio/freepik/search?category=icons", {}, env))) as { items: StockItem[] };
    expect(icons.items.map((i) => i.id)).toEqual(["demo-4", "demo-7", "demo-8"]);
    const typo = (await json(await app().request("/api/studio/freepik/search?category=typography", {}, env))) as { items: StockItem[] };
    expect(typo.items.map((i) => i.id)).toEqual(["demo-9"]);
    expect(typo.items[0].formats).toEqual(["eps"]);
    expect((await app().request("/api/studio/freepik/search?category=stickers", {}, env)).status).toBe(400);

    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    const calls: string[] = [];
    useFreepikFetch(async (input) => {
      calls.push(String(input));
      return Response.json({ data: [], meta: { current_page: 1, last_page: 1, total: 0 } });
    });
    await app().request("/api/studio/freepik/search?q=bolt&category=icons", {}, env);
    const q = new URL(calls[0]).searchParams;
    expect(new URL(calls[0]).origin).toBe(FREEPIK_STOCK.base);
    expect(q.get("term")).toBe("bolt icon");
    expect(q.get("filters[vector][type][svg]")).toBe("1");
  });
});

describe("formats in the library", () => {
  it("a vector ZIP with an SVG: stored once, the sanitised SVG is the layer, its colours the swatches", async () => {
    const env = await seed();
    const d = await download(env, "demo-7");
    expect(d.status).toBe(200);
    expect(d.body.asset).toMatchObject({ providerId: "demo-7", mime: "application/zip", format: "SVG", contents: ["eps", "svg"], editable: true, flattened: false, lettering: false });
    expect(d.body.asset.colors).toEqual(expect.arrayContaining(["#c6f432", "#111111"]));
    expect(d.body.asset.layerSrc).toBe(`/api/studio/freepik/assets/${d.body.asset.id}/file?layer=1`);
    expect(await env.BUCKET.head("assets/demo-7.zip")).toBeTruthy();
    expect(await env.BUCKET.head("assets/demo-7.layer.svg")).toBeTruthy();

    const u = await use(env, d.body.asset.id, "design");
    expect(u.status).toBe(200);
    expect(u.body.layer).toMatchObject({ src: `/api/studio/freepik/assets/${d.body.asset.id}/file?layer=1`, editable: true, flattened: false, format: "SVG", preview: false, kind: "vector", aspect: 1 });

    // Any member reads the layer file (a design shows it): the sanitised SVG, served so it can run nothing.
    const file = await app("member").request(`/api/studio/freepik/assets/${d.body.asset.id}/file?layer=1`, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/svg+xml");
    expect(file.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    // (The fake bucket serves no body: the stored layer file is read directly.)
    const svg = await (await env.BUCKET.get("assets/demo-7.layer.svg"))!.text();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('fill="#c6f432"');
    expect(svg).not.toMatch(/<\?xml|<title>.*<script/);
  });

  it("an EPS-only bundle (decorative lettering) is placed as its preview and says the colours cannot change", async () => {
    const env = await seed();
    const d = await download(env, "demo-9");
    expect(d.body.asset).toMatchObject({ format: "EPS/AI", editable: false, colors: [], layerSrc: null, lettering: true });
    expect(d.body.asset.formatNote).toMatch(/^This file is EPS\/AI: colours cannot be changed here\./);
    const u = await use(env, d.body.asset.id, "design");
    expect(u.status).toBe(200);
    expect(u.body.layer).toMatchObject({ src: `/api/studio/freepik/assets/${d.body.asset.id}/file?preview=1`, preview: true, editable: false, colors: [], lettering: true, format: "EPS/AI" });
    expect(u.body.layer?.note).toMatch(/EPS\/AI: colours cannot be changed here/);
    // The demo preview is drawn on the server: nothing was fetched (the guard checks after each test).
    expect(await env.BUCKET.head("assets/demo-9.preview")).toBeTruthy();
  });

  it("a file stored before formats were read is read once on its next use", async () => {
    const env = await seed();
    const zip = zipSync({ "x/x.svg": enc('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#ff8800"/></svg>'), "x/x.eps": enc("%!PS-Adobe-3.0 EPSF-3.0\n") });
    await env.BUCKET.put("assets/900.zip", zip.buffer.slice(0) as ArrayBuffer, { httpMetadata: { contentType: "application/zip" } });
    await env.DB.prepare("INSERT INTO assets (id, client, source, provider_id, kind, title, author, license, preview_url, file_key, mime, width, height, flattened, added_by, created) VALUES ('a900', 'c1', 'freepik', '900', 'vector', 'Old star', 'V', '{}', '', 'assets/900.zip', 'application/zip', 10, 10, 0, 'u1', ?)").bind(Date.now()).run();
    const u = await use(env, "a900", "design");
    expect(u.body.layer).toMatchObject({ src: "/api/studio/freepik/assets/a900/file?layer=1", editable: true, colors: ["#ff8800"] });
    const row = await env.DB.prepare("SELECT format, layer_key FROM assets WHERE id = 'a900'").first<{ format: string; layer_key: string }>();
    expect(row).toEqual({ format: "zip", layer_key: "assets/900.layer.svg" });
  });

  it("an SVG asset as a post's reference uses the sanitised file and is labelled Freepik", async () => {
    const env = await seed();
    const d = await download(env, "demo-8");
    const u = await use(env, d.body.asset.id, "reference");
    expect(u.status).toBe(200);
    expect(u.body.reference?.source).toBe("freepik");
    const obj = await env.BUCKET.get(u.body.reference!.key);
    expect(await obj!.text()).toMatch(/^<svg xmlns=/);
  });

  it("names typography illustrations as lettering, never as text", () => {
    expect(isLettering("Brush lettering, SALE")).toBe(true);
    expect(isLettering("Gold text effect")).toBe(true);
    expect(isLettering("Anything", "typography")).toBe(true);
    expect(isLettering("Lightning icon")).toBe(false);
  });
});

describe("one search, one import", () => {
  it("the library downloads a Freepik file once: a second save, layer or background reuses it", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_KEY_SETTING, KEY);
    await setSetting(env, FREEPIK_PLAN_SETTING, "premium");
    const zip = zipSync({ "bolt/bolt.svg": enc('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#c6f432"/></svg>'), "bolt/bolt.eps": enc("%!PS-Adobe-3.0 EPSF-3.0\n") });
    const calls: string[] = [];
    useFreepikFetch(async (input) => {
      const url = String(input);
      calls.push(url);
      const u = new URL(url);
      if (u.host === "files.test") return new Response(zip.buffer.slice(0) as ArrayBuffer, { headers: { "content-type": "application/zip" } });
      if (u.pathname === "/v1/resources/321") return Response.json({ data: { id: 321, name: "Bolt icon", type: "vector", premium: true, preview: { url: "https://img.test/321.jpg" }, dimensions: { width: 800, height: 800 }, available_formats: { svg: {}, eps: {} }, author: { name: "V" } } });
      if (u.pathname === "/v1/resources/321/download") return Response.json({ data: { filename: "bolt.zip", url: "https://files.test/bolt.zip" } });
      throw new Error("unexpected " + url);
    });
    const first = await download(env, "321");
    expect(first.body.reused).toBe(false);
    expect(first.body.asset).toMatchObject({ format: "SVG", editable: true, colors: ["#c6f432"] });
    const again = await download(env, "321");
    expect(again.body.reused).toBe(true);
    await use(env, first.body.asset.id, "design");
    await use(env, first.body.asset.id, "design");
    expect(calls.filter((c) => c.endsWith("/download"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("files.test"))).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE provider_id = '321'").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("the whole team, server-side (24 Oct)", () => {
  it("lets a member through every Freepik action, the chips included; the layer file stays readable", async () => {
    const env = await seed();
    const d = await download(env, "demo-7");
    for (const [path, init] of [
      ["/api/studio/freepik/search?category=icons", {}],
      ["/api/studio/freepik/download", { method: "POST", body: JSON.stringify({ id: "demo-8", confirm: true }), headers: JSON_HEADERS }],
      ["/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: d.body.asset.id, batch: "b1", post: 1, role: "design" }), headers: JSON_HEADERS }],
    ] as [string, RequestInit][]) {
      const r = await app("member").request(path, init, env);
      expect(r.status, path).not.toBe(403);
    }
    expect((await app("member").request(`/api/studio/freepik/assets/${d.body.asset.id}/file?layer=1`, {}, env)).status).toBe(200);
  });
});

describe("layer and background edits are free", () => {
  it("placing an icon, recolouring it, setting a background and saving the design reaches no vendor and makes no picture", async () => {
    const env = await seed();
    const a = await studio();
    const icon = await a.request("/api/studio/freepik/download", { method: "POST", body: JSON.stringify({ id: "demo-7", client: "c1", batch: "b1", post: 1, confirm: true }), headers: JSON_HEADERS }, env);
    const iconAsset = ((await json(icon)) as { asset: AssetJson }).asset;
    const bg = (await json(await a.request("/api/studio/freepik/download", { method: "POST", body: JSON.stringify({ id: "demo-10", client: "c1", confirm: true }), headers: JSON_HEADERS }, env))) as { asset: AssetJson };
    const iconUse = (await json(await a.request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: iconAsset.id, batch: "b1", post: 1, role: "design", layerId: "Licon" }), headers: JSON_HEADERS }, env))) as { layer: DesignLayerInfo };
    const bgUse = (await json(await a.request("/api/studio/freepik/use", { method: "POST", body: JSON.stringify({ asset: bg.asset.id, batch: "b1", post: 1, role: "design", layerId: "Lbg" }), headers: JSON_HEADERS }, env))) as { layer: DesignLayerInfo };
    const tasksBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();

    // What the Text studio does in the browser: the layer, its colour, the background, then a save.
    let design: TextDesign = { version: 1, layers: [] };
    const layer = imageLayerFromAsset({ ...iconUse.layer, assetId: iconAsset.id }, 1080, 1350, () => "Licon");
    design = { ...design, layers: [{ ...layer, recolor: { "#c6f432": "#1129d3" }, rotate: 12, opacity: 0.9 }] };
    design = setBackground(design, bgUse.layer.src, { id: "Lbg", source: "freepik", asset: bg.asset.id }).design;
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    const plan = (cfg.plan ?? []).map((p) => (p.index === 1 ? { ...p, ov: { ...(p.ov ?? {}), design: { ...design, canvas: { photoScale: 0.8 } } } } : p));
    const put = await a.request("/api/studio/posts/plan", { method: "PUT", body: JSON.stringify({ batch: "b1", plan }), headers: JSON_HEADERS }, env);
    expect(put.status).toBe(200);

    const saved = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    const d = saved.plan!.find((p) => p.index === 1)!.ov!.design!;
    expect(d.layers.map((l) => l.id)).toEqual(["Lbg", "Licon"]);
    expect(d.layers[0]).toMatchObject({ behind: true, w: 1, h: 1, source: "freepik" });
    expect(d.layers[1]).toMatchObject({ recolor: { "#c6f432": "#1129d3" }, rotate: 12, opacity: 0.9, colors: expect.arrayContaining(["#c6f432"]) });
    expect(d.canvas?.photoScale).toBe(0.8);
    const tasksAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();
    expect(tasksAfter?.n).toBe(tasksBefore?.n);
    // The guard (afterEach) fails the test if any of this reached the network.
  });
});
