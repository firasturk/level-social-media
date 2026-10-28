/**
 * Team (28 Oct): the studio's own workspace for LEVEL employees, mounted at /api/team behind the
 * studio's session (server/index.ts): every route needs a signed-in employee, never a client link.
 * Channels (general, one per client, projects, direct and group conversations), messages with
 * threads, reactions, pins, attachments in the studio's bucket, tasks, internal approvals of the
 * creatives and in-app notifications. The routes are listed in shared/team.ts; the data layer is
 * server/team-db.ts. No outside service: the same database, bucket and session, and no model call
 * (the /ai route answers by rules).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { acceptPost, ownedPlan, type BatchRow } from "./posts";
import { sniffImage } from "./media-intake";
import { imageSize } from "./image-size";
import { resizedPicture, thumbWidth } from "./thumbs";
import type { User } from "@shared/types";
import {
  mentionsIn,
  plainBody,
  TEAM_FILE_MAX,
  TEAM_FILE_TYPES,
  TEAM_IMAGE_MAX,
  TEAM_MESSAGE_MAX,
  TEAM_VOICE_MAX,
  TEAM_VOICE_SECONDS_MAX,
  type AttachmentKind,
  type Message,
  type NotificationKind,
  type ReviewStatus,
  type TeamBootstrap,
  type TeamSync,
} from "@shared/team";
import {
  activeIds,
  activeUsers,
  answerAi,
  channelFor,
  channelName,
  channelStats,
  clientChannel,
  createTask,
  ensureChannels,
  hydrateChannel,
  hydrateChannels,
  hydrateMessage,
  hydrateMessages,
  hydrateTask,
  hydrateTasks,
  isEveryones,
  likeContains,
  membersOf,
  messageRow,
  monthAssignees,
  myChannelIds,
  nextCursor,
  notify,
  plusDays,
  PreviewCache,
  taskEvent,
  taskRow,
  toAttachment,
  toNotification,
  toReview,
  toTeamUser,
  today,
  touchMessage,
  usersById,
  type AttachmentRow,
  type ChannelRow,
  type MessageRow,
  type TaskRow,
} from "./team-db";

export { monthAssignedTask, dueSoonNotifications, channelName, likeContains, nextCursor, unreadMath, parseAiQuestion, monthTitle } from "./team-db";

type Variables = { user: User };
export const teamRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// The mount sets the user; a route reached without one (a test, a wrong mount) is refused here too.
teamRoutes.use("*", async (c, next) => {
  if (!c.get("user")) throw new StudioError("Sign in to use the studio.", 401);
  await next();
});

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

const idSchema = z.string().min(1).max(80);
const taskStatus = z.enum(["todo", "doing", "review", "done"]);
const taskPriority = z.enum(["low", "normal", "high", "urgent"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const refSchema = z.object({ batch: idSchema.optional(), post: z.number().int().min(1).max(999).optional(), video: idSchema.optional(), task: idSchema.optional() });

/** The month when this person may open it (owner, assigned member or admin); 404 otherwise. */
async function openableMonth(env: Env, user: User, batch: string): Promise<BatchRow> {
  try {
    return await ownedPlan(env, user, batch);
  } catch (e) {
    throw new StudioError(e instanceof StudioError && e.status === 409 ? e.message : "Month not found.", e instanceof StudioError && e.status === 409 ? 409 : 404);
  }
}

async function openTaskCount(env: Env, user: User): Promise<number> {
  const r = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM team_tasks WHERE assignee = ? AND status IN ('todo', 'doing', 'review')", user.id);
  return Number(r?.n ?? 0);
}

async function unseenCount(env: Env, user: User): Promise<number> {
  const r = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM team_notifications WHERE user = ? AND seen IS NULL", user.id);
  return Number(r?.n ?? 0);
}

async function myChannelRows(env: Env, user: User): Promise<ChannelRow[]> {
  return all<ChannelRow>(env.DB, "SELECT * FROM team_channels WHERE kind IN ('general', 'client') OR id IN (SELECT channel FROM team_channel_members WHERE user = ?) ORDER BY CASE kind WHEN 'general' THEN 0 WHEN 'client' THEN 1 WHEN 'project' THEN 2 WHEN 'group' THEN 3 ELSE 4 END, name", user.id);
}

/* ---------- bootstrap, sync, channels ---------- */

teamRoutes.get("/bootstrap", async (c) => {
  const user = c.get("user");
  await ensureChannels(c.env, user.id);
  const rows = await myChannelRows(c.env, user);
  const channels = await hydrateChannels(c.env, user, rows);
  const ids = rows.map((r) => r.id);
  const newest = ids.length ? await first<{ m: number | null }>(c.env.DB, `SELECT MAX(updated) AS m FROM team_messages WHERE channel IN (${ids.map(() => "?").join(",")})`, ...ids) : null;
  const newestNote = await first<{ m: number | null }>(c.env.DB, "SELECT MAX(at) AS m FROM team_notifications WHERE user = ?", user.id);
  const out: TeamBootstrap = {
    me: toTeamUser(user),
    users: await activeUsers(c.env),
    channels,
    unread: channels.reduce((n, ch) => n + ch.unread, 0) + (await unseenCount(c.env, user)),
    tasksOpen: await openTaskCount(c.env, user),
    cursor: nextCursor(0, [Number(newest?.m ?? 0), Number(newestNote?.m ?? 0)]),
  };
  return c.json(out);
});

