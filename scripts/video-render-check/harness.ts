/**
 * The browser half of scripts/video-render-check.mjs: the editor's real engine (media store,
 * compositor, preview player, export) bundled on its own, driven by the check through `window`.
 * Nothing here is part of the studio's bundle.
 */
import { MediaStore } from "@/video-editor/engine/media";
import { exportProject, type ExportResult } from "@/video-editor/engine/export";
import { Player } from "@/video-editor/engine/preview";
import { decodeAudio } from "@/video-editor/engine/audio";
import { TEST_CODECS } from "@/video-editor/engine/capabilities";
import { newClip, type VideoProject } from "@shared/video-project";
import { alignCutsToBeats, deleteClips, moveClips, splitAt } from "@shared/video-timeline";

const media = new MediaStore();
let music: AudioBuffer | null = null;
/** Voice-over recordings by voice id (phase 2). */
const voices = new Map<string, AudioBuffer | null>();

async function setVoice(id: string, url: string): Promise<number> {
  const b = await decodeAudio(await (await fetch(url)).arrayBuffer());
  voices.set(id, b);
  return b?.duration ?? 0;
}

/** The editor's own timeline operations, so the check edits a project the way the editor does. */
const ops = { newClip, splitAt, deleteClips, moveClips, alignCutsToBeats };

async function addSource(name: string, url: string): Promise<{ key: string; duration: number; width: number; height: number }> {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name, { type: "video/mp4" });
  const m = await media.add({ kind: "upload", name, size: 0 }, { url: URL.createObjectURL(file), file, label: name });
  return { key: m.key, duration: m.duration, width: m.width, height: m.height };
}

async function setMusic(url: string): Promise<number> {
  music = await decodeAudio(await (await fetch(url)).arrayBuffer());
  return music?.duration ?? 0;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(project: VideoProject): Promise<Omit<ExportResult, "blob" | "still"> & { mp4: string; still: string | null; ms: number }> {
  const t0 = performance.now();
  const r = await exportProject({ project, media, music, voices, lut: null, codecs: TEST_CODECS, onProgress: () => undefined });
  const mp4 = b64(new Uint8Array(await r.blob.arrayBuffer()));
  const still = r.still ? b64(new Uint8Array(await r.still.arrayBuffer())) : null;
  return { width: r.width, height: r.height, duration: r.duration, frames: r.frames, videoCodec: r.videoCodec, colour: r.colour, sources: r.sources, mp4, still, ms: Math.round(performance.now() - t0) };
}

/** The preview drawn at t: the canvas's pixels at the given fractions of the frame, after the hidden videos have seeked. */
async function previewPixels(project: VideoProject, t: number, points: [number, number][]): Promise<{ size: [number, number]; pixels: number[][] }> {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const player = new Player(canvas, media, project);
  player.seek(t);
  // Wait for the elements to seek and a few frames to draw.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const ready = media.all().every((m) => !m.video.seeking);
    if (ready && i > 10) break;
  }
  player.draw();
  await new Promise((r) => setTimeout(r, 200));
  const ctx = canvas.getContext("2d")!;
  const pixels = points.map(([x, y]) => Array.from(ctx.getImageData(Math.min(canvas.width - 1, Math.floor(x * canvas.width)), Math.min(canvas.height - 1, Math.floor(y * canvas.height)), 1, 1).data.slice(0, 3)));
  const size: [number, number] = [canvas.width, canvas.height];
  player.dispose();
  canvas.remove();
  return { size, pixels };
}

/** The preview's canvas at t as a PNG data URL (to look at next to the render's frame). */
async function previewPng(project: VideoProject, t: number): Promise<string> {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const player = new Player(canvas, media, project);
  player.seek(t);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (media.all().every((m) => !m.video.seeking) && i > 10) break;
  }
  player.draw();
  await new Promise((r) => setTimeout(r, 250));
  const url = canvas.toDataURL("image/png");
  player.dispose();
  canvas.remove();
  return url;
}

/** The rotation and size a <video> element reports for a source (what a player shows). */
function elementOf(key: string) {
  const m = media.all().find((x) => x.key === key);
  return m ? { videoWidth: m.video.videoWidth, videoHeight: m.video.videoHeight } : null;
}

Object.assign(window, { harness: { addSource, setMusic, setVoice, render, previewPixels, previewPng, elementOf, ops } });
document.title = "ready";
