/**
 * Team (28 Oct): the data layer under server/team.ts. Rows of the team_* tables become the shapes of
 * shared/team.ts here (users resolved, attachments and reactions gathered, previews of the studio
 * posts a message or task is about), and the pieces the Studio calls on its own live here too: the
 * month task made when a month is assigned (server/studio.ts POST /members), the daily due-date
 * notifications (the cron) and the deterministic /ai answers. Nothing here reaches outside the
 * studio's database and bucket; no model is ever called.
 */
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { getSetting, setSetting } from "./settings";
import { monthLabel } from "@shared/posts";
import type { Config } from "@shared/config";
import type { User } from "@shared/types";
import type {
  Attachment,
  AttachmentKind,
  Channel,
  ChannelKind,
  Message,
  MessageKind,
  MessageRef,
  Notification,
  NotificationKind,
  Reaction,
  RefPreview,
  Review,
  ReviewStatus,
  Task,
  TaskEvent,
  TaskPriority,
  TaskStatus,
  TeamUser,
} from "@shared/team";

/* ---------- rows ---------- */

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  client: string | null;
  created_by: string;
  created: number;
  archived: number | null;
}

export interface MessageRow {
  id: string;
  channel: string;
  thread: string | null;
  author: string;
  kind: MessageKind;
  body: string;
  ref: string | null;
  attachments: string | null;
  mentions: string | null;
  at: number;
  edited: number | null;
  deleted: number | null;
  updated: number;
}

export interface AttachmentRow {
  id: string;
  owner: string;
  message: string | null;
  name: string;
  mime: string;
  size: number;
  key: string;
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
  duration: number | null;
  sha256: string | null;
  created: number;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  client: string | null;
  batch: string | null;
  post: number | null;
  due: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  source_message: string | null;
  kind: "task" | "month";
  created_by: string;
  created: number;
  updated: number;
  done_at: number | null;
}

interface BatchLite {
  id: string;
  name: string;
  owner: string;
  client: string | null;
  month: string | null;
  config: string;
}

/* ---------- small pure helpers ---------- */

/** The name a channel shows this person: a dm is named after the other member. */
export function channelName(kind: ChannelKind, name: string, members: TeamUser[], me: string): string {
  if (kind !== "dm") return name;
  const other = members.find((m) => m.id !== me) ?? members[0];
  return other ? other.name : name;
}

/** A LIKE pattern that matches `q` literally anywhere (used with ESCAPE '\'). */
export function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The next sync cursor: the newest stamp seen, never the clock (a skewed clock would skip rows). */
export function nextCursor(cursor: number, stamps: number[]): number {
  return stamps.reduce((m, s) => (s > m ? s : m), cursor);
}

/** Unread and "mentioned" over a channel's messages by others after what I last read. */
export function unreadMath(rows: { author: string; at: number; mentions: string[] | null; deleted?: boolean }[], me: string, lastRead: number): { unread: number; mentioned: boolean } {
  let unread = 0;
  let mentioned = false;
  for (const r of rows) {
    if (r.author === me || r.deleted || r.at <= lastRead) continue;
    unread++;
    if (r.mentions?.includes(me)) mentioned = true;
  }
  return { unread, mentioned };
}

