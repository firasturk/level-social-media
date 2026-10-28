/**
 * Team state: one provider around the studio holds the people, channels, message caches, tasks
 * counts and notifications, and keeps them fresh by polling /api/team/sync (4 s while Team is
 * open, 20 s for the badge, paused while the tab is hidden, backing off after a failure). The
 * view (which channel, which pane) and the layout live here too, so the panel, the split pane
 * and the full page are the same conversation moved around the studio.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ApiError, del, get, post, put, uploadForm } from "@/api";
import type { Attachment, Channel, Message, MessageRef, Notification, Review, ReviewStatus, Task, TeamBootstrap, TeamSync, TeamUser } from "@shared/team";
import { TEAM_API } from "@shared/team";
import { aiQuestion, LEVEL_AI, mergeChannels, mergeMessages, nextBackoff, nextCursor, readChannel, SYNC_FAST, SYNC_SLOW, unreadOf } from "@shared/team-ui";

export type TeamLayout = "panel" | "split" | "full";
const LAYOUT_KEY = "lsm-team-layout";
const ENTER_KEY = "lsm-team-enter";

export type Pane =
  | { kind: "none" }
  | { kind: "thread"; root: string; version?: string | null }
  | { kind: "task"; id: string }
  | { kind: "pins" }
  | { kind: "search"; q: string }
  | { kind: "newTask"; prefill: TaskDraft };

export interface TaskDraft {
  title?: string;
  description?: string;
  assignee?: string | null;
  client?: string | null;
  batch?: string | null;
  post?: number | null;
  due?: string | null;
  priority?: Task["priority"];
  status?: Task["status"];
  sourceMessage?: string | null;
}

export interface TeamView {
  section: "chat" | "tasks";
  channel: string | null;
  pane: Pane;
}

/** A message on the page: the server's row, or one of ours still on its way (or never stored). */
export type LocalMessage = Message & { pending?: "sending" | "failed"; local?: boolean; items?: unknown[] };

interface ChannelCache {
  messages: LocalMessage[];
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  /** Where "New messages" starts: the last read stamp when the channel was opened. */
  lastRead: number | null;
}
interface ThreadCache {
  root: Message | null;
  replies: LocalMessage[];
  loaded: boolean;
}

export interface SendArgs {
  channel: string;
  body: string;
  thread?: string | null;
  ref?: MessageRef | null;
  attachments?: Attachment[];
  kind?: "text" | "voice";
}

export interface TaskFilters {
  mine?: boolean;
  client?: string;
  status?: Task["status"] | "";
  priority?: Task["priority"] | "";
  due?: "overdue" | "week" | "all";
  batch?: string;
}

export interface TeamApi {
  ready: boolean;
  error: string | null;
  me: TeamUser | null;
  users: TeamUser[];
  channels: Channel[];
  unread: number;
  tasksOpen: number;
  notifications: Notification[];
  online: boolean;
  reconnecting: boolean;

  layout: TeamLayout;
  setLayout: (l: TeamLayout) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  enterSends: boolean;
  setEnterSends: (v: boolean) => void;

  view: TeamView;
  setView: (patch: Partial<TeamView> | ((v: TeamView) => TeamView)) => void;
  openChannel: (id: string) => void;
  openThread: (root: string, version?: string | null) => void;
  openTask: (id: string) => void;
  closePane: () => void;
  /** Opens the studio on a creative (the Workspace implements it). */
  openCreative: (batch: string, post: number) => void;
  registerOpenCreative: (fn: ((batch: string, post: number) => void) | null) => void;
  /** The Discuss thread of a post, in the compact panel (or the current layout). */
  discuss: (batch: string, post: number, opts?: { version?: string | null }) => Promise<void>;

  cache: (channel: string) => ChannelCache | undefined;
  loadChannel: (channel: string) => Promise<void>;
  loadMore: (channel: string) => Promise<void>;
  thread: (root: string) => ThreadCache | undefined;
  loadThread: (root: string) => Promise<void>;
  messageById: (id: string) => LocalMessage | undefined;

