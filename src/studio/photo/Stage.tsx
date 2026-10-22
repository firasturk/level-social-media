/**
 * The Photo studio's canvas: the picture large (zoom to fit, 100% or in between; the stage scrolls
 * to pan, or drag the picture), the compare slider, the marked area of an AI edit, the crop frame
 * of the Adjust tool with its handles, and the Adjust preview drawn into a canvas.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import CompareSlider from "../CompareSlider";
import { moveCrop, resizeCrop, type Aspect, type CropRect } from "@shared/photo-adjust";
import type { Area, StageView } from "./types";

export interface CropFrame {
  rect: CropRect;
  aspect: Aspect;
  /** The rotated picture's pixel size, so the aspect holds in pixels. */
  frameW: number;
  frameH: number;
  onChange: (c: CropRect) => void;
}

interface Props {
  view: StageView;
  /** The natural size of what is shown (the picture, the compare's pictures, or the Adjust frame). */
  size: { w: number; h: number } | null;
  /** 1 = fit the stage; the display scale is fit × zoom. */
  zoom: number;
  /** Reports the fit scale, so the zoom pill can show a percentage and "100%" can be computed. */
  onFit: (fit: number) => void;
  marking: boolean;
  area: Area | null;
  onArea: (a: Area | null) => void;
  /** The Adjust preview to show (drawn elsewhere), and the raw picture while "before" is held. */
  preview: HTMLCanvasElement | null;
  holdBefore: boolean;
  beforeSrc: string;
  crop: CropFrame | null;
  loading?: boolean;
  children?: ReactNode;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export default function Stage({ view, size, zoom, onFit, marking, area, onArea, preview, holdBefore, beforeSrc, crop, loading, children }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState(1);
  const markDrag = useRef<{ x: number; y: number } | null>(null);
  const cropDrag = useRef<{ handle: string; x: number; y: number; start: CropRect } | null>(null);
  const panDrag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const W = size?.w ?? 1;
  const H = size?.h ?? 1;
  const scale = fit * zoom;
  const dispW = W * scale;
  const dispH = H * scale;

  /* Fit to the stage */
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !size) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const f = Math.max(0.02, Math.min((r.width - 32) / size.w, (r.height - 32) / size.h));
      setFit(f);
      onFit(f);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size, onFit]);

  /* The Adjust preview, blitted into the display canvas */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !preview || view.kind !== "adjust") return;
    c.width = preview.width;
    c.height = preview.height;
    c.getContext("2d")?.drawImage(preview, 0, 0);
  }, [preview, view.kind]);

  /* Pointer handling: marking, the crop frame, panning */
  const frac = (e: ReactPointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (marking) {
      const p = frac(e);
      markDrag.current = p;
      onArea({ x: p.x, y: p.y, w: 0, h: 0 });
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (crop) {
      const handle = target.dataset.handle;
      const inside = target.closest(".ps-crop");
      if (handle || inside) {
        const p = frac(e);
        cropDrag.current = { handle: handle ?? "move", x: p.x, y: p.y, start: crop.rect };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    // Panning: only when the picture is larger than the stage.
    const st = stageRef.current;
    if (st && (st.scrollWidth > st.clientWidth || st.scrollHeight > st.clientHeight) && view.kind !== "compare") {
      panDrag.current = { x: e.clientX, y: e.clientY, left: st.scrollLeft, top: st.scrollTop };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (markDrag.current) {
      const p = frac(e);
      const s = markDrag.current;
      onArea({ x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
      return;
    }
    if (cropDrag.current && crop) {
      const p = frac(e);
      const d = cropDrag.current;
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      crop.onChange(d.handle === "move" ? moveCrop(d.start, dx, dy) : resizeCrop(d.start, d.handle, dx, dy, crop.aspect, crop.frameW, crop.frameH));
      return;
    }
    if (panDrag.current && stageRef.current) {
      const st = stageRef.current;
      st.scrollLeft = panDrag.current.left - (e.clientX - panDrag.current.x);
      st.scrollTop = panDrag.current.top - (e.clientY - panDrag.current.y);
    }
  };
  const onUp = () => {
    markDrag.current = null;
    cropDrag.current = null;
    panDrag.current = null;
  };

  const cursor = marking ? "crosshair" : crop ? undefined : zoom > 1 ? "grab" : undefined;
  return (
    <div className={`ps-stage ${marking ? "marking" : ""}`} ref={stageRef}>
      <div className="ps-stage-inner">
        {size && (
          <div ref={wrapRef} className="ps-canvas-wrap" style={{ width: dispW, height: dispH, cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            {view.kind === "compare" && <CompareSlider before={view.before} after={view.after} alt="Compare" />}
            {view.kind === "picture" && <img className="ps-picture" src={view.src} alt={view.label} draggable={false} />}
            {view.kind === "adjust" && (
              <>
                <canvas ref={canvasRef} className="ps-adjust-canvas" style={{ width: dispW, height: dispH }} />
                {holdBefore && <img className="ps-before" src={beforeSrc} alt="Before the adjustments" draggable={false} />}
                {crop && !holdBefore && (
                  <div className="ps-crop" style={{ left: `${crop.rect.x * 100}%`, top: `${crop.rect.y * 100}%`, width: `${crop.rect.w * 100}%`, height: `${crop.rect.h * 100}%` }} role="group" aria-label="Crop frame">
                    <span className="ps-crop-grid" aria-hidden />
                    {HANDLES.map((h) => (
                      <span key={h} className={`ps-handle ${h}`} data-handle={h} />
                    ))}
                  </div>
                )}
              </>
            )}
            {view.kind === "compare" && (
              <div className="ps-compare-labels" aria-hidden>
                <span>{view.beforeLabel}</span>
                <span>{view.afterLabel}</span>
              </div>
            )}
            {(marking || area) && view.kind !== "adjust" && (
              <div className={`ps-mark ${marking ? "on" : ""}`} aria-label="The marked area">
                {area && area.w > 0.01 && <div className="ps-mark-box" style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.w * 100}%`, height: `${area.h * 100}%` }} />}
              </div>
            )}
          </div>
        )}
        {(!size || loading) && <div className="ps-stage-loading">Loading the picture…</div>}
      </div>
      {children}
    </div>
  );
}
