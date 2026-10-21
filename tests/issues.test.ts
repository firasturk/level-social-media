import { describe, expect, it } from "vitest";
import { blocking, monthIssues, sceneContext } from "../shared/issues";
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
    const unread = monthIssues({ config: { plan: [], postCount: 12, month: "2026-10" }, client, theme: { ...theme, analysed: 1 }, products: [], cast: [] });
    expect(blocking(unread).map((x) => x.code)).toEqual(["products", "ideas"]);
    // Unread pins never stop Generate; they are a note with "Analyse the pins" as the fix.
    expect(unread.find((x) => x.code === "pins-unread")?.warn).toBe(true);
    expect(blocking(monthIssues({ config: { plan: [post({ product: "Mango" })], postCount: 1, month: "2026-10" }, client, theme, products: ["Mango"], cast: [] }))).toEqual([]);
    expect(monthIssues({ config: null, client: null, theme: null, products: [], cast: [] })[0].code).toBe("client");
  });

  it("adds each post's own problems once the scene context is given, the same for every screen", () => {
    const config = { plan: [post({ product: "Mango", brief: "A mango smoothie in a paper bag", scene: "" }), post({ index: 2, type: "offer", offer: { products: [], price: "", contents: "" } as never })], postCount: 2, month: "2026-10", theme: "t" };
    const scene = sceneContext({ config, theme, products: [{ note: "a mango", category: "fruit" }], client: { places: [], drivePlaces: 0 } });
    expect(scene).toEqual({ needsScene: true, sellsDrinks: false, hasPlaces: false });
    const without = monthIssues({ config, client, theme, products: ["Mango"], cast: [] });
    expect(without.filter((x) => x.code.startsWith("post-"))).toEqual([]);
    const issues = monthIssues({ config, client, theme, products: ["Mango"], cast: [], scene });
    const own = issues.filter((x) => x.code.startsWith("post-"));
    // The missing shot, the bag and the drink of post 1; post 2's empty offer is the "offer" issue alone.
    expect(own.map((x) => x.code)).toEqual(["post-shot", "post-unbag", "post-post", "post-shot"]);
    expect(own.every((x) => x.problem && x.post)).toBe(true);
    // The gate takes these out before paying: notes with a fix, never what stops Generate (the offer does).
    expect(own.every((x) => x.warn && x.how)).toBe(true);
    expect(blocking(issues).map((x) => x.code)).toEqual(["offer"]);
    expect(issues.filter((x) => x.code === "offer")).toHaveLength(1);
    // A brand that sells drinks keeps its smoothie.
    const drinks = sceneContext({ config, theme, products: [{ note: "a mango smoothie in a cup", category: "drink" }], client: null });
    expect(drinks.sellsDrinks).toBe(true);
    expect(monthIssues({ config, client, theme, products: ["Mango"], cast: [], scene: drinks }).filter((x) => x.code === "post-post")).toEqual([]);
  });
});
