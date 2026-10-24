/**
 * Campaign Autopilot's live production path (server/campaign-runner.ts) with the providers
 * mocked at the studio's own tool functions: the image engine run (`generateRun`), Magnific
 * "Change camera" (`estimatePhotoTool` / `runPhotoTool`) and Higgsfield clips on the subscription
 * credits (`estimateMcpVideo` / `submitMcpVideo`). Proves each step calls the existing tool with
 * the right input (each shot's clip from its own starting picture), reserves in the campaign's
 * ledger before the request, never switches an engine or the billing silently, and produces
 * editable Reels. No network call is made: the paid guard fails on any.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";
import { demoCampaignAnswer } from "../shared/campaign-planner";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };

const calls = vi.hoisted(() => ({
  generate: [] as { indexes?: number[]; approve?: boolean; run?: string; regenerate?: boolean; reserved: number }[],
  tool: [] as { index: number; camera: string; reserved: number }[],
  frame: [] as { model: string; prompt: string; images: number; aspectRatio: string; reserved: number }[],
  clip: [] as { index: number; model: string; duration?: number; aspect?: string; prompt: string; posterKey?: string; reserved: number }[],
  billing: "credits" as "credits" | "cloud",
  env: null as unknown as { DB: D1Database; BUCKET: R2Bucket },
  campaign: "",
}));

async function reservedNow(unit: string): Promise<number> {
  const r = await calls.env.DB.prepare("SELECT reserved FROM spend WHERE scope = ?").bind(`campaign:${calls.campaign}:${unit}`).first<{ reserved: number }>();
  return r?.reserved ?? 0;
}

vi.mock("../server/posts", async (orig) => {
  const real = await orig<typeof import("../server/posts")>();
  return {
    ...real,
    // The planner: the same plan the preview fixture writes (a text model is not called here).
    askText: async (_env: unknown, instruction: string) => JSON.stringify(demoCampaignAnswer(instruction)),
    generateRun: async (env: { DB: D1Database; BUCKET: R2Bucket }, _u: unknown, d: { batch: string; indexes?: number[]; approve?: boolean; run?: string; regenerate?: boolean }) => {
      calls.generate.push({ indexes: d.indexes, approve: d.approve, run: d.run, regenerate: d.regenerate, reserved: await reservedNow("usd") });
      const index = d.indexes![0];
      const id = `task-${index}`;
      const key = `u1/${d.batch}/output/${id}/pic.png`;
      await env.BUCKET.put(key, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { httpMetadata: { contentType: "image/png" } });
      const t = Date.now() + 5;
      await env.DB.prepare("INSERT OR IGNORE INTO sources (id, batch, name, stem, key, mime, size, role, kind, created) VALUES ('s', ?, 'x', 'x', 'k', 'image/png', 0, 'supporting', 'reference', 0)").bind(d.batch).run();
      await env.DB.prepare("INSERT OR REPLACE INTO tasks (id, batch, source, card, status, output, prompt, brief, post, caption, updated) VALUES (?, ?, 's', ?, 'ready', ?, '', '{}', ?, '{}', ?)").bind(id, d.batch, index, key, index, t).run();
      await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, created) VALUES (?, ?, ?, ?, 'made', ?, 0.134, 'engine', ?)").bind(`take-${index}-${t}`, d.batch, index, id, key, t).run();
      return { status: 200, body: { ok: true } };
    },
  };
});

vi.mock("../server/photo-tools", async (orig) => {
  const real = await orig<typeof import("../server/photo-tools")>();
  return {
    ...real,
    estimatePhotoTool: async () => ({ credits: 12, balance: 900, notes: [], text: "" }),
    runPhotoTool: async (env: { DB: D1Database; BUCKET: R2Bucket }, _u: unknown, d: { batch: string; index: number; options: { camera: string } }) => {
      calls.tool.push({ index: d.index, camera: d.options.camera, reserved: await reservedNow("magnific-credits") });
      const id = `job-${d.index}-${d.options.camera}`;
      const key = `u1/${d.batch}/tools/${id}.png`;
      await env.BUCKET.put(key, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { httpMetadata: { contentType: "image/png" } });
      await env.DB.prepare("INSERT INTO photo_tool_jobs (id, batch, post, task, owner, provider, tool, label, options, input_key, output_key, status, estimate, reported, settings, created, updated) VALUES (?, ?, ?, 't', 'u1', 'magnific', 'mg-camera', 'Change camera', '{}', 'in', ?, 'done', 12, 11.5, '{}', ?, ?)").bind(id, d.batch, d.index, key, Date.now(), Date.now()).run();
      return { id, status: "done" };
    },
    settlePhotoJobs: async () => undefined,
  };
});

vi.mock("../server/engine", async (orig) => {
  const real = await orig<typeof import("../server/engine")>();
  return {
    ...real,
    // Google's image engine for each shot's own starting picture: one call, a picture back.
    makeGoogleClient: async () => ({
      edit: async (job: { model: string; prompt: string; images: unknown[]; aspectRatio: string }) => {
        calls.frame.push({ model: job.model, prompt: job.prompt, images: job.images.length, aspectRatio: job.aspectRatio, reserved: await reservedNow("usd") });
        return { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer, mime: "image/png" };
      },
    }),
  };
});

vi.mock("../server/higgsfield-billing", async (orig) => ({ ...(await orig<typeof import("../server/higgsfield-billing")>()), higgsfieldBilling: async () => calls.billing }));

vi.mock("../server/higgsfield-mcp", async (orig) => {
  const real = await orig<typeof import("../server/higgsfield-mcp")>();
  return {
    ...real,
    HiggsfieldMcp: class {
      async connect() {
        throw new Error("not signed in (test)");
      }
    },
    estimateMcpVideo: async () => ({ credits: 30, balance: 1000, plan: null, unlimChoice: null }),
    submitMcpVideo: async (env: { DB: D1Database }, _u: unknown, d: { batch: string; index: number; model: string; prompt: string; duration?: number; aspect?: string }, opts: { posterKey?: string }) => {
      calls.clip.push({ index: d.index, model: d.model, duration: d.duration, aspect: d.aspect, prompt: d.prompt, posterKey: opts.posterKey, reserved: await reservedNow("higgsfield-credits") });
      const id = `clip-${calls.clip.length}`;
      await env.DB.prepare("INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, key, created, updated, provider, settings, poster_key, source, for_client) VALUES (?, ?, ?, 't', 'u1', ?, ?, 'done', ?, ?, ?, 'higgsfield-mcp', ?, ?, 'picture', 0)").bind(id, d.batch, d.index, d.model, d.prompt, `u1/${d.batch}/video/${id}.mp4`, Date.now(), Date.now(), JSON.stringify({ duration: d.duration ?? 5 }), opts.posterKey ?? null).run();
      return { id };
    },
  };
});

const { studioRoutes } = await import("../server/studio");
const { advanceCampaigns } = await import("../server/campaign-runner");
const { StudioError } = await import("../server/errors");

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => undefined)), passThroughOnException: () => undefined };
function app() {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", ADMIN);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}
async function call<T = Record<string, unknown>>(env: FakeEnv, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await app().request(`/api/studio/campaigns${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env, ctx as never);
  const out = { status: r.status, body: (await r.json()) as T };
  await Promise.all(pending.splice(0));
  return out;
}
interface C {
  id: string;
  status: string;
  pauseReason: string | null;
  plan: { rev: number; videos: { key: string; shots: { key: string; source: string }[] }[] };
  proposal: { items: string[]; signature: string; unaccepted: unknown[]; caps: { unit: string; cap: number }[] };
  steps: { step: string; item: string; kind: string; status: string; post: number | null; output: string | null; note: string | null; spent: number }[];
}

async function seed(model = "gemini-3-pro-image") {
  const env = fakeEnv();
  calls.env = env;
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'habibah-live-test', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-12", { postCount: 1, plannedAt: 1000, model, plan: [{ index: 1, type: "lifestyle", title: "Hello", brief: "A table", caption: "", hashtags: "" } as Post] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'December', ?, 'idle', ?, ?, 'c1', '2026-12')").bind(JSON.stringify(config), t, t).run();
  return env;
}

async function plannedAndPriced(env: FakeEnv): Promise<C> {
  const r = await call<{ campaign: C }>(env, "POST", "", { batch: "b1", setup: { imagePosts: 3, videos: 4, shotsPerVideo: 4, videoSeconds: 16, objective: "Winter launch" } });
  expect(r.status).toBe(200);
  const c = r.body.campaign;
  calls.campaign = c.id;
  // The provider estimates as "Refresh estimates" would have learned them (get_cost / simulate_cost).
  const row = await env.DB.prepare("SELECT prices FROM campaign_plans WHERE id = ?").bind(c.id).first<{ prices: string }>();
  const prices = JSON.parse(row!.prices) as Record<string, { amount: number | null; unit: string; source: string | null }>;
  for (const [k, p] of Object.entries(prices)) if (p.amount === null) prices[k] = { amount: k.startsWith("tool:") ? 12 : 30, unit: p.unit, source: "provider" };
  await env.DB.prepare("UPDATE campaign_plans SET prices = ? WHERE id = ?").bind(JSON.stringify(prices), c.id).run();
  return (await call<{ campaign: C }>(env, "GET", `/${c.id}`)).body.campaign;
}

/** Production passes (the page's and the cron's); the admin approves each Reel's starting pictures as they are ready. */
async function tick(env: FakeEnv, id: string, n = 8): Promise<C> {
  let c = (await call<{ campaign: C }>(env, "GET", `/${id}`)).body.campaign;
  for (let i = 0; i < n; i++) {
    c = (await call<{ campaign: C }>(env, "POST", `/${id}/tick`)).body.campaign;
    await advanceCampaigns(env as never, ctx.waitUntil);
    await Promise.all(pending.splice(0));
    c = (await call<{ campaign: C }>(env, "GET", `/${id}`)).body.campaign;
    for (const r of c.steps.filter((s) => s.kind === "review" && s.status === "ready")) c = (await call<{ campaign: C }>(env, "POST", `/${id}/steps/${encodeURIComponent(r.step)}/approve-shots`)).body.campaign;
  }
  return c;
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  calls.generate.length = 0;
  calls.tool.length = 0;
  calls.frame.length = 0;
  calls.clip.length = 0;
  calls.billing = "credits";
});
afterEach(() => expect(reached).toEqual([]));

