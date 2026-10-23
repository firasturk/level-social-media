/**
 * Sound, through Web Audio: a music file or a clip's own track decoded with `decodeAudioData`,
 * its energy envelope for the beat detector (shared/video-project's `detectBeats`), the final mix
 * rendered offline (clips' sound or the music with its fades and volume), and the AAC encoding of
 * that mix with WebCodecs' AudioEncoder for the mp4.
 *
 * Beat detection is onset-based: the envelope is the RMS of 20 ms hops of a mono mixdown; a beat
 * is a hop that rises well above the second before it, and a steady grid is fitted to the most
 * common onset spacing. It finds the pulse of most produced music; it does not know bars or
 * downbeats, and a quiet, rubato or very dense track gets a rough grid (the person can switch
 * snapping off).
 */
import { AUDIO_BITRATE, AUDIO_SAMPLE_RATE, detectBeats, placeClips, totalLength, type VideoProject } from "@shared/video-project";

export const BEAT_HOP = 0.02;

/** Any audio or video file the browser can decode (mp3, wav, m4a/aac, an mp4's AAC track). Null when it has no decodable sound. */
export async function decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(2, 1, AUDIO_SAMPLE_RATE);
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
}

/** RMS energy per hop of the mono mixdown. */
export function energyEnvelope(buffer: AudioBuffer, hop = BEAT_HOP): Float32Array {
  const n = buffer.length;
  const step = Math.max(1, Math.round(hop * buffer.sampleRate));
  const out = new Float32Array(Math.ceil(n / step));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    const from = i * step;
    const to = Math.min(n, from + step);
    for (let j = from; j < to; j++) {
      let v = 0;
      for (const ch of channels) v += ch[j];
      v /= channels.length;
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / Math.max(1, to - from));
  }
  return out;
}

export function beatsOf(buffer: AudioBuffer): number[] {
  return detectBeats(energyEnvelope(buffer), BEAT_HOP, { minGap: 0.25, window: 1, threshold: 1.3 });
}

/**
 * The export's sound, rendered offline at 48 kHz stereo: with music, the track from its offset
 * with its volume and fades (the clips' own sound is left out); without, each clip's own sound
 * trimmed and sped like its picture, crossfaded where the pictures are.
 */
export async function renderMix(project: VideoProject, clipAudio: Map<string, AudioBuffer | null>, music: AudioBuffer | null): Promise<AudioBuffer> {
  const length = Math.max(0.1, totalLength(project));
  const ctx = new OfflineAudioContext(2, Math.ceil(length * AUDIO_SAMPLE_RATE), AUDIO_SAMPLE_RATE);
  const m = project.music;
  if (m && music) {
    const src = ctx.createBufferSource();
    src.buffer = music;
    const gain = ctx.createGain();
    const v = m.volume;
    gain.gain.setValueAtTime(m.fadeIn > 0 ? 0 : v, 0);
    if (m.fadeIn > 0) gain.gain.linearRampToValueAtTime(v, Math.min(length, m.fadeIn));
    if (m.fadeOut > 0) {
      gain.gain.setValueAtTime(v, Math.max(0, length - m.fadeOut));
      gain.gain.linearRampToValueAtTime(0, length);
    }
    src.connect(gain).connect(ctx.destination);
    const offset = Math.min(m.offset, Math.max(0, music.duration - 0.01));
    src.start(0, offset, Math.min(length, music.duration - offset));
  } else {
    const placed = placeClips(project.clips);
    placed.forEach((pl, i) => {
      const buf = clipAudio.get(pl.clip.id);
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pl.clip.speed;
      const gain = ctx.createGain();
      // Fades in under the crossfade that starts it, and out under the one that ends it.
      gain.gain.setValueAtTime(pl.overlap > 0 ? 0 : 1, pl.start);
      if (pl.overlap > 0) gain.gain.linearRampToValueAtTime(1, pl.start + pl.overlap);
      const next = placed[i + 1];
      if (next && next.overlap > 0) {
        gain.gain.setValueAtTime(1, Math.max(pl.start, pl.end - next.overlap));
        gain.gain.linearRampToValueAtTime(0, pl.end);
      }
      src.connect(gain).connect(ctx.destination);
      const inPoint = Math.min(pl.clip.in, Math.max(0, buf.duration - 0.01));
      src.start(pl.start, inPoint, Math.max(0.01, Math.min(pl.clip.out, buf.duration) - inPoint));
    });
  }
  return ctx.startRendering();
}

