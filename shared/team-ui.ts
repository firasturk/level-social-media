/**
 * Team: the pure helpers behind the page (no React, no DOM; shared so the tests and the server can use them).
 * Message grouping, mention tokens, unread merging, the sync cursor and its back-off, times.
 */
import { MENTION_RE, type Channel, type Message, type TeamSync, type TeamUser } from "./team";

/** The read-only assistant: a special mention, answered by POST /api/team/ai and never stored. */
export const LEVEL_AI: TeamUser = { id: "level-ai", name: "Level AI", email: "", role: "member" };

/** Messages by the same person within five minutes share one avatar. */
export const COLLAPSE_MS = 5 * 60 * 1000;

export const SYNC_FAST = 4000;
export const SYNC_SLOW = 20000;
export const SYNC_MAX = 30000;

/** After a failed sync the next try waits twice as long, up to 30 s. */
export function nextBackoff(ms: number): number {
  return Math.min(Math.max(ms, SYNC_FAST) * 2, SYNC_MAX);
}

/** The cursor only moves forward: a slow answer arriving late never rewinds it. */
export function nextCursor(prev: number, sync: { cursor: number }): number {
  return Math.max(prev, sync.cursor || 0);
}

/* ─────────────── Body tokens ─────────────── */

export type BodyToken =
  | { t: "text"; v: string }
  | { t: "mention"; name: string; id: string }
  | { t: "link"; href: string }
  | { t: "br" };

const LINK_RE = /https?:\/\/[^\s<>]+/g;
const TRAILING = /[.,;:!?'")\]]+$/;

/** A message body as tokens: text, @mentions, links and line breaks. */
export function tokenizeBody(body: string): BodyToken[] {
  const out: BodyToken[] = [];
  const lines = body.split(/\r?\n/);
  const re = new RegExp(`${MENTION_RE.source}|(${LINK_RE.source})`, "g");
  lines.forEach((line, li) => {
    if (li > 0) out.push({ t: "br" });
    let last = 0;
    for (const m of line.matchAll(re)) {
      const start = m.index ?? 0;
      if (start > last) out.push({ t: "text", v: line.slice(last, start) });
      if (m[1] !== undefined) {
        out.push({ t: "mention", name: m[1], id: m[2] });
        last = start + m[0].length;
      } else {
        let href = m[0];
        const trail = TRAILING.exec(href);
        if (trail) href = href.slice(0, href.length - trail[0].length);
        out.push({ t: "link", href });
        last = start + href.length;
      }
    }
    if (last < line.length) out.push({ t: "text", v: line.slice(last) });
  });
  return out;
}

/** "@[Name](id)" for a composer insert. */
export function mentionToken(user: Pick<TeamUser, "id" | "name">): string {
  return `@[${user.name}](${user.id})`;
}

/** The "@query" the caret is on, when the writer is picking a person; null otherwise. */
export function mentionQuery(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([^\s@[\]()]{0,40})$/.exec(before);
  if (!m) return null;
  const start = caret - m[2].length - 1;
  return { start, q: m[2] };
}

/** Puts the mention in place of the "@query" and says where the caret lands. */
export function insertMention(text: string, caret: number, user: Pick<TeamUser, "id" | "name">): { text: string; caret: number } {
  const q = mentionQuery(text, caret);
  const start = q ? q.start : caret;
  const token = mentionToken(user) + " ";
  const next = text.slice(0, start) + token + text.slice(caret);
  return { text: next, caret: start + token.length };
}

/** People whose name starts with (or contains) the query, the assistant last. */
export function matchUsers(users: TeamUser[], q: string, limit = 6): TeamUser[] {
  const needle = q.trim().toLowerCase();
  const all = [...users, LEVEL_AI];
  const starts = all.filter((u) => u.name.toLowerCase().startsWith(needle));
  const contains = all.filter((u) => !starts.includes(u) && u.name.toLowerCase().includes(needle));
  return [...starts, ...contains].slice(0, limit);
}

/** Does the body ask the assistant? The question without its mention, or null. */
export function aiQuestion(body: string): string | null {
  if (!new RegExp(`@\\[[^\\]]+\\]\\(${LEVEL_AI.id}\\)`).test(body)) return null;
  return body
    .replace(MENTION_RE, (all, _name, id) => (id === LEVEL_AI.id ? "" : all))
    .replace(/\s+/g, " ")
    .trim();
}

/* ─────────────── Grouping ─────────────── */

export type Row =
  | { kind: "day"; key: string; at: number }
  | { kind: "unread"; key: string }
  | { kind: "message"; key: string; message: Message; collapsed: boolean };

export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The rows of a message list: a divider at every new day, "New messages" before the first unread
 * message by someone else, and messages, collapsed under the previous one when the same person
 * wrote both within five minutes (system messages and dividers break a run).
 */
export function groupMessages(messages: Message[], opts: { lastRead?: number | null; me?: string } = {}): Row[] {
  const rows: Row[] = [];
  let day = "";
  let prev: Message | null = null;
  let unreadShown = false;
  for (const m of messages) {
    const k = dayKey(m.at);
    let broke = false;
    if (k !== day) {
      rows.push({ kind: "day", key: `day-${k}`, at: m.at });
      day = k;
      broke = true;
    }
    if (!unreadShown && opts.lastRead != null && m.at > opts.lastRead && m.author.id !== opts.me && !m.deleted) {
      rows.push({ kind: "unread", key: "unread" });
      unreadShown = true;
      broke = true;
    }
    const collapsed =
      !broke &&
      !!prev &&
      prev.author.id === m.author.id &&
      m.kind !== "system" &&
      prev.kind !== "system" &&
      !prev.deleted &&
      m.at - prev.at <= COLLAPSE_MS &&
      m.at >= prev.at;
    rows.push({ kind: "message", key: m.id, message: m, collapsed });
    prev = m;
  }
  return rows;
}

/* ─────────────── Merging ─────────────── */

/** Changed rows into a cache: replaced by id, otherwise inserted; the cache stays sorted by time. */
export function mergeMessages(cache: Message[], changed: Message[]): Message[] {
  if (!changed.length) return cache;
  const byId = new Map(cache.map((m) => [m.id, m]));
  let touched = false;
  for (const m of changed) {
    const was = byId.get(m.id);
    if (was && JSON.stringify(was) === JSON.stringify(m)) continue;
    byId.set(m.id, m);
    touched = true;
  }
  if (!touched) return cache;
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The sync's counts onto the channel list; channels the sync does not name keep theirs. */
export function mergeChannels(channels: Channel[], sync: TeamSync["channels"]): Channel[] {
  if (!sync.length) return channels;
  const by = new Map(sync.map((c) => [c.id, c]));
  let touched = false;
  const next = channels.map((c) => {
    const s = by.get(c.id);
    if (!s) return c;
    if (s.unread === c.unread && s.mentioned === c.mentioned && s.lastAt === c.lastAt) return c;
    touched = true;
    return { ...c, unread: s.unread, mentioned: s.mentioned, lastAt: s.lastAt };
  });
  return touched ? next : channels;
}

/** A channel read to the end: nothing unread, nobody waiting. */
export function readChannel(channels: Channel[], id: string): Channel[] {
  return channels.map((c) => (c.id === id && (c.unread || c.mentioned) ? { ...c, unread: 0, mentioned: false } : c));
}

/** Unread messages across channels (the badge, until the next sync says otherwise). */
export function unreadOf(channels: Channel[], unseenNotifications = 0): number {
  return channels.reduce((n, c) => n + (c.archived ? 0 : c.unread), 0) + unseenNotifications;
}

export interface ChannelGroups {
  general: Channel[];
  clients: Channel[];
  projects: Channel[];
  dms: Channel[];
  groups: Channel[];
}

/** The navigation's sections, archived channels left out, the most recent first within a section. */
export function groupChannels(channels: Channel[]): ChannelGroups {
  const g: ChannelGroups = { general: [], clients: [], projects: [], dms: [], groups: [] };
  const recent = (a: Channel, b: Channel) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.name.localeCompare(b.name);
  for (const c of channels) {
    if (c.archived) continue;
    if (c.kind === "general") g.general.push(c);
    else if (c.kind === "client") g.clients.push(c);
    else if (c.kind === "project") g.projects.push(c);
    else if (c.kind === "dm") g.dms.push(c);
    else g.groups.push(c);
  }
  g.clients.sort((a, b) => a.name.localeCompare(b.name));
  g.projects.sort(recent);
  g.dms.sort(recent);
  g.groups.sort(recent);
  return g;
}

/** A dm is named after the other person; a group after its members when it has no name. */
export function channelTitle(c: Channel, me?: string): string {
  if (c.kind === "dm" && c.members?.length) {
    const other = c.members.find((m) => m.id !== me) ?? c.members[0];
    return other?.name ?? c.name;
  }
  if (c.kind === "group" && !c.name && c.members?.length) return c.members.filter((m) => m.id !== me).map((m) => m.name.split(/\s+/)[0]).join(", ");
  return c.name;
}

/* ─────────────── Avatars ─────────────── */

/** A stable hue for a person, from their id. */
export function avatarHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const letters = parts.slice(0, 2).map((w) => Array.from(w)[0] ?? "");
  return letters.join("").toUpperCase();
}

/* ─────────────── Times ─────────────── */

/** "just now", "4 min ago", then the clock time today, then a short date. */
export function relativeTime(at: number, now = Date.now(), locale?: string): string {
  const diff = now - at;
  if (diff < 45_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  if (dayKey(at) === dayKey(now)) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(at);
}

export function clockTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}

export function fullTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/** "Today", "Yesterday", then "Monday, 20 October". */
export function dayLabel(at: number, now = Date.now(), locale?: string): string {
  const k = dayKey(at);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(now - 86_400_000)) return "Yesterday";
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: sameYear ? undefined : "numeric" }).format(at);
}

