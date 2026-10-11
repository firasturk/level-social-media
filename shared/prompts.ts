import type { Config } from "./config";
import { FABRIC_CARD, FIDELITY, SCENES, backdropColors } from "./config";

export const MODE_PROMPTS: Record<Config["mode"], string> = {
  "1": "Fashion catalogue production from a mannequin or flat-lay reference. Replace the mannequin with a fully clothed photorealistic adult model wearing exactly this garment. Do not invent unseen product construction.",
  "2": "Create a lifestyle image from the supplied real model photograph. Keep the exact garment, styling and body proportions, but present a DIFFERENT photorealistic adult model face and hair suited to the garment. Never reuse the original person's face.",
  "3": "Create a new pose from the supplied real model photograph. Keep the same person's body, styling and the exact garment, but give her a DIFFERENT photorealistic face so she is not identifiable. Only the pose and framing change.",
  "5": "Premium fashion editorial (Zara / Splash style) built by the Fashion Editorial Prompt Builder from the attached photo. The outfit is the hero product and is never changed.",
  "7": "Fashion imagery written per image by the prompt builder following the creative direction. The outfit is the hero and is never changed.",
  "8": "Premium fashion editorial built by the prompt builder from the attached photo, worn by a new AI-generated model. Only the outfit, footwear, accessories and bags come from the photo; the person is replaced entirely.",
  "6": "Product packshot recolour: change ONLY the background colour of the attached product photo. The product (garment, mannequin or model, and everything on it) must stay pixel-identical: same position, scale, crop, pose, colours, print, texture, folds and edges. Do not retouch, restyle, move, crop or re-light the product.",
  "9": "No prompt: the model from the attached photo is placed in the attached background photo and takes the pose of the attached pose photo; the fixed rules do the rest.",
  "4": "Replace ONLY the background of the existing real model photograph. Preserve the model's face, body, pose, hair, hands, framing and every visible garment detail pixel for pixel. Do not redesign, recolour, retouch or move the model or garment. Match lighting and perspective of the new background to the subject.",
};

const STUDIO_LIGHT =
  "Professional studio: soft, even key light from the front-left with gentle fill, no harsh shadows, floor the same colour as the backdrop, no props, no windows.";

/** Card text for mode 1. Cards 2-5 share one backdrop and lighting; the studio set is built from the same model as card 1. */
function mode1Shot(card: number, backdrop: string): string {
  switch (card) {
    case 1:
      return "Card 1: lifestyle location image, full-length front view, relaxed standing pose.";
    case 2:
      return `Card 2: studio shot. ${backdrop}. ${STUDIO_LIGHT} Full-length front view, standing, weight on one leg.`;
    case 3:
      return `Card 3: studio shot. Exactly the same ${backdrop} and identical lighting as card 2. Three-quarter view showing the garment side, standing.`;
    case 4:
      return `Card 4: studio shot. Exactly the same ${backdrop} and identical lighting as card 2. The model is SEATED on a low plain cube in the same colour as the backdrop, legs together, garment fully visible and unwrinkled.`;
    case 5:
      return `Card 5: studio shot. Exactly the same ${backdrop} and identical lighting as card 2. Back view, standing, garment fully visible.`;
    default:
      return "Card 6: FABRIC ONLY. Extreme macro close-up of the garment's textile filling the whole frame: weave, lace or knit structure, stitching and texture in sharp focus. ABSOLUTELY NO person, mannequin, body, face, limbs, hanger or background. Crop straight into the fabric of the reference garment.";
  }
}

const POSES = [
  "Full-length front view, relaxed standing pose.",
  "Three-quarter view, casual walking pose.",
  "Side profile, full garment visible.",
  "Seated lifestyle pose, garment unobstructed.",
  "Leaning casually against a wall, garment unobstructed.",
  "Candid mid-step pose, looking away from camera.",
];

export const CENTERING =
  "Composition: exactly ONE model. Centre the midpoint of the full model bounding box at x=50% of frame width, equal margins left and right. Keep head, hands, garment and feet fully inside the frame.";

