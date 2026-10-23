/**
 * The render: every output frame of the timeline decoded (WebCodecs), composed by the same
 * compositor as the preview (compose.ts: framing, rotation, colour, background, text and logo
 * layers), turned into BT.709 limited-range I420 on the GPU, encoded to H.264 (VideoEncoder) and
 * muxed with the AAC sound (AudioEncoder) into an MP4 whose `moov` sits in front (mp4-muxer,
 * fastStart in memory), so iPhone and Instagram play it from the first byte. The encoded size is
 * the project's output size, which the frame toggles (9:16, 4:5, 1:1, 16:9) set. Everything runs
 * in this tab; nothing is sent anywhere until the person stores the result.
 *
 * Steps: 1. capability check (stops with a plain message, no other codec is tried);
 *        2. the footage demuxed, its rotation and colour read; the sound rendered offline and encoded;
 *        3. for each frame time t: the clip(s) on screen from the decoders (two during a crossfade),
 *           one composite, one I420 VideoFrame to the encoder; a still kept at `stillAt`;
 *        4. flush, finalize, a Blob with its size, length and what each source was.
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { CubeLut } from "@shared/cube-lut";
import { totalLength, type VideoProject } from "@shared/video-project";
import { isHdr, OUTPUT_COLOUR, type Rotation, type SourceColour } from "@shared/video-compose";
import { checkCapabilities, STUDIO_CODECS, type ExportCodecs } from "./capabilities";
import { demuxMp4, FrameCursor, type DemuxedVideo } from "./demux";
import { encodeAac, renderMix } from "./audio";
import { composeFrame, type Picture } from "./compose";
import { Grader } from "./grader";
import type { MediaStore } from "./media";
import { OverlayLayer } from "./overlays";

export interface ExportProgress {
  phase: "checking" | "reading" | "sound" | "frames" | "finishing";
  /** 0…1 within the phase. */
  fraction: number;
  /** Frames done, when in the frames phase. */
  frame?: number;
  frames?: number;
}

/** The whole render as one number, for the status line ("Rendering 42%") and the job's heartbeat. */
export function overallProgress(p: ExportProgress): number {
  const span: Record<ExportProgress["phase"], [number, number]> = { checking: [0, 0.01], reading: [0.01, 0.06], sound: [0.06, 0.1], frames: [0.1, 0.97], finishing: [0.97, 1] };
  const [a, b] = span[p.phase];
  return a + (b - a) * Math.max(0, Math.min(1, p.fraction));
}

export interface ExportArgs {
  project: VideoProject;
  media: MediaStore;
  music: AudioBuffer | null;
  lut: CubeLut | null;
  onProgress: (p: ExportProgress) => void;
  signal?: AbortSignal;
  /** H.264 + AAC for the studio (the default); VP9 + Opus only in the automated render test. */
  codecs?: ExportCodecs;
  /** Timeline seconds of the still kept as the poster (default: a third in, at most 1 s). */
  stillAt?: number;
}

/** What one source was, as read on import: shown in the docs' checklist and the test. */
export interface SourceReport {
  label: string;
  codec: string;
  coded: { width: number; height: number };
  display: { width: number; height: number };
  rotation: Rotation;
  colour: SourceColour | null;
  /** What the first decoded frame said about its colour. */
  decoded: SourceColour | null;
  /** True when the file has no colour description and the size's convention was used. */
  assumed: boolean;
  hdr: boolean;
}

export interface ExportResult {
  blob: Blob;
  /** A JPEG of the composite at `stillAt` (the poster), or null. */
  still: Blob | null;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  frames: number;
  videoCodec: string;
  /** What the encoder said about the colour it wrote (else the colour the frames were tagged with). */
  colour: VideoColorSpaceInit;
  sources: SourceReport[];
}

