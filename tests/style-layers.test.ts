/**
 * Designed styles, the apply side (shared/style-layers.ts): a pin's design becomes the post's own
 * layers in the client's fonts and colours with the post's words (a huge rotated word, a vertical
 * line, an outlined label), or an Instagram post mockup rebuilt with the client's own account.
 * Arabic is never set on its side. The engine prompt keeps the design's space clean.
 */
import { describe, expect, it } from "vitest";
import {
  ICONS,
  INSTAGRAM_GROUP,
  TYPOGRAPHY_GROUP,
  compactCount,
  layersFromStyleDesign,
  shorten,
  svgDataUrl,
  type StyleLayerContext,
} from "../shared/style-layers";
import type { StyleDesign } from "../shared/style-design";
import {
  TEXT_DESIGN_SCHEMA,
  isImageLayer,
  isLogoLayer,
  isShapeLayer,
  isTextLayer,
  wordsOf,
  type ImageLayer,
  type ShapeLayer,
  type TextLayer,
} from "../shared/layers";
import { buildPostPrompt, type PostBrief } from "../shared/posts";
import { adaptStyleInstruction } from "../shared/styles";

const brand = {
  colors: [
    { name: "Navy", hex: "#0b1f6b" },
    { name: "Lime", hex: "#bbf714" },
  ],
  fonts: { headline: "Graphic School", body: "Almarai" },
  fontFiles: [{ id: "f1", name: "Graphic School" }],
};

const ctx = (over: Partial<StyleLayerContext> = {}): StyleLayerContext => ({
  headline: "Brigadeiro season",
  subline: "Handmade in Amman",
  caption:
    "Our brigadeiro pour is back for the season. Warm chocolate, slow pour, the whole box gone in a minute. Order yours before Sunday and taste why everyone is talking about it.",
  hashtags: "#habibah #brigadeiro #amman",
  handle: "habibah",
  accountName: "Habibah Sweets",
  avatarSrc: "/api/studio/clients/c1/logo?v=7",
  hasLogo: true,
  likes: 189542,
  comments: 328000,
  brand,
  language: "en",
  palette: ["#f3e9d2"],
  ratio: 1.25,
  ...over,
});

const text = (
  role: StyleDesign["texts"][number]["role"],
  over: Partial<StyleDesign["texts"][number]> = {},
): StyleDesign["texts"][number] => ({
  role,
  x: 0.1,
  y: 0.1,
  w: 0.5,
  h: 0.1,
  rotate: 0,
  weight: "regular",
  case: "none",
  tone: "light",
  align: "center",
  decoration: "none",
  behind: false,
  sample: "",
  ...over,
});

/** The brigadeiro pour pin: a huge word read bottom to top along the pour, a thin vertical line, a tag in an oval. */
const typography: StyleDesign = {
  kind: ["typography"],
  texts: [
    text("big", {
      x: 0.08,
      y: 0.1,
      w: 0.22,
      h: 0.8,
      rotate: -90,
      weight: "heavy",
      case: "upper",
      behind: true,
      sample: "BRIGADEIRO",
    }),
    text("line", {
      x: 0.9,
      y: 0.3,
      w: 0.04,
      h: 0.3,
      rotate: 90,
      case: "upper",
      sample: "HANDMADE IN BRAZIL",
    }),
    text("label", {
      x: 0.6,
      y: 0.85,
      w: 0.3,
      h: 0.07,
      case: "upper",
      decoration: "oval",
      sample: "new flavour",
    }),
  ],
  mockup: null,
  space: "the left third of the frame beside the pour",
  accent: "light",
};

/** An Instagram post mockup pin: the white UI panel under the photo with every part. */
const mockup: StyleDesign = {
  kind: ["mockup"],
  texts: [],
  mockup: {
    ui: "instagram-post",
    panel: { x: 0.05, y: 0.55, w: 0.9, h: 0.4, radius: 0.03, tone: "light" },
    parts: {
      actions: true,
      likes: true,
      caption: true,
      hashtags: true,
      account: true,
      comments: true,
      logo: true,
    },
    logo: { x: 0.75, y: 0.05, w: 0.2 },
  },
  space: "the lower half of the frame",
  accent: "brand",
};

const texts = (d: { layers: unknown[] }) =>
  d.layers.filter((l) => isTextLayer(l as TextLayer)) as TextLayer[];