teamRoutes.get("/sync", async (c) => {
  const user = c.get("user");
  const cursor = Math.max(0, Math.floor(Number(c.req.query("cursor")) || 0));
  const ids = await myChannelIds(c.env, user);
  const ph = ids.map(() => "?").join(",");
  const rows = ids.length ? await all<MessageRow>(c.env.DB, `SELECT * FROM team_messages WHERE updated > ? AND channel IN (${ph}) ORDER BY updated ASC LIMIT 200`, cursor, ...ids) : [];
  const notes = await all<{ id: string; kind: NotificationKind; text: string; ref: string | null; at: number; seen: number | null }>(c.env.DB, "SELECT id, kind, text, ref, at, seen FROM team_notifications WHERE user = ? AND at > ? ORDER BY at ASC LIMIT 200", user.id, cursor);
  const stats = await channelStats(c.env, user, ids);
  const channels = ids.map((id) => ({ id, ...(stats.get(id) ?? { unread: 0, mentioned: false, lastAt: null }) }));
  const out: TeamSync = {
    cursor: nextCursor(cursor, [...rows.map((r) => r.updated), ...notes.map((n) => n.at)]),
    messages: await hydrateMessages(c.env, rows),
    notifications: notes.map(toNotification),
    channels,
    unread: channels.reduce((n, ch) => n + ch.unread, 0) + (await unseenCount(c.env, user)),
    tasksOpen: await openTaskCount(c.env, user),
  };
  return c.json(out);
});

teamRoutes.get("/channels", async (c) => {
  const user = c.get("user");
  await ensureChannels(c.env, user.id);
  return c.json({ channels: await hydrateChannels(c.env, user, await myChannelRows(c.env, user)) });
});

teamRoutes.post("/channels", async (c) => {
  const user = c.get("user");
  const d = await body(c, z.object({ kind: z.enum(["project", "dm", "group"]), name: z.string().trim().max(80).optional(), client: idSchema.nullable().optional(), members: z.array(idSchema).max(200).default([]) }));
  const wanted = await activeIds(c.env, d.members);
  if (wanted.length !== new Set(d.members).size) throw new StudioError("Someone on the list is not an active member of the team.");
  const members = [...new Set([user.id, ...wanted])];
  const t = now();
  if (d.kind === "dm") {
    const others = members.filter((id) => id !== user.id);
    if (others.length !== 1) throw new StudioError("A direct conversation is with exactly one other person.");
    const other = others[0];
    const have = await first<{ id: string }>(
      c.env.DB,
      `SELECT ch.id FROM team_channels ch WHERE ch.kind = 'dm'
         AND EXISTS (SELECT 1 FROM team_channel_members m WHERE m.channel = ch.id AND m.user = ?)
         AND EXISTS (SELECT 1 FROM team_channel_members m WHERE m.channel = ch.id AND m.user = ?)
         AND (SELECT COUNT(*) FROM team_channel_members m WHERE m.channel = ch.id) = 2 LIMIT 1`,
      user.id,
      other,
    );
    if (have) return c.json({ channel: await hydrateChannel(c.env, user, have.id) });
    const id = uuid();
    await run(c.env.DB, "INSERT INTO team_channels (id, kind, name, client, created_by, created, archived) VALUES (?, 'dm', 'dm', NULL, ?, ?, NULL)", id, user.id, t);
    for (const m of members) await run(c.env.DB, "INSERT INTO team_channel_members (channel, user, joined) VALUES (?, ?, ?)", id, m, t);
    return c.json({ channel: await hydrateChannel(c.env, user, id) });
  }
  const name = (d.name ?? "").trim();
  if (!name) throw new StudioError("A name is required.");
  let client: string | null = null;
  if (d.kind === "project" && d.client) {
    const cl = await first<{ id: string }>(c.env.DB, "SELECT id FROM clients WHERE id = ?", d.client);
    if (!cl) throw new StudioError("Client not found.", 404);
    client = cl.id;
  }
  const id = uuid();
  await run(c.env.DB, "INSERT INTO team_channels (id, kind, name, client, created_by, created, archived) VALUES (?, ?, ?, ?, ?, ?, NULL)", id, d.kind, name.slice(0, 80), client, user.id, t);
  for (const m of members) await run(c.env.DB, "INSERT INTO team_channel_members (channel, user, joined) VALUES (?, ?, ?)", id, m, t);
  return c.json({ channel: await hydrateChannel(c.env, user, id) });
});

teamRoutes.post("/channels/:id/read", async (c) => {
  const user = c.get("user");
  const ch = await channelFor(c.env, user, c.req.param("id"));
  const d = await body(c, z.object({ at: z.number().int().min(0) }));
  await run(c.env.DB, "INSERT INTO team_reads (channel, user, last_read) VALUES (?, ?, ?) ON CONFLICT(channel, user) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)", ch.id, user.id, d.at);
  return c.json({ ok: true });
});

