/**
 * The text and logo layers, drawn into a transparent 2D canvas the size of the output (the preview
 * draws it at the preview's size: every position and size is a fraction of the frame, so the
 * layout is the same). The browser's own text engine shapes the words, so Arabic is joined and
 * runs right to left (the direction is read from the first strong letter), Latin left to right,
 * and mixed lines follow the Unicode bidirectional rules. The grader blends this canvas over the
 * graded footage (src/video-editor/engine/grader.ts).
 *
 * Fonts: the studio's own web fonts (Inter, Tajawal, Playfair Display, Amiri, Anton, Cairo) when
 * the page has them, then the system's; `prepare` waits for them so the first exported frame does
 * not use a fallback.
 */
import { overlaysAt, textDirection, type LogoOverlay, type Overlay, type TextOverlay } from "@shared/video-compose";

const FAMILIES: Record<TextOverlay["font"], string> = {
  sans: `"Inter", "Tajawal", "Noto Sans Arabic", "Segoe UI", "DejaVu Sans", system-ui, sans-serif`,
  serif: `"Playfair Display", "Amiri", "Noto Naskh Arabic", Georgia, "FreeSerif", serif`,
  display: `"Anton", "Cairo", "Noto Kufi Arabic", Impact, "DejaVu Sans", sans-serif`,
};

export const fontOf = (o: Pick<TextOverlay, "font" | "weight">, px: number) => `${o.weight} ${Math.max(1, Math.round(px))}px ${FAMILIES[o.font]}`;

/** Lines that fit `max` pixels, broken at spaces (a word longer than the line stays whole). */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > max) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export class OverlayLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private images = new Map<string, HTMLImageElement | null>();
  private loading = new Map<string, Promise<void>>();
  private lastKey = "";

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d")!;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.lastKey = "";
  }

  private loadImage(src: string): Promise<void> {
    if (this.images.has(src)) return Promise.resolve();
    let p = this.loading.get(src);
    if (!p) {
      p = new Promise<void>((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          this.images.set(src, img);
          this.lastKey = "";
          resolve();
        };
        img.onerror = () => {
          this.images.set(src, null);
          resolve();
        };
        img.src = src;
      });
      this.loading.set(src, p);
    }
    return p;
  }

  /** Every logo loaded and every font the words use ready: called before an export (and as the preview starts). */
  async prepare(overlays: readonly Overlay[]): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const o of overlays) {
      if (o.kind === "logo") jobs.push(this.loadImage(o.src));
      else if (typeof document !== "undefined" && document.fonts) jobs.push(document.fonts.load(fontOf(o, 48), o.text).catch(() => undefined));
    }
    await Promise.all(jobs);
    this.lastKey = "";
  }

  /**
   * The layer at timeline time t; null when no overlay is on screen (the grader then skips the
   * blend). The canvas is redrawn only when the set of visible overlays changes.
   */
  draw(overlays: readonly Overlay[] | null | undefined, t: number): HTMLCanvasElement | null {
    const on = overlaysAt(overlays, t);
    if (!on.length) return null;
    const key = JSON.stringify(on) + `|${this.canvas.width}x${this.canvas.height}|${[...this.images.keys()].join(",")}`;
    if (key === this.lastKey) return this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const o of on) {
      if (o.kind === "text") this.drawText(o);
      else this.drawLogo(o);
    }
    this.lastKey = key;
    return this.canvas;
  }

  private drawText(o: TextOverlay): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const px = o.size * H;
    const dir = textDirection(o.text);
    ctx.save();
    ctx.font = fontOf(o, px);
    ctx.direction = dir;
    ctx.textBaseline = "middle";
    const max = o.width * W;
    const lines = wrapLines(ctx, o.text, max);
    const lineH = px * 1.22;
    const widths = lines.map((l) => ctx.measureText(l).width);
    const blockW = Math.min(max, Math.max(...widths));
    const cx = o.x * W;
    const top = o.y * H - (lines.length * lineH) / 2;
    // "start" and "end" follow the words' direction: start is the right edge for Arabic.
    const startIsLeft = dir === "ltr";
    const anchor = (w: number) => (o.align === "center" ? cx - w / 2 : (o.align === "start") === startIsLeft ? cx - blockW / 2 : cx + blockW / 2 - w);
    if (o.box) {
      const pad = px * 0.3;
      ctx.fillStyle = o.box;
      lines.forEach((_, i) => {
        const w = widths[i];
        ctx.fillRect(anchor(w) - pad, top + i * lineH - pad * 0.15, w + pad * 2, lineH + pad * 0.3);
      });
    }
    ctx.fillStyle = o.color;
    ctx.textAlign = "left";
    // A soft shadow keeps white words readable on bright footage; none behind a box.
    if (!o.box) {
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = px * 0.12;
      ctx.shadowOffsetY = px * 0.03;
    }
    lines.forEach((line, i) => {
      // Drawn from its left edge with the line's own direction, so the shaping is the browser's.
      ctx.direction = dir;
      ctx.textAlign = dir === "rtl" ? "right" : "left";
      const x = anchor(widths[i]);
      ctx.fillText(line, dir === "rtl" ? x + widths[i] : x, top + i * lineH + lineH / 2);
    });
    ctx.restore();
  }

  private drawLogo(o: LogoOverlay): void {
    const img = this.images.get(o.src);
    if (img === undefined) {
      void this.loadImage(o.src);
      return;
    }
    if (!img) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const w = o.width * W;
    const h = (w * (img.naturalHeight || 1)) / (img.naturalWidth || 1);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = o.opacity;
    ctx.drawImage(img, o.x * W - w / 2, o.y * H - h / 2, w, h);
    ctx.restore();
  }
}
