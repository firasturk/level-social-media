import { describe, expect, it } from "vitest";
import { castLook } from "@shared/cast";
import { fixNote, parsePostReview, postProblems, postReviewInstruction } from "@shared/qa";
import { buildPostPrompt, captionFromImageInstruction, parseCaption, type Post, type PostBrief } from "@shared/posts";
import { briefLines } from "@shared/brief";
import { testSize } from "@shared/pricing";
import { alphaFromBackground, composite, coverage, cutout, placement, plainBackground } from "../server/compose";

describe("structured ambassadors", () => {
  it("puts gender and dress into the look", () => {
    const man = castLook({ description: "thirties, short beard", gender: "man", modest: true });
    expect(man).toMatch(/^a man; thirties, short beard; never wears a headscarf/);
    expect(man).toContain("modest clothing");
    const lina = castLook({ description: "long dark hair", gender: "woman", modest: true, hijab: false });
    expect(lina).toContain("her hair uncovered (no hijab)");
    expect(lina).toContain("never bare shoulders");
    expect(castLook({ description: "x", gender: "woman", hijab: true })).toContain("always wears a hijab");
  });

  it("checks a man by his field and a modest look's clothes", () => {
    const post: Post = { index: 1, type: "lifestyle", title: "T", brief: "Omar in a long dress beside the table.", caption: "", hashtags: "", people: ["Omar", "Lina"], scene: "Lina in a sleeveless top holds the box." };
    const pr = postProblems(post, {
      products: [],
      cast: [
        { name: "Omar", description: "kind smile", gender: "man", modest: true },
        { name: "Lina", description: "warm", gender: "woman", modest: true },
      ],
      needsScene: true,
    });
    const t = pr.map((x) => x.text).join(" | ");
    expect(t).toContain("Omar (a man)");
    expect(t).toContain('"sleeveless" although Lina dresses modestly');
  });
});

describe("automatic review of a post image", () => {
  it("asks against the product photo and lists only real findings", () => {
    const ins = postReviewInstruction({ products: 1, productNotes: ["navy gift box"], type: "lifestyle", people: [] });
    expect(ins).toContain("Image 1 is the real product photo");
    expect(ins).toContain("Image 2 is the generated post");
    const flags = parsePostReview(
      { productSame: false, productIssue: "The box is red.", sizeRight: true, invented: "none", text: "", bag: true, foreign: ["a glass of juice"], people: "" },
      { products: 1 },
    );
    expect(flags.map((f) => f.kind)).toEqual(["product", "bag", "foreign"]);
    expect(fixNote(flags)).toContain("Remove the bag");
  });

  it("allows drinks for a café and on Coffee Day", () => {
    const raw = { productSame: true, productIssue: "", sizeRight: true, invented: "", text: "", bag: false, foreign: ["a coffee cup"], people: "" };
    expect(parsePostReview(raw, { products: 1, sellsDrinks: true })).toEqual([]);
    expect(parsePostReview(raw, { products: 1, coffeeDay: true })).toEqual([]);
  });
});

describe("test post size", () => {
  it("is 1K only when 1K is cheaper", () => {
    expect(testSize("gemini-3-pro-image", "2K")).toBe("2K");
    expect(testSize("gemini-3-pro-image", "4K")).toBe("1K");
    expect(testSize("gpt-image-2", "2K")).toBe("1K");
  });
});

