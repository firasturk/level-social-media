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
  it("keeps a product off an ingredients slide even when the planner names one", () => {
    const r = parseBriefPlan(
      { summary: "", posts: [{ type: "product", group: "carousel", slide: 2, of: 3, role: "ingredients", title: "Ingredients", headline: "x", subline: "", brief: "Chili over chocolate.", product: "Cup", products: ["Cup"], ingredients: "red chili, liquid chocolate", exact: false, reference: 2, caption: "c", hashtags: "#a" }] },
      ["Cup"],
      1,
      () => "g",
    );
    expect(r.posts[0].post.product).toBeUndefined();
    expect(r.posts[0].post.products).toBeUndefined();
    expect(r.posts[0].post.ingredients).toBe("red chili, liquid chocolate");
  });
  it("tells the planner the groups, the exact rule and the text on design", () => {
    const t = briefPlanInstruction({ client: "Abu Saleh", brief: "Carousel of 3 for the new cup.", month: "2026-11", products: [{ name: "Cup", note: "a paper cup" }], references: 2, brand: {}, language: "ar", existing: 12 });
    expect(t).toContain('"carousel"');
    expect(t).toContain("copy it EXACTLY");
    expect(t).toContain("set exact: true");
    expect(t).toContain("already has 12 posts");
  });
});

import { buildPostPrompt, type PostBrief } from "../shared/posts";
import { preflightInstruction, postReviewInstruction } from "../shared/qa";
import { adaptStyleInstruction } from "../shared/styles";

const base: PostBrief = {
  post: true,
  index: 1,
  type: "product",
  title: "Cup Teaser",
  brief: "The cup among chilies on dark wood.",
  palette: ["pale yellow #f5f3d3", "amber #fdbd11"],
  paletteChosen: true,
  style: "Pop-art studio shots on saturated backgrounds.",
  theme: "",
  format: "4:5",
  ref: null,
  styleKey: "styles/ref.jpg",
  refIsSource: false,
  hasProduct: true,
  product: "A teal paper cup of hot chocolate with a chili on the rim.",
  shot: "An overhead flat lay of the cup on dark wood surrounded by whole red chilies and splashes of liquid chocolate.",
};

describe("a campaign brief wins over the month", () => {
  it("keeps the reference's colours and ingredients, and drops the month's palette and client look", () => {
    const p = buildPostPrompt({ ...base, campaign: { ingredients: "red chili pepper, liquid chocolate" } });
    expect(p).toContain("reference picture the designer attached to the campaign brief");
    expect(p).not.toContain("ITS COLOURS ARE NOT COPIED");
    expect(p).not.toContain("chosen by the designer for this month");
    expect(p).not.toContain("BACKGROUND: the backdrop");
    expect(p).not.toContain("CLIENT LOOK");
    expect(p).toContain("THE BRIEF'S INGREDIENTS");
    expect(p).toContain("red chili pepper, liquid chocolate");
    expect(p).not.toContain("other food or drinks, ");
    // An ordinary styled post still takes the month's palette.
    const q = buildPostPrompt(base);
    expect(q).toContain("ITS COLOURS ARE NOT COPIED");
    expect(q).toContain("CLIENT LOOK");
  });
  it("tells the preflight and the review that the brief's reference and ingredients stay", () => {
    const pf = preflightInstruction({ client: "Abu Saleh", scene: "chilies around the cup", products: ["a cup"], people: [], reference: "style", lessons: [], campaign: { ingredients: "red chili" } });
    expect(pf).toContain("dropReference is always false");
    expect(pf).toContain("never foreign");
    const rv = postReviewInstruction({ products: 1, productNotes: ["a cup"], type: "product", people: [], allowedFood: "red chili, liquid chocolate" });
    expect(rv).toContain("brief's own ingredients");
  });
  it("makes the style writer follow the brief and keep the reference's look", () => {
    const t = adaptStyleInstruction({
      style: { title: "Ingredient Rain", kind: "product", prompt: "Flat lay on dark wood with ingredients scattered." },
      product: "",
      post: { type: "Product", headline: "x", brief: "No cup is visible: only chili over chocolate." },
      brand: { name: "Abu Saleh" },
      palette: [],
      people: [],
      reference: true,
    });
    expect(t).toContain("THE DESIGNER'S BRIEF FOR THIS PICTURE");
    expect(t).toContain("DESIGNER'S OWN REFERENCE PICTURE");
    expect(t).not.toContain("REPLACES THE EARLIER ONE");
  });
  it("attaches the designer's reference for a take and says what to take from it", () => {
    const p = buildPostPrompt({ ...base, editRef: { key: "styles/x.jpg", note: "the low camera angle and the warm light" } }, "FRESH TAKE: Use the attached reference: the low camera angle", { reference: true });
    expect(p).toContain("reference picture the designer attached for this take");
    expect(p).toContain("the low camera angle and the warm light");
    expect(p).toContain("NEW TAKE: the designer asks for this post again with the attached reference");
    // Without the image attached, the paragraph is not written.
    expect(buildPostPrompt({ ...base, editRef: { key: "styles/x.jpg" } })).not.toContain("attached for this take");
  });
});

