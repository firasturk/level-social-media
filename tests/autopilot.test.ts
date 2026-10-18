import { describe, expect, it } from "vitest";
import { gridPickInstruction, parseGridPick, type GridCandidate } from "@shared/autopilot";

const grids: GridCandidate[] = [
  { id: "a", title: "Cobalt Street Sport", tags: "blue, urban, fashion", about: "Cobalt blue streetwear.", tiles: 12, forClient: false },
  { id: "b", title: "Pistachio Cream Sweets", tags: "cream, green, dessert", about: "Warm cream tones with desserts.", tiles: 9, forClient: true },
];

describe("Autopilot's grid", () => {
  it("asks for the grid that fits the brand's world and what it can fill", () => {
    const text = gridPickInstruction({ client: "Habibah", profile: "Who: a sweets house in Amman", brand: "tone: warm", products: ["Kunafa tray"], places: "its shop (13)", count: 9, grids });
    expect(text).toContain("2. \"Pistachio Cream Sweets\" (suggested for this brand by its Analysis), 9 tiles");
    expect(text).toMatch(/never a fashion or wellness one/);
    expect(text).toContain("its shop (13)");
    expect(gridPickInstruction({ client: "X", profile: "", brand: "", products: [], places: "", count: 6, grids })).toMatch(/no photos of its own shop/);
  });

  it("keeps only a grid it was shown", () => {
    expect(parseGridPick({ grid: 2, reason: "Desserts in cream." }, grids)).toEqual({ grid: grids[1], reason: "Desserts in cream.", others: [] });
    // Other choices: known grids only, never the first one twice.
    expect(parseGridPick({ grid: 2, reason: "a", others: [{ grid: 2, reason: "x" }, { grid: 1, reason: "Street." }, { grid: 9, reason: "?" }] }, grids)?.others).toEqual([{ grid: grids[0], reason: "Street." }]);
    expect(gridPickInstruction({ client: "H", profile: "", brand: "", products: [], places: "", count: 9, grids, choices: 3 })).toMatch(/next 2 best grids/);
    expect(parseGridPick({ grid: 7 }, grids)).toBeNull();
    expect(parseGridPick(null, grids)).toBeNull();
  });
});
