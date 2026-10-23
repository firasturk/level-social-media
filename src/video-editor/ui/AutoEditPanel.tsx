/**
 * Auto edit (docs/video-editor.md → Edit quality): a purpose, a length and a pace give an editable
 * first cut with a structure (hook, build, payoff, end card) from what the footage looks like
 * (sharpness, exposure, steadiness, movement, its own cuts) and the music's beat and bars
 * (shared/edit-plan.ts), with placeholder words to replace. The panel then says in plain lines
 * what it did. Locked clips stay where they are and speech is never cut inside. Below it, "Edit like
 * this video" (ReferencePanel). Heuristics, not AI; undo brings the previous timeline back.
 */
import { useState } from "react";
import { Wand2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import { MAX_TIMELINE_SECONDS } from "@shared/video-project";
import { PACES, PURPOSES, type Pace, type Purpose } from "@shared/video-autoedit";
import type { TemplateLanguage } from "@shared/video-templates";
import type { PanelCtx } from "./Panels";
import ReferencePanel from "./ReferencePanel";
import "./reference.css";

export function AutoEditPanel({ ctx }: { ctx: PanelCtx }) {
  const [target, setTarget] = useState(15);
  const [purpose, setPurpose] = useState<Purpose>("promo");
  const [pace, setPace] = useState<Pace>("balanced");
  const [text, setText] = useState(true);
  const [language, setLanguage] = useState<TemplateLanguage>("both");
  const [ramps, setRamps] = useState(false);
  const [frame, setFrame] = useState<"reel" | "keep">("reel");
  const isReel = ctx.project.output.width * 16 === ctx.project.output.height * 9;
  const locked = ctx.project.clips.filter((c) => c.locked).length;
  const speech = ctx.project.clips.filter((c) => c.speech).length;
  const edit = ctx.project.edit ?? null;
  return (
    <div className="ve-panel">
      <span className="ts-group-title">A first cut</span>
      <p className="ts-hint">Builds an editable timeline from the footage under Media: the strongest shot first, then shots that build, a payoff and an end card held for the logo and call to action. It reads every clip for sharpness, light, steadiness and movement, leaves out dark, blank, blurry and shaky moments and never crosses a cut inside a clip, cuts where the picture is still, and on the beat and bar when music is set. Rules, not a judgement of the content; change anything afterwards.</p>
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
        <label className="ts-slider">
          <span>
            Length <em>{target}s</em>
          </span>
          <input type="range" min={3} max={MAX_TIMELINE_SECONDS} step={1} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
        <div className="ve-choice" role="group" aria-label="Pace">
          {PACES.map((p) => (
            <button key={p.id} type="button" className={`ts-mini ${pace === p.id ? "primary" : ""}`} aria-pressed={pace === p.id} onClick={() => setPace(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <label className="ve-check">
          <input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} /> Placeholder words over the hook and on the end card
        </label>
        {text && (
          <div className="vl-seg" role="group" aria-label="Text language">
            {(["both", "en", "ar"] as const).map((l) => (
              <button key={l} type="button" className={language === l ? "on" : ""} aria-pressed={language === l} onClick={() => setLanguage(l)}>
                {l === "both" ? "Arabic + English" : l === "en" ? "English" : "Arabic"}
              </button>
            ))}
          </div>
        )}
        <label className="ve-check">
          <input type="checkbox" checked={ramps} onChange={(e) => setRamps(e.target.checked)} /> Speed up calm shots a little (1.25×)
        </label>
        {!isReel && (
          <div className="vl-seg" role="group" aria-label="Frame">
            <button type="button" className={frame === "reel" ? "on" : ""} aria-pressed={frame === "reel"} onClick={() => setFrame("reel")}>
              9:16 Reel
            </button>
            <button type="button" className={frame === "keep" ? "on" : ""} aria-pressed={frame === "keep"} onClick={() => setFrame("keep")}>
              Keep {ctx.project.output.width}×{ctx.project.output.height}
            </button>
          </div>
        )}
        <button type="button" className="ts-btn primary" disabled={!ctx.sources.length} onClick={() => void ctx.auto.run({ purpose, pace, target, text, language, ramps, frame: isReel ? "keep" : frame })}>
          {ctx.auto.busy ? <Orb size={14} status={null} /> : <Wand2 size={14} />} {ctx.auto.busy || "Build the cut"}
        </button>
      </fieldset>
      {ctx.project.clips.length > 0 && <p className="ts-hint">Building replaces the current timeline{locked ? `, except ${locked} locked clip${locked === 1 ? "" : "s"}, which stay${locked === 1 ? "s" : ""} exactly where ${locked === 1 ? "it is" : "they are"}` : ""} (undo brings it back). Words you already wrote are kept.</p>}
      {speech > 0 && <p className="ts-hint">Speech: the seconds of the {speech} clip{speech === 1 ? "" : "s"} marked “Has speech” come back whole, never cut inside.</p>}
      {!ctx.music.name && <p className="ts-hint">Set music first (optional) to cut on its beat and bars.</p>}
      {edit && edit.summary.length > 0 && (
        <>
          <span className="ts-group-title">What the auto edit did</span>
          <ul className="ve-summary" data-testid="auto-summary">
            {edit.summary.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      )}
      {ctx.auto.notes.length > 0 && (
        <ul className="ve-notes">
          {ctx.auto.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <ReferencePanel ctx={ctx} />
    </div>
  );
}