/** "Abu Saleh · October 2026" from a client's name and a batch's month (or its name without one). */
export function monthTitle(clientName: string | null | undefined, month: string | null | undefined, fallback = ""): string {
  const when = month ? monthLabel(month) : "";
  if (clientName && when) return `${clientName} · ${when}`;
  return clientName || when || fallback;
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

/** `d` plus n days as YYYY-MM-DD. */
export function plusDays(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/* ---------- users ---------- */

export const toTeamUser = (u: { id: string; name: string; email: string; role: string }): TeamUser => ({ id: u.id, name: u.name, email: u.email, role: u.role === "admin" ? "admin" : "member" });

/** Every person who can use Team (not disabled), by name. */
export async function activeUsers(env: Env): Promise<TeamUser[]> {
  const rows = await all<{ id: string; name: string; email: string; role: string }>(env.DB, "SELECT id, name, email, role FROM users WHERE disabled = 0 ORDER BY name");
  return rows.map(toTeamUser);
}

/** The users with these ids (disabled ones included, so an old message keeps its author), by id. */
export async function usersById(env: Env, ids: Iterable<string>): Promise<Map<string, TeamUser>> {
  const list = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, TeamUser>();
  if (!list.length) return out;
  const rows = await all<{ id: string; name: string; email: string; role: string }>(env.DB, `SELECT id, name, email, role FROM users WHERE id IN (${placeholders(list.length)})`, ...list);
  for (const r of rows) out.set(r.id, toTeamUser(r));
  return out;
}

const unknownUser = (id: string): TeamUser => ({ id, name: "Someone", email: "", role: "member" });

/** Only the ids of people who exist and are not disabled. */
export async function activeIds(env: Env, ids: string[]): Promise<string[]> {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return [];
  const rows = await all<{ id: string }>(env.DB, `SELECT id FROM users WHERE disabled = 0 AND id IN (${placeholders(list.length)})`, ...list);
  const ok = new Set(rows.map((r) => r.id));
  return list.filter((id) => ok.has(id));
}

/* ---------- channels ---------- */

/** "general" and one channel per active client exist by themselves; a client's channel follows its name and status. */
export async function ensureChannels(env: Env, by: string): Promise<void> {
  const t = now();
  const general = await first<{ id: string }>(env.DB, "SELECT id FROM team_channels WHERE kind = 'general' LIMIT 1");
  if (!general) await run(env.DB, "INSERT INTO team_channels (id, kind, name, client, created_by, created, archived) VALUES (?, 'general', 'general', NULL, ?, ?, NULL)", uuid(), by, t);
  const clients = await all<{ id: string; name: string; status: string }>(env.DB, "SELECT id, name, status FROM clients ORDER BY position, name");
  const existing = await all<{ id: string; client: string; name: string; archived: number | null }>(env.DB, "SELECT id, client, name, archived FROM team_channels WHERE kind = 'client' AND client IS NOT NULL");
  const byClient = new Map(existing.map((c) => [c.client, c]));
  for (const cl of clients) {
    const have = byClient.get(cl.id);
    const archived = cl.status === "active" ? null : 1;
    if (!have) {
      if (cl.status !== "active") continue;
      await run(env.DB, "INSERT INTO team_channels (id, kind, name, client, created_by, created, archived) VALUES (?, 'client', ?, ?, ?, ?, NULL)", uuid(), cl.name, cl.id, by, t);
    } else if (have.name !== cl.name || (have.archived ?? null) !== archived) {
      await run(env.DB, "UPDATE team_channels SET name = ?, archived = ? WHERE id = ?", cl.name, archived, have.id);
    }
  }
}

/** The client's channel, made when missing (the client must exist). */
export async function clientChannel(env: Env, clientId: string, by: string): Promise<ChannelRow> {
  const have = await first<ChannelRow>(env.DB, "SELECT * FROM team_channels WHERE kind = 'client' AND client = ? LIMIT 1", clientId);
  if (have) return have;
  const cl = await first<{ id: string; name: string }>(env.DB, "SELECT id, name FROM clients WHERE id = ?", clientId);
  if (!cl) throw new StudioError("Client not found.", 404);
  const id = uuid();
  await run(env.DB, "INSERT INTO team_channels (id, kind, name, client, created_by, created, archived) VALUES (?, 'client', ?, ?, ?, ?, NULL)", id, cl.name, cl.id, by, now());
  return (await first<ChannelRow>(env.DB, "SELECT * FROM team_channels WHERE id = ?", id))!;
}

export const isEveryones = (kind: ChannelKind) => kind === "general" || kind === "client";

/** The ids of every channel this person is in. */
export async function myChannelIds(env: Env, user: User): Promise<string[]> {
  const rows = await all<{ id: string }>(env.DB, "SELECT id FROM team_channels WHERE kind IN ('general', 'client') OR id IN (SELECT channel FROM team_channel_members WHERE user = ?)", user.id);
  return rows.map((r) => r.id);
}

/** The channel when this person is in it; 404 otherwise (a stranger learns nothing). */
export async function channelFor(env: Env, user: User, id: string | undefined): Promise<ChannelRow> {
  if (!id) throw new StudioError("Channel is required.");
  const ch = await first<ChannelRow>(env.DB, "SELECT * FROM team_channels WHERE id = ?", id);
  if (!ch) throw new StudioError("Channel not found.", 404);
  if (isEveryones(ch.kind)) return ch;
  const m = await first<{ user: string }>(env.DB, "SELECT user FROM team_channel_members WHERE channel = ? AND user = ?", ch.id, user.id);
  if (!m) throw new StudioError("Channel not found.", 404);
  return ch;
}

export async function membersOf(env: Env, channelIds: string[]): Promise<Map<string, TeamUser[]>> {
  const out = new Map<string, TeamUser[]>();
  if (!channelIds.length) return out;
  const rows = await all<{ channel: string; id: string; name: string; email: string; role: string }>(
    env.DB,
    `SELECT m.channel, u.id, u.name, u.email, u.role FROM team_channel_members m JOIN users u ON u.id = m.user WHERE m.channel IN (${placeholders(channelIds.length)}) ORDER BY m.joined, u.name`,
    ...channelIds,
  );
  for (const r of rows) {
    const list = out.get(r.channel) ?? [];
    list.push(toTeamUser(r));
    out.set(r.channel, list);
  }
  return out;
}

export interface ChannelStats {
  unread: number;
  mentioned: boolean;
  lastAt: number | null;
}

/** Unread (messages by others after what I last read), whether one mentions me, and the newest message, per channel. */
export async function channelStats(env: Env, user: User, channelIds: string[]): Promise<Map<string, ChannelStats>> {
  const out = new Map<string, ChannelStats>();
  if (!channelIds.length) return out;
  for (const id of channelIds) out.set(id, { unread: 0, mentioned: false, lastAt: null });
  const ph = placeholders(channelIds.length);
  const last = await all<{ channel: string; lastAt: number }>(env.DB, `SELECT channel, MAX(at) AS lastAt FROM team_messages WHERE channel IN (${ph}) GROUP BY channel`, ...channelIds);
  for (const r of last) out.get(r.channel)!.lastAt = r.lastAt;
  const unread = await all<{ channel: string; unread: number; mentioned: number }>(
    env.DB,
    `SELECT m.channel, COUNT(*) AS unread, SUM(CASE WHEN m.mentions LIKE ? THEN 1 ELSE 0 END) AS mentioned
     FROM team_messages m LEFT JOIN team_reads r ON r.channel = m.channel AND r.user = ?
     WHERE m.channel IN (${ph}) AND m.author <> ? AND m.deleted IS NULL AND m.at > COALESCE(r.last_read, 0)
     GROUP BY m.channel`,
    `%"${user.id}"%`,
    user.id,
    ...channelIds,
    user.id,
  );
  for (const r of unread) {
    const s = out.get(r.channel)!;
    s.unread = Number(r.unread);
    s.mentioned = Number(r.mentioned) > 0;
  }
  return out;
}

/** Channel rows as the page's Channel, from this person's point of view. */
export async function hydrateChannels(env: Env, user: User, rows: ChannelRow[]): Promise<Channel[]> {
  if (!rows.length) return [];
  const withMembers = rows.filter((r) => !isEveryones(r.kind)).map((r) => r.id);
  const [members, stats] = await Promise.all([membersOf(env, withMembers), channelStats(env, user, rows.map((r) => r.id))]);
  return rows.map((r) => {
    const m = isEveryones(r.kind) ? undefined : (members.get(r.id) ?? []);
    const s = stats.get(r.id) ?? { unread: 0, mentioned: false, lastAt: null };
    return {
      id: r.id,
      kind: r.kind,
      name: channelName(r.kind, r.name, m ?? [], user.id),
      client: r.client,
      ...(m ? { members: m } : {}),
      unread: s.unread,
      mentioned: s.mentioned,
      lastAt: s.lastAt,
      archived: !!r.archived,
    };
  });
}

export async function hydrateChannel(env: Env, user: User, id: string): Promise<Channel> {
  const row = await first<ChannelRow>(env.DB, "SELECT * FROM team_channels WHERE id = ?", id);
  if (!row) throw new StudioError("Channel not found.", 404);
  return (await hydrateChannels(env, user, [row]))[0];
}

/* ---------- previews of studio posts ---------- */

interface BatchPreviewContext {
  batch: BatchLite;
  clientName: string | null;
  plan: { index: number; title: string }[];
  tasks: Map<number, { id: string; status: string; output: string | null }>;
  reviews: Map<number, ReviewStatus>;
}

async function batchContext(env: Env, batchId: string): Promise<BatchPreviewContext | null> {
  const b = await first<BatchLite>(env.DB, "SELECT id, name, owner, client, month, config FROM batches WHERE id = ? AND deleted IS NULL", batchId);
  if (!b) return null;
  const config = parseJson<Config>(b.config, {} as Config);
  const client = b.client ? await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", b.client) : null;
  // The latest picture of each post (one with an output first), as the Studio shows it.
  const taskRows = await all<{ id: string; post: number; status: string; output: string | null }>(env.DB, "SELECT id, post, status, output FROM tasks WHERE batch = ? AND post IS NOT NULL ORDER BY (output IS NOT NULL) DESC, updated DESC", b.id);
  const tasks = new Map<number, { id: string; status: string; output: string | null }>();
  for (const t of taskRows) if (!tasks.has(t.post)) tasks.set(t.post, t);
  const reviewRows = await all<{ post: number; status: ReviewStatus }>(env.DB, "SELECT post, status FROM team_reviews WHERE batch = ? ORDER BY at DESC", b.id);
  const reviews = new Map<number, ReviewStatus>();
  for (const r of reviewRows) if (!reviews.has(r.post)) reviews.set(r.post, r.status);
  return { batch: b, clientName: client?.name ?? null, plan: (config.plan ?? []).map((p) => ({ index: p.index, title: p.title })), tasks, reviews };
}

/** Resolves previews for many refs with one read per month. */
export class PreviewCache {
  private cache = new Map<string, Promise<BatchPreviewContext | null>>();
  constructor(private env: Env) {}
  context(batchId: string): Promise<BatchPreviewContext | null> {
    let p = this.cache.get(batchId);
    if (!p) {
      p = batchContext(this.env, batchId);
      this.cache.set(batchId, p);
    }
    return p;
  }
  /** The card a message or task shows for what it is about; null when the month is gone. */
  async preview(ref: MessageRef): Promise<RefPreview | null> {
    if (ref.task) {
      const t = await first<TaskRow>(this.env.DB, "SELECT * FROM team_tasks WHERE id = ?", ref.task);
      if (!t) return null;
      const where = t.batch ? await this.where(t.batch) : "";
      return { title: t.title, where: where || "Task", status: t.status };
    }
    if (!ref.batch) return null;
    const ctx = await this.context(ref.batch);
    if (!ctx) return null;
    const where = monthTitle(ctx.clientName, ctx.batch.month, ctx.batch.name);
    if (!ref.post) return { title: ctx.batch.name, where };
    const post = ctx.plan.find((p) => p.index === ref.post);
    const task = ctx.tasks.get(ref.post);
    return {
      title: post?.title || `Post ${ref.post}`,
      where,
      ...(task ? { status: task.status } : {}),
      thumb: task?.output ? `/api/studio/file?batch=${encodeURIComponent(ctx.batch.id)}&id=${encodeURIComponent(task.id)}&kind=result&w=480` : null,
      review: ctx.reviews.get(ref.post) ?? null,
    };
  }
  async where(batchId: string): Promise<string> {
    const ctx = await this.context(batchId);
    return ctx ? monthTitle(ctx.clientName, ctx.batch.month, ctx.batch.name) : "";
  }
  async postTitle(batchId: string, post: number): Promise<string> {
    const ctx = await this.context(batchId);
    return ctx?.plan.find((p) => p.index === post)?.title ?? "";
  }
}

/* ---------- attachments ---------- */

export const attachmentUrl = (id: string) => `/api/team/file/${id}`;

export function toAttachment(r: AttachmentRow): Attachment {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    width: r.width,
    height: r.height,
    duration: r.duration,
    url: attachmentUrl(r.id),
  };
}

/* ---------- messages ---------- */

/** Message rows as the page's Message: authors, attachments, reactions, pins, reply counts and previews gathered in a few queries. */
export async function hydrateMessages(env: Env, rows: MessageRow[], previews = new PreviewCache(env)): Promise<Message[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);
  const attachmentIds = rows.flatMap((r) => parseJson<string[]>(r.attachments, []));
  const [users, attachments, reactions, pins, replies] = await Promise.all([
    usersById(env, rows.map((r) => r.author)),
    attachmentIds.length ? all<AttachmentRow>(env.DB, `SELECT * FROM team_attachments WHERE id IN (${placeholders(attachmentIds.length)})`, ...attachmentIds) : Promise.resolve([] as AttachmentRow[]),
    all<{ message: string; user: string; emoji: string; at: number }>(env.DB, `SELECT message, user, emoji, at FROM team_reactions WHERE message IN (${ph}) ORDER BY at`, ...ids),
    all<{ message: string }>(env.DB, `SELECT message FROM team_pins WHERE message IN (${ph})`, ...ids),
    all<{ thread: string; n: number; last: number }>(env.DB, `SELECT thread, COUNT(*) AS n, MAX(at) AS last FROM team_messages WHERE thread IN (${ph}) AND deleted IS NULL GROUP BY thread`, ...ids),
  ]);
  const attachmentById = new Map(attachments.map((a) => [a.id, a]));
  const reactionsByMessage = new Map<string, Reaction[]>();
  for (const r of reactions) {
    const list = reactionsByMessage.get(r.message) ?? [];
    const found = list.find((x) => x.emoji === r.emoji);
    if (found) found.users.push(r.user);
    else list.push({ emoji: r.emoji, users: [r.user] });
    reactionsByMessage.set(r.message, list);
  }
  const pinned = new Set(pins.map((p) => p.message));
  const replyStats = new Map(replies.map((r) => [r.thread, r]));
  const out: Message[] = [];
  for (const r of rows) {
    const ref = parseJson<MessageRef | null>(r.ref, null);
    const preview = ref && !r.deleted ? await previews.preview(ref) : null;
    const rs = replyStats.get(r.id);
    out.push({
      id: r.id,
      channel: r.channel,
      thread: r.thread,
      author: users.get(r.author) ?? unknownUser(r.author),
      kind: r.kind,
      body: r.deleted ? "" : r.body,
      attachments: r.deleted ? [] : parseJson<string[]>(r.attachments, []).map((id) => attachmentById.get(id)).filter((a): a is AttachmentRow => !!a).map(toAttachment),
      ref: ref ? { ...ref, ...(preview ? { preview } : {}) } : null,
      mentions: r.deleted ? [] : parseJson<string[]>(r.mentions, []),
      reactions: reactionsByMessage.get(r.id) ?? [],
      replies: rs ? Number(rs.n) : 0,
      lastReplyAt: rs ? Number(rs.last) : null,
      pinned: pinned.has(r.id),
      at: r.at,
      edited: r.edited,
      ...(r.deleted ? { deleted: true } : {}),
    });
  }
  return out;
}

