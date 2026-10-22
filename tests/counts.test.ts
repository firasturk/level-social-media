import { describe, expect, it } from "vitest";
import { countsLine, monthCounts, picturesLine, shapeLine, taskForPost } from "../shared/counts";
import type { Post } from "../shared/posts";

const post = (p: Partial<Post> = {}): Post => ({ index: 1, type: "product", title: "t", brief: "b", caption: "", hashtags: "", ...p });
const task = (post: number, t: { status?: string; output?: string | null; made_for?: number | null } = {}) => ({ post, status: t.status ?? "done", output: t.output === undefined ? "k" : t.output, made_for: t.made_for === undefined ? 5 : t.made_for });

describe("the month in numbers, counted one way for every board", () => {
  const plan = [
    post({ index: 1, product: "Mango", ideaAt: 5 }),
    post({ index: 2, product: "Lime", ideaAt: 5 }),
    post({ index: 3, ideaAt: 5, group: { id: "c", kind: "carousel", slide: 1, of: 2 } }),
    post({ index: 4, ideaAt: 5, group: { id: "c", kind: "carousel", slide: 2, of: 2 } }),
    post({ index: 5, ideaAt: 5, tileSpec: { kind: "text" } as never }),
    post({ index: 6, ideaAt: 9 }),
  ];
  it("a carousel counts once as a post, once per slide as a design; a text tile is never a picture", () => {
    const c = monthCounts(plan, [], null);
    expect([c.posts, c.designs, c.tiles, c.pictures]).toEqual([5, 6, 1, 5]);
    expect(c.carousels).toEqual([{ kind: "carousel", slides: 2 }]);
    expect(c.planned).toBe(6);
    // The tile is planned but not a picture to generate.
    expect(c.remaining).toBe(5);
    expect(c.remainingPosts).toEqual([1, 2, 3, 4, 6]);
    expect(shapeLine(c)).toBe("5 posts, one a 2-slide carousel = 6 designs");
    expect(picturesLine(c)).toBe("5 pictures · 5 remaining · 1 text tile drawn here, free");
  });
  it("existing, remaining and older-idea pictures add up across the states", () => {
    const tasks = [
      task(1), // made, nothing to check
      task(2), // made, flagged by the review
      task(3, { status: "processing", output: null }), // making
      task(4, { status: "failed", output: null }), // failed
      task(6, { made_for: 5 }), // made for an older idea (ideaAt 9)
    ];
    const c = monthCounts(plan, tasks, null, (t) => (t.post === 2 ? 1 : 0));
    expect(c.made).toBe(1);
    expect(c.look).toBe(1);
    expect(c.making).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.older).toBe(1);
    expect(c.olderPosts).toEqual([6]);
    expect(c.existing).toBe(3);
    // Still to generate: the failed one, the older idea and the untouched tile is not counted.
    expect(c.remaining).toBe(2);
    expect(c.remainingPosts).toEqual([4, 6]);
    expect(c.planned).toBe(1);
    expect(countsLine(c)).toBe("5 posts · 6 designs · 1 made · 1 making · 1 needs a look · 1 older idea · 1 failed · 2 remaining");
    expect(picturesLine(c)).toBe("5 pictures · 3 made · 1 making · 2 remaining · 1 text tile drawn here, free");
  });
  it("a running task stands for its post before a failed one does", () => {
    const tasks = [task(1, { status: "failed", output: null }), task(1, { status: "queued", output: null })];
    expect(taskForPost(tasks, 1)?.status).toBe("queued");
    expect(monthCounts([post({ index: 1 })], tasks, null).making).toBe(1);
  });
  it("the plan's revision makes a picture an older idea", () => {
    const c = monthCounts([post({ index: 1, ideaAt: 1 })], [task(1, { made_for: 1 })], { plannedAt: 7 });
    expect(c.older).toBe(1);
    expect(c.remaining).toBe(1);
  });
});