teamRoutes.post("/channels/:id/members", async (c) => {
  const user = c.get("user");
  const ch = await channelFor(c.env, user, c.req.param("id"));
  if (isEveryones(ch.kind)) throw new StudioError("Everyone is in this channel already.");
  if (ch.kind === "dm") throw new StudioError("A direct conversation stays between its two people.");
  const d = await body(c, z.object({ add: z.array(idSchema).max(200).optional(), remove: z.array(idSchema).max(200).optional() }));
  const add = await activeIds(c.env, d.add ?? []);
  if (add.length !== new Set(d.add ?? []).size) throw new StudioError("Someone on the list is not an active member of the team.");
  const t = now();
  for (const id of add) await run(c.env.DB, "INSERT OR IGNORE INTO team_channel_members (channel, user, joined) VALUES (?, ?, ?)", ch.id, id, t);
  for (const id of d.remove ?? []) await run(c.env.DB, "DELETE FROM team_channel_members WHERE channel = ? AND user = ?", ch.id, id);
  const left = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM team_channel_members WHERE channel = ?", ch.id);
  if (!Number(left?.n ?? 0)) {
    // Nobody left: put the caller back rather than orphan the channel.
    await run(c.env.DB, "INSERT OR IGNORE INTO team_channel_members (channel, user, joined) VALUES (?, ?, ?)", ch.id, user.id, t);
  }
  const row = (await first<ChannelRow>(c.env.DB, "SELECT * FROM team_channels WHERE id = ?", ch.id))!;
  return c.json({ channel: (await hydrateChannels(c.env, user, [row]))[0] });
});

teamRoutes.post("/channels/:id/archive", async (c) => {
  const user = c.get("user");
  const ch = await channelFor(c.env, user, c.req.param("id"));
  if (ch.kind === "general") throw new StudioError("The general channel stays open.");
  if (user.role !== "admin" && ch.created_by !== user.id) throw new StudioError("Only an admin or the channel's maker archives it.", 403);
  const d = await body(c, z.object({ archived: z.boolean() }));
  await run(c.env.DB, "UPDATE team_channels SET archived = ? WHERE id = ?", d.archived ? now() : null, ch.id);
  return c.json({ channel: await hydrateChannel(c.env, user, ch.id) });
});

/* ---------- messages ---------- */

teamRoutes.get("/messages", async (c) => {
  const user = c.get("user");
  const ch = await channelFor(c.env, user, c.req.query("channel"));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query("limit")) || 50)));
  const before = Number(c.req.query("before")) || null;
  const rows = before
    ? await all<MessageRow>(c.env.DB, "SELECT * FROM team_messages WHERE channel = ? AND thread IS NULL AND at < ? ORDER BY at DESC LIMIT ?", ch.id, before, limit + 1)
    : await all<MessageRow>(c.env.DB, "SELECT * FROM team_messages WHERE channel = ? AND thread IS NULL ORDER BY at DESC LIMIT ?", ch.id, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return c.json({ messages: await hydrateMessages(c.env, page), hasMore });
});

teamRoutes.get("/thread", async (c) => {
  const user = c.get("user");
  const id = c.req.query("message");
  if (!id) throw new StudioError("Message is required.");
  let root = await messageRow(c.env, id);
  if (root.thread) root = await messageRow(c.env, root.thread);
  await channelFor(c.env, user, root.channel);
  const replies = await all<MessageRow>(c.env.DB, "SELECT * FROM team_messages WHERE thread = ? ORDER BY at ASC", root.id);
  const previews = new PreviewCache(c.env);
  const [rootMsg] = await hydrateMessages(c.env, [root], previews);
  return c.json({ root: rootMsg, replies: await hydrateMessages(c.env, replies, previews) });
});

