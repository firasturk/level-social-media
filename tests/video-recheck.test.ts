/**
 * "Check again" on a Video studio clip recorded as failed (server/video-recheck.ts), against
 * stand-ins for Higgsfield (the MCP sign-in and the Cloud API) and Magnific: a status read only,
 * the mp4 stored exactly as the settler stores it, the run's ledger row closed once, a second press
 * adding nothing, "still running" and "failed there" said plainly, and the first clip of a post the
 * client answered kept beside the picture. No call leaves the test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, higgsfieldStub, json, magnificStub, MAGNIFIC_TOKEN, ops, postJson, seed, signedInHiggsfield, type FakeEnv, type Rpc } from "./support/photo-mcp";
import { MCP_PROVIDER, resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { useMcpFetch } from "../server/freepik-mcp";
import { setSetting, FREEPIK_MCP_TOKEN_SETTING } from "../server/settings";

const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const mp4 = () => new Response(SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength) as ArrayBuffer, { status: 200, headers: { "content-type": "video/mp4" } });
type Answer = { ok: boolean; outcome: string; message: string; video: { id: string; status: string; forClient: boolean; error: string | null; url: string | null }; error?: string };

const check = (env: FakeEnv, role: "admin" | "member" = "admin", id = "vf1") => postJson(app(role), env, "/api/studio/posts/video/check", { batch: "b1", id });
const videoRow = (env: FakeEnv) => env.DB.prepare("SELECT status, key, error, for_client FROM videos WHERE id = 'vf1'").first<{ status: string; key: string | null; error: string | null; for_client: number }>();
const videoOps = async (env: FakeEnv) => (await ops(env)).results.filter((o) => o.kind.startsWith("video"));
const calls = (rpc: Rpc[]) => rpc.filter((x) => x.method === "tools/call").map((x) => x.name);

/** A clip recorded as failed: its row and its ledger row, as the settler leaves them. */
async function failedClip(provider: string, requestId: string, ledger: "higgsfield" | "freepik", estimate = 30) {
  const env = await seed();
  const t = Date.now() - 3_600_000;
  await env.DB.prepare("INSERT INTO integration_ops (id, provider, kind, user_id, batch, post, task_id, estimate, reported, status, note, created, updated) VALUES ('op1', ?, 'video', 'u1', 'b1', 1, ?, ?, NULL, 'failed', 'The clip finished without a video link.', ?, ?)").bind(ledger, requestId, estimate, t, t).run();
  await env.DB.prepare(
    "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES ('vf1', 'b1', 1, 't1', 'u1', 'kling', 'idea', 'failed', ?, NULL, 'The clip finished without a video link.', ?, ?, ?, ?, 'u2/b1/output/t1/a.png', 'picture', 0, 'op1')",
  )
    .bind(requestId, t, t, provider, JSON.stringify({ estimate, unit: "credits" }))
    .run();
  return env;
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  useMcpFetch(null);
  resetHiggsfieldMcpCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useHiggsfieldMcpFetch(null);
  useMcpFetch(null);
  vi.unstubAllGlobals();
});

