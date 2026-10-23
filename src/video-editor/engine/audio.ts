/**
 * Sound, through Web Audio: a music file, a voice-over or a clip's own track decoded with
 * `decodeAudioData`, its energy envelope for the beat detector (shared/video-project's
 * `detectBeats`), the final mix rendered offline, and the encoding of that mix with WebCodecs'
 * AudioEncoder for the mp4.
 *
 * The mix (phase 2) is defined in shared/video-mix.ts and is the same for the render and the
 * preview: every clip's own sound at its volume (0 when muted; fading under crossfades and dips),
 * the music from its start to its end on the timeline with its volume, fades and ducking under
 * speech (one gain curve, `musicGainCurve`, handed to Web Audio as it is in both places), and each
 * voice-over at its place and volume. Music and the clips' sound are now mixed together.
 *
 * Beat detection is onset-based: the envelope is the RMS of 20 ms hops of a mono mixdown; a beat
 * is a hop that rises well above the second before it, and a steady grid is fitted to the most
 * common onset spacing. It finds the pulse of most produced music; it does not know bars or
 * downbeats, and a quiet, rubato or very dense track gets a rough grid (the person can switch
 * snapping off).
 */
import { AUDIO_BITRATE, AUDIO_SAMPLE_RATE, clipVolume, detectBeats, musicSpan, placeClips, totalLength, type VideoProject, type VoiceClip } from "@shared/video-project";
import { clipGainPoints, CURVE_RATE, curveFrom, musicGainCurve } from "@shared/video-mix";

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

/** The music's buffer source and where it plays: from timeline time `from`, when to start (seconds after `from`), where in the track, for how long. */
function musicPlan(project: VideoProject, buffer: AudioBuffer, from: number): { delay: number; offset: number; duration: number } | null {
  const m = project.music;
  if (!m) return null;
  const length = totalLength(project);
  const span = musicSpan({ ...m, duration: m.duration ?? buffer.duration }, length);
  if (from >= span.end || span.end <= span.start) return null;
  const startAt = Math.max(from, span.start);
  const offset = m.offset + (startAt - span.start);
  if (offset >= buffer.duration) return null;
  return { delay: startAt - from, offset, duration: Math.min(span.end - startAt, buffer.duration - offset) };
}

/** A voice-over from timeline time `from`: the delay, the second in the recording, how long. Null once it is over. */
function voicePlan(v: VoiceClip, buffer: AudioBuffer, from: number): { delay: number; offset: number; duration: number } | null {
  const end = v.start + (v.out - v.in);
  if (from >= end) return null;
  const startAt = Math.max(from, v.start);
  const offset = v.in + (startAt - v.start);
  const stop = Math.min(v.out, buffer.duration);
  if (offset >= stop) return null;
  return { delay: startAt - from, offset, duration: stop - offset };
}

/**
 * The render's sound, offline at 48 kHz stereo: the clips' own sound (trimmed and sped like the
 * pictures, at their volumes, faded under crossfades and dips), the music (its span, volume, fades
 * and ducking as one curve) and the voice-overs.
 */
