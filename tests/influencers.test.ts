/**
 * AI influencers (server/influencers.ts) against a stand-in Higgsfield MCP: designing asks
 * `ai_influencer_prepare` only (nothing made), making needs the confirm and sends the prepared params
 * unchanged with the quote as the ceiling, the finished sheet is collected into R2, it can join the
 * ambassadors, the trend gallery is opened with the character, and a trend needs the confirm and runs
 * `execute_preset` once with the character sheet. Members are refused. No call leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, ops, postJson, RESULT_PNG, seed, signedInHiggsfield, type FakeEnv, type Rpc } from "./support/photo-mcp";
import { HIGGSFIELD_MCP_URL, resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { resetPresetCaches } from "../server/video-presets";
import { setSetting, HIGGSFIELD_BILLING_SETTING } from "../server/settings";
import { characterField, parsePrepared } from "../server/influencers";
import { cleanSelection, influencerBrief } from "../shared/influencers";

const SHEET_JOB = "11111111-2222-4333-8444-555555555555";
const PARAMS = { tier: "normal", selection: { gender: ["male"], ethnicity_origin_base: ["middle_eastern"] }, brief: "Yazan", medias: [], seed: 4242 };

function stub() {
  const rpc: Rpc[] = [];
  let waits = 0;
  const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError } });
  const tools = ["balance", "jobs_wait", "show_generation_by_ids", "get_presets", "get_preset_instructions", "execute_preset", "ai_influencer_prepare", "ai_influencer_generate"];
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
    if (name === "ai_influencer_prepare") return text(b.id, { params: PARAMS, credits: 12, free_gens_remaining: 0, design: "A Middle Eastern man in his twenties, short black hair, casual." });
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
    expect(characterField({ properties: { prompt: {}, character_image: {} } })).toBe("character_image");
    expect(characterField(null)).toBe("character_sheet");
    expect(parsePrepared({ content: [{ type: "text", text: JSON.stringify({ params: PARAMS, credits: 12 }) }] })).toMatchObject({ params: PARAMS, credits: 12 });
  });

  it("designs for free, makes after the confirm with the prepared params unchanged, collects the sheet and adds it to the ambassadors", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    // Members see nothing.
    expect((await app("member").request("/api/studio/influencers?client=c1", {}, env)).status).toBe(403);
    const prep = (await json(await postJson(app(), env, "/api/studio/influencers/prepare", { client: "c1", name: "Yazan", traits: { gender: "male", ethnicity_origin_base: "middle_eastern" }, notes: "a student" }))) as { influencer: { id: string; status: string; credits: number; design: string } };
    expect(prep.influencer).toMatchObject({ status: "draft", credits: 12 });
    expect(prep.influencer.design).toMatch(/Middle Eastern man/);
    const asked = s.rpc.find((x) => x.name === "ai_influencer_prepare")!.args!;
    expect(asked).toMatchObject({ tier: "normal", selection: { gender: ["male"], ethnicity_origin_base: ["middle_eastern"] }, batch_size: 1, randomize: false });
    expect(String(asked.brief)).toMatch(/Yazan: a real-looking man from Amman, Jordan, the face of Sample/);
    expect(s.rpc.some((x) => x.name === "ai_influencer_generate")).toBe(false);
    const id = prep.influencer.id;
    const ask = await postJson(app(), env, `/api/studio/influencers/${id}/make`, {});
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 12, balance: 900 });
    expect(s.rpc.some((x) => x.name === "ai_influencer_generate")).toBe(false);
    const made = (await json(await postJson(app(), env, `/api/studio/influencers/${id}/make`, { confirm: true }))) as { influencer: { status: string } };
    expect(made.influencer.status).toBe("making");
    expect(s.rpc.find((x) => x.name === "ai_influencer_generate")!.args).toEqual({ params: PARAMS, max_credits: 12 });
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
      ["influencer.sheet", "done", 12],
    ]);
  });

  it("opens the trend gallery with the character, then makes a trend after the confirm with the character sheet as its input", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    const prep = (await json(await postJson(app(), env, "/api/studio/influencers/prepare", { client: "c1", name: "Yazan", traits: { gender: "male" } }))) as { influencer: { id: string } };
    const id = prep.influencer.id;
    // Not before the influencer is made.
    expect((await app().request(`/api/studio/influencers/${id}/trends`, {}, env)).status).toBe(409);
    await postJson(app(), env, `/api/studio/influencers/${id}/make`, { confirm: true });
    await app().request("/api/studio/influencers?client=c1", {}, env);
    const gallery = (await json(await app().request(`/api/studio/influencers/${id}/trends?category=genjutsu-trending`, {}, env))) as { items: { id: string; video: string; description: string }[] };
    expect(gallery.items).toEqual([expect.objectContaining({ id: "genjutsu:trending:groove", video: "https://cdn.test/groove.mp4", description: "Motion transfer: your character or product takes this video's moves and camera." })]);
    expect(s.rpc.find((x) => x.name === "get_presets" && !x.args?.preset_id)!.args).toEqual({ source: "genjutsu", category: "genjutsu-trending", limit: 50, initial_inputs: { character_sheet: [{ id: SHEET_JOB, type: "image_job" }] } });
    const ask = await postJson(app(), env, `/api/studio/influencers/${id}/trend`, { presetId: "genjutsu:trending:groove" });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 30 });
    expect(s.rpc.some((x) => x.name === "execute_preset")).toBe(false);
    const go = (await json(await postJson(app(), env, `/api/studio/influencers/${id}/trend`, { presetId: "genjutsu:trending:groove", confirm: true }))) as { trend: { status: string; credits: number; presetName: string } };
    expect(go.trend).toMatchObject({ status: "queued", credits: 30, presetName: "Locker Groove" });
    expect(s.rpc.find((x) => x.name === "execute_preset")!.args).toEqual({ source: "genjutsu", preset_id: "genjutsu:trending:groove", inputs: { character_sheet: [{ id: SHEET_JOB, type: "image_job" }] } });
    const list = (await json(await app().request("/api/studio/influencers?client=c1", {}, env))) as { influencers: { trends: { status: string; video: string }[] }[] };
    expect(list.influencers[0].trends[0]).toMatchObject({ status: "done" });
    const video = await app().request(`${list.influencers[0].trends[0].video}?download=1`, {}, env);
    expect(video.status).toBe(200);
    expect(video.headers.get("content-disposition")).toMatch(/Locker-Groove\.mp4/);
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
