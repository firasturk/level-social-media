/**
 * The preview: the timeline played on a canvas at reduced size through the same compositor as the
 * export (compose.ts: framing, colour, background, text and logo layers). Each clip's hidden
 * <video> is kept near the source time the timeline asks for (the browser's own decoder does the
 * work here, and turns phone footage upright itself; WebCodecs is used by the export). Without
 * music the clip on screen is heard; with music, the music plays from the timeline time with its
 * volume and fades, as the export mixes it.
 */
import type { CubeLut } from "@shared/cube-lut";
import { totalLength, type VideoProject } from "@shared/video-project";
import { MusicPreview } from "./audio";
import { composeFrame, type Picture } from "./compose";
import { Grader } from "./grader";
import type { MediaStore } from "./media";
import { OverlayLayer } from "./overlays";

const MAX_PREVIEW_W = 540;
const MAX_PREVIEW_H = 960;

export function previewSize(p: Pick<VideoProject, "output">): { w: number; h: number } {
  const s = Math.min(1, MAX_PREVIEW_W / p.output.width, MAX_PREVIEW_H / p.output.height);
  return { w: Math.max(2, Math.round((p.output.width * s) / 2) * 2), h: Math.max(2, Math.round((p.output.height * s) / 2) * 2) };
}

export class Player {
  private grader: Grader;
  private overlays: OverlayLayer;
  private ctx: CanvasRenderingContext2D;
  private project: VideoProject;
  private raf = 0;
  private startedAt = 0;
  private startTime = 0;
  private music: MusicPreview | null = null;
  private drawing = false;
  time = 0;
  playing = false;
  bypass = false;
  muted = false;
  onTime: ((t: number, playing: boolean) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private media: MediaStore,
    project: VideoProject,
  ) {
    this.project = project;
    this.ctx = canvas.getContext("2d")!;
    const { w, h } = previewSize(project);
    this.grader = new Grader(w, h);
    this.overlays = new OverlayLayer(w, h);
    void this.overlays.prepare(project.overlays);
    canvas.width = w;
    canvas.height = h;
    this.loop();
  }

  setProject(p: VideoProject): void {
    const overlaysChanged = p.overlays !== this.project.overlays;
    this.project = p;
    const { w, h } = previewSize(p);
    if (w !== this.grader.width || h !== this.grader.height) {
      this.grader.resize(w, h);
      this.overlays.resize(w, h);
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (overlaysChanged) void this.overlays.prepare(p.overlays);
    const len = totalLength(p);
    if (this.time > len) this.time = len;
    this.music?.update(p, this.playing ? this.time : null);
  }

  setLut(lut: CubeLut | null): void {
    this.grader.setLut(lut);
  }

  setMusic(buffer: AudioBuffer | null): void {
    this.music?.dispose();
    this.music = buffer ? new MusicPreview(buffer) : null;
    this.music?.setMuted(this.muted);
    if (this.playing && this.music) this.music.start(this.project, this.time);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.music?.setMuted(m);
  }

  play(): void {
    if (this.playing) return;
    if (this.time >= totalLength(this.project) - 0.02) this.time = 0;
    this.playing = true;
    this.startedAt = performance.now();
    this.startTime = this.time;
    this.music?.start(this.project, this.time);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.music?.stop();
    for (const m of this.media.all()) m.video.pause();
  }

  seek(t: number): void {
    const wasPlaying = this.playing;
    this.pause();
    this.time = Math.max(0, Math.min(t, totalLength(this.project)));
    if (wasPlaying) this.play();
    else this.draw();
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.playing) {
      const len = totalLength(this.project);
      this.time = this.startTime + (performance.now() - this.startedAt) / 1000;
      if (this.time >= len) {
        this.time = len;
        this.pause();
      }
    }
    this.draw();
    this.onTime?.(this.time, this.playing);
  };

  private keep(video: HTMLVideoElement, source: number, speed: number, audible: boolean): boolean {
    const drift = Math.abs(video.currentTime - source);
    if (this.playing) {
      video.playbackRate = Math.min(4, Math.max(0.25, speed));
      video.muted = !audible || this.muted;
      if (drift > 0.25) video.currentTime = source;
      if (video.paused) void video.play().catch(() => undefined);
    } else {
      if (!video.paused) video.pause();
      if (drift > 0.04) video.currentTime = source;
    }
    return video.readyState >= 2;
  }

  /** The compositor at the current time; the pictures are the hidden <video> elements, kept at the asked source time. */
  draw(): void {
    if (this.drawing) return;
    this.drawing = true;
    const p = this.project;
    const used = new Set<HTMLVideoElement>();
    let first = true;
    const picture = (clipIndex: number, source: number, speed: number): Picture | null => {
      const clip = p.clips[clipIndex];
      const m = clip ? this.media.get(clip.source) : null;
      if (!m) return null;
      const audible = first && !p.music;
      first = false;
      // The same footage twice in a crossfade: one element, the incoming clip waits for it.
      if (used.has(m.video)) return null;
      used.add(m.video);
      return this.keep(m.video, source, speed, audible) ? { image: m.video, width: m.width, height: m.height, rotation: 0 } : null;
    };
    void composeFrame(this.grader, this.overlays, p, this.time, picture, { bypass: this.bypass })
      .then(() => {
        for (const m of this.media.all()) if (!used.has(m.video) && !m.video.paused) m.video.pause();
        this.ctx.drawImage(this.grader.canvas, 0, 0, this.canvas.width, this.canvas.height);
      })
      .catch(() => undefined)
      .finally(() => {
        this.drawing = false;
      });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.pause();
    this.music?.dispose();
    this.grader.dispose();
  }
}
