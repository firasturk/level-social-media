/**
 * OCR checks: what an OCR provider read in a picture, compared with what the post should say.
 * Two checks share one normalisation of Arabic and numerals:
 *  - the raw picture (the engine's output, before the browser draws the words): any writing on it
 *    that is not the product's own packaging or the brand's name is unintended;
 *  - the final artwork (the picture with the headline, sub-line and price drawn by the browser):
 *    every approved word must be there, read as approved, and nothing else may be written.
 * Everything here is pure, so the server, the browser and the tests share it. A reading below the
 * confidence floor is never acted on by itself: it is handed to a person.
 */
import type { PostFlag } from "./qa";

/** One run of text the provider read, with its region as fractions of the picture (0..1). */
export interface OcrBlock {
  text: string;
  /** 0..1; the provider's own figure, or a default when it gives none. */
  confidence: number;
  /** [x0, y0, x1, y1] normalised 0..1, left-top to right-bottom. */
  box: [number, number, number, number];
}

export interface OcrResult {
  blocks: OcrBlock[];
  /** BCP-47 code of the main language read ("ar", "en"), when the provider says. */
  language?: string;
  /** "google-vision" or "demo". */
  provider: string;
}

/** What the artwork should carry: the approved words of the post. */
export interface ExpectedText {
  headline?: string;
  subline?: string;
  price?: string;
  /** Other numbers that must read exactly (a date, a phone number, an offer count). */
  numbers?: string[];
  /** Writing that may appear beyond the approved words: packaging print, the brand's name, a logo wordmark. */
  allowed?: string[];
}

export type FindingKind = "match" | "missing" | "mismatch" | "extra" | "low-confidence";
/** ok: nothing to do; review: a person must look (never acted on by itself); warn: a fault was read clearly. */
export type FindingSeverity = "ok" | "review" | "warn";
export type FindingField = "headline" | "subline" | "price" | "number" | "text";

export interface Finding {
  kind: FindingKind;
  /** Which approved word this is about; "text" for writing that was not expected. */
  field: FindingField;
  expected?: string;
  detected?: string;
  box?: [number, number, number, number];
  confidence: number;
  severity: FindingSeverity;
  /** One short sentence for the person reading the table. */
  note: string;
}

/** Below this the provider's reading is treated as uncertain: "needs a human look", never automatic. */
export const LOW_CONFIDENCE = 0.6;
/** Normalised Levenshtein ratio from which two strings count as the same words. */
export const MATCH_RATIO = 0.85;
/** From this ratio up (and below MATCH_RATIO) the words are there but read differently. */
const NEAR_RATIO = 0.5;

/* ───────────── Normalisation ───────────── */

const ARABIC_INDIC = /[\u0660-\u0669]/g;
const EASTERN_ARABIC = /[\u06F0-\u06F9]/g;
/** Tashkeel (fatha, damma, kasra, shadda, sukun and the tanween), the hamza marks and the superscript alef. */
const TASHKEEL = /[\u064B-\u0655\u0670]/g;
const TATWEEL = /\u0640/g;
const ALEF_VARIANTS = /[\u0623\u0625\u0622\u0671]/g;
const ALEF_MAQSURA = /\u0649/g;
const TA_MARBUTA = /\u0629/g;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g;
const ARABIC_LETTER = /[\u0600-\u06FF]/;
const LATIN_LETTER = /[A-Za-z]/;

export interface NormaliseOptions {
  /** Also write ta marbuta (ة) as ha (ه): "حلوة" and "حلوه" become the same word. */
  taMarbuta?: boolean;
}

/**
 * One spelling for the same words however they were written or read: ASCII digits for the
 * Arabic-Indic and Eastern numerals, no diacritics or tatweel, one alef, ya for alef maqsura, one
 * space between words, lower-case Latin.
 */
