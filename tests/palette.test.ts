import { describe, expect, it } from "vitest";
import { paletteRule, parsePalette } from "@shared/posts";

describe("theme palette", () => {
  it("keeps valid 6-digit hex colours once, lowercased, at most 8", () => {
    const out = parsePalette([
      { name: "Dusty rose", hex: "#E8B4B8" },
      { name: "dup", hex: "#e8b4b8" },
      { name: "bad", hex: "pink" },
      { name: "short", hex: "#fff" },
      { name: "Navy", hex: "#002a5c" },
    ]);
    expect(out).toEqual([
      { name: "Dusty rose", hex: "#e8b4b8" },
      { name: "Navy", hex: "#002a5c" },
    ]);
    expect(parsePalette(Array.from({ length: 12 }, (_, i) => ({ name: "c", hex: `#00000${i.toString(16)}` })))).toHaveLength(8);
    expect(parsePalette("nope")).toEqual([]);
  });
  it("tells the engine that chosen colours override the reference", () => {
    expect(paletteRule(["Navy #002a5c"], true)).toMatch(/replace the colours of the style reference/);
    expect(paletteRule(["Navy #002a5c"])).toMatch(/^PALETTE:/);
    expect(paletteRule([], true)).toBe("");
  });
});