describe("Campaign Autopilot live path (providers mocked at the studio's tools)", () => {
  it("nothing is called before approval; after it every step goes through the existing tool, reserved first, each clip from its own starting picture", async () => {
    const env = await seed();
    const c = await plannedAndPriced(env);
    expect(c.proposal.unaccepted).toEqual([]);
    await tick(env, c.id, 2);
    expect([calls.generate.length, calls.tool.length, calls.frame.length, calls.clip.length]).toEqual([0, 0, 0, 0]);

    const a = await call<{ campaign: C }>(env, "POST", `/${c.id}/approve`, { items: c.proposal.items, retries: 1, signature: c.proposal.signature, acceptedUnknown: [] });
    expect(a.status).toBe(200);
    const p = await tick(env, c.id, 14);
    // 3 post pictures and 4 key frames through the image engine, each approved for its run id.
    expect(calls.generate).toHaveLength(7);
    expect(calls.generate.every((g) => g.approve === true && g.indexes?.length === 1 && g.run?.startsWith(`campaign:${c.id}:`))).toBe(true);
    // 3 other shots per video, each its own picture from Google's engine: the key frame as reference, the shot's own words.
    expect(calls.tool).toHaveLength(0);
    expect(calls.frame).toHaveLength(12);
    expect(calls.frame.every((f) => f.model === "gemini-3-pro-image" && f.aspectRatio === "9:16" && f.images >= 1 && f.reserved > 0)).toBe(true);
    for (const v of p.plan.videos as unknown as { shots: { key: string; source: string; action: string }[] }[]) for (const shot of v.shots.slice(1)) expect(calls.frame.some((f) => f.prompt.includes(`THIS SHOT: ${shot.action}`))).toBe(true);
    expect(calls.frame.every((f) => /different camera setup in the same scene/.test(f.prompt))).toBe(true);
    // 16 clips on the subscription credits, each from its shot's starting picture.
    expect(calls.clip).toHaveLength(16);
    for (const v of p.plan.videos) {
      const key = p.steps.find((s) => s.step === `${v.key}:-:image`)!;
      const keyPicture = (await env.DB.prepare("SELECT output_key FROM campaign_steps WHERE campaign = ? AND step = ?").bind(c.id, key.step).first<{ output_key: string }>())!.output_key;
      const post = key.post!;
      const clips = calls.clip.filter((x) => x.index === post);
      expect(clips).toHaveLength(4);
      expect(clips[0].posterKey).toBe(keyPicture);
      for (const x of clips.slice(1)) expect(x.posterKey).toMatch(/\/campaign\/.+-frame-1\.png$/);
      expect(new Set(clips.map((x) => x.posterKey)).size).toBe(4);
      expect(clips.every((x) => x.aspect === "9:16" && x.duration === 5 && x.model === "seedance")).toBe(true);
    }
    // Every request found its reservation already made in its unit.
    expect(calls.generate.every((g) => g.reserved > 0)).toBe(true);
    expect(calls.clip.every((x) => x.reserved > 0)).toBe(true);
    const usd = await env.DB.prepare("SELECT approved, reserved FROM spend WHERE scope = ?").bind(`campaign:${c.id}:usd`).first<{ approved: number; reserved: number }>();
    expect(usd!.reserved).toBeLessThanOrEqual(usd!.approved);
    // The Reels: assembled as editable projects, waiting for the browser render.
    expect(p.steps.filter((s) => s.kind === "assemble").every((s) => s.status === "done")).toBe(true);
    expect(p.steps.filter((s) => s.kind === "render").every((s) => s.status === "ready")).toBe(true);
    const projects = await env.DB.prepare("SELECT COUNT(*) AS n FROM video_projects WHERE batch = 'b1'").first<{ n: number }>();
    expect(projects!.n).toBe(4);
  });

  it("Magnific Change camera stays a choice for the shot pictures: other angles of the key frame, never the same twice", async () => {
    const env = await seed();
    let c = await plannedAndPriced(env);
    const full = (await env.DB.prepare("SELECT plan FROM campaign_plans WHERE id = ?").bind(c.id).first<{ plan: string }>())!;
    const plan = JSON.parse(full.plan) as { rev: number; videos: { frameEngine: { kind: string; model: string } }[] };
    plan.videos = plan.videos.map((v) => ({ ...v, frameEngine: { kind: "mg-camera", model: "images_change_camera" } }));
    const saved = await call<{ campaign: C }>(env, "PUT", `/${c.id}/plan`, { plan, rev: plan.rev });
    expect(saved.status).toBe(200);
    c = saved.body.campaign;
    const row = await env.DB.prepare("SELECT prices FROM campaign_plans WHERE id = ?").bind(c.id).first<{ prices: string }>();
    const prices = JSON.parse(row!.prices) as Record<string, { amount: number | null; unit: string; source: string | null }>;
    prices["tool:mg-camera"] = { amount: 12, unit: "magnific-credits", source: "provider" };
    await env.DB.prepare("UPDATE campaign_plans SET prices = ? WHERE id = ?").bind(JSON.stringify(prices), c.id).run();
    c = (await call<{ campaign: C }>(env, "GET", `/${c.id}`)).body.campaign;
    await call(env, "POST", `/${c.id}/approve`, { items: c.proposal.items, retries: 1, signature: c.proposal.signature, acceptedUnknown: [] });
    await tick(env, c.id, 14);
    expect(calls.frame).toHaveLength(0);
    expect(calls.tool).toHaveLength(12);
    const byCard = new Map<number, string[]>();
    for (const t of calls.tool) byCard.set(t.index, [...(byCard.get(t.index) ?? []), t.camera]);
    for (const cams of byCard.values()) expect(new Set(cams).size).toBe(cams.length);
    expect(calls.tool.every((t) => t.reserved > 0)).toBe(true);
    // Reported costs settle the reservations: Magnific reported 11.5 per angle.
    const magnific = await env.DB.prepare("SELECT approved, reserved FROM spend WHERE scope = ?").bind(`campaign:${c.id}:magnific-credits`).first<{ approved: number; reserved: number }>();
    expect(magnific!.reserved).toBeCloseTo(12 * 11.5, 3);
    expect(magnific!.reserved).toBeLessThanOrEqual(magnific!.approved);
    // Switched to the image engine after production: the frames start over in dollars, not 11.5 credits + dollars.
    const now2 = (await env.DB.prepare("SELECT plan FROM campaign_plans WHERE id = ?").bind(c.id).first<{ plan: string }>())!;
    const plan2 = JSON.parse(now2.plan) as { rev: number; videos: { frameEngine: { kind: string; model: string } }[] };
    plan2.videos = plan2.videos.map((v) => ({ ...v, frameEngine: { kind: "engine", model: "gemini-3-pro-image" } }));
    const edited = await call<{ campaign: C }>(env, "PUT", `/${c.id}/plan`, { plan: plan2, rev: plan2.rev });
    expect(edited.status).toBe(200);
    {
      const p2 = edited.body.campaign as unknown as { proposal: { items: string[]; signature: string } };
      await call(env, "POST", `/${c.id}/approve`, { items: p2.proposal.items, retries: 1, signature: p2.proposal.signature, acceptedUnknown: [] });
      const frames = (await env.DB.prepare("SELECT unit, spent FROM campaign_steps WHERE campaign = ? AND kind = 'frame'").bind(c.id).all<{ unit: string; spent: number }>()).results;
      expect(frames.every((f) => f.unit === "usd" && f.spent === 0)).toBe(true);
    }
  });

  it("switching the Higgsfield billing after approval pauses the clips: no clip goes to the other account", async () => {
    const env = await seed();
    const c = await plannedAndPriced(env);
    await call(env, "POST", `/${c.id}/approve`, { items: c.proposal.items, retries: 1, signature: c.proposal.signature, acceptedUnknown: [] });
    calls.billing = "cloud";
    const p = await tick(env, c.id);
    expect(calls.clip).toHaveLength(0);
    expect(p.status).toBe("paused");
    expect(p.pauseReason).toMatch(/nothing was switched silently/);
  });

  it("a month switched to another image engine after approval pauses the pictures instead of using it", async () => {
    const env = await seed();
    const c = await plannedAndPriced(env);
    await call(env, "POST", `/${c.id}/approve`, { items: c.proposal.items, retries: 1, signature: c.proposal.signature, acceptedUnknown: [] });
    const row = await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>();
    const config = JSON.parse(row!.config) as Config;
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'").bind(JSON.stringify({ ...config, model: "gpt-image-2" })).run();
    const p = await tick(env, c.id, 3);
    expect(calls.generate).toHaveLength(0);
    expect(p.status).toBe("paused");
    expect(p.steps.find((s) => s.kind === "image" && s.status === "paused")!.note).toMatch(/approved for gemini-3-pro-image/);
  });
});
