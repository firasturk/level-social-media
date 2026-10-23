/**
 * The timeline (phase 2): a toolbar (split, ripple delete and delete-leaving-a-gap, lock, snapping,
 * zoom out / fit / in, the timecode in mm:ss:ff at 30 fps, frame steps), a ruler with the beat
 * markers, and five labelled lanes: Video (clips), Text, Logo, Music and Voice.
 *
 * - Clips: click selects, shift-click extends, cmd/ctrl-click toggles; drag a clip (or the
 *   selection) to reorder; drag its ends to trim. Locked clips show a lock and cannot be dragged
 *   or trimmed; gaps show as empty stretches.
 * - Text and logo layers, the music and the voice-overs: drag to move, drag the ends to trim.
 * - Snapping (on by default, the magnet): to the playhead, the cuts, the beats and the edges of
 *   the text, logo, music and voice blocks, within a few pixels at any zoom. Hold Alt (Option)
 *   while dragging to place freely.
 * - Zoom: the buttons, ctrl/cmd + wheel or a trackpad pinch (around the pointer), a two-finger
 *   pinch on a touch screen; "Fit" shows the whole cut.
 * - Keyframes show as diamonds on their block; a click on one moves the playhead there.
 * Every drag is one undo step (mark, patch while dragging, commit at the end).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Diamond, Image as ImageIcon, Lock, Magnet, Maximize2, Mic, Music, Scissors, Trash2, Type, Unlock, Video, ZoomIn, ZoomOut } from "lucide-react";
import { clipLength, isGap, musicSpan, placeClips, totalLength, trimClip, type Clip, type VideoProject } from "@shared/video-project";
import type { Overlay } from "@shared/video-compose";
import { diamondTimes, dropIndexAt, fitPps, formatTimecode, moveClips, parseTimecode, SNAP_PX, snapSpan, snapTargets, snapTime, stepFrames, tickSpacing, zoomAround, ZOOM_STEP, type SnapTarget } from "@shared/video-timeline";
import "./timeline.css";

export interface TimelineProps {
  project: VideoProject;
  time: number;
  /** Beat times on the timeline, seconds. */
  beats: number[];
  /** The selected clips, in the order they were selected. */
  selection: string[];
  readOnly?: boolean;
  labelOf: (clip: Clip) => string;
  /** The selected text or logo layer, or voice-over. */
  selectedOverlay?: string | null;
  selectedVoice?: string | null;
  /** The music's name, when the cut has music. */
  musicName?: string | null;
  /** The voice-overs' names by id. */
  snapping: boolean;
  setSnapping: (on: boolean) => void;
  onClipClick: (id: string, mods: { shift: boolean; toggle: boolean }) => void;
  onClearSelection: () => void;
  onSelectOverlay: (id: string) => void;
  onSelectVoice: (id: string) => void;
  onSelectMusic: () => void;
  onSeek: (t: number) => void;
  mark: () => void;
  patch: (fn: (p: VideoProject) => VideoProject) => void;
  commit: (fn: (p: VideoProject) => VideoProject) => void;
  onSplit: () => void;
  onDelete: (ripple: boolean) => void;
  onToggleLock: () => void;
}

type Drag =
  | { kind: "trim"; id: string; edge: "in" | "out"; x0: number; clip: Clip; start: number }
  | { kind: "clip"; id: string; x0: number; moved: boolean; ids: string[]; t: number; mods: { shift: boolean; toggle: boolean } }
  | { kind: "overlay"; id: string; edge: "move" | "start" | "end"; x0: number; o: Overlay }
  | { kind: "music"; edge: "move" | "start" | "end"; x0: number; start: number; end: number; offset: number }
  | { kind: "voice"; id: string; edge: "move" | "start" | "end"; x0: number; start: number; in: number; out: number; duration: number }
  | { kind: "scrub" };

const LANES: { id: string; label: string; icon: ReactNode }[] = [
  { id: "video", label: "Video", icon: <Video size={12} /> },
  { id: "text", label: "Text", icon: <Type size={12} /> },
  { id: "logo", label: "Logo", icon: <ImageIcon size={12} /> },
  { id: "music", label: "Music", icon: <Music size={12} /> },
  { id: "voice", label: "Voice", icon: <Mic size={12} /> },
];

