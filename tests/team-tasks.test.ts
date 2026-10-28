/**
 * Team tasks and internal approvals (server/team.ts, server/team-db.ts): tasks with a history of
 * every change, the filters of the list, a task made from a message, the month task made when a
 * month is assigned (once per person while open), approvals that mark the studio picture ready
 * like the Studio's Accept and change requests that make one task for the month's owner, and the
 * daily due-date notifications that run once a day. No network call anywhere.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { Post } from "../shared/posts";
import type { Channel, Message, Review, Task, TeamBootstrap } from "../shared/team";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { teamRoutes, monthAssignedTask, dueSoonNotifications } from "../server/team";
import { studioRoutes } from "../server/studio";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };
const MONA: User = { id: "u2", email: "mona@test", name: "Mona", role: "member" };
const SAMI: User = { id: "u3", email: "sami@test", name: "Sami", role: "member" };
const json = <T = Record<string, unknown>>(r: Response) => r.json() as Promise<T>;

function app(user: User) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  a.route("/api/team", teamRoutes);
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}
const get = (env: FakeEnv, user: User, path: string) => app(user).request(path, {}, env);
const send = (env: FakeEnv, user: User, method: string, path: string, data?: unknown) =>
  app(user).request(path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) }, env);
const post = (env: FakeEnv, user: User, path: string, data?: unknown) => send(env, user, "POST", path, data);

/** Three people, two clients, a month of Mona's (two posts, one picture in review) and an older month of Firas's. */
async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now() - 10_000;
  await env.DB.prepare("DELETE FROM clients").run();
  for (const u of [ADMIN, MONA, SAMI]) await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created, disabled) VALUES (?, ?, ?, 'x', ?, ?, 0)").bind(u.id, u.email, u.name, u.role, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, position, created, updated) VALUES ('c1', 'Abu Saleh', 'abu-saleh-tasks', 'active', 1, ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, position, created, updated) VALUES ('c2', 'Habibah', 'habibah-tasks', 'active', 2, ?, ?)").bind(t, t).run();
  const plan = [
    { index: 1, type: "product", title: "Kunafa tray", brief: "b", caption: "", hashtags: "" } as Post,
    { index: 2, type: "tip", title: "Morning coffee", brief: "b", caption: "", hashtags: "" } as Post,
  ];
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u2', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(postConfig("c1", "2026-10", { plan, postCount: 2 })), t, t).run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b2', 'u1', 'September', ?, 'idle', ?, ?, 'c2', '2026-09')").bind(JSON.stringify(postConfig("c2", "2026-09", { plan: [plan[0]], postCount: 1 })), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, role, created) VALUES ('s1', 'b1', 'x.png', 'x', 'k/x.png', 'image/png', 1, 'lead', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, post, status, output, qa, prompt, updated) VALUES ('t1', 'b1', 's1', 1, 1, 'review', 'u2/b1/output/t1/1.png', '{\"flags\":[{\"a\":1}],\"notes\":\"n\"}', '', ?)").bind(t).run();
  return env;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const studioTask = (env: FakeEnv) => env.DB.prepare("SELECT status, qa FROM tasks WHERE id = 't1'").first<{ status: string; qa: string }>();
const notifications = (env: FakeEnv, user: string) => env.DB.prepare("SELECT kind, text, ref FROM team_notifications WHERE user = ? ORDER BY at, rowid").bind(user).all<{ kind: string; text: string; ref: string }>().then((r) => r.results);

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached).toEqual([]);
});