export async function messageRow(env: Env, id: string): Promise<MessageRow> {
  const m = await first<MessageRow>(env.DB, "SELECT * FROM team_messages WHERE id = ?", id);
  if (!m) throw new StudioError("Message not found.", 404);
  return m;
}

export async function hydrateMessage(env: Env, id: string): Promise<Message> {
  return (await hydrateMessages(env, [await messageRow(env, id)]))[0];
}

/** Stamps a message as changed, so /sync carries it again. */
export async function touchMessage(env: Env, id: string): Promise<void> {
  await run(env.DB, "UPDATE team_messages SET updated = ? WHERE id = ?", now(), id);
}

/* ---------- notifications ---------- */

export async function notify(env: Env, users: Iterable<string>, kind: NotificationKind, text: string, ref: Notification["ref"]): Promise<void> {
  const t = now();
  for (const u of new Set(users)) {
    if (!u) continue;
    await run(env.DB, "INSERT INTO team_notifications (id, user, kind, text, ref, at, seen) VALUES (?, ?, ?, ?, ?, ?, NULL)", uuid(), u, kind, text.slice(0, 300), ref ? JSON.stringify(ref) : null, t);
  }
}

export function toNotification(r: { id: string; kind: NotificationKind; text: string; ref: string | null; at: number; seen: number | null }): Notification {
  return { id: r.id, kind: r.kind, text: r.text, ref: parseJson<Notification["ref"]>(r.ref, null), at: r.at, seen: !!r.seen };
}

