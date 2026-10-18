import { describe, expect, it } from "vitest";
import { parseTypography, typographyInstruction } from "@shared/typography";

describe("typography", () => {
  it("asks for one style, a word from the headline and a second font", () => {
    const text = typographyInstruction({ client: "Habibah", headline: "كنافة حبيبة", kind: "product post", headlineFont: "Gulzar", palette: ["cream #fcf7f0"], used: ["post 1: behind"] });
    expect(text).toMatch(/BEHIND the product/);
    expect(text).toMatch(/copied EXACTLY/);
    expect(text).toContain("Aref Ruqaa");
    expect(text).toContain("post 1: behind");
  });

  it("keeps a word only from the headline and an Arabic font for an Arabic word", () => {
    expect(parseTypography({ style: "behind", word: "كنافة", font: "Reem Kufi", color: "#8c6b44" }, "كنافة حبيبة", "Gulzar")).toEqual({ style: "behind", word: "كنافة", font: "Reem Kufi" });
    // A word that is not in the headline becomes its first words; a Latin font for Arabic falls back.
    expect(parseTypography({ style: "repeat", word: "حلويات", font: "Montserrat", color: "white" }, "طعم الموسم", "Gulzar")).toEqual({ style: "repeat", word: "طعم الموسم", font: "Gulzar" });
    expect(parseTypography({ style: "none", word: "x", font: "Cairo", color: "" }, "x", "Gulzar")).toBeNull();
  });
});

describe("typography styles chosen by the team", () => {
  it("keeps the team's style unless the typographer says it cannot work", () => {
    expect(parseTypography({ style: "outline", word: "كنافة", font: "Cairo", color: "" }, "كنافة حبيبة", "Gulzar", "repeat")?.style).toBe("repeat");
    expect(parseTypography({ style: "none", word: "كنافة", font: "Cairo", color: "" }, "كنافة حبيبة", "Gulzar", "repeat")).toBeNull();
    expect(typographyInstruction({ client: "H", headline: "x", kind: "product", headlineFont: "Gulzar", palette: [], used: [], force: "behind" })).toMatch(/THE TEAM CHOSE THE STYLE "behind"/);
  });
});
