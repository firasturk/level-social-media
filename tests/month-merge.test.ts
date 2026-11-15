import { describe, expect, it } from "vitest";
import { mergeKeys, mergeMonth, mergePlan, sameJson, samePost } from "../shared/month-merge";

const post = (index: number, extra: Record<string, unknown> = {}) => ({ index, title: `Post ${index}`, brief: `idea ${index}`, caption: "", headline: "", ...extra });

describe("a month saved by two writers at once", () => {
  it("compares values whatever the key order", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
  });

  it("keeps a caption written meanwhile when the page saves a headline on the same post", () => {
    const base = [post(1), post(2)];
    const mine = [post(1, { headline: "New headline" }), post(2)];
    const theirs = [post(1, { caption: "Written by the studio" }), post(2)];
    expect(mergePlan(base, mine, theirs)).toEqual([post(1, { headline: "New headline", caption: "Written by the studio" }), post(2)]);
  });

  it("lets the later save win one field only when both changed that field", () => {
    const merged = mergePlan([post(1)], [post(1, { headline: "Mine" })], [post(1, { headline: "Theirs", caption: "Kept" })]);
    expect(merged).toEqual([post(1, { headline: "Mine", caption: "Kept" })]);
  });

  it("keeps a post someone else added, and a removal made on purpose", () => {
    const base = [post(1), post(2), post(3)];
    // The writer removed post 2; meanwhile someone added post 4 and edited post 3.
    const mine = [post(1), post(3)];
    const theirs = [post(1), post(2), post(3, { caption: "edited" }), post(4)];
    expect(mergePlan(base, mine, theirs)).toEqual([post(1), post(3, { caption: "edited" }), post(4)]);
  });

  it("respects a removal by someone else, unless the writer changed that post meanwhile", () => {
    const base = [post(1), post(2)];
    expect(mergePlan(base, [post(1), post(2)], [post(1)])).toEqual([post(1)]);
    expect(mergePlan(base, [post(1), post(2, { headline: "Worked on" })], [post(1)])).toEqual([post(1), post(2, { headline: "Worked on" })]);
  });

  it("keeps the writer's order and its own new posts", () => {
    const base = [post(1), post(2)];
    const mine = [post(2), post(1), post(5)];
    expect(mergePlan(base, mine, [post(1), post(2), post(4)]).map((p) => p.index)).toEqual([2, 1, 5, 4]);
  });

  it("merges the whole month: a long engine pass keeps the client's answer and a setting changed meanwhile", () => {
    const base = { size: "2K", notes: "", plan: [post(1), post(2)], approvals: {} as Record<string, unknown> };
    // The engine pass rewrote the idea of post 2 from its minutes-old copy.
    const mine = { ...base, plan: [post(1), post(2, { brief: "a better idea" })] };
    // Meanwhile: the client approved post 1, the designer edited post 1's caption and changed the size.
    const theirs = { size: "4K", notes: "", plan: [post(1, { caption: "hand-written" }), post(2)], approvals: { "1": { status: "approved" } } };
    expect(mergeMonth(base, mine, theirs)).toEqual({ size: "4K", notes: "", plan: [post(1, { caption: "hand-written" }), post(2, { brief: "a better idea" })], approvals: { "1": { status: "approved" } } });
  });

  it("merges two answers of the client on different posts, and removes a key the writer removed", () => {
    const base = { approvals: { "1": { status: "changes" } }, shots: "old" } as Record<string, unknown>;
    const mine = { approvals: { "1": { status: "changes" }, "2": { status: "approved" } } } as Record<string, unknown>;
    const theirs = { approvals: { "1": { status: "approved" } }, shots: "old" } as Record<string, unknown>;
    expect(mergeMonth(base, mine, theirs)).toEqual({ approvals: { "1": { status: "approved" }, "2": { status: "approved" } } });
    expect(mergeKeys({ a: 1, b: 2 }, { a: 1 } as { a: number; b?: number }, { a: 5, b: 2 })).toEqual({ a: 5 });
  });

  it("writes the writer's copy as it is when nobody else wrote", () => {
    const base = { plan: [post(1)], size: "2K" };
    const mine = { plan: [post(1, { headline: "x" })], size: "1K" };
    expect(mergeMonth(base, mine, base)).toEqual(mine);
  });

  it("tells the same post from whatever holds its number now", () => {
    expect(samePost({ title: "A", brief: "x", ideaAt: 1 }, { title: "A", brief: "y", ideaAt: 2 })).toBe(true);
    expect(samePost({ title: "A", brief: "x", ideaAt: 1 }, { title: "B", brief: "y", ideaAt: 2 })).toBe(false);
    expect(samePost({ title: "", brief: "" }, { title: "", brief: "" })).toBe(false);
  });
});
