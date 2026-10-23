/**
 * An mp4 read into its video samples with mp4box.js, and a cursor that hands out decoded frames
 * in order through WebCodecs' VideoDecoder. The export walks each clip forward, so the cursor
 * decodes sequentially and restarts from the nearest key frame only when asked to go backwards.
 * Every VideoFrame is closed here once it is replaced; the caller never keeps one.
 *
 * Read on import, so the export draws every source the same way:
 *  - the display rotation from the track header's matrix (a phone held upright stores landscape
 *    pixels with a 90° matrix): the decoder hands out coded frames, the compositor turns them;
 *  - the colour description from the sample entry's `colr` box (nclx): handed to the decoder so
 *    the frames convert to RGB with the file's own matrix and range; a file that says nothing gets
 *    the broadcast convention for its size (shared/video-compose.ts `assumedColour`).
 * H.264 is what the studio stores; VP9 and AV1 MP4s are read too (the test renders use them where
 * the browser has no H.264).
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Movie, type MultiBufferStream, type Sample, type Track, type VisualSampleEntry } from "mp4box";
import { assumedColour, colourFromNclx, displaySize, rotationOfMatrix, type Rotation, type SourceColour } from "@shared/video-compose";

export interface DemuxedVideo {
  codec: string;
  /** The avcC (or av1C) record VideoDecoder needs; undefined for VP9. */
  description: Uint8Array | undefined;
  /** The coded size: what the decoder hands out. */
  width: number;
  height: number;
  /** Clockwise display rotation from the track header. */
  rotation: Rotation;
  /** The size a player shows (the coded size turned by the rotation). */
  displayWidth: number;
  displayHeight: number;
  /** What the file says about its colour (nulls when it says nothing). */
  colour: SourceColour | null;
  /** Seconds. */
  duration: number;
  samples: DemuxSample[];
}

export interface DemuxSample {
  /** Presentation time, seconds from the first frame. */
  cts: number;
  /** Decode time, seconds. */
  dts: number;
  duration: number;
  key: boolean;
  data: Uint8Array;
}

/** The whole file parsed in memory (clips are 60 MB at most). */
export function demuxMp4(bytes: ArrayBuffer): Promise<DemuxedVideo> {
  return new Promise((resolve, reject) => {
    const file: ISOFile = createFile();
    let info: Movie | null = null;
    let track: Track | null = null;
    const samples: Sample[] = [];
    file.onError = (e: unknown) => reject(new Error(`The clip could not be read: ${String(e)}`));
    file.onReady = (movie: Movie) => {
      info = movie;
      track = movie.videoTracks[0] ?? null;
      if (!track) {
        reject(new Error("The clip has no video track."));
        return;
      }
      file.setExtractionOptions(track.id, null, { nbSamples: 1_000_000 });
      file.start();
    };
    file.onSamples = (_id: number, _user: unknown, list: Sample[]) => {
      samples.push(...list);
    };
    const buffer = MP4BoxBuffer.fromArrayBuffer(bytes, 0);
    file.appendBuffer(buffer, true);
    file.flush();
    if (!info || !track) {
      reject(new Error("The clip is not an MP4 the editor can read (no moov index found)."));
      return;
    }
    const t = track as Track;
    if (!/^(avc[13]|vp09|av01)/.test(t.codec)) {
      reject(new Error(`The clip is ${t.codec.split(".")[0]}, not H.264: the editor reads H.264 MP4s only.`));
      return;
    }
    const description = codecDescription(file, t.id);
    const rotation = rotationOfMatrix(t.matrix);
    if (!samples.length) {
      reject(new Error("The clip has no frames."));
      return;
    }
    const timescale = samples[0].timescale || t.timescale;
    const t0 = Math.min(...samples.map((s) => s.cts)) / timescale;
    const out: DemuxSample[] = samples
      .map((s) => ({ cts: s.cts / timescale - t0, dts: s.dts / timescale, duration: s.duration / timescale, key: s.is_sync, data: s.data ?? new Uint8Array(0) }))
      .sort((a, b) => a.dts - b.dts);
    const last = out.reduce((m, s) => Math.max(m, s.cts + s.duration), 0);
    const width = t.video?.width ?? t.track_width;
    const height = t.video?.height ?? t.track_height;
    const shown = displaySize({ width, height }, rotation);
    resolve({ codec: t.codec, description, width, height, rotation, displayWidth: shown.width, displayHeight: shown.height, colour: colourOf(file, t.id), duration: last || t.duration / t.timescale, samples: out });
  });
}

function sampleEntries(file: ISOFile, trackId: number): VisualSampleEntry[] {
  const trak = file.getTrackById(trackId);
  return (trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) as VisualSampleEntry[];
}

/** The avcC (or av1C) box's payload after its 8-byte header: the decoder configuration record. */
function codecDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  for (const e of sampleEntries(file, trackId)) {
    const box = e.avcC ?? e.av1C;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream as unknown as MultiBufferStream);
    return new Uint8Array(stream.buffer, 8);
  }
  return undefined;
}

