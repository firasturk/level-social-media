import { describe, expect, it } from "vitest";
import { readableOn } from "@shared/contrast";
import { postProblems } from "@shared/qa";
import type { Post } from "@shared/posts";

describe("words that read on their picture", () => {
  it("keeps a colour that reads and swaps one that vanishes", () => {
    expect(readableOn("#ffffff", 0.05)).toBe("#ffffff");
    expect(readableOn("#ffffff", 0.75)).toBe("#1f1a17");
    expect(readableOn("#002a5c", 0.02)).toBe("#ffffff");
    expect(readableOn("#4e0c15", 0.7)).toBe("#4e0c15");
  });
});

describe("a person holds a product", () => {
  it("flags a person tile with nothing in hand", () => {
    const p = { index: 5, type: "lifestyle", title: "", brief: "Lina by a stone wall.", caption: "", hashtags: [], scene: "Lina by a stone wall.", tileSpec: { kind: "person", items: "", background: "", text: { position: "none", align: "center" } } } as unknown as Post;
    expect(postProblems(p, { products: [], cast: [], needsScene: true }).find((x) => x.fix === "product")).toBeTruthy();
    expect(postProblems({ ...p, product: "Alhajj Mahmoud 700G" }, { products: ["Alhajj Mahmoud 700G"], cast: [], needsScene: true }).find((x) => x.fix === "product")).toBeFalsy();
  });
});
