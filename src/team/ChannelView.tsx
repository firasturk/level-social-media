/**
 * One channel: its header (name, members, pins, search), its messages and the composer.
 * The thread pane and the task pane open beside it (or over it, on a phone).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Hash, Lock, MessagesSquare, Pin, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import type { Channel } from "@shared/team";
import { plainBody } from "@shared/team";
import { AvatarStack } from "./Avatar";
import { Composer, useDrafts } from "./Composer";
import { channelTitle, firstLine } from "@shared/team-ui";
import { MessageList, type MessageActions } from "./MessageList";
import { Empty } from "./ui";
import { useTeam, type LocalMessage } from "./useTeam";

/** The actions every message offers, wired to the provider; the same in a channel and in a thread. */
export function useMessageActions(onEdit: (m: LocalMessage) => void, inThread = false): MessageActions {
  const team = useTeam();
  return useMemo<MessageActions>(
    () => ({
      onReact: (m, emoji) => void team.react(m.id, emoji),
      onReply: inThread ? undefined : (m) => team.openThread(m.id),
      onPin: (m) => void team.pin(m.id, !m.pinned).catch((e: Error) => toast.error(e.message)),
      onEdit,
      onDelete: async (m) => {
        if (!(await askConfirm("Delete this message? A small “deleted” note stays in its place.", { ok: "Delete" }))) return;
        try {
          await team.remove(m.id);
        } catch (e) {
          toast.error((e as Error).message);
        }
      },
      onTask: (m) => {
        const ch = team.channels.find((c) => c.id === m.channel);
        const text = plainBody(m.body);
        team.setView({
          pane: {
            kind: "newTask",
            prefill: {
              title: m.ref?.preview ? `${m.ref.preview.title}: ${firstLine(text, 60) || "follow up"}` : firstLine(text, 80),
              description: text,
              client: ch?.client ?? null,
              batch: m.ref?.batch ?? null,
              post: m.ref?.post ?? null,
              sourceMessage: m.id,
            },
          },
        });
      },
      onCopyLink: (m) => {
        const url = `${window.location.origin}/team?channel=${encodeURIComponent(m.channel)}&message=${encodeURIComponent(m.thread ?? m.id)}${m.thread ? `&reply=${encodeURIComponent(m.id)}` : ""}`;
        navigator.clipboard
          ?.writeText(url)
          .then(() => toast.success("Link copied."))
          .catch(() => toast.message(url));
      },
      onOpenCreative: (batch, post) => team.openCreative(batch, post),
      onRetry: (id) => void team.retry(id),
      onDiscard: (id) => team.discard(id),
    }),
    [inThread, onEdit, team],
  );
}

export function channelIcon(c: Channel, size = 15) {
  if (c.kind === "dm") return <Users size={size} />;
  if (c.kind === "group") return <Lock size={size} />;
  if (c.kind === "project") return <MessagesSquare size={size} />;
  return <Hash size={size} />;
}

export function ChannelView({ channel, onBack, tools, highlight, compact = false }: { channel: Channel; onBack?: () => void; tools?: ReactNode; highlight?: string | null; compact?: boolean }) {
  const team = useTeam();
  const me = team.me!;
  const cache = team.cache(channel.id);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const drafts = useDrafts();

  const { loadChannel, markRead, open: teamOpen } = team;
  useEffect(() => {
    void loadChannel(channel.id);
  }, [channel.id, loadChannel]);
  useEffect(() => setEditing(null), [channel.id]);

  // Reading: whatever is on screen is read, now and as new messages land.
  const lastAt = cache?.messages.at(-1)?.at;
  const loaded = !!cache?.loaded;
  useEffect(() => {
    if (!loaded || !teamOpen || document.hidden) return;
    markRead(channel.id);
  }, [loaded, lastAt, channel.id, markRead, teamOpen]);

  const actions = useMessageActions(useCallback((m: LocalMessage) => setEditing(m), []));
  const messages = cache?.messages ?? [];
  const mine = [...messages].reverse().find((m) => m.author.id === me.id && !m.deleted && !m.pending && !m.local && m.kind !== "system");

  const offline = !team.online ? "You are offline. Messages can be sent when the connection is back." : null;
  const title = channelTitle(channel, me.id);
  const members = channel.members?.filter((m) => m.id !== me.id) ?? [];

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) team.setView({ pane: { kind: "search", q: q.trim() } });
  };

  return (
    <section className={`tm-channel ${compact ? "compact" : ""}`} aria-label={title}>
      <header className="tm-channel-head">
        {onBack && (
          <button type="button" className="tm-icon tm-back" onClick={onBack} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="tm-channel-title">
          <span className="tm-channel-icon">{channelIcon(channel)}</span>
          <h2 dir="auto">{title}</h2>
          {channel.kind === "client" && <span className="tm-pill soft">client</span>}
          {channel.kind === "project" && <span className="tm-pill soft">project</span>}
        </div>
        {members.length > 0 && <AvatarStack users={members} size={22} />}
        <div className="tm-channel-tools">
          {searching ? (
            <form className="tm-search" onSubmit={submitSearch}>
              <Search size={14} />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this channel" dir="auto" onKeyDown={(e) => e.key === "Escape" && (setSearching(false), setQ(""))} onBlur={() => !q && setSearching(false)} aria-label="Search this channel" />
            </form>
          ) : (
            <button type="button" className="tm-icon" title="Search" aria-label="Search" onClick={() => setSearching(true)}>
              <Search size={16} />
            </button>
          )}
          <button type="button" className={`tm-icon ${team.view.pane.kind === "pins" ? "on" : ""}`} title="Pinned messages" aria-label="Pinned messages" onClick={() => team.setView((v) => ({ ...v, pane: v.pane.kind === "pins" ? { kind: "none" } : { kind: "pins" } }))}>
            <Pin size={16} />
          </button>
          {tools}
        </div>
      </header>
      <MessageList
        messages={messages}
        me={me}
        users={team.users}
        lastRead={cache?.lastRead ?? null}
        hasMore={!!cache?.hasMore}
        loading={!!cache?.loading}
        loaded={!!cache?.loaded}
        onLoadMore={() => void team.loadMore(channel.id)}
        actions={actions}
        onDropFiles={(files) => drafts.add(files)}
        highlight={highlight}
        empty={<Empty icon={channelIcon(channel, 22)} title={channel.kind === "dm" ? `Say hello to ${title}` : "Say hello to the team"} hint={channel.kind === "client" ? "Everything about this client's months lands here; Discuss on a card opens its thread." : "Messages, files and voice notes; @ to mention someone, Enter to send."} />}
      />
      <Composer
        placeholder={channel.kind === "dm" ? `Message ${title}` : `Message #${title}`}
        drafts={drafts.drafts}
        onAddFiles={drafts.add}
        onRemoveDraft={drafts.remove}
        onRetryDraft={drafts.retry}
        onSend={(body, attachments) => {
          void team.send({ channel: channel.id, body, attachments });
          drafts.clear();
        }}
        onEditLast={mine ? () => setEditing(mine) : undefined}
        editing={editing ? { id: editing.id, body: editing.body } : null}
        onSaveEdit={(body) => {
          const id = editing!.id;
          setEditing(null);
          void team.edit(id, body).catch((e: Error) => toast.error(e.message));
        }}
        onCancelEdit={() => setEditing(null)}
        disabledReason={offline}
        users={team.users}
        autoFocus={!compact}
        compact={compact}
      />
    </section>
  );
}
