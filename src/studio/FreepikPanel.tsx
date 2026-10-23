import { useCallback, useEffect, useRef, useState } from "react";
import { BookmarkPlus, Check, ImagePlus, Layers, Library, Lock, PanelBottom, Scissors, Search, SlidersHorizontal, Type } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { ApiError, get, post } from "@/api";
import { layerId as newLayerId } from "@shared/layers";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SourceBadge from "./SourceBadge";
import "./freepik.css";

/**
 * Freepik assets: one search with filter chips (Icons, Photos, Backgrounds, Textures, Typography),
 * the results in their own scrolling area, and the chosen item's compact preview with its actions
 * in a footer that never scrolls away: Add as layer, Set as background, Use as reference and Save
 * to library. Every download is proposed with its estimate and confirmed first; a file already in
 * the library is reused (nothing is downloaded twice). Layer and background edits are free: no
 * picture is made. With no key the panel searches a labelled demo catalogue and nothing leaves the
 * server. Members see the actions with "Admins only for now". A Freepik asset never changes the
 * theme, the engine or a product photo.
 */

export type AssetKind = "photo" | "vector" | "psd" | "template";
export type Category = "icons" | "photos" | "backgrounds" | "textures" | "typography";

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
  /** Read from the bytes when stored: "SVG", "EPS/AI", "PSD", "JPG"…; null before. */
  format?: string | null;
  editable?: boolean;
  colors?: string[];
  formatNote?: string | null;
  layerSrc?: string | null;
  lettering?: boolean;
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

/** The image layer an asset becomes, as the server's design use answers it. */
export interface FreepikLayer {
  src: string;
  name: string;
  flattened: boolean;
  assetId: string;
  /** The id the use was recorded against: the new layer takes it. */
  layerId?: string;
  format?: string | null;
  editable?: boolean;
  colors?: string[];
  note?: string | null;
  lettering?: boolean;
  kind?: AssetKind;
  aspect?: number | null;
  preview?: boolean;
}

/** As one image layer, as the background, or (an SVG vector) as separate layers, one per group or shape. */
export type DesignHow = "layer" | "background" | "pieces";

export interface FreepikPanelProps {
  clientId: string;
  batchId?: string | null;
  /** The post the asset goes to; when absent, `posts` offers a choice. */
  post?: number;
  slide?: number;
  posts?: { index: number; title: string }[];
  /** Which actions are offered: all four, only the reference (and the library), or only the design ones. */
  mode?: "all" | "reference" | "design";
  /** Design mode: the id the Text Studio gives the new image layer, so the use is recorded against it. */
  layerId?: string;
  onReference?: (post: number) => void | Promise<void>;
  /** Add as layer / Set as background: the Text studio adds it in place; the Photo studio carries it to the Text studio. */
  onDesign?: (layer: FreepikLayer, how: DesignHow) => void | Promise<void>;
  /** "Add editable text": a normal text layer, offered next to decorative lettering. */
  onAddText?: () => void;
  /** Where the panel sits: fills its column (results scroll inside, the footer stays) or keeps its own height. */
  fill?: boolean;
  /** What "Add as layer" says it does here. */
  layerHint?: string;
}

const KINDS: { id: AssetKind | ""; label: string }[] = [
  { id: "", label: "Any type" },
  { id: "photo", label: "Photos" },
  { id: "vector", label: "Vectors" },
  { id: "psd", label: "PSD" },
  { id: "template", label: "Templates" },
];
const CHIPS: { id: Category | ""; label: string }[] = [
  { id: "", label: "All" },
  { id: "icons", label: "Icons" },
  { id: "photos", label: "Photos" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "textures", label: "Textures" },
  { id: "typography", label: "Typography" },
];
const ORIENTATIONS = ["", "landscape", "portrait", "square", "panoramic"] as const;
const COLORS = ["", "black", "blue", "gray", "green", "orange", "red", "white", "yellow", "purple", "cyan", "pink"] as const;

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const LETTERING_LABEL = "Decorative lettering (not editable text)";
export const BACKGROUND_HINT = "Set as background puts the asset behind the photo, across the whole post. It shows where the photo is transparent (a cut-out) and around the photo when you make the photo smaller. The photo is not made again and nothing is spent.";

