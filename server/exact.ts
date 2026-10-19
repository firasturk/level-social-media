/**
 * Exact product mode in the Worker: the product's cut-out (made once per photo and kept in R2),
 * where it stands in the generated scene (asked of the vision model), and the final picture.
 */
import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import type { Env } from "./env";
import { StudioError } from "./errors";
import type { ImageBytes } from "./openai";
import { resolveGoogleAuth, resolveOpenAIKey } from "./settings";
import { askVisionGoogle, askVisionOpenAI } from "./editorial";
import {
  alphaFromBackground,
  alphaFromMask,
  composite,
  coverage,
  cutout,
  placement,
  plainBackground,
  type Box,
  type Light,
  type Raster,
} from "./compose";

/** Longest side the cut-out is kept at: sharp at 2K, light enough for the Worker's memory. */
const CUTOUT_MAX = 1600;

function decode(bytes: ArrayBuffer | Uint8Array): { img: PhotonImage; raster: Raster } {
  const img = PhotonImage.new_from_byteslice(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return { img, raster: { data: img.get_raw_pixels(), width: img.get_width(), height: img.get_height() } };
}

/** The exact bytes of a view, as their own buffer. */
function own(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function toPng(r: Raster): Uint8Array {
  const img = new PhotonImage(r.data, r.width, r.height);
  try {
    return img.get_bytes();
  } finally {
    img.free();
  }
}

const RATIOS: [string, number][] = [
  ["1:1", 1],
  ["4:5", 0.8],
  ["3:4", 0.75],
  ["2:3", 2 / 3],
  ["9:16", 9 / 16],
  ["5:4", 1.25],
  ["4:3", 4 / 3],
  ["3:2", 1.5],
  ["16:9", 16 / 9],
];

/** The product photo as a cut-out PNG (transparent around it), made once and kept next to the photo. */
export async function productCutout(env: Env, source: { key: string; mime?: string }): Promise<Raster> {
  const cacheKey = `${source.key}.cutout.png`;
  const cached = await env.BUCKET.get(cacheKey);
  if (cached) {
    const { img, raster } = decode(await cached.arrayBuffer());
    img.free();
    return raster;
  }
  const obj = await env.BUCKET.get(source.key);
  if (!obj) throw new StudioError("Product photo unavailable.", 404);
  let { img, raster } = decode(await obj.arrayBuffer());
  const longest = Math.max(raster.width, raster.height);
  if (longest > CUTOUT_MAX) {
    const s = CUTOUT_MAX / longest;
    const small = resize(img, Math.round(raster.width * s), Math.round(raster.height * s), SamplingFilter.Lanczos3);
    img.free();
    img = small;
    raster = { data: img.get_raw_pixels(), width: img.get_width(), height: img.get_height() };
  }
  img.free();
  // A plain studio background is removed exactly; a busy one is masked by the image model.
  let alpha: Uint8Array | null = null;
  const bg = plainBackground(raster);
  if (bg) {
    const a = alphaFromBackground(raster, bg);
    const c = coverage(a);
    if (c > 0.02 && c < 0.97) alpha = a;
  }
  if (!alpha) {
    const { makeGoogleClient } = await import("./engine");
    const engine = await makeGoogleClient(env);
    const ratio = raster.width / raster.height;
    const aspectRatio = RATIOS.reduce((best, r) => (Math.abs(r[1] - ratio) < Math.abs(best[1] - ratio) ? r : best))[0];
    const mask = await engine.edit({
      model: "gemini-3-pro-image",
      prompt:
        "Image 1 is a product photo. Draw its cut-out mask at exactly the same framing, position and size: the whole product (box, tin, lid, ribbon, packaging and anything it holds) pure white, everything else (background, surface, hands, props, shadows) pure black. Flat white and black only, no grey, no outline, no text.",
      images: [{ bytes: own(toPng(raster)), mime: "image/png" }],
      aspectRatio: aspectRatio as never,
      size: "1K",
    });
    const m = decode(mask.bytes);
    m.img.free();
    const a = alphaFromMask(m.raster, raster.width, raster.height);
    const c = coverage(a);
    if (c < 0.02 || c > 0.97) throw new StudioError("The product could not be cut out of its photo. Use a photo on a plain background.", 422);
    alpha = a;
  }
  const cut = cutout(raster, alpha);
  await env.BUCKET.put(cacheKey, toPng(cut), { httpMetadata: { contentType: "image/png" } });
  return cut;
}

/**
 * The product can be set in exactly: a plain background cuts cleanly, and a busy one (a shop, a
 * marble wall) is masked once by the image model and kept. False when no cut-out can be made.
 */
export async function canCutOut(env: Env, source: { key: string; reference_key?: string | null; mime?: string }): Promise<boolean> {
  if (await cutsCleanly(env, source)) return true;
  try {
    await productCutout(env, source);
    return true;
  } catch {
    return false;
  }
}

/**
 * The product photo can be cut out exactly: it stands on a plain studio background (or its cut-out
 * is already made). A photo with a scene behind it is drawn by the engine from the photo instead,
 * since a model-drawn mask never lines up with it pixel for pixel.
 */
export async function cutsCleanly(env: Env, source: { key: string; reference_key?: string | null }): Promise<boolean> {
  if (await env.BUCKET.head(`${source.key}.cutout.png`)) return true;
  const obj = await env.BUCKET.get(source.reference_key || source.key);
  if (!obj || (obj.size ?? 0) > 8_000_000) return false;
  const { img, raster } = decode(await obj.arrayBuffer());
  img.free();
  const bg = plainBackground(raster);
  if (!bg) return false;
  const c = coverage(alphaFromBackground(raster, bg));
  return c > 0.02 && c < 0.97;
}

const SPOT_SCHEMA = {
  type: "object",
  properties: {
    box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    light: { type: "string", enum: ["left", "right", "front", "top", "back"] },
    empty: { type: "boolean" },
  },
  required: ["box", "light", "empty"],
};

/** Where the product stands in the scene and where the light comes from, read by the vision model. */
async function findSpot(env: Env, product: ImageBytes, scene: ImageBytes, note: string): Promise<{ box: Box; light: Light; empty: boolean }> {
  const instruction = [
    `Image 1 is a product${note ? ` (${note})` : ""}. Image 2 is a photograph made with an empty place where this exact product will be set afterwards.`,
    "box: [ymin, xmin, ymax, xmax] normalised 0..1000 in image 2: the rectangle the product should fill, at its real size in this scene (compare with people, hands, furniture and the surface), standing on the empty surface with its base on the box's bottom edge, fully inside the frame, never covering a face.",
    "light: the side the scene's main light comes from (left, right, front, top or back).",
    "empty: true when that place is clear (no other product, box or object already standing there).",
    "Return ONLY the JSON.",
  ].join("\n");
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  let text: string;
  if (google) {
    try {
      text = await askVisionGoogle(google, instruction, [product, scene], SPOT_SCHEMA);
    } catch (e) {
      if (!openai) throw e;
      text = await askVisionOpenAI(openai, instruction, [product, scene]);
    }
  } else if (openai) text = await askVisionOpenAI(openai, instruction, [product, scene]);
  else throw new StudioError("Exact product mode needs a Google or OpenAI key in Connection.", 428);
  const d = JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as {
    box?: number[];
    light?: string;
    empty?: boolean;
  };
  const box = Array.isArray(d.box) && d.box.length === 4 && d.box.every(Number.isFinite) ? (d.box as Box) : null;
  const ok = box && box[2] - box[0] > 40 && box[3] - box[1] > 40;
  return {
    // A vision answer that makes no sense falls back to the place the prompt asked for.
    box: ok ? box : EXACT_SPOT,
    light: (["left", "right", "front", "top", "back"].includes(d.light ?? "") ? d.light : "front") as Light,
    empty: d.empty !== false,
  };
}

/** The place the prompt asks the engine to leave empty: lower middle of the frame. */
export const EXACT_SPOT: Box = [430, 270, 860, 730];

/** The final picture: the scene with the real product set into its place. */
export async function placeProduct(
  env: Env,
  source: { key: string; reference_key?: string | null; mime?: string },
  scene: ImageBytes,
  note: string,
): Promise<{ image: ImageBytes; empty: boolean }> {
  const cut = await productCutout(env, source);
  const ref = await env.BUCKET.get(source.reference_key || source.key);
  const productBytes: ImageBytes = ref
    ? { bytes: await ref.arrayBuffer(), mime: ref.httpMetadata?.contentType || "image/jpeg" }
    : { bytes: own(toPng(cut)), mime: "image/png" };
  const spot = await findSpot(env, productBytes, scene, note);
  const s = decode(scene.bytes);
  const at = placement(spot.box, s.raster, cut);
  const cutImg = new PhotonImage(cut.data, cut.width, cut.height);
  const sized = resize(cutImg, at.width, at.height, SamplingFilter.Lanczos3);
  cutImg.free();
  const product: Raster = { data: sized.get_raw_pixels(), width: sized.get_width(), height: sized.get_height() };
  sized.free();
  const out = composite(s.raster, product, at, spot.light);
  s.img.free();
  const final = new PhotonImage(out.data, out.width, out.height);
  try {
    return { image: { bytes: own(final.get_bytes_jpeg(93)), mime: "image/jpeg" }, empty: spot.empty };
  } finally {
    final.free();
  }
}
