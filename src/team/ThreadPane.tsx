/**
 * A thread: the root message on top (with the creative and its approval actions when the thread
 * is about a post), the replies, and a composer that answers in the thread.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { toast } from "sonner";
import { useMessageActions } from "./ChannelView";
import { Composer, useDrafts } from "./Composer";
import { channelTitle } from "@shared/team-ui";
import { CreativeCard } from "./MessageBody";
import { MessageItem, MessageList } from "./MessageList";
import { ReviewActions } from "./ReviewActions";
import { Empty, MessageSkeleton } from "./ui";
import { useTeam, type LocalMessage } from "./useTeam";

export function ThreadPane({ root, version, onClose, highlight, asPage = false }: { root: string; version?: string | null; onClose: () => void; highlight?: string | null; asPage?: boolean }) {
  const team = useTeam();
  const me = team.me!;
  const t = team.thread(root);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  const drafts = useDrafts();

  const { loadThread } = team;
  useEffect(() => {
    void loadThread(root);
  }, [root, loadThread]);
  useEffect(() => setEditing(null), [root]);

  const actions = useMessageActions(useCallback((m: LocalMessage) => setEditing(m), []), true);
  const rootMsg = t?.root ?? team.messageById(root) ?? null;
  const channel = rootMsg ? team.channels.find((c) => c.id === rootMsg.channel) : null;
  const replies = t?.replies ?? [];
  const mine = [...replies].reverse().find((m) => m.author.id === me.id && !m.deleted && !m.pending && !m.local);
  const offline = !team.online ? "You are offline." : null;
  const ref = rootMsg?.ref;
  const creative = ref?.preview && ref.batch && ref.post !== undefined && ref.post !== null ? { batch: ref.batch, post: ref.post, preview: ref.preview } : null;

  return (
    <aside className={`tm-pane tm-thread ${asPage ? "page" : ""}`} aria-label="Thread">
      <header className="tm-pane-head">
        {asPage && (
          <button type="button" className="tm-icon tm-back" onClick={onClose} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="tm-pane-title">
          <h3>{creative ? "Discuss" : "Thread"}</h3>
          {channel && <small dir="auto">{channelTitle(channel, me.id)}</small>}
        </div>
        {!asPage && (
          <button type="button" className="tm-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        )}
      </header>
      {creative && (
        <div className="tm-thread-creative">
          <CreativeCard preview={creative.preview} large onOpen={() => team.openCreative(creative.batch, creative.post)} />
          <ReviewActions batch={creative.batch} post={creative.post} preview={creative.preview} version={version} compact />
        </div>
      )}
      <MessageList
        messages={replies}
        me={me}
        users={team.users}
        lastRead={null}
        hasMore={false}
        loading={!t?.loaded}
        loaded={!!t?.loaded}
        onLoadMore={() => undefined}
        actions={actions}
        onDropFiles={(files) => drafts.add(files)}
        inThread
        highlight={highlight}
        header={
          rootMsg ? (
            <div className="tm-thread-root">
              {creative && rootMsg.kind === "system" ? null : <MessageItem m={rootMsg} collapsed={false} me={me} users={team.users} actions={actions} inThread showTicks={false} />}
              {replies.length > 0 && <div className="tm-thread-count">{replies.length} {replies.length === 1 ? "reply" : "replies"}</div>}
            </div>
          ) : (
            <MessageSkeleton rows={1} />
          )
        }
        empty={<Empty title={creative ? "Talk about this creative" : "No replies yet"} hint={creative ? "Notes, versions and approvals about this post live here." : "Reply to keep the conversation together."} />}
      />
      <Composer
        placeholder="Reply…"
        drafts={drafts.drafts}
        onAddFiles={drafts.add}
        onRemoveDraft={drafts.remove}
        onRetryDraft={drafts.retry}
        onSend={(body, attachments) => {
          if (!rootMsg) return;
          void team.send({ channel: rootMsg.channel, thread: root, body, attachments });
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
        disabledReason={offline ?? (rootMsg ? null : "Loading…")}
        users={team.users}
        autoFocus
        compact
      />
    </aside>
  );
}
