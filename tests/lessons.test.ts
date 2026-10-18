import { describe, expect, it } from "vitest";
import { castLook, childOf } from "../shared/cast";
import { buildPostPrompt, photoRules, withoutWordsSentences, type PostBrief } from "../shared/posts";
import { lessonLine } from "../shared/qa";

describe("the words of a design never reach the picture", () => {
  it("drops headline and swipe sentences from a brief or a shot", () => {
    expect(
      withoutWordsSentences(
        "Kinan leans forward against a white wall with black paint splatters, wearing the light grey 'BORN TO PARTY' sweatshirt. The lighting is studio-bright, and the headline 'Be Silly.' is centered over the roller-skating cake graphic.",
      ),
    ).toBe("Kinan leans forward against a white wall with black paint splatters, wearing the light grey 'BORN TO PARTY' sweatshirt.");
    expect(withoutWordsSentences("He wears a red paper cape. The headline is centered across his chest. The mood is heroic.")).toBe(
      "He wears a red paper cape. The mood is heroic.",
    );
  });
  it("keeps caption, language and swipe rules out of the photograph's client rules", () => {
    expect(
      photoRules(
        "Use paper-cutout digital elements for a 'scrapbook' look.\nAlways include a 'Swipe' indicator for carousels.\nAvoid overly formal MSA; stick to friendly Levantine.\nKeep backgrounds uncluttered.",
      ),
    ).toBe("Use paper-cutout digital elements for a 'scrapbook' look.\nKeep backgrounds uncluttered.");
  });
});

describe("a child in the designer's words wins over the adult gender", () => {
  it("reads girl, boy and child", () => {
    expect(childOf("6 years old little girl with happy cute face")).toBe("girl");
    expect(childOf("8 years boy")).toBe("boy");
    expect(childOf("a 4 year old kid")).toBe("child");
    expect(childOf("tall man with a beard")).toBe("");
  });
  it("describes a girl saved as a man as a girl, without the man's dress rules", () => {
    const look = castLook({ description: "6 years old little girl with happy cute face", gender: "man" });
    expect(look).toContain("a little girl (child model)");
    expect(look).not.toContain("a man");
    expect(look).not.toContain("never wears a headscarf");
    expect(castLook({ description: "8 years boy", gender: "man" })).toContain("a little boy (child model)");
    expect(castLook({ description: "tall, calm", gender: "man" })).toBe("a man; tall, calm; never wears a headscarf, a hijab, a veil, a dress or a skirt");
  });
});

describe("lessons from earlier pictures", () => {
  it("words a review finding as a rule", () => {
    expect(lessonLine("text", 'Writing in the picture: "BE SILLY.", "Swipe ->"')).toMatch(/^No writing: an earlier picture carried "BE SILLY\.", "Swipe ->"\./);
    expect(lessonLine("ailook", "Looks AI-made: The child has airbrushed skin.")).toContain("an earlier picture the child has airbrushed skin");
    expect(lessonLine("people", "The post shows a young boy instead of a 6-year-old girl.")).toContain("a young boy instead of a 6-year-old girl");
  });
  it("puts the lessons and the children rule into the prompt", () => {
    const b: PostBrief = {
      post: true,
      take: 1,
      index: 1,
      type: "lifestyle",
      title: "Silly Party",
      brief: "Kinan stands by a wall. The headline is centered over the sweatshirt graphic.",
      palette: [],
      style: "",
      theme: "",
      format: "4:5",
      hasProduct: true,
      ambassadors: [{ name: "Kinan", description: "a little boy (child model); 8 years boy", key: "k" }],
      lessons: [lessonLine("text", 'Writing in the picture: "Swipe ->"')],
    } as unknown as PostBrief;
    const prompt = buildPostPrompt(b);
    expect(prompt).toContain("MISTAKES SEEN IN EARLIER PICTURES FOR THIS CLIENT");
    expect(prompt).toContain('- No writing: an earlier picture carried "Swipe ->"');
    expect(prompt).toContain("CHILDREN: the child looks like a real photographed child");
    expect(prompt).not.toContain("The headline is centered");
  });
});

