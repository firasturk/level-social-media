/**
 * The preset gallery (the ask's core): Higgsfield's presets page inside the studio, videos only
 * (the server keeps the cards with a reference video, or a picture preview of a preset whose
 * result is a video; shared/video-presets.ts). The stage shows the category list on the left and
 * the cards, each with the provider's own reference video (plays on hover or tap, muted, looping,
 * hotlinked from the provider) or its picture tagged "Picture preview", its title, one line of
 * description, chips (the slash command, the source, the category) and what it needs. The right
 * panel shows the picked preset in full: the video large, the instructions ("Learn more"), the
 * price, "Use this preset" (the Generate panel prefilled) and, for an admin on a runnable preset,
 * "Run this preset" with the confirm. Members browse; nothing is invented when a category is empty.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { BookOpen, Image as ImageIcon, LayoutGrid, Lock, Play, RefreshCw, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { PRESET_CATEGORIES, type PresetCard, type PresetCategoryId, type PresetDetail } from "@shared/video-presets";
import { listPresets, presetDetail, runPreset, type ConfirmAsk, type PresetList } from "../../studioApi";
import type { StudioShared } from "./types";

/** A search across what a card says: the same rule as the server's. */
export function matches(c: PresetCard, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [c.title, c.description, c.command ?? "", c.category ?? "", c.type ?? "", c.source].some((s) => s.toLowerCase().includes(t));
}

const SOURCE_LABELS: Record<string, string> = { viral: "Effects", marketing_studio: "Marketing Studio", genjutsu: "Genjutsu", katana: "Katana", recipe: "Recipe", soul: "Soul", recraft: "Recraft", what_if: "What if" };
export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s.replace(/_/g, " ");

