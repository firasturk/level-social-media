import { describe, expect, it } from "vitest";
import { extraProductsIn, postProblems, renameProduct } from "@shared/qa";
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
    // A product the month has a photo of joins the picture instead of a rewrite.
    expect(pr.find((x) => x.text.includes("كنافة-ناعمة-سوبر"))).toMatchObject({ fix: "include", products: ["كنافة-ناعمة-سوبر"] });
    // An offer keeps exactly its products: it is written again.
    const offer = postProblems({ ...base, type: "offer", offer: { products: ["عش-البلبل-بالنوتيلا"], price: "5", details: "box" }, caption: "جربوا كنافة ناعمة سوبر" }, ctx);
    expect(offer.find((x) => x.text.includes("كنافة-ناعمة-سوبر"))?.fix).toBe("post");
  });

  it("asks an offer for its contents", () => {
    const pr = postProblems({ ...base, type: "offer", offer: { products: [], price: "", details: "" } }, ctx);
    expect(pr.some((x) => x.text.includes("offer without"))).toBe(true);
  });

  it("takes the bag sentences out without touching the rest", () => {
    expect(withoutBags("A hand lifts the tray. She carries a paper bag out of the shop. Warm light; soft shadows.")).toBe("A hand lifts the tray. Warm light; soft shadows.");
  });

  it("changes the old product's name to the new one, however it was written", () => {
    expect(renameProduct("جربوا كنافة ناعمة سوبر اليوم", "كنافة-ناعمة-سوبر", "Pistachio Kunafa Piece")).toBe("جربوا Pistachio Kunafa Piece اليوم");
    expect(renameProduct("A tray of D22A1943 copy on stone.", "D22A1943 copy", "Sesame cookies")).toBe("A tray of Sesame cookies on stone.");
    expect(renameProduct("Nothing here", "", "x")).toBe("Nothing here");
  });
});
