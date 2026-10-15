import { Zip, ZipPassThrough } from "fflate";
import { splitIntoParts } from "@shared/zip-parts";

export interface ZipEntry {
  name: string;
  /** Fetched from the app when no `blob` is given. */
  url?: string;
  /** Bytes already in memory (for example an image rendered in the browser). */
  blob?: Blob;
  /** Convert the fetched image to this format before adding it (originals are never converted). */
  convert?: { format: "jpg" | "webp"; quality: number; fit?: boolean };
}

/** Export size window: every fitted JPG/WebP lands between these, when the image allows it. */
export const FIT_MIN = 1_000_000;
export const FIT_MAX = 1_900_000;
/** Lowest JPG/WebP quality the fit may reach; resolution is never reduced. */
export const FIT_FLOOR = 35;

/**
 * Re-encodes until the file is inside the 1-1.9 MB window: lower quality while too big, raise it
 * while too small, in steps of 5 between 35 and 100. A small image that stays under 1 MB even at
 * quality 100 is kept at 100; a huge one that stays over 1.9 MB at 35 is kept at 35. The pixel
 * size never changes.
 */
export async function fitImage(
  blob: Blob,
  format: "jpg" | "webp",
  startQuality: number,
): Promise<Blob> {
  let q = Math.min(100, Math.max(FIT_FLOOR, Math.round(startQuality / 5) * 5));
  let out = await convertImage(blob, format, q);
  if (out.size > FIT_MAX) {
    while (out.size > FIT_MAX && q > FIT_FLOOR) {
      q -= 5;
      out = await convertImage(blob, format, q);
    }
    return out;
  }
  let best = out;
  while (best.size < FIT_MIN && q < 100) {
    q += 5;
    const next = await convertImage(blob, format, q);
    if (next.size > FIT_MAX) break;
    best = next;
  }
  return best;
}

/** Re-encodes an image blob in the browser. */
export async function convertImage(
  blob: Blob,
  format: "jpg" | "webp",
  quality: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    if (format === "jpg") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Conversion failed."))),
        format === "jpg" ? "image/jpeg" : "image/webp",
        quality / 100,
      ),
    );
  } finally {
    bitmap.close();
  }
}

/** Largest ZIP part the export produces; a bigger export is split into part1, part2, … */
export const PART_MAX = 1_400_000_000;

/** One file prepared for the archive: its bytes, after any conversion. */
async function prepare(entry: ZipEntry): Promise<Uint8Array> {
  let blob = entry.blob;
  if (!blob) {
    const r = await fetch(entry.url ?? "", { credentials: "same-origin" });
    if (!r.ok) throw new Error(`Could not download ${entry.name}. Retry export.`);
    blob = await r.blob();
  }
  if (entry.convert) {
    const converted = entry.convert.fit
      ? await fitImage(blob, entry.convert.format, entry.convert.quality)
      : await convertImage(blob, entry.convert.format, entry.convert.quality);
    return new Uint8Array(await converted.arrayBuffer());
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** An uncompressed ZIP assembled in memory from prepared files (images are already compressed). */
class ZipPart {
  private chunks: Uint8Array[] = [];
  private zip: Zip;
  private done: Promise<void>;
  bytes = 0;
  files = 0;
  constructor() {
    let finish!: () => void;
    let fail!: (e: Error) => void;
    this.done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    this.done.catch(() => {});
    this.zip = new Zip((err, data, final) => {
      if (err) return fail(err);
      this.chunks.push(data);
      this.bytes += data.length;
      if (final) finish();
    });
  }
  add(name: string, data: Uint8Array) {
    const item = new ZipPassThrough(name);
    this.zip.add(item);
    item.push(data, true);
    this.files++;
  }
  async close(): Promise<Blob> {
    this.zip.end();
    await this.done;
    return new Blob(this.chunks as BlobPart[], { type: "application/zip" });
  }
}

/**
 * Builds the export as one or more ZIP files, each at most `partMax` bytes, split at product
 * folders (see shared/zip-parts.ts). Files are fetched and converted first, then packed.
 */
export async function buildZips(entries: ZipEntry[], partMax = PART_MAX): Promise<Blob[]> {
  const data: Uint8Array[] = [];
  for (const e of entries) data.push(await prepare(e));
  const plan = splitIntoParts(
    entries.map((e, i) => ({ name: e.name, size: data[i].length })),
    partMax,
  );
  const parts: Blob[] = [];
  for (const indexes of plan) {
    const part = new ZipPart();
    for (const i of indexes) part.add(entries[i].name, data[i]);
    parts.push(await part.close());
  }
  return parts;
}

/** Saves every part, named `<base>.zip` alone or `<base>-part1of3.zip` when split. */
export async function saveZips(parts: Blob[], base: string): Promise<void> {
  for (let i = 0; i < parts.length; i++) {
    const name = parts.length === 1 ? `${base}.zip` : `${base}-part${i + 1}of${parts.length}.zip`;
    saveBlob(parts[i], name);
    // Browsers drop downloads fired in the same instant; a short gap keeps every part.
    if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
