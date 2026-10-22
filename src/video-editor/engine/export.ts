/**
 * The render: every output frame of the timeline decoded (WebCodecs), graded (the shader), encoded
 * to H.264 (VideoEncoder) and muxed with the AAC sound (AudioEncoder) into an MP4 whose `moov`
 * sits in front (mp4-muxer, fastStart in memory), so iPhone and Instagram play it from the first
 * byte. Everything runs in this tab; nothing is sent anywhere until the person stores the result.
 *
 * Steps: 1. capability check (stops with a plain message, no other codec is tried);
 *        2. the sound rendered offline and encoded to AAC;
 *        3. for each frame time t: the clip(s) on screen, their source frames from the cursors
 *           (two during a crossfade), one draw through the grader, one VideoFrame to the encoder;
 *        4. flush, finalize, a Blob.
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { CubeLut } from "@shared/cube-lut";
import { frameAt, lookOf, totalLength, type VideoProject } from "@shared/video-project";
import { checkCapabilities } from "./capabilities";
import { demuxMp4, FrameCursor, type DemuxedVideo } from "./demux";
import { encodeAac, renderMix } from "./audio";
import { combineColour, Grader } from "./grader";
import type { MediaStore } from "./media";

export interface ExportProgress {
  phase: "checking" | "reading" | "sound" | "frames" | "finishing";
  /** 0…1 within the phase. */
  fraction: number;
  /** Frames done, when in the frames phase. */
  frame?: number;
  frames?: number;
}

export interface ExportArgs {
  project: VideoProject;
  media: MediaStore;
  music: AudioBuffer | null;
  lut: CubeLut | null;
  onProgress: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export async function exportProject(args: ExportArgs): Promise<Blob> {
  const { project, media, onProgress, signal } = args;
  const abort = () => {
    if (signal?.aborted) throw new Error("Export stopped.");
  };
  onProgress({ phase: "checking", fraction: 0 });
  const caps = await checkCapabilities(project.output);
  if (!caps.canExport || !caps.videoCodec) throw new Error(`${caps.message} ${caps.details.join(" ")}`.trim());
  const length = totalLength(project);
  if (length <= 0) throw new Error("The timeline is empty: add a clip first.");
  const { width, height, fps, bitrate } = project.output;

  // 1. The footage, read into memory and demuxed once per source.
  onProgress({ phase: "reading", fraction: 0 });
  const demuxed = new Map<string, DemuxedVideo>();
  // One decoder per clip (two windows of the same footage can then crossfade), opened when the clip comes up and closed when it is past.
  const cursors = new Map<string, FrameCursor>();
  const clipAudio = new Map<string, AudioBuffer | null>();
  const sources = project.clips.map((c) => media.get(c.source));
  if (sources.some((s) => !s)) throw new Error("A clip's footage is not loaded in this tab (an uploaded file from an earlier session?). Remove it or add the file again.");
  let done = 0;
  for (const [i, c] of project.clips.entries()) {
    abort();
    const m = sources[i]!;
    if (!demuxed.has(m.key)) demuxed.set(m.key, await demuxMp4(await media.bytes(m)));
    if (!project.music) clipAudio.set(c.id, await media.audio(m));
    onProgress({ phase: "reading", fraction: ++done / project.clips.length });
  }
  const cursorFor = (clipIndex: number): { cursor: FrameCursor; width: number; height: number } => {
    const clip = project.clips[clipIndex];
    const d = demuxed.get(sources[clipIndex]!.key)!;
    let cursor = cursors.get(clip.id);
    if (!cursor) {
      cursor = new FrameCursor(d);
      cursors.set(clip.id, cursor);
    }
    return { cursor, width: d.width, height: d.height };
  };

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height, frameRate: fps },
    audio: { codec: "aac", sampleRate: 48000, numberOfChannels: 2 },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  // 2. Sound: the mix rendered offline, then AAC.
  onProgress({ phase: "sound", fraction: 0 });
  const mix = await renderMix(project, clipAudio, args.music);
  abort();
  await encodeAac(mix, (chunk, meta) => muxer.addAudioChunk(chunk, meta));
  onProgress({ phase: "sound", fraction: 1 });

  // 3. Frames.
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = new Error(`H.264 encoding failed: ${e.message}`);
    },
  });
  encoder.configure({ codec: caps.videoCodec, width, height, framerate: fps, bitrate, bitrateMode: "variable", latencyMode: "quality", avc: { format: "avc" } });
  const grader = new Grader(width, height);
  grader.setLut(args.lut);
  const base = combineColour(lookOf(project.look).params, project.colour);
  const lutStrength = project.lut?.strength ?? 1;
  const frames = Math.max(1, Math.round(length * fps));
  const frameUs = Math.round(1e6 / fps);
  try {
    for (let i = 0; i < frames; i++) {
      abort();
      if (encodeError) throw encodeError;
      const t = i / fps;
      const on = frameAt(project.clips, t);
      if (!on.a) {
        grader.clear();
      } else {
        const sa = cursorFor(on.a.placed.index);
        const fa = await sa.cursor.frameAt(on.a.source);
        let b: { source: { image: VideoFrame; width: number; height: number }; mix: number } | null = null;
        if (on.b) {
          const sb = cursorFor(on.b.placed.index);
          const fb = await sb.cursor.frameAt(on.b.source);
          if (fb) b = { source: { image: fb, width: sb.width, height: sb.height }, mix: on.b.mix };
        }
        if (fa) grader.draw({ image: fa, width: sa.width, height: sa.height }, b, { params: combineColour(base, on.a.placed.clip.colour), lutStrength });
        else grader.clear();
        // Decoders of clips that are over are closed so at most two are open at a time.
        for (const [id, cursor] of cursors) {
          if (id !== on.a.placed.clip.id && id !== on.b?.placed.clip.id) {
            cursor.close();
            cursors.delete(id);
          }
        }
      }
      const frame = new VideoFrame(grader.canvas, { timestamp: i * frameUs, duration: frameUs });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      if (i % 3 === 0) onProgress({ phase: "frames", fraction: (i + 1) / frames, frame: i + 1, frames });
    }
    onProgress({ phase: "finishing", fraction: 0 });
    await encoder.flush();
    if (encodeError) throw encodeError;
    encoder.close();
    muxer.finalize();
  } finally {
    for (const c of cursors.values()) c.close();
    grader.dispose();
    if (encoder.state !== "closed") encoder.close();
  }
  onProgress({ phase: "finishing", fraction: 1 });
  return new Blob([target.buffer], { type: "video/mp4" });
}
