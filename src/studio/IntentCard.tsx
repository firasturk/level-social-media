/**
 * The Prompt Box's card: what the box understood from a sentence, laid out so a person can check
 * it before anything runs. Target, the asset picked, the operation and its provider, the settings,
 * the credit estimate, and two buttons: Run and Change target. Search results sit under their card
 * with "Use as reference" and "Add to design", which make their own cards.
 */
import { useState } from "react";
import { Check, ImageOff, Play, SlidersHorizontal } from "lucide-react";
import { Orb } from "@/components/Orb";
import { askInput } from "@/lib/confirm";
import { COST_UNKNOWN, intentRunnable, type IntentAsset, type ToolIntent } from "@shared/promptbox";
import { DEFAULT_FRAME, frameLabel } from "@shared/video-frame";

export interface ResultAsset extends IntentAsset {
  type?: string;
  premium?: boolean;
}

export interface Card {
  id: string;
  at: number;
  intent: ToolIntent;
  /** The server's answer: the viewer may run provider tools (admins only for now). */
  canRun: boolean;
  /** An admin's own estimate when the catalog has none; sent with the run. */
  estimate?: number;
  results?: ResultAsset[];
  fixture?: boolean;
  running?: boolean;
  done?: string;
  error?: string;
}

const PROVIDER: Record<ToolIntent["provider"], string> = { freepik: "Freepik", higgsfield: "Higgsfield", none: "the studio" };

function settingLines(i: ToolIntent): [string, string][] {
  const s = i.settings;
  const str = (k: string) => (s[k] === undefined || s[k] === null || s[k] === "" ? "" : String(s[k]));
  if (i.tool === "freepik.search") return [["Query", str("q") || "(none)"], ["Type", str("type") || "photo"], ["Orientation", str("orientation") || "any"], ["Page", str("page") || "1"]];
  if (i.tool === "video.generate")
    return [
      ["Model", str("modelName") || str("model") || "(none)"],
      ["Engines", "the engine list follows the billing choice under Connection → Higgsfield (subscription credits or Cloud API)"],
      ["Duration", `${str("duration") || "5"} s`],
      ["Frame", `${frameLabel(str("frame")) || frameLabel(DEFAULT_FRAME)}${str("aspect") ? "" : " · an engine with no frame choice keeps the picture's frame; the Video studio makes the picture that frame first"}`],
      ["Source", str("source") === "artwork" ? "the design with its words" : "the picture"],
    ];
  if (i.tool === "freepik.use") return [["Role", str("role") === "reference" ? "reference for the next take" : "layer in the design"], ["Placement", str("placement") || "where the design puts it"]];
  return [["Operation", str("operation") || "enhance"]];
}

