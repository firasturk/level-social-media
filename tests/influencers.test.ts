/**
 * AI influencers (server/influencers.ts) against a stand-in Higgsfield MCP: designing asks
 * `ai_influencer_prepare` only (nothing made), making needs the confirm and sends the prepared params
 * unchanged with the quote as the ceiling (or a free generation with no credits, only when some are
 * left), the finished sheet is collected into R2, it can join the ambassadors, and it becomes a
 * character for trends (its sheet job as the Genjutsu reference). Members are refused. No call
 * leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, ops, postJson, RESULT_PNG, seed, signedInHiggsfield, type FakeEnv, type Rpc } from "./support/photo-mcp";
import { HIGGSFIELD_MCP_URL, resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { resetPresetCaches } from "../server/video-presets";
import { setSetting, HIGGSFIELD_BILLING_SETTING } from "../server/settings";
import { parsePrepared } from "../server/influencers";
import { resetTrendCaches } from "../server/ambassador-trends";
import { cleanSelection, influencerBrief } from "../shared/influencers";

const SHEET_JOB = "11111111-2222-4333-8444-555555555555";
const PARAMS = { tier: "normal", selection: { gender: ["male"], ethnicity_origin_base: ["middle_eastern"] }, brief: "Yazan", medias: [], seed: 4242 };

function stub() {
  const rpc: Rpc[] = [];
  let waits = 0;
  const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError } });
  const tools = ["balance", "jobs_wait", "show_generation_by_ids", "get_presets", "get_preset_instructions", "execute_preset", "ai_influencer_prepare", "ai_influencer_generate", "show_characters"];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://cdn.test/sheet.png") return new Response(RESULT_PNG.slice(0), { headers: { "content-type": "image/png" } });
    if (url === "https://cdn.test/trend.mp4") return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer, { headers: { "content-type": "video/mp4" } });
    if (url !== HIGGSFIELD_MCP_URL) throw new Error(`unexpected ${url}`);
    const b = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    rpc.push({ method: b.method, name: b.params?.name as string | undefined, args: b.params?.arguments as Record<string, unknown> | undefined });
    if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "higgsfield", version: "1" }, capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "s1" } });
    if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (b.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } });
    const name = b.params.name as string;
    const args = (b.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "balance") return text(b.id, { credits: 900, plan: "Creator" });
    if (name === "show_characters") return text(b.id, { items: [], next_cursor: null });
    if (name === "ai_influencer_prepare") return text(b.id, { params: PARAMS, credits: 1.125, free_gens_remaining: 2, design: "A Middle Eastern man in his twenties, short black hair, casual." });
    if (name === "ai_influencer_generate") return text(b.id, { job_id: SHEET_JOB, job_ids: [SHEET_JOB] });
    if (name === "jobs_wait") {
      waits++;
      const jobs = args.jobs as { index: number; job_id: string }[];
      return text(b.id, { all_terminal: true, results: jobs.map((j) => ({ index: j.index, job_id: j.job_id, status: "completed", result: { url: j.job_id === SHEET_JOB ? "https://cdn.test/sheet.png" : "https://cdn.test/trend.mp4" } })) });
    }
    if (name === "get_presets") {
      if (args.preset_id) return text(b.id, { preset: { id: args.preset_id, name: "Locker Groove", preview_url: "https://cdn.test/groove.mp4", preview_type: "video", execution: { available: true, cost_credits: 30, readiness: { ready: true, missing: [] }, input_schema: { type: "object", properties: { character_sheet: { type: "array" } }, required: ["character_sheet"] } } } });
      return text(b.id, { items: [{ id: "genjutsu:trending:groove", name: "Locker Groove", description: "Motion transfer reference for /genjutsu. Driving video: …", kind: "genjutsu-motion", type: "genjutsu", thumbnail_url: "https://cdn.test/groove.webp", preview_url: "https://cdn.test/groove.mp4", preview_type: "video" }], next_cursor: null });
    }
    if (name === "get_preset_instructions") return text(b.id, { instructions: "" });
    if (name === "execute_preset") return text(b.id, 'Preset submitted. Final job_ids: ["99999999-8888-4777-8666-555555555555"].');
    return text(b.id, { error: `no ${name}` }, true);
  };
  return { fn, rpc, waits: () => waits };
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  resetHiggsfieldMcpCaches();
  resetPresetCaches();
  resetTrendCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useHiggsfieldMcpFetch(null);
});

async function ready(env: FakeEnv) {
  await signedInHiggsfield(env);
  await setSetting(env, HIGGSFIELD_BILLING_SETTING, "credits");
}

describe("AI influencers", () => {
  it("keeps the traits it knows, never a beard on a woman, and dresses the person modestly", () => {
    expect(cleanSelection({ gender: "female", facial_hair: "fh_beard", hair: "hair_long", nonsense: "x", age: "teen" })).toEqual({ gender: ["female"], hair: ["hair_long"] });
    const b = influencerBrief({ name: "Lina", gender: "female", hijab: true, city: "", notes: "loves street food", brand: "Habibah" });
    expect(b).toMatch(/real-looking woman from Amman, Jordan/);
    expect(b).toMatch(/covers the shoulders, arms and knees, and a hijab/);
    expect(b).toMatch(/loves street food$/);
    // The live answer (24 Oct): about 1.1 credits a sheet, and the free generations left.
    expect(parsePrepared({ content: [{ type: "text", text: JSON.stringify({ params: PARAMS, credits: 1.125, free_gens_remaining: 2, submitted: false }) }] })).toMatchObject({ params: PARAMS, credits: 1.125, freeGens: 2 });
  });

  it("designs for free, makes after the confirm with the prepared params unchanged, collects the sheet and adds it to the ambassadors", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    // Members see nothing.
    expect((await app("member").request("/api/studio/influencers?client=c1", {}, env)).status).toBe(403);
    const prep = (await json(await postJson(app(), env, "/api/studio/influencers/prepare", { client: "c1", name: "Yazan", traits: { gender: "male", ethnicity_origin_base: "middle_eastern" }, notes: "a student" }))) as { influencer: { id: string; status: string; credits: number; design: string } };
    expect(prep.influencer).toMatchObject({ status: "draft", credits: 1.125 });
    expect(prep.influencer.design).toMatch(/Middle Eastern man/);
    const asked = s.rpc.find((x) => x.name === "ai_influencer_prepare")!.args!;
    expect(asked).toMatchObject({ tier: "normal", selection: { gender: ["male"], ethnicity_origin_base: ["middle_eastern"] }, batch_size: 1, randomize: false });
    expect(String(asked.brief)).toMatch(/Yazan: a real-looking man from Amman, Jordan, the face of Sample/);
    expect(s.rpc.some((x) => x.name === "ai_influencer_generate")).toBe(false);
    const id = prep.influencer.id;
    const ask = await postJson(app(), env, `/api/studio/influencers/${id}/make`, {});
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 1.125, balance: 900 });
    expect(s.rpc.some((x) => x.name === "ai_influencer_generate")).toBe(false);
    const made = (await json(await postJson(app(), env, `/api/studio/influencers/${id}/make`, { confirm: true }))) as { influencer: { status: string } };
    expect(made.influencer.status).toBe("making");
    expect(s.rpc.find((x) => x.name === "ai_influencer_generate")!.args).toEqual({ params: PARAMS, max_credits: 1.125 });
    // The same ask again is refused.
    expect((await postJson(app(), env, `/api/studio/influencers/${id}/make`, { confirm: true })).status).toBe(409);
    // Reading the list collects the finished sheet.
    const list = (await json(await app().request("/api/studio/influencers?client=c1", {}, env))) as { influencers: { id: string; status: string; image: string; inCast: boolean }[] };
    expect(list.influencers[0]).toMatchObject({ id, status: "ready", image: `/api/studio/influencers/${id}/image`, inCast: false });
    expect((await env.BUCKET.get(`influencers/c1/${id}.png`)) !== null).toBe(true);
    const img = await app("member").request(`/api/studio/influencers/${id}/image`, {}, env);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(await json(await postJson(app(), env, `/api/studio/influencers/${id}/cast`))).toMatchObject({ ok: true });
    const amb = await env.DB.prepare("SELECT name, gender, modest, image_key FROM ambassadors WHERE client = 'c1'").all<{ name: string; gender: string; modest: number; image_key: string }>();
    expect(amb.results).toEqual([{ name: "Yazan", gender: "man", modest: 1, image_key: `influencers/c1/${id}.png` }]);
    const sheetOps = (await ops(env)).results.filter((o) => o.kind.startsWith("influencer."));
    expect(sheetOps.map((o) => [o.kind, o.status, o.estimate])).toEqual([
      ["influencer.prepare", "done", 0],
      ["influencer.sheet", "done", 1.125],
    ]);
  });

  it("makes one with a free generation (no credits) only when some are left, and the finished one is a character for trends with its sheet as the reference", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    const prep = (await json(await postJson(app(), env, "/api/studio/influencers/prepare", { client: "c1", name: "Lina", traits: { gender: "female" }, hijab: true }))) as { influencer: { id: string; freeGens: number } };
    expect(prep.influencer.freeGens).toBe(2);
    const id = prep.influencer.id;
    const ask = await postJson(app(), env, `/api/studio/influencers/${id}/make`, { free: true });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, free: true, credits: 0 });
    await postJson(app(), env, `/api/studio/influencers/${id}/make`, { free: true, confirm: true });
    expect(s.rpc.find((x) => x.name === "ai_influencer_generate")!.args).toEqual({ params: PARAMS, max_credits: 0, use_free_gens: true });
    const sheetOps = (await ops(env)).results.filter((o) => o.kind === "influencer.sheet");
    expect(sheetOps[0].estimate).toBe(0);
    expect(sheetOps[0].note).toMatch(/a free generation, no credits/);
    // Not a character while it is being made; once collected, listed for trends with its sheet job as the Genjutsu reference.
    const before = (await json(await app().request("/api/studio/ambassadors/trends?client=c1", {}, env))) as { characters: { from: string }[] };
    expect(before.characters.some((c) => c.from === "influencer")).toBe(false);
    await app().request("/api/studio/influencers?client=c1", {}, env);
    const after = (await json(await app().request("/api/studio/ambassadors/trends?client=c1", {}, env))) as { characters: { id: string; from: string; name: string }[] };
    expect(after.characters).toContainEqual(expect.objectContaining({ id: `influencer:${id}`, from: "influencer", name: "Lina" }));
    await app().request(`/api/studio/ambassadors/trends/gallery?client=c1&character=influencer:${id}`, {}, env);
    expect(s.rpc.find((x) => x.name === "get_presets" && !x.args?.preset_id)!.args).toMatchObject({ initial_inputs: { character_sheet: [{ id: SHEET_JOB, type: "image_job" }] } });
  });

  it("refuses a free generation when none is left, without calling Higgsfield", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    const prep = (await json(await postJson(app(), env, "/api/studio/influencers/prepare", { client: "c1", name: "Yazan" }))) as { influencer: { id: string } };
    await env.DB.prepare("UPDATE influencers SET free_gens = 0 WHERE id = ?").bind(prep.influencer.id).run();
    const r = await postJson(app(), env, `/api/studio/influencers/${prep.influencer.id}/make`, { free: true, confirm: true });
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ noFreeGens: true });
    expect(s.rpc.some((x) => x.name === "ai_influencer_generate")).toBe(false);
  });

  it("refuses to make anything on the Cloud billing", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    await setSetting(env, HIGGSFIELD_BILLING_SETTING, "cloud");
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    const prep = (await json(await postJson(app(), env, "/api/studio/influencers/prepare", { client: "c1", name: "Yazan" }))) as { influencer: { id: string } };
    expect((await postJson(app(), env, `/api/studio/influencers/${prep.influencer.id}/make`, { confirm: true })).status).toBe(409);
    expect(s.rpc.some((x) => x.name === "ai_influencer_generate")).toBe(false);
  });
});
