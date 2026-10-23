/**
 * A post's picture brought to another frame (1:1, 4:5, 9:16) for free: the picture's size is read
 * from its first bytes, and when its shape differs the middle of it is cut to the new frame (no
 * engine, nothing paid). The cut picture becomes the post's picture, the previous one stays under
 * Versions; a post the client answered keeps the client's version and the cut waits beside it.
 * Used by the planner chat ("crop all the photos to 4:5"), which must never remake a picture to
 * change its size. (Live: asked to crop, the chat said done without doing anything, then offered to
 * generate every picture again.)
 */
import type { Env } from "./env";
import { first, now, run, uuid } from "./db";
import { imageSize } from "./image-size";
import { FORMATS, postRevision, type Format } from "@shared/posts";
import { clientHold } from "@shared/client-hold";
import type { Config } from "@shared/config";

export const FORMAT_RATIO: Record<Format, number> = { "1:1": 1, "4:5": 4 / 5, "9:16": 9 / 16 };

/** The frame a size already is (within 1.5%), or null. */
export function frameOf(size: { width: number; height: number }): Format | null {
  const r = size.width / size.height;
  return FORMATS.find((f) => Math.abs(r - FORMAT_RATIO[f]) / FORMAT_RATIO[f] < 0.015) ?? null;
}

/** "1086×1358 (4:5)" or "1365×1365 (1:1)", or the bare size when it is no studio frame. */
export function sizeLabel(size: { width: number; height: number }): string {
  const f = frameOf(size);
  return `${size.width}×${size.height}${f ? ` (${f})` : ""}`;
}

/** The middle of a picture in another frame: the largest box of that shape, centred. */
export function centreBox(width: number, height: number, format: Format): { x1: number; y1: number; x2: number; y2: number } {
  const ratio = FORMAT_RATIO[format];
  if (width / height > ratio) {
    const w = Math.round(height * ratio);
    const x1 = Math.floor((width - w) / 2);
    return { x1, y1: 0, x2: x1 + w, y2: height };
  }
  const h = Math.round(width / ratio);
  const y1 = Math.floor((height - h) / 2);
  return { x1: 0, y1, x2: width, y2: y1 + h };
}

/** A picture's size from its first bytes (a ranged read), else from the whole file. */
export async function storedSize(env: Env, key: string): Promise<{ width: number; height: number } | null> {
  const head = await env.BUCKET.get(key, { range: { offset: 0, length: 256 * 1024 } }).catch(() => null);
  const fromHead = head ? imageSize(await head.arrayBuffer()) : null;
  if (fromHead) return fromHead;
  const obj = await env.BUCKET.get(key);
  return obj ? imageSize(await obj.arrayBuffer()) : null;
}

/** The size of each post's current picture, for the chat to see. */
export async function postPictureSizes(env: Env, batch: string, indexes: number[]): Promise<Map<number, { width: number; height: number }>> {
  const out = new Map<number, { width: number; height: number }>();
  for (const index of indexes) {
    const t = await first<{ output: string | null }>(env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", batch, index);
    if (!t?.output) continue;
    const size = await storedSize(env, t.output).catch(() => null);
    if (size) out.set(index, size);
  }
  return out;
}

export type FrameOutcome = "already" | "cropped" | "held" | "no-picture" | "unreadable";

/**
 * One post's picture cut to a frame. Writes the new picture beside the old one in the post's
 * output folder; the old picture stays a version (a take, and the month's snapshot "before the
 * crop"). Nothing is sent anywhere.
 */
export async function framePostPicture(env: Env, b: { id: string; owner: string }, config: Config, index: number, format: Format): Promise<FrameOutcome> {
  const t = await first<{ id: string; output: string | null; status: string }>(env.DB, "SELECT id, output, status FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, index);
  if (!t?.output || ["queued", "processing", "finalizing"].includes(t.status)) return "no-picture";
  const obj = await env.BUCKET.get(t.output);
  if (!obj) return "no-picture";
  const bytes = await obj.arrayBuffer();
  const size = imageSize(bytes);
  if (!size) return "unreadable";
  if (frameOf(size) === format) return "already";
  const { PhotonImage, crop } = await import("@cf-wasm/photon");
  let out: { bytes: ArrayBuffer; mime: string; ext: string };
  const img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
  try {
    const box = centreBox(img.get_width(), img.get_height(), format);
    const cut = crop(img, box.x1, box.y1, box.x2, box.y2);
    try {
      const png = /png/i.test(obj.httpMetadata?.contentType ?? "") || /\.png$/i.test(t.output);
      const raw = png ? cut.get_bytes() : cut.get_bytes_jpeg(92);
      out = { bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, mime: png ? "image/png" : "image/jpeg", ext: png ? "png" : "jpg" };
    } finally {
      cut.free();
    }
  } catch {
    return "unreadable";
  } finally {
    img.free();
  }
  const key = `${b.owner}/${b.id}/output/${t.id}/${uuid()}.${out.ext}`;
  await env.BUCKET.put(key, out.bytes, { httpMetadata: { contentType: out.mime } });
  const post = (config.plan ?? []).find((p) => p.index === index);
  const madeFor = post ? postRevision(post, config) : null;
  const note = `Cut to ${format} from ${sizeLabel(size)} (free, the middle of the picture kept)`;
  if (clientHold(config, index)) {
    await run(env.DB, "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)", uuid(), b.id, index, t.id, key, `${note} · new version (the client's version stays)`, madeFor, now());
    return "held";
  }
  await run(env.DB, "UPDATE tasks SET output = ?, updated = ? WHERE id = ?", key, now() + 1, t.id);
  await run(env.DB, "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)", uuid(), b.id, index, t.id, key, note, madeFor, now());
  await run(env.DB, "INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES (?, ?, 'snapshot', ?, ?, ?, ?)", uuid(), b.id, `Post ${index} before the crop to ${format}`, JSON.stringify({ [String(index)]: t.output }), JSON.stringify([{ post: index, key: t.output, at: now() }]), now());
  return "cropped";
}