describe("Check again on a Higgsfield clip (the sign-in)", () => {
  it("collects a clip Higgsfield finished: the mp4 under the clip's key, the version done (the client's, the post being unanswered), the ledger row closed once", async () => {
    const env = await failedClip(MCP_PROVIDER, "job-v1", "higgsfield");
    await signedInHiggsfield(env);
    const stub = higgsfieldStub({ waits: [{ status: "completed", result: { url: "https://cdn.test/clip.mp4" } }] });
    useHiggsfieldMcpFetch((input, init) => (String(input instanceof Request ? input.url : input) === "https://cdn.test/clip.mp4" ? Promise.resolve(mp4()) : stub.fn(input, init)));
    const r = (await json(await check(env))) as Answer;
    expect(r).toMatchObject({ ok: true, outcome: "done", video: { id: "vf1", status: "done", forClient: true } });
    expect(calls(stub.rpc)).toEqual(["jobs_wait"]);
    expect(await videoRow(env)).toMatchObject({ status: "done", key: "u2/b1/video/t1/vf1.mp4", error: null, for_client: 1 });
    expect(env.BUCKET.objects.has("u2/b1/video/t1/vf1.mp4")).toBe(true);
    let rows = await videoOps(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "done", estimate: 30, reported: 30, task_id: "job-v1" });
    expect(rows[0].note).toMatch(/^30 credits \(from the estimate\) · collected by Check again/);
    // Pressed again: nothing asked, nothing added.
    const before = stub.rpc.length;
    const again = (await json(await check(env))) as Answer;
    expect(again.outcome).toBe("done");
    expect(again.message).toMatch(/^Already collected/);
    expect(stub.rpc).toHaveLength(before);
    rows = await videoOps(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].reported).toBe(30);
  });

  it("keeps the picture as the client's version when the client answered the post", async () => {
    const env = await failedClip(MCP_PROVIDER, "job-v1", "higgsfield");
    const row = await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>();
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify({ ...JSON.parse(row!.config), approvals: { "1": { status: "approved", at: 1 } } })).run();
    await signedInHiggsfield(env);
    const stub = higgsfieldStub({ waits: [{ status: "completed", credits_used: 24, result: { url: "https://cdn.test/clip.mp4" } }] });
    useHiggsfieldMcpFetch((input, init) => (String(input instanceof Request ? input.url : input) === "https://cdn.test/clip.mp4" ? Promise.resolve(mp4()) : stub.fn(input, init)));
    const r = (await json(await check(env))) as Answer;
    expect(r).toMatchObject({ outcome: "done", video: { status: "done", forClient: false } });
    expect((await videoOps(env))[0]).toMatchObject({ status: "done", reported: 24 });
  });

  it("says still running, or failed with Higgsfield's reason, and changes nothing else", async () => {
    const env = await failedClip(MCP_PROVIDER, "job-v1", "higgsfield");
    await signedInHiggsfield(env);
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "in_progress" }] }).fn);
    const running = (await json(await check(env))) as Answer;
    expect(running).toMatchObject({ outcome: "running", message: "Higgsfield says the job is still running (in_progress). Nothing was changed; check again in a minute.", video: { status: "failed" } });
    resetHiggsfieldMcpCaches();
    useHiggsfieldMcpFetch(higgsfieldStub({ waits: [{ status: "nsfw", error: "Rejected by moderation" }] }).fn);
    const failed = (await json(await check(env))) as Answer;
    expect(failed).toMatchObject({ outcome: "failed", message: "Higgsfield says the job failed: Rejected by moderation.", video: { status: "failed", error: "Failed on Higgsfield: Rejected by moderation" } });
    expect(await videoRow(env)).toMatchObject({ status: "failed", key: null });
    expect((await videoOps(env))[0]).toMatchObject({ status: "failed", reported: null });
  });
});

describe("Check again on a Magnific clip", () => {
  it("collects a creation Magnific finished, from the estimate", async () => {
    const env = await failedClip("magnific", "cr_v1", "freepik", 40);
    await setSetting(env, FREEPIK_MCP_TOKEN_SETTING, MAGNIFIC_TOKEN);
    const stub = magnificStub({ waits: [{ status: "completed", url: "https://cdn.test/magnific/clip.mp4" }] });
    useMcpFetch((input, init) => (String(input instanceof Request ? input.url : input) === "https://cdn.test/magnific/clip.mp4" ? Promise.resolve(mp4()) : stub.fn(input, init)));
    const r = (await json(await check(env))) as Answer;
    expect(r).toMatchObject({ outcome: "done", video: { status: "done" } });
    expect(calls(stub.rpc)).toEqual(["creations_wait"]);
    expect((await videoOps(env))[0]).toMatchObject({ provider: "freepik", status: "done", reported: 40 });
  });
});

describe("Check again on a Higgsfield Cloud API clip", () => {
  it("reads the request's status and collects the clip; the ledger row is closed as the settler closes it", async () => {
    const env = await failedClip("higgsfield", "req-1", "higgsfield");
    (env as unknown as Record<string, string>).HIGGSFIELD_API_KEY = "id:secret";
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        seen.push(url);
        if (url === "https://higgsfield.test/requests/req-1/status") return Response.json({ status: "completed", video: { url: "https://cdn.test/out.mp4" } });
        if (url === "https://cdn.test/out.mp4") return mp4();
        throw new Error(`unexpected ${url}`);
      }),
    );
    const r = (await json(await check(env))) as Answer;
    expect(r).toMatchObject({ outcome: "done", video: { status: "done" } });
    expect(seen).toEqual(["https://higgsfield.test/requests/req-1/status", "https://cdn.test/out.mp4"]);
    expect((await videoOps(env))[0]).toMatchObject({ status: "done", reported: null });
  });

  it("refuses a version no provider made", async () => {
    const env = await failedClip("upload", "x", "higgsfield");
    const r = await check(env);
    expect(r.status).toBe(409);
    expect(((await json(r)) as Answer).error).toMatch(/not made by a provider/);
  });
});
