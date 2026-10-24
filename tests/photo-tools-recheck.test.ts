/**
 * "Check again" on a Photo studio AI tools job recorded as failed (server/photo-tools.ts,
 * `recheckPhotoJob`), against stand-ins for the Higgsfield and Magnific MCPs. The live case: an
 * Upscale finished at Higgsfield and was charged, the studio recorded the job as failed, and the
 * picture never reached the post. Asked again, the provider is read with its status tools only
 * (never the tool that made the picture), and:
 *   - finished: the picture lands under the same key the settler uses, the job is done, the ledger
 *     row of the run is closed with the credits the provider names (else the estimate), once;
 *   - still running: said so, nothing changes;
 *   - failed: kept failed, with the provider's reason;
 *   - pressed twice (or twice at once): one picture, one cost.
 * And the settler no longer fails a job on a one-second wait that says "timeout", nor on a result
 * link it did not know where to find. No call leaves the test: the guard fails it on any fetch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, higgsfieldStub, json, magnificStub, MAGNIFIC_TOKEN, ops, postJson, seed, signedInHiggsfield, type FakeEnv, type Rpc } from "./support/photo-mcp";
import { resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { useMcpFetch } from "../server/freepik-mcp";
import { resetPhotoToolCaches, sniffPicture } from "../server/photo-tools";
import { resultLink } from "../server/provider-status";
import { setSetting, FREEPIK_MCP_TOKEN_SETTING } from "../server/settings";

type Job = { id: string; status: string; output: string | null; estimate: number | null; reported: number | null; error: string | null };
type Check = { ok: boolean; outcome: string; message: string; job: Job; error?: string };

const run = (env: FakeEnv, body: Record<string, unknown>) => postJson(app(), env, "/api/studio/photo/tools/run", { batch: "b1", index: 1, options: {}, confirm: true, ...body });
const check = (env: FakeEnv, id: string, role: "admin" | "member" = "admin") => postJson(app(role), env, `/api/studio/photo/tools/jobs/${id}/check`);
const listJobs = async (env: FakeEnv) => ((await json(await app().request("/api/studio/photo/tools/jobs?batch=b1&index=1", {}, env))) as { jobs: Job[] }).jobs;
const outputs = (env: FakeEnv) => [...env.BUCKET.objects.keys()].filter((k) => k.startsWith("u2/b1/output/t1/") && k !== "u2/b1/output/t1/a.png");
const toolOps = async (env: FakeEnv) => (await ops(env)).results.filter((o) => o.kind === "image.tool");
/** Anything but a status read or a sign-in step: what "Check again" must never call. */
const notStatus = (rpc: Rpc[]) => rpc.filter((x) => x.method === "tools/call" && !["jobs_wait", "show_generation_by_ids", "creations_wait", "creations_get"].includes(x.name ?? ""));

/** What the live studio did: the settler recorded the run as failed (job and ledger row alike). */
async function recordFailed(env: FakeEnv, id: string, error = "The tool finished without a picture link.") {
  await env.DB.prepare("UPDATE photo_tool_jobs SET status = 'failed', error = ? WHERE id = ?").bind(error, id).run();
  await env.DB.prepare("UPDATE integration_ops SET status = 'failed', note = ? WHERE kind = 'image.tool'").bind(error).run();
}

/** An Upscale run on Higgsfield (12 credits estimated), recorded as failed. */
async function failedUpscale() {
  const env = await seed();
  await signedInHiggsfield(env);
  useHiggsfieldMcpFetch(higgsfieldStub().fn);
  const go = (await json(await run(env, { tool: "hf-upscale" }))) as { job: Job };
  expect(go.job).toMatchObject({ status: "running", estimate: 12 });
  await recordFailed(env, go.job.id);
  resetHiggsfieldMcpCaches();
  return { env, id: go.job.id };
}

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

