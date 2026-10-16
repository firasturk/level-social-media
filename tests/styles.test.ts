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
    const s = parseStyle({ keep: true, score: 9, kind: "people", title: '"Cloud Swing"', tags: "sky, swing", prompt: "x".repeat(80) });
    expect(s).toMatchObject({ keep: true, score: 9, kind: "people", title: "Cloud Swing" });
    expect(parseStyle({ keep: true, score: 7, kind: "product", title: "Nice concept", tags: "", prompt: "z".repeat(80) }).keep).toBe(false);
    expect(parseStyle({ keep: true, score: 9, kind: "product", title: "Too short", tags: "", prompt: "short" }).keep).toBe(false);
    // Below the team's bar (8): a plain packshot or a merely nice concept stays out of the gallery.
    expect(parseStyle({ keep: true, score: 5, kind: "product", title: "Plain packshot", tags: "", prompt: "y".repeat(80) }).keep).toBe(false);
    expect(ins).toContain("THE BAR");
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
      post: true, index: 1, type: "lifestyle", title: "T", brief: "B", palette: [], style: "", format: "4:5",
      ref: null, refIsSource: false, hasProduct: true, styleKey: "styles/x.jpg", shot: "A hand dips a pistachio over the open tin.",
      theme: "Autumn road trip", props: "autumn leaves", library: "Warm roadside light",
    };
    const p = buildPostPrompt(b);
    expect(p).toContain("Image 2 is the style the designer picked");
    expect(p).toContain("THE PHOTOGRAPH (the picked style");
    expect(p).toContain("A hand dips a pistachio");
    expect(p).not.toContain("autumn leaves");
    expect(p).not.toContain("Warm roadside light");
    expect(p).not.toContain("REFERENCE SHOT");
  });
});
