/**
 * Runs the Fashion Editorial Prompt Builder skill with a vision model: the uploaded photo goes in,
 * a structured brief (analysis, long prompt, negative prompt) comes out. The skill is one of the
 * ready-made entries in shared/skills.ts. Google Gemini is
 * used when a Google key exists, otherwise OpenAI. The skill text itself lives in shared/editorial-skill.ts.
 */
import { skillById, type SkillDef } from "@shared/skills";
import { zaidSkill } from "@shared/zaid";
import { isVertexAuth, vertexText, type GoogleAuth } from "./vertex";
import {
  composeFixedRules,
  DEFAULT_DIRECTION_RULES,
  type DirectionRule,
} from "@shared/direction-rules";
import { StudioError } from "./errors";
import type { ImageBytes } from "./openai";

export interface EditorialBrief {
  subject: string;
  faceMode: "FACE_VISIBLE" | "FACE_PARTIAL" | "NO_FACE";
  garments: string;
  scene: string;
  pose: string;
  light: string;
  prompt: string;
  negative: string;
  /** Id of the reference-library photo attached to this run, if any. */
  mood?: string;
  /** FULL_BODY | THREE_QUARTER | UPPER_BODY | LOWER_BODY, read from the upload and locked for the output. */
  framing?: string;
  /** Task id of the already generated image of the same product set this one is matched to. */
  setOf?: string;
}

export type Framing = "FULL_BODY" | "THREE_QUARTER" | "UPPER_BODY" | "LOWER_BODY";

export interface EditorialRequest {
  /** Zaid creative direction: Zaid's prompt structure, examples and rules around the chosen skill. */
  zaid?: boolean;
  /** Replace the person entirely with an AI-generated model; keep only what is worn. */
  newModel?: boolean;
  /** Crop of the upload, verified by a separate check before the prompt is written. Binding. */
  uploadFraming?: Framing;
  /** What the verified check saw worn in the upload, as a short list. */
  visibleGarments?: string;
  /** Verified: the upload shows a hand in a pocket. Only then may the output. */
  handsInPockets?: boolean;
  /** Verified: the upload shows the model from behind; the output keeps the back view. */
  backView?: boolean;
  /** Second attempt note when the first draft was too short (Zaid creative direction). */
  expand?: string;
  /** A saved prompt that leads this run: its scene, pose, light and style are reused as written. */
  look?: {
    name: string;
    prompt: string;
    negative: string;
    scene: string;
    pose: string;
    light: string;
  };
  image: ImageBytes;
  /** 1-based run number; used to rotate scene families so every card differs. */
  run: number;
  /** Skill id from shared/skills.ts; unknown ids fall back to the editorial skill. */
  skill?: string;
  /** The resolved skill (team edits applied); when absent the built-in list is used. */
  skillDef?: SkillDef;
  /** Mode 7: extra direction text added by the team. */
  direction?: string;
  /** Mode 7: the fixed rules as the team keeps them (defaults when absent). */
  rules?: DirectionRule[];
  /** Scene pre-drawn by planRun(); when absent builderInstruction draws one itself. */
  scene?: string | null;
  /** Reference-library photo ids available for this skill; planRun() picks one not used recently. */
  references?: string[];
  /** Reference ids already attached to sibling runs or recent batches. */
  usedReferences?: string[];
  /** The reference photo chosen for this run, attached after the garment photo. */
  reference?: string;
  /** Extra images attached after the garment photo (the chosen reference, then the set sibling). */
  extraImages?: ImageBytes[];
  /** Same-product set: the scene and light already used for the sibling image, to be matched exactly. */
  set?: { scene: string; light: string; pose: string; hasImage: boolean };
  /** "auto" | "arab" | "european" | "mixed" */
  market: string;
  /** Free-text city / mood preference from the batch. */
  preference: string;
  aspectRatio: string;
  /** Scenes and poses already used for this source, to avoid repeats. */
  used: { scene: string; pose: string }[];
  /** Scenes used recently in the user's other batches, so sets do not all open on the same street. */
  recent?: string[];
  /** Random source for the scene draw; injectable for tests. */
  random?: () => number;
}

/** Numbered scene lines of a skill library, in order. */
export function libraryScenes(library: string): string[] {
  const section = library.split(/\n## /).find((s) => /^Scene/i.test(s)) ?? library;
  return [...section.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1].trim());
}

/**
 * Draws the scene for this run: a random library scene that was not used for this outfit or in
 * the user's recent batches. Left to its own devices the model opens on its favourite street
 * every time, so the draw happens here and the skill is told to use it.
 */
