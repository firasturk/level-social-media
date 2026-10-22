import { describe, expect, it } from "vitest";
import {
  applyColor,
  applyPixels,
  areaWords,
  clampCrop,
  cropForAspect,
  cropPixels,
  DEFAULT_ADJUST,
  describeAdjust,
  isDefaultAdjust,
  moveCrop,
  outputSize,
  resizeCrop,
  rotatedSize,
  straightenScale,
  toneCurve,
  unsharpMask,
  vignette,
  whiteBalanceGains,
  type AdjustParams,
} from "../shared/photo-adjust";

/**
 * The Photo studio's Adjust maths, on numbers and small buffers: the crop rectangle rules, the
 * tone curve, the colour pipeline, sharpen and vignette. No canvas, no DOM, no network.
 */

const P = (patch: Partial<AdjustParams>): AdjustParams => ({ ...DEFAULT_ADJUST, ...patch });
/** A w×h RGBA buffer of one colour. */
const flat = (w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rgb[0];
    d[i + 1] = rgb[1];
    d[i + 2] = rgb[2];
    d[i + 3] = 255;
  }
  return d;
};
const px = (d: Uint8ClampedArray, i: number) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];

describe("Adjust: what changed", () => {
  it("the defaults change nothing and say so", () => {
    expect(isDefaultAdjust(DEFAULT_ADJUST)).toBe(true);
    expect(describeAdjust(DEFAULT_ADJUST)).toEqual([]);
  });
  it("names each change in plain words, for the take's note", () => {
    const words = describeAdjust(P({ crop: { x: 0, y: 0.1, w: 1, h: 0.8 }, aspect: "4:5", rotate: 90, flipH: true, straighten: -3, exposure: 20, sharpen: 30 }));
    expect(words).toEqual(["crop 4:5", "rotate 90°", "flip horizontally", "straighten -3°", "exposure +20", "sharpen 30"]);
    expect(isDefaultAdjust(P({ vignette: 10 }))).toBe(false);
  });
});

describe("Adjust: crop geometry", () => {
  it("turns the size with a quarter turn", () => {
    expect(rotatedSize(1080, 1350, 90)).toEqual({ w: 1350, h: 1080 });
    expect(rotatedSize(1080, 1350, 180)).toEqual({ w: 1080, h: 1350 });
  });
  it("centres the largest crop of an aspect inside the picture", () => {
    // A 4:5 picture asked for 1:1: the full width, a shorter height, centred.
    const sq = cropForAspect("1:1", 1080, 1350);
    expect(sq.w).toBe(1);
    expect(sq.h).toBeCloseTo(0.8, 6);
    expect(sq.y).toBeCloseTo(0.1, 6);
    // Asked for 9:16 (taller than 4:5): the full height, a narrower width.
    const tall = cropForAspect("9:16", 1080, 1350);
    expect(tall.h).toBe(1);
    expect(tall.w * 1080).toBeCloseTo((1350 * 9) / 16, 3);
    expect(tall.x).toBeCloseTo((1 - tall.w) / 2, 6);
    expect(cropForAspect("free", 1080, 1350)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("keeps a crop inside the picture and holds its aspect", () => {
    const c = clampCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, "free", 1080, 1350);
    expect(c.x + c.w).toBeLessThanOrEqual(1);
    expect(c.y + c.h).toBeLessThanOrEqual(1);
    const sq = clampCrop({ x: 0, y: 0, w: 0.5, h: 0.9 }, "1:1", 1080, 1350);
    expect((sq.w * 1080) / (sq.h * 1350)).toBeCloseTo(1, 6);
    // Too small shrinks no further than the minimum.
    const tiny = clampCrop({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 }, "free", 1080, 1350);
    expect(tiny.w).toBeGreaterThanOrEqual(0.05);
  });
  it("rounds a crop to whole pixels, never past the edge", () => {
    expect(cropPixels(null, 1080, 1350)).toEqual({ x: 0, y: 0, w: 1080, h: 1350 });
    expect(cropPixels({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 }, 1080, 1350)).toEqual({ x: 270, y: 135, w: 540, h: 1080 });
    const edge = cropPixels({ x: 0.999, y: 0.999, w: 0.5, h: 0.5 }, 100, 100);
    expect(edge.x + edge.w).toBeLessThanOrEqual(100);
    expect(edge.w).toBeGreaterThanOrEqual(1);
  });
  it("gives the output size from the rotation and the crop", () => {
    expect(outputSize(P({ rotate: 90 }), 1080, 1350)).toEqual({ w: 1350, h: 1080 });
    expect(outputSize(P({ crop: cropForAspect("1:1", 1080, 1350), aspect: "1:1" }), 1080, 1350)).toEqual({ w: 1080, h: 1080 });
  });
  it("drags a handle with the far side anchored, and moves the frame inside the picture", () => {
    const c = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    const e = resizeCrop(c, "e", 0.1, 0, "free", 1000, 1000);
    expect(e).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.5 });
    const nw = resizeCrop(c, "nw", 0.1, 0.1, "free", 1000, 1000);
    expect(nw.x + nw.w).toBeCloseTo(0.7, 6);
    expect(nw.y + nw.h).toBeCloseTo(0.7, 6);
    expect(nw.w).toBeCloseTo(0.4, 6);
    // With an aspect, the dragged side decides and the other follows; the anchor holds.
    const sq = resizeCrop(c, "e", 0.2, 0, "1:1", 1000, 1000);
    expect(sq.w).toBeCloseTo(0.7, 6);
    expect(sq.h).toBeCloseTo(0.7, 6);
    expect(sq.x).toBeCloseTo(0.2, 6);
    const moved = moveCrop(c, 0.9, -0.9);
    expect(moved).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });
  it("scales a straightened picture just enough to fill its frame", () => {
    expect(straightenScale(0, 1080, 1350)).toBe(1);
    const s = straightenScale(10, 1080, 1350);
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThan(1.3);
    expect(straightenScale(-10, 1080, 1350)).toBeCloseTo(s, 9);
  });
});