describe("the gate before paying", () => {
  it("takes the words to draw, the bag and the card out of the idea and the shot, and says so", async () => {
    const { gatePostText } = await import("../shared/posts");
    const g = gatePostText({
      brief: "Kinan stands by a white wall. The headline is centered over the sweatshirt graphic.",
      scene: "Kinan leans forward in the grey sweatshirt. The headline 'Be Silly.' is centered over the graphic. A paper bag stands beside him.",
    });
    expect(g.brief).toBe("Kinan stands by a white wall.");
    expect(g.scene).toBe("Kinan leans forward in the grey sweatshirt.");
    expect(g.notes).toEqual(['took the words to draw out of the idea', 'took the words to draw out of the shot ("Be Silly.")', "took the bag or carrier out of the shot"]);
    expect(gatePostText({ brief: "A girl holds the box level with both hands." }).notes).toEqual([]);
  });
});

describe("a back print stays on the back", () => {
  it("adds the rule only when a product's description puts the graphic on the back", async () => {
    const { backPrintRule } = await import("../shared/posts");
    expect(backPrintRule(['A light grey toddler sweatshirt with a cake character and the text "BORN TO PARTY" printed on the back.'])).toContain("BACK PRINT");
    expect(backPrintRule(["A brown sweatshirt with 'born to brunch' across the back", ""])).toContain("seen from behind");
    expect(backPrintRule(["A red sweatshirt with white 'LET'S GET COZY' text on the chest."])).toBe("");
  });
});

describe("a fresh take puts its findings first and keeps the children", () => {
  it("places NEW TAKE right after the brief and forbids adults when every ambassador is a child", async () => {
    const { buildPostPrompt, FRESH_TAKE } = await import("../shared/posts");
    const b = {
      post: true, take: 1, index: 8, type: "lifestyle", title: "Garden", brief: "Kinan and Tulay stand in a plush garden.",
      palette: [], style: "", theme: "", format: "4:5", hasProduct: true,
      ambassadors: [
        { name: "kinan", description: "a little boy (child model); 8 years boy", key: "k" },
        { name: "tulay", description: "a little girl (child model); 6 years old", key: "t" },
      ],
    } as unknown as import("../shared/posts").PostBrief;
    const prompt = buildPostPrompt(b, `${FRESH_TAKE}Make the product exactly as in its photo (the print moved to the front).`);
    expect(prompt).toContain("ALL THE AMBASSADORS ARE CHILDREN");
    expect(prompt.indexOf("NEW TAKE:")).toBeGreaterThan(prompt.indexOf("POST (Lifestyle)"));
    expect(prompt.indexOf("NEW TAKE:")).toBeLessThan(prompt.indexOf("PRODUCT TRUTH"));
  });
});

