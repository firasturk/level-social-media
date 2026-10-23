/**
 * FFmpeg's AAC-LC encoder as WebAssembly (src/video-editor/engine/aac-encoder.wasm, built by
 * scripts/aac-wasm/build.sh from FFmpeg 8.1.3, LGPL-2.1-or-later), driven from JavaScript. No DOM
 * here: the video editor's fallback (src/video-editor/engine/aac-fallback.ts) and the Node tests
 * (tests/aac-fallback.test.ts) both use it; the server never imports it.
 *
 * The module is a WASI "reactor" with no JavaScript glue: the few WASI calls libavutil links
 * (environment, clock, files) are answered here with "nothing there", since the encoder never
 * reads a file or the environment. Input is planar float PCM written straight into the encoder's
 * frame; output is raw AAC access units (no ADTS headers) with their times in samples. FFmpeg's
 * encoder starts `priming` (1024) samples early: the first unit's time is −1024.
 */

export interface AacUnit {
  data: Uint8Array;
  /** Presentation time in samples, as the encoder gives it (the first is −priming). */
  pts: number;
  /** Samples. */
  duration: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  aac_open(sampleRate: number, channels: number, bitrate: number): number;
  aac_close(): void;
  aac_frame_size(): number;
  aac_initial_padding(): number;
  aac_extradata(): number;
  aac_extradata_size(): number;
  aac_input(channel: number): number;
  aac_encode(samples: number, pts: number): number;
  aac_out_data(): number;
  aac_out_sizes(): number;
  aac_out_pts(): number;
  aac_out_durations(): number;
  aac_out_clear(): void;
}

const EBADF = 8;

/** The WASI imports the module links, all answering "no such thing" (nothing is ever read or written). */
function wasi(memory: () => WebAssembly.Memory): Record<string, (...a: never[]) => number> {
  const zero = (...ptrs: number[]) => {
    const v = new DataView(memory().buffer);
    for (const p of ptrs) v.setUint32(p, 0, true);
    return 0;
  };
  return {
    environ_sizes_get: (count: number, size: number) => zero(count, size),
    environ_get: () => 0,
    clock_time_get: (_id: number, _precision: bigint, out: number) => {
      new DataView(memory().buffer).setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
    fd_close: () => EBADF,
    fd_fdstat_get: () => EBADF,
    fd_fdstat_set_flags: () => EBADF,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_read: () => EBADF,
    fd_seek: () => EBADF,
    fd_write: () => EBADF,
    path_open: () => EBADF,
    proc_exit: (code: number) => {
      throw new Error(`The AAC encoder stopped (exit ${code}).`);
    },
  };
}

export class AacWasmEncoder {
  readonly frameSize: number;
  /** Samples the encoder delays its output by (FFmpeg's AAC: 1024). */
  readonly priming: number;
  /** The AudioSpecificConfig FFmpeg wrote (it marks SBR absent explicitly after the two plain bytes). */
  readonly extradata: Uint8Array;
  readonly channels: number;
  private readonly x: Exports;
  private closed = false;

  private constructor(x: Exports, channels: number) {
    this.x = x;
    this.channels = channels;
    this.frameSize = x.aac_frame_size();
    this.priming = x.aac_initial_padding();
    this.extradata = new Uint8Array(x.memory.buffer, x.aac_extradata(), x.aac_extradata_size()).slice();
  }

  /** A fresh instance of the module (each encoder has its own memory), opened for AAC-LC. */
  static async create(module: WebAssembly.Module, sampleRate: number, channels: number, bitrate: number): Promise<AacWasmEncoder> {
    let memory: WebAssembly.Memory | null = null;
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi(() => memory!) });
    const x = instance.exports as unknown as Exports;
    memory = x.memory;
    x._initialize?.();
    const r = x.aac_open(sampleRate, channels, bitrate);
    if (r < 0) throw new Error(`The AAC encoder could not start (error ${r}).`);
    return new AacWasmEncoder(x, channels);
  }

  /** Encodes one frame (frameSize samples per channel, fewer only for the last) starting at sample `pts`. */
  encode(planes: Float32Array[], pts: number): AacUnit[] {
    if (this.closed) throw new Error("The AAC encoder is closed.");
    const n = planes[0].length;
    if (n < 1 || n > this.frameSize) throw new Error(`An AAC frame takes 1 to ${this.frameSize} samples, not ${n}.`);
    for (let c = 0; c < this.channels; c++) {
      const ptr = this.x.aac_input(c);
      if (!ptr) throw new Error("The AAC encoder has no input buffer.");
      new Float32Array(this.x.memory.buffer, ptr, n).set((planes[c] ?? planes[0]).subarray(0, n));
    }
    return this.collect(this.x.aac_encode(n, pts));
  }

  /** The units still inside the encoder (its delay and the padding of the last frame). */
  flush(): AacUnit[] {
    if (this.closed) return [];
    return this.collect(this.x.aac_encode(0, 0));
  }

  private collect(count: number): AacUnit[] {
    if (count < 0) throw new Error(`AAC encoding failed (error ${count}).`);
    const buf = this.x.memory.buffer;
    const sizes = new Int32Array(buf, this.x.aac_out_sizes(), count);
    const pts = new Float64Array(buf, this.x.aac_out_pts(), count);
    const durations = new Float64Array(buf, this.x.aac_out_durations(), count);
    const data = this.x.aac_out_data();
    const out: AacUnit[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      out.push({ data: new Uint8Array(buf, data + at, sizes[i]).slice(), pts: pts[i], duration: durations[i] });
      at += sizes[i];
    }
    this.x.aac_out_clear();
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.x.aac_close();
  }
}
