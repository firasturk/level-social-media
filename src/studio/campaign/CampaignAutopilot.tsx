/**
 * Campaign Autopilot (docs/campaign-autopilot.md), admins only while it is tested: set up a whole
 * campaign, review and edit the plan (ideas, products, references, storyboards, engines, costs per
 * provider), approve all of it or the selected items, then follow production post by post and shot
 * by shot. Reels are rendered here, in this tab, with the video editor's own engine, and stored on
 * their cards. Finished work opens in the existing editors from its card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Clapperboard, Film, Image as ImageIcon, Loader2, Pause, Play, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { ApiError } from "@/api";
import { defaultSetup, needsKeyFrame, planCounts, UNIT_LABEL, type CampaignPlan, type CampaignSetup, type CostUnit, type ImagePlanItem, type PlanRef, type ProductPick, type ShotPlan, type ShotSource, type VideoPlanItem } from "@shared/campaign-plan";
import { approveShots, redoStep, retargetItem, approveCampaign, campaignEngines, campaignSources, createCampaign, discardCampaign, listCampaigns, loadCampaign, pauseCampaign, refreshPrices, regenerate, renderedStep, resumeCampaign, retryStep, savePlan, tickCampaign, type Campaign, type CampaignStep, type Engines, type Sources } from "./campaignApi";
import "./campaign.css";

interface Props {
  batch: string;
  onClose: () => void;
  /** Opens the Studio on a card (its editors are there). */
  onOpenCard: (index: number) => void;
}

