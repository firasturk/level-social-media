/**
 * A light read of an MP4's box structure, enough to accept an upload and describe it: is it an
 * ISO MP4 at all, is the `moov` index in front of the media (progressive playback on iPhone), how
 * long is it, and does it carry H.264 video and AAC audio. Nothing is decoded.
 */
export interface Mp4Info {
  /** The file starts with an `ftyp` box: an ISO base-media file (MP4, M4V, MOV). */
  isMp4: boolean;
  brands: string[];
  /** `moov` comes before `mdat`: the player can start before the download ends. */
  faststart: boolean | null;
  /** Seconds from the movie header, when found. */
  duration: number | null;
  /** The sample-description fourccs found in the index (avc1 = H.264, hvc1/hev1 = HEVC, mp4a = AAC). */
  codecs: string[];
  video: "h264" | "hevc" | "other" | null;
  audio: "aac" | "other" | null;
  width: number | null;
  height: number | null;
}

function fourcc(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

interface Box {
  type: string;
  start: number;
  size: number;
  head: number;
}

/** The boxes between `from` and `to` at one level. */
function boxes(v: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = v.getUint32(at);
    let head = 8;
    const type = fourcc(v, at + 4);
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(v.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head) break;
    out.push({ type, start: at, size, head });
    at += size;
  }
  return out;
}

export function readMp4(bytes: ArrayBuffer): Mp4Info {
  const v = new DataView(bytes);
  const info: Mp4Info = { isMp4: false, brands: [], faststart: null, duration: null, codecs: [], video: null, audio: null, width: null, height: null };
  if (bytes.byteLength < 16) return info;
  const top = boxes(v, 0, bytes.byteLength);
  const ftyp = top[0];
  if (!ftyp || ftyp.type !== "ftyp") return info;
  info.isMp4 = true;
  for (let at = ftyp.start + 8; at + 4 <= ftyp.start + ftyp.size; at += 4) {
    const b = fourcc(v, at).trim();
    if (b && !info.brands.includes(b) && at !== ftyp.start + 12) info.brands.push(b);
  }
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (moov && mdat) info.faststart = moov.start < mdat.start;
  else if (moov) info.faststart = true;
  if (!moov) return info;
  for (const b of boxes(v, moov.start + moov.head, moov.start + moov.size)) {
    if (b.type === "mvhd") {
      const version = v.getUint8(b.start + 8);
      const timescale = version === 1 ? v.getUint32(b.start + 28) : v.getUint32(b.start + 20);
      const duration = version === 1 ? Number(v.getBigUint64(b.start + 32)) : v.getUint32(b.start + 24);
      if (timescale > 0) info.duration = Math.round((duration / timescale) * 100) / 100;
    }
    if (b.type === "trak") readTrack(v, b, info);
  }
  return info;
}

function readTrack(v: DataView, trak: Box, info: Mp4Info): void {
  const walk = (box: Box, path: string[]): void => {
    for (const b of boxes(v, box.start + box.head, box.start + box.size)) {
      if (b.type === "tkhd" && info.width === null) {
        const version = v.getUint8(b.start + 8);
        const at = b.start + (version === 1 ? 96 : 84);
        if (at + 8 <= b.start + b.size) {
          const w = v.getUint32(at) >>> 16;
          const h = v.getUint32(at + 4) >>> 16;
          if (w && h) {
            info.width = w;
            info.height = h;
          }
        }
      }
      if (b.type === "stsd") {
        // version/flags (4) + entry count (4), then sample entries.
        for (const e of boxes(v, b.start + 16, b.start + b.size)) {
          if (!info.codecs.includes(e.type)) info.codecs.push(e.type);
          if (e.type === "avc1" || e.type === "avc3") info.video = "h264";
          else if (e.type === "hvc1" || e.type === "hev1") info.video = info.video ?? "hevc";
          else if (e.type === "mp4a") info.audio = "aac";
          else if (/^(vp09|av01|mp4v|s263)$/.test(e.type)) info.video = info.video ?? "other";
          else if (/^(ac-3|ec-3|Opus|alac|samr)$/.test(e.type)) info.audio = info.audio ?? "other";
        }
      }
      if (["mdia", "minf", "stbl"].includes(b.type)) walk(b, [...path, b.type]);
    }
  };
  walk(trak, ["trak"]);
}
