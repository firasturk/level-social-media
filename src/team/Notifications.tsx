/**
 * The bell: direct messages, mentions, tasks, reviews, approvals and due dates, newest first,
 * marked seen when the list opens; a click goes to the channel, the message or the task.
 */
import { useEffect, useState } from "react";
import { AtSign, Bell, BellOff, Calendar, CircleCheck, MessageSquare, SquareCheck, Stamp } from "lucide-react";
import type { Notification } from "@shared/team";
import { relativeTime } from "@shared/team-ui";
import { useClickOutside } from "./ui";
import { useTeam } from "./useTeam";

function iconOf(kind: Notification["kind"]) {
  switch (kind) {
    case "dm":
      return <MessageSquare size={14} />;
    case "mention":
      return <AtSign size={14} />;
    case "task":
      return <SquareCheck size={14} />;
    case "review":
      return <Stamp size={14} />;
    case "approval":
      return <CircleCheck size={14} />;
    case "due":
      return <Calendar size={14} />;
  }
}

export function NotificationBell({ onNavigate }: { onNavigate?: () => void }) {
  const team = useTeam();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  const unseen = team.notifications.filter((n) => !n.seen).length;

  // Opening the list marks everything seen (the badge clears), the rows keep a soft tint until closed.
  const [seenAtOpen, setSeenAtOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    const fresh = team.notifications.filter((n) => !n.seen).map((n) => n.id);
    setSeenAtOpen(new Set(fresh));
    if (fresh.length) void team.markSeen(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const go = (n: Notification) => {
    setOpen(false);
    const r = n.ref;
    if (!r) return;
    if (r.task) team.setView((v) => ({ ...v, pane: { kind: "task", id: r.task! } }));
    else if (r.channel) {
      team.openChannel(r.channel);
      if (r.message) team.setView((v) => ({ ...v, pane: { kind: "thread", root: r.message! } }));
    } else if (r.batch && r.post !== undefined) void team.discuss(r.batch, r.post);
    onNavigate?.();
  };

  return (
    <span className="tm-bell-anchor" ref={ref}>
      <button type="button" className={`tm-icon ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label={unseen ? `${unseen} new notifications` : "Notifications"} title="Notifications" aria-expanded={open}>
        <Bell size={17} />
        {unseen > 0 && <span className="tm-bell-badge">{unseen > 9 ? "9+" : unseen}</span>}
      </button>
      {open && (
        <div className="tm-popover tm-notifs" role="dialog" aria-label="Notifications">
          <div className="tm-popover-head">
            <b>Notifications</b>
            {team.notifications.length > 0 && (
              <button type="button" className="tm-link-btn quiet" onClick={() => void team.markSeen()}>
                Mark all seen
              </button>
            )}
          </div>
          {!team.notifications.length ? (
            <div className="tm-empty small">
              <BellOff size={18} />
              <b>All quiet</b>
              <small>Mentions, direct messages, tasks and approvals show here.</small>
            </div>
          ) : (
            <ul>
              {team.notifications.slice(0, 40).map((n) => (
                <li key={n.id}>
                  <button type="button" className={`tm-notif ${seenAtOpen.has(n.id) || !n.seen ? "fresh" : ""}`} onClick={() => go(n)}>
                    <span className={`tm-notif-icon ${n.kind}`}>{iconOf(n.kind)}</span>
                    <span className="tm-notif-text" dir="auto">
                      {n.text}
                    </span>
                    <time>{relativeTime(n.at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}