/** The ref a message is about, checked: a month the caller can open. Returns the canonical JSON or null. */
async function checkedRef(env: Env, user: User, ref: z.infer<typeof refSchema> | null | undefined): Promise<string | null> {
  if (!ref) return null;
  const out: Record<string, unknown> = {};
  if (ref.batch) {
    await openableMonth(env, user, ref.batch);
    out.batch = ref.batch;
    if (ref.post) out.post = ref.post;
  }
  if (ref.video) out.video = ref.video;
  if (ref.task) {
    await taskRow(env, ref.task);
    out.task = ref.task;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** The people a message's mentions reach: the ids written in the body who exist and are not disabled. */
async function mentionedIds(env: Env, text: string): Promise<string[]> {
  return activeIds(env, mentionsIn(text));
}

/** Tells a dm's other side about a new message, and everyone mentioned (once each, never the author). */
async function tellAbout(env: Env, ch: ChannelRow, author: User, msg: MessageRow, mentions: string[], opts: { exclude?: Set<string>; dm?: boolean } = {}): Promise<void> {
  const text = plainBody(msg.body).replace(/\s+/g, " ").trim().slice(0, 140) || (msg.kind === "voice" ? "Voice note" : "Attachment");
  const told = new Set<string>([author.id]);
  const excludeMentions = opts.exclude ?? new Set<string>();
  if (ch.kind === "dm" && opts.dm !== false) {
    const others = (await membersOf(env, [ch.id])).get(ch.id)?.map((m) => m.id).filter((id) => id !== author.id) ?? [];
    await notify(env, others, "dm", `${author.name}: ${text}`, { channel: ch.id, message: msg.id });
    for (const o of others) told.add(o);
  }
  const members = (await membersOf(env, [ch.id])).get(ch.id);
  const place = ch.kind === "dm" ? "a direct message" : `#${channelName(ch.kind, ch.name, members ?? [], author.id)}`;
  const fresh = mentions.filter((id) => !told.has(id) && !excludeMentions.has(id));
  await notify(env, fresh, "mention", `${author.name} mentioned you in ${place}: ${text}`, { channel: ch.id, message: msg.id });
}

teamRoutes.post("/messages", async (c) => {
  const user = c.get("user");
  const d = await body(
    c,
    z.object({
      channel: idSchema,
      body: z.string().max(TEAM_MESSAGE_MAX, `A message has at most ${TEAM_MESSAGE_MAX} characters.`).default(""),
      thread: idSchema.nullable().optional(),
      ref: refSchema.nullable().optional(),
      attachments: z.array(idSchema).max(10).optional(),
      kind: z.enum(["text", "voice"]).optional(),
    }),
  );
  const ch = await channelFor(c.env, user, d.channel);
  if (ch.archived) throw new StudioError("This channel is archived.", 409);
  const text = d.body.trim();
  const attachmentIds = [...new Set(d.attachments ?? [])];
  if (!text && !attachmentIds.length) throw new StudioError("Write something or attach a file.");
  let thread: string | null = null;
  if (d.thread) {
    const root = await messageRow(c.env, d.thread);
    if (root.channel !== ch.id) throw new StudioError("That thread is in another channel.");
    thread = root.thread ?? root.id;
  }
  const attachments: AttachmentRow[] = [];
  for (const id of attachmentIds) {
    const a = await first<AttachmentRow>(c.env.DB, "SELECT * FROM team_attachments WHERE id = ? AND owner = ?", id, user.id);
    if (!a) throw new StudioError("Attachment not found.", 404);
    if (a.message) throw new StudioError("That attachment is already on a message.", 409);
    attachments.push(a);
  }
  const ref = await checkedRef(c.env, user, d.ref);
  const mentions = await mentionedIds(c.env, text);
  const id = uuid();
  const t = now();
  const kind = d.kind === "voice" || (!text && attachments.length === 1 && attachments[0].kind === "voice") ? "voice" : "text";
  await run(
    c.env.DB,
    "INSERT INTO team_messages (id, channel, thread, author, kind, body, ref, attachments, mentions, at, edited, deleted, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
    id,
    ch.id,
    thread,
    user.id,
    kind,
    text,
    ref,
    attachments.length ? JSON.stringify(attachments.map((a) => a.id)) : null,
    mentions.length ? JSON.stringify(mentions) : null,
    t,
    t,
  );
  for (const a of attachments) await run(c.env.DB, "UPDATE team_attachments SET message = ? WHERE id = ?", id, a.id);
  // The root carries its reply count: stamped so the poll refreshes it.
  if (thread) await touchMessage(c.env, thread);
  const row = await messageRow(c.env, id);
  await tellAbout(c.env, ch, user, row, mentions);
  return c.json({ message: (await hydrateMessages(c.env, [row]))[0] });
});

teamRoutes.put("/messages/:id", async (c) => {
  const user = c.get("user");
  const m = await messageRow(c.env, c.req.param("id"));
  const ch = await channelFor(c.env, user, m.channel);
  if (m.author !== user.id) throw new StudioError("Only the author edits a message.", 403);
  if (m.deleted) throw new StudioError("That message was deleted.", 409);
  const d = await body(c, z.object({ body: z.string().trim().min(1).max(TEAM_MESSAGE_MAX) }));
  const before = new Set<string>(JSON.parse(m.mentions ?? "[]") as string[]);
  const mentions = await mentionedIds(c.env, d.body);
  const t = now();
  await run(c.env.DB, "UPDATE team_messages SET body = ?, mentions = ?, edited = ?, updated = ? WHERE id = ?", d.body, mentions.length ? JSON.stringify(mentions) : null, t, t, m.id);
  const row = await messageRow(c.env, m.id);
  // Only people newly mentioned hear about the edit.
  if (mentions.some((id) => !before.has(id))) await tellAbout(c.env, ch, user, row, mentions, { exclude: before, dm: false });
  return c.json({ message: (await hydrateMessages(c.env, [row]))[0] });
});

teamRoutes.delete("/messages/:id", async (c) => {
  const user = c.get("user");
  const m = await messageRow(c.env, c.req.param("id"));
  await channelFor(c.env, user, m.channel);
  if (m.author !== user.id && user.role !== "admin") throw new StudioError("Only the author or an admin deletes a message.", 403);
  const attachmentIds = JSON.parse(m.attachments ?? "[]") as string[];
  const t = now();
  await run(c.env.DB, "UPDATE team_messages SET body = '', ref = NULL, attachments = NULL, mentions = NULL, deleted = ?, updated = ? WHERE id = ?", t, t, m.id);
  await run(c.env.DB, "DELETE FROM team_pins WHERE message = ?", m.id);
  for (const id of attachmentIds) {
    const a = await first<{ key: string }>(c.env.DB, "SELECT key FROM team_attachments WHERE id = ?", id);
    if (!a) continue;
    await run(c.env.DB, "DELETE FROM team_attachments WHERE id = ?", id);
    const still = await first<{ id: string }>(c.env.DB, "SELECT id FROM team_attachments WHERE key = ? LIMIT 1", a.key);
    if (!still) await c.env.BUCKET.delete(a.key).catch((e) => console.error("[team] delete", errorMessage(e)));
  }
  if (m.thread) await touchMessage(c.env, m.thread);
  return c.json({ ok: true });
});

teamRoutes.post("/messages/:id/react", async (c) => {
  const user = c.get("user");
  const m = await messageRow(c.env, c.req.param("id"));
  await channelFor(c.env, user, m.channel);
  if (m.deleted) throw new StudioError("That message was deleted.", 409);
  const d = await body(c, z.object({ emoji: z.string().trim().min(1).max(16) }));
  const removed = await run(c.env.DB, "DELETE FROM team_reactions WHERE message = ? AND user = ? AND emoji = ?", m.id, user.id, d.emoji);
  if (!removed) await run(c.env.DB, "INSERT INTO team_reactions (message, user, emoji, at) VALUES (?, ?, ?, ?)", m.id, user.id, d.emoji, now());
  await touchMessage(c.env, m.id);
  return c.json({ message: await hydrateMessage(c.env, m.id) });
});

teamRoutes.post("/messages/:id/pin", async (c) => {
  const user = c.get("user");
  const m = await messageRow(c.env, c.req.param("id"));
  await channelFor(c.env, user, m.channel);
  if (m.deleted) throw new StudioError("That message was deleted.", 409);
  const d = await body(c, z.object({ pinned: z.boolean() }));
  if (d.pinned) await run(c.env.DB, "INSERT OR IGNORE INTO team_pins (channel, message, by, at) VALUES (?, ?, ?, ?)", m.channel, m.id, user.id, now());
  else await run(c.env.DB, "DELETE FROM team_pins WHERE message = ?", m.id);
  await touchMessage(c.env, m.id);
  return c.json({ message: await hydrateMessage(c.env, m.id) });
});

teamRoutes.get("/pins", async (c) => {
  const user = c.get("user");
  const ch = await channelFor(c.env, user, c.req.query("channel"));
  const rows = await all<MessageRow>(c.env.DB, "SELECT m.* FROM team_pins p JOIN team_messages m ON m.id = p.message WHERE p.channel = ? AND m.deleted IS NULL ORDER BY p.at DESC LIMIT 100", ch.id);
  return c.json({ messages: await hydrateMessages(c.env, rows) });
});

teamRoutes.get("/search", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!q) return c.json({ messages: [] as Message[] });
  const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query("limit")) || 50)));
  const only = c.req.query("channel");
  const ids = only ? [(await channelFor(c.env, user, only)).id] : await myChannelIds(c.env, user);
  if (!ids.length) return c.json({ messages: [] as Message[] });
  const rows = await all<MessageRow>(c.env.DB, `SELECT * FROM team_messages WHERE deleted IS NULL AND body LIKE ? ESCAPE '\\' AND channel IN (${ids.map(() => "?").join(",")}) ORDER BY at DESC LIMIT ?`, likeContains(q), ...ids, limit);
  return c.json({ messages: await hydrateMessages(c.env, rows) });
});

