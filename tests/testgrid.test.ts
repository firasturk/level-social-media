import { describe, expect, it } from "vitest";
import { testGridLayout, testGridPrompt } from "@shared/testgrid";
import type { Post } from "@shared/posts";

const post = (index: number, extra: Partial<Post> = {}): Post =>
  ({ index, type: "product", title: `Post ${index}`, brief: `Idea ${index}`, caption: "", hashtags: [], headline: `عنوان ${index}`, ...extra }) as Post;

describe("test grid", () => {
  it("puts the newest post first, three across, at most twelve", () => {
    const l = testGridLayout(Array.from({ length: 14 }, (_, i) => post(i + 1)));
    expect(l.order).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(l.rows).toBe(4);
    expect(l.aspectRatio).toBe("9:16");
    expect(testGridLayout(Array.from({ length: 9 }, (_, i) => post(i + 1))).aspectRatio).toBe("4:5");
  });

  it("follows the grid's tiles when the month has them", () => {
    const plan = [post(1, { tile: "Tile 3 (top right): x" }), post(2, { tile: "Tile 1 (top left): y" }), post(3, { tile: "Tile 2 (top middle): z" })];
    expect(testGridLayout(plan).order).toEqual([2, 3, 1]);
  });

  it("describes every cell in order and asks for no words", () => {
    const plan = [post(1, { scene: "A kunafa tray on navy stone.", product: "كنافة" }), post(2, { tileSpec: { kind: "text", items: "", background: "cream #f3e9dc", text: { position: "center", align: "center", size: "large", color: "#002a5c" } } as Post["tileSpec"] })];
    const layout = testGridLayout(plan);
    const text = testGridPrompt({ client: "Habibah", layout, plan, palette: ["navy #002a5c"], products: ["كنافة"], reference: true });
    expect(text).toContain("Cell 1 (row 1, column 1), text tile");
    expect(text).toContain("A plain background: cream #f3e9dc");
    expect(text).toContain("Cell 2 (row 1, column 2), product: A kunafa tray on navy stone. Product: كنافة (exactly as in Image 1).");
    expect(text).toContain("Image 2 is the feed the brand wants to look like");
    expect(text).toMatch(/NO words, letters/);
  });
});

describe("grid colours", () => {
  it("asks for the colour story of the grid, not of the pins", async () => {
    const { gridPaletteInstruction } = await import("@shared/posts");
    const text = gridPaletteInstruction();
    expect(text).toContain("Instagram feed grid");
    expect(text).toContain("the grid's colour story");
    expect(text).not.toContain("references' colour story");
  });
});

describe("no invented shop", () => {
  it("flags a shop interior when the client has no photos of its shop", async () => {
    const { postProblems } = await import("@shared/qa");
    const shop = post(3, { type: "behind", scene: "A candid interior shot of the branch with a dark blue arched wall and a marble counter." } as Partial<Post>);
    const ctx = { products: [], cast: [], needsScene: true };
    expect(postProblems(shop, { ...ctx, hasPlaces: false }).find((x) => x.fix === "noplace")).toBeTruthy();
    expect(postProblems(shop, { ...ctx, hasPlaces: true }).find((x) => x.fix === "noplace")).toBeFalsy();
    const tray = post(4, { scene: "A tray of kunafa on a marble surface." });
    expect(postProblems(tray, { ...ctx, hasPlaces: false }).find((x) => x.fix === "noplace")).toBeFalsy();
  });
});

describe("no invented words on cards", () => {
  it("takes business cards, tags and menus out, and flags them", async () => {
    const { withoutLettering } = await import("@shared/posts");
    const { postProblems } = await import("@shared/qa");
    expect(withoutLettering("The tray sits on a cream paper surface next to a very dark blue and silver business card. Soft light.")).toBe("The tray sits on a cream paper surface. Soft light.");
    expect(withoutLettering("A price tag on the counter. Warm light.")).toBe("Warm light.");
    const p = post(1, { scene: "A tray next to a business card." });
    expect(postProblems(p, { products: [], cast: [], needsScene: true }).find((x) => x.fix === "blank")).toBeTruthy();
    expect(postProblems({ ...p, scene: withoutLettering(p.scene!) }, { products: [], cast: [], needsScene: true }).find((x) => x.fix === "blank")).toBeFalsy();
  });
});