/** The licence badge: free with attribution, premium in the plan, credits, or cost not known. */
export function licenseBadge(item: Pick<StockItem, "license" | "demo">, status: FreepikStatus | null): { text: string; cls: string } {
  const est = status?.downloadEstimate ?? null;
  if (item.license.type === "freemium") return est && est > 0 ? { text: `Free · credits: ${est}`, cls: "credits" } : { text: "Free with attribution", cls: "free" };
  if (item.demo || !status?.connected) return { text: "Premium · demo", cls: "premium" };
  if (est === 0) return { text: "Premium · in your plan", cls: "premium" };
  if (est === null) return { text: "Premium · cost not known", cls: "unknown" };
  return { text: `Credits: ${est}`, cls: "credits" };
}

/** What the format allows, said plainly: before the download from the formats Freepik lists, after it from the bytes. */
export function formatLabel(item: { kind: AssetKind; flattened: boolean; formats?: string[]; mime?: string | null; format?: string | null; formatNote?: string | null }): string {
  if (item.formatNote) return item.formatNote;
  if (item.kind === "vector") return item.formats?.includes("svg") || /svg/.test(item.mime ?? "") ? "Editable vector (SVG): its colours can be changed on the layer." : "This file is EPS/AI: colours cannot be changed here. The preview picture is placed instead.";
  if (item.kind === "psd" || item.kind === "template") return "This file is PSD: placed as a flattened picture; its layers cannot be changed here.";
  return "A picture (JPG/PNG): placed as it is; its colours cannot be changed here.";
}

/** The short format on a card: "SVG", "EPS/AI", "PSD" or "Photo". */
function formatChip(item: { kind: AssetKind; formats?: string[]; format?: string | null }): string {
  if (item.format) return item.format;
  if (item.kind === "vector") return item.formats?.includes("svg") ? "SVG" : "EPS/AI";
  if (item.kind === "psd" || item.kind === "template") return "PSD";
  return "Photo";
}

const looksLettering = (title: string, category: Category | "") => category === "typography" || /\b(letter(ing)?|typograph\w*|calligraph\w*|text effect|word ?art|wordmark|slogan|quote)\b/i.test(title);

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

/** The search, its results and the choice, kept for this tab: the Text studio opens on the same results and the same asset. */
interface SavedSearch {
  q: string;
  category: Category | "";
  kind: AssetKind | "";
  orientation: string;
  color: string;
  page: number;
  answer: SearchAnswer | null;
  selected: StockItem | null;
  selectedAsset: AssetItem | null;
}
const savedKey = (clientId: string) => `lsm-freepik-search:${clientId}`;
function readSaved(clientId: string): SavedSearch | null {
  try {
    const raw = sessionStorage.getItem(savedKey(clientId));
    return raw ? (JSON.parse(raw) as SavedSearch) : null;
  } catch {
    return null;
  }
}
function writeSaved(clientId: string, s: SavedSearch) {
  try {
    sessionStorage.setItem(savedKey(clientId), JSON.stringify(s));
  } catch {
    /* private mode or full: the search is simply not carried over */
  }
}

type Busy = "reference" | "layer" | "background" | "pieces" | "download" | null;

