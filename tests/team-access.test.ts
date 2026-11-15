import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import { VIDEO_MODELS } from "../shared/qa";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { studioRoutes } from "../server/studio";
import { adminRoutes } from "../server/admin";
import { usePhotoLabFetch } from "../server/photolab";
import { INTEGRATION_PROVIDERS, integrationAccess, listIntegrationOps, setIntegrationSwitch, TEAM_PROVIDERS } from "../server/integrations";

/**
 * Who may do what, after the owner's decision of 15 Nov: employees (role "member") make videos and
 * use the AI edit tools; connecting accounts and keys, the billing choices, the Admin page and
 * Campaign Autopilot stay with admins. Every run route is tried as a member and must not answer
 * "Admins only"; every account route is tried as a member and must answer 403. Nothing here reaches
 * a provider: the guard refuses any outside call, so a route that gets past its gate ends on its
 * own next check (not signed in, cost not known, a missing clip), never on a spend.
 */

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Mona", role: "member" };
const PICTURE = new Uint8Array([80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
const JSON_HEADERS = { "content-type": "application/json" };

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.route("/api/admin", adminRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

/** A month the member owns, with one finished picture and one finished clip. */
async function seed() {
  const env = fakeEnv({ HIGGSFIELD_API_KEY: "key-id:key-secret" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u2', 'member@test', 'Mona', 'x', 'member', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [{ index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only" } as never],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u2/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, updated, post) VALUES ('t1', 'b1', 's1', 1, 'review', 'u2/b1/output/t1/a.png', '', ?, 1)").bind(t).run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", PICTURE, { httpMetadata: { contentType: "image/png" } });
  await env.BUCKET.put("u2/b1/video/t1/v1.mp4", PICTURE, { httpMetadata: { contentType: "video/mp4" } });
  await env.DB.prepare("INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, created, updated) VALUES ('v1', 'b1', 1, 't1', 'u2', ?, 'steam', 'done', 'req-1', 'u2/b1/video/t1/v1.mp4', ?, ?)").bind(VIDEO_MODELS[0].slug, t, t).run();
  return env;
}

type Call = [what: string, method: string, path: string, body?: unknown];
const ASK = { batch: "b1", index: 1, model: VIDEO_MODELS[0].slug, prompt: "The steam rises slowly from the kunafa." };

/** Everything the team runs: one line per action the owner opened to employees. */
const TEAM_RUNS: Call[] = [
  ["make a video (Cloud API)", "POST", "/api/studio/posts/video", ASK],
  ["try a failed clip again", "POST", "/api/studio/posts/video/retry", { batch: "b1", id: "v1" }],
  ["write the motion idea", "POST", "/api/studio/posts/video/idea", { batch: "b1", index: 1 }],
  ["list the subscription's engines", "GET", "/api/studio/higgsfield/mcp/models"],
  ["ask a clip's cost (subscription credits)", "POST", "/api/studio/higgsfield/mcp/estimate", ASK],
  ["make a video (subscription credits)", "POST", "/api/studio/higgsfield/mcp/generate", { ...ASK, confirm: true }],
  ["make a video (Magnific)", "POST", "/api/studio/video/magnific/generate", { batch: "b1", index: 1, slug: "kling", prompt: ASK.prompt, duration: 5, confirm: true }],
  ["enhance a clip (Magnific)", "POST", "/api/studio/video/magnific/enhance", { batch: "b1", videoId: "v1", tool: "video_upscale", arguments: { mode: "magnific" }, confirm: true }],
  ["enhance a clip (Higgsfield)", "POST", "/api/studio/video/higgsfield/tool", { batch: "b1", videoId: "v1", tool: "upscale_video", arguments: {}, confirm: true }],
  ["check a clip", "POST", "/api/studio/video/higgsfield/check", { batch: "b1", videoId: "v1", tool: "virality_predictor", confirm: true }],
  ["check a failed clip again", "POST", "/api/studio/posts/video/check", { batch: "b1", id: "v1" }],
  ["run a video preset", "POST", "/api/studio/video/presets/run", { batch: "b1", index: 1, presetId: "p1", source: "marketing_studio_v2", inputs: {}, confirm: true }],
  ["save a video project", "POST", "/api/studio/posts/video/editor/projects", { batch: "b1", post: 1, name: "Cut" }],
  ["start a render (\"Render & update card\")", "POST", "/api/studio/posts/video/editor/renders", { projectId: "none", rev: 1 }],
  ["upload a render", "POST", "/api/studio/posts/video/editor/render", {}],
  ["combine cards into one video", "POST", "/api/studio/media/combine", {}],
  ["ask a Photo studio AI tool's cost (Higgsfield)", "POST", "/api/studio/photo/tools/estimate", { batch: "b1", index: 1, tool: "hf-upscale", options: {} }],
  ["run a Photo studio AI tool (Higgsfield)", "POST", "/api/studio/photo/tools/run", { batch: "b1", index: 1, tool: "hf-upscale", options: {}, confirm: true }],
  ["run a Photo studio AI tool (Magnific)", "POST", "/api/studio/photo/tools/run", { batch: "b1", index: 1, tool: "mg-upscale", options: {}, confirm: true }],
  ["run a picture preset", "POST", "/api/studio/photo/presets/run", { batch: "b1", index: 1, presetId: "p1", source: "marketing_studio_v2", inputs: {}, confirm: true }],
  ["propose a Photo lab run", "POST", "/api/studio/photolab/run", { client: "c1", source: { kind: "task", batch: "b1", id: "t1" }, op: "remove-bg" }],
  ["search Freepik stock", "GET", "/api/studio/freepik/search?q=marble"],
  ["list the Magnific tools", "GET", "/api/studio/freepik/mcp/tools"],
];

/** What stays with admins: accounts, keys, billing, the Admin page, Campaign Autopilot. */
const ADMIN_ONLY: Call[] = [
  ["save the Freepik key", "POST", "/api/studio/photolab/key", { key: "FPSX0123456789abcdef0123456789abcdef" }],
  ["remove the Freepik key", "DELETE", "/api/studio/photolab/key"],
  ["say which Freepik plan the account is on", "POST", "/api/studio/freepik/plan", { plan: "premium" }],
  ["start the Magnific sign-in", "POST", "/api/studio/freepik/mcp/signin/start"],
  ["sign Magnific out", "POST", "/api/studio/freepik/mcp/signout"],
  ["paste a Magnific token", "POST", "/api/studio/freepik/mcp/token", { token: "t".repeat(40) }],
  ["remove the Magnific token", "DELETE", "/api/studio/freepik/mcp/token"],
  ["start the Higgsfield sign-in", "POST", "/api/studio/higgsfield/mcp/signin/start"],
  ["sign Higgsfield out", "POST", "/api/studio/higgsfield/mcp/signout"],
  ["choose the Higgsfield billing", "POST", "/api/studio/higgsfield/mcp/billing", { billing: "credits" }],
  ["connect Pinterest", "PUT", "/api/studio/pinterest", { token: "pina_x" }],
  ["disconnect Pinterest", "DELETE", "/api/studio/pinterest"],
  ["connect Instagram (Meta)", "POST", "/api/studio/meta", { token: "EAAG-x" }],
  ["switch an integration off", "POST", "/api/admin/integrations/switch", { provider: "higgsfield", enabled: false }],
  ["set a video price", "POST", "/api/admin/integrations/estimate", { provider: "higgsfield", kind: "video", usd: 1 }],
  ["change the workspace settings", "POST", "/api/admin/settings", { pricing: "everyone" }],
  ["read the team list", "GET", "/api/admin/users"],
  ["open Campaign Autopilot", "GET", "/api/studio/campaigns?batch=b1"],
  ["start a Campaign Autopilot plan", "POST", "/api/studio/campaigns", { batch: "b1" }],
  ["run the month autopilot", "POST", "/api/studio/autopilot/grid", { client: "c1" }],
];

const send = (user: User, env: FakeEnv, [, method, path, body]: Call) =>
  app(user).request(path, method === "GET" || body === undefined ? { method } : { method, body: JSON.stringify(body), headers: JSON_HEADERS }, env);

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  usePhotoLabFetch(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  usePhotoLabFetch(null);
});

describe("employees make videos and use the AI edit tools (15 Nov)", () => {
  it("every provider's runs are the whole team's, and the entry points are told so", async () => {
    const env = await seed();
    expect([...TEAM_PROVIDERS].sort()).toEqual([...INTEGRATION_PROVIDERS].sort());
    for (const p of INTEGRATION_PROVIDERS) expect(await integrationAccess(env, MEMBER, p), p).toEqual({ admin: true, enabled: true, reason: "" });
  });

  it.each(TEAM_RUNS)("a member may %s", async (...call) => {
    const env = await seed();
    const r = await send(MEMBER, env, call);
    const text = await r.text();
    expect(r.status, `${call[2]} → ${text.slice(0, 200)}`).not.toBe(403);
    expect(text).not.toMatch(/Admins only|for admins|Only an admin/i);
  });

  it("a member's run ends where an admin's does: the same answer, not a refusal", async () => {
    for (const call of TEAM_RUNS.filter((c) => c[1] === "POST")) {
      const [asMember, asAdmin] = [await send(MEMBER, await seed(), call), await send(ADMIN, await seed(), call)];
      expect(asMember.status, call[0]).toBe(asAdmin.status);
    }
  });

  it("a member runs the Photo lab end to end (demo: nothing is sent or charged) and the ledger names them", async () => {
    const env = await seed();
    const run = TEAM_RUNS.find((c) => c[2] === "/api/studio/photolab/run")!;
    const proposed = await send(MEMBER, env, run);
    expect(proposed.status).toBe(200);
    const p = (await proposed.json()) as { opId: string; needsConfirmation: boolean };
    expect(p.needsConfirmation).toBe(true);
    const done = await send(MEMBER, env, [run[0], run[1], run[2], { ...(run[3] as object), opId: p.opId, confirm: true }]);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { job: { status: string } }).job.status).toBe("done");
    expect((await listIntegrationOps(env, { provider: "freepik" }))[0]).toMatchObject({ id: p.opId, user_id: "u2", user_name: "Mona", status: "done" });
    expect(reached).toEqual([]);
  });

  it("an admin can still close a provider for everyone with its switch", async () => {
    const env = await seed();
    await setIntegrationSwitch(env, "higgsfield", false);
    const r = await send(MEMBER, env, TEAM_RUNS[0]);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/switched off by an admin/);
    expect(await integrationAccess(env, MEMBER, "higgsfield")).toMatchObject({ admin: true, enabled: false });
  });
});

describe("accounts, keys, billing, the Admin page and Campaign Autopilot stay with admins", () => {
  it.each(ADMIN_ONLY)("a member may not %s", async (...call) => {
    const env = await seed();
    const r = await send(MEMBER, env, call);
    expect(r.status, call[2]).toBe(403);
    // Nothing was written or sent on a refusal.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM integration_ops").first<{ n: number }>()).toEqual({ n: 0 });
    expect(reached).toEqual([]);
  });

  it("the Freepik status says who keeps the account: the team runs it, admins hold the key and the plan", async () => {
    const env = await seed();
    const m = (await (await app(MEMBER).request("/api/studio/freepik/status", {}, env)).json()) as { admin: boolean; accountAdmin: boolean };
    expect(m).toMatchObject({ admin: true, accountAdmin: false });
    const lab = (await (await app(MEMBER).request("/api/studio/photolab/status", {}, env)).json()) as { accountAdmin: boolean; access: { admin: boolean } };
    expect(lab).toMatchObject({ accountAdmin: false, access: { admin: true } });
    const a = (await (await app(ADMIN).request("/api/studio/freepik/status", {}, env)).json()) as { admin: boolean; accountAdmin: boolean };
    expect(a).toMatchObject({ admin: true, accountAdmin: true });
  });
});
