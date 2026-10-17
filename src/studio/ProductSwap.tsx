import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post } from "@/api";
import type { Post } from "@shared/posts";
import type { ProductMatch, ProductOption, ProductSource } from "@shared/drive";

const SOURCES: { id: ProductSource; label: string }[] = [
  { id: "month", label: "This month" },
  { id: "gallery", label: "Earlier months" },
  { id: "drive", label: "Drive" },
];

/** The small picture of an option, wherever it lives. */
export function optionThumb(o: Pick<ProductOption, "source" | "id">, sourceUrl: (id: string) => string): string {
  if (o.source === "month") return sourceUrl(o.id);
  if (o.source === "gallery") return `/api/studio/posts/gallery/image?id=${encodeURIComponent(o.id)}`;
  return `/api/studio/drive/photo/${encodeURIComponent(o.id)}?size=320`;
}

/**
 * A post's product: the ones that fit it best first (recommended), then every photo there is
 * (this month, earlier months, the client's Drive). Choosing one puts it on the post and writes
 * the post's shot again for it.
 */
export default function ProductSwap({
  open,
  onClose,
  batchId,
  target,
  sourceUrl,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  batchId: string | null;
  target: Post | null;
  sourceUrl: (id: string) => string;
  onChanged: () => Promise<void>;
}) {
  const [match, setMatch] = useState<ProductMatch | null>(null);
  const [matchError, setMatchError] = useState("");
  const [options, setOptions] = useState<ProductOption[] | null>(null);
  const [tab, setTab] = useState<ProductSource>("month");
  const [q, setQ] = useState("");
  const [using, setUsing] = useState("");

  useEffect(() => {
    if (!open || !batchId || !target) return;
    setMatch(null);
    setMatchError("");
    setOptions(null);
    setQ("");
    post<{ matches: ProductMatch[] }>("/api/studio/posts/products/match", { batch: batchId, indexes: [target.index] })
      .then((r) => setMatch(r.matches[0] ?? { index: target.index, picks: [] }))
      .catch((e) => setMatchError((e as Error).message));
    get<{ options: ProductOption[] }>(`/api/studio/posts/products/options?batch=${encodeURIComponent(batchId)}`)
      .then((r) => {
        setOptions(r.options);
        setTab(r.options.some((o) => o.source === "month") ? "month" : r.options.some((o) => o.source === "drive") ? "drive" : "gallery");
      })
      .catch(() => setOptions([]));
  }, [open, batchId, target?.index]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(
    () => (options ?? []).filter((o) => o.source === tab && (!q.trim() || `${o.name} ${o.note}`.toLowerCase().includes(q.trim().toLowerCase()))),
    [options, tab, q],
  );

  async function use(o: ProductOption) {
    if (!batchId || !target) return;
    const key = `${o.source}:${o.id}`;
    setUsing(key);
    try {
      const r = await post<{ post: Post }>("/api/studio/posts/products/use", { batch: batchId, index: target.index, source: o.source, id: o.id, name: o.name });
      // The shot is written again for the new product.
      await post("/api/studio/posts/shots", { batch: batchId, indexes: [target.index] });
      await onChanged();
      toast.success(`Post ${target.index} now shows ${r.post.product}; its shot is written for it.`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUsing("");
    }
  }

  const card = (o: ProductOption & { reason?: string }) => {
    const key = `${o.source}:${o.id}`;
    const current = !!target?.product && o.name.toLowerCase() === target.product.toLowerCase();
    return (
      <button
        key={key}
        type="button"
        className={`journey-thumb pick swap-card ${current ? "on" : ""}`}
        disabled={!!using}
        onClick={() => void use(o)}
        title={o.reason || o.note || o.name}
      >
        <img src={optionThumb(o, sourceUrl)} alt="" loading="lazy" />
        <figcaption dir="auto">{o.name}</figcaption>
        {o.source !== "month" && <span className="journey-tag">{o.source === "drive" ? "Drive" : "Earlier"}</span>}
        {o.reason && <small className="swap-reason">{o.reason}</small>}
        {using === key && (
          <span className="swap-busy">
            <LoaderCircle className="spinning" size={18} />
          </span>
        )}
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !using && onClose()}>
      <DialogContent className="drive-dialog">
        <DialogHeader>
          <DialogTitle>Post {target ? String(target.index).padStart(2, "0") : ""} · its product</DialogTitle>
          <DialogDescription>
            {target?.product ? `Now: ${target.product}. ` : ""}Choose the product this post shows; its shot is written again for it.
          </DialogDescription>
        </DialogHeader>
        <div className="swap-section">
          <strong>
            <Sparkles size={14} /> Recommended for this post
          </strong>
          {matchError ? (
            <p className="field-hint">{matchError}</p>
          ) : !match ? (
            <div className="journey-reading">
              <LoaderCircle className="spinning" size={16} /> Finding the products that fit this post…
            </div>
          ) : match.picks.length ? (
            <div className="drive-grid swap-recommended">{match.picks.map(card)}</div>
          ) : (
            <p className="field-hint">No product fits this post's picture (a text, place or people tile needs none), or there are no photos yet.</p>
          )}
        </div>
        <div className="swap-section">
          <div className="drive-bar">
            <div className="journey-filter">
              {SOURCES.map((s) => (
                <button key={s.id} type="button" className={`journey-chip small ${tab === s.id ? "active" : ""}`} onClick={() => setTab(s.id)}>
                  {s.label} · {(options ?? []).filter((o) => o.source === s.id).length}
                </button>
              ))}
            </div>
            <label className="swap-search">
              <Search size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a product" aria-label="Search a product" />
            </label>
          </div>
          {!options ? (
            <div className="journey-reading">
              <LoaderCircle className="spinning" size={16} /> Opening the products…
            </div>
          ) : shown.length ? (
            <div className="drive-grid">{shown.map(card)}</div>
          ) : (
            <p className="field-hint">
              {tab === "drive" ? "No Drive photos: connect the client's Drive folder from the gallery on the Products screen." : "Nothing here."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