const fmt = (n: number | null | undefined, unit: CostUnit | null) => (n === null || n === undefined ? "unknown" : unit === "usd" ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : `${Math.round(n * 100) / 100} ${unit === "magnific-credits" ? "Magnific cr" : "Higgsfield cr"}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const SOURCE_LABEL: Record<ShotSource, { label: string; hint: string }> = {
  "start-image": { label: "New starting image + video generation", hint: "A starting picture is made for this shot, then animated" },
  animate: { label: "Video generation from a client photo", hint: "The client's photo (or the key frame) is animated" },
  existing: { label: "Existing media, used as it is", hint: "The client's own clip or photo; nothing generated" },
};

function RefBadge({ r }: { r: PlanRef | null }) {
  if (!r) return null;
  const label = r.kind === "reference" ? "Reference · inspiration, not the result" : r.kind === "asset" ? "Client asset · used as it is" : "Generated preview";
  return (
    <span className={`ca-ref ca-ref-${r.kind}`} title={`${label}. ${r.from}`}>
      {r.thumb ? <img src={r.thumb} alt="" loading="lazy" /> : <ImageIcon size={14} />}
      <span>
        <b>{label}</b>
        <small>{r.label}</small>
      </span>
    </span>
  );
}

function ProductBadge({ p }: { p: ProductPick | null }) {
  if (!p) return <span className="ca-muted">No product</span>;
  return (
    <span className="ca-product" title={p.note ?? p.name}>
      {p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <ImageIcon size={14} />}
      <span>
        <b>{p.name}</b>
        <small>{p.from === "drive" ? "Client's Drive (actual photo)" : "Month's product photo"}</small>
      </span>
    </span>
  );
}

/* ───────────── Setup ───────────── */

function Setup({ batch, sources, onCreated }: { batch: string; sources: Sources | null; onCreated: (c: Campaign) => void }) {
  const [s, setS] = useState<CampaignSetup>(defaultSetup());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof CampaignSetup>(k: K, v: CampaignSetup[K]) => setS((x) => ({ ...x, [k]: v }));
  const toggleProduct = (p: ProductPick) => setS((x) => ({ ...x, products: x.products.some((q) => q.id === p.id) ? x.products.filter((q) => q.id !== p.id) : [...x.products, { id: p.id, name: p.name, from: p.from, thumb: p.thumb, ...(p.note ? { note: p.note } : {}) }] }));
  const toggleRef = (m: PlanRef) => setS((x) => ({ ...x, direction: { ...x.direction, references: x.direction.references.some((r) => r.id === m.id) ? x.direction.references.filter((r) => r.id !== m.id) : [...x.direction.references, { kind: "reference", id: m.id, label: m.label, thumb: m.thumb, from: m.from }] } }));
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      onCreated((await createCampaign(batch, s)).campaign);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const num = (k: "imagePosts" | "videos" | "shotsPerVideo" | "videoSeconds", min: number, max: number) => <input type="number" min={min} max={max} value={s[k]} onChange={(e) => set(k, Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />;
  return (
    <div className="ca-setup">
      <section className="ca-card">
        <h3>The campaign</h3>
        <div className="ca-grid2">
          <label>
            Objective
            <textarea rows={2} dir="auto" value={s.objective} onChange={(e) => set("objective", e.target.value)} placeholder="e.g. Launch the winter menu and bring families in this week" />
          </label>
          <label>
            Target audience
            <textarea rows={2} dir="auto" value={s.audience} onChange={(e) => set("audience", e.target.value)} placeholder="Leave empty to use the brand kit's audience" />
          </label>
          <label>
            Offer
            <input dir="auto" value={s.offer} onChange={(e) => set("offer", e.target.value)} placeholder="e.g. 15% off until Friday" />
          </label>
          <label>
            Key message
            <input dir="auto" value={s.message} onChange={(e) => set("message", e.target.value)} />
          </label>
        </div>
      </section>
      <section className="ca-card">
        <h3>What to make</h3>
        <div className="ca-grid4">
          <label>Image posts {num("imagePosts", 0, 12)}</label>
          <label>Videos (Reels) {num("videos", 0, 8)}</label>
          <label>Shots per video {num("shotsPerVideo", 1, 8)}</label>
          <label>Video length (s) {num("videoSeconds", 5, 60)}</label>
          <label>
            Image format
            <select value={s.imageFormat} onChange={(e) => set("imageFormat", e.target.value as CampaignSetup["imageFormat"])}>
              {["4:5", "1:1", "9:16"].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Video frame
            <select value={s.videoFrame} onChange={(e) => set("videoFrame", e.target.value as CampaignSetup["videoFrame"])}>
              {["9:16", "4:5", "1:1", "16:9"].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Language
            <select value={s.language} onChange={(e) => set("language", e.target.value as CampaignSetup["language"])}>
              <option value="both">Arabic and English</option>
              <option value="ar">Arabic</option>
              <option value="en">English</option>
            </select>
          </label>
          <label>
            Platforms
            <span className="ca-checks">
              {["instagram", "tiktok", "facebook"].map((p) => (
                <label key={p} className="ca-check">
                  <input type="checkbox" checked={s.platforms.includes(p)} onChange={() => set("platforms", s.platforms.includes(p) ? s.platforms.filter((x) => x !== p) : [...s.platforms, p])} /> {p}
                </label>
              ))}
            </span>
          </label>
          <label>
            From
            <input type="date" value={s.periodStart} onChange={(e) => set("periodStart", e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={s.periodEnd} onChange={(e) => set("periodEnd", e.target.value)} />
          </label>
        </div>
      </section>
      <section className="ca-card">
        <h3>Products</h3>
        <div className="ca-seg" role="radiogroup">
          <label className="ca-check">
            <input type="radio" checked={s.productMode === "suggest"} onChange={() => set("productMode", "suggest")} /> Suggest from the client's products (you review them in the plan)
          </label>
          <label className="ca-check">
            <input type="radio" checked={s.productMode === "manual"} onChange={() => set("productMode", "manual")} /> Only the products I pick
          </label>
        </div>
        {s.productMode === "manual" && (
          <div className="ca-thumbs">
            {!sources && <Loader2 className="spin" size={16} />}
            {sources?.products.map((p) => (
              <button type="button" key={p.id} className={`ca-thumb ${s.products.some((q) => q.id === p.id) ? "on" : ""}`} onClick={() => toggleProduct(p)} title={p.note ?? p.name}>
                {p.thumb && <img src={p.thumb} alt="" loading="lazy" />}
                <span>{p.name}</span>
                <small>{p.from === "drive" ? "Drive" : "Month"}</small>
              </button>
            ))}
            {sources && !sources.products.length && <p className="ca-muted">No product photos in the month or the client's Drive folders.</p>}
          </div>
        )}
        <p className="ca-muted">Products come from the month's photos and the client's connected Drive folders; nothing needs uploading.</p>
      </section>
      <section className="ca-card">
        <h3>Creative direction</h3>
        <textarea rows={3} dir="auto" value={s.direction.prompt} onChange={(e) => setS((x) => ({ ...x, direction: { ...x.direction, prompt: e.target.value } }))} placeholder="Mood, light, places, people, pace… The brand kit (tone, colours, rules) is used as it is." />
        {!!sources?.media.length && (
          <>
            <small className="ca-muted">Pick references from the client's Drive (labelled as inspiration, never as the expected result):</small>
            <div className="ca-thumbs">
              {sources.media
                .filter((m) => m.media !== "clip")
                .slice(0, 24)
                .map((m) => (
                  <button type="button" key={m.id} className={`ca-thumb ${s.direction.references.some((r) => r.id === m.id) ? "on" : ""}`} onClick={() => toggleRef(m)} title={m.label}>
                    {m.thumb && <img src={m.thumb} alt="" loading="lazy" />}
                    <span>{m.label}</span>
                  </button>
                ))}
            </div>
          </>
        )}
      </section>
      {error && <p className="ca-error">{error}</p>}
      <div className="ca-actions">
        <button type="button" className="cta primary" disabled={busy || (!s.imagePosts && !s.videos)} onClick={() => void submit()}>
          {busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />} {busy ? "Writing the plan…" : "Write the plan"}
        </button>
        <small className="ca-muted">One text-model call (billed by the text provider, outside the production budget). No picture or video is made before you approve.</small>
      </div>
    </div>
  );
}

/* ───────────── Costs and approval ───────────── */

function CostPanel({ c, retries, setRetries, accepted, setAccepted }: { c: Campaign; retries: number; setRetries: (n: number) => void; accepted: Record<string, number>; setAccepted: (a: Record<string, number>) => void }) {
  const p = c.proposal;
  const n = p.counts;
  return (
    <section className="ca-card ca-costs">
      <h3>Totals and cost before approval</h3>
      <div className="ca-counts">
        <span><b>{n.imagePosts}</b> image posts</span>
        <span><b>{n.videos}</b> finished videos</span>
        <span><b>{n.shots}</b> video shots ({n.clips} generated clips, {n.existingShots} existing media)</span>
        <span><b>{n.startImages}</b> starting images ({n.keyFrames} key frames)</span>
        <span><b>{n.pictures}</b> pictures to generate in all</span>
        <span><b>{n.assemblies}</b> assemblies · <b>{n.renders}</b> renders (free)</span>
      </div>
      {p.kept.length > 0 && <p className="ca-muted">{p.kept.length} finished steps are kept and not charged again.</p>}
      <table className="ca-table">
        <thead>
          <tr>
            <th>Provider and unit</th>
            <th>Steps</th>
            <th>Estimate</th>
            <th>Retry allowance</th>
            <th>Maximum authorised</th>
          </tr>
        </thead>
        <tbody>
          {p.caps.map((cap) => (
            <tr key={cap.unit}>
              <td>{UNIT_LABEL[cap.unit]}</td>
              <td>{p.costs.totals[cap.unit]?.steps ?? 0}{cap.unknown ? ` (${cap.unknown} unknown)` : ""}</td>
              <td>{fmt(cap.estimate, cap.unit)}</td>
              <td>{fmt(cap.retryAllowance, cap.unit)}</td>
              <td><b>{fmt(cap.cap, cap.unit)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ca-muted">Units are never added together: dollars, Higgsfield credits and Magnific credits are separate budgets.</p>
      <label className="ca-inline">
        Retries per step
        <select value={retries} onChange={(e) => setRetries(Number(e.target.value))}>
          {[0, 1, 2, 3].map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <small className="ca-muted">The cap is the estimate × (1 + retries). A step that would go past it pauses the campaign.</small>
      </label>
      {p.costs.unknown.length > 0 && (
        <div className="ca-warn">
          <AlertTriangle size={16} />
          <div>
            <b>{p.costs.unknown.length} step{p.costs.unknown.length === 1 ? "" : "s"} with no established cost.</b> Refresh the estimates, change the engine, or accept each at an amount you authorise:
            <ul>
              {p.costs.unknown.map((u) => (
                <li key={u.step}>
                  {u.item} {u.shot ?? ""} · {u.label} ·{" "}
                  <input type="number" min={0} step="any" placeholder={u.unit === "usd" ? "USD" : "credits"} value={accepted[u.step] ?? ""} onChange={(e) => setAccepted({ ...accepted, [u.step]: Number(e.target.value) })} /> {u.unit === "usd" ? "USD" : "credits"}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <details>
        <summary>Not inside the cap</summary>
        <ul className="ca-list">
          {c.outsideTheCap.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Every priced step ({p.costs.lines.length})</summary>
        <table className="ca-table">
          <tbody>
            {p.costs.lines.map((l) => (
              <tr key={l.step}>
                <td>{l.item} {l.shot ?? ""}</td>
                <td>{l.label}</td>
                <td>{fmt(l.amount, l.unit)}</td>
                <td className="ca-muted">{l.source === "demo" ? "preview fixture, not a live price" : l.source ?? "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/* ───────────── Plan items ───────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="ca-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ImageItem({ it, sources, engines, onChange, onRegen, onProduct, cost, busy }: { it: ImagePlanItem; sources: Sources | null; engines: Engines | null; onChange: (x: ImagePlanItem) => void; onRegen: () => void; onProduct: (p: ProductPick | null) => void; cost: string; busy: boolean }) {
  return (
    <article className={`ca-item ${it.selected ? "" : "off"}`}>
      <header>
        <label className="ca-check">
          <input type="checkbox" checked={it.selected} onChange={(e) => onChange({ ...it, selected: e.target.checked })} />
          <ImageIcon size={15} /> <b>Image post · {it.key}</b>
        </label>
        <span className="ca-pill">{cost}</span>
        <button type="button" className="text-button" disabled={busy} onClick={onRegen} title="Write this post again (one text call); the rest of the plan stays">
          <RefreshCw size={14} /> Regenerate
        </button>
      </header>
      <div className="ca-item-body">
        <div className="ca-col">
          <Field label="Idea">
            <textarea rows={2} dir="auto" value={it.idea} onChange={(e) => onChange({ ...it, idea: e.target.value })} />
          </Field>
          <Field label="Objective">
            <input dir="auto" value={it.objective} onChange={(e) => onChange({ ...it, objective: e.target.value })} />
          </Field>
          <Field label="Visual direction">
            <textarea rows={2} dir="auto" value={it.visual} onChange={(e) => onChange({ ...it, visual: e.target.value })} />
          </Field>
          <div className="ca-grid3">
            <Field label="Headline">
              <input dir="auto" value={it.headline} onChange={(e) => onChange({ ...it, headline: e.target.value })} />
            </Field>
            <Field label="Call to action">
              <input dir="auto" value={it.cta} onChange={(e) => onChange({ ...it, cta: e.target.value })} />
            </Field>
            <Field label="Image engine">
              <select value={it.engine.model} onChange={(e) => onChange({ ...it, engine: { kind: "engine", model: e.target.value } })}>
                {[...new Set([it.engine.model, ...(engines?.images.map((x) => x.model) ?? [])])].map((m) => (
                  <option key={m} value={m}>{engines?.images.find((x) => x.model === m)?.name ?? m}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Caption">
            <textarea rows={2} dir="auto" value={it.caption} onChange={(e) => onChange({ ...it, caption: e.target.value })} />
          </Field>
        </div>
        <div className="ca-side">
          <ProductBadge p={it.product} />
          <ProductSelect value={it.product} sources={sources} disabled={busy} onChange={onProduct} />
          <RefBadge r={it.reference} />
          <small className="ca-muted">Outputs: {it.outputs} picture</small>
        </div>
      </div>
    </article>
  );
}

function ProductSelect({ value, sources, onChange, disabled }: { value: ProductPick | null; sources: Sources | null; onChange: (p: ProductPick | null) => void; disabled?: boolean }) {
  return (
    <select aria-label="Product" disabled={disabled} title="Changing the product rewrites this item's words for it (one text call); review, then save" value={value ? `${value.from}:${value.id}` : ""} onChange={(e) => {
      const p = sources?.products.find((x) => `${x.from}:${x.id}` === e.target.value);
      onChange(p ? { id: p.id, name: p.name, from: p.from, thumb: p.thumb, ...(p.note ? { note: p.note } : {}) } : null);
    }}>
      <option value="">No product</option>
      {value && !sources?.products.some((x) => x.id === value.id) && <option value={`${value.from}:${value.id}`}>{value.name}</option>}
      {sources?.products.map((p) => (
        <option key={`${p.from}:${p.id}`} value={`${p.from}:${p.id}`}>{p.name} ({p.from === "drive" ? "Drive" : "month"})</option>
      ))}
    </select>
  );
}

function Shot({ v, s, i, sources, onChange, onMove, onDelete, onRegen, cost, busy }: { v: VideoPlanItem; s: ShotPlan; i: number; sources: Sources | null; onChange: (x: ShotPlan) => void; onMove: (d: -1 | 1) => void; onDelete: () => void; onRegen: () => void; cost: string; busy: boolean }) {
  const firstStart = v.shots.find((x) => x.source === "start-image")?.key;
  const startNote = s.source === "start-image" ? (s.key === firstStart ? "Key frame (the card's picture)" : "Another angle of the key frame") : s.source === "animate" ? (s.asset ? "From the client's photo" : "From the key frame") : "";
  return (
    <li className="ca-shot">
      <div className="ca-shot-head">
        <b>{i + 1}</b>
        <span className={`ca-src ca-src-${s.source}`} title={SOURCE_LABEL[s.source].hint}>
          {s.source === "existing" ? <Film size={13} /> : <Clapperboard size={13} />} {SOURCE_LABEL[s.source].label}
        </span>
        {startNote && <small className="ca-muted">{startNote}</small>}
        <span className="ca-pill">{cost}</span>
        <span className="ca-shot-tools">
          <button type="button" className="icon-button" disabled={i === 0} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp size={14} /></button>
          <button type="button" className="icon-button" disabled={i === v.shots.length - 1} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown size={14} /></button>
          <button type="button" className="icon-button" disabled={busy} onClick={onRegen} title="Write this shot again (one text call)"><RefreshCw size={14} /></button>
          <button type="button" className="icon-button" disabled={v.shots.length <= 1} onClick={onDelete} aria-label="Delete shot"><Trash2 size={14} /></button>
        </span>
      </div>
      <div className="ca-grid4">
        <Field label="Seconds">
          <input type="number" min={1} max={15} step={0.5} value={s.seconds} onChange={(e) => onChange({ ...s, seconds: Number(e.target.value) || 1 })} />
        </Field>
        <Field label="Framing">
          <input value={s.framing} onChange={(e) => onChange({ ...s, framing: e.target.value })} />
        </Field>
        <Field label="Camera">
          <input value={s.camera} onChange={(e) => onChange({ ...s, camera: e.target.value })} />
        </Field>
        <Field label="Source">
          <select value={s.source} onChange={(e) => onChange({ ...s, source: e.target.value as ShotSource, asset: e.target.value === "start-image" ? null : s.asset })}>
            <option value="start-image">New starting image</option>
            <option value="animate">Animate a photo</option>
            <option value="existing" disabled={!sources?.media.length}>Existing media</option>
          </select>
        </Field>
      </div>
      <Field label="Action">
        <textarea rows={2} dir="auto" value={s.action} onChange={(e) => onChange({ ...s, action: e.target.value })} />
      </Field>
      <div className="ca-grid2">
        <Field label="On-screen text">
          <input dir="auto" value={s.text} onChange={(e) => onChange({ ...s, text: e.target.value })} />
        </Field>
        {s.source !== "start-image" && (
          <Field label={s.source === "existing" ? "Client clip or photo" : "Client photo to animate"}>
            <select value={s.asset?.id ?? ""} onChange={(e) => {
              const m = sources?.media.find((x) => x.id === e.target.value);
              onChange({ ...s, asset: m ? { kind: "asset", id: m.id, label: m.label, thumb: m.thumb, from: m.from, media: m.media } : null });
            }}>
              <option value="">{s.source === "animate" ? "The key frame" : "Choose…"}</option>
              {sources?.media.filter((m) => s.source === "existing" || m.media !== "clip").map((m) => (
                <option key={m.id} value={m.id}>{m.media === "clip" ? "Clip" : "Photo"} · {m.label.slice(0, 60)}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="ca-refs">
        <RefBadge r={s.asset} />
        <RefBadge r={s.reference} />
      </div>
    </li>
  );
}

function VideoItem({ v, sources, engines, onChange, onRegen, onProduct, costOf, busy }: { v: VideoPlanItem; sources: Sources | null; engines: Engines | null; onChange: (x: VideoPlanItem) => void; onRegen: (shot?: string) => void; onProduct: (p: ProductPick | null) => void; costOf: (step: string) => string; busy: boolean }) {
  const setShot = (k: number, s: ShotPlan) => onChange({ ...v, shots: v.shots.map((x, j) => (j === k ? s : x)) });
  const move = (k: number, d: -1 | 1) => {
    const shots = [...v.shots];
    [shots[k], shots[k + d]] = [shots[k + d], shots[k]];
    onChange({ ...v, shots });
  };
  const total = Math.round(v.shots.reduce((t, s) => t + s.seconds, 0) * 10) / 10;
  return (
    <article className={`ca-item ${v.selected ? "" : "off"}`}>
      <header>
        <label className="ca-check">
          <input type="checkbox" checked={v.selected} onChange={(e) => onChange({ ...v, selected: e.target.checked })} />
          <Film size={15} /> <b>Reel · {v.key}</b>
        </label>
        <span className="ca-pill">{total} s · {v.frame} · {v.shots.length} shots</span>
        <button type="button" className="text-button" disabled={busy} onClick={() => onRegen()}>
          <RefreshCw size={14} /> Regenerate
        </button>
      </header>
      <div className="ca-item-body">
        <div className="ca-col">
          <Field label="Concept">
            <textarea rows={2} dir="auto" value={v.concept} onChange={(e) => onChange({ ...v, concept: e.target.value })} />
          </Field>
          <div className="ca-grid3">
            <Field label="Hook">
              <input dir="auto" value={v.hook} onChange={(e) => onChange({ ...v, hook: e.target.value })} />
            </Field>
            <Field label="Call to action">
              <input dir="auto" value={v.cta} onChange={(e) => onChange({ ...v, cta: e.target.value })} />
            </Field>
            <Field label="Transitions">
              <select value={v.transitions} onChange={(e) => onChange({ ...v, transitions: e.target.value as VideoPlanItem["transitions"] })}>
                <option value="cuts">Cuts</option>
                <option value="crossfades">Crossfades</option>
                <option value="mixed">Mixed</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="ca-side">
          <ProductBadge p={v.product} />
          <ProductSelect value={v.product} sources={sources} disabled={busy} onChange={onProduct} />
          <small className="ca-muted">{needsKeyFrame(v) ? `Key frame: ${costOf(`${v.key}:-:image`)}` : "No key frame needed"}</small>
        </div>
      </div>
      <h4>Storyboard</h4>
      <ol className="ca-shots">
        {v.shots.map((s, k) => (
          <Shot key={s.key} v={v} s={s} i={k} sources={sources} busy={busy} onChange={(x) => setShot(k, x)} onMove={(d) => move(k, d)} onDelete={() => onChange({ ...v, shots: v.shots.filter((_, j) => j !== k) })} onRegen={() => onRegen(s.key)} cost={s.source === "existing" ? "free" : [costOf(`${v.key}:${s.key}:frame`), costOf(`${v.key}:${s.key}:clip`)].filter((x) => x !== "—").join(" + ")} />
        ))}
      </ol>
      <button type="button" className="text-button" disabled={v.shots.length >= 8} onClick={() => onChange({ ...v, shots: [...v.shots, { key: `s${Math.max(0, ...v.shots.map((s) => Number(s.key.slice(1)) || 0)) + 1}`, seconds: 3, action: "", framing: "medium", camera: "static", reference: null, source: "start-image", asset: null, text: "" }] })}>
        <Plus size={14} /> Add a shot
      </button>
      <div className="ca-grid3">
        <Field label="Voiceover">
          <textarea rows={2} dir="auto" value={v.voiceover} onChange={(e) => onChange({ ...v, voiceover: e.target.value })} placeholder="None" />
        </Field>
        <Field label="Music direction">
          <input value={v.music.direction} onChange={(e) => onChange({ ...v, music: { ...v.music, direction: e.target.value } })} />
        </Field>
        <Field label="Licensed track">
          <select value={v.music.trackId ?? ""} onChange={(e) => {
            const t = sources?.tracks.find((x) => x.id === e.target.value);
            onChange({ ...v, music: { ...v.music, trackId: t?.id ?? null, trackTitle: t?.title ?? null } });
          }}>
            <option value="">Pick by mood from the library</option>
            {sources?.tracks.map((t) => (
              <option key={t.id} value={t.id}>{t.title}{t.bpm ? ` · ${t.bpm} BPM` : ""} · {t.licence}</option>
            ))}
          </select>
        </Field>
        <Field label="Colour look">
          <select value={v.look} onChange={(e) => onChange({ ...v, look: e.target.value })}>
            <option value="">None</option>
            {sources?.looks.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Starting images">
          <select value={v.keyFrameEngine.model} onChange={(e) => onChange({ ...v, keyFrameEngine: { kind: "engine", model: e.target.value } })}>
            {[...new Set([v.keyFrameEngine.model, ...(engines?.images.map((x) => x.model) ?? [])])].map((m) => (
              <option key={m} value={m}>{engines?.images.find((x) => x.model === m)?.name ?? m}</option>
            ))}
          </select>
        </Field>
        <Field label="Video engine">
          <select value={`${v.clipEngine.provider}|${v.clipEngine.model}`} onChange={(e) => {
            const [provider, model] = e.target.value.split("|");
            const found = engines?.clips.find((x) => x.provider === provider && x.model === model);
            if (found) onChange({ ...v, clipEngine: { provider: found.provider, model: found.model, name: found.name } });
          }}>
            <option value={`${v.clipEngine.provider}|${v.clipEngine.model}`}>{v.clipEngine.name}</option>
            {engines?.clips.filter((x) => !(x.provider === v.clipEngine.provider && x.model === v.clipEngine.model)).map((x) => (
              <option key={`${x.provider}|${x.model}`} value={`${x.provider}|${x.model}`}>{x.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Caption">
        <textarea rows={2} dir="auto" value={v.caption} onChange={(e) => onChange({ ...v, caption: e.target.value })} />
      </Field>
    </article>
  );
}

/* ───────────── Production ───────────── */

const STATUS_LABEL: Record<CampaignStep["status"], string> = { waiting: "Waiting", ready: "Ready", running: "Working", done: "Done", failed: "Failed", paused: "Paused", skipped: "Skipped" };

const ANGLES = [
  ["left", "From the left"],
  ["right", "From the right"],
  ["top", "From above"],
  ["low", "Low angle"],
  ["closer", "Closer"],
  ["wider", "Wider"],
  ["front", "Front"],
] as const;

/**
 * A Reel's starting pictures, in shot order, for the admin to look at before any clip is made:
 * each shot's picture (or the client's own media), its length and action, "Make again" for one
 * picture, and the approval that lets the clips be made.
 */
function ShotReview({ c, v, onApprove, onRedo, busy }: { c: Campaign; v: VideoPlanItem; onApprove: (step: string) => void; onRedo: (step: string, angle?: string) => void; busy: boolean }) {
  const review = c.steps.find((s) => s.step === `${v.key}:-:review`);
  const [angles, setAngles] = useState<Record<string, string>>({});
  if (!review || review.status === "done" || review.status === "skipped") return null;
  const firstStart = v.shots.find((x) => x.source === "start-image")?.key;
  const stepOf = (shot: ShotPlan) => (shot.source === "existing" || (shot.source === "animate" && shot.asset) ? null : shot.source === "start-image" && shot.key !== firstStart ? c.steps.find((s) => s.step === `${v.key}:${shot.key}:frame`) : c.steps.find((s) => s.step === `${v.key}:-:image`));
  const ready = review.status === "ready";
  return (
    <div className="ca-review">
      <div className="ca-review-head">
        <b>Look at {v.key}'s shots before the videos are made</b>
        <span className="ca-muted">{ready ? "Every starting picture is ready. Approve them, or make one again; no clip is made before you approve." : "The starting pictures are being made; they appear here as they finish."}</span>
      </div>
      <ol className="ca-review-shots">
        {v.shots.map((shot, i) => {
          const st = stepOf(shot);
          const pic = st?.output ?? shot.asset?.thumb ?? null;
          return (
            <li key={shot.key}>
              <div className="ca-review-pic">
                {pic ? (
                  <a href={pic} target="_blank" rel="noreferrer" title="Open large">
                    <img src={pic} alt={`Shot ${i + 1}`} />
                  </a>
                ) : (
                  <span className="ca-muted">{st?.status === "running" ? <Loader2 size={18} className="spin" /> : "…"}</span>
                )}
                <span className="ca-pill">{i + 1} · {shot.seconds} s</span>
              </div>
              <small dir="auto">{shot.action}</small>
              {!st && <small className="ca-muted">{shot.source === "existing" ? "The client's own media, used as it is" : "The client's photo, animated"}</small>}
              {st && st.status !== "running" && (
                <span className="ca-review-redo">
                  {st.kind === "frame" && (
                    <select aria-label="Angle" value={angles[st.step] ?? ""} onChange={(e) => setAngles({ ...angles, [st.step]: e.target.value })} disabled={busy}>
                      <option value="">Same angle</option>
                      {ANGLES.map(([id, label]) => (
                        <option key={id} value={id}>{label}</option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="text-button" disabled={busy} onClick={() => onRedo(st.step, angles[st.step] || undefined)} title={st.kind === "image" ? "Another take of the key frame (its other angles are made again from it)" : "This angle made again"}>
                    <RefreshCw size={13} /> Make again
                  </button>
                </span>
              )}
              {st?.error && <small className="ca-error">{st.error}</small>}
            </li>
          );
        })}
      </ol>
      <button type="button" className="cta primary" disabled={!ready || busy} onClick={() => onApprove(review.step)}>
        <Check size={16} /> Approve shots &amp; make the videos
      </button>
    </div>
  );
}

function Progress({ c, onRetry, onOpenCard, rendering, renderFailed, onRenderAgain, onApproveShots, onRedo, busy }: { c: Campaign; onRetry: (s: CampaignStep) => void; onOpenCard: (n: number) => void; rendering: { step: string; fraction: number; phase: string } | null; renderFailed: Record<string, string>; onRenderAgain: (step: string) => void; onApproveShots: (step: string) => void; onRedo: (step: string, angle?: string) => void; busy: boolean }) {
  const items = [...c.plan.images.map((i) => ({ key: i.key, title: i.headline || i.idea.slice(0, 50), video: false })), ...c.plan.videos.map((v) => ({ key: v.key, title: v.hook || v.concept.slice(0, 50), video: true }))];
  return (
    <section className="ca-card">
      <h3>Production</h3>
      <div className="ca-progress">
        {items.map((it) => {
          const steps = c.steps.filter((s) => s.item === it.key);
          if (!steps.length) return null;
          const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
          const card = steps.find((s) => s.kind === "post")?.post;
          return (
            <div key={it.key} className="ca-prog-item">
              <header>
                {it.video ? <Film size={15} /> : <ImageIcon size={15} />}
                <b>{it.key}</b> <span className="ca-muted">{it.title}</span>
                <span className="ca-pill">{done}/{steps.length}</span>
                {card && (
                  <button type="button" className="text-button" onClick={() => onOpenCard(card)}>
                    Open card {card}
                  </button>
                )}
              </header>
              {it.video && <ShotReview c={c} v={c.plan.videos.find((x) => x.key === it.key)!} onApprove={onApproveShots} onRedo={onRedo} busy={busy} />}
              <div className="ca-steps">
                {steps.map((s) => (
                  <div key={s.step} className={`ca-step ca-st-${s.status}`} title={[s.label, s.note, s.error].filter(Boolean).join(" · ")}>
                    {s.output && s.kind !== "render" && s.kind !== "post" ? <img src={s.output} alt="" loading="lazy" /> : <span className="ca-step-icon">{s.status === "done" ? <Check size={14} /> : s.status === "running" ? <Loader2 size={14} className="spin" /> : s.status === "failed" ? <X size={14} /> : null}</span>}
                    <span>
                      <b>{s.shot ? `${s.shot} · ` : ""}{s.kind}</b>
                      <small>{STATUS_LABEL[s.status]}{s.unit && s.spent ? ` · ${fmt(s.spent, s.unit)}` : ""}{s.attempts > 1 ? ` · attempt ${s.attempts}/${s.maxAttempts}` : ""}</small>
                      {rendering?.step === s.step && <small>Rendering {Math.round(rendering.fraction * 100)}% · {rendering.phase}</small>}
                      {s.error && <small className="ca-error">{s.error}</small>}
                      {s.note && s.status !== "done" && <small className="ca-muted">{s.note}</small>}
                    </span>
                    {renderFailed[s.step] && (
                      <>
                        <small className="ca-error">Render in this tab failed: {renderFailed[s.step]}</small>
                        <button type="button" className="text-button" onClick={() => onRenderAgain(s.step)}>
                          <RotateCcw size={13} /> Render again
                        </button>
                      </>
                    )}
                    {s.status === "failed" && (
                      <button type="button" className="text-button" onClick={() => onRetry(s)}>
                        <RotateCcw size={13} /> Retry this step
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ───────────── The screen ───────────── */

export default function CampaignAutopilot({ batch, onClose, onOpenCard }: Props) {
  const [c, setC] = useState<Campaign | null>(null);
  const [draft, setDraft] = useState<CampaignPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [list, setList] = useState<{ id: string; status: string; created: number; summary: string; simulate: boolean }[] | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [engines, setEngines] = useState<Engines | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retries, setRetries] = useState(1);
  const [accepted, setAccepted] = useState<Record<string, number>>({});
  const [rendering, setRendering] = useState<{ step: string; fraction: number; phase: string } | null>(null);
  /** Renders that failed in this tab: not tried again by themselves (the button does). */
  const [renderFailed, setRenderFailed] = useState<Record<string, string>>({});
  const renderBusy = useRef(false);

  useEffect(() => {
    listCampaigns(batch).then((r) => setList(r.campaigns), (e) => setError(errText(e)));
    campaignSources(batch).then(setSources, () => setSources({ products: [], media: [], looks: [], tracks: [] }));
    campaignEngines().then(setEngines, () => undefined);
  }, [batch]);

  const take = useCallback((next: Campaign) => {
    setC(next);
    setDraft(next.plan);
    setDirty(false);
  }, []);

  const act = async (label: string, fn: () => Promise<{ campaign: Campaign }>) => {
    setBusy(label);
    setError("");
    try {
      take((await fn()).campaign);
    } catch (e) {
      setError(errText(e));
      if (e instanceof ApiError && (e.data as { stale?: boolean }).stale && c) take((await loadCampaign(c.id)).campaign);
    } finally {
      setBusy("");
    }
  };

  // The selection's figures: asked again when the selection or the retries change (a free read).
  const selected = useMemo(() => (draft ? [...draft.images, ...draft.videos].filter((x) => x.selected).map((x) => x.key) : []), [draft]);
  useEffect(() => {
    if (!c || dirty) return;
    const same = c.proposal.items.join(",") === [...selected].sort().join(",") && c.proposal.retries === retries;
    if (same) return;
    const t = setTimeout(() => {
      loadCampaign(c.id, { items: selected, retries }).then((r) => setC(r.campaign), (e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [c, selected, retries, dirty]);

  // While producing: a pass every few seconds; renders run here one at a time.
  const producing = c?.status === "producing";
  useEffect(() => {
    if (!c || !producing) return;
    const t = setInterval(() => {
      tickCampaign(c.id).then((r) => setC(r.campaign), () => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [c?.id, producing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!c || !producing || renderBusy.current) return;
    const next = c.steps.find((s) => s.kind === "render" && s.status === "ready" && s.ref?.kind === "project" && s.post && !renderFailed[s.step]);
    if (!next) return;
    renderBusy.current = true;
    setRendering({ step: next.step, fraction: 0, phase: "starting" });
    void (async () => {
      try {
        const { renderProjectToCard } = await import("@/video-editor/headless-render");
        const r = await renderProjectToCard({ batch: c.batch, post: next.post!, projectId: next.ref!.id, stills: next.stills ?? [] }, { onProgress: (fraction, phase) => setRendering({ step: next.step, fraction, phase }) });
        setC((await renderedStep(c.id, next.step, r.videoId)).campaign);
      } catch (e) {
        setRenderFailed((f) => ({ ...f, [next.step]: errText(e) }));
      } finally {
        renderBusy.current = false;
        setRendering(null);
      }
    })();
  }, [c, producing, renderFailed]);

  /** A new product: the item's words rewritten for it on the server, put in the draft to review and save. */
  const retarget = async (item: ImagePlanItem | VideoPlanItem, product: ProductPick | null) => {
    if (!c) return;
    setBusy("retarget");
    setError("");
    setNotice(`Rewriting ${item.key} for ${product?.name ?? "no product"}…`);
    try {
      const r = await retargetItem(c.id, item, product);
      update((p) => ({ ...p, images: p.images.map((i) => (i.key === r.item.key ? (r.item as ImagePlanItem) : i)), videos: p.videos.map((v) => (v.key === r.item.key ? (r.item as VideoPlanItem) : v)) }));
      setNotice(r.note);
    } catch (e) {
      setNotice("");
      setError(errText(e));
    } finally {
      setBusy("");
    }
  };
  const update = (fn: (p: CampaignPlan) => CampaignPlan) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  };
  const costOf = (step: string) => {
    const l = c?.proposal.costs.lines.find((x) => x.step === step);
    return l ? fmt(l.amount, l.unit) : "—";
  };
  const counts = draft ? planCounts(draft) : null;
  const approvedItems = new Set(c?.approval?.terms.items ?? []);
  const needs = c?.approval?.needsApproval ?? [];
  const canApprove = !!c && !dirty && !busy && (c.status === "draft" || needs.length > 0 || !c.approval?.current) && c.status !== "done";
  const approve = (items: string[]) =>
    act("approve", () =>
      approveCampaign(c!.id, { items, retries, signature: c!.proposal.signature, acceptedUnknown: Object.entries(accepted).filter(([, a]) => a > 0).map(([step, amount]) => ({ step, unit: c!.proposal.costs.unknown.find((u) => u.step === step)!.unit, amount })) }),
    );

  return (
    <div className="ca-overlay" role="dialog" aria-label="Campaign Autopilot">
      <header className="ca-top">
        <Sparkles size={18} />
        <h2>Campaign Autopilot</h2>
        <span className="ca-pill">Admins · testing</span>
        {c?.simulate && <span className="ca-pill warn">Preview: providers simulated, nothing is generated or charged</span>}
        <span className="ca-grow" />
        {c && (
          <button type="button" className="text-button" onClick={() => { setC(null); setDraft(null); listCampaigns(batch).then((r) => setList(r.campaigns), () => undefined); }}>
            All campaigns
          </button>
        )}
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="ca-body">
        {error && <p className="ca-error" role="alert">{error}</p>}
        {notice && <p className="ca-muted" role="status">{busy === "retarget" ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {notice}</p>}
        {!c && (
          <>
            {!!list?.length && (
              <section className="ca-card">
                <h3>This month's campaigns</h3>
                <ul className="ca-list">
                  {list.map((x) => (
                    <li key={x.id}>
                      <button type="button" className="text-button" onClick={() => void act("open", () => loadCampaign(x.id))}>
                        {new Date(x.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · {x.status}{x.simulate ? " · simulated" : ""} · {x.summary || "Untitled plan"}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Setup batch={batch} sources={sources} onCreated={take} />
          </>
        )}
        {c && draft && (
          <>
            <section className="ca-card ca-summary">
              <h3>Campaign summary</h3>
              <p dir="auto">{draft.summary.concept}</p>
              {draft.summary.mix && <p className="ca-muted" dir="auto">{draft.summary.mix}</p>}
              {draft.summary.together && <p className="ca-muted" dir="auto">{draft.summary.together}</p>}
              {counts && <p className="ca-pill">{counts.imagePosts} image posts · {counts.videos} videos · {counts.shots} shots · {counts.clips} clips · {counts.startImages} starting images</p>}
              {draft.planningNotes.length > 0 && (
                <ul className="ca-list ca-muted">
                  {draft.planningNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <div className="ca-status">
                Status: <b>{c.status}</b>
                {c.pauseReason && <span className="ca-warn-inline"><AlertTriangle size={14} /> {c.pauseReason}</span>}
                {c.status === "done" && <span className="ca-ok"><Check size={14} /> Ready for review. Nothing was sent to the client, approved or published.</span>}
                {needs.length > 0 && <span className="ca-warn-inline">Changed after approval, waiting for approval: {needs.join(", ")}</span>}
              </div>
            </section>
            {(c.status === "producing" || c.status === "paused" || c.status === "done" || c.steps.length > 0) && <Progress c={c} busy={!!busy} onApproveShots={(step) => void act("shots", () => approveShots(c.id, step))} onRedo={(step, angle) => void act("redo", async () => {
              try {
                return await redoStep(c.id, step, angle);
              } catch (e) {
                if (e instanceof ApiError && (e.data as { needsConfirm?: boolean }).needsConfirm && window.confirm(e.message)) return redoStep(c.id, step, angle, true);
                throw e;
              }
            })} onOpenCard={onOpenCard} rendering={rendering} renderFailed={renderFailed} onRenderAgain={(step) => setRenderFailed((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== step)))} onRetry={(s) => void act("retry", async () => {
              try {
                return await retryStep(c.id, s.step);
              } catch (e) {
                if (e instanceof ApiError && (e.data as { needsExtra?: boolean }).needsExtra && window.confirm(`${e.message}`)) return retryStep(c.id, s.step, true);
                throw e;
              }
            })} />}
            <div className="ca-items">
              {draft.images.map((it) => (
                <ImageItem key={it.key} it={it} sources={sources} engines={engines} busy={!!busy} cost={`${costOf(`${it.key}:-:image`)}${approvedItems.has(it.key) ? " · approved" : ""}`} onChange={(x) => update((p) => ({ ...p, images: p.images.map((i) => (i.key === x.key ? x : i)) }))} onRegen={() => void act("regen", () => regenerate(c.id, c.plan.rev, it.key))} onProduct={(product) => void retarget(it, product)} />
              ))}
              {draft.videos.map((v) => (
                <VideoItem key={v.key} v={v} sources={sources} engines={engines} busy={!!busy} costOf={costOf} onChange={(x) => update((p) => ({ ...p, videos: p.videos.map((i) => (i.key === x.key ? x : i)) }))} onRegen={(shot) => void act("regen", () => regenerate(c.id, c.plan.rev, v.key, shot))} onProduct={(product) => void retarget(v, product)} />
              ))}
            </div>
            {c.status !== "done" && <CostPanel c={c} retries={retries} setRetries={setRetries} accepted={accepted} setAccepted={setAccepted} />}
          </>
        )}
      </div>
      {c && draft && c.status !== "done" && (
        <footer className="ca-bottom">
          {dirty ? (
            <>
              <span className="ca-muted">Unsaved changes. Saving updates the costs; a change to an approved item's production pauses it until approved again.</span>
              <button type="button" className="cta secondary" onClick={() => { setDraft(c.plan); setDirty(false); }}>Undo changes</button>
              <button type="button" className="cta primary" disabled={!!busy} onClick={() => void act("save", () => savePlan(c.id, draft, c.plan.rev))}>
                {busy === "save" ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Save changes
              </button>
            </>
          ) : (
            <>
              <button type="button" className="text-button" disabled={!!busy} onClick={() => void act("prices", () => refreshPrices(c.id))}>
                <RefreshCw size={14} /> Refresh estimates
              </button>
              {c.status === "draft" && (
                <button type="button" className="text-button" onClick={() => { if (window.confirm("Discard this plan? Nothing was made from it.")) void discardCampaign(c.id).then(() => { setC(null); setDraft(null); }); }}>
                  Discard plan
                </button>
              )}
              {c.status === "producing" && (
                <button type="button" className="cta secondary" onClick={() => void act("pause", () => pauseCampaign(c.id))}><Pause size={16} /> Pause</button>
              )}
              {c.status === "paused" && (
                <button type="button" className="cta secondary" onClick={() => void act("resume", () => resumeCampaign(c.id))}><Play size={16} /> Resume</button>
              )}
              <span className="ca-grow" />
              {c.proposal.unaccepted.length > 0 && <span className="ca-warn-inline"><AlertTriangle size={14} /> {c.proposal.unaccepted.length} step(s) without a cost</span>}
              {c.status === "draft" && (
                <button type="button" className="cta secondary" disabled={!canApprove || !selected.length} onClick={() => void approve(selected)} title="Approve only the ticked items">
                  Approve selected ({selected.length})
                </button>
              )}
              {c.status === "draft" && (
                <button type="button" className="cta primary" disabled={!canApprove || selected.length !== [...draft.images, ...draft.videos].length} onClick={() => void approve(selected)} title={selected.length !== [...draft.images, ...draft.videos].length ? "Some items are unticked: approve the selected ones" : "Approve every item and start production"}>
                  {busy === "approve" ? <Loader2 size={16} className="spin" /> : <Play size={16} />} Approve plan &amp; start production
                </button>
              )}
              {c.status !== "draft" && (needs.length > 0 || !c.approval?.current) && (
                <button type="button" className="cta primary" disabled={!canApprove} onClick={() => void approve(selected)}>
                  Approve changes
                </button>
              )}
            </>
          )}
        </footer>
      )}
    </div>
  );
}
