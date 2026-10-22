/**
 * Content language: the brand kit sets a default (ar, en or both), a month and a post may each
 * override it, and the Text studio, the writers and the previews follow the resolved value. Also
 * the small script helpers the renderer and the layouts share: what script a text is in, which
 * way it reads, and a price formatted for the language with Intl (Latin digits, bidi-safe).
 */
import { CLIENT_LANGUAGES, type ClientLanguage } from "./clients";
import { ARABIC_RE, STRONG_LTR_RE, type Direction } from "./layers";

export type { ClientLanguage } from "./clients";

export const LANGUAGE_LABELS: Record<ClientLanguage, string> = { ar: "Arabic", en: "English", both: "Arabic and English" };

/** Where a resolved language came from, for the editor's "follows the brand kit" line. */
export type LanguageSource = "post" | "month" | "brand" | "default";

const valid = (v: unknown): v is ClientLanguage => typeof v === "string" && (CLIENT_LANGUAGES as readonly string[]).includes(v);

/**
 * The language in force: the post's own, else the month's, else the brand kit's, else Arabic
 * (the studio's clients write Arabic first). Unknown or empty values are skipped, never guessed.
 */
export function resolveLanguage(brand: unknown, month?: unknown, post?: unknown): ClientLanguage {
  return languageWithSource(brand, month, post).language;
}

export function languageWithSource(brand: unknown, month?: unknown, post?: unknown): { language: ClientLanguage; source: LanguageSource } {
  if (valid(post)) return { language: post, source: "post" };
  if (valid(month)) return { language: month, source: "month" };
  if (valid(brand)) return { language: brand, source: "brand" };
  return { language: "ar", source: "default" };
}

/** The script a text is written in: Arabic, Latin, both, or neither (numbers and marks only). */
export type Script = "ar" | "en" | "mixed" | "none";

export function scriptOf(text: string): Script {
  const ar = ARABIC_RE.test(text);
  const en = STRONG_LTR_RE.test(text);
  return ar && en ? "mixed" : ar ? "ar" : en ? "en" : "none";
}

/** The reading direction a layer made for this language starts with (auto lets mixed copy decide). */
export function directionFor(language: ClientLanguage): Direction {
  return language === "ar" ? "rtl" : language === "en" ? "ltr" : "auto";
}

/** The side a left/right-aligned layout aligns to in this language. */
export function alignFor(language: ClientLanguage): "left" | "right" {
  return language === "en" ? "left" : "right";
}

/** The language a text reads as, for a bilingual pair: Arabic when it has Arabic, else English. */
export function languageOfText(text: string, fallback: ClientLanguage = "ar"): "ar" | "en" {
  const s = scriptOf(text);
  return s === "ar" || s === "mixed" ? "ar" : s === "en" ? "en" : fallback === "en" ? "en" : "ar";
}

/** Intl locales for the two languages (Jordan). Latin digits unless Arabic-Indic ones are asked for. */
export function localeFor(language: "ar" | "en", digits: "latn" | "arab" = "latn"): string {
  return language === "ar" ? `ar-JO-u-nu-${digits}` : "en-JO";
}

/**
 * A price for the language: Intl writes the currency where the locale puts it ("19.99 د.أ." in
 * Arabic, "JOD 19.99" in English), with Latin digits by default (the digits most Jordanian social
 * posts use). The canvas renderer orders mixed runs itself, so the plain string is the default;
 * `isolate` wraps it in a bidi isolate (FSI…PDI) for DOM text, where it then keeps its order
 * inside copy of the other language.
 */
export function formatPrice(amount: number, currency: string, language: ClientLanguage, opts: { digits?: "latn" | "arab"; isolate?: boolean } = {}): string {
  const lang = language === "en" ? "en" : "ar";
  let out: string;
  try {
    out = new Intl.NumberFormat(localeFor(lang, opts.digits), { style: "currency", currency, currencyDisplay: lang === "ar" ? "symbol" : "code", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    out = `${amount.toFixed(2)} ${currency}`;
  }
  // Intl adds its own marks (RLM, NBSP) that a canvas measures as width: keep the text plain.
  out = out.replace(/[\u200e\u200f\u061c]/g, "").replace(/\u00a0/g, " ").trim();
  return opts.isolate ? `\u2068${out}\u2069` : out;
}

/** Takes the bidi isolate marks off a string (for file names, prompts and measurement). */
export function plainText(text: string): string {
  return text.replace(/[\u2066-\u2069\u200e\u200f\u061c]/g, "");
}

/** A number in the language's digits (Latin by default), for a date or a count on a design. */
export function formatNumber(n: number, language: ClientLanguage, digits: "latn" | "arab" = "latn"): string {
  const lang = language === "en" ? "en" : "ar";
  try {
    return new Intl.NumberFormat(localeFor(lang, digits)).format(n);
  } catch {
    return String(n);
  }
}

/** Sample words for a layout preview when the post has none yet, in the language asked for. */
export interface SampleContent {
  headline: string;
  subline: string;
  /** A formatted price with its currency, ready to draw. */
  price: string;
  /** A short call to action. */
  cta: string;
  /** A second headline in the other language, for a bilingual layout (never a translation). */
  headlineAlt?: string;
}

const SAMPLES: Record<"ar" | "en", Omit<SampleContent, "price">> = {
  ar: { headline: "عرض نهاية الأسبوع", subline: "على كل القائمة حتى الأحد", cta: "اطلب الآن" },
  en: { headline: "Weekend offer", subline: "On the whole menu until Sunday", cta: "Order now" },
};

/**
 * The words a layout preview draws: the post's own headline and second line where they exist,
 * sample copy in the language where they do not. Nothing is translated: a bilingual layout's
 * second headline is the post's line in the other script when it has one, else sample copy
 * marked as a placeholder for the designer to write over.
 */
export function sampleContent(language: ClientLanguage, post: { headline?: string; subline?: string; price?: string } = {}): SampleContent {
  const head = post.headline?.trim() ?? "";
  const sub = post.subline?.trim() ?? "";
  const primary: "ar" | "en" = language === "en" ? "en" : language === "ar" ? "ar" : head ? languageOfText(head) : "ar";
  const other: "ar" | "en" = primary === "ar" ? "en" : "ar";
  const base = SAMPLES[primary];
  const out: SampleContent = {
    headline: head || base.headline,
    subline: sub || base.subline,
    price: post.price?.trim() || formatPrice(19.99, "JOD", primary),
    cta: base.cta,
  };
  if (language === "both") {
    // The second line is the other language's headline when it reads in that script.
    if (sub && languageOfText(sub, other) === other && languageOfText(head || base.headline) !== other) {
      out.headlineAlt = sub;
      out.subline = "";
    } else out.headlineAlt = SAMPLES[other].headline;
  }
  return out;
}
