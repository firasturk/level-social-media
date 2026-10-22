import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import type { MemoryItem } from "../shared/brandMemory";
import { conflictsBetween, scopeMatches } from "../shared/brandMemory";

/**
 * Brand memory: pending lessons never reach a prompt, accepting a picture approves nothing, a review
 * finding is proposed with its exact words and nothing broader, judging one item leaves the others
 * alone, a revision keeps the history, and each item applies only where its scope says.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;

const ADMIN: User = { id: "u1", email: "u@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "m@test", name: "Mona", role: "member" };

async function app(user: User = ADMIN) {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  for (const u of [ADMIN, MEMBER]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES (?, ?, ?, 'x', ?)").bind(u.id, u.email, u.name, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c2', 'Other', 'other', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "product", title: "Pistachio crossing", brief: "The green shake in the crossing sign.", caption: "", hashtags: "", product: "pistachio" } as never,
      { index: 2, type: "tip", title: "Tip", brief: "A tip card on a wooden table.", caption: "", hashtags: "" } as never,
    ],
  });
  for (const [id, month] of [
    ["b1", "2026-10"],
    ["b2", "2026-11"],
  ])
    await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES (?, 'u1', ?, ?, 'idle', ?, ?, 'c1', ?)")
      .bind(id, `Month ${month}`, JSON.stringify({ ...config, month }), t, t, month)
      .run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare(
    "INSERT INTO tasks (id, batch, source, card, status, output, qa, prompt, updated, post) VALUES ('t1', 'b1', 's1', 1, 'review', 'u1/b1/output/t1.jpg', ?, 'p', ?, 1)",
  )
    .bind(JSON.stringify({ automated: true, flags: [{ kind: "text", text: 'Writing in the picture: "Swipe"' }] }), t)
    .run();
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const send = (a: Awaited<ReturnType<typeof app>>, env: FakeEnv, method: string, path: string, body?: unknown) =>
  a.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } }, env);

async function rows(env: FakeEnv) {
  return (await env.DB.prepare("SELECT * FROM lessons ORDER BY first, revision").all<{ id: string; text: string; status: string; category: string; scope: string; deactivated: number | null; replaces: string | null; revision: number; source: string; approver: string | null; approved_at: number | null }>()).results;
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("what reaches a prompt", () => {
  it("carries only approved, active items and never a pending or rejected one", async () => {
    const env = await seed();
    const { lessonsFor, rememberLesson } = await import("../server/lessons");
    await rememberLesson(env, "c1", "b1", "text", 'Writing in the picture: "Swipe"', "review");
    expect(await lessonsFor(env, "c1")).toEqual([]);
    const a = await app();
    const [pending] = await rows(env);
    expect(pending.status).toBe("pending");
    expect((await send(a, env, "PUT", `/api/studio/lessons/${pending.id}`, { status: "approved" })).status).toBe(200);
    expect(await lessonsFor(env, "c1")).toEqual(['No writing: an earlier picture carried "Swipe". Nothing is written, lettered or drawn as a word, arrow or sign anywhere in the picture.']);
    await send(a, env, "PUT", `/api/studio/lessons/${pending.id}`, { status: "rejected" });
    expect(await lessonsFor(env, "c1")).toEqual([]);
    await send(a, env, "PUT", `/api/studio/lessons/${pending.id}`, { status: "approved" });
    await send(a, env, "POST", `/api/studio/lessons/${pending.id}/deactivate`);
    expect(await lessonsFor(env, "c1")).toEqual([]);
  });

  it("filters by scope: brand-wide always, a month's only for that month, a post's only for that post", async () => {
    const env = await seed();
    const a = await app();
    const { lessonsFor, memoryFor } = await import("../server/lessons");
    expect((await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "No people in any picture.", category: "brand_rule" })).status).toBe(201);
    expect((await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "Everything outdoors at golden hour.", category: "campaign_instruction", scope: { batch: "b1" } })).status).toBe(201);
    expect((await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "The cup from above, lid off.", category: "post_instruction", scope: { batch: "b1", post: 2 } })).status).toBe(201);
    // Without a scope: the brand alone (the existing call sites).
    expect(await lessonsFor(env, "c1")).toEqual(["Brand rule: No people in any picture."]);
    expect(await lessonsFor(env, "c1", { batch: "b2" })).toEqual(["Brand rule: No people in any picture."]);
    expect(await lessonsFor(env, "c1", { batch: "b1" })).toEqual(["Brand rule: No people in any picture.", "This month: Everything outdoors at golden hour."]);
    expect(await lessonsFor(env, "c1", { batch: "b1", post: 1 })).toEqual(["Brand rule: No people in any picture.", "This month: Everything outdoors at golden hour."]);
    expect(await lessonsFor(env, "c1", { batch: "b1", post: 2 })).toEqual(["Brand rule: No people in any picture.", "This month: Everything outdoors at golden hour.", "This post: The cup from above, lid off."]);
    expect(await lessonsFor(env, "c2")).toEqual([]);
    const m = await memoryFor(env, "c1", { batch: "b1", post: 2 });
    expect(m.brand_rule.map((i) => i.text)).toEqual(["No people in any picture."]);
    expect(m.campaign_instruction).toHaveLength(1);
    expect(m.post_instruction[0].scope).toEqual({ batch: "b1", post: 2 });
    expect(m.lesson).toEqual([]);
    const r = await send(a, env, "GET", "/api/studio/lessons/memory?client=c1&batch=b1&post=1");
    expect(((await json(r)) as { post_instruction: unknown[] }).post_instruction).toEqual([]);
    // A campaign instruction needs its month; a post instruction its post.
    expect((await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "x", category: "campaign_instruction" })).status).toBe(400);
    expect((await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "y", category: "post_instruction", scope: { batch: "b1" } })).status).toBe(400);
    expect(scopeMatches({ batch: "b1", post: 2 }, { batch: "b1" })).toBe(false);
    expect(scopeMatches({}, undefined)).toBe(true);
  });

  it("a member's brand rule waits as pending; an admin's is approved with the approver and the time", async () => {
    const env = await seed();
    const asMember = await app(MEMBER);
    const r = (await json(await send(asMember, env, "POST", "/api/studio/lessons", { client: "c1", text: "Only the brand's blue.", category: "brand_rule" }))) as unknown as MemoryItem;
    expect(r.status).toBe("pending");
    expect(r.approver).toBeNull();
    const asAdmin = await app();
    const q = (await json(await send(asAdmin, env, "POST", "/api/studio/lessons", { client: "c1", text: "Always the logo bottom right.", category: "brand_rule" }))) as unknown as MemoryItem;
    expect(q.status).toBe("approved");
    expect(q.approver).toBe("Firas");
    expect(q.approved_at).toBeGreaterThan(0);
    expect(q.source).toBe("team");
    expect(q.revision).toBe(1);
    // A member cannot judge.
    expect((await send(asMember, env, "PUT", `/api/studio/lessons/${r.id}`, { status: "approved" })).status).toBe(403);
    const { lessonsFor } = await import("../server/lessons");
    expect(await lessonsFor(env, "c1")).toEqual(["Brand rule: Always the logo bottom right."]);
  });
});

describe("how lessons are proposed", () => {
  it("accepting a picture changes no lesson's status", async () => {
    const env = await seed();
    const { rememberLessons } = await import("../server/lessons");
    await rememberLessons(env, "c1", "b1", [{ kind: "text", text: 'Writing in the picture: "Swipe"' }, { kind: "bag", text: "The product sits in a paper bag." }]);
    const before = await rows(env);
    expect(before.map((r) => r.status)).toEqual(["pending", "pending"]);
    const a = await app();
    const r = await send(a, env, "POST", "/api/studio/posts/accept", { batch: "b1", index: 1 });
    expect(r.status).toBe(200);
    const after = await rows(env);
    expect(after.map((r) => [r.id, r.status, r.approver, r.approved_at])).toEqual(before.map((r) => [r.id, r.status, r.approver, r.approved_at]));
    const task = await env.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>();
    expect(task?.status).toBe("ready");
  });

  it("a review flag creates one pending lesson with its exact text, scoped to the brand but never a brand rule", async () => {
    const env = await seed();
    const { rememberLessons, rememberLesson } = await import("../server/lessons");
    await rememberLessons(env, "c1", "b1", [{ kind: "people", text: "The post shows a young boy instead of a 6-year-old girl." }]);
    const all = await rows(env);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ text: "The post shows a young boy instead of a 6-year-old girl.", status: "pending", category: "lesson", scope: "", source: "review", revision: 1, approver: null, approved_at: null });
    // Seen again: counted on the same item, still pending.
    await rememberLessons(env, "c1", "b1", [{ kind: "people", text: "The post shows a young boy instead of a 6-year-old girl." }]);
    const again = await rows(env);
    expect(again).toHaveLength(1);
    expect((await env.DB.prepare("SELECT seen FROM lessons").first<{ seen: number }>())?.seen).toBe(2);
    // The client's change and a retry's drift are proposals too.
    await rememberLesson(env, "c1", "b1", "client", "The client prefers the cup on the left.", "client");
    await rememberLesson(env, "c1", "b1", "idea", "Post 2 drifted from its idea and was made again from its original reference: the sign was missing", "retry");
    const three = await rows(env);
    expect(three.map((r) => [r.status, r.category, r.source])).toEqual([
      ["pending", "lesson", "review"],
      ["pending", "lesson", "client"],
      ["pending", "lesson", "retry"],
    ]);
    expect(three.some((r) => r.category === "brand_rule")).toBe(false);
    // The run's own notes are not lessons.
    await rememberLesson(env, "c1", "b1", "similar", "Looks like an earlier picture: post 3", "review");
    expect(await rows(env)).toHaveLength(3);
  });

  it("rejecting one lesson leaves the others as they were", async () => {
    const env = await seed();
    const { rememberLessons } = await import("../server/lessons");
    await rememberLessons(env, "c1", "b1", [
      { kind: "text", text: "A" },
      { kind: "bag", text: "B" },
      { kind: "people", text: "C" },
    ]);
    const a = await app();
    const [x, y, z] = await rows(env);
    await send(a, env, "PUT", `/api/studio/lessons/${y.id}`, { status: "approved" });
    const r = await send(a, env, "PUT", `/api/studio/lessons/${x.id}`, { status: "rejected" });
    expect(await json(r)).toMatchObject({ ok: true, status: "rejected", approver: "Firas", approved_at: null });
    const after = new Map((await rows(env)).map((r) => [r.id, r]));
    expect(after.get(x.id)).toMatchObject({ status: "rejected", approver: "Firas" });
    expect(after.get(y.id)).toMatchObject({ status: "approved", approver: "Firas" });
    expect(after.get(z.id)).toMatchObject({ status: "pending", approver: null, approved_at: null });
    const list = (await json(await send(a, env, "GET", "/api/studio/lessons?client=c1&status=pending"))) as unknown as MemoryItem[];
    expect(list.map((i) => i.id)).toEqual([z.id]);
    const lessons = (await json(await send(a, env, "GET", "/api/studio/lessons?client=c1&category=lesson&active=1"))) as unknown as MemoryItem[];
    expect(lessons).toHaveLength(3);
  });
});

describe("revisions and history", () => {
  it("a revision is a new row with revision + 1 that replaces the old one; the old row is deactivated and keeps its text", async () => {
    const env = await seed();
    const a = await app();
    const first = (await json(await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "No people in any picture.", category: "brand_rule" }))) as unknown as MemoryItem;
    const second = (await json(await send(a, env, "POST", `/api/studio/lessons/${first.id}/revise`, { text: "No people in any picture; hands are fine." }))) as unknown as MemoryItem;
    expect(second.revision).toBe(2);
    expect(second.replaces).toBe(first.id);
    expect(second.status).toBe("approved");
    expect(second.first).toBe(first.first);
    const all = new Map((await rows(env)).map((r) => [r.id, r]));
    expect(all.get(first.id)).toMatchObject({ text: "No people in any picture.", status: "approved", revision: 1 });
    expect(all.get(first.id)?.deactivated).toBeGreaterThan(0);
    expect(all.get(second.id)).toMatchObject({ deactivated: null, replaces: first.id });
    const { lessonsFor } = await import("../server/lessons");
    expect(await lessonsFor(env, "c1")).toEqual(["Brand rule: No people in any picture; hands are fine."]);
    // Revising a retired row is refused; the history is read with the list, active=1 hides it.
    expect((await send(a, env, "POST", `/api/studio/lessons/${first.id}/revise`, { text: "again" })).status).toBe(409);
    expect(((await json(await send(a, env, "GET", "/api/studio/lessons?client=c1&active=1"))) as unknown as MemoryItem[]).map((i) => i.id)).toEqual([second.id]);
    expect(((await json(await send(a, env, "GET", "/api/studio/lessons?client=c1"))) as unknown as MemoryItem[]).length).toBe(2);
    // A member's revision of an approved rule waits as pending; the old rule is retired meanwhile.
    const m = await app(MEMBER);
    const third = (await json(await send(m, env, "POST", `/api/studio/lessons/${second.id}/revise`, { text: "No people; hands and feet are fine." }))) as unknown as MemoryItem;
    expect(third).toMatchObject({ revision: 3, replaces: second.id, status: "pending" });
    expect(await lessonsFor(env, "c1")).toEqual([]);
  });

  it("clearing a client's memory keeps its approved brand rules unless confirm=brand is passed", async () => {
    const env = await seed();
    const a = await app();
    await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "No people in any picture.", category: "brand_rule" });
    await send(a, env, "POST", "/api/studio/lessons", { client: "c1", text: "Outdoors.", category: "campaign_instruction", scope: { batch: "b1" } });
    const { rememberLesson } = await import("../server/lessons");
    await rememberLesson(env, "c1", "b1", "bag", "A bag.", "review");
    expect(await json(await send(a, env, "DELETE", "/api/studio/lessons?client=c1"))).toEqual({ ok: true, deleted: 2, kept: 1 });
    expect((await rows(env)).map((r) => r.category)).toEqual(["brand_rule"]);
    expect(await json(await send(a, env, "DELETE", "/api/studio/lessons?client=c1&confirm=brand"))).toEqual({ ok: true, deleted: 1, kept: 0 });
    expect(await rows(env)).toEqual([]);
  });
});

describe("conflicts between items", () => {
  const item = (id: string, text: string, category: MemoryItem["category"], scope: MemoryItem["scope"] = {}): MemoryItem =>
    ({ id, client: "c1", category, kind: "rule", text, scope, status: "approved", source: "team", seen: 1, first: 1, last: 1, batch: null, approver: null, approved_at: null, revision: 1, replaces: null, deactivated: null, rule: text }) as MemoryItem;
  it("sees a post instruction that asks for what a brand rule forbids", () => {
    const rule = item("r", "No people in any picture.", "brand_rule");
    const post = item("p", "A woman holds the cup towards the camera.", "post_instruction", { batch: "b1", post: 2 });
    const hands = item("h", "Never show hands.", "brand_rule");
    const noText = item("n", "No text on the picture.", "brand_rule");
    const text = item("t", "The headline text sits in the top third.", "post_instruction", { batch: "b1", post: 3 });
    const fine = item("f", "The cup stands on a marble table.", "campaign_instruction", { batch: "b1" });
    const c = conflictsBetween([rule, post, hands, noText, text, fine]);
    expect(c.map((x) => [x.about, x.forbids.id, x.asks.id])).toEqual([
      ["people", "r", "p"],
      ["text", "n", "t"],
    ]);
  });
  it("finds nothing when the items agree", () => {
    expect(conflictsBetween([item("a", "No text in the picture.", "brand_rule"), item("b", "Text-free, the product alone.", "post_instruction", { batch: "b1", post: 1 })])).toEqual([]);
    expect(conflictsBetween([item("a", "No hands.", "brand_rule"), item("b", "The cup on a table.", "post_instruction", { batch: "b1", post: 1 })])).toEqual([]);
  });
});
