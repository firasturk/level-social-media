import { describe, expect, it } from "vitest";
import { extraProductsIn, postProblems } from "@shared/qa";
import { withoutBags, type Post } from "@shared/posts";

const products = ["عش-البلبل-بالنوتيلا", "عش-البلبل-بالفستق", "كنافة-ناعمة-سوبر", "50 - Pistachio Burma & Ush Al-Bulbul - Pistachio Burma & Ush Al-Bulbul"];
const base: Post = { index: 3, type: "lifestyle", title: "T", brief: "A hand holds the product.", caption: "", hashtags: "", product: "عش-البلبل-بالنوتيلا", scene: "A hand holds the gift box against a wall." };
const ctx = { products, cast: [{ name: "Khalif", description: "a man in his thirties" }, { name: "Lina", description: "a woman" }], needsScene: true };

describe("post checks before any image is paid for", () => {
  it("passes a clean post", () => {
    expect(postProblems({ ...base, caption: "عش البلبل بالنوتيلا مع قهوة الصبح" }, { ...ctx, sellsDrinks: false })).toEqual([]);
  });

  it("finds a missing shot, bags, drinks and a man in a headscarf", () => {
    const pr = postProblems(
      { ...base, scene: "", brief: "Khalif in a headscarf carries the tray inside a paper bag next to a glass of juice.", people: ["Khalif"] },
      ctx,
    );
    const texts = pr.map((x) => x.text).join(" | ");
    expect(texts).toContain("has no shot yet");
    expect(pr.find((x) => x.text.includes("bag or a carrier"))?.fix).toBe("unbag");
    expect(texts).toContain("which the client does not sell");
    expect(texts).toContain("Khalif (a man)");
  });

  it("finds another product named in the caption, not its own sibling", () => {
    expect(extraProductsIn("كنافة ناعمة سوبر وعش البلبل بالنوتيلا", ["عش-البلبل-بالنوتيلا"], products)).toEqual(["كنافة-ناعمة-سوبر"]);
    expect(extraProductsIn("عش البلبل بالنوتيلا", ["عش-البلبل-بالنوتيلا"], products)).toEqual([]);
    const pr = postProblems({ ...base, caption: "جربوا كنافة ناعمة سوبر" }, ctx);
    expect(pr.some((x) => x.text.includes("كنافة-ناعمة-سوبر") && x.fix === "post")).toBe(true);
  });

  it("asks an offer for its contents", () => {
    const pr = postProblems({ ...base, type: "offer", offer: { products: [], price: "", details: "" } }, ctx);
    expect(pr.some((x) => x.text.includes("offer without"))).toBe(true);
  });

  it("takes the bag sentences out without touching the rest", () => {
    expect(withoutBags("A hand lifts the tray. She carries a paper bag out of the shop. Warm light; soft shadows.")).toBe("A hand lifts the tray. Warm light; soft shadows.");
  });
});
