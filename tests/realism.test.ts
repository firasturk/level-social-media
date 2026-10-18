import { describe, expect, it } from "vitest";
import { fixNote, parsePostReview, postReviewInstruction } from "@shared/qa";
import { REAL_PEOPLE_RULE, realRefLine } from "@shared/realism";

describe("real people", () => {
  it("asks the review whether the people look AI-made only when there are people", () => {
    const withPeople = postReviewInstruction({ products: 1, productNotes: ["a tin"], type: "lifestyle", people: [{ name: "Lina", description: "young woman" }] });
    expect(withPeople).toMatch(/aiLook: when the picture shows a person/);
    const nobody = postReviewInstruction({ products: 1, productNotes: ["a tin"], type: "product", people: [] });
    expect(nobody).toContain('aiLook: "".');
  });

  it("flags an AI look and asks for a photographed person", () => {
    const flags = parsePostReview({ productSame: true, sizeRight: true, invented: "", text: "", bag: false, foreign: [], people: "", tile: "", aiLook: "waxy airbrushed skin" }, { products: 1 });
    expect(flags).toEqual([{ kind: "ailook", text: "Looks AI-made: waxy airbrushed skin" }]);
    expect(fixNote(flags)).toMatch(/real skin with pores/);
    expect(parsePostReview({ aiLook: "none" }, { products: 0 })).toEqual([]);
  });

  it("keeps the real photo for realism only", () => {
    expect(realRefLine(3)).toMatch(/^Image 3 is a real photograph/);
    expect(realRefLine(3)).toMatch(/never its person, face, clothes/);
    expect(REAL_PEOPLE_RULE).toMatch(/motivated by a real source/);
  });
});
