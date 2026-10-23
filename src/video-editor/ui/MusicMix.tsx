/**
 * The music's mix controls and the voice-over (phase 2), shown in the Music tab under the track
 * picker (which stays as it is): where the music starts and stops on the timeline and from which
 * second of the track, its volume and fades, ducking under speech, the beats with "Align cuts to
 * beats"; then the Voice lane's recordings, each with its place and volume.
 *
 * Honest wording: a track picked here is the studio's file, mixed into the render. It is not
 * Instagram's music; Instagram's own music can only be added in the Instagram app when posting.
 */
import { useRef } from "react";
import { Mic, Sparkles, Trash2, Upload } from "lucide-react";
import { Orb } from "@/components/Orb";
import { DEFAULT_DUCKING, musicSpan, totalLength, type Music } from "@shared/video-project";
import { formatTimecode } from "@shared/video-timeline";
import type { PanelCtx } from "./Panels";

export interface VoiceCtx {
  busy: string;
  /** A recording from this computer, added at the playhead. */
  add: (file: File) => Promise<void>;
  remove: (id: string) => void;
  selected: string | null;
  select: (id: string | null) => void;
  /** The recording's sound is in this tab (else it must be picked again to hear and render it). */
  loaded: (id: string) => boolean;
}

const fmt = (s: number) => `${s.toFixed(1)}s`;

export function MusicMixControls({ ctx, music: m, setMusic }: { ctx: PanelCtx; music: Music; setMusic: (patch: Partial<Music>, step: "patch" | "commit") => void }) {
  const length = totalLength(ctx.project);
  const span = musicSpan(m, length);
  const duck = m.duck ?? DEFAULT_DUCKING;
  const end = () => ctx.commit((p) => p);
  const trackLen = ctx.music.duration || m.duration || 60;
  return (
    <>
      <span className="ts-group-title">On the timeline</span>
      <p className="ts-hint">
        Plays {formatTimecode(span.start)} – {formatTimecode(span.end)}. Drag the music block's ends on the Music lane to trim it, or its middle to move it.
      </p>
      <label className="ts-slider">
        <span>
          Starts on the timeline at <em>{fmt(span.start)}</em>
        </span>
        <input type="range" min={0} max={Math.max(0, length - 0.5)} step={0.1} value={span.start} onPointerDown={ctx.mark} onChange={(e) => setMusic({ start: Number(e.target.value), end: m.end !== undefined ? Math.max(Number(e.target.value) + 0.5, m.end) : undefined }, "patch")} onPointerUp={end} />
      </label>
      <label className="ts-slider">
        <span>
          Stops at <em>{m.end === undefined ? "the end" : fmt(span.end)}</em>
        </span>
        <input type="range" min={0} max={Math.max(0.5, length)} step={0.1} value={m.end ?? length} onPointerDown={ctx.mark} onChange={(e) => setMusic({ end: Number(e.target.value) >= length - 0.05 ? undefined : Math.max(span.start + 0.5, Number(e.target.value)) }, "patch")} onPointerUp={end} />
      </label>
      <label className="ts-slider">
        <span>
          From this second of the track <em>{fmt(m.offset)}</em>
        </span>
        <input type="range" min={0} max={Math.max(0, trackLen - 1)} step={0.1} value={m.offset} onPointerDown={ctx.mark} onChange={(e) => setMusic({ offset: Number(e.target.value) }, "patch")} onPointerUp={end} />
      </label>
      <span className="ts-group-title">Level</span>
      <label className="ts-slider">
        <span>
          Music volume <em>{Math.round(m.volume * 100)}%</em>
        </span>
        <input type="range" min={0} max={1} step={0.05} value={m.volume} onPointerDown={ctx.mark} onChange={(e) => setMusic({ volume: Number(e.target.value) }, "patch")} onPointerUp={end} />
      </label>
      <label className="ts-slider">
        <span>
          Fade in <em>{fmt(m.fadeIn)}</em>
        </span>
        <input type="range" min={0} max={5} step={0.1} value={m.fadeIn} onPointerDown={ctx.mark} onChange={(e) => setMusic({ fadeIn: Number(e.target.value) }, "patch")} onPointerUp={end} />
      </label>
      <label className="ts-slider">
        <span>
          Fade out <em>{fmt(m.fadeOut)}</em>
        </span>
        <input type="range" min={0} max={5} step={0.1} value={m.fadeOut} onPointerDown={ctx.mark} onChange={(e) => setMusic({ fadeOut: Number(e.target.value) }, "patch")} onPointerUp={end} />
      </label>
      <label className="ve-check">
        <input type="checkbox" checked={duck.enabled} onChange={(e) => setMusic({ duck: { ...duck, enabled: e.target.checked } }, "commit")} /> Duck under speech (clips marked “Has speech” and the voice-over)
      </label>
      {duck.enabled && (
        <label className="ts-slider">
          <span>
            Music under speech <em>{Math.round(duck.level * 100)}%</em>
          </span>
          <input type="range" min={0} max={1} step={0.05} value={duck.level} onPointerDown={ctx.mark} onChange={(e) => setMusic({ duck: { ...duck, level: Number(e.target.value) } }, "patch")} onPointerUp={end} />
        </label>
      )}
      <p className="ts-hint">The clips' own sound plays with the music at each clip's volume (Media). The preview plays the same levels, fades and ducking as the render.</p>
      <span className="ts-group-title">Beats</span>
      <p className="ts-hint">{ctx.music.beats ? `${ctx.music.beats} beats found from the track's pulses; they show as markers on the ruler and the Music lane, and edges snap to them.` : ctx.music.busy || "No clear pulse found in this track."}</p>
      <div className="ve-actions">
        <button type="button" className="ts-mini" disabled={!ctx.music.beats || ctx.project.clips.length < 2} onClick={ctx.music.align} title="Move every cut within a quarter second of a beat onto it, keeping the cut's length; locked clips and speech are not touched">
          <Sparkles size={12} /> Align cuts to beats
        </button>
      </div>
    </>
  );
}