describe("Check again on a Higgsfield job recorded as failed", () => {
  it("collects a run the provider finished: the picture under the job's key, the job done, the ledger row closed with the credits Higgsfield names; a second press adds nothing", async () => {
    const { env, id } = await failedUpscale();
    const stub = higgsfieldStub({ waits: [{ status: "completed", credits_used: 2, result: { url: "https://cdn.test/out.png" } }] });
    useHiggsfieldMcpFetch(stub.fn);

    const r = (await json(await check(env, id))) as Check;
    expect(r).toMatchObject({ ok: true, outcome: "done", job: { id, status: "done", reported: 2, error: null } });
    expect(r.message).toMatch(/Higgsfield had finished it: the result is collected \(2 credits\)/);
    // A status read only: the upscale itself was never sent again, nor priced.
    expect(stub.rpc.filter((x) => x.method === "tools/call").map((x) => x.name)).toEqual(["jobs_wait"]);
    expect(stub.rpc.find((x) => x.name === "jobs_wait")!.args).toEqual({ jobs: [{ index: 0, job_id: "job-up-1" }], timeout_seconds: 1 });
    expect(notStatus(stub.rpc)).toEqual([]);
    // The same key the settler would have used.
    expect(outputs(env)).toEqual([`u2/b1/output/t1/${id}.png`]);
    // The run's own ledger row, done, with the provider's figure: still one row.
    const rows = await toolOps(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "higgsfield", status: "done", estimate: 12, reported: 2, task_id: "job-up-1" });
    expect(rows[0].note).toMatch(/^Upscale \(Higgsfield\) · 2 credits reported by Higgsfield · collected by Check again \(recorded as failed before: The tool finished without a picture link\.\)/);

    // Pressed again: nothing is asked, nothing is added.
    const calls = stub.rpc.length;
    const again = (await json(await check(env, id))) as Check;
    expect(again).toMatchObject({ outcome: "done", job: { status: "done", reported: 2 } });
    expect(again.message).toMatch(/^Already collected/);
    expect(stub.rpc).toHaveLength(calls);
    expect(outputs(env)).toHaveLength(1);
    expect(await toolOps(env)).toHaveLength(1);
    expect((await toolOps(env))[0].reported).toBe(2);

    // From here the result goes to the post exactly as a normal run's does: one take, the previous picture kept.
    const used = (await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${id}/use`, { as: "picture", batch: "b1" }))) as { key: string; held: string | null };
    expect(used).toMatchObject({ key: `u2/b1/output/t1/${id}.png`, held: null });
    expect((await env.DB.prepare("SELECT output FROM tasks WHERE id = 't1'").first<{ output: string }>())!.output).toBe(used.key);
    const takes = (await env.DB.prepare("SELECT key, note FROM post_takes WHERE batch = 'b1' AND post = 1").all()).results as { key: string; note: string }[];
    expect(takes).toHaveLength(1);
    expect(takes[0].note).toMatch(/AI tools: Upscale \(Higgsfield\) · 2 credits/);
  });

  it("two presses at once make one picture and one cost", async () => {
    const { env, id } = await failedUpscale();
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "completed", result: { url: "https://cdn.test/out.png" } }] }).fn);
    const [a, b] = await Promise.all([check(env, id), check(env, id)]);
    const answers = [a, b].map((r) => r.status);
    expect(answers).toContain(200);
    expect(answers.every((s) => s === 200 || s === 409)).toBe(true);
    expect(outputs(env)).toHaveLength(1);
    const rows = await toolOps(env);
    expect(rows).toHaveLength(1);
    // No figure from the provider: the estimate is what the ledger holds.
    expect(rows[0]).toMatchObject({ status: "done", reported: 12 });
    expect(rows[0].note).toMatch(/12 credits \(from the estimate\)/);
    expect((await listJobs(env))[0]).toMatchObject({ status: "done", reported: 12 });
  });

  it("says a job is still running and changes nothing (a wait that ran out included)", async () => {
    const { env, id } = await failedUpscale();
    for (const status of ["in_progress", "timeout"]) {
      useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status }] }).fn);
      resetHiggsfieldMcpCaches();
      const r = (await json(await check(env, id))) as Check;
      expect(r.outcome).toBe("running");
      expect(r.message).toBe(`Higgsfield says the job is still running (${status}). Nothing was changed; check again in a minute.`);
      expect(r.job).toMatchObject({ status: "failed", output: null, error: "The tool finished without a picture link." });
    }
    expect(outputs(env)).toEqual([]);
    expect((await toolOps(env))[0]).toMatchObject({ status: "failed", reported: null });
  });

  it("keeps a job the provider failed as failed, with the provider's reason", async () => {
    const { env, id } = await failedUpscale();
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "failed", error: "The picture was flagged by moderation." }] }).fn);
    const r = (await json(await check(env, id))) as Check;
    expect(r).toMatchObject({ outcome: "failed", message: "Higgsfield says the job failed: The picture was flagged by moderation.", job: { status: "failed", output: null } });
    expect(r.job.error).toBe("The tool failed on the provider: The picture was flagged by moderation");
    expect(outputs(env)).toEqual([]);
    expect((await toolOps(env))[0]).toMatchObject({ status: "failed", reported: null });
  });

  it("finds the result through show_generation_by_ids when the wait gives no link, never takes the studio's own link, and reads a picture served as octet-stream", async () => {
    const { env, id } = await failedUpscale();
    const stub = higgsfieldStub({ waits: [{ status: "completed", media: { id: "med_1", type: "image" }, input_url: "https://studio.test/api/public/object?k=abc" }], shown: { status: "completed", image_url: "https://cdn.test/out.bin" } });
    useHiggsfieldMcpFetch(stub.fn);
    const r = (await json(await check(env, id))) as Check;
    expect(r).toMatchObject({ outcome: "done", job: { status: "done", reported: 12 } });
    expect(stub.rpc.filter((x) => x.method === "tools/call").map((x) => x.name)).toEqual(["jobs_wait", "show_generation_by_ids"]);
    expect(outputs(env)).toEqual([`u2/b1/output/t1/${id}.png`]);
    expect(env.BUCKET.objects.get(`u2/b1/output/t1/${id}.png`)!.httpMetadata?.contentType).toBe("image/png");
  });

  it("refuses a job that is not failed or never had a provider id, and answers a done one without asking", async () => {
    const { env, id } = await failedUpscale();
    await env.DB.prepare("UPDATE photo_tool_jobs SET provider_job = NULL WHERE id = ?").bind(id).run();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    const none = await check(env, id);
    expect(none.status).toBe(409);
    expect(((await json(none)) as Check).error).toMatch(/never gave this run a job id/);
    await env.DB.prepare("UPDATE photo_tool_jobs SET status = 'running', provider_job = 'job-up-1' WHERE id = ?").bind(id).run();
    expect(((await json(await check(env, id))) as Check).outcome).toBe("running");
    expect(stub.rpc.filter((x) => x.method === "tools/call")).toEqual([]);
    expect((await check(env, "nope")).status).toBe(404);
  });

  it("writes a ledger row for a job that has none, and never a second figure for one already counted", async () => {
    const { env, id } = await failedUpscale();
    // A row already closed with a figure (counted by hand, say): left as it is.
    await env.DB.prepare("UPDATE integration_ops SET status = 'done', reported = 3 WHERE kind = 'image.tool'").run();
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "completed", credits_used: 2, result: { url: "https://cdn.test/out.png" } }] }).fn);
    const r = (await json(await check(env, id))) as Check;
    expect(r.job).toMatchObject({ status: "done", reported: 3 });
    expect(await toolOps(env)).toHaveLength(1);
    expect((await toolOps(env))[0].reported).toBe(3);

    // A job with no ledger row at all gets exactly one.
    const second = await failedUpscale();
    await second.env.DB.prepare("UPDATE photo_tool_jobs SET op_id = NULL").run();
    await second.env.DB.prepare("DELETE FROM integration_ops WHERE kind = 'image.tool'").run();
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "completed", credits_used: 2, result: { url: "https://cdn.test/out.png" } }] }).fn);
    expect(((await json(await check(second.env, second.id))) as Check).outcome).toBe("done");
    expect(((await json(await check(second.env, second.id))) as Check).outcome).toBe("done");
    const rows = await toolOps(second.env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "higgsfield", status: "done", estimate: 12, reported: 2, task_id: "job-up-1" });
  });
});

describe("Check again on a Magnific job", () => {
  it("collects a finished creation with creations_wait and closes the ledger row from the estimate", async () => {
    const env = await seed();
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    useMcpFetch(magnificStub().fn);
    const go = (await json(await run(env, { tool: "mg-upscale", options: { preset: "portrait" } }))) as { job: Job };
    await recordFailed(env, go.job.id, "Magnific could not be asked for half an hour.");
    resetPhotoToolCaches();
    const stub = magnificStub({ waits: [{ status: "processing" }], got: { status: "completed", url: "https://cdn.test/magnific/out.jpg" } });
    useMcpFetch(stub.fn);
    const r = (await json(await check(env, go.job.id))) as Check;
    expect(r).toMatchObject({ outcome: "done", job: { status: "done", reported: 8 } });
    expect(notStatus(stub.rpc)).toEqual([]);
    expect(stub.rpc.filter((x) => x.name === "images_upscale")).toEqual([]);
    expect(outputs(env)).toEqual([`u2/b1/output/t1/${go.job.id}.jpg`]);
    const rows = await toolOps(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "freepik", status: "done", estimate: 8, reported: 8, task_id: "cr_up_1" });
  });
});

describe("the settler", () => {
  it("does not record a job as failed when the one-second wait says timeout, and collects it on the next poll", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "timeout" }, { status: "completed", result: { url: "https://cdn.test/out.png" } }] }).fn);
    await run(env, { tool: "hf-upscale" });
    expect((await listJobs(env))[0]).toMatchObject({ status: "running", error: null });
    expect((await listJobs(env))[0]).toMatchObject({ status: "done" });
  });

  it("finds a result link the parser does not know where to look for, instead of recording the job as failed", async () => {
    const env = await seed();
    await signedInHiggsfield(env);
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "completed", media: { id: "med_1", type: "image" }, image_url: "https://cdn.test/out.png" }] }).fn);
    await run(env, { tool: "hf-upscale" });
    expect((await listJobs(env))[0]).toMatchObject({ status: "done", error: null });
    expect(outputs(env)).toHaveLength(1);
  });

  it("reads links and picture bytes defensively", () => {
    const env = { PUBLIC_BASE_URL: "https://studio.test" } as never;
    expect(resultLink(env, "https://studio.test/api/public/object?k=1", { out: "https://cdn.test/a.webp" })).toBe("https://cdn.test/a.webp");
    expect(resultLink(env, null, { a: "https://cdn.test/page", b: ["https://cdn.test/b.jpg"] })).toBe("https://cdn.test/b.jpg");
    expect(resultLink(env, null, null, "Done: https://cdn.test/c.png")).toBe("https://cdn.test/c.png");
    expect(resultLink(env, null, { only: "https://studio.test/x.png" })).toBeNull();
    expect(sniffPicture(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer)).toBe("jpg");
    expect(sniffPicture(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer)).toBe("png");
    expect(sniffPicture(new Uint8Array([...new TextEncoder().encode("RIFF0000WEBPVP8 ")]).buffer)).toBe("webp");
    expect(sniffPicture(new Uint8Array([...new TextEncoder().encode("<html>")]).buffer)).toBeNull();
  });
});

describe("Use as the post's picture follows the client hold", () => {
  it("keeps the result beside the client's picture on a post the client answered, and replaces it on one they have not", async () => {
    const { env, id } = await failedUpscale();
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "completed", result: { url: "https://cdn.test/out.png" } }] }).fn);
    expect(((await json(await check(env, id))) as Check).outcome).toBe("done");
    const setAnswer = async (status: "approved" | "changes" | null) => {
      const row = await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>();
      const config = JSON.parse(row!.config) as Record<string, unknown>;
      config.shareToken = "d".repeat(32);
      config.approvals = status ? { "1": { status, at: 1 } } : {};
      await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(config)).run();
    };
    const output = async () => (await env.DB.prepare("SELECT output FROM tasks WHERE id = 't1'").first<{ output: string }>())!.output;
    for (const status of ["approved", "changes"] as const) {
      await setAnswer(status);
      const used = (await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${id}/use`, { as: "picture", batch: "b1" }))) as { held: string; message: string; current: string };
      expect(used.held).toBe(status);
      expect(used.current).toBe("u2/b1/output/t1/a.png");
      expect(await output()).toBe("u2/b1/output/t1/a.png");
    }
    const notes = ((await env.DB.prepare("SELECT note FROM post_takes WHERE batch = 'b1' AND post = 1").all()).results as { note: string }[]).map((t) => t.note);
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.endsWith("new version (the client's version stays)"))).toBe(true);
    // Unanswered, link out: the result is the post's picture at once.
    await setAnswer(null);
    const used = (await json(await postJson(app(), env, `/api/studio/photo/tools/jobs/${id}/use`, { as: "picture", batch: "b1" }))) as { held: string | null; key: string };
    expect(used.held).toBeNull();
    expect(await output()).toBe(used.key);
  });
});

