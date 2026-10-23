/** The licences page names the FFmpeg build the editor ships, with the LGPL text and its source. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FFMPEG_VERSION, LICENCES_HTML } from "../server/licences";

describe("open-source licences page", () => {
  it("names the same FFmpeg release the AAC encoder is built from", () => {
    const script = readFileSync("scripts/aac-wasm/build.sh", "utf8");
    expect(script).toContain(`FFMPEG_VERSION=${FFMPEG_VERSION}`);
    expect(LICENCES_HTML).toContain(`ffmpeg-${FFMPEG_VERSION}.tar.xz`);
    expect(LICENCES_HTML).toContain("Lesser General Public License");
    expect(LICENCES_HTML).toContain("lgpl-2.1.html");
  });
});
