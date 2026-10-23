/**
 * The browser half of the colour tools (phase 3): preset thumbnails drawn from the current frame
 * through the real grader (one small WebGL2 grader shared by all thumbnails, so they cost one tiny
 * pass each), and the measurements the colour match needs: a few frames of a clip sampled from a
 * hidden <video> of its own (so the preview is not disturbed) and the reference picture, both as
 * Lab statistics (shared/colour-match.ts). The fit happens once per clip from those frames; the
 * render then applies the same fixed transfer to every frame.
 */
import { labStats, poolStats, type LabStats } from "@shared/colour-match";
import type { Clip } from "@shared/video-project";
import type { ClipGrade } from "@shared/video-looks";
import type { Framing } from "@shared/video-compose";
import { Grader } from "./grader";

/** The raw picture of a source (a <video> at its current time, an image) drawn small into a 2D canvas, ungraded. */
export function snapshot(image: CanvasImageSource, width: number, height: number, max = 160): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(width, height));
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(width * s));
  c.height = Math.max(2, Math.round(height * s));
  c.getContext("2d")!.drawImage(image, 0, 0, c.width, c.height);
  return c;
}

let shared: Grader | null = null;
let users = 0;

/**
 * Preset thumbnails: the snapshot placed with the clip's framing in a small frame of the project's
 * shape and graded once per preset by the same shader as the preview and the render. Returns one
 * data URL per grade. One grader serves every thumbnail (a browser allows only a few WebGL contexts).
 */
export class ThumbRenderer {
  constructor() {
    users++;
  }

  render(snap: HTMLCanvasElement, frame: { width: number; height: number }, framing: Framing, grades: ClipGrade[], background = "#000000"): string[] {
    const s = Math.min(1, 120 / Math.max(frame.width, frame.height));
    const w = Math.max(2, Math.round((frame.width * s) / 2) * 2);
    const h = Math.max(2, Math.round((frame.height * s) / 2) * 2);
    shared ??= new Grader(w, h);
    shared.resize(w, h);
    shared.setLut(null);
    return grades.map((grade) => {
      shared!.draw({ image: snap, width: snap.width, height: snap.height, framing }, null, { grade, lutStrength: 0, background });
      return shared!.canvas.toDataURL("image/jpeg", 0.85);
    });
  }

  dispose(): void {
    users = Math.max(0, users - 1);
    if (!users && shared) {
      shared.dispose();
      shared = null;
    }
  }
}

/** Times inside a clip (source seconds) spread evenly between its in and out points, away from the edges. */
export function sampleTimes(clip: Pick<Clip, "in" | "out">, n: number): number[] {
  const len = Math.max(0, clip.out - clip.in);
  return Array.from({ length: Math.max(1, n) }, (_, i) => clip.in + ((i + 0.5) / Math.max(1, n)) * len);
}

const SAMPLE_PX = 96;

/** A few frames of a source as small RGBA pictures, read from a <video> of their own (the preview's element is left alone). */
export async function sampleFrames(url: string, times: number[], max = SAMPLE_PX): Promise<ImageData[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "use-credentials";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The clip could not be read for the colour match.")), 20000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("The clip could not be read for the colour match."));
      };
    });
    const out: ImageData[] = [];
    for (const t of times) {
      await new Promise<void>((resolve) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          resolve();
        };
        video.addEventListener("seeked", done);
        video.currentTime = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.05));
        setTimeout(done, 3000);
      });
      const snap = snapshot(video, video.videoWidth, video.videoHeight, max);
      out.push(snap.getContext("2d")!.getImageData(0, 0, snap.width, snap.height));
    }
    return out;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** A picture (a URL of the studio or Drive, a blob URL) loaded and measured; with a tiny JPEG of it for the project. */
export async function measurePicture(url: string): Promise<{ stats: LabStats; thumb: string; width: number; height: number }> {
  const img = new Image();
  img.crossOrigin = "use-credentials";
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error("The reference picture could not be read.");
  }
  const snap = snapshot(img, img.naturalWidth, img.naturalHeight, 256);
  const stats = labStats(snap.getContext("2d")!.getImageData(0, 0, snap.width, snap.height).data);
  return { stats, thumb: tinyJpeg(img, img.naturalWidth, img.naturalHeight), width: img.naturalWidth, height: img.naturalHeight };
}

/** A JPEG small enough to keep in the project (8 KB at most), or "" when it does not fit. */
export function tinyJpeg(image: CanvasImageSource, width: number, height: number): string {
  for (const [max, q] of [
    [64, 0.7],
    [48, 0.6],
    [32, 0.5],
  ] as const) {
    const url = snapshot(image, width, height, max).toDataURL("image/jpeg", q);
    if (url.length <= 8 * 1024) return url;
  }
  return "";
}

/** A clip's pooled statistics from `n` frames spread over it (one fit per clip: no flicker). */
export async function clipStats(url: string, clip: Pick<Clip, "in" | "out">, n = 5): Promise<{ stats: LabStats; frames: number }> {
  const frames = await sampleFrames(url, sampleTimes(clip, n));
  return { stats: poolStats(frames.map((f) => labStats(f.data))), frames: frames.length };
}