describe("Adjust: colour", () => {
  it("leaves the tones alone at the defaults", () => {
    const lut = toneCurve(DEFAULT_ADJUST);
    expect(lut[0]).toBe(0);
    expect(lut[128]).toBe(128);
    expect(lut[255]).toBe(255);
  });
  it("exposure brightens every tone but black; contrast spreads around middle grey", () => {
    const bright = toneCurve(P({ exposure: 50 }));
    expect(bright[0]).toBe(0);
    expect(bright[100]).toBeGreaterThan(100);
    expect(bright[255]).toBe(255);
    const dark = toneCurve(P({ exposure: -50 }));
    expect(dark[200]).toBeLessThan(200);
    const con = toneCurve(P({ contrast: 50 }));
    expect(con[64]).toBeLessThan(64);
    expect(con[192]).toBeGreaterThan(192);
    expect(Math.abs(con[128] - 128)).toBeLessThanOrEqual(1);
  });
  it("highlights move only the bright end and shadows only the dark end", () => {
    const hi = toneCurve(P({ highlights: -100 }));
    expect(hi[230]).toBeLessThan(230);
    expect(Math.abs(hi[30] - 30)).toBeLessThanOrEqual(2);
    const sh = toneCurve(P({ shadows: 100 }));
    expect(sh[30]).toBeGreaterThan(30);
    expect(Math.abs(sh[230] - 230)).toBeLessThanOrEqual(2);
  });
  it("saturation pulls a colour to its grey or pushes it away", () => {
    const d = flat(2, 1, [200, 100, 50]);
    applyColor(d, P({ saturation: -100 }));
    const [r, g, b] = px(d, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    const d2 = flat(1, 1, [200, 100, 50]);
    applyColor(d2, P({ saturation: 50 }));
    expect(d2[0]).toBeGreaterThan(200);
    expect(d2[2]).toBeLessThan(50);
    expect(d2[3]).toBe(255);
  });
  it("temperature warms (more red, less blue) and tint shifts green against magenta", () => {
    expect(whiteBalanceGains(P({ temperature: 100 }))).toMatchObject({ r: 1.25, b: 0.75 });
    const warm = flat(1, 1, [128, 128, 128]);
    applyColor(warm, P({ temperature: 60 }));
    expect(warm[0]).toBeGreaterThan(128);
    expect(warm[2]).toBeLessThan(128);
    const green = flat(1, 1, [128, 128, 128]);
    applyColor(green, P({ tint: 100 }));
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);
  });
  it("does nothing to a buffer at the defaults, and clamps at the ends", () => {
    const d = flat(3, 1, [10, 250, 128]);
    const copy = new Uint8ClampedArray(d);
    applyColor(d, DEFAULT_ADJUST);
    expect(d).toEqual(copy);
    applyColor(d, P({ exposure: 100, contrast: 100 }));
    for (let i = 0; i < d.length; i += 4) expect(d[i + 3]).toBe(255);
    expect(d[1]).toBe(255);
  });
});

describe("Adjust: sharpen and vignette", () => {
  it("an unsharp mask raises the contrast of an edge and leaves a flat area alone", () => {
    const w = 6;
    const h = 3;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = x < 3 ? 60 : 180;
        const o = (y * w + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = 255;
      }
    unsharpMask(d, w, h, 100);
    // Just left of the edge darker than 60, just right brighter than 180; the far columns are untouched.
    expect(d[(1 * w + 2) * 4]).toBeLessThan(60);
    expect(d[(1 * w + 3) * 4]).toBeGreaterThan(180);
    expect(d[(1 * w + 0) * 4]).toBe(60);
    expect(d[(1 * w + 5) * 4]).toBe(180);
    const same = flat(4, 4, [90, 90, 90]);
    unsharpMask(same, 4, 4, 100);
    expect(same.every((v, i) => (i % 4 === 3 ? v === 255 : v === 90))).toBe(true);
  });
  it("a vignette darkens the corners and leaves the centre", () => {
    const w = 21;
    const h = 21;
    const d = flat(w, h, [200, 200, 200]);
    vignette(d, w, h, 100);
    const centre = px(d, 10 * w + 10);
    const corner = px(d, 0);
    expect(centre).toEqual([200, 200, 200]);
    expect(corner[0]).toBeLessThan(200);
    expect(corner[0]).toBeGreaterThanOrEqual(0);
    expect(d[3]).toBe(255);
  });
  it("the whole pipeline at the defaults is the identity", () => {
    const d = flat(5, 5, [120, 60, 30]);
    const copy = new Uint8ClampedArray(d);
    applyPixels(d, 5, 5, DEFAULT_ADJUST);
    expect(d).toEqual(copy);
  });
});

describe("The marked area in words", () => {
  it("says where the box sits and how big it is", () => {
    expect(areaWords({ x: 0.6, y: 0.05, w: 0.3, h: 0.2 })).toBe("Change only the marked area (top right of the picture, about 30% wide and 20% tall); keep everything outside it exactly as it is.");
    expect(areaWords({ x: 0.3, y: 0.4, w: 0.4, h: 0.2 })).toMatch(/middle centre/);
  });
});