/** The mix as AAC chunks for the muxer, in order. */
export async function encodeAac(buffer: AudioBuffer, onChunk: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined) => void, codec = "mp4a.40.2"): Promise<void> {
  const channels = 2;
  let error: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => onChunk(chunk, meta),
    error: (e) => {
      error = new Error(`${codec === "opus" ? "Opus" : "AAC"} encoding failed: ${e.message}`);
    },
  });
  encoder.configure({ codec, sampleRate: buffer.sampleRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE });
  const frames = 1024;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let at = 0; at < buffer.length; at += frames) {
    if (error) throw error;
    const n = Math.min(frames, buffer.length - at);
    const data = new Float32Array(n * channels);
    data.set(left.subarray(at, at + n), 0);
    data.set(right.subarray(at, at + n), n);
    const audio = new AudioData({ format: "f32-planar", sampleRate: buffer.sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((at / buffer.sampleRate) * 1e6), data });
    encoder.encode(audio);
    audio.close();
    if (encoder.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
  }
  await encoder.flush();
  if (error) throw error;
  encoder.close();
}

/**
 * Plays the music for the preview from a timeline time, with the volume and fades the export mixes
 * (renderMix above), so what is heard is what is written. A tiny player the editor starts and stops.
 */
export class MusicPreview {
  private ctx: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private master: GainNode | null = null;
  private muted = false;
  constructor(private buffer: AudioBuffer) {}
  start(project: VideoProject, timelineAt: number): void {
    this.stop();
    const m = project.music;
    if (!m) return;
    this.ctx ??= new AudioContext();
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    this.master.gain.value = this.muted ? 0 : 1;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.master);
    const offset = m.offset + timelineAt;
    if (offset >= this.buffer.duration) return;
    this.envelope(gain, project, timelineAt);
    src.start(0, offset);
    this.node = src;
    this.gain = gain;
    void this.ctx.resume();
  }
  /** The fades and volume from timeline time `from`, on the context's clock. */
  private envelope(gain: GainNode, project: VideoProject, from: number): void {
    const m = project.music;
    if (!m || !this.ctx) return;
    const length = Math.max(0.1, totalLength(project));
    const now = this.ctx.currentTime;
    const at = (t: number) => now + Math.max(0, t - from);
    const level = (t: number) => {
      let v = m.volume;
      if (m.fadeIn > 0 && t < m.fadeIn) v *= Math.max(0, t / m.fadeIn);
      if (m.fadeOut > 0 && t > length - m.fadeOut) v *= Math.max(0, (length - t) / m.fadeOut);
      return v;
    };
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(level(from), now);
    if (m.fadeIn > 0 && from < m.fadeIn) gain.gain.linearRampToValueAtTime(m.volume, at(m.fadeIn));
    if (m.fadeOut > 0) {
      const s = Math.max(from, length - m.fadeOut);
      gain.gain.setValueAtTime(level(s), at(s));
      gain.gain.linearRampToValueAtTime(0, at(length));
    }
  }
  /** The project changed while playing (a volume or fade moved): the envelope follows. */
  update(project: VideoProject, playingAt: number | null): void {
    if (this.gain && playingAt !== null) this.envelope(this.gain, project, playingAt);
  }
  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }
  stop(): void {
    try {
      this.node?.stop();
    } catch {
      /* already stopped */
    }
    this.node = null;
    this.gain = null;
  }
  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