const named = <T>(d: { layers: { name?: string }[] }, name: string) =>
  d.layers.find((l) => l.name === name) as T | undefined;

describe("typography from a designed pin", () => {
  it("sets the hero word huge, rotated along the pour, in the headline font, uppercase, grouped", () => {
    const d = layersFromStyleDesign(typography, ctx());
    expect(TEXT_DESIGN_SCHEMA.safeParse(d).success).toBe(true);
    const big = named<TextLayer>(d, "Big word (behind the product on the pin)")!;
    expect(big).toBeTruthy();
    // A one-word hero on the pin takes the first word of the headline; the word is the post's, never the pin's.
    expect(big.text).toBe("Brigadeiro");
    expect(big.font).toBe("Graphic School");
    expect(big.weight).toBe(800);
    expect(big.transform).toBe("upper");
    expect(big.rotate).toBe(-90);
    expect(big.fill).toEqual({ type: "solid", color: "#ffffff" });
    expect(big.group).toBe(TYPOGRAPHY_GROUP);
    expect(big.autoSize).toBe(false);
    expect(big.fit).toBe(true);
    // The layer's own box is the visible box turned on its side, around the same centre.
    expect(big.w).toBeCloseTo(0.8 * 1.25, 3);
    expect(big.h!).toBeCloseTo(0.22 / 1.25, 3);
    expect(big.x + big.w / 2).toBeCloseTo(0.08 + 0.22 / 2, 3);
    expect(big.y + big.h! / 2).toBeCloseTo(0.1 + 0.8 / 2, 3);
    expect(big.size).toBeGreaterThan(0.05);
    expect(big.size).toBeLessThanOrEqual(0.2);
    // The hero word is not the whole headline, so the plan's headline is not tied to it.
    expect(big.role).toBeUndefined();
  });

  it("draws the small vertical line in the body font and the label inside a thin outlined oval", () => {
    const d = layersFromStyleDesign(typography, ctx());
    const line = named<TextLayer>(d, "Second line")!;
    expect(line.text).toBe("Handmade in Amman");
    expect(line.role).toBe("subline");
    expect(line.font).toBe("Almarai");
    expect(line.rotate).toBe(90);
    expect(line.w).toBeCloseTo(0.3 * 1.25, 3);
    expect(line.transform).toBe("upper");
    const oval = named<ShapeLayer>(d, "Oval outline")!;
    const label = named<TextLayer>(d, "Label")!;
    expect(oval.shape).toBe("ellipse");
    expect(oval.fill).toEqual({ type: "solid", color: "#ffffff", alpha: 0 });
    expect(oval.stroke).toEqual({ color: "#ffffff", width: 0.0025 });
    expect(oval).toMatchObject({ x: 0.6, y: 0.85, w: 0.3, h: 0.07 });
    // The oval is drawn under its words.
    expect(d.layers.indexOf(oval)).toBeLessThan(d.layers.indexOf(label));
    expect(label.text).toBe("Handmade in Amman");
    expect(label.group).toBe(TYPOGRAPHY_GROUP);
  });

  it("takes the whole headline when the pin's hero is a phrase, and ties it to the plan's headline", () => {
    const d = layersFromStyleDesign(
      {
        ...typography,
        texts: [text("big", { sample: "SLOW POUR SUNDAYS", rotate: 0, w: 0.8, h: 0.3 })],
      },
      ctx(),
    );
    const big = texts(d)[0];
    expect(big.text).toBe("Brigadeiro season");
    expect(big.role).toBe("headline");
    expect(wordsOf(d).headline).toBe("Brigadeiro season");
  });

  it("gives a pill, a box and an underline their decoration, and the brand colour only where it reads", () => {
    const pill = layersFromStyleDesign(
      {
        ...typography,
        accent: "brand",
        texts: [text("label", { decoration: "pill", tone: "dark" })],
      },
      ctx(),
    );
    const p = texts(pill)[0];
    expect(p.background).toMatchObject({ color: "#0b1f6b", alpha: 1, radius: 2 });
    expect(p.fill).toEqual({ type: "solid", color: "#ffffff" });
    const box = layersFromStyleDesign(
      { ...typography, texts: [text("label", { decoration: "box", tone: "dark" })] },
      ctx(),
    );
    expect(box.layers.filter(isShapeLayer).map((l) => l.shape)).toEqual(["rect"]);
    expect(texts(box)[0].fill).toEqual({ type: "solid", color: "#111111" });
    const under = layersFromStyleDesign(
      { ...typography, texts: [text("label", { decoration: "underline" })] },
      ctx(),
    );
    const rule = under.layers.find(isShapeLayer)!;
    expect(rule.shape).toBe("line");
    expect(rule.y).toBeGreaterThan(0.1);
    // Navy on a dark ground does not read: the letters stay white even with the brand accent.
    const dark = layersFromStyleDesign(
      { ...typography, accent: "brand", texts: [text("big", { tone: "light", sample: "X" })] },
      ctx(),
    );
    expect(texts(dark)[0].fill).toEqual({ type: "solid", color: "#ffffff" });
    // On a light ground, navy letters read: the brand colour is taken.
    const light = layersFromStyleDesign(
      { ...typography, accent: "brand", texts: [text("big", { tone: "dark", sample: "X" })] },
      ctx(),
    );
    expect(texts(light)[0].fill).toEqual({ type: "solid", color: "#0b1f6b" });
  });

  it("shortens the caption to its box, writes the handle with an at sign, and stands the brand's name in for an empty headline", () => {
    const d = layersFromStyleDesign(
      {
        ...typography,
        texts: [
          text("caption", { w: 0.4, h: 0.08 }),
          text("handle", { sample: "@brand" }),
          text("big", { sample: "X" }),
        ],
      },
      ctx({ headline: "", subline: "" }),
    );
    const cap = named<TextLayer>(d, "Caption")!;
    expect(cap.text.length).toBeLessThan(ctx().caption.length);
    expect(cap.text.endsWith("…")).toBe(true);
    expect(named<TextLayer>(d, "Handle")!.text).toBe("@habibah");
    expect(named<TextLayer>(d, "Big word")!.text).toBe("Habibah");
  });

  it("never sets Arabic on its side: a quarter turn stays horizontal in the same box, reading right to left", () => {
    const d = layersFromStyleDesign(
      typography,
      ctx({ headline: "موسم البريغاديرو", subline: "صُنع بحب في عمّان", language: "ar" }),
    );
    const big = texts(d).find((l) => l.text === "موسم")!;
    expect(big).toBeTruthy();
    expect(big.rotate).toBeUndefined();
    expect(big.direction).toBe("rtl");
    expect(big.transform).toBeUndefined();
    expect(big).toMatchObject({ x: 0.08, y: 0.1, w: 0.22, h: 0.8 });
    const line = named<TextLayer>(d, "Second line")!;
    expect(line.rotate).toBeUndefined();
    expect(line).toMatchObject({ x: 0.9, y: 0.3, w: 0.04, h: 0.3 });
    // A diagonal is fine for Arabic.
    const tilted = layersFromStyleDesign(
      { ...typography, texts: [text("big", { rotate: -20, sample: "X" })] },
      ctx({ headline: "موسم البريغاديرو", language: "ar" }),
    );
    expect(texts(tilted)[0].rotate).toBe(-20);
    // An Arabic client whose headline is English still gets the turn.
    const latin = layersFromStyleDesign(typography, ctx({ language: "ar" }));
    expect(texts(latin)[0].rotate).toBe(-90);
  });

  it("is deterministic: the same design and words give the same layers", () => {
    expect(layersFromStyleDesign(typography, ctx())).toEqual(
      layersFromStyleDesign(typography, ctx()),
    );
  });
});

