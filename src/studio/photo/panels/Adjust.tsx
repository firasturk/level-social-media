/**
 * Adjust: free, in the browser, no provider. Crop with aspect presets and handles on the canvas,
 * a quarter turn, flips, straighten, the light and colour sliders, sharpen, vignette; hold to see
 * the picture before; Reset; Apply draws the picture at full resolution and makes it the post's
 * picture (the current one stays under Versions).
 */
import { Check, Crop, Eye, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw } from "lucide-react";
import { Orb } from "@/components/Orb";
import { COLOR_SLIDERS, cropForAspect, describeAdjust, isDefaultAdjust, outputSize, rotatedSize, type AdjustParams, type Aspect } from "@shared/photo-adjust";
import type { StudioCtx } from "../types";

const ASPECTS: { id: Aspect; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "1:1", label: "1:1" },
  { id: "4:5", label: "4:5" },
  { id: "9:16", label: "9:16" },
];

export default function AdjustPanel({ ctx }: { ctx: StudioCtx }) {
  const { params, setParams, natural, inFlight } = ctx;
  const patch = (p: Partial<AdjustParams>, coalesce?: string) => setParams({ ...params, ...p }, coalesce);
  const rotated = natural ? rotatedSize(natural.w, natural.h, params.rotate) : null;
  const out = natural ? outputSize(params, natural.w, natural.h) : null;
  const changes = describeAdjust(params);
  const dirty = !isDefaultAdjust(params);

  const setAspect = (aspect: Aspect) => {
    if (!rotated) return;
    // A new aspect re-centres the frame at the largest size; "Free" keeps the frame as it is.
    patch({ aspect, crop: aspect === "free" ? (params.crop ?? { x: 0, y: 0, w: 1, h: 1 }) : cropForAspect(aspect, rotated.w, rotated.h) });
  };
  const toggleCrop = () => {
    if (params.crop) patch({ crop: null, aspect: "free" });
    else if (rotated) patch({ crop: params.aspect === "free" ? { x: 0, y: 0, w: 1, h: 1 } : cropForAspect(params.aspect, rotated.w, rotated.h) });
  };
  const rotate = (dir: 1 | -1) => {
    const next = (((params.rotate + dir * 90) % 360) + 360) % 360;
    // The crop was drawn on the old frame: a turned picture starts the frame again at its aspect.
    const r = natural ? rotatedSize(natural.w, natural.h, next as AdjustParams["rotate"]) : null;
    patch({ rotate: next as AdjustParams["rotate"], crop: params.crop && r ? cropForAspect(params.aspect, r.w, r.h) : params.crop });
  };

  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>Adjust</span>
        <small className="ps-free">Free · drawn here</small>
      </div>

      <span className="ts-group-title">Crop and turn</span>
      <div className="ps-row">
        <button type="button" className={`ts-mini ${params.crop ? "primary" : ""}`} onClick={toggleCrop} disabled={!natural} title="Show the crop frame on the picture; drag its corners and edges, or move it">
          <Crop size={13} /> {params.crop ? "Cropping" : "Crop"}
        </button>
        <span className="ps-seg small" role="radiogroup" aria-label="Aspect">
          {ASPECTS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={params.aspect === a.id} className={params.aspect === a.id ? "on" : ""} onClick={() => setAspect(a.id)} disabled={!natural}>
              {a.label}
            </button>
          ))}
        </span>
      </div>
      <div className="ps-row">
        <button type="button" className="ts-icon" onClick={() => rotate(-1)} title="Turn left 90°" aria-label="Turn left 90 degrees">
          <RotateCcw size={15} />
        </button>
        <button type="button" className="ts-icon" onClick={() => rotate(1)} title="Turn right 90°" aria-label="Turn right 90 degrees">
          <RotateCw size={15} />
        </button>
        <button type="button" className={`ts-icon ${params.flipH ? "on" : ""}`} onClick={() => patch({ flipH: !params.flipH })} title="Flip left to right" aria-label="Flip horizontally" aria-pressed={params.flipH}>
          <FlipHorizontal2 size={15} />
        </button>
        <button type="button" className={`ts-icon ${params.flipV ? "on" : ""}`} onClick={() => patch({ flipV: !params.flipV })} title="Flip top to bottom" aria-label="Flip vertically" aria-pressed={params.flipV}>
          <FlipVertical2 size={15} />
        </button>
        {out && (
          <small className="ps-size">
            {out.w} × {out.h} px
          </small>
        )}
      </div>
      <Slider label="Straighten" unit="°" min={-10} max={10} step={0.5} value={params.straighten} onChange={(v) => patch({ straighten: v }, "straighten")} onReset={() => patch({ straighten: 0 })} />

      <span className="ts-group-title">Light and colour</span>
      {COLOR_SLIDERS.map((s) => (
        <Slider key={s.key} label={s.label} min={s.min} max={s.max} step={1} value={params[s.key] as number} onChange={(v) => patch({ [s.key]: v } as Partial<AdjustParams>, s.key)} onReset={() => patch({ [s.key]: 0 } as Partial<AdjustParams>)} />
      ))}

      <div className="ps-row ps-adjust-actions">
        <button
          type="button"
          className={`ts-mini ${ctx.holdBefore ? "primary" : ""}`}
          onPointerDown={() => ctx.setHoldBefore(true)}
          onPointerUp={() => ctx.setHoldBefore(false)}
          onPointerLeave={() => ctx.setHoldBefore(false)}
          onKeyDown={(e) => e.key === " " && ctx.setHoldBefore(true)}
          onKeyUp={() => ctx.setHoldBefore(false)}
          title="Hold to see the picture before the adjustments (or hold C)"
        >
          <Eye size={13} /> Hold for before
        </button>
        <button type="button" className="ts-mini" onClick={ctx.resetParams} disabled={!dirty} title="Every slider back to zero, the crop off">
          Reset
        </button>
      </div>

      <div className="ps-apply">
        <button type="button" className="ts-btn primary ps-cta" disabled={!dirty || ctx.applying || inFlight || !natural} onClick={() => void ctx.applyAdjust()} title="Draws the picture at full resolution and makes it the post's picture; the current one stays under Versions. Free.">
          {ctx.applying ? <Orb size={15} /> : <Check size={15} />} Apply as the post's picture
        </button>
        <p className="ts-hint">
          {dirty ? `Changes: ${changes.join(", ")}.` : "Move a slider or set a crop; nothing is changed until you apply."} The words and the logo are redrawn over the new picture. The picture it replaces stays under Versions.
        </p>
        {out && Math.max(out.w, out.h) > 4096 && <p className="ts-hint warn">The picture is drawn at most 4096 px on its long side.</p>}
      </div>
    </div>
  );
}

function Slider({ label, unit = "", min, max, step, value, onChange, onReset }: { label: string; unit?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; onReset: () => void }) {
  const shown = `${value > 0 && min < 0 ? "+" : ""}${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`;
  return (
    <label className="ts-slider ps-slider" onDoubleClick={onReset} title="Double-click to reset">
      <span>
        {label} <em className={value ? "set" : ""}>{shown}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    </label>
  );
}
