/**
 * The layouts library: every layout is a valid layer set in Arabic, English and both; it uses the
 * brand's fonts and colours and the post's own words; an English client never gets an Arabic
 * default face and the other way round; a bilingual client gets two headline layers that read in
 * their own directions; applying keeps the designer's pictures and never asks for a picture.
 */
import { describe, expect, it } from "vitest";
import { LAYOUTS, applyLayout, fontFor, isLatinOnlyFont, layoutsFor, type LayoutBrand, type LayoutContext } from "../shared/layouts";
import { ARABIC_RE, TEXT_DESIGN_SCHEMA, isTextLayer, newImageLayer, type TextDesign, type TextLayer } from "../shared/layers";
import { sampleContent, type ClientLanguage } from "../shared/language";
import { LATIN_FONTS } from "../shared/overlay";

const bare: LayoutBrand = { colors: [], fonts: {}, fontFiles: [] };
const branded: LayoutBrand = { colors: [{ name: "Navy", hex: "#0b1f6b" }, { name: "Lime", hex: "#bbf714" }], fonts: { headline: "Graphic School", body: "Almarai" }, fontFiles: [{ id: "f1", name: "Graphic School" }] };

const ctx = (language: ClientLanguage, brand: LayoutBrand = bare, post: { headline?: string; subline?: string } = {}, hasLogo = true): LayoutContext => ({ brand, language, sample: sampleContent(language, post), hasLogo, ratio: 1.25 });

const textLayers = (layers: { type: string }[]) => layers.filter((l): l is TextLayer => isTextLayer(l as TextLayer));