/** The owner and the assigned members of a month (who works on it). */
export async function monthAssignees(env: Env, batchId: string): Promise<string[]> {
  const b = await first<{ owner: string }>(env.DB, "SELECT owner FROM batches WHERE id = ?", batchId);
  const members = await all<{ user: string }>(env.DB, "SELECT user FROM batch_members WHERE batch = ?", batchId);
  return [...new Set([...(b ? [b.owner] : []), ...members.map((m) => m.user)])];
}

/* ---------- tasks ---------- */

export async function taskRow(env: Env, id: string): Promise<TaskRow> {
  const t = await first<TaskRow>(env.DB, "SELECT * FROM team_tasks WHERE id = ?", id);
  if (!t) throw new StudioError("Task not found.", 404);
  return t;
}

export async function taskEvent(env: Env, task: string, by: string, change: TaskEvent["change"]): Promise<void> {
  await run(env.DB, "INSERT INTO team_task_events (id, task, by, at, change) VALUES (?, ?, ?, ?, ?)", uuid(), task, by, now(), JSON.stringify(change));
}

/** Task rows as the page's Task; events only when asked (one task). */
export async function hydrateTasks(env: Env, rows: TaskRow[], opts: { events?: boolean } = {}): Promise<Task[]> {
  if (!rows.length) return [];
  const previews = new PreviewCache(env);
  const userIds = rows.flatMap((r) => [r.created_by, ...(r.assignee ? [r.assignee] : [])]);
  const events = opts.events && rows.length === 1 ? await all<{ id: string; by: string; at: number; change: string }>(env.DB, "SELECT id, by, at, change FROM team_task_events WHERE task = ? ORDER BY at, rowid", rows[0].id) : [];
  const users = await usersById(env, [...userIds, ...events.map((e) => e.by)]);
  const clientIds = [...new Set(rows.map((r) => r.client).filter((x): x is string => !!x))];
  const clients = new Map<string, string>();
  if (clientIds.length) for (const c of await all<{ id: string; name: string }>(env.DB, `SELECT id, name FROM clients WHERE id IN (${placeholders(clientIds.length)})`, ...clientIds)) clients.set(c.id, c.name);
  const out: Task[] = [];
  for (const r of rows) {
    const batchName = r.batch ? (await previews.where(r.batch)) || null : null;
    const preview = r.batch && r.post ? await previews.preview({ batch: r.batch, post: r.post }) : null;
    out.push({
      id: r.id,
      title: r.title,
      description: r.description,
      assignee: r.assignee ? (users.get(r.assignee) ?? unknownUser(r.assignee)) : null,
      client: r.client,
      clientName: r.client ? (clients.get(r.client) ?? null) : null,
      batch: r.batch,
      batchName,
      post: r.post,
      due: r.due,
      priority: r.priority,
      status: r.status,
      kind: r.kind === "month" ? "month" : "task",
      sourceMessage: r.source_message,
      createdBy: users.get(r.created_by) ?? unknownUser(r.created_by),
      created: r.created,
      updated: r.updated,
      ...(opts.events ? { events: events.map((e) => ({ id: e.id, by: users.get(e.by) ?? unknownUser(e.by), at: e.at, change: parseJson<TaskEvent["change"]>(e.change, { comment: "" }) })) } : {}),
      preview,
    });
  }
  return out;
}

