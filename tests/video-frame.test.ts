/**
 * The video frame (shared/video-frame.ts): the four frames with Reel 9:16 as the default, the
 * cover and contain placement maths the browser composes with, the frame a picture already has, how
 * a frame reaches an engine (its aspect option, or the picture composed first), and the stored
 * choice read back. Pure maths, no network.
 */
import { describe, expect, it } from "vitest";
import { containPlacement, coverPlacement, DEFAULT_FILL, DEFAULT_FRAME, FRAMES, frameLabel, frameOf, frameRoute, frameRouteLine, frameSize, frameStorageKey, isFill, isFrame, needsCompose, parseFrameChoice, pictureFrame } from "../shared/video-frame";

describe("the frames", () => {
  it("offers Reel 9:16 (the default), Portrait 4:5, Square 1:1 and Landscape 16:9, with plain labels", () => {
    expect(FRAMES.map((f) => f.id)).toEqual(["9:16", "4:5", "1:1", "16:9"]);
    expect(DEFAULT_FRAME).toBe("9:16");
    expect(DEFAULT_FILL).toBe("crop");
    expect(frameLabel("9:16")).toBe("Reel 9:16");
    expect(frameLabel("4:5")).toBe("Portrait 4:5");
    expect(frameLabel("1:1")).toBe("Square 1:1");
    expect(frameLabel("16:9")).toBe("Landscape 16:9");
    expect(frameLabel(null)).toBe("");
    expect(frameLabel("3:4")).toBe("");
    expect(isFrame("9:16")).toBe(true);
    expect(isFrame("3:4")).toBe(false);
    expect(isFill("blur")).toBe(true);
    expect(isFill("stretch")).toBe(false);
    expect(frameOf("16:9")).toMatchObject({ name: "Landscape", w: 16, h: 9 });
  });

  it("sizes a frame from its long side", () => {
    expect(frameSize("9:16")).toEqual({ w: 1080, h: 1920 });
    expect(frameSize("16:9")).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("1:1", 1080)).toEqual({ w: 1080, h: 1080 });
    expect(frameSize("4:5", 1350)).toEqual({ w: 1080, h: 1350 });
  });
});

describe("the placement maths", () => {
  const reel = frameSize("9:16");
  it("cover: a 4:5 picture fills a 9:16 canvas and loses its sides, centred", () => {
    const p = coverPlacement({ w: 1080, h: 1350 }, reel);
    expect(p.h).toBeCloseTo(1920);
    expect(p.w).toBeCloseTo(1536);
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(-228);
    // Centred: the same amount cut on each side.
    expect(p.x + p.w - reel.w).toBeCloseTo(-p.x);
  });
  it("cover: a landscape picture fills a 9:16 canvas top to bottom", () => {
    const p = coverPlacement({ w: 1920, h: 1080 }, reel);
    expect(p.h).toBeCloseTo(1920);
    expect(p.w).toBeCloseTo(3413.33, 1);
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeLessThan(0);
  });
  it("contain: the whole 4:5 picture sits inside a 9:16 canvas with bands above and below", () => {
    const p = containPlacement({ w: 1080, h: 1350 }, reel);
    expect(p.w).toBeCloseTo(1080);
    expect(p.h).toBeCloseTo(1350);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(285);
    expect(p.y + p.h + p.y).toBeCloseTo(reel.h);
  });
  it("contain: a wide picture inside a 9:16 canvas keeps its width and leaves bands", () => {
    const p = containPlacement({ w: 1920, h: 1080 }, reel);
    expect(p.w).toBeCloseTo(1080);
    expect(p.h).toBeCloseTo(607.5);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo((1920 - 607.5) / 2);
  });
  it("a picture already in the frame fits exactly and needs no composing", () => {
    expect(coverPlacement({ w: 540, h: 960 }, reel)).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(containPlacement({ w: 540, h: 960 }, reel)).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(pictureFrame(1080, 1920)).toBe("9:16");
    expect(pictureFrame(1080, 1350)).toBe("4:5");
    expect(pictureFrame(1000, 1000)).toBe("1:1");
    expect(pictureFrame(1920, 1080)).toBe("16:9");
    expect(pictureFrame(1000, 1300)).toBeNull();
    expect(pictureFrame(0, 10)).toBeNull();
    expect(needsCompose({ w: 1080, h: 1920 }, "9:16")).toBe(false);
    expect(needsCompose({ w: 1080, h: 1350 }, "9:16")).toBe(true);
  });
});

describe("how a frame reaches an engine", () => {
  it("hands the frame to an engine with that option, composes the picture for one without", () => {
    expect(frameRoute("9:16", ["16:9", "9:16", "1:1"])).toEqual({ aspect: "9:16", compose: false });
    expect(frameRoute("4:5", ["16:9", "9:16", "1:1"])).toEqual({ aspect: undefined, compose: true });
    expect(frameRoute("9:16", null)).toEqual({ aspect: undefined, compose: true });
    expect(frameRoute("9:16", [])).toEqual({ aspect: undefined, compose: true });
    expect(frameRouteLine("Kling 2.6 Pro", "9:16", ["9:16"], "crop")).toBe("Kling 2.6 Pro takes the Reel 9:16 frame itself.");
    expect(frameRouteLine("Seedance 2.5", "9:16", null, "crop")).toMatch(/follows the picture's frame, so the picture is made Reel 9:16 here before it is sent \(cropped to fit, centred\)/);
    expect(frameRouteLine("Seedance 2.5", "1:1", null, "blur")).toMatch(/made Square 1:1 here .* \(the whole picture over blurred edges\)/);
  });

  it("remembers the choice per month and falls back to the defaults for anything unknown", () => {
    expect(frameStorageKey("b1")).toBe("lsm-video-frame-b1");
    expect(parseFrameChoice(null)).toEqual({ frame: "9:16", fill: "crop" });
    expect(parseFrameChoice(JSON.stringify({ frame: "1:1", fill: "blur" }))).toEqual({ frame: "1:1", fill: "blur" });
    expect(parseFrameChoice(JSON.stringify({ frame: "3:4", fill: "stretch" }))).toEqual({ frame: "9:16", fill: "crop" });
    expect(parseFrameChoice("not json")).toEqual({ frame: "9:16", fill: "crop" });
  });
});
