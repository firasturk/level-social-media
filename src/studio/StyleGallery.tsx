import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Link2, LoaderCircle, Maximize2, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { del, get, post } from "@/api";
import { AnimatedLevelLogo } from "@/components/LevelLogo";
import { STYLE_CATEGORIES, type StyleItem } from "@shared/styles";

type Page = {
  styles: StyleItem[];
  total: number;
  page: number;
  pages: number;
  counts: Record<string, number>;
  pool: number;
};

/**
 * Every style the app has seen, by id: post cards and shot rows show a style's name and picture
 * without loading the library, and a style seen once is never fetched again.
 */
const known = new Map<string, StyleItem>();
const listeners = new Set<() => void>();
let version = 0;
function remember(list: StyleItem[]) {
  for (const s of list) known.set(s.id, s);
  version++;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const asking = new Set<string>();
async function lookup(ids: string[]) {
  const missing = ids.filter((id) => !known.has(id) && !asking.has(id));
  if (!missing.length) return;
  missing.forEach((id) => asking.add(id));
  try {
    const r = await get<{ styles: StyleItem[] }>(`/api/studio/styles/lookup?ids=${missing.map(encodeURIComponent).join(",")}`);
    remember(r.styles);
  } catch {
    /* the chip shows without its picture */
  } finally {
    missing.forEach((id) => asking.delete(id));
  }
}

/** The styles of these ids (loaded on demand). */
export function useStyleInfo(ids: (string | undefined | null)[]): Map<string, StyleItem> {
  useSyncExternalStore(subscribe, () => version);
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(",");
  useEffect(() => {
    if (key) void lookup(key.split(","));
  }, [key]);
  return known;
}

export const styleThumb = (s: Pick<StyleItem, "id" | "updated">, full = false) =>
  `/api/studio/styles/${s.id}/image?v=${s.updated}${full ? "&size=full" : ""}`;

const TABS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "trends", label: "Trends" },
  ...STYLE_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
];

/** Pages already loaded open instantly when the team comes back to them. */
const pages = new Map<string, Page>();

/**
 * "Pick your style", full screen in the studio's colours: the library in even rows, by category
 * or search, page by page. Click to select; remove a style, write the selected ones again (Update)
 * or swap them for new ones (New ideas). When picking, the selection goes to one post or the grid.
 */
