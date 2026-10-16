import { describe, expect, it } from "vitest";
import { buildPostPrompt, parseIdeas, type PostBrief } from "@shared/posts";

const base: PostBrief = {
  post: true,
  index: 1,
  type: "lifestyle",
  title: "t",
  brief: "b",
  palette: [],
  style: "",
  theme: "",
  format: "4:5",
  ref: "r1",
  refIsSource: false,
  hasProduct: true,
};

describe("brand ambassadors", () => {
  it("numbers products, then portraits, then the style reference", () => {
    const text = buildPostPrompt({
      ...base,
      extraProducts: [{ name: "Mango", key: "k2" }],
      ambassadors: [
        { name: "Omar", description: "man in his thirties", key: "a1" },
        { name: "Lina", description: "", key: "a2" },
      ],
    });
    expect(text).toContain("Images 1 to 2 are product photos");
    expect(text).toContain("Images 3 to 4 are portraits of the brand's ambassadors");
    expect(text).toContain("Image 3: Omar (man in his thirties).");
    expect(text).toContain("Image 5 is a style reference");
  });
  it("puts a single portrait after a lone product, and the reference after it", () => {
    const text = buildPostPrompt({ ...base, ambassadors: [{ name: "Omar", description: "", key: "a1" }] });
    expect(text).toContain("Image 2 is the portrait of the brand's ambassador");
    expect(text).toContain("Image 3 is a style reference");
  });
  it("keeps only cast names, matched without case, at most three", () => {
    const plan = parseIdeas(
      JSON.stringify({
        posts: [{ type: "lifestyle", title: "x", brief: "b", caption: "c", hashtags: "#a", product: "", people: ["omar", "Ghost", "LINA", "Omar"] }],
      }),
      12,
      [],
      ["Omar", "Lina"],
    );
    expect(plan[0].people).toEqual(["Omar", "Lina"]);
  });
});
