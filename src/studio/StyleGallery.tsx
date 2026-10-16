import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Check, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import { del, get, post } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

export const styleThumb = (s: Pick<StyleItem, "id" | "updated">, full = false) =>
  `/api/studio/styles/${s.id}/image?v=${s.updated}${full ? "&size=full" : ""}`;

/**
 * "Pick your style": the gallery of product-photo styles read from Pinterest. Remove one and a new
 * one takes its place; select some to update their prompts or swap them for fresh ideas. In pick
 * mode the selection goes to the month's posts.
 */
export default function StyleGallery({
  pick,
  admin,
}: {
  /** Pick mode: what the selection is used for. */
  pick?: { max: number; label: (n: number) => string; onPick: (ids: string[]) => Promise<void> | void; kind?: StyleKind };
  admin?: boolean;
}) {
  const { styles, ready, filling: busyFill } = useStyles();
  const [kind, setKind] = useState<StyleKind>(pick?.kind ?? "product");
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<StyleItem | null>(null);
  const [busy, setBusy] = useState("");
  const shown = useMemo(() => styles.filter((s) => s.kind === kind), [styles, kind]);
  const counts = useMemo(
    () => ({ product: styles.filter((s) => s.kind === "product").length, people: styles.filter((s) => s.kind === "people").length }),
    [styles],
  );

  // An unfilled gallery fills itself while it is open.
  useEffect(() => {
    if (ready && missing(store) > 0) void fill();
  }, [ready, styles.length]);

  const toggle = useCallback(
    (id: string) =>
      setSelected((sel) => {
        if (sel.includes(id)) return sel.filter((x) => x !== id);
        if (pick?.max === 1) return [id];
        return pick && sel.length >= pick.max ? sel : [...sel, id];
      }),
    [pick],
  );

  async function remove(id: string) {
    // The card leaves at once; the server puts a ready style in its place.
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
    try {
      setStore(await post<Reply>(`/api/studio/styles/${what}`, { ids: selected.slice(0, what === "refresh" ? 12 : 70) }));
      toast.success(what === "refresh" ? `${selected.length} style${selected.length > 1 ? "s" : ""} updated.` : `${selected.length} new idea${selected.length > 1 ? "s" : ""} in their places.`);
      setSelected([]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function use() {
    if (!pick || !selected.length) return;
    setBusy("pick");
    try {
      await pick.onPick(selected);
      setSelected([]);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="style-gallery">
      <div className="style-bar">
        <div className="style-tabs" role="tablist">
          {(["product", "people"] as StyleKind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={`journey-chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
              {k === "product" ? "Products" : "With people"} · {counts[k]}
            </button>
          ))}
          {busyFill && (
            <span className="style-filling">
              <LoaderCircle className="spinning" size={13} /> Reading new styles from Pinterest…
            </span>
          )}
        </div>
        <div className="style-actions">
          {selected.length > 0 && (
            <>
              <span className="style-count">{selected.length} selected</span>
              <button type="button" className="text-button" onClick={() => setSelected([])}>
                Clear
              </button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void act("refresh")} title="Write these styles again: a fresh take on the same idea">
                {busy === "refresh" ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />} Update
              </button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void act("replace")} title="Swap these for new styles">
                {busy === "replace" ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />} New ideas
              </button>
            </>
          )}
          {pick && (
            <button type="button" className="primary" disabled={!selected.length || !!busy} onClick={() => void use()}>
              {busy === "pick" ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />} {pick.label(selected.length)}
            </button>
          )}
        </div>
      </div>
      {!ready ? (
        <div className="style-grid">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="style-card skeleton" />
          ))}
        </div>
      ) : (
        <div className="style-grid">
          {shown.map((s) => {
            const on = selected.includes(s.id);
            return (
              <div key={s.id} className={`style-card ${on ? "on" : ""}`}>
                <button type="button" className="style-image" onClick={() => (pick ? toggle(s.id) : setOpen(s))} title={s.tags}>
                  <img src={styleThumb(s)} alt={s.title} loading="lazy" decoding="async" />
                </button>
                <label className="style-check" title="Select">
                  <input type="checkbox" checked={on} onChange={() => toggle(s.id)} aria-label={`Select ${s.title}`} />
                </label>
                <button type="button" className="style-x" onClick={() => void remove(s.id)} title="Remove: a new style takes its place" aria-label={`Remove ${s.title}`}>
                  <X size={12} />
                </button>
                <button type="button" className="style-title" onClick={() => setOpen(s)}>
                  {s.title}
                </button>
              </div>
            );
          })}
          {Array.from({ length: Math.max(0, STYLE_TARGET[kind] - shown.length) }, (_, i) => (
            <div key={`s${i}`} className="style-card skeleton" />
          ))}
        </div>
      )}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="style-preview">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.title}</DialogTitle>
                <DialogDescription>{open.tags}</DialogDescription>
              </DialogHeader>
              <div className="style-preview-body">
                <img src={styleThumb(open, true)} alt={open.title} />
                <div>
                  {admin && open.prompt ? (
                    <>
                      <strong>The style, for any product</strong>
                      <p>{open.prompt}</p>
                    </>
                  ) : (
                    <p className="field-hint">Picked for a post, this style is written for that post's own product, its ingredients and the brand's colours.</p>
                  )}
                  <div className="style-preview-actions">
                    {pick && (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          toggle(open.id);
                          setOpen(null);
                        }}
                      >
                        <Check size={14} /> {selected.includes(open.id) ? "Unselect" : "Select"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        void remove(open.id);
                        setOpen(null);
                      }}
                    >
                      <X size={14} /> Remove
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The gallery in a dialog, to pick styles for one post or for the whole grid. */
export function StylePicker({
  open,
  onClose,
  title,
  max,
  label,
  onPick,
  admin,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  max: number;
  label: (n: number) => string;
  onPick: (ids: string[]) => Promise<void> | void;
  admin?: boolean;
  kind?: StyleKind;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="style-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Pick the look only: each style is written for the post's own product, its ingredients and your brand.</DialogDescription>
        </DialogHeader>
        {open && (
          <StyleGallery
            admin={admin}
            pick={{
              max,
              label,
              kind,
              onPick: async (ids) => {
                await onPick(ids);
                onClose();
              },
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
