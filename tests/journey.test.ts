import { describe, expect, it } from "vitest";
import { dateInMonth, occasionsOf, spreadDates, withDates } from "@shared/occasions";
import { adaptShotsInstruction, briefLines, FOREIGN_ITEMS, parseBrief } from "@shared/brief";
import { ideasInstruction, parseIdeas } from "@shared/posts";

describe("occasions and posting dates", () => {
  it("finds fixed and Hijri occasions", () => {
    const may = occasionsOf("2026-05").map((o) => o.name);
    expect(may).toContain("Independence Day");
    expect(may).toContain("Eid al-Adha");
    const march = occasionsOf("2026-03").map((o) => o.name);
    expect(march).toContain("Mother's Day");
    expect(march).toContain("Eid al-Fitr");
  });

  it("spreads posts over the month and keeps the writer's dates", () => {
    expect(spreadDates("2026-10", 3)).toEqual(["2026-10-01", "2026-10-16", "2026-10-31"]);
    expect(dateInMonth("2026-10-32", "2026-10")).toBeUndefined();
    const plan = withDates(
      [
        { index: 1, date: "2026-10-20" },
        { index: 2, date: "2026-11-02" },
        { index: 3, date: "2026-10-05" },
      ],
      "2026-10",
    );
    expect(plan.map((p) => p.date)).toEqual(["2026-10-05", "2026-10-16", "2026-10-20"]);
    expect(plan.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it("reads the date of an idea", () => {
    const [p] = parseIdeas(JSON.stringify({ posts: [{ type: "product", title: "T", brief: "B", caption: "", hashtags: "", date: "2026-10-09" }] }), 1, []);
    expect(p.date).toBe("2026-10-09");
  });
});

describe("the brief", () => {
  it("parses an analysis and orders its rules", () => {
    const b = parseBrief({ summary: "S", points: ["a", "", "b"], logic: "L", categories: [{ product: "x", category: "Tin" }] });
    expect(b.points).toEqual(["a", "b"]);
    expect(b.categories).toEqual([{ product: "x", category: "Tin" }]);
    expect(
      briefLines({ colours: { summary: "", points: [], logic: "C", at: 1 }, products: { summary: "", points: [], logic: "P", at: 1 } }),
    ).toEqual(["P", "C"]);
  });

  it("puts the brief and the occasions in the ideas instruction", () => {
    const text = ideasInstruction({
      clientName: "Habibah",
      tone: "",
      dos: "",
      donts: "",
      language: "ar",
      palette: [],
      style: "",
      themeTitle: "",
      themeDirection: "",
      products: [],
      month: "2026-05",
      count: 4,
      occasions: [{ date: "2026-05-25", name: "Independence Day" }],
      brief: ["Show tins by their handle."],
    });
    expect(text).toContain("CREATIVE BRIEF");
    expect(text).toContain("Show tins by their handle.");
    expect(text).toContain("2026-05-25 Independence Day");
    expect(text).toContain('date (the posting day');
  });
});

describe("the month's shots", () => {
  it("spots what the client does not sell", () => {
    expect(FOREIGN_ITEMS.test("A hand holds a glass filled with a layered beverage")).toBe(true);
    expect(FOREIGN_ITEMS.test("holding a textured snack bar vertically")).toBe(true);
    expect(FOREIGN_ITEMS.test("A hand holds the blue and silver gift box against a cream wall. You can see the tin.")).toBe(false);
  });

  it("asks for the client's products and colours only", () => {
    const t = adaptShotsInstruction({ shots: ["A hand holds a glass."], products: ["- Tin: a round silver tin"], palette: ["deep blue #0042aa", "cream #f5e6d3"] });
    expect(t).toContain("The background (wall, backdrop, main surface) is deep blue #0042aa");
    expect(t).toContain("- Tin: a round silver tin");
    expect(t).toContain("exactly 1 entries");
  });
});

describe("a client with no products", () => {
  it("plans the month around its service", () => {
    const text = ideasInstruction({
      clientName: "United Insurance",
      tone: "",
      dos: "",
      donts: "",
      language: "ar",
      palette: [],
      style: "",
      themeTitle: "",
      themeDirection: "",
      products: [],
      month: "2026-11",
      count: 4,
      service: "car, home and travel insurance for families in Jordan",
    });
    expect(text).toContain("SERVICE BRAND (no products): United Insurance offers car, home and travel insurance");
    expect(text).not.toContain("PRODUCTS ONLY");
  });

  it("rewrites the shots around the service", () => {
    const t = adaptShotsInstruction({ shots: ["A hand holds a glass."], products: [], palette: [], service: "car insurance" });
    expect(t).toContain("THE BRAND SELLS A SERVICE, NOT PRODUCTS: car insurance");
  });
});
