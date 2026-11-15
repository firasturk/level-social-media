/**
 * Brand memory: what the studio remembers about a client and carries into its prompts. Four kinds of
 * item share one table (lessons): a brand rule (approved, brand-wide), a campaign instruction (one
 * month), a post instruction (one post of one month) and a lesson (proposed by the review, the
 * client or a retry; waits for the admin). Only approved, active items reach a prompt.
 */
import { lessonLine, type FlagKind } from "./qa";
import { colourLabel, photoRules } from "./posts";

export type MemoryCategory = "brand_rule" | "campaign_instruction" | "post_instruction" | "lesson";
export type MemoryStatus = "pending" | "approved" | "rejected";
export type MemorySource = "review" | "client" | "retry" | "team";

export const MEMORY_CATEGORIES: MemoryCategory[] = ["brand_rule", "campaign_instruction", "post_instruction", "lesson"];

export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  brand_rule: "Brand rules",
  campaign_instruction: "Campaign instructions",
  post_instruction: "Post instructions",
  lesson: "Proposed lessons",
};

export const SOURCE_LABEL: Record<string, string> = {
  review: "the review found it",
  client: "the client asked",
  retry: "fixed by itself",
  team: "the team wrote it",
};

/** Where an item applies: nothing for the whole brand, a batch for one month, a batch and a post for one post. */
export interface MemoryScope {
  batch?: string;
  post?: number;
}

/** One item as the routes return it. */
export interface MemoryItem {
  id: string;
  client: string;
  clientName?: string;
  category: MemoryCategory;
  kind: string;
  text: string;
  scope: MemoryScope;
  status: MemoryStatus;
  source: string;
  seen: number;
  /** When it was first written (the creation date). */
  first: number;
  last: number;
  batch: string | null;
  approver: string | null;
  approved_at: number | null;
  revision: number;
  replaces: string | null;
  deactivated: number | null;
  /** The line a prompt carries for it. */
  rule: string;
}

export function parseScope(raw: string | null | undefined): MemoryScope {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as { batch?: unknown; post?: unknown };
    const out: MemoryScope = {};
    if (typeof o.batch === "string" && o.batch) out.batch = o.batch;
    if (typeof o.post === "number" && Number.isInteger(o.post) && o.post > 0) out.post = o.post;
    return out;
  } catch {
    return {};
  }
}

export function scopeString(scope: MemoryScope | undefined): string {
  if (!scope?.batch) return "";
  return JSON.stringify(scope.post ? { batch: scope.batch, post: scope.post } : { batch: scope.batch });
}

/** Does an item with this scope apply to the given batch and post? Brand-wide always; a month's to that month; a post's to that post only. */
export function scopeMatches(item: MemoryScope, want: MemoryScope | undefined): boolean {
  if (!item.batch) return true;
  if (!want?.batch || want.batch !== item.batch) return false;
  if (item.post === undefined) return true;
  return want.post !== undefined && want.post === item.post;
}

/** The line a prompt carries for one item. A lesson keeps the review's wording of the rule; the team's items say where they apply. */
export function memoryLine(category: MemoryCategory, kind: string, text: string): string {
  const t = text.trim();
  switch (category) {
    case "brand_rule":
      return `Brand rule: ${t}`;
    case "campaign_instruction":
      return `This month: ${t}`;
    case "post_instruction":
      return `This post: ${t}`;
    default:
      return kind === "rule" ? `The team's rule: ${t}` : lessonLine(kind as FlagKind, t);
  }
}

/** Items in prompt order: the brand's rules first, then the month's, then the post's, then the lessons. */
export const CATEGORY_ORDER: Record<MemoryCategory, number> = { brand_rule: 0, campaign_instruction: 1, post_instruction: 2, lesson: 3 };

/* ───────────── Conflicts ───────────── */

/**
 * Simple keyword pairs: an item that forbids something ("no people") and another that asks for it
 * ("a person holds the cup") contradict each other. Only the obvious pairs are read.
 */
