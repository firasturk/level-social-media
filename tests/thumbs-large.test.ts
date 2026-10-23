/**
 * A camera original is too large for the Worker to decode (a 30 MP photo is 120 MB of pixels, the
 * Worker has 128 MB): asking for a card-size copy must not decode it. Found on the live site: a
 * client's Drive photos (4480×6720) showed as broken pictures on their cards.
 */
import { describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { decodable, MAX_DECODE_PIXELS, resizedPicture } from "../server/thumbs";
import { imageSize } from "../server/image-size";

/** A JPEG that is only its header: SOI, then a baseline SOF0 saying `width`×`height`. */
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
}

describe("card-size copies of very large pictures", () => {
  it("reads the size from the header and refuses to decode past the budget", () => {
    expect(imageSize(jpegHeader(4480, 6720).buffer as ArrayBuffer)).toEqual({ width: 4480, height: 6720 });
    expect(decodable({ width: 4480, height: 6720 })).toBe(false);
    expect(decodable({ width: 3000, height: 4000 })).toBe(true);
    expect(4480 * 6720).toBeGreaterThan(MAX_DECODE_PIXELS);
    expect(decodable(null)).toBe(true);
  });

  it("serves a too-large upload as it is instead of decoding it (the browser draws it)", async () => {
    const env = fakeEnv();
    const big = jpegHeader(4480, 6720);
    await env.BUCKET.put("u/b/output/t/big.jpg", big, { httpMetadata: { contentType: "image/jpeg" } });
    // Photon would throw on these bytes (no image data): returning means it was never asked.
    const r = await resizedPicture(env as never, "u/b/output/t/big.jpg", 1080);
    expect(r?.key).toBe("u/b/output/t/big.jpg");
    expect(r?.mime).toBe("image/jpeg");
    expect(new Uint8Array(r!.bytes)).toEqual(big);
    // Nothing is cached under the card-size name: it would be the full picture under a small name.
    expect(await env.BUCKET.get("u/b/output/t/big.jpg.w1080.jpg")).toBeNull();
  });
});
