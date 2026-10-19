/**
 * Smaller copies of a finished picture for the pages that only show it (the client link, the
 * studio's cards): made once per width with Photon, kept next to the picture in R2, and served
 * as JPEG. The full-size picture stays what is downloaded and exported.
 */
import type { Env } from "./env";

/** Widths a page may ask for: a card, a phone-wide card, a lightbox. */
export const THUMB_WIDTHS = [480, 720, 1080] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

export function thumbWidth(raw: string | undefined): ThumbWidth | null {
  const n = Number(raw);
  return (THUMB_WIDTHS as readonly number[]).includes(n) ? (n as ThumbWidth) : null;
}

/** The picture at `key`, at most `w` wide, as JPEG bytes (null when the picture is gone). */
export async function resizedPicture(env: Env, key: string, w: ThumbWidth): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const cacheKey = `${key}.w${w}.jpg`;
  const cached = await env.BUCKET.get(cacheKey);
  if (cached) return { bytes: await cached.arrayBuffer(), mime: "image/jpeg" };
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const original = await obj.arrayBuffer();
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon");
  const img = PhotonImage.new_from_byteslice(new Uint8Array(original));
  try {
    const width = img.get_width();
    const height = img.get_height();
    if (width <= w) {
      const same = img.get_bytes_jpeg(86);
      const bytes = same.buffer.slice(same.byteOffset, same.byteOffset + same.byteLength) as ArrayBuffer;
      await env.BUCKET.put(cacheKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      return { bytes, mime: "image/jpeg" };
    }
    const small = resize(img, w, Math.round((height * w) / width), SamplingFilter.Lanczos3);
    try {
      const jpeg = small.get_bytes_jpeg(86);
      const bytes = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
      await env.BUCKET.put(cacheKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      return { bytes, mime: "image/jpeg" };
    } finally {
      small.free();
    }
  } finally {
    img.free();
  }
}

/** Every copy a picture has (full and resized), for deleting them together. */
export function pictureKeys(key: string): string[] {
  return [key, ...THUMB_WIDTHS.map((w) => `${key}.w${w}.jpg`)];
}
