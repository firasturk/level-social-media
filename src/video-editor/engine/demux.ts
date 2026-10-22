/**
 * An mp4 read into its H.264 samples with mp4box.js, and a cursor that hands out decoded frames
 * in order through WebCodecs' VideoDecoder. The export walks each clip forward, so the cursor
 * decodes sequentially and restarts from the nearest key frame only when asked to go backwards.
 * Every VideoFrame is closed here once it is replaced; the caller never keeps one.
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Movie, type MultiBufferStream, type Sample, type Track, type VisualSampleEntry } from "mp4box";

export interface DemuxedVideo {
  codec: string;
  /** The avcC record VideoDecoder needs for AVC-format samples. */
  description: Uint8Array | undefined;
  width: number;
  height: number;
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
    if (!/^avc[13]/.test(t.codec)) {
      reject(new Error(`The clip is ${t.codec.split(".")[0]}, not H.264: the editor reads H.264 MP4s only.`));
      return;
    }
    const description = avcDescription(file, t.id);
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
    resolve({ codec: t.codec, description, width: t.video?.width ?? t.track_width, height: t.video?.height ?? t.track_height, duration: last || t.duration / t.timescale, samples: out });
  });
}

/** The avcC box's payload (after its 8-byte header), which is the AVCDecoderConfigurationRecord. */
function avcDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId);
  const entries = (trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) as VisualSampleEntry[];
  for (const e of entries) {
    const box = e.avcC;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream as unknown as MultiBufferStream);
    return new Uint8Array(stream.buffer, 8);
  }
  return undefined;
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
  constructor(readonly video: DemuxedVideo) {}

  private open(fromSample: number): void {
    this.closeDecoder();
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.pending.push(f);
        this.wake?.();
      },
      error: (e) => {
        this.failed = new Error(`Decoding failed: ${e.message}`);
        this.wake?.();
      },
    });
    this.decoder.configure({ codec: this.video.codec, description: this.video.description, optimizeForLatency: false });
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
