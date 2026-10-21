/**
 * Smaller copies of a finished picture for the pages that only show it (the client link, the
 * studio's cards): made once per width with Photon, kept next to the picture in R2, and served
 * as JPEG. The full-size picture stays what is downloaded and exported.
 */
import type { Env } from "./env";

/** Widths a page may ask for: a card, a phone-wide card, a lightbox. */
export const THUMB_WIDTHS = [480, 720, 1080, 1440] as const;
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
      const same = img.get_bytes_jpeg(90);
      const bytes = same.buffer.slice(same.byteOffset, same.byteOffset + same.byteLength) as ArrayBuffer;
      await env.BUCKET.put(cacheKey, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      return { bytes, mime: "image/jpeg" };
    }
    const small = resize(img, w, Math.round((height * w) / width), SamplingFilter.Lanczos3);
    try {
      const jpeg = small.get_bytes_jpeg(90);
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

/**
 * A difference hash of a picture: 9×8 grey pixels, each bit says whether a pixel is brighter than
 * its right neighbour. Two pictures with the same composition give hashes a few bits apart.
 */
export async function pictureHash(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon");
    const img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
    try {
      const small = resize(img, 9, 8, SamplingFilter.Triangle);
      try {
        const px = small.get_raw_pixels();
        const grey = (x: number, y: number) => {
          const i = (y * 9 + x) * 4;
          return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        };
        let hex = "";
        for (let y = 0; y < 8; y++) {
          let byte = 0;
          for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey(x, y) > grey(x + 1, y) ? 1 : 0);
          hex += byte.toString(16).padStart(2, "0");
        }
        return hex;
      } finally {
        small.free();
      }
    } finally {
      img.free();
    }
  } catch {
    return null;
  }
}

/** How many bits two fingerprints differ in (0 = the same picture, under 10 = the same composition). */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