describe("exact product mode", () => {
  const brief: PostBrief = {
    post: true, index: 1, type: "lifestyle", title: "Morning", brief: "Lina holds the box by the window.", palette: [], style: "", theme: "", format: "4:5",
    ref: "r1", refIsSource: true, hasProduct: false, product: "navy gift box with a gold lid", exact: { source: "s1" },
  };

  it("asks for an empty place, never for the product", () => {
    const p = buildPostPrompt(brief);
    expect(p).toContain("EMPTY PLACE FOR THE PRODUCT");
    expect(p).toContain("THE PRODUCT IS NOT IN THIS PICTURE");
    expect(p).toContain("FINAL CHECK");
    expect(p).not.toContain("navy gift box with a gold lid");
    expect(p).not.toContain("Image 1 is the product photo");
  });

  it("keeps the placed product on a revision", () => {
    const p = buildPostPrompt(brief, "Brighter", { revision: true });
    expect(p).toContain("keep it untouched, pixel for pixel");
    expect(p).not.toContain("EMPTY PLACE FOR THE PRODUCT");
  });

  it("cuts a product off a plain background and sets its exact pixels into the scene", () => {
    const W = 120;
    const H = 100;
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const inside = x >= 30 && x < 90 && y >= 20 && y < 80;
        px.set(inside ? [20, 30, 90, 255] : [250, 250, 250, 255], (y * W + x) * 4);
      }
    const img = { data: px, width: W, height: H };
    const bg = plainBackground(img);
    expect(bg).not.toBeNull();
    const alpha = alphaFromBackground(img, bg!);
    expect(coverage(alpha)).toBeGreaterThan(0.2);
    const cut = cutout(img, alpha);
    expect(cut.width).toBeLessThanOrEqual(60);
    const scene = { data: new Uint8Array(200 * 200 * 4).fill(200), width: 200, height: 200 };
    const at = placement([400, 300, 900, 700], scene, cut);
    expect(at.y + at.height).toBeLessThanOrEqual(180);
    // The product at its natural size keeps its own colour in its middle.
    const out = composite(scene, cut, { x: 50, y: 50 }, "left");
    const mid = ((50 + Math.floor(cut.height / 2)) * 200 + 50 + Math.floor(cut.width / 2)) * 4;
    // The product's own colour, toned at most a little toward the scene's light.
    [20, 30, 90].forEach((v, c) => expect(Math.abs(out.data[mid + c] - v)).toBeLessThanOrEqual(Math.ceil(v * 0.12) + 1));
    // The scene beside the product darkens where its shadow falls (light from the left).
    const right = ((50 + cut.height - 2) * 200 + 50 + cut.width + 2) * 4;
    expect(out.data[right]).toBeLessThan(200);
  });

  it("finds no plain background on a busy photo", () => {
    const W = 50;
    const px = new Uint8Array(W * W * 4);
    for (let i = 0; i < px.length; i += 4) px.set([(i * 37) % 255, (i * 91) % 255, (i * 13) % 255, 255], i);
    expect(plainBackground({ data: px, width: W, height: W })).toBeNull();
  });
});

describe("props the designer cleared", () => {
  const base: PostBrief = {
    post: true, index: 1, type: "lifestyle", title: "T", brief: "B", palette: ["Blue #0061ff", "Orange #e87a3e"], paletteChosen: true,
    style: "", theme: "", format: "4:5", ref: null, refIsSource: false, hasProduct: true,
  };
  it("asks for no decorations at all when the props are empty", () => {
    const p = buildPostPrompt(base);
    expect(p).toContain("PROPS: none this month");
    expect(p).not.toContain("go to the props");
  });
  it("keeps the props the designer wrote", () => {
    const p = buildPostPrompt({ ...base, props: "autumn leaves" });
    expect(p).toContain("the scene includes autumn leaves");
    expect(p).not.toContain("PROPS: none this month");
  });
});

describe("the ideas read only the screens before them", () => {
  it("leaves the shots reading out", () => {
    const at = 1;
    const lines = briefLines({ theme: { summary: "", points: [], logic: "Theme rule", at }, shots: { summary: "", points: [], logic: "Use cyan props", at } }, ["shots"]);
    expect(lines).toEqual(["Theme rule"]);
  });
});

describe("captions from the finished picture", () => {
  const post: Post = { index: 2, type: "lifestyle", title: "Lotus joy", brief: "B", caption: "لوتس ميلك شيك.. السعادة بكاسة.", hashtags: "", headline: "لوتس ميلك شيك", people: ["omar"], product: "Lotus milkshake" };
  it("asks for what the picture shows, in the client's voice, around the headline", () => {
    const ins = captionFromImageInstruction({ clientName: "Abu Saleh", tone: "playful Jordanian", language: "ar", post, products: [{ name: "Lotus milkshake", note: "a milkshake with biscuit crumbles" }] });
    expect(ins).toContain("from what the picture really shows");
    expect(ins).toContain("playful Jordanian");
    expect(ins).toContain("Arabic ONLY");
    expect(ins).toContain('HEADLINE ON THE IMAGE: "لوتس ميلك شيك"');
    expect(ins).toContain("never write their names");
    expect(ins).toContain("THE IDEA'S FIRST DRAFT");
  });
  it("keeps the caption short and the hashtags clean", () => {
    const r = parseCaption(JSON.stringify({ caption: "كاسة لوتس باردة بين إيديك #لوتس", hashtags: "لوتس, #ميلك_شيك #لوتس عمان" }));
    expect(r?.caption).toBe("كاسة لوتس باردة بين إيديك");
    expect(r?.hashtags).toBe("#لوتس #ميلك_شيك #عمان");
    expect(parseCaption("not json")).toBeNull();
  });
});