describe("Team tasks", () => {
  it("creates, changes with a history of every field, comments, and resolves people, client and month", async () => {
    const env = await seed();
    const made = await post(env, ADMIN, "/api/team/tasks", { title: "Fix the tray", description: "Bigger", assignee: "u2", batch: "b1", post: 1, due: "2026-10-30", priority: "high" });
    expect(made.status).toBe(200);
    const t = (await json<{ task: Task }>(made)).task;
    expect(t).toMatchObject({
      title: "Fix the tray",
      description: "Bigger",
      assignee: { id: "u2", name: "Mona" },
      client: "c1", // filled from the month
      clientName: "Abu Saleh",
      batch: "b1",
      batchName: "Abu Saleh · October 2026",
      post: 1,
      due: "2026-10-30",
      priority: "high",
      status: "todo",
      kind: "task",
      createdBy: { id: "u1", name: "Firas" },
      preview: { title: "Kunafa tray", where: "Abu Saleh · October 2026", status: "review", thumb: "/api/studio/file?batch=b1&id=t1&kind=result&w=480", review: null },
    });
    expect(t.events?.map((e) => e.change)).toEqual([{ field: "created", from: null, to: "Fix the tray" }]);
    expect(await notifications(env, "u2")).toEqual([{ kind: "task", text: "Firas assigned you: Fix the tray", ref: JSON.stringify({ task: t.id }) }]);
    // Changes: one event per field, done_at when done, the new assignee told.
    const changed = (await json<{ task: Task }>(await send(env, MONA, "PUT", `/api/team/tasks/${t.id}`, { status: "doing", priority: "urgent", title: "Fix the tray", assignee: "u3" }))).task;
    expect(changed.status).toBe("doing");
    expect(changed.events?.slice(1).map((e) => [e.by.id, e.change])).toEqual([
      ["u2", { field: "assignee", from: "u2", to: "u3" }],
      ["u2", { field: "priority", from: "high", to: "urgent" }],
      ["u2", { field: "status", from: "todo", to: "doing" }],
    ]);
    expect(await notifications(env, "u3")).toEqual([{ kind: "task", text: "Mona assigned you: Fix the tray", ref: JSON.stringify({ task: t.id }) }]);
    const commented = (await json<{ task: Task }>(await post(env, ADMIN, `/api/team/tasks/${t.id}/comment`, { text: "Looks better" }))).task;
    expect(commented.events?.at(-1)?.change).toEqual({ comment: "Looks better" });
    expect((await notifications(env, "u3")).map((n) => n.text)).toEqual(["Mona assigned you: Fix the tray", 'Firas on "Fix the tray": Looks better']);
    const done = (await json<{ task: Task }>(await send(env, SAMI, "PUT", `/api/team/tasks/${t.id}`, { status: "done" }))).task;
    expect(done.status).toBe("done");
    const row = await env.DB.prepare("SELECT done_at FROM team_tasks WHERE id = ?").bind(t.id).first<{ done_at: number }>();
    expect(row?.done_at).toBeGreaterThan(0);
    const reopened = (await json<{ task: Task }>(await send(env, SAMI, "PUT", `/api/team/tasks/${t.id}`, { status: "todo" }))).task;
    expect(reopened.status).toBe("todo");
    expect((await env.DB.prepare("SELECT done_at FROM team_tasks WHERE id = ?").bind(t.id).first<{ done_at: number | null }>())?.done_at).toBeNull();
    // Nothing changed: no event.
    const same = (await json<{ task: Task }>(await send(env, SAMI, "PUT", `/api/team/tasks/${t.id}`, { status: "todo" }))).task;
    expect(same.events?.length).toBe(reopened.events?.length);
    const one = await json<{ task: Task }>(await get(env, MONA, `/api/team/tasks/${t.id}`));
    expect(one.task.events?.length).toBe(same.events?.length);
    // Bad asks.
    expect((await post(env, ADMIN, "/api/team/tasks", { title: "" })).status).toBe(400);
    expect((await post(env, ADMIN, "/api/team/tasks", { title: "x", assignee: "nobody" })).status).toBe(400);
    expect((await post(env, ADMIN, "/api/team/tasks", { title: "x", client: "nope" })).status).toBe(404);
    expect((await post(env, SAMI, "/api/team/tasks", { title: "x", batch: "b1" })).status).toBe(404); // not Sami's month
    expect((await post(env, ADMIN, "/api/team/tasks", { title: "x", due: "tomorrow" })).status).toBe(400);
    expect((await get(env, ADMIN, "/api/team/tasks/nope")).status).toBe(404);
  });

  it("filters by mine, client, status, priority, due and month", async () => {
    const env = await seed();
    const mk = async (data: Record<string, unknown>) => (await json<{ task: Task }>(await post(env, ADMIN, "/api/team/tasks", data))).task;
    const a = await mk({ title: "A overdue", assignee: "u2", client: "c1", due: daysFromNow(-3), priority: "urgent" });
    const b = await mk({ title: "B this week", assignee: "u3", client: "c1", due: daysFromNow(3) });
    const c = await mk({ title: "C later", assignee: "u2", client: "c2", due: daysFromNow(20), priority: "low" });
    const d = await mk({ title: "D done late", assignee: "u2", client: "c1", due: daysFromNow(-1), status: "done" });
    const e = await mk({ title: "E on the month", batch: "b1", post: 2 });
    const list = async (q: string, user = MONA) => (await json<{ tasks: Task[] }>(await get(user === MONA ? env : env, user, `/api/team/tasks${q}`))).tasks.map((t) => t.id);
    expect(await list("?mine=1")).toEqual([a.id, c.id, d.id]); // open first, then by date
    expect(await list("?mine=1&status=done")).toEqual([d.id]);
    expect(await list("?client=c1")).toEqual([a.id, b.id, e.id, d.id]);
    expect(await list("?priority=urgent")).toEqual([a.id]);
    expect(await list("?due=overdue")).toEqual([a.id]);
    expect(await list("?due=week")).toEqual([b.id]);
    expect(await list("?due=all")).toEqual([a.id, b.id, c.id, e.id, d.id]); // dated first, undated, then done
    expect(await list("?batch=b1")).toEqual([e.id]);
    expect(await list("?mine=1", SAMI)).toEqual([b.id]);
    const boot = await json<TeamBootstrap>(await get(env, MONA, "/api/team/bootstrap"));
    expect(boot.tasksOpen).toBe(2);
  });

  it("makes a task from a message, titled by its first words, visible to the channel's people only", async () => {
    const env = await seed();
    const boot = await json<TeamBootstrap>(await get(env, MONA, "/api/team/bootstrap"));
    const general = boot.channels.find((c) => c.kind === "general")!;
    const long = `Please @[Sami](u3) ${"remake the tray picture with more syrup ".repeat(4).trim()}`;
    const m = (await json<{ message: Message }>(await post(env, MONA, "/api/team/messages", { channel: general.id, body: long }))).message;
    const t = (await json<{ task: Task }>(await post(env, SAMI, "/api/team/tasks", { sourceMessage: m.id, assignee: "u3" }))).task;
    expect(t.title).toBe(`Please @Sami ${"remake the tray picture with more syrup ".repeat(4)}`.slice(0, 80));
    expect(t.title.length).toBe(80);
    expect(t.description).toBe(long.replace(/@\[Sami\]\(u3\)/, "@Sami"));
    expect(t.sourceMessage).toBe(m.id);
    // A named title wins; a message from a dm I am not in is not mine to turn into a task.
    const named = (await json<{ task: Task }>(await post(env, SAMI, "/api/team/tasks", { sourceMessage: m.id, title: "Syrup" }))).task;
    expect(named.title).toBe("Syrup");
    const d = (await json<{ channel: Channel }>(await post(env, MONA, "/api/team/channels", { kind: "dm", members: ["u1"] }))).channel;
    const secret = (await json<{ message: Message }>(await post(env, MONA, "/api/team/messages", { channel: d.id, body: "private" }))).message;
    expect((await post(env, SAMI, "/api/team/tasks", { sourceMessage: secret.id })).status).toBe(404);
  });

  it("gives a newly assigned person the month as one task, found again while open, from the Studio's assignment", async () => {
    const env = await seed();
    const first = await monthAssignedTask(env, "b1", "u3", "u1");
    expect(first).toMatchObject({ title: "Month: Abu Saleh · October 2026", kind: "month", assignee: { id: "u3" }, client: "c1", batch: "b1", priority: "normal", status: "todo", createdBy: { id: "u1" } });
    const again = await monthAssignedTask(env, "b1", "u3", "u2");
    expect(again.id).toBe(first.id);
    expect((await notifications(env, "u3")).map((n) => n.text)).toEqual(["Firas assigned you: Month: Abu Saleh · October 2026"]);
    // Done, then assigned again: a fresh month task.
    await send(env, SAMI, "PUT", `/api/team/tasks/${first.id}`, { status: "done" });
    const fresh = await monthAssignedTask(env, "b1", "u3", "u1");
    expect(fresh.id).not.toBe(first.id);
    // The Studio's assignment makes the task for each newcomer (Sami keeps his open one; Firas gets his).
    const assign = await post(env, ADMIN, "/api/studio/members", { batch: "b1", users: ["u3", "u1"] });
    expect(assign.status).toBe(200);
    const sami = await json<{ tasks: Task[] }>(await get(env, SAMI, "/api/team/tasks?mine=1&batch=b1"));
    expect(sami.tasks.filter((t) => t.kind === "month" && t.status !== "done")).toHaveLength(1);
    expect(sami.tasks.filter((t) => t.kind === "month" && t.status !== "done")[0].id).toBe(fresh.id);
    const firas = await json<{ tasks: Task[] }>(await get(env, ADMIN, "/api/team/tasks?mine=1&batch=b1"));
    expect(firas.tasks.map((t) => [t.kind, t.title, t.status])).toEqual([["month", "Month: Abu Saleh · October 2026", "todo"]]);
    const monthTasks = () => env.DB.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE kind = 'month'").first<{ n: number }>().then((r) => r?.n);
    expect(await monthTasks()).toBe(3);
    // Assigning the same list again, or taking someone off, makes nothing new.
    await post(env, ADMIN, "/api/studio/members", { batch: "b1", users: ["u3", "u1"] });
    await post(env, ADMIN, "/api/studio/members", { batch: "b1", users: ["u3"] });
    expect(await monthTasks()).toBe(3);
    expect((await monthAssignedTask(env, "nope", "u3", "u1").catch((e) => e))).toBeInstanceOf(StudioError);
  });

  it("tells assignees about tasks due today or overdue, once a day", async () => {
    const env = await seed();
    await post(env, ADMIN, "/api/team/tasks", { title: "Today", assignee: "u2", due: today() });
    await post(env, ADMIN, "/api/team/tasks", { title: "Late", assignee: "u3", due: "2026-01-05" });
    await post(env, ADMIN, "/api/team/tasks", { title: "Later", assignee: "u3", due: daysFromNow(5) });
    await post(env, ADMIN, "/api/team/tasks", { title: "Finished late", assignee: "u3", due: "2026-01-05", status: "done" });
    await post(env, ADMIN, "/api/team/tasks", { title: "Nobody's", due: "2026-01-05" });
    expect(await dueSoonNotifications(env)).toBe(2);
    expect((await notifications(env, "u2")).filter((n) => n.kind === "due").map((n) => n.text)).toEqual(["Due today: Today"]);
    expect((await notifications(env, "u3")).filter((n) => n.kind === "due").map((n) => n.text)).toEqual(["Overdue since 2026-01-05: Late"]);
    expect(await dueSoonNotifications(env)).toBe(0);
    expect((await notifications(env, "u3")).filter((n) => n.kind === "due")).toHaveLength(1);
    // Another day runs again.
    expect(await dueSoonNotifications(env, daysFromNow(1))).toBe(2);
  });
});