export interface PromptImages {
  /** true when a real model identity reference is attached as image 2 */
  identity?: boolean;
  /** true when card 1's result is attached as the consistency reference (mode 1, cards 2-5) */
  firstCard?: boolean;
  /** true when card 2's studio result is attached as the backdrop/lighting reference (mode 1, cards 3-5) */
  studio?: boolean;
  /** true when the latest result is attached as the last image for a revision */
  revision?: boolean;
  /** true when a reference-library photo is attached after the garment photo */
  mood?: boolean;
  /** true when an already generated image of the same product set is attached after the reference */
  set?: boolean;
  /** No prompt: a background photo is attached as the next image */
  background?: boolean;
  /** No prompt: a pose photo is attached after the background */
  pose?: boolean;
}

/** Scene for a given card, cycling through the scene list. */
export function sceneFor(_c: Config, card: number): string {
  return SCENES[(card - 1) % SCENES.length];
}

/**
 * Whether the prompt asks for a centred model and the reviewer may queue a centring retry.
 * Modes 4 and 6 keep the source framing; every other approach, the skill campaigns included,
 * composes its own frame and centres the model.
 */
export function centeringApplies(c: Config, card: number): boolean {
  return c.center && card !== FABRIC_CARD && c.mode !== "4" && c.mode !== "6";
}

/** Build the full generation prompt for one card. Deterministic so it can be stored and audited. */
export function buildPrompt(c: Config, card: number, edit = "", images: PromptImages = {}): string {
  const fidelity = `Product fidelity: preserve ${FIDELITY}. Preserve colour, seams, logo, buttons, silhouette, hem and fit exactly. No added text or watermarks. The original photo is the source of truth.`;
  const parts: string[] = [MODE_PROMPTS[c.mode], `Source type: ${c.input}.`];

  if (c.mode === "1") {
    if (card !== FABRIC_CARD) parts.push(`Model direction: ${c.modelDescription}.`);
    parts.push(mode1Shot(card, c.backdrop || "warm beige seamless paper backdrop"));
    if (card === 1) parts.push(`Location: ${c.prompt} ${sceneFor(c, 1)}`);
    if (card > 1 && card < FABRIC_CARD)
      parts.push(
        "Use the exact same model face, hair, body and garment as card 1. Studio setting only.",
      );
  } else if (c.mode === "2") {
    parts.push(`Model direction: ${c.modelDescription}.`);
    parts.push(`Lifestyle scene: ${c.prompt} ${sceneFor(c, card)}`);
    parts.push(POSES[(card - 1) % POSES.length]);
  } else if (c.mode === "3") {
    parts.push(`New pose: ${POSES[(card - 1) % POSES.length]}`);
    parts.push(`Setting: ${c.prompt} ${sceneFor(c, card)}`);
  } else if (c.mode === "6") {
    const colour = backdropColors(c)[(card - 1) % backdropColors(c).length];
    parts.push(
      `New background: a flat, perfectly even, seamless solid ${colour} backdrop filling the whole frame behind the product. Keep a soft, natural contact shadow under the product consistent with the original lighting; no gradients, textures, props or vignette unless the original had them. Edges of the product must stay clean with no halo or colour fringing.`,
    );
    if (c.prompt) parts.push(c.prompt);
  } else if (c.mode === "5" || c.mode === "8") {
    parts.push("Editorial prompt is written per image by the prompt builder before generation.");
    if (c.mode === "8") parts.push(NEW_MODEL_RULE);
    if (c.prompt) parts.push(`City / mood preference: ${c.prompt}`);
  } else if (c.mode === "7") {
    parts.push("Prompt is written per image by the prompt builder from the creative direction.");
    if (c.prompt) parts.push(`Creative direction: ${c.prompt}`);
  } else {
    parts.push(`New background for this image: ${sceneFor(c, card)} ${c.prompt}`);
    parts.push("Keep the model, pose, framing and garment exactly as in the source photo.");
  }

  parts.push(fidelity);
  // Every approach that shows a person keeps the upload's crop and tidy hair; the fabric macro and
  // the packshot recolour have no model to frame.
  if (c.mode !== "6" && !(c.mode === "1" && card === FABRIC_CARD)) {
    parts.push(framingRule());
    parts.push(HAIR_RULE);
    // Approaches 2 and 3 change the model on purpose; the others keep the person exactly.
    if (c.mode !== "2" && c.mode !== "3") parts.push(IDENTITY_RULE);
    parts.push(TATTOO_RULE);
  }
  if (c.mode === "1" && card === FABRIC_CARD)
    parts.push(
      "Output must be a flat textile macro photograph only. If a person would appear, the result is wrong.",
    );
  if (centeringApplies(c, card)) parts.push(CENTERING);
  if (edit)
    parts.push(
      `Revision of the existing result: ${edit}. Change only what is requested; keep all other details.`,
    );

  const roles: string[] = [
    "Image 1 is the exact source for the outfit, footwear and any accessories worn: keep them identical.",
  ];
  if (images.identity) roles.push("Image 2 is the real model identity reference.");
  if (images.firstCard)
    roles.push(
      "Image 2 is card 1: it establishes the model's face, hair and body. Keep this exact same model across the studio cards.",
    );
  if (images.studio)
    roles.push(
      "Image 3 is card 2: copy its backdrop colour, floor, lighting direction and softness exactly so the studio set looks like one shoot.",
    );
  if (images.revision) roles.push("The LAST image is the existing result to revise.");
  if (roles.length > 1) parts.push(roles.join(" "));
  return parts.filter(Boolean).join("\n\n");
}

