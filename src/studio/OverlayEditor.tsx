import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import { TYPO_FONTS, TYPO_LABELS, TYPO_STYLES, type TypoStyle } from "@shared/typography";
import { loadImage, paintFrame, type OverlayLayout } from "@/lib/overlay";

export interface EditorResult {
  headline: string;
  subline: string;
  ov: PostOverlayPatch | undefined;
}

/** Edits a post's text directly on its image: type, drag the text block or the logo, resize, recolour. */
export default function OverlayEditor({
  open,
  src,
  spec,
  logoSrc,
  headline: initialHeadline,
  subline: initialSubline,
  patch: initialPatch,
  onClose,
  onSave,
}: {
  open: boolean;
  src: string;
  spec: OverlaySpec;
  logoSrc: string | null;
  headline: string;
  subline: string;
  patch: PostOverlayPatch | undefined;
  onClose: () => void;
  onSave: (r: EditorResult) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const layoutRef = useRef<OverlayLayout>({ logo: null, text: null });
  const dragRef = useRef<{ what: "text" | "logo"; x: number; y: number; dx: number; dy: number } | null>(null);
  const [headline, setHeadline] = useState(initialHeadline);
  const [subline, setSubline] = useState(initialSubline);
  const [patch, setPatch] = useState<PostOverlayPatch>(initialPatch ?? {});
  const [ready, setReady] = useState(false);
  const W = 540;

  useEffect(() => {
    if (!open) return;
    setHeadline(initialHeadline);
    setSubline(initialSubline);
    setPatch(initialPatch ?? {});
    setReady(false);
    loadImage(src)
      .then((img) => {
        imgRef.current = img;
        const c = canvasRef.current;
        if (!c) return;
        c.width = W;
        c.height = Math.round((W * img.naturalHeight) / img.naturalWidth);
        setReady(true);
      })
      .catch(() => setReady(false));
  }, [open, src, initialHeadline, initialSubline, initialPatch]);

  useEffect(() => {
    const c = canvasRef.current;
    const img = imgRef.current;
    if (!open || !ready || !c || !img) return;
    let alive = true;
    void paintFrame(c, img, spec, { headline, subline }, logoSrc, { patch }).then((l) => {
      if (alive) layoutRef.current = l;
    });
    return () => {
      alive = false;
    };
  }, [open, ready, spec, headline, subline, logoSrc, patch]);

  function hit(e: React.PointerEvent<HTMLCanvasElement>): "text" | "logo" | null {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) * c.width) / r.width;
    const y = ((e.clientY - r.top) * c.height) / r.height;
    const inside = (b: { x: number; y: number; w: number; h: number } | null) =>
      !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    const l = layoutRef.current;
    if (inside(l.logo)) return "logo";
    if (inside(l.text)) return "text";
    return null;
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const what = hit(e);
    if (!what) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      what,
      x: e.clientX,
      y: e.clientY,
      dx: what === "text" ? (patch.dx ?? 0) : (patch.logoDx ?? 0),
      dy: what === "text" ? (patch.dy ?? 0) : (patch.logoDy ?? 0),
    };
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    const c = canvasRef.current;
    if (!c) return;
    if (!d) {
      c.style.cursor = hit(e) ? "grab" : "default";
      return;
    }
    const r = c.getBoundingClientRect();
    const fx = (e.clientX - d.x) / r.width;
    const fy = (e.clientY - d.y) / r.width;
    c.style.cursor = "grabbing";
    setPatch((p) =>
      d.what === "text"
        ? { ...p, dx: round(d.dx + fx), dy: round(d.dy + fy) }
        : { ...p, logoDx: round(d.dx + fx), logoDy: round(d.dy + fy) },
    );
  }
  function onUp() {
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = "default";
  }

  const clean = (p: PostOverlayPatch): PostOverlayPatch | undefined => {
    const out = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== 0 && v !== ""));
    return Object.keys(out).length ? (out as PostOverlayPatch) : undefined;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="overlay-editor">
        <DialogHeader>
          <DialogTitle>Text on image</DialogTitle>
          <DialogDescription>
            Type the headline, drag the text block or the logo to move them, and adjust size and colour. Only this post changes.
          </DialogDescription>
        </DialogHeader>
        <div className="overlay-editor-body">
          <div className="overlay-editor-canvas">
            {!ready && <LoaderCircle className="spinning" size={22} />}
            <canvas
              ref={canvasRef}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
          </div>
          <div className="overlay-editor-controls">
            <label className="field-label" htmlFor="oe-headline">Headline</label>
            <input id="oe-headline" dir="auto" value={headline} onChange={(e) => setHeadline(e.target.value)} />
            <label className="field-label" htmlFor="oe-subline">Second line</label>
            <input id="oe-subline" dir="auto" value={subline} onChange={(e) => setSubline(e.target.value)} />
            <label className="field-label" htmlFor="oe-scale">Text size · {Math.round((patch.scale ?? 1) * 100)}%</label>
            <input id="oe-scale" type="range" min={40} max={220} value={Math.round((patch.scale ?? 1) * 100)} onChange={(e) => setPatch((p) => ({ ...p, scale: Number(e.target.value) / 100 }))} />
            <label className="field-label" htmlFor="oe-logo">Logo width · {Math.round((patch.logoWidth ?? spec.logo.width) * 1080)}px</label>
            <input id="oe-logo" type="range" min={60} max={700} value={Math.round((patch.logoWidth ?? spec.logo.width) * 1080)} onChange={(e) => setPatch((p) => ({ ...p, logoWidth: Number(e.target.value) / 1080 }))} />
            <div className="field-grid three">
              <label className="num"><span>Headline</span><input type="color" value={patch.color ?? spec.headline.color} onChange={(e) => setPatch((p) => ({ ...p, color: e.target.value }))} /></label>
              <label className="num"><span>Second line</span><input type="color" value={patch.subColor ?? spec.subline.color} onChange={(e) => setPatch((p) => ({ ...p, subColor: e.target.value }))} /></label>
              <label className="num"><span>Place</span>
                <select value={patch.position ?? spec.headline.position} onChange={(e) => setPatch((p) => ({ ...p, position: e.target.value as PostOverlayPatch["position"], dx: undefined, dy: undefined }))}>
                  <option value="top">Top</option>
                  <option value="center">Centre</option>
                  <option value="bottom">Bottom</option>
                </select>
              </label>
              <label className="num"><span>Align</span>
                <select value={patch.align ?? spec.headline.align} onChange={(e) => setPatch((p) => ({ ...p, align: e.target.value as PostOverlayPatch["align"] }))}>
                  <option value="center">Centre</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </div>
            <label className="field-label" htmlFor="oe-typo">Typography</label>
            <div className="field-grid three overlay-typo">
              <label className="num">
                <span>Style</span>
                <select
                  id="oe-typo"
                  value={patch.typo?.style ?? ""}
                  onChange={(e) => {
                    const style = e.target.value as TypoStyle | "";
                    setPatch((p) => ({
                      ...p,
                      typo: style
                        ? { word: headline.split(/\s+/).slice(0, 2).join(" "), font: TYPO_FONTS[0], ...initialPatch?.typo, ...p.typo, style }
                        : undefined,
                    }));
                  }}
                >
                  <option value="">Plain headline</option>
                  {TYPO_STYLES.map((t) => (
                    <option key={t} value={t}>
                      {TYPO_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              {patch.typo && (
                <>
                  <label className="num">
                    <span>Big word</span>
                    <input dir="auto" value={patch.typo.word} onChange={(e) => setPatch((p) => ({ ...p, typo: { ...p.typo!, word: e.target.value } }))} />
                  </label>
                  <label className="num">
                    <span>Second font</span>
                    <select value={patch.typo.font} onChange={(e) => setPatch((p) => ({ ...p, typo: { ...p.typo!, font: e.target.value } }))}>
                      {TYPO_FONTS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            {patch.typo && !patch.typo.subject && (
              <p className="field-hint">The letters go behind the product once its outline is read: press "Typography for me" on the month.</p>
            )}
            <div className="footer-actions">
              <button type="button" className="text-button" onClick={() => setPatch((p) => ({ typo: p.typo, typoFor: p.typoFor }))}>
                <RotateCcw size={13} /> Reset position and size
              </button>
              <span className="spacer" />
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" onClick={() => onSave({ headline, subline, ov: clean(patch) })}>
                Save
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
