import { describe, expect, it } from "vitest";
import { buildPostPrompt, type PostBrief } from "../shared/posts";

/**
 * Golden prompts: the exact text the image engine receives for each creation method. Any change to
 * these snapshots is an intentional change to the model inputs and is explained in the commit.
 */
const base: PostBrief = {
  post: true,
  index: 3,
  type: "product",
  title: "Golden hour baklava",
  brief: "A tray of pistachio baklava on a marble table, warm side light, one piece lifted by hand.",
  palette: ["Cream #f3e9d2", "Pistachio #7a9a5a"],
  style: "Warm, generous, family hospitality.",
  theme: "Autumn gatherings: long tables, copper trays, soft evening light.",
  format: "4:5",
  ref: null,
  refIsSource: false,
  hasProduct: true,
  product: "pistachio baklava tray: a round brass tray of layered pistachio baklava, cut in diamonds",
  always: "the brass tray stays in view",
  never: "no cutlery",
  rules: "Every box keeps its printed lid.",
  photography: "50mm, eye level, soft window light.",
  lessons: ["The product is never shown in a bag."],
  productNames: ["pistachio baklava tray"],
  shot: "Low side light across a marble table, one hand lifting a piece.",
};

const cases: Record<string, PostBrief> = {
  "theme reference (borrow the look)": { ...base, ref: "ref-1", library: "Copper, linen, candle light; shallow depth.", props: "dried orange slices", wardrobe: "cream knit" },
  "grid tile (recreate the composition)": { ...base, ref: "style:grid-9", tileKey: "styles/grid-9-tile-3.jpg", shot: "Tile 3: top-down tray on a dark table." },
  "brief campaign (designer's reference, colours lead)": { ...base, styleKey: "styles/brief-7.jpg", campaign: { ingredients: "pistachios, honey", colours: ["Navy #0b1f6b"] }, paletteChosen: true },
  "applied gallery style (style alone)": { ...base, styleKey: "styles/s-42.jpg", theme: "", library: "ignored with a style", props: "ignored with a style" },
  "style with people (reference described, not attached)": { ...base, styleKey: "styles/s-42.jpg", noRefImage: true, ambassadors: [{ name: "Lina", description: "woman, 30s, hijab", key: "amb/lina.jpg" }] },
  "revision with an edit reference": { ...base, ref: "ref-1", editRef: { key: "u/b/ref.jpg", note: "Keep the tray, replace the table with wood." }, take: 2 },
  "no product: reference is image 1": { ...base, hasProduct: false, product: undefined, ref: "ref-1", refIsSource: true, type: "tip", brandFoods: "baklava, kunafa" },
  "exact product mode": { ...base, exact: { source: "src-1" }, ref: "ref-1" },
};

describe("golden prompts", () => {
  for (const [name, brief] of Object.entries(cases))
    it(name, () => {
      expect(buildPostPrompt(brief)).toMatchSnapshot();
    });
});