/* ---------- files ---------- */

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "text/plain": "txt",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** The picture kind the bytes really are (sniffImage plus GIF), or null for something else. */
export function sniffPicture(bytes: ArrayBuffer): string | null {
  const known = sniffImage(bytes);
  if (known) return known;
  const b = new Uint8Array(bytes.slice(0, 6));
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  return null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

teamRoutes.post("/upload", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData().catch(() => {
    throw new StudioError("Send the file as multipart form data.");
  });
  const f = form.get("file");
  if (!(f instanceof File)) throw new StudioError("A file is required.");
  const declared = (f.type || "").toLowerCase().split(";")[0].trim();
  if (!TEAM_FILE_TYPES.test(declared)) throw new StudioError("That kind of file is not accepted here (pictures, PDF, audio, MP4, text and Office files are).", 415);
  let kind: AttachmentKind = "file";
  let max = TEAM_FILE_MAX;
  if (declared.startsWith("image/")) {
    kind = "image";
    max = TEAM_IMAGE_MAX;
  } else if (declared.startsWith("audio/")) {
    kind = "voice";
    max = TEAM_VOICE_MAX;
  }
  if (f.size > max) throw new StudioError(`The file is too large: ${kind === "image" ? "a picture" : kind === "voice" ? "a voice note" : "a file"} has at most ${mb(max)}.`, 413);
  const bytes = await f.arrayBuffer();
  let mime = declared;
  let width: number | null = null;
  let height: number | null = null;
  if (kind === "image") {
    const real = sniffPicture(bytes);
    if (!real) throw new StudioError("That file is not a picture.", 415);
    mime = real;
    const size = imageSize(bytes);
    width = size?.width ?? null;
    height = size?.height ?? null;
  }
  let duration: number | null = null;
  if (kind === "voice") {
    const raw = form.get("duration");
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) duration = Math.round(n * 10) / 10;
    if (duration !== null && duration > TEAM_VOICE_SECONDS_MAX) throw new StudioError(`A voice note is at most ${TEAM_VOICE_SECONDS_MAX} seconds.`, 413);
  }
  const sha = await sha256Hex(bytes);
  const id = uuid();
  const same = await first<{ key: string }>(c.env.DB, "SELECT key FROM team_attachments WHERE owner = ? AND sha256 = ? LIMIT 1", user.id, sha);
  const ext = EXT[mime] ?? (/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1]?.toLowerCase() ?? "bin");
  const key = same?.key ?? `team/${user.id}/${id}.${ext}`;
  if (!same) await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  const name = (f.name || "file").normalize("NFC").replace(/[\r\n"]/g, " ").slice(0, 200);
  await run(
    c.env.DB,
    "INSERT INTO team_attachments (id, owner, message, name, mime, size, key, kind, width, height, duration, sha256, created) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    user.id,
    name,
    mime,
    bytes.byteLength,
    key,
    kind,
    width,
    height,
    duration,
    sha,
    now(),
  );
  const row = (await first<AttachmentRow>(c.env.DB, "SELECT * FROM team_attachments WHERE id = ?", id))!;
  return c.json({ attachment: toAttachment(row) });
});

