/**
 * A brand ambassador's look as the writers and the image engine read it: the gender and the dress
 * come from fields, so they are never lost in a free-text description.
 */
export type Gender = "man" | "woman" | "";

export interface CastProfile {
  description: string;
  gender?: Gender | string;
  modest?: boolean;
  hijab?: boolean;
}

/**
 * A child in the designer's words wins over the adult gender field: "6 years old little girl" on a
 * row saved as a man is a girl, and the man's dress rules do not apply to her.
 */
export function childOf(description: string): "girl" | "boy" | "child" | "" {
  const d = description.toLowerCase();
  const young = /\b(child|kid|toddler|baby|little|young)\b|\b\d{1,2}\s*(years?|yrs?|y\/?o)\b|\b(years?|yrs?)[- ]old\b/.test(d);
  if (/\b(girl|daughter)\b/.test(d)) return "girl";
  if (/\b(boy|son)\b/.test(d)) return "boy";
  return young ? "child" : "";
}

export const MODEST_DRESS =
  "modest clothing: shoulders, upper arms, chest and knees covered (long or elbow sleeves, a loose fit, long trousers or a long skirt); never bare shoulders, a low neckline, a short skirt or tight clothes";

/** The full look: gender first, the designer's words, then the dress rules. */
export function castLook(a: CastProfile): string {
  const parts: string[] = [];
  const child = childOf(a.description);
  if (child === "girl") parts.push("a little girl (child model)");
  else if (child === "boy") parts.push("a little boy (child model)");
  else if (child === "child") parts.push("a child (child model)");
  else if (a.gender === "man") parts.push("a man");
  else if (a.gender === "woman") parts.push("a woman");
  if (a.description.trim()) parts.push(a.description.trim().replace(/[.\s]+$/, ""));
  if (child === "boy" || (!child && a.gender === "man")) parts.push("never wears a headscarf, a hijab, a veil, a dress or a skirt");
  if (child === "girl" || (!child && a.gender === "woman")) parts.push(a.hijab ? "always wears a hijab covering her hair" : child ? "no hijab" : "her hair uncovered (no hijab)");
  if (child) parts.push("natural child proportions, happy and natural, no makeup, no adult poses");
  if (a.modest) parts.push(MODEST_DRESS);
  return parts.join("; ");
}
