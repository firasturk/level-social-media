/**
 * Team (server/team.ts, shared/team.ts): the employees' workspace on the studio's own database and
 * bucket. Channels made by themselves (general, one per client), direct conversations found again,
 * messages with threads, edits, deleted stubs, reactions, pins and search; the poll (/sync) with
 * unread and mention counts per person and a cursor that never skips a row; uploads within the
 * limits and served back; the discussion anchor of a post made once; notifications; the rule-based
 * assistant. The guard proves no network call is made anywhere here: Team is free.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { Post } from "../shared/posts";
import type { Channel, Message, TeamBootstrap, TeamSync, Attachment } from "../shared/team";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { teamRoutes, channelName, likeContains, nextCursor, unreadMath, parseAiQuestion, monthTitle } from "../server/team";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MONA: User = { id: "u2", email: "mona@test", name: "Mona", role: "member" };
const SAMI: User = { id: "u3", email: "sami@test", name: "Sami", role: "member" };
const GONE: User = { id: "u4", email: "gone@test", name: "Left", role: "member" };
const json = <T = Record<string, unknown>>(r: Response) => r.json() as Promise<T>;
const tick = () => new Promise((r) => setTimeout(r, 3));

/** A real, tiny PNG (w×h, one colour). */
function png(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (1 + w * 3) + 1 + x * 3);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function app(user: User | null) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  a.route("/api/team", teamRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const get = (env: FakeEnv, user: User | null, path: string) => app(user).request(`/api/team${path}`, {}, env);
const send = (env: FakeEnv, user: User | null, method: string, path: string, data?: unknown) =>
  app(user).request(`/api/team${path}`, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) }, env);
const post = (env: FakeEnv, user: User | null, path: string, data?: unknown) => send(env, user, "POST", path, data);

/** Three people (one disabled), two clients (one archived), a month of Mona's with two posts and one picture. */
async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now() - 10_000;
  await env.DB.prepare("DELETE FROM clients").run(); // the migrations seed Level's first clients; this test has its own
  for (const u of [ADMIN, MONA, SAMI, GONE]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created, disabled) VALUES (?, ?, ?, 'x', ?, ?, ?)").bind(u.id, u.email, u.name, u.role, t, u.id === GONE.id ? 1 : 0).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, position, created, updated) VALUES ('c1', 'Abu Saleh', 'abu-saleh-team', 'active', 1, ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, position, created, updated) VALUES ('c2', 'حبيبة', 'habibah-team', 'active', 2, ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, position, created, updated) VALUES ('c3', 'Old Brand', 'old-brand-team', 'archived', 3, ?, ?)").bind(t, t).run();
  const plan = [
    { index: 1, type: "product", title: "Kunafa tray", brief: "b", caption: "", hashtags: "" } as Post,
    { index: 2, type: "tip", title: "Morning coffee", brief: "b", caption: "", hashtags: "" } as Post,
  ];
  const config = postConfig("c1", "2026-10", { plan, postCount: 2 });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, role, created) VALUES ('s1', 'b1', 'x.png', 'x', 'k/x.png', 'image/png', 1, 'lead', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, post, status, output, qa, prompt, updated) VALUES ('t1', 'b1', 's1', 1, 1, 'review', 'u2/b1/output/t1/1.png', '{\"flags\":[{\"a\":1}]}', '', ?)").bind(t).run();
  return env;
}

async function bootstrap(env: FakeEnv, user: User) {
  const r = await get(env, user, "/bootstrap");
  expect(r.status).toBe(200);
  return json<TeamBootstrap>(r);
}
const channelOf = (b: TeamBootstrap, kind: string, name?: string) => b.channels.find((c) => c.kind === kind && (!name || c.name === name))!;

async function say(env: FakeEnv, user: User, channel: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await post(env, user, "/messages", { channel, body, ...extra });
  expect(r.status).toBe(200);
  return (await json<{ message: Message }>(r)).message;
}

async function dm(env: FakeEnv, user: User, other: string) {
  const r = await post(env, user, "/channels", { kind: "dm", members: [other] });
  expect(r.status).toBe(200);
  return (await json<{ channel: Channel }>(r)).channel;
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached).toEqual([]);
});