teamRoutes.get("/file/:id", async (c) => {
  const a = await first<AttachmentRow>(c.env.DB, "SELECT * FROM team_attachments WHERE id = ?", c.req.param("id"));
  if (!a) throw new StudioError("File not found.", 404);
  const inline = a.kind === "image" || a.kind === "voice";
  const disposition = `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`;
  const headers = { "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Disposition": disposition };
  const w = a.kind === "image" ? thumbWidth(c.req.query("w")) : null;
  if (w) {
    const small = await resizedPicture(c.env, a.key, w).catch((e) => {
      console.error("[team] resize", errorMessage(e));
      return undefined;
    });
    if (small === null) throw new StudioError("File not found.", 404);
    if (small) return new Response(small.bytes, { headers: { ...headers, "Content-Type": small.mime } });
  }
  const obj = await c.env.BUCKET.get(a.key);
  if (!obj) throw new StudioError("File not found.", 404);
  const bytes = obj.body ?? (await obj.arrayBuffer());
  return new Response(bytes, { headers: { ...headers, "Content-Type": a.mime || obj.httpMetadata?.contentType || "application/octet-stream", "Content-Length": String(obj.size) } });
});

/* ---------- the discussion of a post ---------- */

teamRoutes.get("/discuss", async (c) => {
  const user = c.get("user");
  const batch = c.req.query("batch") ?? "";
  const post = Math.floor(Number(c.req.query("post")));
  if (!batch || !Number.isFinite(post) || post < 1) throw new StudioError("A month and a post are required.");
  const b = await openableMonth(c.env, user, batch);
  if (!b.client) throw new StudioError("This month has no client.", 409);
  const ch = await clientChannel(c.env, b.client, user.id);
  const ref = JSON.stringify({ batch: b.id, post });
  let anchor = await first<MessageRow>(c.env.DB, "SELECT * FROM team_messages WHERE channel = ? AND kind = 'system' AND thread IS NULL AND ref = ? AND deleted IS NULL ORDER BY at LIMIT 1", ch.id, ref);
  if (!anchor) {
    const title = await new PreviewCache(c.env).postTitle(b.id, post);
    const id = uuid();
    const t = now();
    await run(c.env.DB, "INSERT INTO team_messages (id, channel, thread, author, kind, body, ref, attachments, mentions, at, edited, deleted, updated) VALUES (?, ?, NULL, ?, 'system', ?, ?, NULL, NULL, ?, NULL, NULL, ?)", id, ch.id, user.id, `Discussion of post ${post}${title ? ` · ${title}` : ""}`, ref, t, t);
    anchor = await messageRow(c.env, id);
  }
  return c.json({ channel: await hydrateChannel(c.env, user, ch.id), message: (await hydrateMessages(c.env, [anchor]))[0] });
});

/* ---------- tasks ---------- */

const taskFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  assignee: idSchema.nullable(),
  client: idSchema.nullable(),
  batch: idSchema.nullable(),
  post: z.number().int().min(1).max(999).nullable(),
  due: dateSchema.nullable(),
  priority: taskPriority,
  status: taskStatus,
};

teamRoutes.get("/tasks", async (c) => {
  const user = c.get("user");
  const q = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.mine === "1") {
    where.push("assignee = ?");
    params.push(user.id);
  }
  for (const f of ["client", "status", "priority", "batch"] as const) {
    if (q[f]) {
      where.push(`${f} = ?`);
      params.push(q[f]);
    }
  }
  const day = today();
  if (q.due === "overdue") {
    where.push("due IS NOT NULL AND due < ? AND status <> 'done'");
    params.push(day);
  } else if (q.due === "week") {
    where.push("due IS NOT NULL AND due >= ? AND due <= ?");
    params.push(day, plusDays(day, 7));
  }
  const rows = await all<TaskRow>(c.env.DB, `SELECT * FROM team_tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END, due IS NULL, due, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created DESC LIMIT 500`, ...params);
  return c.json({ tasks: await hydrateTasks(c.env, rows) });
});

