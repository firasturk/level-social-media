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
