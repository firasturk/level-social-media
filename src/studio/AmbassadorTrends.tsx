/**
 * Trends with a character (admins): pick one of the client's ambassadors (its portrait) or one of the
 * Soul characters made on the Higgsfield account, pick a Genjutsu trend (trending, new, Higgsfield's
 * own), and the character takes the place of the person in that video. The studio never makes a
 * character. Browsing spends nothing; each trend shows Higgsfield's price and waits for the confirm.
 * Members see nothing (the list is admins only).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Play, Sparkles, X } from "lucide-react";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { ApiError, get, post } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { TREND_CATEGORIES, type Trend, type TrendCategory, type TrendCharacter } from "@shared/ambassador-trends";
import type { PresetCard } from "@shared/video-presets";
import type { Client } from "@shared/types";
import "./ambassador-trends.css";

type ConfirmAsk = { needsConfirm?: boolean; needsEstimate?: boolean; credits?: number | null; balance?: number | null };

export default function AmbassadorTrends({ client }: { client: Client }) {
  const [characters, setCharacters] = useState<TrendCharacter[] | null>(null);
  const [trends, setTrends] = useState<Trend[]>([]);
  const [reason, setReason] = useState("");
  const [hidden, setHidden] = useState(false);
  const [picked, setPicked] = useState<TrendCharacter | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get<{ characters: TrendCharacter[]; trends: Trend[]; reason: string }>(`/api/studio/ambassadors/trends?client=${encodeURIComponent(client.id)}`);
      setCharacters(r.characters);
      setTrends(r.trends);
      setReason(r.reason);
    } catch (e) {
      if ((e as ApiError).status === 403) setHidden(true);
      else setReason((e as Error).message);
    }
  }, [client.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // While a trend is being made the list is read again (that is also when finished videos are collected).
  const making = trends.some((t) => t.status === "queued" || t.status === "generating");
  useEffect(() => {
    if (!making) return;
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [making, load]);

  if (hidden) return null;
  return (
    <section className="atr">
      <header className="atr-head">
        <b>Trends with a character</b>
        <small>Pick one of this client's ambassadors, its AI influencers or one of your Higgsfield characters, then a trending video: the character takes the place of the person in it. Each trend shows its price before anything is made.</small>
      </header>
      {reason && <p className="atr-note warn">{reason}</p>}
      {characters === null ? (
        <p className="atr-note">
          <Orb size={14} /> Reading the characters…
        </p>
      ) : characters.length === 0 ? (
        <p className="atr-note">No character yet: give an ambassador a portrait, or make a character on Higgsfield.</p>
      ) : (
        <div className="atr-chars">
          {characters.map((ch) => (
            <button key={ch.id} type="button" className="atr-char" onClick={() => setPicked(ch)} title={`Make a trend with ${ch.name}`}>
              {ch.image ? <img src={ch.image} alt="" loading="lazy" /> : <span className="atr-blank" />}
              <b>{ch.name}</b>
              <small>{ch.from === "ambassador" ? "Ambassador" : ch.from === "influencer" ? "AI influencer" : "Higgsfield character"}</small>
            </button>
          ))}
        </div>
      )}
      {trends.length > 0 && (
        <div className="atr-trends">
          {trends.map((t) => (
            <div key={t.id} className={`atr-trend ${t.status}`}>
              {t.video ? <AutoplayVideo src={t.video} mode="preview" label={t.presetName} /> : <span className="atr-wait">{t.status === "failed" ? "Failed" : <Orb size={16} />}</span>}
              <small>
                {t.characterName} · {t.presetName}
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
      {picked && (
        <TrendPicker
          client={client}
          character={picked}
          onClose={() => setPicked(null)}
          onMade={() => {
            setPicked(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function TrendPicker({ client, character, onClose, onMade }: { client: Client; character: TrendCharacter; onClose: () => void; onMade: () => void }) {
  const [category, setCategory] = useState<TrendCategory>("genjutsu-trending");
  const [items, setItems] = useState<PresetCard[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let live = true;
    setItems(null);
    setError("");
    get<{ items: PresetCard[] }>(`/api/studio/ambassadors/trends/gallery?client=${encodeURIComponent(client.id)}&character=${encodeURIComponent(character.id)}&category=${category}`)
      .then((r) => live && setItems(r.items))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [client.id, character.id, category]);
  async function make(card: PresetCard) {
    setBusy(card.id);
    const send = (confirm: boolean) => post("/api/studio/ambassadors/trends/make", { client: client.id, character: character.id, presetId: card.id, confirm });
    try {
      try {
        await send(false);
      } catch (e) {
        const err = e as ApiError;
        const d = (err.data ?? {}) as ConfirmAsk;
        if (err.status !== 409 || !(d.needsConfirm || d.needsEstimate)) throw e;
        const what = `“${card.title}” with ${character.name}`;
        const ok = await askConfirm(d.needsEstimate ? `${what}: Higgsfield names no price for it. Make it at an unknown cost from the subscription credits?` : `${what}: about ${d.credits} credits from the subscription balance${d.balance != null ? ` (${d.balance} available)` : ""}.`, { ok: d.needsEstimate ? "Make it, cost unknown" : `Make it · ${d.credits} credits`, danger: false, cancel: "Not now" });
        if (!ok) return;
        await send(true);
      }
      toast.success(`“${card.title}” is being made with ${character.name}; it takes a few minutes.`);
      onMade();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="atr-picker" role="dialog" aria-label={`Trends with ${character.name}`}>
      <header>
        <b>
          <Sparkles size={14} /> A trend with {character.name}
        </b>
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
      {error && <p className="atr-note warn">{error}</p>}
      {items === null && !error ? (
        <p className="atr-note">
          <Orb size={14} /> Reading the trends…
        </p>
      ) : (
        <div className="atr-grid">
          {(items ?? []).map((card) => (
            <article key={card.id} className="atr-tile">
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
