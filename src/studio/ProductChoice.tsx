/**
 * Choosing product images, wherever a post's picture needs the real product: three visible ways
 * (chosen for the team from the client's Drive, picked by hand from the Drive, uploaded), the
 * proposal reviewed before anything is made (replace, exclude or lock each post's image), and which
 * product image each post has now. Product photos are the real items in the pictures; reference
 * pictures (pins, grid tiles, styles) only guide the look and are never products. Nothing here
 * costs a picture: a proposal is a text call (or the demo fixture) and copies nothing until applied.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Ban, Check, HardDrive, Lock, LockOpen, RefreshCw, Sparkles, Upload, Wand2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import { get, post } from "@/api";
import type { Post } from "@shared/posts";
import type { Source } from "@shared/types";
import { productLibrary, type DriveFolder, type ProductOption } from "@shared/drive";
import { displayName } from "./PlanView";
import ProductSwap, { needsProduct, optionThumb } from "./ProductSwap";
import DrivePicker from "./DrivePicker";

/** One post of a proposal, as the server writes it: the image it would use, why, and the others that fit. */
export interface ProductProposal {
  index: number;
  title: string;
  headline?: string;
  current?: string;
  locked: boolean;
  pick: (ProductOption & { reason: string; confident: boolean }) | null;
  alternatives: (ProductOption & { reason?: string })[];
}

interface Proposal {
  proposals: ProductProposal[];
  options: ProductOption[];
  drive: number;
}

/** Where a product image lives, in a word. */
const SOURCE_LABEL: Record<ProductOption["source"], string> = { month: "This month", gallery: "Earlier month", drive: "Drive" };

const sameName = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The month's product photo a post uses, by its name. */
export function productOf(post: Post, products: Source[]): Source | undefined {
  const name = post.product ?? post.offer?.products[0];
  return name ? products.find((s) => sameName(displayName(s.name), name)) : undefined;
}

/** Whether the client has a connected product library: an approved Drive folder, or the folder on its profile. */
export function useProductLibrary(clientId: string | null | undefined): { connected: boolean; folders: number; demo: boolean } | null {
  const [state, setState] = useState<{ connected: boolean; folders: number; demo: boolean } | null>(null);
  useEffect(() => {
    if (!clientId) {
      setState(null);
      return;
    }
    let live = true;
    get<{ folders: DriveFolder[]; demo: boolean }>(`/api/studio/drive/${encodeURIComponent(clientId)}/folders`)
      .then((r) => live && setState({ ...productLibrary(r.folders), demo: r.demo || productLibrary(r.folders).demo }))
      .catch(() => live && setState({ connected: false, folders: 0, demo: false }));
    return () => {
      live = false;
    };
  }, [clientId]);
  return state;
}

/**
 * The product column of one post: its product photo (never a reference), or "No product selected"
 * with the way to choose one.
 */
export function PostProductCell({ post, products, sourceUrl, onChoose }: { post: Post; products: Source[]; sourceUrl: (id: string) => string; onChoose?: (post: Post) => void }) {
  if (!needsProduct(post)) return <span className="prodc-cell none">No product in this picture</span>;
  const src = productOf(post, products);
  const name = post.product ?? post.offer?.products[0];
  if (src)
    return (
      <span className="prodc-cell" title={`Product photo: ${name}`}>
        <img src={sourceUrl(src.id)} alt="" />
        <span className="prodc-cell-text">
          <b dir="auto">{name}</b>
          <small>
            Product photo{post.productLock ? " · locked" : ""}
            {onChoose && (
              <>
                {" · "}
                <button type="button" className="text-button" onClick={() => onChoose(post)}>
                  Replace
                </button>
              </>
            )}
          </small>
        </span>
      </span>
    );
  return (
    <span className="prodc-cell missing">
      <i className="prodc-blank" aria-hidden />
      <span className="prodc-cell-text">
        <b>{name ? `${name} · no photo yet` : "No product selected"}</b>
        {onChoose && (
          <small>
            <button type="button" className="text-button" onClick={() => onChoose(post)}>
              Choose a product image
            </button>
          </small>
        )}
      </span>
    </span>
  );
}

