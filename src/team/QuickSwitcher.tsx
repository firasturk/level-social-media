/** Cmd/Ctrl+K: type a few letters, jump to a channel or a person (a direct message opens). */
import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Lock, MessagesSquare, Search } from "lucide-react";
import { toast } from "sonner";
import type { Channel, TeamUser } from "@shared/team";
import { Avatar } from "./Avatar";
import { channelTitle } from "@shared/team-ui";
import { useTeam } from "./useTeam";

type Hit = { kind: "channel"; c: Channel } | { kind: "person"; u: TeamUser };

export function QuickSwitcher({ onClose, onPicked }: { onClose: () => void; onPicked?: () => void }) {
  const team = useTeam();
  const me = team.me!;
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const box = useRef<HTMLInputElement | null>(null);

  const hits = useMemo<Hit[]>(() => {
    const n = q.trim().toLowerCase();
    const chans = team.channels.filter((c) => !c.archived).map((c) => ({ c, title: channelTitle(c, me.id) }));
    const people = team.users.filter((u) => u.id !== me.id);
    const score = (s: string) => (!n ? 1 : s.toLowerCase().startsWith(n) ? 3 : s.toLowerCase().includes(n) ? 2 : 0);
    const out: { h: Hit; s: number; at: number }[] = [];
    for (const { c, title } of chans) {
      const s = score(title);
      if (s) out.push({ h: { kind: "channel", c }, s: s + (c.unread ? 0.5 : 0), at: c.lastAt ?? 0 });
    }
    for (const u of people) {
      if (chans.some((x) => x.c.kind === "dm" && x.c.members?.some((m) => m.id === u.id))) continue;
      const s = score(u.name);
      if (s) out.push({ h: { kind: "person", u }, s: s - 0.25, at: 0 });
    }
    return out.sort((a, b) => b.s - a.s || b.at - a.at).slice(0, 12).map((x) => x.h);
  }, [q, team.channels, team.users, me.id]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => box.current?.focus(), []);

  const pick = async (h: Hit) => {
    onClose();
    if (h.kind === "channel") team.openChannel(h.c.id);
    else {
      try {
        const c = await team.createChannel({ kind: "dm", members: [h.u.id] });
        team.openChannel(c.id);
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
    }
    onPicked?.();
  };

  return (
    <div className="tm-switcher-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-label="Go to">
      <div className="tm-switcher">
        <div className="tm-switcher-input">
          <Search size={16} />
          <input
            ref={box}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Go to a channel or a person"
            dir="auto"
            aria-label="Go to a channel or a person"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => (i + 1) % Math.max(1, hits.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => (i - 1 + hits.length) % Math.max(1, hits.length));
              } else if (e.key === "Enter" && hits[idx]) void pick(hits[idx]);
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul role="listbox">
          {hits.map((h, i) => (
            <li key={h.kind === "channel" ? h.c.id : `u-${h.u.id}`}>
              <button type="button" role="option" aria-selected={i === idx} className={i === idx ? "on" : ""} onMouseEnter={() => setIdx(i)} onClick={() => void pick(h)}>
                {h.kind === "channel" ? (
                  <>
                    <span className="tm-nav-icon">{h.c.kind === "dm" && h.c.members ? <Avatar user={h.c.members.find((m) => m.id !== me.id) ?? h.c.members[0]} size={20} /> : h.c.kind === "group" ? <Lock size={14} /> : h.c.kind === "project" ? <MessagesSquare size={14} /> : <Hash size={14} />}</span>
                    <span dir="auto">{channelTitle(h.c, me.id)}</span>
                    {h.c.unread > 0 && <span className="tm-badge">{h.c.unread}</span>}
                  </>
                ) : (
                  <>
                    <span className="tm-nav-icon">
                      <Avatar user={h.u} size={20} />
                    </span>
                    <span>{h.u.name}</span>
                    <small>new message</small>
                  </>
                )}
              </button>
            </li>
          ))}
          {!hits.length && <li className="tm-muted tm-switcher-none">Nothing by that name.</li>}
        </ul>
      </div>
    </div>
  );
}