export async function exportProject(args: ExportArgs): Promise<ExportResult> {
  const { project, media, onProgress, signal } = args;
  const codecs = args.codecs ?? STUDIO_CODECS;
  const abort = () => {
    if (signal?.aborted) throw new Error("Render stopped.");
  };
  onProgress({ phase: "checking", fraction: 0 });
  const caps = await checkCapabilities(project.output, codecs);
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
  const reports = new Map<string, SourceReport>();
  const cursorFor = (clipIndex: number): { cursor: FrameCursor; d: DemuxedVideo; key: string } => {
    const clip = project.clips[clipIndex];
    const key = sources[clipIndex]!.key;
    const d = demuxed.get(key)!;
    let cursor = cursors.get(clip.id);
    if (!cursor) {
      cursor = new FrameCursor(d);
      cursors.set(clip.id, cursor);
    }
    return { cursor, d, key };
  };

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: codecs.video, width, height, frameRate: fps },
    audio: { codec: codecs.audio, sampleRate: 48000, numberOfChannels: 2 },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  // 2. Sound: the mix rendered offline, then AAC.
  onProgress({ phase: "sound", fraction: 0 });
  const mix = await renderMix(project, clipAudio, args.music);
  abort();
  await encodeAac(mix, (chunk, meta) => muxer.addAudioChunk(chunk, meta), codecs.audio === "opus" ? "opus" : "mp4a.40.2");
  onProgress({ phase: "sound", fraction: 1 });

  // 3. Frames.
  let encodeError: Error | null = null;
  let written: VideoColorSpaceInit | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      // The file is tagged with the colour the frames carry (BT.709 limited) when the encoder does not say.
      if (meta?.decoderConfig) {
        written ??= meta.decoderConfig.colorSpace ?? null;
        if (!meta.decoderConfig.colorSpace?.matrix) meta = { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: { ...OUTPUT_COLOUR } } };
      }
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      encodeError = new Error(`${codecs.video === "avc" ? "H.264" : "VP9"} encoding failed: ${e.message}`);
    },
  });
  encoder.configure({ codec: caps.videoCodec, width, height, framerate: fps, bitrate, bitrateMode: "variable", latencyMode: "quality", ...(codecs.video === "avc" ? { avc: { format: "avc" as const } } : {}) });
  const grader = new Grader(width, height);
  grader.setLut(args.lut);
  const overlays = new OverlayLayer(width, height);
  await overlays.prepare(project.overlays);
  const frames = Math.max(1, Math.round(length * fps));
  const frameUs = Math.round(1e6 / fps);
  const stillFrame = Math.min(frames - 1, Math.max(0, Math.round((args.stillAt ?? Math.min(1, length / 3)) * fps)));
  let still: Blob | null = null;
  const picture = async (clipIndex: number, source: number): Promise<Picture | null> => {
    const { cursor, d, key } = cursorFor(clipIndex);
    const frame = await cursor.frameAt(source);
    if (!reports.has(key)) {
      const m = sources[clipIndex]!;
      reports.set(key, { label: m.label, codec: d.codec, coded: { width: d.width, height: d.height }, display: { width: d.displayWidth, height: d.displayHeight }, rotation: d.rotation, colour: d.colour, decoded: cursor.observed, assumed: !d.colour, hdr: isHdr(d.colour) || isHdr(cursor.observed) });
    }
    return frame ? { image: frame, width: d.displayWidth, height: d.displayHeight, rotation: d.rotation } : null;
  };
  try {
    for (let i = 0; i < frames; i++) {
      abort();
      if (encodeError) throw encodeError;
      const t = i / fps;
      const on = await composeFrame(grader, overlays, project, t, picture);
      // Decoders of clips that are over are closed so at most two are open at a time.
      for (const [id, cursor] of cursors) {
        if (!on.includes(id)) {
          cursor.close();
          cursors.delete(id);
        }
      }
      if (i === stillFrame) still = await new Promise<Blob | null>((r) => grader.canvas.toBlob((b) => r(b), "image/jpeg", 0.85));
      const frame = grader.canReadI420
        ? new VideoFrame(grader.readI420(), { format: "I420", codedWidth: width, codedHeight: height, timestamp: i * frameUs, duration: frameUs, colorSpace: { ...OUTPUT_COLOUR } })
        : new VideoFrame(grader.canvas, { timestamp: i * frameUs, duration: frameUs });
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
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    still,
    width,
    height,
    duration: frames / fps,
    frames,
    videoCodec: caps.videoCodec,
    colour: written ?? { ...OUTPUT_COLOUR },
    sources: [...reports.values()],
  };
}