describe("layouts", () => {
  it("every layout is a valid design in each language", () => {
    for (const language of ["ar", "en", "both"] as const) {
      for (const l of layoutsFor(language)) {
        const made = l.make(ctx(language, branded));
        const design = applyLayout(null, made);
        const parsed = TEXT_DESIGN_SCHEMA.safeParse(design);
        expect(parsed.success, `${l.name} in ${language}: ${JSON.stringify(parsed.success ? "" : parsed.error.issues[0])}`).toBe(true);
        expect(design.layers.length).toBeGreaterThan(0);
        // Every text layer has words and sits inside the canvas.
        for (const t of textLayers(design.layers)) {
          expect(t.text.trim().length).toBeGreaterThan(0);
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(t.x + t.w).toBeLessThanOrEqual(1.001);
          expect(t.y).toBeGreaterThanOrEqual(0);
          expect(t.y).toBeLessThan(1);
        }
      }
    }
  });

  it("names the six curated layouts and offers the bilingual split only to bilingual clients", () => {
    const names = LAYOUTS.map((l) => l.name);
    for (const n of ["Bold promotional", "Editorial", "Minimal premium", "Product launch", "Clean price / offer", "Typographic statement"]) expect(names).toContain(n);
    expect(layoutsFor("ar").some((l) => l.id === "bilingual")).toBe(false);
    expect(layoutsFor("en").some((l) => l.id === "bilingual")).toBe(false);
    expect(layoutsFor("both").some((l) => l.id === "bilingual")).toBe(true);
  });

  it("uses the post's own words, with the headline and second line roles the plan keeps in step", () => {
    for (const l of layoutsFor("ar")) {
      const design = applyLayout(null, l.make(ctx("ar", branded, { headline: "قهوة الصباح", subline: "طازجة كل يوم" })));
      const texts = textLayers(design.layers);
      const head = texts.find((t) => t.role === "headline");
      expect(head?.text, l.name).toBe("قهوة الصباح");
      expect(texts.find((t) => t.role === "subline")?.text, l.name).toBe("طازجة كل يوم");
      expect(head?.direction, l.name).toBe("rtl");
    }
  });

  it("uses the brand's fonts and first colour when the brand kit names them", () => {
    for (const l of layoutsFor("en")) {
      const design = applyLayout(null, l.make(ctx("en", branded)));
      const head = textLayers(design.layers).find((t) => t.role === "headline")!;
      expect(head.font, l.name).toBe("Graphic School");
      const sub = textLayers(design.layers).find((t) => t.role === "subline");
      if (sub) expect(sub.font, l.name).toBe("Almarai");
    }
    const offer = applyLayout(null, LAYOUTS.find((l) => l.id === "offer")!.make(ctx("en", branded)));
    const price = textLayers(offer.layers).find((t) => t.name === "Price")!;
    expect(price.background?.color).toBe("#0b1f6b");
    expect(price.fill).toEqual({ type: "solid", color: "#ffffff" });
  });

  it("never gives an English client an Arabic default face, nor an Arabic client a Latin-only one", () => {
    const latin = new Set(LATIN_FONTS.map((f) => f.family));
    for (const l of layoutsFor("en")) {
      for (const t of textLayers(applyLayout(null, l.make(ctx("en"))).layers)) expect(latin.has(t.font), `${l.name}: ${t.name} uses ${t.font}`).toBe(true);
    }
    for (const l of layoutsFor("ar")) {
      for (const t of textLayers(applyLayout(null, l.make(ctx("ar"))).layers)) expect(isLatinOnlyFont(t.font), `${l.name}: ${t.name} uses ${t.font}`).toBe(false);
    }
    expect(fontFor(bare, "headline", "en", "bold")).toBe("Montserrat");
    expect(fontFor(bare, "headline", "ar", "bold")).toBe("Cairo");
    expect(fontFor(branded, "headline", "en", "bold")).toBe("Graphic School");
  });

  it("gives a bilingual client two headline layers, each reading its own way, and never translates", () => {
    for (const l of layoutsFor("both")) {
      const design = applyLayout(null, l.make(ctx("both", bare, { headline: "عرض العيد", subline: "Eid offer" })));
      const texts = textLayers(design.layers);
      const arabic = texts.filter((t) => ARABIC_RE.test(t.text));
      const english = texts.filter((t) => !ARABIC_RE.test(t.text) && /[A-Za-z]/.test(t.text));
      expect(arabic.length, l.name).toBeGreaterThan(0);
      expect(english.length, l.name).toBeGreaterThan(0);
      // The post's English line became the second headline: the words are the designer's, not a translation.
      expect(texts.some((t) => t.text === "Eid offer"), l.name).toBe(true);
      expect(texts.some((t) => t.text === "عرض العيد"), l.name).toBe(true);
      for (const t of english) if (t.direction) expect(t.direction, `${l.name}: ${t.name}`).not.toBe("rtl");
      // Two independently editable layers: distinct ids, no shared role.
      const ids = new Set(texts.map((t) => t.id));
      expect(ids.size).toBe(texts.length);
    }
  });

  it("falls back to sample copy in the language, with a formatted price, when the post has no words yet", () => {
    const ar = sampleContent("ar");
    const en = sampleContent("en");
    expect(ARABIC_RE.test(ar.headline)).toBe(true);
    expect(ARABIC_RE.test(en.headline)).toBe(false);
    expect(en.price).toMatch(/19\.99/);
    expect(ar.price).toMatch(/19\.99/);
    const both = sampleContent("both", { headline: "Fresh every day" });
    expect(both.headline).toBe("Fresh every day");
    expect(both.headlineAlt && ARABIC_RE.test(both.headlineAlt)).toBe(true);
  });

  it("keeps the designer's pictures when a layout is applied and gives everything else a fresh id", () => {
    const picture = newImageLayer("/api/studio/sources/p1", { name: "Cup" });
    const before: TextDesign = { version: 1, layers: [picture, { ...textLayers(applyLayout(null, LAYOUTS[0].make(ctx("ar"))).layers)[0], id: "old" }] };
    const after = applyLayout(before, LAYOUTS[1].make(ctx("ar")));
    expect(after.layers[0]).toBe(picture);
    expect(after.layers.some((l) => l.id === "old")).toBe(false);
    expect(after.canvas).toBeDefined();
    // A layout without a logo file places no logo layer.
    const noLogo = applyLayout(null, LAYOUTS[0].make(ctx("ar", bare, {}, false)));
    expect(noLogo.layers.some((l) => l.type === "logo")).toBe(false);
  });
});