const fmtTick = (s: number, spacing: number) => (spacing < 1 ? formatTimecode(s).slice(3) : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)}s`);

export default function Timeline(props: TimelineProps) {
  const { project, time, beats, selection, readOnly, labelOf, selectedOverlay, selectedVoice, musicName, snapping, setSnapping } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [pps, setPps] = useState(40);
  const [fit, setFit] = useState(true);
  const [snapLine, setSnapLine] = useState<SnapTarget | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [tcText, setTcText] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ d: number; pps: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const length = totalLength(project);
  // "Fit" follows the cut's length and the lane's width until the person zooms.
  useLayoutEffect(() => {
    if (fit) setPps(fitPps(width - 16, length));
  }, [fit, width, length]);
  const span = Math.max(length * 1.05, width / pps, 5);
  const inner = span * pps;
  const x = (t: number) => t * pps;
  const placed = useMemo(() => placeClips(project.clips), [project.clips]);

  // Keep the playhead in view while playing or stepping.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || fit) return;
    const px = x(time);
    if (px < el.scrollLeft + 20 || px > el.scrollLeft + el.clientWidth - 20) el.scrollLeft = Math.max(0, px - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, fit]);

  const zoom = (factor: number, anchorX?: number) => {
    const el = scrollRef.current;
    const ax = anchorX ?? (el ? x(time) - el.scrollLeft : 0);
    const next = zoomAround({ pps, scroll: el?.scrollLeft ?? 0 }, factor, Math.max(0, ax));
    setFit(false);
    setPps(next.pps);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = next.scroll;
    });
  };

  // ctrl/cmd + wheel (and a trackpad pinch, which the browser reports the same way) zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / pps);
  };
  const tolerance = (e: { altKey: boolean }) => (snapping && !e.altKey ? SNAP_PX / pps : 0);
  const targets = (exclude: string[]) => snapTargets(project, { playhead: time, beats, exclude: new Set(exclude) });

  /* ───────────── Pointer handling for every drag ───────────── */
  const begin = (e: ReactPointerEvent, d: Drag) => {
    e.stopPropagation();
    if (d.kind !== "scrub" && readOnly) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = d;
    if (d.kind !== "clip" && d.kind !== "scrub") props.mark();
  };

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const tol = tolerance(e);
    if (d.kind === "scrub") {
      props.onSeek(Math.min(length, timeAt(e.clientX)));
      return;
    }
    const dt = (e.clientX - ("x0" in d ? d.x0 : 0)) / pps;
    if (d.kind === "trim") {
      // The clip's end on the timeline is what moves (the clips after it follow); it snaps.
      const c = d.clip;
      const proposed = d.edge === "in" ? trimClip(c, { in: c.in + dt * c.speed }) : trimClip(c, { out: c.out + dt * c.speed });
      const end = d.start + clipLength(proposed);
      const s = snapTime(end, targets([c.id]), tol);
      let next = proposed;
      if (s.target) next = d.edge === "in" ? trimClip(c, { in: c.out - (s.t - d.start) * c.speed }) : trimClip(c, { out: c.in + (s.t - d.start) * c.speed });
      setSnapLine(s.target);
      props.patch((p) => ({ ...p, clips: p.clips.map((x) => (x.id === c.id ? { ...x, in: next.in, out: next.out } : x)) }));
    } else if (d.kind === "clip") {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 5) return;
      d.moved = true;
      d.t = timeAt(e.clientX);
      setDropAt(dropIndexAt(project.clips, d.t));
    } else if (d.kind === "overlay") {
      const o = d.o;
      const T = targets([o.id]);
      if (d.edge === "move") {
        const s = snapSpan(Math.max(0, o.start + dt), o.end - o.start, T, tol);
        const start = Math.max(0, s.start);
        setSnapLine(s.target);
        props.patch((p) => ({ ...p, overlays: p.overlays.map((x) => (x.id === o.id ? ({ ...x, start, end: start + (o.end - o.start) } as Overlay) : x)) }));
      } else {
        const raw = d.edge === "start" ? o.start + dt : o.end + dt;
        const s = snapTime(raw, T, tol);
        setSnapLine(s.target);
        const start = d.edge === "start" ? Math.max(0, Math.min(s.t, o.end - 0.1)) : o.start;
        const end = d.edge === "end" ? Math.max(s.t, o.start + 0.1) : o.end;
        props.patch((p) => ({ ...p, overlays: p.overlays.map((x) => (x.id === o.id ? ({ ...x, start, end } as Overlay) : x)) }));
      }
    } else if (d.kind === "music") {
      const T = targets(["music"]);
      let { start, end, offset } = d;
      if (d.edge === "move") {
        const s = snapSpan(Math.max(0, d.start + dt), d.end - d.start, T, tol);
        start = Math.max(0, s.start);
        end = start + (d.end - d.start);
        setSnapLine(s.target);
      } else if (d.edge === "start") {
        // Trimming the head keeps the music where it was: the track starts later by the same amount.
        const s = snapTime(Math.max(0, d.start + dt), T, tol);
        start = Math.min(Math.max(0, s.t, d.start - d.offset), d.end - 0.5);
        offset = d.offset + (start - d.start);
        setSnapLine(s.target);
      } else {
        const s = snapTime(d.end + dt, T, tol);
        end = Math.max(d.start + 0.5, s.t);
        setSnapLine(s.target);
      }
      props.patch((p) => (p.music ? { ...p, music: { ...p.music, start, end, offset: Math.max(0, offset) } } : p));
    } else if (d.kind === "voice") {
      const T = targets([d.id]);
      let { start, in: inPt, out } = d;
      if (d.edge === "move") {
        const s = snapSpan(Math.max(0, d.start + dt), d.out - d.in, T, tol);
        start = Math.max(0, s.start);
        setSnapLine(s.target);
      } else if (d.edge === "start") {
        const s = snapTime(d.start + dt, T, tol);
        const shift = Math.min(Math.max(s.t - d.start, -d.in), d.out - d.in - 0.25);
        start = d.start + shift;
        inPt = d.in + shift;
        setSnapLine(s.target);
      } else {
        const s = snapTime(d.start + (d.out - d.in) + dt, T, tol);
        out = Math.min(d.duration, Math.max(d.in + 0.25, d.in + (s.t - d.start)));
        setSnapLine(s.target);
      }
      props.patch((p) => ({ ...p, voices: p.voices.map((v) => (v.id === d.id ? { ...v, start, in: inPt, out } : v)) }));
    }
  };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    setSnapLine(null);
    setDropAt(null);
    if (!d || d.kind === "scrub") return;
    if (d.kind === "clip") {
      if (!d.moved) {
        props.onClipClick(d.id, d.mods);
        return;
      }
      const to = dropIndexAt(project.clips, d.t);
      props.commit((p) => ({ ...p, clips: moveClips(p.clips, d.ids, to) }));
      return;
    }
    props.commit((p) => p);
  };

  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  /* ───────────── Pinch on a touch screen ───────────── */
  const onTouchDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch") return;
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.max(10, Math.abs(a - b)), pps };
      drag.current = null;
    }
  };
  const onTouchMove = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch" || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e.clientX);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const factor = (Math.max(10, Math.abs(a - b)) / pinch.current.d) * (pinch.current.pps / pps);
      const rect = scrollRef.current!.getBoundingClientRect();
      if (Math.abs(factor - 1) > 0.02) zoom(factor, (a + b) / 2 - rect.left);
    }
  };
  const onTouchUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  /* ───────────── Pieces ───────────── */
  const spacing = tickSpacing(pps);
  const ticks: number[] = [];
  for (let t = 0; t <= span + 1e-9; t += spacing) ticks.push(Math.round(t * 1000) / 1000);
  const texts = project.overlays.filter((o) => o.kind === "text");
  const logos = project.overlays.filter((o) => o.kind === "logo");
  const sel = new Set(selection);
  const diamonds = (start: number, endT: number, kf: Clip["keyframes"]) =>
    diamondTimes(start, kf, endT).map((t) => (
      <button
        key={`k${t}`}
        type="button"
        className="ve-diamond"
        style={{ left: x(t - start) }}
        title={`Keyframe at ${formatTimecode(t)}`}
        aria-label={`Keyframe at ${formatTimecode(t)}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.onSeek(t);
        }}
      >
        <Diamond size={9} />
      </button>
    ));
  const edges = (onDown: (e: ReactPointerEvent, edge: "start" | "end") => void) =>
    !readOnly && (
      <>
        <span className="ve-handle in" role="separator" aria-label="Trim start" onPointerDown={(e) => onDown(e, "start")} {...handlers} />
        <span className="ve-handle out" role="separator" aria-label="Trim end" onPointerDown={(e) => onDown(e, "end")} {...handlers} />
      </>
    );
  const layerBlock = (o: Overlay) => (
    <div
      key={o.id}
      className={`ve-layer-block ${o.kind} ${selectedOverlay === o.id ? "on" : ""}`}
      style={{ left: x(o.start), width: Math.max(10, x(o.end - o.start)) }}
      title={`${o.kind === "text" ? o.text : o.name} · ${formatTimecode(o.start)}–${formatTimecode(o.end)}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") props.onSelectOverlay(o.id);
      }}
      onPointerDown={(e) => {
        props.onSelectOverlay(o.id);
        begin(e, { kind: "overlay", id: o.id, edge: "move", x0: e.clientX, o });
      }}
      {...handlers}
      dir="auto"
    >
      {o.kind === "text" ? <Type size={11} /> : <ImageIcon size={11} />} <span>{o.kind === "text" ? (o.second ? `${o.text} · ${o.second}` : o.text) : o.name}</span>
      {diamonds(o.start, o.end, o.keyframes)}
      {edges((e, edge) => {
        props.onSelectOverlay(o.id);
        begin(e, { kind: "overlay", id: o.id, edge, x0: e.clientX, o });
      })}
    </div>
  );

  const m = project.music;
  const ms = m ? musicSpan(m, length) : null;
  const tcValue = tcText ?? formatTimecode(time);
  const canEdit = !readOnly && project.clips.length > 0;
  const selectedClips = project.clips.filter((c) => sel.has(c.id));
  const allLocked = selectedClips.length > 0 && selectedClips.every((c) => c.locked);

  return (
    <div className="ve-timeline ve-tl2">
      <div className="ve-tl-bar" role="toolbar" aria-label="Timeline">
        <span className="ve-tl-group">
          <button type="button" className="ts-icon" onClick={props.onSplit} disabled={!canEdit} title="Split at the playhead (S)" aria-label="Split at the playhead">
            <Scissors size={14} />
          </button>
          <button type="button" className="ts-icon" onClick={() => props.onDelete(true)} disabled={!canEdit || !selection.length} title="Delete and close the gap (Delete)" aria-label="Ripple delete">
            <Trash2 size={14} />
            <small>Ripple</small>
          </button>
          <button type="button" className="ts-icon" onClick={() => props.onDelete(false)} disabled={!canEdit || !selection.length} title="Delete and leave a gap (Shift + Delete)" aria-label="Delete, leave a gap">
            <Trash2 size={14} />
            <small>Gap</small>
          </button>
          <button type="button" className={`ts-icon ${allLocked ? "on" : ""}`} onClick={props.onToggleLock} disabled={!canEdit || !selection.length} title="Lock: auto edit, beat alignment and dragging never move a locked clip (L)" aria-label={allLocked ? "Unlock" : "Lock"} aria-pressed={allLocked}>
            {allLocked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
        </span>
        <span className="ve-tl-group">
          <button type="button" className={`ts-icon ${snapping ? "on" : ""}`} onClick={() => setSnapping(!snapping)} aria-pressed={snapping} title={snapping ? "Snapping on: to the playhead, cuts, beats and the text, logo, music and voice edges (hold Alt to place freely)" : "Snapping off"} aria-label="Snapping">
            <Magnet size={14} />
          </button>
          <button type="button" className="ts-icon" onClick={() => zoom(1 / ZOOM_STEP)} title="Zoom out (or ctrl + wheel, or pinch)" aria-label="Zoom out">
            <ZoomOut size={14} />
          </button>
          <button type="button" className={`ts-icon ${fit ? "on" : ""}`} onClick={() => setFit(true)} title="Fit the whole cut" aria-label="Zoom to fit" aria-pressed={fit}>
            <Maximize2 size={14} />
          </button>
          <button type="button" className="ts-icon" onClick={() => zoom(ZOOM_STEP)} title="Zoom in (or ctrl + wheel, or pinch)" aria-label="Zoom in">
            <ZoomIn size={14} />
          </button>
        </span>
        <span className="ve-tl-group ve-tl-time">
          <button type="button" className="ts-icon" onClick={() => props.onSeek(stepFrames(time, -1, length))} title="One frame back (←)" aria-label="One frame back">
            <ChevronLeft size={14} />
          </button>
          <input
            className="ve-tc"
            value={tcValue}
            aria-label="Timecode (minutes:seconds:frames at 30 fps)"
            title="Minutes : seconds : frames (30 fps). Type a time and press Enter."
            onFocus={() => setTcText(formatTimecode(time))}
            onChange={(e) => setTcText(e.target.value)}
            onBlur={() => setTcText(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const t = parseTimecode(tcValue);
                if (t !== null) props.onSeek(Math.min(length, t));
                setTcText(null);
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setTcText(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <button type="button" className="ts-icon" onClick={() => props.onSeek(stepFrames(time, 1, length))} title="One frame on (→)" aria-label="One frame on">
            <ChevronRight size={14} />
          </button>
          <small className="ve-tl-len">/ {formatTimecode(length)}</small>
        </span>
        {selection.length > 1 && <span className="ve-tl-count">{selection.length} clips selected</span>}
      </div>
      <div className="ve-tl-body">
        <div className="ve-tl-labels" aria-hidden>
          <span className="ve-tl-label ruler" />
          {LANES.map((l) => (
            <span key={l.id} className={`ve-tl-label ${l.id}`}>
              {l.icon} <span>{l.label}</span>
            </span>
          ))}
        </div>
        <div className="ve-tl-scroll" ref={scrollRef} onPointerDownCapture={onTouchDown} onPointerMoveCapture={onTouchMove} onPointerUpCapture={onTouchUp} onPointerCancelCapture={onTouchUp}>
          <div className="ve-tl-inner" style={{ width: inner }}>
            <div
              className="ve-ruler"
              role="slider"
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(length * 30) / 30}
              aria-valuenow={Math.round(time * 30) / 30}
              aria-valuetext={formatTimecode(time)}
              tabIndex={0}
              onPointerDown={(e) => {
                begin(e, { kind: "scrub" });
                props.onSeek(Math.min(length, timeAt(e.clientX)));
              }}
              {...handlers}
            >
              {ticks.map((t) => (
                <span key={t} className="ve-tick" style={{ left: x(t) }}>
                  {fmtTick(t, spacing)}
                </span>
              ))}
              {beats.map((b, i) => (
                <span key={`b${i}`} className="ve-beat" style={{ left: x(b) }} aria-hidden />
              ))}
            </div>
            {/* Video */}
            <div
              className="ve-tl-lane video"
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                props.onClearSelection();
                props.onSeek(Math.min(length, timeAt(e.clientX)));
              }}
            >
              {placed.map((pl) => {
                const c = pl.clip;
                const gap = isGap(c);
                return (
                  <div
                    key={c.id}
                    className={`ve-clip ${sel.has(c.id) ? "on" : ""} ${pl.overlap > 0 ? "xfade" : ""} ${gap ? "gap" : ""} ${c.locked ? "locked" : ""} ${c.transition === "dipBlack" || c.transition === "dipWhite" ? c.transition : ""}`}
                    style={{ left: x(pl.start), width: Math.max(8, x(pl.end - pl.start)) }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel.has(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") props.onClipClick(c.id, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
                    }}
                    title={`${gap ? "Gap" : labelOf(c)} · ${formatTimecode(pl.start)}–${formatTimecode(pl.end)}${c.speed !== 1 ? ` · ×${c.speed}` : ""}${c.muted ? " · muted" : c.volume !== undefined && c.volume !== 1 ? ` · sound ${Math.round(c.volume * 100)}%` : ""}${c.speech ? " · has speech" : ""}${c.locked ? " · locked" : ""}`}
                    onPointerDown={(e) => {
                      const mods = { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey };
                      props.onSeek(Math.min(length, timeAt(e.clientX)));
                      if (readOnly || c.locked) {
                        e.stopPropagation();
                        props.onClipClick(c.id, mods);
                        return;
                      }
                      const ids = sel.has(c.id) && !mods.shift && !mods.toggle ? project.clips.filter((x) => sel.has(x.id) && !x.locked).map((x) => x.id) : [c.id];
                      begin(e, { kind: "clip", id: c.id, x0: e.clientX, moved: false, ids, t: 0, mods });
                    }}
                    {...handlers}
                  >
                    {pl.overlap > 0 && <span className="ve-xfade" style={{ width: x(pl.overlap) }} aria-hidden />}
                    <span className="ve-clip-label">
                      {c.locked && <Lock size={10} />} {gap ? "Gap" : labelOf(c)}
                      {c.speed !== 1 ? ` ×${c.speed}` : ""}
                      {c.muted ? " · muted" : ""}
                      {c.speech ? " · speech" : ""}
                    </span>
                    {diamonds(pl.start, pl.end, c.keyframes)}
                    {!readOnly && !c.locked && (
                      <>
                        <span className="ve-handle in" role="separator" aria-label="Trim start" onPointerDown={(e) => begin(e, { kind: "trim", id: c.id, edge: "in", x0: e.clientX, clip: c, start: pl.start })} {...handlers} />
                        <span className="ve-handle out" role="separator" aria-label="Trim end" onPointerDown={(e) => begin(e, { kind: "trim", id: c.id, edge: "out", x0: e.clientX, clip: c, start: pl.start })} {...handlers} />
                      </>
                    )}
                  </div>
                );
              })}
              {dropAt !== null && <span className="ve-drop" style={{ left: x(dropAt < placed.length ? placed[dropAt].start : length) }} aria-hidden />}
              {!placed.length && <span className="ve-empty">Add a clip from the Media panel, or let Auto edit build a first cut.</span>}
            </div>
            <div className="ve-tl-lane text">{texts.map(layerBlock)}</div>
            <div className="ve-tl-lane logo">{logos.map(layerBlock)}</div>
            <div className="ve-tl-lane music">
              {m && ms && (
                <div
                  className={`ve-music-block ${ms.end <= ms.start ? "empty" : ""}`}
                  style={{ left: x(ms.start), width: Math.max(10, x(ms.end - ms.start)) }}
                  title={`${musicName ?? "Music"} · ${formatTimecode(ms.start)}–${formatTimecode(ms.end)} · from ${m.offset.toFixed(1)} s in the track`}
                  onPointerDown={(e) => {
                    props.onSelectMusic();
                    begin(e, { kind: "music", edge: "move", x0: e.clientX, start: ms.start, end: ms.end, offset: m.offset });
                  }}
                  {...handlers}
                >
                  <Music size={11} /> <span>{musicName ?? "Music"}</span>
                  {m.fadeIn > 0 && <span className="ve-fade in" style={{ width: x(Math.min(m.fadeIn, ms.end - ms.start)) }} aria-hidden />}
                  {m.fadeOut > 0 && <span className="ve-fade out" style={{ width: x(Math.min(m.fadeOut, ms.end - ms.start)) }} aria-hidden />}
                  {edges((e, edge) => {
                    props.onSelectMusic();
                    begin(e, { kind: "music", edge, x0: e.clientX, start: ms.start, end: ms.end, offset: m.offset });
                  })}
                </div>
              )}
              {beats.map((b, i) => (
                <span key={`m${i}`} className="ve-beat" style={{ left: x(b) }} aria-hidden />
              ))}
            </div>
            <div className="ve-tl-lane voice">
              {project.voices.map((v) => (
                <div
                  key={v.id}
                  className={`ve-voice-block ${selectedVoice === v.id ? "on" : ""}`}
                  style={{ left: x(v.start), width: Math.max(10, x(v.out - v.in)) }}
                  title={`${v.name} · ${formatTimecode(v.start)}–${formatTimecode(v.start + v.out - v.in)} · ${Math.round(v.volume * 100)}%`}
                  onPointerDown={(e) => {
                    props.onSelectVoice(v.id);
                    begin(e, { kind: "voice", id: v.id, edge: "move", x0: e.clientX, start: v.start, in: v.in, out: v.out, duration: v.duration });
                  }}
                  {...handlers}
                >
                  <Mic size={11} /> <span>{v.name}</span>
                  {edges((e, edge) => {
                    props.onSelectVoice(v.id);
                    begin(e, { kind: "voice", id: v.id, edge, x0: e.clientX, start: v.start, in: v.in, out: v.out, duration: v.duration });
                  })}
                </div>
              ))}
            </div>
            {snapLine && <span className={`ve-snapline ${snapLine.kind}`} style={{ left: x(snapLine.t) }} aria-hidden />}
            <span className="ve-playhead" style={{ left: x(time) }} aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}
