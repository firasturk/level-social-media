import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Check, Link2, LoaderCircle, Maximize2, RefreshCw, Sparkles, X } from "lucide-react";
import { del, get, post } from "@/api";
import { STYLE_TARGET, type StyleItem, type StyleKind } from "@shared/styles";

type Reply = { styles: StyleItem[]; pool: number; spare: number };

/**
 * One copy of the gallery for the whole app: it opens instantly from any screen once loaded, and
 * every change made anywhere shows everywhere.
 */
let store: Reply | null = null;
let loading: Promise<void> | null = null;
let filling = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function setStore(r: Reply) {
  store = r;
  emit();
}
async function load(force = false) {
  if (loading && !force) return loading;
  loading = get<Reply>("/api/studio/styles")
    .then(setStore)
    .catch((e) => {
      toast.error((e as Error).message);
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}
/** Reads more pins until the gallery is full (each call reads a few). */
async function fill() {
  if (filling) return;
  filling = true;
  emit();
  try {
    for (let i = 0; i < 20; i++) {
      const short = missing(store);
      if (!short || (!store?.pool && !store?.spare && i > 0)) break;
      setStore(await post<Reply>("/api/studio/styles/fill"));
    }
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    filling = false;
    emit();
  }
}
function missing(r: Reply | null): number {
  if (!r) return 0;
  return (["product", "people"] as StyleKind[]).reduce(
    (s, k) => s + Math.max(0, STYLE_TARGET[k] - r.styles.filter((x) => x.kind === k).length),
    0,
  );
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The gallery's styles (loads once, shared by every screen). */
export function useStyles(): { styles: StyleItem[]; ready: boolean; filling: boolean } {
  const r = useSyncExternalStore(subscribe, () => store);
  const busy = useSyncExternalStore(subscribe, () => filling);
  useEffect(() => {
    if (!store) void load();
  }, []);
  return { styles: r?.styles ?? [], ready: !!r, filling: busy };
}

/** Puts the team's own pins at the front of the gallery. */
export async function addPins(links: string[]): Promise<{ added: number; failed: string[] }> {
  const r = await post<Reply & { added: number; failed: string[] }>("/api/studio/styles/add", { links });
  setStore(r);
  return r;
}

export const styleThumb = (s: Pick<StyleItem, "id" | "updated">, full = false) =>
  `/api/studio/styles/${s.id}/image?v=${s.updated}${full ? "&size=full" : ""}`;

type Tab = "all" | StyleKind;

/**
 * "Pick your style", full screen: the styles laid out in even rows like a product-shot gallery.
 * Click to select (Select all, Select none); remove one and a new one takes its place; Update writes
 * the selected styles again, New ideas swaps them. When picking, the selection goes to one post or
 * to the whole grid.
 */
export default function StyleScreen({
  open,
  onClose,
  admin,
  pick,
}: {
  open: boolean;
  onClose: () => void;
  admin?: boolean;
  /** Picking for one post ("post") or for the grid ("grid", spread over `posts` posts). */
  pick?: { mode: "post" | "grid"; posts?: number; label?: string; kind?: StyleKind; onPick: (ids: string[]) => Promise<void> | void };
}) {
  const { styles, ready, filling: busyFill } = useStyles();
  const [tab, setTab] = useState<Tab>(pick?.kind ?? "all");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<StyleItem | null>(null);
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setSelected([]);
      setTab(pick?.kind ?? "all");
    }
  }, [open, pick?.kind]);
  // An unfilled gallery fills itself while it is open.
  useEffect(() => {
    if (open && ready && missing(store) > 0) void fill();
  }, [open, ready, styles.length]);

  // All: both galleries mixed, the strongest first; a tab keeps its own order.
  const shown = useMemo(
    () => (tab === "all" ? [...styles].sort((a, b) => b.score - a.score || a.position - b.position) : styles.filter((s) => s.kind === tab)),
    [styles, tab],
  );
  const counts = useMemo(
    () => ({ all: styles.length, product: styles.filter((s) => s.kind === "product").length, people: styles.filter((s) => s.kind === "people").length }),
    [styles],
  );
  const toggle = useCallback((id: string) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])), []);

  // Esc closes (or the preview first); Ctrl/Cmd+A selects everything shown.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        if (preview) setPreview(null);
        else onClose();
      } else if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(shown.map((s) => s.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, preview, shown, onClose]);

  async function remove(id: string) {
    // The tile leaves at once; the server puts a ready style in its place.
    if (store) setStore({ ...store, styles: store.styles.filter((s) => s.id !== id) });
    setSelected((sel) => sel.filter((x) => x !== id));
    try {
      setStore(await del<Reply>(`/api/studio/styles/${id}`));
    } catch (e) {
      toast.error((e as Error).message);
      void load(true);
    }
  }

  async function act(what: "refresh" | "replace") {
    if (!selected.length) return;
    setBusy(what);
    const ids = what === "refresh" ? selected.slice(0, 12) : selected;
    try {
      setStore(await post<Reply>(`/api/studio/styles/${what}`, { ids }));
      toast.success(
        what === "refresh"
          ? `${ids.length} style${ids.length > 1 ? "s" : ""} written again.${selected.length > 12 ? " Up to 12 at a time." : ""}`
          : `${ids.length} new idea${ids.length > 1 ? "s" : ""} in their places.`,
      );
      setSelected([]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function use() {
    if (!pick || !selected.length) return;
    if (pick.mode === "post" && selected.length !== 1) return;
    setBusy("pick");
    try {
      await pick.onPick(selected);
      setSelected([]);
      onClose();
    } finally {
      setBusy("");
    }
  }

  async function addLinks() {
    const list = links.split(/\s+/).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x));
    if (!list.length) return toast.error("Paste one or more Pinterest links.");
    setBusy("add");
    try {
      const r = await addPins(list.slice(0, 20));
      toast.success(`${r.added} pin${r.added === 1 ? "" : "s"} added at the front.${r.failed.length ? ` ${r.failed.length} could not be read.` : ""}`);
      setLinks("");
      setAdding(false);
      scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (!open) return null;
  const n = selected.length;
  const useLabel = !pick
    ? ""
    : pick.mode === "post"
      ? n === 1
        ? "Use for this post"
        : n > 1
          ? "Select one for this post"
          : "Pick a style"
      : n
        ? `Use ${n} for the grid${pick.posts ? ` · ${pick.posts} posts` : ""}`
        : "Pick styles for the grid";

  // On the page itself: an animated parent (the journey's boxes) would trap a fixed screen inside it.
  return createPortal(
    <div className="style-screen" role="dialog" aria-modal aria-label="Pick your style">
      <header className="style-top">
        <div className="style-top-row">
          <div className="style-heading">
            <span className="style-eyebrow">{pick ? (pick.mode === "grid" ? "Style grid" : pick.label ?? "One post") : "Styles"}</span>
            <strong>Pick your style</strong>
          </div>
          <div className="style-top-actions">
            {busyFill && (
              <span className="style-filling">
                <LoaderCircle className="spinning" size={13} /> New styles coming in…
              </span>
            )}
            <button type="button" className="style-pill" onClick={() => setAdding((v) => !v)} title="Add your own Pinterest pins at the front of the gallery">
              <Link2 size={14} /> Add pins
            </button>
            <button type="button" className="style-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        {adding && (
          <div className="style-add">
            <textarea
              rows={2}
              value={links}
              autoFocus
              onChange={(e) => setLinks(e.target.value)}
              placeholder="Paste Pinterest links (pin.it/… or pinterest.com/pin/…), one per line. They join the front of the gallery, whatever the bar says."
            />
            <button type="button" className="style-primary" disabled={busy === "add"} onClick={() => void addLinks()}>
              {busy === "add" ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />} Add
            </button>
          </div>
        )}
        <div className="style-top-row">
          <div className="style-tabs" role="tablist">
            {(
              [
                ["all", "All"],
                ["product", "Product shot"],
                ["people", "With people"],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`style-pill ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
                {label} <em>{counts[k]}</em>
              </button>
            ))}
          </div>
          <div className="style-select">
            <button type="button" className="style-link" onClick={() => setSelected(shown.map((s) => s.id))}>
              Select all
            </button>
            <button
              type="button"
              className="style-link"
              onClick={() => setSelected((sel) => [...new Set([...sel, ...shown.filter((s) => !sel.includes(s.id)).slice(0, 10).map((s) => s.id)])])}
              title="Select the next ten styles"
            >
              Select 10 more
            </button>
            <button type="button" className="style-link" onClick={() => setSelected(shown.map((s) => s.id).filter((id) => !selected.includes(id)))}>
              Invert
            </button>
            <button type="button" className="style-link" disabled={!n} onClick={() => setSelected([])}>
              Select none
            </button>
          </div>
        </div>
      </header>

      <div className="style-scroll" ref={scroller}>
        <div className="style-rows">
          {(ready ? shown : []).map((s) => {
            const on = selected.includes(s.id);
            const ar = s.w && s.h ? s.w / s.h : 0.75;
            return (
              <div key={s.id} className={`style-tile ${on ? "on" : ""}`} style={{ flexGrow: ar, flexBasis: `calc(var(--row) * ${ar})` }}>
                <button type="button" className="style-tile-image" style={{ aspectRatio: `${ar}` }} onClick={() => toggle(s.id)} aria-pressed={on} title={s.tags}>
                  <img src={styleThumb(s)} alt={s.title} loading="lazy" decoding="async" />
                  <span className="style-tile-label">
                    <small>{s.kind === "people" ? "With people" : "Product shot"}</small>
                    <b>{s.title}</b>
                  </span>
                </button>
                <span className="style-tile-check" aria-hidden>
                  {on && <Check size={13} strokeWidth={3} />}
                </span>
                <span className="style-tile-tools">
                  <button type="button" onClick={() => setPreview(s)} aria-label={`Open ${s.title}`} title="Open">
                    <Maximize2 size={13} />
                  </button>
                  <button type="button" onClick={() => void remove(s.id)} aria-label={`Remove ${s.title}`} title="Remove: a new style takes its place">
                    <X size={13} />
                  </button>
                </span>
              </div>
            );
          })}
          {Array.from({ length: ready ? Math.max(0, (tab === "all" ? STYLE_TARGET.product + STYLE_TARGET.people : STYLE_TARGET[tab]) - shown.length) : 18 }, (_, i) => (
            <div key={`s${i}`} className="style-tile skeleton" style={{ flexGrow: 0.75, flexBasis: "calc(var(--row) * 0.75)" }} />
          ))}
          <span className="style-rows-end" />
        </div>
      </div>

      {(n > 0 || pick) && (
        <div className="style-dock">
          <span className="style-dock-count">{n ? `${n} selected` : pick?.mode === "grid" ? `Select the styles for ${pick.posts ?? "your"} posts` : "Select one style"}</span>
          {n > 0 && (
            <>
              <button type="button" className="style-pill" disabled={!!busy} onClick={() => void act("refresh")} title="Write the selected styles again: a fresh take on the same idea">
                {busy === "refresh" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />} Update
              </button>
              <button type="button" className="style-pill" disabled={!!busy} onClick={() => void act("replace")} title="Swap the selected styles for new ideas">
                {busy === "replace" ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />} New ideas
              </button>
            </>
          )}
          {pick && (
            <button type="button" className="style-primary" disabled={!n || !!busy || (pick.mode === "post" && n !== 1)} onClick={() => void use()}>
              {busy === "pick" ? <LoaderCircle className="spinning" size={15} /> : <Check size={15} />} {useLabel}
            </button>
          )}
        </div>
      )}

      {preview && (
        <div className="style-preview-layer" onClick={() => setPreview(null)}>
          <div className="style-preview-card" onClick={(e) => e.stopPropagation()}>
            <img src={styleThumb(preview, true)} alt={preview.title} />
            <div className="style-preview-text">
              <small>{preview.kind === "people" ? "With people" : "Product shot"} · {preview.tags}</small>
              <h2>{preview.title}</h2>
              {admin && preview.prompt ? (
                <p>{preview.prompt}</p>
              ) : (
                <p>Picked for a post, this style is written for that post's own product, its ingredients and the brand's colours.</p>
              )}
              <div className="style-preview-actions">
                <button
                  type="button"
                  className="style-primary"
                  onClick={() => {
                    toggle(preview.id);
                    setPreview(null);
                  }}
                >
                  <Check size={14} /> {selected.includes(preview.id) ? "Unselect" : "Select"}
                </button>
                <button
                  type="button"
                  className="style-pill"
                  onClick={() => {
                    void remove(preview.id);
                    setPreview(null);
                  }}
                >
                  <X size={14} /> Remove
                </button>
                <button type="button" className="style-pill" onClick={() => setPreview(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
