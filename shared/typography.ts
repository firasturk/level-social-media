/**
 * Typography: a post's words set as part of the picture, not only over it. A big word goes behind
 * the product (the product stands in front of its letters), crosses it, repeats down the post or
 * stands as an outline, in a second font picked for the post. The engine never draws words; the
 * browser does, with the product's outline read from the finished picture.
 */
import { HEADLINE_FONTS, LATIN_FONTS } from "./overlay";

export const TYPO_STYLES = ["behind", "overlap", "repeat", "outline"] as const;
export type TypoStyle = (typeof TYPO_STYLES)[number];

export const TYPO_LABELS: Record<TypoStyle, string> = {
  behind: "Behind the product",
  overlap: "Crossing the product",
  repeat: "Repeated",
  outline: "Big outline",
};

export interface PostTypography {
  style: TypoStyle;
  /** The word or two set big (from the headline, as written). */
  word: string;
  /** The second font, for the big word. */
  font: string;
  /** Its colour (#rrggbb); empty picks what reads on the picture. */
  color?: string;
  /** Where the outline of the product is served (studio or share link); none when it was not read. */
  subject?: string;
}

/** The fonts the typography may use for the big word. */
export const TYPO_FONTS = [...HEADLINE_FONTS, ...LATIN_FONTS].map((f) => f.family);

/** The outline of the picture's subject: a greyscale mask over a box of the picture. */
export interface SubjectMask {
  /** x, y, w, h as fractions of the picture's width and height (the whole picture for a matte). */
  box: [number, number, number, number];
  /** A greyscale image (data URL) the size of the box: white is the subject. */
  mask: string;
  label: string;
}

export const TYPO_SCHEMA = {
  type: "object",
  properties: {
    style: { type: "string", enum: ["none", ...TYPO_STYLES] },
    word: { type: "string" },
    font: { type: "string" },
    color: { type: "string" },
    reason: { type: "string" },
  },
  required: ["style", "word", "font", "color", "reason"],
};

export function typographyInstruction(r: {
  client: string;
  headline: string;
  subline?: string;
  kind: string;
  /** The month's headline font: the big word takes a second font that sits well with it. */
  headlineFont: string;
  palette: string[];
  /** Styles already given to the posts before it, for variety across the feed. */
  used: string[];
  /** The style the team chose for the month; the typographer only answers "none" when it cannot work here. */
  force?: TypoStyle;
  /** The grid tile's own lettering: where its words sit and how big. */
  tile?: { position?: string; size?: string };
}): string {
  return [
    `You are the typographer of the brand "${r.client}" on Instagram. The image is a finished post (${r.kind}) whose headline is "${r.headline}"${r.subline ? ` and second line "${r.subline}"` : ""}. Decide how its words are set as typography that is part of the design, the way top food and fashion brands do it.`,
    [
      "The styles:",
      "- behind: one big word set huge across the post, BEHIND the product: the product stands in front of the letters and hides part of them. Only when the product is one clear subject with calm space around its upper part, and the letters stay readable with part of them hidden.",
      "- overlap: one big word crossing the product's lower part, the product's top standing over the letters. For a tall product (a cup, a bottle, a person holding the product) with calm space beside it.",
      "- repeat: the word repeated three or four times down the post, outlined with one filled row. For a plain or softly textured background with the product small or low in the frame, or a typographic post.",
      "- outline: one big outlined word in a calm, even area (a plain wall, sky, cloth or empty surface) away from the product.",
      "- none: the plain headline is best: a face would be covered, the picture is busy (many pieces, patterns, strong texture), or there is no calm space. Letters over a busy picture never read.",
    ].join("\n"),
    "THE WORDS NEVER COVER the product, the food, a face or the logo, and never sit under the logo at the top: the big word goes where the picture is calm (sky, wall, cloth, empty surface) or deliberately behind the product. When no such place exists, answer none.",
    r.tile ? `THE GRID TILE this post follows sets its words ${r.tile.size ? `${r.tile.size} ` : ""}${r.tile.position ? `at the ${r.tile.position}` : ""}: match that scale and place (small or medium tile words mean none; huge tile words mean behind, outline or repeat at that place).` : "",
    `word: the strongest one or two words of the headline, copied EXACTLY as written there (same language, same letters); never a new word.`,
    `font: one of ${TYPO_FONTS.join(", ")}. A second font that suits this post and sits well with the headline font ${r.headlineFont}: a contrast (a calligraphic or display face against a clean one), and it must write the word's script (an Arabic word takes an Arabic font; Montserrat and Inter are Latin only).`,
    `color: one #rrggbb that reads on the picture where the word sits, from the month's colours when one fits: ${r.palette.join(", ") || "white #ffffff, black #111111"}.`,
    r.force
      ? `THE TEAM CHOSE THE STYLE "${r.force}" for the month: use it, and answer "none" only when it cannot work on this picture (it would cover a face, or the picture is too busy for letters to read).`
      : r.used.length
        ? `The posts before it use: ${r.used.join(", ")}. Vary across the feed; the same style twice in a row only when it is clearly best.`
        : "",
    "Return the JSON with a short reason.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The typographer's answer, kept only when its word comes from the headline and its font is known. */
export function parseTypography(raw: unknown, headline: string, fallbackFont: string, force?: TypoStyle): PostTypography | null {
  const x = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const said = String(x.style ?? "");
  const style = force && said !== "none" ? force : said;
  if (!(TYPO_STYLES as readonly string[]).includes(style)) return null;
  const asked = String(x.word ?? "").replace(/\s+/g, " ").trim();
  const word = asked && headline.includes(asked) ? asked : headline.split(/\s+/).slice(0, 2).join(" ");
  if (!word) return null;
  const arabic = /[؀-ۿ]/.test(word);
  const named = TYPO_FONTS.find((f) => f.toLowerCase() === String(x.font ?? "").trim().toLowerCase());
  const latinOnly = (f: string) => LATIN_FONTS.some((l) => l.family === f);
  const font = named && !(arabic && latinOnly(named)) ? named : fallbackFont;
  const color = /^#[0-9a-f]{6}$/i.test(String(x.color ?? "").trim()) ? String(x.color).trim() : undefined;
  return { style: style as TypoStyle, word, font, ...(color ? { color } : {}) };
}
