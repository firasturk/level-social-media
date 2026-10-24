/**
 * AI influencers (admins): the client's own AI person, designed here and made once as a Higgsfield
 * character sheet, then put into trend videos (Genjutsu motion presets: trending, new, Higgsfield's
 * own) with that character. Every paid step shows Higgsfield's price and waits for the confirm;
 * designing and browsing spend nothing. A finished influencer can join the client's ambassadors, so
 * the campaigns can cast it. Members see nothing (the list is admins only).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Play, Plus, Sparkles, Trash2, UserRoundPlus, Users, X } from "lucide-react";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { ApiError, del, get, post } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { INFLUENCER_TRAITS, TREND_CATEGORIES, type Influencer, type TrendCategory } from "@shared/influencers";
import type { PresetCard } from "@shared/video-presets";
import type { Client } from "@shared/types";
import "./influencers.css";

type ConfirmAsk = { needsConfirm?: boolean; needsEstimate?: boolean; credits?: number | null; balance?: number | null };

/** A paid call: asked once, the price shown, sent again with the confirm. */
async function withConfirm<T>(send: (confirm: boolean) => Promise<T>, what: string): Promise<T | null> {
  try {
    return await send(false);
  } catch (e) {
    const err = e as ApiError;
    const d = (err.data ?? {}) as ConfirmAsk;
    if (err.status !== 409 || !(d.needsConfirm || d.needsEstimate)) throw e;
    const ok = await askConfirm(d.needsEstimate ? `${what}: Higgsfield names no price for it. Make it at an unknown cost from the subscription credits?` : `${what}: about ${d.credits} credits from the subscription balance${d.balance != null ? ` (${d.balance} available)` : ""}.`, { ok: d.needsEstimate ? "Make it, cost unknown" : `Make it · ${d.credits} credits`, danger: false, cancel: "Not now" });
    return ok ? send(true) : null;
  }
}

