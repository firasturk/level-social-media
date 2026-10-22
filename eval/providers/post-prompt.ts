/**
 * The image prompt of one post (shared/posts.ts buildPostPrompt) for each creation method, with the
 * image order read back out of it: the engine gets image 1 (the product photo) first and the
 * references after it, exactly as server/engine.ts postImages attaches them.
 */
import { buildPostPrompt, type PostBrief } from "../../shared/posts";
import type { PromptImages } from "../../shared/prompts";
import { CLIENT, EXISTING_PLAN, PALETTE, PRODUCTS, PRODUCT_NAMES, approvedLessonLines, obj, str, unapprovedLessonLines } from "./fixtures";

export const BASE_BRIEF: PostBrief = {
  post: true,
  index: 1,
  type: "product",
  title: EXISTING_PLAN[0].title,
  brief: EXISTING_PLAN[0].brief,
  palette: PALETTE,
  style: CLIENT.style,
  theme: "Street signs: the cup is the sign's symbol, noon sun, blue sky, hard shadows.",
  format: "4:5",
  ref: null,
  refIsSource: false,
  hasProduct: true,
  product: PRODUCTS[0].note,
  always: CLIENT.dos,
  never: CLIENT.donts,
  photography: "35 mm at eye level, hard noon sun, true colours.",
  productNames: PRODUCT_NAMES,
  lessons: approvedLessonLines(),
};

/** The brief as each creation method writes it. */
export const VARIANTS: Record<string, Partial<PostBrief>> = {
  /** Quick Campaign: the designer's reference is a private style; the brief's colours lead. */
  brief: { styleKey: "styles/brief-1.jpg", shot: "The pistachio shake inside a round road sign, eye level, noon sun, hard shadow to the left.", campaign: { ingredients: "pistachios", colours: ["Navy #0b1f6b"] }, paletteChosen: true },
  /** Follow a grid: the post's own tile, cut from the grid, is the reference. */
  grid: { ref: "style:grid-9", tileKey: "styles/grid-9-tile-3.jpg", grid: "A feed of street scenes: cups set into road signs, hard noon light, sky blue and sign yellow.", tile: "Tile 3: the cup centred in a round sign plate, a calm band of sky at the top.", shot: "Tile 3: the cup centred in the sign plate, straight on." },
  /** Use theme references: a theme pin is the look; the month's shot is the picture. */
  theme: { ref: "ref-1", library: "## Scenes\n1. A cup inside a road sign, noon sun.\n## Light\n- hard noon sun", shot: "The pistachio shake inside a round road sign at eye level, noon sun, a hard shadow to the left; the plate fills the upper two thirds." },
  /** One post from a style: the gallery style written for this product is the picture. */
  style: { styleKey: "styles/st-sign.jpg", shot: "The pistachio shake stands inside a round blue road sign as its symbol, eye level, noon sun, blue sky behind the plate." },
};

/** How many images the engine is handed for this brief, counted as postImages attaches them. */
export function expectedImages(b: PostBrief, images: PromptImages): number {
  let n = b.hasProduct ? 1 + (b.extraProducts?.length ?? 0) : b.ref || b.styleKey || b.tileKey ? 1 : 0;
  n += b.ambassadors?.length ?? 0;
  if (b.place) n += 1;
  if (b.realRef) n += 1;
  if (b.hasProduct && (b.ref || b.styleKey || b.tileKey) && !b.refIsSource && !b.noRefImage) n += 1;
  if (b.editRef && images.reference) n += 1;
  if (images.revision) n += 1;
  return n;
}

export function postPrompt(vars: Record<string, unknown>) {
  const variant = str(vars.variant, "theme");
  const brief: PostBrief = { ...BASE_BRIEF, ...(VARIANTS[variant] ?? {}), ...obj<Partial<PostBrief>>(vars.brief, {}) };
  const images = obj<PromptImages>(vars.images, {});
  const edit = str(vars.edit);
  const prompt = buildPostPrompt(brief, edit, images);
  // "Image 1 is …", "Images 1 to 2 are …", "Image 3 is …", in the order the prompt names them.
  const imageLines = [...prompt.matchAll(/Images? (\d+)(?: to (\d+))?(?: is| are) ([^.:]{0,60})/g)].map((m) => ({ from: Number(m[1]), to: Number(m[2] ?? m[1]), role: m[3].trim() }));
  let highestImage = 0;
  for (const m of prompt.matchAll(/Images? (\d+)(?: to (\d+))?/g)) highestImage = Math.max(highestImage, Number(m[2] ?? m[1]));
  return {
    method: "post-prompt",
    variant,
    prompt,
    imageLines,
    highestImage,
    expectedImages: expectedImages(brief, images),
    firstImage: imageLines[0] ?? null,
    memory: { approved: brief.lessons ?? [], unapproved: unapprovedLessonLines() },
  };
}
