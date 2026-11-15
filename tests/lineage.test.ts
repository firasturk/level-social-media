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

describe("automatic retakes", () => {
  it("never retakes a picture by itself for a judgment call: the idea, the brand's look, staging", async () => {
    const { selfFixable } = await import("../server/engine");
    const flag = (kind: string) => ({ kind, text: `${kind} finding` });
    const qa = (kinds: string[]) => ({ automated: true, found: true, count: 1, box: [], productConcern: false, notes: "", flags: kinds.map(flag) });
    expect(selfFixable(qa(["idea", "brand", "staging", "tile", "ailook"]) as never)).toEqual([]);
    expect(selfFixable(qa(["idea", "product", "text"]) as never).map((f) => f.kind)).toEqual(["product", "text"]);
  });

  it("has no paid retake for a drifted idea left in the engine", async () => {
    const { readFileSync } = await import("node:fs");
    const engine = readFileSync(new URL("../server/engine.ts", import.meta.url), "utf8");
    expect(engine).not.toContain("retry from original reference queued");
  });
});

describe("the client's rules for the photograph", () => {
  it("keeps the photo part of a line that also names layout items", async () => {
    const { photoRules } = await import("../shared/posts");
    const abuSaleh = ["No gradients, frames, stickers or shadows", "No icons or emoji; the only marks are the logo and the hand-drawn curl arrows", "Never recolour, crop, split or redraw the three-tile logo", "No type in mango or strawberry colours", "No formal Arabic, no prices on artwork"].join("\n");
    expect(photoRules(abuSaleh).split("\n")).toEqual(["No gradients, frames or shadows", "No type in mango or strawberry colours", "No prices on artwork"]);
  });

  it("still leaves out a line that is only about the layout, and never bends a rule's meaning", async () => {
    const { photoRules } = await import("../shared/posts");
    expect(photoRules("Logo always top centre\nNever redraw the logo\nNo emoji")).toBe("");
    // The closing words belong to every item: the line is dropped whole, as before, not cut to "No people".
    expect(photoRules("No people or logos in the background")).toBe("");
    expect(photoRules("Warm morning light\nNo plastic cups")).toBe("Warm morning light\nNo plastic cups");
    // A clause that speaks of the logo just left out goes with it; a rule of its own after it stays.
    expect(photoRules("Never redraw the logo; when it appears in the world it is the exact lens-and-bar shape")).toBe("");
    expect(photoRules("Never redraw the logo; no plastic cups")).toBe("No plastic cups");
    expect(photoRules("Warm light; soft shade under the cup")).toBe("Warm light; soft shade under the cup");
  });
});