/** Final prompt for an editorial card: the builder's prompt plus roles, revision and the negative block. */
/** Engine-facing rule for the new-model skill campaign: the person is replaced, what is worn is kept. */
export const NEW_MODEL_RULE =
  "NEW MODEL: the person in the reference photo is NOT reproduced. Generate an entirely different, AI-created professional model: a new face, hair, skin tone, build and identity that do not resemble the original person in any way. Take from the reference photo ONLY what is worn: every garment, the footwear, and any accessories or bags, all kept identical in colour, print, construction, length and fit. Keep the same framing and crop as the reference.";

/** Engine-facing hair rule: tidy hair, no wind-blown or stray strands. */
export const HAIR_RULE =
  "HAIR: neat and settled, exactly as styled in the reference photo when the model is kept; no wind-blown, flying, floating or stray strands, no hair across the face or eyes.";

/** Engine-facing identity rule: the person in the reference photo is the model in the output. */
export const IDENTITY_RULE =
  "IDENTITY (highest priority): the model is the same person as in the reference photo (image 1), reproduced exactly: identical face and facial structure (face shape, jawline, nose, lips, eyes, eyebrows, cheekbones), identical skin tone, age and body; no identity change, no beautifying, no averaging, no different person. HAIRSTYLE: the same hairstyle as the reference photo, same length, colour, parting, texture and styling; do not restyle, cut, lengthen or recolour the hair. When the face is not visible in the reference photo, it is not visible in the output either.";

/** Engine-facing rule for every approach: tattoos on the model never appear in the output. */
export const TATTOO_RULE =
  "TATTOOS: if the person in the reference photo has any tattoo, it is removed in the output; the skin there is clean and natural, with no tattoo, ink, marking or trace of it anywhere on the body.";

/** Engine-facing light rule for Zaid creative direction. */
export const LIGHT_RULE =
  "LIGHT: real sun, golden-hour sun (low, warm, long soft shadows) or midday sun (high, clean, short shadows) as the prompt names it; never overcast, dusk, night or artificial light. Bright but balanced: open shadows and no blown-out highlights; no dim, murky, heavy-shadow or harsh high-contrast lighting. The model is evenly lit and the garment colours read true.";

/** Engine-facing integration rule for Zaid creative direction: the model belongs to the scene. */
export const BLEND_RULE =
  "INTEGRATION: the model is physically part of the scene, never a cutout or a pasted-on figure. The same sun direction, colour temperature and contrast on the model as on the background; feet planted on the ground with a true contact shadow and a cast shadow matching the scene's other shadows; matching perspective and camera height; identical grain, sharpness and colour grade on model and background; reflected light and ambient colour from the surroundings on skin and garment; natural edges with no halo or outline.";

/** Engine-facing background detail rule for Zaid creative direction. */
export const DETAIL_RULE =
  "BACKGROUND DETAIL: render the whole background in full, crisp, high-resolution detail: architecture, facades, materials, textures, signage, foliage, street furniture, floor surfaces and distant layers all sharply defined and rich. Only a gentle, natural depth of field that keeps the entire setting readable; never an empty, plain, smeared, washed-out or heavily blurred background.";

/**
 * No prompt approach: the engine gets the model photo, a background photo and a pose photo, and a
 * short fixed prompt instead of a written one. Light, shadows and colour come from the background
 * photo; the stance comes from the pose photo; everything about the person from image 1.
 */
