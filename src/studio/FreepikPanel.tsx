import { useCallback, useEffect, useState } from "react";
import { Check, Download, ImagePlus, Layers, Library, Lock, Search } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { ApiError, get, post } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import "./freepik.css";

/**
 * Freepik assets: a stock search with filters, the result grid with a licence badge, and for the
 * chosen item "Use as reference" (the post's reference picture), "Add to design" (an image layer
 * of the Text Studio) and "Download to library". A download is proposed with its estimate and
 * confirmed before anything is fetched; a file already in the library is reused. With no key the
 * panel searches a labelled demo catalogue and nothing leaves the server. Members see the entry
 * with "Admins only for now". A Freepik asset never changes the theme, the engine or a product photo.
 */

export type AssetKind = "photo" | "vector" | "psd" | "template";

export interface FreepikStatus {
  connected: boolean;
  demo: boolean;
  reason: string;
  admin: boolean;
  access: string;
  plan: "premium" | "business" | "unknown";
  planLabel: string;
  downloadEstimate: number | null;
  entitlements: Record<string, unknown>;
  /** Connected through the Magnific sign-in or, the advanced path, a pasted token. */
  mcp: { connected: boolean; signedIn?: boolean; token?: boolean; url: string };
  switch: { enabled: boolean; reason: string };
}

export interface StockItem {
  id: string;
  kind: AssetKind;
  title: string;
  author: string;
  license: { type: "freemium" | "premium"; attribution: boolean; uses: string[]; url?: string };
  preview: string;
  width: number | null;
  height: number | null;
  orientation: string;
  flattened: boolean;
  formats: string[];
  url: string;
  demo: boolean;
}

export interface AssetItem {
  id: string;
  client: string | null;
  providerId: string;
  kind: AssetKind;
  title: string;
  author: string;
  license: StockItem["license"];
  preview: string;
  file: string | null;
  stored: boolean;
  mime: string | null;
  width: number | null;
  height: number | null;
  flattened: boolean;
  layerable: boolean;
  demo: boolean;
  uses?: number;
}

interface SearchAnswer {
  items: StockItem[];
  page: number;
  lastPage: number;
  total: number;
  demo: boolean;
  connected: boolean;
  downloadEstimate: number | null;
}

export interface FreepikLayer {
  src: string;
  name: string;
  flattened: boolean;
  assetId: string;
}

export interface FreepikPanelProps {
  clientId: string;
  batchId?: string | null;
  /** The post the asset goes to; when absent, `posts` offers a choice. */
  post?: number;
  slide?: number;
  posts?: { index: number; title: string }[];
  /** Which actions are offered: both, only the reference, or only the design layer. */
  mode?: "all" | "reference" | "design";
  /** Design mode: the id the Text Studio gives the new image layer, so the use is recorded against it. */
  layerId?: string;
  onReference?: (post: number) => void | Promise<void>;
  onDesign?: (layer: FreepikLayer) => void;
}

const KINDS: { id: AssetKind | ""; label: string }[] = [
  { id: "", label: "Any type" },
  { id: "photo", label: "Photos" },
  { id: "vector", label: "Vectors" },
  { id: "psd", label: "PSD" },
  { id: "template", label: "Templates" },
];
const ORIENTATIONS = ["", "landscape", "portrait", "square", "panoramic"] as const;
const COLORS = ["", "black", "blue", "gray", "green", "orange", "red", "white", "yellow", "purple", "cyan", "pink"] as const;

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The licence badge: free with attribution, premium in the plan, credits, or cost not known. */
export function licenseBadge(item: Pick<StockItem, "license" | "demo">, status: FreepikStatus | null): { text: string; cls: string } {
  const est = status?.downloadEstimate ?? null;
  if (item.license.type === "freemium") return est && est > 0 ? { text: `Free · credits: ${est}`, cls: "credits" } : { text: "Free with attribution", cls: "free" };
  if (item.demo || !status?.connected) return { text: "Premium · demo", cls: "premium" };
  if (est === 0) return { text: "Premium · in your plan", cls: "premium" };
  if (est === null) return { text: "Premium · cost not known", cls: "unknown" };
  return { text: `Credits: ${est}`, cls: "credits" };
}

