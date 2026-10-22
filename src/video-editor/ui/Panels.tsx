/**
 * The editor's five panels: Clips (sources and the selected clip), Auto edit, Music, Colour and
 * Export. Each reads the shared `PanelCtx` the editor builds; the panels own no state of the
 * document themselves. Plain words throughout: the person is a designer, not an engineer.
 */
import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Clapperboard, Download, Eye, EyeOff, Music, Plus, Scissors, Sparkles, Trash2, Upload, Wand2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import { BITRATE_PRESETS, clipLength, COLOUR_KEYS, DEFAULT_COLOUR, estimateBytes, formatBytes, LOOKS, MAX_TIMELINE_SECONDS, OUTPUT_PRESETS, totalLength, type AutoStyle, type Clip, type ColourParams, type VideoProject } from "@shared/video-project";
import type { Media } from "../engine/media";
import type { ExportProgress } from "../engine/export";

export interface PanelCtx {
  project: VideoProject;
  readOnly: boolean;
  /** Why the person cannot save or export, when they cannot. */
  reason: string;
  selected: Clip | null;
  time: number;
  commit: (fn: (p: VideoProject) => VideoProject) => void;
  patch: (fn: (p: VideoProject) => VideoProject) => void;
  mark: () => void;
  sources: Media[];
  labelOf: (clip: Clip) => string;
  onAddClip: (m: Media) => void;
  onAddFootage: (files: FileList) => Promise<void>;
  footageBusy: string;
  onSplit: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  auto: { busy: string; run: (target: number, style: AutoStyle) => Promise<void> };
  music: { name: string | null; duration: number; beats: number; busy: string; pick: (file: File) => Promise<void>; remove: () => void; snap: () => void };
  colour: { lutName: string | null; pickLut: (file: File) => Promise<void>; clearLut: () => void; bypass: boolean; setBypass: (b: boolean) => void };
  exporting: { progress: ExportProgress | null; result: string | null; error: string | null; run: () => Promise<void>; stop: () => void; canExport: boolean; capsMessage: string; standalone: boolean };
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const fmt = (s: number) => `${s.toFixed(1)}s`;

/* ───────────── Clips ───────────── */

export function ClipsPanel({ ctx }: { ctx: PanelCtx }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const c = ctx.selected;
  const set = (patch: Partial<Clip>) => c && ctx.commit((p) => ({ ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }));
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Footage</span>
      {ctx.sources.length === 0 && <p className="ts-hint">No footage yet. {ctx.exporting.standalone ? "Add a clip from this computer." : "This post has no finished video version; add a clip from this computer or make one in the Video dialog."}</p>}
      <ul className="ve-sources">
        {ctx.sources.map((m) => (
          <li key={m.key}>
            <span className="ve-source-text">
              <b>{m.label}</b>
              <small>
                {fmt(m.duration)} · {m.width}×{m.height}
              </small>
            </span>
            <button type="button" className="ts-mini" disabled={ctx.readOnly || ctx.project.clips.length >= 24} onClick={() => ctx.onAddClip(m)} title="Add this footage to the end of the timeline">
              <Plus size={12} /> Add
            </button>
          </li>
        ))}
      </ul>
      <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple hidden onChange={(e) => { if (e.target.files?.length) void ctx.onAddFootage(e.target.files); e.target.value = ""; }} />
      <button type="button" className="ts-btn" disabled={!!ctx.footageBusy} onClick={() => fileRef.current?.click()} title="An H.264 MP4 or MOV from this computer, 60 MB at most">
        {ctx.footageBusy ? <Orb size={14} status={null} /> : <Upload size={14} />} {ctx.footageBusy || "Add footage from this computer"}
      </button>
      {!ctx.exporting.standalone && !ctx.readOnly && <p className="ts-hint">Footage you add is kept with the post as an uploaded version, so this cut can be reopened later.</p>}
      {ctx.exporting.standalone && <p className="ts-hint">With no post open, footage stays in this tab only; the export is saved as a file.</p>}

      <span className="ts-group-title">Selected clip</span>
      {!c ? (
        <p className="ts-hint">Select a clip on the timeline to trim it, change its speed or the way it joins the clip before.</p>
      ) : (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <p className="ve-clip-name">
            <Clapperboard size={13} /> {ctx.labelOf(c)} · {fmt(clipLength(c))} on the timeline
          </p>
          <label className="ve-row">
            <span>Start in the footage</span>
            <input type="number" min={0} max={c.duration} step={0.1} value={Math.round(c.in * 10) / 10} onChange={(e) => set({ in: Math.min(Math.max(0, Number(e.target.value)), c.out - 0.25 * c.speed) })} />
          </label>
          <label className="ve-row">
            <span>End in the footage</span>
            <input type="number" min={0} max={c.duration} step={0.1} value={Math.round(c.out * 10) / 10} onChange={(e) => set({ out: Math.max(Math.min(c.duration, Number(e.target.value)), c.in + 0.25 * c.speed) })} />
          </label>
          <label className="ve-row">
            <span>Speed</span>
            <select value={c.speed} onChange={(e) => set({ speed: Number(e.target.value) })}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  ×{s}
                </option>
              ))}
            </select>
          </label>
          <label className="ve-row">
            <span>Joins the clip before with</span>
            <select value={c.transition} onChange={(e) => set({ transition: e.target.value as Clip["transition"] })} disabled={ctx.project.clips[0]?.id === c.id}>
              <option value="cut">A cut</option>
              <option value="crossfade">A crossfade</option>
            </select>
          </label>
          {c.transition === "crossfade" && (
            <label className="ts-slider">
              <span>
                Crossfade <em>{c.transitionDuration.toFixed(1)}s</em>
              </span>
              <input type="range" min={0.2} max={2} step={0.1} value={c.transitionDuration} onPointerDown={ctx.mark} onChange={(e) => ctx.patch((p) => ({ ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, transitionDuration: Number(e.target.value) } : x)) }))} onPointerUp={() => ctx.commit((p) => p)} />
            </label>
          )}
          <div className="ve-actions">
            <button type="button" className="ts-mini" onClick={() => ctx.onMove(-1)} title="Move this clip one place earlier">
              <ArrowUp size={12} /> Earlier
            </button>
            <button type="button" className="ts-mini" onClick={() => ctx.onMove(1)} title="Move this clip one place later">
              <ArrowDown size={12} /> Later
            </button>
            <button type="button" className="ts-mini" onClick={ctx.onSplit} title="Split this clip at the playhead (S)">
              <Scissors size={12} /> Split
            </button>
            <button type="button" className="ts-mini danger" onClick={ctx.onDelete} title="Remove this clip from the timeline (Delete)">
              <Trash2 size={12} /> Remove
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/* ───────────── Auto edit ───────────── */

