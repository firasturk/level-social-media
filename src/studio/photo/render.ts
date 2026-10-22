/**
 * The Adjust tool's drawing: the geometry (quarter turns, flips, straightening, the crop) is done
 * by a canvas; the pixels then go through the pure pipeline in `@shared/photo-adjust`. The same
 * function draws the preview (a small canvas, fast enough for a slider) and the final picture
 * (full resolution, capped so the browser's memory holds it).
 */
import { applyPixels, cropPixels, rotatedSize, straightenScale, type AdjustParams } from "@shared/photo-adjust";

/** The longest side the final picture is drawn at: the engines make at most ~2K, and 4096² RGBA is 64 MB. */
export const MAX_OUTPUT_EDGE = 4096;

export function loadPicture(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("The picture could not be loaded."));
    img.src = src;
  });
}

export interface Drawn {
  canvas: HTMLCanvasElement;
  /** The scale from the source picture's pixels to this canvas (1 for the full picture). */
  scale: number;
}

/**
 * The picture after rotation, flip and straightening (the crop is applied only when `crop` is
 * true), colour and detail adjusted, no wider or taller than `maxEdge`. With `crop` false the
 * whole frame is drawn so the crop frame can be shown over it.
 */
export function drawAdjusted(img: HTMLImageElement | HTMLCanvasElement, p: AdjustParams, maxEdge: number, crop: boolean): Drawn {
  const sw = img.width;
  const sh = img.height;
  const r = rotatedSize(sw, sh, p.rotate);
  // The frame drawn: the rotated picture, or the crop of it.
  const c = crop ? cropPixels(p.crop, r.w, r.h) : { x: 0, y: 0, w: r.w, h: r.h };
  const scale = Math.min(1, maxEdge / Math.max(c.w, c.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(c.w * scale));
  canvas.height = Math.max(1, Math.round(c.h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.scale(scale, scale);
  // Into the rotated frame's coordinates, then the crop offset.
  ctx.translate(-c.x, -c.y);
  // Rotate and flip about the rotated frame's centre; straighten about it too, scaled to stay filled.
  ctx.translate(r.w / 2, r.h / 2);
  if (p.straighten) {
    const k = straightenScale(p.straighten, r.w, r.h);
    ctx.scale(k, k);
    ctx.rotate((p.straighten * Math.PI) / 180);
  }
  ctx.rotate((p.rotate * Math.PI) / 180);
  ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
  ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
  if (p.exposure || p.contrast || p.saturation || p.temperature || p.tint || p.highlights || p.shadows || p.sharpen || p.vignette) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyPixels(data.data, canvas.width, canvas.height, p);
    ctx.putImageData(data, 0, 0);
  }
  return { canvas, scale };
}

/** The canvas as a file for the server: PNG when the source was one (transparency kept), JPEG otherwise. */
export function canvasFile(canvas: HTMLCanvasElement, name: string, png: boolean): Promise<File> {
  return new Promise((ok, no) =>
    canvas.toBlob(
      (b) => (b ? ok(new File([b], `${name}.${png ? "png" : "jpg"}`, { type: b.type })) : no(new Error("The picture could not be saved."))),
      png ? "image/png" : "image/jpeg",
      0.94,
    ),
  );
}