import { briefMonth } from "../shared/campaign";

describe("a month stays its brief's posts by its stamps", () => {
  it("is the brief's while nothing wrote the ideas again, whatever the posts' groups", () => {
    expect(briefMonth({ campaign: { at: 100, only: true }, plannedAt: 100 })).toBe(true);
    expect(briefMonth({ campaign: { at: 100, only: true }, plannedAt: 90 })).toBe(true);
    expect(briefMonth({ campaign: { at: 100, only: true }, plannedAt: 101 })).toBe(false);
    expect(briefMonth({ campaign: { at: 100 }, plannedAt: 100 })).toBe(false);
    expect(briefMonth(null)).toBe(false);
  });
  it("plans a separator as a plain post with no product", () => {
    const r = parseBriefPlan(
      { summary: "", posts: [{ type: "quote", group: "single", slide: 1, of: 1, role: "separator", title: "Separator", headline: "أبو صالح", subline: "", brief: "A plain teal backdrop.", product: "Cup", products: [], ingredients: "", exact: false, reference: 0, caption: "c", hashtags: "#a" }] },
      ["Cup"],
      4,
      () => "g",
    );
    expect(r.posts[0].post.product).toBeUndefined();
    expect(r.posts[0].post.type).toBe("quote");
    expect(r.posts[0].reference).toBe(0);
    expect(briefPlanInstruction({ client: "x", brief: "b", month: "2026-11", products: [], references: 0, brand: {}, language: "ar", existing: 0 })).toContain('role "separator"');
  });
});

describe("quote posts and references keep the brand's truth", () => {
  it("gives a quote without a product a texture backdrop of the brand's foods, never a flat colour", () => {
    const p = buildPostPrompt({ ...base, type: "quote", styleKey: undefined, hasProduct: false, product: undefined, shot: undefined, brandFoods: "a mango drink; a strawberry slushie" });
    expect(p).toContain("TEXTURE BACKDROP");
    expect(p).toContain("a mango drink; a strawberry slushie");
    expect(p).toContain("never a plain flat colour");
  });
  it("keeps the product's own container shape next to a brief reference", () => {
    const p = buildPostPrompt({ ...base, campaign: {} });
    expect(p).toContain("THE REFERENCE'S CONTAINER IS NOT THIS PRODUCT");
    expect(buildPostPrompt(base)).not.toContain("THE REFERENCE'S CONTAINER");
  });
  it("keeps a product post's own ingredients from the planner", () => {
    const r = parseBriefPlan(
      { summary: "", posts: [{ type: "product", group: "carousel", slide: 1, of: 2, role: "teaser", title: "T", headline: "h", subline: "", brief: "Mango cup on mangoes.", product: "Cup", products: [], ingredients: "mango pieces, whole mangoes", exact: false, reference: 1, caption: "c", hashtags: "#a" }] },
      ["Cup"],
      1,
      () => "g",
    );
    expect(r.posts[0].post.ingredients).toBe("mango pieces, whole mangoes");
    expect(r.posts[0].post.product).toBe("Cup");
    expect(briefPlanInstruction({ client: "x", brief: "b", month: "2026-11", products: [], references: 1, brand: {}, language: "ar", existing: 0 })).toContain("INGREDIENTS AROUND THE PRODUCT");
  });
});
