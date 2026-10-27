import { parsePostReview, postReviewInstruction } from "@shared/qa";
import { describe, expect, it } from "vitest";
import { adaptStyleInstruction, describeStyleInstruction, gridPostCount, gridStyleInstruction, parseGridStyle, parseStyle, pictureSig, seasonWords } from "@shared/styles";
import { buildPostPrompt, hexIn, overlayFromTile, TEXTURED_BACKGROUND, tileSpecOf, type PostBrief } from "@shared/posts";

describe("style gallery", () => {
  it("reads a pin into a style for any product", () => {
    const ins = describeStyleInstruction("Frambini ice cream, raspberries in ice cubes");
    expect(ins).toContain("the product's own key ingredients");
    expect(ins).toContain("Frambini");
    const fresh = describeStyleInstruction("", { title: "Frozen in ice cubes", prompt: "The product lies among ice cubes." });
    expect(fresh).toContain("FRESH variation");
    const s = parseStyle({ keep: true, score: 9, kind: "people", title: '"Cloud Swing"', tags: "sky, swing", prompt: "x".repeat(80) });
    expect(s).toMatchObject({ keep: true, score: 9, kind: "people", title: "Cloud Swing" });
    expect(parseStyle({ keep: true, score: 7, kind: "product", title: "Nice concept", tags: "", prompt: "z".repeat(80) }).keep).toBe(false);
    expect(parseStyle({ keep: true, score: 9, kind: "product", title: "Too short", tags: "", prompt: "short" }).keep).toBe(false);
    // Below the team's bar (8): a plain packshot or a merely nice concept stays out of the gallery.
    expect(parseStyle({ keep: true, score: 5, kind: "product", title: "Plain packshot", tags: "", prompt: "y".repeat(80) }).keep).toBe(false);
    expect(ins).toContain("THE BAR");
    expect(parseStyle({ keep: false, title: "A", prompt: "y".repeat(80) }).keep).toBe(false);
  });

  it("writes a style for the real product, its ingredients and colours", () => {
    const ins = adaptStyleInstruction({
      style: { title: "Frozen in ice cubes", kind: "product", prompt: "The product lies among ice cubes with the product's own key ingredients frozen inside." },
      product: "a round navy tin of pistachio kunafa nests",
      category: "Tin",
      post: { type: "Lifestyle", headline: "برد الصيف", brief: "The tin on ice." },
      brand: { name: "Habibah", never: "no alcohol" },
      palette: ["Royal blue #1f4fa0", "Cream #f3eadb"],
      people: [],
    });
    expect(ins).toContain("pistachio kunafa nests");
    expect(ins).toContain("raspberries frozen in ice become pistachios frozen in ice");
    expect(ins).toContain("keep the style's own colours");
    expect(ins).toContain("Where the style says 'the brand's main colour', write Royal blue #1f4fa0");
    expect(ins).not.toContain("The background is Royal blue");
    expect(ins).toContain("nobody appears");
    expect(ins).toContain("NEVER a drink");
  });

  it("attaches the style's picture as the style reference", () => {
    const b: PostBrief = {
      post: true, index: 1, type: "lifestyle", title: "T", brief: "B", palette: [], style: "", format: "4:5",
      ref: null, refIsSource: false, hasProduct: true, styleKey: "styles/x.jpg", shot: "A hand dips a pistachio over the open tin.",
      theme: "Autumn road trip", props: "autumn leaves", library: "Warm roadside light",
    };
    const p = buildPostPrompt(b);
    expect(p).toContain("Image 2 is the style the designer picked");
    expect(p).toContain("THE PHOTOGRAPH (the picked style");
    expect(p).toContain("A hand dips a pistachio");
    expect(p).not.toContain("autumn leaves");
    expect(p).not.toContain("Warm roadside light");
    expect(p).not.toContain("REFERENCE SHOT");
  });

  it("lets the picked style set the scale and keeps a retake in the style", () => {
    const b: PostBrief = {
      post: true, index: 4, type: "lifestyle", title: "Lotus Shake Joy", brief: "Omar lies on the floor.", palette: [], style: "People appear partially.", format: "4:5",
      ref: null, refIsSource: false, hasProduct: true, styleKey: "styles/giant.jpg", take: 5,
      shot: "A giant light brown milkshake in a clear cup towers over Omar; two regular-sized copies stand on either side.",
      product: "A light brown milkshake topped with biscuit crumbles in a clear cup with a turquoise Arabic logo.",
      productNames: ["Lotus milkshake ", "milk shake"],
      always: "Blue sky with soft cloud, palm leaves, pool water", never: "No prices on artwork",
      theme: "", library: "",
    };
    const p = buildPostPrompt(b);
    expect(p).toContain("A light brown milkshake topped");
    expect(p).toContain("A giant light brown milkshake");
    expect(p).toContain("keep its composition, set, camera and scale");
    expect(p).not.toContain("another camera angle and distance");
    expect(p).not.toContain("never enlarged");
    expect(p).not.toContain("It appears once");
    expect(p).toContain("Every copy of it in the picture");
    expect(p).toContain("Image 2's product, packaging, logo and print never appear");
    expect(p).not.toContain("palm leaves");
    expect(p).toContain("No prices on artwork");
    // The picked style is the look: the client's usual finish stays off a styled post (27 Oct).
    expect(p).not.toContain("CLIENT LOOK");
    expect(p).not.toContain("CLIENT STYLE");
    expect(p).not.toContain("duplicated products");
  });

  it("reviews a styled post by the style's scale", () => {
    const ins = postReviewInstruction({ products: 1, productNotes: ["a milkshake"], type: "lifestyle", people: [], style: "A giant milkshake towers over the man." });
    expect(ins).toContain("A giant product or several copies of the same product are then right");
    expect(ins).toContain("Extra copies of the same photographed product");
    expect(postReviewInstruction({ products: 1, productNotes: ["a milkshake"], type: "lifestyle", people: [] })).toContain("false when it is giant");
  });
});