export type DueState = "overdue" | "today" | "soon" | "later";

/** Where a due date stands against today (dates are "YYYY-MM-DD"). */
export function dueState(due: string | null | undefined, now = Date.now()): DueState | null {
  if (!due) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "soon";
  return "later";
}

export function dueLabel(due: string | null | undefined, now = Date.now(), locale?: string): string {
  if (!due) return "";
  const s = dueState(due, now);
  if (s === "today") return "Today";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due);
  if (!m) return due;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((d.getTime() - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: new Date(now).getFullYear() === d.getFullYear() ? undefined : "numeric" }).format(d);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The first line of a text, cut to a length, for a title. */
export function firstLine(text: string, max = 80): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Sixty everyday emoji for the "more" grid; no library, no network. */
export const EMOJI_GRID = [
  "😀", "😄", "😁", "😂", "🤣", "😊", "😍", "🥰", "😘", "😎",
  "🤩", "🥳", "😏", "😅", "🙃", "🤔", "🤨", "😐", "😬", "🙄",
  "😢", "😭", "😤", "😱", "🤯", "😴", "🤒", "🤗", "🤝", "👋",
  "👍", "👎", "👏", "🙌", "🙏", "💪", "✌️", "🤞", "👀", "💯",
  "🔥", "✨", "⭐", "🎉", "🎊", "❤️", "🧡", "💛", "💚", "💙",
  "💜", "🖤", "💔", "✅", "❌", "⚠️", "❓", "💡", "📌", "🚀",
];
