/**
 * The browser half of scripts/video-looks-check.mjs (phase 3): the editor's real engine (media
 * store, compositor and grader, preview player, export, the colour tools) bundled on its own and
 * driven through `window`. Nothing here is part of the studio's bundle.
 */
import { MediaStore } from "@/video-editor/engine/media";
import { exportProject } from "@/video-editor/engine/export";
import { Player } from "@/video-editor/engine/preview";
import { decodeAudio } from "@/video-editor/engine/audio";
import { TEST_CODECS } from "@/video-editor/engine/capabilities";
import { clipStats, measurePicture, snapshot, ThumbRenderer } from "@/video-editor/engine/looks";
import { clipFraming, lookOf, musicFileUrl, musicSourceFromTrack, newProject, placeClips, PRESET_IDS, validateProject, type ClipSource, type VideoProject } from "@shared/video-project";
import { gradePixel, resolveGrade } from "@shared/video-looks";
import { fitTransfer, labStats, statsDistance, type ColourMatch, type Vec3 } from "@shared/colour-match";
import { parseStoredCube, sampleCube, serialiseCube } from "@shared/cube-lut";
import { applyTemplate, templateOf } from "@shared/video-templates";
import { catalogEntry } from "@shared/music-catalog";
import type { MusicTrack } from "@shared/music";

const media = new MediaStore();
let music: AudioBuffer | null = null;
const sources = new Map<string, { source: ClipSource; duration: number; width: number; height: number; url: string }>();

async function addSource(name: string, url: string) {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name, { type: "video/mp4" });
  const source: ClipSource = { kind: "upload", name, size: 0 };
  const m = await media.add(source, { url: URL.createObjectURL(file), file, label: name });
  sources.set(name, { source, duration: m.duration, width: m.width, height: m.height, url: m.url });
  return { key: m.key, duration: m.duration, width: m.width, height: m.height };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The catalog track as the studio's routes describe it (server/music.ts catalogTrack), for the project's music source. */
function catalogTrack(slug: string): MusicTrack {
  const e = catalogEntry(slug)!;
  const id = `cat:${e.slug}`;
  return { id, kind: "catalog", title: e.title, artist: e.artist, moods: e.moods, genre: e.genre, duration: e.duration, bpm: e.bpm, bpmSource: e.bpmSource, test: e.test, source: { name: e.source.name, page: e.source.page, author: e.source.author }, licence: e.licence, contentId: e.contentId, url: musicFileUrl(id), peaksUrl: "", stored: true };
}

/** A catalog track loaded the way the editor reopens one: from the music library's file route, decoded here. */
async function loadCatalogMusic(slug: string) {
  const track = catalogTrack(slug);
  const source = musicSourceFromTrack(track);
  const r = await fetch(musicFileUrl(track.id));
  music = await decodeAudio(await r.arrayBuffer());
  return { source, duration: music?.duration ?? 0, status: r.status };
}

/** A template applied to footage already added (by name), as the gallery does. */
function template(id: string, names: string[], base: Partial<VideoProject> = {}): VideoProject {
  const t = templateOf(id)!;
  const m = names.map((n) => sources.get(n)!).map((s) => ({ source: s.source, duration: s.duration }));
  return applyTemplate(t, { ...newProject(t.name, 1), ...base }, m, { language: "both", now: 1 });
}

/** A clip's colour matched to a reference picture, as the Colour panel does it: five frames pooled, one fit. */
async function fitMatch(name: string, clip: { in: number; out: number }, refUrl: string, refName: string) {
  const s = sources.get(name)!;
  const ref = await measurePicture(refUrl);
  const { stats, frames } = await clipStats(s.url, clip, 5);
  const t = fitTransfer(stats, ref.stats);
  const match: ColourMatch = { ref: { kind: "upload", id: refName, name: refName, ...(ref.thumb ? { thumb: ref.thumb } : {}) }, scale: t.scale, offset: t.offset, amount: 1, frames, at: 1 };
  return { match, clipStats: stats, refStats: ref.stats, before: statsDistance(stats, ref.stats) };
}

/** Lab statistics of raw RGB bytes (frames ffmpeg decoded from a render) and their distance to other statistics. */
function labOfRgb(rgbB64: string, refStats?: ReturnType<typeof labStats>) {
  const bin = atob(rgbB64);
  const n = bin.length / 3;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = bin.charCodeAt(i * 3);
    rgba[i * 4 + 1] = bin.charCodeAt(i * 3 + 1);
    rgba[i * 4 + 2] = bin.charCodeAt(i * 3 + 2);
    rgba[i * 4 + 3] = 255;
  }
  const s = labStats(rgba);
  return { mean: s.mean, std: s.std, distance: refStats ? statsDistance(s, refStats) : null };
}

/** What the shader should draw for a raw colour under a clip's grade (the CPU twin), with the project's LUT when it has one. */
function expected(project: VideoProject, clipIndex: number, raw: number[]): number[] {
  const g = resolveGrade(project, project.clips[clipIndex] ?? null);
  let c = gradePixel(raw.map((v) => v / 255) as Vec3, { ...g, protectSkin: false });
  const lut = project.lut?.data ? parseStoredCube({ size: project.lut.size, data: project.lut.data }) : null;
  if (lut) {
    const l = sampleCube(lut, c[0], c[1], c[2]);
    const k = project.lut!.strength;
    c = [c[0] + (l[0] - c[0]) * k, c[1] + (l[1] - c[1]) * k, c[2] + (l[2] - c[2]) * k];
  }
  if (g.protectSkin) c = gradePixel(raw.map((v) => v / 255) as Vec3, g);
  return c.map((v) => Math.round(v * 255));
}

