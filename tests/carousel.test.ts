import { describe, expect, it } from "vitest";
import { carouselEntries, carouselStatus, withSlide } from "@shared/carousel";

type P = { index: number; title: string; date?: string; group?: { id: string; kind: "carousel" | "series"; slide: number; of: number } };
const g = (id: string, slide: number, of: number, kind: "carousel" | "series" = "carousel") => ({ id, kind, slide, of });
const plan: P[] = [
  { index: 1, title: "Single" },
  { index: 2, title: "C · 2", group: g("c", 2, 3) },
  { index: 3, title: "C · 1", group: g("c", 1, 3) },
  { index: 4, title: "Series 1", group: g("s", 1, 2, "series") },
  { index: 5, title: "C · 3", group: g("c", 3, 3) },
  { index: 6, title: "Series 2", group: g("s", 2, 2, "series") },
];

describe("a carousel as one card (27 Oct)", () => {
  it("shows each carousel once, where its first slide stood, its slides in order; series parts stay cards of their own", () => {
    const cards = carouselEntries(plan);
    expect(cards.map((c) => c.post.index)).toEqual([1, 3, 4, 6]);
    expect(cards[1].slides?.map((s) => s.index)).toEqual([3, 2, 5]);
    expect(cards[0].slides).toBeUndefined();
    expect(cards[2].slides).toBeUndefined();
  });
  it("shows the slide chosen, or slide 1 when the choice is gone", () => {
    expect(carouselEntries(plan, { c: 3 })[1].post.index).toBe(5);
    expect(carouselEntries(plan, { c: 9 })[1].post.index).toBe(3);
  });
  it("adds a slide after a carousel's last, and turns a single post into slide 1 of a new carousel", () => {
    const make = (index: number, lead: P): P => ({ index, title: `${lead.title} +`, date: lead.date });
    const more = withSlide(plan, 2, make, () => "new")!;
    expect(more.index).toBe(7);
    expect(more.plan.filter((p) => p.group?.id === "c").map((p) => [p.index, p.group!.slide, p.group!.of])).toEqual([
      [2, 2, 4],
      [3, 1, 4],
      [5, 3, 4],
      [7, 4, 4],
    ]);
    const single = withSlide(plan, 1, make, () => "fresh")!;
    expect(single.plan.find((p) => p.index === 1)!.group).toEqual({ id: "fresh", kind: "carousel", slide: 1, of: 2 });
    expect(single.plan.find((p) => p.index === 7)!.group).toEqual({ id: "fresh", kind: "carousel", slide: 2, of: 2 });
  });
  it("refuses a series part and an eleventh slide", () => {
    const make = (index: number): P => ({ index, title: "x" });
    expect(withSlide(plan, 4, make, () => "x")).toBeNull();
    const ten: P[] = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, title: `s${i}`, group: g("full", i + 1, 10) }));
    expect(withSlide(ten, 1, make, () => "x")).toBeNull();
  });
  it("answers for the whole carousel on the client's link", () => {
    expect(carouselStatus(["approved", "approved"])).toBe("approved");
    expect(carouselStatus(["approved", null])).toBeNull();
    expect(carouselStatus(["approved", "changes"])).toBe("changes");
    expect(carouselStatus([])).toBeNull();
  });
});
