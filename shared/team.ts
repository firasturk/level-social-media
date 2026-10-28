/**
 * Team (28 Oct): the studio's own workspace for LEVEL employees. This file is the contract between
 * the server (server/team.ts, mounted at /api/team behind the studio's session: every route needs a
 * signed-in employee, never a client link) and the page (src/team). Everything runs on the studio's
 * own database, bucket and session: no outside service, no new cost. Live updates are polled.
 */

export interface TeamUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

export type ChannelKind = "general" | "client" | "project" | "dm" | "group";

export interface Channel {
  id: string;
  kind: ChannelKind;
  /** "general", the client's name, a project's name; a dm's name is the other person's. */
  name: string;
  client: string | null;
  /** Members of a dm, group or project channel; general and client channels are everyone's (absent). */
  members?: TeamUser[];
  unread: number;
  /** Someone mentioned me in an unread message. */
  mentioned: boolean;
  lastAt: number | null;
  archived: boolean;
}

export type AttachmentKind = "image" | "file" | "voice";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  width?: number | null;
  height?: number | null;
  /** Seconds, for a voice note. */
  duration?: number | null;
  /** GET /api/team/file/:id (signed-in employees only). */
  url: string;
}

/** What a message is about: the preview card it shows, resolved by the server. */
export interface MessageRef {
  batch?: string;
  post?: number;
  video?: string;
  task?: string;
}

export interface RefPreview {
  title: string;
  /** "Abu Saleh · October 2026" */
  where: string;
  /** The post's production status, as the studio shows it. */
  status?: string;
  /** A small picture, when the creative has one (an authenticated studio file URL). */
  thumb?: string | null;
  /** The internal approval state of the creative, when any. */
  review?: ReviewStatus | null;
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export type MessageKind = "text" | "voice" | "system";

export interface Message {
  id: string;
  channel: string;
  /** The root message of the thread this reply belongs to, or null for a top-level message. */
  thread: string | null;
  author: TeamUser;
  kind: MessageKind;
  /** The text; @mentions are written as @[Name](userId). */
  body: string;
  attachments: Attachment[];
  ref?: (MessageRef & { preview?: RefPreview }) | null;
  mentions: string[];
  reactions: Reaction[];
  /** Replies in this message's thread (top-level messages only). */
  replies: number;
  lastReplyAt?: number | null;
  pinned: boolean;
  at: number;
  edited?: number | null;
  /** A deleted message stays as a stub ("message deleted") so a thread keeps its shape. */
  deleted?: boolean;
}

export type TaskStatus = "todo" | "doing" | "review" | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export const TASK_STATUSES: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" },
];
export const TASK_PRIORITIES: { id: TaskPriority; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high", label: "High" },
  { id: "urgent", label: "Urgent" },
];

export interface TaskEvent {
  id: string;
  by: TeamUser;
  at: number;
  change: { field: string; from?: string | null; to?: string | null } | { comment: string };
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: TeamUser | null;
  client: string | null;
  clientName?: string | null;
  batch: string | null;
  /** "Abu Saleh · October 2026", when the task belongs to a month. */
  batchName?: string | null;
  post: number | null;
  due: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  /** "task", or "month": the parent task made when a month is assigned (one per month and person). */
  kind: "task" | "month";
  sourceMessage?: string | null;
  createdBy: TeamUser;
  created: number;
  updated: number;
  events?: TaskEvent[];
  preview?: RefPreview | null;
}

export type ReviewStatus = "draft" | "review" | "changes" | "approved";
export const REVIEW_STATUSES: { id: ReviewStatus; label: string }[] = [
  { id: "draft", label: "Draft" },
  { id: "review", label: "In review" },
  { id: "changes", label: "Changes requested" },
  { id: "approved", label: "Approved" },
];

export interface Review {
  id: string;
  batch: string;
  post: number;
  /** The picture key the decision was about. */
  version: string | null;
  status: ReviewStatus;
  by: TeamUser;
  note: string;
  at: number;
}

export type NotificationKind = "dm" | "mention" | "task" | "review" | "approval" | "due";

export interface Notification {
  id: string;
  kind: NotificationKind;
  text: string;
  ref: { channel?: string; message?: string; task?: string; batch?: string; post?: number } | null;
  at: number;
  seen: boolean;
}

/** GET /api/team/bootstrap */
export interface TeamBootstrap {
  me: TeamUser;
  users: TeamUser[];
  channels: Channel[];
  /** Unread messages across channels + unseen notifications. */
  unread: number;
  /** My open tasks (todo, doing, review). */
  tasksOpen: number;
  /** The sync cursor to start polling from (a timestamp in ms). */
  cursor: number;
}

/**
 * GET /api/team/sync?cursor=<ms>[&channel=<id>]: everything that changed since the cursor in the
 * channels I am in (new, edited, deleted, reacted, pinned messages carry their whole row), my new
 * notifications, the unread count per channel, and the next cursor. Polled every 4 s while the
 * Team page or panel is open, every 20 s otherwise (the badge). Cheap: one indexed query on
 * team_messages.updated plus the counts.
 */
