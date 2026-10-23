/**
 * Campaign Autopilot end to end on the preview's fixtures (server/campaign.ts,
 * server/campaign-runner.ts): a plan of 3 image posts and 4 multishot Reels written from the
 * client's real products and Drive, its counts and costs per unit, edits before approval, nothing
 * made before approval, approval tied to the plan's signature (stale and duplicate approvals),
 * production within the approved scope and budget (a budget stop pauses), a material edit after
 * approval re-running only what changed, a failed step retried alone, the Reels assembled as
 * editable projects and rendered onto their cards. The preview simulates every provider: the paid
 * guard proves no network call at all is made.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import type { Post } from "../shared/posts";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { driveMock } from "../server/drive-mock";
import { validateProject } from "../shared/video-project";
import type { CampaignPlan } from "../shared/campaign-plan";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const SAMPLE = readFileSync(join(process.cwd(), "tests/fixtures/sample-1s.mp4"));
const sampleBytes = () => new Uint8Array(SAMPLE.buffer.slice(SAMPLE.byteOffset, SAMPLE.byteOffset + SAMPLE.byteLength));

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => undefined)), passThroughOnException: () => undefined };

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function call<T = Record<string, unknown>>(env: FakeEnv, method: string, path: string, body?: unknown, user: User = ADMIN): Promise<{ status: number; body: T }> {
  const r = await app(user).request(`/api/studio/campaigns${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env, ctx as never);
  const out = { status: r.status, body: (await r.json()) as T };
  await Promise.all(pending.splice(0));
  return out;
}

interface Campaign {
  id: string;
  status: string;
  simulate: boolean;
  pauseReason: string | null;
  plan: CampaignPlan;
  proposal: { counts: Record<string, number>; costs: { totals: Record<string, { estimate: number; steps: number; unknown: number }>; unknown: unknown[] }; caps: { unit: string; estimate: number; cap: number; retryAllowance: number }[]; signature: string; items: string[]; kept: string[]; stepCount: number; unaccepted: unknown[] };
  approval: { current: boolean; needsApproval: string[] } | null;
  ledger: Record<string, { approved: number; reserved: number; remaining: number }>;
  steps: { step: string; item: string; shot: string | null; kind: string; status: string; post: number | null; output: string | null; spent: number; attempts: number; maxAttempts: number; ref: { kind: string; id: string } | null; note: string | null }[];
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  for (const u of [ADMIN, MEMBER]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES (?, ?, ?, 'x', ?, ?)").bind(u.id, u.email, u.name, u.role, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'habibah-campaign-test', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-11", { postCount: 1, plannedAt: 1000, model: "nano-banana-pro", plan: [{ index: 1, type: "product", title: "Kunafa", brief: "A kunafa tray on marble", caption: "Hello", hashtags: "", product: "kunafa" } as Post] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'November', ?, 'idle', ?, ?, 'c1', '2026-11')").bind(JSON.stringify(config), t, t).run();
  return env;
}

const SETUP = { objective: "Launch the winter menu", audience: "Families in Amman", offer: "15% off this week", message: "Warm drinks for cold nights", imagePosts: 3, videos: 4, shotsPerVideo: 4, videoSeconds: 16, platforms: ["instagram"], language: "both", productMode: "suggest", direction: { prompt: "Cosy, golden light", references: [{ kind: "reference", id: "ref-1", label: "Golden hour café", thumb: null, from: "a reference you added" }], styleId: null } };

async function create(env: FakeEnv): Promise<Campaign> {
  const r = await call<{ campaign: Campaign }>(env, "POST", "", { batch: "b1", setup: SETUP });
  expect(r.status).toBe(200);
  return r.body.campaign;
}
const get = async (env: FakeEnv, id: string) => (await call<{ campaign: Campaign }>(env, "GET", `/${id}`)).body.campaign;
async function approve(env: FakeEnv, c: Campaign, extra: Record<string, unknown> = {}) {
  return call<{ campaign: Campaign; already?: boolean; error?: string }>(env, "POST", `/${c.id}/approve`, { items: c.proposal.items, retries: 1, signature: c.proposal.signature, acceptedUnknown: [], ...extra });
}
/** Production passes; the admin approves each Reel's starting pictures as they are ready (unless `shots` is false). */
async function tickUntilQuiet(env: FakeEnv, id: string, max = 12, shots = true): Promise<Campaign> {
  let c = await get(env, id);
  for (let i = 0; i < max; i++) {
    const before = JSON.stringify(c.steps.map((s) => s.status));
    c = (await call<{ campaign: Campaign }>(env, "POST", `/${id}/tick`)).body.campaign;
    if (shots) for (const r of c.steps.filter((s) => s.kind === "review" && s.status === "ready")) c = (await call<{ campaign: Campaign }>(env, "POST", `/${id}/steps/${encodeURIComponent(r.step)}/approve-shots`)).body.campaign;
    if (JSON.stringify(c.steps.map((s) => s.status)) === before) break;
  }
  return c;
}
/** What the browser does after rendering a Reel's project: a render job and its version on the card, then the step reported. */
async function renderInBrowser(env: FakeEnv, c: Campaign, step: string) {
  const s = c.steps.find((x) => x.step === step)!;
  const videoId = `vid-render-${step.replace(/[^a-z0-9]/gi, "")}`;
  const key = `u1/b1/video/render/${videoId}.mp4`;
  await env.BUCKET.put(key, sampleBytes(), { httpMetadata: { contentType: "video/mp4" } });
  const t = Date.now();
  await env.DB.prepare("INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, key, created, updated, provider, settings, source, for_client) VALUES (?, 'b1', ?, 'x', 'u1', 'editor', 'render', 'done', ?, ?, ?, 'editor', '{}', 'editor', 0)").bind(videoId, s.post, key, t, t).run();
  const renderId = `render-${videoId}`;
  await env.DB.prepare("INSERT INTO video_renders (id, project, batch, post, project_rev, document, status, progress, video_id, outcome, created, updated, finished, created_by) VALUES (?, ?, 'b1', ?, 1, '{}', 'done', 1, ?, 'card', ?, ?, ?, 'u1')").bind(renderId, s.ref!.id, s.post, videoId, t, t, t).run();
  return call<{ campaign: Campaign }>(env, "POST", `/${c.id}/steps/${encodeURIComponent(step)}/rendered`, { videoId });
}
const spendRows = (env: FakeEnv) => env.DB.prepare("SELECT scope, approved, reserved FROM spend ORDER BY scope").all<{ scope: string; approved: number; reserved: number }>().then((r) => r.results);