describe("a preset answered 'Preset submitted … job_ids: [\"…\"]' (live, Street Skate)", () => {
  const live = 'Preset submitted. Final job_ids: ["7e3a7cee-039b-4645-87bb-560c7d11ecba"]. Do not execute it again. Call job_display, then jobs_wait.';
  it("reads the job id wherever the prose puts it", async () => {
    const { parseJobs } = await import("../server/higgsfield-mcp");
    expect(parseJobs({ content: [{ type: "text", text: live }] } as never).map((j) => j.jobId)).toEqual(["7e3a7cee-039b-4645-87bb-560c7d11ecba"]);
    expect(parseJobs({ content: [{ type: "text", text: "Submitted 1 job.\n- 30eade26-1111-4222-8333-444455556666" }] } as never).map((j) => j.jobId)).toEqual(["30eade26-1111-4222-8333-444455556666"]);
  });
  it("Check again finds the id in the error of a run recorded before, and collects it", async () => {
    const { env, id } = await failedUpscale();
    await env.DB.prepare("UPDATE photo_tool_jobs SET provider_job = NULL, error = ? WHERE id = ?").bind(`Higgsfield did not start the tool: ${live}`, id).run();
    const stub = higgsfieldStub({ waits: [{ status: "completed", credits_used: 2, result: { url: "https://cdn.test/out.png" } }] });
    useHiggsfieldMcpFetch(stub.fn);
    const r = (await json(await check(env, id))) as Check;
    expect(r).toMatchObject({ ok: true, outcome: "done", job: { id, status: "done" } });
    const sent = stub.rpc.filter((x) => x.method === "tools/call");
    expect(sent.map((x) => x.name)).toEqual(["jobs_wait"]);
    expect(JSON.stringify(sent[0])).toContain("7e3a7cee-039b-4645-87bb-560c7d11ecba");
  });
});
