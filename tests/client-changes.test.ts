import { describe, expect, it } from "vitest";
import { CLIENT_CHANGE_TOOLS, CLIENT_CHANGES_SCHEMA, clientChangesInstruction, parseClientChanges, parseSteps, plansRemake, type ClientAsk } from "@shared/client-changes";
import { parsePostReview, postReviewInstruction } from "@shared/qa";

const ask: ClientAsk = {
  index: 3,
  title: "Blueberry Mojito Travel",
  brief: "A Blueberry mojito cup on a black pedestrian sign, pulled like a suitcase.",
  scene: "Front-on shot of the sign.",
  product: "Blueberry mojito",
  headline: "وين ما تروح معك",
  caption: "رفيقك بكل مشوار",
  hashtags: "#موهيتو",
  note: "استخدموا سكينة",
};

describe("do client comments", () => {
  it("asks for each post with the client's words and the product photos", () => {
    const text = clientChangesInstruction({ client: "Abu Saleh", asks: [ask], products: [{ name: "Sakina avocado shake", note: "green shake" }] });
    expect(text).toContain('THE CLIENT ASKS: "استخدموا سكينة"');
    expect(text).toContain("- Sakina avocado shake: green shake");
    expect(text).toContain("Never invent a product that has no photo");
  });
  it("matches the named product to the real names and keeps the post's words when the answer is thin", () => {
    const out = parseClientChanges(
      { posts: [{ index: 3, product: "sakina avocado shake", brief: "A Sakina cup on the sign.", scene: "", headline: "", caption: "رفيقك 🥑", hashtags: "#سكينة", summary: "Sakina replaces the mojito." }] },
      [ask],
      ["Blueberry mojito", "Sakina avocado shake"],
    );
    expect(out).toHaveLength(1);
    expect(out[0].product).toBe("Sakina avocado shake");
    expect(out[0].headline).toBe("وين ما تروح معك");
    expect(out[0].scene).toBe("");
    expect(out[0].summary).toBe("Sakina replaces the mojito.");
  });
  it("skips posts the model did not answer", () => {
    expect(parseClientChanges({ posts: [{ index: 9 }] }, [ask], [])).toEqual([]);
  });
});

describe("a take that drifts from its idea", () => {
  const ctx = { products: 1, productNotes: [""], type: "lifestyle", people: [], idea: "A cup on a black pedestrian sign, pulled like a suitcase." } as Parameters<typeof postReviewInstruction>[0];
  it("is asked about and flagged", () => {
    expect(postReviewInstruction(ctx)).toContain("a main element that is missing or replaced");
    const flags = parsePostReview({ productSame: true, sizeRight: true, invented: "", text: "", bag: false, foreign: [], people: "", tile: "", aiLook: "", staging: "", idea: "The sign is missing; the cup stands alone on a table.", faces: [] }, ctx);
    expect(flags.map((f) => f.kind)).toEqual(["idea"]);
    expect(flags[0].text).toContain("Not like its idea");
  });
  it("is never flagged on a post without an idea", () => {
    const flags = parsePostReview({ productSame: true, sizeRight: true, invented: "", text: "", bag: false, foreign: [], people: "", tile: "", aiLook: "", staging: "", idea: "The sign is missing.", faces: [] }, { ...ctx, idea: undefined });
    expect(flags).toEqual([]);
  });
});

describe("the plan of a client's comment (25 Oct)", () => {
  it("tells the art director every tool, the carousel rule, and asks for steps", () => {
    const text = clientChangesInstruction({ client: "Habibah", asks: [ask], products: [] });
    for (const t of CLIENT_CHANGE_TOOLS) expect(text).toContain(`- ${t.id}: `);
    expect(text).toMatch(/A carousel request: keep the post as slide 1/);
    const items = (CLIENT_CHANGES_SCHEMA.properties.posts.items as { required: string[]; properties: { steps: { items: { properties: { tool: { enum: string[] } } } } } });
    expect(items.required).toContain("steps");
    expect(items.properties.steps.items.properties.tool.enum).toEqual(CLIENT_CHANGE_TOOLS.map((t) => t.id));
  });
  it("keeps only the studio's own tools, in order, at most eight", () => {
    expect(parseSteps([{ tool: "rewrite", what: "  new   caption " }, { tool: "photoshop", what: "x" }, { tool: "carousel-camera", what: "from above, closer" }, "junk"])).toEqual([
      { tool: "rewrite", what: "new caption" },
      { tool: "carousel-camera", what: "from above, closer" },
    ]);
    expect(parseSteps(Array.from({ length: 12 }, () => ({ tool: "retouch", what: "" })))).toHaveLength(8);
    expect(parseSteps("rewrite")).toEqual([]);
  });
  it("offers a new picture only when the plan makes one (or has no plan at all)", () => {
    expect(plansRemake({ steps: [{ tool: "rewrite", what: "" }, { tool: "carousel-variations", what: "" }] })).toBe(false);
    expect(plansRemake({ steps: [{ tool: "rewrite", what: "" }, { tool: "remake", what: "" }] })).toBe(true);
    expect(plansRemake({})).toBe(true);
  });
  it("carries the steps through the parse", () => {
    const out = parseClientChanges({ posts: [{ index: 3, brief: "b", caption: "c", hashtags: "#h", summary: "s", steps: [{ tool: "carousel-generate", what: "an ingredients slide" }] }] }, [ask], []);
    expect(out[0].steps).toEqual([{ tool: "carousel-generate", what: "an ingredients slide" }]);
  });
  it("names where each team step is and what it costs", () => {
    for (const t of CLIENT_CHANGE_TOOLS) {
      expect(t.where.length).toBeGreaterThan(5);
      expect(t.cost.length).toBeGreaterThan(3);
      if ("carousel" in t && t.carousel) expect(t.where).toMatch(/Add as a carousel$/);
    }
  });
});