export function pickScene(req: EditorialRequest, scenes: string[]): string | null {
  if (!scenes.length) return null;
  const taken = [...req.used.map((u) => u.scene), ...(req.recent ?? [])]
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  const similar = (scene: string) => {
    const head = scene.toLowerCase().slice(0, 28);
    return taken.some((t) => t.includes(head) || head.includes(t.slice(0, 28)));
  };
  const fresh = scenes.filter((s) => !similar(s));
  const pool = fresh.length ? fresh : scenes;
  const random = req.random ?? Math.random;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

const SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    faceMode: { type: "string", enum: ["FACE_VISIBLE", "FACE_PARTIAL", "NO_FACE"] },
    garments: { type: "string" },
    scene: { type: "string" },
    pose: { type: "string" },
    light: { type: "string" },
    prompt: { type: "string" },
    negative: { type: "string" },
    framing: { type: "string", enum: ["FULL_BODY", "UPPER_BODY", "LOWER_BODY"] },
  },
  required: [
    "subject",
    "faceMode",
    "garments",
    "scene",
    "pose",
    "light",
    "prompt",
    "negative",
    "framing",
  ],
};

/** Zaid creative direction prompts are long-form: this many words at least. */
export const ZAID_MIN_WORDS = 800;
export const ZAID_MAX_WORDS = 1000;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function builderInstruction(req: EditorialRequest): string {
  // Zaid creative direction: outfit, framing, pockets, centring and bright balanced light are hard rules;
  // hair and catalogue wording follow the direction.
  const relaxed = !!req.zaid || req.skill === "zaid";
  const market =
    req.market === "arab"
      ? "Arab / Middle-Eastern / Gulf / Levantine features"
      : req.market === "european"
        ? "European (Mediterranean, Northern or Eastern European) features"
        : req.market === "mixed"
          ? "alternate between Arab and European features across runs"
          : "your choice, alternating between Arab and European features across runs";
  const used = req.used.length
    ? `Already used for this outfit (do NOT reuse these scene families or poses): ${req.used
        .map((u, i) => `run ${i + 1}: scene "${u.scene}", pose "${u.pose}"`)
        .join("; ")}.`
    : "This is the first run for this outfit.";
  const skill = skillFor(req);
  const scene = req.scene !== undefined ? req.scene : pickScene(req, libraryScenes(skill.library));
  const look = req.look
    ? `SAVED LOOK "${req.look.name}" (overrides the reference rules, the scene assignment, the library and the avoid-repeats list). The team approved the prompt below on an earlier image and wants the SAME look again. Reuse its location and background, pose and stance, lighting, camera angle and distance, colour grade and overall style exactly as written; do not pick a different scene family and do not vary them for novelty. Rewrite ONLY what must follow image 1: the subject line, the garment inventory (every garment, footwear and accessory exactly as worn in image 1), the framing/crop of image 1, and the face rules. Keep the prompt structure, length and wording otherwise as close to the saved prompt as the new outfit allows.\n--- SAVED PROMPT ---\n${req.look.prompt}\n--- END SAVED PROMPT ---${req.look.negative ? `\nSaved negative prompt to reuse: ${req.look.negative}` : ""}`
    : "";
  const mood = req.reference
    ? "REFERENCE FIRST. Image 2 is the primary creative source for this run: build the scene, the pose and stance (standing, sitting, walking, leaning), the lighting and the camera angle from it. Describe its kind of place, surfaces, depth, time of day and light with full density, and give the model a pose in the same spirit, then change the exact spot and details so the result is a sibling, not a copy. Ignore its clothing, face, hair, hats, bags, sunglasses, jewellery, props and accessories; the garment comes from image 1 alone and the framing follows image 1. The skill's written direction and library are secondary: use them for mood, colour and the avoid list, and only draw a scene from the library when it fits the reference."
    : "";
  const set = req.set
    ? `SAME PRODUCT SET (overrides everything about the scene): this upload is another photo of the SAME product as an image already generated. Use exactly the same location and background, the same light and time of day, the same colour grade and camera distance, so the two images sit side by side as one shoot. Scene to reuse: "${req.set.scene}". Light to reuse: "${req.set.light}".${req.set.hasImage ? " The generated sibling is attached as the last image: match its background, light and colour grade precisely." : ""} Only the pose and crop follow this upload (same framing as image 1); the pose may differ from the sibling's ("${req.set.pose}") so the two are not identical.`
    : "";
  const recent = req.recent?.length
    ? `Scenes used in the user's recent batches (avoid these families too): ${req.recent
        .slice(0, 12)
        .map((s) => `"${s}"`)
        .join("; ")}.`
    : "";
  return [
    "You are running the following skill. Follow it exactly and return ONLY the JSON object described at the end.",
    "=== SKILL ===",
    skill.instructions,
    "=== TEMPLATE ===",
    skill.template,
    "=== LIBRARY ===",
    skill.library,
    "=== RUN CONTEXT ===",
    `Run number: ${req.run}. ${req.look ? "Repeat the saved look; the avoid list does not apply." : used}`,
    req.look ? "" : recent,
    look,
    mood,
    set,
    scene && !req.reference && !req.set && !req.look
      ? `Scene assigned to this run (use it as the location family; describe it with full density and you may refine details): "${scene}". Do not substitute another family.`
      : "",
    req.newModel
      ? `NEW MODEL RULE (overrides the FACE rule and anything else about the person): the person in image 1 is never reproduced. Treat the face as NO_FACE regardless of visibility. Invent an entirely new professional model (face, hair, skin tone, build, age within adult range) following the market preference "${market}", described with the realism block. Never describe or borrow the original person's features, hair, skin or body. Take from image 1 ONLY the garments, footwear, accessories and bags, kept exactly as worn, plus the framing. Write the opening line as: "Use the attached image as the single source of truth for the outfit only; the model is a different, newly generated person. Replace the plain background completely with the new setting described below."`
      : `Market preference for a generated face (only when the face is not visible): ${market}.`,
    req.preference
      ? `EXTRA REQUESTS FROM THE USER for this batch (apply them to the prompt; they override the skill's direction and library but never the fixed rules): ${req.preference}`
      : "No extra requests from the user.",
    relaxed
      ? composeFixedRules(req.rules ?? DEFAULT_DIRECTION_RULES)
      : "Fixed rules for every prompt (they override the skill's own direction, template and library, including any default framing such as full body): (1) everything worn in image 1 stays exactly as it is, garments, footwear and any accessory already in the photo, nothing added, removed or invented, no shoes, bags, hats, jewellery or extra layers that are not visible in image 1; (2) a reference image contributes only setting, pose and stance, lighting and camera angle; (3) never copy hats, bags, sunglasses, jewellery or props from a reference; (4) FRAMING LOCK: the output crop equals the upload crop, an upper-body upload ends at the same line with no legs or footwear drawn, a lower-body upload starts at the same line with no face or top drawn, a full-body upload stays full body with footwear visible, a three-quarter upload (head to around the knees) stays three-quarter and ends at the same line with no feet drawn, and a back-view upload stays a back view with the model facing away and no face shown; (5) catalogue-safe wording only; (8) HANDS: a hand goes into a pocket only when the upload shows a hand in a pocket; otherwise hands stay out of pockets, relaxed and visible, and in a lower-body image the hands are visible in the frame, in a natural position that fits the scene and the body's movement (resting beside the thighs, lightly touching the garment, mid-stride), never cropped out, never raised out of frame; (11) IDENTITY: when the model is kept, the face and facial structure are reproduced exactly as in image 1 (face shape, jawline, nose, lips, eyes, eyebrows, cheekbones, skin tone, age), and the hairstyle is kept exactly (length, colour, parting, texture, styling); write this explicitly in the FACE & HAIR section and never describe a different or idealised face or a restyled hair; (12) TATTOOS: any tattoo visible on the person in image 1 is removed in the output; state in the prompt that the skin is clean with no tattoo or ink, and add tattoos to the AVOID list; (9) POSE: write one coherent pose that is different from the upload's stance, as one body in one moment: state explicitly where each arm, each hand and each leg is, how the weight sits and where the head looks; never give the same limb two positions, never a hand both in a pocket and elsewhere; say in the prompt that the upload's own stance is not kept; (7) HAIR: when the model is kept, the same hairstyle, length and colour as image 1; in every case the hair is neat and settled, no wind-blown, flying, floating or stray strands, no hair across the face, and the AVOID block lists wind-blown hair, flying hair strands and messy hair; (6) COMPOSITION: the model is centred on the vertical axis of the frame, the midpoint of the full body at x=50% with equal space left and right, never pushed to one side; architecture, street or furniture may frame the model symmetrically but never offset them. Say this explicitly in the prompt's composition section.",
    `Aspect ratio: ${req.aspectRatio} vertical.`,
    req.uploadFraming
      ? framingDirective(req.uploadFraming, req.visibleGarments, req.handsInPockets, req.backView)
      : "Framing lock: read the upload's framing (FULL_BODY, THREE_QUARTER, UPPER_BODY or LOWER_BODY) and keep it in the output with roughly the same crop line; report it in the JSON as framing.",
    "CHILDREN: when the subject is a child, the prompt stays at 500-800 words whatever other length rule says, and it never describes the child's skin, body, physique, muscles, limbs, proportions or anything physical beyond the clothes: describe the outfit, a simple happy natural pose in plain words (standing, walking, sitting on a step), the scene and the light only.",
    "Safe wording: catalogue language only; never describe bodies as attractive or sensual; children only as happy child models with an age band, no makeup, no adult poses.",
    "Intimates rule (underwear, lingerie, bras, briefs, sleepwear, swimwear): this is retail catalogue photography for a family department store. Describe the garments in plain product terms (bra, briefs, camisole), keep the pose calm and upright with relaxed arms and a neutral expression, choose a bright indoor or studio-like scene (bedroom with daylight, dressing room, hotel room, clean studio) rather than a street, and use no suggestive, sensual or body-focused language anywhere in the prompt. Phrase the opening as 'catalogue photograph of a model wearing the supplied two-piece set'.",
    relaxed
      ? `The attached image is the model/outfit photo. Do Step 1 (analysis), Step 2 (fresh combination) and Step 3 (write the full prompt, English, all template sections). LENGTH: the prompt field must be ${ZAID_MIN_WORDS}-${ZAID_MAX_WORDS} words, never under ${ZAID_MIN_WORDS} and not over ${ZAID_MAX_WORDS}. Develop every section with several concrete sentences: name and describe each background element, surface and material, the exact light on each of them, every garment detail, and the pose joint by joint. A prompt under ${ZAID_MIN_WORDS} words is rejected.`
      : "The attached image is the model/outfit photo. Do Step 1 (analysis), Step 2 (fresh combination) and Step 3 (write the full prompt, 600-1100 words, English, all template sections).",
    req.expand,
    "Return JSON with keys: subject, faceMode, garments (the full garment inventory as prose), scene (one line), pose (one line), light (one line), prompt (the full prompt text), negative (one line negative prompt), framing (FULL_BODY, THREE_QUARTER, UPPER_BODY or LOWER_BODY).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Draws the scene and the reference photo for a run so the builder text and the attachments
 * agree. The reference is one of the skill's library photos not used for this outfit or recently.
 */
function skillFor(req: EditorialRequest): SkillDef {
  if (req.skill === "zaid") return zaidSkill(req.direction ?? "");
  if (req.zaid) return zaidSkill(req.direction ?? "", req.skillDef ?? skillById(req.skill));
  return req.skillDef ?? skillById(req.skill);
}

export function planRun(req: EditorialRequest): { scene: string | null; mood?: string } {
  const skill = skillFor(req);
  const refs = req.references ?? [];
  // With reference photos the photo leads and rotates; the text library's scenes only step in without photos.
  if (!refs.length) return { scene: pickScene(req, libraryScenes(skill.library)) };
  const scene = null;
  const random = req.random ?? Math.random;
  // usedReferences is most-recent-first. Pick at random among the photos not used yet; when every
  // photo has been used, take the ones whose last use is the oldest, so the library rotates evenly.
  const used = req.usedReferences ?? [];
  const taken = new Set(used);
  const fresh = refs.filter((r) => !taken.has(r));
  let pool = fresh;
  if (!pool.length) {
    const lastUse = (r: string) => used.indexOf(r);
    const oldest = Math.max(...refs.map(lastUse));
    pool = refs.filter((r) => lastUse(r) === oldest);
  }
  return { scene, mood: pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] };
}

function imageParts(req: EditorialRequest): ImageBytes[] {
  return [req.image, ...(req.extraImages ?? [])];
}

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000)
    s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s);
}

