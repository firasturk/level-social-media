/**
 * AAC in an MP4, the parts that need no browser (used by the video editor's AAC fallback,
 * src/video-editor/engine/aac-fallback.ts, and tested in tests/aac-mp4.test.ts):
 *
 *  - the AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1) the `esds` box carries, built and read;
 *  - the time of each access unit: 1024 samples each, computed from the sample count so rounding to
 *    microseconds never adds up (the muxer turns them back into exact 1024-sample deltas);
 *  - an edit list (`edts`/`elst`) added to the sound track of a finished faststart MP4, so the
 *    encoder's priming samples (1024 for FFmpeg's AAC encoder) and the padding after the last
 *    sample are not played: the sound then starts exactly with the first video frame, as in MP4s
 *    written by FFmpeg or an iPhone. mp4-muxer has no edit lists, so the box is inserted after
 *    `finalize()`, and every chunk offset (`stco`/`co64`) is moved by the inserted size.
 */

export const AAC_FRAME = 1024;
/** Audio object type 2: AAC Low Complexity, the one profile iPhone and Instagram expect. */
export const AAC_LC = 2;

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The two-byte AudioSpecificConfig of plain AAC: object type, sampling frequency index, channel configuration, GASpecificConfig all zero (1024-sample frames). */
export function audioSpecificConfig(sampleRate: number, channels: number, objectType = AAC_LC): Uint8Array {
  const index = RATES.indexOf(sampleRate);
  if (index < 0) throw new Error(`AAC has no sampling frequency index for ${sampleRate} Hz.`);
  if (!Number.isInteger(channels) || channels < 1 || channels > 7) throw new Error(`AAC channel configuration ${channels} is not supported.`);
  if (objectType < 1 || objectType > 30) throw new Error(`Audio object type ${objectType} is out of range.`);
  const bits = (objectType << 11) | (index << 7) | (channels << 3);
  return new Uint8Array([bits >> 8, bits & 0xff]);
}

export interface AscInfo {
  objectType: number;
  sampleRate: number;
  channels: number;
  /** Samples per frame: 1024, or 960 when frameLengthFlag is set. */
  frameLength: number;
}

/** Reads an AudioSpecificConfig (object type escape, explicit frequency, frameLengthFlag). */
export function parseAudioSpecificConfig(bytes: Uint8Array): AscInfo {
  let pos = 0;
  const read = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      if (pos >> 3 >= bytes.length) throw new Error("The AudioSpecificConfig is too short.");
      v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    }
    return v >>> 0;
  };
  let objectType = read(5);
  if (objectType === 31) objectType = 32 + read(6);
  const index = read(4);
  const sampleRate = index === 15 ? read(24) : RATES[index];
  if (!sampleRate) throw new Error(`Sampling frequency index ${index} is reserved.`);
  const channels = read(4);
  const frameLength = read(1) ? 960 : AAC_FRAME;
  return { objectType, sampleRate, channels, frameLength };
}

/** Microsecond timestamp and duration of access unit `index`, from its first sample (no accumulated rounding). */
export function aacUnitTime(index: number, sampleRate: number, frame = AAC_FRAME): { timestamp: number; duration: number } {
  const t0 = Math.round((index * frame * 1e6) / sampleRate);
  const t1 = Math.round(((index + 1) * frame * 1e6) / sampleRate);
  return { timestamp: t0, duration: t1 - t0 };
}

/** How many access units an encoder with `priming` samples of delay writes for `samples` input samples (FFmpeg's AAC: every started frame, plus the delay). */
export function aacUnitCount(samples: number, priming: number, frame = AAC_FRAME): number {
  return Math.ceil((samples + priming) / frame);
}

/* ───────────── The edit list ───────────── */

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
}

function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  for (let at = from; at + 8 <= to; ) {
    let size = v.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw new Error("The MP4's boxes do not add up.");
    out.push({ type: String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]), start: at, size, header });
    at += size;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, type: string): Box | undefined => boxesIn(b, parent.start + parent.header, parent.start + parent.size).find((x) => x.type === type);

