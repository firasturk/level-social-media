import { describe, expect, it } from "vitest";
import { clientChangesInstruction, parseClientChanges, type ClientAsk } from "@shared/client-changes";
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