describe("the preflight before paying", () => {
  it("reads the art director's answer and keeps only a real rewrite", async () => {
    const { parsePreflight, preflightInstruction } = await import("../shared/qa");
    const pf = parsePreflight({ ok: false, problems: ["The reference shows adults; the ambassadors are children.", "none"], scene: "short", dropReference: true, note: "Leave the reference out." });
    expect(pf).toMatchObject({ ok: false, problems: ["The reference shows adults; the ambassadors are children."], scene: "", dropReference: true });
    expect(parsePreflight({ ok: true, problems: [], scene: "", dropReference: false, note: "" })?.ok).toBe(true);
    const text = preflightInstruction({ client: "Qamari", scene: "Kinan stands in a plush garden.", products: ["grey sweatshirt, print on the back"], people: ["kinan (a little boy)"], reference: "style", lessons: ["No bags"] });
    expect(text).toContain("children stay children");
    expect(text).toContain("THE ATTACHED IMAGE is the style the designer picked");
  });
  it("leaves the style image out of the prompt's numbering when it is not attached", async () => {
    const { buildPostPrompt } = await import("../shared/posts");
    const base = { post: true, take: 1, index: 1, type: "lifestyle", title: "T", brief: "A child in a garden.", palette: [], style: "", theme: "", format: "4:5", hasProduct: true, styleKey: "styles/x.jpg", shot: "A plush garden set, eye level, soft light.", ambassadors: [{ name: "kinan", description: "a little boy (child model)", key: "k" }] };
    const withImage = buildPostPrompt(base as never);
    const without = buildPostPrompt({ ...base, noRefImage: true } as never);
    expect(withImage).toContain("Image 3 is the style the designer picked");
    expect(without).not.toContain("Image 3 is the style");
    expect(without).toContain("THE PHOTOGRAPH (the picked style written for this product");
  });
  it("tells every writer the client's lessons", async () => {
    const { ideasInstruction } = await import("../shared/posts");
    const { adaptShotsInstruction } = await import("../shared/brief");
    const { adaptStyleInstruction } = await import("../shared/styles");
    const lessons = ["No bags: an earlier picture put the product in a bag."];
    expect(adaptShotsInstruction({ shots: ["a"], posts: [], palette: [], lessons })).toContain("MISTAKES SEEN IN THIS CLIENT'S EARLIER PICTURES");
    expect(adaptStyleInstruction({ style: { title: "Pour", kind: "product", prompt: "x" }, product: "sweatshirt", post: { type: "Lifestyle", headline: "", brief: "" }, brand: { name: "Q" }, palette: [], people: [], lessons })).toContain("No bags");
    expect(adaptStyleInstruction({ style: { title: "Pour", kind: "product", prompt: "x" }, product: "sweatshirt", post: { type: "Lifestyle", headline: "", brief: "" }, brand: { name: "Q" }, palette: [], people: [] })).toContain("CANNOT HAPPEN WITH THIS PRODUCT");
    expect(ideasInstruction({ clientName: "Q", tone: "", dos: "", donts: "", language: "en", palette: [], style: "", themeTitle: "", themeDirection: "", themeLibrary: "", props: "", products: [], productNotes: {}, month: "2026-10", count: 1, lessons } as never)).toContain("No bags");
  });
});

describe("a clothing brand dresses its people", () => {
  it("tells the engine that every ambassador wears a product, and the idea writer too", async () => {
    const { buildPostPrompt, ideasInstruction, sellsClothing } = await import("../shared/posts");
    expect(sellsClothing(["Off-white toddler sweatshirt with red text"])).toBe(true);
    expect(sellsClothing(["A box of baklava"])).toBe(false);
    const b = {
      post: true, take: 1, index: 2, type: "lifestyle", title: "T", brief: "Three friends.", palette: [], style: "", theme: "", format: "4:5", hasProduct: true,
      product: "Off-white toddler sweatshirt with red 'Mini MAMA' text on the chest",
      extraProducts: [{ name: "jeans", note: "pale blue cargo jeans", key: "j" }],
      ambassadors: [{ name: "kinan", description: "a little boy", key: "k" }, { name: "tulay", description: "a little girl", key: "t" }, { name: "ahmad", description: "a little girl", key: "a" }],
    };
    const prompt = buildPostPrompt(b as never);
    expect(prompt).toContain("DRESSED IN THE BRAND");
    expect(prompt).toContain("There are more people than garments");
    const ideas = ideasInstruction({ clientName: "Q", tone: "", dos: "", donts: "", language: "en", palette: [], style: "", themeTitle: "", themeDirection: "", themeLibrary: "", props: "", products: ["s"], productNotes: { s: "grey sweatshirt" }, month: "2026-10", count: 1, ambassadors: [{ name: "kinan", description: "a boy" }] } as never);
    expect(ideas).toContain("A CLOTHING BRAND: every person in a picture wears one of the month's products");
  });
});

describe("a print stays on the side its photo shows", () => {
  it("mirrors the rule for a chest print and says nothing when the side is unknown", async () => {
    const { backPrintRule } = await import("../shared/posts");
    expect(backPrintRule(['Off-white toddler sweatshirt with red "Mini MAMA" text on the chest.'])).toContain("FRONT PRINT");
    expect(backPrintRule(['Off-white toddler sweatshirt featuring red "Mini MAMA" text, about 40 cm long.'])).toBe("");
  });
});
