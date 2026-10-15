/** Client helpers shared by the server (slugs for export names) and the client (card badges). */

/** Lowercase a-z0-9 and dashes, accents stripped: "Abu Saleh" -> "abu-saleh". Non-Latin names fall back to "client". */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 40).replace(/-+$/, "") || "client";
}

/** First free slug: the base, then base-2, base-3 and so on. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`;
    if (!set.has(s)) return s;
  }
}

/** Up to two initials for a card without a logo: "United Insurance" -> "UI", "حبيبة" -> "ح". */
export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => Array.from(w)[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export const CLIENT_LANGUAGES = ["ar", "en", "both"] as const;
export type ClientLanguage = (typeof CLIENT_LANGUAGES)[number];