describe("Team approvals", () => {
  it("records decisions newest first; approval marks the studio picture ready like Accept and tells the owner", async () => {
    const env = await seed();
    expect((await studioTask(env))?.status).toBe("review");
    const r = await post(env, ADMIN, "/api/team/reviews", { batch: "b1", post: 1, status: "approved", note: "Lovely", version: "u2/b1/output/t1/1.png" });
    expect(r.status).toBe(200);
    const review = (await json<{ review: Review }>(r)).review;
    expect(review).toMatchObject({ batch: "b1", post: 1, status: "approved", note: "Lovely", version: "u2/b1/output/t1/1.png", by: { id: "u1", name: "Firas" } });
    const t = await studioTask(env);
    expect(t?.status).toBe("ready");
    expect(JSON.parse(t!.qa)).toMatchObject({ flags: [], productConcern: false, automated: true, notes: "Accepted by Firas.", acceptedBy: "Firas" });
    expect(await notifications(env, "u2")).toEqual([{ kind: "approval", text: "Firas approved post 1 · Kunafa tray (Abu Saleh · October 2026): Lovely", ref: JSON.stringify({ batch: "b1", post: 1 }) }]);
    expect(await notifications(env, "u1")).toEqual([]);
    // A post without a picture can still be approved on paper; nothing to mark.
    expect((await post(env, MONA, "/api/team/reviews", { batch: "b1", post: 2, status: "approved" })).status).toBe(200);
    await post(env, MONA, "/api/team/reviews", { batch: "b1", post: 1, status: "review" });
    const list = await json<{ reviews: Review[] }>(await get(env, MONA, "/api/team/reviews?batch=b1"));
    expect(list.reviews.map((x) => [x.post, x.status])).toEqual([
      [1, "review"],
      [2, "approved"],
      [1, "approved"],
    ]);
    // The preview of the post carries the latest decision.
    const task = (await json<{ task: Task }>(await post(env, ADMIN, "/api/team/tasks", { title: "x", batch: "b1", post: 1 }))).task;
    expect(task.preview?.review).toBe("review");
    // Only people on the month review it; a month that is not one of posts cannot be asked for.
    expect((await post(env, SAMI, "/api/team/reviews", { batch: "b1", post: 1, status: "approved" })).status).toBe(404);
    expect((await get(env, SAMI, "/api/team/reviews?batch=b1")).status).toBe(404);
    expect((await post(env, ADMIN, "/api/team/reviews", { batch: "b1", post: 1, status: "nope" })).status).toBe(400);
  });

  it("asks for changes with one task for the month's owner, and tells the month's people", async () => {
    const env = await seed();
    await post(env, ADMIN, "/api/studio/members", { batch: "b1", users: ["u3"] });
    const r1 = await post(env, ADMIN, "/api/team/reviews", { batch: "b1", post: 1, status: "changes", note: "More syrup" });
    expect(r1.status).toBe(200);
    const tasks = async () => (await json<{ tasks: Task[] }>(await get(env, ADMIN, "/api/team/tasks?batch=b1&status=todo"))).tasks.filter((t) => t.kind === "task");
    let made = await tasks();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: "Changes on post 1 · Kunafa tray", description: "More syrup", assignee: { id: "u2" }, client: "c1", batch: "b1", post: 1, priority: "high", status: "todo", createdBy: { id: "u1" } });
    // Again: no second task while the first is open; the people hear each time.
    await post(env, ADMIN, "/api/team/reviews", { batch: "b1", post: 1, status: "changes", note: "Even more" });
    made = await tasks();
    expect(made).toHaveLength(1);
    const mona = await notifications(env, "u2");
    expect(mona.map((n) => [n.kind, n.text])).toEqual([
      ["review", "Firas asked for changes on post 1 · Kunafa tray (Abu Saleh · October 2026): More syrup"],
      ["review", "Firas asked for changes on post 1 · Kunafa tray (Abu Saleh · October 2026): Even more"],
    ]);
    expect((await notifications(env, "u3")).filter((n) => n.kind === "review")).toHaveLength(2);
    expect((await notifications(env, "u1")).filter((n) => n.kind === "review")).toHaveLength(0);
    // Post 12 is not post 1; once the task is done, the next request makes a new one.
    await send(env, MONA, "PUT", `/api/team/tasks/${made[0].id}`, { status: "done" });
    await post(env, ADMIN, "/api/team/reviews", { batch: "b1", post: 1, status: "changes" });
    expect(await tasks()).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE title LIKE 'Changes on post 1%'").first<{ n: number }>())?.n).toBe(2);
    expect((await studioTask(env))?.status).toBe("review"); // changes never touch the studio picture
    // Sending for review tells the month's people too.
    await post(env, SAMI, "/api/team/reviews", { batch: "b1", post: 2, status: "review" });
    expect((await notifications(env, "u2")).at(-1)?.text).toBe("Sami sent post 2 · Morning coffee (Abu Saleh · October 2026) for review");
  });
});
