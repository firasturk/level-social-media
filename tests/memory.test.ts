import { describe, expect, it } from "vitest";
import { earlierLines, overlap, seenBefore } from "@shared/memory";

const earlier = [
  { label: "October 2026 · post 4", title: "Mango Juice Roundabout", brief: "A fresh mango juice cup is centered on a blue circular roundabout sign with three white arrows. Amman street under a clear sky." },
  { label: "September 2026 · post 1", title: "Grandmother's kitchen", brief: "A grandmother pours tea for her grandchildren in a sunlit kitchen, the box of sweets open on the table." },
];

describe("campaign memory", () => {
  it("marks an idea that repeats an earlier month", () => {
    expect(seenBefore({ title: "Mango roundabout sign", brief: "The mango juice cup stands centred on a blue circular roundabout sign with white arrows, Amman street behind." }, earlier)).toBe("October 2026 · post 4");
  });
  it("lets a new idea through", () => {
    expect(seenBefore({ title: "Kiwi mojito by the pool", brief: "A kiwi mojito on the edge of a rooftop pool at sunset, a hand reaching for it." }, earlier)).toBeUndefined();
  });
  it("measures overlap between 0 and 1 and lists the earlier posts for the planner", () => {
    expect(overlap("a b c", "")).toBe(0);
    expect(overlap("mango juice roundabout sign", "mango juice roundabout sign")).toBe(1);
    expect(earlierLines(earlier)[0]).toContain("October 2026 · post 4: Mango Juice Roundabout — A fresh mango juice cup");
  });
});
