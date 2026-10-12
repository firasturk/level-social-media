/**
 * Creative direction (mode 7): the fixed rules every prompt follows. The team sees, edits, adds and
 * removes them in the studio; the list is stored once (settings) and read on every prompt. Each
 * built-in rule has a key, so the engine-side companion rule (light, detail, integration, identity,
 * tattoos, framing, centring) follows the same switch.
 */
export interface DirectionRule {
  /** Stable id. Built-in rules keep their key; team rules get `custom-<n>`. */
  key: string;
  title: string;
  text: string;
  enabled: boolean;
}

export const DEFAULT_DIRECTION_RULES: DirectionRule[] = [
  {
    key: "outfit",
    title: "Outfit lock",
    text: "OUTFIT: everything worn in image 1 stays exactly as it is, garments, footwear and any accessory already in the photo, nothing added, removed or invented.",
    enabled: true,
  },
  {
    key: "framing",
    title: "Framing lock",
    text: "FRAMING LOCK: the output crop equals the upload crop, an upper-body upload stays upper body and ends at the same line with no legs or footwear drawn, a lower-body upload stays lower body and starts at the same line with no face or top drawn, a full-body upload stays full body with footwear visible, a three-quarter upload (head to around the knees) stays three-quarter and ends at the same line with no feet drawn, and a back-view upload stays a back view with the model facing away and no face shown.",
    enabled: true,
  },
  {
    key: "reference",
    title: "Reference use",
    text: "A reference image contributes only setting, pose and stance, lighting and camera angle.",
    enabled: true,
  },
  {
    key: "props",
    title: "No props from references",
    text: "Never copy hats, bags, sunglasses, jewellery or props from a reference.",
    enabled: true,
  },
  {
    key: "hands",
    title: "Hands and pockets",
    text: "HANDS: a hand goes into a pocket only when the upload shows a hand in a pocket; otherwise hands stay out of pockets, relaxed and visible.",
    enabled: true,
  },
  {
    key: "pose",
    title: "Pose: one coherent pose, not the upload's",
    text: "POSE: write one coherent pose that is different from the upload's stance, as one body in one moment: state explicitly where the left arm, the right arm, each hand, the left leg and the right leg are, how the weight sits and where the head looks; never give the same limb two positions, never a hand both in a pocket and elsewhere, never a stepping foot and a planted foot for the same leg; say in the prompt that the upload's own stance is not kept Keep the pose simple and readable for a catalogue: both hands stay below shoulder level and away from the face, forehead, hair and head; no arm raised, no shading of the eyes, no hand on the neck or cheek, no arms crossed over the chest or the garment's front print; the full front of the garment stays visible.",
    enabled: true,
  },
  {
    key: "catalogue",
    title: "Catalogue-safe wording",
    text: "Catalogue-safe wording only.",
    enabled: true,
  },
  {
    key: "identity",
    title: "Identity: face and hairstyle",
    text: "IDENTITY: when the model is kept, the face and facial structure are reproduced exactly as in image 1 (face shape, jawline, nose, lips, eyes, eyebrows, cheekbones, skin tone, age), and the hairstyle is kept exactly (length, colour, parting, texture, styling); write this explicitly in the FACE & HAIR section and never describe a different or idealised face or a restyled hair.",
    enabled: true,
  },
  {
    key: "tattoos",
    title: "Tattoos removed",
    text: "TATTOOS: any tattoo visible on the person in image 1 is removed in the output; state in the prompt that the skin is clean with no tattoo or ink, and add tattoos to the AVOID list.",
    enabled: true,
  },
  {
    key: "light",
    title: "Light: golden hour or midday sun",
    text: "LIGHT: real sun, either golden-hour sun (low, warm, long soft shadows) or midday sun (high, clean, short shadows), chosen per image and named in the prompt; never overcast, dusk, night or artificial light; the scene is bright but balanced, with open shadows and no blown-out highlights, no dim, murky, heavy-shadow or high-contrast scenes; the model is lit evenly and the garment colours read true.",
    enabled: true,
  },
  {
    key: "grain",
    title: "Film grain",
    text: "FILM GRAIN: every image carries a clearly visible, fine, even analog film grain over the whole frame, like a professionally scanned 35mm colour negative at ISO 400: the grain is noticeable at normal viewing size without zooming in, organic and uniform, strongest in the midtones and shadows and present in the skin, the garment and the sky alike; slightly softened micro-contrast, a gentle bloom on the brightest sunlit edges and backlit hair, natural restrained colour; write this in the prompt's photographic treatment section as a real film texture (not a faint hint), still never coarse or clumpy, never digital noise, never a vintage filter, never blur or loss of detail.",
    enabled: true,
  },
  {
    key: "integration",
    title: "Integration: model part of the scene",
    text: "INTEGRATION: the model is a real part of the scene, not a cutout: the same sun direction, colour temperature and contrast on the model as on the background, feet planted on the ground with a true contact shadow and a cast shadow that matches the scene's shadows, matching perspective and camera height, the same grain, sharpness and colour grade on model and background, reflected light and ambient colour from the surroundings on skin and garment, and described in the prompt.",
    enabled: true,
  },
  {
    key: "camera",
    title: "Camera angle from the reference",
    text: "CAMERA ANGLE: for a FULL_BODY upload the camera angle, camera height, tilt, lens feel and distance are taken from the attached reference photo (image 2) and described explicitly in the CAMERA section (low angle from knee height, eye level, slightly high, three-quarter view, wide with environment, tight full body); the library's angles are meant to vary across the set, so never default to a straight eye-level frontal view; for an UPPER_BODY or LOWER_BODY upload the camera stays on the crop and only the reference's angle direction is borrowed.",
    enabled: true,
  },
  {
    key: "detail",
    title: "Background detail",
    text: "BACKGROUND DETAIL: the background is rendered in full, crisp detail, every element named and described in the prompt (architecture, facades, materials, textures, signage, foliage, street furniture, floor surfaces, distant layers), sharply defined and rich, with only a gentle natural depth of field that keeps the whole setting readable; never an empty, plain, smeared, washed-out or heavily blurred background.",
    enabled: true,
  },
  {
    key: "composition",
    title: "Composition: centred model",
    text: "COMPOSITION: the model is centred on the vertical axis of the frame, the midpoint of the full body at x=50% with equal space left and right, never pushed to one side; architecture, street or furniture may frame the model symmetrically but never offset them. Say this explicitly in the prompt's composition section.",
    enabled: true,
  },
];

