/**
 * The video editor's AAC fallback (browsers with H.264 but no WebCodecs AAC encoder): the pure
 * parts in shared/aac-mp4.ts (the AudioSpecificConfig, the access units' times, the edit list
 * added to a finished mp4) and the real WebAssembly encoder (src/video-editor/engine/aac-encoder.wasm,
 * FFmpeg's AAC-LC) run in Node on a synthetic signal. The files are written by the editor's own muxer
 * (mp4-muxer) and read back with mp4box, the editor's demuxer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { createFile, MP4BoxBuffer, type Sample } from "mp4box";
import { AAC_FRAME, aacUnitCount, aacUnitTime, addEditList, audioSpecificConfig, parseAudioSpecificConfig } from "../shared/aac-mp4";
import { AacWasmEncoder } from "../shared/aac-wasm";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("AudioSpecificConfig", () => {
  it("builds the two plain bytes of AAC-LC", () => {
    expect(hex(audioSpecificConfig(48000, 2))).toBe("1190");
    expect(hex(audioSpecificConfig(44100, 2))).toBe("1210");
    expect(hex(audioSpecificConfig(48000, 1))).toBe("1188");
    expect(() => audioSpecificConfig(47000, 2)).toThrow(/47000/);
    expect(() => audioSpecificConfig(48000, 9)).toThrow(/channel/);
  });

  it("reads what it builds, FFmpeg's longer form, an escaped object type and an explicit rate", () => {
    expect(parseAudioSpecificConfig(audioSpecificConfig(48000, 2))).toEqual({ objectType: 2, sampleRate: 48000, channels: 2, frameLength: 1024 });
    // FFmpeg's AAC encoder: the same two bytes, then "SBR absent" signalled explicitly (sync extension 0x2b7).
    expect(parseAudioSpecificConfig(new Uint8Array([0x11, 0x90, 0x56, 0xe5, 0x00]))).toEqual({ objectType: 2, sampleRate: 48000, channels: 2, frameLength: 1024 });
    // Object type 42 (USAC) is escaped: 31, then 42 − 32 in six bits; frequency index 3.
    const bits = "11111" + "001010" + "0011" + "0010" + "0";
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) if (bits[i] === "1") bytes[i >> 3] |= 0x80 >> (i & 7);
    expect(parseAudioSpecificConfig(bytes)).toMatchObject({ objectType: 42, sampleRate: 48000, channels: 2 });
    // An explicit 24-bit rate (index 15): 2, 15, 48000, 2 channels, 960-sample frames.
    const b2 = "00010" + "1111" + (48000).toString(2).padStart(24, "0") + "0010" + "1";
    const e = new Uint8Array(Math.ceil(b2.length / 8));
    for (let i = 0; i < b2.length; i++) if (b2[i] === "1") e[i >> 3] |= 0x80 >> (i & 7);
    expect(parseAudioSpecificConfig(e)).toEqual({ objectType: 2, sampleRate: 48000, channels: 2, frameLength: 960 });
    expect(() => parseAudioSpecificConfig(new Uint8Array([0x11]))).toThrow(/short/);
  });
});

describe("access unit times", () => {
  it("never drifts: every unit lands on its exact sample in the muxer's 48 kHz timescale", () => {
    let sum = 0;
    for (let i = 0; i < 3000; i++) {
      const t = aacUnitTime(i, 48000);
      expect(t.timestamp).toBe(sum);
      expect(Math.round((t.timestamp / 1e6) * 48000)).toBe(i * AAC_FRAME);
      expect(t.duration === 21333 || t.duration === 21334).toBe(true);
      sum += t.duration;
    }
    // 3000 units = 64 s exactly.
    expect(sum).toBe(64_000_000);
  });

  it("counts the units an encoder with 1024 samples of priming writes", () => {
    expect(aacUnitCount(48000, 1024)).toBe(48);
    expect(aacUnitCount(1024, 1024)).toBe(2);
    expect(aacUnitCount(96300, 1024)).toBe(96);
  });
});

/* ───────────── The edit list on a real mp4-muxer file ───────────── */

interface RawBox {
  type: string;
  start: number;
  size: number;
}
function boxes(b: Uint8Array, from = 0, to = b.length): RawBox[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: RawBox[] = [];
  for (let at = from; at + 8 <= to; ) {
    const size = v.getUint32(at);
    out.push({ type: String.fromCharCode(...b.subarray(at + 4, at + 8)), start: at, size });
    if (size < 8) break;
    at += size;
  }
  return out;
}
const kids = (b: Uint8Array, x: RawBox) => boxes(b, x.start + 8, x.start + x.size);
const find = (b: Uint8Array, x: RawBox, type: string) => kids(b, x).find((k) => k.type === type);

