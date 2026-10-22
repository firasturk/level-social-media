/**
 * How much a clip moves, second by second: frames are read every `step` seconds through a
 * hidden <video> element, drawn at 48×48, and the mean absolute difference between one frame
 * and the previous is the energy (0…1). The auto-edit planner (shared/video-project) picks each
 * clip's liveliest window from it. A heuristic: a camera pan counts as motion as much as a
 * dancing subject does.
 */
export const ENERGY_STEP = 0.5;

export async function motionEnergy(video: HTMLVideoElement, step = ENERGY_STEP, onProgress?: (fraction: number) => void): Promise<Float32Array> {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const n = Math.max(1, Math.floor(duration / step));
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new Float32Array(n);
  const out = new Float32Array(n);
  let prev: Uint8ClampedArray | null = null;
  const wasPaused = video.paused;
  const wasAt = video.currentTime;
  video.pause();
  for (let i = 0; i < n; i++) {
    await seekTo(video, Math.min(duration - 0.001, i * step));
    ctx.drawImage(video, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    if (prev) {
      let sum = 0;
      for (let j = 0; j < px.length; j += 4) {
        const l = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114;
        const pl = prev[j] * 0.299 + prev[j + 1] * 0.587 + prev[j + 2] * 0.114;
        sum += Math.abs(l - pl);
      }
      out[i] = sum / (size * size) / 255;
    }
    prev = px;
    onProgress?.((i + 1) / n);
  }
  if (n > 1) out[0] = out[1];
  await seekTo(video, wasAt).catch(() => undefined);
  if (!wasPaused) void video.play().catch(() => undefined);
  return out;
}

export function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("The clip could not be read at that time."));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      clearTimeout(timer);
    };
    const timer = setTimeout(fail, 8000);
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = t;
  });
}