export default function FreepikPanel({ clientId, batchId, post: fixedPost, slide, posts, mode = "all", layerId, onReference, onDesign, onAddText, fill, layerHint }: FreepikPanelProps) {
  const status = useFreepikStatus();
  const saved = useRef(readSaved(clientId)).current;
  const [tab, setTab] = useState<"search" | "library">("search");
  const [q, setQ] = useState(saved?.q ?? "");
  const [category, setCategory] = useState<Category | "">(saved?.category ?? "");
  const [kind, setKind] = useState<AssetKind | "">(saved?.kind ?? "");
  const [orientation, setOrientation] = useState<string>(saved?.orientation ?? "");
  const [color, setColor] = useState<string>(saved?.color ?? "");
  const [page, setPage] = useState(saved?.page ?? 1);
  const [answer, setAnswer] = useState<SearchAnswer | null>(saved?.answer ?? null);
  const [library, setLibrary] = useState<AssetItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<StockItem | null>(saved?.selected ?? null);
  const [selectedAsset, setSelectedAsset] = useState<AssetItem | null>(saved?.selectedAsset ?? null);
  const [busy, setBusy] = useState<Busy>(null);
  const [postIndex, setPostIndex] = useState<number>(fixedPost ?? posts?.[0]?.index ?? 1);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fixedPost) setPostIndex(fixedPost);
  }, [fixedPost]);
  useEffect(() => {
    writeSaved(clientId, { q, category, kind, orientation, color, page, answer, selected, selectedAsset });
  }, [clientId, q, category, kind, orientation, color, page, answer, selected, selectedAsset]);

  const search = useCallback(
    async (p = 1, over: { category?: Category | "" } = {}) => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q, type: kind, orientation, color, category: over.category ?? category, page: String(p), client: clientId });
        const r = await get<SearchAnswer>(`/api/studio/freepik/search?${params}`);
        setAnswer(r);
        setPage(p);
        resultsRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "The search failed.");
      } finally {
        setSearching(false);
      }
    },
    [q, kind, orientation, color, category, clientId],
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
    // The first search runs once the status says the viewer may search (a carried-over search is shown as it was).
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

  async function act(what: Exclude<Busy, null>) {
    const item = selectedAsset ? { id: selectedAsset.providerId, title: selectedAsset.title } : selected ? { id: selected.id, title: selected.title } : null;
    if (!item) return;
    if (what !== "download" && !batchId) return toast.error("Save the month first.");
    setBusy(what);
    try {
      const asset = selectedAsset?.stored ? selectedAsset : await ensureStored(item, what !== "download");
      // The stored asset is the selection from now on, kept for this tab before anything else
      // happens (the Photo studio closes on "Add as layer"; the Text studio opens on it, stored).
      writeSaved(clientId, { q, category, kind, orientation, color, page, answer, selected, selectedAsset: asset });
      setSelectedAsset(asset);
      if (what === "download") {
        toast.success(selectedAsset?.stored ? `"${asset.title}" is in the library.` : "Saved to the library: it is reused from there, never downloaded again.");
      } else if (what === "reference") {
        await post("/api/studio/freepik/use", { asset: asset.id, batch: batchId, post: postIndex, slide, role: "reference" });
        toast.success(`Reference on post ${postIndex}: its next picture takes it.`);
        await onReference?.(postIndex);
      } else {
        const id = layerId ?? newLayerId();
        const r = await post<{ layer?: Omit<FreepikLayer, "assetId"> & { layerable: boolean } }>("/api/studio/freepik/use", { asset: asset.id, batch: batchId, post: postIndex, slide, role: "design", layerId: id });
        if (r.layer) {
          const { layerable: _l, ...layer } = r.layer;
          void _l;
          await onDesign?.({ ...layer, assetId: asset.id, layerId: id, lettering: layer.lettering || looksLettering(asset.title, category) }, what);
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

  const canReference = mode !== "design";
  const canDesign = mode !== "reference" && !!onDesign;

  if (status === null) return <p className="fp-note">Checking the Freepik connection…</p>;
  if (!status.admin || !status.switch.enabled)
    return (
      <div className={`fp-panel ${fill ? "fill" : ""}`}>
        <div className="fp-locked" role="note">
          <strong>
            <Lock size={14} /> <SourceBadge source="freepik" /> {status.admin ? "Switched off" : "Admins only for now"}
          </strong>
          <span>{status.admin ? status.switch.reason || "The integration is off." : "Stock icons, photos, backgrounds and lettering from Freepik, as a layer, a background or a post's reference. Access is restricted until wider access is approved; ask an admin to add the asset for you."}</span>
        </div>
        <div className="fp-footer" aria-label="Actions on the selected asset">
          <div className="fp-actions locked">
            {canDesign && (
              <button type="button" className="primary wide" disabled title="Admins only for now">
                <Lock size={13} /> Add as layer
              </button>
            )}
            {canDesign && (
              <button type="button" className="secondary" disabled title="Admins only for now">
                <Lock size={13} /> Set as background
              </button>
            )}
            {canReference && (
              <button type="button" className="secondary" disabled title="Admins only for now">
                <Lock size={13} /> Use as reference
              </button>
            )}
            <button type="button" className="secondary wide" disabled title="Admins only for now">
              <Lock size={13} /> Save to library
            </button>
            {onAddText && (
              <button type="button" className="secondary wide" onClick={onAddText} title="A normal text layer you can type in">
                <Type size={13} /> Add editable text
              </button>
            )}
          </div>
          <span className="fp-note">Freepik actions: admins only for now.</span>
        </div>
      </div>
    );

  const current = selectedAsset ?? selected;
  const badge = current ? licenseBadge(current, status) : null;
  const lettering = current ? !!selectedAsset?.lettering || looksLettering(current.title, category) : false;
  const vectorColours = selectedAsset?.editable ? (selectedAsset.colors ?? []) : [];
  const thumb = current ? (selectedAsset?.layerSrc ?? selectedAsset?.file ?? current.preview) : null;
  const pickChip = (c: Category | "") => {
    setCategory(c);
    void search(1, { category: c });
  };

  return (
    <div className={`fp-panel ${fill ? "fill" : ""}`}>
      <div className="fp-head">
        <strong>
          <SourceBadge source="freepik" /> Assets
        </strong>
        {status.demo ? <span className="fp-demo" title={status.reason}>Demo catalogue · Not connected</span> : <span className="fp-note">{status.plan === "premium" ? "Downloads in the plan (100 a day)" : status.plan === "business" ? "Downloads billed in credits" : "Plan not set"}</span>}
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
        <div className="fp-controls">
          <form
            className="fp-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search(1);
            }}
          >
            <span className="fp-search-box">
              <Search size={14} aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets: lightning, marble, lantern…" aria-label="Search Freepik" />
            </span>
            <button type="submit" className="secondary" disabled={searching}>
              {searching ? <Orb size={14} /> : <Search size={14} />} <span>Search</span>
            </button>
          </form>
          <div className="fp-chips" role="group" aria-label="Kind of asset">
            {CHIPS.map((c) => (
              <button key={c.id || "all"} type="button" className={category === c.id ? "on" : ""} aria-pressed={category === c.id} onClick={() => pickChip(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          <details className="fp-more">
            <summary>
              <SlidersHorizontal size={12} /> More filters
            </summary>
            <div className="fp-more-row">
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
            </div>
          </details>
        </div>
      )}

      <div className="fp-results" ref={resultsRef} role="region" aria-label={tab === "search" ? "Search results" : "Library"} tabIndex={0}>
        {tab === "search" && (
          <>
            {!answer && <p className="fp-note">{searching ? "Searching…" : "Search Freepik, or pick a kind above."}</p>}
            {answer && !answer.items.length && <p className="fp-empty">Nothing found{answer.demo ? " in the demo catalogue (try lightning, mango, lantern, sale)" : ""}.</p>}
            {answer && answer.items.length > 0 && (
              <div className="fp-grid" role="list">
                {answer.items.map((it) => {
                  const b = licenseBadge(it, status);
                  const on = selected?.id === it.id && !selectedAsset;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      role="listitem"
                      aria-pressed={on}
                      className={`fp-card ${on ? "on" : ""} ${it.kind === "vector" ? "vector" : ""}`}
                      onClick={() => {
                        setSelected(it);
                        setSelectedAsset(null);
                      }}
                      title={`${it.title} · ${it.author}`}
                    >
                      <img src={it.preview} alt="" loading="lazy" />
                      <span className={`fp-badge ${b.cls}`}>{b.text}</span>
                      <span className="fp-title">{it.title}</span>
                      <span className="fp-format">{formatChip(it)}</span>
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
            {library && !library.length && <p className="fp-empty">Nothing in the library yet: search and save an asset.</p>}
            {library && library.length > 0 && (
              <div className="fp-grid" role="list">
                {library.map((a) => {
                  const b = licenseBadge(a, status);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="listitem"
                      aria-pressed={selectedAsset?.id === a.id}
                      className={`fp-card ${selectedAsset?.id === a.id ? "on" : ""} ${a.kind === "vector" ? "vector" : ""}`}
                      onClick={() => {
                        setSelectedAsset(a);
                        setSelected(null);
                      }}
                      title={`${a.title} · ${a.author}`}
                    >
                      <img src={a.layerSrc ?? a.file ?? a.preview} alt="" loading="lazy" />
                      <span className={`fp-badge ${b.cls}`}>{b.text}</span>
                      {a.stored && (
                        <span className="fp-stored" title="In the library">
                          <Check size={12} />
                        </span>
                      )}
                      <span className="fp-title">{a.title}</span>
                      <span className="fp-format">
                        {formatChip(a)} · {a.uses ? `used ${a.uses}×` : "not used yet"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="fp-footer" aria-label="Actions on the selected asset">
        {current && badge ? (
          <>
            {vectorColours.length > 0 && (
              <div className="fp-swatches" aria-label="Vector colours">
                <span className="fp-swatches-title">Vector colours</span>
                <span className="fp-swatch-row">
                  {vectorColours.slice(0, 10).map((c) => (
                    <span key={c} className="fp-swatch" style={{ background: c }} title={`${c.toUpperCase()}: change it on the layer`} />
                  ))}
                </span>
              </div>
            )}
            <div className="fp-selected">
              <span className={`fp-thumb ${current.kind === "vector" ? "vector" : ""}`}>{thumb && <img src={thumb} alt="" />}</span>
              <span className="fp-selected-text">
                <b title={current.title}>{current.title}</b>
                <span className="fp-meta">
                  <SourceBadge source="freepik" compact /> {formatChip({ kind: current.kind, formats: selected?.formats, format: selectedAsset?.format })}
                  {" · "}
                  <span className={`fp-badge-inline ${badge.cls}`}>{badge.text}</span>
                </span>
              </span>
            </div>
            {lettering && <span className="fp-lettering">{LETTERING_LABEL}</span>}
            <span className="fp-note fp-format-note">{formatLabel({ kind: current.kind, flattened: current.flattened, formats: selected?.formats, mime: selectedAsset?.mime, format: selectedAsset?.format, formatNote: selectedAsset?.formatNote })}</span>
            {current.license.attribution && <span className="fp-note fp-attribution">Free licence: credit {current.author || "Freepik"} where the post is published.</span>}
            {!fixedPost && posts && posts.length > 0 && (
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
          </>
        ) : (
          <p className="fp-note fp-pick">Pick an asset: its actions stay here while the results scroll.</p>
        )}
        <div className="fp-actions">
          {canDesign && (
            <button type="button" className="primary wide" disabled={!current || !!busy || !batchId} onClick={() => void act("layer")} title={layerHint ?? "An image layer over the post's picture: move, resize, turn and stack it. Free: no picture is made."}>
              {busy === "layer" ? <Orb size={14} /> : <Layers size={14} />} Add as layer
            </button>
          )}
          {canDesign && current?.kind === "vector" && (
            <button
              type="button"
              className="secondary"
              disabled={!current || !!busy || !batchId}
              onClick={() => void act("pieces")}
              title="Each group and shape of the SVG as its own layer, in the same place and grouped: move, recolour or delete one piece, or remove the vector's background. An EPS/AI-only file cannot be split: it is added as one picture and says why."
            >
              {busy === "pieces" ? <Orb size={14} /> : <Scissors size={14} />} Add as separate layers
            </button>
          )}
          {canDesign && (
            <button type="button" className="secondary" disabled={!current || !!busy || !batchId} onClick={() => void act("background")} title={BACKGROUND_HINT}>
              {busy === "background" ? <Orb size={14} /> : <PanelBottom size={14} />} Set as background
            </button>
          )}
          {canReference && (
            <button type="button" className={canDesign ? "secondary" : "primary"} disabled={!current || !!busy || !batchId} onClick={() => void act("reference")} title="The picture attached to the post as its reference: the next take or revision uses it. It does not change the theme.">
              {busy === "reference" ? <Orb size={14} /> : <ImagePlus size={14} />} Use as reference
            </button>
          )}
          <button type="button" className="secondary wide" disabled={!current || !!busy || !!selectedAsset?.stored} onClick={() => void act("download")}>
            {busy === "download" ? <Orb size={14} /> : selectedAsset?.stored ? <Check size={14} /> : <BookmarkPlus size={14} />} {selectedAsset?.stored ? "In the library" : "Save to library"}
          </button>
          {onAddText && lettering && (
            <button type="button" className="secondary wide" onClick={onAddText} title="A normal text layer you can type in, next to the lettering picture">
              <Type size={14} /> Add editable text
            </button>
          )}
        </div>
        {canDesign && current && <span className="fp-note fp-bg-hint">Set as background: behind the photo, which is never made again.</span>}
      </div>
    </div>
  );
}

/** The panel in a dialog (results scroll inside it; the selected asset's actions stay at the bottom). */
export function FreepikDialog({ open, onClose, title, description, ...panel }: { open: boolean; onClose: () => void; title?: string; description?: string } & FreepikPanelProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="fp-dialog">
        <DialogHeader>
          <DialogTitle>
            <Library size={16} style={{ display: "inline", verticalAlign: "-3px", marginRight: 6 }} />
            {title ?? "Freepik assets"}
          </DialogTitle>
          <DialogDescription>{description ?? "Stock icons, photos, backgrounds and lettering from Freepik, as a layer, a background or a post's reference picture. Never the theme, the engine or a product photo."}</DialogDescription>
        </DialogHeader>
        {open && <FreepikPanel fill {...panel} />}
      </DialogContent>
    </Dialog>
  );
}