describe("the open style library", () => {
  it("puts every style on a shelf", () => {
    const base = { keep: true, score: 9, kind: "product", title: "Fridge Stash", tags: "", prompt: "p".repeat(80) };
    expect(parseStyle({ ...base, category: "sweets" }).category).toBe("sweets");
    expect(parseStyle({ ...base, category: "drinks" }).category).toBe("drinks");
    expect(parseStyle({ ...base, category: "nonsense" }).category).toBe("lifestyle");
  });

  it("knows a picture under any pin", () => {
    expect(pictureSig("https://i.pinimg.com/736x/39/5c/39/395c39e081a60ee237f7c302eeed5337.jpg")).toBe("395c39e081a60ee237f7c302eeed5337");
    expect(pictureSig("https://i.pinimg.com/originals/39/5c/39/395c39e081a60ee237f7c302eeed5337.png")).toBe("395c39e081a60ee237f7c302eeed5337");
  });

  it("knows the season's words for the daily search", () => {
    expect(seasonWords(new Date(Date.UTC(2026, 6, 10)))).toContain("summer");
    expect(seasonWords(new Date(Date.UTC(2026, 1, 20)))).toContain("valentine");
    // 1 Ramadan 1448 falls in February 2027.
    expect(seasonWords(new Date(Date.UTC(2027, 1, 15)))).toContain("ramadan");
  });
});

describe("the Grids shelf", () => {
  it("keeps only real feeds of six tiles or more", () => {
    const base = { keep: true, score: 8, title: "Sunlit Pastel Cafe", tags: "pastel", tiles: 9, prompt: "p".repeat(80) };
    expect(parseGridStyle(base).keep).toBe(true);
    expect(parseGridStyle({ ...base, tiles: 3 }).keep).toBe(false);
    expect(parseGridStyle({ ...base, score: 6 }).keep).toBe(false);
    expect(parseGridStyle({ ...base, keep: false }).keep).toBe(false);
  });
  it("gives the month one post per tile", () => {
    expect(gridPostCount(9, 12)).toBe(9);
    expect(gridPostCount(0, 12)).toBe(12);
    expect(gridPostCount(48, 12)).toBe(30);
  });
  it("reads a feed's world and its rhythm for any brand", () => {
    const ins = gridStyleInstruction("");
    expect(ins).toContain("rows of three");
    expect(ins).toContain("tile by tile");
    expect(ins).toContain("never a brand name");
  });
});

describe("following a grid tile by tile", () => {
  it("reads a tile and lays its words out like the tile", () => {
    const spec = tileSpecOf({ kind: "text", items: "", background: "cream paper #f3ece0", text: { position: "center", align: "left", size: "huge", color: "#1a1a1a", style: "bold serif" } })!;
    expect(spec.kind).toBe("text");
    const o = overlayFromTile(spec.text, spec.kind);
    expect(o.ov).toMatchObject({ position: "center", align: "left", scale: 1.8, fade: false });
    expect(tileSpecOf({ kind: "nonsense" as never })).toBeUndefined();
    expect(overlayFromTile({ position: "none", align: "center", size: "small", color: "", style: "" }, "product")).toEqual({ overlay: false });
  });
  it("tells a plain background from a textured one", () => {
    expect(TEXTURED_BACKGROUND.test("cream paper #f3ece0")).toBe(true);
    expect(TEXTURED_BACKGROUND.test("solid navy #0b2a4a")).toBe(false);
    expect(hexIn("solid navy #0b2a4a", "#ffffff")).toBe("#0b2a4a");
  });
  it("paints only the background of a textured typographic tile", () => {
    const p = buildPostPrompt({ post: true, index: 1, type: "quote", title: "T", brief: "B", palette: [], style: "", theme: "", format: "4:5", ref: null, refIsSource: true, hasProduct: false, design: "background", shot: "white marble" });
    expect(p).toContain("THE BACKGROUND: white marble");
    expect(p).toContain("NOTHING ELSE");
    expect(p).not.toContain("PRODUCT TRUTH");
  });
  it("flags a post that drifts from its tile", () => {
    const flags = parsePostReview({ productSame: true, productIssue: "", sizeRight: true, invented: "", text: "", bag: false, foreign: [], people: "", tile: "a drink tile shows a box" }, { products: 1, tile: "Tile 2: a drink" });
    expect(flags.map((f) => f.kind)).toEqual(["tile"]);
  });
});