async function render(project: VideoProject) {
  const t0 = performance.now();
  const r = await exportProject({ project, media, music, lut: null, codecs: TEST_CODECS, onProgress: () => undefined });
  const mp4 = b64(new Uint8Array(await r.blob.arrayBuffer()));
  return { width: r.width, height: r.height, duration: r.duration, frames: r.frames, mp4, ms: Math.round(performance.now() - t0) };
}

async function withPlayer<T>(project: VideoProject, t: number, opts: { bypass?: boolean; split?: number | null }, fn: (canvas: HTMLCanvasElement) => T): Promise<T> {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const player = new Player(canvas, media, project);
  player.bypass = !!opts.bypass;
  player.split = opts.split ?? null;
  player.seek(t);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const ready = media.all().every((m) => !m.video.seeking && m.video.readyState >= 2);
    if (ready && i > 12) break;
  }
  player.draw();
  await new Promise((r) => setTimeout(r, 250));
  try {
    return fn(canvas);
  } finally {
    player.dispose();
    canvas.remove();
  }
}

/** The preview at t: pixels at points (fractions), the whole frame's mean RGB, and optionally a PNG. */
async function preview(project: VideoProject, t: number, points: [number, number][], opts: { bypass?: boolean; split?: number | null; png?: boolean } = {}) {
  return withPlayer(project, t, opts, (canvas) => {
    const ctx = canvas.getContext("2d")!;
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < all.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += all[i + c];
    const n = all.length / 4;
    const pixels = points.map(([x, y]) => {
      // A 5×5 average around the point (grain in the fixtures).
      const px = Math.min(canvas.width - 3, Math.max(2, Math.floor(x * canvas.width)));
      const py = Math.min(canvas.height - 3, Math.max(2, Math.floor(y * canvas.height)));
      const d = ctx.getImageData(px - 2, py - 2, 5, 5).data;
      const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) s[c] += d[i + c];
      return s.map((v) => Math.round(v / 25));
    });
    return { size: [canvas.width, canvas.height], mean: sum.map((v) => v / n), pixels, png: opts.png ? canvas.toDataURL("image/png") : null };
  });
}

/** The five presets (and None) drawn from one frame of a clip by the real grader, as a labelled contact sheet. */
async function contactSheet(project: VideoProject, clipIndex: number, t: number) {
  const clip = project.clips[clipIndex];
  const m = media.get(clip.source)!;
  m.video.pause();
  m.video.currentTime = t;
  await new Promise<void>((r) => {
    m.video.addEventListener("seeked", () => r(), { once: true });
    setTimeout(r, 3000);
  });
  const snap = snapshot(m.video, m.width, m.height, 240);
  const ids = ["none", ...PRESET_IDS];
  const renderer = new ThumbRenderer();
  const urls = renderer.render(snap, project.output, clipFraming(project, clip), ids.map((id) => resolveGrade({ ...project, look: "none", lookAmount: 1 }, { ...clip, look: { id, amount: 1 } })), project.background);
  renderer.dispose();
  const imgs = await Promise.all(
    urls.map(
      (u) =>
        new Promise<HTMLImageElement>((r) => {
          const i = new Image();
          i.onload = () => r(i);
          i.src = u;
        }),
    ),
  );
  const tw = imgs[0].naturalWidth;
  const th = imgs[0].naturalHeight;
  const sheet = document.createElement("canvas");
  const pad = 10;
  sheet.width = ids.length * (tw + pad) + pad;
  sheet.height = th + 40;
  const g = sheet.getContext("2d")!;
  g.fillStyle = "#f4f4f6";
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.fillStyle = "#111";
  g.font = "600 11px sans-serif";
  imgs.forEach((img, i) => {
    g.drawImage(img, pad + i * (tw + pad), pad);
    g.fillText(lookOf(ids[i]).name, pad + i * (tw + pad), th + pad + 18);
  });
  // The mean colour of each thumbnail, to show they differ the way the presets say.
  const means = imgs.map((img) => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k];
    return s.map((v) => Math.round(v / (d.length / 4)));
  });
  return { png: sheet.toDataURL("image/png"), ids, means, thumb: [tw, th] };
}

/** A LUT kept with the draft: serialised, the project saved as JSON and read back (validateProject), as a reopen does. */
function withStoredLut(project: VideoProject, size: number, strength: number) {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const R = r / (size - 1);
        const G = g / (size - 1);
        const B = b / (size - 1);
        // A teal-and-orange table: warm highs, cool shadows.
        data[i++] = Math.min(1, R * 1.08 + 0.02);
        data[i++] = G;
        data[i++] = Math.min(1, B * 0.85 + 0.06 * (1 - G));
      }
  const s = serialiseCube({ title: "teal-orange", size, data });
  const saved = JSON.parse(JSON.stringify({ ...project, lut: { name: "teal-orange.cube", size: s.size, strength, data: s.data } }));
  const r = validateProject(saved);
  if (!r.ok) throw new Error(r.reason);
  return { project: r.project, chars: s.data.length };
}

Object.assign(window, { harness: { addSource, loadCatalogMusic, template, fitMatch, labOfRgb, expected, render, preview, contactSheet, withStoredLut, validate: (p: unknown) => validateProject(p), placed: (p: VideoProject) => placeClips(p.clips).map((x) => ({ start: x.start, end: x.end, overlap: x.overlap })) } });
document.title = "ready";