export async function hydrateTask(env: Env, id: string, events = false): Promise<Task> {
  return (await hydrateTasks(env, [await taskRow(env, id)], { events }))[0];
}

export interface NewTask {
  title: string;
  description?: string;
  assignee?: string | null;
  client?: string | null;
  batch?: string | null;
  post?: number | null;
  due?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  sourceMessage?: string | null;
  kind?: "task" | "month";
}

/** Inserts a task with its first event and tells the assignee (unless `quiet`: the caller sends its own word). */
export async function createTask(env: Env, by: TeamUser, t: NewTask, opts: { quiet?: boolean } = {}): Promise<TaskRow> {
  const id = uuid();
  const at = now();
  const status = t.status ?? "todo";
  await run(
    env.DB,
    "INSERT INTO team_tasks (id, title, description, assignee, client, batch, post, due, priority, status, source_message, kind, created_by, created, updated, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    t.title,
    t.description ?? "",
    t.assignee ?? null,
    t.client ?? null,
    t.batch ?? null,
    t.post ?? null,
    t.due ?? null,
    t.priority ?? "normal",
    status,
    t.sourceMessage ?? null,
    t.kind ?? "task",
    by.id,
    at,
    at,
    status === "done" ? at : null,
  );
  await taskEvent(env, id, by.id, { field: "created", from: null, to: t.title });
  if (!opts.quiet && t.assignee && t.assignee !== by.id) await notify(env, [t.assignee], "task", `${by.name} assigned you: ${t.title}`, { task: id });
  return taskRow(env, id);
}

