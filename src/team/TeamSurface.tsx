/**
 * The Team shell, the same conversation in three places: a compact panel over the studio, a split
 * pane beside it, or the full page. It measures its own width and lays out one, two or three
 * columns accordingly, so the phone, the panel and the page share the code.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Columns2, Maximize2, MessagesSquare, PanelRight, RefreshCw, WifiOff, X } from "lucide-react";
import type { Channel, Message } from "@shared/team";
import { ChannelView } from "./ChannelView";
import { channelTitle } from "@shared/team-ui";
import { ListPane } from "./ListPane";
import { Navigation } from "./Navigation";
import { NotificationBell } from "./Notifications";
import { QuickSwitcher } from "./QuickSwitcher";
import { NewTaskPane, TaskPane } from "./TaskPane";
import { TasksView } from "./TasksView";
import { ThreadPane } from "./ThreadPane";
import { Empty, ListSkeleton } from "./ui";
import { useTeam, type TeamLayout } from "./useTeam";
import "./team.css";

const STACK_MAX = 720;
const THREE_MIN = 1100;

/** Three icons: compact panel, split, full page. */
export function LayoutSwitcher({ compact = false }: { compact?: boolean }) {
  const team = useTeam();
  const opts: { id: TeamLayout; icon: ReactNode; label: string }[] = [
    { id: "panel", icon: <PanelRight size={15} />, label: "Compact panel" },
    { id: "split", icon: <Columns2 size={15} />, label: "Split with the studio" },
    { id: "full", icon: <Maximize2 size={15} />, label: "Full workspace" },
  ];
  return (
    <span className={`tm-layouts ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Layout">
      {opts.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={team.layout === o.id} className={`tm-icon ${team.layout === o.id ? "on" : ""}`} title={o.label} aria-label={o.label} onClick={() => team.setLayout(o.id)}>
          {o.icon}
        </button>
      ))}
    </span>
  );
}

function StatusPills() {
  const team = useTeam();
  if (!team.online)
    return (
      <span className="tm-pill warn tm-status-pill">
        <WifiOff size={11} /> Offline
      </span>
    );
  if (team.reconnecting)
    return (
      <span className="tm-pill soft tm-status-pill">
        <RefreshCw size={11} className="tm-spin" /> Reconnecting…
      </span>
    );
  return null;
}

/** The compact header's channel picker: the current name, a chevron, the navigation underneath. */
function ChannelPicker({ channel, onOpenNav }: { channel: Channel | null; onOpenNav: () => void }) {
  const team = useTeam();
  const title = team.view.section === "tasks" ? "My tasks" : channel ? channelTitle(channel, team.me?.id) : "Team";
  return (
    <button type="button" className="tm-picker" onClick={onOpenNav} title="Channels and tasks" aria-haspopup="true">
      <span dir="auto">{title}</span>
      <ChevronDown size={14} />
    </button>
  );
}

export function TeamSurface({ layout, onClose }: { layout: TeamLayout; onClose?: () => void }) {
  const team = useTeam();
  const host = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [showNav, setShowNav] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [highlight, setHighlight] = useState<{ channel?: string; message?: string; reply?: string } | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const stacked = width > 0 && width < STACK_MAX;
  const three = width >= THREE_MIN;
  const { view } = team;
  const channel = view.channel ? team.channels.find((c) => c.id === view.channel) ?? null : null;

  // A deep link (/team?channel=&message=[&reply=]) opens where it points, then the address is cleaned.
  useEffect(() => {
    if (!team.ready) return;
    const u = new URL(window.location.href);
    if (u.pathname.replace(/\/$/, "") !== "/team") return;
    const ch = u.searchParams.get("channel");
    const msg = u.searchParams.get("message");
    const reply = u.searchParams.get("reply");
    if (!ch) return;
    team.openChannel(ch);
    if (msg) {
      if (reply) team.openThread(msg);
      setHighlight({ channel: ch, message: msg, reply: reply ?? undefined });
    }
    u.search = "";
    window.history.replaceState(null, "", u.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.ready]);

  // Somewhere to start: the general channel, then the first; a phone starts on the list.
  useEffect(() => {
    if (!team.ready || view.channel || view.section === "tasks") return;
    const pick = team.channels.find((c) => c.kind === "general") ?? team.channels.find((c) => !c.archived);
    if (pick) team.openChannel(pick.id);
    if (stacked && layout === "full") setShowNav(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.ready, team.channels.length]);

  // Keys: Esc closes the pane (then the panel), Cmd/Ctrl+K opens the switcher.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((s) => !s);
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && (t as HTMLInputElement).value) return;
      if (switcher) setSwitcher(false);
      else if (team.view.pane.kind !== "none") team.closePane();
      else if (showNav && stacked && layout !== "full") setShowNav(false);
      else if (layout !== "full") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, onClose, showNav, stacked, switcher, team]);

  const pane = view.pane;
  const closePane = useCallback(() => team.closePane(), [team]);
  const jump = useCallback(
    (m: Message) => {
      team.openChannel(m.channel);
      if (m.thread) team.openThread(m.thread);
      else team.closePane();
      setHighlight({ channel: m.channel, message: m.thread ?? m.id, reply: m.thread ? m.id : undefined });
      setShowNav(false);
    },
    [team],
  );

  const paneNode = useMemo(() => {
    const asPage = stacked;
    switch (pane.kind) {
      case "thread":
        return <ThreadPane root={pane.root} version={pane.version} onClose={closePane} asPage={asPage} highlight={highlight?.reply ?? null} />;
      case "task":
        return <TaskPane id={pane.id} onClose={closePane} asPage={asPage} />;
      case "newTask":
        return <NewTaskPane prefill={pane.prefill} onClose={closePane} asPage={asPage} />;
      case "pins":
        return <ListPane kind="pins" channel={view.channel} onClose={closePane} onJump={jump} asPage={asPage} />;
      case "search":
        return <ListPane kind="search" q={pane.q} channel={view.channel} onClose={closePane} onJump={jump} asPage={asPage} />;
      default:
        return null;
    }
  }, [pane, stacked, closePane, highlight?.reply, view.channel, jump]);

  const compactHeader = layout !== "full";
  const navVisible = layout === "full" ? !stacked || showNav : showNav;

  const center = !team.ready ? (
    <div className="tm-center tm-loading">
      {team.error ? (
        <Empty title="Team could not load" hint={team.error} />
      ) : (
        <ListSkeleton rows={8} />
      )}
    </div>
  ) : view.section === "tasks" ? (
    <TasksView onBack={stacked && layout === "full" ? () => setShowNav(true) : undefined} compact={stacked} />
  ) : channel ? (
    <ChannelView channel={channel} compact={stacked || layout === "panel"} highlight={highlight?.channel === channel.id && !highlight.reply ? highlight.message ?? null : null} onBack={stacked && layout === "full" ? () => setShowNav(true) : undefined} tools={layout === "full" && !stacked ? <LayoutSwitcher compact /> : undefined} />
  ) : (
    <div className="tm-center">
      <Empty icon={<MessagesSquare size={22} />} title="Pick a channel" hint="Or press Cmd/Ctrl+K to jump somewhere." />
    </div>
  );

  const navNode = (
    <div className={`tm-navcol ${stacked ? "stacked" : ""}`}>
      {layout === "full" && (
        <div className="tm-navcol-head">
          <h1>Team</h1>
          <StatusPills />
          <NotificationBell onNavigate={() => setShowNav(false)} />
          {stacked && onClose && (
            <button type="button" className="tm-icon" onClick={onClose} aria-label="Back to the studio" title="Back to the studio">
              <X size={17} />
            </button>
          )}
        </div>
      )}
      <Navigation onPick={() => setShowNav(false)} compact={stacked} />
    </div>
  );

  return (
    <div ref={host} className={`tm-surface layout-${layout} ${stacked ? "stacked" : three ? "three" : "two"} ${pane.kind !== "none" ? "has-pane" : ""} ${navVisible ? "nav-open" : ""}`}>
      {compactHeader && (
        <header className="tm-top">
          <ChannelPicker channel={channel} onOpenNav={() => setShowNav((s) => !s)} />
          <StatusPills />
          <div className="tm-top-tools">
            <NotificationBell />
            <LayoutSwitcher compact />
            {onClose && (
              <button type="button" className="tm-icon" onClick={onClose} aria-label="Close Team" title="Close (Esc)">
                <X size={17} />
              </button>
            )}
          </div>
        </header>
      )}
      <div className="tm-columns">
        {layout === "full" && !stacked && navNode}
        {(layout !== "full" || stacked) && navVisible && (
          <div className="tm-nav-layer" onMouseDown={(e) => e.target === e.currentTarget && setShowNav(false)}>
            {navNode}
          </div>
        )}
        <div className="tm-centercol">{center}</div>
        {paneNode && <div className={`tm-panecol ${three && layout === "full" ? "side" : "over"}`}>{paneNode}</div>}
      </div>
      {switcher && <QuickSwitcher onClose={() => setSwitcher(false)} onPicked={() => setShowNav(false)} />}
    </div>
  );
}

/** The small floating "Team" button in the studio; it opens the compact panel. */
export function TeamFab() {
  const team = useTeam();
  if (team.open) return null;
  return (
    <button type="button" className="tm-fab" onClick={() => team.setOpen(true)} title="Team: messages, tasks, approvals" aria-label={team.unread ? `Team, ${team.unread} unread` : "Team"}>
      <MessagesSquare size={18} />
      <span>Team</span>
      {team.unread > 0 && <em>{team.unread > 99 ? "99+" : team.unread}</em>}
    </button>
  );
}

/** The compact drawer and the split pane around the studio; the full page is rendered by the Workspace itself. */
export function TeamDock({ onDiscussClose }: { onDiscussClose?: () => void }) {
  const team = useTeam();
  const [w, setW] = useState(() => {
    try {
      return Number(localStorage.getItem("lsm-team-split")) || 0;
    } catch {
      return 0;
    }
  });
  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  const close = useCallback(() => {
    team.setOpen(false);
    onDiscussClose?.();
  }, [team, onDiscussClose]);

  useEffect(() => {
    if (!team.open || team.layout !== "split") return;
    document.documentElement.style.setProperty("--team-w", `${w || Math.round(window.innerWidth * 0.4)}px`);
    document.documentElement.classList.add("team-split");
    return () => {
      document.documentElement.classList.remove("team-split");
    };
  }, [team.open, team.layout, w]);

  if (!team.open || team.layout === "full") return null;

  const onDown = (e: React.PointerEvent) => {
    dragging.current = { startX: e.clientX, startW: w || Math.round(window.innerWidth * 0.4) };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const rtl = getComputedStyle(document.documentElement).direction === "rtl";
    const dx = (e.clientX - dragging.current.startX) * (rtl ? 1 : -1);
    const next = Math.max(360, Math.min(window.innerWidth - 480, dragging.current.startW + dx));
    setW(next);
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = null;
    try {
      localStorage.setItem("lsm-team-split", String(w));
    } catch {
      /* private mode */
    }
  };

  if (team.layout === "panel")
    return (
      <div className="tm-drawer" role="complementary" aria-label="Team">
        <TeamSurface layout="panel" onClose={close} />
      </div>
    );
  return (
    <div className="tm-splitpane" role="complementary" aria-label="Team">
      <div className="tm-divider" role="separator" aria-orientation="vertical" aria-label="Resize Team" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      <TeamSurface layout="split" onClose={close} />
    </div>
  );
}
