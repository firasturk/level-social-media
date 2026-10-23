/**
 * Auto edit (phase 2): a purpose (product launch, promo, story), a target length, a pace (calm,
 * balanced, energetic) and, when music is set, its beats give an editable first cut
 * (shared/video-autoedit.ts). Locked clips stay where they are and speech is never cut inside.
 * Heuristics from how much the picture moves, said plainly; undo brings the previous timeline back.
 */
import { useState } from "react";
import { Wand2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import { MAX_TIMELINE_SECONDS } from "@shared/video-project";
import { PACES, PURPOSES, type Pace, type Purpose } from "@shared/video-autoedit";
import type { PanelCtx } from "./Panels";

export function AutoEditPanel({ ctx }: { ctx: PanelCtx }) {
  const [target, setTarget] = useState(15);
  const [purpose, setPurpose] = useState<Purpose>("promo");
  const [pace, setPace] = useState<Pace>("balanced");
  const locked = ctx.project.clips.filter((c) => c.locked).length;
  const speech = ctx.project.clips.filter((c) => c.speech).length;
  return (
    <div className="ve-panel">
      <span className="ts-group-title">A first cut</span>
      <p className="ts-hint">Builds an editable timeline from the footage under Media: each shot is the liveliest stretch of its clip (how much the picture moves), ordered and joined for the purpose and pace, cut on the beat when music is set. Simple rules, not a judgement of the content; change anything afterwards.</p>
      <fieldset className="ve-fields" disabled={ctx.readOnly || !!ctx.auto.busy}>
        <label className="ve-row">
          <span>Purpose</span>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
            {PURPOSES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="ts-hint">{PURPOSES.find((p) => p.id === purpose)?.hint}</p>
        <label className="ts-slider">
          <span>
            Length <em>{target}s</em>
          </span>
          <input type="range" min={3} max={MAX_TIMELINE_SECONDS} step={1} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
        <div className="ve-choice" role="group" aria-label="Pace">
          {PACES.map((p) => (
            <button key={p.id} type="button" className={`ts-mini ${pace === p.id ? "primary" : ""}`} aria-pressed={pace === p.id} onClick={() => setPace(p.id)} title={`Shots of ${p.shots[0]}–${p.shots[1]} s`}>
              {p.name}
            </button>
          ))}
        </div>
        <button type="button" className="ts-btn primary" disabled={!ctx.sources.length} onClick={() => void ctx.auto.run({ purpose, pace, target })}>
          {ctx.auto.busy ? <Orb size={14} status={null} /> : <Wand2 size={14} />} {ctx.auto.busy || "Build the cut"}
        </button>
      </fieldset>
      {ctx.project.clips.length > 0 && <p className="ts-hint">Building replaces the current timeline{locked ? `, except ${locked} locked clip${locked === 1 ? "" : "s"}, which stay${locked === 1 ? "s" : ""} exactly where ${locked === 1 ? "it is" : "they are"}` : ""} (undo brings it back).</p>}
      {speech > 0 && <p className="ts-hint">Speech: the seconds of the {speech} clip{speech === 1 ? "" : "s"} marked “Has speech” come back whole, never cut inside.</p>}
      {ctx.music.name ? <p className="ts-hint">Music is set: shot lengths are whole beats, so cuts land on the grid. “Align cuts to beats” (Music) tidies cuts after you edit.</p> : <p className="ts-hint">Set music first (optional) if you want the cuts on the beat.</p>}
      {ctx.auto.notes.length > 0 && (
        <ul className="ve-notes">
          {ctx.auto.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
