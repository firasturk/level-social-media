/**
 * Presets: the picture gallery the Video studio's preset gallery inspired, pictures only. The stage
 * shows the categories on the left (Styles, Product shots, Magnific looks, Recipes) and the cards,
 * each with the provider's own sample picture (hotlinked), its title, a line of description, chips,
 * "Use this style / look / preset" (the AI tools panel prefilled) and "Learn more". The right panel
 * shows the picked entry in full: the sample large, what it does and needs, the price, the
 * instructions, and, for an admin on a runnable product shot, "Run this preset" with the confirm.
 * Members browse; nothing is invented when a category is empty.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, ImageOff, LayoutGrid, Lock, Play, RefreshCw, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { NO_MAGNIFIC_SAMPLE, PHOTO_PRESET_CATEGORIES, type PhotoPresetCard, type PhotoPresetCategoryId, type PhotoPresetDetail } from "@shared/photo-presets";
import { listPhotoPresets, photoPresetDetail, runPhotoPreset, type ConfirmAsk, type PhotoPresetList } from "../photoApi";
import type { StudioCtx } from "../types";

/** A search across what a card says: the same rule as the server's. */
export function matchesPhoto(c: PhotoPresetCard, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [c.title, c.description, c.command ?? "", c.category ?? "", c.type ?? "", c.source].some((s) => s.toLowerCase().includes(t));
}

const SOURCE_LABELS: Record<string, string> = { soul: "Soul style", marketing_studio: "Product shot", magnific: "Magnific", recipe: "Recipe" };
const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s.replace(/_/g, " ");
const USE_LABEL: Record<PhotoPresetCard["kind"], string> = { style: "Use this style", preset: "Use this preset", look: "Use this look", recipe: "Use these words" };

export interface PresetsState {
  category: PhotoPresetCategoryId;
  setCategory: (c: PhotoPresetCategoryId) => void;
  q: string;
  setQ: (q: string) => void;
  list: PhotoPresetList | null;
  loading: boolean;
  error: string;
  cards: PhotoPresetCard[];
  reload: (refresh?: boolean) => Promise<void>;
  searchProvider: () => Promise<void>;
  selected: PhotoPresetCard | null;
  select: (card: PhotoPresetCard | null) => void;
  detail: PhotoPresetDetail | null;
  detailBusy: boolean;
  detailError: string;
}

