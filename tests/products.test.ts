import { describe, expect, it } from "vitest";
import { matchProduct, parseIdeas, productKeyOf } from "@shared/posts";

const products = ["Chocolate Muffin ", "Hot chocolate ", "Spicy hot chocolate ", "Lotus milkshake_", "اينشتاين ", "mango"];

describe("product matching", () => {
  it("ignores case, extension, underscores and stray spaces", () => {
    expect(productKeyOf("Lotus milkshake_.png")).toBe("lotus milkshake");
    expect(matchProduct("lotus milkshake", products)).toBe("Lotus milkshake_");
    expect(matchProduct("Chocolate Muffin", products)).toBe("Chocolate Muffin ");
    expect(matchProduct("اينشتاين", products)).toBe("اينشتاين ");
  });
  it("prefers the longest product named inside a longer text", () => {
    expect(matchProduct("Spicy Hot Chocolate Pyramid", products)).toBe("Spicy hot chocolate ");
    expect(matchProduct("Hot Chocolate Crafting", products)).toBe("Hot chocolate ");
    expect(matchProduct("Full Frame Mango Texture", products)).toBe("mango");
  });
  it("matches nothing for empty or unrelated names", () => {
    expect(matchProduct("", products)).toBeUndefined();
    expect(matchProduct("Sahlab", products)).toBeUndefined();
  });
  it("falls back to the title when the product field is empty", () => {
    const plan = parseIdeas(
      JSON.stringify({
        posts: [
          { type: "product", title: "Chocolate Muffin Promo Stage", brief: "A muffin.", caption: "c", hashtags: "#a", product: "" },
          { type: "tip", title: "Morning light", brief: "Nothing named.", caption: "c", hashtags: "#a", product: "" },
        ],
      }),
      12,
      products,
    );
    expect(plan[0].product).toBe("Chocolate Muffin ");
    expect(plan[1].product).toBeUndefined();
  });
});