let reached: Reached[];
beforeAll(() => {
  driveMock.files.set("demo-clip-campaign", { id: "demo-clip-campaign", folder: "demo-brand", name: "Pouring shot.mp4", mimeType: "video/mp4", modifiedTime: "2026-09-10T09:00:00.000Z", md5Checksum: "d1a0f0c0e0b0a09000000000000000c9", size: SAMPLE.byteLength, width: 1080, height: 1920, color: "#333333", media: sampleBytes() });
});
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  // Planning, estimates, approval and simulated production: not one network call.
  expect(reached).toEqual([]);
});

describe("Campaign Autopilot: planning before any spend", () => {
  it("is admin-only", async () => {
    const env = await seed();
    const r = await call(env, "POST", "", { batch: "b1", setup: SETUP }, MEMBER);
    expect(r.status).toBe(403);
  });

  it("plans 3 image posts and 4 multishot Reels with the right shot, picture and clip counts, priced per unit, and makes nothing", async () => {
    const env = await seed();
    const c = await create(env);
    expect(c.status).toBe("draft");
    expect(c.simulate).toBe(true);
    expect(c.plan.images).toHaveLength(3);
    expect(c.plan.videos).toHaveLength(4);
    expect(c.plan.videos.every((v) => v.shots.length === 4)).toBe(true);
    // Products come from the client's real lists, with their thumbnails; the reference stays labelled as one.
    expect(c.plan.images.every((i) => !i.product || (i.product.from === "drive" && i.product.thumb?.startsWith("/api/studio/drive/photo/")))).toBe(true);
    expect(c.plan.images[0].reference).toMatchObject({ kind: "reference", id: "ref-1" });
    // The second Reel ends on the client's own clip, used as it is.
    const v2 = c.plan.videos[1];
    expect(v2.shots[3]).toMatchObject({ source: "existing", asset: { kind: "asset", media: "clip" } });
    const n = c.proposal.counts;
    expect([n.imagePosts, n.videos, n.shots]).toEqual([3, 4, 16]);
    // Four multishot videos are not four generation calls: one clip per generated shot, starting images first.
    expect(n.clips).toBe(n.generatedShots);
    expect(n.clips).toBeGreaterThan(4);
    expect(n.pictures).toBe(3 + n.keyFrames + (n.pictures - 3 - n.keyFrames));
    expect(n.assemblies).toBe(4);
    expect(n.renders).toBe(4);
    // Units stay apart: list-price dollars for pictures and the Cloud clips (preview fixture), Magnific credits for other angles.
    const totals = c.proposal.costs.totals;
    expect(Object.keys(totals).sort()).toEqual(["magnific-credits", "usd"]);
    expect(totals["magnific-credits"].steps).toBe(n.pictures - 3 - n.keyFrames);
    expect(c.proposal.caps.find((x) => x.unit === "usd")!.cap).toBeCloseTo(c.proposal.caps.find((x) => x.unit === "usd")!.estimate * 2, 3);
    // Nothing made, nothing reserved: no cards, no tasks, no clips, no ledger rows.
    const config = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    expect(config.plan).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM videos").first<{ n: number }>())!.n).toBe(0);
    expect(await spendRows(env)).toEqual([]);
    expect(c.steps).toEqual([]);
  });

  it("edits before approval: words, a product, a shot's length; a stale page is refused", async () => {
    const env = await seed();
    const c = await create(env);
    const plan = structuredClone(c.plan);
    plan.images[0].headline = "Winter is here";
    plan.videos[0].shots[0].seconds = 6;
    plan.images[1].product = null;
    const r = await call<{ changes: { material: string[]; words: string[] }; campaign: Campaign }>(env, "PUT", `/${c.id}/plan`, { plan, rev: 1 });
    expect(r.status).toBe(200);
    expect(r.body.changes.words).toEqual(["img-1"]);
    expect(r.body.changes.material.sort()).toEqual(["img-2", "vid-1"]);
    expect(r.body.campaign.plan.rev).toBe(2);
    expect(r.body.campaign.plan.videos[0].seconds).toBeCloseTo(c.plan.videos[0].seconds + 2, 5);
    const stale = await call(env, "PUT", `/${c.id}/plan`, { plan, rev: 1 });
    expect(stale.status).toBe(409);
    // The approval terms follow the edit: the earlier signature no longer approves anything.
    const old = await approve(env, c);
    expect(old.status).toBe(409);
    expect(await spendRows(env)).toEqual([]);
  });
});

