import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import { canApply, FEEDBACK_SCHEMA, feedbackFromInstruction, feedbackInstruction, interpretFeedback, parseFeedbackActions, splitFeedback, type FeedbackAction, type FeedbackContext } from "../shared/feedback";
import type { PostOverlayPatch } from "../shared/overlay";

/**
 * Client feedback becomes reviewable changes: the rules read it the same way every time, nothing is
 * applied by itself, a layer change never touches a picture or a budget, a picture edit on the
 * preview is only described, and no lesson is ever written from a client's words. The fetch guard
 * fails the test the moment anything reaches the network.
 */
const ctx: FeedbackContext = {
  posts: [
    { index: 1, title: "Pistachio crossing", headline: "Green light", caption: "Try it today", hasPicture: true, logoWidth: 0.16 },
    { index: 2, title: "Mojito travel", headline: "Wherever you go", caption: "Your companion", hasPicture: true, logoWidth: 0.16 },
    { index: 3, title: "Ingredients carousel", hasPicture: false, slides: 4, logoWidth: 0.16 },
  ],
};

describe("reading the client's feedback by the rules", () => {
  it("splits a message into items and keeps a post label with its items", () => {
    expect(splitFeedback("Post 2: bigger headline. Remove the cup.\n- The logo is too small")).toEqual(["Post 2: bigger headline.", "Post 2: Remove the cup.", "The logo is too small"]);
    // A later label, or a sentence that points at a post itself, is not swallowed by the first label.
    expect(splitFeedback("Post 1: bigger logo. Post 2: remove the cup. The second one is too dark.")).toEqual(["Post 1: bigger logo.", "Post 2: remove the cup.", "The second one is too dark."]);
  });

  it("logo larger on one post is a free layer edit with a logoWidth patch", () => {
    const [a] = interpretFeedback("Please make the logo larger", { ...ctx, post: 1 });
    expect(a.kind).toBe("layer");
    expect(a.post).toBe(1);
    expect((a.patch as PostOverlayPatch).logoWidth).toBe(0.2);
    expect(a.change).toContain("Logo 25% larger");
  });

  it("removing an object is a picture edit with the instruction to send", () => {
    const [a] = interpretFeedback("Post 1: remove the cup.", ctx);
    expect(a.kind).toBe("image");
    expect(a.post).toBe(1);
    expect(a.instruction).toBe("Remove the cup.");
    expect(a.conflict).toBeUndefined();
  });

  it("'the second one' is unclear, asks which post and guesses no target", () => {
    const [a] = interpretFeedback("The second one needs a bigger logo.", ctx);
    expect(a.kind).toBe("unclear");
    expect(a.post).toBeUndefined();
    expect(a.ambiguity).toMatch(/^Which post\?/);
    const [b] = interpretFeedback("Make the blue one darker", ctx);
    expect(b.kind).toBe("unclear");
    expect(b.post).toBeUndefined();
  });

  it("'post 2: bigger headline' scales the words on post 2", () => {
    const [a] = interpretFeedback("post 2: bigger headline", ctx);
    expect(a.kind).toBe("layer");
    expect(a.post).toBe(2);
    expect((a.patch as PostOverlayPatch).scale).toBe(1.25);
  });

  it("new words become a words patch; words without the new words ask for them", () => {
    const [a] = interpretFeedback('Post 1: change the headline to "Fresh every morning"', ctx);
    expect(a.kind).toBe("words");
    expect(a.patch).toEqual({ headline: "Fresh every morning" });
    const [b] = interpretFeedback("Post 1: fix the typo in the caption", ctx);
    expect(b.kind).toBe("words");
    expect(b.ambiguity).toContain("caption");
  });

  it("asking for people when the campaign has none is a conflict, not a refusal", () => {
    const [a] = interpretFeedback("Post 2: add a woman holding the cup", { ...ctx, constraints: { noPeople: true } });
    expect(a.kind).toBe("image");
    expect(a.conflict).toContain("no people");
    const [b] = interpretFeedback("Post 2: write the price on the cup", ctx);
    expect(b.conflict).toContain("never draws words");
  });

  it("a new concept is an idea; a slide points at the carousel; 'all posts' fans out one change per post", () => {
    const [idea] = interpretFeedback("Post 2: not this concept, we want a different idea here", ctx);
    expect(idea.kind).toBe("idea");
    const [slide] = interpretFeedback("Slide 3: lighter background", ctx);
    expect(slide.post).toBe(3);
    expect(slide.slide).toBe(3);
    expect(slide.kind).toBe("image");
    expect(slide.conflict).toContain("no picture yet");
    const all = interpretFeedback("The logo is too small on all posts", ctx);
    expect(all.map((a) => a.post)).toEqual([1, 2, 3]);
    expect(all.every((a) => a.kind === "layer")).toBe(true);
  });

  it("the model's answer is checked: made-up posts lose their target, patches keep only their keys, nothing usable falls back to the rules", () => {
    const fallback = interpretFeedback("Post 1: bigger logo", ctx);
    const out = parseFeedbackActions({ actions: [{ post: 9, kind: "layer", change: "Bigger logo", patch: { logoWidth: 0.2, headline: "x" } }] }, ctx, fallback);
    expect(out[0].post).toBeUndefined();
    expect(out[0].kind).toBe("unclear");
    const ok = parseFeedbackActions({ actions: [{ post: 1, kind: "layer", change: "Bigger logo", patch: { logoWidth: 0.2, headline: "x" } }] }, ctx, fallback);
    expect(ok[0].patch).toEqual({ logoWidth: 0.2 });
    expect(parseFeedbackActions({ nope: true }, ctx, fallback)).toBe(fallback);
  });

  it("the instruction carries the context and the feedback in blocks the fixture reads back", () => {
    const text = feedbackInstruction({ client: "Abu Saleh", text: 'Post 1: bigger logo.\nThe second one: remove the cup.', context: ctx });
    expect(text).toContain("NEVER guess a post");
    const back = feedbackFromInstruction(text);
    expect(back?.text).toBe('Post 1: bigger logo.\nThe second one: remove the cup.');
    expect(back?.context.posts.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it("only an approved change with a target and its content can be applied", () => {
    const a: Pick<FeedbackAction, "kind" | "post" | "status" | "patch" | "instruction"> = { kind: "layer", post: 1, status: "approved", patch: { logoWidth: 0.2 } };
    expect(canApply(a)).toBe(true);
    expect(canApply({ ...a, status: "proposed" })).toBe(false);
    expect(canApply({ ...a, post: undefined })).toBe(false);
    expect(canApply({ kind: "image", post: 1, status: "approved" })).toBe(false);
    expect(canApply({ kind: "unclear", post: 1, status: "approved" })).toBe(false);
  });
});

/* ───────────── The routes, on the fakes, no network ───────────── */

type FakeEnv = ReturnType<typeof fakeEnv>;

async function app() {
  const { StudioError } = await import("../server/errors");
  const { feedbackRoutes } = await import("../server/feedback");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio/feedback", feedbackRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, donts, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', 'no people in the pictures', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "product", title: "Pistachio crossing", brief: "The green shake in the crossing sign, pistachios on the stripes.", caption: "Try it", hashtags: "#demo", product: "pistachio", headline: "Green light" } as never,
      { index: 2, type: "tip", title: "Tip", brief: "A tip card on a wooden table.", caption: "", hashtags: "" } as never,
    ],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES ('task-1', 'b1', 's1', 1, 'ready', 'u1/b1/output/task-1/a.jpg', '', 1, ?)").bind(t).run();
  return env;
}

const headers = { "content-type": "application/json" };
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const count = async (env: FakeEnv, table: string) => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n);
const planOf = async (env: FakeEnv) => (JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as { plan: { index: number; ov?: PostOverlayPatch; headline?: string; brief: string; ideaAt?: number }[] }).plan;

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the feedback routes", () => {
  it("stores the feedback, reads it with the demo fixture and proposes changes nobody applied", async () => {
    const env = await seed();
    const a = await app();
    const r = await a.request("/api/studio/feedback", { method: "POST", body: JSON.stringify({ batch: "b1", text: "Post 1: make the logo bigger. Post 1: remove the cup. The second one is too dark.", source: "pasted" }), headers }, env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { interpreter: string; actions: FeedbackAction[] };
    expect(d.interpreter).toBe("demo");
    expect(d.actions).toHaveLength(3);
    expect(d.actions.map((x) => x.kind)).toEqual(["layer", "image", "unclear"]);
    expect(d.actions.every((x) => x.status === "proposed")).toBe(true);
    expect(d.actions[0].change).toContain("DEMO FIXTURE");
    expect((d.actions[0].patch as PostOverlayPatch).logoWidth).toBe(0.2);
    expect(d.actions[1].conflict).toBeUndefined();
    expect(d.actions[2].post).toBeUndefined();
    const list = (await json(await a.request("/api/studio/feedback?batch=b1", {}, env))) as { feedback: { text: string; actions: unknown[] }[] };
    expect(list.feedback).toHaveLength(1);
    expect(list.feedback[0].actions).toHaveLength(3);
    // The plan is as it was: nothing applied by itself.
    expect((await planOf(env))[0].ov).toBeUndefined();
    expect(await count(env, "lessons")).toBe(0);
  });

  it("applies one approved layer change through the plan: ov patched, no task, no spend, no lesson", async () => {
    const env = await seed();
    const a = await app();
    const d = (await json(await a.request("/api/studio/feedback", { method: "POST", body: JSON.stringify({ batch: "b1", post: 1, text: "The logo should be bigger", source: "typed" }), headers }, env))) as { actions: FeedbackAction[] };
    const action = d.actions[0];
    expect(action.kind).toBe("layer");
    // Not approved yet: apply is refused.
    const early = await a.request(`/api/studio/feedback/actions/${action.id}/apply`, { method: "POST", body: "{}", headers }, env);
    expect(early.status).toBe(409);
    const put = await a.request(`/api/studio/feedback/actions/${action.id}`, { method: "PUT", body: JSON.stringify({ status: "approved" }), headers }, env);
    expect(put.status).toBe(200);
    const tasksBefore = await count(env, "tasks");
    const apply = await a.request(`/api/studio/feedback/actions/${action.id}/apply`, { method: "POST", body: "{}", headers }, env);
    expect(apply.status).toBe(200);
    const out = (await json(apply)) as { action: FeedbackAction };
    expect(out.action.status).toBe("applied");
    expect(out.action.applied?.result).toContain("picture was not touched");
    const plan = await planOf(env);
    expect(plan[0].ov?.logoWidth).toBe(0.2);
    expect(plan[0].ideaAt).toBeUndefined();
    expect(await count(env, "tasks")).toBe(tasksBefore);
    expect((await env.DB.prepare("SELECT status FROM tasks WHERE id = 'task-1'").first<{ status: string }>())!.status).toBe("ready");
    expect(await count(env, "spend")).toBe(0);
    expect(await count(env, "lessons")).toBe(0);
    // Applied once: a second apply is refused.
    expect((await a.request(`/api/studio/feedback/actions/${action.id}/apply`, { method: "POST", body: "{}", headers }, env)).status).toBe(409);
  });

  it("lets the designer fix the target of an unclear change, then applies the words", async () => {
    const env = await seed();
    const a = await app();
    const d = (await json(await a.request("/api/studio/feedback", { method: "POST", body: JSON.stringify({ batch: "b1", text: 'The second one: change the headline to "Go green"', source: "typed" }), headers }, env))) as { actions: FeedbackAction[] };
    const action = d.actions[0];
    expect(action.kind).toBe("unclear");
    expect(action.post).toBeUndefined();
    const put = (await json(await a.request(`/api/studio/feedback/actions/${action.id}`, { method: "PUT", body: JSON.stringify({ post: 1, kind: "words", patch: { headline: "Go green" }, status: "approved" }), headers }, env))) as { action: FeedbackAction };
    expect(put.action.post).toBe(1);
    expect(put.action.ambiguity).toBeUndefined();
    const apply = await a.request(`/api/studio/feedback/actions/${action.id}/apply`, { method: "POST", body: "{}", headers }, env);
    expect(apply.status).toBe(200);
    expect((await planOf(env))[0].headline).toBe("Go green");
    expect(await count(env, "lessons")).toBe(0);
  });

  it("describes a picture edit on the preview instead of spending, and flags the no-people conflict", async () => {
    const env = await seed();
    const a = await app();
    const d = (await json(await a.request("/api/studio/feedback", { method: "POST", body: JSON.stringify({ batch: "b1", post: 1, text: "Add a man holding the cup", source: "voice" }), headers }, env))) as { actions: FeedbackAction[] };
    const action = d.actions[0];
    expect(action.kind).toBe("image");
    expect(action.conflict).toContain("no people");
    await a.request(`/api/studio/feedback/actions/${action.id}`, { method: "PUT", body: JSON.stringify({ status: "approved" }), headers }, env);
    const apply = await a.request(`/api/studio/feedback/actions/${action.id}/apply`, { method: "POST", body: "{}", headers }, env);
    expect(apply.status).toBe(200);
    const out = (await json(apply)) as { preview: boolean; request: { path: string; body: { batch: string; indexes: number[]; regenerate: boolean; note: string } }; action: FeedbackAction };
    expect(out.preview).toBe(true);
    expect(out.request.path).toBe("/api/studio/posts/generate");
    expect(out.request.body).toMatchObject({ batch: "b1", indexes: [1], regenerate: true, note: "Add a man holding the cup." });
    expect(out.action.status).toBe("approved");
    expect(await count(env, "spend")).toBe(0);
    expect(await count(env, "tasks")).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM tasks WHERE id = 'task-1'").first<{ status: string }>())!.status).toBe("ready");
    expect(await count(env, "lessons")).toBe(0);
  });

  it("an idea rewrites the post's brief and generates nothing", async () => {
    const env = await seed();
    const a = await app();
    const d = (await json(await a.request("/api/studio/feedback", { method: "POST", body: JSON.stringify({ batch: "b1", post: 2, text: "Not this concept, try a different idea", source: "typed" }), headers }, env))) as { actions: FeedbackAction[] };
    expect(d.actions[0].kind).toBe("idea");
    await a.request(`/api/studio/feedback/actions/${d.actions[0].id}`, { method: "PUT", body: JSON.stringify({ status: "approved" }), headers }, env);
    const apply = await a.request(`/api/studio/feedback/actions/${d.actions[0].id}/apply`, { method: "POST", body: "{}", headers }, env);
    expect(apply.status).toBe(200);
    const plan = await planOf(env);
    expect(plan[1].brief).toContain("Client feedback:");
    expect(plan[1].ideaAt).toBeGreaterThan(0);
    expect(await count(env, "tasks")).toBe(1);
    expect(await count(env, "lessons")).toBe(0);
  });

  it("the demo fixture answers the feedback schema consistently with the rules", async () => {
    const { demoAnswer } = await import("../server/demo");
    const raw = JSON.parse(demoAnswer(feedbackInstruction({ client: "Sample", text: "Post 2: bigger headline", context: ctx }), FEEDBACK_SCHEMA)) as { actions: { post: number; kind: string; change: string; patch: PostOverlayPatch }[] };
    expect(raw.actions).toHaveLength(1);
    expect(raw.actions[0]).toMatchObject({ post: 2, kind: "layer", patch: { scale: 1.25 } });
    expect(raw.actions[0].change).toContain("DEMO FIXTURE");
  });
});
