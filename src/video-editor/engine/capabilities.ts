/**
 * What this browser can do, asked up front. The export needs an H.264 video encoder and AAC audio
 * (iPhone and Instagram play nothing else) and the preview needs the browser to decode H.264.
 * AAC comes from WebCodecs when the browser has an AAC AudioEncoder; when it has H.264 but no AAC
 * (Google Chrome on Linux, Safari before 26) the editor encodes the sound itself with its own
 * AAC-LC encoder in WebAssembly (aac-fallback.ts), into the same H.264 + AAC mp4. When H.264 or
 * WebCodecs is missing the editor says so and stops: there is no other video codec to fall back
 * to, because the output has to be H.264 + AAC.
 */
import { AUDIO_SAMPLE_RATE } from "@shared/video-project";

export interface Capabilities {
  /** The editor can render an mp4 here. */
  canExport: boolean;
  canDecode: boolean;
  /** The H.264 codec string the encoder accepted (High profile, level 4.0 or 4.2). */
  videoCodec: string | null;
  /** Who encodes the sound: the browser's WebCodecs, the editor's own WebAssembly AAC encoder, or nobody. */
  audioEncoder: "native" | "wasm" | null;
  /** Plain words for the person when something is missing; empty when all is well. */
  message: string;
  /** Plain words when rendering works but differs from usual (the AAC fallback); empty otherwise. */
  notice: string;
  details: string[];
}

export const STOP_MESSAGE = "This browser cannot make an H.264 + AAC video. Use Chrome, Edge or Safari on a computer.";

/** What the AAC fallback downloads the first time (aac-encoder.wasm is 0.63 MB, about 0.23 MB compressed). */
export const AAC_FALLBACK_DOWNLOAD = "0.6 MB";
export const AAC_FALLBACK_NOTICE = `This browser has no built-in AAC audio encoder, so the editor encodes the sound itself: the first render downloads its encoder (${AAC_FALLBACK_DOWNLOAD}). The file is the same H.264 + AAC mp4.`;

/** Level 4.0 covers 1080×1920 at 30 fps; 4.2 is asked first for headroom, then 4.0. */
const H264_CANDIDATES = ["avc1.64002A", "avc1.640028", "avc1.4D402A", "avc1.4D4028"];

/**
 * The codecs an export is written with. The studio always uses H.264 + AAC (iPhone, Instagram,
 * the upload checks). VP9 + Opus in MP4 exists only for the automated render test: open-source
 * Chromium has no H.264, and the test must still run the whole compositor and inspect a real file.
 */
export interface ExportCodecs {
  video: "avc" | "vp9";
  audio: "aac" | "opus";
}
export const STUDIO_CODECS: ExportCodecs = { video: "avc", audio: "aac" };
export const TEST_CODECS: ExportCodecs = { video: "vp9", audio: "opus" };

/** The test profile: VP9 profile 0, level 4.1, 8-bit, BT.709 (vp09.00.41.08.01.01.01.01.00), and Opus. */
async function checkTestCodecs(output: { width: number; height: number; fps: number }): Promise<Capabilities> {
  const details: string[] = [];
  let videoCodec: string | null = null;
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") details.push("WebCodecs is not available here.");
  else {
    for (const codec of ["vp09.00.41.08.01.01.01.01.00", "vp09.00.41.08", "vp09.00.10.08"]) {
      const r = await VideoEncoder.isConfigSupported({ codec, width: output.width, height: output.height, framerate: output.fps, bitrate: 4_000_000 }).catch(() => ({ supported: false }));
      if (r.supported) {
        videoCodec = codec;
        break;
      }
    }
    if (!videoCodec) details.push("No VP9 encoder.");
    const a = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: 2, bitrate: 128_000 }).catch(() => ({ supported: false }));
    if (!a.supported) details.push("No Opus encoder.");
  }
  const ok = !details.length;
  return { canExport: ok, canDecode: ok, videoCodec, audioEncoder: ok ? "native" : null, message: ok ? "" : "This browser cannot make the test render.", notice: "", details };
}

export async function checkCapabilities(output = { width: 1080, height: 1920, fps: 30 }, codecs: ExportCodecs = STUDIO_CODECS): Promise<Capabilities> {
  if (codecs.video === "vp9") return checkTestCodecs(output);
  const details: string[] = [];
  let videoCodec: string | null = null;
  let audioEncoder: Capabilities["audioEncoder"] = null;
  let canDecode = false;
  // Safari before 26 has the video half of WebCodecs but no AudioEncoder at all: the AAC fallback covers it.
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") {
    details.push("WebCodecs (VideoEncoder, VideoDecoder) is not available here.");
  } else {
    for (const codec of H264_CANDIDATES) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width: output.width, height: output.height, framerate: output.fps, bitrate: 8_000_000, avc: { format: "avc" } });
        if (r.supported) {
          videoCodec = codec;
          break;
        }
      } catch {
        /* an unknown codec string throws in some browsers: try the next */
      }
    }
    if (!videoCodec) details.push("No H.264 video encoder (open-source Chromium builds have none; Chrome, Edge and Safari do).");
    let nativeAac = false;
    try {
      // The studio's renders are always AAC; the automated checks may ask for Opus where Chrome has H.264 but no AAC encoder.
      if (typeof AudioEncoder !== "undefined") nativeAac = !!(await AudioEncoder.isConfigSupported({ codec: codecs.audio === "opus" ? "opus" : "mp4a.40.2", sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: 2, bitrate: 128_000 })).supported;
    } catch {
      /* an unknown codec throws in some browsers: no native AAC */
    }
    if (nativeAac) {
      audioEncoder = "native";
      if (!videoCodec) details.push("AAC audio is available, but video needs H.264 as well.");
    } else if (videoCodec && codecs.audio !== "opus" && typeof WebAssembly === "object" && typeof WebAssembly.compile === "function") {
      audioEncoder = "wasm";
      details.push("No built-in AAC audio encoder: the editor's own AAC encoder (WebAssembly) is used.");
    } else details.push("No AAC audio encoder.");
    try {
      const d = await VideoDecoder.isConfigSupported({ codec: "avc1.640028" });
      canDecode = !!d.supported;
      if (!canDecode) details.push("No H.264 video decoder: the clips cannot be read here.");
    } catch {
      details.push("No H.264 video decoder: the clips cannot be read here.");
    }
  }
  if (typeof OfflineAudioContext === "undefined") details.push("Web Audio is not available: music cannot be read.");
  const canExport = !!videoCodec && !!audioEncoder && !details.some((d) => d.startsWith("No AAC") || d.startsWith("WebCodecs") || d.startsWith("Web Audio") || d.startsWith("No H.264 video decoder"));
  return { canExport, canDecode, videoCodec, audioEncoder, message: canExport && canDecode ? "" : STOP_MESSAGE, notice: canExport && audioEncoder === "wasm" ? AAC_FALLBACK_NOTICE : "", details };
}
