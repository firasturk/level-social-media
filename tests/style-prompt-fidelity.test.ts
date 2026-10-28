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