/** What the format allows: a flattened picture, or an editable vector the Text Studio can draw. */
export function formatLabel(item: { kind: AssetKind; flattened: boolean; formats?: string[]; mime?: string | null }): string {
  if (item.kind === "vector") return item.formats?.includes("svg") || /svg/.test(item.mime ?? "") ? "Editable vector (SVG): works as an image layer" : "Vector source files: editable in Illustrator, not as layers here";
  if (item.kind === "psd" || item.kind === "template") return "Flattened picture, not editable layers (PSD preview)";
  return "Flattened picture, not editable layers";
}

export function useFreepikStatus(): FreepikStatus | null {
  const [status, setStatus] = useState<FreepikStatus | null>(null);
  useEffect(() => {
    let live = true;
    get<FreepikStatus>("/api/studio/freepik/status")
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export default function FreepikPanel({ clientId, batchId, post: fixedPost, slide, posts, mode = "all", layerId, onReference, onDesign }: FreepikPanelProps) {
  const status = useFreepikStatus();
  const [tab, setTab] = useState<"search" | "library">("search");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<AssetKind | "">("");
  const [orientation, setOrientation] = useState<string>("");
  const [color, setColor] = useState<string>("");
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [library, setLibrary] = useState<AssetItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<StockItem | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<AssetItem | null>(null);
  const [busy, setBusy] = useState<"reference" | "design" | "download" | null>(null);
  const [postIndex, setPostIndex] = useState<number>(fixedPost ?? posts?.[0]?.index ?? 1);
  useEffect(() => {
    if (fixedPost) setPostIndex(fixedPost);
  }, [fixedPost]);

  const search = useCallback(
    async (p = 1) => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q, type: kind, orientation, color, page: String(p), client: clientId });
        const r = await get<SearchAnswer>(`/api/studio/freepik/search?${params}`);
        setAnswer(r);
        setPage(p);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "The search failed.");
      } finally {
        setSearching(false);
      }
    },
    [q, kind, orientation, color, clientId],
  );

  const loadLibrary = useCallback(async () => {
    try {
      const r = await get<{ assets: AssetItem[] }>(`/api/studio/freepik/assets?client=${encodeURIComponent(clientId)}`);
      setLibrary(r.assets);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The library could not be read.");
    }
  }, [clientId]);

  useEffect(() => {
    if (status?.admin && tab === "library" && library === null) void loadLibrary();
  }, [status?.admin, tab, library, loadLibrary]);
  useEffect(() => {
    if (status?.admin && answer === null) void search(1);
    // The first search runs once the status says the viewer may search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.admin]);

  /** The item in the library with its file: proposed, confirmed with its estimate, downloaded once, reused afterwards. */
  async function ensureStored(item: { id: string; title: string }, withPost: boolean): Promise<AssetItem> {
    const base = { id: item.id, client: clientId, batch: batchId ?? undefined, post: withPost ? postIndex : undefined };
    try {
      const r = await post<{ asset: AssetItem; reused: boolean }>("/api/studio/freepik/download", base);
      return r.asset;
    } catch (e) {
      if (!(e instanceof ApiError) || !e.data.needsConfirm) throw e;
      const estimate = e.data.estimate as number | null;
      const what = estimate === 0 ? "No credits: this download is in the plan." : `About ${estimate} credits from the Freepik balance.`;
      const ok = await askConfirm(`Download "${item.title}" to the library? ${what} The file is kept and reused; nothing is downloaded twice.`, { ok: "Download", danger: false, cancel: "Not now" });
      if (!ok) throw new Error("Not downloaded.");
      const r = await post<{ asset: AssetItem; reused: boolean }>("/api/studio/freepik/download", { ...base, confirm: true });
      return r.asset;
    }
  }

  async function act(kindOf: "reference" | "design" | "download") {
    const item = selectedAsset ? { id: selectedAsset.providerId, title: selectedAsset.title } : selected ? { id: selected.id, title: selected.title } : null;
    if (!item) return;
    if (kindOf !== "download" && !batchId) return toast.error("Save the month first.");
    setBusy(kindOf);
    try {
      const asset = selectedAsset?.stored ? selectedAsset : await ensureStored(item, kindOf !== "download");
      if (kindOf === "download") {
        toast.success(asset.stored ? `"${asset.title}" is in the library.` : "Downloaded to the library.");
      } else {
        const r = await post<{ layer?: FreepikLayer & { layerable: boolean }; reference?: { key: string } }>("/api/studio/freepik/use", { asset: asset.id, batch: batchId, post: postIndex, slide, role: kindOf, layerId: kindOf === "design" ? layerId : undefined });
        if (kindOf === "reference") {
          toast.success(`Reference on post ${postIndex}: its next picture takes it.`);
          await onReference?.(postIndex);
        } else if (r.layer) {
          onDesign?.({ src: r.layer.src, name: r.layer.name, flattened: r.layer.flattened, assetId: asset.id });
        }
      }
      setLibrary(null);
      setSelectedAsset(asset);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "That did not work.";
      if (msg !== "Not downloaded.") toast.error(msg);
    } finally {
      setBusy(null);
    }
  }

  if (status === null) return <p className="fp-note">Checking the Freepik connection…</p>;
  if (!status.admin)
    return (
      <div className="fp-locked" role="note">
        <strong>
          <Lock size={14} /> Freepik assets · Admins only for now
        </strong>
        <span>Stock photos, vectors and templates from Freepik as a post's reference or a design layer. Access is restricted until wider access is approved; ask an admin to add the asset for you.</span>
      </div>
    );
  if (!status.switch.enabled)
    return (
      <div className="fp-locked" role="note">
        <strong>
          <Lock size={14} /> Freepik assets · switched off
        </strong>
        <span>{status.switch.reason || "The integration is off."}</span>
      </div>
    );

  const current = selectedAsset ?? selected;
  const badge = current ? licenseBadge(current, status) : null;
  const canReference = mode !== "design";
  const canDesign = mode !== "reference" && (!selectedAsset || selectedAsset.layerable);

  return (
    <div className="fp-panel">
      <div className="fp-head">
        <strong>
          <Search size={14} /> Freepik assets
        </strong>
        {status.demo ? <span className="fp-demo" title={status.reason}>Demo catalogue · Not connected</span> : <span className="fp-note">Connected · {status.plan === "premium" ? "downloads in the plan (100 a day)" : status.plan === "business" ? "downloads billed in credits" : "plan not set"}</span>}
        <span className="fp-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>
            Search
          </button>
          <button type="button" role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
            Library
          </button>
        </span>
      </div>

      {tab === "search" && (
        <>
          <form
            className="fp-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search(1);
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Freepik: pistachio dessert, lantern pattern…" aria-label="Search Freepik" />
            <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind | "")} aria-label="Type">
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <select value={orientation} onChange={(e) => setOrientation(e.target.value)} aria-label="Orientation">
              {ORIENTATIONS.map((o) => (
                <option key={o} value={o}>
                  {o ? cap(o) : "Any orientation"}
                </option>
              ))}
            </select>
            <select value={color} onChange={(e) => setColor(e.target.value)} aria-label="Colour">
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c ? cap(c) : "Any colour"}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary" disabled={searching}>
              {searching ? <Orb size={14} /> : <Search size={14} />} Search
            </button>
          </form>
          {answer && !answer.items.length && <p className="fp-empty">Nothing found{answer.demo ? " in the demo catalogue (try mango, coffee, lantern, sale, story)" : ""}.</p>}
          {answer && answer.items.length > 0 && (
            <div className="fp-grid" role="list">
              {answer.items.map((it) => {
                const b = licenseBadge(it, status);
                return (
                  <button key={it.id} type="button" role="listitem" className={`fp-card ${selected?.id === it.id && !selectedAsset ? "on" : ""}`} onClick={() => { setSelected(it); setSelectedAsset(null); }} title={`${it.title} · ${it.author}`}>
                    <img src={it.preview} alt="" loading="lazy" />
                    <span className={`fp-badge ${b.cls}`}>{b.text}</span>
                    <span className="fp-title">{it.title}</span>
                    <span className="fp-format">{it.kind === "vector" ? (it.formats.includes("svg") ? "Editable vector" : "Vector files") : "Flattened picture"}</span>
                  </button>
                );
              })}
            </div>
          )}
          {answer && answer.lastPage > 1 && (
            <div className="fp-pager">
              <button type="button" className="text-button" disabled={page <= 1 || searching} onClick={() => void search(page - 1)}>
                Previous
              </button>
              <span>
                Page {page} of {answer.lastPage}
              </span>
              <button type="button" className="text-button" disabled={page >= answer.lastPage || searching} onClick={() => void search(page + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}

      {tab === "library" && (
        <>
          {library === null && <p className="fp-note">Reading the library…</p>}
          {library && !library.length && <p className="fp-empty">Nothing in the library yet: search and download an asset.</p>}
          {library && library.length > 0 && (
            <div className="fp-grid" role="list">
              {library.map((a) => {
                const b = licenseBadge(a, status);
                return (
                  <button key={a.id} type="button" role="listitem" className={`fp-card ${selectedAsset?.id === a.id ? "on" : ""}`} onClick={() => { setSelectedAsset(a); setSelected(null); }} title={`${a.title} · ${a.author}`}>
                    <img src={a.file ?? a.preview} alt="" loading="lazy" />
                    <span className={`fp-badge ${b.cls}`}>{b.text}</span>
                    {a.stored && (
                      <span className="fp-stored" title="In the library">
                        <Check size={12} />
                      </span>
                    )}
                    <span className="fp-title">{a.title}</span>
                    <span className="fp-format">{a.uses ? `Used ${a.uses}×` : "Not used yet"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {current && badge && (
        <div className="fp-selected">
          <img src={selectedAsset?.file ?? current.preview} alt="" />
          <div className="fp-selected-text">
            <b>{current.title}</b>
            <span className="fp-meta">
              {current.author ? `${current.author} · ` : ""}
              {cap(current.kind)}
              {current.width && current.height ? ` · ${current.width}×${current.height}` : ""}
              {" · "}
              <span className={`fp-badge-inline ${badge.cls}`}>{badge.text}</span>
            </span>
            <span className="fp-note">{formatLabel({ kind: current.kind, flattened: current.flattened, formats: selected?.formats, mime: selectedAsset?.mime })}</span>
            {current.license.attribution && <span className="fp-note">Free licence: credit the author ({current.author || "Freepik"}) where the post is published.</span>}
            {!fixedPost && posts && posts.length > 0 && mode !== "design" && (
              <label className="fp-post">
                For post
                <select value={postIndex} onChange={(e) => setPostIndex(Number(e.target.value))}>
                  {posts.map((p) => (
                    <option key={p.index} value={p.index}>
                      {p.index}. {p.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="fp-actions">
              {canReference && (
                <button type="button" className="primary" disabled={!!busy || !batchId} onClick={() => void act("reference")} title="The picture attached to the post as its reference: the next take or revision uses it. It does not change the theme.">
                  {busy === "reference" ? <Orb size={14} /> : <ImagePlus size={14} />} Use as reference
                </button>
              )}
              {canDesign && (
                <button type="button" className={canReference ? "secondary" : "primary"} disabled={!!busy || !batchId} onClick={() => void act("design")} title="An image layer in the Text Studio over the post's picture">
                  {busy === "design" ? <Orb size={14} /> : <Layers size={14} />} Add to design
                </button>
              )}
              <button type="button" className="secondary" disabled={!!busy || !!selectedAsset?.stored} onClick={() => void act("download")}>
                {busy === "download" ? <Orb size={14} /> : selectedAsset?.stored ? <Check size={14} /> : <Download size={14} />} {selectedAsset?.stored ? "In the library" : "Download to library"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The panel in a dialog, for the Text Studio's Add menu and the Direction board. */
export function FreepikDialog({ open, onClose, title, description, ...panel }: { open: boolean; onClose: () => void; title?: string; description?: string } & FreepikPanelProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="fp-dialog">
        <DialogHeader>
          <DialogTitle>
            <Library size={16} style={{ display: "inline", verticalAlign: "-3px", marginRight: 6 }} />
            {title ?? "Freepik assets"}
          </DialogTitle>
          <DialogDescription>{description ?? "Stock photos, vectors and templates from Freepik, as a post's reference picture or a design layer. Never the theme, the engine or a product photo."}</DialogDescription>
        </DialogHeader>
        {open && <FreepikPanel {...panel} />}
      </DialogContent>
    </Dialog>
  );
}