function soundTrak(b: Uint8Array): RawBox {
  const moov = boxes(b).find((x) => x.type === "moov")!;
  return kids(b, moov).filter((x) => x.type === "trak").find((t) => {
    const hdlr = find(b, find(b, t, "mdia")!, "hdlr")!;
    return String.fromCharCode(...b.subarray(hdlr.start + 16, hdlr.start + 20)) === "soun";
  })!;
}

/** A small file as the editor writes it: 2 s of 30 fps "video" and AAC-sized "audio" units, each filled with its own byte pattern. */
function muxed(fastStart: "in-memory" | false) {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width: 64, height: 64, frameRate: 30 }, audio: { codec: "aac", sampleRate: 48000, numberOfChannels: 2 }, fastStart, firstTimestampBehavior: "offset" });
  const videoData: Uint8Array[] = [];
  const audioData: Uint8Array[] = [];
  const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]);
  for (let i = 0; i < 60; i++) {
    const d = new Uint8Array(200 + i).fill(i);
    videoData.push(d);
    muxer.addVideoChunkRaw(d, i % 30 === 0 ? "key" : "delta", Math.round((i * 1e6) / 30), Math.round(1e6 / 30), i === 0 ? { decoderConfig: { codec: "avc1.640028", codedWidth: 64, codedHeight: 64, description: avcC } } : undefined);
  }
  const units = aacUnitCount(96000, 1024);
  for (let i = 0; i < units; i++) {
    const d = new Uint8Array(300 + (i % 7)).fill(0x80 | (i & 0x7f));
    audioData.push(d);
    const t = aacUnitTime(i, 48000);
    muxer.addAudioChunkRaw(d, "key", t.timestamp, t.duration, i === 0 ? { decoderConfig: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: audioSpecificConfig(48000, 2) } } : undefined);
  }
  muxer.finalize();
  return { bytes: new Uint8Array(target.buffer), videoData, audioData };
}

function samplesOf(bytes: Uint8Array): Promise<{ tracks: { id: number; type: string }[]; data: Map<number, Uint8Array[]>; stts: Map<number, number[]> }> {
  return new Promise((resolve) => {
    const f = createFile();
    const data = new Map<number, Uint8Array[]>();
    const stts = new Map<number, number[]>();
    let tracks: { id: number; type: string }[] = [];
    f.onReady = (m) => {
      tracks = m.tracks.map((t) => ({ id: t.id, type: t.type ?? "" }));
      for (const t of m.tracks) {
        data.set(t.id, []);
        stts.set(t.id, []);
        f.setExtractionOptions(t.id, null, { nbSamples: 100000 });
      }
      f.start();
    };
    f.onSamples = (id: number, _u: unknown, list: Sample[]) => {
      for (const s of list) {
        data.get(id)!.push(s.data!.slice());
        stts.get(id)!.push(s.duration);
      }
    };
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    f.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, 0), true);
    f.flush();
    resolve({ tracks, data, stts });
  });
}

describe("edit list", () => {
  it("adds edts/elst to the sound track of a faststart file and moves every chunk offset with it", async () => {
    const { bytes, videoData, audioData } = muxed("in-memory");
    const top = boxes(bytes).map((x) => x.type);
    expect(top.indexOf("moov")).toBeLessThan(top.indexOf("mdat"));
    const out = addEditList(bytes, { handler: "soun", mediaTime: 1024, duration: 2 });
    expect(out.length).toBe(bytes.length + 36);
    // The boxes still add up, moov is still first, and the edit is right after tkhd.
    const outTop = boxes(out);
    expect(outTop.reduce((n, x) => n + x.size, 0)).toBe(out.length);
    expect(outTop.map((x) => x.type).indexOf("moov")).toBeLessThan(outTop.map((x) => x.type).indexOf("mdat"));
    const trak = soundTrak(out);
    expect(kids(out, trak).map((x) => x.type)).toEqual(["tkhd", "edts", "mdia"]);
    const elst = find(out, find(out, trak, "edts")!, "elst")!;
    const v = new DataView(out.buffer);
    expect(v.getUint32(elst.start + 12)).toBe(1); // one entry
    expect(v.getUint32(elst.start + 16)).toBe(2000); // 2 s in the movie's 1000 timescale
    expect(v.getInt32(elst.start + 20)).toBe(1024); // the priming, in 48 kHz units
    expect(v.getInt16(elst.start + 24)).toBe(1);
    // tkhd (v0) duration follows the edit; mvhd is the longest track (the video's 2 s).
    const tkhd = find(out, trak, "tkhd")!;
    expect(v.getUint32(tkhd.start + 28)).toBe(2000);
    const mvhd = find(out, outTop.find((x) => x.type === "moov")!, "mvhd")!;
    expect(v.getUint32(mvhd.start + 24)).toBe(2000);
    // Every sample read back through the moved offsets is the one that was written, in both tracks.
    const read = await samplesOf(out);
    const vid = read.tracks.find((t) => t.type === "video")!.id;
    const aud = read.tracks.find((t) => t.type === "audio")!.id;
    expect(read.data.get(vid)!.map(hex)).toEqual(videoData.map(hex));
    expect(read.data.get(aud)!.map(hex)).toEqual(audioData.map(hex));
    // And each AAC unit lasts exactly 1024 samples in the 48 kHz media timescale (no drift).
    expect(new Set(read.stts.get(aud))).toEqual(new Set([1024]));
  });

  it("leaves offsets alone when mdat comes before moov, and refuses a second edit list or a missing track", async () => {
    const { bytes, audioData } = muxed(false);
    const top = boxes(bytes).map((x) => x.type);
    expect(top.indexOf("mdat")).toBeLessThan(top.indexOf("moov"));
    const out = addEditList(bytes, { handler: "soun", mediaTime: 1024, duration: 2 });
    const read = await samplesOf(out);
    expect(read.data.get(read.tracks.find((t) => t.type === "audio")!.id)!.map(hex)).toEqual(audioData.map(hex));
    expect(() => addEditList(out, { handler: "soun", mediaTime: 1024, duration: 2 })).toThrow(/already/);
    expect(() => addEditList(bytes, { handler: "text", mediaTime: 0, duration: 1 })).toThrow(/no 'text' track/);
    expect(() => addEditList(bytes, { handler: "soun", mediaTime: -1, duration: 1 })).toThrow(/media time/);
  });
});