export default function IntentCard({
  card,
  posts,
  campaign,
  admin,
  selectedAsset,
  onChange,
  onRun,
  onUseAsset,
  onPickAsset,
}: {
  card: Card;
  posts: { index: number; title: string; group?: { kind: string; slide: number; of: number } | null }[];
  campaign: string;
  admin: boolean;
  selectedAsset: IntentAsset | null;
  onChange: (next: Card) => void;
  onRun: (card: Card) => void;
  onUseAsset: (card: Card, asset: ResultAsset, role: "reference" | "design") => void;
  onPickAsset: (asset: ResultAsset) => void;
}) {
  const [picking, setPicking] = useState(false);
  const i = card.intent;
  const estimate = card.estimate ?? i.estimate;
  const shown: ToolIntent = { ...i, estimate };
  const runnable = intentRunnable(shown);
  const canRun = admin && card.canRun && runnable.ok && !card.running && !card.done;
  const target = posts.find((p) => p.index === i.target.post);
  const targetLine = [campaign, i.target.post === null ? "no post yet" : `post ${i.target.post}${target ? ` · ${target.title}` : ""}`, i.target.slide ? `slide ${i.target.slide}` : target?.group ? `slide ${target.group.slide} of ${target.group.of}` : ""].filter(Boolean).join(" · ");
  const costLine = estimate === null ? `${COST_UNKNOWN} · blocked until clarified` : estimate === 0 ? `Free · ${i.estimateNote}` : `About ${estimate} credits${card.estimate !== undefined ? " · set by you" : ""}`;
  const runLabel = card.running ? "Running" : card.done ? "Done" : estimate === null ? "Run" : estimate === 0 ? "Run · free" : `Run · about ${estimate} credits`;
  function retarget(post: number) {
    onChange({ ...card, intent: { ...i, target: { ...i.target, post }, questions: i.questions.filter((q) => !/^(Which post|There is no post|Choose a post)/.test(q)) } });
    setPicking(false);
  }
  async function setCost() {
    const v = await askInput("Credits this run will use (the catalog has no price for it):", card.estimate !== undefined ? String(card.estimate) : "", { ok: "Set the cost", placeholder: "for example 12" });
    const n = Number(v);
    if (v === null || !Number.isFinite(n) || n < 0) return;
    onChange({ ...card, estimate: n });
  }
  return (
    <div className={`intent-card ${card.done ? "done" : ""} ${card.error ? "failed" : ""}`} dir="auto">
      <div className="intent-head">
        <strong>{i.operation}</strong>
        <span className="intent-provider">through {PROVIDER[i.provider]}</span>
      </div>
      <dl className="intent-rows">
        <dt>Target</dt>
        <dd>
          {targetLine}
          {picking ? (
            <select autoFocus value={i.target.post ?? ""} onChange={(e) => e.target.value && retarget(Number(e.target.value))} onBlur={() => setPicking(false)}>
              <option value="">Choose a post</option>
              {posts.map((p) => (
                <option key={p.index} value={p.index}>
                  {p.index} · {p.title}
                  {p.group ? ` (${p.group.kind} ${p.group.slide}/${p.group.of})` : ""}
                </option>
              ))}
            </select>
          ) : null}
        </dd>
        <dt>Selected asset</dt>
        <dd>
          {i.asset ? (
            <span className="intent-asset">
              <Thumb url={i.asset.url} alt={i.asset.title ?? i.asset.id} />
              <span>
                {i.asset.title ?? i.asset.id} <small>({i.asset.source} · {i.asset.id})</small>
              </span>
            </span>
          ) : (
            "none yet"
          )}
        </dd>
        <dt>Settings</dt>
        <dd>
          {settingLines(i).map(([k, v]) => (
            <span key={k} className="intent-setting">
              <small>{k}</small> {v}
            </span>
          ))}
        </dd>
        <dt>Credit estimate</dt>
        <dd className={estimate === null ? "intent-blocked" : ""}>
          {costLine}
          {estimate === null && admin && !card.done ? (
            <button type="button" className="text-button" onClick={() => void setCost()}>
              Set the cost
            </button>
          ) : null}
        </dd>
      </dl>
      {i.questions[0] ? <p className="intent-question">{i.questions[0]}</p> : null}
      {!admin || !card.canRun ? <p className="intent-note">Admins only for now: {PROVIDER[i.provider]} is restricted until wider access is approved.</p> : null}
      {card.error ? <p className="intent-error">{card.error}</p> : null}
      {card.done ? (
        <p className="intent-done">
          <Check size={13} /> {card.done}
          {card.fixture ? " (fixture)" : ""}
        </p>
      ) : null}
      <div className="intent-actions">
        <button type="button" className="primary" disabled={!canRun} title={!admin || !card.canRun ? "Admins only for now" : runnable.ok ? (i.needsConfirmation ? "Runs this card now; nothing ran from the sentence" : "Browsing is free; nothing is made") : runnable.why} onClick={() => onRun({ ...card, intent: shown })}>
          {card.running ? <Orb size={13} /> : <Play size={13} />} {runLabel}
        </button>
        {!card.done && i.tool !== "freepik.search" ? (
          <button type="button" className="text-button" onClick={() => setPicking((p) => !p)}>
            <SlidersHorizontal size={13} /> Change target
          </button>
        ) : null}
        {!card.done && i.tool === "freepik.search" && i.target.post === null ? (
          <button type="button" className="text-button" onClick={() => setPicking((p) => !p)}>
            <SlidersHorizontal size={13} /> Choose a post
          </button>
        ) : null}
      </div>
      {card.results ? (
        <div className="intent-results">
          {card.results.length === 0 ? <p className="intent-note">Nothing found. Try other words.</p> : null}
          {card.results.map((r) => {
            const picked = selectedAsset?.id === r.id;
            return (
              <div key={r.id} className={`intent-result ${picked ? "picked" : ""}`}>
                <button type="button" className="intent-result-pick" title={picked ? "Selected" : "Select this asset"} onClick={() => onPickAsset(r)}>
                  <Thumb url={r.url} alt={r.title ?? r.id} />
                </button>
                <span className="intent-result-title" title={r.title}>
                  {r.title ?? r.id}
                  {r.premium ? <small> · premium</small> : null}
                </span>
                <span className="intent-result-actions">
                  <button type="button" className="text-button" disabled={!admin} onClick={() => onUseAsset(card, r, "reference")}>
                    Use as reference
                  </button>
                  <button type="button" className="text-button" disabled={!admin} onClick={() => onUseAsset(card, r, "design")}>
                    Add to design
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Thumb({ url, alt }: { url?: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken)
    return (
      <span className="intent-thumb empty" aria-label={alt}>
        <ImageOff size={14} />
      </span>
    );
  return <img className="intent-thumb" src={url} alt={alt} loading="lazy" onError={() => setBroken(true)} />;
}
