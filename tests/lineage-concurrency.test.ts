import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceBatch } from "../server/engine";
import { approveSpend } from "../server/spend";
import { setSetting, FAL_KEY_SETTING } from "../server/settings";
import { postConfig } from "../shared/config";
import { olderIdea, type Post, type PostBrief } from "../shared/posts";
import { fakeEnv } from "./support/fakes";

/**
 * Lineage while things move: an idea edited during a run, a result arriving for a request the
 * post no longer waits for, and a replacement that fails. Fake D1, mocked fal transport.
 */
const T0 = 1_700_000_000_000;
const MODEL = "fal/bytedance/seedream/v5/pro/edit";
const brief = (index: number): PostBrief => ({ post: true, index, type: "product", title: "t", brief: "The cup in a sign.", palette: [], style: "", theme: "", format: "4:5", ref: null, refIsSource: false, hasProduct: true, product: "a cup" });

async function seed(opts: { output?: string | null; madeFor?: number | null; status?: string } = {}) {
  const env = fakeEnv();
  await setSetting(env, FAL_KEY_SETTING, "00000000-0000-0000-0000-000000000000:0123456789abcdef0123456789abcdef");
  const plan: Post[] = [{ index: 1, type: "product", title: "t", brief: "The cup in a sign.", caption: "", hashtags: "", product: "cup", ideaAt: T0 }];
  const config = postConfig("c1", "2026-10", { model: MODEL, plan, plannedAt: T0 });
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(T0).run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'm', ?, 'running', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), T0, T0).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created) VALUES ('s1', 'b1', 'cup.jpg', 'cup', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?)").bind(T0).run();
  await env.BUCKET.put("u1/b1/src/s1.jpg", new TextEncoder().encode("src").buffer as ArrayBuffer, { httpMetadata: { contentType: "image/jpeg" } });
  if (opts.output) await env.BUCKET.put(opts.output, new TextEncoder().encode("old").buffer as ArrayBuffer, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, prompt, brief, post, caption, preflight, output, made_for, making_for, updated) VALUES ('t1', 'b1', 's1', 1, ?, '', ?, 1, '{}', '{\"at\":1,\"notes\":[]}', ?, ?, ?, ?)")
    .bind(opts.status ?? "queued", JSON.stringify(brief(1)), opts.output ?? null, opts.madeFor ?? null, T0, T0)
    .run();
  await approveSpend(env, "b1", 5);
  return env;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** fal's answers: submit, then the status of each request id, then the picture. */
function falMock(statusOf: Record<string, "pending" | "done" | "failed">) {
  let n = 0;
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://queue.fal.run/") && !url.includes("/requests/")) return json({ request_id: `req-${++n}` });
    const m = /\/requests\/(req-\d+)(\/status)?/.exec(url);
    if (m) {
      const st = statusOf[m[1]] ?? "pending";
      if (m[2]) return json({ status: st === "done" ? "COMPLETED" : st === "failed" ? "COMPLETED" : "IN_PROGRESS" });
      return st === "failed" ? json({ detail: "bad luck" }, 500) : json({ images: [{ url: `https://cdn.test/${m[1]}.jpg` }] });
    }
    if (url.startsWith("https://cdn.test/")) return new Response(new TextEncoder().encode(`picture ${url}`), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    return json({}, 500);
  });
}
const task = (env: ReturnType<typeof fakeEnv>) => env.DB.prepare("SELECT status, output, made_for, making_for, request_id FROM tasks WHERE id = 't1'").first<{ status: string; output: string | null; made_for: number | null; making_for: number | null; request_id: string | null }>();
const setPlanIdeaAt = async (env: ReturnType<typeof fakeEnv>, at: number) => {
  const row = await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>();
  const cfg = JSON.parse(row!.config);
  cfg.plan[0].ideaAt = at;
  await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify(cfg)).run();
  return cfg;
};

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe("lineage while a month moves", () => {
  it("a picture keeps the revision it was submitted for, even when the idea is edited while it is being made", async () => {
    const env = await seed();
    const statuses: Record<string, "pending" | "done" | "failed"> = { "req-1": "pending" };
    vi.stubGlobal("fetch", falMock(statuses));
    await advanceBatch(env, "b1", {});
    expect((await task(env))?.status).toBe("processing");
    // The designer edits the idea while the engine works.
    const cfg = await setPlanIdeaAt(env, T0 + 60_000);
    statuses["req-1"] = "done";
    await advanceBatch(env, "b1", {});
    const t = await task(env);
    expect(t?.output).toMatch(/\/output\//);
    expect(t?.made_for).toBe(T0);
    expect(olderIdea(t, cfg.plan[0], cfg)).toBe(true);
  });

  it("a result for a request the post no longer waits for never replaces the newer one", async () => {
    const env = await seed();
    const statuses: Record<string, "pending" | "done" | "failed"> = { "req-1": "pending" };
    vi.stubGlobal("fetch", falMock(statuses));
    await advanceBatch(env, "b1", {});
    const first = (await task(env))?.request_id;
    // The submission is lost and made again: the post now waits for req-2; req-1 then completes.
    await env.DB.prepare("UPDATE tasks SET status = 'queued', request_id = NULL, lease = NULL, leased_at = NULL, making_for = ? WHERE id = 't1'").bind(T0 + 1).run();
    await advanceBatch(env, "b1", {});
    const second = (await task(env))?.request_id;
    expect(second).not.toBe(first);
    statuses["req-1"] = "done";
    await advanceBatch(env, "b1", {});
    const t = await task(env);
    expect(t?.status).toBe("processing");
    expect(t?.output).toBeNull();
    // A stale claim (the old request id) changes nothing.
    const claimed = await env.DB.prepare("UPDATE tasks SET status = 'finalizing' WHERE id = 't1' AND status = 'processing' AND request_id = ?").bind(first).run();
    expect(claimed.meta.changes).toBe(0);
    statuses["req-2"] = "done";
    await advanceBatch(env, "b1", {});
    expect((await task(env))?.made_for).toBe(T0 + 1);
  });

  it("a failed replacement keeps the previous picture and its lineage", async () => {
    const env = await seed({ output: "u1/b1/output/t1/old.jpg", madeFor: T0 - 5 });
    const statuses: Record<string, "pending" | "done" | "failed"> = { "req-1": "failed" };
    vi.stubGlobal("fetch", falMock(statuses));
    await advanceBatch(env, "b1", {});
    expect((await task(env))?.status).toBe("processing");
    for (let i = 0; i < 3; i++) await advanceBatch(env, "b1", {});
    const t = await task(env);
    expect(t?.output).toBe("u1/b1/output/t1/old.jpg");
    expect(t?.made_for).toBe(T0 - 5);
    expect(["review", "queued", "processing"]).toContain(t?.status);
  });
});
