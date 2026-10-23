/**
 * Test audio for the music library: short beat loops synthesised here, in code, so development and
 * the tests never need a downloaded file. They are ours by authorship and dedicated CC0. Every one
 * is labelled "Test audio" in the catalog and is not meant for a client's video.
 *
 * The output is a 16-bit mono WAV at 22 050 Hz. The same spec always gives the same bytes (the noise
 * comes from a seeded generator), so a file can be checked against its expected length and BPM.
 */

export interface TestAudioSpec {
  bpm: number;
  seconds: number;
  /** The scale the melody walks, in semitones above the root. */
  scale: readonly number[];
  /** Root note, Hz. */
  root: number;
  /** Per eighth note in a bar of 8: "D" low drum (doum), "T" high drum (tek), "K" kick, "S" snare, "H" hat, "-" rest. */
  pattern: string;
  /** 0 … 1: how much of the melody plays (calm loops play less). */
  melody: number;
  /** A sustained chord under the beat. */
  pad: boolean;
  seed: number;
}

export const TEST_SAMPLE_RATE = 22050;

/** Major pentatonic, and Hijaz (D, E♭, F♯, G, A, B♭, C) for the Arabic-flavoured loop. */
export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9, 12],
  hijaz: [0, 1, 4, 5, 7, 8, 10, 12],
} as const;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The samples, in −1 … 1. */
export function synthTestSamples(spec: TestAudioSpec, rate = TEST_SAMPLE_RATE): Float32Array {
  const n = Math.round(spec.seconds * rate);
  const out = new Float32Array(n);
  const rand = rng(spec.seed);
  const eighth = 60 / spec.bpm / 2;
  const steps = Math.floor(spec.seconds / eighth);
  const add = (start: number, len: number, f: (t: number, i: number) => number) => {
    const from = Math.round(start * rate);
    const to = Math.min(n, from + Math.round(len * rate));
    for (let i = from; i < to; i++) out[i] += f((i - from) / rate, i - from);
  };
  // The pad: root, fifth and octave, quietly, all the way.
  if (spec.pad) {
    const fs = [spec.root, spec.root * 1.5, spec.root * 2];
    add(0, spec.seconds, (t) => 0.06 * fs.reduce((a, fr) => a + Math.sin(2 * Math.PI * fr * t), 0) * Math.min(1, t / 2, (spec.seconds - t) / 2));
  }
  let note = 0;
  for (let s = 0; s < steps; s++) {
    const at = s * eighth;
    const hit = spec.pattern[s % spec.pattern.length];
    if (hit === "K" || hit === "D") add(at, 0.25, (t) => 0.7 * Math.sin(2 * Math.PI * (hit === "D" ? 90 : 55) * t * (1 + 2 * Math.exp(-t * 30))) * Math.exp(-t * (hit === "D" ? 14 : 18)));
    if (hit === "T") add(at, 0.08, (t) => 0.35 * (Math.sin(2 * Math.PI * 520 * t) * 0.6 + (rand() * 2 - 1) * 0.4) * Math.exp(-t * 45));
    if (hit === "S") add(at, 0.15, (t) => 0.3 * (rand() * 2 - 1) * Math.exp(-t * 25));
    if (hit === "H" || hit === "K" || hit === "S") add(at, 0.04, (t) => 0.08 * (rand() * 2 - 1) * Math.exp(-t * 90));
    if (rand() < spec.melody) {
      // A walk on the scale: mostly steps, sometimes a leap.
      note = Math.max(0, Math.min(spec.scale.length - 1, note + (rand() < 0.75 ? (rand() < 0.5 ? -1 : 1) : Math.round(rand() * 4 - 2))));
      const fr = spec.root * 2 * Math.pow(2, spec.scale[note] / 12);
      add(at, eighth * 1.8, (t) => 0.16 * (Math.sin(2 * Math.PI * fr * t) + 0.3 * Math.sin(4 * Math.PI * fr * t)) * Math.min(1, t * 200) * Math.exp(-t * 3));
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
  return out;
}

/** A 16-bit PCM mono WAV of the samples. */
export function wavBytes(samples: Float32Array, rate = TEST_SAMPLE_RATE): ArrayBuffer {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return buf;
}

export function synthTestWav(spec: TestAudioSpec): ArrayBuffer {
  return wavBytes(synthTestSamples(spec));
}

/** A PCM WAV's samples (mono mixdown) and rate, for the server-side waveform; null when it is not PCM 8/16/24/32-bit or float. */
export function readWav(bytes: ArrayBuffer): { channels: Float32Array[]; rate: number } | null {
  if (bytes.byteLength < 44) return null;
  const v = new DataView(bytes);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let o = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt " && o + 24 <= bytes.byteLength) {
      format = v.getUint16(o + 8, true);
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
      if (format === 0xfffe && size >= 26 && o + 34 <= bytes.byteLength) format = v.getUint16(o + 32, true);
    }
    if (id === "data") {
      if (!channels || !rate || ![1, 3].includes(format)) return null;
      const bytesPer = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.byteLength - o - 8) / (bytesPer * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      const base = o + 8;
      for (let f = 0; f < frames; f++)
        for (let c = 0; c < channels; c++) {
          const p = base + (f * channels + c) * bytesPer;
          let s = 0;
          if (format === 3 && bits === 32) s = v.getFloat32(p, true);
          else if (bits === 16) s = v.getInt16(p, true) / 32768;
          else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
          else if (bits === 24) s = ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608);
          else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
          else return null;
          out[c][f] = s;
        }
      return { channels: out, rate };
    }
    o += 8 + size + (size % 2);
  }
  return null;
}
