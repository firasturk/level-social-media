import { describe, expect, it } from "vitest";
import { foreignItemIn } from "../shared/brief";
import { parsePostReview, postProblems } from "../shared/qa";
import type { Post } from "../shared/posts";

const post = (scene: string, brief = "A tray of baklava on marble."): Post =>
  ({ index: 1, type: "product", title: "t", brief, caption: "", hashtags: "", product: "baklava tray", scene }) as Post;
const ctx = { products: ["baklava tray"], cast: [], sellsDrinks: false, needsScene: true, hasPlaces: true };

describe("foreign items", () => {
  it("names a drink the shot puts in the picture", () => {
    expect(foreignItemIn("A tray of baklava beside a glass of tea.")).toBe("glass");
    expect(foreignItemIn("Two coffee cups frame the box.")).toBe("coffee");
  });

  it("ignores an item the shot rules out", () => {
    expect(foreignItemIn("The tray stands alone, without any additional liquids.")).toBe("");
    expect(foreignItemIn("No glass, no cup, just the box on the marble.")).toBe("");
    expect(foreignItemIn("Instead of a coffee, a folded napkin sits beside it.")).toBe("");
    // The negation belongs to its own clause: the glass after the comma is in the picture.
    expect(foreignItemIn("No cutlery, a glass of water at the back.")).toBe("glass");
  });

  it("stops blocking a post whose shot says 'without liquids'", () => {
    const flagged = postProblems(post("A tray on marble beside a glass of tea."), ctx);
    expect(flagged.some((p) => /shows "glass"/.test(p.text))).toBe(true);
    const clean = postProblems(post("A tray on marble, without any additional liquids."), ctx);
    expect(clean.some((p) => /shows "/.test(p.text))).toBe(false);
  });

  it("keeps only drinks, vessels and food from the reviewer's foreign list", () => {
    const flags = parsePostReview({ productSame: true, sizeRight: true, invented: "", text: "", bag: false, foreign: ["a silver fork", "a glass of juice", "a napkin"], people: "", tile: "" }, { products: true, sellsDrinks: false, coffeeDay: false, tile: "", idea: "", brand: undefined } as never);
    const foreign = flags.find((f) => f.kind === "foreign");
    expect(foreign?.text).toBe("Shows what the brand does not sell: a glass of juice");
    const none = parsePostReview({ productSame: true, sizeRight: true, invented: "", text: "", bag: false, foreign: ["a silver fork"], people: "", tile: "" }, { products: true, sellsDrinks: false, coffeeDay: false, tile: "", idea: "", brand: undefined } as never);
    expect(none.some((f) => f.kind === "foreign")).toBe(false);
  });
});