/** The Voice lane: recordings from this computer, each at a place on the timeline with its own volume. */
export function VoicePanel({ ctx }: { ctx: PanelCtx }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const v = ctx.voice;
  const sel = ctx.project.voices.find((x) => x.id === v.selected) ?? null;
  const set = (id: string, patch: Partial<(typeof ctx.project.voices)[number]>, step: "patch" | "commit") => (step === "commit" ? ctx.commit : ctx.patch)((p) => ({ ...p, voices: p.voices.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  return (
    <div className="ve-panel">
      <span className="ts-group-title">Voice-over</span>
      <p className="ts-hint">A recording from this computer (mp3, m4a or wav) on its own lane, at the playhead. The music ducks under it.</p>
      <input ref={fileRef} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void v.add(f); e.target.value = ""; }} />
      <button type="button" className="ts-btn" disabled={ctx.readOnly || !!v.busy || ctx.project.voices.length >= 8} onClick={() => fileRef.current?.click()}>
        {v.busy ? <Orb size={14} status={null} /> : <Upload size={14} />} {v.busy || "Add a voice-over"}
      </button>
      {ctx.project.voices.length > 0 && (
        <ul className="ve-layers">
          {ctx.project.voices.map((x) => (
            <li key={x.id}>
              <button type="button" className={v.selected === x.id ? "on" : ""} onClick={() => v.select(x.id)}>
                <Mic size={12} /> <span>{x.name}</span>
                <small>
                  {formatTimecode(x.start)} · {fmt(x.out - x.in)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sel && (
        <fieldset className="ve-fields" disabled={ctx.readOnly}>
          {!v.loaded(sel.id) && <p className="ts-hint warn">This recording's sound is not in this tab. Add it again to hear it and to render with it.</p>}
          <label className="ts-slider">
            <span>
              Starts at <em>{formatTimecode(sel.start)}</em>
            </span>
            <input type="range" min={0} max={Math.max(0.5, totalLength(ctx.project))} step={1 / 30} value={sel.start} onPointerDown={ctx.mark} onChange={(e) => set(sel.id, { start: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <label className="ts-slider">
            <span>
              Voice volume <em>{Math.round(sel.volume * 100)}%</em>
            </span>
            <input type="range" min={0} max={1} step={0.05} value={sel.volume} onPointerDown={ctx.mark} onChange={(e) => set(sel.id, { volume: Number(e.target.value) }, "patch")} onPointerUp={() => ctx.commit((p) => p)} />
          </label>
          <p className="ts-hint">Trim it by dragging its ends on the Voice lane.</p>
          <button type="button" className="ts-mini danger" onClick={() => v.remove(sel.id)}>
            <Trash2 size={12} /> Remove this voice-over
          </button>
        </fieldset>
      )}
    </div>
  );
}
