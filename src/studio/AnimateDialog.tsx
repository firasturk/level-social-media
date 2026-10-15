import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Play } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ANIMATION_PRESETS, type AnimationPreset, type OverlaySpec, type PostOverlayPatch } from "@shared/overlay";
import { loadImage, paintFrame, recordAnimation, videoMime } from "@/lib/overlay";
import { saveBlob } from "@/lib/zip";

const PRESET_LABEL: Record<AnimationPreset, string> = {
  fade: "Fade in",
  rise: "Rise from below",
  typewriter: "Typewriter",
  zoom: "Zoom in",
};

/** "Animate this text": the headline enters over the still image; exported as a short video. */
export default function AnimateDialog({
  open,
  src,
  spec,
  logoSrc,
  headline,
  subline,
  patch,
  fileBase,
  onClose,
}: {
  open: boolean;
  src: string;
  spec: OverlaySpec;
  logoSrc: string | null;
  headline: string;
  subline: string;
  patch: PostOverlayPatch | undefined;
  fileBase: string;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [preset, setPreset] = useState<AnimationPreset>("rise");
  const [seconds, setSeconds] = useState(1.6);
  const [hold, setHold] = useState(2.5);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(0);
  const W = 480;
  const { ext } = videoMime();

  useEffect(() => {
    if (!open) return;
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
  }, [open, src]);

  // Loop the preview whenever something changes.
  useEffect(() => {
    const c = canvasRef.current;
    const img = imgRef.current;
    if (!open || !ready || !c || !img) return;
    let alive = true;
    let raf = 0;
    const start = performance.now();
    const total = (seconds + hold) * 1000;
    const tick = async () => {
      if (!alive) return;
      const t = ((performance.now() - start) % total) / 1000;
      const progress = Math.min(1, t / seconds);
      await paintFrame(c, img, spec, { headline, subline }, logoSrc, { patch, anim: { preset, progress } });
      if (alive) raf = requestAnimationFrame(() => void tick());
    };
    setPlaying(true);
    void tick();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      setPlaying(false);
    };
  }, [open, ready, spec, headline, subline, logoSrc, patch, preset, seconds, hold]);

  async function exportVideo() {
    setExporting(0.01);
    try {
      const { blob, ext } = await recordAnimation(
        src,
        spec,
        { headline, subline },
        logoSrc,
        { preset, seconds, hold, fps: 30, width: 1080, patch },
        (p) => setExporting(Math.max(0.01, p)),
      );
      saveBlob(blob, `${fileBase}_${preset}.${ext}`);
      toast.success(`Video saved (${ext.toUpperCase()}).`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(0);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="animate-dialog">
        <DialogHeader>
          <DialogTitle>Animate this text</DialogTitle>
          <DialogDescription>
            The headline enters over the still image. Pick a motion and export a short {ext.toUpperCase()} for stories and reels.
          </DialogDescription>
        </DialogHeader>
        <div className="overlay-editor-body">
          <div className="overlay-editor-canvas">
            {!ready && <LoaderCircle className="spinning" size={22} />}
            <canvas ref={canvasRef} />
            {playing && <span className="anim-badge"><Play size={11} /> preview</span>}
          </div>
          <div className="overlay-editor-controls">
            <label className="field-label">Motion</label>
            <div className="preset-row">
              {ANIMATION_PRESETS.map((p) => (
                <button key={p} type="button" className={`format-chip ${preset === p ? "active" : ""}`} onClick={() => setPreset(p)}>
                  <strong>{PRESET_LABEL[p]}</strong>
                </button>
              ))}
            </div>
            <label className="field-label" htmlFor="an-seconds">Entry · {seconds.toFixed(1)} s</label>
            <input id="an-seconds" type="range" min={5} max={40} value={Math.round(seconds * 10)} onChange={(e) => setSeconds(Number(e.target.value) / 10)} />
            <label className="field-label" htmlFor="an-hold">Hold after · {hold.toFixed(1)} s</label>
            <input id="an-hold" type="range" min={5} max={60} value={Math.round(hold * 10)} onChange={(e) => setHold(Number(e.target.value) / 10)} />
            <div className="prompt-tip">
              Exported at 1080 px wide, 30 fps, {(seconds + hold).toFixed(1)} s. Keep the browser tab visible while it records.
            </div>
            <div className="footer-actions">
              <span className="spacer" />
              <button type="button" className="secondary" onClick={onClose}>Close</button>
              <button type="button" className="primary" onClick={() => void exportVideo()} disabled={!ready || exporting > 0}>
                {exporting > 0 ? <LoaderCircle className="spinning" size={15} /> : <Download size={15} />}
                {exporting > 0 ? `Recording ${Math.round(exporting * 100)}%` : `Export ${ext.toUpperCase()}`}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
