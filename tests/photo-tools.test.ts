/**
 * The Photo studio's AI tools (server/photo-tools.ts) against stand-ins for the Higgsfield and
 * Magnific MCPs: the option-to-argument mapping, the catalog (a member sees the list with no call,
 * an admin the live availability, the option lists and the balances, cached an hour), the estimate
 * (`get_cost` / `simulate_cost`), a run refused to a member and with the switch off, the confirm →
 * the tool once → the job → `jobs_wait` / `creations_wait` → the picture under the post's output
 * prefix → "Use as the post's picture" (a take, the previous picture kept) and "Save as a product
 * photo", an unknown Higgsfield cost blocked until confirmed and an unknown Magnific cost blocked.
 * No call leaves the test: the guard fails it on any fetch the stubs did not answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, higgsfieldStub, json, magnificStub, MAGNIFIC_TOKEN, ops, postJson, seed, signedInHiggsfield, type FakeEnv } from "./support/photo-mcp";
import { PHOTO_TOOLS, photoTool } from "../shared/photo-tools";
import { resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { useMcpFetch } from "../server/freepik-mcp";
import { higgsfieldArgs, magnificOptionArgs, MAGNIFIC_LISTS_SETTING, paramFor, parseMagnificEntries, resetPhotoToolCaches } from "../server/photo-tools";
import type { ToolShape } from "../server/higgsfield-mcp";
import { getSetting, setSetting, FREEPIK_MCP_TOKEN_SETTING } from "../server/settings";
import { setIntegrationSwitch } from "../server/integrations";

type Job = { id: string; status: string; output: string | null; input: string; estimate: number | null; reported: number | null; label: string; tool: string; provider: string; error: string | null; options: Record<string, string> };
const catalog = async (env: FakeEnv, role: "admin" | "member" = "admin", qs = "") => json(await app(role).request(`/api/studio/photo/tools/catalog${qs}`, {}, env));
const estimate = (env: FakeEnv, body: Record<string, unknown>, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/photo/tools/estimate", { batch: "b1", index: 1, options: {}, ...body });
const run = (env: FakeEnv, body: Record<string, unknown>, role: "admin" | "member" = "admin") => postJson(app(role), env, "/api/studio/photo/tools/run", { batch: "b1", index: 1, options: {}, ...body });
const listJobs = async (env: FakeEnv, role: "admin" | "member" = "admin") => ((await json(await app(role).request("/api/studio/photo/tools/jobs?batch=b1&index=1", {}, env))) as { jobs: Job[] }).jobs;
const outputs = (env: FakeEnv) => [...env.BUCKET.objects.keys()].filter((k) => k.startsWith("u2/b1/output/t1/") && k !== "u2/b1/output/t1/a.png");

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  useMcpFetch(null);
  resetHiggsfieldMcpCaches();
  resetPhotoToolCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useHiggsfieldMcpFetch(null);
  useMcpFetch(null);
});

describe("mapping options onto a tool's arguments", () => {
  it("finds the argument a schema has for each option, by exact name first", () => {
    expect(paramFor(["media_id", "prompt", "aspect_ratio"], "prompt")).toBe("prompt");
    expect(paramFor(["imageUrl", "aspectRatio"], "aspect")).toBe("aspectRatio");
    expect(paramFor(["style_id", "model"], "styleId")).toBe("style_id");
    expect(paramFor(["imageUrl", "scaleFactor"], "scale")).toBe("scaleFactor");
    expect(paramFor(["imageUrl"], "prompt")).toBeNull();
  });

  it("builds Higgsfield arguments from the live shapes: image_id with the source size for upscale_image, media_id + media_type for remove_background, medias for the generator, get_cost only where listed, params wrapped when the schema wraps", () => {
    const flat = (names: string[]): ToolShape => ({ names, required: [], wrapped: false, top: [] });
    const nested = (names: string[], required: string[] = []): ToolShape => ({ names, required, wrapped: true, top: [] });
    const up = higgsfieldArgs(photoTool("hf-upscale")!, nested(["image_id", "width", "height", "resolution", "provider", "get_cost"], ["image_id", "width", "height"]), "med_1", {}, true, { width: 1856, height: 2304 });
    expect(up).toEqual({ args: { params: { image_id: "med_1", width: 1856, height: 2304, get_cost: true } }, costable: true, notes: [] });
    // The size unknown: the tool still gets the picture, and the note says what is missing.
    expect(higgsfieldArgs(photoTool("hf-upscale")!, nested(["image_id", "width", "height", "get_cost"], ["image_id", "width", "height"]), "med_1", {}, false, null)).toEqual({ args: { params: { image_id: "med_1" } }, costable: true, notes: ["the picture's size could not be read; the tool requires it"] });
    const bg = higgsfieldArgs(photoTool("hf-remove-bg")!, nested(["media_id", "media_type"], ["media_id", "media_type"]), "med_1", {}, true);
    expect(bg).toEqual({ args: { params: { media_id: "med_1", media_type: "image" } }, costable: false, notes: [] });
    const out = higgsfieldArgs(photoTool("hf-outpaint")!, nested(["image_id", "aspect_ratio", "width", "height", "get_cost"], ["image_id"]), "med_1", { aspect: "4:5", prompt: "more counter" }, true);
    expect(out.args).toEqual({ params: { image_id: "med_1", aspect_ratio: "4:5", get_cost: true } });
    expect(out.notes).toEqual(["what the new edges show (optional) not taken by outpaint_image"]);
    // The older flat shape still reads.
    const upFlat = higgsfieldArgs(photoTool("hf-upscale")!, flat(["media_id", "scale", "get_cost"]), "med_1", {}, true);
    expect(upFlat).toEqual({ args: { media_id: "med_1", get_cost: true }, costable: true, notes: [] });
    const gen = higgsfieldArgs(photoTool("hf-generate")!, nested([]), "med_1", { styleId: "soul_film", prompt: "a cup", aspect: "1:1" }, true);
    expect(gen.args).toEqual({ params: { model: "soul_2", medias: [{ value: "med_1", role: "image" }], count: 1, style_id: "soul_film", prompt: "a cup", aspect_ratio: "1:1", get_cost: true } });
    expect(gen.costable).toBe(true);
    const odd = higgsfieldArgs(photoTool("hf-relight")!, flat(["image", "text"]), "med_1", { prompt: "warm" }, false);
    expect(odd.args).toEqual({ image: "med_1", text: "warm" });
    expect(odd.notes).toEqual(["picture as image"]);
    const dropped = higgsfieldArgs(photoTool("hf-relight")!, flat(["media_id"]), "med_1", { prompt: "warm" }, false);
    expect(dropped.notes).toEqual(["the light wanted not taken by relight_image"]);
  });

  it("builds Magnific option arguments under the schema's names and reads the option lists in several shapes", () => {
    expect(magnificOptionArgs(photoTool("mg-upscale")!, ["imageUrl", "preset", "mode"], { preset: "portrait", mode: "precision" }).args).toEqual({ preset: "portrait", mode: "precision" });
    expect(magnificOptionArgs(photoTool("mg-replace-bg")!, ["imageUrl", "backgroundPrompt"], { prompt: "marble" }).args).toEqual({ backgroundPrompt: "marble" });
    const list = parseMagnificEntries({ content: [{ type: "text", text: JSON.stringify({ presets: [{ id: "portrait", name: "Portrait", preview: "https://x.test/p.jpg" }, { id: "product" }] }) }] });
    expect(list).toEqual([
      { id: "portrait", label: "Portrait", description: "", image: "https://x.test/p.jpg" },
      { id: "product", label: "product", description: "", image: null },
    ]);
    expect(parseMagnificEntries({ content: [{ type: "text", text: JSON.stringify(["precision", "creative"]) }] }).map((e) => e.id)).toEqual(["precision", "creative"]);
    expect(parseMagnificEntries({ content: [{ type: "text", text: "Modes:\n- precision — sharp detail\n- creative — more invention" }] }).map((e) => [e.id, e.description])).toEqual([
      ["precision", "sharp detail"],
      ["creative", "more invention"],
    ]);
  });
});

describe("the catalog", () => {
  it("gives a member the tool list with no live call and Admins only; gives an admin the live availability, the lists and the balances, cached an hour", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const hf = higgsfieldStub();
    const mg = magnificStub();
    useHiggsfieldMcpFetch(hf.fn);
    useMcpFetch(mg.fn);
    const member = (await catalog(env, "member")) as { admin: boolean; tools: unknown[]; higgsfield: { connected: boolean; admin: boolean; reason: string; available: Record<string, boolean | null> }; magnific: { reason: string; available: Record<string, boolean | null> }; upscalePresets: unknown[] };
    expect(member.admin).toBe(false);
    expect(member.tools).toHaveLength(PHOTO_TOOLS.length);
    expect(member.higgsfield).toMatchObject({ connected: true, admin: false });
    expect(member.higgsfield.reason).toMatch(/Admins only for now/);
    expect(member.higgsfield.available["hf-upscale"]).toBeNull();
    expect(member.upscalePresets).toEqual([]);
    expect(hf.rpc).toEqual([]);
    expect(mg.rpc).toEqual([]);
    const admin = (await catalog(env)) as { admin: boolean; higgsfield: { balance: number; available: Record<string, boolean | null>; reason: string }; magnific: { balance: number; available: Record<string, boolean | null> }; upscalePresets: { id: string; label: string }[]; upscaleModes: { id: string }[]; retouchModels: { id: string }[] };
    expect(admin.admin).toBe(true);
    expect(admin.higgsfield.reason).toBe("");
    expect(admin.higgsfield.balance).toBe(1500);
    expect(admin.higgsfield.available).toMatchObject({ "hf-upscale": true, "hf-remove-bg": true, "hf-generate": true, "hf-outpaint": false });
    expect(admin.magnific.balance).toBe(320);
    expect(admin.magnific.available).toMatchObject({ "mg-upscale": true, "mg-relight": true, "mg-skin": false });
    expect(admin.upscalePresets).toEqual([
      { id: "portrait", label: "Portrait" },
      { id: "product", label: "Product" },
    ]);
    expect(admin.upscaleModes.map((m) => m.id)).toEqual(["precision", "creative"]);
    expect(admin.retouchModels.map((m) => m.id)).toEqual(["retouch-v2"]);
    expect(JSON.parse((await getSetting(env, MAGNIFIC_LISTS_SETTING))!).lists.upscaleModes).toHaveLength(2);
    const lists = mg.rpc.filter((x) => x.method === "tools/list").length;
    await catalog(env);
    expect(mg.rpc.filter((x) => x.method === "tools/list")).toHaveLength(lists);
    await catalog(env, "admin", "?refresh=1");
    expect(mg.rpc.filter((x) => x.method === "tools/list")).toHaveLength(lists + 1);
  });
});

describe("Higgsfield tools on the post's picture", () => {
  it("refuses a member and the switch off before anything is imported", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const member = await run(env, { tool: "hf-upscale", confirm: true }, "member");
    expect(member.status).toBe(403);
    expect((await json(member)).error).toMatch(/Admins only for now/);
    expect(await estimate(env, { tool: "hf-upscale" }, "member")).toHaveProperty("status", 403);
    await setIntegrationSwitch(env, "higgsfield", false);
    expect(await run(env, { tool: "hf-upscale", confirm: true })).toHaveProperty("status", 503);
    expect(await run(env, { tool: "nope", confirm: true })).toHaveProperty("status", 400);
    expect(stub.rpc).toEqual([]);
  });

  it("estimates with get_cost (nothing submitted), asks for the confirm, runs once, polls jobs_wait into a picture, and the result becomes the post's picture as a take", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub({ balanceAfter: 1488 });
    useHiggsfieldMcpFetch(stub.fn);
    const est = (await json(await estimate(env, { tool: "hf-upscale" }))) as { credits: number; balance: number; unit: string };
    expect(est).toMatchObject({ credits: 12, balance: 1500, unit: "credits" });
    // The picture under image_id with its size read from the stored file, nested under params, get_cost only on the estimate.
    expect(stub.rpc.filter((x) => x.name === "upscale_image").map((x) => x.args)).toEqual([{ params: { image_id: "med_1", width: 1080, height: 1350, get_cost: true } }]);
    expect((await ops(env)).results.filter((o) => o.kind === "image.estimate")[0]).toMatchObject({ provider: "higgsfield", estimate: 12, status: "done" });
    const ask = await run(env, { tool: "hf-upscale" });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 12, balance: 1500 });
    expect(stub.rpc.filter((x) => x.name === "upscale_image" && !(x.args?.params as Record<string, unknown>)?.get_cost)).toHaveLength(0);
    const go = (await json(await run(env, { tool: "hf-upscale", confirm: true }))) as { job: Job };
    expect(go.job).toMatchObject({ status: "running", provider: "higgsfield", tool: "hf-upscale", label: "Upscale (Higgsfield)", estimate: 12 });
    expect(stub.rpc.filter((x) => x.name === "upscale_image" && !(x.args?.params as Record<string, unknown>)?.get_cost).map((x) => x.args)).toEqual([{ params: { image_id: "med_1", width: 1080, height: 1350 } }]);
    // The picture was imported once for the estimate and the run alike.
    expect(stub.rpc.filter((x) => x.name === "media_import_url")).toHaveLength(1);
    const twice = await run(env, { tool: "hf-upscale", confirm: true });
    expect(twice.status).toBe(409);
    expect((await json(twice)).error).toMatch(/a moment ago/);
    let jobs = await listJobs(env, "member");
    expect(jobs[0]).toMatchObject({ status: "running", output: null });
    expect(stub.rpc.filter((x) => x.name === "jobs_wait").at(-1)?.args).toEqual({ jobs: [{ index: 0, job_id: "job-up-1" }], timeout_seconds: 1 });
    jobs = await listJobs(env);
    expect(jobs[0]).toMatchObject({ status: "done", reported: 12, error: null });
    expect(outputs(env)).toHaveLength(1);
    const runOps = (await ops(env)).results.filter((o) => o.kind === "image.tool");
    expect(runOps).toHaveLength(1);
    expect(runOps[0]).toMatchObject({ provider: "higgsfield", status: "done", estimate: 12, reported: 12, task_id: "job-up-1" });
    expect(runOps[0].note).toMatch(/balance 1500 → 1488/);
    // The result as the post's picture: the task points at it, a take is recorded, the previous picture is kept.
    const asMember = await postJson(app("member"), env, `/api/studio/photo/tools/jobs/${jobs[0].id}/use`, { as: "picture", batch: "b1" });
    expect(asMember.status).toBe(403);
    const used = (await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${jobs[0].id}/use`, { as: "picture", batch: "b1" }))) as { key: string; previous: string };
    expect(used.key).toBe(outputs(env)[0]);
    expect(used.previous).toBe("u2/b1/output/t1/a.png");
    const task = await env.DB.prepare("SELECT output, status, made_for FROM tasks WHERE id = 't1'").first<{ output: string; status: string; made_for: number | null }>();
    expect(task).toMatchObject({ output: used.key, status: "ready" });
    expect(task!.made_for).not.toBeNull();
    const takes = (await env.DB.prepare("SELECT key, cost, note FROM post_takes WHERE batch = 'b1' AND post = 1").all()).results as { key: string; cost: number; note: string }[];
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ key: used.key, cost: 0 });
    expect(takes[0].note).toMatch(/AI tools: Upscale \(Higgsfield\) · 12 credits/);
    const snaps = (await env.DB.prepare("SELECT label, outputs FROM month_versions WHERE batch = 'b1'").all()).results as { label: string; outputs: string }[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ label: "Post 1 before the AI tools", outputs: JSON.stringify({ "1": "u2/b1/output/t1/a.png" }) });
    // And as a product photo: a sources row with the picture under the owner's source prefix.
    const product = (await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${jobs[0].id}/use`, { as: "product", batch: "b1" }))) as { source: { name: string; key: string } };
    expect(product.source.name).toMatch(/^Post 1 upscale\.png$/);
    expect(product.source.key).toMatch(/^u2\/b1\/source\//);
    const sources = (await env.DB.prepare("SELECT name, kind, role FROM sources WHERE batch = 'b1' ORDER BY created").all()).results as { name: string; kind: string }[];
    expect(sources.at(-1)).toMatchObject({ name: product.source.name, kind: "product", role: "lead" });
    expect((await ops(env)).results.filter((o) => /^image\.result\./.test(o.kind)).map((o) => o.kind)).toEqual(["image.result.picture", "image.result.product"]);
    // The pictures are served to a member of the month.
    expect((await app("member").request(jobs[0].output!, {}, env)).status).toBe(200);
    expect((await app("member").request(jobs[0].input, {}, env)).status).toBe(200);
  });

  it("blocks a tool with no get_cost as cost not known until the admin confirms it anyway, and finishes a synchronous answer at once", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub({ syncUpscale: true });
    useHiggsfieldMcpFetch(stub.fn);
    expect((await json(await estimate(env, { tool: "hf-remove-bg" }))).credits).toBeNull();
    expect((await ops(env)).results.filter((o) => o.kind === "image.estimate")[0]).toMatchObject({ estimate: null, status: "refused" });
    expect(await run(env, { tool: "hf-relight" })).toHaveProperty("status", 400);
    const ask = await run(env, { tool: "hf-remove-bg" });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsEstimate: true, tool: "hf-remove-bg" });
    expect(stub.rpc.filter((x) => x.name === "remove_background")).toHaveLength(0);
    const go = (await json(await run(env, { tool: "hf-remove-bg", confirm: true }))) as { job: Job };
    expect(go.job).toMatchObject({ status: "running", estimate: null });
    expect(stub.rpc.find((x) => x.name === "remove_background")!.args).toEqual({ params: { media_id: "med_1", media_type: "image" } });
    const runOps = (await ops(env)).results.filter((o) => o.kind === "image.tool");
    expect(runOps[0].note).toMatch(/cost unknown, confirmed/);
    // A tool that answers the finished picture at once (no job id) is done on return.
    const sync = (await json(await run(env, { tool: "hf-upscale", confirm: true }))) as { job: Job };
    expect(sync.job).toMatchObject({ status: "done", estimate: 12 });
    expect(sync.job.output).toMatch(/which=out/);
    expect(outputs(env)).toHaveLength(1);
    // The Soul generator: the style and the prompt go under params with the picture as a media.
    const gen = (await json(await run(env, { tool: "hf-generate", options: { styleId: "soul_film", prompt: "the cup on a café table", aspect: "4:5" }, confirm: true }))) as { job: Job };
    expect(gen.job).toMatchObject({ status: "running", estimate: 4, label: "Generate with a style (Higgsfield)" });
    expect(stub.rpc.filter((x) => x.name === "generate_image" && !(x.args?.params as Record<string, unknown>).get_cost).at(-1)?.args).toEqual({ params: { model: "soul_2", medias: [{ value: "med_1", role: "image" }], count: 1, style_id: "soul_film", prompt: "the cup on a café table", aspect_ratio: "4:5" } });
  });
});

describe("Magnific tools on the post's picture", () => {
  it("refuses a member and the Freepik switch off; says Not connected without a sign-in", async () => {
    const env = await seed();
    expect(await run(env, { tool: "mg-upscale", confirm: true }, "member")).toHaveProperty("status", 403);
    const notConnected = await run(env, { tool: "mg-upscale", confirm: true });
    expect(notConnected.status).toBe(409);
    expect(await json(notConnected)).toMatchObject({ connected: false });
    await setIntegrationSwitch(env, "freepik", false);
    expect(await run(env, { tool: "mg-upscale", confirm: true })).toHaveProperty("status", 503);
  });

  it("simulates the cost with the picture as a link, asks for the confirm, runs once, and creations_wait lands the picture", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const est = (await json(await estimate(env, { tool: "mg-upscale", options: { preset: "portrait", mode: "precision" } }))) as { credits: number; balance: number };
    expect(est).toMatchObject({ credits: 8, balance: 320 });
    const sim = stub.rpc.find((x) => x.name === "simulate_cost")!;
    expect(sim.args).toMatchObject({ tool: "images_upscale", arguments: { preset: "portrait", mode: "precision" } });
    expect(String((sim.args!.arguments as Record<string, unknown>).imageUrl)).toMatch(/^https:\/\/studio\.test\/api\/public\/object\?k=/);
    expect(stub.rpc.filter((x) => x.name === "images_upscale")).toHaveLength(0);
    const ask = await run(env, { tool: "mg-upscale", options: { preset: "portrait" } });
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ needsConfirm: true, credits: 8, balance: 320 });
    const go = (await json(await run(env, { tool: "mg-upscale", options: { preset: "portrait" }, confirm: true }))) as { job: Job };
    expect(go.job).toMatchObject({ status: "running", provider: "magnific", tool: "mg-upscale", label: "Upscale (Magnific)", estimate: 8 });
    expect(stub.rpc.filter((x) => x.name === "images_upscale")).toHaveLength(1);
    expect(stub.rpc.find((x) => x.name === "images_upscale")!.args).toMatchObject({ preset: "portrait" });
    let jobs = await listJobs(env);
    expect(jobs[0].status).toBe("running");
    expect(stub.rpc.filter((x) => x.name === "creations_wait").at(-1)?.args).toEqual({ identifiers: ["cr_up_1"], timeoutSeconds: 1 });
    jobs = await listJobs(env);
    expect(jobs[0]).toMatchObject({ status: "done", reported: 8 });
    expect(outputs(env)).toHaveLength(1);
    expect(outputs(env)[0]).toMatch(/\.jpg$/);
    const runOps = (await ops(env)).results.filter((o) => o.kind === "image.tool");
    expect(runOps[0]).toMatchObject({ provider: "freepik", status: "done", estimate: 8, reported: 8, task_id: "cr_up_1" });
    expect(runOps[0].note).toMatch(/balance 320 → 312/);
    // How the picture was handed over is kept on the job (the ledger note moves on to the reported credits).
    const row = await env.DB.prepare("SELECT settings FROM photo_tool_jobs WHERE id = ?").bind(jobs[0].id).first<{ settings: string }>();
    expect(JSON.parse(row!.settings)).toMatchObject({ mcpTool: "images_upscale", notes: ["picture: link as imageUrl"], args: { imageUrl: "<link>", preset: "portrait" } });
  });

  it("uploads the picture as a creation when the tool takes an identifier, and blocks an unknown cost outright", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub();
    useMcpFetch(stub.fn);
    const go = (await json(await run(env, { tool: "mg-relight", options: { prompt: "soft light" }, confirm: true }))) as { job: Job };
    expect(go.job).toMatchObject({ status: "running", estimate: 5 });
    expect(stub.rpc.find((x) => x.name === "creations_request_upload")?.args).toMatchObject({ contentType: "image/png", size: 29, type: "image" });
    expect(stub.puts).toEqual([{ url: "https://upload.test/put/1", bytes: 29, type: "image/png" }]);
    expect(stub.rpc.find((x) => x.name === "creations_finalize_upload")?.args).toMatchObject({ identifier: "up_1" });
    expect(stub.rpc.find((x) => x.name === "images_relight")!.args).toEqual({ prompt: "soft light", creationIdentifier: "cr_pic_1" });
    expect((await ops(env)).results.filter((o) => o.kind === "image.tool")[0].note).toMatch(/creation as creationIdentifier/);
    expect(await run(env, { tool: "mg-relight", confirm: true })).toHaveProperty("status", 400);
    useMcpFetch(magnificStub({ noCost: true }).fn);
    resetPhotoToolCaches();
    const blocked = await run(env, { tool: "mg-remove-bg", confirm: true });
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({ blocked: true });
    expect((await ops(env)).results.filter((o) => o.kind === "image.tool").at(-1)).toMatchObject({ status: "refused", estimate: null });
  });
});