const SUBJECTS: { name: string; words: RegExp }[] = [
  { name: "people", words: /\b(people|person|persons|man|woman|men|women|model|models|ambassador|ambassadors|faces?|humans?)\b/i },
  { name: "text", words: /\b(text|writing|words?|letters?|lettering|headline|typography|captions?|slogan)\b/i },
  { name: "hands", words: /\bhands?\b/i },
  { name: "bags", words: /\bbags?\b/i },
  { name: "logo", words: /\blogos?\b/i },
  { name: "animals", words: /\b(animals?|dogs?|cats?|pets?)\b/i },
  { name: "food", words: /\b(food|dish|dishes|meal|meals)\b/i },
];

/** "no people", "never show hands", "without text", "avoid bags", "people-free", "no hands in the frame". */
function forbids(text: string, words: RegExp): boolean {
  const t = text.toLowerCase();
  const w = words.source.replace(/^\\b|\\b$/g, "");
  const neg = new RegExp(`\\b(no|never|without|avoid|not|don't|do not|zero)\\b[^.;,]{0,40}?${w}`, "i");
  const suffix = new RegExp(`${w}[- ]free\\b`, "i");
  return neg.test(t) || suffix.test(t);
}

/** Mentions the subject without forbidding it. */
function asks(text: string, words: RegExp): boolean {
  return words.test(text) && !forbids(text, words);
}

export interface MemoryConflict {
  /** What the two items disagree about. */
  about: string;
  /** The item that forbids it. */
  forbids: MemoryItem;
  /** The item that asks for it. */
  asks: MemoryItem;
}

/** Pairs of items where one forbids a subject and another asks for it. The more specific item (post, month) is the one listed as asking or forbidding as written. */
export function conflictsBetween(items: MemoryItem[]): MemoryConflict[] {
  const out: MemoryConflict[] = [];
  for (const s of SUBJECTS) {
    const no = items.filter((i) => forbids(i.text, s.words));
    const yes = items.filter((i) => asks(i.text, s.words));
    for (const f of no) for (const a of yes) if (f.id !== a.id) out.push({ about: s.name, forbids: f, asks: a });
  }
  return out;
}

/** A short label for where an item applies. */
export function scopeLabel(scope: MemoryScope, monthName?: string): string {
  if (!scope.batch) return "whole brand";
  const m = monthName ?? "this month";
  return scope.post ? `${m} · post ${scope.post}` : m;
}

/* ───────────── The brand block: the client's identity on an AI edit and on a video ───────────── */

/**
 * A month's pictures are generated from a prompt that carries the client's kit and memory
 * (buildPostPrompt). An AI edit of a picture and a video used to send the typed words alone, with
 * nothing about the client. `brandBlock` writes the short text those requests now carry after the
 * typed words: one header line, then one rule per line, so a block that must be shortened loses
 * whole rules from the end and never half a sentence.
 *
 * An edit gets limits only (what never appears, the client's own picture rules, the colours of what
 * is added): the client's ALWAYS scenes, style, tone and audience describe whole pictures and would
 * pull an edit away from the picture it is asked to keep. One-off lessons and one post's
 * instructions stay out of both: they were written for another picture.
 */
export type BrandUse = "edit" | "video";

/** The part of a `clients` row the block reads (the stored columns; `colors` as stored JSON or already parsed). */
export interface BrandKit {
  colors?: string | { name?: string; hex?: string }[] | null;
  dos?: string | null;
  donts?: string | null;
  image_rules?: string | null;
  photography?: string | null;
  language?: string | null;
}

export interface BrandBlockOptions {
  /** The longest block (characters); the use's own cap when left out or larger. */
  max?: number;
  /** Edit: false for a tool that makes a new picture from this one (a style, a preset), where "keep everything else" does not hold. */
  keepRest?: boolean;
  /** False for a relight: its words describe light, and a list of brand colours would tint it. */
  colours?: boolean;
  /** Video: the typed words ask for on-screen or spoken words, so the client's language is named. */
  words?: boolean;
}

