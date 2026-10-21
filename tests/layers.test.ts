import { describe, expect, it } from "vitest";
import {
  applyCase,
  contrastRatio,
  editText,
  luminance,
  newTextLayer,
  paragraphDirection,
  replaceInLayers,
  segmentsOf,
  setRunStyle,
  shiftRuns,
  styleAt,
  TEXT_DESIGN_SCHEMA,
  wordsOf,
  type TextDesign,
} from "../shared/layers";
import { assistInstruction, parseAssist } from "../shared/text-assist";

describe("text layers", () => {
  it("reads a paragraph's direction from its first strong character", () => {
    expect(paragraphDirection("حلويات العيد")).toBe("rtl");
    expect(paragraphDirection("Eid sweets")).toBe("ltr");
    expect(paragraphDirection("2026 · عرض")).toBe("rtl");
    expect(paragraphDirection("!!!")).toBe("ltr");
    expect(paragraphDirection("hello", "rtl")).toBe("rtl");
  });

  it("changes case without touching Arabic letters", () => {
    expect(applyCase("new menu", "upper")).toBe("NEW MENU");
    expect(applyCase("new menu", "title")).toBe("New Menu");
    expect(applyCase("قهوة", "upper")).toBe("قهوة");
    expect(applyCase("Mixed", "none")).toBe("Mixed");
  });

  it("styles a range of words and cuts the text into uniform segments", () => {
    const runs = setRunStyle(undefined, 4, 9, { bold: true });
    expect(runs).toEqual([{ from: 4, to: 9, style: { bold: true } }]);
    const runs2 = setRunStyle(runs, 6, 12, { color: "#ff0000" });
    expect(styleAt(runs2, 7)).toEqual({ bold: true, color: "#ff0000" });
    expect(styleAt(runs2, 10)).toEqual({ color: "#ff0000" });
    expect(styleAt(runs2, 2)).toEqual({});
    const segs = segmentsOf(runs2, 0, 21);
    expect(segs.map((s) => [s.from, s.to])).toEqual([
      [0, 4],
      [4, 6],
      [6, 9],
      [9, 12],
      [12, 21],
    ]);
    // Clearing bold on the overlap leaves the colour.
    const cleared = setRunStyle(runs2, 4, 9, { bold: undefined });
    expect(styleAt(cleared, 7)).toEqual({ color: "#ff0000" });
    expect(styleAt(cleared, 5)).toEqual({});
  });

  it("moves run boundaries with the text when words are typed or deleted", () => {
    const runs = [{ from: 4, to: 9, style: { bold: true } }];
    expect(shiftRuns(runs, 0, 0, 3)).toEqual([{ from: 7, to: 12, style: { bold: true } }]);
    expect(shiftRuns(runs, 5, 0, 2)).toEqual([{ from: 4, to: 11, style: { bold: true } }]);
    expect(shiftRuns(runs, 2, 10, 0)).toBeUndefined();
    const layer = newTextLayer("Our fresh juice", { runs: [{ from: 4, to: 9, style: { bold: true } }] });
    const typed = editText(layer, "Our very fresh juice");
    expect(typed.runs).toEqual([{ from: 9, to: 14, style: { bold: true } }]);
    expect(typed.text.slice(9, 14)).toBe("fresh");
  });

  it("finds and replaces across layers, keeping the runs in step", () => {
    const layers = [newTextLayer("Mango season", { runs: [{ from: 0, to: 5, style: { bold: true } }] }), newTextLayer("Try the mango")];
    const r = replaceInLayers(layers, "mango", "kiwi");
    expect(r.count).toBe(2);
    expect(r.layers[0].text).toBe("Kiwi season".replace("K", "k"));
    expect(r.layers[0].runs).toEqual([{ from: 0, to: 4, style: { bold: true } }]);
    expect(r.layers[1].text).toBe("Try the kiwi");
  });

  it("keeps the plan's headline and second line from the roled layers", () => {
    const d: TextDesign = {
      version: 1,
      layers: [newTextLayer("small note"), newTextLayer("Big\nheadline", { role: "headline" }), newTextLayer("second", { role: "subline" })],
    };
    expect(wordsOf(d)).toEqual({ headline: "Big headline", subline: "second" });
    const noRoles: TextDesign = { version: 1, layers: [newTextLayer("first"), newTextLayer("second"), newTextLayer("", { hidden: true })] };
    expect(wordsOf(noRoles)).toEqual({ headline: "first", subline: "second" });
  });

  it("validates a stored design and refuses nonsense", () => {
    const d: TextDesign = {
      version: 1,
      layers: [
        newTextLayer("حلويات", {
          fill: { type: "linear", angle: 90, stops: [{ at: 0, color: "#ffffff" }, { at: 1, color: "#1129d3" }] },
          stroke: { color: "#000000", width: 0.04 },
          shadow: { color: "#000000", blur: 0.3, x: 0.05, y: 0.08, alpha: 0.6 },
          background: { color: "#000000", alpha: 0.4, padding: 0.4, radius: 0.4, blur: 12 },
          curve: 45,
          blend: "multiply",
        }),
      ],
      canvas: { gradient: { color: "#000000", angle: 180, from: 0, to: 0.6 } },
    };
    expect(TEXT_DESIGN_SCHEMA.safeParse(d).success).toBe(true);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ version: 1, layers: [{ ...d.layers[0], weight: 950 }] }).success).toBe(false);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ version: 1, layers: [{ ...d.layers[0], blend: "bogus" }] }).success).toBe(false);
  });

  it("measures contrast the WCAG way", () => {
    expect(contrastRatio(luminance("#ffffff"), luminance("#000000"))).toBeCloseTo(21, 0);
    expect(contrastRatio(luminance("#ffffff"), luminance("#ffffff"))).toBe(1);
    expect(contrastRatio(luminance("#ffffff"), luminance("#777777"))).toBeGreaterThan(4);
  });
});

describe("text assistant", () => {
  it("writes the task, the brand and the words into the instruction", () => {
    const text = assistInstruction({ action: "shorten", text: "عرض خاص على كل المشروبات هذا الأسبوع", client: "Qamari", tone: "warm, Jordanian", language: "ar", brand: { fonts: ["Cairo"], colours: ["#1129d3"] } });
    expect(text).toContain("Qamari");
    expect(text).toContain("shorter versions");
    expect(text).toContain("Brand fonts: Cairo");
    expect(text).toContain("عرض خاص");
  });

  it("parses suggestions, drops quotes and duplicates, keeps the verdict", () => {
    const a = parseAssist({ suggestions: [{ text: '"Fresh every morning"', note: "shorter" }, { text: "Fresh every morning", note: "same" }, { text: "", note: "x" }], verdict: "Hierarchy is clear." });
    expect(a.suggestions).toEqual([{ text: "Fresh every morning", note: "shorter" }]);
    expect(a.verdict).toBe("Hierarchy is clear.");
    expect(parseAssist(null)).toEqual({ suggestions: [], verdict: undefined });
  });
});
