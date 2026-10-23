/**
 * The timeline: a ruler with the playhead, then one lane per kind of layer, labelled on the left
 * as in the studio's mock-up: Video (one block per clip, dragged at its ends to trim), Text and
 * Logo (the overlays, by their start and end; a click selects one and opens its panel) and Music
 * (the track under the whole cut, with the beat ticks). Trims are reported as mark / patch /
 * commit so a whole drag is one undo step. Reordering and splitting live in the Media panel and
 * the toolbar; the later timeline work (drag to move, snapping, zoom) builds on these lanes.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Image as ImageIcon, Music, Type, Video } from "lucide-react";
import { placeClips, totalLength, trimClip, type Clip, type VideoProject } from "@shared/video-project";

export interface TimelineProps {
  project: VideoProject;
  time: number;
  /** Beat times on the timeline, seconds. */
  beats: number[];
  selected: string | null;
  readOnly?: boolean;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onTrimStart: () => void;
  onTrim: (id: string, patch: { in?: number; out?: number }) => void;
  onTrimEnd: () => void;
  labelOf: (clip: Clip) => string;
  /** The selected text or logo layer. */
  selectedOverlay?: string | null;
  onSelectOverlay?: (id: string) => void;
  /** The music's name, when the cut has music. */
  musicName?: string | null;
}

const MIN_SPAN = 5;

function Lane({ label, icon, children, className = "" }: { label: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`ve-lane ${className}`}>
      <span className="ve-lane-label">
        {icon} {label}
      </span>
      <div className="ve-lane-body">{children}</div>
    </div>
  );
}

export default function Timeline({ project, time, beats, selected, readOnly, onSelect, onSeek, onTrimStart, onTrim, onTrimEnd, labelOf, selectedOverlay, onSelectOverlay, musicName }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const length = totalLength(project);
  const span = Math.max(MIN_SPAN, length * 1.05);
  const pxPerSec = width / span;
  const placed = placeClips(project.clips);
  const drag = useRef<{ id: string; edge: "in" | "out"; startX: number; clip: Clip } | null>(null);

  const seekFromEvent = (e: ReactPointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(length, (e.clientX - rect.left) / pxPerSec)));
  };

  const startTrim = (e: ReactPointerEvent<HTMLSpanElement>, clip: Clip, edge: "in" | "out") => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: clip.id, edge, startX: e.clientX, clip };
    onSelect(clip.id);
    onTrimStart();
  };
  const moveTrim = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const seconds = ((e.clientX - d.startX) / pxPerSec) * d.clip.speed;
    const next = d.edge === "in" ? trimClip(d.clip, { in: d.clip.in + seconds }) : trimClip(d.clip, { out: d.clip.out + seconds });
    onTrim(d.id, d.edge === "in" ? { in: next.in } : { out: next.out });
  };
  const endTrim = () => {
    if (!drag.current) return;
    drag.current = null;
    onTrimEnd();
  };

  const ticks: number[] = [];
  const tickEvery = span > 40 ? 10 : span > 16 ? 5 : span > 8 ? 2 : 1;
  for (let t = 0; t <= span; t += tickEvery) ticks.push(t);
  const texts = project.overlays.filter((o) => o.kind === "text");
  const logos = project.overlays.filter((o) => o.kind === "logo");
  const block = (o: (typeof project.overlays)[number]) => (
    <button
      key={o.id}
      type="button"
      className={`ve-layer-block ${o.kind} ${selectedOverlay === o.id ? "on" : ""}`}
      style={{ left: Math.min(o.start, span) * pxPerSec, width: Math.max(10, (Math.min(o.end, span) - Math.min(o.start, span)) * pxPerSec) }}
      title={`${o.kind === "text" ? o.text : o.name} · ${o.start.toFixed(1)}–${o.end.toFixed(1)}s`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => onSelectOverlay?.(o.id)}
      dir="auto"
    >
      {o.kind === "text" ? <Type size={11} /> : <ImageIcon size={11} />} <span>{o.kind === "text" ? o.text : o.name}</span>
    </button>
  );

  return (
    <div className="ve-timeline">
      <div className="ve-lane ve-lane-ruler">
        <span className="ve-lane-label" aria-hidden />
        <div className="ve-lane-body" ref={ref}>
          <div className="ve-ruler" onPointerDown={seekFromEvent} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.round(length * 10) / 10} aria-valuenow={Math.round(time * 10) / 10} tabIndex={0}>
            {ticks.map((t) => (
              <span key={t} className="ve-tick" style={{ left: t * pxPerSec }}>
                {t}s
              </span>
            ))}
            {beats.map((b, i) => (
              <span key={`b${i}`} className="ve-beat" style={{ left: b * pxPerSec }} aria-hidden />
            ))}
          </div>
          <span className="ve-playhead" style={{ left: time * pxPerSec }} aria-hidden />
        </div>
      </div>
      <Lane label="Video" icon={<Video size={12} />} className="video">
        <div className="ve-track" onPointerDown={(e) => { if (e.target === e.currentTarget) { onSelect(null); seekFromEvent(e); } }}>
          {placed.map((pl) => (
            <div
              key={pl.clip.id}
              className={`ve-clip ${selected === pl.clip.id ? "on" : ""} ${pl.overlap > 0 ? "xfade" : ""}`}
              style={{ left: pl.start * pxPerSec, width: Math.max(8, (pl.end - pl.start) * pxPerSec) }}
              title={`${labelOf(pl.clip)} · ${(pl.end - pl.start).toFixed(1)}s${pl.clip.speed !== 1 ? ` · ×${pl.clip.speed}` : ""}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(pl.clip.id);
                seekFromEvent(e);
              }}
            >
              {pl.overlap > 0 && <span className="ve-xfade" style={{ width: pl.overlap * pxPerSec }} aria-hidden />}
              <span className="ve-clip-label">
                {labelOf(pl.clip)}
                {pl.clip.speed !== 1 ? ` ×${pl.clip.speed}` : ""}
              </span>
              {!readOnly && (
                <>
                  <span className="ve-handle in" role="separator" aria-label="Trim start" onPointerDown={(e) => startTrim(e, pl.clip, "in")} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={endTrim} />
                  <span className="ve-handle out" role="separator" aria-label="Trim end" onPointerDown={(e) => startTrim(e, pl.clip, "out")} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={endTrim} />
                </>
              )}
            </div>
          ))}
          {!placed.length && <span className="ve-empty">Add a clip from the Media panel, or let Auto edit build a first cut.</span>}
        </div>
        <span className="ve-playhead" style={{ left: time * pxPerSec }} aria-hidden />
      </Lane>
      <Lane label="Text" icon={<Type size={12} />} className="text">
        {texts.map(block)}
        <span className="ve-playhead" style={{ left: time * pxPerSec }} aria-hidden />
      </Lane>
      <Lane label="Logo" icon={<ImageIcon size={12} />} className="logo">
        {logos.map(block)}
        <span className="ve-playhead" style={{ left: time * pxPerSec }} aria-hidden />
      </Lane>
      <Lane label="Music" icon={<Music size={12} />} className="music">
        {musicName && (
          <span className="ve-music-block" style={{ left: 0, width: Math.max(10, length * pxPerSec) }} title={musicName}>
            <Music size={11} /> {musicName}
          </span>
        )}
        {beats.map((b, i) => (
          <span key={`m${i}`} className="ve-beat" style={{ left: b * pxPerSec }} aria-hidden />
        ))}
        <span className="ve-playhead" style={{ left: time * pxPerSec }} aria-hidden />
      </Lane>
    </div>
  );
}
