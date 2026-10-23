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
 *
 * Phase 2: each paragraph takes its own direction, so a bilingual layer (Arabic over English, or
 * the reverse) draws one line right to left and the other left to right; a layer's position,
 * scale and opacity follow its keyframes (`overlayState`, shared) at the frame's time.
 */
import { overlaysAt, overlayState, textParagraphs, type LogoOverlay, type Overlay, type OverlayState, type TextOverlay } from "@shared/video-compose";

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
      else if (typeof document !== "undefined" && document.fonts) jobs.push(document.fonts.load(fontOf(o, 48), `${o.text} ${o.second ?? ""}`).catch(() => undefined));
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
    const states = on.map((o) => overlayState(o, t));
    const key = JSON.stringify(on) + JSON.stringify(states) + `|${this.canvas.width}x${this.canvas.height}|${[...this.images.keys()].join(",")}`;
    if (key === this.lastKey) return this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    on.forEach((o, i) => {
      if (states[i].opacity <= 0) return;
      if (o.kind === "text") this.drawText(o, states[i]);
      else this.drawLogo(o, states[i]);
    });
    this.lastKey = key;
    return this.canvas;
  }

  private drawText(o: TextOverlay, s: OverlayState): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const px = o.size * H * s.scale;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.font = fontOf(o, px);
    ctx.textBaseline = "middle";
    const max = o.width * W * s.scale;
    // Each paragraph wrapped in its own direction: the Arabic line runs right to left, the English one left to right.
    const lines: { text: string; dir: "rtl" | "ltr" }[] = [];
    for (const p of textParagraphs(o)) {
      ctx.direction = p.dir;
      for (const l of wrapLines(ctx, p.text, max)) lines.push({ text: l, dir: p.dir });
    }
    const lineH = px * 1.22;
    const widths = lines.map((l) => {
      ctx.direction = l.dir;
      return ctx.measureText(l.text).width;
    });
    const blockW = Math.min(max, Math.max(...widths));
    const cx = s.x * W;
    const top = s.y * H - (lines.length * lineH) / 2;
    // "start" and "end" follow each line's direction: start is the right edge for Arabic.
    const anchor = (w: number, dir: "rtl" | "ltr") => (o.align === "center" ? cx - w / 2 : (o.align === "start") === (dir === "ltr") ? cx - blockW / 2 : cx + blockW / 2 - w);
    if (o.box) {
      const pad = px * 0.3;
      ctx.fillStyle = o.box;
      lines.forEach((l, i) => {
        const w = widths[i];
        ctx.fillRect(anchor(w, l.dir) - pad, top + i * lineH - pad * 0.15, w + pad * 2, lineH + pad * 0.3);
      });
    }
    ctx.fillStyle = o.color;
    // A soft shadow keeps white words readable on bright footage; none behind a box.
    if (!o.box) {
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = px * 0.12;
      ctx.shadowOffsetY = px * 0.03;
    }
    lines.forEach((l, i) => {
      // Drawn from its own edge with the line's own direction, so the shaping and the order are the browser's.
      ctx.direction = l.dir;
      ctx.textAlign = l.dir === "rtl" ? "right" : "left";
      const x = anchor(widths[i], l.dir);
      ctx.fillText(l.text, l.dir === "rtl" ? x + widths[i] : x, top + i * lineH + lineH / 2);
    });
    ctx.restore();
  }

  private drawLogo(o: LogoOverlay, s: OverlayState): void {
    const img = this.images.get(o.src);
    if (img === undefined) {
      void this.loadImage(o.src);
      return;
    }
    if (!img) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const w = o.width * W * s.scale;
    const h = (w * (img.naturalHeight || 1)) / (img.naturalWidth || 1);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.drawImage(img, s.x * W - w / 2, s.y * H - h / 2, w, h);
    ctx.restore();
  }
}