/** Checks the people and places a task points at; fills the client from the month. */
async function checkTaskRefs(env: Env, user: User, t: { assignee?: string | null; client?: string | null; batch?: string | null }): Promise<{ client: string | null | undefined }> {
  if (t.assignee) {
    const ok = await activeIds(env, [t.assignee]);
    if (!ok.length) throw new StudioError("That person is not an active member of the team.");
  }
  let client = t.client;
  if (t.client) {
    const cl = await first<{ id: string }>(env.DB, "SELECT id FROM clients WHERE id = ?", t.client);
    if (!cl) throw new StudioError("Client not found.", 404);
  }
  if (t.batch) {
    const b = await openableMonth(env, user, t.batch);
    if (client === undefined || client === null) client = b.client ?? null;
  }
  return { client };
}

teamRoutes.post("/tasks", async (c) => {
  const user = c.get("user");
  const d = await body(
    c,
    z.object({
      title: taskFields.title.optional(),
      description: taskFields.description.optional(),
      assignee: taskFields.assignee.optional(),
      client: taskFields.client.optional(),
      batch: taskFields.batch.optional(),
      post: taskFields.post.optional(),
      due: taskFields.due.optional(),
      priority: taskFields.priority.optional(),
      status: taskStatus.optional(),
      sourceMessage: idSchema.nullable().optional(),
    }),
  );
  let title = d.title ?? "";
  let description = d.description ?? "";
  if (d.sourceMessage) {
    const m = await messageRow(c.env, d.sourceMessage);
    await channelFor(c.env, user, m.channel);
    const plain = plainBody(m.body).replace(/\s+/g, " ").trim();
    if (!title) title = plain.slice(0, 80) || "Task from a message";
    if (!description && plain.length > 80) description = plain.slice(0, 4000);
  }
  if (!title) throw new StudioError("A title is required.");
  const { client } = await checkTaskRefs(c.env, user, d);
  const row = await createTask(c.env, toTeamUser(user), { title, description, assignee: d.assignee ?? null, client: client ?? null, batch: d.batch ?? null, post: d.post ?? null, due: d.due ?? null, priority: d.priority, status: d.status, sourceMessage: d.sourceMessage ?? null });
  return c.json({ task: await hydrateTask(c.env, row.id, true) });
});