/** The first words of the block's header line: how an earlier block is recognised and taken off. */
export const BRAND_BLOCK_LABEL: Record<BrandUse, string> = { edit: "CLIENT BRAND LIMITS", video: "CLIENT BRAND RULES" };
/** Providers read a limited prompt and weigh its first words most: the block stays short. */
export const BRAND_BLOCK_MAX: Record<BrandUse, number> = { edit: 600, video: 900 };

const HEADERS = {
  edit: `${BRAND_BLOCK_LABEL.edit} (keep everything not named above exactly as it is; these apply only to what is added or changed):`,
  remake: `${BRAND_BLOCK_LABEL.edit} (they apply to everything this picture adds or changes):`,
  video: `${BRAND_BLOCK_LABEL.video} (for everything that moves, enters or changes in the clip; none of this is shown as words):`,
} as const;

/** One rule on one line; a rule longer than this is taken by its sentences, or left out. */
const RULE_MAX = 240;
const BLOCK_COLOURS = 6;

/** ALWAYS lines that say how people look and dress: the only part of the ALWAYS list an added person or a clip must follow. */
const DRESS_RULE = /\b(modest\w*|hijabs?|abayas?|headscar(?:f|ves)|veils?|niqabs?|covered|sleeves?|cloth(?:es|ing)|dress(?:ed|es)?|wears?|wearing|outfits?|swimwear|skin)\b/i;
const PEOPLE_RULE = /\b(people|persons?|m[ae]n|wom[ae]n|girls?|boys?|child(?:ren)?|kids?|famil(?:y|ies)|models?|ambassadors?|faces?|hands?)\b/i;

const LANGUAGE_NAMES: Record<string, string> = { ar: "Arabic", en: "English", both: "Arabic and English" };

function oneLine(text: string): string {
  return text.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
}

/** A text as separate rules: its lines, and the sentences of a line too long to be one rule. */
function rulesOf(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (text ?? "").split("\n")) {
    const line = oneLine(raw);
    if (!line) continue;
    if (line.length <= RULE_MAX) out.push(line);
    else for (const sentence of line.split(/(?<=[.!?؟])\s+/)) if (sentence.trim() && sentence.trim().length <= RULE_MAX) out.push(sentence.trim());
  }
  return out;
}

