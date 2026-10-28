import { describe, expect, it } from "vitest";
import { buildPostPrompt } from "../shared/posts";

/**
 * The prompt of a post made in a gallery style keeps the product's details (27 Oct): the month's
 * chosen palette no longer strips the colours out of the shot the style writer made for this product
 * ("pistachio-green drink ... pale and dark green swirls" stayed "pistachio- drink ... pale and
 * swirls"), and a drink "with calligraphy on the front" no longer gets the garment's FRONT PRINT rule.
 */
const base = {
  post: true,
  index: 4,
  type: "lifestyle",
  title: "Frosted Pistachio Star Close-Up",
  brief: "The pistachio drink, frosted, with silver stars in the slush.",
  palette: ["pale red #f3e9e8", "turquoise #63c7c9"],
  paletteChosen: true,
  style: "",
  theme: "",
  format: "4:5",
  hasProduct: true,
  product: "A pistachio-green drink in a clear plastic cup with a lid, striped in pale and dark green swirls, with turquoise Arabic calligraphy on the front; about 10 cm wide, 12 cm tall.",
  productNames: [],
  styleKey: "styles/starry.jpg",
  shot: "Low-angle, extreme close-up of one pistachio-green drink in its real clear plastic cup with lid, striped in pale and dark green swirls with turquoise Arabic calligraphy on the front. Behind it a soft sky in pale red #f3e9e8.",
} as unknown as Parameters<typeof buildPostPrompt>[0];

describe("a post made in a style keeps its product's details", () => {
  it("keeps the colours of the style-written shot when the month has chosen colours", () => {
    const prompt = buildPostPrompt(base);
    expect(prompt).toContain("pistachio-green drink in its real clear plastic cup");
    expect(prompt).toContain("pale and dark green swirls with turquoise Arabic calligraphy");
  });
  it("lets the style's own colours lead instead of the month's palette", () => {
    const prompt = buildPostPrompt(base);
    expect(prompt).toContain("the picked style's own colours lead this picture");
    expect(prompt).not.toContain("chosen by the designer for this month");
    expect(prompt).not.toContain("BACKGROUND: the backdrop");
  });
  it("gives the garment print rule to garments only", () => {
    expect(buildPostPrompt(base)).not.toContain("FRONT PRINT");
    const tee = buildPostPrompt({ ...base, product: "A white cotton t-shirt with a red logo printed on the chest." } as never);
    expect(tee).toContain("FRONT PRINT");
  });
});

/**
 * Post 10 of Abu Saleh (28 Oct): a card turned into a post, then given a style, kept coming out as
 * a cork pedestal. Its title had been written from the wrong picture and fed back into the prompt;
 * the preflight had left the style picture out, after which the product rule named "Image 1" as the
 * product that never appears; and the idea lessons described the wrong picture to the engine.
 */
describe("a styled post is steered by its style alone", () => {
  it("leaves the title out of the prompt: the shot is the picture", () => {
    const prompt = buildPostPrompt({ ...base, title: "Cork Pedestal Spicy Warmth" } as typeof base);
    expect(prompt).not.toContain("Cork Pedestal");
    expect(prompt).toContain("in the picked style.\nTHE PHOTOGRAPH");
  });
  it("numbers the style picture only when it is attached", () => {
    const attached = buildPostPrompt(base);
    expect(attached).toContain("Image 2's product, packaging, logo and print never appear");
    const dropped = buildPostPrompt({ ...base, noRefImage: true } as typeof base);
    expect(dropped).not.toContain("Image 1's product");
    expect(dropped).toContain("The picked style's own product, packaging, logo and print never appear");
  });
});

import { adaptStyleInstruction } from "../shared/styles";

