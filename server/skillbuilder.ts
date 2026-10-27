/**
 * Writes a skill's direction and library from its reference photos: the vision model studies
 * every photo for setting, pose and light (never clothing or accessories) and returns the two
 * texts the team would otherwise write by hand.
 */
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { resolveAnthropicKey, resolveGoogleKey, resolveOpenAIKey } from "./settings";
import { tryClaude } from "./anthropic";
import { askVisionGoogle, askVisionOpenAI } from "./editorial";
import type { ImageBytes } from "./openai";

const SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    goal: { type: "string" },
    library: { type: "string" },
  },
  required: ["description", "goal", "library"],
};

export function skillBuilderInstruction(title: string, count: number): string {
  return [
    `You are writing the creative brief for a fashion-photography prompt skill called "${title}" from ${count} attached reference photographs. Every generated image will later borrow its background, pose and lighting from one of these photos.`,
    "Look at each photo and extract ONLY: the kind of place and its surfaces, depth layers, weather and time of day; the model's pose and body language; the light (direction, quality, colour); the framing distance and lens feel; the colour grade and photographic treatment (film-like, clean, etc.). Ignore and never mention clothing, prints, colours of garments, faces, hair styling, hats, bags, sunglasses, jewellery, props or brands.",
    "Write three texts in English:",
    "0. description: one sentence (max 160 characters) a colleague would read under the skill's name, naming the kind of places, light and mood. Catalogue-safe wording.",
    "1. goal: 4-8 sentences starting with 'Goal: write ONE prompt for ...'. Say what the skill is for, the overall world and mood shared by the photos, the pose energy, the light signature, the framing habit, and end with 'The garment stays exactly as supplied; the output keeps the upload's framing.' If children appear, add 'Child safety wording applies throughout.' Use catalogue-safe wording only (no words about bodies being attractive, sensual or similar).",
    "2. library: Markdown in exactly this shape: '# <title> library', then '## Scene families' with ONE numbered line per photo (1., 2., ...) describing that photo's setting with full density in one sentence (surfaces, depth, weather, light), then '## Poses' with one dash line per photo describing its pose in the same spirit, then '## Light' with 3-4 dash lines, '## Camera' with 2 dash lines (lens, height, framing), '## Colour grade' with 1-2 dash lines, and '## Avoid' with one dash line that starts with 'Hats, caps, bags, sunglasses or props copied from a reference;' and continues with what would break this world.",
    "Return ONLY a JSON object with keys description, goal and library.",
  ].join("\n\n");
}

export async function buildSkillFromReferences(
  env: Env,
  title: string,
  images: ImageBytes[],
): Promise<{ description: string; goal: string; library: string }> {
  if (!images.length) throw new StudioError("Add reference photos to this skill first.");
  const google = (await resolveGoogleKey(env)).key;
  const openai = (await resolveOpenAIKey(env)).key;
  const anthropic = (await resolveAnthropicKey(env)).key;
  if (!google && !openai && !anthropic)
    throw new StudioError(
      "Building from references needs a Claude, Google or OpenAI key in Connection.",
      428,
    );
  const instruction = skillBuilderInstruction(title, images.length);
  let text: string;
  const claude = await tryClaude(env, instruction, images, SCHEMA);
  if (claude !== null) text = claude;
  else if (!google && !openai) throw new StudioError("Claude could not answer this time, and no Google or OpenAI key is connected to answer instead.", 502);
  else if (google) {
    try {
      text = await askVisionGoogle(google, instruction, images, SCHEMA);
    } catch (e) {
      if (openai && /location is not supported|credits are used up|\(4\d\d\)/.test(errorMessage(e)))
        text = await askVisionOpenAI(openai, instruction, images);
      else throw e;
    }
  } else text = await askVisionOpenAI(openai!, instruction, images);
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const d = JSON.parse(cleaned) as { description?: string; goal?: string; library?: string };
  if (!d.goal || !d.library) throw new StudioError("The model returned an incomplete brief.", 502);
  return {
    description: (d.description ?? "").trim().slice(0, 300),
    goal: d.goal.trim(),
    library: d.library.trim(),
  };
}
