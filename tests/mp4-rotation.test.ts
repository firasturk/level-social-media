/**
 * A phone records a portrait clip as a wide picture and a quarter-turn in the track header's display
 * matrix. The size the studio stores (and the card's frame label) must be the size it plays at:
 * found in the QA round, a vertical phone clip was labelled "Landscape 16:9" on its card.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readMp4 } from "../server/mp4";

const file = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/video/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe("the size an MP4 plays at", () => {
  it("reads a plain clip's size as stored", () => {
    expect(readMp4(file("wide-64x36.mp4"))).toMatchObject({ isMp4: true, width: 64, height: 36 });
  });

  it("turns a phone's quarter-turned clip upright", () => {
    expect(readMp4(file("phone-rotated-64x36.mp4"))).toMatchObject({ isMp4: true, width: 36, height: 64 });
  });
});
