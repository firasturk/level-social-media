/**
 * The renderer's measure-and-wrap: Arabic, English and mixed lines wrap inside their box without
 * clipping, words are never broken, a line reads in the direction of its script, "fit to box"
 * shrinks the type until the words fit, and bidi isolate marks take no room on the canvas.
 */
import { describe, expect, it, vi } from "vitest";
import { newTextLayer, type TextLayer } from "../shared/layers";

// The canvas never fetches a font in these tests: the font helpers are the browser's job.
vi.mock("../src/lib/fonts", () => ({
  ensureFont: async () => undefined,
  loadFont: async () => undefined,
  fontStack: (f: string) => `"${f}", sans-serif`,
  ARABIC: /[؀-ۿ]/,
}));

/** Every glyph is half an em wide: widths follow the font size the renderer sets, as a real canvas would. */
function fakeContext() {
  const ctx = {
    font: "",
    direction: "ltr",
    textAlign: "left",
    save() {},
    restore() {},
    setTransform() {},
    measureText(t: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 16);
      return { width: Array.from(t.replace(/[\u2066-\u2069]/g, "")).length * px * 0.5 };
    },
  };
  return ctx;
}

interface Line {
  width: number;
  dir: "rtl" | "ltr";
  tokens: { text: string; space: boolean }[];
}
interface Layout {
  lines: Line[];
  total: number;
  px: number;
}
interface Box {
  w: number;
  h: number;
  px: number;
  lines: number;
}
type LayoutBox = (ctx: unknown, layer: TextLayer, W: number, H: number) => { lay: Layout; box: Box };
const renderer = async () => (await import("../src/lib/textLayers".toString())) as { layoutBox: LayoutBox };

const W = 1000;
const H = 1250;

async function lay(text: string, over: Partial<TextLayer> = {}) {
  const { layoutBox } = await renderer();
  const layer = newTextLayer(text, { x: 0.1, y: 0.1, w: 0.5, size: 0.06, lineHeight: 1.2, ...over });
  return layoutBox(fakeContext(), layer, W, H);
}

const maxW = 0.5 * W;
const words = (l: Line) => l.tokens.filter((t) => !t.space).map((t) => t.text);

describe("measure and wrap", () => {
  it("wraps an English sentence inside its box without breaking a word", async () => {
    const text = "Fresh coffee every morning until Sunday only here";
    const { lay: out, box } = await lay(text);
    expect(out.lines.length).toBeGreaterThan(1);
    for (const line of out.lines) {
      expect(line.width).toBeLessThanOrEqual(maxW + 0.5);
      expect(line.dir).toBe("ltr");
    }
    expect(out.lines.flatMap(words).join(" ")).toBe(text);
    expect(box.h).toBeCloseTo(out.total, 5);
    expect(box.lines).toBe(out.lines.length);
  });

  it("wraps an Arabic sentence the same way and reads it right to left", async () => {
    const text = "قهوة طازجة كل صباح حتى يوم الأحد هنا فقط";
    const { lay: out } = await lay(text);
    expect(out.lines.length).toBeGreaterThan(1);
    for (const line of out.lines) {
      expect(line.width).toBeLessThanOrEqual(maxW + 0.5);
      expect(line.dir).toBe("rtl");
    }
    expect(out.lines.flatMap(words).join(" ")).toBe(text);
  });

  it("wraps a mixed line, keeps the price whole and reads it in the Arabic direction", async () => {
    const text = "عرض Eid Sale بسعر 19.99 JOD لهذا الأسبوع فقط";
    const { lay: out } = await lay(text, { size: 0.05 });
    expect(out.lines.length).toBeGreaterThan(1);
    for (const line of out.lines) expect(line.width).toBeLessThanOrEqual(maxW + 0.5);
    expect(out.lines[0].dir).toBe("rtl");
    expect(out.lines.flatMap(words).join(" ")).toBe(text);
    // The number and its currency are never split across lines by the wrap when they fit together.
    const joined = out.lines.map((l) => words(l).join(" "));
    expect(joined.some((l) => l.includes("19.99 JOD")) || joined.some((l) => l.endsWith("19.99"))).toBe(true);
  });

  it("shrinks the type to fit a fixed box instead of clipping", async () => {
    const text = "A very long headline that would never fit this small box at its size";
    const fixed = await lay(text, { autoSize: false, fit: true, h: 0.12, size: 0.12 });
    expect(fixed.lay.px).toBeLessThan(0.12 * W);
    expect(fixed.lay.total).toBeLessThanOrEqual(0.12 * H + 0.5);
    for (const line of fixed.lay.lines) expect(line.width).toBeLessThanOrEqual(maxW + 0.5);
    // Without fit the same box keeps the size and the words run past it (the box reports its fixed height).
    const loose = await lay(text, { autoSize: false, h: 0.12, size: 0.12 });
    expect(loose.lay.px).toBe(0.12 * W);
    expect(loose.lay.total).toBeGreaterThan(0.12 * H);
  });

  it("gives bidi isolate marks no width", async () => {
    const plain = await lay("Only 19.99 JOD today");
    const isolated = await lay("Only \u206819.99 JOD\u2069 today");
    expect(isolated.lay.lines.map((l) => l.width)).toEqual(plain.lay.lines.map((l) => l.width));
    expect(isolated.lay.lines.flatMap(words).join(" ")).toBe("Only 19.99 JOD today");
  });

  it("lets a layer's direction decide for a line of numbers", async () => {
    const auto = await lay("19.99");
    expect(auto.lay.lines[0].dir).toBe("ltr");
    const rtl = await lay("19.99", { direction: "rtl" });
    expect(rtl.lay.lines[0].dir).toBe("rtl");
  });
});
