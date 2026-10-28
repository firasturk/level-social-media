/** Pinned messages, or search results: a plain list of messages; a click opens the message where it lives. */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Pin, Search, X } from "lucide-react";
import type { Message } from "@shared/team";
import { useMessageActions } from "./ChannelView";
import { channelTitle } from "@shared/team-ui";
import { MessageItem } from "./MessageList";
import { Empty, MessageSkeleton } from "./ui";
import { useTeam } from "./useTeam";

export function ListPane({ kind, q, channel, onClose, onJump, asPage = false }: { kind: "pins" | "search"; q?: string; channel: string | null; onClose: () => void; onJump: (m: Message) => void; asPage?: boolean }) {
  const team = useTeam();
  const me = team.me!;
  const [items, setItems] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useMessageActions(useCallback(() => undefined, []), true);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    const p = kind === "pins" ? (channel ? team.pins(channel) : Promise.resolve([])) : team.search(q ?? "", channel ?? undefined);
    p.then((r) => alive && setItems(r)).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [kind, q, channel, team, team.view.channel]);

  const ch = channel ? team.channels.find((c) => c.id === channel) : null;

  return (
    <aside className={`tm-pane tm-listpane ${asPage ? "page" : ""}`} aria-label={kind === "pins" ? "Pinned messages" : "Search results"}>
      <header className="tm-pane-head">
        {asPage && (
          <button type="button" className="tm-icon tm-back" onClick={onClose} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="tm-pane-title">
          <h3>
            {kind === "pins" ? (
              <>
                <Pin size={14} /> Pinned
              </>
            ) : (
              <>
                <Search size={14} /> “{q}”
              </>
            )}
          </h3>
          {ch && <small dir="auto">{channelTitle(ch, me.id)}</small>}
        </div>
        {!asPage && (
          <button type="button" className="tm-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        )}
      </header>
      <div className="tm-pane-body list">
        {items === null && !error && <MessageSkeleton rows={3} />}
        {error && <p className="tm-error">{error}</p>}
        {items && !items.length && <Empty title={kind === "pins" ? "Nothing pinned yet" : "Nothing found"} hint={kind === "pins" ? "Pin a message from its toolbar to keep it here." : "Try another word; search looks at the text of messages."} />}
        {items?.map((m) => (
          <div key={m.id} className="tm-list-hit" role="button" tabIndex={0} onClick={() => onJump(m)} onKeyDown={(e) => e.key === "Enter" && onJump(m)}>
            <MessageItem m={m} collapsed={false} me={me} users={team.users} actions={actions} inThread showTicks={false} plain />
          </div>
        ))}
      </div>
    </aside>
  );
}
