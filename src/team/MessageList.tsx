/**
 * The messages of a channel or a thread: day dividers that stick, "New messages", runs by the
 * same person collapsed under one avatar, a hover toolbar, reactions, the thread's reply count,
 * sending / failed states on your own, and a drop zone for files.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CheckCheck, Clock, Link2, MessageSquare, Pencil, Pin, Smile, SquareCheck, Trash2 } from "lucide-react";
import type { TeamUser } from "@shared/team";
import { Avatar } from "./Avatar";
import { clockTime, dayLabel, fullTime, groupMessages, LEVEL_AI, relativeTime, type Row } from "@shared/team-ui";
import { Attachments, CreativeCard, MessageBody } from "./MessageBody";
import { EmojiPicker, MessageSkeleton } from "./ui";
import type { LocalMessage } from "./useTeam";

export interface MessageActions {
  onReact: (m: LocalMessage, emoji: string) => void;
  onReply?: (m: LocalMessage) => void;
  onPin: (m: LocalMessage) => void;
  onEdit: (m: LocalMessage) => void;
  onDelete: (m: LocalMessage) => void;
  onTask: (m: LocalMessage) => void;
  onCopyLink: (m: LocalMessage) => void;
  onOpenCreative: (batch: string, post: number) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}

export function MessageList({
  messages,
  me,
  users,
  lastRead,
  hasMore,
  loading,
  loaded,
  onLoadMore,
  actions,
  onDropFiles,
  inThread = false,
  empty,
  header,
  highlight,
}: {
  messages: LocalMessage[];
  me: TeamUser;
  users: TeamUser[];
  lastRead: number | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  onLoadMore: () => void;
  actions: MessageActions;
  onDropFiles: (files: File[]) => void;
  inThread?: boolean;
  empty: ReactNode;
  /** Pinned at the top of the list (a thread's root). */
  header?: ReactNode;
  /** A message to scroll to and light up once. */
  highlight?: string | null;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [away, setAway] = useState(false);
  const rows = groupMessages(messages, { lastRead, me: me.id });
  const lastOwn = [...messages].reverse().find((m) => m.author.id === me.id && !m.local && !m.deleted)?.id;

  // Before the list grows, remember where we were; after, keep the bottom (or the place).
  const count = messages.length;
  const firstId = messages[0]?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current) {
      el.scrollTop = el.scrollHeight - keep.current.height + keep.current.top;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [count, firstId, loaded]);

  useLayoutEffect(() => {
    if (!highlight) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-id="${highlight}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("lit");
    const t = setTimeout(() => el.classList.remove("lit"), 2200);
    return () => clearTimeout(t);
  }, [highlight, loaded]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = fromBottom < 48;
    setAway(fromBottom > 320);
    if (el.scrollTop < 80 && hasMore && !loading) {
      keep.current = { height: el.scrollHeight, top: el.scrollTop };
      onLoadMore();
    }
  }, [hasMore, loading, onLoadMore]);

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) onDropFiles(files);
  };

  return (
    <div
      className={`tm-list-wrap ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={drop}
    >
      <div ref={scroller} className="tm-list" onScroll={onScroll}>
        {header}
        {!loaded && loading && <MessageSkeleton />}
        {loaded && hasMore && (
          <div className="tm-more">
            {loading ? <span className="tm-muted">Loading earlier messages…</span> : <button type="button" className="tm-link-btn" onClick={() => { keep.current = scroller.current ? { height: scroller.current.scrollHeight, top: scroller.current.scrollTop } : null; onLoadMore(); }}>Earlier messages</button>}
          </div>
        )}
        {loaded && !messages.length && empty}
        {rows.map((r) => (
          <RowView key={r.key} row={r} me={me} users={users} actions={actions} inThread={inThread} showTicks={r.kind === "message" && r.message.id === lastOwn} />
        ))}
      </div>
      {away && (
        <button
          type="button"
          className="tm-jump"
          onClick={() => {
            stick.current = true;
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown size={14} /> Latest
        </button>
      )}
      {dragging && (
        <div className="tm-drop" aria-hidden="true">
          <span>Drop to attach</span>
        </div>
      )}
    </div>
  );
}

function RowView({ row, me, users, actions, inThread, showTicks }: { row: Row; me: TeamUser; users: TeamUser[]; actions: MessageActions; inThread: boolean; showTicks: boolean }) {
  if (row.kind === "day")
    return (
      <div className="tm-day" role="separator">
        <span>{dayLabel(row.at)}</span>
      </div>
    );
  if (row.kind === "unread")
    return (
      <div className="tm-unread-line" role="separator">
        <span>New messages</span>
      </div>
    );
  return <MessageItem m={row.message} collapsed={row.collapsed} me={me} users={users} actions={actions} inThread={inThread} showTicks={showTicks} />;
}

export function MessageItem({ m, collapsed, me, users, actions, inThread, showTicks, plain = false }: { m: LocalMessage; collapsed: boolean; me: TeamUser; users: TeamUser[]; actions: MessageActions; inThread: boolean; showTicks: boolean; /** No toolbar (a search result, a pin). */ plain?: boolean }) {
  const [picker, setPicker] = useState(false);
  const own = m.author.id === me.id;
  const ai = m.author.id === LEVEL_AI.id;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? (id === me.id ? "you" : "someone");

  if (m.kind === "system" && !m.ref?.preview) {
    return (
      <div className="tm-system" data-id={m.id}>
        <MessageBody body={m.body} me={me.id} />
        <time dateTime={new Date(m.at).toISOString()}>{clockTime(m.at)}</time>
      </div>
    );
  }

  return (
    <article className={`tm-msg ${collapsed ? "collapsed" : ""} ${own ? "own" : ""} ${m.pending ? `pending ${m.pending}` : ""} ${m.local ? "local" : ""} ${m.pinned ? "pinned" : ""} ${ai ? "ai" : ""} ${m.kind === "system" ? "anchor" : ""}`} data-id={m.id}>
      <div className="tm-msg-side">{collapsed ? <time className="tm-msg-hovertime">{clockTime(m.at)}</time> : <Avatar user={m.author} size={34} />}</div>
      <div className="tm-msg-main">
        {!collapsed && (
          <header className="tm-msg-head">
            <b dir="auto">{m.author.name}</b>
            {ai && <span className="tm-pill ai">read-only assistant</span>}
            <time dateTime={new Date(m.at).toISOString()} title={fullTime(m.at)}>
              {relativeTime(m.at)}
            </time>
            {m.pinned && (
              <span className="tm-msg-flag" title="Pinned">
                <Pin size={11} /> Pinned
              </span>
            )}
          </header>
        )}
        {m.deleted ? (
          <p className="tm-body deleted">This message was deleted.</p>
        ) : (
          <>
            {m.body && <MessageBody body={m.body} me={me.id} />}
            {m.attachments?.length > 0 && <Attachments items={m.attachments} />}
            {m.ref?.preview && <CreativeCard preview={m.ref.preview} onOpen={m.ref.batch && m.ref.post !== undefined ? () => actions.onOpenCreative(m.ref!.batch!, m.ref!.post!) : undefined} />}
            {m.items && m.items.length > 0 && <AiItems items={m.items} onOpenCreative={actions.onOpenCreative} />}
            {(m.edited || m.pending || (showTicks && own)) && (
              <span className="tm-msg-meta">
                {m.edited ? <span title={fullTime(m.edited)}>edited</span> : null}
                {m.pending === "sending" && (
                  <span className="tm-state">
                    <Clock size={11} /> Sending…
                  </span>
                )}
                {m.pending === "failed" && (
                  <span className="tm-state failed">
                    Not sent ·{" "}
                    <button type="button" className="tm-link-btn" onClick={() => actions.onRetry(m.id)}>
                      Retry
                    </button>{" "}
                    ·{" "}
                    <button type="button" className="tm-link-btn" onClick={() => actions.onDiscard(m.id)}>
                      Discard
                    </button>
                  </span>
                )}
                {!m.pending && showTicks && own && !m.local && (
                  <span className="tm-state sent" title="Sent">
                    <CheckCheck size={12} />
                  </span>
                )}
              </span>
            )}
            {m.reactions.length > 0 && (
              <div className="tm-reactions">
                {m.reactions.map((r) => (
                  <button key={r.emoji} type="button" className={`tm-reaction ${r.users.includes(me.id) ? "mine" : ""}`} onClick={() => actions.onReact(m, r.emoji)} title={r.users.map(nameOf).join(", ")} disabled={!!m.pending || m.local}>
                    <span>{r.emoji}</span>
                    <b>{r.users.length}</b>
                  </button>
                ))}
                {!plain && !m.local && (
                  <span className="tm-emoji-anchor">
                    <button type="button" className="tm-reaction add" onClick={() => setPicker(true)} aria-label="Add a reaction" disabled={!!m.pending}>
                      <Smile size={13} />
                    </button>
                    {picker && <EmojiPicker onClose={() => setPicker(false)} onPick={(e) => { setPicker(false); actions.onReact(m, e); }} />}
                  </span>
                )}
              </div>
            )}
            {!inThread && m.replies > 0 && actions.onReply && (
              <button type="button" className="tm-thread-link" onClick={() => actions.onReply!(m)}>
                <MessageSquare size={13} />
                {m.replies} {m.replies === 1 ? "reply" : "replies"}
                {m.lastReplyAt ? <small>· last {relativeTime(m.lastReplyAt)}</small> : null}
              </button>
            )}
          </>
        )}
      </div>
      {!plain && !m.deleted && !m.pending && !m.local && (
        <div className="tm-tools" role="toolbar" aria-label="Message actions">
          <span className="tm-emoji-anchor">
            <button type="button" className="tm-icon" title="React" aria-label="React" onClick={() => setPicker(true)}>
              <Smile size={15} />
            </button>
            {picker && m.reactions.length === 0 && <EmojiPicker onClose={() => setPicker(false)} onPick={(e) => { setPicker(false); actions.onReact(m, e); }} />}
          </span>
          {!inThread && actions.onReply && (
            <button type="button" className="tm-icon" title="Reply in thread" aria-label="Reply in thread" onClick={() => actions.onReply!(m)}>
              <MessageSquare size={15} />
            </button>
          )}
          <button type="button" className={`tm-icon ${m.pinned ? "on" : ""}`} title={m.pinned ? "Unpin" : "Pin"} aria-label={m.pinned ? "Unpin" : "Pin"} onClick={() => actions.onPin(m)}>
            <Pin size={15} />
          </button>
          <button type="button" className="tm-icon" title="Make a task" aria-label="Make a task" onClick={() => actions.onTask(m)}>
            <SquareCheck size={15} />
          </button>
          {own && m.kind !== "system" && (
            <button type="button" className="tm-icon" title="Edit" aria-label="Edit" onClick={() => actions.onEdit(m)}>
              <Pencil size={15} />
            </button>
          )}
          {(own || me.role === "admin") && m.kind !== "system" && (
            <button type="button" className="tm-icon danger" title="Delete" aria-label="Delete" onClick={() => actions.onDelete(m)}>
              <Trash2 size={15} />
            </button>
          )}
          <button type="button" className="tm-icon" title="Copy link" aria-label="Copy link" onClick={() => actions.onCopyLink(m)}>
            <Link2 size={15} />
          </button>
        </div>
      )}
    </article>
  );
}

/** The assistant's items (tasks, posts, creatives) as compact rows; shapes vary, so it reads what it can. */
function AiItems({ items, onOpenCreative }: { items: unknown[]; onOpenCreative: (batch: string, post: number) => void }) {
  return (
    <ul className="tm-ai-items">
      {items.slice(0, 20).map((raw, i) => {
        const it = (raw ?? {}) as Record<string, unknown>;
        const title = String(it.title ?? it.name ?? it.text ?? it.label ?? JSON.stringify(raw)).slice(0, 140);
        const where = [it.clientName ?? it.client, it.batchName ?? it.where, it.status, it.due ? `due ${it.due}` : null].filter(Boolean).join(" · ");
        const batch = typeof it.batch === "string" ? it.batch : null;
        const post = typeof it.post === "number" ? it.post : null;
        return (
          <li key={i}>
            {batch && post !== null ? (
              <button type="button" className="tm-ai-item" onClick={() => onOpenCreative(batch, post)}>
                <b dir="auto">{title}</b>
                {where && <small>{where}</small>}
              </button>
            ) : (
              <span className="tm-ai-item">
                <b dir="auto">{title}</b>
                {where && <small>{where}</small>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