/**
 * The parent task of a month assigned to a person (server/studio.ts POST /members): "Month: Abu
 * Saleh · October 2026", once per month and person while it is open.
 */
export async function monthAssignedTask(env: Env, batchId: string, userId: string, byUserId: string): Promise<Task> {
  const open = await first<TaskRow>(env.DB, "SELECT * FROM team_tasks WHERE kind = 'month' AND batch = ? AND assignee = ? AND status <> 'done' ORDER BY created DESC LIMIT 1", batchId, userId);
  if (open) return (await hydrateTasks(env, [open]))[0];
  const b = await first<BatchLite>(env.DB, "SELECT id, name, owner, client, month, config FROM batches WHERE id = ?", batchId);
  if (!b) throw new StudioError("Month not found.", 404);
  const client = b.client ? await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", b.client) : null;
  const byUser = (await usersById(env, [byUserId])).get(byUserId) ?? unknownUser(byUserId);
  const row = await createTask(env, byUser, { title: `Month: ${monthTitle(client?.name, b.month, b.name)}`, assignee: userId, client: b.client, batch: b.id, priority: "normal", status: "todo", kind: "month" });
  return (await hydrateTasks(env, [row]))[0];
}

/** Tells assignees about tasks due today or overdue, once a day (the cron). Returns how many were told. */
export async function dueSoonNotifications(env: Env, day = today()): Promise<number> {
  const key = `team_due_notified:${day}`;
  if (await getSetting(env, key)) return 0;
  const rows = await all<{ id: string; title: string; assignee: string; due: string }>(env.DB, "SELECT id, title, assignee, due FROM team_tasks WHERE status <> 'done' AND assignee IS NOT NULL AND due IS NOT NULL AND due <= ? ORDER BY due", day);
  for (const r of rows) {
    const text = r.due === day ? `Due today: ${r.title}` : `Overdue since ${r.due}: ${r.title}`;
    await notify(env, [r.assignee], "due", text, { task: r.id });
  }
  await setSetting(env, key, String(rows.length));
  return rows.length;
}

