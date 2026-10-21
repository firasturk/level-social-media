/**
 * The writing assistant of the Text studio: rewrites, shortens, translates or judges the words on
 * a post. It only ever suggests; the designer applies a suggestion by hand, nothing is replaced on
 * its own.
 */
export const ASSIST_ACTIONS = ["rewrite", "shorten", "expand", "headlines", "cta", "spelling", "translate", "tone", "layout"] as const;
export type AssistAction = (typeof ASSIST_ACTIONS)[number];

export const ASSIST_LABELS: Record<AssistAction, string> = {
  rewrite: "Rewrite",
  shorten: "Shorten",
  expand: "Expand",
  headlines: "Headline ideas",
  cta: "Call-to-action ideas",
  spelling: "Fix spelling",
  translate: "Translate",
  tone: "Brand tone",
  layout: "Judge the layout",
};

export interface AssistRequest {
  action: AssistAction;
  /** The words of the selected layer (or every layer, one per line, for the layout check). */
  text: string;
  client: string;
  tone?: string;
  audience?: string;
  language?: "ar" | "en" | "both";
  /** The post's idea, so the words stay on subject. */
  brief?: string;
  /** The brand fonts and colours, for the layout judgement. */
  brand?: { fonts: string[]; colours: string[] };
}

export interface AssistSuggestion {
  text: string;
  /** Why, in a few words. */
  note: string;
}

export interface AssistAnswer {
  suggestions: AssistSuggestion[];
  /** The layout judgement (hierarchy, placement, contrast), when asked. */
  verdict?: string;
}

export const ASSIST_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, note: { type: "string" } },
        required: ["text", "note"],
      },
    },
    verdict: { type: "string" },
  },
  required: ["suggestions", "verdict"],
};

const TASKS: Record<AssistAction, string> = {
  rewrite: "Write 4 alternative versions of the text, same meaning and length, each with a different angle.",
  shorten: "Write 4 shorter versions: fewer words, the same promise, none over half the original length.",
  expand: "Write 3 longer versions that add one concrete detail each (an ingredient, a benefit, a time), none over twice the original length.",
  headlines: "Write 6 headline ideas for this post: 2 to 5 words each, a hook the reader stops on, no generic slogans.",
  cta: "Write 6 call-to-action lines for this post: 2 to 6 words each, one clear action (order, visit, book, try), no exclamation marks.",
  spelling: "Correct the spelling, hamza, ta marbuta, punctuation and spacing of the text without changing its words or meaning. Give the corrected text as the one suggestion; the note lists what changed, or says it was already correct.",
  translate: "Translate the text: Arabic into natural English, English into natural Arabic (Jordanian-friendly Modern Standard Arabic, no literal word order). Give 2 suggestions: one faithful, one freer that reads like it was written in that language.",
  tone: "Rewrite the text 3 ways in the client's brand tone described below, keeping the meaning. The note says which tone trait each version leans on.",
  layout: "Judge the words as laid out on the picture (every layer, one per line, as given): the hierarchy (one clear headline, the rest smaller), the placement (off the product and faces, inside the safe margins), the contrast (readable over what is behind them). Give the verdict in 2 or 3 sentences, and up to 3 suggestions, each a short instruction the designer can act on (e.g. 'Make the second line 60% of the headline'), with its reason in the note.",
};

export function assistInstruction(r: AssistRequest): string {
  const lang = r.language === "en" ? "English" : r.language === "both" ? "Arabic and English (the client posts in both)" : "Arabic";
  return [
    `You are the copywriter and typography director of ${r.client}, a brand posting on Instagram.`,
    `The client's language: ${lang}. Keep the language of the text unless the task is to translate.`,
    r.tone ? `Brand tone: ${r.tone.slice(0, 600)}` : "",
    r.audience ? `Audience: ${r.audience.slice(0, 300)}` : "",
    r.brief ? `The post's idea: ${r.brief.slice(0, 500)}` : "",
    r.brand?.fonts.length ? `Brand fonts: ${r.brand.fonts.join(", ")}.` : "",
    r.brand?.colours.length ? `Brand colours: ${r.brand.colours.join(", ")}.` : "",
    "",
    `TASK: ${TASKS[r.action]}`,
    "Rules: words for a picture, not a paragraph: short, concrete, no emojis, no hashtags, no quotes around the text. Never invent prices, dates or offers that are not in the text or the idea.",
    'Answer as JSON: {"suggestions":[{"text":"...","note":"..."}],"verdict":"..."}; verdict is "" unless the task asks for a judgement.',
    "",
    "THE TEXT:",
    r.text.slice(0, 1500),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function parseAssist(raw: unknown): AssistAnswer {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const suggestions: AssistSuggestion[] = [];
  for (const s of Array.isArray(d.suggestions) ? (d.suggestions as Record<string, unknown>[]) : []) {
    if (!s || typeof s !== "object") continue;
    const text = str(s.text).replace(/^["“”']+|["“”']+$/g, "").slice(0, 600);
    if (!text) continue;
    if (suggestions.some((x) => x.text === text)) continue;
    suggestions.push({ text, note: str(s.note).slice(0, 300) });
  }
  const verdict = str(d.verdict).slice(0, 1200);
  return { suggestions: suggestions.slice(0, 8), verdict: verdict || undefined };
}
