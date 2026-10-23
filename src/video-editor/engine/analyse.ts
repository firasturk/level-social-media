/**
 * Footage and reference videos read for the auto edit and "Edit like this video"
 * (docs/video-editor.md → Edit quality): the file is demuxed and decoded in order with WebCodecs
 * (the export's own reader, engine/demux.ts), each sampled frame drawn upright into a small canvas
 * (about 160 pixels wide) and measured by shared/shot-analysis.ts. Footage is sampled ten times a
 * second (cuts inside it are found within a tenth of a second, and the planner keeps 0.12 s away
 * from them); a reference is read frame by frame, so its cuts are found to the frame. Everything
 * happens in this tab: nothing is uploaded, nothing is generated.
 */
import { analyseFootage, frameFeatures, linkFrames, type FootageAnalysis, type FrameFeatures } from "@shared/shot-analysis";
import { labStats, poolStats, type LabStats } from "@shared/colour-match";
import { beatAccents, musicGrid, steadyBeat, type MusicGrid } from "@shared/music-bars";
import { analyseReference, type ReferenceAnalysis } from "@shared/reference-template";
import { timelineBeats, type VideoProject } from "@shared/video-project";
import { BEAT_HOP, beatsOf, decodeAudio, energyEnvelope } from "./audio";
import { demuxMp4, FrameCursor, type DemuxedVideo } from "./demux";
import type { Media, MediaStore } from "./media";

export const ANALYSIS_WIDTH = 160;
/** Footage frames read per second for the auto edit. */
export const FOOTAGE_FPS = 10;

export interface ReadFrames {
  frames: FrameFeatures[];
  video: DemuxedVideo;
  /** Lab statistics pooled over every fifth frame. */
  colour: LabStats | null;
}

/** Every `1/fps` seconds (or every frame with fps 0) of an mp4, measured. Grey copies are dropped once compared, so long videos stay small. */
export async function readFrames(bytes: ArrayBuffer, opts: { fps?: number; width?: number; onProgress?: (f: number) => void; signal?: AbortSignal } = {}): Promise<ReadFrames> {
  const video = await demuxMp4(bytes);
  const w = opts.width ?? ANALYSIS_WIDTH;
  const h = Math.max(8, Math.round((w * video.displayHeight) / Math.max(1, video.displayWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot draw the frames to measure them.");
  const times = opts.fps ? Array.from({ length: Math.max(1, Math.floor(video.duration * opts.fps + 1e-6)) }, (_, i) => i / opts.fps!) : [...video.samples].map((s) => s.cts).sort((a, b) => a - b);
  const cursor = new FrameCursor(video);
  const frames: FrameFeatures[] = [];
  const colours: LabStats[] = [];
  try {
    for (const [i, t] of times.entries()) {
      if (opts.signal?.aborted) throw new Error("Stopped.");
      const frame = await cursor.frameAt(t + 1e-4);
      if (!frame) break;
      ctx.save();
      // The decoder hands out coded frames: turn them upright as the compositor does.
      if (video.rotation === 90) {
        ctx.translate(w, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(frame, 0, 0, h, w);
      } else if (video.rotation === 270) {
        ctx.translate(0, h);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(frame, 0, 0, h, w);
      } else if (video.rotation === 180) {
        ctx.translate(w, h);
        ctx.rotate(Math.PI);
        ctx.drawImage(frame, 0, 0, w, h);
      } else ctx.drawImage(frame, 0, 0, w, h);
      ctx.restore();
      const data = ctx.getImageData(0, 0, w, h).data;
      const f = frameFeatures(Math.round(t * 1e4) / 1e4, data, w, h);
      const prev = frames[frames.length - 1];
      if (prev) {
        linkFrames(prev, f);
        prev.grey = new Float32Array(0);
      }
      frames.push(f);
      if (i % 5 === 0) colours.push(labStats(data, 2));
      if (i % 10 === 0) {
        opts.onProgress?.((i + 1) / times.length);
        // Let the page breathe between batches.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    cursor.close();
  }
  opts.onProgress?.(1);
  return { frames, video, colour: colours.length ? poolStats(colours) : null };
}

const cache = new WeakMap<Media, Promise<FootageAnalysis | null>>();

/** A source's analysis for the auto edit, read once per tab; null when the file cannot be read here. */
export function footageAnalysis(store: MediaStore, m: Media, onProgress?: (f: number) => void): Promise<FootageAnalysis | null> {
  let p = cache.get(m);
  if (!p) {
    p = store
      .bytes(m)
      .then((b) => readFrames(b, { fps: FOOTAGE_FPS, onProgress }))
      .then((r) => analyseFootage(r.frames, Math.min(m.duration, r.video.duration || m.duration)))
      .catch(() => null);
    cache.set(m, p);
  }
  return p;
}

/** A track's pulse and bars (in track seconds) from its decoded sound; null when it has no steady beat. */
export function gridOfBuffer(buffer: AudioBuffer, beats?: number[]): MusicGrid | null {
  const env = energyEnvelope(buffer, BEAT_HOP);
  const b = beats ?? beatsOf(buffer);
  if (b.length < 4) return null;
  const grid = musicGrid(b, beatAccents(b, env, BEAT_HOP));
  return steadyBeat(grid, env, BEAT_HOP) ? grid : null;
}

/**
 * The music's grid on the timeline, for the auto edit: from the decoded track when the tab has it
 * (accents read, so the bars fall on the loud beats), else from the beats stored with the draft
 * (bars counted from the first beat). Null without music.
 */
export function timelineGrid(project: Pick<VideoProject, "music">, length: number, buffer: AudioBuffer | null): MusicGrid | null {
  const m = project.music;
  if (!m?.beats?.length) return null;
  const env = buffer ? energyEnvelope(buffer, BEAT_HOP) : null;
  const grid = musicGrid(m.beats, env ? beatAccents(m.beats, env, BEAT_HOP) : m.beats.map(() => 1));
  const toTimeline = (xs: number[]) => timelineBeats({ ...m, beats: xs }, length);
  const pulse = toTimeline(grid.pulse);
  return pulse.length > 1 ? { ...grid, pulse, bars: toTimeline(grid.bars) } : null;
}

/** A reference video read whole: its frames one by one, its colour, its music's beat when it has one. */
export async function analyseReferenceFile(bytes: ArrayBuffer, source: ReferenceAnalysis["source"], onProgress?: (label: string, f: number) => void): Promise<ReferenceAnalysis> {
  const read = await readFrames(bytes, { fps: 0, onProgress: (f) => onProgress?.("Reading the reference's frames", f) });
  const v = read.video;
  if (v.duration > 180) throw new Error("The reference is longer than 3 minutes; pick a shorter video.");
  onProgress?.("Listening for a beat", 0);
  const audio = await decodeAudio(bytes);
  const grid = audio ? gridOfBuffer(audio) : null;
  const fps = v.samples.length / Math.max(0.01, v.duration);
  return analyseReference(read.frames, { duration: v.duration, width: v.displayWidth, height: v.displayHeight, fps: Math.round(fps * 100) / 100, source }, { grid, colour: read.colour ? { mean: read.colour.mean.map((x) => Math.round(x * 100) / 100) as [number, number, number], std: read.colour.std.map((x) => Math.round(x * 100) / 100) as [number, number, number] } : null });
}