export interface ProductChoiceProps {
  batchId: string | null;
  client: { id: string; name: string } | null;
  plan: Post[];
  /** This month's product photos. */
  products: Source[];
  sourceUrl: (id: string) => string;
  /** The month read again after a change. */
  refresh: () => Promise<void>;
  /** Opens the upload input (the third way). */
  onUpload: () => void;
  /** "full": the three ways, the proposal and the per-post list. "bar": the three ways and the proposal only. */
  variant?: "full" | "bar";
  /** After product images changed (the plan preview reads again). */
  onChanged?: () => Promise<void>;
}

export default function ProductChoice(p: ProductChoiceProps) {
  const library = useProductLibrary(p.client?.id);
  const connected = !!library?.connected;
  const posts = useMemo(() => p.plan.filter(needsProduct), [p.plan]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposing, setProposing] = useState(false);
  /** The team's edits on the proposal, by post: another image, left out, or locked. */
  const [edits, setEdits] = useState<Record<number, { pick?: ProductOption; excluded?: boolean; lock?: boolean }>>({});
  const [applying, setApplying] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [swap, setSwap] = useState<Post | null>(null);

  const propose = useCallback(async () => {
    if (!p.batchId) return;
    setProposing(true);
    try {
      const r = await post<Proposal>("/api/studio/posts/products/propose", { batch: p.batchId, drive: true });
      setProposal(r);
      setEdits(Object.fromEntries(r.proposals.map((x) => [x.index, { lock: x.locked }])));
      const found = r.proposals.filter((x) => x.pick).length;
      toast.success(found ? `${found} of ${r.proposals.length} post${r.proposals.length === 1 ? "" : "s"} have a proposed product image. Review them below; nothing is copied until you apply.` : "No product image fits these posts yet: choose from Drive or upload photos.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProposing(false);
    }
  }, [p.batchId]);

  const chosen = (x: ProductProposal): ProductOption | null => edits[x.index]?.pick ?? x.pick;
  const toApply = proposal ? proposal.proposals.filter((x) => !edits[x.index]?.excluded && chosen(x)) : [];

  async function apply() {
    if (!p.batchId || !proposal) return;
    setApplying(true);
    try {
      const choices = toApply.map((x) => {
        const o = chosen(x)!;
        return { index: x.index, source: o.source, id: o.id, name: o.name, lock: !!edits[x.index]?.lock };
      });
      const unlock = proposal.proposals.filter((x) => x.locked && !edits[x.index]?.lock).map((x) => x.index);
      const r = await post<{ filled: { index: number; product: string }[]; failed: string[] }>("/api/studio/posts/products/choose", { batch: p.batchId, choices, unlock });
      for (const f of r.failed) toast.error(f);
      if (r.filled.length) {
        // The shots follow the products when the month has a look to write them from; a month without one has no shots yet.
        await post("/api/studio/posts/shots", { batch: p.batchId, indexes: r.filled.map((f) => f.index) }).catch(() => undefined);
        toast.success(`${r.filled.length} post${r.filled.length === 1 ? "" : "s"} now use the chosen product images (${r.filled.map((f) => `${f.index}: ${f.product}`).join(", ")}).`);
      }
      setProposal(null);
      setEdits({});
      await p.refresh();
      await p.onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  async function toggleLock(x: Post) {
    if (!p.batchId) return;
    try {
      await post("/api/studio/posts/products/lock", { batch: p.batchId, index: x.index, lock: !x.productLock });
      await p.refresh();
      toast.message(x.productLock ? `Post ${x.index}'s product image is unlocked.` : `Post ${x.index}'s product image is locked: proposals leave it alone.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const n = p.products.length;
  const missing = posts.filter((x) => !productOf(x, p.products));
  return (
    <div className={`prodc ${p.variant ?? "full"}`}>
      <div className="prodc-choices" role="group" aria-label="Choose product images">
        <button type="button" className={`cta ${connected ? "primary" : "secondary"}`} disabled={!p.batchId || !connected || !posts.length || proposing || applying} onClick={() => void propose()} title={!connected ? "Connect the client's Drive first (Choose from Drive)" : !posts.length ? "Write the posts first; then an image is proposed for each" : "An image is proposed for every post from the brief, the grid and the Drive's products; you review it before anything is made"}>
          {proposing ? <Orb size={15} /> : <Wand2 size={16} />} Choose for me from Drive
        </button>
        <button type="button" className="cta secondary" disabled={!p.client} onClick={() => setDriveOpen(true)} title="Browse the client's Drive folders and pick the photos yourself">
          <HardDrive size={16} /> Choose from Drive
        </button>
        <button type="button" className={`cta ${connected ? "secondary" : "primary"}`} onClick={p.onUpload} title="Upload product photos from this computer">
          <Upload size={16} /> Upload images{connected ? " (optional)" : ""}
        </button>
      </div>
      <small className="prodc-hint">
        {library === null
          ? "Checking the client's product library…"
          : connected
            ? `${p.client?.name ?? "The client"}'s product library is connected${library.demo ? " (demo listing)" : ""}: ${library.folders} Drive folder${library.folders === 1 ? "" : "s"}. Uploading is optional.`
            : "No product library connected yet: connect the client's Drive folder (Choose from Drive) or upload the photos."}
        {" "}Product photos are the real items in the pictures; reference pictures only guide the look and are never products.
      </small>
      {proposing && (
        <div className="journey-reading">
          <Orb size={16} /> Proposing a product image for each post…
        </div>
      )}
      {proposal && (
        <div className="prodc-proposal" role="region" aria-label="Proposed product images">
          <div className="flow-row-head">
            <span className="flow-eyebrow">Proposed product images · not applied</span>
            <span className="flow-pill">{toApply.length} of {proposal.proposals.length} to apply</span>
            <button type="button" className="text-button" disabled={proposing} onClick={() => void propose()}>
              <RefreshCw size={12} /> Propose again
            </button>
          </div>
          <ul className="prodc-list">
            {proposal.proposals.map((x) => {
              const o = chosen(x);
              const e = edits[x.index] ?? {};
              const opts = proposal.options;
              return (
                <li key={x.index} className={e.excluded ? "excluded" : ""}>
                  <span className="flow-post-n">{String(x.index).padStart(2, "0")}</span>
                  <span className="prodc-pick">
                    {o ? <img src={optionThumb(o, p.sourceUrl)} alt="" loading="lazy" /> : <i className="prodc-blank" aria-hidden />}
                    <span className="prodc-pick-text">
                      <b dir="auto">{x.headline || x.title}</b>
                      {o ? (
                        <span>
                          <strong dir="auto">{o.name}</strong> <span className="journey-tag">{SOURCE_LABEL[o.source]}</span> <span className="journey-tag muted">Product photo</span>
                          {x.locked && !e.pick ? " · locked" : ""}
                        </span>
                      ) : (
                        <span>No image fits yet: pick one or leave the post out.</span>
                      )}
                      <small className="flow-muted">{e.pick ? "Replaced by you." : x.pick ? (x.pick.confident ? x.pick.reason : `Proposed: ${x.pick.reason || "fits the post"}`) : ""}</small>
                    </span>
                  </span>
                  <span className="prodc-controls">
                    <label className="prodc-replace" title="Replace with another product image">
                      <span>Replace</span>
                      <select
                        value={o ? `${o.source}:${o.id}` : ""}
                        disabled={e.excluded || applying}
                        onChange={(ev) => {
                          const pick = opts.find((k) => `${k.source}:${k.id}` === ev.target.value);
                          setEdits((m) => ({ ...m, [x.index]: { ...m[x.index], pick } }));
                        }}
                      >
                        <option value="">{o ? "Keep the proposed image" : "Pick an image…"}</option>
                        {(["month", "gallery", "drive"] as const).map((src) => {
                          const list = opts.filter((k) => k.source === src);
                          return list.length ? (
                            <optgroup key={src} label={SOURCE_LABEL[src]}>
                              {list.map((k) => (
                                <option key={`${k.source}:${k.id}`} value={`${k.source}:${k.id}`}>
                                  {k.name}
                                </option>
                              ))}
                            </optgroup>
                          ) : null;
                        })}
                      </select>
                    </label>
                    <button type="button" className={`text-button ${e.excluded ? "on" : ""}`} disabled={applying} onClick={() => setEdits((m) => ({ ...m, [x.index]: { ...m[x.index], excluded: !m[x.index]?.excluded } }))} title={e.excluded ? "Put this post back into the proposal" : "Leave this post as it is"}>
                      {e.excluded ? <Check size={12} /> : <Ban size={12} />} {e.excluded ? "Include" : "Exclude"}
                    </button>
                    <button type="button" className={`text-button ${e.lock ? "on" : ""}`} disabled={applying || e.excluded || !o} onClick={() => setEdits((m) => ({ ...m, [x.index]: { ...m[x.index], lock: !m[x.index]?.lock } }))} title={e.lock ? "Unlock: later proposals may change this post's image" : "Lock: later proposals leave this post's image alone"}>
                      {e.lock ? <Lock size={12} /> : <LockOpen size={12} />} {e.lock ? "Locked" : "Lock"}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flow-pick-row">
            <button type="button" className="cta primary" disabled={applying || !toApply.length} onClick={() => void apply()}>
              {applying ? <Orb size={15} /> : <Check size={16} />} Use these {toApply.length} product image{toApply.length === 1 ? "" : "s"}
            </button>
            <button type="button" className="text-button" disabled={applying} onClick={() => { setProposal(null); setEdits({}); }}>
              Discard the proposal
            </button>
            <small className="flow-muted">Drive and earlier-month photos are copied into the month when applied; the posts' shots are written again for their products. No picture is made here.</small>
          </div>
        </div>
      )}
      {(p.variant ?? "full") === "full" && posts.length > 0 && (
        <div className="prodc-posts">
          <div className="flow-row-head">
            <span className="flow-eyebrow">Which product image goes on each post</span>
            <small className="flow-muted">
              {n} product photo{n === 1 ? "" : "s"} this month{missing.length ? ` · ${missing.length} post${missing.length === 1 ? "" : "s"} without a product image` : " · every post has one"}
            </small>
          </div>
          <ul className="prodc-list compact">
            {[...posts]
              .sort((a, b) => a.index - b.index)
              .map((x) => (
                <li key={x.index}>
                  <span className="flow-post-n">{String(x.index).padStart(2, "0")}</span>
                  <PostProductCell post={x} products={p.products} sourceUrl={p.sourceUrl} onChoose={setSwap} />
                  <span className="prodc-controls">
                    <button type="button" className={`text-button ${x.productLock ? "on" : ""}`} disabled={!productOf(x, p.products)} onClick={() => void toggleLock(x)} title={x.productLock ? "Unlock: proposals may change this post's image" : "Lock: proposals leave this post's image alone"}>
                      {x.productLock ? <Lock size={12} /> : <LockOpen size={12} />} {x.productLock ? "Locked" : "Lock"}
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
      {p.client && (
        <DrivePicker
          open={driveOpen}
          onClose={() => setDriveOpen(false)}
          client={p.client}
          count={Math.min(12, Math.max(4, posts.length || 6))}
          batchId={p.batchId}
          onAdded={async () => {
            await p.refresh();
            await p.onChanged?.();
          }}
        />
      )}
      <ProductSwap
        open={!!swap}
        onClose={() => setSwap(null)}
        batchId={p.batchId}
        target={swap}
        sourceUrl={p.sourceUrl}
        onChanged={async () => {
          await p.refresh();
          await p.onChanged?.();
        }}
      />
      {!posts.length && (p.variant ?? "full") === "full" && (
        <small className="flow-muted">
          <Sparkles size={12} /> The posts are written on the next step; each then gets its product image here or on the Plan.
        </small>
      )}
    </div>
  );
}