export function buildNoPromptPrompt(
  framing: string | undefined,
  handsInPockets: boolean,
  backView: boolean,
  images: PromptImages,
  edit = "",
  notes: { scene?: string; pose?: string } = {},
): string {
  // With a background the location photo is image 1 and the model photo image 2, so the engine
  // adds the person into the photograph instead of cutting the person out of the model photo.
  const model = images.background ? 2 : 1;
  let idx = model + 1;
  const parts: string[] = [];
  if (images.background) {
    parts.push(
      `Image 1 is a photograph of a LOCATION. Image ${model} is a MODEL wearing an OUTFIT. Make the photograph that a professional fashion photographer would have taken if the model from image ${model} had been standing in the location of image 1 at the moment image 1 was taken: one single editorial fashion photograph, shot in one exposure, with one light, one camera and one colour grade for the person and the place. Every garment, the footwear and any accessory from image ${model} stay exactly as worn, nothing added, removed or restyled.`,
      `LOCATION: keep the place of image 1 recognisably the same: its architecture, surfaces, materials, props, time of day, weather and light. The scene may be re-framed and re-rendered around the model so that the model's crop fills the frame naturally; the camera stays at the height and distance a photographer would use for that crop. Add nothing that is not in the location and remove nothing from it.`,
      RELIGHT_RULE,
    );
    if (notes.scene) parts.push(`SCENE READ (facts taken from the location photo): ${notes.scene}`);
    parts.push(
      /no cast shadows/i.test(notes.scene ?? "") ? SOFT_SHADOW_RULE : SHADOW_RULE,
      SCALE_RULE,
    );
  } else
    parts.push(
      "Editorial fashion photograph of the model from image 1, photographed on location by a professional fashion photographer. Image 1 is the model and the outfit: every garment, the footwear and any accessory stay exactly as worn, nothing added, removed or restyled.",
    );
  parts.push(EDITORIAL_STYLE_RULE, identityFor(model), TATTOO_RULE);
  if (images.pose) {
    parts.push(
      `Image ${idx++} is the POSE reference: copy only the body pose from it: stance, weight distribution, torso angle, each arm and hand, leg positions, head angle and the direction of the gaze. Never copy its clothing, face, hair, body shape, accessories or background; the person in the output is the person from image ${model} in the outfit from image ${model}.`,
    );
    if (notes.pose) parts.push(`POSE READ (facts taken from the pose photo): ${notes.pose}`);
  } else parts.push(`POSE: keep the model's pose as in image ${model}, natural and relaxed.`);
  if (!backView && framing !== "LOWER_BODY") parts.push(eyesFor(model));
  parts.push(ANATOMY_RULE);
  parts.push(
    framingRule(framing, handsInPockets).replace(
      /reference photo/g,
      `model photo (image ${model})`,
    ),
  );
  if (backView)
    parts.push(BACK_VIEW_RULE.replace("The reference photo", `The model photo (image ${model})`));
  parts.push(CENTERING);
  if (edit)
    parts.push(
      `Revision of the existing result: ${edit}. Change only what is requested; keep all other details.`,
    );
  if (images.revision) parts.push("The LAST image is the existing result to revise.");
  parts.push(
    `AVOID: ${["different face, altered facial features, changed hairstyle, different hair length or colour", "crossed eyes, asymmetric eyes, misaligned pupils, glassy or blank eyes, eyes looking in two directions", "tattoos, tattoo, body ink", "cutout look, pasted-on model, collage, photo montage, floating feet, missing contact shadow, mismatched lighting, halo edges, the studio lighting of the model photo kept", "wrong shadow direction, shadow falling toward the light, double shadows, a shadow from a second light source", "wrong scale, model too large or too small for the spot, model not on the ground plane", "studio look, flat studio lighting, over-smoothed plastic skin, HDR glow", "clothing or accessories from the pose photo, a second person", "extra limb, third arm, third leg, extra hand, extra foot, merged poses", handsInPockets ? "" : "hands in pockets"].filter(Boolean).join(", ")}`,
  );
  return parts.join("\n\n");
}

function identityFor(model: number): string {
  return IDENTITY_RULE.replace("(image 1)", `(image ${model})`);
}

function eyesFor(model: number): string {
  return EYES_RULE.replace("as in image 1", `as in image ${model}`);
}

