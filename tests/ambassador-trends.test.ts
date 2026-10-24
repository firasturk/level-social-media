/**
 * Trends with a character (server/ambassador-trends.ts) against a stand-in Higgsfield MCP: the
 * characters are the client's ambassadors with a portrait and the account's Soul characters (one per
 * name); the gallery is opened with the character's picture as an uploaded input; a trend needs the
 * confirm and runs `execute_preset` once; the finished video is collected into R2. Members are
 * refused, and nothing makes a character. No call leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, ops, postJson, seed, signedInHiggsfield, type FakeEnv, type Rpc } from "./support/photo-mcp";
import { HIGGSFIELD_MCP_URL, resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { resetPresetCaches } from "../server/video-presets";
import { setSetting, HIGGSFIELD_BILLING_SETTING } from "../server/settings";
import { characterField, parseSouls, resetTrendCaches } from "../server/ambassador-trends";
import { parseCharacterId } from "../shared/ambassador-trends";

const SOUL_PIC = "https://cdn.test/souls/enigma.png";

function stub() {
  const rpc: Rpc[] = [];
  const text = (id: unknown, body: unknown, isError = false) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], isError } });
  const tools = ["balance", "media_import_url", "jobs_wait", "show_generation_by_ids", "get_presets", "get_preset_instructions", "execute_preset", "show_characters"];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
    if (name === "show_characters") {
      // As read live (24 Oct): Soul 2 and legacy Soul lists, one name in both.
      const items = args.type === "soul_2" ? [{ id: "s2-enigma", soul_id: "s2-enigma", name: "Elegant Enigma", type: "soul_2", status: "ready", preview_url: SOUL_PIC }, { id: "s2-cheer", soul_id: "s2-cheer", name: "Chill Heart Cheer", type: "soul_2", status: "ready", preview_url: "https://cdn.test/souls/cheer.jpg" }] : [{ id: "s1-enigma", soul_id: "s1-enigma", name: "Elegant Enigma", type: "soul", status: "ready", preview_url: "https://cdn.test/souls/old.png" }, { id: "s1-lace", soul_id: "s1-lace", name: "Ethereal Lace Whisper", type: "soul", status: "ready", preview_url: "https://cdn.test/souls/lace.png" }, { id: "s1-busy", soul_id: "s1-busy", name: "Training", type: "soul", status: "training" }];
      return text(b.id, { items, next_cursor: null });
    }
    if (name === "media_import_url") return text(b.id, { media_id: String(args.url) === SOUL_PIC ? "med-soul" : "med-amb", type: "image", status: "ready" });
    if (name === "get_presets") {
      if (args.preset_id) return text(b.id, { preset: { id: args.preset_id, name: "Locker Groove", preview_url: "https://cdn.test/groove.mp4", preview_type: "video", execution: { available: true, cost_credits: 30, readiness: { ready: true, missing: [] }, input_schema: { type: "object", properties: { character_sheet: { type: "array" } } } } } });
      return text(b.id, { items: [{ id: "genjutsu:trending:groove", name: "Locker Groove", description: "Motion transfer reference for /genjutsu. Driving video: …", kind: "genjutsu-motion", type: "genjutsu", thumbnail_url: "https://cdn.test/groove.webp", preview_url: "https://cdn.test/groove.mp4", preview_type: "video" }], next_cursor: null });
    }
    if (name === "get_preset_instructions") return text(b.id, { instructions: "" });
    if (name === "execute_preset") return text(b.id, 'Preset submitted. Final job_ids: ["99999999-8888-4777-8666-555555555555"].');
    if (name === "jobs_wait") {
      const jobs = args.jobs as { index: number; job_id: string }[];
      return text(b.id, { all_terminal: true, results: jobs.map((j) => ({ index: j.index, job_id: j.job_id, status: "completed", result: { url: "https://cdn.test/trend.mp4" } })) });
    }
    return text(b.id, { error: `no ${name}` }, true);
  };
  return { fn, rpc };
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
  const t = Date.now();
  await env.DB.prepare("INSERT INTO ambassadors (id, client, name, description, gender, image_key, position, created, updated) VALUES ('a1', 'c1', 'Omar', '', 'man', 'ambassadors/c1/a1.png', 0, ?, ?), ('a2', 'c1', 'No Portrait', '', 'man', NULL, 1, ?, ?)").bind(t, t, t, t).run();
  await env.BUCKET.put("ambassadors/c1/a1.png", new Uint8Array([137, 80, 78, 71]).buffer, { httpMetadata: { contentType: "image/png" } });
}

describe("trends with a character", () => {
  it("reads the character ids and the Soul list, and finds the preset's character input", () => {
    expect(parseCharacterId("soul:s2-enigma")).toEqual({ kind: "soul", ref: "s2-enigma" });
    expect(parseCharacterId("ambassador:a1")).toEqual({ kind: "ambassador", ref: "a1" });
    expect(parseCharacterId("other:x")).toBeNull();
    expect(parseSouls({ content: [{ type: "text", text: JSON.stringify({ items: [{ soul_id: "x", name: "A", status: "ready", preview_url: "https://c/a.png" }, { soul_id: "y", name: "B", status: "training" }] }) }] })).toEqual([{ id: "x", name: "A", image: "https://c/a.png" }]);
    expect(characterField({ properties: { prompt: {}, character_image: {} } })).toBe("character_image");
    expect(characterField(null)).toBe("character_sheet");
  });

  it("lists the client's ambassadors with a portrait and the account's characters, one per name; members see nothing", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    expect((await app("member").request("/api/studio/ambassadors/trends?client=c1", {}, env)).status).toBe(403);
    const r = (await json(await app().request("/api/studio/ambassadors/trends?client=c1", {}, env))) as { characters: { id: string; name: string; from: string }[] };
    expect(r.characters.map((c) => [c.id, c.name, c.from])).toEqual([
      ["ambassador:a1", "Omar", "ambassador"],
      ["soul:s2-enigma", "Elegant Enigma", "higgsfield"],
      ["soul:s2-cheer", "Chill Heart Cheer", "higgsfield"],
      ["soul:s1-lace", "Ethereal Lace Whisper", "higgsfield"],
    ]);
    // Nothing that makes a character is ever called.
    expect(s.rpc.some((x) => /ai_influencer|train|generate/.test(x.name ?? "") || x.args?.action === "train")).toBe(false);
  });

  it("opens the trend gallery with the character's picture, makes a trend after the confirm, and collects the video", async () => {
    const env = await seed();
    await ready(env);
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    const gallery = (await json(await app().request("/api/studio/ambassadors/trends/gallery?client=c1&character=soul:s2-enigma&category=genjutsu-trending", {}, env))) as { items: { id: string; description: string }[] };
    expect(gallery.items.map((i) => i.id)).toEqual(["genjutsu:trending:groove"]);
    expect(s.rpc.find((x) => x.name === "media_import_url")!.args).toEqual({ url: SOUL_PIC, type: "image" });
    expect(s.rpc.find((x) => x.name === "get_presets" && !x.args?.preset_id)!.args).toEqual({ source: "genjutsu", category: "genjutsu-trending", limit: 50, initial_inputs: { character_sheet: [{ id: "med-soul", type: "media_input" }] } });
    // An ambassador without a portrait cannot be used.
    expect((await app().request("/api/studio/ambassadors/trends/gallery?client=c1&character=ambassador:a2", {}, env)).status).toBe(409);
    const make = (body: Record<string, unknown> = {}) => postJson(app(), env, "/api/studio/ambassadors/trends/make", { client: "c1", character: "ambassador:a1", presetId: "genjutsu:trending:groove", ...body });
    const ask = await make();
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 30, balance: 900 });
    expect(s.rpc.some((x) => x.name === "execute_preset")).toBe(false);
    const go = (await json(await make({ confirm: true }))) as { trend: { status: string; credits: number; characterName: string; presetName: string } };
    expect(go.trend).toMatchObject({ status: "queued", credits: 30, characterName: "Omar", presetName: "Locker Groove" });
    expect(s.rpc.find((x) => x.name === "execute_preset")!.args).toEqual({ source: "genjutsu", preset_id: "genjutsu:trending:groove", inputs: { character_sheet: [{ id: "med-amb", type: "media_input" }] } });
    expect((await make({ confirm: true })).status).toBe(409);
    const list = (await json(await app().request("/api/studio/ambassadors/trends?client=c1", {}, env))) as { trends: { status: string; video: string }[] };
    expect(list.trends[0]).toMatchObject({ status: "done" });
    const video = await app().request(`${list.trends[0].video}?download=1`, {}, env);
    expect(video.status).toBe(200);
    expect(video.headers.get("content-disposition")).toMatch(/Locker-Groove\.mp4/);
    const trendOps = (await ops(env)).results.filter((o) => o.kind === "trend.video");
    expect(trendOps.map((o) => [o.status, o.estimate])).toEqual([["done", 30]]);
  });

  it("refuses a trend on the Cloud billing", async () => {
    const env = await seed();
    await ready(env);
    await setSetting(env, HIGGSFIELD_BILLING_SETTING, "cloud");
    const s = stub();
    useHiggsfieldMcpFetch(s.fn);
    expect((await postJson(app(), env, "/api/studio/ambassadors/trends/make", { client: "c1", character: "ambassador:a1", presetId: "x", confirm: true })).status).toBe(409);
    expect(s.rpc.some((x) => x.name === "execute_preset")).toBe(false);
  });
});