export interface PresetsState {
  category: PresetCategoryId;
  setCategory: (c: PresetCategoryId) => void;
  q: string;
  setQ: (q: string) => void;
  list: PresetList | null;
  loading: boolean;
  error: string;
  /** The cards that match the search, in the category. */
  cards: PresetCard[];
  reload: (refresh?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  searchProvider: () => Promise<void>;
  selected: PresetCard | null;
  select: (card: PresetCard | null) => void;
  detail: PresetDetail | null;
  detailBusy: boolean;
  detailError: string;
}

/** The gallery's state, owned by the shell so the stage (the cards) and the side panel (the detail) share it. */
export function usePresets(s: StudioShared, active: boolean): PresetsState {
  const [category, setCategory] = useState<PresetCategoryId>("popular");
  const [q, setQ] = useState("");
  const [lists, setLists] = useState<Partial<Record<string, PresetList>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PresetCard | null>(null);
  const [detail, setDetail] = useState<PresetDetail | null>(null);
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
  const load = useCallback(
    async (c: PresetCategoryId, opts: { refresh?: boolean; q?: string } = {}) => {
      setLoading(true);
      setError("");
      try {
        const r = await listPresets(c, { refresh: opts.refresh, q: opts.q });
        if (alive.current) setLists((l) => ({ ...l, [key(c, opts.q)]: r }));
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [],
  );
  useEffect(() => {
    if (active && !lists[key(category)]) void load(category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, category]);
  const list = lists[key(category, q.trim() && lists[key(category, q.trim())] ? q.trim() : "")] ?? null;
  const cards = useMemo(() => (list ? list.items.filter((c) => matches(c, q)) : []), [list, q]);
  const loadMore = useCallback(async () => {
    if (!list?.nextCursor) return;
    setLoading(true);
    try {
      const r = await listPresets(category, { cursor: list.nextCursor });
      const seen = new Set(list.items.map((c) => `${c.source}:${c.id}`));
      if (alive.current) setLists((l) => ({ ...l, [key(category)]: { ...r, items: [...list.items, ...r.items.filter((c) => !seen.has(`${c.source}:${c.id}`))] } }));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [category, list]);
  const select = useCallback(
    (card: PresetCard | null) => {
      setSelected(card);
      setDetail(null);
      setDetailError("");
      if (!card) return;
      setDetailBusy(true);
      presetDetail(card.id, card.source, s.post)
        .then((r) => {
          if (alive.current) setDetail(r.preset);
        })
        .catch((e: Error) => {
          if (alive.current) setDetailError(e.message);
        })
        .finally(() => alive.current && setDetailBusy(false));
    },
    [s.post],
  );
  return {
    category,
    setCategory: (c) => {
      // Another category: the side panel forgets the preset picked in the last one.
      setCategory(c);
      setSelected(null);
      setDetail(null);
      setDetailError("");
    },
    q,
    setQ,
    list,
    loading,
    error,
    cards,
    reload: (refresh = false) => load(category, { refresh }),
    loadMore,
    searchProvider: () => load(category, { q: q.trim() }),
    selected,
    select,
    detail,
    detailBusy,
    detailError,
  };
}

/* ───────────── The stage: categories and cards ───────────── */

function playOn(e: MouseEvent<HTMLElement>, on: boolean) {
  const v = e.currentTarget.querySelector("video");
  if (!v) return;
  if (on) void v.play().catch(() => undefined);
  else {
    v.pause();
    v.currentTime = 0;
  }
}

export function PresetCardView({ card, selected, onSelect, onUse, children }: { card: PresetCard; selected: boolean; onSelect: () => void; onUse: () => void; children?: ReactNode }) {
  return (
    <article className={`vs-preset ${selected ? "on" : ""}`} onMouseEnter={(e) => playOn(e, true)} onMouseLeave={(e) => playOn(e, false)}>
      <button
        type="button"
        className="vs-preset-media"
        onClick={(e) => {
          // A tap plays the reference (muted) and opens the detail; hover already plays it on a computer.
          const v = e.currentTarget.querySelector("video");
          if (v && v.paused) void v.play().catch(() => undefined);
          onSelect();
        }}
        title={card.description || card.title}
        aria-label={`${card.title}: open`}
      >
        {card.video ? <video src={card.video} poster={card.poster ?? undefined} muted loop playsInline preload="none" /> : card.poster ? <img src={card.poster} alt="" loading="lazy" /> : <span className="vs-preset-blank">No preview</span>}
        {card.video ? (
          <span className="vs-preset-play" aria-hidden>
            <Play size={14} />
          </span>
        ) : card.poster ? (
          <span className="vs-preset-tag" title="Higgsfield shows a picture for this preset; the result is a video">
            <ImageIcon size={11} /> Picture preview
          </span>
        ) : null}
        {card.price !== null && <span className="vs-preset-price">{card.price} credits</span>}
      </button>
      <div className="vs-preset-text">
        <b>{card.title}</b>
        {card.description && <small className="vs-preset-desc">{card.description}</small>}
        <span className="vs-chips">
          {card.command && <em className="vs-chip cmd">{card.command}</em>}
          <em className="vs-chip">{sourceLabel(card.source)}</em>
          {card.category && card.category !== card.source && <em className="vs-chip">{card.category.replace(/[_-]+/g, " ")}</em>}
        </span>
        {card.needs.length > 0 && <small className="vs-needs">Needs: {card.needs.join(", ")}</small>}
        <span className="vs-preset-actions">
          <button type="button" className="ts-mini primary" onClick={onUse} title="Open Generate with this preset's words (and engine, when it names one) filled in">
            <Sparkles size={12} /> Use this preset
          </button>
          <button type="button" className="ts-mini" onClick={onSelect}>
            <BookOpen size={12} /> Learn more
          </button>
          {children}
        </span>
      </div>
    </article>
  );
}

export function PresetsGallery({ s, ps }: { s: StudioShared; ps: PresetsState }) {
  const cat = PRESET_CATEGORIES.find((c) => c.id === ps.category)!;
  return (
    <div className="vs-gallery">
      <nav className="vs-cats" aria-label="Preset categories">
        {PRESET_CATEGORIES.map((c) => (
          <button key={c.id} type="button" className={ps.category === c.id ? "on" : ""} onClick={() => ps.setCategory(c.id)} title={c.hint}>
            {c.label}
          </button>
        ))}
      </nav>
      <div className="vs-grid-wrap">
        <header className="vs-gallery-head">
          <span className="vs-gallery-title">
            <LayoutGrid size={14} /> {cat.label}
            <small>{cat.hint}</small>
          </span>
          <label className="vs-search">
            <Search size={13} />
            <input type="search" placeholder="Search presets" value={ps.q} onChange={(e) => ps.setQ(e.target.value)} aria-label="Search presets" />
            {ps.q && (
              <button type="button" className="ts-icon" onClick={() => ps.setQ("")} aria-label="Clear the search">
                <X size={12} />
              </button>
            )}
          </label>
          <button type="button" className="ts-icon" onClick={() => void ps.reload(true)} disabled={ps.loading} title="Ask Higgsfield for today's list (the gallery is kept a day)" aria-label="Refresh">
            <RefreshCw size={13} />
          </button>
        </header>
        {ps.list && !ps.list.signedIn && (
          <p className="vs-note warn">
            <TriangleAlert size={13} /> {ps.list.reason || "Not signed in: Connection → Higgsfield → Sign in to Higgsfield."}
          </p>
        )}
        {ps.list && ps.list.signedIn && ps.list.reason && (
          <p className="vs-note warn">
            <TriangleAlert size={13} /> {ps.list.reason}
          </p>
        )}
        {ps.error && (
          <p className="vs-note warn">
            <TriangleAlert size={13} /> {ps.error}
          </p>
        )}
        {ps.loading && !ps.list && (
          <p className="vs-note">
            <Orb size={16} /> Reading Higgsfield's presets…
          </p>
        )}
        {ps.list && ps.list.signedIn && !ps.list.reason && ps.cards.length === 0 && !ps.loading && (
          <p className="vs-note">
            {ps.q.trim() ? (
              <>
                Nothing here matches “{ps.q.trim()}”.{" "}
                <button type="button" className="ts-link" onClick={() => void ps.searchProvider()}>
                  Search Higgsfield for it
                </button>
              </>
            ) : (
              ps.list.empty
            )}
          </p>
        )}
        <div className="vs-grid">
          {ps.cards.map((card) => (
            <PresetCardView key={`${card.source}:${card.id}`} card={card} selected={ps.selected?.id === card.id && ps.selected.source === card.source} onSelect={() => ps.select(card)} onUse={() => s.usePreset(card)} />
          ))}
        </div>
        {ps.list?.nextCursor && (
          <button type="button" className="ts-btn vs-more" disabled={ps.loading} onClick={() => void ps.loadMore()}>
            {ps.loading ? <Orb size={14} status={null} /> : null} More presets
          </button>
        )}
        {ps.list && !ps.list.admin && ps.list.signedIn && <p className="vs-note">You can browse every preset; running one is admins only for now.</p>}
      </div>
    </div>
  );
}

/* ───────────── The side panel: one preset in full ───────────── */

/** The text inputs a preset asks for beyond the picture (a prompt, a mood), from its schema. */
function textInputs(detail: PresetDetail): { name: string; label: string; required: boolean }[] {
  const schema = detail.inputSchema as { properties?: Record<string, { type?: string; description?: string; title?: string }>; required?: string[] } | null;
  if (!schema?.properties) return [];
  const req = schema.required ?? [];
  return Object.entries(schema.properties)
    .filter(([name, p]) => (p.type === "string" || !p.type) && !/image|photo|picture|product|media|video|clip|frame|character|reference/i.test(`${name} ${p.description ?? ""}`))
    .map(([name, p]) => ({ name, label: p.title || p.description || name.replace(/[_-]+/g, " "), required: req.includes(name) }));
}

export function PresetDetailPanel({ s, ps }: { s: StudioShared; ps: PresetsState }) {
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
  if (!card) {
    return (
      <div className="vs-panel">
        <div className="ts-panel-head">
          <span>
            <LayoutGrid size={13} /> Presets
          </span>
        </div>
        <p className="ts-hint">Pick a preset on the left to see its reference video, what it does and what it needs. “Use this preset” fills the Generate panel with its words; a runnable preset can also be run from here by an admin, on the subscription credits.</p>
        <p className="ts-hint">The videos are Higgsfield's own examples, shown from their site; the studio keeps no copy. Only presets whose result is a video are listed here; picture presets live in the Photo studio.</p>
      </div>
    );
  }
  const detail = ps.detail;
  const fields = detail ? textInputs(detail) : [];
  const readiness = detail?.readiness as { ready?: boolean; missing?: string[]; message?: string } | null;
  async function run(confirm = false) {
    if (!s.post || !card) return;
    setRunning(true);
    setError("");
    try {
      const r = await runPreset({ batch: s.post.batch, index: s.post.index, presetId: card.id, source: card.source, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v.trim())), confirm });
      await s.reloadVideos();
      s.setShownId(r.video.id);
      toast.success(`“${card.title}” is being made from this post's picture; it takes a minute or two.`);
      s.openPanel("versions");
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && (d.needsConfirm || d.needsEstimate)) {
        const ok = await askConfirm(d.needsEstimate ? `Run “${card.title}” on this post's picture: Higgsfield names no price for it. Run it at an unknown cost from the subscription credits?` : `Run “${card.title}” on this post's picture: about ${d.credits} credits from the subscription balance${d.balance != null ? ` (${d.balance} available)` : ""}.`, { ok: d.needsEstimate ? "Run it anyway, cost unknown" : `Run · ${d.credits} credits`, danger: false, cancel: "Not now" });
        if (ok) return run(true);
      } else setError(err.message);
    } finally {
      setRunning(false);
    }
  }
  const canRun = !!s.post && !!detail?.runnable && s.admin && !!s.pictureUrl;
  return (
    <div className="vs-panel vs-detail">
      <div className="ts-panel-head">
        <span>
          <LayoutGrid size={13} /> Preset
        </span>
        <button type="button" className="ts-icon" onClick={() => ps.select(null)} aria-label="Close the preset">
          <X size={13} />
        </button>
      </div>
      <div className="vs-detail-media" onMouseEnter={(e) => playOn(e, true)}>
        {card.video ? <video key={card.video} src={card.video} poster={card.poster ?? undefined} muted loop playsInline controls preload="metadata" /> : card.poster ? <img src={card.poster} alt="" /> : <span className="vs-preset-blank">No preview</span>}
        {!card.video && card.poster && (
          <span className="vs-preset-tag">
            <ImageIcon size={11} /> Picture preview
          </span>
        )}
      </div>
      <b className="vs-detail-title">{card.title}</b>
      {card.description && <p className="vs-detail-desc">{card.description}</p>}
      <span className="vs-chips">
        {card.command && <em className="vs-chip cmd">{card.command}</em>}
        <em className="vs-chip">{sourceLabel(card.source)}</em>
        {card.category && card.category !== card.source && <em className="vs-chip">{card.category.replace(/[_-]+/g, " ")}</em>}
        {card.engine && <em className="vs-chip">engine · {card.engine}</em>}
      </span>
      {ps.detailBusy && (
        <p className="ts-hint">
          <Orb size={13} /> Reading the preset…
        </p>
      )}
      {ps.detailError && <p className="ts-hint warn">{ps.detailError}</p>}
      {card.needs.length > 0 && (
        <p className="ts-hint">
          <b>Needs:</b> {card.needs.join(", ")}.{s.pictureUrl && card.needs.some((n) => /picture/.test(n)) ? " This post's picture is used." : ""}
        </p>
      )}
      {detail && (
        <p className="ts-hint">
          <b>Cost:</b> {detail.price !== null ? `about ${detail.price} credits from the subscription (said again before the run).` : "not known: Higgsfield names no price. An admin confirms the run at an unknown cost."}
        </p>
      )}
      {readiness && typeof readiness === "object" && (readiness.ready !== undefined || readiness.missing || readiness.message) && (
        <p className="ts-hint">
          <b>Ready?</b> {readiness.ready ? "Yes: everything the preset needs is there." : readiness.message || (readiness.missing?.length ? `Still needed: ${readiness.missing.join(", ")}.` : "Not yet.")}
        </p>
      )}
      {detail && !detail.runnable && <p className="ts-hint">{detail.source === "recipe" ? "A recipe is a set of steps, not one run: use its words in Generate, or follow it on Higgsfield." : detail.source === "katana" ? "A Katana production runs on Higgsfield itself; the studio shows it for reference." : "This preset cannot be run from here today."}</p>}
      <div className="vs-detail-actions">
        <button type="button" className="ts-btn primary vs-cta" onClick={() => s.usePreset(card)}>
          <Sparkles size={14} /> Use this preset
        </button>
        {detail?.instructions && (
          <button type="button" className="ts-btn vs-cta" onClick={() => setOpen((o) => !o)}>
            <BookOpen size={14} /> {open ? "Hide the details" : "Learn more"}
          </button>
        )}
      </div>
      {open && detail?.instructions && <pre className="vs-words">{detail.instructions}</pre>}
      {detail?.runnable && (
        <>
          <span className="ts-group-title">Run it here</span>
          {!s.admin ? (
            <div className="vs-locked" role="note">
              <Lock size={14} />
              <div>
                <b>Admins only for now</b>
                <p>Running a preset spends the subscription's credits; an admin runs it. Browsing is open to everyone.</p>
              </div>
            </div>
          ) : (
            <fieldset className="vs-fields" disabled={running}>
              {fields.map((f) => (
                <label key={f.name} className="vs-field">
                  <span>
                    {f.label}
                    {f.required ? "" : " (optional)"}
                  </span>
                  <textarea rows={2} value={inputs[f.name] ?? ""} onChange={(e) => setInputs((i) => ({ ...i, [f.name]: e.target.value }))} placeholder={/prompt|idea|words/i.test(f.name) ? "A few words" : ""} />
                </label>
              ))}
              {!s.pictureUrl && <p className="ts-hint warn">This post has no picture yet; the preset needs one.</p>}
              <button type="button" className="ts-btn primary vs-cta" disabled={!canRun} onClick={() => void run()} title={!s.post ? "Open a post first" : undefined}>
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
