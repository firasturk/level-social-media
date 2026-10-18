/**
 * Real people, not AI renders: the rules every picture with a person follows, the portrait's own
 * rules, and what the review checks. Photographers' habits that keep a model looking photographed:
 * light from a real source, real skin, a candid moment, a real lens.
 */

/** In every post that shows a person. */
export const REAL_PEOPLE_RULE = [
  "REAL PEOPLE: every person looks photographed, never generated. Real skin with visible pores, fine lines, tiny marks and natural unevenness of tone; no airbrushed, waxy, glossy or plastic skin, no beauty filter. Real hair with stray strands and natural volume. A natural, slightly asymmetric face; eyes that look at something in the scene, not a fixed stare. A candid moment: caught mid-gesture, mid-laugh or mid-conversation, weight on one leg, never a stiff pose or a frozen catalogue smile.",
  "Hands are anatomically right, relaxed, holding the product with real weight and contact (fingers wrapping it, a slight press into the box or plate). Clothes with real fabric weave, creases and folds where the body bends.",
  "LIGHT ON PEOPLE: motivated by a real source in the scene (a window, daylight through a door, the shop's lamps), soft falloff across the face, true shadows under the chin, nose and where hands meet the product, a natural catch-light in the eyes; the person sits in the same light as the set, never lit separately like a cut-out.",
  "CAMERA: a professional photographer's photo on a full-frame camera, 50mm or 85mm lens around f/2.8, focus on the eyes, natural depth of field, subtle film grain, true colours. No HDR glow, no over-sharpening, no perfect symmetry, no smooth CGI look.",
].join(" ");

/** The ambassador's portrait: the face every post copies, so it must look like a real photo. */
export const REAL_PORTRAIT_RULE =
  "It must look like a real casting photo taken by a professional photographer, not an AI image: soft window light from one side with a gentle falloff, real skin with pores, fine lines and natural unevenness (no retouching, no airbrushing, no glow), a slightly asymmetric natural face, real hair with stray strands, a relaxed real expression, an 85mm lens at f/2.8 with focus on the eyes, subtle film grain, true colours.";

/** The reference photo of real people attached for realism only. */
export function realRefLine(n: number): string {
  return `Image ${n} is a real photograph of a real person, attached ONLY to show what a real photo of a person looks like: copy its realism (skin texture, hair, how light falls on the face and body, lens and grain), never its person, face, clothes, pose, place or colours.`;
}

/** What the review checks in a picture with people. */
export const AI_LOOK_CHECK =
  'aiLook: when the picture shows a person, describe in one short sentence what makes them look AI-generated rather than photographed (waxy or plastic skin, airbrushed face, glowing skin, doll eyes, a stiff pose or frozen smile, a person lit separately from the set, CGI smoothness, malformed hands), else "".';

/** The revision that makes the people look photographed. */
export const AI_LOOK_FIX =
  "Make the people look photographed, not generated: real skin with pores and natural unevenness, no airbrushing or glow, natural asymmetric face and a candid expression, hands holding the product with real contact, the person lit by the same real light as the set, a real lens with subtle grain";