/** The gallery's state, owned by the studio so the stage (the cards) and the side panel (the detail) share it. */
export function usePhotoPresets(post: { batch: string; index: number } | null, active: boolean): PresetsState {
  const [category, setCategory] = useState<PhotoPresetCategoryId>("styles");
  const [q, setQ] = useState("");
  const [lists, setLists] = useState<Partial<Record<string, PhotoPresetList>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PhotoPresetCard | null>(null);
  const [detail, setDetail] = useState<PhotoPresetDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = (c: string, query = "") => (query ? `${c}?${query}` : c);
  const load = useCallback(async (c: PhotoPresetCategoryId, opts: { refresh?: boolean; q?: string } = {}) => {
    setLoading(true);
    setError("");
    try {
      const r = await listPhotoPresets(c, { refresh: opts.refresh, q: opts.q });
      if (alive.current) setLists((l) => ({ ...l, [key(c, opts.q)]: r }));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (active && !lists[key(category)]) void load(category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, category]);
  const list = lists[key(category, q.trim() && lists[key(category, q.trim())] ? q.trim() : "")] ?? null;
  const cards = useMemo(() => (list ? list.items.filter((c) => matchesPhoto(c, q)) : []), [list, q]);
  const select = useCallback(
    (card: PhotoPresetCard | null) => {
      setSelected(card);
      setDetail(null);
      setDetailError("");
      if (!card) return;
      setDetailBusy(true);
      photoPresetDetail(card.id, card.source, card.kind === "preset" ? post : null)
        .then((r) => {
          if (alive.current) setDetail(r.preset);
        })
        .catch((e: Error) => {
          if (alive.current) setDetailError(e.message);
        })
        .finally(() => alive.current && setDetailBusy(false));
    },
    [post],
  );
  return {
    category,
    setCategory,
    q,
    setQ,
    list,
    loading,
    error,
    cards,
    reload: (refresh = false) => load(category, { refresh }),
    searchProvider: () => load(category, { q: q.trim() }),
    selected,
    select,
    detail,
    detailBusy,
    detailError,
  };
}

/* ───────────── The stage: categories and cards ───────────── */

export function PresetCardView({ card, selected, onSelect, onUse, children }: { card: PhotoPresetCard; selected: boolean; onSelect: () => void; onUse: (() => void) | null; children?: ReactNode }) {
  return (
    <article className={`ps-preset ${selected ? "on" : ""}`}>
      <button type="button" className="ps-preset-media" onClick={onSelect} title={card.description || card.title} aria-label={`${card.title}: open`}>
        {card.image ? (
          <img src={card.image} alt="" loading="lazy" />
        ) : (
          <span className="ps-preset-blank">
            <ImageOff size={16} /> {card.provider === "magnific" ? NO_MAGNIFIC_SAMPLE : "No sample picture"}
          </span>
        )}
        {card.price !== null && <span className="ps-preset-price">{card.price} credits</span>}
      </button>
      <div className="ps-preset-text">
        <b>{card.title}</b>
        {card.description && <small className="ps-preset-desc">{card.description}</small>}
        <span className="ps-chips-row">
          {card.command && <em className="ps-chip cmd">{card.command}</em>}
          <em className="ps-chip">{sourceLabel(card.source)}</em>
          {card.category && card.category !== card.source && !/^(product-shot|recipe)$/.test(card.category) && <em className="ps-chip">{card.category.replace(/[_-]+/g, " ")}</em>}
        </span>
        {card.needs.length > 0 && <small className="ps-needs">Needs: {card.needs.join(", ")}</small>}
        <span className="ps-preset-actions">
          {onUse && (
            <button type="button" className="ts-mini primary" onClick={onUse} title={card.kind === "preset" ? "Open the detail to run this preset on the post's picture" : "Open AI tools with this filled in"}>
              <Sparkles size={12} /> {USE_LABEL[card.kind]}
            </button>
          )}
          <button type="button" className="ts-mini" onClick={onSelect}>
            <BookOpen size={12} /> Learn more
          </button>
          {children}
        </span>
      </div>
    </article>
  );
}

export function PresetsGallery({ ctx }: { ctx: StudioCtx }) {
  const ps = ctx.presets;
  const cat = PHOTO_PRESET_CATEGORIES.find((c) => c.id === ps.category)!;
  const who = cat.provider === "higgsfield" ? "Higgsfield" : "Magnific";
  const use = (card: PhotoPresetCard) => {
    if (card.kind === "preset") {
      ps.select(card);
      return;
    }
    if (!card.use) return;
    ctx.tools.prefill(card.use, card);
    ctx.openPanel("tools");
  };
  return (
    <div className="ps-gallery">
      <nav className="ps-cats" aria-label="Preset categories">
        {PHOTO_PRESET_CATEGORIES.map((c) => (
          <button key={c.id} type="button" className={ps.category === c.id ? "on" : ""} onClick={() => ps.setCategory(c.id)} title={c.hint}>
            {c.label}
          </button>
        ))}
      </nav>
      <div className="ps-grid-wrap">
        <header className="ps-gallery-head">
          <span className="ps-gallery-title">
            <LayoutGrid size={14} /> {cat.label}
            <small>{cat.hint}</small>
          </span>
          <label className="ps-search">
            <Search size={13} />
            <input type="search" placeholder="Search presets" value={ps.q} onChange={(e) => ps.setQ(e.target.value)} aria-label="Search presets" />
            {ps.q && (
              <button type="button" className="ts-icon" onClick={() => ps.setQ("")} aria-label="Clear the search">
                <X size={12} />
              </button>
            )}
          </label>
          <button type="button" className="ts-icon" onClick={() => void ps.reload(true)} disabled={ps.loading} title={`Ask ${who} for today's list (the gallery is kept a day)`} aria-label="Refresh">
            <RefreshCw size={13} />
          </button>
        </header>
        {ps.list && (!ps.list.signedIn || ps.list.reason) && (
          <p className="ps-note warn">
            <TriangleAlert size={13} /> {ps.list.reason || `Not signed in: Connection → ${who}.`}
          </p>
        )}
        {ps.error && (
          <p className="ps-note warn">
            <TriangleAlert size={13} /> {ps.error}
          </p>
        )}
        {ps.loading && !ps.list && (
          <p className="ps-note">
            <Orb size={16} /> Reading {who}'s list…
          </p>
        )}
        {ps.list && ps.list.signedIn && !ps.list.reason && ps.cards.length === 0 && !ps.loading && (
          <p className="ps-note">
            {ps.q.trim() ? (
              <>
                Nothing here matches “{ps.q.trim()}”.{" "}
                <button type="button" className="ts-link" onClick={() => void ps.searchProvider()}>
                  Search {who} for it
                </button>
              </>
            ) : (
              ps.list.empty
            )}
          </p>
        )}
        <div className="ps-grid">
          {ps.cards.map((card) => (
            <PresetCardView key={`${card.source}:${card.category}:${card.id}`} card={card} selected={ps.selected?.id === card.id && ps.selected.source === card.source} onSelect={() => ps.select(card)} onUse={card.use || card.kind === "preset" ? () => use(card) : null} />
          ))}
        </div>
        {ps.list && !ps.list.admin && ps.list.signedIn && <p className="ps-note">You can browse every preset; using one on a picture is admins only for now.</p>}
        <p className="ps-note quiet">The sample pictures are the providers' own examples, shown from their sites; the studio keeps no copy. Clips live in the Video studio.</p>
      </div>
    </div>
  );
}

/* ───────────── The side panel: one entry in full ───────────── */

/** The text inputs a preset asks for beyond the picture (a prompt, a mood), from its schema. */
function textInputs(detail: PhotoPresetDetail): { name: string; label: string; required: boolean }[] {
  const schema = detail.inputSchema as { properties?: Record<string, { type?: string; description?: string; title?: string }>; required?: string[] } | null;
  if (!schema?.properties) return [];
  const req = schema.required ?? [];
  return Object.entries(schema.properties)
    .filter(([name, p]) => (p.type === "string" || !p.type) && !/image|photo|picture|product|media|video|clip|frame|character|reference/i.test(`${name} ${p.description ?? ""}`))
    .map(([name, p]) => ({ name, label: p.title || p.description || name.replace(/[_-]+/g, " "), required: req.includes(name) }));
}

export function PresetDetailPanel({ ctx }: { ctx: StudioCtx }) {
  const ps = ctx.presets;
  const card = ps.detail ?? ps.selected;
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setInputs({});
    setError("");
    setOpen(false);
  }, [ps.selected?.id]);
  const post = ctx.editor.batchId ? { batch: ctx.editor.batchId, index: ctx.editor.post.index } : null;
  const admin = !!ps.list?.admin;
  if (!card) {
    return (
      <div className="ps-panel">
        <div className="ts-panel-head">
          <span>
            <LayoutGrid size={13} /> Presets
          </span>
        </div>
        <PanelSwitch ctx={ctx} />
        <p className="ts-hint">Pick a card to see its sample picture, what it does and what it needs. “Use this style” fills the AI tools with it; a product-shot preset can be run from here by an admin, on the subscription credits.</p>
        <p className="ts-hint">Pictures only: the clips and their presets live in the Video studio.</p>
      </div>
    );
  }
  const detail = ps.detail;
  const fields = detail ? textInputs(detail) : [];
  const readiness = detail?.readiness as { ready?: boolean; missing?: string[]; message?: string } | null;
  async function run(confirm = false) {
    if (!post || !card) return;
    setRunning(true);
    setError("");
    try {
      const r = await runPhotoPreset({ batch: post.batch, index: post.index, presetId: card.id, source: card.source, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v.trim())), confirm });
      await ctx.tools.reloadJobs();
      ctx.tools.setJob(r.job);
      toast.success(`“${card.title}” is being made from this post's picture; it takes a few seconds to a minute.`);
      ctx.openPanel("tools");
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && (d.needsConfirm || d.needsEstimate)) {
        const ok = await askConfirm(d.needsEstimate ? `Run “${card.title}” on this post's picture: Higgsfield names no price for it. Run it at an unknown cost from the subscription credits?` : `Run “${card.title}” on this post's picture: about ${d.credits} credits from the subscription balance${d.balance != null ? ` (${d.balance} available)` : ""}. The result is shown first; the post's picture changes only when you use it.`, { ok: d.needsEstimate ? "Run it anyway, cost unknown" : `Run · ${d.credits} credits`, danger: false, cancel: "Not now" });
        if (ok) return run(true);
      } else setError(err.message);
    } finally {
      setRunning(false);
    }
  }
  const canRun = !!post && !!detail?.runnable && admin && !!ctx.task.output;
  const useIt = () => {
    if (!card.use) return;
    ctx.tools.prefill(card.use, card);
    ctx.openPanel("tools");
  };
  return (
    <div className="ps-panel ps-detail">
      <div className="ts-panel-head">
        <span>
          <LayoutGrid size={13} /> {card.kind === "style" ? "Style" : card.kind === "look" ? "Look" : card.kind === "recipe" ? "Recipe" : "Preset"}
        </span>
        <button type="button" className="ts-icon" onClick={() => ps.select(null)} aria-label="Close the preset">
          <X size={13} />
        </button>
      </div>
      <div className="ps-detail-media">
        {card.image ? (
          <img src={card.image} alt="" />
        ) : (
          <span className="ps-preset-blank">
            <ImageOff size={16} /> {card.provider === "magnific" ? NO_MAGNIFIC_SAMPLE : "No sample picture"}
          </span>
        )}
      </div>
      <b className="ps-detail-title">{card.title}</b>
      {card.description && <p className="ps-detail-desc">{card.description}</p>}
      <span className="ps-chips-row">
        {card.command && <em className="ps-chip cmd">{card.command}</em>}
        <em className="ps-chip">{sourceLabel(card.source)}</em>
        {card.category && card.category !== card.source && !/^(product-shot|recipe)$/.test(card.category) && <em className="ps-chip">{card.category.replace(/[_-]+/g, " ")}</em>}
      </span>
      {ps.detailBusy && (
        <p className="ts-hint">
          <Orb size={13} /> Reading the entry…
        </p>
      )}
      {ps.detailError && <p className="ts-hint warn">{ps.detailError}</p>}
      {card.needs.length > 0 && (
        <p className="ts-hint">
          <b>Needs:</b> {card.needs.join(", ")}.{ctx.task.output && card.needs.some((n) => /picture/.test(n)) ? " This post's picture is used." : ""}
        </p>
      )}
      {detail && card.kind === "preset" && (
        <p className="ts-hint">
          <b>Cost:</b> {detail.price !== null ? `about ${detail.price} credits from the subscription (said again before the run).` : "not known: Higgsfield names no price. An admin confirms the run at an unknown cost."}
        </p>
      )}
      {card.kind !== "preset" && <p className="ts-hint">{card.kind === "style" ? "A style is used through Generate with a style under AI tools: the cost is asked there before anything is made." : card.kind === "look" ? "A look is used through the Magnific tools under AI tools: the cost is asked there first." : "A recipe is a set of steps, not one run: use its words under AI tools, or follow it on Higgsfield."}</p>}
      {readiness && typeof readiness === "object" && (readiness.ready !== undefined || readiness.missing || readiness.message) && (
        <p className="ts-hint">
          <b>Ready?</b> {readiness.ready ? "Yes: everything the preset needs is there." : readiness.message || (readiness.missing?.length ? `Still needed: ${readiness.missing.join(", ")}.` : "Not yet.")}
        </p>
      )}
      <div className="ps-detail-actions">
        {card.use && (
          <button type="button" className="ts-btn primary ps-cta" onClick={useIt}>
            <Sparkles size={14} /> {USE_LABEL[card.kind]}
          </button>
        )}
        {detail?.instructions && (
          <button type="button" className="ts-btn ps-cta" onClick={() => setOpen((o) => !o)}>
            <BookOpen size={14} /> {open ? "Hide the details" : "Learn more"}
          </button>
        )}
      </div>
      {open && detail?.instructions && <pre className="ps-words">{detail.instructions}</pre>}
      {detail?.runnable && card.kind === "preset" && (
        <>
          <span className="ts-group-title">Run it here</span>
          {!admin ? (
            <div className="ps-locked" role="note">
              <Lock size={14} />
              <div>
                <b>Admins only for now</b>
                <p>Running a preset spends the subscription's credits; an admin runs it. Browsing is open to everyone.</p>
              </div>
            </div>
          ) : (
            <fieldset className="ps-fields" disabled={running}>
              {fields.map((f) => (
                <label key={f.name} className="ps-field">
                  <span>
                    {f.label}
                    {f.required ? "" : " (optional)"}
                  </span>
                  <textarea rows={2} value={inputs[f.name] ?? ""} onChange={(e) => setInputs((i) => ({ ...i, [f.name]: e.target.value }))} placeholder={/prompt|idea|words/i.test(f.name) ? "A few words" : ""} />
                </label>
              ))}
              {!ctx.task.output && <p className="ts-hint warn">This post has no picture yet; the preset needs one.</p>}
              <button type="button" className="ts-btn primary ps-cta" disabled={!canRun || running} onClick={() => void run()}>
                {running ? <Orb size={14} status={null} /> : <Play size={14} />} Run this preset{detail.price !== null ? ` · ${detail.price} credits` : " · cost not known"}
              </button>
              {error && (
                <p className="ts-hint warn">
                  <TriangleAlert size={12} /> {error}
                </p>
              )}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}

/** A quick switch between the two picture-making panels (the phone's "AI" button lands on one of them). */
export function PanelSwitch({ ctx, current = "presets" }: { ctx: StudioCtx; current?: "presets" | "tools" }) {
  return (
    <div className="ps-seg small ps-ai-switch" role="tablist" aria-label="Presets or AI tools">
      <button type="button" role="tab" aria-selected={current === "presets"} className={current === "presets" ? "on" : ""} onClick={() => ctx.openPanel("presets")}>
        <LayoutGrid size={12} /> Presets
      </button>
      <button type="button" role="tab" aria-selected={current === "tools"} className={current === "tools" ? "on" : ""} onClick={() => ctx.openPanel("tools")}>
        <Sparkles size={12} /> AI tools
      </button>
    </div>
  );
}