/** The sample entry's `colr` box, when it is an nclx description (an ICC profile is not read). */
function colourOf(file: ISOFile, trackId: number): SourceColour | null {
  for (const e of sampleEntries(file, trackId)) {
    const boxes = ((e as unknown as { boxes?: { type: string; colour_type?: string; colour_primaries?: number; transfer_characteristics?: number; matrix_coefficients?: number; full_range_flag?: number }[] }).boxes ?? []).filter((b) => b.type === "colr");
    const nclx = boxes.find((b) => b.colour_type === "nclx" || b.colour_type === "nclc");
    if (nclx) return colourFromNclx(nclx.colour_primaries ?? 2, nclx.transfer_characteristics ?? 2, nclx.matrix_coefficients ?? 2, nclx.full_range_flag === 1);
  }
  return null;
}

/**
 * Frames of one clip in presentation order. `frameAt(t)` returns the frame shown at source time t
 * (the last frame whose time is ≤ t); going backwards reopens the decoder at the key frame before t.
 */
export class FrameCursor {
  private decoder: VideoDecoder | null = null;
  private pending: VideoFrame[] = [];
  private held: VideoFrame | null = null;
  private next = 0;
  private atEnd = false;
  private wake: (() => void) | null = null;
  private failed: Error | null = null;
  /** The colour the first decoded frame was labelled with (after the configuration below). */
  observed: SourceColour | null = null;
  constructor(readonly video: DemuxedVideo) {}

  private open(fromSample: number): void {
    this.closeDecoder();
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.observed ??= { primaries: f.colorSpace?.primaries ?? null, transfer: f.colorSpace?.transfer ?? null, matrix: f.colorSpace?.matrix ?? null, fullRange: f.colorSpace?.fullRange ?? null };
        this.pending.push(f);
        this.wake?.();
      },
      error: (e) => {
        this.failed = new Error(`Decoding failed: ${e.message}`);
        this.wake?.();
      },
    });
    // The colour the container states, else the convention for the size (what <video> players use for an
    // unlabelled file: BT.601 below 720 lines, BT.709 above), is handed to the decoder. Without this the
    // decoder labels an unknown stream BT.709 whatever its size, and SD footage would render with other
    // colours than the preview shows (measured: green 255 → 214).
    const c = assumedColour(this.video.colour, Math.min(this.video.width, this.video.height));
    this.decoder.configure({ codec: this.video.codec, description: this.video.description, optimizeForLatency: false, colorSpace: { primaries: c.primaries as VideoColorPrimaries, transfer: c.transfer as VideoTransferCharacteristics, matrix: c.matrix as VideoMatrixCoefficients, fullRange: c.fullRange } });
    this.next = fromSample;
    this.atEnd = false;
    this.failed = null;
  }

  private closeDecoder(): void {
    for (const f of this.pending) f.close();
    this.pending = [];
    this.held?.close();
    this.held = null;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  private keyBefore(t: number): number {
    let idx = 0;
    this.video.samples.forEach((s, i) => {
      if (s.key && s.cts <= t + 1e-6) idx = i;
    });
    return idx;
  }

  private feed(): void {
    const d = this.decoder!;
    const s = this.video.samples[this.next++];
    d.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: Math.round(s.cts * 1e6), duration: Math.round(s.duration * 1e6), data: s.data }));
  }

  private waitOutput(): Promise<void> {
    return new Promise((r) => {
      this.wake = () => {
        this.wake = null;
        r();
      };
      // A decoder can sit on a few chunks before it emits: a short tick keeps the loop alive.
      setTimeout(() => this.wake?.(), 40);
    });
  }

  /** The frame on screen at source time t. The returned frame belongs to the cursor: draw it, do not close it. */
  async frameAt(t: number): Promise<VideoFrame | null> {
    const target = Math.max(0, Math.min(t, this.video.duration));
    const heldTs = this.held ? this.held.timestamp / 1e6 : null;
    if (!this.decoder || (heldTs !== null && target < heldTs - 1e-3)) this.open(this.keyBefore(target));
    for (;;) {
      if (this.failed) throw this.failed;
      while (this.pending.length && this.pending[0].timestamp / 1e6 <= target + 1e-4) {
        this.held?.close();
        this.held = this.pending.shift()!;
      }
      if (this.pending.length) return this.held ?? this.pending[0];
      if (this.atEnd) return this.held;
      if (this.next >= this.video.samples.length) {
        this.atEnd = true;
        await this.decoder!.flush().catch(() => undefined);
        continue;
      }
      // Keep a few chunks in flight; wait for an output when the queue is deep enough.
      let fed = 0;
      while (this.next < this.video.samples.length && this.decoder!.decodeQueueSize < 6 && fed < 4) {
        this.feed();
        fed++;
      }
      if (!this.pending.length) await this.waitOutput();
    }
  }

  close(): void {
    this.closeDecoder();
  }
}
