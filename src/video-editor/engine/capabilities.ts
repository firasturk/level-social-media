/**
 * What this browser can do, asked up front. The export needs H.264 video and AAC audio encoders
 * (iPhone and Instagram play nothing else) and the preview needs the browser to decode H.264.
 * When something is missing the editor says so and stops: there is no other codec to fall back
 * to, because the output has to be H.264 + AAC.
 */
import { AUDIO_SAMPLE_RATE } from "@shared/video-project";

export interface Capabilities {
  /** The editor can render an mp4 here. */
  canExport: boolean;
  canDecode: boolean;
  /** The H.264 codec string the encoder accepted (High profile, level 4.0 or 4.2). */
  videoCodec: string | null;
  /** Plain words for the person when something is missing; empty when all is well. */
  message: string;
  details: string[];
}

export const STOP_MESSAGE = "This browser cannot make an H.264 + AAC video. Use Chrome, Edge or Safari on a computer.";

/** Level 4.0 covers 1080×1920 at 30 fps; 4.2 is asked first for headroom, then 4.0. */
const H264_CANDIDATES = ["avc1.64002A", "avc1.640028", "avc1.4D402A", "avc1.4D4028"];

export async function checkCapabilities(output = { width: 1080, height: 1920, fps: 30 }): Promise<Capabilities> {
  const details: string[] = [];
  let videoCodec: string | null = null;
  let canDecode = false;
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoDecoder === "undefined") {
    details.push("WebCodecs (VideoEncoder, AudioEncoder, VideoDecoder) is not available here.");
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
    try {
      const a = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: 2, bitrate: 128_000 });
      if (!a.supported) details.push("No AAC audio encoder.");
      else if (!videoCodec) details.push("AAC audio is available, but video needs H.264 as well.");
    } catch {
      details.push("No AAC audio encoder.");
    }
    try {
      const d = await VideoDecoder.isConfigSupported({ codec: "avc1.640028" });
      canDecode = !!d.supported;
      if (!canDecode) details.push("No H.264 video decoder: the clips cannot be read here.");
    } catch {
      details.push("No H.264 video decoder: the clips cannot be read here.");
    }
  }
  if (typeof OfflineAudioContext === "undefined") details.push("Web Audio is not available: music cannot be read.");
  const canExport = !!videoCodec && !details.some((d) => d.startsWith("No AAC") || d.startsWith("WebCodecs") || d.startsWith("Web Audio") || d.startsWith("No H.264 video decoder"));
  return { canExport, canDecode, videoCodec, message: canExport && canDecode ? "" : STOP_MESSAGE, details };
}
