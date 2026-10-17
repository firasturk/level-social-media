import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Check, Globe, Instagram, LoaderCircle, Plus, ScanSearch, Sparkles, X } from "lucide-react";
import { get, post, put } from "@/api";
import type { Client } from "@shared/types";
import { PROFILE_REF_KINDS, type ProfileRecord, type ProfileRef } from "@shared/profile";
import { styleThumb } from "./StyleGallery";

type Reply = { profile: ProfileRecord };
type Grid = { id: string; title: string; status: string; updated: number; tiles: number };

/** The client's profile, loaded once per client and kept in step with the panel. */
function useProfile(clientId: string | null) {
  const [rec, setRec] = useState<ProfileRecord | null>(null);
  const load = useCallback(async () => {
    if (!clientId) return setRec(null);
    try {
      setRec((await get<Reply>(`/api/studio/profiles/${encodeURIComponent(clientId)}`)).profile);
    } catch {
      setRec(null);
    }
  }, [clientId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { rec, setRec, load };
}

/**
 * The client's profile on the journey's first screen: what the Analysis understood from their
 * Instagram, their website and the brands they are compared with. Opens the full profile.
 */
export function ProfileBar({ client, onClientsChanged }: { client: Client; onClientsChanged: (clients: Client[]) => void }) {
  const { rec, setRec } = useProfile(client.id);
  const [open, setOpen] = useState(false);
  const p = rec?.profile;
  return (
    <div className={`profile-bar ${p ? "on" : ""}`}>
      <span className="profile-bar-icon">
        <ScanSearch size={18} />
      </span>
      <span className="profile-bar-text">
        <strong>{p ? `${client.name}'s profile` : "Client profile"}</strong>
        <small>
          {rec?.status === "running"
            ? "The Analysis is reading their Instagram and website…"
            : p
              ? p.summary
              : "No profile yet. The Analysis reads their Instagram, their website and the brands you compare them with, then writes their voice, offer, branding and tips for the team."}
        </small>
      </span>
      <button type="button" className={p ? "secondary" : "primary"} onClick={() => setOpen(true)}>
        {p ? "Open profile" : (
          <>
            <Sparkles size={14} /> Analysis
          </>
        )}
      </button>
      {open && <ProfilePanel client={client} rec={rec} onRec={setRec} onClose={() => setOpen(false)} onClientsChanged={onClientsChanged} />}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="profile-list">
      <h4>{title}</h4>
      <ul>
        {items.map((x, i) => (
          <li key={i} dir="auto">
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfilePanel({
  client,
  rec,
  onRec,
  onClose,
  onClientsChanged,
}: {
  client: Client;
  rec: ProfileRecord | null;
  onRec: (r: ProfileRecord) => void;
  onClose: () => void;
  onClientsChanged: (clients: Client[]) => void;
}) {
  const [instagram, setInstagram] = useState(rec?.instagram ?? "");
  const [website, setWebsite] = useState(rec?.website ?? "");
  const [refs, setRefs] = useState<ProfileRef[]>(rec?.refs ?? []);
  const [busy, setBusy] = useState(rec?.status === "running");
  const [grids, setGrids] = useState<{ grids: Grid[]; reading: number } | null>(null);
  const p = rec?.profile;

  const loadGrids = useCallback(async () => {
    try {
      setGrids(await get(`/api/studio/profiles/${encodeURIComponent(client.id)}/grids`));
    } catch {
      setGrids(null);
    }
  }, [client.id]);
  useEffect(() => {
    void loadGrids();
  }, [loadGrids]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function analyse() {
    setBusy(true);
    try {
      const r = await post<Reply>(`/api/studio/profiles/${encodeURIComponent(client.id)}/analyse`, { instagram, website, refs });
      onRec(r.profile);
      toast.success(`${client.name}'s profile is written. The ideas and captions follow it now.`);
      void loadGrids();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyTone() {
    if (!p) return;
    const tone = [p.tone.description, p.tone.dialect && `Dialect: ${p.tone.dialect}.`, p.tone.improve.length && `Better than now: ${p.tone.improve.join("; ")}.`]
      .filter(Boolean)
      .join(" ");
    try {
      const r = await put<{ clients: Client[] }>(`/api/studio/clients/${encodeURIComponent(client.id)}`, { tone: tone.slice(0, 2000) });
      onClientsChanged(r.clients);
      toast.success("The brand kit's tone of voice follows the profile now.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const setRef = (i: number, patch: Partial<ProfileRef>) => setRefs((list) => list.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  return createPortal(
    <div className="profile-panel" role="dialog" aria-modal aria-label={`${client.name}'s profile`}>
      <header className="profile-top">
        <div>
          <small>Client profile</small>
          <h2>{client.name}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      <div className="profile-body">
        <aside className="profile-inputs">
          <label className="field-label">
            <span>
              <Instagram size={13} /> Their Instagram
            </span>
            <input value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@habibah1951" dir="ltr" />
          </label>
          <label className="field-label">
            <span>
              <Globe size={13} /> Their website
            </span>
            <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="habibah.com" dir="ltr" />
          </label>
          <div className="profile-refs">
            <span className="field-label">Brands to compare with</span>
            {refs.map((r, i) => (
              <div key={i} className="profile-ref">
                <input value={r.handle} onChange={(e) => setRef(i, { handle: e.target.value })} placeholder="@instagram" dir="ltr" aria-label="Instagram account" />
                <input value={r.website} onChange={(e) => setRef(i, { website: e.target.value })} placeholder="website (optional)" dir="ltr" aria-label="Website" />
                <select value={r.kind} onChange={(e) => setRef(i, { kind: e.target.value as ProfileRef["kind"] })} aria-label="Why we compare">
                  {PROFILE_REF_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k === "competitor" ? "Competitor" : "Direction to take"}
                    </option>
                  ))}
                </select>
                <button type="button" className="icon-button" onClick={() => setRefs((list) => list.filter((_, n) => n !== i))} aria-label="Remove">
                  <X size={14} />
                </button>
              </div>
            ))}
            {refs.length < 4 && (
              <button type="button" className="text-button" onClick={() => setRefs((list) => [...list, { handle: "", website: "", kind: "competitor" }])}>
                <Plus size={13} /> Add a brand
              </button>
            )}
            <small className="field-hint">A competitor to do better than, or a brand whose direction to take (Nike for a sports brand). They are studied, never copied.</small>
          </div>
          <button type="button" className="primary profile-run" disabled={busy || (!instagram.trim() && !website.trim())} onClick={() => void analyse()}>
            {busy ? <LoaderCircle className="spinning" size={15} /> : <Sparkles size={15} />}
            {busy ? "Reading… about a minute" : p ? "Analysis again" : "Analysis"}
          </button>
          {rec?.error && rec.status === "failed" && <p className="profile-error">{rec.error}</p>}
          {rec?.analysed && <small className="field-hint">Last Analysis: {new Date(rec.analysed).toLocaleString()}</small>}
        </aside>
        <div className="profile-main">
          {!p ? (
            <div className="profile-empty">
              <ScanSearch size={28} />
              <p>Give their Instagram and website, add the brands to compare with, then press Analysis.</p>
            </div>
          ) : (
            <>
              <section className="profile-card wide">
                <h3>Who they are</h3>
                <p dir="auto">{p.summary}</p>
                {p.audience && <p className="profile-muted" dir="auto">{p.audience}</p>}
                <small className="profile-muted">
                  {rec?.sources?.instagram
                    ? `@${rec.sources.instagram.username} · ${rec.sources.instagram.followers.toLocaleString()} followers · ${rec.sources.instagram.read} latest posts read`
                    : "Instagram not read"}
                  {rec?.sources?.website ? ` · website: ${rec.sources.website.pages.length} page${rec.sources.website.pages.length > 1 ? "s" : ""}` : ""}
                  {rec?.sources?.refs.length ? ` · compared with ${rec.sources.refs.map((r) => r.name).join(", ")}` : ""}
                </small>
              </section>
              <section className="profile-card">
                <h3>Tone of voice</h3>
                <p dir="auto">{p.tone.description}</p>
                {p.tone.dialect && <span className="journey-tag">{p.tone.dialect}</span>}
                {p.tone.examples.length > 0 && (
                  <div className="profile-quotes">
                    {p.tone.examples.map((x, i) => (
                      <q key={i} dir="auto">
                        {x}
                      </q>
                    ))}
                  </div>
                )}
                <List title="Keep" items={p.tone.keep} />
                <List title="Write better" items={p.tone.improve} />
                <button type="button" className="text-button" onClick={() => void applyTone()} title="Write this into the brand kit's tone of voice">
                  <Check size={13} /> Use as the brand kit's tone
                </button>
              </section>
              <section className="profile-card">
                <h3>What they sell</h3>
                <List title="Products" items={p.offer.products} />
                <List title="Heroes" items={p.offer.heroes} />
                <List title="Services" items={p.offer.services} />
              </section>
              <section className="profile-card">
                <h3>Branding</h3>
                {p.branding.colours.length > 0 && (
                  <div className="profile-colours">
                    {p.branding.colours.map((c, i) => {
                      const hex = /#[0-9a-f]{6}\b/i.exec(c)?.[0];
                      return (
                        <span key={i} className="journey-tag">
                          {hex && <i style={{ background: hex }} />}
                          {c}
                        </span>
                      );
                    })}
                  </div>
                )}
                {p.branding.type && <p dir="auto"><b>Lettering:</b> {p.branding.type}</p>}
                {p.branding.packaging && <p dir="auto"><b>Packaging:</b> {p.branding.packaging}</p>}
                {p.branding.photography && <p dir="auto"><b>Photography:</b> {p.branding.photography}</p>}
              </section>
              <section className="profile-card">
                <h3>Their content</h3>
                <List title="Kinds of posts" items={p.content.pillars} />
                <List title="What works" items={p.content.works} />
                <List title="What does little" items={p.content.weak} />
                {p.content.rhythm && <p className="profile-muted" dir="auto">{p.content.rhythm}</p>}
              </section>
              {p.refs.length > 0 && (
                <section className="profile-card wide">
                  <h3>Compared brands</h3>
                  <div className="profile-refs-grid">
                    {p.refs.map((r, i) => (
                      <div key={i} className="profile-ref-card">
                        <strong dir="auto">
                          {r.name} <span className="journey-tag">{/direction/i.test(r.kind) ? "Direction" : "Competitor"}</span>
                        </strong>
                        <List title="Strengths" items={r.strengths} />
                        <List title="Gaps we can own" items={r.gaps} />
                        <List title="What we do" items={r.takeaways} />
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section className="profile-card wide">
                <h3>Direction</h3>
                <p dir="auto">{p.direction}</p>
              </section>
              <section className="profile-card wide profile-tips">
                <h3>Tips for the team</h3>
                <div className="profile-refs-grid">
                  <List title="Text on the designs" items={p.tips.headlines} />
                  <List title="Captions" items={p.tips.captions} />
                  <List title="Pictures and layouts" items={p.tips.design} />
                </div>
              </section>
              <section className="profile-card wide">
                <h3>Suggested grids</h3>
                {grids?.grids.length ? (
                  <div className="profile-grids">
                    {grids.grids.map((g) => (
                      <figure key={g.id}>
                        <img src={styleThumb(g)} alt={g.title} loading="lazy" />
                        <figcaption>
                          {g.title}
                          <small>{g.status === "active" ? `On the Grids shelf${g.tiles ? ` · ${g.tiles} posts` : ""}` : "Waiting for approval"}</small>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : null}
                <p className="profile-muted">
                  {grids?.reading
                    ? `${grids.reading} more feeds from Pinterest are being read for ${client.name}; they arrive here in a few minutes. `
                    : ""}
                  Suggested grids wait for the admin's approval in Styles → To approve, then show first in this client's grid picker.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