describe("a style's own colours and staging (posts 10 and 11 of Abu Saleh, 28 Oct)", () => {
  const req = {
    style: { title: "Ledge Cocoa Burst", kind: "product" as const, prompt: "The background is a seamless soft gradient in the brand's main colour." },
    product: "Hot chocolate in a teal cup",
    post: { type: "Product", headline: "x", brief: "y" },
    brand: { name: "Abu Saleh" },
    palette: ["pale red #f3e9e8", "cyan #63c7c9"],
    people: [],
  };
  it("never fills the style's colour placeholder with the brand's colour", () => {
    const text = adaptStyleInstruction(req);
    expect(text).not.toContain("#f3e9e8");
    expect(text).toContain("the same colour as the backdrop of the attached style picture");
    expect(text).toContain("Never add a lid, straw, sleeve");
    expect(text).toContain("THE STYLE'S OWN STAGING STAYS");
  });
  it("tells the engine the style's pouring vessels are staging", () => {
    expect(buildPostPrompt(base)).toContain("THE PICKED STYLE'S STAGING");
    expect(buildPostPrompt({ ...base, styleKey: undefined, shot: undefined } as typeof base)).not.toContain("THE PICKED STYLE'S STAGING");
  });
});

import { styleCameraSentences } from "../shared/styles";

describe("the style's camera travels word for word (post 10 of Abu Saleh, 28 Oct)", () => {
  const ledge =
    "Low, heroic camera angle, almost at surface level, shooting slightly upward at the product so it looks monumental against the backdrop. The product stands at the edge of a smooth, matte cream-coloured ledge that slices diagonally across the bottom of the frame. Large chunky pieces of the product's own key ingredients are stacked in two loose piles. A burst of fine powder explodes upward.";
  it("takes the camera and the product's place from the style's opening", () => {
    expect(styleCameraSentences(ledge)).toBe(
      "Low, heroic camera angle, almost at surface level, shooting slightly upward at the product so it looks monumental against the backdrop. The product stands at the edge of a smooth, matte cream-coloured ledge that slices diagonally across the bottom of the frame.",
    );
    expect(styleCameraSentences("Pieces of fruit fall. Water splashes. The mood is fresh.")).toBe("");
  });
  it("puts them in the engine prompt as a mandatory line", () => {
    const prompt = buildPostPrompt({ ...base, styleCamera: styleCameraSentences(ledge) } as typeof base);
    expect(prompt).toContain("CAMERA AND COMPOSITION OF THE PICKED STYLE (mandatory");
    expect(prompt).toContain("slices diagonally across the bottom of the frame");
    expect(buildPostPrompt(base)).not.toContain("CAMERA AND COMPOSITION");
  });
});

import { withoutLightingGear } from "../shared/posts";

describe("no studio gear in the picture (the softbox in the corner, 28 Oct)", () => {
  it("rewrites named lighting gear as light and rules gear out", () => {
    expect(withoutLightingGear("A large softbox from the upper left gives soft directional light, with a reflector on the right.")).toBe("soft, broad light from the upper left gives soft directional light, with on the right.");
    const prompt = buildPostPrompt({ ...base, shot: "Light is a large softbox from the upper left, soft but directional." } as typeof base);
    expect(prompt).not.toContain("large softbox");
    expect(prompt).toContain("soft, broad light from the upper left");
    expect(prompt).toContain("NO STUDIO GEAR IN THE PICTURE");
  });
});

import { preflightInstruction as preflightText } from "../shared/qa";

describe("the product is the style's pouring vessel (post 13 of Abu Saleh, 28 Oct)", () => {
  it("lets the product's own cup tilt and pour when the pour is the style's hero", () => {
    const text = adaptStyleInstruction({
      style: { title: "Endless Pour Stream", kind: "people", prompt: "A hand holds a small open cup tilted almost upside down; a stream pours out." },
      product: "Hot chocolate in a teal cup",
      post: { type: "Product", headline: "x", brief: "y" },
      brand: { name: "Abu Saleh" },
      palette: [],
      people: ["Omar (a man)"],
    });
    expect(text).toContain("EXCEPT when the style's hero is a pour from its own vessel");
    expect(text).toContain("no second cup, jug or glass is added");
    expect(buildPostPrompt(base)).toContain("the product's open cup, glass or bottle is that vessel");
    expect(preflightText({ client: "Abu Saleh", scene: "x", products: ["cup"], people: [], reference: "style", lessons: [] })).toContain("tilted and pouring its own drink as the style shows, and that is not a problem");
  });
});
