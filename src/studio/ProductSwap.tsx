import { useEffect, useMemo, useState } from "react";
import { Check, HardDrive, LoaderCircle, RefreshCw, Repeat, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post } from "@/api";
import type { Post } from "@shared/posts";
import { NO_PRODUCT_TILES, type ProductMatch, type ProductOption, type ProductSource } from "@shared/drive";

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

/** Puts the product on the post, then writes the post's shot again for it. */
export async function putProduct(batchId: string, index: number, o: ProductOption): Promise<Post> {
  const r = await post<{ post: Post }>("/api/studio/posts/products/use", { batch: batchId, index, source: o.source, id: o.id, name: o.name });
  await post("/api/studio/posts/shots", { batch: batchId, indexes: [index] });
  return r.post;
}

/** Posts that show a product (not greetings, offers, or text, place and people tiles). */
export const needsProduct = (x: Post) => x.type !== "greeting" && x.type !== "offer" && !NO_PRODUCT_TILES.has(x.tileSpec?.kind ?? "");

const sameName = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Under the props on the shots screen: the products that fit each post best (the client's Drive,
 * earlier months, this month), each with Use or Replace.
 */
export function RecommendedProducts({
  batchId,
  plan,
  monthProducts,
  sourceUrl,
  onChanged,
}: {
  batchId: string | null;
  plan: Post[];
  /** Display names of this month's product photos. */
  monthProducts: string[];
  sourceUrl: (id: string) => string;
  onChanged: () => Promise<void>;
}) {
  const posts = plan.filter(needsProduct);
  const sig = posts.map((x) => `${x.index}:${x.headline ?? ""}`).join("|");
  const [data, setData] = useState<{ matches: ProductMatch[]; drive: number } | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [using, setUsing] = useState("");
  useEffect(() => {
    if (!batchId || !sig) return;
    setData(null);
    setError("");
    post<{ matches: ProductMatch[]; drive: number }>("/api/studio/posts/products/match", { batch: batchId, indexes: sig.split("|").map((x) => Number(x.split(":")[0])) })
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [batchId, sig, tick]);

  async function use(index: number, o: ProductOption) {
    if (!batchId) return;
    setUsing(`${index}:${o.source}:${o.id}`);
    try {
      const p = await putProduct(batchId, index, o);
      await onChanged();
      toast.success(`Post ${index} now shows ${p.product}; its shot is written for it.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUsing("");
    }
  }

  if (!posts.length) return null;
  return (
    <div className="journey-box recommended-box">
      <div className="journey-box-title">
        <Sparkles size={15} />
        <strong>Recommended products</strong>
        <span className="journey-box-actions">
          <button type="button" className="text-button" onClick={() => setTick((t) => t + 1)} disabled={!data && !error} title="Look again">
            <RefreshCw size={13} />
          </button>
        </span>
      </div>
      {data && !data.drive && (
        <p className="field-hint drive-hint">
          <HardDrive size={13} /> No Drive photos yet: connect the client's folder from the gallery's Drive button on the Products screen.
        </p>
      )}
      {error ? (
        <p className="field-hint">{error}</p>
      ) : !data ? (
        <div className="journey-reading">
          <LoaderCircle className="spinning" size={16} /> Finding the products that fit each post…
        </div>
      ) : (
        <ol className="recommended-list">
          {posts.map((x) => {
            const picks = data.matches.find((m) => m.index === x.index)?.picks ?? [];
            const hasPhoto = monthProducts.some((n) => sameName(n, x.product));
            return (
              <li key={x.index}>
                <span className="recommended-post">
                  <b>{String(x.index).padStart(2, "0")}</b>
                  <span dir="auto">{x.headline || x.title}</span>
                </span>
                {picks.length ? (
                  <div className="recommended-picks">
                    {picks.slice(0, 2).map((o) => {
                      const key = `${x.index}:${o.source}:${o.id}`;
                      const current = hasPhoto && sameName(o.name, x.product);
                      return (
                        <figure key={key} className="recommended-pick" title={o.reason || o.note}>
                          <img src={optionThumb(o, sourceUrl)} alt="" loading="lazy" />
                          <figcaption dir="auto">{o.name}</figcaption>
                          {o.source !== "month" && <span className="journey-tag">{o.source === "drive" ? "Drive" : "Earlier"}</span>}
                          {current ? (
                            <span className="recommended-in">
                              <Check size={12} /> In use
                            </span>
                          ) : (
                            <button type="button" className="secondary" disabled={!!using} onClick={() => void use(x.index, o)}>
                              {using === key ? <LoaderCircle className="spinning" size={12} /> : hasPhoto ? <Repeat size={12} /> : <Check size={12} />}
                              {hasPhoto ? "Replace" : "Use"}
                            </button>
                          )}
                        </figure>
                      );
                    })}
                  </div>
                ) : (
                  <small className="field-hint">Nothing fits this post yet.</small>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
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
    post<{ matches: ProductMatch[]; drive: number }>("/api/studio/posts/products/match", { batch: batchId, indexes: [target.index] })
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
      const p = await putProduct(batchId, target.index, o);
      await onChanged();
      toast.success(`Post ${target.index} now shows ${p.product}; its shot is written for it.`);
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
