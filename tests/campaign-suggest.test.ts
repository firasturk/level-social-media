/** "Suggest a campaign": what the text model is told, and how its answer becomes setups. */
import { describe, expect, it } from "vitest";
import { demoSuggestions, suggestInstruction, suggestionsFrom, type SuggestInput } from "../shared/campaign-suggest";

const input: SuggestInput = {
  brand: { name: "Sakina", tone: "warm, local", audience: "students", language: "ar", dos: "", donts: "no discounts", style: "" },
  profile: "Summary: smoothies and juices in Amman\nPhotography: bright, natural light",
  products: [
    { id: "a", name: "Mango Smoothie", from: "library", thumb: "/t/a", listId: "P1" },
    { id: "b", name: "Berry Blast", from: "drive", thumb: null, listId: "P2" },
  ],
  month: "2026-11",
  today: "2026-10-23",
  occasions: [{ date: "2026-11-14", name: "King Hussein's birthday" }],
  cast: [{ name: "omar", gender: "man", modest: true }],
  rules: ["Never show a woman, not even her hand."],
  past: ["Summer refresh"],
  hint: "families on the weekend",
  language: "ar",
};

describe("Suggest a campaign", () => {
  it("briefs the model with the brand, its Analysis, products, cast, rules, occasions, past campaigns and the admin's words", () => {
    const t = suggestInstruction(input);
    expect(t).toMatch(/THREE campaigns/);
    expect(t).toMatch(/Summary: smoothies and juices in Amman/);
    expect(t).toMatch(/^P1: Mango Smoothie/m);
    expect(t).toMatch(/PEOPLE: only the brand's cast/);
    expect(t).toMatch(/- Never show a woman, not even her hand\./);
    expect(t).toMatch(/2026-11-14: King Hussein's birthday/);
    expect(t).toMatch(/do not repeat their ideas\)\n- Summer refresh/);
    expect(t).toMatch(/THE ADMIN ASKS FOR: families on the weekend/);
    expect(t).toMatch(/never invent a discount/);
    expect(t).toMatch(/LANGUAGE: Arabic/);
  });

  it("maps the answer to setups: real products only, sizes in the limits, no list ids in the words", () => {
    const out = suggestionsFrom(
      {
        suggestions: [
          { title: "Weekend together", insight: "Families share on Fridays", why: "Cooler weather", objective: "Bring families in with P1 (P1)", audience: "Families", offer: "", message: "Share the cold one", direction: "Warm light, P2 on the table", products: ["P1", "P9", "P1"], imagePosts: 40, videos: 2, shotsPerVideo: 0, videoSeconds: 18.4 },
          { title: "" },
        ],
      },
      input,
    );
    expect(out).toHaveLength(1);
    const s = out[0].setup;
    expect(s.products!.map((p) => p.id)).toEqual(["a"]);
    expect(s.products![0]).not.toHaveProperty("listId");
    expect(s.productMode).toBe("manual");
    expect(s.objective).toBe("Bring families in with Mango Smoothie");
    expect(s.direction!.prompt).toBe("Warm light, Berry Blast on the table");
    expect([s.imagePosts, s.videos, s.shotsPerVideo, s.videoSeconds]).toEqual([12, 2, 1, 18]);
  });

  it("the preview answers three labelled suggestions from the listed products", () => {
    const out = suggestionsFrom(demoSuggestions(suggestInstruction(input)), input);
    expect(out).toHaveLength(3);
    expect(out.every((x) => x.title.startsWith("Preview:"))).toBe(true);
    expect(out[0].setup.products!.map((p) => p.name)).toEqual(["Mango Smoothie", "Berry Blast"]);
  });
});