export default function Influencers({ client }: { client: Client }) {
  const [list, setList] = useState<Influencer[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [trendsFor, setTrendsFor] = useState<Influencer | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get<{ influencers: Influencer[] }>(`/api/studio/influencers?client=${encodeURIComponent(client.id)}`);
      setList(r.influencers);
      setError("");
    } catch (e) {
      if ((e as ApiError).status === 403) setHidden(true);
      else setError((e as Error).message);
    }
  }, [client.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // While something is being made, the list is read again (that is also when finished jobs are collected).
  const making = !!list?.some((i) => i.status === "making" || i.trends.some((t) => t.status === "queued" || t.status === "generating"));
  useEffect(() => {
    if (!making) return;
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [making, load]);

  if (hidden) return null;
  return (
    <section className="inf">
      <header className="inf-head">
        <span>
          <Users size={15} /> <b>AI influencers</b>
          <small>The client's own AI person from Higgsfield, put into trending videos.</small>
        </span>
        {!creating && (
          <button type="button" className="text-button" onClick={() => setCreating(true)}>
            <Plus size={13} /> New influencer
          </button>
        )}
      </header>
      {error && <p className="inf-note warn">{error}</p>}
      {creating && (
        <NewInfluencer
          client={client}
          onDone={(i) => {
            setCreating(false);
            if (i) setList((l) => [i, ...(l ?? []).filter((x) => x.id !== i.id)]);
          }}
        />
      )}
      {list === null ? (
        <p className="inf-note">
          <Orb size={14} /> Reading…
        </p>
      ) : list.length === 0 && !creating ? (
        <p className="inf-note">No influencer yet. Design one: its look, its style and a few words; Higgsfield names the price before anything is made.</p>
      ) : (
        <div className="inf-list">
          {list.map((i) => (
            <InfluencerCard key={i.id} i={i} onChanged={load} onTrends={() => setTrendsFor(i)} />
          ))}
        </div>
      )}
      {trendsFor && (
        <TrendPicker
          influencer={trendsFor}
          onClose={() => setTrendsFor(null)}
          onMade={() => {
            setTrendsFor(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function NewInfluencer({ client, onDone }: { client: Client; onDone: (i: Influencer | null) => void }) {
  const [name, setName] = useState("");
  const [traits, setTraits] = useState<Record<string, string>>({ ethnicity_origin_base: "middle_eastern", age: "adult" });
  const [hijab, setHijab] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const woman = traits.gender === "female";
  async function prepare() {
    if (!name.trim()) return toast.error("Give the influencer a name.");
    setBusy(true);
    try {
      const r = await post<{ influencer: Influencer }>("/api/studio/influencers/prepare", { client: client.id, name: name.trim(), traits, hijab: woman && hijab, notes });
      toast.success(`${r.influencer.name} is designed: ${r.influencer.credits !== null ? `about ${r.influencer.credits} credits to make` : "Higgsfield named no price"}. Nothing is made until you press Make.`);
      onDone(r.influencer);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="inf-new" disabled={busy}>
      <label className="inf-field wide">
        <span>Name</span>
        <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder="Yazan, Lina, Abu Fadi…" />
      </label>
      {INFLUENCER_TRAITS.filter((g) => !(woman && g.id === "facial_hair")).map((g) => (
        <label key={g.id} className="inf-field">
          <span>{g.label}</span>
          <select value={traits[g.id] ?? ""} onChange={(e) => setTraits((t) => ({ ...t, [g.id]: e.target.value }))}>
            <option value="">Any</option>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
      ))}
      {woman && (
        <label className="inf-check">
          <input type="checkbox" checked={hijab} onChange={(e) => setHijab(e.target.checked)} /> Wears a hijab
        </label>
      )}
      <label className="inf-field wide">
        <span>A few words (optional)</span>
        <textarea dir="auto" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="a university student who loves street food; warm smile; always in a navy jacket" />
      </label>
      <p className="inf-note wide">Always modestly dressed, a real-looking person from Amman. Designing asks Higgsfield for the look and the price only: nothing is made or spent.</p>
      <div className="inf-actions wide">
        <button type="button" className="primary btn-pill" onClick={() => void prepare()}>
          {busy ? <Orb size={13} status={null} /> : <Sparkles size={14} />} Design and price
        </button>
        <button type="button" className="text-button" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

function InfluencerCard({ i, onChanged, onTrends }: { i: Influencer; onChanged: () => Promise<void>; onTrends: () => void }) {
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    try {
      const r = await withConfirm((confirm) => post(`/api/studio/influencers/${i.id}/make`, { confirm }), `Make ${i.name}`);
      if (r) toast.success(`${i.name} is being made; it takes a minute or two.`);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cast() {
    try {
      await post(`/api/studio/influencers/${i.id}/cast`, {});
      toast.success(`${i.name} joined the client's ambassadors: campaigns can cast them now.`);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function remove() {
    if (!(await askConfirm(`Remove the design of ${i.name}?`))) return;
    try {
      await del(`/api/studio/influencers/${i.id}`);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <article className={`inf-card ${i.status}`}>
      <div className="inf-sheet">
        {i.image ? <img src={i.image} alt={i.name} loading="lazy" /> : <span>{i.status === "making" ? <Orb size={18} /> : i.status === "failed" ? "Not made" : "Designed, not made yet"}</span>}
      </div>
      <div className="inf-body">
        <b>{i.name}</b>
        <small className="inf-status">{i.status === "draft" ? `Designed · ${i.credits !== null ? `about ${i.credits} credits to make` : "no price named"}` : i.status === "making" ? "Being made…" : i.status === "ready" ? (i.inCast ? "Ready · in the client's ambassadors" : "Ready") : "Failed"}</small>
        {i.design && i.status === "draft" && <p className="inf-design" dir="auto">{i.design}</p>}
        {i.error && <p className="inf-note warn">{i.error}</p>}
        <span className="inf-actions">
          {(i.status === "draft" || i.status === "failed") && (
            <>
              <button type="button" className="primary btn-pill" disabled={busy} onClick={() => void make()}>
                {busy ? <Orb size={13} status={null} /> : <Sparkles size={14} />} Make{i.credits !== null ? ` · ${i.credits} credits` : ""}
              </button>
              <button type="button" className="text-button" onClick={() => void remove()} aria-label="Remove">
                <Trash2 size={13} />
              </button>
            </>
          )}
          {i.status === "ready" && (
            <>
              <button type="button" className="primary btn-pill" onClick={onTrends}>
                <Play size={14} /> Make a trend
              </button>
              {!i.inCast && (
                <button type="button" className="text-button" onClick={() => void cast()}>
                  <UserRoundPlus size={13} /> Add to ambassadors
                </button>
              )}
            </>
          )}
        </span>
        {i.trends.length > 0 && (
          <div className="inf-trends">
            {i.trends.map((t) => (
              <div key={t.id} className={`inf-trend ${t.status}`}>
                {t.video ? <AutoplayVideo src={t.video} mode="preview" label={t.presetName} /> : <span className="inf-trend-wait">{t.status === "failed" ? "Failed" : <Orb size={16} />}</span>}
                <small>
                  {t.presetName}
                  {t.credits !== null ? ` · ${t.credits} credits` : ""}
                </small>
                {t.error && <small className="warn">{t.error}</small>}
                {t.video && (
                  <a className="text-button" href={`${t.video}?download=1`}>
                    <Download size={12} /> Download
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function TrendPicker({ influencer, onClose, onMade }: { influencer: Influencer; onClose: () => void; onMade: () => void }) {
  const [category, setCategory] = useState<TrendCategory>("genjutsu-trending");
  const [items, setItems] = useState<PresetCard[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let live = true;
    setItems(null);
    setError("");
    get<{ items: PresetCard[] }>(`/api/studio/influencers/${influencer.id}/trends?category=${category}`)
      .then((r) => live && setItems(r.items))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [influencer.id, category]);
  async function make(card: PresetCard) {
    setBusy(card.id);
    try {
      const r = await withConfirm((confirm) => post(`/api/studio/influencers/${influencer.id}/trend`, { presetId: card.id, confirm }), `“${card.title}” with ${influencer.name}`);
      if (r) {
        toast.success(`“${card.title}” is being made with ${influencer.name}; it takes a few minutes.`);
        onMade();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="inf-picker" role="dialog" aria-label={`Trends for ${influencer.name}`}>
      <header>
        <b>Make a trend with {influencer.name}</b>
        <nav>
          {TREND_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={category === c.id ? "on" : ""} onClick={() => setCategory(c.id)}>
              {c.label}
            </button>
          ))}
        </nav>
        <button type="button" className="ts-icon" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <p className="inf-note">Higgsfield's trending motion videos: {influencer.name} takes the place of the person in the video. Pick one; its price is shown before anything is made.</p>
      {error && <p className="inf-note warn">{error}</p>}
      {items === null && !error ? (
        <p className="inf-note">
          <Orb size={14} /> Reading the trends…
        </p>
      ) : (
        <div className="inf-grid">
          {(items ?? []).map((card) => (
            <article key={card.id} className="inf-tile">
              {card.video ? <AutoplayVideo src={card.video} poster={card.poster} mode="preview" label={card.title} /> : card.poster ? <img src={card.poster} alt="" loading="lazy" /> : null}
              <small>{card.title}</small>
              <button type="button" className="primary btn-pill" disabled={!!busy} onClick={() => void make(card)}>
                {busy === card.id ? <Orb size={12} status={null} /> : <Play size={12} />} Use this
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
