/**
 * The editor's panels: Media (sources, the selected clip and its framing), Text and Logo (the
 * layers over the video), Music, Auto edit and Render. Each reads the shared `PanelCtx`
 * the editor builds; the panels own no state of the document themselves. Plain words throughout:
 * the person is a designer, not an engineer. The Colour panel (ColourPanel.tsx), the templates
 * (TemplatesGallery.tsx) and the music source (MusicSourcePanel.tsx) are phase 3's own files.
 */
import { useRef, useState } from "react";
import { get } from "@/api";
import { ArrowDown, ArrowUp, Clapperboard, Download, Image as ImageIcon, Library, Lock, Music, Plus, RotateCcw, Scissors, Send, Trash2, Type, Unlock, Upload } from "lucide-react";
import { Orb } from "@/components/Orb";
import { BITRATE_PRESETS, clipLength, estimateBytes, formatBytes, isGap, placeClips, totalLength, TRANSITIONS, type Clip, type VideoProject } from "@shared/video-project";
import type { LooksCtx } from "./looks-ctx";
import TemplatesGallery from "./TemplatesGallery";
import MusicSourcePanel from "./MusicSourcePanel";
import { DEFAULT_FRAMING, MAX_LOGO_DATA_URL, MAX_ZOOM, textDirection, type Framing, type LogoOverlay, type Overlay, type TextOverlay } from "@shared/video-compose";
import type { AutoRunOptions } from "@shared/edit-plan";
import type { ReferenceCtx } from "./ReferencePanel";
import type { Keyframes } from "@shared/video-keyframes";
import KeyframeControls, { isAnimated } from "./KeyframeControls";
import { MusicMixControls, type VoiceCtx } from "./MusicMix";
import { frameLabel, FRAMES, type FrameId } from "@shared/video-frame";
import type { AudioTrack } from "@/studio/videoApi";
import { metaLine, type Media } from "../engine/media";
import type { ExportProgress } from "../engine/export";
import type { RenderItem } from "../api";

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
  /** The sources a first cut or a template picks from: without the editor's own renders. */
  footage: Media[];
  labelOf: (clip: Clip) => string;
  onAddClip: (m: Media) => void;
  onAddFootage: (files: FileList) => Promise<void>;
  footageBusy: string;
  onSplit: () => void;
  /** Deletes the selected clips: closing the gap (ripple) or leaving it. */
  onDelete: (ripple?: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  /** The selected clips (several with shift or cmd clicks). */
  selection: string[];
  onToggleLock: () => void;
  /** Moves the playhead (timeline seconds). */
  seek: (t: number) => void;
  /** Auto edit (shared/edit-plan.ts) and "Edit like this video" (ReferencePanel). */
  auto: { busy: string; run: (opts: AutoRunOptions) => Promise<void>; notes: string[]; reference: ReferenceCtx };
  /** The voice-over lane. */
  voice: VoiceCtx;
  music: {
    name: string | null;
    duration: number;
    beats: number;
    busy: string;
    pick: (file: File, license?: string) => Promise<void>;
    remove: () => void;
    /** The post's licensed tracks. */
    tracks: AudioTrack[];
    choose: (t: AudioTrack) => Promise<void>;
    /** A picked track is kept with the post (a post is open and the person may). */
    keeps: boolean;
    /** "Align cuts to beats": every cut near a beat moved onto it (locked clips and speech untouched). */
    align: () => void;
  };
  colour: { lutName: string | null; pickLut: (file: File) => Promise<void>; clearLut: () => void; bypass: boolean; setBypass: (b: boolean) => void };
  exporting: {
    progress: ExportProgress | null;
    result: string | null;
    error: string | null;
    run: () => Promise<void>;
    stop: () => void;
    canExport: boolean;
    capsMessage: string;
    /** Rendering works, differently from usual (the AAC fallback's one-time download); empty otherwise. */
    capsNotice: string;
    standalone: boolean;
    running: boolean;
    renders: RenderItem[];
    /** The draft and render state line. */
    chip: string;
    sendForReview: (videoId: string) => Promise<void>;
    videoLabel: (id: string) => string;
    /** The version the client sees now. */
    clientId: string | null;
  };
  layers: {
    selected: string | null;
    select: (id: string | null) => void;
    addText: () => void;
    addLogo: (src: string, name: string) => void;
    patch: (id: string, patch: Partial<Overlay>, step?: "patch" | "commit") => void;
    remove: (id: string) => void;
    /** The client's logo from the brand kit, when there is one. */
    logoUrl: string | null;
  };
  framing: { frame: FrameId | null; setFrame: (f: FrameId) => void };
  /** Phase 3: split view, the client, the studio's reference pictures, the music library pick. */
  looks: LooksCtx;
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
      <TemplatesGallery ctx={ctx} />
      <span className="ts-group-title">Footage</span>
      {ctx.sources.length === 0 && <p className="ts-hint">No footage yet. {ctx.exporting.standalone ? "Add a clip from this computer." : !ctx.exporting.canExport && ctx.exporting.capsMessage ? "This browser cannot read the post's clips, so they are not listed here." : "This post has no finished video version; add a clip from this computer or make one in the Video dialog."}</p>}
      <ul className="ve-sources">
        {ctx.sources.map((m) => (
          <li key={m.key}>
            <span className="ve-source-text">
              <b>{m.label}</b>
              <small>
                {fmt(m.duration)} · {m.width}×{m.height}
                {m.meta ? ` · ${metaLine(m.meta)}` : ""}
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

      <span className="ts-group-title">{ctx.selection.length > 1 ? `${ctx.selection.length} clips selected` : "Selected clip"}</span>
      {ctx.selection.length > 1 && (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <p className="ts-hint">Drag them together on the timeline, or delete, lock, mute them at once. The settings below are the last one's ({c ? ctx.labelOf(c) : ""}).</p>
          <div className="ve-actions">
            <button type="button" className="ts-mini" onClick={ctx.onToggleLock}>
              <Lock size={12} /> Lock / unlock
            </button>
            <button type="button" className="ts-mini" onClick={() => ctx.commit((p) => ({ ...p, clips: p.clips.map((x) => (ctx.selection.includes(x.id) ? { ...x, muted: !x.muted || undefined } : x)) }))}>
              Mute / unmute
            </button>
            <button type="button" className="ts-mini danger" onClick={() => ctx.onDelete(true)} title="Delete and close the gap (Delete)">
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </fieldset>
      )}
      {!c ? (
        <p className="ts-hint">Select a clip on the timeline to trim it, change its speed, its sound or the way it joins the clip before. Shift-click selects a run of clips, cmd/ctrl-click adds one.</p>
      ) : isGap(c) ? (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <p className="ve-clip-name">A gap · {fmt(clipLength(c))} of background, no sound</p>
          <div className="ve-actions">
            <button type="button" className="ts-mini danger" onClick={() => ctx.onDelete(true)} title="Close the gap (Delete)">
              <Trash2 size={12} /> Close the gap
            </button>
          </div>
        </fieldset>
      ) : (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <p className="ve-clip-name">
            <Clapperboard size={13} /> {ctx.labelOf(c)} · {fmt(clipLength(c))} on the timeline
          </p>
          <div className="ve-choice">
            <button type="button" className={`ts-mini ${c.locked ? "primary" : ""}`} onClick={() => set({ locked: !c.locked || undefined })} aria-pressed={!!c.locked} title="Locked: auto edit, beat alignment and dragging never move or trim it">
              {c.locked ? <Lock size={12} /> : <Unlock size={12} />} {c.locked ? "Locked" : "Lock"}
            </button>
            <button type="button" className={`ts-mini ${c.speech ? "primary" : ""}`} onClick={() => set({ speech: !c.speech || undefined })} aria-pressed={!!c.speech} title="Has speech: auto edit never cuts inside it, and the music ducks under it">
              Has speech
            </button>
          </div>
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
          <span className="ts-group-title">Sound</span>
          <div className="ve-choice">
            <button type="button" className={`ts-mini ${!c.muted ? "primary" : ""}`} onClick={() => set({ muted: undefined })} aria-pressed={!c.muted}>
              Keep its sound
            </button>
            <button type="button" className={`ts-mini ${c.muted ? "primary" : ""}`} onClick={() => set({ muted: true })} aria-pressed={!!c.muted}>
              Mute
            </button>
          </div>
          {!c.muted && (
            <label className="ts-slider">
              <span>
                Clip volume <em>{Math.round((c.volume ?? 1) * 100)}%</em>
              </span>
              <input type="range" min={0} max={1} step={0.05} value={c.volume ?? 1} onPointerDown={ctx.mark} onChange={(e) => ctx.patch((p) => ({ ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, volume: Number(e.target.value) } : x)) }))} onPointerUp={() => ctx.commit((p) => p)} />
            </label>
          )}
          <p className="ts-hint">Mixed with the music and the voice-over; the music ducks under a clip marked “Has speech”.</p>
          <label className="ve-row">
            <span>Joins the clip before with</span>
            <select value={c.transition} onChange={(e) => set({ transition: e.target.value as Clip["transition"] })} disabled={ctx.project.clips[0]?.id === c.id}>
              {TRANSITIONS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {c.transition !== "cut" && ctx.project.clips[0]?.id !== c.id && (
            <label className="ts-slider">
              <span>
                {c.transition === "crossfade" ? "Crossfade" : "Dip"} <em>{c.transitionDuration.toFixed(1)}s</em>
              </span>
              <input type="range" min={0.2} max={2} step={0.1} value={c.transitionDuration} onPointerDown={ctx.mark} onChange={(e) => ctx.patch((p) => ({ ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, transitionDuration: Number(e.target.value) } : x)) }))} onPointerUp={() => ctx.commit((p) => p)} />
            </label>
          )}
          <ClipFraming ctx={ctx} clip={c} />
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
            <button type="button" className="ts-mini danger" onClick={() => ctx.onDelete(true)} title="Delete and close the gap (Delete)">
              <Trash2 size={12} /> Delete
            </button>
            <button type="button" className="ts-mini" onClick={() => ctx.onDelete(false)} title="Delete and leave a gap, so nothing after it moves (Shift + Delete)">
              <Trash2 size={12} /> Delete, keep the gap
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** The selected clip's place in the frame: the cut's framing, or its own (Fill or Fit, zoom, pan). Uniform scale only. */
function ClipFraming({ ctx, clip }: { ctx: PanelCtx; clip: Clip }) {
  const own = clip.framing;
  const f: Framing = own ?? ctx.project.framing ?? DEFAULT_FRAMING;
  const set = (patch: Partial<Framing>, step: "patch" | "commit") => (step === "commit" ? ctx.commit : ctx.patch)((p) => ({ ...p, clips: p.clips.map((x) => (x.id === clip.id ? { ...x, framing: { ...(x.framing ?? p.framing ?? DEFAULT_FRAMING), ...patch } } : x)) }));
  return (
    <>
      <span className="ts-group-title">Framing</span>
      <label className="ve-check">
        <input type="checkbox" checked={!!own} onChange={(e) => ctx.commit((p) => ({ ...p, clips: p.clips.map((x) => (x.id === clip.id ? (e.target.checked ? { ...x, framing: { ...(p.framing ?? DEFAULT_FRAMING) } } : { ...x, framing: undefined, keyframes: undefined }) : x)) }))} /> Reframe (and animate) this clip on its own
      </label>
      {own ? (
        <>
          <div className="ve-choice">
            {(["fill", "fit"] as const).map((m) => (
              <button key={m} type="button" className={`ts-mini ${f.fit === m ? "primary" : ""}`} onClick={() => set({ fit: m }, "commit")}>
                {m === "fill" ? "Fill" : "Fit"}
              </button>
            ))}
          </div>
          <label className="ts-slider">
            <span>
              Zoom <em>{f.zoom.toFixed(2)}×</em>
            </span>
            <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={f.zoom} disabled={isAnimated(clip.keyframes, "zoom")} title={isAnimated(clip.keyframes, "zoom") ? "Animated: set it under Animate" : undefined} onPointerDown={ctx.mark} onChange={(e) => set({ zoom: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ts-slider">
            <span>
              Left · right <em>{f.x.toFixed(2)}</em>
            </span>
            <input type="range" min={-1} max={1} step={0.01} value={f.x} disabled={isAnimated(clip.keyframes, "x")} onPointerDown={ctx.mark} onChange={(e) => set({ x: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} onDoubleClick={() => set({ x: 0 }, "commit")} />
          </label>
          <label className="ts-slider">
            <span>
              Up · down <em>{f.y.toFixed(2)}</em>
            </span>
            <input type="range" min={-1} max={1} step={0.01} value={f.y} disabled={isAnimated(clip.keyframes, "y")} onPointerDown={ctx.mark} onChange={(e) => set({ y: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} onDoubleClick={() => set({ y: 0 }, "commit")} />
          </label>
          <p className="ts-hint">The picture keeps its shape: zoom enlarges it, the two sliders move it inside the frame. People and products are never stretched.</p>
          {(() => {
            const pl = placeClips(ctx.project.clips).find((x) => x.clip.id === clip.id);
            if (!pl) return null;
            const setKf = (kf: Keyframes | undefined, step: "patch" | "commit") => (step === "commit" ? ctx.commit : ctx.patch)((p) => ({ ...p, clips: p.clips.map((x) => (x.id === clip.id ? { ...x, keyframes: kf } : x)) }));
            return (
              <KeyframeControls
                kf={clip.keyframes}
                local={ctx.time - pl.start}
                length={pl.end - pl.start}
                readOnly={ctx.readOnly}
                mark={ctx.mark}
                onChange={setKf}
                onSeek={(l) => ctx.seek(pl.start + l)}
                props={[
                  { prop: "zoom", label: "Zoom", base: f.zoom, min: 1, max: MAX_ZOOM, step: 0.01, format: (v) => `${v.toFixed(2)}×` },
                  { prop: "x", label: "Left · right", base: f.x, min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
                  { prop: "y", label: "Up · down", base: f.y, min: -1, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
                ]}
              />
            );
          })()}
        </>
      ) : (
        <p className="ts-hint">Uses the cut's {f.fit === "fit" ? "Fit" : "Fill"} above the stage. Tick to zoom or move this clip in the frame.</p>
      )}
      {f.fit === "fit" && (
        <label className="ve-row">
          <span>Background around the picture</span>
          <input type="color" value={ctx.project.background} onFocus={ctx.mark} onChange={(e) => ctx.patch((p) => ({ ...p, background: e.target.value }))} onBlur={() => ctx.commit((p) => p)} />
        </label>
      )}
    </>
  );
}

/* ───────────── Text and logo layers ───────────── */

const fmtT = (s: number) => `${s.toFixed(1)}s`;

function LayerTiming({ ctx, o }: { ctx: PanelCtx; o: Overlay }) {
  const len = Math.max(0.5, totalLength(ctx.project));
  return (
    <>
      <label className="ve-row">
        <span>Shows from</span>
        <input type="number" min={0} max={len} step={0.1} value={Math.round(o.start * 10) / 10} onChange={(e) => ctx.layers.patch(o.id, { start: Math.min(Math.max(0, Number(e.target.value)), o.end - 0.1) })} />
      </label>
      <label className="ve-row">
        <span>Until</span>
        <input type="number" min={0} max={len + 30} step={0.1} value={Math.round(o.end * 10) / 10} onChange={(e) => ctx.layers.patch(o.id, { end: Math.max(o.start + 0.1, Number(e.target.value)) })} />
      </label>
      <label className="ts-slider">
        <span>
          Across <em>{Math.round(o.x * 100)}%</em>
        </span>
        <input type="range" min={0} max={1} step={0.005} value={o.x} disabled={isAnimated(o.keyframes, "x")} title={isAnimated(o.keyframes, "x") ? "Animated: set it under Animate" : undefined} onPointerDown={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { x: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
      </label>
      <label className="ts-slider">
        <span>
          Down <em>{Math.round(o.y * 100)}%</em>
        </span>
        <input type="range" min={0} max={1} step={0.005} value={o.y} disabled={isAnimated(o.keyframes, "y")} title={isAnimated(o.keyframes, "y") ? "Animated: set it under Animate" : undefined} onPointerDown={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { y: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
      </label>
    </>
  );
}

/** Position, scale and opacity keyframes of a text or logo layer. */
function LayerAnimate({ ctx, o }: { ctx: PanelCtx; o: Overlay }) {
  const opacity = o.kind === "logo" ? o.opacity : (o.opacity ?? 1);
  return (
    <KeyframeControls
      kf={o.keyframes}
      local={ctx.time - o.start}
      length={o.end - o.start}
      readOnly={ctx.readOnly}
      mark={ctx.mark}
      onChange={(kf, step) => ctx.layers.patch(o.id, { keyframes: kf }, step)}
      onSeek={(l) => ctx.seek(o.start + l)}
      props={[
        { prop: "x", label: "Across", base: o.x, min: 0, max: 1, step: 0.005, format: (v) => `${Math.round(v * 100)}%` },
        { prop: "y", label: "Down", base: o.y, min: 0, max: 1, step: 0.005, format: (v) => `${Math.round(v * 100)}%` },
        { prop: "scale", label: "Scale", base: 1, min: 0.2, max: 3, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
        { prop: "opacity", label: "Opacity", base: opacity, min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
      ]}
    />
  );
}

function LayerList({ ctx, kind }: { ctx: PanelCtx; kind: Overlay["kind"] }) {
  const list = ctx.project.overlays.filter((o) => o.kind === kind);
  if (!list.length) return null;
  return (
    <ul className="ve-layers">
      {list.map((o) => (
        <li key={o.id}>
          <button type="button" className={ctx.layers.selected === o.id ? "on" : ""} onClick={() => ctx.layers.select(o.id)} dir="auto">
            {o.kind === "text" ? <Type size={12} /> : <ImageIcon size={12} />} <span>{o.kind === "text" ? o.text : o.name}</span>
            <small>
              {fmtT(o.start)}–{fmtT(o.end)}
            </small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TextPanel({ ctx }: { ctx: PanelCtx }) {
  const o = ctx.project.overlays.find((x): x is TextOverlay => x.id === ctx.layers.selected && x.kind === "text") ?? null;
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Text on the video</span>
      <p className="ts-hint">Words over the footage in Arabic, English or both (a second line in the other language). Arabic is joined and runs right to left, English left to right, in the preview and in the render. Never colour-graded, so brand colours stay exact.</p>
      <button type="button" className="ts-btn" disabled={ctx.readOnly || !ctx.project.clips.length} onClick={ctx.layers.addText}>
        <Plus size={14} /> Add text at the playhead
      </button>
      <LayerList ctx={ctx} kind="text" />
      {o && (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <label className="ve-stack">
            <span>Words</span>
            <textarea dir="auto" rows={2} maxLength={300} value={o.text} onFocus={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { text: e.target.value }, "patch")} onBlur={() => ctx.commit((p) => p)} style={{ textAlign: textDirection(o.text) === "rtl" ? "right" : "left" }} />
          </label>
          <label className="ve-check">
            <input type="checkbox" checked={o.second !== undefined} onChange={(e) => ctx.layers.patch(o.id, { second: e.target.checked ? "" : undefined })} /> Bilingual: a second line in the other language
          </label>
          {o.second !== undefined && (
            <label className="ve-stack">
              <span>Second line{o.second.trim() ? ` (${textDirection(o.second) === "rtl" ? "right to left" : "left to right"})` : ""}</span>
              <textarea dir="auto" rows={1} maxLength={300} value={o.second} placeholder={textDirection(o.text) === "rtl" ? "The English line" : "The Arabic line"} onFocus={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { second: e.target.value }, "patch")} onBlur={() => ctx.commit((p) => p)} style={{ textAlign: textDirection(o.second) === "rtl" ? "right" : "left" }} />
            </label>
          )}
          <LayerTiming ctx={ctx} o={o} />
          {!isAnimated(o.keyframes, "opacity") && (
            <label className="ts-slider">
              <span>
                Opacity <em>{Math.round((o.opacity ?? 1) * 100)}%</em>
              </span>
              <input type="range" min={0.1} max={1} step={0.05} value={o.opacity ?? 1} onPointerDown={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { opacity: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
            </label>
          )}
          <label className="ts-slider">
            <span>
              Size <em>{Math.round(o.size * 1000) / 10}%</em>
            </span>
            <input type="range" min={0.02} max={0.16} step={0.002} value={o.size} onPointerDown={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { size: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ve-row">
            <span>Font</span>
            <select value={o.font} onChange={(e) => ctx.layers.patch(o.id, { font: e.target.value as TextOverlay["font"] })}>
              <option value="sans">Clean (Inter · Tajawal)</option>
              <option value="display">Bold display (Anton · Cairo)</option>
              <option value="serif">Elegant (Playfair · Amiri)</option>
            </select>
          </label>
          <label className="ve-row">
            <span>Weight</span>
            <select value={o.weight} onChange={(e) => ctx.layers.patch(o.id, { weight: Number(e.target.value) as TextOverlay["weight"] })}>
              <option value={400}>Regular</option>
              <option value={600}>Semi-bold</option>
              <option value={800}>Bold</option>
            </select>
          </label>
          <label className="ve-row">
            <span>Align</span>
            <select value={o.align} onChange={(e) => ctx.layers.patch(o.id, { align: e.target.value as TextOverlay["align"] })}>
              <option value="start">Start of the line</option>
              <option value="center">Centre</option>
              <option value="end">End of the line</option>
            </select>
          </label>
          <label className="ve-row">
            <span>Colour</span>
            <input type="color" value={o.color.slice(0, 7)} onFocus={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { color: e.target.value }, "patch")} onBlur={() => ctx.commit((p) => p)} />
          </label>
          <label className="ve-check">
            <input type="checkbox" checked={!!o.box} onChange={(e) => ctx.layers.patch(o.id, { box: e.target.checked ? "#000000" : null })} /> A box behind the words
          </label>
          {o.box && (
            <label className="ve-row">
              <span>Box colour</span>
              <input type="color" value={o.box.slice(0, 7)} onFocus={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { box: e.target.value }, "patch")} onBlur={() => ctx.commit((p) => p)} />
            </label>
          )}
          <LayerAnimate ctx={ctx} o={o} />
          <button type="button" className="ts-mini danger" onClick={() => ctx.layers.remove(o.id)}>
            <Trash2 size={12} /> Remove this text
          </button>
        </fieldset>
      )}
    </div>
  );
}

/** What the logo panel reads from the client's asset library (GET /api/studio/freepik/assets). */
interface LibraryAsset {
  id: string;
  title: string;
  stored: boolean;
  mime: string | null;
  layerable: boolean;
}

export function LogoPanel({ ctx }: { ctx: PanelCtx }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const o = ctx.project.overlays.find((x): x is LogoOverlay => x.id === ctx.layers.selected && x.kind === "logo") ?? null;
  const pick = (file: File) => {
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (url.length > MAX_LOGO_DATA_URL) return setError("That file is too large for a logo layer (about 150 KB at most). Use a smaller PNG.");
      ctx.layers.addLogo(url, file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsDataURL(file);
  };
  // The brand kit's logo is a same-origin address the project can keep; anything else is uploaded as a small file.
  const brand = ctx.layers.logoUrl && ctx.layers.logoUrl.startsWith("/") ? ctx.layers.logoUrl : null;
  // The client's asset library (stock brought in from Freepik): a stored picture is a same-origin address too.
  const [library, setLibrary] = useState<LibraryAsset[] | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const clientId = ctx.looks.client?.id ?? null;
  const openLibrary = async () => {
    setLibraryOpen((v) => !v);
    if (library || !clientId) return;
    setError("");
    try {
      const r = await get<{ assets: LibraryAsset[] }>(`/api/studio/freepik/assets?client=${encodeURIComponent(clientId)}`);
      setLibrary(r.assets.filter((a) => a.stored && (a.layerable || /^image\//.test(a.mime ?? ""))));
    } catch (e) {
      setLibrary([]);
      setError(e instanceof Error ? e.message : "The asset library could not be read.");
    }
  };
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Logo and pictures</span>
      <p className="ts-hint">A logo (or any small picture) over the video, the same size in every frame. Not colour-graded.</p>
      <div className="ve-actions">
        {brand && (
          <button type="button" className="ts-btn" disabled={ctx.readOnly || !ctx.project.clips.length} onClick={() => ctx.layers.addLogo(brand, "Client logo")}>
            <ImageIcon size={14} /> Add the client's logo
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
        <button type="button" className="ts-btn" disabled={ctx.readOnly || !ctx.project.clips.length} onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Upload a logo
        </button>
        {clientId && (
          <button type="button" className="ts-btn" aria-expanded={libraryOpen} disabled={ctx.readOnly || !ctx.project.clips.length} onClick={() => void openLibrary()}>
            <Library size={14} /> From the asset library
          </button>
        )}
      </div>
      {libraryOpen && (
        <div className="ve-asset-pick">
          {library === null ? (
            <p className="ts-hint">Reading the library…</p>
          ) : library.length === 0 ? (
            <p className="ts-hint">Nothing in this client's library yet. Bring assets in from Freepik in the Text studio first.</p>
          ) : (
            library.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.title}
                onClick={() => {
                  ctx.layers.addLogo(`/api/studio/freepik/assets/${encodeURIComponent(a.id)}/file${a.layerable ? "?layer=1" : ""}`, a.title.slice(0, 60) || "Asset");
                  setLibraryOpen(false);
                }}
              >
                <img src={`/api/studio/freepik/assets/${encodeURIComponent(a.id)}/file${a.layerable ? "?layer=1" : ""}`} alt="" loading="lazy" />
              </button>
            ))
          )}
        </div>
      )}
      {error && <p className="ts-hint warn">{error}</p>}
      <LayerList ctx={ctx} kind="logo" />
      {o && (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <LayerTiming ctx={ctx} o={o} />
          <label className="ts-slider">
            <span>
              Width <em>{Math.round(o.width * 100)}%</em>
            </span>
            <input type="range" min={0.04} max={0.8} step={0.005} value={o.width} onPointerDown={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { width: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ts-slider">
            <span>
              Opacity <em>{Math.round(o.opacity * 100)}%</em>
            </span>
            <input type="range" min={0.1} max={1} step={0.05} value={o.opacity} disabled={isAnimated(o.keyframes, "opacity")} onPointerDown={ctx.mark} onChange={(e) => ctx.layers.patch(o.id, { opacity: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <LayerAnimate ctx={ctx} o={o} />
          <button type="button" className="ts-mini danger" onClick={() => ctx.layers.remove(o.id)}>
            <Trash2 size={12} /> Remove this logo
          </button>
        </fieldset>
      )}
    </div>
  );
}

/* ───────────── Auto edit: AutoEditPanel.tsx (phase 2) ───────────── */

/* ───────────── Music ───────────── */

export function MusicPanel({ ctx }: { ctx: PanelCtx }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [license, setLicense] = useState("");
  const m = ctx.project.music;
  const setMusic = (patch: Partial<NonNullable<VideoProject["music"]>>, step: "patch" | "commit") => (step === "commit" ? ctx.commit : ctx.patch)((p) => (p.music ? { ...p, music: { ...p.music, ...patch } } : p));
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Music</span>
      <MusicSourcePanel ctx={ctx} />
      <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void ctx.music.pick(f, license); e.target.value = ""; }} />
      {!m ? (
        <>
          <p className="ts-hint">A track from this computer (mp3, m4a or wav), mixed with the clips' own sound (each clip's volume is under Media). Use music you have the rights to: this is not Instagram's music library. Instagram's own music can only be added in the Instagram app when posting.</p>
          {ctx.music.keeps && (
            <label className="ve-stack">
              <span>Licence (who cleared it, under what)</span>
              <input type="text" maxLength={500} value={license} onChange={(e) => setLicense(e.target.value)} placeholder="e.g. Artlist licence #1234, cleared by Firas" />
            </label>
          )}
          <button type="button" className="ts-btn" disabled={ctx.readOnly || !!ctx.music.busy} onClick={() => fileRef.current?.click()}>
            {ctx.music.busy ? <Orb size={14} status={null} /> : <Music size={14} />} {ctx.music.busy || "Pick a track"}
          </button>
          {ctx.music.keeps && <p className="ts-hint">The track is kept with the post (under Audio), so the saved draft reopens with it.</p>}
          {ctx.music.tracks.length > 0 && (
            <>
              <span className="ts-group-title">The post's tracks</span>
              <ul className="ve-sources">
                {ctx.music.tracks.map((t) => (
                  <li key={t.id}>
                    <span className="ve-source-text">
                      <b>{t.name}</b>
                      <small>{t.license || "no licence line"}</small>
                    </span>
                    <button type="button" className="ts-mini" disabled={ctx.readOnly || !!ctx.music.busy || !t.url} onClick={() => void ctx.music.choose(t)}>
                      <Plus size={12} /> Use
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          <p className="ve-clip-name">
            <Music size={13} /> {ctx.music.name ?? (m.source.kind === "upload" ? m.source.name : "Track")}
            {ctx.music.duration ? ` · ${fmt(ctx.music.duration)}` : ""}
          </p>
          {!ctx.music.name && <p className="ts-hint warn">{m.source.kind === "audioKey" ? "The track could not be read back from the post. Pick it again under Change track." : m.source.kind === "catalog" || m.source.kind === "library" ? "The track could not be read from the music library. Pick it again from the library." : "The track's file is not in this tab (it was not kept with the post). Pick it again to hear it and to render with it."}</p>}
          <MusicMixControls ctx={ctx} music={m} setMusic={setMusic} />
          <div className="ve-actions">
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

/* ───────────── Export ───────────── */

const PHASE_TEXT: Record<ExportProgress["phase"], string> = {
  checking: "Checking this browser",
  reading: "Reading the footage",
  sound: "Mixing the sound",
  audio: "Encoding audio…",
  frames: "Rendering the frames",
  finishing: "Finishing the file",
};

const STATUS_LINE: Record<RenderItem["status"], string> = {
  rendering: "Rendering",
  uploading: "Uploading",
  done: "Rendered",
  failed: "Failed",
  interrupted: "Interrupted",
};

export function ExportPanel({ ctx }: { ctx: PanelCtx }) {
  const o = ctx.project.output;
  const length = totalLength(ctx.project);
  const bitrate = BITRATE_PRESETS.find((b) => b.bps === o.bitrate)?.id ?? "custom";
  const x = ctx.exporting;
  const busy = !!x.progress || x.running;
  const last = x.renders[0] ?? null;
  const review = x.renders.find((r) => r.status === "done" && r.outcome === "review" && r.videoId && r.videoId !== x.clientId) ?? null;
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Frame</span>
      <fieldset className="ve-fields" disabled={ctx.readOnly || busy}>
        <div className="ve-frames">
          {FRAMES.map((f) => (
            <button key={f.id} type="button" className={`ve-frame-pick ${ctx.framing.frame === f.id ? "on" : ""}`} onClick={() => ctx.framing.setFrame(f.id)} title={f.hint} aria-pressed={ctx.framing.frame === f.id}>
              <i style={{ aspectRatio: `${f.w} / ${f.h}` }} aria-hidden />
              <span>{frameLabel(f.id)}</span>
            </button>
          ))}
        </div>
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
          {o.width}×{o.height} · {fmt(length)} · {o.fps} fps · H.264 + AAC · about {formatBytes(estimateBytes(o, length))}
        </p>
      </fieldset>
      {!x.canExport && x.capsMessage ? (
        <p className="ve-stop">{x.capsMessage}</p>
      ) : (
        <button type="button" className="ts-btn primary" disabled={ctx.readOnly || busy || length <= 0} onClick={() => void x.run()}>
          <Download size={14} /> {x.standalone ? "Render to a file" : last?.status === "interrupted" || last?.status === "failed" ? "Render again" : "Render & update card"}
        </button>
      )}
      {x.canExport && x.capsNotice && <p className="ts-hint">{x.capsNotice}</p>}
      {!x.standalone && x.chip && <p className="ve-render-state">{x.chip}</p>}
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
      {x.error && <p className="ts-hint warn">Render failed: {x.error}</p>}
      {x.result && <p className="ve-done">{x.result}</p>}
      {review && review.videoId && (
        <div className="ve-review">
          <p>The client approved the version they see, so {x.videoLabel(review.videoId)} is on the card but not on the client's link yet.</p>
          <button type="button" className="ts-btn" disabled={ctx.readOnly} onClick={() => void x.sendForReview(review.videoId!)}>
            <Send size={14} /> Send for review (make it the client's version)
          </button>
        </div>
      )}
      {last?.status === "interrupted" && <p className="ts-hint warn">The last render stopped when its tab closed or went to sleep. Rendering happens in the browser and cannot continue without the tab: press Render again and keep this tab open.</p>}
      {!x.standalone && x.renders.length > 0 && (
        <>
          <span className="ts-group-title">Renders</span>
          <ul className="ve-renders">
            {x.renders.map((r) => (
              <li key={r.id} className={r.status}>
                <span>
                  <b>{STATUS_LINE[r.status]}</b> · save {r.projectRev}
                  {r.status === "rendering" || r.status === "uploading" ? ` · ${Math.round(r.progress * 100)}%` : ""}
                  {r.width && r.height ? ` · ${r.width}×${r.height}` : ""}
                  {r.duration ? ` · ${r.duration.toFixed(1)} s` : ""}
                </span>
                <small>
                  {new Date(r.created).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {r.videoId ? ` · ${x.videoLabel(r.videoId)}` : ""}
                  {r.outcome === "card" ? " · on the card" : r.outcome === "review" ? " · on the card, waiting for review" : r.outcome === "superseded" ? " · kept as a version (a newer one is on the card)" : ""}
                  {r.error ? ` · ${r.error}` : ""}
                </small>
                {(r.status === "interrupted" || r.status === "failed") && r === last && (
                  <button type="button" className="ts-mini" disabled={ctx.readOnly || busy} onClick={() => void x.run()}>
                    <RotateCcw size={12} /> Render again
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {!x.standalone && <p className="ts-hint">“Save draft” keeps the editable project; “Render & update card” makes a new version from the saved draft and, once it is uploaded, the card plays it (and the client's link, unless the client approved the version they see). Earlier versions stay under Versions.</p>}
      <p className="ts-hint">Rendered here in your browser, frame by frame: about real time on a laptop, longer on a phone. Keep this tab open until it finishes; the card keeps its current video meanwhile. The file plays on iPhone and uploads to Instagram as it is.</p>
      {ctx.reason && <p className="ts-hint warn">{ctx.reason}</p>}
    </div>
  );
}