describe("an Instagram post mockup from a designed pin", () => {
  it("rebuilds the frame with the client's own account: panel, icons, likes, caption, hashtags, account row, comments pill, logo", () => {
    const d = layersFromStyleDesign(mockup, ctx());
    expect(TEXT_DESIGN_SCHEMA.safeParse(d).success).toBe(true);
    expect(d.layers.every((l) => l.group === INSTAGRAM_GROUP)).toBe(true);
    const panel = d.layers[0] as ShapeLayer;
    expect(panel).toMatchObject({
      type: "shape",
      shape: "rect",
      x: 0.05,
      y: 0.55,
      w: 0.9,
      h: 0.4,
      radius: 0.03,
      fill: { type: "solid", color: "#ffffff" },
    });
    const icons = d.layers
      .filter(isImageLayer)
      .filter((l) => l.src.startsWith("data:image/svg+xml"));
    expect(icons.map((l) => l.name)).toEqual(["Like", "Comment", "Share", "Save", "Comment icon"]);
    // The heart is filled in the brand's main colour; every icon stays small and inside the panel.
    expect(icons[0].src).toContain("%230b1f6b");
    for (const i of icons.slice(0, 4)) {
      expect(i.w).toBeCloseTo(0.05, 3);
      expect(i.src.length).toBeLessThanOrEqual(600);
      expect(i.x).toBeGreaterThanOrEqual(0.05);
      expect(i.x + i.w).toBeLessThanOrEqual(0.95);
    }
    expect(icons[3].x).toBeGreaterThan(icons[2].x + 0.3);
    const likes = named<TextLayer>(d, "Likes")!;
    expect(likes.text).toBe("189,542 likes");
    expect(likes.weight).toBe(700);
    expect(likes.font).toBe("Almarai");
    const caption = named<TextLayer>(d, "Caption")!;
    expect(caption.text.startsWith("habibah Our brigadeiro pour")).toBe(true);
    expect(caption.runs).toEqual([{ from: 0, to: 7, style: { bold: true, color: "#0b1f6b" } }]);
    const tags = named<TextLayer>(d, "Hashtags")!;
    expect(tags.text).toBe("#habibah #brigadeiro #amman");
    expect(tags.fill).toEqual({ type: "solid", color: "#0b1f6b" });
    const avatar = named<ImageLayer>(d, "Profile picture")!;
    expect(avatar).toMatchObject({
      type: "image",
      src: "/api/studio/clients/c1/logo?v=7",
      fit: "cover",
      source: "brand",
    });
    expect(avatar.radius).toBeCloseTo(avatar.w / 2, 4);
    expect(named<TextLayer>(d, "Handle")!.text).toBe("habibah");
    expect(named<TextLayer>(d, "Account name")!.text).toBe("Habibah Sweets");
    const pill = named<ShapeLayer>(d, "Comments pill")!;
    expect(pill).toMatchObject({
      type: "shape",
      shape: "rect",
      fill: { type: "solid", color: "#efefef", alpha: 1 },
    });
    expect(named<TextLayer>(d, "Comments")!.text).toBe("328K comments");
    const logo = d.layers.find(isLogoLayer)!;
    expect(logo).toMatchObject({ x: 0.75, y: 0.05, w: 0.2, name: "Logo" });
    // Every row sits inside the panel.
    for (const l of texts(d)) {
      expect(l.y).toBeGreaterThanOrEqual(0.55);
      expect(l.y).toBeLessThanOrEqual(0.95);
    }
    // The mockup's chrome never becomes the post's headline when the Text studio saves.
    expect(wordsOf(d)).toEqual({ headline: "", subline: "" });
  });

  it("leaves out the parts the pin does not show, falls back without a logo, and floats white on the photo without a panel", () => {
    const some: StyleDesign = {
      ...mockup,
      mockup: {
        ...mockup.mockup!,
        panel: null,
        parts: {
          actions: true,
          likes: false,
          caption: true,
          hashtags: false,
          account: true,
          comments: false,
          logo: true,
        },
      },
    };
    const d = layersFromStyleDesign(
      some,
      ctx({ avatarSrc: null, hasLogo: false, accountName: "Zain" }),
    );
    expect(d.layers.some(isLogoLayer)).toBe(false);
    expect(named<TextLayer>(d, "Likes")).toBeUndefined();
    expect(named<TextLayer>(d, "Hashtags")).toBeUndefined();
    expect(named<ShapeLayer>(d, "Comments pill")).toBeUndefined();
    expect(named<ShapeLayer>(d, "Instagram panel")).toBeUndefined();
    // No picture: a brand-colour disc with the name's initial stands in.
    expect(named<ShapeLayer>(d, "Profile picture")).toMatchObject({
      type: "shape",
      shape: "ellipse",
      fill: { type: "solid", color: "#0b1f6b" },
    });
    expect(named<TextLayer>(d, "Initial")!.text).toBe("Z");
    // Floating on the photograph, the UI is white and the heart Instagram red when the design is not brand-accented.
    expect(named<TextLayer>(d, "Handle")!.fill).toEqual({ type: "solid", color: "#ffffff" });
    const red = layersFromStyleDesign({ ...some, accent: "light" }, ctx());
    expect(named<ImageLayer>(red, "Like")!.src).toContain("%23ed4956");
    // A logo part without a place on the pin goes to the top-right corner.
    const noPlace = layersFromStyleDesign(
      { ...mockup, mockup: { ...mockup.mockup!, logo: undefined } },
      ctx(),
    );
    expect(noPlace.layers.find(isLogoLayer)).toMatchObject({ x: 0.78, y: 0.04, w: 0.18 });
  });

  it("writes both the typography and the mockup when the pin has both, within the design's layer limit", () => {
    const both: StyleDesign = {
      ...mockup,
      kind: ["typography", "mockup"],
      texts: typography.texts,
    };
    const d = layersFromStyleDesign(both, ctx());
    expect(TEXT_DESIGN_SCHEMA.safeParse(d).success).toBe(true);
    expect(d.layers.filter((l) => l.group === INSTAGRAM_GROUP).length).toBeGreaterThan(8);
    expect(d.layers.filter((l) => l.group === TYPOGRAPHY_GROUP).length).toBe(4);
    expect(new Set(d.layers.map((l) => l.id)).size).toBe(d.layers.length);
  });

  it("formats counts and inline icons the way the renderer loads them", () => {
    expect(compactCount(328000)).toBe("328K");
    expect(compactCount(1250)).toBe("1.3K");
    expect(compactCount(12500)).toBe("13K");
    expect(compactCount(1_200_000)).toBe("1.2M");
    expect(compactCount(412)).toBe("412");
    expect(
      svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M0 0"/></svg>'),
    ).toBe(
      "data:image/svg+xml;utf8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3Cpath%20fill='%23fff'%20d='M0%200'/%3E%3C/svg%3E",
    );
    expect(
      decodeURIComponent(ICONS.bookmark("#262626").slice("data:image/svg+xml;utf8,".length)),
    ).toContain("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>");
    expect(shorten("one two three four five", 12)).toBe("one two…");
    expect(shorten("short", 12)).toBe("short");
  });
});

