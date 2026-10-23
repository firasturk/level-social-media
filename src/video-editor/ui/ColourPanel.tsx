/**
 * The Colour panel (phase 3, docs/video-editor.md): where the colour applies (this clip, chosen
 * clips, the whole video), the five presets with thumbnails drawn from the current frame through
 * the real grader, the preset's intensity, before/after (hold, or a split view on the stage),
 * "Protect skin tones", the correction sliders, the colour match to a reference picture
 * (MatchColour.tsx) and a .cube LUT, now kept with the draft. Every change is one undo step; the
 * render draws exactly what the preview shows (one shader for both).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Eye, EyeOff, Trash2, Upload } from "lucide-react";
import { clipFraming, COLOUR_KEYS, DEFAULT_COLOUR, LOOKS, lookOf, placeClips, PRESET_IDS, type Clip, type ColourParams, type VideoProject } from "@shared/video-project";
import { applyLook, clearClipLooks, clipLook, resolveGrade, setLookAmount, type Scope } from "@shared/video-looks";
import { sourceKey } from "../engine/media";
import { snapshot, ThumbRenderer } from "../engine/looks";
import type { PanelCtx } from "./Panels";
import MatchColour from "./MatchColour";
import "./video-looks.css";

type ScopeKind = "clip" | "chosen" | "all";

const SLIDERS: { key: keyof ColourParams; label: string; min: number; max: number }[] = [
  { key: "exposure", label: "Exposure", min: -2, max: 2 },
  { key: "contrast", label: "Contrast", min: -1, max: 1 },
  { key: "saturation", label: "Saturation", min: -1, max: 1 },
  { key: "vibrance", label: "Vibrance", min: -1, max: 1 },
  { key: "temperature", label: "Temperature", min: -1, max: 1 },
  { key: "tint", label: "Tint", min: -1, max: 1 },
  { key: "highlights", label: "Highlights", min: -1, max: 1 },
  { key: "shadows", label: "Shadows", min: -1, max: 1 },
  { key: "whites", label: "Whites", min: -1, max: 1 },
  { key: "blacks", label: "Blacks", min: -1, max: 1 },
];

const THUMB_IDS = ["none", ...PRESET_IDS] as const;

/** The clip under the playhead (the last one past the end). */
export function clipAtTime(p: Pick<VideoProject, "clips">, t: number): Clip | null {
  const placed = placeClips(p.clips);
  return placed.find((pl) => t >= pl.start && t < pl.end)?.clip ?? placed.at(-1)?.clip ?? null;
}

