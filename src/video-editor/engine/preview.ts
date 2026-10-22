/**
 * The preview: the timeline played on a canvas at reduced size, drawn through the same grader as
 * the export. Each clip's hidden <video> is kept near the source time the timeline asks for (the
 * browser's own H.264 decoder does the work here; WebCodecs is used by the export). Without
 * music the clip on screen is heard; with music, the music plays from the timeline time.
 */
import type { CubeLut } from "@shared/cube-lut";
import { frameAt, lookOf, totalLength, type VideoProject } from "@shared/video-project";
import { MusicPreview } from "./audio";
import { combineColour, Grader } from "./grader";
import type { MediaStore } from "./media";

const MAX_PREVIEW_W = 540;
const MAX_PREVIEW_H = 960;

export class Player {
  private grader: Grader;
  private ctx: CanvasRenderingContext2D;
  private project: VideoProject;
  private raf = 0;
  private startedAt = 0;
  private startTime = 0;
  private music: MusicPreview | null = null;
  time = 0;
  playing = false;
  bypass = false;
  onTime: ((t: number, playing: boolean) => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private media: MediaStore,
    project: VideoProject,
  ) {
    this.project = project;
    this.ctx = canvas.getContext("2d")!;
    const { w, h } = this.previewSize(project);
    this.grader = new Grader(w, h);
    canvas.width = w;
    canvas.height = h;
    this.loop();
  }

  private previewSize(p: VideoProject): { w: number; h: number } {
    const s = Math.min(1, MAX_PREVIEW_W / p.output.width, MAX_PREVIEW_H / p.output.height);
    return { w: Math.max(2, Math.round((p.output.width * s) / 2) * 2), h: Math.max(2, Math.round((p.output.height * s) / 2) * 2) };
  }

  setProject(p: VideoProject): void {
    this.project = p;
    const { w, h } = this.previewSize(p);
    if (w !== this.grader.width || h !== this.grader.height) {
      this.grader.resize(w, h);
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const len = totalLength(p);
    if (this.time > len) this.time = len;
  }

  setLut(lut: CubeLut | null): void {
    this.grader.setLut(lut);
  }

  setMusic(buffer: AudioBuffer | null): void {
    this.music?.dispose();
    this.music = buffer ? new MusicPreview(buffer) : null;
    if (this.playing && this.music) this.music.start(this.project, this.time);
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
      video.muted = !audible;
      if (drift > 0.25) video.currentTime = source;
      if (video.paused) void video.play().catch(() => undefined);
    } else {
      if (!video.paused) video.pause();
      if (drift > 0.04) video.currentTime = source;
    }
    return video.readyState >= 2;
  }

  draw(): void {
    const p = this.project;
    const on = frameAt(p.clips, this.time);
    const base = combineColour(lookOf(p.look).params, p.colour);
    const lutStrength = p.lut?.strength ?? 1;
    if (!on.a) {
      this.grader.clear();
    } else {
      const ma = this.media.get(on.a.placed.clip.source);
      const mb = on.b ? this.media.get(on.b.placed.clip.source) : null;
      const audible = !p.music;
      const readyA = ma ? this.keep(ma.video, on.a.source, on.a.placed.clip.speed, audible) : false;
      let b: { source: { image: HTMLVideoElement; width: number; height: number }; mix: number } | null = null;
      if (on.b && mb && mb !== ma) {
        const readyB = this.keep(mb.video, on.b.source, on.b.placed.clip.speed, false);
        if (readyB) b = { source: { image: mb.video, width: mb.width, height: mb.height }, mix: on.b.mix };
      }
      for (const m of this.media.all()) if (m !== ma && m !== mb && !m.video.paused) m.video.pause();
      if (ma && readyA) this.grader.draw({ image: ma.video, width: ma.width, height: ma.height }, b, { params: combineColour(base, on.a.placed.clip.colour), lutStrength, bypass: this.bypass });
      else this.grader.clear();
    }
    this.ctx.drawImage(this.grader.canvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.pause();
    this.music?.dispose();
    this.grader.dispose();
  }
}