export interface TeamSync {
  cursor: number;
  messages: Message[];
  notifications: Notification[];
  channels: { id: string; unread: number; mentioned: boolean; lastAt: number | null }[];
  unread: number;
  tasksOpen: number;
}

/** Limits, shared by the upload route and the page. */
export const TEAM_IMAGE_MAX = 20 * 1024 * 1024;
export const TEAM_FILE_MAX = 25 * 1024 * 1024;
export const TEAM_VOICE_MAX = 10 * 1024 * 1024;
export const TEAM_VOICE_SECONDS_MAX = 180;
export const TEAM_MESSAGE_MAX = 4000;
export const TEAM_FILE_TYPES = /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/(webm|ogg|mp4|mpeg|wav)|video\/mp4|text\/plain|application\/(zip|vnd\.openxmlformats-officedocument\.[a-z.]+|msword|vnd\.ms-excel|vnd\.ms-powerpoint))$/i;

/** The eight quick reactions; any emoji is accepted. */
export const QUICK_EMOJI = ["👍", "❤️", "✅", "👀", "🔥", "🙏", "😂", "🎉"];

/** @mentions in a body: "@[Name](id)". */
export const MENTION_RE = /@\[([^\]]+)\]\(([a-zA-Z0-9_-]+)\)/g;
export function mentionsIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) out.add(m[2]);
  return [...out];
}
/** The body as plain text, mentions as "@Name". */
export function plainBody(body: string): string {
  return body.replace(MENTION_RE, "@$1");
}

/**
 * The routes (all under /api/team, JSON unless said; every one needs a signed-in employee):
 *
 *   GET  /bootstrap                               → TeamBootstrap
 *   GET  /sync?cursor=&channel=                   → TeamSync
 *   GET  /channels                                → { channels: Channel[] }
 *   POST /channels { kind: "project"|"dm"|"group", name?, client?, members: string[] } → { channel: Channel }
 *        (a dm with the same person twice is the same channel; "general" and client channels exist by themselves)
 *   POST /channels/:id/read { at }                → { ok }   (everything up to `at` read)
 *   POST /channels/:id/members { add?: string[], remove?: string[] } → { channel }
 *   POST /channels/:id/archive { archived: boolean } → { channel }
 *   GET  /messages?channel=&before=<at>&limit=50  → { messages: Message[], hasMore }  (top-level, newest last)
 *   GET  /thread?message=<id>                     → { root: Message, replies: Message[] }
 *   POST /messages { channel, body, thread?, ref?, attachments?: string[], kind?: "text"|"voice" } → { message }
 *   PUT  /messages/:id { body }                   → { message }   (author only; edited stamped)
 *   DELETE /messages/:id                          → { ok }        (author or admin; a stub stays)
 *   POST /messages/:id/react { emoji }            → { message }   (toggles)
 *   POST /messages/:id/pin { pinned: boolean }    → { message }
 *   GET  /pins?channel=                           → { messages }
 *   GET  /search?q=&channel=&limit=               → { messages }  (LIKE on the body, newest first)
 *   POST /upload (multipart: file, duration?)     → { attachment: Attachment }  (limits above; the same bytes twice is one object)
 *   GET  /file/:id[?w=480]                        → the bytes (images resized when w is given, via the studio's thumbs)
 *   GET  /discuss?batch=&post=                    → { channel, message }  (the client's channel and the anchor message for the post: a system message with ref {batch, post}, made once)
 *   GET  /tasks?mine=1&client=&status=&priority=&due=overdue|week|all&batch= → { tasks: Task[] }
 *   POST /tasks { title, description?, assignee?, client?, batch?, post?, due?, priority?, status?, sourceMessage? } → { task }
 *   PUT  /tasks/:id { ...fields }                 → { task }  (every change is an event)
 *   POST /tasks/:id/comment { text }              → { task }
 *   GET  /tasks/:id                               → { task } (with events)
 *   GET  /reviews?batch=                          → { reviews: Review[] } (the latest per post first)
 *   POST /reviews { batch, post, status, note?, version? } → { review }
 *        approved: the studio task of that picture is accepted (status ready) as the Studio's Accept does;
 *        changes: a task "Changes on post N" for the month's owner (or its assignees) is created unless one is open;
 *        the client's own approvals (the share link) are untouched.
 *   GET  /notifications                           → { notifications }
 *   POST /notifications/seen { ids?: string[] }   → { ok }   (all when no ids)
 *   POST /ai { q }                                → { answer: string, items?: unknown[] }
 *        deterministic only: "pending tasks for <client>", "unfinished posts for <month>", "overdue", "needs approval";
 *        no model call, no charge; anything else answers "I can list tasks, unfinished posts, overdue work and creatives waiting for approval."
 */
export const TEAM_API = "/api/team";
