/**
 * Policy-safe wording. Image engines refuse prompts (and sometimes whole accounts get flagged) over
 * a handful of words that have no place in catalogue photography anyway. The builder is told the
 * rule, and the server runs every prompt through the same filter before it leaves.
 */
export const SAFE_WORDING_RULE = `SAFE WORDING (mandatory, every prompt):
- Describe people as models in a retail catalogue. Never describe bodies as attractive, sensual, seductive, sexy, alluring, provocative, sultry or similar; never mention bare skin, curves, wet looks, parted lips or body-hugging fits. Use neutral words: fitted, relaxed, confident, calm, elegant, playful.
- Children: describe them only as "child model" with an age band, happy and natural; no makeup, no posed sunglasses, no adult poses or expressions, no wording about their bodies beyond "natural child proportions".
- Underwear, swimwear and sleepwear: plain product words (bra, briefs, swimsuit, pyjama set), calm upright poses, catalogue tone.
- Never ask for nudity, transparency, see-through fabric or a changed body shape.`;

/** Words to swap before a prompt reaches an engine; the replacement keeps the sentence readable. */
const SWAPS: [RegExp, string][] = [
  [
    /\b(sexy|seductive|seductively|sultry|alluring|provocative|erotic|sensual|sensually)\b/gi,
    "elegant",
  ],
  [/\b(lustful|flirty|flirtatious|teasing)\b/gi, "playful"],
  [/\b(nude|naked|topless|undressed|unclothed)\b/gi, "dressed"],
  [/\b(bare|exposed) (skin|chest|back|legs|shoulders|midriff|stomach)\b/gi, "the $2"],
  [/\b(parted lips|lips parted|pouting|pout|biting (her|his) lip)\b/gi, "a calm expression"],
  [/\b(body-hugging|skin-tight|skintight|figure-hugging)\b/gi, "fitted"],
  [/\b(curvy|curvaceous|voluptuous|busty)\b/gi, "natural"],
  [/\bcurves\b/gi, "silhouette"],
  [/\b(see-through|sheer|transparent) (fabric|top|dress|blouse)\b/gi, "lightweight $2"],
  [/\b(wet look|wet hair and skin|dripping wet)\b/gi, "fresh look"],
  [/\b(intimate|intimately)\b/gi, "quiet"],
];

export function sanitizePrompt(text: string): string {
  // The rule itself names the words it forbids; it passes through untouched.
  const at = text.indexOf(SAFE_WORDING_RULE);
  if (at >= 0)
    return (
      sanitizePrompt(text.slice(0, at)) + SAFE_WORDING_RULE + sanitizePrompt(text.slice(at + SAFE_WORDING_RULE.length))
    );
  let out = text;
  for (const [re, rep] of SWAPS) out = out.replace(re, rep);
  return out;
}

/** True when the brief's subject line (or the skill) says the model is a child. */
export function isChildSubject(subject: string, skill?: string): boolean {
  if (skill === "kids") return true;
  return /\b(child|children|kid|kids|boy|girl|toddler|baby|infant|teen|teenager|years? old|aged? \d)\b/i.test(
    subject,
  );
}

/**
 * Child prompts: partner content checkers refuse descriptions of a child's skin, body or physique,
 * however innocent. Sentences carrying such words are dropped; the clothes, pose, scene and light
 * remain. "upper-body" / "full-body" style crop words are kept.
 */
const CHILD_BODY_WORDS =
  /\b(skin|complexion|muscle|muscles|muscular|physique|torso|chest|thighs?|belly|tummy|limbs?|bare|flesh|cheeks?|neck|collarbones?|shoulders?|hips?|waistline|curves?|figure|anatomy|anatomical|proportions?)\b|(?<![-\w])body\b/i;

export function sanitizeChildPrompt(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .filter((sentence) => !CHILD_BODY_WORDS.test(sentence))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The content checker's refusal, as fal.ai and Higgsfield phrase it. */
export function isContentPolicyError(message: string): boolean {
  return /content[_ ]policy|content checker|partner_validation|flagged|moderation/i.test(message);
}