describe("Team: pure helpers", () => {
  it("names a dm after the other person, escapes LIKE, keeps the cursor on what was seen and counts unread", () => {
    const members = [{ id: "u1", name: "Firas", email: "", role: "admin" as const }, { id: "u2", name: "Mona", email: "", role: "member" as const }];
    expect(channelName("dm", "dm", members, "u1")).toBe("Mona");
    expect(channelName("dm", "dm", members, "u2")).toBe("Firas");
    expect(channelName("client", "Abu Saleh", [], "u1")).toBe("Abu Saleh");
    expect(likeContains("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    expect(nextCursor(100, [])).toBe(100);
    expect(nextCursor(100, [90, 150, 120])).toBe(150);
    const rows = [
      { author: "u2", at: 10, mentions: null },
      { author: "u2", at: 20, mentions: ["u1"] },
      { author: "u1", at: 30, mentions: ["u2"] },
      { author: "u2", at: 40, mentions: null, deleted: true },
    ];
    expect(unreadMath(rows, "u1", 0)).toEqual({ unread: 2, mentioned: true });
    expect(unreadMath(rows, "u1", 20)).toEqual({ unread: 0, mentioned: false });
    expect(unreadMath(rows, "u2", 0)).toEqual({ unread: 1, mentioned: true });
    expect(monthTitle("Abu Saleh", "2026-10")).toBe("Abu Saleh · October 2026");
    expect(monthTitle(null, "2026-10")).toBe("October 2026");
    expect(monthTitle(null, null, "Loose")).toBe("Loose");
  });

  it("parses a question for its intent, client (any script) and month, without a model", () => {
    const clients = [{ id: "c1", name: "Abu Saleh" }, { id: "c2", name: "حبيبة" }];
    expect(parseAiQuestion("pending tasks for Abu Saleh", clients)).toEqual({ intent: "tasks", client: { id: "c1", name: "Abu Saleh" }, month: null });
    expect(parseAiQuestion("unfinished posts for October", clients, 2026)).toEqual({ intent: "unfinished", client: null, month: "2026-10" });
    expect(parseAiQuestion("what is overdue for حبيبة?", clients)).toEqual({ intent: "overdue", client: { id: "c2", name: "حبيبة" }, month: null });
    expect(parseAiQuestion("which creatives need approval in 2026-11", clients)).toEqual({ intent: "approval", client: null, month: "2026-11" });
    expect(parseAiQuestion("tell me a joke", clients).intent).toBeNull();
  });
});

describe("Team: channels", () => {
  it("is mounted behind the session in the worker and refuses a call without a user", async () => {
    const index = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");
    expect(index).toMatch(/app\.use\("\/api\/team\/\*"/);
    expect(index).toMatch(/app\.route\("\/api\/team", teamRoutes\)/);
    expect(index).toMatch(/dueSoonNotifications\(env\)/);
    const env = await seed();
    expect((await get(env, null, "/bootstrap")).status).toBe(401);
    expect((await post(env, null, "/messages", { channel: "x", body: "hi" })).status).toBe(401);
  });

  it("makes general and one channel per active client once, lists active people, and starts the cursor", async () => {
    const env = await seed();
    const b = await bootstrap(env, MONA);
    expect(b.me).toEqual({ id: "u2", name: "Mona", email: "mona@test", role: "member" });
    expect(b.users.map((u) => u.id).sort()).toEqual(["u1", "u2", "u3"]);
    expect(b.channels.map((c) => [c.kind, c.name, c.client])).toEqual([
      ["general", "general", null],
      ["client", "Abu Saleh", "c1"],
      ["client", "حبيبة", "c2"],
    ]);
    expect(b.channels.every((c) => c.unread === 0 && !c.mentioned && c.lastAt === null && !c.archived && c.members === undefined)).toBe(true);
    expect(b.unread).toBe(0);
    expect(b.tasksOpen).toBe(0);
    expect(b.cursor).toBe(0);
    // Twice: the same channels, no duplicates; a client renamed renames its channel.
    await env.DB.prepare("UPDATE clients SET name = 'Abu Saleh Sweets' WHERE id = 'c1'").run();
    const again = await bootstrap(env, ADMIN);
    expect(again.channels.map((c) => c.id).sort()).toEqual(b.channels.map((c) => c.id).sort());
    expect(channelOf(again, "client", "Abu Saleh Sweets").client).toBe("c1");
  });

  it("finds the same direct conversation twice, names it per person, and hides it from others", async () => {
    const env = await seed();
    const a = await dm(env, MONA, "u3");
    expect(a.kind).toBe("dm");
    expect(a.name).toBe("Sami");
    expect(a.members?.map((m) => m.id).sort()).toEqual(["u2", "u3"]);
    const b = await dm(env, SAMI, "u2");
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Mona");
    const asMembers = await post(env, MONA, "/channels", { kind: "dm", members: ["u2", "u3"] });
    expect((await json<{ channel: Channel }>(asMembers)).channel.id).toBe(a.id);
    await say(env, MONA, a.id, "secret");
    expect((await get(env, ADMIN, `/messages?channel=${a.id}`)).status).toBe(404);
    expect((await post(env, ADMIN, "/messages", { channel: a.id, body: "hi" })).status).toBe(404);
    expect((await get(env, SAMI, `/messages?channel=${a.id}`)).status).toBe(200);
    // Not with three, not with a disabled person, not with oneself.
    expect((await post(env, MONA, "/channels", { kind: "dm", members: ["u1", "u3"] })).status).toBe(400);
    expect((await post(env, MONA, "/channels", { kind: "dm", members: ["u4"] })).status).toBe(400);
    expect((await post(env, MONA, "/channels", { kind: "dm", members: [] })).status).toBe(400);
    const list = await json<{ channels: Channel[] }>(await get(env, ADMIN, "/channels"));
    expect(list.channels.some((c) => c.id === a.id)).toBe(false);
  });

  it("makes project and group channels with members, adds and removes people, archives for admins", async () => {
    const env = await seed();
    const r = await post(env, MONA, "/channels", { kind: "project", name: "Ramadan campaign", client: "c1", members: ["u3"] });
    const ch = (await json<{ channel: Channel }>(r)).channel;
    expect(ch.kind).toBe("project");
    expect(ch.client).toBe("c1");
    expect(ch.members?.map((m) => m.id).sort()).toEqual(["u2", "u3"]);
    expect((await post(env, MONA, "/channels", { kind: "group", members: ["u3"] })).status).toBe(400); // no name
    expect((await post(env, MONA, "/channels", { kind: "project", name: "x", client: "nope", members: [] })).status).toBe(404);
    const added = await json<{ channel: Channel }>(await post(env, MONA, `/channels/${ch.id}/members`, { add: ["u1"], remove: ["u3"] }));
    expect(added.channel.members?.map((m) => m.id).sort()).toEqual(["u1", "u2"]);
    expect((await post(env, MONA, `/channels/${ch.id}/members`, { add: ["u4"] })).status).toBe(400);
    expect((await get(env, SAMI, `/messages?channel=${ch.id}`)).status).toBe(404);
    expect((await post(env, SAMI, `/channels/${ch.id}/archive`, { archived: true })).status).toBe(404);
    const archived = await json<{ channel: Channel }>(await post(env, ADMIN, `/channels/${ch.id}/archive`, { archived: true }));
    expect(archived.channel.archived).toBe(true);
    expect((await post(env, MONA, "/messages", { channel: ch.id, body: "late" })).status).toBe(409);
    const general = channelOf(await bootstrap(env, ADMIN), "general");
    expect((await post(env, ADMIN, `/channels/${general.id}/archive`, { archived: true })).status).toBe(400);
  });
});

describe("Team: messages", () => {
  it("posts, threads (a reply to a reply joins the root), edits by the author only, deletes to a stub", async () => {
    const env = await seed();
    const general = channelOf(await bootstrap(env, MONA), "general");
    const root = await say(env, MONA, general.id, "Hello @[Sami](u3) and @[Left](u4)");
    expect(root.thread).toBeNull();
    expect(root.mentions).toEqual(["u3"]); // the disabled person is not mentioned
    expect(root.kind).toBe("text");
    const reply = await say(env, SAMI, general.id, "Hi!", { thread: root.id });
    expect(reply.thread).toBe(root.id);
    const deeper = await say(env, ADMIN, general.id, "Me too", { thread: reply.id });
    expect(deeper.thread).toBe(root.id);
    const thread = await json<{ root: Message; replies: Message[] }>(await get(env, MONA, `/thread?message=${reply.id}`));
    expect(thread.root.id).toBe(root.id);
    expect(thread.root.replies).toBe(2);
    expect(thread.replies.map((m) => m.body)).toEqual(["Hi!", "Me too"]);
    const page = await json<{ messages: Message[]; hasMore: boolean }>(await get(env, MONA, `/messages?channel=${general.id}`));
    expect(page.messages.map((m) => m.id)).toEqual([root.id]); // top-level only, newest last
    expect(page.hasMore).toBe(false);
    expect((await post(env, SAMI, "/messages", { channel: general.id, body: "" })).status).toBe(400);
    expect((await post(env, SAMI, "/messages", { channel: general.id, body: "x".repeat(4001) })).status).toBe(400);
    // Edit: the author only, stamped.
    expect((await send(env, SAMI, "PUT", `/messages/${root.id}`, { body: "nope" })).status).toBe(403);
    const edited = (await json<{ message: Message }>(await send(env, MONA, "PUT", `/messages/${root.id}`, { body: "Hello again" }))).message;
    expect(edited.body).toBe("Hello again");
    expect(edited.edited).toBeGreaterThan(0);
    expect(edited.mentions).toEqual([]);
    // Delete: the author or an admin; a stub stays so the thread keeps its shape.
    expect((await send(env, SAMI, "DELETE", `/messages/${root.id}`)).status).toBe(403);
    expect((await send(env, ADMIN, "DELETE", `/messages/${root.id}`)).status).toBe(200);
    const after = await json<{ root: Message; replies: Message[] }>(await get(env, MONA, `/thread?message=${root.id}`));
    expect(after.root.deleted).toBe(true);
    expect(after.root.body).toBe("");
    expect(after.replies).toHaveLength(2);
    expect((await send(env, MONA, "PUT", `/messages/${root.id}`, { body: "back" })).status).toBe(409);
  });

  it("toggles reactions, pins and unpins, and searches the body literally in my channels only", async () => {
    const env = await seed();
    const b = await bootstrap(env, MONA);
    const general = channelOf(b, "general");
    const m = await say(env, MONA, general.id, "Sale 50% off_today");
    let r = (await json<{ message: Message }>(await post(env, SAMI, `/messages/${m.id}/react`, { emoji: "👍" }))).message;
    expect(r.reactions).toEqual([{ emoji: "👍", users: ["u3"] }]);
    r = (await json<{ message: Message }>(await post(env, MONA, `/messages/${m.id}/react`, { emoji: "👍" }))).message;
    expect(r.reactions).toEqual([{ emoji: "👍", users: ["u3", "u2"] }]);
    r = (await json<{ message: Message }>(await post(env, SAMI, `/messages/${m.id}/react`, { emoji: "👍" }))).message;
    expect(r.reactions).toEqual([{ emoji: "👍", users: ["u2"] }]);
    r = (await json<{ message: Message }>(await post(env, SAMI, `/messages/${m.id}/pin`, { pinned: true }))).message;
    expect(r.pinned).toBe(true);
    expect((await json<{ messages: Message[] }>(await get(env, ADMIN, `/pins?channel=${general.id}`))).messages.map((x) => x.id)).toEqual([m.id]);
    r = (await json<{ message: Message }>(await post(env, SAMI, `/messages/${m.id}/pin`, { pinned: false }))).message;
    expect(r.pinned).toBe(false);
    expect((await json<{ messages: Message[] }>(await get(env, ADMIN, `/pins?channel=${general.id}`))).messages).toEqual([]);
    // Search: "%" and "_" are letters here, a dm I am not in stays hidden.
    const secret = await dm(env, MONA, "u3");
    await say(env, MONA, secret.id, "Sale 50% off_today for Sami only");
    const mine = await json<{ messages: Message[] }>(await get(env, MONA, "/search?q=50%25%20off_today"));
    expect(mine.messages.map((x) => x.body)).toEqual(["Sale 50% off_today for Sami only", "Sale 50% off_today"]);
    const theirs = await json<{ messages: Message[] }>(await get(env, ADMIN, "/search?q=off_today"));
    expect(theirs.messages.map((x) => x.id)).toEqual([m.id]);
    expect((await json<{ messages: Message[] }>(await get(env, ADMIN, "/search?q=50%25x"))).messages).toEqual([]);
    expect((await json<{ messages: Message[] }>(await get(env, ADMIN, `/search?q=sale&channel=${general.id}`))).messages).toHaveLength(1);
    expect((await get(env, ADMIN, `/search?q=sale&channel=${secret.id}`)).status).toBe(404);
  });

  it("shows what a message is about: a post of a month the author can open, with its picture and status", async () => {
    const env = await seed();
    const ch = channelOf(await bootstrap(env, MONA), "client", "Abu Saleh");
    // Sami is not on the month: the ref is refused; Mona owns it.
    expect((await post(env, SAMI, "/messages", { channel: ch.id, body: "look", ref: { batch: "b1", post: 1 } })).status).toBe(404);
    const m = await say(env, MONA, ch.id, "look", { ref: { batch: "b1", post: 1 } });
    expect(m.ref).toEqual({ batch: "b1", post: 1, preview: { title: "Kunafa tray", where: "Abu Saleh · October 2026", status: "review", thumb: "/api/studio/file?batch=b1&id=t1&kind=result&w=480", review: null } });
    const bare = await say(env, ADMIN, ch.id, "the month", { ref: { batch: "b1" } });
    expect(bare.ref?.preview).toEqual({ title: "October", where: "Abu Saleh · October 2026" });
    const noPicture = await say(env, MONA, ch.id, "post 2", { ref: { batch: "b1", post: 2 } });
    expect(noPicture.ref?.preview?.thumb).toBeNull();
    expect(noPicture.ref?.preview?.title).toBe("Morning coffee");
  });
});

describe("Team: the poll", () => {
  it("returns changed rows since the cursor, unread and mentions per person, and never skips a row", async () => {
    const env = await seed();
    const mona = await bootstrap(env, MONA);
    const general = channelOf(mona, "general");
    const m1 = await say(env, MONA, general.id, "morning @[Sami](u3)");
    await tick();
    const s1 = await json<TeamSync>(await get(env, SAMI, `/sync?cursor=${mona.cursor}`));
    expect(s1.messages.map((m) => m.id)).toEqual([m1.id]);
    // The cursor is the newest stamp seen (the message or the mention notification written just after it), never the clock.
    expect(s1.cursor).toBeGreaterThanOrEqual(m1.at);
    expect(s1.cursor).toBeLessThanOrEqual(Math.max(m1.at, ...s1.notifications.map((n) => n.at)));
    const g1 = s1.channels.find((c) => c.id === general.id)!;
    expect(g1).toEqual({ id: general.id, unread: 1, mentioned: true, lastAt: m1.at });
    expect(s1.unread).toBe(2); // one unread message and one unseen mention notification
    expect(s1.notifications.map((n) => n.kind)).toEqual(["mention"]);
    // The author's own view: nothing unread, nothing mentioned.
    const own = await json<TeamSync>(await get(env, MONA, `/sync?cursor=0`));
    expect(own.channels.find((c) => c.id === general.id)).toEqual({ id: general.id, unread: 0, mentioned: false, lastAt: m1.at });
    expect(own.unread).toBe(0);
    // Nothing new: the same cursor comes back, no rows.
    const quiet = await json<TeamSync>(await get(env, SAMI, `/sync?cursor=${s1.cursor}`));
    expect(quiet.cursor).toBe(s1.cursor);
    expect(quiet.messages).toEqual([]);
    expect(quiet.notifications).toEqual([]);
    // Reading marks the channel; a reaction changes the row and the poll carries it again.
    expect((await post(env, SAMI, `/channels/${general.id}/read`, { at: m1.at })).status).toBe(200);
    await tick();
    await post(env, ADMIN, `/messages/${m1.id}/react`, { emoji: "🔥" });
    const s2 = await json<TeamSync>(await get(env, SAMI, `/sync?cursor=${s1.cursor}`));
    expect(s2.messages.map((m) => m.id)).toEqual([m1.id]);
    expect(s2.messages[0].reactions).toEqual([{ emoji: "🔥", users: ["u1"] }]);
    expect(s2.cursor).toBeGreaterThan(s1.cursor);
    expect(s2.channels.find((c) => c.id === general.id)).toEqual({ id: general.id, unread: 0, mentioned: false, lastAt: m1.at });
    expect(s2.unread).toBe(1); // the mention notification is still unseen
    await post(env, SAMI, "/notifications/seen", {});
    expect((await json<TeamSync>(await get(env, SAMI, `/sync?cursor=${s2.cursor}`))).unread).toBe(0);
    // A dm I am not in never reaches my poll; its member sees it and is told.
    const secret = await dm(env, MONA, "u1");
    await tick();
    const m2 = await say(env, MONA, secret.id, "for Firas");
    const outside = await json<TeamSync>(await get(env, SAMI, `/sync?cursor=${s2.cursor}`));
    expect(outside.messages).toEqual([]);
    expect(outside.channels.some((c) => c.id === secret.id)).toBe(false);
    const inside = await json<TeamSync>(await get(env, ADMIN, `/sync?cursor=${s2.cursor}`));
    expect(inside.messages.map((m) => m.id)).toEqual([m2.id]);
    expect(inside.notifications.map((n) => [n.kind, n.text])).toEqual([["dm", "Mona: for Firas"]]);
    expect(inside.channels.find((c) => c.id === secret.id)).toEqual({ id: secret.id, unread: 1, mentioned: false, lastAt: m2.at });
  });
});

describe("Team: files", () => {
  const upload = (env: FakeEnv, user: User, file: File, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("file", file, file.name);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return app(user).request("/api/team/upload", { method: "POST", body: form }, env);
  };

  it("stores a picture once per person and bytes, refuses a renamed file and a foreign type, and serves it back", async () => {
    const env = await seed();
    const bytes = png(6, 8, [200, 100, 50]);
    const r1 = await upload(env, MONA, new File([bytes], "shot.png", { type: "image/png" }));
    expect(r1.status).toBe(200);
    const a1 = (await json<{ attachment: Attachment }>(r1)).attachment;
    expect(a1).toMatchObject({ name: "shot.png", mime: "image/png", size: bytes.length, kind: "image", width: 6, height: 8, url: `/api/team/file/${a1.id}` });
    // The same bytes again: a second row, one object.
    const r2 = await upload(env, MONA, new File([bytes], "copy.png", { type: "image/jpeg" }));
    const a2 = (await json<{ attachment: Attachment }>(r2)).attachment;
    expect(a2.id).not.toBe(a1.id);
    expect(a2.mime).toBe("image/png"); // the sniffed kind, not the declared one
    const keys = await env.DB.prepare("SELECT id, key FROM team_attachments ORDER BY created").all<{ id: string; key: string }>();
    expect(keys.results.map((k) => k.key)).toEqual([`team/u2/${a1.id}.png`, `team/u2/${a1.id}.png`]);
    expect([...env.BUCKET.objects.keys()]).toEqual([`team/u2/${a1.id}.png`]);
    // Another person uploading the same bytes gets their own object.
    const r3 = await upload(env, SAMI, new File([bytes], "shot.png", { type: "image/png" }));
    const a3 = (await json<{ attachment: Attachment }>(r3)).attachment;
    expect(env.BUCKET.objects.has(`team/u3/${a3.id}.png`)).toBe(true);
    // A text file wearing a picture's name and type is caught by its bytes; an unknown type is refused.
    const fake = await upload(env, MONA, new File([new TextEncoder().encode("hello")], "fake.png", { type: "image/png" }));
    expect(fake.status).toBe(415);
    expect((await upload(env, MONA, new File([new Uint8Array([1, 2, 3])], "run.exe", { type: "application/x-msdownload" }))).status).toBe(415);
    expect((await app(MONA).request("/api/team/upload", { method: "POST", body: new FormData() }, env)).status).toBe(400);
    // Too large: the limit of its kind.
    const huge = await upload(env, MONA, new File([new Uint8Array(21 * 1024 * 1024)], "big.png", { type: "image/png" }));
    expect(huge.status).toBe(413);
    // Served back with its type, inline, by any signed-in employee; nothing without a user.
    const served = await get(env, ADMIN, `/file/${a1.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''shot.png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    expect((await get(env, null, `/file/${a1.id}`)).status).toBe(401);
    expect((await get(env, ADMIN, "/file/nope")).status).toBe(404);
    const small = await get(env, ADMIN, `/file/${a1.id}?w=480`);
    expect(small.status).toBe(200);
    expect(small.headers.get("content-type")).toMatch(/^image\//);
  });

  it("takes a voice note and a document, attaches them to one message each, and keeps a deleted message's bytes only while referenced", async () => {
    const env = await seed();
    const voice = (await json<{ attachment: Attachment }>(await upload(env, MONA, new File([new Uint8Array([1, 2, 3, 4])], "note.webm", { type: "audio/webm" }), { duration: "12.4" }))).attachment;
    expect(voice).toMatchObject({ kind: "voice", duration: 12.4, mime: "audio/webm" });
    expect((await upload(env, MONA, new File([new Uint8Array([1, 2, 3, 4, 5])], "long.webm", { type: "audio/webm" }), { duration: "200" })).status).toBe(413);
    const doc = (await json<{ attachment: Attachment }>(await upload(env, MONA, new File([new Uint8Array([37, 80, 68, 70])], "brief.pdf", { type: "application/pdf" })))).attachment;
    expect(doc.kind).toBe("file");
    const asFile = await get(env, SAMI, `/file/${doc.id}`);
    expect(asFile.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''brief.pdf");
    expect(asFile.headers.get("content-type")).toBe("application/pdf");
    const general = channelOf(await bootstrap(env, MONA), "general");
    const m = await say(env, MONA, general.id, "", { attachments: [voice.id] });
    expect(m.kind).toBe("voice");
    expect(m.attachments.map((a) => a.id)).toEqual([voice.id]);
    // Someone else's attachment, or one already on a message, cannot be attached again.
    expect((await post(env, SAMI, "/messages", { channel: general.id, body: "mine", attachments: [doc.id] })).status).toBe(404);
    expect((await post(env, MONA, "/messages", { channel: general.id, body: "again", attachments: [voice.id] })).status).toBe(409);
    const m2 = await say(env, MONA, general.id, "the brief", { attachments: [doc.id] });
    expect(m2.attachments[0].name).toBe("brief.pdf");
    const key = `team/u2/${doc.id}.pdf`;
    expect(env.BUCKET.objects.has(key)).toBe(true);
    await send(env, MONA, "DELETE", `/messages/${m2.id}`);
    expect(env.BUCKET.objects.has(key)).toBe(false);
    expect((await get(env, SAMI, `/file/${doc.id}`)).status).toBe(404);
    expect(env.BUCKET.objects.has(`team/u2/${voice.id}.webm`)).toBe(true);
  });
});

describe("Team: the discussion of a post", () => {
  it("opens the client's channel with one anchor per post, made once, whose thread is the discussion", async () => {
    const env = await seed();
    const r = await get(env, MONA, "/discuss?batch=b1&post=1");
    expect(r.status).toBe(200);
    const first = await json<{ channel: Channel; message: Message }>(r);
    expect(first.channel.kind).toBe("client");
    expect(first.channel.client).toBe("c1");
    expect(first.message).toMatchObject({ kind: "system", body: "Discussion of post 1 · Kunafa tray", thread: null, ref: { batch: "b1", post: 1 } });
    const again = await json<{ channel: Channel; message: Message }>(await get(env, ADMIN, "/discuss?batch=b1&post=1"));
    expect(again.message.id).toBe(first.message.id);
    const other = await json<{ channel: Channel; message: Message }>(await get(env, MONA, "/discuss?batch=b1&post=2"));
    expect(other.message.id).not.toBe(first.message.id);
    expect(other.message.body).toBe("Discussion of post 2 · Morning coffee");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_messages WHERE kind = 'system'").first<{ n: number }>();
    expect(count?.n).toBe(2);
    await say(env, ADMIN, first.channel.id, "Make the tray bigger", { thread: first.message.id });
    const thread = await json<{ root: Message; replies: Message[] }>(await get(env, MONA, `/thread?message=${first.message.id}`));
    expect(thread.replies).toHaveLength(1);
    // Someone not on the month cannot open its discussion; a bad ask is refused.
    expect((await get(env, SAMI, "/discuss?batch=b1&post=1")).status).toBe(404);
    expect((await get(env, MONA, "/discuss?batch=b1")).status).toBe(400);
  });
});

describe("Team: notifications and the assistant", () => {
  it("tells people about mentions and direct messages, lists them newest first and marks them seen", async () => {
    const env = await seed();
    const general = channelOf(await bootstrap(env, MONA), "general");
    await say(env, MONA, general.id, "@[Sami](u3) @[Mona](u2) please look");
    await tick();
    const d = await dm(env, MONA, "u3");
    await say(env, MONA, d.id, "and @[Sami](u3) here");
    const list = await json<{ notifications: { kind: string; text: string; seen: boolean; ref: Record<string, unknown> }[] }>(await get(env, SAMI, "/notifications"));
    expect(list.notifications.map((n) => n.kind)).toEqual(["dm", "mention"]); // one for the dm (not twice), newest first
    expect(list.notifications[0].text).toBe("Mona: and @Sami here");
    expect(list.notifications[1].text).toBe("Mona mentioned you in #general: @Sami @Mona please look");
    expect(list.notifications[1].ref).toEqual({ channel: general.id, message: expect.any(String) });
    expect(list.notifications.every((n) => !n.seen)).toBe(true);
    // Mona mentioned herself: no notification for the author.
    expect((await json<{ notifications: unknown[] }>(await get(env, MONA, "/notifications"))).notifications).toEqual([]);
    const [newest] = list.notifications as unknown as { id: string }[];
    await post(env, SAMI, "/notifications/seen", { ids: [newest.id] });
    const after = await json<{ notifications: { seen: boolean }[] }>(await get(env, SAMI, "/notifications"));
    expect(after.notifications.map((n) => n.seen)).toEqual([true, false]);
    await post(env, SAMI, "/notifications/seen", {});
    expect((await json<{ notifications: { seen: boolean }[] }>(await get(env, SAMI, "/notifications"))).notifications.every((n) => n.seen)).toBe(true);
  });

  it("answers from the database by rules alone and never writes", async () => {
    const env = await seed();
    await post(env, ADMIN, "/tasks", { title: "Fix the kunafa tray", assignee: "u2", client: "c1", priority: "urgent", due: "2020-01-01" });
    await post(env, ADMIN, "/tasks", { title: "Send the plan", assignee: "u3", client: "c1" });
    await post(env, ADMIN, "/tasks", { title: "Done thing", client: "c1", status: "done" });
    await post(env, MONA, "/reviews", { batch: "b1", post: 1, status: "review" });
    const before = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM team_tasks) + (SELECT COUNT(*) FROM team_messages) + (SELECT COUNT(*) FROM team_notifications) + (SELECT COUNT(*) FROM team_reviews) AS n").first<{ n: number }>();
    const ask = async (q: string) => json<{ answer: string; items?: unknown[] }>(await post(env, SAMI, "/ai", { q }));
    const tasks = await ask("pending tasks for Abu Saleh");
    expect(tasks.answer).toBe("2 open tasks for Abu Saleh: 1 urgent, 1 normal. Fix the kunafa tray (Mona); Send the plan (Sami).");
    expect(tasks.items).toHaveLength(2);
    const overdue = await ask("what is overdue?");
    expect(overdue.answer).toBe("1 task is overdue: 1 urgent. Fix the kunafa tray (Mona).");
    const unfinished = await ask("unfinished posts for Abu Saleh in October 2026");
    expect(unfinished.answer).toBe("1 of 2 planned posts for Abu Saleh in October 2026 are not made yet: post 2 Morning coffee.");
    expect(unfinished.items).toEqual([{ batch: "b1", post: 2, title: "Morning coffee", where: "Abu Saleh · October 2026", status: undefined }]);
    const approval = await ask("which creatives need approval");
    expect(approval.answer).toBe("1 creative is waiting for approval: post 1 Kunafa tray.");
    expect(approval.items).toEqual([{ batch: "b1", post: 1, title: "Kunafa tray", where: "Abu Saleh · October 2026", status: "review", review: "review" }]);
    expect((await ask("unfinished posts for حبيبة")).answer).toBe("No month of posts found for حبيبة.");
    expect((await ask("what is the weather")).answer).toBe("I can list tasks, unfinished posts, overdue work and creatives waiting for approval.");
    expect((await post(env, SAMI, "/ai", { q: "" })).status).toBe(400);
    const after = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM team_tasks) + (SELECT COUNT(*) FROM team_messages) + (SELECT COUNT(*) FROM team_notifications) + (SELECT COUNT(*) FROM team_reviews) AS n").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
