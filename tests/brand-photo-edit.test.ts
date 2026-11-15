/**
 * The client's brand limits on the Photo studio's AI tools and picture presets (server/photo-tools.ts,
 * server/photo-presets.ts), against the stand-ins for the Higgsfield and Magnific MCPs: a never-rule
 * and a brand colour reach the words the provider is sent, after the typed words and never twice; a
 * tool with no words is sent exactly what it was sent before; the typed words stay whole at the
 * length the route accepts; an empty kit adds nothing. No call leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, higgsfieldStub, json, magnificStub, MAGNIFIC_TOKEN, ops, postJson, seed, signedInHiggsfield, type FakeEnv, type Rpc } from "./support/photo-mcp";
import { blocksIn, BRAND_RULE, COLOUR, EDIT_LABEL, giveBrandRule, giveKit, NEVER } from "./support/brand-kit";
import { resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { useMcpFetch } from "../server/freepik-mcp";
import { resetPresetCaches } from "../server/video-presets";
import { resetPhotoPresetCaches } from "../server/photo-presets";
import { resetPhotoToolCaches, TOOL_PROMPT_MAX } from "../server/photo-tools";
import { setSetting, FREEPIK_MCP_TOKEN_SETTING } from "../server/settings";

type Job = { id: string; status: string; brand: string; options: Record<string, string> };
const estimate = (env: FakeEnv, body: Record<string, unknown>) => postJson(app(), env, "/api/studio/photo/tools/estimate", { batch: "b1", index: 1, options: {}, ...body });
const run = (env: FakeEnv, body: Record<string, unknown>) => postJson(app("member"), env, "/api/studio/photo/tools/run", { batch: "b1", index: 1, options: {}, confirm: true, ...body });
const calls = (rpc: Rpc[], name: string) => rpc.filter((x) => x.method === "tools/call" && x.name === name);
const settingsOf = async (env: FakeEnv, id: string) => JSON.parse((await env.DB.prepare("SELECT settings FROM photo_tool_jobs WHERE id = ?").bind(id).first<{ settings: string }>())!.settings) as { brand?: string; args: Record<string, unknown> };

async function withKit() {
  const env = await seed();
  await giveKit(env);
  await giveBrandRule(env);
  await signedInHiggsfield(env);
  await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
  return env;
}

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

describe("Magnific edit tools", () => {
  it("replace background: the estimate and the run carry the typed words first, then the never-rule, the approved brand rule and the brand colours", async () => {
    const env = await withKit();
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const typed = "a marble counter in morning light";
    expect((await estimate(env, { tool: "mg-replace-bg", options: { prompt: typed } })).status).toBe(200);
    const simulated = String((calls(stub.rpc, "simulate_cost")[0].args!.arguments as Record<string, unknown>).prompt);
    const go = (await json(await run(env, { tool: "mg-replace-bg", options: { prompt: typed } }))) as { job: Job };
    const sent = String(calls(stub.rpc, "images_replace_background")[0].args!.prompt);
    expect(sent).toBe(
      [
        typed,
        "",
        `${EDIT_LABEL} (keep everything not named above exactly as it is; these apply only to what is added or changed):`,
        "- Colours of anything added stay within: deep blue #0042aa, cream #f5e9d0.",
        "- NEVER: No plastic cups.",
        `- Brand rule: ${BRAND_RULE}.`,
        "- Every box keeps its printed lid.",
        "- If a person is added or changed: Women wear modest clothing with long sleeves.",
      ].join("\n"),
    );
    expect(sent).toContain(NEVER);
    expect(sent).toContain(COLOUR);
    // The estimate priced the very same words.
    expect(simulated).toBe(sent);
    // The job keeps the words as typed and the limits beside them; the ledger says they were sent.
    expect(go.job.options).toEqual({ prompt: typed });
    expect(go.job.brand).toBe(sent.slice(typed.length).trim());
    expect((await settingsOf(env, go.job.id)).brand).toBe(go.job.brand);
    expect((await ops(env)).results.find((o) => o.kind === "image.tool")!.note).toContain(`the client's brand limits sent after the typed words (${go.job.brand.length} characters)`);
  });

  it("a relight gets the limits without the colour list (its words describe light)", async () => {
    const env = await withKit();
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    await run(env, { tool: "mg-relight", options: { prompt: "soft light" } });
    const sent = String(calls(stub.rpc, "images_relight")[0].args!.prompt);
    expect(sent.startsWith("soft light\n\n")).toBe(true);
    expect(sent).toContain(NEVER);
    expect(sent).not.toContain("#0042aa");
  });

  it("a tool with no words gets nothing: upscale and remove background are sent as before", async () => {
    const env = await withKit();
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const up = (await json(await run(env, { tool: "mg-upscale", options: { preset: "portrait" } }))) as { job: Job };
    const bg = (await json(await run(env, { tool: "mg-remove-bg" }))) as { job: Job };
    expect(Object.keys(calls(stub.rpc, "images_upscale")[0].args!).sort()).toEqual(["imageUrl", "preset"]);
    expect(Object.keys(calls(stub.rpc, "images_remove_background")[0].args!)).toEqual(["imageUrl"]);
    expect(blocksIn(JSON.stringify(stub.rpc))).toBe(0);
    expect([up.job.brand, bg.job.brand]).toEqual(["", ""]);
    expect((await settingsOf(env, up.job.id)).brand).toBeUndefined();
  });

  it("never adds the limits twice: words that already carry a block are sent with one fresh block", async () => {
    const env = await withKit();
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    await run(env, { tool: "mg-restyle", options: { prompt: "soft film photograph" } });
    const first = String(calls(stub.rpc, "images_restyle")[0].args!.prompt);
    expect(blocksIn(first)).toBe(1);
    // The sent text comes back as the words of a second run (a retry from a stored prompt).
    const again = (await json(await run(env, { tool: "mg-restyle", options: { prompt: first } }))) as { job: Job };
    const second = String(calls(stub.rpc, "images_restyle")[1].args!.prompt);
    expect(second).toBe(first);
    expect(blocksIn(second)).toBe(1);
    expect(again.job.brand).toBe(first.slice("soft film photograph".length).trim());
  });

  it("keeps the typed words whole at the length limit: the limits lose rules, then go", async () => {
    const env = await withKit();
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const long = `${"a slow sunrise over the counter, ".repeat(52)}end.`;
    expect(long.length).toBeGreaterThan(TOOL_PROMPT_MAX - 400);
    await run(env, { tool: "mg-restyle", options: { prompt: long } });
    const sent = String(calls(stub.rpc, "images_restyle")[0].args!.prompt);
    expect(sent.startsWith(`${long}\n\n${EDIT_LABEL}`)).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(TOOL_PROMPT_MAX);
    // Fewer rules than the whole block, and the last one is whole.
    expect(sent).toContain(COLOUR);
    expect(sent).not.toContain("printed lid");
    expect(sent.endsWith(".")).toBe(true);
    const full = "b".repeat(TOOL_PROMPT_MAX);
    const job = (await json(await run(env, { tool: "mg-restyle", options: { prompt: full } }))) as { job: Job };
    expect(calls(stub.rpc, "images_restyle")[1].args!.prompt).toBe(full);
    expect(job.job.brand).toBe("");
  });

  it("adds nothing for a client with an empty kit", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const go = (await json(await run(env, { tool: "mg-replace-bg", options: { prompt: "a marble counter" } }))) as { job: Job };
    expect(calls(stub.rpc, "images_replace_background")[0].args!.prompt).toBe("a marble counter");
    expect(go.job.brand).toBe("");
    expect((await ops(env)).results.find((o) => o.kind === "image.tool")!.note).not.toContain("brand limits");
  });
});

describe("Higgsfield edit tools and presets", () => {
  it("relight: get_cost and the run carry the typed words, then the limits", async () => {
    const env = await withKit();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const go = (await json(await run(env, { tool: "hf-relight", options: { prompt: "warm evening light from the left" } }))) as { job: Job };
    const [cost, made] = calls(stub.rpc, "relight_image");
    expect(cost.args).toMatchObject({ get_cost: true });
    expect(made.args!.get_cost).toBeUndefined();
    for (const c of [cost, made]) {
      const sent = String(c.args!.prompt);
      expect(sent.startsWith(`warm evening light from the left\n\n${EDIT_LABEL} (keep everything not named above exactly as it is;`)).toBe(true);
      expect(sent).toContain(NEVER);
      expect(sent).toContain(`- Brand rule: ${BRAND_RULE}.`);
      expect(blocksIn(sent)).toBe(1);
    }
    expect(go.job.options).toEqual({ prompt: "warm evening light from the left" });
    expect(go.job.brand).toContain(NEVER);
  });

  it("generate with a style: a new picture, so the limits cover all of it, colours included", async () => {
    const env = await withKit();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    await run(env, { tool: "hf-generate", options: { styleId: "soul_film", prompt: "the same cup on a sunlit café table" } });
    const sent = String((calls(stub.rpc, "generate_image").at(-1)!.args!.params as Record<string, unknown>).prompt);
    expect(sent.startsWith(`the same cup on a sunlit café table\n\n${EDIT_LABEL} (they apply to everything this picture adds or changes):`)).toBe(true);
    expect(sent).toContain(NEVER);
    expect(sent).toContain(COLOUR);
  });

  it("upscale and remove background have no words and get none", async () => {
    const env = await withKit();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    await run(env, { tool: "hf-upscale" });
    await run(env, { tool: "hf-remove-bg" });
    expect(calls(stub.rpc, "upscale_image").length).toBeGreaterThan(0);
    expect(calls(stub.rpc, "remove_background")).toHaveLength(1);
    expect(blocksIn(JSON.stringify(stub.rpc))).toBe(0);
  });

  it("a product-shot preset: the words typed into it are followed by the limits; a preset run with no words is sent as it was", async () => {
    const env = await withKit();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const preset = (inputs: Record<string, unknown>) => postJson(app(), env, "/api/studio/photo/presets/run", { batch: "b1", index: 1, presetId: "hero_shot", source: "marketing_studio", inputs, confirm: true });
    const go = (await json(await preset({ prompt: "warm and soft" }))) as { job: Job };
    const sent = (calls(stub.rpc, "execute_preset")[0].args!.inputs as Record<string, unknown>);
    expect(String(sent.prompt).startsWith(`warm and soft\n\n${EDIT_LABEL} (they apply to everything this picture adds or changes):`)).toBe(true);
    expect(String(sent.prompt)).toContain(NEVER);
    expect(String(sent.prompt)).toContain(COLOUR);
    expect(go.job.options).toEqual({ prompt: "warm and soft" });
    expect(go.job.brand).toContain(NEVER);
    await preset({});
    expect(calls(stub.rpc, "execute_preset")[1].args!.inputs).toEqual({ product_image: "med_1" });
  });

  it("a Marketing Studio ad: the notes typed for it are followed by the limits", async () => {
    const env = await withKit();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    // The card must be in today's list first.
    await app("member").request("/api/studio/photo/presets?category=ads", {}, env);
    const r = await postJson(app(), env, "/api/studio/photo/presets/run", { batch: "b1", index: 1, presetId: "plush-paw", source: "marketing_studio_v2", inputs: { notes: "20% off this week" }, confirm: true });
    expect(r.status).toBe(200);
    const notes = String((calls(stub.rpc, "generate_image").at(-1)!.args!.params as Record<string, unknown>).notes);
    expect(notes.startsWith(`20% off this week\n\n${EDIT_LABEL} (they apply to everything this picture adds or changes):`)).toBe(true);
    expect(notes).toContain(NEVER);
    expect(notes).toContain(COLOUR);
    expect(((await json(r)) as { job: Job }).job.brand).toContain(NEVER);
  });
});
