import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Grid3x3, Link2, LoaderCircle, Maximize2, RefreshCw, Search, Sparkles, Upload, X } from "lucide-react";
import { del, get, post, postForm } from "@/api";
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
  { id: "grid", label: "Grids" },
  ...STYLE_CATEGORIES.filter((c) => c.id !== "grid").map((c) => ({ id: c.id, label: c.label })),
];

const shelfLabel = (s: Pick<StyleItem, "category" | "tiles" | "client" | "waiting">) =>
  s.category === "grid"
    ? `${s.waiting ? "Waiting · " : ""}${s.client ? "Suggested · " : ""}Grid${s.tiles ? ` · ${s.tiles} posts` : ""}`
    : (STYLE_CATEGORIES.find((c) => c.id === s.category)?.label ?? "Style");

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
  forClient,
  clients,
}: {
  /** The client the team works on: "Add to Habibah's" and a tab with that client's collection. */
  forClient?: { id: string; name: string };
  /** Without a client in hand (the library page), the dock offers every client to add to. */
  clients?: { id: string; name: string }[];
  open: boolean;
  onClose: () => void;
  admin?: boolean;
  /** The admin's queue changed (the sidebar's badge follows). */
  onPendingChange?: () => void;
  /**
   * Picking for one post ("post"), for the posts of the month ("grid", spread over `posts` posts),
   * or the feed grid the whole month follows ("feed", one from the Grids shelf).
   */
  pick?: {
    mode: "post" | "grid" | "feed";
    posts?: number;
    label?: string;
    tab?: string;
    /** The client the grid is picked for: its suggested grids come first. */
    client?: string;
    onPick: (ids: string[], items: StyleItem[]) => Promise<void> | void;
  };
}) {
  const [tab, setTab] = useState(pick?.tab ?? "all");
  const reviewing = !!admin && tab === "review";
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const key = `${tab}|${q}|${page}|${forClient?.id ?? pick?.client ?? ""}`;
  const [data, setData] = useState<Page | null>(pages.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<StyleItem[]>([]);
  const [preview, setPreview] = useState<StyleItem | null>(null);
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState("");
  const [asGrid, setAsGrid] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const single = pick?.mode === "post" || pick?.mode === "feed";
  const clientId = forClient?.id ?? pick?.client;
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

  // Every list the screen loads asks the same way: the client's suggestions first and, for the admin
  // picking a month's grid, the grids still waiting for approval.
  const query = useCallback(
    () =>
      new URLSearchParams({
        tab,
        q,
        page: String(page),
        ...(clientId ? { client: clientId } : {}),
        ...(pick?.mode === "feed" && admin ? { waiting: "1" } : {}),
      }).toString(),
    [tab, q, page, clientId, pick?.mode, admin],
  );

  const load = useCallback(
    async (force = false) => {
      const cached = pages.get(key);
      if (cached) setData(cached);
      if (cached && !force) return;
      setLoading(true);
      try {
        apply(await get<Page>(`/api/studio/styles?${query()}`), key);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [key, apply, query],
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
    if (single && selected.length !== 1) return;
    setBusy("pick");
    try {
      // A grid still waiting is approved by the admin's pick: it joins the shelf as it is used.
      const waiting = selected.filter((x) => x.waiting).map((x) => x.id);
      if (waiting.length && admin) {
        await post("/api/studio/styles/approve", { ids: waiting });
        pages.clear();
        onPendingChange?.();
      }
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
      const r = await post<Page & { added: number; failed: string[] }>("/api/studio/styles/add", { links: list.slice(0, 20), grid: asGrid || undefined });
      pages.clear();
      remember(r.styles);
      toast.success(`${r.added} ${asGrid ? "grid" : "pin"}${r.added === 1 ? "" : "s"} added${asGrid ? " (on Grids)" : " (on Trends)"}.${r.failed.length ? ` ${r.failed.length} could not be read.` : ""}`);
      setLinks("");
      setAdding(false);
      setTyped("");
      setTab(asGrid ? "grid" : "trends");
      setPage(1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /** "Add to Habibah's": the selection joins the client's own collection (the admin's also approves). */
  async function saveTo(client: { id: string; name: string }, list = ids) {
    if (!list.length) return;
    setBusy("save");
    try {
      changed(await post<Page>(`/api/studio/styles/save?${query()}`, { client: client.id, ids: list }));
      toast.success(`${list.length} added to ${client.name}'s styles. They come first whenever you pick for ${client.name}.`);
      setSelected([]);
      onPendingChange?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function unsave(list: string[]) {
    if (!forClient || !list.length) return;
    try {
      changed(await post<Page>(`/api/studio/styles/unsave?${query()}`, { client: forClient.id, ids: list }));
      setSelected((sel) => sel.filter((x) => !list.includes(x.id)));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** The team's own pictures from the computer: feed grids, or photo styles. */
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy("upload");
    const form = new FormData();
    for (const f of Array.from(files).slice(0, 10)) form.append("file", f);
    if (asGrid) form.append("grid", "1");
    try {
      const r = await postForm<Page & { added: number; failed: string[] }>("/api/studio/styles/upload", form);
      pages.clear();
      remember(r.styles);
      const what = `${r.added} ${asGrid ? "grid" : "picture"}${r.added === 1 ? "" : "s"}`;
      toast.success(`${admin ? `${what} added${asGrid ? " to Grids" : ""}` : `${what} sent to the admin for approval`}.${r.failed.length ? ` ${r.failed.length} could not be read.` : ""}`);
      setAdding(false);
      setTyped("");
      setTab(admin ? (asGrid ? "grid" : "trends") : tab);
      setPage(1);
      if (!admin) void load(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  if (!open) return null;
  const n = selected.length;
  // A month's grid is picked from the Grids shelf only; a post never takes a whole grid.
  const shelves = pick?.mode === "feed" ? TABS.filter((t) => t.id === "grid") : pick ? TABS.filter((t) => t.id !== "grid") : TABS;
  const tabs = forClient && pick?.mode !== "feed" ? [{ id: "saved", label: `${forClient.name}'s` }, ...shelves] : shelves;
  const counts = data?.counts ?? {};
  const pageCount = data?.pages ?? 1;
  const useLabel = !pick
    ? ""
    : pick.mode === "feed"
      ? n === 1
        ? "Follow this grid"
        : n > 1
          ? "Select one grid"
          : "Pick a grid"
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
            <span className="style-eyebrow">{pick ? (pick.mode === "feed" ? "The month's grid" : pick.mode === "grid" ? "Style grid" : pick.label ?? "One post") : "Style library"}</span>
          </div>
          <h1 className="style-title">{pick?.mode === "feed" || tab === "grid" ? "Pick your grid" : "Pick your style"}</h1>
          <label className="style-search">
            <Search size={15} />
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={tab === "grid" ? "Search: pastel, cafe, skincare, gold…" : "Search: balloons, ice, gift box, ramadan…"}
              aria-label="Search the styles"
            />
            {typed && (
              <button type="button" onClick={() => setTyped("")} aria-label="Clear the search">
                <X size={13} />
              </button>
            )}
          </label>
          <div className="style-top-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setAsGrid(pick?.mode === "feed" || tab === "grid");
                setAdding((v) => !v);
              }}
              title="Add your own pictures or Pinterest pins to the library"
            >
              <Link2 size={14} /> Add
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
              placeholder={
                asGrid
                  ? "Paste Pinterest links of whole Instagram feeds (pin.it/… or pinterest.com/pin/…), one per line, or upload screenshots of feeds."
                  : "Paste Pinterest links (pin.it/… or pinterest.com/pin/…), one per line, or upload your own pictures."
              }
            />
            <div className="style-add-actions">
              <label className="check-row" title="A whole Instagram feed: a month follows it tile by tile">
                <input type="checkbox" checked={asGrid} onChange={(e) => setAsGrid(e.target.checked)} />
                <Grid3x3 size={13} /> Feed grids
              </label>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => fileInput.current?.click()}>
                {busy === "upload" ? <LoaderCircle className="spinning" size={14} /> : <Upload size={14} />} Upload pictures
              </button>
              <button type="button" className="primary" disabled={!!busy || !links.trim()} onClick={() => void addLinks()}>
                {busy === "add" ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />} Add links
              </button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
            </div>
          </div>
        )}
        <div className="style-top-row">
          <div className="style-tabs" role="tablist">
            {[...(admin && !pick ? [{ id: "review", label: "To approve" }] : []), ...tabs].map((t) => (
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
                {t.id === "trends" && <Sparkles size={12} />}
                {t.id === "grid" && <Grid3x3 size={12} />}
                {t.id === "saved" && <Check size={12} />} {t.label}
                {counts[t.id] !== undefined && <em>{counts[t.id]}</em>}
              </button>
            ))}
          </div>
          <div className="style-select" hidden={single}>
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
                    <small>{shelfLabel(s)}</small>
                    <b>{s.title}</b>
                  </span>
                </button>
                {s.saved && forClient ? (
                  <span className="style-tile-new saved">{forClient.name}</span>
                ) : s.waiting ? (
                  <span className="style-tile-new waiting">Waiting</span>
                ) : (
                  fresh && <span className="style-tile-new">New</span>
                )}
                <span className="style-tile-check" aria-hidden>
                  {on && <Check size={13} strokeWidth={3} />}
                </span>
                <span className="style-tile-tools">
                  <button type="button" onClick={() => setPreview(s)} aria-label={`Open ${s.title}`} title="Open">
                    <Maximize2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => (reviewing ? void judge("remove", [s.id]) : tab === "saved" ? void unsave([s.id]) : void remove(s))}
                    aria-label={`${reviewing ? "Reject" : "Remove"} ${s.title}`}
                    title={
                      reviewing
                        ? "Reject: it never reaches the team"
                        : tab === "saved"
                          ? `Take it out of ${forClient?.name ?? "the client"}'s styles (it stays in the library)`
                          : "Remove from the library for good"
                    }
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
              {reviewing
                ? "Nothing waiting: new styles arrive here every day for your approval."
                : q
                  ? `Nothing for “${q}” here. Try another word or another tab.`
                  : tab === "grid" && counts.gridWaiting
                    ? `${counts.gridWaiting} grids are waiting for the admin's approval; they show here once approved.`
                    : "No styles here yet: new ones come in every day."}
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
          <span className="style-dock-count">
            {n ? `${n} selected` : pick?.mode === "grid" ? `Select the styles for ${pick.posts ?? "your"} posts` : pick?.mode === "feed" ? "Select one grid" : "Select one style"}
          </span>
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
          {n > 0 && !reviewing && forClient && tab !== "saved" && (
            <button type="button" className="secondary style-save" disabled={!!busy} onClick={() => void saveTo(forClient)} title={`Keep these for ${forClient.name}: they come first whenever you pick for ${forClient.name}`}>
              {busy === "save" ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />} Add to {forClient.name}'s
            </button>
          )}
          {n > 0 && !reviewing && !forClient && clients && clients.length > 0 && (
            <select
              className="style-save-select"
              value=""
              disabled={!!busy}
              aria-label="Add to a client's styles"
              onChange={(e) => {
                const c = clients.find((x) => x.id === e.target.value);
                if (c) void saveTo(c);
              }}
            >
              <option value="">Add to a client's…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {n > 0 && !reviewing && tab === "saved" && forClient && (
            <button type="button" className="secondary" disabled={!!busy} onClick={() => void unsave(ids)}>
              <X size={14} /> Take out of {forClient.name}'s
            </button>
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
            <button type="button" className="primary" disabled={!n || !!busy || (single && n !== 1)} onClick={() => void use()}>
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
                {shelfLabel(preview)} · {preview.tags}
              </small>
              <h2>{preview.title}</h2>
              {admin && preview.prompt ? (
                <p>{preview.prompt}</p>
              ) : (
                <p>
                  {preview.category === "grid"
                    ? "Picked for a month, the posts follow this feed tile by tile, with the brand's own products, people and colours."
                    : "Picked for a post, this style is written for that post's own product, its ingredients and the brand's colours."}
                </p>
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