function kitColours(colors: BrandKit["colors"]): string[] {
  let list: unknown = colors;
  if (typeof colors === "string") {
    try {
      list = JSON.parse(colors);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const c of list as { hex?: unknown }[]) {
    const hex = typeof c?.hex === "string" ? c.hex.trim() : "";
    // The colour word comes from the hex itself, as in the generated posts: a stale kit name never contradicts it.
    if (/^#?[0-9a-f]{6}$/i.test(hex)) out.push(colourLabel(hex.startsWith("#") ? hex : `#${hex}`));
  }
  return [...new Set(out)].slice(0, BLOCK_COLOURS);
}

/** Does a video idea ask for words on screen or a voice? ("No text appears" does not.) */
export function asksForWords(instruction: string): boolean {
  const said = instruction.replace(/\b(?:no|without|never|not any|nor)\s+(?:new\s+|on-?screen\s+)?(?:text|words?|captions?|subtitles?|lettering|writing|titles?|logos?|voice-?overs?|dialogue|speech)\b[^.;\n]*/gi, " ");
  return /\b(says?|saying|speaks?|speaking|spoken|talks?|talking|voice-?over|voiceover|narrat\w*|dialogue|subtitles?|captions?|on-?screen (?:text|words?|title)|(?:text|words?|title) on[- ]screen|text (?:appears|reads|says|on screen)|title card|lettering)\b/i.test(said);
}

/**
 * The client's brand block for an edit or a video, or "" when the kit and the memory have nothing
 * for it (nothing is ever invented). `memoryLines` are the lines `lessonsFor` returns: only the
 * approved brand rules and the month's instructions are read from them.
 */
export function brandBlock(kit: BrandKit | null | undefined, memoryLines: string[], use: BrandUse, opts: BrandBlockOptions = {}): string {
  const k = kit ?? {};
  const never = rulesOf(photoRules(k.donts ?? "")).map((r) => `NEVER: ${r.replace(/^never[:,]?\s+/i, "")}`);
  const colours = opts.colours === false ? [] : kitColours(k.colors);
  const colourLine = colours.length ? [`${use === "video" ? "Colours of anything that enters or changes stay within" : "Colours of anything added stay within"}: ${colours.join(", ")}`] : [];
  // Layout rules (logo, type, language) are the designer's, as in the generated posts: only what a picture can show is kept.
  const remembered = (prefix: string) => memoryLines.filter((l) => l.startsWith(prefix)).flatMap((l) => rulesOf(photoRules(l.slice(prefix.length))).map((r) => `${prefix}${r}`));
  const own = rulesOf(k.image_rules);
  const always = rulesOf(photoRules(k.dos ?? ""));
  const language = LANGUAGE_NAMES[k.language ?? ""];
  const rules =
    use === "edit"
      ? [...colourLine, ...never, ...remembered("Brand rule: "), ...remembered("This month: "), ...own, ...always.filter((r) => DRESS_RULE.test(r)).map((r) => `If a person is added or changed: ${r}`)]
      : [
          ...colourLine,
          ...never,
          ...always.filter((r) => DRESS_RULE.test(r) || PEOPLE_RULE.test(r)).map((r) => `People: ${r}`),
          ...remembered("Brand rule: "),
          ...remembered("This month: "),
          ...own,
          ...rulesOf(k.photography).map((r) => `Camera and light: ${r}`),
        ];
  // A kit with no rule and no colour adds nothing: the language alone is not a brand.
  if (!rules.length) return "";
  if (use === "video" && opts.words && language) rules.splice(colourLine.length, 0, `Any words on screen or spoken are in ${language}`);
  const header = use === "video" ? HEADERS.video : opts.keepRest === false ? HEADERS.remake : HEADERS.edit;
  const lines = [...new Set(rules)].map((r) => `- ${/[!?؟]$/.test(r) ? r : `${r.replace(/[.;,:]+$/, "")}.`}`);
  return fitBrandBlock([header, ...lines].join("\n"), Math.min(opts.max ?? BRAND_BLOCK_MAX[use], BRAND_BLOCK_MAX[use]));
}

/** A block cut to a length: whole rules leave from the end; a block with no rule left is no block. */
export function fitBrandBlock(block: string, max: number): string {
  const lines = block.split("\n");
  while (lines.length > 1 && lines.join("\n").length > max) lines.pop();
  return lines.length > 1 ? lines.join("\n") : "";
}

const BLOCK_RE = new RegExp(`\\s*(?:${BRAND_BLOCK_LABEL.edit}|${BRAND_BLOCK_LABEL.video})\\b[^\\n]*(?:\\n- [^\\n]*)*`, "g");

/** The words without any brand block they carry (a retry of stored text, a revise of a revise). */
export function stripBrandBlock(text: string): string {
  const out = text.replace(BLOCK_RE, "");
  return out === text ? text : out.trim();
}

/**
 * What a provider is sent: the typed words first and unchanged, then the block. A block already in
 * the words is replaced, never added twice. With a provider limit the typed words always stay
 * whole and the block gives way (fewer rules, or none).
 */
export function withBrandBlock(instruction: string, block: string, limit?: number | null): { text: string; block: string } {
  const typed = stripBrandBlock(instruction);
  if (!typed.trim() || !block) return { text: typed, block: "" };
  const fitted = limit ? fitBrandBlock(block, limit - typed.length - 2) : block;
  return fitted ? { text: `${typed}\n\n${fitted}`, block: fitted } : { text: typed, block: "" };
}
