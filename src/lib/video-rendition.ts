/**
 * The lightweight versions of a clip, made in this browser when a clip is stored (Workers cannot
 * transcode, and nothing is sent to an outside service):
 *   - a still: the clip's own first frame as a small JPEG (540 px on its short side), the poster
 *     under every player and card. Any browser that can play the clip makes it.
 *   - a preview mp4: the first 8 seconds at 360 px on the short side, 24 fps, about 700 kbit/s,
 *     no sound (cards and galleries play muted). Made with WebCodecs (H.264 decode and encode),
 *     so only where the browser has an H.264 encoder (Chrome, Edge, Safari on a computer); kept
 *     only when it is clearly lighter than the file.
 * Both are best effort: when either cannot be made the full file plays instead, as before.
 * Nothing here is a generation and nothing here calls a provider.
 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { PREVIEW_RENDITION, renditionSize, STILL_SHORT_SIDE, worthKeeping } from "@shared/video-preview";
import { postForm } from "@/api";
import type { VideoItem } from "@/studio/videoApi";

export interface Rendition {
  preview: Blob | null;
  still: Blob | null;
}

/** H.264 profiles a small preview fits in, the most compatible first (Baseline 3.0 plays everywhere). */
const CODECS = ["avc1.42E01E", "avc1.42E01F", "avc1.4D401F", "avc1.640028"];
const TIMEOUT_MS = 45_000;

function once(el: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`${event} timed out`)), ms);
    const ok = () => done(null);
    const bad = () => done(new Error("The clip could not be read here."));
    function done(e: Error | null) {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
      if (e) reject(e);
      else resolve();
    }
    el.addEventListener(event, ok);
    el.addEventListener("error", bad);
  });
}

function canvasOf(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

async function toJpeg(c: OffscreenCanvas | HTMLCanvasElement): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/jpeg", 0.8));
}

/** The clip's first frame as a small JPEG, or null when this browser cannot read the clip. */
export async function makeStill(file: Blob): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  try {
    const loaded = once(v, "loadeddata", 10_000);
    v.src = url;
    await loaded;
    const at = Math.min(0.1, (v.duration || 0) / 2);
    if (at > 0) {
      const seeked = once(v, "seeked", 5_000);
      v.currentTime = at;
      await seeked;
    }
    if (!v.videoWidth || !v.videoHeight) return null;
    const { width, height } = renditionSize(v.videoWidth, v.videoHeight, STILL_SHORT_SIDE);
    const c = canvasOf(width, height);
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, width, height);
    return await toJpeg(c);
  } catch {
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
    URL.revokeObjectURL(url);
  }
}

/** True when this browser can make the preview mp4 (WebCodecs with an H.264 encoder is asked later). */
export function canMakePreviewClip(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined";
}

async function encoderCodec(width: number, height: number): Promise<string | null> {
  for (const codec of CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: PREVIEW_RENDITION.fps, bitrate: PREVIEW_RENDITION.bitrate, avc: { format: "avc" } });
      if (r.supported) return codec;
    } catch {
      /* an unknown codec string throws in some browsers: try the next */
    }
  }
  return null;
}

/**
 * The preview mp4: the first seconds of the clip, small, silent, H.264 with its index in front.
 * Null when this browser has no H.264 encoder or decoder, the clip is not an H.264 mp4, or the
 * result would not be lighter than the file.
 */
export async function makePreviewClip(file: Blob): Promise<Blob | null> {
  if (!canMakePreviewClip()) return null;
  // The editor's demuxer (mp4box) only loads when a preview is made.
  const { demuxMp4, FrameCursor } = await import("@/video-editor/engine/demux");
  const d = await demuxMp4(await file.arrayBuffer());
  const decodable = await VideoDecoder.isConfigSupported({ codec: d.codec, description: d.description }).catch(() => ({ supported: false }));
  if (!decodable.supported) return null;
  const { width, height } = renditionSize(d.width, d.height);
  const codec = await encoderCodec(width, height);
  if (!codec) return null;
  const { fps, bitrate, seconds } = PREVIEW_RENDITION;
  const length = Math.min(d.duration || seconds, seconds);
  const frames = Math.max(1, Math.round(length * fps));
  const frameUs = Math.round(1e6 / fps);
  const canvas = canvasOf(width, height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width, height, frameRate: fps }, fastStart: "in-memory", firstTimestampBehavior: "offset" });
  let failed: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failed = new Error(e.message);
    },
  });
  encoder.configure({ codec, width, height, framerate: fps, bitrate, bitrateMode: "variable", avc: { format: "avc" } });
  const cursor = new FrameCursor(d);
  try {
    for (let i = 0; i < frames; i++) {
      if (failed) throw failed;
      const frame = await cursor.frameAt(i / fps);
      if (frame) ctx.drawImage(frame, 0, 0, width, height);
      const out = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
      encoder.encode(out, { keyFrame: i % (fps * 2) === 0 });
      out.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
    }
    await encoder.flush();
    if (failed) throw failed;
    muxer.finalize();
  } finally {
    cursor.close();
    if (encoder.state !== "closed") encoder.close();
  }
  const blob = new Blob([target.buffer], { type: "video/mp4" });
  return worthKeeping(blob.size, file.size) ? blob : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Both lightweight versions, each best effort (null when it could not be made in time). */
export async function makeRendition(file: Blob): Promise<Rendition> {
  const still = await withTimeout(makeStill(file), 15_000);
  const preview = await withTimeout(makePreviewClip(file), TIMEOUT_MS);
  return { preview, still };
}

/** The rendition's fields on an upload form ('preview', 'still'), when there are any. */
export function addRendition(form: FormData, r: Rendition): void {
  if (r.preview) form.set("preview", new File([r.preview], "preview.mp4", { type: "video/mp4" }));
  if (r.still) form.set("still", new File([r.still], "still.jpg", { type: "image/jpeg" }));
}

/* ───────────── After the fact: a finished clip an engine delivered ───────────── */

const tried = new Set<string>();

/**
 * Makes and keeps the lightweight versions of a finished clip that has none (one an engine
 * delivered: the server cannot transcode it). Called by the Video studio's stage for admins, once
 * per clip per session, after the clip has been on screen a moment. Resolves with the updated
 * version, or null when nothing was kept.
 */
export async function backfillRendition(v: VideoItem): Promise<VideoItem | null> {
  if (!v.url || v.preview || v.status !== "done" || tried.has(v.id)) return null;
  tried.add(v.id);
  try {
    const batch = new URL(v.url, location.href).searchParams.get("batch");
    if (!batch) return null;
    const r = await fetch(v.url, { credentials: "same-origin" });
    if (!r.ok) return null;
    const rendition = await makeRendition(await r.blob());
    if (!rendition.preview && !rendition.still) return null;
    const form = new FormData();
    form.set("batch", batch);
    form.set("id", v.id);
    addRendition(form, rendition);
    const res = await postForm<{ video: VideoItem }>("/api/studio/posts/video/preview", form);
    return res.video;
  } catch {
    return null;
  }
}
