import { describe, expect, it } from "vitest";
import {
  buildPostPrompt,
  colourLabel,
  colourName,
  matchProduct,
  photoRules,
  withoutProductNames,
  type PostBrief,
} from "@shared/posts";

const PRODUCTS = [
  "30 - Mini Tart - Mini Tart",
  "50 - Pistachio Burma &#038; Ush Al-Bulbul - Pistachio Burma &#038; Ush Al-Bulbul",
  "عش-البلبل-بالنوتيلا",
];

describe("colour names come from the hex", () => {
  it("names the picked colour, not a stale label", () => {
    expect(colourName("#0042aa")).toBe("deep blue");
    expect(colourName("#3a88fe")).toContain("blue");
    expect(colourName("#f5e6d3")).toBe("cream");
    expect(colourName("#c5a381")).toBe("tan");
    expect(colourName("#8b0000")).toContain("red");
    expect(colourName("#ffffff")).toBe("white");
    expect(colourLabel("#0042AA")).toBe("deep blue #0042aa");
  });
});

describe("product matching", () => {
  it("reads HTML entities in file names", () => {
    expect(matchProduct("50 - Pistachio Burma & Ush Al-Bulbul", PRODUCTS)).toBe(PRODUCTS[1]);
    expect(matchProduct("Pistachio Burma tin", PRODUCTS)).toBe(PRODUCTS[1]);
  });
});

describe("file names never reach the image prompt", () => {
  it("replaces product names in the brief", () => {
    const out = withoutProductNames(
      "A circular tin of '50 - Pistachio Burma & Ush Al-Bulbul' beside the '30 - Mini Tart' box and عش البلبل بالنوتيلا.",
      PRODUCTS.map((p) => p.replace(/&#038;/g, "&")),
    );
    expect(out).not.toMatch(/Pistachio|Mini Tart|البلبل/);
    expect(out).toContain("the product");
  });

  it("keeps layout rules out of the photo and names colours from the hex", () => {
    const b: PostBrief = {
      post: true,
      index: 1,
      type: "testimonial",
      title: "عش-البلبل-بالنوتيلا moment",
      brief: "Hands hold a plate of 'عش-البلبل-بالنوتيلا'.",
      palette: [colourLabel("#0042aa")],
      paletteChosen: true,
      style: "",
      theme: "Goal: warm posts. The palette is dominated by deep crimson.",
      library: "## Light\n- hard sun\n\n## Palette\n- Deep Crimson for textiles\n\n## Mood\n- cozy",
      always: "Deep navy ground with the silver square-Kufic band as the only ornament\nOne Habibah logo per piece, centred at the top\nSweets shown fresh and generous",
      never: "No gold in the palette\nNo gradients outside the logo",
      format: "4:5",
      hasProduct: true,
      product: "عش-البلبل-بالنوتيلا — Shredded pastry nests with chocolate.",
      productNames: PRODUCTS,
    } as PostBrief;
    const p = buildPostPrompt(b);
    expect(p).not.toContain("البلبل");
    expect(p).not.toMatch(/Kufic|centred at the top|crimson/i);
    expect(p).toContain("Sweets shown fresh and generous");
    expect(p).toContain("deep blue #0042aa");
    expect(p).toContain("Shredded pastry nests with chocolate.");
    expect(p).toContain("## Mood");
    expect(p).not.toContain("SAFE WORDING");
    expect(photoRules("The AlBandar Group mark small and white in the bottom-left corner")).toBe("");
  });
});
