/**
 * "Animate": simple keyframes for a text layer, a logo layer or a clip's framing (phase 2). Each
 * property (position, scale, opacity; pan and zoom for a clip) gets a diamond button that sets or
 * removes a keyframe at the playhead with the value shown; once a property has a keyframe its
 * slider sets the keyframe at the playhead (moving the playhead and the slider adds the next one).
 * Two keyframes or more make it move; the easing of the keyframe at the playhead says how it
 * travels to the next one (linear, ease in, ease out, ease in and out). The diamonds also show on
 * the timeline's lane. Every change is one undo step.
 */
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import { EASINGS, keyAt, keyTimes, removeKey, setKey, tidyKeyframes, valueAt, type Easing, type KeyProp, type Keyframes } from "@shared/video-keyframes";

export interface AnimProp {
  prop: KeyProp;
  label: string;
  /** The value without keyframes. */
  base: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

interface Props {
  kf: Keyframes | undefined;
  /** The playhead, in seconds from the layer's (or clip's) start. */
  local: number;
  /** The layer's (or clip's) length: keyframes are set inside it. */
  length: number;
  props: AnimProp[];
  readOnly?: boolean;
  mark: () => void;
  /** A new keyframe set; "patch" while a slider moves, "commit" for one step. */
  onChange: (kf: Keyframes | undefined, step: "patch" | "commit") => void;
  /** Moves the playhead to a local time. */
  onSeek: (local: number) => void;
}

export function isAnimated(kf: Keyframes | undefined, prop: KeyProp): boolean {
  return !!kf?.[prop]?.length;
}

export default function KeyframeControls({ kf, local, length, props, readOnly, mark, onChange, onSeek }: Props) {
  const inside = local >= -1e-6 && local <= length + 1e-6;
  const at = Math.min(Math.max(0, local), length);
  const times = keyTimes(kf);
  const prev = [...times].reverse().find((t) => t < at - 1e-3);
  const next = times.find((t) => t > at + 1e-3);
  const set = (prop: KeyProp, v: number, step: "patch" | "commit") => onChange(tidyKeyframes({ ...kf, [prop]: setKey(kf?.[prop], at, v) }), step);
  const toggle = (p: AnimProp) => {
    const list = kf?.[p.prop];
    if (keyAt(list, at)) onChange(tidyKeyframes({ ...kf, [p.prop]: removeKey(list, at) }), "commit");
    else set(p.prop, valueAt(list, at, p.base), "commit");
  };
  const easeHere = props.map((p) => keyAt(kf?.[p.prop], at)).find((k) => !!k)?.ease;
  const setEase = (e: Easing) => {
    const out: Keyframes = { ...kf };
    for (const p of props) {
      const list = kf?.[p.prop];
      if (keyAt(list, at)) out[p.prop] = setKey(list, at, keyAt(list, at)!.v, e);
    }
    onChange(tidyKeyframes(out), "commit");
  };
  return (
    <div className="ve-anim">
      <div className="ve-panel-head">
        <span className="ts-group-title">Animate</span>
        <span className="ve-anim-nav">
          <button type="button" className="ts-mini" disabled={prev === undefined} onClick={() => prev !== undefined && onSeek(prev)} title="The keyframe before" aria-label="Previous keyframe">
            <ChevronLeft size={12} />
          </button>
          <span>{times.length} keyframe{times.length === 1 ? "" : "s"}</span>
          <button type="button" className="ts-mini" disabled={next === undefined} onClick={() => next !== undefined && onSeek(next)} title="The keyframe after" aria-label="Next keyframe">
            <ChevronRight size={12} />
          </button>
        </span>
      </div>
      {!inside && <p className="ts-hint">Move the playhead over this {props.some((p) => p.prop === "zoom") ? "clip" : "layer"} to set keyframes.</p>}
      <fieldset className="ve-fields" disabled={readOnly || !inside}>
        {props.map((p) => {
          const list = kf?.[p.prop];
          const animated = !!list?.length;
          const here = keyAt(list, at);
          const v = valueAt(list, at, p.base);
          return (
            <div key={p.prop} className="ve-anim-row">
              <button type="button" className={`ve-key ${here ? "on" : animated ? "some" : ""}`} onClick={() => toggle(p)} title={here ? `Remove the ${p.label.toLowerCase()} keyframe here` : `Set a ${p.label.toLowerCase()} keyframe here`} aria-label={here ? `Remove ${p.label} keyframe` : `Add ${p.label} keyframe`} aria-pressed={!!here}>
                <Diamond size={12} />
              </button>
              <label className="ts-slider">
                <span>
                  {p.label} <em>{p.format(v)}</em>
                </span>
                <input type="range" min={p.min} max={p.max} step={p.step} value={v} disabled={!animated} onPointerDown={mark} onChange={(e) => set(p.prop, Number(e.target.value), "patch")} onPointerUp={() => onChange(kf, "commit")} onKeyUp={() => onChange(kf, "commit")} />
              </label>
            </div>
          );
        })}
        {easeHere && (
          <label className="ve-row">
            <span>From this keyframe</span>
            <select value={easeHere} onChange={(e) => setEase(e.target.value as Easing)}>
              {EASINGS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      <p className="ts-hint">A diamond sets a keyframe at the playhead; move the playhead, change the value, and it moves between them. Two keyframes or more make it move.</p>
    </div>
  );
}
