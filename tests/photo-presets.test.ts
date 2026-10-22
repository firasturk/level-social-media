/**
 * The Photo studio's preset gallery (server/photo-presets.ts) against stand-ins for the Higgsfield
 * and Magnific MCPs: Soul styles, product shots, Magnific looks and recipes normalised into
 * picture cards (pseudo entries and video entries dropped), a day's cache in an encrypted settings
 * row with `?refresh=1`, members browsing and refused to run, a product-shot run that needs the
 * confirm (a known price, or "cost not known"), `execute_preset` → a job → `jobs_wait` → the
 * picture under the post's output prefix. No call leaves the test: the guard fails it on any fetch
 * the stubs did not answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, HERO, higgsfieldStub, json, magnificStub, MAGNIFIC_TOKEN, ops, postJson, PRODUCT_SHOTS, seed, signedInHiggsfield, SOUL_STYLES, type FakeEnv } from "./support/photo-mcp";
import { PHOTO_PRESET_CATEGORIES } from "../shared/photo-presets";
import { resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { MCP_NOT_CONNECTED, useMcpFetch } from "../server/freepik-mcp";
import { resetPresetCaches } from "../server/video-presets";
import { isRealEntry, parseMagnificLooks, parsePhotoRecipes, parseProductShots, parseSoulStyles, photoCacheKey, resetPhotoPresetCaches, saysVideo } from "../server/photo-presets";
import { resetPhotoToolCaches } from "../server/photo-tools";
import { getSetting, setSetting, FREEPIK_MCP_TOKEN_SETTING } from "../server/settings";
import { setIntegrationSwitch } from "../server/integrations";

const text = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const browse = (env: FakeEnv, qs: string, role: "admin" | "member" = "member") => app(role).request(`/api/studio/photo/presets?${qs}`, {}, env);
const listJobs = async (env: FakeEnv) => ((await json(await app().request("/api/studio/photo/tools/jobs?batch=b1&index=1", {}, env))) as { jobs: { id: string; status: string; output: string | null; estimate: number | null; reported: number | null; label: string; tool: string }[] }).jobs;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  useMcpFetch(null);
  resetHiggsfieldMcpCaches();
  resetPresetCaches();
  resetPhotoPresetCaches();
  resetPhotoToolCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useHiggsfieldMcpFetch(null);
  useMcpFetch(null);
});

describe("normalising the answers into picture cards", () => {
  it("reads Soul styles with their sample picture and drops the pseudo entries, the video style and the one with no sample", () => {
    const cards = parseSoulStyles(text({ presets: SOUL_STYLES }));
    expect(cards.map((c) => c.id)).toEqual(["soul_film", "soul_editorial"]);
    expect(cards[0]).toMatchObject({ kind: "style", source: "soul", provider: "higgsfield", title: "Film grain", image: "https://cdn.test/soul/film.jpg", runnable: false, prompt: "film photograph, soft grain" });
    expect(cards[0].use).toEqual({ provider: "higgsfield", tool: "hf-generate", options: { styleId: "soul_film", prompt: "film photograph, soft grain" } });
    expect(cards[1].image).toBe("https://cdn.test/soul/editorial.webp");
    expect(isRealEntry({ id: "all", name: "All", preview_url: "https://x.test/a.jpg" }, true)).toBe(false);
    expect(isRealEntry({ id: "effects", name: "Effects", preview_url: "https://x.test/a.jpg" }, true)).toBe(false);
    expect(saysVideo({ type: "video" })).toBe(true);
    expect(saysVideo({ description: "A clip of the product turning" })).toBe(true);
    expect(saysVideo({ type: "image", description: "A clip of the product turning" })).toBe(false);
  });

  it("reads product-shot presets (picture output, runnable) and drops the video preset, the category name and the entry without a preview", () => {
    const cards = parseProductShots(text({ presets: PRODUCT_SHOTS }));
    expect(cards.map((c) => c.id)).toEqual(["hero_shot"]);
    expect(cards[0]).toMatchObject({ kind: "preset", source: "marketing_studio", title: "Hero Shot", command: "/hero-shot", image: "https://cdn.test/presets/hero.jpg", price: 6, needs: ["1 product picture"], runnable: true, use: null });
  });

  it("reads Magnific looks: a sample when the entry has one, the name alone when it has none, the video model dropped", () => {
    const looks = parseMagnificLooks(text({ models: [{ slug: "mystic", name: "Mystic", description: "Photoreal", sample: "https://cdn.test/mg/mystic.jpg" }, { slug: "flux-video", name: "Flux video" }] }), text({ presets: [{ id: "portrait", name: "Portrait", preview: "https://cdn.test/mg/portrait.jpg" }, { id: "product", name: "Product" }] }));
    expect(looks.map((l) => [l.id, l.image])).toEqual([
      ["portrait", "https://cdn.test/mg/portrait.jpg"],
      ["product", null],
      ["mystic", "https://cdn.test/mg/mystic.jpg"],
    ]);
    expect(looks[0].use).toEqual({ provider: "magnific", tool: "mg-upscale", options: { preset: "portrait" } });
    expect(looks[2].use).toEqual({ provider: "magnific", tool: "mg-restyle", options: { model: "mystic" } });
  });

  it("keeps the picture recipes and drops the video one", () => {
    const recipes = parsePhotoRecipes(text({ recipes: [{ command: "/hero-shot", title: "Hero shot", description: "A product picture.", prompt: "hero shot" }, { command: "/reel-cover", title: "Reel cover", description: "A cover picture for a reel." }, { slash: "katana/launch-day", title: "Launch day", description: "A six-shot video production." }] }));
    expect(recipes.map((r) => r.id)).toEqual(["/hero-shot", "/reel-cover"]);
    expect(recipes[0]).toMatchObject({ kind: "recipe", runnable: false, use: { provider: "higgsfield", tool: "hf-generate", options: { prompt: "hero shot" } } });
    expect(recipes[1].use).toBeNull();
  });
});

describe("browsing the gallery", () => {
  it("says Not signed in with no call before the sign-in, lists the four categories, refuses an unknown one", async () => {
    const env = await seed();
    const r = await json(await browse(env, "category=styles"));
    expect(r).toMatchObject({ signedIn: false, items: [], reason: expect.stringMatching(/^Not signed in: Connection → Higgsfield/), admin: false, provider: "higgsfield" });
    expect((r.categories as unknown[]).length).toBe(PHOTO_PRESET_CATEGORIES.length);
    const looks = await json(await browse(env, "category=magnific-looks"));
    expect(looks).toMatchObject({ signedIn: false, items: [], reason: MCP_NOT_CONNECTED, provider: "magnific" });
    expect(await browse(env, "category=nope")).toHaveProperty("status", 400);
  });

  it("lets a member browse the styles, caches them a day in an encrypted row, asks again only on refresh, and maps the other categories to their asks", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const r = (await json(await browse(env, "category=styles"))) as { items: { id: string; image: string }[]; cached: boolean; signedIn: boolean; admin: boolean };
    expect(r).toMatchObject({ signedIn: true, admin: false, cached: false });
    expect(r.items.map((i) => i.id)).toEqual(["soul_film", "soul_editorial"]);
    expect(r.items[0].image).toBe("https://cdn.test/soul/film.jpg");
    expect(stub.rpc.filter((x) => x.name === "get_presets").map((x) => x.args)).toEqual([{ source: "soul", limit: 50 }]);
    const raw = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(photoCacheKey("styles", "")).first<{ value: string }>();
    expect(raw?.value).toBeTruthy();
    expect(raw!.value).not.toContain("Film grain");
    expect(JSON.parse((await getSetting(env, photoCacheKey("styles", "")))!).items).toHaveLength(2);
    expect((await json(await browse(env, "category=styles"))).cached).toBe(true);
    resetPhotoPresetCaches();
    expect((await json(await browse(env, "category=styles"))).cached).toBe(true);
    expect(stub.rpc.filter((x) => x.name === "get_presets")).toHaveLength(1);
    await browse(env, "category=styles&refresh=1");
    expect(stub.rpc.filter((x) => x.name === "get_presets")).toHaveLength(2);
    const shots = (await json(await browse(env, "category=product-shots"))) as { items: { id: string; runnable: boolean }[] };
    expect(shots.items.map((i) => i.id)).toEqual(["hero_shot"]);
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).toEqual({ source: "marketing_studio", category: "product-shot", limit: 50 });
    await browse(env, "category=product-shots&q=hero");
    expect(stub.rpc.filter((x) => x.name === "get_presets").at(-1)?.args).toEqual({ source: "marketing_studio", category: "product-shot", query: "hero", limit: 50 });
    const recipes = (await json(await browse(env, "category=recipes"))) as { items: { id: string; source: string }[] };
    expect(stub.rpc.filter((x) => x.name === "get_preset_instructions").at(-1)?.args).toEqual({});
    expect(recipes.items.map((i) => i.id)).toEqual(["/hero-shot", "/reel-cover"]);
    const browsed = (await ops(env)).results.filter((o) => o.kind === "preset.browse");
    expect(browsed.length).toBe(5);
    expect(browsed.every((o) => o.provider === "higgsfield" && o.estimate === 0 && o.status === "done" && /photo/.test(o.note))).toBe(true);
  });

  it("lists Magnific looks from the models and upscale presets once connected, saying when there is no sample", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const r = (await json(await browse(env, "category=magnific-looks"))) as { items: { id: string; image: string | null; kind: string; category: string }[]; signedIn: boolean };
    expect(r.signedIn).toBe(true);
    expect(r.items.map((i) => [i.id, i.image])).toEqual([
      ["portrait", "https://cdn.test/mg/portrait.jpg"],
      ["product", null],
      ["mystic", "https://cdn.test/mg/mystic.jpg"],
    ]);
    expect(stub.rpc.filter((x) => x.name === "images_models_list")).toHaveLength(1);
    expect(stub.rpc.filter((x) => x.name === "images_upscale_presets_list")).toHaveLength(1);
    expect((await ops(env)).results.filter((o) => o.kind === "preset.browse" && o.provider === "freepik")).toHaveLength(1);
    await setIntegrationSwitch(env, "freepik", false);
    resetPhotoPresetCaches();
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(photoCacheKey("magnific-looks", "")).run();
    const off = (await json(await browse(env, "category=magnific-looks"))) as { items: unknown[]; reason: string };
    expect(off.items).toEqual([]);
    expect(off.reason).toMatch(/switched off/);
  });

  it("opens a product shot with its inputs, instructions and, for an admin on a post, the readiness with the picture prefilled; a style opens from the cached list", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const asMember = (await json(await app("member").request("/api/studio/photo/presets/hero_shot?source=marketing_studio", {}, env))) as { preset: Record<string, unknown>; admin: boolean };
    expect(asMember.admin).toBe(false);
    expect(asMember.preset).toMatchObject({ id: "hero_shot", kind: "preset", title: "Hero Shot", command: "/hero-shot", price: 6, needs: ["1 product picture"], runnable: true, image: "https://cdn.test/presets/hero.jpg", readiness: { ready: false, missing: ["product_image"] } });
    expect(asMember.preset.instructions).toMatch(/How \/hero-shot works/);
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(0);
    const asAdmin = (await json(await app().request("/api/studio/photo/presets/hero_shot?source=marketing_studio&batch=b1&index=1", {}, env))) as { preset: Record<string, unknown>; readinessError: string };
    expect(asAdmin.readinessError).toBe("");
    expect(asAdmin.preset.readiness).toEqual({ ready: true, missing: [] });
    expect(stub.rpc.filter((x) => x.name === "get_presets" && x.args?.initial_inputs)[0]?.args).toMatchObject({ preset_id: "hero_shot", source: "marketing_studio", initial_inputs: { product_image: [{ id: "med_1", type: "image" }] } });
    expect(await app("member").request("/api/studio/photo/presets/soul_film?source=soul", {}, env)).toHaveProperty("status", 404);
    await browse(env, "category=styles");
    const style = (await json(await app("member").request("/api/studio/photo/presets/soul_film?source=soul", {}, env))) as { preset: Record<string, unknown> };
    expect(style.preset).toMatchObject({ id: "soul_film", kind: "style", use: { tool: "hf-generate" } });
    const recipe = (await json(await app("member").request(`/api/studio/photo/presets/${encodeURIComponent("/hero-shot")}?source=recipe`, {}, env))) as { preset: Record<string, unknown> };
    expect(recipe.preset).toMatchObject({ kind: "recipe", command: "/hero-shot", runnable: false });
    expect(recipe.preset.instructions).toMatch(/How \/hero-shot works/);
  });
});

describe("running a product-shot preset", () => {
  const run = (env: FakeEnv, body: Record<string, unknown> = {}, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/photo/presets/run", { batch: "b1", index: 1, presetId: "hero_shot", source: "marketing_studio", inputs: { prompt: "warm and soft" }, ...body });

  it("refuses a member, a recipe, a style, and the switch off; browsing stays open", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const member = await run(env, {}, "member");
    expect(member.status).toBe(403);
    expect((await json(member)).error).toMatch(/Admins only for now/);
    expect(await run(env, { source: "recipe", presetId: "/hero-shot" })).toHaveProperty("status", 400);
    expect(await run(env, { source: "soul", presetId: "soul_film" })).toHaveProperty("status", 400);
    await setIntegrationSwitch(env, "higgsfield", false);
    expect(await run(env, { confirm: true })).toHaveProperty("status", 503);
    const browsed = (await json(await browse(env, "category=product-shots"))) as { items: unknown[]; reason: string };
    expect(browsed.items).toEqual([]);
    expect(browsed.reason).toMatch(/switched off/);
    expect(stub.rpc.filter((x) => x.name === "execute_preset")).toHaveLength(0);
  });

  it("asks for the confirm with the detail's price, runs execute_preset with the picture in the input, and the job lands as a picture of the post", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub({ balanceAfter: 1494 });
    useHiggsfieldMcpFetch(stub.fn);
    const ask = await run(env);
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 6, balance: 1500 });
    expect(stub.rpc.filter((x) => x.name === "execute_preset")).toHaveLength(0);
    const go = (await json(await run(env, { confirm: true }))) as { job: { id: string; status: string; estimate: number; label: string; tool: string; provider: string } };
    expect(go.job).toMatchObject({ status: "running", estimate: 6, label: "Preset · Hero Shot", tool: "preset:hero_shot", provider: "higgsfield" });
    expect(stub.rpc.find((x) => x.name === "execute_preset")!.args).toEqual({ source: "marketing_studio", preset_id: "hero_shot", inputs: { prompt: "warm and soft", product_image: "med_1" } });
    const twice = await run(env, { confirm: true });
    expect(twice.status).toBe(409);
    expect((await json(twice)).error).toMatch(/a moment ago/);
    let jobs = await listJobs(env);
    expect(jobs[0]).toMatchObject({ status: "running", output: null });
    jobs = await listJobs(env);
    expect(jobs[0]).toMatchObject({ status: "done", reported: 6 });
    expect(jobs[0].output).toMatch(/\/api\/studio\/photo\/tools\/jobs\/.*\/image\?which=out/);
    const stored = [...env.BUCKET.objects.keys()].filter((k) => k.startsWith("u2/b1/output/t1/") && k !== "u2/b1/output/t1/a.png");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/\.png$/);
    const file = await app("member").request(jobs[0].output!, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    const runOps = (await ops(env)).results.filter((o) => o.kind === "preset.run");
    expect(runOps).toHaveLength(1);
    expect(runOps[0]).toMatchObject({ status: "done", estimate: 6, reported: 6, task_id: "job-p1" });
    expect(runOps[0].note).toMatch(/balance 1500 → 1494/);
  });

  it("blocks a preset with no price as cost not known until the admin confirms it anyway", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub({ noPrice: true });
    useHiggsfieldMcpFetch(stub.fn);
    const ask = await run(env);
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsEstimate: true, presetId: "hero_shot" });
    expect(stub.rpc.filter((x) => x.name === "execute_preset")).toHaveLength(0);
    const go = (await json(await run(env, { confirm: true }))) as { job: { status: string; estimate: number | null } };
    expect(go.job).toMatchObject({ status: "running", estimate: null });
    const runOps = (await ops(env)).results.filter((o) => o.kind === "preset.run");
    expect(runOps[0].estimate).toBeNull();
    expect(runOps[0].note).toMatch(/cost unknown, confirmed/);
    expect(HERO.price).toBe(6);
  });
});
