import { describe, expect, it } from "vitest";
import { gridSummary } from "../shared/posts";

describe("what a read grid holds, for the picker", () => {
  it("counts the tiles by kind and reads the layout from the positions", () => {
    const s = gridSummary({
      world: "Street signs under noon sun.",
      tiles: [
        { position: "row 1, col 1", scene: "", productPlacement: "", textPlacement: "", kind: "product" },
        { position: "row 1, col 2", scene: "", productPlacement: "", textPlacement: "", kind: "text" },
        { position: "row 1, col 3", scene: "", productPlacement: "", textPlacement: "", kind: "product" },
        { position: "row 2, col 1", scene: "", productPlacement: "", textPlacement: "", kind: "person" },
        { position: "row 2, col 2", scene: "", productPlacement: "", textPlacement: "" },
      ],
    });
    expect(s.read).toBe(true);
    expect(s.tiles).toBe(5);
    expect(s.layout).toBe("2 rows × 3 columns");
    expect(s.textTiles).toBe(1);
    expect(s.kinds).toEqual([
      { kind: "product", n: 2 },
      { kind: "text", n: 1 },
      { kind: "person", n: 1 },
      { kind: "picture", n: 1 },
    ]);
    expect(s.world).toBe("Street signs under noon sun.");
  });
  it("says so when the grid was never read", () => {
    expect(gridSummary(null)).toEqual({ read: false, tiles: 0, kinds: [], textTiles: 0, layout: "", world: "" });
  });
});