function handlerOf(b: Uint8Array, trak: Box): string {
  const mdia = child(b, trak, "mdia");
  const hdlr = mdia && child(b, mdia, "hdlr");
  // hdlr: header, version/flags (4), pre_defined (4), handler_type (4).
  if (!hdlr) return "";
  const at = hdlr.start + hdlr.header + 8;
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

export interface EditListOptions {
  /** The track to edit, by its handler (`soun` for the sound). */
  handler: string;
  /** Where presentation starts in the track, in its media timescale (the encoder's priming, 1024). */
  mediaTime: number;
  /** How long the track plays, in seconds (the mix's length, so the padding after it is cut). */
  duration: number;
}

/**
 * The MP4 with an `edts`/`elst` box (one segment: `duration` from `mediaTime`, rate 1) right after
 * the track's `tkhd`. The track header's and the movie header's durations follow the edit; the
 * `trak` and `moov` sizes grow by 36 bytes, and when `moov` comes before `mdat` (faststart) every
 * chunk offset in the file moves by the same 36. A track that already has an edit list is refused.
 */
export function addEditList(mp4: Uint8Array, opts: EditListOptions): Uint8Array<ArrayBuffer> {
  const top = boxesIn(mp4, 0, mp4.length);
  const moov = top.find((x) => x.type === "moov");
  if (!moov) throw new Error("The MP4 has no moov box.");
  if (moov.header !== 8) throw new Error("A 64-bit moov size is not supported here.");
  const mdat = top.find((x) => x.type === "mdat");
  const shiftOffsets = !!mdat && moov.start < mdat.start;
  const traks = boxesIn(mp4, moov.start + 8, moov.start + moov.size).filter((x) => x.type === "trak");
  const trak = traks.find((t) => handlerOf(mp4, t) === opts.handler);
  if (!trak) throw new Error(`The MP4 has no '${opts.handler}' track.`);
  if (trak.header !== 8) throw new Error("A 64-bit trak size is not supported here.");
  if (child(mp4, trak, "edts")) throw new Error("The track already has an edit list.");
  const tkhd = child(mp4, trak, "tkhd");
  const mvhd = child(mp4, moov, "mvhd");
  if (!tkhd || !mvhd) throw new Error("The MP4 has no track or movie header.");
  const mv = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  const mvVersion = mp4[mvhd.start + 8];
  const movieScale = mv.getUint32(mvhd.start + 12 + (mvVersion === 1 ? 16 : 8));
  const segment = Math.round(opts.duration * movieScale);
  if (!(segment > 0) || segment > 0xffffffff) throw new Error("The edit's duration is out of range.");
  if (!Number.isInteger(opts.mediaTime) || opts.mediaTime < 0 || opts.mediaTime > 0x7fffffff) throw new Error("The edit's media time is out of range.");

  const EDTS = 36;
  const edts = new Uint8Array(EDTS);
  const e = new DataView(edts.buffer);
  e.setUint32(0, EDTS);
  edts.set([0x65, 0x64, 0x74, 0x73], 4); // edts
  e.setUint32(8, 28);
  edts.set([0x65, 0x6c, 0x73, 0x74], 12); // elst, version 0, flags 0
  e.setUint32(20, 1); // one entry
  e.setUint32(24, segment); // segment_duration, movie timescale
  e.setInt32(28, opts.mediaTime); // media_time, media timescale
  e.setInt16(32, 1); // media_rate_integer
  e.setInt16(34, 0); // media_rate_fraction

  const insertAt = tkhd.start + tkhd.size;
  const out = new Uint8Array(mp4.length + EDTS);
  out.set(mp4.subarray(0, insertAt), 0);
  out.set(edts, insertAt);
  out.set(mp4.subarray(insertAt), insertAt + EDTS);
  const o = new DataView(out.buffer);
  o.setUint32(moov.start, moov.size + EDTS);
  o.setUint32(trak.start, trak.size + EDTS);

  // Durations: the track's tkhd is the edit's length; the movie's is the longest track.
  const durationAt = (box: Box, v0: number, v1: number) => (out[box.start + 8] === 1 ? { at: box.start + v1, wide: true } : { at: box.start + v0, wide: false });
  const setDuration = (d: { at: number; wide: boolean }, value: number) => (d.wide ? o.setBigUint64(d.at, BigInt(value)) : o.setUint32(d.at, value));
  const getDuration = (d: { at: number; wide: boolean }) => (d.wide ? Number(o.getBigUint64(d.at)) : o.getUint32(d.at));
  setDuration(durationAt(tkhd, 28, 36), segment); // tkhd is before the insertion point: same offsets
  const newMoov: Box = { ...moov, size: moov.size + EDTS };
  let longest = 0;
  for (const t of boxesIn(out, newMoov.start + 8, newMoov.start + newMoov.size).filter((x) => x.type === "trak")) {
    const th = child(out, t, "tkhd");
    if (th) longest = Math.max(longest, getDuration(durationAt(th, 28, 36)));
  }
  setDuration(durationAt(mvhd.start > insertAt ? { ...mvhd, start: mvhd.start + EDTS } : mvhd, 24, 32), longest);

  if (shiftOffsets) {
    const walk = (from: number, to: number) => {
      for (const x of boxesIn(out, from, to)) {
        if (x.type === "trak" || x.type === "mdia" || x.type === "minf" || x.type === "stbl") walk(x.start + x.header, x.start + x.size);
        else if (x.type === "stco" || x.type === "co64") {
          const n = o.getUint32(x.start + x.header + 4);
          const first = x.start + x.header + 8;
          for (let i = 0; i < n; i++) {
            if (x.type === "stco") {
              const v = o.getUint32(first + i * 4) + EDTS;
              if (v > 0xffffffff) throw new Error("A chunk offset no longer fits in 32 bits.");
              o.setUint32(first + i * 4, v);
            } else o.setBigUint64(first + i * 8, o.getBigUint64(first + i * 8) + BigInt(EDTS));
          }
        }
      }
    };
    walk(newMoov.start + 8, newMoov.start + newMoov.size);
  }
  return out;
}