/** The paragraph the prompt builder gets: the enabled rules, numbered in the team's order. */
export function composeFixedRules(rules: DirectionRule[]): string {
  const active = rules.filter((r) => r.enabled && r.text.trim());
  if (!active.length) return "";
  return `Fixed rules for every prompt (they override the skill's own direction, template and library, including any default framing such as full body): ${active
    .map((r, i) => `(${i + 1}) ${r.text.trim().replace(/[.;]\s*$/, "")}`)
    .join("; ")}.`;
}

/** Whether a built-in rule is present and on (an absent key counts as off). */
export function ruleOn(rules: DirectionRule[] | undefined, key: string): boolean {
  if (!rules) return true;
  return rules.some((r) => r.key === key && r.enabled);
}

/** Earlier wordings of built-in rules: a stored copy the team never edited is upgraded to the current text. */
const SUPERSEDED_TEXTS: Record<string, string[]> = {
  pose: [
    "POSE: write one coherent pose that is different from the upload's stance, as one body in one moment: state explicitly where the left arm, the right arm, each hand, the left leg and the right leg are, how the weight sits and where the head looks; never give the same limb two positions, never a hand both in a pocket and elsewhere, never a stepping foot and a planted foot for the same leg; say in the prompt that the upload's own stance is not kept.",
  ],
  grain: [
    "FILM GRAIN: every image carries a subtle, fine, even analog film grain over the whole frame, like a professionally scanned 35mm colour negative: fine organic grain visible in the midtones and shadows, slightly softened micro-contrast, a gentle bloom on the brightest sunlit edges and backlit hair, natural restrained colour; write this in the prompt's photographic treatment section as a delicate finishing texture that stays uniform across model and background, never heavy, never digital noise, never a vintage filter, never blur or loss of detail.",
  ],
};

/** What is stored: the team's list plus the built-in keys they removed (so a new built-in still appears). */
export interface StoredDirectionRules {
  rules: DirectionRule[];
  removed: string[];
}

/** Prepares the team's list for storage, remembering which built-in rules they removed. */
export function storeDirectionRules(rules: DirectionRule[]): StoredDirectionRules {
  const keys = new Set(rules.map((r) => r.key));
  return {
    rules,
    removed: DEFAULT_DIRECTION_RULES.map((r) => r.key).filter((k) => !keys.has(k)),
  };
}

/**
 * Reads a stored list, falling back to the defaults when absent or unreadable. A built-in rule
 * added after the team saved their list is appended, unless they removed it on purpose.
 */
export function parseDirectionRules(raw: string | null | undefined): DirectionRule[] {
  if (!raw) return DEFAULT_DIRECTION_RULES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const stored: unknown = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as StoredDirectionRules).rules)
        ? (parsed as StoredDirectionRules).rules
        : null;
    const removed = new Set(
      !Array.isArray(parsed) && parsed && typeof parsed === "object"
        ? ((parsed as StoredDirectionRules).removed ?? [])
        : [],
    );
    if (!Array.isArray(stored)) return DEFAULT_DIRECTION_RULES;
    const d = stored;
    const list = d
      .filter(
        (r): r is DirectionRule =>
          !!r && typeof r === "object" && typeof (r as DirectionRule).text === "string",
      )
      .map((r, i) => ({
        key: typeof r.key === "string" && r.key ? r.key : `custom-${i + 1}`,
        title: typeof r.title === "string" ? r.title : "",
        text: r.text,
        enabled: r.enabled !== false,
      }));
    for (const r of list) {
      const current = DEFAULT_DIRECTION_RULES.find((d) => d.key === r.key);
      if (current && (SUPERSEDED_TEXTS[r.key] ?? []).includes(r.text.trim())) {
        r.text = current.text;
        if (!r.title) r.title = current.title;
      }
    }
    const present = new Set(list.map((r) => r.key));
    for (const r of DEFAULT_DIRECTION_RULES)
      if (!present.has(r.key) && !removed.has(r.key)) list.push(r);
    return list;
  } catch {
    return DEFAULT_DIRECTION_RULES;
  }
}
