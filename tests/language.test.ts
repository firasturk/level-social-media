/**
 * Content language: the brand kit's default, the month's and the post's overrides, which script a
 * text is in, prices formatted for the language with Intl, and the renderer's bidi rules for
 * mixed lines (a price stays one unit inside Arabic copy).
 */
import { describe, expect, it } from "vitest";
import { alignFor, directionFor, formatNumber, formatPrice, languageOfText, languageWithSource, plainText, resolveLanguage, scriptOf } from "../shared/language";
import { directionRuns, paragraphDirection } from "../shared/layers";

describe("language resolution", () => {
  it("takes the post's language, else the month's, else the brand kit's, else Arabic", () => {
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("en", "ar")).toBe("ar");
    expect(resolveLanguage("en", "ar", "both")).toBe("both");
    expect(resolveLanguage(undefined, undefined, undefined)).toBe("ar");
    expect(languageWithSource("en", undefined, "ar")).toEqual({ language: "ar", source: "post" });
    expect(languageWithSource("en", "both")).toEqual({ language: "both", source: "month" });
    expect(languageWithSource("en")).toEqual({ language: "en", source: "brand" });
    expect(languageWithSource(null)).toEqual({ language: "ar", source: "default" });
  });

  it("skips values it does not know instead of guessing", () => {
    expect(resolveLanguage("fr", "", "xx")).toBe("ar");
    expect(resolveLanguage("en", "fr")).toBe("en");
    expect(resolveLanguage("en", undefined, "")).toBe("en");
  });

  it("knows the script of a text and the direction and side a language starts with", () => {
    expect(scriptOf("قهوة الصباح")).toBe("ar");
    expect(scriptOf("Morning coffee")).toBe("en");
    expect(scriptOf("قهوة Coffee")).toBe("mixed");
    expect(scriptOf("19.99 - 20%")).toBe("none");
    expect(languageOfText("19.99", "en")).toBe("en");
    expect(languageOfText("19.99")).toBe("ar");
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor("both")).toBe("auto");
    expect(alignFor("en")).toBe("left");
    expect(alignFor("ar")).toBe("right");
    expect(alignFor("both")).toBe("right");
  });
});

describe("prices and numbers", () => {
  it("formats a price with Intl in Latin digits, the currency where the language puts it", () => {
    const en = formatPrice(19.99, "JOD", "en");
    expect(en).toMatch(/^JOD\s?19\.99$/);
    const ar = formatPrice(19.99, "JOD", "ar");
    expect(ar).toContain("19");
    expect(ar).toContain("99");
    // Latin digits, no Arabic-Indic ones, and no stray bidi or no-break marks a canvas would measure.
    expect(/[٠-٩]/.test(ar)).toBe(false);
    expect(/[\u200e\u200f\u061c\u00a0]/.test(ar)).toBe(false);
    expect(formatPrice(5, "JOD", "ar", { digits: "arab" })).toMatch(/[٠-٩]/);
  });

  it("isolates a price for DOM text on request, and strips the marks again", () => {
    const iso = formatPrice(19.99, "JOD", "en", { isolate: true });
    expect(iso.startsWith("\u2068")).toBe(true);
    expect(iso.endsWith("\u2069")).toBe(true);
    expect(plainText(iso)).toBe(formatPrice(19.99, "JOD", "en"));
  });

  it("formats numbers for the language", () => {
    expect(formatNumber(1234, "en")).toBe("1,234");
    expect(formatNumber(1234, "ar")).toMatch(/1[,٬]?234/);
    expect(formatNumber(7, "ar", "arab")).toBe("٧");
  });
});

describe("mixed-script lines", () => {
  const t = (s: string) => s.split(/(\s+)/).filter(Boolean).map((text) => ({ text }));
  const runsOf = (s: string, dir: "rtl" | "ltr") => directionRuns(t(s), dir).map((r) => [r.dir, r.tokens.map((x) => x.text).join("")]);

  it("keeps a price as one left-to-right unit inside Arabic copy", () => {
    expect(runsOf("خصم 19.99 JOD اليوم", "rtl")).toEqual([
      ["rtl", "خصم "],
      ["ltr", "19.99 JOD "],
      ["rtl", "اليوم"],
    ]);
  });

  it("lets a number alone follow the Arabic word before it, and a number after English stay English", () => {
    expect(runsOf("خصم 20% اليوم", "rtl")).toEqual([["rtl", "خصم 20% اليوم"]]);
    expect(runsOf("Only 19.99 دينار", "ltr")).toEqual([
      ["ltr", "Only 19.99 "],
      ["rtl", "دينار"],
    ]);
    expect(runsOf("عرض Eid Sale 2026 خاص", "rtl")).toEqual([
      ["rtl", "عرض "],
      ["ltr", "Eid Sale 2026 "],
      ["rtl", "خاص"],
    ]);
  });

  it("decides a paragraph's direction by its first letter, and by the fallback when it has none", () => {
    expect(paragraphDirection("19.99 دينار")).toBe("rtl");
    expect(paragraphDirection("JOD 19.99")).toBe("ltr");
    expect(paragraphDirection("19.99")).toBe("ltr");
    expect(paragraphDirection("19.99", "auto", "rtl")).toBe("rtl");
    expect(paragraphDirection("Coffee", "rtl")).toBe("rtl");
  });
});
