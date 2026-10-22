/**
 * The picture composed to a video frame in the browser, before it is sent as the clip's first
 * frame: a 9:16 (or 4:5, 1:1, 16:9) canvas with the picture covering it (crop to fit, centred) or
 * contained over a blurred, darkened copy of itself. The maths live in shared/video-frame.ts; this
 * file only draws. The result is a JPEG data URL the submit routes already take as `artwork`.
 */
import { containPlacement, coverPlacement, frameSize, needsCompose, type FrameFill, type FrameId } from "@shared/video-frame";

/** The long side of the composed picture: a Reel at 1080 × 1920. */
export const COMPOSE_LONG_SIDE = 1920;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("The picture could not be read for the frame."));
    img.src = src;
  });
}

/**
 * The picture (a URL or a data URL) drawn into the frame. When the picture already has that frame
 * it is returned untouched (a data URL as it is; a URL is still redrawn so the result is a data URL).
 */
export async function composeFrame(src: string, frame: FrameId, fill: FrameFill, opts: { longSide?: number; quality?: number } = {}): Promise<string> {
  const img = await loadImage(src);
  const natural = { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  if (!needsCompose(natural, frame) && src.startsWith("data:")) return src;
  const size = frameSize(frame, opts.longSide ?? COMPOSE_LONG_SIDE);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The browser could not draw the frame.");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size.w, size.h);
  if (fill === "blur" && needsCompose(natural, frame)) {
    // The blurred, darkened copy fills the edges; the whole picture sits on top.
    const back = coverPlacement(natural, size);
    ctx.save();
    ctx.filter = "blur(40px)";
    ctx.drawImage(img, back.x - 40, back.y - 40, back.w + 80, back.h + 80);
    ctx.restore();
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, size.w, size.h);
    const front = containPlacement(natural, size);
    ctx.drawImage(img, front.x, front.y, front.w, front.h);
  } else {
    const p = coverPlacement(natural, size);
    ctx.drawImage(img, p.x, p.y, p.w, p.h);
  }
  return canvas.toDataURL("image/jpeg", opts.quality ?? 0.92);
}