export function ColourPanel({ ctx }: { ctx: PanelCtx }) {
  const p = ctx.project;
  const lutRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<ScopeKind>(ctx.selected ? "clip" : "all");
  const [chosen, setChosen] = useState<string[]>(() => (ctx.selected ? [ctx.selected.id] : []));
  const playhead = useMemo(() => clipAtTime(p, ctx.time), [p, ctx.time]);
  const thisClip = ctx.selected ?? playhead;
  const targets: Clip[] = scope === "all" ? [] : scope === "clip" ? (thisClip ? [thisClip] : []) : p.clips.filter((c) => chosen.includes(c.id));
  const first = targets[0] ?? null;
  const scopeArg: Scope = scope === "all" ? { kind: "all" } : { kind: "clips", ids: targets.map((c) => c.id) };
  const current = scope === "all" ? { id: p.look, amount: p.lookAmount ?? 1 } : first ? clipLook(p, first) : { id: p.look, amount: p.lookAmount ?? 1 };
  const own = targets.filter((c) => c.look);
  const noTarget = scope !== "all" && !targets.length;
  const look = lookOf(current.id);

  const choose = (id: string) => ctx.commit((q) => applyLook(q, scopeArg, id, current.id === "none" || look.legacy ? 1 : current.amount));
  const params: ColourParams = scope === "all" ? p.colour : (first?.colour ?? DEFAULT_COLOUR);
  const ids = new Set(targets.map((c) => c.id));
  const update = (key: keyof ColourParams, value: number, step: "patch" | "commit") =>
    (step === "commit" ? ctx.commit : ctx.patch)((q) => (scope === "all" ? { ...q, colour: { ...q.colour, [key]: value } } : { ...q, clips: q.clips.map((x) => (ids.has(x.id) ? { ...x, colour: { ...DEFAULT_COLOUR, ...(x.colour ?? {}), [key]: value } } : x)) }));
  const reset = () => ctx.commit((q) => (scope === "all" ? { ...q, colour: { ...DEFAULT_COLOUR }, look: "none", lookAmount: 1 } : { ...q, clips: q.clips.map((x) => (ids.has(x.id) ? withoutColour(x) : x)) }));
  const changed = COLOUR_KEYS.some((k) => params[k] !== 0) || (scope === "all" ? p.look !== "none" : own.length > 0);
  const scopeLabel = scope === "all" ? "the whole video" : scope === "clip" ? (thisClip ? `“${ctx.labelOf(thisClip)}”` : "no clip") : `${targets.length} chosen clip${targets.length === 1 ? "" : "s"}`;

  return (
    <div className="ve-panel">
      <div className="ve-panel-head">
        <span className="ts-group-title">Colour</span>
        <span className="ve-actions">
          <button type="button" className={`ts-mini ${ctx.colour.bypass ? "primary" : ""}`} onPointerDown={() => ctx.colour.setBypass(true)} onPointerUp={() => ctx.colour.setBypass(false)} onPointerLeave={() => ctx.colour.setBypass(false)} title="Hold to see the footage without any colour change">
            {ctx.colour.bypass ? <EyeOff size={12} /> : <Eye size={12} />} Before
          </button>
          <button type="button" className={`ts-mini ${ctx.looks.split ? "primary" : ""}`} aria-pressed={ctx.looks.split} onClick={() => ctx.looks.setSplit(!ctx.looks.split)} title="Split the stage: before colour on the left, after on the right (the preview only)">
            <Columns2 size={12} /> Split
          </button>
        </span>
      </div>
      <div className="vl-seg" role="group" aria-label="Apply to">
        <button type="button" className={scope === "clip" ? "on" : ""} aria-pressed={scope === "clip"} onClick={() => setScope("clip")} disabled={!p.clips.length} title="The selected clip, or the one under the playhead">
          This clip
        </button>
        <button
          type="button"
          className={scope === "chosen" ? "on" : ""}
          aria-pressed={scope === "chosen"}
          onClick={() => {
            if (!chosen.length && thisClip) setChosen([thisClip.id]);
            setScope("chosen");
          }}
          disabled={p.clips.length < 2}
          title="Tick the clips the colour goes to"
        >
          Chosen clips
        </button>
        <button type="button" className={scope === "all" ? "on" : ""} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
          Whole video
        </button>
      </div>
      {scope === "chosen" && (
        <div className="vl-clips" role="group" aria-label="Chosen clips">
          {p.clips.map((c, i) => (
            <label key={c.id}>
              <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen((list) => (e.target.checked ? [...list, c.id] : list.filter((x) => x !== c.id)))} />
              <span>
                {i + 1}. {ctx.labelOf(c)}
              </span>
              <small>{c.look ? lookOf(c.look.id).name : ""}</small>
            </label>
          ))}
        </div>
      )}
      <p className="ts-hint">
        Applies to {scopeLabel}.{scope !== "all" && own.length ? " It has its own preset; the rest of the video keeps the video's." : ""}
      </p>
      <fieldset className="ve-fields" disabled={ctx.readOnly || noTarget}>
        <span className="ts-group-title">Presets</span>
        <PresetThumbs ctx={ctx} clip={first ?? playhead} current={current.id} onPick={choose} />
        {(look.legacy || current.id === "mono") && (
          <p className="ts-hint">
            In use: {look.name}.{look.replacedBy ? ` Its new version is ${lookOf(look.replacedBy).name}.` : ""}
          </p>
        )}
        <div className="ve-actions">
          {LOOKS.filter((l) => l.id === "mono").map((l) => (
            <button key={l.id} type="button" className={`ts-mini ${current.id === l.id ? "primary" : ""}`} onClick={() => choose(l.id)} title={l.hint}>
              {l.name}
            </button>
          ))}
          {scope !== "all" && own.length > 0 && (
            <button type="button" className="ts-mini" onClick={() => ctx.commit((q) => clearClipLooks(q, own.map((c) => c.id)))} title="This clip follows the whole video's preset again">
              Use the video's preset
            </button>
          )}
        </div>
        <label className="ts-slider">
          <span>
            Intensity <em>{current.id === "none" ? "–" : `${Math.round(current.amount * 100)}%`}</em>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={current.amount}
            disabled={current.id === "none"}
            aria-label="Preset intensity"
            onPointerDown={ctx.mark}
            onChange={(e) => ctx.patch((q) => setLookAmount(q, scopeArg, Number(e.target.value)))}
            onPointerUp={() => ctx.commit((q) => q)}
            onKeyUp={() => ctx.commit((q) => q)}
          />
        </label>
        <label className="ve-check" title="A hue-range rule, not face detection: warm, moderately saturated tones keep their hue and most of their saturation">
          <input type="checkbox" checked={p.protectSkin} onChange={(e) => ctx.commit((q) => ({ ...q, protectSkin: e.target.checked }))} /> Protect skin tones
        </label>
        {p.protectSkin && <p className="ts-hint">On warm, moderately saturated tones (where skin falls) the grade keeps its brightness, the original hue and most of the original saturation. It is a hue range, not face detection: wood, sand or a beige product are protected too; skin under coloured light is not.</p>}

        <span className="ts-group-title">Corrections</span>
        {SLIDERS.map((s) => (
          <label key={s.key} className="ts-slider">
            <span>
              {s.label}{" "}
              <em>
                {params[s.key] > 0 ? "+" : ""}
                {params[s.key].toFixed(2)}
              </em>
            </span>
            <input type="range" min={s.min} max={s.max} step={0.01} value={params[s.key]} onPointerDown={ctx.mark} onChange={(e) => update(s.key, Number(e.target.value), "patch")} onPointerUp={() => ctx.commit((q) => q)} onDoubleClick={() => update(s.key, 0, "commit")} />
          </label>
        ))}
        {changed && (
          <button type="button" className="ts-link" onClick={reset}>
            Reset {scope === "all" ? "the video's colour" : "the colour of " + scopeLabel}
          </button>
        )}
      </fieldset>

      <MatchColour ctx={ctx} targets={scope === "all" ? p.clips : targets} scopeLabel={scopeLabel} />

      <fieldset className="ve-fields" disabled={ctx.readOnly}>
        <span className="ts-group-title">LUT</span>
        <input ref={lutRef} type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void ctx.colour.pickLut(f); e.target.value = ""; }} />
        {p.lut ? (
          <>
            <p className="ve-clip-name">
              {p.lut.name} · {p.lut.size}³{p.lut.data ? " · kept with the draft" : ""}
            </p>
            {!p.lut.data && !ctx.colour.lutName && <p className="ts-hint warn">This draft was saved before LUTs were kept with it: load the .cube file again to see it and to render with it (it is then kept).</p>}
            <label className="ts-slider">
              <span>
                Strength <em>{Math.round(p.lut.strength * 100)}%</em>
              </span>
              <input type="range" min={0} max={1} step={0.05} value={p.lut.strength} onPointerDown={ctx.mark} onChange={(e) => ctx.patch((q) => (q.lut ? { ...q, lut: { ...q.lut, strength: Number(e.target.value) } } : q))} onPointerUp={() => ctx.commit((q) => q)} />
            </label>
            <div className="ve-actions">
              <button type="button" className="ts-mini" onClick={() => lutRef.current?.click()}>
                Change LUT
              </button>
              <button type="button" className="ts-mini danger" onClick={ctx.colour.clearLut}>
                <Trash2 size={12} /> Remove
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="ts-hint">A .cube file (a 3D table from DaVinci Resolve, Premiere or a LUT pack), applied after the sliders to the whole video and kept with the draft (tables above 33³ are resampled to 33³).</p>
            <button type="button" className="ts-btn" onClick={() => lutRef.current?.click()}>
              <Upload size={14} /> Load a .cube LUT
            </button>
          </>
        )}
      </fieldset>
    </div>
  );
}

