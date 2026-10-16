import { describe, expect, it } from "vitest";
import { adaptStyleInstruction, describeStyleInstruction, parseStyle } from "@shared/styles";
import { buildPostPrompt, type PostBrief } from "@shared/posts";

describe("style gallery", () => {
  it("reads a pin into a style for any product", () => {
    const ins = describeStyleInstruction("Frambini ice cream, raspberries in ice cubes");
    expect(ins).toContain("the product's own key ingredients");
    expect(ins).toContain("Frambini");
    const fresh = describeStyleInstruction("", { title: "Frozen in ice cubes", prompt: "The product lies among ice cubes." });
    expect(fresh).toContain("FRESH variation");
    const s = parseStyle({ keep: true, kind: "people", title: '"Held to the sun"', tags: "sun, hands", prompt: "x".repeat(80) });
    expect(s).toMatchObject({ keep: true, kind: "people", title: "Held to the sun" });
    expect(parseStyle({ keep: true, kind: "product", title: "Too short", tags: "", prompt: "short" }).keep).toBe(false);
    expect(parseStyle({ keep: false, title: "A", prompt: "y".repeat(80) }).keep).toBe(false);
  });

  it("writes a style for the real product, its ingredients and colours", () => {
    const ins = adaptStyleInstruction({
      style: { title: "Frozen in ice cubes", kind: "product", prompt: "The product lies among ice cubes with the product's own key ingredients frozen inside." },
      product: "a round navy tin of pistachio kunafa nests",
      category: "Tin",
      post: { type: "Lifestyle", headline: "برد الصيف", brief: "The tin on ice." },
      brand: { name: "Habibah", never: "no alcohol" },
      palette: ["Royal blue #1f4fa0", "Cream #f3eadb"],
      people: [],
    });
    expect(ins).toContain("pistachio kunafa nests");
    expect(ins).toContain("raspberries frozen in ice become pistachios frozen in ice");
    expect(ins).toContain("The background is Royal blue #1f4fa0");
    expect(ins).toContain("nobody appears");
    expect(ins).toContain("NEVER a drink");
  });

  it("attaches the style's picture as the style reference", () => {
    const b: PostBrief = {
      post: true, index: 1, type: "lifestyle", title: "T", brief: "B", palette: [], style: "", theme: "", format: "4:5",
      ref: null, refIsSource: false, hasProduct: true, styleKey: "styles/x.jpg",
    };
    expect(buildPostPrompt(b)).toContain("Image 2 is a style reference");
  });
});
