/**
 * The timeline: a ruler with the playhead, one block per clip (dragged at its ends to trim),
 * beat ticks when music is set, and the cut points. Trims are reported as mark / patch / commit so
 * a whole drag is one undo step. Reordering and splitting live in the Clips panel and the toolbar.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
}

const MIN_SPAN = 5;

export default function Timeline({ project, time, beats, selected, readOnly, onSelect, onSeek, onTrimStart, onTrim, onTrimEnd, labelOf }: TimelineProps) {
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

  return (
    <div className="ve-timeline" ref={ref}>
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
        {!placed.length && <span className="ve-empty">Add a clip from the Clips panel, or let Auto edit build a first cut.</span>}
      </div>
      <span className="ve-playhead" style={{ left: time * pxPerSec }} aria-hidden />
    </div>
  );
}