/** Engine-facing re-light rule for the No prompt approach: the model photo's studio light is discarded. */
export const RELIGHT_RULE =
  "RE-LIGHT: the model photo was taken in a studio under flat, even, shadowless light against a plain backdrop. That light does not exist in the output. Discard it completely and light the person and the garment only with the light of the location: the same source, direction, height, hardness and colour temperature as everything else in the scene, with real highlights and shadows on the face, the skin, the hair and the fabric, reflected light and ambient colour from the surroundings, the same exposure, contrast, grain and colour grade as the location. Keep the garment's true colour and print under that light. The person must look photographed in that place, never lifted from another photo.";

/** Engine-facing editorial look for the No prompt approach. */
export const EDITORIAL_STYLE_RULE =
  "STYLE: a high-end editorial fashion photograph, not a catalogue cutout: shot on location with a full-frame camera and a 50-85 mm lens at a natural working distance, true-to-life skin texture, fabric weave and fibres, natural depth of field with the location still readable, honest colour and contrast as the scene gives them; no HDR glow, no over-smoothed skin, no studio flash, no stock-photo flatness.";

/** Engine-facing shadow rule for the No prompt approach (a scene with visible cast shadows). */
export const SHADOW_RULE =
  "SHADOWS: the model casts exactly one shadow on the ground, in the same direction, length, softness and darkness as the shadows already present in the location photo; it starts at the feet or at the point of contact, lies flat on the ground surface and follows the ground's perspective. A soft contact shadow sits under the soles. The body's own shadows (under the chin, under the arms, inside folds, the far side of the face and garments) all follow the same light direction. No shadow falls toward the light, no second shadow, no missing shadow, no shadow from a light that is not in the scene.";

/** Engine-facing shadow rule for the No prompt approach (overcast or open shade: no hard cast shadow). */
export const SOFT_SHADOW_RULE =
  "SHADOWS: the location has soft, diffuse light with no hard cast shadows, so the model has no hard shadow either: only a soft, dark contact shadow directly under the soles and between the feet, fading out within a short distance, exactly like the soft shadows under the objects already in the location photo. The body's own shading is soft and gentle, slightly darker under the chin, under the arms and inside folds, with the top of the head and shoulders a little brighter from the sky. No hard-edged shadow, no shadow from a sun that is not in the scene, no floating feet.";

/** Engine-facing scale and perspective rule for the No prompt approach. */
export const SCALE_RULE =
  "SCALE AND PERSPECTIVE: the model stands on the ground at the standing spot in the location photo, drawn at the right size for that distance from the camera; the location photo's camera height, lens perspective, horizon and vanishing lines apply to the model too, so feet, hips and head sit where a person that size would in that spot. Elements in front of that spot overlap the model naturally; elements behind stay behind. The model is in the scene's space, not in front of a picture of it.";

/** Engine-facing eyes rule for the No prompt approach. */
export const EYES_RULE =
  "EYES: both eyes exactly as in image 1: the same shape, colour, size, spacing, eyelids and brows. Both eyes open, sharp and in focus, with the same catchlight from the scene's light in each; the pupils aligned and looking in the same direction, following the gaze described in the pose; a natural, alive expression. Never crossed, wall-eyed, asymmetric, enlarged, glassy, blank or looking in two directions.";

/** Engine-facing pose rule for the builder approaches: the written pose, never image 1's stance. */
export const POSE_RULE =
  "POSE: the stance, the position of each arm, hand, leg and foot, the weight and the head direction are ONLY the ones written in the prompt above. Image 1 gives the person, the hair and the outfit, not the pose: do not keep image 1's stance, arm positions or hand positions, and never mix image 1's pose with the written one. The written pose is one body in one moment.";

/** Engine-facing anatomy rule: one person, the right number of limbs, nothing left over from another pose. */
export const ANATOMY_RULE =
  "ANATOMY: exactly one person with one head, two arms, two hands with five fingers each, two legs and two feet, every one of them belonging to the single written pose. No extra arm, hand, leg or foot, no duplicated limb, no limb or shoe left over from another pose, no hand that is both in a pocket and elsewhere, no foot that is both planted and stepping.";

/** Engine-facing back-view rule: a model photographed from behind stays photographed from behind. */
export const BACK_VIEW_RULE =
  "BACK VIEW: the reference photo shows the model from behind. Keep exactly this back view: the model faces away from the camera, no face is shown, the back of the hairstyle and the back of every garment are what is seen; never turn the model around, never add a face or a profile.";