teamRoutes.put("/tasks/:id", async (c) => {
  const user = c.get("user");
  const t = await taskRow(c.env, c.req.param("id"));
  const d = await body(
    c,
    z.object({
      title: taskFields.title.optional(),
      description: taskFields.description.optional(),
      assignee: taskFields.assignee.optional(),
      client: taskFields.client.optional(),
      batch: taskFields.batch.optional(),
      post: taskFields.post.optional(),
      due: taskFields.due.optional(),
      priority: taskFields.priority.optional(),
      status: taskFields.status.optional(),
    }),
  );
  const { client } = await checkTaskRefs(c.env, user, { assignee: d.assignee, client: d.client, batch: d.batch });
  const next: Record<string, unknown> = { ...d };
  if (d.batch && d.client === undefined && !t.client && client) next.client = client;
  const changes: { field: string; from: string | null; to: string | null }[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of Object.keys(taskFields) as (keyof typeof taskFields)[]) {
    if (next[field] === undefined) continue;
    const before = t[field] ?? null;
    const after = (next[field] as string | number | null) ?? null;
    if (before === after) continue;
    changes.push({ field, from: before === null ? null : String(before), to: after === null ? null : String(after) });
    sets.push(`${field} = ?`);
    params.push(after);
  }
  if (!changes.length) return c.json({ task: await hydrateTask(c.env, t.id, true) });
  const at = now();
  if (next.status !== undefined && next.status !== t.status) {
    sets.push("done_at = ?");
    params.push(next.status === "done" ? at : null);
  }
  sets.push("updated = ?");
  params.push(at);
  await run(c.env.DB, `UPDATE team_tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, t.id);
  for (const ch of changes) await taskEvent(c.env, t.id, user.id, ch);
  const reassigned = changes.find((ch) => ch.field === "assignee");
  if (reassigned?.to && reassigned.to !== user.id) await notify(c.env, [reassigned.to], "task", `${user.name} assigned you: ${(next.title as string | undefined) ?? t.title}`, { task: t.id });
  return c.json({ task: await hydrateTask(c.env, t.id, true) });
});

teamRoutes.post("/tasks/:id/comment", async (c) => {
  const user = c.get("user");
  const t = await taskRow(c.env, c.req.param("id"));
  const d = await body(c, z.object({ text: z.string().trim().min(1).max(4000) }));
  await taskEvent(c.env, t.id, user.id, { comment: d.text });
  await run(c.env.DB, "UPDATE team_tasks SET updated = ? WHERE id = ?", now(), t.id);
  const mentioned = await mentionedIds(c.env, d.text);
  await notify(c.env, [...(t.assignee && t.assignee !== user.id ? [t.assignee] : []), ...mentioned.filter((id) => id !== user.id)], "task", `${user.name} on "${t.title}": ${plainBody(d.text).slice(0, 140)}`, { task: t.id });
  return c.json({ task: await hydrateTask(c.env, t.id, true) });
});

teamRoutes.get("/tasks/:id", async (c) => c.json({ task: await hydrateTask(c.env, c.req.param("id"), true) }));

/* ---------- internal approvals ---------- */

teamRoutes.get("/reviews", async (c) => {
  const user = c.get("user");
  const b = await openableMonth(c.env, user, c.req.query("batch") ?? "");
  const rows = await all<{ id: string; batch: string; post: number; version: string | null; status: ReviewStatus; by: string; note: string; at: number }>(c.env.DB, "SELECT * FROM team_reviews WHERE batch = ? ORDER BY at DESC, rowid DESC LIMIT 1000", b.id);
  const users = await usersById(c.env, rows.map((r) => r.by));
  return c.json({ reviews: rows.map((r) => toReview(r, users)) });
});

teamRoutes.post("/reviews", async (c) => {
  const user = c.get("user");
  const d = await body(c, z.object({ batch: idSchema, post: z.number().int().min(1).max(999), status: z.enum(["draft", "review", "changes", "approved"]), note: z.string().trim().max(2000).optional(), version: z.string().max(400).nullable().optional() }));
  const b = await openableMonth(c.env, user, d.batch);
  const id = uuid();
  const at = now();
  await run(c.env.DB, "INSERT INTO team_reviews (id, batch, post, version, status, by, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, b.id, d.post, d.version ?? null, d.status, user.id, d.note ?? "", at);
  const previews = new PreviewCache(c.env);
  const title = await previews.postTitle(b.id, d.post);
  const label = `post ${d.post}${title ? ` · ${title}` : ""}`;
  const where = await previews.where(b.id);
  const assignees = (await monthAssignees(c.env, b.id)).filter((u) => u !== user.id);
  if (d.status === "approved") {
    // The same as the Studio's Accept: the picture counts as ready, its review flags cleared.
    await acceptPost(c.env, user, b, d.post).catch((e) => {
      if (!(e instanceof StudioError && e.status === 404)) throw e;
    });
    await notify(c.env, assignees, "approval", `${user.name} approved ${label} (${where})${d.note ? `: ${d.note}` : ""}`, { batch: b.id, post: d.post });
  } else if (d.status === "changes") {
    const prefix = `Changes on post ${d.post}`;
    // "Changes on post 1" must not match "Changes on post 12": the title is the prefix alone or followed by " · ".
    const open = await first<{ id: string }>(c.env.DB, "SELECT id FROM team_tasks WHERE batch = ? AND post = ? AND kind = 'task' AND status <> 'done' AND (title = ? OR title LIKE ? ESCAPE '\\') LIMIT 1", b.id, d.post, prefix, `${likeContains(prefix).slice(1, -1)} ·%`);
    // The owner hears about it once, as a review (the task itself is quiet).
    if (!open) await createTask(c.env, toTeamUser(user), { title: `${prefix}${title ? ` · ${title}` : ""}`, description: d.note ?? "", assignee: b.owner, client: b.client ?? null, batch: b.id, post: d.post, priority: "high", status: "todo" }, { quiet: true });
    await notify(c.env, assignees, "review", `${user.name} asked for changes on ${label} (${where})${d.note ? `: ${d.note}` : ""}`, { batch: b.id, post: d.post });
  } else if (d.status === "review") {
    await notify(c.env, assignees, "review", `${user.name} sent ${label} (${where}) for review${d.note ? `: ${d.note}` : ""}`, { batch: b.id, post: d.post });
  }
  const row = (await first<{ id: string; batch: string; post: number; version: string | null; status: ReviewStatus; by: string; note: string; at: number }>(c.env.DB, "SELECT * FROM team_reviews WHERE id = ?", id))!;
  return c.json({ review: toReview(row, await usersById(c.env, [row.by])) });
});

/* ---------- notifications ---------- */

teamRoutes.get("/notifications", async (c) => {
  const user = c.get("user");
  const rows = await all<{ id: string; kind: NotificationKind; text: string; ref: string | null; at: number; seen: number | null }>(c.env.DB, "SELECT id, kind, text, ref, at, seen FROM team_notifications WHERE user = ? ORDER BY at DESC LIMIT 100", user.id);
  return c.json({ notifications: rows.map(toNotification) });
});

teamRoutes.post("/notifications/seen", async (c) => {
  const user = c.get("user");
  const d = await body(c, z.object({ ids: z.array(idSchema).max(500).optional() }));
  const t = now();
  if (d.ids?.length) await run(c.env.DB, `UPDATE team_notifications SET seen = ? WHERE user = ? AND seen IS NULL AND id IN (${d.ids.map(() => "?").join(",")})`, t, user.id, ...d.ids);
  else await run(c.env.DB, "UPDATE team_notifications SET seen = ? WHERE user = ? AND seen IS NULL", t, user.id);
  return c.json({ ok: true });
});

/* ---------- the deterministic assistant ---------- */

teamRoutes.post("/ai", async (c) => {
  const d = await body(c, z.object({ q: z.string().trim().min(1).max(500) }));
  return c.json(await answerAi(c.env, d.q));
});