export function AutoEditPanel({ ctx }: { ctx: PanelCtx }) {
  const [target, setTarget] = useState(15);
  const [style, setStyle] = useState<AutoStyle>("calm");
  return (
    <div className="ve-panel">
      <span className="ts-group-title">A first cut</span>
      <p className="ts-hint">Builds a timeline from the footage above: each clip trimmed to its liveliest seconds (how much the picture moves), in order for a calm cut or liveliest first for an energetic one, cut on the beat when music is set. Simple rules, not a judgement of the content; change anything afterwards.</p>
      <fieldset className="ve-fields" disabled={ctx.readOnly || !!ctx.auto.busy}>
        <label className="ts-slider">
          <span>
            Length <em>{target}s</em>
          </span>
          <input type="range" min={3} max={MAX_TIMELINE_SECONDS} step={1} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
        <div className="ve-choice">
          <button type="button" className={`ts-mini ${style === "calm" ? "primary" : ""}`} onClick={() => setStyle("calm")} title="Longer shots, crossfades, in the order of the footage">
            Calm
          </button>
          <button type="button" className={`ts-mini ${style === "energetic" ? "primary" : ""}`} onClick={() => setStyle("energetic")} title="Short shots, hard cuts, the liveliest footage first">
            Energetic
          </button>
        </div>
        <button type="button" className="ts-btn primary" disabled={!ctx.sources.length} onClick={() => void ctx.auto.run(target, style)}>
          {ctx.auto.busy ? <Orb size={14} status={null} /> : <Wand2 size={14} />} {ctx.auto.busy || "Build the cut"}
        </button>
      </fieldset>
      {ctx.project.clips.length > 0 && <p className="ts-hint">Building replaces the current timeline (undo brings it back).</p>}
      {ctx.music.name ? <p className="ts-hint">Music is set: shot lengths are whole beats, so cuts land on the grid.</p> : <p className="ts-hint">Set music first if you want the cuts on the beat.</p>}
    </div>
  );
}

