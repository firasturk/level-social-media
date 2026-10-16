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

export const MODEST_DRESS =
  "modest clothing: shoulders, upper arms, chest and knees covered (long or elbow sleeves, a loose fit, long trousers or a long skirt); never bare shoulders, a low neckline, a short skirt or tight clothes";

/** The full look: gender first, the designer's words, then the dress rules. */
export function castLook(a: CastProfile): string {
  const parts: string[] = [];
  if (a.gender === "man") parts.push("a man");
  else if (a.gender === "woman") parts.push("a woman");
  if (a.description.trim()) parts.push(a.description.trim().replace(/[.\s]+$/, ""));
  if (a.gender === "man") parts.push("never wears a headscarf, a hijab, a veil, a dress or a skirt");
  if (a.gender === "woman") parts.push(a.hijab ? "always wears a hijab covering her hair" : "her hair uncovered (no hijab)");
  if (a.modest) parts.push(MODEST_DRESS);
  return parts.join("; ");
}
