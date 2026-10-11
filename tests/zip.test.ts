import { describe, expect, it } from "vitest";
import { splitIntoParts, zipOverhead } from "../shared/zip-parts";

const item = (name: string, size = 1000) => ({ name, size });

describe("multi-part ZIP export", () => {
  it("splits at product-folder boundaries once a part would pass the limit", () => {
    const items = ["A/1.jpg", "A/2.jpg", "B/1.jpg", "B/2.jpg", "C/1.jpg", "C/2.jpg"].map((n) =>
      item(n),
    );
    const folder = 2 * (1000 + zipOverhead("A/1.jpg"));
    expect(splitIntoParts(items, folder + 10)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(splitIntoParts(items, 2 * folder + 10)).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
    expect(splitIntoParts(items, 1_400_000_000)).toEqual([[0, 1, 2, 3, 4, 5]]);
  });

  it("splits a folder bigger than a part file by file, and never returns no parts", () => {
    const items = ["A/1.jpg", "A/2.jpg", "A/3.jpg"].map((n) => item(n));
    expect(splitIntoParts(items, 1000 + zipOverhead("A/1.jpg") + 1)).toEqual([[0], [1], [2]]);
    expect(splitIntoParts([], 10)).toEqual([[]]);
  });
});
