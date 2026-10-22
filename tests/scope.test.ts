import { describe, expect, it } from "vitest";
import { confirmScope, effectLine, scopeCount, scopeLabel, scopeNote } from "../shared/scope";

describe("the scope of an action, said the same way everywhere", () => {
  it("names the post, the slide, the selection or the month", () => {
    expect(scopeLabel({ kind: "post", index: 3, title: "Mango" })).toBe("post 3 “Mango”");
    expect(scopeLabel({ kind: "slide", index: 4, slide: 2, of: 5 })).toBe("slide 2 of 5 of post 4");
    expect(scopeLabel({ kind: "selection", indexes: [2, 5, 7] })).toBe("posts 2, 5 and 7");
    expect(scopeLabel({ kind: "selection", indexes: [2] })).toBe("post 2");
    expect(scopeLabel({ kind: "month", month: "2026-10", designs: 16 })).toBe("October 2026, 16 designs");
    expect(scopeCount({ kind: "month", month: "2026-10", designs: 16 })).toBe(16);
  });
  it("one post from a style is one post's scope, never the month's summary", () => {
    const one = confirmScope({ target: { kind: "post", index: 3 }, effect: "new-version", cost: 0.13, untouched: "the month's other 11 posts" });
    expect(one.message).toBe("Make another version of post 3's picture? Creates another version of its picture; the current one stays under Versions. About $0.13 (list price, an estimate). The month's other 11 posts untouched.");
    expect(one.ok).toBe("Make post 3 · about $0.13");
    expect(one.message).not.toMatch(/all|month's 12|designs/);
    const first = confirmScope({ target: { kind: "post", index: 3 }, effect: "first-image", cost: 0.13 });
    expect(first.message).toMatch(/^Make post 3's picture\? Makes its first picture\./);
    expect(scopeNote({ kind: "post", index: 3 }, 12)).toBe("Only post 3 changes; the month's other 11 posts are untouched.");
  });
  it("the month's action says all of it, with the count on the button", () => {
    const all = confirmScope({ target: { kind: "month", month: "2026-10", designs: 12 }, effect: "first-image", cost: 1.56 });
    expect(all.message).toBe("Make every picture of October 2026 (12 designs)? Makes their first pictures. About $1.56 (list price, an estimate).");
    expect(all.ok).toBe("Make all 12 · about $1.56");
    const again = confirmScope({ target: { kind: "month", month: "2026-10", designs: 12 }, effect: "new-version" });
    expect(again.message).toBe("Make another version of every picture of October 2026 (12 designs)? Creates another version of each picture; the current ones stay under Versions.");
    expect(confirmScope({ target: { kind: "month", month: "2026-10", designs: 12 }, effect: "plan" }).message).toMatch(/^Change the plan of October 2026 \(12 designs\)\? Changes the plan only/);
    expect(scopeNote({ kind: "month", month: "2026-10", designs: 12 })).toBe("The whole month: 12 designs.");
  });
  it("a plan change says no picture is made; an edit says the picture before stays", () => {
    const plan = confirmScope({ target: { kind: "selection", indexes: [2, 5] }, effect: "plan", cost: 9 });
    expect(plan.message).toBe("Change posts 2 and 5? Changes the plan only: their idea, shot or words. No picture is made and nothing is paid.");
    expect(plan.ok).toBe("Change 2");
    expect(effectLine("edit-image", { kind: "post", index: 1 })).toMatch(/stays under Versions/);
    const edit = confirmScope({ target: { kind: "slide", index: 4, slide: 2, of: 5 }, effect: "edit-image", cost: 0.2 });
    expect(edit.ok).toBe("Edit slide 2 · about $0.20");
  });
});
