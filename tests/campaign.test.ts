import { describe, expect, it } from "vitest";
import { briefPlanInstruction, parseBriefPlan } from "../shared/campaign";

describe("a campaign brief becomes posts", () => {
  it("numbers the slides after the month's posts, groups a carousel, keeps the text on design and the exact flag", () => {
    let n = 0;
    const r = parseBriefPlan(
      {
        summary: "A 3-slide carousel.",
        posts: [
          { type: "lifestyle", group: "carousel", slide: 1, of: 3, role: "teaser", title: "Teaser", headline: "مكس مش عادي أبداً!", subline: "", brief: "The cup half hidden in dramatic red light.", product: "Spicy hot chocolate cup", products: [], ingredients: "", exact: false, reference: 1, caption: "Something new is brewing.", hashtags: "#AbuSaleh" },
          { type: "lifestyle", group: "carousel", slide: 2, of: 3, role: "ingredients", title: "Ingredients", headline: "درينك الموسم… بطريقة جديدة!", subline: "", brief: "Close-up of red chili and cocoa.", product: "", products: [], ingredients: "red chili, dark chocolate", exact: false, reference: 1, caption: "Chili meets chocolate.", hashtags: "#AbuSaleh" },
          { type: "lifestyle", group: "carousel", slide: 3, of: 3, role: "reveal", title: "Reveal", headline: "سبايسي هوت تشوكلت", subline: "", brief: "The full cup on the dark table.", product: "Spicy hot chocolate cup", products: [], ingredients: "", exact: true, reference: 1, caption: "Here it is.", hashtags: "#AbuSaleh" },
        ],
      },
      ["Spicy hot chocolate cup", "Karak"],
      13,
      () => `g${++n}`,
    );
    expect(r.posts.map((p) => p.post.index)).toEqual([13, 14, 15]);
    expect(r.posts.map((p) => p.post.group?.id)).toEqual(["g1", "g1", "g1"]);
    expect(r.posts[0].post.headline).toBe("مكس مش عادي أبداً!");
    expect(r.posts[1].post.product).toBeUndefined();
    expect(r.posts[1].post.ingredients).toBe("red chili, dark chocolate");
    expect(r.posts[2].post.exact).toBe(true);
    expect(r.posts[2].post.product).toBe("Spicy hot chocolate cup");
    expect(r.posts.every((p) => p.reference === 1)).toBe(true);
  });
  it("tells the planner the groups, the exact rule and the text on design", () => {
    const t = briefPlanInstruction({ client: "Abu Saleh", brief: "Carousel of 3 for the new cup.", month: "2026-11", products: [{ name: "Cup", note: "a paper cup" }], references: 2, brand: {}, language: "ar", existing: 12 });
    expect(t).toContain('"carousel"');
    expect(t).toContain("copy it EXACTLY");
    expect(t).toContain("set exact: true");
    expect(t).toContain("already has 12 posts");
  });
});