/* ───────────── The WebAssembly encoder itself ───────────── */

const wasm = readFileSync(new URL("../src/video-editor/engine/aac-encoder.wasm", import.meta.url));
/** Node has WebAssembly.compile; the Workers types these tests are checked with leave it out. */
const compile = (bytes: Uint8Array) => (WebAssembly as unknown as { compile(b: Uint8Array): Promise<WebAssembly.Module> }).compile(bytes);

describe("the WebAssembly AAC encoder (FFmpeg aac, LGPL)", () => {
  it("encodes 48 kHz stereo PCM into AAC-LC access units with 1024 samples of priming", async () => {
    const mod = await compile(wasm);
    const enc = await AacWasmEncoder.create(mod, 48000, 2, 128_000);
    expect(enc.frameSize).toBe(1024);
    expect(enc.priming).toBe(1024);
    expect(parseAudioSpecificConfig(enc.extradata)).toEqual({ objectType: 2, sampleRate: 48000, channels: 2, frameLength: 1024 });
    // The plain two bytes the file carries are FFmpeg's own first two.
    expect(hex(enc.extradata.subarray(0, 2))).toBe(hex(audioSpecificConfig(48000, 2)));

    const n = 48000 * 3 + 500;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
      right[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000) + 0.05 * Math.sin(i * 0.37);
    }
    const units = [];
    for (let at = 0; at < n; at += 1024) units.push(...enc.encode([left.subarray(at, at + 1024), right.subarray(at, at + 1024)], at));
    units.push(...enc.flush());
    expect(units.length).toBe(aacUnitCount(n, 1024));
    units.forEach((u, i) => expect(u.pts).toBe(i * 1024 - 1024));
    // Each raw_data_block starts with a channel pair element (id 1), the first with FFmpeg's fill element
    // naming the encoder (id 6), and none carries an ADTS header.
    units.forEach((u, i) => expect(u.data[0] >> 5).toBe(i === 0 ? 6 : 1));
    for (const u of units) {
      expect(u.data[0] === 0xff && (u.data[1] & 0xf0) === 0xf0).toBe(false);
    }
    const kbps = (units.reduce((s, u) => s + u.data.length, 0) * 8) / (n / 48000) / 1000;
    expect(kbps).toBeGreaterThan(90);
    expect(kbps).toBeLessThan(160);
    expect(() => enc.encode([new Float32Array(2048), new Float32Array(2048)], 0)).toThrow(/1 to 1024/);
    enc.close();
    expect(() => enc.encode([left.subarray(0, 1024), right.subarray(0, 1024)], 0)).toThrow(/closed/);
  });

  it("starts a fresh, independent encoder each time", async () => {
    const mod = await compile(wasm);
    const a = await AacWasmEncoder.create(mod, 48000, 2, 128_000);
    const b = await AacWasmEncoder.create(mod, 48000, 2, 128_000);
    const silence = new Float32Array(1024);
    const ua = [...a.encode([silence, silence], 0), ...a.encode([silence, silence], 1024), ...a.flush()];
    const ub = [...b.encode([silence, silence], 0), ...b.encode([silence, silence], 1024), ...b.flush()];
    expect(ua.map((u) => hex(u.data))).toEqual(ub.map((u) => hex(u.data)));
    a.close();
    b.close();
  });
});