describe("no logos asked for in the picture", () => {
  it("takes the logo and brand mark sentences out of a shot", async () => {
    const { withoutLettering } = await import("@shared/posts");
    expect(withoutLettering("A flat-lay on tan marble. The Habibah logo is centered at the top. The AlBandar mark is in the bottom-left. Warm light.")).toBe("A flat-lay on tan marble. Warm light.");
    expect(withoutLettering("A navy SUV on the blue floor. The car's grille is plain, with no badge or logo. Hard light.")).toBe("A navy SUV on the blue floor. The car's grille is plain, with no badge or logo. Hard light.");
    expect(withoutLettering("A busy shopping street at dusk. She marks the date on a calendar.")).toBe("A busy shopping street at dusk. She marks the date on a calendar.");
    expect(withoutLettering("A marble tray on a market stall.")).toBe("A marble tray on a market stall.");
  });
});

describe("the reference grid's bags and logos never reach the engine", () => {
  it("cleans the tile and the grid reading", async () => {
    const { tileWithoutBags, gridWithoutBags } = await import("@shared/posts");
    const tile = "Tile 5 (row 2, col 2): A person holding a large brand shopping bag. Product: bag held at waist level Items: shopping bag, person in modest clothing";
    expect(tileWithoutBags(tile, true)).toContain("A person holding the product.");
    expect(tileWithoutBags(tile, false)).not.toMatch(/bag/i);
    const grid = "A warm studio world. The brand logo sits on every box.\nTile 4 (row 2, col 1, text): A nut and a ribbon.\nTile 5 (row 2, col 2, person): A person holding a large brand shopping bag.\nTile 7 (row 3, col 1, place): Items: display case, arched wall, logo";
    expect(gridWithoutBags(grid)).toBe("A warm studio world.\nTile 4 (row 2, col 1, text): A nut and a ribbon.");
  });

  it("takes the card out of a grid tile", async () => {
    const { tileWithoutBags } = await import("@shared/posts");
    expect(tileWithoutBags("Tile 9 (row 3, col 3): A product container and a branded card on a textured surface. Items: dessert cup, card, crumbs", true)).toBe(
      "Tile 9 (row 3, col 3): A product container on a textured surface. Items: dessert cup, crumbs",
    );
  });
});

describe("a post's own tile", () => {
  const notes = "World.\nTile 1 (row 1, col 1, food): A pastry.\nTile 5 (row 2, col 2, person): A person holding a large brand shopping bag.\nTile 6 (row 2, col 3, detail): A stack on a stone.\nTile 7 (row 3, col 1, place): A shop.\nTile 9 (row 3, col 3, product): A container and a branded card.";
  it("finds where the tile sits and which tiles are copied closely", async () => {
    const { tileCell, cleanGrid } = await import("@shared/testgrid");
    expect(tileCell("Tile 6 (row 2, col 3): A stack on a stone.", notes, [])).toEqual({ row: 2, col: 3, rows: 3, cols: 3 });
    expect(tileCell("Tile 7 (row 3, col 1): A shop.", notes, [])).toBeNull();
    expect(tileCell("Tile 5 (row 2, col 2): A person.", notes, [])).toBeNull();
    expect(tileCell("Tile 9 (row 3, col 3): A container and a branded card.", notes, [])).toBeNull();
    expect(tileCell("Tile 5 (row 2, col 2): A person.", notes, [], true)).toEqual({ row: 2, col: 2, rows: 3, cols: 3 });
    expect(cleanGrid(736, 981, 3, 3)).toBe(true);
    expect(cleanGrid(1170, 2532, 3, 3)).toBe(false);
  });
});
