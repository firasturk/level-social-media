/**
 * Brand memory: what the studio remembers about a client and carries into its prompts. Four kinds of
 * item share one table (lessons): a brand rule (approved, brand-wide), a campaign instruction (one
 * month), a post instruction (one post of one month) and a lesson (proposed by the review, the
 * client or a retry; waits for the admin). Only approved, active items reach a prompt.
 */
import { lessonLine, type FlagKind } from "./qa";

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