function parseBrief(text: string): EditorialBrief {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const d = JSON.parse(cleaned) as Partial<EditorialBrief>;
  if (!d.prompt || d.prompt.length < 200)
    throw new StudioError("Prompt builder returned an empty prompt.", 502);
  return {
    subject: d.subject ?? "",
    faceMode: (d.faceMode as EditorialBrief["faceMode"]) ?? "NO_FACE",
    garments: d.garments ?? "",
    scene: d.scene ?? "",
    pose: d.pose ?? "",
    light: d.light ?? "",
    prompt: d.prompt,
    negative: d.negative ?? "",
    framing: d.framing,
  };
}

/** Google Gemini through the Interactions API with a JSON schema response. */
/** Text/vision models to try in order; Google retires names quickly, so a 404 falls through to the next. */
export const GOOGLE_TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
];

export async function buildBriefWithGoogle(
  key: GoogleAuth | string,
  req: EditorialRequest,
  fetchImpl: typeof fetch = fetch,
  model?: string,
): Promise<EditorialBrief> {
  if (isVertexAuth(key))
    return parseBrief(
      await vertexText(key.vertex, builderInstruction(req), imageParts(req), SCHEMA, fetchImpl),
    );
  const candidates = model ? [model] : GOOGLE_TEXT_MODELS;
  let lastError: StudioError | null = null;
  for (const m of candidates) {
    try {
      return await buildBriefWithGoogleModel(
        typeof key === "string" ? key : key.key,
        req,
        fetchImpl,
        m,
      );
    } catch (e) {
      if (e instanceof StudioError && /\(404\)/.test(e.message)) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new StudioError("No Google text model available.", 502);
}

/** One vision call to Google returning the model's JSON text (schema-constrained). */
export async function askVisionGoogle(
  auth: GoogleAuth | string,
  instruction: string,
  images: ImageBytes[],
  schema: unknown,
  fetchImpl: typeof fetch = fetch,
  model?: string,
): Promise<string> {
  if (isVertexAuth(auth)) return vertexText(auth.vertex, instruction, images, schema, fetchImpl);
  const key = typeof auth === "string" ? auth : auth.key;
  const candidates = model ? [model] : GOOGLE_TEXT_MODELS;
  let lastError: StudioError | null = null;
  for (const m of candidates) {
    const r = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: m,
        store: false,
        input: [
          { type: "text", text: instruction },
          ...images.map((img) => ({
            type: "image",
            mime_type: img.mime,
            data: toBase64(img.bytes),
          })),
        ],
        response_format: { type: "text", mime_type: "application/json", schema },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (r.status === 404) {
      lastError = new StudioError(`Prompt builder (Google) failed (404): ${m}`, 502);
      continue;
    }
    if (!r.ok)
      throw new StudioError(
        `Prompt builder (Google) failed (${r.status}): ${(await r.text()).slice(0, 200)}`,
        502,
      );
    const d = (await r.json()) as {
      steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
      output_text?: string;
    };
    return (
      d.output_text ??
      (d.steps ?? [])
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
    );
  }
  throw lastError ?? new StudioError("No Google text model available.", 502);
}

/** One vision call to OpenAI returning the model's JSON text. */
/**
 * The verified crop, stated as a hard instruction. Written before the skill text is read, so a
 * skill that defaults to full body (or a name like "Full Body") cannot override it.
 */
export function framingDirective(
  framing: Framing,
  garments?: string,
  handsInPockets = false,
  backView = false,
): string {
  const seen = garments ? ` Verified items worn in the upload: ${garments}.` : "";
  const view = backView
    ? " BACK VIEW: the upload shows the model from behind. The output keeps exactly this back view: the model faces away from the camera, the face is not shown and not described, the back of the hairstyle and the back of every garment are what is seen; never turn the model around, never add a face or a profile."
    : "";
  const hands = handsInPockets
    ? " HANDS: the upload shows a hand in a pocket, so a hand in a pocket is allowed."
    : " HANDS: the upload shows no hand in a pocket, so NO hand goes into a pocket in the output; hands stay out of pockets, relaxed and visible.";
  if (framing === "LOWER_BODY")
    return `VERIFIED UPLOAD FRAMING: LOWER_BODY (waist down). This is a fact, not a judgement call, and it overrides the skill, its template, its library and any reference photo. The output is a LOWER-BODY image: it starts at the same crop line as the upload (waist or hips) and ends below the footwear. The head, face, hair and shoulders are NOT in the image at all. Do not describe a face, hair, expression, gaze, a top garment or anything above the crop line; the only upper garment that may be mentioned is the sliver visible at the top edge of the upload, exactly as shown. Pose and scene are written for a lower-body shot: legs, stance, footwear, ground surface and the lower part of the setting. HANDS IN FRAME: the hands are visible inside the lower-body crop, relaxed and natural, in a position that fits the setting and the movement (resting beside the thighs, brushing the garment, swinging mid-step); never cropped out of the frame and never raised above the crop line. Report framing as LOWER_BODY.${seen}${hands}${view}`;
  if (framing === "UPPER_BODY")
    return `VERIFIED UPLOAD FRAMING: UPPER_BODY. This is a fact, not a judgement call, and it overrides the skill, its template, its library and any reference photo. The output is an UPPER-BODY image: from above the head down to the same crop line as the upload (waist or hips). Legs, trousers, skirts and footwear are NOT in the image; do not describe or invent them. Pose and scene are written for an upper-body shot. Report framing as UPPER_BODY.${seen}${hands}${view}`;
  if (framing === "THREE_QUARTER")
    return `VERIFIED UPLOAD FRAMING: THREE_QUARTER. This is a fact, not a judgement call, and it overrides the skill, its template, its library and any reference photo. The output is a THREE-QUARTER image: from above the head down to the same crop line as the upload, between mid-thigh and just below the knees. Feet and footwear are NOT in the image; do not describe or invent them. Pose and scene are written for a three-quarter shot. Report framing as THREE_QUARTER.${seen}${hands}${view}`;
  return `VERIFIED UPLOAD FRAMING: FULL_BODY. The output is a full-body image, head to footwear completely inside the frame, as in the upload. Report framing as FULL_BODY.${seen}${hands}${view}`;
}

/** JSON schema for the framing check (Google structured output). */
export const FRAMING_SCHEMA = {
  type: "object",
  properties: {
    framing: { type: "string", enum: ["FULL_BODY", "THREE_QUARTER", "UPPER_BODY", "LOWER_BODY"] },
    headVisible: { type: "boolean" },
    kneesVisible: { type: "boolean" },
    feetVisible: { type: "boolean" },
    backView: { type: "boolean" },
    faceVisible: { type: "boolean" },
    handsInPockets: { type: "boolean" },
    garments: { type: "string" },
  },
  required: [
    "framing",
    "headVisible",
    "kneesVisible",
    "feetVisible",
    "backView",
    "faceVisible",
    "handsInPockets",
    "garments",
  ],
};

export const FRAMING_CHECK_INSTRUCTION =
  "Look at the attached product photo and answer with JSON only. headVisible: true only if the head (face or back of the head) is inside the picture. kneesVisible: true only if the knees are inside the picture. feetVisible: true only if the feet, shoes or ankles are inside the picture. backView: true only if the person is seen from behind (back of the head, back of the garments, no face). framing follows from those facts: FULL_BODY when head and feet are both inside; THREE_QUARTER when the head is inside, the feet are NOT inside, and the picture ends between mid-thigh and just below the knees; UPPER_BODY when the head is inside and the picture ends at the waist or hips with no legs below the hips; LOWER_BODY when the head is NOT inside and the picture shows legs and/or footwear from the waist, hips or chest down, even if a sliver of a top is visible at the top edge. Decide from what is actually inside the picture, never from what the garment would need. faceVisible: true only if a face is clearly visible. handsInPockets: true only if at least one hand is inside a pocket in the photo. garments: a short comma-separated list of the clothing, footwear and accessories actually visible. Keys: framing, headVisible, kneesVisible, feetVisible, backView, faceVisible, handsInPockets, garments.";

/** Parse the framing check's answer; unknown answers are treated as full body. */
export interface FramingCheck {
  framing: Framing;
  faceVisible: boolean;
  handsInPockets: boolean;
  /** The upload shows the person from behind; the output keeps that back view. */
  backView: boolean;
  garments: string;
}

export function parseFramingCheck(text: string): FramingCheck {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const d = JSON.parse(cleaned) as {
      framing?: string;
      headVisible?: boolean;
      kneesVisible?: boolean;
      feetVisible?: boolean;
      backView?: boolean;
      faceVisible?: boolean;
      handsInPockets?: boolean;
      garments?: string;
    };
    let framing: Framing =
      d.framing === "UPPER_BODY" || d.framing === "LOWER_BODY" || d.framing === "THREE_QUARTER"
        ? d.framing
        : "FULL_BODY";
    // What is inside the picture decides, not the label: no head but feet is a lower-body crop,
    // head and feet a full body, head and knees but no feet a three-quarter crop, head alone an
    // upper-body crop.
    if (typeof d.headVisible === "boolean" && typeof d.feetVisible === "boolean") {
      if (!d.headVisible && d.feetVisible) framing = "LOWER_BODY";
      else if (d.headVisible && d.feetVisible) framing = "FULL_BODY";
      else if (d.headVisible && !d.feetVisible)
        framing =
          d.kneesVisible === true || (d.kneesVisible === undefined && framing === "THREE_QUARTER")
            ? "THREE_QUARTER"
            : "UPPER_BODY";
    }
    return {
      framing,
      faceVisible: !!d.faceVisible,
      handsInPockets: !!d.handsInPockets,
      backView: !!d.backView,
      garments: (d.garments ?? "").slice(0, 300),
    };
  } catch {
    return {
      framing: "FULL_BODY",
      faceVisible: false,
      handsInPockets: false,
      backView: false,
      garments: "",
    };
  }
}

export async function askVisionOpenAI(
  key: string,
  instruction: string,
  images: ImageBytes[],
  fetchImpl: typeof fetch = fetch,
  model = "gpt-4.1",
): Promise<string> {
  const r = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            // The garment photo needs full detail; the reference and sibling images only set the
            // scene, so low detail (a few dozen tokens each) keeps the call inside small rate limits.
            ...images.map((img, i) => ({
              type: "image_url",
              image_url: {
                url: `data:${img.mime};base64,${toBase64(img.bytes)}`,
                detail: i === 0 ? "high" : "low",
              },
            })),
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (r.status === 429) {
    const detail = (await r.text()).slice(0, 200);
    // Each model has its own token-per-minute pool; the mini model's is far larger, so one 429 on
    // the main model falls through to it rather than stalling the batch.
    if (model === "gpt-4.1")
      return askVisionOpenAI(key, instruction, images, fetchImpl, "gpt-4.1-mini");
    throw new StudioError(`Prompt builder (OpenAI) rate limited (429): ${detail}`, 429);
  }
  if (!r.ok)
    throw new StudioError(
      `Prompt builder (OpenAI) failed (${r.status}): ${(await r.text()).slice(0, 200)}`,
      502,
    );
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return d.choices?.[0]?.message?.content ?? "";
}

async function buildBriefWithGoogleModel(
  key: string,
  req: EditorialRequest,
  fetchImpl: typeof fetch,
  model: string,
): Promise<EditorialBrief> {
  return parseBrief(
    await askVisionGoogle(key, builderInstruction(req), imageParts(req), SCHEMA, fetchImpl, model),
  );
}

/** OpenAI chat completion with an image and JSON output. */
export async function buildBriefWithOpenAI(
  key: string,
  req: EditorialRequest,
  fetchImpl: typeof fetch = fetch,
  model = "gpt-4.1",
): Promise<EditorialBrief> {
  return parseBrief(
    await askVisionOpenAI(key, builderInstruction(req), imageParts(req), fetchImpl, model),
  );
}

/* ───────────── No prompt approach: reading the background and pose photos ───────────── */

/** JSON schema for the background read (Google structured output). */
export const SCENE_SCHEMA = {
  type: "object",
  properties: {
    location: { type: "string" },
    timeOfDay: { type: "string" },
    lightSource: { type: "string" },
    lightDirection: { type: "string" },
    lightHeight: { type: "string" },
    hardness: { type: "string" },
    colourTemperature: { type: "string" },
    shadowDirection: { type: "string" },
    shadowLength: { type: "string" },
    groundSurface: { type: "string" },
    standingSpot: { type: "string" },
    cameraHeight: { type: "string" },
    lens: { type: "string" },
    depth: { type: "string" },
  },
  required: [
    "location",
    "timeOfDay",
    "lightSource",
    "lightDirection",
    "lightHeight",
    "hardness",
    "colourTemperature",
    "shadowDirection",
    "shadowLength",
    "groundSurface",
    "standingSpot",
    "cameraHeight",
    "lens",
    "depth",
  ],
};

export const SCENE_READ_INSTRUCTION =
  "You are a photographer's assistant reading a location photo that a fashion model will later be photographed in. Answer with JSON only, each value a short concrete phrase, decided from what is visible in the photo. location: what the place is (street, rooftop, beach, interior...) in a few words. timeOfDay: morning, midday, golden hour, blue hour, night or overcast day. lightSource: the main light (direct sun, overcast sky, open shade, window light, artificial lamps...). lightDirection: where the main light comes from relative to the camera (front, front-left, left, back-left, behind, back-right, right, front-right). lightHeight: low, mid or high. hardness: hard with crisp shadow edges, or soft with diffuse edges. colourTemperature: warm golden, neutral, cool blue or mixed. shadowDirection: which way the shadows on the ground fall in the picture (toward the camera, away from the camera, to the left, to the right, diagonal...). shadowLength: none, short, medium or long. groundSurface: the surface a person would stand on (asphalt, cobblestone, sand, wooden deck, tiles...). standingSpot: the one spot in the picture where a model would naturally stand so the composition works, described by what is around it (e.g. 'on the pavement in front of the arched doorway, left of the lamp post'). cameraHeight: eye level, low (below the waist) or high (above the head). lens: wide, normal or telephoto, judged from the perspective. depth: the foreground, midground and background layers in one short sentence. Keys: location, timeOfDay, lightSource, lightDirection, lightHeight, hardness, colourTemperature, shadowDirection, shadowLength, groundSurface, standingSpot, cameraHeight, lens, depth.";

/** Turn the background read into the sentences the engine gets. Unknown or empty answers give "". */
export function parseSceneNotes(text: string): string {
  const d = parseJsonAnswer<Record<string, unknown>>(text);
  if (!d) return "";
  const v = (k: string) =>
    String(d[k] ?? "")
      .trim()
      .replace(/\.+$/, "");
  if (!v("lightDirection") && !v("shadowDirection") && !v("standingSpot")) return "";
  const noShadow =
    /^(none|no shadows?|n\/a|-)?$/i.test(v("shadowDirection")) || /^none$/i.test(v("shadowLength"));
  const bits = [
    v("location") && `Location: ${v("location")}`,
    v("timeOfDay") && `time of day: ${v("timeOfDay")}`,
    v("lightSource") && `main light: ${v("lightSource")}`,
    v("lightDirection") && `coming from the ${v("lightDirection")} of the camera`,
    v("lightHeight") && `at ${v("lightHeight")} height`,
    v("hardness") && `${v("hardness")}`,
    v("colourTemperature") && `${v("colourTemperature")} in colour`,
    noShadow
      ? "No cast shadows on the ground in this light, only a soft contact shadow under the feet"
      : v("shadowDirection") && `Shadows on the ground fall ${v("shadowDirection")}`,
    !noShadow && v("shadowLength") && `and are ${v("shadowLength")}`,
    v("groundSurface") && `Ground: ${v("groundSurface")}`,
    v("standingSpot") && `The model stands ${v("standingSpot")}`,
    v("cameraHeight") && `Camera: ${v("cameraHeight")}`,
    v("lens") && `${v("lens")} lens`,
    v("depth") && `Depth: ${v("depth")}`,
  ].filter(Boolean) as string[];
  return (
    bits.join("; ").replace(/;\s*(Shadows|No cast|Ground|The model|Camera|Depth)/g, ". $1") + "."
  );
}

/** JSON schema for the pose read (Google structured output). */
export const POSE_SCHEMA = {
  type: "object",
  properties: {
    stance: { type: "string" },
    weight: { type: "string" },
    torso: { type: "string" },
    arms: { type: "string" },
    hands: { type: "string" },
    head: { type: "string" },
    gaze: { type: "string" },
    expression: { type: "string" },
  },
  required: ["stance", "weight", "torso", "arms", "hands", "head", "gaze", "expression"],
};

export const POSE_READ_INSTRUCTION =
  "Describe only the body pose of the person in the attached photo, for another photographer to recreate with a different model. Answer with JSON only, each value one short concrete phrase. stance: legs and feet (standing, walking, leaning, feet apart, one foot forward, crossed...). weight: which leg carries the weight and how the hips sit. torso: angle of the torso to the camera (square, turned three-quarter left/right, profile) and whether it is upright or leaning. arms: what each arm does. hands: what each hand does and where it is (relaxed at the side, on the hip, touching the collar, in a pocket...). head: head angle (straight, turned, tilted, chin up or down). gaze: where the eyes look (into the camera lens, off to the left, off to the right, down, into the distance). expression: neutral, soft smile, serious, laughing. Never describe clothing, hair, face, body shape or the background. Keys: stance, weight, torso, arms, hands, head, gaze, expression.";

/** Turn the pose read into the sentences the engine gets. Unknown or empty answers give "". */
export function parsePoseNotes(text: string): string {
  const d = parseJsonAnswer<Record<string, unknown>>(text);
  if (!d) return "";
  const v = (k: string) =>
    String(d[k] ?? "")
      .trim()
      .replace(/\.+$/, "");
  if (!v("stance") && !v("arms") && !v("gaze")) return "";
  const bits = [
    v("stance") && `Stance: ${v("stance")}`,
    v("weight") && `weight: ${v("weight")}`,
    v("torso") && `torso: ${v("torso")}`,
    v("arms") && `arms: ${v("arms")}`,
    v("hands") && `hands: ${v("hands")}`,
    v("head") && `head: ${v("head")}`,
    v("gaze") && `gaze: ${v("gaze")}`,
    v("expression") && `expression: ${v("expression")}`,
  ].filter(Boolean) as string[];
  return bits.join("; ") + ".";
}

function parseJsonAnswer<T>(text: string): T | null {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const d = JSON.parse(cleaned) as unknown;
    return d && typeof d === "object" ? (d as T) : null;
  } catch {
    return null;
  }
}