/* ───────────── Music ───────────── */

export function MusicPanel({ ctx }: { ctx: PanelCtx }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const m = ctx.project.music;
  const setMusic = (patch: Partial<NonNullable<VideoProject["music"]>>, step: "patch" | "commit") => (step === "commit" ? ctx.commit : ctx.patch)((p) => (p.music ? { ...p, music: { ...p.music, ...patch } } : p));
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Music</span>
      <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void ctx.music.pick(f); e.target.value = ""; }} />
      {!m ? (
        <>
          <p className="ts-hint">A track from this computer (mp3, m4a or wav). It replaces the clips' own sound in the export. Use music you have the rights to; Instagram's own library cannot be used from here.</p>
          <button type="button" className="ts-btn" disabled={ctx.readOnly || !!ctx.music.busy} onClick={() => fileRef.current?.click()}>
            {ctx.music.busy ? <Orb size={14} status={null} /> : <Music size={14} />} {ctx.music.busy || "Pick a track"}
          </button>
        </>
      ) : (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <p className="ve-clip-name">
            <Music size={13} /> {ctx.music.name ?? (m.source.kind === "upload" ? m.source.name : "Track")}
            {ctx.music.duration ? ` · ${fmt(ctx.music.duration)}` : ""}
          </p>
          {!ctx.music.name && <p className="ts-hint warn">The track's file is not in this tab (a saved project keeps its name, not the file). Pick it again to hear it and to export with it.</p>}
          <label className="ts-slider">
            <span>
              Starts in the track at <em>{fmt(m.offset)}</em>
            </span>
            <input type="range" min={0} max={Math.max(0, (ctx.music.duration || m.duration || 60) - 1)} step={0.1} value={m.offset} onPointerDown={ctx.mark} onChange={(e) => setMusic({ offset: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ts-slider">
            <span>
              Volume <em>{Math.round(m.volume * 100)}%</em>
            </span>
            <input type="range" min={0} max={1} step={0.05} value={m.volume} onPointerDown={ctx.mark} onChange={(e) => setMusic({ volume: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ts-slider">
            <span>
              Fade in <em>{fmt(m.fadeIn)}</em>
            </span>
            <input type="range" min={0} max={5} step={0.1} value={m.fadeIn} onPointerDown={ctx.mark} onChange={(e) => setMusic({ fadeIn: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ts-slider">
            <span>
              Fade out <em>{fmt(m.fadeOut)}</em>
            </span>
            <input type="range" min={0} max={5} step={0.1} value={m.fadeOut} onPointerDown={ctx.mark} onChange={(e) => setMusic({ fadeOut: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <span className="ts-group-title">Beats</span>
          <p className="ts-hint">{ctx.music.beats ? `${ctx.music.beats} beats found from the track's pulses; they show as ticks on the timeline.` : ctx.music.busy || "No clear pulse found in this track."}</p>
          <div className="ve-actions">
            <button type="button" className={`ts-mini ${ctx.project.snapToBeats ? "primary" : ""}`} disabled={!ctx.music.beats} onClick={ctx.music.snap} title="Move every cut to the nearest beat (within a quarter second), now and whenever the cut is built again">
              <Sparkles size={12} /> {ctx.project.snapToBeats ? "Cuts snap to beats" : "Snap cuts to beats"}
            </button>
            <button type="button" className="ts-mini" onClick={() => fileRef.current?.click()}>
              Change track
            </button>
            <button type="button" className="ts-mini danger" onClick={ctx.music.remove}>
              <Trash2 size={12} /> Remove
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/* ───────────── Colour ───────────── */

const SLIDERS: { key: keyof ColourParams; label: string; min: number; max: number }[] = [
  { key: "exposure", label: "Exposure", min: -2, max: 2 },
  { key: "contrast", label: "Contrast", min: -1, max: 1 },
  { key: "saturation", label: "Saturation", min: -1, max: 1 },
  { key: "temperature", label: "Temperature", min: -1, max: 1 },
  { key: "tint", label: "Tint", min: -1, max: 1 },
  { key: "highlights", label: "Highlights", min: -1, max: 1 },
  { key: "shadows", label: "Shadows", min: -1, max: 1 },
];

export function ColourPanel({ ctx }: { ctx: PanelCtx }) {
  const lutRef = useRef<HTMLInputElement>(null);
  const [perClip, setPerClip] = useState(false);
  const c = ctx.selected;
  const onClip = perClip && c;
  const params: ColourParams = onClip ? (c.colour ?? DEFAULT_COLOUR) : ctx.project.colour;
  const update = (key: keyof ColourParams, value: number, step: "patch" | "commit") =>
    (step === "commit" ? ctx.commit : ctx.patch)((p) =>
      onClip ? { ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, colour: { ...(x.colour ?? DEFAULT_COLOUR), [key]: value } } : x)) } : { ...p, colour: { ...p.colour, [key]: value } },
    );
  const reset = () => ctx.commit((p) => (onClip ? { ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, colour: undefined } : x)) } : { ...p, colour: { ...DEFAULT_COLOUR }, look: "none" }));
  const changed = COLOUR_KEYS.some((k) => params[k] !== 0) || (!onClip && ctx.project.look !== "none");
  return (
    <div className="ve-panel">
      <div className="ve-panel-head">
        <span className="ts-group-title">Look</span>
        <button type="button" className={`ts-mini ${ctx.colour.bypass ? "primary" : ""}`} onPointerDown={() => ctx.colour.setBypass(true)} onPointerUp={() => ctx.colour.setBypass(false)} onPointerLeave={() => ctx.colour.setBypass(false)} title="Hold to see the footage without any colour change">
          {ctx.colour.bypass ? <EyeOff size={12} /> : <Eye size={12} />} Before
        </button>
      </div>
      <fieldset className="ve-fields" disabled={ctx.readOnly}>
        <div className="ve-looks">
          {LOOKS.map((l) => (
            <button key={l.id} type="button" className={`ve-look ${ctx.project.look === l.id ? "on" : ""}`} title={l.hint} onClick={() => ctx.commit((p) => ({ ...p, look: l.id }))}>
              {l.name}
            </button>
          ))}
        </div>
        <p className="ts-hint">A look is a starting point; the sliders add to it. Applied to the whole cut{c ? ", or to the selected clip only" : ""}.</p>
        {c && (
          <label className="ve-check">
            <input type="checkbox" checked={perClip} onChange={(e) => setPerClip(e.target.checked)} /> Adjust only “{ctx.labelOf(c)}”
          </label>
        )}
        {SLIDERS.map((s) => (
          <label key={s.key} className="ts-slider">
            <span>
              {s.label} <em>{params[s.key] > 0 ? "+" : ""}{params[s.key].toFixed(2)}</em>
            </span>
            <input type="range" min={s.min} max={s.max} step={0.01} value={params[s.key]} onPointerDown={ctx.mark} onChange={(e) => update(s.key, Number(e.target.value), "patch")} onPointerUp={() => ctx.commit((p) => p)} onDoubleClick={() => update(s.key, 0, "commit")} />
          </label>
        ))}
        {changed && (
          <button type="button" className="ts-link" onClick={reset}>
            Reset {onClip ? "this clip's colour" : "the colour"}
          </button>
        )}
        <span className="ts-group-title">LUT</span>
        <input ref={lutRef} type="file" accept=".cube" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void ctx.colour.pickLut(f); e.target.value = ""; }} />
        {ctx.project.lut ? (
          <>
            <p className="ve-clip-name">{ctx.project.lut.name} · {ctx.project.lut.size}³</p>
            {!ctx.colour.lutName && <p className="ts-hint warn">The LUT file is not in this tab (a saved project keeps its name, not the table). Pick it again to see it and to export with it.</p>}
            <label className="ts-slider">
              <span>
                Strength <em>{Math.round(ctx.project.lut.strength * 100)}%</em>
              </span>
              <input type="range" min={0} max={1} step={0.05} value={ctx.project.lut.strength} onPointerDown={ctx.mark} onChange={(e) => ctx.patch((p) => (p.lut ? { ...p, lut: { ...p.lut, strength: Number(e.target.value) } } : p))} onPointerUp={() => ctx.commit((p) => p)} />
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
            <p className="ts-hint">A .cube file (a 3D table from DaVinci Resolve, Premiere or a LUT pack), applied after the sliders to the whole cut.</p>
            <button type="button" className="ts-btn" onClick={() => lutRef.current?.click()}>
              <Upload size={14} /> Load a .cube LUT
            </button>
          </>
        )}
      </fieldset>
    </div>
  );
}

/* ───────────── Export ───────────── */

const PHASE_TEXT: Record<ExportProgress["phase"], string> = {
  checking: "Checking this browser",
  reading: "Reading the footage",
  sound: "Mixing the sound",
  frames: "Rendering the frames",
  finishing: "Finishing the file",
};

export function ExportPanel({ ctx }: { ctx: PanelCtx }) {
  const o = ctx.project.output;
  const length = totalLength(ctx.project);
  const preset = OUTPUT_PRESETS.find((p) => p.width === o.width && p.height === o.height)?.id ?? "custom";
  const bitrate = BITRATE_PRESETS.find((b) => b.bps === o.bitrate)?.id ?? "custom";
  const x = ctx.exporting;
  const busy = !!x.progress;
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Output</span>
      <fieldset className="ve-fields" disabled={ctx.readOnly || busy}>
        <label className="ve-row">
          <span>Size</span>
          <select value={preset} onChange={(e) => { const p = OUTPUT_PRESETS.find((q) => q.id === e.target.value); if (p) ctx.commit((pr) => ({ ...pr, output: { ...pr.output, width: p.width, height: p.height } })); }}>
            {OUTPUT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {preset === "custom" && <option value="custom">{o.width}×{o.height}</option>}
          </select>
        </label>
        <label className="ve-row">
          <span>Quality</span>
          <select value={bitrate} onChange={(e) => { const b = BITRATE_PRESETS.find((q) => q.id === e.target.value); if (b) ctx.commit((pr) => ({ ...pr, output: { ...pr.output, bitrate: b.bps } })); }}>
            {BITRATE_PRESETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {bitrate === "custom" && <option value="custom">{Math.round(o.bitrate / 1e6)} Mbit/s</option>}
          </select>
        </label>
        <p className="ve-estimate">
          {fmt(length)} · {o.fps} fps · H.264 + AAC · about {formatBytes(estimateBytes(o, length))}
        </p>
      </fieldset>
      {!x.canExport && x.capsMessage ? (
        <p className="ve-stop">{x.capsMessage}</p>
      ) : (
        <button type="button" className="ts-btn primary" disabled={ctx.readOnly || busy || length <= 0} onClick={() => void x.run()}>
          <Download size={14} /> {x.standalone ? "Export to a file" : "Export as a new version"}
        </button>
      )}
      {x.progress && (
        <div className="ve-progress" role="status">
          <span>
            <Orb size={14} status={null} /> {PHASE_TEXT[x.progress.phase]}
            {x.progress.phase === "frames" && x.progress.frames ? ` · ${x.progress.frame} of ${x.progress.frames}` : ""}
          </span>
          <progress value={x.progress.fraction} max={1} />
          <button type="button" className="ts-link danger" onClick={x.stop}>
            Stop
          </button>
        </div>
      )}
      {x.error && <p className="ts-hint warn">{x.error}</p>}
      {x.result && <p className="ve-done">{x.result}</p>}
      {!x.standalone && <p className="ts-hint">The export becomes a version of this post. It is shown to the client only when you pick it with “Select for client review” in the Video dialog or the editor's Versions.</p>}
      <p className="ts-hint">Rendered here in your browser, frame by frame: about real time on a laptop, longer on a phone. Keep the tab open until it finishes. The file plays on iPhone and uploads to Instagram as it is.</p>
      {ctx.reason && <p className="ts-hint warn">{ctx.reason}</p>}
    </div>
  );
}