function withoutColour(c: Clip): Clip {
  const out = { ...c };
  delete out.colour;
  delete out.look;
  return out;
}

/**
 * The presets drawn on the current frame of the clip (its framing, sliders and match included) by
 * the real shader; redrawn when that clip, its colour or the frame shape changes, not on every
 * playhead move.
 */
function PresetThumbs({ ctx, clip, current, onPick }: { ctx: PanelCtx; clip: Clip | null; current: string; onPick: (id: string) => void }) {
  const p = ctx.project;
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const renderer = useRef<ThumbRenderer | null>(null);
  useEffect(() => {
    renderer.current = new ThumbRenderer();
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);
  const media = clip ? (ctx.sources.find((m) => m.key === sourceKey(clip.source)) ?? null) : null;
  // What the thumbnails depend on (the playhead moving inside the same clip does not redraw them).
  const base = useMemo(() => ({ look: "none", lookAmount: 1, colour: p.colour, protectSkin: p.protectSkin }), [p.colour, p.protectSkin]);
  const framing = clip ? clipFraming(p, clip) : null;
  const key = clip ? JSON.stringify([clip.id, clip.source, clip.in, clip.colour ?? null, clip.match ?? null, framing, p.output.width, p.output.height, p.background]) : "";
  useEffect(() => {
    if (!clip || !media || !framing) {
      setThumbs({});
      return;
    }
    const v = media.video;
    let cancelled = false;
    const draw = () => {
      if (cancelled || !renderer.current) return;
      if (v.readyState < 2 || v.seeking) return;
      try {
        const snap = snapshot(v, media.width, media.height, 200);
        const grades = THUMB_IDS.map((id) => resolveGrade(base, { colour: clip.colour, match: clip.match, look: { id, amount: 1 } }));
        const urls = renderer.current.render(snap, { width: p.output.width, height: p.output.height }, framing, grades, p.background);
        setThumbs(Object.fromEntries(THUMB_IDS.map((id, i) => [id, urls[i]])));
      } catch (e) {
        console.warn("[colour] thumbnails", (e as Error).message);
      }
    };
    const timer = setTimeout(draw, 150);
    v.addEventListener("loadeddata", draw);
    v.addEventListener("seeked", draw);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      v.removeEventListener("loadeddata", draw);
      v.removeEventListener("seeked", draw);
    };
    // `key` stands for the clip, its colour, match and framing, and the frame's shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, media, base]);
  return (
    <div className="vl-presets" role="group" aria-label="Presets">
      {THUMB_IDS.map((id) => {
        const l = lookOf(id);
        return (
          <button key={id} type="button" className={`vl-preset ${current === id ? "on" : ""}`} aria-pressed={current === id} onClick={() => onPick(id)} title={l.hint} data-preset={id}>
            {thumbs[id] ? <img className="vl-thumb" src={thumbs[id]} alt="" style={{ aspectRatio: `${p.output.width} / ${p.output.height}` }} /> : <i className="vl-thumb empty" style={{ aspectRatio: `${p.output.width} / ${p.output.height}` }}>{clip ? "…" : "No clip"}</i>}
            <span>{l.name}</span>
          </button>
        );
      })}
    </div>
  );
}