/** Engine-facing framing lock: the output crop is the upload's crop, nothing outside it is drawn. */
export function framingRule(framing?: string, handsInPockets = false): string {
  const hands = handsInPockets
    ? " Hands: one hand may rest in a pocket, as in the reference photo, only where the written pose says so; that hand is then nowhere else."
    : " Hands: no hand in a pocket; hands stay out of pockets, relaxed and visible.";
  if (framing === "UPPER_BODY")
    return (
      "FRAMING LOCK: upper body only, cropped at the same line as the reference photo (around the waist or hips). Do not show or invent legs, trousers, skirts, footwear or anything below that line; nothing outside the reference crop exists in this image." +
      hands
    );
  if (framing === "LOWER_BODY")
    return (
      "FRAMING LOCK: lower body only, from the waist down exactly as the reference photo is cropped. Do not show or invent the face, the top garments or anything above that line; nothing outside the reference crop exists in this image. The hands are visible inside the frame, relaxed and natural, in a position that fits the scene and the body's movement; never cropped out or raised above the crop line." +
      hands
    );
  if (framing === "THREE_QUARTER")
    return (
      "FRAMING LOCK: three-quarter body, from above the head down to the same line as the reference photo (between mid-thigh and just below the knees). Do not show or invent feet or footwear; nothing outside the reference crop exists in this image." +
      hands
    );
  if (framing === "FULL_BODY")
    return (
      "FRAMING LOCK: full body, head to footwear completely inside the frame, as in the reference photo. Nothing is worn in this image that is not visible in the reference photo: no added shoes, bags, hats, jewellery or layers." +
      hands
    );
  return (
    "FRAMING LOCK: keep exactly the reference photo's crop. A full-body photo stays full body with footwear inside the frame; an upper-body photo stays upper body and ends at the same line, with no legs, trousers or footwear drawn; a lower-body photo stays lower body and starts at the same line, with no face or top drawn. Nothing is worn in this image that is not visible in the reference photo: no added shoes, bags, hats, jewellery or layers." +
    hands
  );
}

/** Creative direction: which engine-side rules are on (absent means on). */
export interface EngineRuleFlags {
  identity?: boolean;
  tattoos?: boolean;
  framing?: boolean;
  hands?: boolean;
  light?: boolean;
  detail?: boolean;
  integration?: boolean;
  composition?: boolean;
  grain?: boolean;
}

/** Engine-facing film-grain finish for Creative direction. */
export const GRAIN_RULE =
  "FILM GRAIN: finish the whole image with a clearly visible, fine, even analog film grain, as in a professionally scanned 35mm colour negative at ISO 400: the grain is noticeable at normal viewing size without zooming in, organic and uniform across the model, the garment, the skin, the background and the sky, strongest in the midtones and shadows; slightly softened micro-contrast, a gentle bloom on the brightest sunlit edges and backlit hair, natural restrained colour. It is a real film texture, not a faint hint; still never coarse or clumpy, not digital noise, not a heavy vintage filter, and it never blurs or softens the detail of the face, the garment or the setting.";