describe("the engine prompt of a designed style", () => {
  const brief: PostBrief = {
    post: true,
    index: 1,
    type: "lifestyle",
    title: "T",
    brief: "B",
    palette: [],
    style: "",
    theme: "",
    format: "4:5",
    ref: null,
    refIsSource: false,
    hasProduct: true,
    styleKey: "styles/x.jpg",
    shot: "A slow chocolate pour over the box on a cream surface.",
  };

  it("asks for clean space where the words and the frame go, after the photograph, only for a designed style", () => {
    const p = buildPostPrompt({
      ...brief,
      designSpace: "the left third of the frame beside the pour",
    });
    expect(p).toContain(
      "CLEAN SPACE FOR THE DESIGN: the left third of the frame beside the pour. That area is plain backdrop or calm surface with no props, letters, panels, phone interface, icons or frames anywhere in the picture: the words and the Instagram frame are added afterwards by the designer.",
    );
    expect(p.indexOf("THE PHOTOGRAPH")).toBeLessThan(p.indexOf("CLEAN SPACE FOR THE DESIGN"));
    expect(buildPostPrompt(brief)).not.toContain("CLEAN SPACE");
    expect(buildPostPrompt({ ...brief, designSpace: "  " })).not.toContain("CLEAN SPACE");
  });

  it("tells the shot writer that the pin's words and frame are the studio's, not the photograph's", () => {
    const base = {
      style: { title: "Pour", kind: "product" as const, prompt: "x" },
      product: "a box of brigadeiro",
      post: { type: "Lifestyle", headline: "", brief: "" },
      brand: { name: "Q" },
      palette: [],
      people: [],
    };
    const both = adaptStyleInstruction({
      ...base,
      design: { space: "the left third", mockup: true },
    });
    expect(both).toContain("THE PIN'S WORDS AND INSTAGRAM FRAME ARE NOT PART OF THE PHOTOGRAPH");
    expect(both).toContain("keep this space clean for them: the left third.");
    const words = adaptStyleInstruction({ ...base, design: { space: "", mockup: false } });
    expect(words).toContain("THE PIN'S WORDS ARE NOT PART OF THE PHOTOGRAPH");
    expect(words).toContain("the area where the pin sets its words");
    expect(adaptStyleInstruction(base)).not.toContain("NOT PART OF THE PHOTOGRAPH");
  });
});
