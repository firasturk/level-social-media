/**
 * The AAC fallback: when the browser's WebCodecs has H.264 but no AAC encoder (Google Chrome on
 * Linux, Safari before 26), the offline mix (audio.ts `renderMix`) is encoded here with FFmpeg's
 * AAC-LC encoder compiled to WebAssembly (shared/aac-wasm.ts; ~0.6 MB, served by the studio itself next to
 * the other built files, downloaded only the first time a render needs it, then cached by the
 * browser). The access units go to the same muxer as the native path's, with the same
 * AudioSpecificConfig (AAC-LC, 48 kHz, stereo) in `esds`; afterwards an edit list removes the
 * encoder's 1024 priming samples and the padding after the mix (aac-mp4.ts `addEditList`), so the
 * sound lines up with the first frame to the sample.
 *
 * This module is loaded with `import()` only by a render that needs it, so browsers with a native
 * AAC encoder never download it or the wasm.
 */
import wasmUrl from "./aac-encoder.wasm?url";
import { aacUnitCount, aacUnitTime, audioSpecificConfig, parseAudioSpecificConfig } from "@shared/aac-mp4";
import { AacWasmEncoder } from "@shared/aac-wasm";

let compiled: Promise<WebAssembly.Module> | null = null;

/** The encoder module, fetched and compiled once per tab; a failed download can be retried. */
function encoderModule(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    let r: Response;
    let bytes: ArrayBuffer;
    try {
      r = await fetch(wasmUrl);
      bytes = await r.arrayBuffer();
    } catch {
      throw new Error("The audio encoder could not be downloaded: check the connection and render again.");
    }
    // A missing file comes back as the app's page (the studio's single-page fallback), not as a 404.
    if (!r.ok || /text\/html/.test(r.headers.get("content-type") ?? "")) throw new Error(`The audio encoder could not be downloaded (HTTP ${r.status}): reload the page and render again.`);
    try {
      return await WebAssembly.compile(bytes);
    } catch {
      throw new Error("The audio encoder could not start in this browser (WebAssembly).");
    }
  })();
  compiled.catch(() => (compiled = null));
  return compiled;
}

export interface FallbackAudio {
  /** Samples the first unit starts before the mix (the edit list's media time). */
  priming: number;
  /** The mix's length in samples (the edit list's duration). */
  samples: number;
  sampleRate: number;
  units: number;
}

/**
 * Encodes the mix (48 kHz stereo) to AAC-LC and hands each access unit to `onUnit` with its
 * timestamp and duration in microseconds (unit i at i × 1024 samples) and, on the first, the
 * decoder configuration for the muxer. Yields to the page every few frames so the progress shows
 * and Stop works.
 */
export async function encodeAacFallback(
  mix: AudioBuffer,
  bitrate: number,
  onUnit: (data: Uint8Array, timestamp: number, duration: number, meta: EncodedAudioChunkMetadata | undefined) => void,
  onProgress: (fraction: number) => void,
  abort: () => void,
): Promise<FallbackAudio> {
  const channels = 2;
  const sampleRate = mix.sampleRate;
  const description = audioSpecificConfig(sampleRate, channels);
  const encoder = await AacWasmEncoder.create(await encoderModule(), sampleRate, channels, bitrate);
  try {
    // FFmpeg writes the same object type, rate and channels, then marks SBR absent; the plain two bytes are what the file carries.
    const own = parseAudioSpecificConfig(encoder.extradata);
    if (own.objectType !== 2 || own.sampleRate !== sampleRate || own.channels !== channels || own.frameLength !== encoder.frameSize) throw new Error("The audio encoder is not set up for AAC-LC 48 kHz stereo.");
    const left = mix.getChannelData(0);
    const right = mix.numberOfChannels > 1 ? mix.getChannelData(1) : left;
    const frame = encoder.frameSize;
    const total = aacUnitCount(mix.length, encoder.priming, frame);
    let index = 0;
    const emit = (units: { data: Uint8Array; pts: number }[]) => {
      for (const u of units) {
        // The encoder's own times are −priming, 0, 1024…: unit i is placed at i × 1024; the edit list skips the priming.
        if (u.pts !== index * frame - encoder.priming) throw new Error(`The audio encoder skipped a frame (unit ${index} at ${u.pts}).`);
        const t = aacUnitTime(index, sampleRate, frame);
        onUnit(u.data, t.timestamp, t.duration, index === 0 ? { decoderConfig: { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, description } } : undefined);
        index++;
      }
    };
    for (let at = 0; at < mix.length; at += frame) {
      emit(encoder.encode([left.subarray(at, at + frame), right.subarray(at, at + frame)], at));
      if ((at / frame) % 64 === 63) {
        onProgress(index / total);
        await new Promise((r) => setTimeout(r, 0));
        abort();
      }
    }
    emit(encoder.flush());
    if (index !== total) throw new Error(`The audio encoder wrote ${index} frames, ${total} expected.`);
    onProgress(1);
    return { priming: encoder.priming, samples: mix.length, sampleRate, units: index };
  } finally {
    encoder.close();
  }
}
