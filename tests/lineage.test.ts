import { describe, expect, it } from "vitest";
import { lineageUnknown, olderIdea, planShape, postRevision, wordsOnlyNote, type Post } from "../shared/posts";

const post = (p: Partial<Post> = {}): Post => ({ index: 1, type: "product", title: "t", brief: "b", caption: "", hashtags: "", ...p });

describe("a picture's lineage", () => {
  it("reads the post's revision from its own stamps and the month's, never from the task's timestamp", () => {
    expect(postRevision(post(), { plannedAt: 100 })).toBe(100);
    expect(postRevision(post({ ideaAt: 150 }), { plannedAt: 100 })).toBe(150);
    expect(postRevision(post({ reference: { key: "k", thumb: "", at: 170 } }), { plannedAt: 100 })).toBe(170);
    expect(postRevision(post({ clientNote: { note: "n", at: 180 } }), { plannedAt: 100 })).toBe(180);
    expect(postRevision(post({ tile: "Tile 1" }), { plannedAt: 100, gridAt: 190 })).toBe(190);
    expect(postRevision(post(), { plannedAt: 100, gridAt: 190 })).toBe(100);
  });

  it("calls a picture an older idea only when its recorded revision is behind, and never a legacy one", () => {
    const cfg = { plannedAt: 100 };
    expect(olderIdea({ output: "o", made_for: 100 }, post(), cfg)).toBe(false);
    expect(olderIdea({ output: "o", made_for: 100 }, post({ ideaAt: 120 }), cfg)).toBe(true);
    expect(olderIdea({ output: "o", made_for: null }, post({ ideaAt: 120 }), cfg)).toBe(false);
    expect(olderIdea({ output: null, made_for: 50 }, post(), cfg)).toBe(false);
    expect(lineageUnknown({ output: "o", made_for: null })).toBe(true);
    expect(lineageUnknown({ output: "o", made_for: 100 })).toBe(false);
    expect(lineageUnknown({ output: null, made_for: null })).toBe(false);
  });

  it("keeps a picture current when the client's comment was answered with words alone", () => {
    const cfg = { plannedAt: 100 };
    const words = { clientNote: { note: "new caption", at: 300 }, clientSteps: { at: 300, steps: [{ tool: "rewrite", what: "caption" }, { tool: "words", what: "headline" }] } };
    // New months: the idea keeps its stamp, the comment is no revision.
    expect(postRevision(post({ ideaAt: 150, ...words }), cfg)).toBe(150);
    expect(olderIdea({ output: "o", made_for: 150 }, post({ ideaAt: 150, ...words }), cfg)).toBe(false);
    // Months applied before the rule stamped the idea with the comment's instant: still current.
    expect(olderIdea({ output: "o", made_for: 120 }, post({ ideaAt: 300, ...words }), cfg)).toBe(false);
    // A plan that makes the picture again, a plan with no steps, or an idea edited later: older.
    const remake = { clientNote: { note: "other product", at: 300 }, clientSteps: { at: 300, steps: [{ tool: "rewrite", what: "x" }, { tool: "remake", what: "new" }] } };
    expect(olderIdea({ output: "o", made_for: 120 }, post({ ideaAt: 300, ...remake }), cfg)).toBe(true);
    expect(olderIdea({ output: "o", made_for: 120 }, post({ clientNote: { note: "n", at: 300 } }), cfg)).toBe(true);
    expect(olderIdea({ output: "o", made_for: 120 }, post({ ideaAt: 400, ...words }), cfg)).toBe(true);
    expect(wordsOnlyNote(post(words))).toBe(true);
    expect(wordsOnlyNote(post(remake))).toBe(false);
    expect(wordsOnlyNote(post({ clientNote: { note: "n", at: 300 }, clientSteps: { at: 200, steps: [{ tool: "rewrite", what: "x" }] } }))).toBe(false);
  });

  it("counts posts, slides, designs, pictures and text tiles apart", () => {
    const plan: Post[] = [
      ...Array.from({ length: 10 }, (_, i) => post({ index: i + 1 })),
      post({ index: 11, tileSpec: { kind: "text", background: "#fff" } as never }),
      ...Array.from({ length: 5 }, (_, i) => post({ index: 12 + i, group: { id: "g", kind: "carousel", slide: i + 1, of: 5 } })),
    ];
    expect(planShape(plan)).toBe("12 posts, one a 5-slide carousel: 16 designs, 15 pictures to make and 1 text tile drawn here.");
    expect(planShape([post()])).toBe("1 post: 1 design, 1 picture to make.");
    expect(planShape([])).toBe("");
  });
});
