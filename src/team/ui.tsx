/** Small shared pieces of the Team page: a click-outside hook, a popover menu, empty and loading states. */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { QUICK_EMOJI } from "@shared/team";
import { EMOJI_GRID } from "@shared/team-ui";

export function useClickOutside(open: boolean, onClose: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, onClose]);
  return ref;
}

export interface MenuItem {
  label: ReactNode;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  on?: boolean;
}

/** A small floating list under (or over) its trigger; the parent decides when it is open. */
export function Menu({ items, onClose, align = "end", up = false, className = "" }: { items: MenuItem[]; onClose: () => void; align?: "start" | "end"; up?: boolean; className?: string }) {
  const ref = useClickOutside(true, onClose);
  return (
    <div ref={ref} className={`tm-menu ${align} ${up ? "up" : ""} ${className}`} role="menu">
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`${it.danger ? "danger" : ""} ${it.on ? "on" : ""}`}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.icon && <span className="tm-menu-icon">{it.icon}</span>}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The eight quick reactions and a "more" grid of sixty everyday emoji. */
export function EmojiPicker({ onPick, onClose, up = false }: { onPick: (emoji: string) => void; onClose: () => void; up?: boolean }) {
  const [more, setMore] = useState(false);
  const ref = useClickOutside(true, onClose);
  return (
    <div ref={ref} className={`tm-emoji ${up ? "up" : ""} ${more ? "wide" : ""}`} role="dialog" aria-label="Pick a reaction">
      <div className="tm-emoji-quick">
        {QUICK_EMOJI.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} aria-label={e}>
            {e}
          </button>
        ))}
        <button type="button" className={`tm-emoji-more ${more ? "on" : ""}`} onClick={() => setMore((m) => !m)} aria-expanded={more} aria-label="More emoji">
          {more ? "−" : "+"}
        </button>
      </div>
      {more && (
        <div className="tm-emoji-grid">
          {EMOJI_GRID.map((e) => (
            <button key={e} type="button" onClick={() => onPick(e)} aria-label={e}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="tm-empty">
      {icon && <span className="tm-empty-icon">{icon}</span>}
      <b>{title}</b>
      {hint && <small>{hint}</small>}
      {action}
    </div>
  );
}

/** Grey lines where messages will be. */
export function MessageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="tm-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="tm-skel-row" style={{ "--w": `${45 + ((i * 37) % 45)}%` } as React.CSSProperties}>
          <i className="tm-skel-avatar" />
          <span>
            <i className="tm-skel-line short" />
            <i className="tm-skel-line" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="tm-skeleton list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} className="tm-skel-line" style={{ "--w": `${60 + ((i * 23) % 40)}%` } as React.CSSProperties} />
      ))}
    </div>
  );
}

/** A tiny status pill. */
export function Pill({ children, tone = "soft", className = "" }: { children: ReactNode; tone?: "soft" | "accent" | "warn" | "danger" | "ok"; className?: string }) {
  return <span className={`tm-pill ${tone} ${className}`}>{children}</span>;
}