describe("Campaign Autopilot: approval and production", () => {
  it("approves once, produces the whole campaign within the caps, assembles editable Reels and puts them on their cards", async () => {
    const env = await seed();
    const c = await create(env);
    const a = await approve(env, c);
    expect(a.status).toBe(200);
    expect(a.body.campaign.status).toBe("producing");
    const ledger = await spendRows(env);
    expect(ledger.map((x) => x.scope).sort()).toEqual([`campaign:${c.id}:magnific-credits`, `campaign:${c.id}:usd`]);
    // A second press approves nothing more.
    const again = await approve(env, c);
    expect(again.body.already).toBe(true);
    expect((await spendRows(env)).map((x) => x.approved)).toEqual(ledger.map((x) => x.approved));

    let p = await tickUntilQuiet(env, c.id);
    const renders = p.steps.filter((s) => s.kind === "render");
    expect(renders).toHaveLength(4);
    expect(renders.every((s) => s.status === "ready" && s.ref?.kind === "project")).toBe(true);
    expect(p.steps.filter((s) => s.kind !== "render").every((s) => s.status === "done")).toBe(true);
    // The cards: 3 posts and 4 Reels after the month's post; every picture labelled simulated.
    const config = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    expect(config.plan!.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(config.plan!.slice(4).every((x) => x.format === "9:16" && x.overlay === false)).toBe(true);
    const takes = await env.DB.prepare("SELECT note FROM post_takes WHERE batch = 'b1'").all<{ note: string }>();
    expect(takes.results.every((t) => t.note.startsWith("Simulated (preview)"))).toBe(true);
    // Spend within the caps, in each unit.
    for (const row of await spendRows(env)) expect(row.reserved).toBeLessThanOrEqual(row.approved + 1e-6);
    // Each Reel: an ordinary editable project on its card, with its shots, words and music.
    const projects = await env.DB.prepare("SELECT id, post, project FROM video_projects WHERE batch = 'b1' ORDER BY post").all<{ id: string; post: number; project: string }>();
    expect(projects.results.map((x) => x.post)).toEqual([5, 6, 7, 8]);
    for (const pr of projects.results) {
      const v = validateProject(JSON.parse(pr.project));
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.project.clips.length).toBe(4);
    }
    // The client's clip joined the second Reel as a version of its card, copied (not generated).
    const uploads = await env.DB.prepare("SELECT post, provider, source FROM videos WHERE source = 'upload'").all<{ post: number; provider: string }>();
    expect(uploads.results).toEqual([{ post: 6, provider: "upload", source: "upload" }]);

    for (const r of renders) p = (await renderInBrowser(env, p, r.step)).body.campaign;
    expect(p.status).toBe("done");
    expect(p.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("pauses when the approved allowance runs out, and goes on after more is approved", async () => {
    const env = await seed();
    const c = await create(env);
    await approve(env, c);
    // Something else used most of the dollars meanwhile: only one picture still fits.
    const usd = `campaign:${c.id}:usd`;
    const perImage = c.proposal.costs.totals.usd.estimate / c.proposal.costs.totals.usd.steps;
    await env.DB.prepare("UPDATE spend SET approved = ? WHERE scope = ?").bind(perImage * 1.5, usd).run();
    const p = await tickUntilQuiet(env, c.id);
    expect(p.status).toBe("paused");
    expect(p.pauseReason).toMatch(/approved allowance is not enough/);
    const paused = p.steps.filter((s) => s.status === "paused");
    expect(paused.length).toBeGreaterThan(0);
    const reserved = (await spendRows(env)).find((x) => x.scope === usd)!;
    expect(reserved.reserved).toBeLessThanOrEqual(reserved.approved + 1e-6);
    // The admin approves the rest; resume carries on from where it stopped.
    await env.DB.prepare("UPDATE spend SET approved = approved + 100 WHERE scope = ?").bind(usd).run();
    await call(env, "POST", `/${c.id}/resume`);
    const q = await tickUntilQuiet(env, c.id);
    expect(q.steps.filter((s) => s.kind !== "render").every((s) => s.status === "done")).toBe(true);
  });

  it("a material edit after approval pauses that Reel; approving it again re-makes only the changed shot", async () => {
    const env = await seed();
    const c = await create(env);
    await approve(env, c);
    const done = await tickUntilQuiet(env, c.id);
    const before = new Map(done.steps.map((s) => [s.step, s.output]));
    const plan = structuredClone(done.plan);
    plan.videos[0].shots[2].action = "The cup lifted towards the window light.";
    const r = await call<{ changes: { material: string[] }; campaign: Campaign }>(env, "PUT", `/${c.id}/plan`, { plan, rev: done.plan.rev });
    expect(r.body.changes.material).toEqual(["vid-1"]);
    expect(r.body.campaign.approval!.needsApproval).toEqual(["vid-1"]);
    // The pending render of that Reel waits; nothing of it is made until approved again.
    expect(r.body.campaign.steps.find((s) => s.step === "vid-1:-:render")!.status).toBe("paused");
    const cur = r.body.campaign;
    // Only what the change touches is in the new approval: that shot (its starting image and clip), the assembly, the render.
    const changed = cur.steps.filter((s) => s.item === "vid-1" && (s as { stale?: boolean }).stale).map((s) => s.step);
    expect(changed.sort()).toEqual(["vid-1:-:assemble", "vid-1:-:review", "vid-1:s3:clip", "vid-1:s3:frame"].sort());
    const a2 = await approve(env, cur);
    expect(a2.status).toBe(200);
    const after = await tickUntilQuiet(env, c.id);
    for (const s of after.steps.filter((x) => x.item !== "vid-1" && x.kind !== "render")) expect(s.output).toBe(before.get(s.step));
    expect(after.steps.find((s) => s.step === "vid-1:s1:clip")!.attempts).toBe(1);
    expect(after.steps.find((s) => s.step === "vid-1:s3:clip")!.attempts).toBe(1);
    expect(after.steps.find((s) => s.step === "vid-1:-:assemble")!.status).toBe("done");
  });

  it("a failed step is retried alone; past its approved attempts it needs one more approved attempt", async () => {
    const env = await seed();
    const c = await create(env);
    await approve(env, c);
    const p = await tickUntilQuiet(env, c.id);
    // Say the third shot of Reel 2 failed twice at the provider (both approved attempts).
    await env.DB.prepare("UPDATE campaign_steps SET status = 'failed', attempts = 2, error = 'Generation failed on Higgsfield.' WHERE campaign = ? AND step = 'vid-2:s3:clip'").bind(c.id).run();
    const others = p.steps.filter((s) => s.step !== "vid-2:s3:clip" && s.kind !== "render");
    const refused = await call<{ needsExtra?: boolean }>(env, "POST", `/${c.id}/steps/${encodeURIComponent("vid-2:s3:clip")}/retry`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.needsExtra).toBe(true);
    const ok = await call<{ campaign: Campaign }>(env, "POST", `/${c.id}/steps/${encodeURIComponent("vid-2:s3:clip")}/retry`, { extra: true });
    expect(ok.status).toBe(200);
    const q = await tickUntilQuiet(env, c.id);
    const retried = q.steps.find((s) => s.step === "vid-2:s3:clip")!;
    expect(retried.status).toBe("done");
    expect(retried.attempts).toBe(3);
    // Everything that had succeeded is untouched: same outputs, one attempt each.
    for (const s of others) {
      const now = q.steps.find((x) => x.step === s.step)!;
      expect(now.output).toBe(s.output);
      expect(now.attempts).toBe(s.attempts);
    }
  });
});

describe("Campaign Autopilot: a new product on an item", () => {
  it("rewrites the item's words for the new product (nothing saved until the admin saves) and never shows list ids", async () => {
    const env = await seed();
    const c = await create(env);
    const v = c.plan.videos[0];
    const old = v.product!;
    // The planner's list ids never reach the words ("… (P1)" became the product's name, or went).
    expect(JSON.stringify(c.plan)).not.toMatch(/\(P\d+\)|\bP\d+\b/);
    expect(v.concept).toContain(old.name);
    const sources = (await call<{ products: { id: string; name: string; from: string; thumb: string | null }[] }>(env, "GET", "/sources?batch=b1")).body;
    const next = sources.products.find((p) => p.id !== old.id)!;
    const r = await call<{ item: { key: string; product: { id: string }; concept: string; shots: { key: string; action: string; seconds: number }[] }; note: string }>(env, "POST", `/${c.id}/retarget`, { item: v, product: next });
    expect(r.status).toBe(200);
    expect(r.body.item.key).toBe(v.key);
    expect(r.body.item.product.id).toBe(next.id);
    expect(r.body.item.concept).toContain(next.name);
    expect(r.body.item.concept).not.toContain(old.name);
    expect(r.body.item.shots.map((s) => [s.key, s.seconds])).toEqual(v.shots.map((s) => [s.key, s.seconds]));
    expect(r.body.item.shots.every((s) => !s.action.includes(old.name))).toBe(true);
    // Nothing saved: the stored plan still has the old product until the admin saves the draft.
    expect((await get(env, c.id)).plan.videos[0].product!.id).toBe(old.id);
    // A product that is not the client's is refused.
    const bad = await call(env, "POST", `/${c.id}/retarget`, { item: v, product: { id: "nope", name: "Fake", from: "drive", thumb: null } });
    expect(bad.status).toBe(409);
  });
});

describe("Campaign Autopilot: the admin looks at the shots before the videos", () => {
  it("makes no clip before a Reel's starting pictures are approved; Make again re-makes one picture alone", async () => {
    const env = await seed();
    const c = await create(env);
    await approve(env, c);
    const p = await tickUntilQuiet(env, c.id, 12, false);
    // Every Reel stops at its review: pictures made, not one clip started.
    expect(p.steps.filter((s) => s.kind === "review").every((s) => s.status === "ready")).toBe(true);
    expect(p.steps.filter((s) => s.kind === "clip").every((s) => s.status === "waiting")).toBe(true);
    expect(p.status).toBe("producing");
    // Another angle for one shot: confirmed at its estimate first, then made alone.
    const frame = p.steps.find((s) => s.step === "vid-1:s2:frame")!;
    const ask = await call<{ needsConfirm?: boolean }>(env, "POST", `/${c.id}/steps/${encodeURIComponent(frame.step)}/redo`, { angle: "top" });
    expect(ask.status).toBe(409);
    expect(ask.body.needsConfirm).toBe(true);
    const r = await call<{ campaign: Campaign }>(env, "POST", `/${c.id}/steps/${encodeURIComponent(frame.step)}/redo`, { angle: "top", confirm: true });
    expect(r.status).toBe(200);
    const q = await tickUntilQuiet(env, c.id, 6, false);
    const again = q.steps.find((s) => s.step === frame.step)!;
    expect(again.attempts).toBe(2);
    expect(q.steps.find((s) => s.step === "vid-1:s3:frame")!.attempts).toBe(1);
    expect(q.steps.find((s) => s.step === "vid-1:-:review")!.status).toBe("ready");
    // Approved: that Reel's clips are made; the other Reels still wait for their look.
    const ok = await call<{ campaign: Campaign }>(env, "POST", `/${c.id}/steps/${encodeURIComponent("vid-1:-:review")}/approve-shots`);
    expect(ok.status).toBe(200);
    const z = await tickUntilQuiet(env, c.id, 8, false);
    expect(z.steps.filter((s) => s.item === "vid-1" && s.kind === "clip").every((s) => s.status === "done")).toBe(true);
    expect(z.steps.filter((s) => s.item === "vid-3" && s.kind === "clip").every((s) => s.status === "waiting")).toBe(true);
    // An approved Reel's pictures are not made again here.
    const late = await call(env, "POST", `/${c.id}/steps/${encodeURIComponent("vid-1:s2:frame")}/redo`, { confirm: true });
    expect(late.status).toBe(409);
  });
});