/* ---------- reviews ---------- */

export function toReview(r: { id: string; batch: string; post: number; version: string | null; status: ReviewStatus; by: string; note: string; at: number }, users: Map<string, TeamUser>): Review {
  return { id: r.id, batch: r.batch, post: r.post, version: r.version, status: r.status, by: users.get(r.by) ?? unknownUser(r.by), note: r.note, at: r.at };
}

/* ---------- the deterministic assistant ---------- */

export type AiIntent = "tasks" | "unfinished" | "overdue" | "approval" | null;

export interface AiQuestion {
  intent: AiIntent;
  client: { id: string; name: string } | null;
  /** YYYY-MM */
  month: string | null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** What the question asks for: an intent, a client (by name, any script) and a month, read by plain rules. */
export function parseAiQuestion(q: string, clients: { id: string; name: string }[], year = new Date().getFullYear()): AiQuestion {
  const text = q.toLowerCase();
  let client: AiQuestion["client"] = null;
  for (const c of [...clients].sort((a, b) => b.name.length - a.name.length)) {
    if (c.name && text.includes(c.name.toLowerCase())) {
      client = { id: c.id, name: c.name };
      break;
    }
  }
  let month: string | null = null;
  const iso = /\b(20\d{2})-(0[1-9]|1[0-2])\b/.exec(text);
  if (iso) month = `${iso[1]}-${iso[2]}`;
  else {
    const idx = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(text));
    if (idx >= 0) {
      const y = /\b(20\d{2})\b/.exec(text);
      month = `${y ? y[1] : year}-${String(idx + 1).padStart(2, "0")}`;
    }
  }
  let intent: AiIntent = null;
  if (/\boverdue\b|\blate\b|past due/.test(text)) intent = "overdue";
  else if (/needs? approval|waiting for approval|\bapprov(e|al|als|ed)\b|for review|in review/.test(text)) intent = "approval";
  else if (/unfinished|not (yet )?made|remaining|not done|left to (make|do)|posts? (without|missing)|incomplete|pending posts/.test(text)) intent = "unfinished";
  else if (/pending tasks|open tasks|\btasks?\b|to ?do/.test(text)) intent = "tasks";
  return { intent, client, month };
}

