/**
 * A picture as a short clip, made in this tab: the Video editor's footage is H.264 MP4 only, so a
 * picture card joining "Combine into one video" is drawn on the editor's 1080×1920 frame (whole,
 * on a blurred copy of itself) and encoded for a few seconds with the same WebCodecs encoder the
 * editor's export uses. Campaign Autopilot draws a Reel's photo shots the same way, at the Reel's
 * own size and for its shot's length (src/video-editor/headless-render.ts). Nothing is sent anywhere and nothing is generated; a browser without an
 * H.264 encoder says so with the editor's own message.
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { checkCapabilities } from "@/video-editor/engine/capabilities";

export const STILL_SECONDS = 3;

async function loadImage(url: string): Promise<ImageBitmap> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`The picture could not be read (${r.status}).`);
  const blob = await r.blob();
  try {
    return await createImageBitmap(blob);
  } catch {
    // SVG and some other formats decode only through an <img> element.
    const src = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      return await createImageBitmap(img, { resizeWidth: img.naturalWidth || 1080, resizeHeight: img.naturalHeight || 1080 });
    } catch {
      throw new Error("The source image could not be decoded.");
    } finally {
      URL.revokeObjectURL(src);
    }
  }
}

/** The picture drawn on the frame: whole, centred, over a darkened, blurred copy that fills it. */
function drawFrame(ctx: CanvasRenderingContext2D, img: ImageBitmap, w: number, h: number) {
  const cover = Math.max(w / img.width, h / img.height);
  const fit = Math.min(w / img.width, h / img.height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.filter = "blur(40px) brightness(0.6)";
  ctx.drawImage(img, (w - img.width * cover) / 2, (h - img.height * cover) / 2, img.width * cover, img.height * cover);
  ctx.restore();
  ctx.drawImage(img, (w - img.width * fit) / 2, (h - img.height * fit) / 2, img.width * fit, img.height * fit);
}

/** The picture at `url` as a `seconds`-long H.264 clip at `output`'s size (a Reel, 1080×1920 at 30 fps, by default). */
export async function stillToClip(url: string, name: string, seconds = STILL_SECONDS, output: { width: number; height: number; fps: number } = { width: 1080, height: 1920, fps: 30 }): Promise<File> {
  const caps = await checkCapabilities(output);
  if (!caps.videoCodec) throw new Error(`${caps.message} ${caps.details.join(" ")}`.trim());
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the picture.");
  drawFrame(ctx, img, output.width, output.height);
  img.close();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width: output.width, height: output.height, frameRate: output.fps }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = new Error(`H.264 encoding failed: ${e.message}`);
    },
  });
  encoder.configure({ codec: caps.videoCodec, width: output.width, height: output.height, framerate: output.fps, bitrate: 4_000_000, avc: { format: "avc" } });
  const frames = Math.round(seconds * output.fps);
  const frameUs = Math.round(1e6 / output.fps);
  try {
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
      encoder.encode(frame, { keyFrame: i % (output.fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
    }
    await encoder.flush();
    if (failure) throw failure;
    encoder.close();
    muxer.finalize();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  return new File([target.buffer], `${name.replace(/\.[a-z0-9]+$/i, "") || "picture"}.mp4`, { type: "video/mp4" });
}

/** The first frame of a clip picked on this computer, as a JPEG for the card's picture (null when the browser cannot read it). */
export async function posterOf(file: File, timeoutMs = 6000): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("unreadable"));
      };
    });
    // A frame a little in, so a fade from black is not the card's picture.
    if (video.duration > 0.6) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(0.5, video.duration / 3);
        setTimeout(resolve, 1500);
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width) return null;
    ctx.drawImage(video, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.88));
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
