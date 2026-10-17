import { describe, expect, it } from "vitest";
import { blendFor, composite, type Raster } from "../server/compose";

const solid = (w: number, h: number, rgb: [number, number, number], a = 255): Raster => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, a], i * 4);
  return { data, width: w, height: h };
};

describe("an exact product blends in without being redrawn", () => {
  it("tones it toward a warm, darker scene within its caps", () => {
    const scene = solid(200, 200, [200, 150, 100]);
    const product = solid(40, 40, [200, 200, 200]);
    const b = blendFor(scene, product, { x: 80, y: 80 }, "left");
    for (const g of b.gain) {
      expect(g).toBeGreaterThan(0.8);
      expect(g).toBeLessThan(1.15);
    }
    expect(b.gain[0]).toBeGreaterThan(b.gain[2]);
    expect(b.shade(1, 0.5)).toBeGreaterThan(b.shade(0, 0.5));
  });
  it("keeps the product's own pixels in its middle", () => {
    const scene = solid(200, 200, [120, 120, 120]);
    const product = solid(60, 60, [10, 200, 30]);
    const out = composite(scene, product, { x: 70, y: 70 }, "front");
    const i = (100 * 200 + 100) * 4;
    expect(Math.abs(out.data[i] - 10)).toBeLessThan(8);
    expect(Math.abs(out.data[i + 1] - 200)).toBeLessThan(24);
    expect(Math.abs(out.data[i + 2] - 30)).toBeLessThan(8);
  });
});