export const AI_FALLBACK = "I can list tasks, unfinished posts, overdue work and creatives waiting for approval.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Answers from the database alone; never writes, never calls a model. */
export async function answerAi(env: Env, q: string): Promise<{ answer: string; items?: unknown[] }> {
  const clients = await all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM clients");
  const ask = parseAiQuestion(q, clients);
  const forWhom = ask.client ? ` for ${ask.client.name}` : "";
  if (ask.intent === "tasks" || ask.intent === "overdue") {
    const overdue = ask.intent === "overdue";
    const rows = await all<TaskRow>(
      env.DB,
      `SELECT * FROM team_tasks WHERE status <> 'done'${ask.client ? " AND client = ?" : ""}${overdue ? " AND due IS NOT NULL AND due < ?" : ""} ORDER BY due IS NULL, due, created DESC LIMIT 100`,
      ...(ask.client ? [ask.client.id] : []),
      ...(overdue ? [today()] : []),
    );
    const tasks = await hydrateTasks(env, rows);
    if (!tasks.length) return { answer: overdue ? `Nothing is overdue${forWhom}.` : `No open tasks${forWhom}.`, items: [] };
    const byPriority = ["urgent", "high", "normal", "low"].map((p) => [p, tasks.filter((t) => t.priority === p).length] as const).filter(([, n]) => n > 0).map(([p, n]) => `${n} ${p}`);
    const lead = overdue ? `${plural(tasks.length, "task is", "tasks are")} overdue${forWhom}` : `${plural(tasks.length, "open task")}${forWhom}`;
    const first3 = tasks.slice(0, 3).map((t) => `${t.title}${t.assignee ? ` (${t.assignee.name})` : ""}`).join("; ");
    return { answer: `${lead}: ${byPriority.join(", ")}. ${first3}${tasks.length > 3 ? "; …" : ""}.`, items: tasks };
  }
  if (ask.intent === "unfinished" || ask.intent === "approval") {
    const batches = await all<BatchLite>(
      env.DB,
      `SELECT id, name, owner, client, month, config FROM batches WHERE deleted IS NULL AND month IS NOT NULL${ask.client ? " AND client = ?" : ""}${ask.month ? " AND month = ?" : ""} ORDER BY month DESC, created DESC LIMIT 24`,
      ...(ask.client ? [ask.client.id] : []),
      ...(ask.month ? [ask.month] : []),
    );
    const previews = new PreviewCache(env);
    const items: { batch: string; post: number; title: string; where: string; status?: string; review?: ReviewStatus | null }[] = [];
    let planned = 0;
    for (const b of batches) {
      const ctx = await previews.context(b.id);
      if (!ctx) continue;
      const where = monthTitle(ctx.clientName, b.month, b.name);
      for (const p of ctx.plan) {
        planned++;
        const t = ctx.tasks.get(p.index);
        const review = ctx.reviews.get(p.index) ?? null;
        if (ask.intent === "unfinished") {
          const made = !!t?.output && ["ready", "review", "approved"].includes(t.status);
          if (!made) items.push({ batch: b.id, post: p.index, title: p.title, where, status: t?.status });
        } else if (review === "review") items.push({ batch: b.id, post: p.index, title: p.title, where, status: t?.status, review });
      }
    }
    const scope = `${forWhom}${ask.month ? ` in ${monthLabel(ask.month)}` : ""}`;
    if (!batches.length) return { answer: `No month of posts found${scope}.`, items: [] };
    if (ask.intent === "unfinished") {
      if (!items.length) return { answer: `Every planned post${scope} has a picture (${planned} planned).`, items: [] };
      return { answer: `${items.length} of ${planned} planned posts${scope} are not made yet: ${items.slice(0, 5).map((i) => `post ${i.post} ${i.title}`.trim()).join("; ")}${items.length > 5 ? "; …" : ""}.`, items };
    }
    if (!items.length) return { answer: `No creative is waiting for approval${scope}.`, items: [] };
    return { answer: `${plural(items.length, "creative is", "creatives are")} waiting for approval${scope}: ${items.slice(0, 5).map((i) => `post ${i.post} ${i.title}`.trim()).join("; ")}${items.length > 5 ? "; …" : ""}.`, items };
  }
  return { answer: AI_FALLBACK };
}