  send: (args: SendArgs) => Promise<void>;
  retry: (tmpId: string) => Promise<void>;
  discard: (tmpId: string) => void;
  edit: (id: string, body: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  react: (id: string, emoji: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  upload: (file: File, onProgress?: (sent: number, of: number) => void, duration?: number) => Promise<Attachment>;
  markRead: (channel: string) => void;
  pins: (channel: string) => Promise<Message[]>;
  search: (q: string, channel?: string) => Promise<Message[]>;
  createChannel: (body: { kind: "project" | "dm" | "group"; name?: string; client?: string | null; members: string[] }) => Promise<Channel>;
  archiveChannel: (id: string, archived: boolean) => Promise<void>;

  listTasks: (f: TaskFilters) => Promise<Task[]>;
  getTask: (id: string) => Promise<Task>;
  createTask: (draft: TaskDraft) => Promise<Task>;
  updateTask: (id: string, patch: TaskDraft) => Promise<Task>;
  commentTask: (id: string, text: string) => Promise<Task>;
  /** A task changed somewhere: lists re-read themselves. */
  tasksStamp: number;

  listReviews: (batch: string) => Promise<Review[]>;
  postReview: (body: { batch: string; post: number; status: ReviewStatus; note?: string; version?: string | null }) => Promise<Review>;
  reviewsStamp: number;

  markSeen: (ids?: string[]) => Promise<void>;
  refreshNow: () => void;
}

const TeamContext = createContext<TeamApi | null>(null);

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

const api = (p: string) => `${TEAM_API}${p}`;
const tmpId = () => `tmp-${crypto.randomUUID()}`;

export function TeamProvider({ user, children }: { user: TeamUser; children: ReactNode }) {
  const [me, setMe] = useState<TeamUser | null>(null);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tasksOpen, setTasksOpen] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [caches, setCaches] = useState<Record<string, ChannelCache>>({});
  const [threads, setThreads] = useState<Record<string, ThreadCache>>({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [reconnecting, setReconnecting] = useState(false);
  const [tasksStamp, setTasksStamp] = useState(0);
  const [reviewsStamp, setReviewsStamp] = useState(0);

  const [layout, setLayoutState] = useState<TeamLayout>(() => {
    const v = stored(LAYOUT_KEY);
    return v === "split" || v === "full" || v === "panel" ? v : "panel";
  });
  const setLayout = useCallback((l: TeamLayout) => {
    setLayoutState(l);
    store(LAYOUT_KEY, l);
  }, []);
  const [open, setOpen] = useState(false);
  const [enterSends, setEnterSendsState] = useState(() => stored(ENTER_KEY) !== "newline");
  const setEnterSends = useCallback((v: boolean) => {
    setEnterSendsState(v);
    store(ENTER_KEY, v ? "send" : "newline");
  }, []);

  const [view, setViewState] = useState<TeamView>({ section: "chat", channel: null, pane: { kind: "none" } });
  const setView = useCallback((patch: Partial<TeamView> | ((v: TeamView) => TeamView)) => {
    setViewState((v) => (typeof patch === "function" ? patch(v) : { ...v, ...patch }));
  }, []);

  const cursor = useRef(0);
  const delay = useRef(SYNC_FAST);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const viewRef = useRef(view);
  viewRef.current = view;
  const cachesRef = useRef(caches);
  cachesRef.current = caches;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const pendingBodies = useRef(new Map<string, SendArgs>());
  const readSent = useRef(new Map<string, number>());
  const openCreativeRef = useRef<((batch: string, post: number) => void) | null>(null);

  /* ─────────────── Caches ─────────────── */

  const patchCache = useCallback((channel: string, fn: (c: ChannelCache) => ChannelCache) => {
    setCaches((all) => {
      const was = all[channel] ?? { messages: [], hasMore: false, loaded: false, loading: false, lastRead: null };
      const next = fn(was);
      return next === was ? all : { ...all, [channel]: next };
    });
  }, []);
  const patchThread = useCallback((root: string, fn: (t: ThreadCache) => ThreadCache) => {
    setThreads((all) => {
      const was = all[root] ?? { root: null, replies: [], loaded: false };
      const next = fn(was);
      return next === was ? all : { ...all, [root]: next };
    });
  }, []);

  /** A server row lands where it belongs: its channel's list or its thread, and the root's reply count. */
  const applyMessages = useCallback(
    (rows: Message[]) => {
      if (!rows.length) return;
      const tops = rows.filter((m) => !m.thread);
      const replies = rows.filter((m) => m.thread);
      if (tops.length) {
        setCaches((all) => {
          let next = all;
          for (const m of tops) {
            const c = next[m.channel];
            if (!c?.loaded) continue;
            const merged = mergeMessages(c.messages, [m]);
            if (merged !== c.messages) next = { ...next, [m.channel]: { ...c, messages: merged } };
          }
          return next;
        });
      }
      if (replies.length) {
        const fresh: Message[] = [];
        setThreads((all) => {
          let next = all;
          for (const m of replies) {
            const t = next[m.thread!];
            if (!t?.loaded) {
              fresh.push(m);
              continue;
            }
            if (!t.replies.some((r) => r.id === m.id)) fresh.push(m);
            const merged = mergeMessages(t.replies, [m]);
            if (merged !== t.replies) next = { ...next, [m.thread!]: { ...t, replies: merged } };
          }
          return next;
        });
        // The root's reply count, when the sync did not carry the root itself.
        setCaches((all) => {
          let next = all;
          for (const m of fresh) {
            if (tops.some((t) => t.id === m.thread)) continue;
            const c = next[m.channel];
            if (!c?.loaded) continue;
            const i = c.messages.findIndex((x) => x.id === m.thread);
            if (i < 0) continue;
            const root = c.messages[i];
            if ((root.lastReplyAt ?? 0) >= m.at) continue;
            const msgs = c.messages.slice();
            msgs[i] = { ...root, replies: (root.replies ?? 0) + 1, lastReplyAt: m.at };
            next = { ...next, [m.channel]: { ...c, messages: msgs } };
          }
          return next;
        });
        setThreads((all) => {
          let next = all;
          for (const m of fresh) {
            const t = next[m.thread!];
            if (!t?.root || (t.root.lastReplyAt ?? 0) >= m.at) continue;
            next = { ...next, [m.thread!]: { ...t, root: { ...t.root, replies: (t.root.replies ?? 0) + 1, lastReplyAt: m.at } } };
          }
          return next;
        });
      }
    },
    [],
  );

  /* ─────────────── Sync ─────────────── */

  const applySync = useCallback(
    (s: TeamSync) => {
      cursor.current = nextCursor(cursor.current, s);
      applyMessages(s.messages ?? []);
      if (s.channels?.length) setChannels((cs) => mergeChannels(cs, s.channels));
      if (s.notifications?.length) {
        setNotifications((ns) => {
          const by = new Map(ns.map((n) => [n.id, n]));
          for (const n of s.notifications) by.set(n.id, n);
          return [...by.values()].sort((a, b) => b.at - a.at).slice(0, 200);
        });
      }
      setTasksOpen(s.tasksOpen ?? 0);
      // A message that arrived while its channel is on screen is read as it lands.
      const v = viewRef.current;
      if (v.channel && openRef.current && !document.hidden) {
        const mine = (s.messages ?? []).filter((m) => m.channel === v.channel && !m.thread);
        if (mine.length) setChannels((cs) => readChannel(cs, v.channel!));
      }
    },
    [applyMessages],
  );

  const tickRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback((ms?: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (document.hidden) return;
    const wait = ms ?? (openRef.current ? delay.current : Math.max(delay.current, SYNC_SLOW));
    timer.current = setTimeout(() => void tickRef.current(), wait);
  }, []);

  const tick = useCallback(async () => {
    if (syncing.current || !cursor.current) {
      schedule();
      return;
    }
    syncing.current = true;
    try {
      const s = await get<TeamSync>(api(`/sync?cursor=${cursor.current}`));
      applySync(s);
      delay.current = SYNC_FAST;
      setReconnecting(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        window.location.reload();
        return;
      }
      setReconnecting(true);
      delay.current = nextBackoff(delay.current);
    } finally {
      syncing.current = false;
      schedule();
    }
  }, [applySync, schedule]);
  tickRef.current = tick;

  const refreshNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void tick();
  }, [tick]);

  // Bootstrap once (again after a failure); the loop starts from its cursor.
  const [bootAttempt, setBootAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await get<TeamBootstrap>(api("/bootstrap"));
        if (!alive) return;
        setMe(b.me);
        setUsers(b.users);
        setChannels(b.channels);
        setTasksOpen(b.tasksOpen);
        cursor.current = b.cursor || Date.now();
        setReady(true);
        setError(null);
        try {
          const n = await get<{ notifications: Notification[] }>(api("/notifications"));
          if (alive) setNotifications(n.notifications ?? []);
        } catch {
          /* the sync brings new ones */
        }
        schedule();
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          window.location.reload();
          return;
        }
        setError((e as Error).message || "Team could not load.");
        // Try again in a while.
        timer.current = setTimeout(() => {
          setError(null);
          setBootAttempt((a) => a + 1);
        }, 15000);
      }
    })();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [user.id, bootAttempt, schedule]);

  // Opening Team speeds the loop up and asks at once; a hidden tab pauses it, coming back resumes.
  useEffect(() => {
    if (!ready) return;
    if (open) refreshNow();
    else schedule();
  }, [open, ready, refreshNow, schedule]);
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      } else if (ready) refreshNow();
    };
    const up = () => {
      setOnline(true);
      if (ready) refreshNow();
    };
    const down = () => setOnline(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [ready, refreshNow]);

  /* ─────────────── Reading ─────────────── */

  const markRead = useCallback(
    (channel: string) => {
      const c = cachesRef.current[channel];
      const last = c?.messages.filter((m) => !m.pending && !m.local).at(-1)?.at ?? Date.now();
      const at = Math.max(last, Date.now());
      if ((readSent.current.get(channel) ?? 0) >= last) {
        setChannels((cs) => readChannel(cs, channel));
        return;
      }
      readSent.current.set(channel, last);
      setChannels((cs) => readChannel(cs, channel));
      void post(api(`/channels/${encodeURIComponent(channel)}/read`), { at }).catch(() => readSent.current.delete(channel));
    },
    [],
  );

  /* ─────────────── Loading ─────────────── */

  const loadChannel = useCallback(
    async (channel: string) => {
      const c = cachesRef.current[channel];
      if (c?.loaded || c?.loading) return;
      patchCache(channel, (x) => ({ ...x, loading: true }));
      try {
        const r = await get<{ messages: Message[]; hasMore: boolean }>(api(`/messages?channel=${encodeURIComponent(channel)}&limit=50`));
        const ch = channels.find((x) => x.id === channel);
        // Unread n: the divider sits before the last n messages by others.
        let lastRead: number | null = null;
        if (ch && ch.unread > 0) {
          const others = r.messages.filter((m) => m.author.id !== user.id);
          const first = others[Math.max(0, others.length - ch.unread)];
          if (first) lastRead = first.at - 1;
        }
        patchCache(channel, (x) => ({ ...x, messages: mergeMessages(r.messages, x.messages.filter((m) => m.pending || m.local)), hasMore: !!r.hasMore, loaded: true, loading: false, lastRead }));
      } catch (e) {
        patchCache(channel, (x) => ({ ...x, loading: false }));
        toast.error((e as Error).message);
      }
    },
    [channels, patchCache, user.id],
  );

  const loadMore = useCallback(
    async (channel: string) => {
      const c = cachesRef.current[channel];
      if (!c?.loaded || c.loading || !c.hasMore) return;
      const oldest = c.messages.find((m) => !m.pending && !m.local)?.at;
      if (!oldest) return;
      patchCache(channel, (x) => ({ ...x, loading: true }));
      try {
        const r = await get<{ messages: Message[]; hasMore: boolean }>(api(`/messages?channel=${encodeURIComponent(channel)}&before=${oldest}&limit=50`));
        patchCache(channel, (x) => ({ ...x, messages: mergeMessages(x.messages, r.messages), hasMore: !!r.hasMore, loading: false }));
      } catch (e) {
        patchCache(channel, (x) => ({ ...x, loading: false }));
        toast.error((e as Error).message);
      }
    },
    [patchCache],
  );

  const loadThread = useCallback(
    async (root: string) => {
      try {
        const r = await get<{ root: Message; replies: Message[] }>(api(`/thread?message=${encodeURIComponent(root)}`));
        patchThread(root, (t) => ({ root: r.root, replies: mergeMessages(r.replies, t.replies.filter((m) => m.pending || m.local)), loaded: true }));
        applyMessages([r.root]);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [applyMessages, patchThread],
  );

  /* ─────────────── Writing ─────────────── */

  const place = useCallback(
    (m: LocalMessage) => {
      if (m.thread) patchThread(m.thread, (t) => ({ ...t, replies: mergeMessages(t.replies, [m]) }));
      else patchCache(m.channel, (c) => ({ ...c, messages: mergeMessages(c.messages, [m]) }));
    },
    [patchCache, patchThread],
  );
  const unplace = useCallback(
    (m: Pick<LocalMessage, "id" | "channel" | "thread">) => {
      if (m.thread) patchThread(m.thread, (t) => ({ ...t, replies: t.replies.filter((x) => x.id !== m.id) }));
      else patchCache(m.channel, (c) => ({ ...c, messages: c.messages.filter((x) => x.id !== m.id) }));
    },
    [patchCache, patchThread],
  );

  const deliver = useCallback(
    async (id: string, args: SendArgs) => {
      try {
        const r = await post<{ message: Message }>(api("/messages"), {
          channel: args.channel,
          body: args.body,
          thread: args.thread ?? undefined,
          ref: args.ref ?? undefined,
          attachments: args.attachments?.map((a) => a.id),
          kind: args.kind ?? (args.attachments?.some((a) => a.kind === "voice") && !args.body.trim() ? "voice" : "text"),
        });
        pendingBodies.current.delete(id);
        unplace({ id, channel: args.channel, thread: args.thread ?? null });
        applyMessages([r.message]);
        if (!r.message.thread) markRead(args.channel);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) window.location.reload();
        const fail = (m: LocalMessage) => (m.id === id ? { ...m, pending: "failed" as const } : m);
        if (args.thread) patchThread(args.thread, (t) => ({ ...t, replies: t.replies.map(fail) }));
        else patchCache(args.channel, (c) => ({ ...c, messages: c.messages.map(fail) }));
      }
    },
    [applyMessages, markRead, patchCache, patchThread, unplace],
  );

  const send = useCallback(
    async (args: SendArgs) => {
      if (!me) return;
      const q = aiQuestion(args.body);
      const now = Date.now();
      if (q !== null) {
        // The assistant answers here only: the question and the answer are never stored.
        place({ id: `local-${now}`, channel: args.channel, thread: args.thread ?? null, author: me, kind: "text", body: args.body, attachments: [], mentions: [LEVEL_AI.id], reactions: [], replies: 0, pinned: false, at: now, local: true });
        try {
          const r = await post<{ answer: string; items?: unknown[] }>(api("/ai"), { q });
          place({ id: `local-${now + 1}`, channel: args.channel, thread: args.thread ?? null, author: LEVEL_AI, kind: "text", body: r.answer, attachments: [], mentions: [], reactions: [], replies: 0, pinned: false, at: now + 1, local: true, items: r.items });
        } catch (e) {
          place({ id: `local-${now + 1}`, channel: args.channel, thread: args.thread ?? null, author: LEVEL_AI, kind: "text", body: `I could not answer: ${(e as Error).message}`, attachments: [], mentions: [], reactions: [], replies: 0, pinned: false, at: now + 1, local: true });
        }
        return;
      }
      const id = tmpId();
      pendingBodies.current.set(id, args);
      place({
        id,
        channel: args.channel,
        thread: args.thread ?? null,
        author: me,
        kind: args.kind ?? "text",
        body: args.body,
        attachments: args.attachments ?? [],
        ref: args.ref ? { ...args.ref } : null,
        mentions: [],
        reactions: [],
        replies: 0,
        pinned: false,
        at: now,
        pending: "sending",
      });
      await deliver(id, args);
    },
    [deliver, me, place],
  );

  const retry = useCallback(
    async (id: string) => {
      const args = pendingBodies.current.get(id);
      if (!args) return;
      const back = (m: LocalMessage) => (m.id === id ? { ...m, pending: "sending" as const, at: Date.now() } : m);
      if (args.thread) patchThread(args.thread, (t) => ({ ...t, replies: t.replies.map(back) }));
      else patchCache(args.channel, (c) => ({ ...c, messages: c.messages.map(back) }));
      await deliver(id, args);
    },
    [deliver, patchCache, patchThread],
  );

  const discard = useCallback(
    (id: string) => {
      const args = pendingBodies.current.get(id);
      pendingBodies.current.delete(id);
      if (args) unplace({ id, channel: args.channel, thread: args.thread ?? null });
    },
    [unplace],
  );

  const edit = useCallback(
    async (id: string, body: string) => {
      const r = await put<{ message: Message }>(api(`/messages/${encodeURIComponent(id)}`), { body });
      applyMessages([r.message]);
    },
    [applyMessages],
  );

  const remove = useCallback(
    async (id: string) => {
      await del(api(`/messages/${encodeURIComponent(id)}`));
      const stub = (m: LocalMessage): LocalMessage => (m.id === id ? { ...m, deleted: true, body: "", attachments: [], reactions: [], ref: null } : m);
      setCaches((all) => Object.fromEntries(Object.entries(all).map(([k, c]) => [k, { ...c, messages: c.messages.map(stub) }])));
      setThreads((all) => Object.fromEntries(Object.entries(all).map(([k, t]) => [k, { ...t, replies: t.replies.map(stub), root: t.root && t.root.id === id ? stub(t.root) : t.root }])));
    },
    [],
  );

  const react = useCallback(
    async (id: string, emoji: string) => {
      if (!me) return;
      // Toggled at once; the server's row follows.
      const flip = (m: LocalMessage): LocalMessage => {
        if (m.id !== id) return m;
        const has = m.reactions.find((r) => r.emoji === emoji);
        let reactions = m.reactions;
        if (has && has.users.includes(me.id)) reactions = reactions.map((r) => (r.emoji === emoji ? { ...r, users: r.users.filter((u) => u !== me.id) } : r)).filter((r) => r.users.length);
        else if (has) reactions = reactions.map((r) => (r.emoji === emoji ? { ...r, users: [...r.users, me.id] } : r));
        else reactions = [...reactions, { emoji, users: [me.id] }];
        return { ...m, reactions };
      };
      setCaches((all) => Object.fromEntries(Object.entries(all).map(([k, c]) => [k, { ...c, messages: c.messages.map(flip) }])));
      setThreads((all) => Object.fromEntries(Object.entries(all).map(([k, t]) => [k, { ...t, replies: t.replies.map(flip), root: t.root ? flip(t.root) : t.root }])));
      try {
        const r = await post<{ message: Message }>(api(`/messages/${encodeURIComponent(id)}/react`), { emoji });
        applyMessages([r.message]);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [applyMessages, me],
  );

  const pin = useCallback(
    async (id: string, pinned: boolean) => {
      const r = await post<{ message: Message }>(api(`/messages/${encodeURIComponent(id)}/pin`), { pinned });
      applyMessages([r.message]);
    },
    [applyMessages],
  );

  const upload = useCallback(async (file: File, onProgress?: (sent: number, of: number) => void, duration?: number) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (duration !== undefined) fd.append("duration", String(Math.round(duration)));
    const r = await uploadForm<{ attachment: Attachment }>(api("/upload"), fd, onProgress);
    return r.attachment;
  }, []);

  const pins = useCallback(async (channel: string) => (await get<{ messages: Message[] }>(api(`/pins?channel=${encodeURIComponent(channel)}`))).messages ?? [], []);
  const search = useCallback(async (q: string, channel?: string) => (await get<{ messages: Message[] }>(api(`/search?q=${encodeURIComponent(q)}${channel ? `&channel=${encodeURIComponent(channel)}` : ""}&limit=50`))).messages ?? [], []);

  const createChannel = useCallback(async (body: { kind: "project" | "dm" | "group"; name?: string; client?: string | null; members: string[] }) => {
    const r = await post<{ channel: Channel }>(api("/channels"), body);
    setChannels((cs) => (cs.some((c) => c.id === r.channel.id) ? cs.map((c) => (c.id === r.channel.id ? r.channel : c)) : [...cs, r.channel]));
    return r.channel;
  }, []);
  const archiveChannel = useCallback(async (id: string, archived: boolean) => {
    const r = await post<{ channel: Channel }>(api(`/channels/${encodeURIComponent(id)}/archive`), { archived });
    setChannels((cs) => cs.map((c) => (c.id === id ? r.channel : c)));
  }, []);

  /* ─────────────── Tasks and reviews ─────────────── */

  const listTasks = useCallback(async (f: TaskFilters) => {
    const q = new URLSearchParams();
    if (f.mine) q.set("mine", "1");
    if (f.client) q.set("client", f.client);
    if (f.status) q.set("status", f.status);
    if (f.priority) q.set("priority", f.priority);
    if (f.due) q.set("due", f.due);
    if (f.batch) q.set("batch", f.batch);
    return (await get<{ tasks: Task[] }>(api(`/tasks?${q.toString()}`))).tasks ?? [];
  }, []);
  const getTask = useCallback(async (id: string) => (await get<{ task: Task }>(api(`/tasks/${encodeURIComponent(id)}`))).task, []);
  const createTask = useCallback(async (draft: TaskDraft) => {
    const r = await post<{ task: Task }>(api("/tasks"), draft);
    setTasksStamp((s) => s + 1);
    return r.task;
  }, []);
  const updateTask = useCallback(async (id: string, patch: TaskDraft) => {
    const r = await put<{ task: Task }>(api(`/tasks/${encodeURIComponent(id)}`), patch);
    setTasksStamp((s) => s + 1);
    return r.task;
  }, []);
  const commentTask = useCallback(async (id: string, text: string) => {
    const r = await post<{ task: Task }>(api(`/tasks/${encodeURIComponent(id)}/comment`), { text });
    setTasksStamp((s) => s + 1);
    return r.task;
  }, []);

  const listReviews = useCallback(async (batch: string) => (await get<{ reviews: Review[] }>(api(`/reviews?batch=${encodeURIComponent(batch)}`))).reviews ?? [], []);
  const postReview = useCallback(async (body: { batch: string; post: number; status: ReviewStatus; note?: string; version?: string | null }) => {
    const r = await post<{ review: Review }>(api("/reviews"), body);
    setReviewsStamp((s) => s + 1);
    setTasksStamp((s) => s + 1);
    return r.review;
  }, []);

  const markSeen = useCallback(async (ids?: string[]) => {
    setNotifications((ns) => ns.map((n) => (!ids || ids.includes(n.id) ? { ...n, seen: true } : n)));
    await post(api("/notifications/seen"), ids ? { ids } : {}).catch(() => undefined);
  }, []);

  /* ─────────────── Navigation ─────────────── */

  const openChannel = useCallback((id: string) => setViewState((v) => ({ section: "chat", channel: id, pane: v.pane.kind === "thread" || v.pane.kind === "pins" || v.pane.kind === "search" ? { kind: "none" } : v.pane })), []);
  const openThread = useCallback((root: string, version?: string | null) => setViewState((v) => ({ ...v, section: "chat", pane: { kind: "thread", root, version } })), []);
  const openTask = useCallback((id: string) => setViewState((v) => ({ ...v, pane: { kind: "task", id } })), []);
  const closePane = useCallback(() => setViewState((v) => ({ ...v, pane: { kind: "none" } })), []);
  const openCreative = useCallback((batch: string, post: number) => {
    if (openCreativeRef.current) openCreativeRef.current(batch, post);
    else toast.message("Open the month in the Studio to see this creative.");
  }, []);
  const registerOpenCreative = useCallback((fn: ((batch: string, post: number) => void) | null) => {
    openCreativeRef.current = fn;
  }, []);

  const discuss = useCallback(
    async (batch: string, post: number, opts?: { version?: string | null }) => {
      try {
        const r = await get<{ channel: Channel; message: Message }>(api(`/discuss?batch=${encodeURIComponent(batch)}&post=${post}`));
        setChannels((cs) => (cs.some((c) => c.id === r.channel.id) ? cs : [...cs, r.channel]));
        applyMessages([r.message]);
        patchThread(r.message.id, (t) => ({ ...t, root: r.message }));
        setViewState({ section: "chat", channel: r.channel.id, pane: { kind: "thread", root: r.message.id, version: opts?.version ?? null } });
        setOpen(true);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [applyMessages, patchThread],
  );

  const messageById = useCallback(
    (id: string): LocalMessage | undefined => {
      for (const c of Object.values(cachesRef.current)) {
        const m = c.messages.find((x) => x.id === id);
        if (m) return m;
      }
      for (const t of Object.values(threadsRef.current)) {
        if (t.root?.id === id) return t.root;
        const m = t.replies.find((x) => x.id === id);
        if (m) return m;
      }
      return undefined;
    },
    [],
  );

  const unread = useMemo(() => unreadOf(channels, notifications.filter((n) => !n.seen).length), [channels, notifications]);

  const value = useMemo<TeamApi>(
    () => ({
      ready,
      error,
      me,
      users,
      channels,
      unread,
      tasksOpen,
      notifications,
      online,
      reconnecting,
      layout,
      setLayout,
      open,
      setOpen,
      enterSends,
      setEnterSends,
      view,
      setView,
      openChannel,
      openThread,
      openTask,
      closePane,
      openCreative,
      registerOpenCreative,
      discuss,
      cache: (channel) => caches[channel],
      loadChannel,
      loadMore,
      thread: (root) => threads[root],
      loadThread,
      messageById,
      send,
      retry,
      discard,
      edit,
      remove,
      react,
      pin,
      upload,
      markRead,
      pins,
      search,
      createChannel,
      archiveChannel,
      listTasks,
      getTask,
      createTask,
      updateTask,
      commentTask,
      tasksStamp,
      listReviews,
      postReview,
      reviewsStamp,
      markSeen,
      refreshNow,
    }),
    [ready, error, me, users, channels, unread, tasksOpen, notifications, online, reconnecting, layout, setLayout, open, enterSends, setEnterSends, view, setView, openChannel, openThread, openTask, closePane, openCreative, registerOpenCreative, discuss, caches, loadChannel, loadMore, threads, loadThread, messageById, send, retry, discard, edit, remove, react, pin, upload, markRead, pins, search, createChannel, archiveChannel, listTasks, getTask, createTask, updateTask, commentTask, tasksStamp, listReviews, postReview, reviewsStamp, markSeen, refreshNow],
  );

  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function useTeam(): TeamApi {
  const v = useContext(TeamContext);
  if (!v) throw new Error("useTeam needs a TeamProvider around it.");
  return v;
}
