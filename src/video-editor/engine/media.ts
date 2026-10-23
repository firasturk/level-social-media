/**
 * The footage behind the clips, kept once per source: a stored version of the post (read from the
 * studio's Range route) or a file picked in the browser (a blob URL). Each source gets a hidden
 * <video> for the preview and the energy reader, its bytes for the export's demuxer, its decoded
 * sound for the mix, and its motion energy for the auto edit, each read when first needed.
 */
import type { ClipSource } from "@shared/video-project";
import { isHdr, type Rotation, type SourceColour } from "@shared/video-compose";
import { decodeAudio } from "./audio";
import { motionEnergy } from "./energy";

export const sourceKey = (s: ClipSource): string => (s.kind === "version" ? `version:${s.batch}:${s.videoId}` : `upload:${s.name}:${s.size}`);

export interface Media {
  key: string;
  source: ClipSource;
  url: string;
  file: File | null;
  label: string;
  duration: number;
  width: number;
  height: number;
  /** The hidden element the preview draws from. */
  video: HTMLVideoElement;
  bytes?: Promise<ArrayBuffer>;
  /** What the file itself says, read on import (`inspect`): rotation, colour, codec. */
  meta?: SourceMeta;
  inspecting?: Promise<SourceMeta | null>;
  audio?: Promise<AudioBuffer | null>;
  energy?: Promise<Float32Array>;
}

export interface SourceMeta {
  codec: string;
  rotation: Rotation;
  coded: { width: number; height: number };
  colour: SourceColour | null;
  hdr: boolean;
}

/** One line for the Media panel: "rotated 90° · BT.709 · HDR, not tone-mapped". */
export function metaLine(m: SourceMeta | undefined): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.rotation) parts.push(`phone rotation ${m.rotation}° (turned upright)`);
  parts.push(m.colour?.matrix ? `${m.colour.matrix === "bt709" ? "BT.709" : m.colour.matrix === "smpte170m" || m.colour.matrix === "bt470bg" ? "BT.601" : m.colour.matrix.toUpperCase()}${m.colour.fullRange ? " full range" : ""}` : "colour not labelled (assumed by size)");
  if (m.hdr) parts.push("HDR, not tone-mapped: colours may look flat");
  return parts.join(" · ");
}

export class MediaStore {
  private items = new Map<string, Media>();

  get(source: ClipSource): Media | null {
    return this.items.get(sourceKey(source)) ?? null;
  }

  all(): Media[] {
    return [...this.items.values()];
  }

  /** Registers a source and reads its length and size through a hidden <video>; the same source is read once. */
  async add(source: ClipSource, where: { url: string; file?: File; label: string }): Promise<Media> {
    const key = sourceKey(source);
    const had = this.items.get(key);
    if (had) return had;
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "use-credentials";
    video.src = where.url;
    const meta = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${where.label}: the browser did not read this clip (is it an H.264 MP4?).`)), 20000);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${where.label}: this browser cannot play the clip (it needs an H.264 MP4; open-source Chromium builds decode no H.264).`));
      };
    });
    if (!Number.isFinite(meta.duration) || meta.duration <= 0) throw new Error(`${where.label}: the clip's length could not be read.`);
    const media: Media = { key, source, url: where.url, file: where.file ?? null, label: where.label, duration: meta.duration, width: meta.width, height: meta.height, video };
    this.items.set(key, media);
    return media;
  }

  bytes(m: Media): Promise<ArrayBuffer> {
    m.bytes ??= m.file ? m.file.arrayBuffer() : fetch(m.url, { credentials: "same-origin" }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${m.label}: the clip could not be fetched (${r.status}).`))));
    return m.bytes;
  }

  /** The file's own description (rotation, colour) read with the demuxer; null when it cannot be read here. */
  inspect(m: Media): Promise<SourceMeta | null> {
    m.inspecting ??= this.bytes(m)
      .then((b) => import("./demux").then(({ demuxMp4 }) => demuxMp4(b)))
      .then((d) => {
        m.meta = { codec: d.codec, rotation: d.rotation, coded: { width: d.width, height: d.height }, colour: d.colour, hdr: isHdr(d.colour) };
        return m.meta;
      })
      .catch(() => null);
    return m.inspecting;
  }

  audio(m: Media): Promise<AudioBuffer | null> {
    m.audio ??= this.bytes(m).then(decodeAudio);
    return m.audio;
  }

  energy(m: Media, onProgress?: (f: number) => void): Promise<Float32Array> {
    m.energy ??= motionEnergy(m.video, 0.5, onProgress);
    return m.energy;
  }

  dispose(): void {
    for (const m of this.items.values()) {
      m.video.removeAttribute("src");
      m.video.load();
      if (m.url.startsWith("blob:")) URL.revokeObjectURL(m.url);
    }
    this.items.clear();
  }
}