export async function renderMix(project: VideoProject, clipAudio: Map<string, AudioBuffer | null>, music: AudioBuffer | null, voices: Map<string, AudioBuffer | null> = new Map()): Promise<AudioBuffer> {
  const length = Math.max(0.1, totalLength(project));
  const ctx = new OfflineAudioContext(2, Math.ceil(length * AUDIO_SAMPLE_RATE), AUDIO_SAMPLE_RATE);
  const placed = placeClips(project.clips);
  placed.forEach((pl, i) => {
    const buf = clipAudio.get(pl.clip.id);
    if (!buf || clipVolume(pl.clip) <= 0) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pl.clip.speed;
    const gain = ctx.createGain();
    const points = clipGainPoints(project.clips, i, placed);
    points.forEach(([t, g], k) => (k === 0 ? gain.gain.setValueAtTime(g, t) : gain.gain.linearRampToValueAtTime(g, t)));
    src.connect(gain).connect(ctx.destination);
    const inPoint = Math.min(pl.clip.in, Math.max(0, buf.duration - 0.01));
    src.start(pl.start, inPoint, Math.max(0.01, Math.min(pl.clip.out, buf.duration) - inPoint));
  });
  if (project.music && music) {
    const plan = musicPlan(project, music, 0);
    if (plan) {
      const src = ctx.createBufferSource();
      src.buffer = music;
      const gain = ctx.createGain();
      // Sample k of the curve is at k / CURVE_RATE seconds, exactly as in the preview.
      const curve = musicGainCurve(project);
      gain.gain.setValueCurveAtTime(curve, 0, (curve.length - 1) / CURVE_RATE);
      src.connect(gain).connect(ctx.destination);
      src.start(plan.delay, plan.offset, plan.duration);
    }
  }
  for (const v of project.voices ?? []) {
    const buf = voices.get(v.id);
    if (!buf || v.volume <= 0) continue;
    const plan = voicePlan(v, buf, 0);
    if (!plan) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = v.volume;
    src.connect(gain).connect(ctx.destination);
    src.start(plan.delay, plan.offset, plan.duration);
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
 * The preview's music and voice-over, played from a timeline time with the same gain curve and the
 * same places the render mixes (renderMix above), so what is heard is what is written. The clips'
 * own sound plays from their <video> elements in the player (preview.ts), at the same levels.
 */
export class MixPreview {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: AudioBuffer | null = null;
  private voices = new Map<string, AudioBuffer>();
  private musicNode: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private voiceNodes: { id: string; node: AudioBufferSourceNode; gain: GainNode }[] = [];
  /** What the scheduled voices were made from: a change restarts them. */
  private voiceKey = "";
  private muted = false;

  setMusic(buffer: AudioBuffer | null): void {
    this.music = buffer;
  }

  setVoices(map: Map<string, AudioBuffer>): void {
    this.voices = map;
  }

  get hasSound(): boolean {
    return !!this.music || this.voices.size > 0;
  }

  private context(): { ctx: AudioContext; master: GainNode } {
    this.ctx ??= new AudioContext();
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    this.master.gain.value = this.muted ? 0 : 1;
    return { ctx: this.ctx, master: this.master };
  }

  /** Starts the music and the voices from timeline time `from`. */
  start(project: VideoProject, from: number): void {
    this.stop();
    if (!this.hasSound) return;
    const { ctx, master } = this.context();
    const now = ctx.currentTime;
    if (this.music && project.music) {
      const plan = musicPlan(project, this.music, from);
      if (plan) {
        const src = ctx.createBufferSource();
        src.buffer = this.music;
        const gain = this.curveGain(ctx, project, from, now);
        src.connect(gain).connect(master);
        src.start(now + plan.delay, plan.offset, plan.duration);
        this.musicNode = src;
        this.musicGain = gain;
      }
    }
    this.startVoices(project, from, now);
    void ctx.resume();
  }

  private curveGain(ctx: AudioContext, project: VideoProject, from: number, now: number): GainNode {
    const gain = ctx.createGain();
    // The render's curve from this time on (to within one sample, 10 ms), at the same spacing.
    const curve = curveFrom(musicGainCurve(project), from);
    gain.gain.setValueCurveAtTime(curve, now, Math.max(0.02, (curve.length - 1) / CURVE_RATE));
    return gain;
  }

  private startVoices(project: VideoProject, from: number, now: number): void {
    const { ctx, master } = this.context();
    for (const v of project.voices ?? []) {
      const buf = this.voices.get(v.id);
      if (!buf) continue;
      const plan = voicePlan(v, buf, from);
      if (!plan) continue;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = v.volume;
      node.connect(gain).connect(master);
      node.start(now + plan.delay, plan.offset, plan.duration);
      this.voiceNodes.push({ id: v.id, node, gain });
    }
    this.voiceKey = voiceKeyOf(project);
  }

  /** The project changed while playing: the music's curve and the voices' volumes follow; a moved voice is rescheduled. */
  update(project: VideoProject, playingAt: number | null): void {
    if (playingAt === null || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.musicNode && this.musicGain && this.master) {
      // A fresh gain node with the new curve (a running curve cannot be replaced in place everywhere).
      const gain = this.curveGain(this.ctx, project, playingAt, now);
      gain.connect(this.master);
      this.musicNode.disconnect();
      this.musicNode.connect(gain);
      this.musicGain.disconnect();
      this.musicGain = gain;
    }
    if (voiceKeyOf(project) !== this.voiceKey) {
      this.stopVoices();
      this.startVoices(project, playingAt, now);
    } else for (const v of this.voiceNodes) v.gain.gain.value = project.voices.find((x) => x.id === v.id)?.volume ?? 0;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }

  private stopVoices(): void {
    for (const v of this.voiceNodes) {
      try {
        v.node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.voiceNodes = [];
  }

  stop(): void {
    try {
      this.musicNode?.stop();
    } catch {
      /* already stopped */
    }
    this.musicNode = null;
    this.musicGain = null;
    this.stopVoices();
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}

const voiceKeyOf = (p: VideoProject): string => (p.voices ?? []).map((v) => `${v.id}:${v.start}:${v.in}:${v.out}`).join("|");