export function buildEditorialPrompt(
  briefPrompt: string,
  negative: string,
  edit = "",
  images: PromptImages = {},
  newModel = false,
  center = true,
  framing?: string,
  handsInPockets = false,
  relaxed = false,
  backView = false,
  flags: EngineRuleFlags = {},
): string {
  // Creative direction: each engine-side rule follows the team's switch for the matching fixed rule.
  const on = (k: keyof EngineRuleFlags) => !relaxed || flags[k] !== false;
  const parts = [briefPrompt.trim()];
  if (newModel) parts.push(NEW_MODEL_RULE);
  else if (on("identity")) parts.push(IDENTITY_RULE);
  if (on("tattoos")) parts.push(TATTOO_RULE);
  if (on("framing")) parts.push(framingRule(framing, handsInPockets && on("hands")));
  if (backView && on("framing")) parts.push(BACK_VIEW_RULE);
  parts.push(POSE_RULE, ANATOMY_RULE);
  // Creative direction: hair follows the direction; the light is bright but balanced.
  if (relaxed) {
    if (on("light")) parts.push(LIGHT_RULE);
    if (on("detail")) parts.push(DETAIL_RULE);
    if (on("integration")) parts.push(BLEND_RULE);
    if (on("grain")) parts.push(GRAIN_RULE);
  } else parts.push(HAIR_RULE);
  if (center && on("composition")) parts.push(CENTERING);
  if (edit)
    parts.push(
      `Revision of the existing result: ${edit}. Change only what is requested; keep all other details.`,
    );
  const roles: string[] = [
    newModel
      ? "The attached first image is the reference photo of the outfit only: keep every garment, the footwear and any accessory or bag worn in it identical, nothing added or removed. Do not reproduce the person, face, hair or body from it; the model is newly generated."
      : "The attached first image is the reference photo of the outfit and model: keep every garment, the footwear and any accessory worn in it identical, nothing added or removed.",
  ];
  let idx = 2;
  if (images.mood)
    roles.push(
      `Image ${idx++} is a visual reference: use it only for the background/setting, the lighting and the camera angle; its stance was already turned into the written pose above, so the pose comes from the written prompt, not from image 1 and not from a mix of the two. Never copy its clothing, face, hats, bags, accessories or exact spot. Keep the framing of image 1 (full body stays full body, three-quarter stays three-quarter, an upper-body crop stays upper-body, a lower-body crop stays lower-body, a back view stays a back view).${
        relaxed && framing === "FULL_BODY"
          ? " For this full-body image reproduce the reference's camera angle, camera height, tilt and distance exactly as the prompt describes them."
          : ""
      }`,
    );
  if (images.set)
    roles.push(
      `Image ${idx++} is an already generated image of the same product: reproduce its background, lighting, colour grade and camera distance exactly so both images read as one shoot. Only the crop follows image 1; the pose is the one written in the prompt, which differs from the sibling's pose and from image 1's stance.`,
    );
  if (images.revision) roles.push("The LAST image is the existing result to revise.");
  // The image-1 rule stands alone when the person is being replaced; otherwise only with extra images.
  if (roles.length > 1 || newModel) parts.push(roles.join(" "));
  const avoid = [
    negative,
    relaxed
      ? [
          on("light")
            ? "dim scene, murky light, overcast sky, blown-out highlights, harsh shadows"
            : "",
          on("detail")
            ? "empty background, smeared background, heavy background blur, low-detail background"
            : "",
          on("integration")
            ? "cutout look, pasted-on model, floating feet, missing contact shadow, mismatched lighting, halo edges"
            : "",
          on("grain")
            ? "digital noise, coarse clumpy grain, grain-free plastic-smooth digital look, vintage filter, oversharpened"
            : "",
        ]
          .filter(Boolean)
          .join(", ")
      : "wind-blown hair, flying hair strands, messy hair",
    handsInPockets || !on("hands") ? "" : "hands in pockets",
    "extra limb, third arm, third leg, extra hand, duplicated hand, extra foot, extra shoe, merged poses, the pose of the outfit photo kept",
    on("tattoos") ? "tattoos, tattoo, body ink" : "",
    newModel || !on("identity")
      ? ""
      : "different face, altered facial features, changed hairstyle, different hair length or colour",
  ]
    .filter(Boolean)
    .join(", ");
  parts.push(`AVOID: ${avoid}`);
  return parts.join("\n\n");
}

export const RECENTER_SUFFIX =
  "Correct composition: full person bounding box exactly at x=50%. Preserve garment and entire body.";

/**
 * A short, plain prompt used for the one retry after a content checker refused the full prompt:
 * the scene, pose and light in one line each, the outfit lock and the fixed rules, nothing else.
 */
export function buildCompactPrompt(
  brief: { scene: string; pose: string; light: string; garments: string; negative: string },
  newModel: boolean,
  center: boolean,
  framing?: string,
  handsInPockets = false,
): string {
  const parts = [
    `Catalogue lifestyle photograph of the model from the reference photo wearing exactly the supplied outfit (${brief.garments}). Setting: ${brief.scene}. Pose: ${brief.pose}. Light: ${brief.light}. Photorealistic, natural colour, clean editorial look.`,
    newModel ? NEW_MODEL_RULE : IDENTITY_RULE,
    framingRule(framing, handsInPockets),
    "POSE: only the pose written above; not the stance of image 1. One person, two arms, two hands, two legs, two feet, no extra limb.",
  ];
  if (center) parts.push(CENTERING);
  parts.push(
    `AVOID: ${[brief.negative, handsInPockets ? "" : "hands in pockets"].filter(Boolean).join(", ")}`,
  );
  return parts.join("\n\n");
}