export default function StyleScreen({
  open,
  onClose,
  admin,
  pick,
  onPendingChange,
}: {
  open: boolean;
  onClose: () => void;
  admin?: boolean;
  /** The admin's queue changed (the sidebar's badge follows). */
  onPendingChange?: () => void;
  /** Picking for one post ("post") or for the grid ("grid", spread over `posts` posts). */
  pick?: {
    mode: "post" | "grid";
    posts?: number;
    label?: string;
    tab?: string;
    onPick: (ids: string[], items: StyleItem[]) => Promise<void> | void;
  };
}) {
  const [tab, setTab] = useState(pick?.tab ?? "all");
  const reviewing = !!admin && tab === "review";
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const key = `${tab}|${q}|${page}`;
  const [data, setData] = useState<Page | null>(pages.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<StyleItem[]>([]);
  const [preview, setPreview] = useState<StyleItem | null>(null);
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => selected.map((s) => s.id), [selected]);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setTab(pick?.tab ?? "all");
    setPage(1);
  }, [open, pick?.tab]);

  // Search as the team types (after a short pause), from page one.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typed.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const apply = useCallback(
    (r: Page, k = key) => {
      pages.set(k, r);
      remember(r.styles);
      if (k === key) setData(r);
    },
    [key],
  );

  const load = useCallback(
    async (force = false) => {
      const cached = pages.get(key);
      if (cached) setData(cached);
      if (cached && !force) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ tab, q, page: String(page) });
        apply(await get<Page>(`/api/studio/styles?${params}`), key);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [key, tab, q, page, apply],
  );

  useEffect(() => {
    if (!open) return;
    void load();
    scroller.current?.scrollTo({ top: 0 });
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A change on the server: every cached page is old now; this one comes back fresh. */
  function changed(r: Page) {
    pages.clear();
    apply(r);
  }

  const shown = useMemo(() => data?.styles ?? [], [data]);
  const toggle = useCallback(
    (s: StyleItem) => setSelected((sel) => (sel.some((x) => x.id === s.id) ? sel.filter((x) => x.id !== s.id) : [...sel, s])),
    [],
  );

  // Esc closes (or the preview first); Ctrl/Cmd+A selects the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        if (preview) setPreview(null);
        else onClose();
      } else if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected((sel) => [...sel, ...shown.filter((s) => !sel.some((x) => x.id === s.id))]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, preview, shown, onClose]);

  const query = () => new URLSearchParams({ tab, q, page: String(page) }).toString();

  async function remove(s: StyleItem) {
    // The tile leaves at once.
    if (data) setData({ ...data, styles: data.styles.filter((x) => x.id !== s.id), total: data.total - 1 });
    setSelected((sel) => sel.filter((x) => x.id !== s.id));
    try {
      changed(await del<Page>(`/api/studio/styles/${s.id}?${query()}`));
    } catch (e) {
      toast.error((e as Error).message);
      void load(true);
    }
  }

  async function act(what: "refresh" | "replace") {
    if (!ids.length) return;
    setBusy(what);
    const list = what === "refresh" ? ids.slice(0, 12) : ids;
    try {
      const r = await post<Page & { added?: number }>(`/api/studio/styles/${what}?${query()}`, { ids: list });
      changed(r);
      toast.success(
        what === "refresh"
          ? `${list.length} style${list.length > 1 ? "s" : ""} written again.${ids.length > 12 ? " Up to 12 at a time." : ""}`
          : `${list.length} removed · ${r.added ?? 0} new idea${r.added === 1 ? "" : "s"} ${admin ? "waiting in To approve" : "sent to the admin for approval"}.`,
      );
      setSelected([]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /** The admin's queue: approve the good ones (they reach the team), reject the rest (gone for good). */
  async function judge(what: "approve" | "remove", list: string[]) {
    if (!list.length) return;
    setBusy(what);
    try {
      const r = await post<Page>(`/api/studio/styles/${what}?${query()}`, { ids: list });
      changed(r);
      toast.success(what === "approve" ? `${list.length} approved: the team sees them now.` : `${list.length} rejected.`);
      setSelected([]);
      onPendingChange?.();
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
      await pick.onPick(ids, selected);
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
      const r = await post<Page & { added: number; failed: string[] }>("/api/studio/styles/add", { links: list.slice(0, 20) });
      pages.clear();
      remember(r.styles);
      toast.success(`${r.added} pin${r.added === 1 ? "" : "s"} added (on Trends).${r.failed.length ? ` ${r.failed.length} could not be read.` : ""}`);
      setLinks("");
      setAdding(false);
      setTyped("");
      setTab("trends");
      setPage(1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (!open) return null;
  const n = selected.length;
  const counts = data?.counts ?? {};
  const pageCount = data?.pages ?? 1;
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
  // Page numbers around the current one, with the first and last always reachable.
  const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pageCount])].filter((x) => x >= 1 && x <= pageCount).sort((a, b) => a - b);

  // On the page itself: an animated parent (the journey's boxes) would trap a fixed screen inside it.
  return createPortal(
    <div className="style-screen" role="dialog" aria-modal aria-label="Pick your style">
      <header className="style-top">
        <div className="style-top-row">
          <div className="style-brand">
            <AnimatedLevelLogo className="style-logo" />
            <span className="style-eyebrow">{pick ? (pick.mode === "grid" ? "Style grid" : pick.label ?? "One post") : "Style library"}</span>
          </div>
          <h1 className="style-title">Pick your style</h1>
          <label className="style-search">
            <Search size={15} />
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search: balloons, ice, gift box, ramadan…" aria-label="Search the styles" />
            {typed && (
              <button type="button" onClick={() => setTyped("")} aria-label="Clear the search">
                <X size={13} />
              </button>
            )}
          </label>
          <div className="style-top-actions">
            <button type="button" className="secondary" onClick={() => setAdding((v) => !v)} title="Add your own Pinterest pins to the library">
              <Link2 size={14} /> Add pins
            </button>
            <button type="button" className="icon-button style-close" onClick={onClose} aria-label="Close">
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
              placeholder="Paste Pinterest links (pin.it/… or pinterest.com/pin/…), one per line. They join the library at once."
            />
            <button type="button" className="primary" disabled={busy === "add"} onClick={() => void addLinks()}>
              {busy === "add" ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />} Add
            </button>
          </div>
        )}
        <div className="style-top-row">
          <div className="style-tabs" role="tablist">
            {[...(admin ? [{ id: "review", label: "To approve" }] : []), ...TABS].map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`journey-chip ${tab === t.id ? "active" : ""} ${t.id === "review" && counts.review ? "waiting" : ""}`}
                onClick={() => {
                  setTab(t.id);
                  setPage(1);
                }}
              >
                {t.id === "trends" && <Sparkles size={12} />} {t.label}
                {counts[t.id] !== undefined && <em>{counts[t.id]}</em>}
              </button>
            ))}
          </div>
          <div className="style-select">
            <button type="button" className="text-button" onClick={() => setSelected((sel) => [...sel, ...shown.filter((s) => !sel.some((x) => x.id === s.id))])}>
              Select all
            </button>
            <button
              type="button"
              className="text-button"
              title="Select the next ten styles on this page"
              onClick={() => setSelected((sel) => [...sel, ...shown.filter((s) => !sel.some((x) => x.id === s.id)).slice(0, 10)])}
            >
              Select 10 more
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setSelected((sel) => [...sel.filter((x) => !shown.some((s) => s.id === x.id)), ...shown.filter((s) => !sel.some((x) => x.id === s.id))])}
            >
              Invert
            </button>
            <button type="button" className="text-button" disabled={!n} onClick={() => setSelected([])}>
              Select none
            </button>
            {reviewing && shown.length > 0 && (
              <button type="button" className="text-button style-approve-all" disabled={!!busy} onClick={() => void judge("approve", shown.map((s) => s.id))}>
                Approve all on this page
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="style-scroll" ref={scroller}>
        <div className="style-meta">
          {loading && <LoaderCircle className="spinning" size={13} />}
          {data ? (
            <span>
              {data.total} style{data.total === 1 ? "" : "s"}
              {q ? ` for “${q}”` : ""} · page {data.page} of {pageCount}
              {tab === "trends" ? " · new in the last two weeks" : ""}
              {reviewing ? " · waiting for your approval: only what you approve reaches the team" : ""}
            </span>
          ) : (
            <span>Loading the library…</span>
          )}
        </div>
        <div className="style-rows" key={key}>
          {(data ? shown : []).map((s, i) => {
            const on = ids.includes(s.id);
            const ar = s.w && s.h ? s.w / s.h : 0.75;
            const fresh = Date.now() - s.created < 2 * 86_400_000;
            return (
              <div
                key={s.id}
                className={`style-tile ${on ? "on" : ""}`}
                style={{ flexGrow: ar, flexBasis: `calc(var(--row) * ${ar})`, "--i": Math.min(i, 30) } as React.CSSProperties}
              >
                <button type="button" className="style-tile-image" style={{ aspectRatio: `${ar}` }} onClick={() => toggle(s)} aria-pressed={on} title={s.tags}>
                  <img src={styleThumb(s)} alt={s.title} loading="lazy" decoding="async" />
                  <span className="style-tile-label">
                    <small>{STYLE_CATEGORIES.find((c) => c.id === s.category)?.label ?? "Style"}</small>
                    <b>{s.title}</b>
                  </span>
                </button>
                {fresh && <span className="style-tile-new">New</span>}
                <span className="style-tile-check" aria-hidden>
                  {on && <Check size={13} strokeWidth={3} />}
                </span>
                <span className="style-tile-tools">
                  <button type="button" onClick={() => setPreview(s)} aria-label={`Open ${s.title}`} title="Open">
                    <Maximize2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => (reviewing ? void judge("remove", [s.id]) : void remove(s))}
                    aria-label={`${reviewing ? "Reject" : "Remove"} ${s.title}`}
                    title={reviewing ? "Reject: it never reaches the team" : "Remove from the library for good"}
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
            );
          })}
          {!data &&
            Array.from({ length: 18 }, (_, i) => (
              <div key={`s${i}`} className="style-tile skeleton" style={{ flexGrow: 0.75, flexBasis: "calc(var(--row) * 0.75)" }} />
            ))}
          {data && !shown.length && (
            <p className="style-empty">
              {reviewing ? "Nothing waiting: new styles arrive here every day for your approval." : q ? `Nothing for “${q}” here. Try another word or another tab.` : "No styles here yet: new ones come in every day."}
            </p>
          )}
          <span className="style-rows-end" />
        </div>
        {pageCount > 1 && (
          <nav className="style-pager" aria-label="Pages">
            <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={15} /> Previous
            </button>
            {nums.map((x, i) => (
              <span key={x} className="style-pager-num">
                {i > 0 && x - nums[i - 1] > 1 && <i>…</i>}
                <button type="button" className={`journey-chip ${x === page ? "active" : ""}`} onClick={() => setPage(x)} aria-current={x === page ? "page" : undefined}>
                  {x}
                </button>
              </span>
            ))}
            <button type="button" className="secondary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
              Next <ChevronRight size={15} />
            </button>
          </nav>
        )}
      </div>

      {(n > 0 || (pick && !reviewing)) && (
        <div className="style-dock">
          <span className="style-dock-count">{n ? `${n} selected` : pick?.mode === "grid" ? `Select the styles for ${pick.posts ?? "your"} posts` : "Select one style"}</span>
          {n > 0 && reviewing && (
            <>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void judge("remove", ids)} title="Reject: they never reach the team">
                {busy === "remove" ? <LoaderCircle className="spinning" size={14} /> : <X size={14} />} Reject
              </button>
              <button type="button" className="primary" disabled={!!busy} onClick={() => void judge("approve", ids)} title="Approve: the team sees them in the library">
                {busy === "approve" ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />} Approve {n}
              </button>
            </>
          )}
          {n > 0 && !reviewing && (
            <>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void act("refresh")} title="Write the selected styles again: a fresh take on the same idea">
                {busy === "refresh" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />} Update
              </button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void act("replace")} title="Remove the selected styles and bring new ideas">
                {busy === "replace" ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />} New ideas
              </button>
            </>
          )}
          {pick && !reviewing && (
            <button type="button" className="primary" disabled={!n || !!busy || (pick.mode === "post" && n !== 1)} onClick={() => void use()}>
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
              <small>
                {STYLE_CATEGORIES.find((c) => c.id === preview.category)?.label ?? "Style"} · {preview.tags}
              </small>
              <h2>{preview.title}</h2>
              {admin && preview.prompt ? (
                <p>{preview.prompt}</p>
              ) : (
                <p>Picked for a post, this style is written for that post's own product, its ingredients and the brand's colours.</p>
              )}
              <div className="style-preview-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    toggle(preview);
                    setPreview(null);
                  }}
                >
                  <Check size={14} /> {ids.includes(preview.id) ? "Unselect" : "Select"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void remove(preview);
                    setPreview(null);
                  }}
                >
                  <X size={14} /> Remove
                </button>
                <button type="button" className="text-button" onClick={() => setPreview(null)}>
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
