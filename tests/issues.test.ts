import { describe, expect, it } from "vitest";
import { blocking, monthIssues } from "../shared/issues";
import type { Post } from "../shared/posts";

const post = (p: Partial<Post> = {}): Post => ({ index: 1, type: "product", title: "t", brief: "b", caption: "", hashtags: "", ...p });
const client = { logo: true, tone: "warm", colors: [{ hex: "#000000" }], service: "" };
const theme = { references: 3, shots: ["a"], analysed: 10, latestRef: 5, palette: [{ hex: "#111111" }] };

describe("what stands before Generate", () => {
  it("blocks on what the pictures cannot do without, warns about the rest", () => {
    const issues = monthIssues({
      config: { plan: [post({ product: "Mango smoothie" }), post({ index: 2, product: "Strawberry mojito" }), post({ index: 3, type: "offer", offer: { products: [], price: "", contents: "" } as never })], postCount: 3, month: "2026-10" },
      client: { ...client, logo: false },
      theme,
      products: ["Mango smoothie"],
      cast: [{ name: "Lina", gender: "", image: false }],
    });
    expect(blocking(issues).map((x) => x.code).sort()).toEqual(["gender", "offer", "portrait-missing", "product-missing"]);
    expect(issues.find((x) => x.code === "product-missing")?.post).toBe(2);
    expect(issues.filter((x) => x.warn).map((x) => x.code)).toContain("logo");
  });

  it("asks for ideas, a read theme and products, and nothing when the month is complete", () => {
    expect(blocking(monthIssues({ config: { plan: [], postCount: 12, month: "2026-10" }, client, theme: { ...theme, analysed: 1 }, products: [], cast: [] })).map((x) => x.code)).toEqual(["products", "pins-unread", "ideas"]);
    expect(blocking(monthIssues({ config: { plan: [post({ product: "Mango" })], postCount: 1, month: "2026-10" }, client, theme, products: ["Mango"], cast: [] }))).toEqual([]);
    expect(monthIssues({ config: null, client: null, theme: null, products: [], cast: [] })[0].code).toBe("client");
  });
});