export function normaliseText(s: string, opts: NormaliseOptions = {}): string {
  let t = (s ?? "")
    .replace(ZERO_WIDTH, "")
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066A/g, "%")
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",")
    .replace(/\u060C/g, ",")
    .replace(TASHKEEL, "")
    .replace(TATWEEL, "")
    .replace(ALEF_VARIANTS, "\u0627")
    .replace(ALEF_MAQSURA, "\u064A");
  if (opts.taMarbuta) t = t.replace(TA_MARBUTA, "\u0647");
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The normalised text with its punctuation taken out: what the words are, not how they were set. */
export function comparable(s: string, opts: NormaliseOptions = {}): string {
  return normaliseText(s, opts)
    .replace(/[^\p{L}\p{N}%\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length];
}

/** 1 for the same string, 0 for nothing in common: 1 - distance / longer length. */
export function similarity(a: string, b: string): number {
  const longest = Math.max([...a].length, [...b].length);
  if (!longest) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/* ───────────── Matching helpers ───────────── */

const OPTS: NormaliseOptions = { taMarbuta: true };

/** Does the read text carry the expected words: the same (fuzzy), or the expected inside the read run. */
function ratioOf(expected: string, detected: string): number {
  const e = comparable(expected, OPTS);
  const d = comparable(detected, OPTS);
  if (!e || !d) return 0;
  if (e === d) return 1;
  if (d.includes(e) && e.length >= 2) return 1;
  // A run that wrapped across the expected words: every expected word found in order inside it.
  return similarity(e, d);
}

interface Candidate {
  text: string;
  blocks: number[];
  confidence: number;
  box: [number, number, number, number];
}

function unionBox(blocks: OcrBlock[]): [number, number, number, number] {
  return [
    Math.min(...blocks.map((b) => b.box[0])),
    Math.min(...blocks.map((b) => b.box[1])),
    Math.max(...blocks.map((b) => b.box[2])),
    Math.max(...blocks.map((b) => b.box[3])),
  ];
}

/** Each block alone, then runs of two and three consecutive blocks: a headline often wraps over two lines. */
function candidates(blocks: OcrBlock[]): Candidate[] {
  const out: Candidate[] = [];
  for (let size = 1; size <= 3; size++) {
    for (let i = 0; i + size <= blocks.length; i++) {
      const run = blocks.slice(i, i + size);
      out.push({
        text: run.map((b) => b.text).join(" "),
        blocks: run.map((_, k) => i + k),
        confidence: Math.min(...run.map((b) => b.confidence)),
        box: unionBox(run),
      });
    }
  }
  return out;
}

function hasLetters(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/** Writing the brand allows in the picture: matches a packaging word or the brand's name, or is made of such words. */
function isAllowed(text: string, allowed: string[]): boolean {
  const t = comparable(text, OPTS);
  if (!t) return true;
  const words = allowed.map((a) => comparable(a, OPTS)).filter(Boolean);
  if (!words.length) return false;
  for (const w of words) {
    if (w === t || (w.length >= 2 && (w.includes(t) || t.includes(w)))) return true;
    if (similarity(w, t) >= MATCH_RATIO) return true;
  }
  const allowedTokens = new Set(words.flatMap((w) => w.split(" ")));
  const tokens = t.split(" ");
  return tokens.every((tok) => allowedTokens.has(tok) || [...allowedTokens].some((a) => similarity(a, tok) >= MATCH_RATIO));
}

/**
 * Writing that is not words: the same glyph four or more times in a row, Arabic and Latin letters
 * inside one word, or a run that is mostly symbols. The image engines produce exactly this when
 * they try to write.
 */
export function looksGarbled(text: string): boolean {
  const t = normaliseText(text);
  if (!t) return false;
  if (/(\p{L})\1{3,}/u.test(t)) return true;
  for (const word of t.split(" ")) {
    if (ARABIC_LETTER.test(word) && LATIN_LETTER.test(word)) return true;
  }
  const letters = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const symbols = (t.match(/[^\p{L}\p{N}\s%.,:!?'"-]/gu) ?? []).length;
  return letters > 0 && symbols > letters;
}

/* ───────────── The two checks ───────────── */

/**
 * The final artwork against the approved words: each of headline, sub-line, price and numbers is
 * found (match), read differently (mismatch), absent (missing) or read too faintly to say
 * (low-confidence); every other run of text that is not allowed packaging or brand writing is extra.
 */
export function compareArtwork(expected: ExpectedText, detected: OcrResult): Finding[] {
  const blocks = detected.blocks.filter((b) => hasLetters(comparable(b.text, OPTS)));
  const cands = candidates(blocks);
  const used = new Set<number>();
  const out: Finding[] = [];
  const wanted: { field: FindingField; value: string }[] = [];
  if (expected.headline?.trim()) wanted.push({ field: "headline", value: expected.headline.trim() });
  if (expected.subline?.trim()) wanted.push({ field: "subline", value: expected.subline.trim() });
  if (expected.price?.trim()) wanted.push({ field: "price", value: expected.price.trim() });
  for (const n of expected.numbers ?? []) if (n?.trim()) wanted.push({ field: "number", value: n.trim() });

  for (const w of wanted) {
    let best: { c: Candidate; ratio: number } | null = null;
    for (const c of cands) {
      if (c.blocks.some((i) => used.has(i))) continue;
      const ratio = ratioOf(w.value, c.text);
      // Prefer the tightest run that reads the words: a single block over a run that happens to contain it.
      if (!best || ratio > best.ratio + 1e-9 || (Math.abs(ratio - best.ratio) < 1e-9 && c.blocks.length < best.c.blocks.length)) best = { c, ratio };
    }
    if (!best || best.ratio < NEAR_RATIO) {
      out.push({ kind: "missing", field: w.field, expected: w.value, confidence: 0, severity: "warn", note: `The ${w.field} was not read anywhere on the artwork.` });
      continue;
    }
    for (const i of best.c.blocks) used.add(i);
    const low = best.c.confidence < LOW_CONFIDENCE;
    if (best.ratio >= MATCH_RATIO) {
      out.push(
        low
          ? { kind: "low-confidence", field: w.field, expected: w.value, detected: best.c.text, box: best.c.box, confidence: best.c.confidence, severity: "review", note: `The ${w.field} seems to be there but was read faintly. Needs a human look.` }
          : { kind: "match", field: w.field, expected: w.value, detected: best.c.text, box: best.c.box, confidence: best.c.confidence, severity: "ok", note: `The ${w.field} reads as approved.` },
      );
      continue;
    }
    out.push(
      low
        ? { kind: "low-confidence", field: w.field, expected: w.value, detected: best.c.text, box: best.c.box, confidence: best.c.confidence, severity: "review", note: `The ${w.field} was read faintly and differently. Needs a human look.` }
        : { kind: "mismatch", field: w.field, expected: w.value, detected: best.c.text, box: best.c.box, confidence: best.c.confidence, severity: "warn", note: `The ${w.field} reads differently from the approved words.` },
    );
  }

  const allowed = expected.allowed ?? [];
  blocks.forEach((b, i) => {
    if (used.has(i) || isAllowed(b.text, allowed)) return;
    const low = b.confidence < LOW_CONFIDENCE;
    out.push(
      low
        ? { kind: "low-confidence", field: "text", detected: b.text, box: b.box, confidence: b.confidence, severity: "review", note: "Faint writing that is not among the approved words. Needs a human look." }
        : { kind: "extra", field: "text", detected: b.text, box: b.box, confidence: b.confidence, severity: "warn", note: looksGarbled(b.text) ? "Garbled writing that is not among the approved words." : "Writing that is not among the approved words." },
    );
  });
  return out;
}

/**
 * The raw picture: nothing may be written on it except the product's own packaging print and the
 * brand's name (the allowed words). Every other run is unintended writing; a garbled one (mixed
 * scripts, repeated glyphs) is named as such; a faint one is handed to a person.
 */
export function checkRawImage(detected: OcrResult, allowed: string[]): Finding[] {
  const out: Finding[] = [];
  for (const b of detected.blocks) {
    if (!hasLetters(comparable(b.text, OPTS))) continue;
    if (isAllowed(b.text, allowed)) continue;
    if (b.confidence < LOW_CONFIDENCE) {
      out.push({ kind: "low-confidence", field: "text", detected: b.text, box: b.box, confidence: b.confidence, severity: "review", note: "Faint writing was read here. Needs a human look." });
      continue;
    }
    out.push({
      kind: "extra",
      field: "text",
      detected: b.text,
      box: b.box,
      confidence: b.confidence,
      severity: "warn",
      note: looksGarbled(b.text) ? "Garbled writing: the engine tried to write and produced glyph salad." : "Writing that is not on the product's packaging.",
    });
  }
  return out;
}

/* ───────────── Review flags for the engine ───────────── */

/** The text of a flag the OCR raw check adds to a picture's review when it read writing clearly. */
export const OCR_FLAG_PREFIX = "Writing in the picture (OCR): ";
/** The text of a flag the OCR raw check adds when it read something too faintly to be sure. */
export const OCR_LOW_PREFIX = "Check the writing (low OCR confidence): ";

/** A flag the OCR check added, as opposed to one the vision review found: never a retake trigger. */
export function isOcrFlag(f: PostFlag): boolean {
  return f.kind === "text" && (f.text.startsWith(OCR_FLAG_PREFIX) || f.text.startsWith(OCR_LOW_PREFIX));
}

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim().slice(0, 60)}"`;

/**
 * The raw check's findings as review flags: one "text" flag for everything read clearly, one for
 * everything read faintly. Both are review notes for the team; neither makes the engine spend.
 */
export function ocrFlags(findings: Finding[]): PostFlag[] {
  const sure = findings.filter((f) => f.kind === "extra" && f.detected);
  const faint = findings.filter((f) => f.kind === "low-confidence" && f.detected);
  const out: PostFlag[] = [];
  if (sure.length) out.push({ kind: "text", text: `${OCR_FLAG_PREFIX}${sure.map((f) => quote(f.detected!)).join(", ")}.` });
  if (faint.length) out.push({ kind: "text", text: `${OCR_LOW_PREFIX}${faint.map((f) => quote(f.detected!)).join(", ")} may be writing; a human should look.` });
  return out;
}
