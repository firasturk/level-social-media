/**
 * Client feedback, turned into reviewable changes: a pasted message, a typed note or a dictation
 * is split into items and each item is read as one change on one post (a layer edit, new words, a
 * picture edit, a new idea) or left unclear with a question. Nothing here applies anything: every
 * action waits for the designer's approval, one at a time. The rules are deterministic so the
 * preview and the tests answer the same way; a text model refines them when a key is connected.
 */
import type { PostOverlayPatch } from "./overlay";

export type FeedbackSource = "pasted" | "typed" | "voice" | "approval-page";

export interface FeedbackItem {
  id: string;
  batch: string;
  /** The post the feedback was given on (post level); absent for feedback on the whole month. */
  post?: number;
  text: string;
  source: FeedbackSource;
  created: number;
  /** Who entered it (the team member's name, or the approval page). */
  by: string;
}

export type FeedbackKind = "layer" | "image" | "words" | "idea" | "unclear";
export type FeedbackStatus = "proposed" | "approved" | "applied" | "rejected";

/** The words of a post the client may ask to change. */
export interface WordsPatch {
  headline?: string;
  subline?: string;
  caption?: string;
}

export interface FeedbackAction {
  id: string;
  feedback: string;
  post?: number;
  slide?: number;
  /** The picture the change is about (a task id or a take key), when the client named one. */
  version?: string;
  kind: FeedbackKind;
  /** The interpreted change, in plain words. */
  change: string;
  /** layer: a PostOverlayPatch; words: a WordsPatch. */
  patch?: PostOverlayPatch | WordsPatch;
  /** image: the edit instruction the engine gets. */
  instruction?: string;
  /** What is not clear ("Which post? …"); the designer fixes it before approving. */
  ambiguity?: string;
  /** Where the request runs against the brand or the campaign. */
  conflict?: string;
  status: FeedbackStatus;
  applied?: { at: number; result?: string };
}

/** What the rules know about one post of the month. */
export interface FeedbackPost {
  index: number;
  title: string;
  headline?: string;
  caption?: string;
  hasPicture: boolean;
  /** A carousel: how many slides it has. */
  slides?: number;
  /** The post's own overlay adjustments, so a "bigger" is relative to what is there. */
  ov?: PostOverlayPatch;
  /** The logo width the client's layout gives this post (a fraction of the width). */
  logoWidth?: number;
}

export interface FeedbackConstraints {
  /** The campaign shows no people (a hand at most). */
  noPeople?: boolean;
  /** The client's don'ts, one line. */
  donts?: string;
}

export interface FeedbackContext {
  posts: FeedbackPost[];
  /** The post the feedback was given on: items that name no post are about it. */
  post?: number;
  constraints?: FeedbackConstraints;
}

/** An action as the rules or the model propose it, before it is stored. */
export type ProposedAction = Omit<FeedbackAction, "id" | "feedback" | "status" | "applied">;

export const DEFAULT_LOGO_WIDTH = 0.16;
const BIGGER = 1.25;
const SMALLER = 0.8;
const STEP = 0.05;
const MAX_ITEMS = 24;

const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The feedback split into its items: lines, bullets, numbered points, then sentences. */
export function splitFeedback(text: string): string[] {
  const out: string[] = [];
  const lines = text
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d{1,2}[.)]|\(\d{1,2}\))\s+/, "").trim())
    .filter(Boolean);
  const LABEL = /^((?:post|slide)\s*#?\d{1,2}|#\d{1,2})\s*[:\-–—]\s*/i;
  for (const line of lines) {
    // A post label followed by a colon keeps the sentences after it together ("Post 2: bigger
    // headline. Remove the cup."), until another label or a sentence that points at a post itself.
    let prefix = "";
    for (const raw of line.split(/(?<=[.!?؟;])\s+|\s*;\s*/)) {
      const part = raw.trim();
      if (!part) continue;
      const label = LABEL.exec(part);
      if (label) {
        prefix = `${label[1]}: `;
        const rest = part.slice(label[0].length).trim();
        if (rest) out.push(prefix + rest);
        continue;
      }
      out.push(refersToPost(part) ? part : prefix + part);
    }
  }
  return out.slice(0, MAX_ITEMS);
}

/** True when a sentence names its own post ("post 3", "the second one", "the blue one"). */
function refersToPost(text: string): boolean {
  return /\b(?:post|picture|image|photo|slide)\s*#?\s*\d{1,2}\b/i.test(text) || ORDINALS.test(text) || VAGUE.test(text);
}

interface Target {
  post?: number;
  slide?: number;
  /** Every post of the month. */
  all?: boolean;
  ambiguity?: string;
  /** The item without its post label. */
  text: string;
}

const ORDINALS = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(one|post|picture|image|photo|slide)\b/i;
const VAGUE = /\b(the|that|this)\s+(blue|red|green|white|black|dark|light|bright|yellow|pink|orange|purple|grey|gray|brown|other|one with|first|second|third|next|previous)\b|\bthe (one|post|picture|image|photo) (with|where|that|of)\b|\bthat (one|post|picture|image|photo)\b/i;

/** Which post (and slide) an item speaks about; unclear when it points without a number. */
export function resolveTarget(item: string, ctx: FeedbackContext): Target {
  let text = item.trim();
  let post: number | undefined;
  let slide: number | undefined;
  const label = /^(?:post\s*#?(\d{1,2})|#(\d{1,2}))\s*[:\-–—]?\s*/i.exec(text);
  if (label) {
    post = Number(label[1] ?? label[2]);
    text = text.slice(label[0].length).trim();
  }
  const inline = /\b(?:post|picture|image|photo)\s*#?\s*(\d{1,2})\b/i.exec(text);
  if (!post && inline) post = Number(inline[1]);
  const slideRef = /\bslide\s*#?\s*(\d{1,2})\b/i.exec(text);
  if (slideRef) slide = Number(slideRef[1]);
  const all = /\b(all|every|each)\s+(of\s+)?(the\s+)?(posts?|pictures?|images?|photos?|of them|designs?)\b|\b(the whole|the entire|across the) (month|campaign|set)\b|\beverywhere\b/i.test(text);
  if (all) return { all: true, text };
  if (post !== undefined) {
    if (!ctx.posts.some((p) => p.index === post)) return { text, ambiguity: `Which post? Post ${post} is not in this month (${ctx.posts.map((p) => p.index).join(", ")}).` };
    return { post, slide, text };
  }
  if (slide && ctx.post === undefined) {
    const carousels = ctx.posts.filter((p) => (p.slides ?? 0) >= slide!);
    if (carousels.length === 1) return { post: carousels[0].index, slide, text };
    return { slide, text, ambiguity: carousels.length ? `Which post? Slide ${slide} exists on posts ${carousels.map((p) => p.index).join(", ")}.` : `Which post? No carousel here has a slide ${slide}.` };
  }
  if (ORDINALS.test(text) || VAGUE.test(text)) {
    const m = ORDINALS.exec(text) ?? VAGUE.exec(text);
    return { slide, text, ambiguity: `Which post? "${m![0]}" does not say which post is meant; pick it below.` };
  }
  if (ctx.post !== undefined && ctx.posts.some((p) => p.index === ctx.post)) return { post: ctx.post, slide, text };
  if (ctx.posts.length === 1) return { post: ctx.posts[0].index, slide, text };
  return { slide, text, ambiguity: "Which post? The feedback names no post; pick it below." };
}

const LOGO = /\blogo\b|\bbrand mark\b|\bmark\b/i;
const WORDS_LAYER = /\b(text|headline|title|words|font|lettering|typography|sub-?line|second line|copy)\b/i;
const BIGGER_RE = /\b(bigger|larger|big|huge|increase|enlarge|more visible|too small|stand out|prominent|boost)\b/i;
const SMALLER_RE = /\b(smaller|reduce|shrink|too big|too large|less visible|subtle|tone down|smaller)\b/i;
const MOVE_RE = /\b(move|shift|place|put|bring|lower|raise|higher|lower|center|centre|left|right|up|down|top|bottom)\b/i;
const COLOR_RE = /\b(white|black|red|blue|green|yellow|orange|pink|purple|gold|golden|grey|gray|brown|beige|navy|teal)\b|#[0-9a-f]{3,8}\b/i;
const IDEA_RE = /\b(different|another|new|fresh|other)\s+(idea|concept|direction|approach|angle|take on)\b|\bnot this (concept|idea|direction)\b|\brethink\b|\bstart (over|again)\b|\bscrap (this|it)\b|\bdoes ?n[o']t work as (a|an) (idea|concept)\b|\bchange the (whole )?(idea|concept)\b/i;
const IMAGE_OBJECT = /\b(remove|take out|take away|delete|get rid of|drop|hide|add|put|include|show|replace|swap|change|fix|more|less|fewer)\b/i;
const IMAGE_WORDS = /\b(light(ing)?|brighter|darker|dim|shadows?|background|backdrop|blur|blurry|sharper|sharp|warmer|cooler|contrast|saturat\w*|exposure|crop|zoom|angle|closer|further|farther|wider|tighter|composition|scene|picture|image|photo|render|product looks|cup|bottle|plate|table|hand|sky|wall|floor|props?|colou?r of the|too dark|too bright|realistic|ai look|plastic|fake)\b/i;
const PEOPLE_RE = /\b(people|person|persons|man|woman|men|women|girl|boy|kid|kids|child|children|family|model|models|someone|somebody|customer|customers|face|faces|couple|crowd|barista|waiter)\b/i;
const TEXT_IN_PICTURE = /\b(text|words?|letters?|writing|slogan|price|label|sign|caption)\b.{0,30}\b(in|on|inside|into|onto|within)\s+the\s+(picture|image|photo|cup|wall|sign|board|packaging|background|scene)\b|\b(write|print|engrave|paint)\b.{0,40}\b(on|onto|in|inside)\s+the\s+(picture|image|photo|cup|wall|sign|board|packaging|background|scene)\b/i;

/** The replacement the client gives: 'change the headline to "…"', 'headline: …', 'write … as the caption'. */
function quotedWords(text: string, field: RegExp): { field: keyof WordsPatch; value: string } | null {
  const m = field.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const key: keyof WordsPatch = /caption/.test(name) ? "caption" : /sub|second/.test(name) ? "subline" : "headline";
  const after = text.slice(m.index + m[0].length);
  const quoted = /["“«'‘]([^"”»'’]{1,200})["”»'’]/.exec(after) ?? /["“«'‘]([^"”»'’]{1,200})["”»'’]/.exec(text);
  if (quoted) return { field: key, value: quoted[1].trim() };
  const to = /^\s*(?:to|as|into|:|=|should (?:say|read|be)|says?|reads?)\s*(.+)$/i.exec(after);
  if (to) return { field: key, value: to[1].replace(/[.؟!]+$/, "").trim() };
  return null;
}

const WORDS_FIELD = /\b(headline|title|caption|sub-?line|second line|words|copy|text)\b/i;
const WORDS_VERB = /\b(change|rewrite|replace|make|set|use|write|put|say|should (?:say|read|be)|reads?|says?|update|edit|correct|fix|rename|call it)\b/i;

/** Which post a 'bigger' is measured from. */
function postOf(ctx: FeedbackContext, index: number | undefined): FeedbackPost | undefined {
  return index === undefined ? undefined : ctx.posts.find((p) => p.index === index);
}

function conflictOf(text: string, kind: FeedbackKind, post: FeedbackPost | undefined, ctx: FeedbackContext): string | undefined {
  const notes: string[] = [];
  if (kind === "image" || kind === "idea") {
    if (ctx.constraints?.noPeople && PEOPLE_RE.test(text) && !/\bno (people|person|one|faces?)\b|\bwithout (people|a person|anyone|faces?)\b|\bremove (the )?(people|person|man|woman|hand|face)/i.test(text)) notes.push("The campaign shows no people (a hand at most); this asks for people.");
    if (TEXT_IN_PICTURE.test(text)) notes.push("The engine never draws words, letters or signs in the picture: words go on the headline layer instead.");
    if (ctx.constraints?.donts?.trim()) {
      const donts = ctx.constraints.donts.split(/[,;\n]+/).map((d) => d.trim().toLowerCase()).filter((d) => d.length > 3);
      const hit = donts.find((d) => text.toLowerCase().includes(d.replace(/^no\s+/, "")));
      if (hit) notes.push(`The client's don'ts say "${hit}".`);
    }
  }
  if (kind === "image" && post && !post.hasPicture) notes.push(`Post ${post.index} has no picture yet: generate it first, then edit it.`);
  return notes.length ? notes.join(" ") : undefined;
}

/** One item read as one change (its target already resolved). */
export function classifyItem(text: string, target: { post?: number; slide?: number }, ctx: FeedbackContext): ProposedAction {
  const post = postOf(ctx, target.post);
  const ov = post?.ov ?? {};
  const base: Pick<ProposedAction, "post" | "slide"> = { post: target.post, slide: target.slide };
  const t = text.trim();

  if (IDEA_RE.test(t)) {
    const kind = "idea" as const;
    return { ...base, kind, change: `Rethink the idea: ${t.replace(/[.؟!]+$/, "")}.`, conflict: conflictOf(t, kind, post, ctx) };
  }

  // The words of the post, given outright.
  if (WORDS_FIELD.test(t) && (WORDS_VERB.test(t) || /["“«]/.test(t))) {
    const given = quotedWords(t, new RegExp(`\\b(headline|title|caption|sub-?line|second line)\\b`, "i")) ?? quotedWords(t, WORDS_FIELD);
    if (given && !/\b(bigger|smaller|larger|move|colou?r|font|size)\b/i.test(t)) {
      return { ...base, kind: "words", change: `${given.field === "caption" ? "Caption" : given.field === "subline" ? "Second line" : "Headline"} becomes "${given.value}".`, patch: { [given.field]: given.value } as WordsPatch };
    }
    if (/\b(typo|spelling|misspell|grammar|wrong word|correct)\b/i.test(t) || (/\b(caption|headline|title)\b/i.test(t) && !BIGGER_RE.test(t) && !SMALLER_RE.test(t) && !MOVE_RE.test(t) && !COLOR_RE.test(t))) {
      const field: keyof WordsPatch = /caption/i.test(t) ? "caption" : /sub-?line|second line/i.test(t) ? "subline" : "headline";
      return { ...base, kind: "words", change: `Change the ${field === "subline" ? "second line" : field}: ${t}`, ambiguity: `What should the ${field === "subline" ? "second line" : field} say? Type the new words before approving.` };
    }
  }

  // The logo: a layer the browser draws; the picture is never touched.
  if (LOGO.test(t) && !/\b(in|inside|on) the (picture|image|photo|cup)\b/i.test(t)) {
    const from = ov.logoWidth ?? post?.logoWidth ?? DEFAULT_LOGO_WIDTH;
    if (BIGGER_RE.test(t) && !SMALLER_RE.test(t)) {
      const logoWidth = round(clamp(from * BIGGER, 0.02, 1));
      return { ...base, kind: "layer", change: `Logo ${Math.round(BIGGER * 100 - 100)}% larger (width ${from.toFixed(3)} → ${logoWidth.toFixed(3)} of the post).`, patch: { logoWidth } as PostOverlayPatch };
    }
    if (SMALLER_RE.test(t)) {
      const logoWidth = round(clamp(from * SMALLER, 0.02, 1));
      return { ...base, kind: "layer", change: `Logo ${Math.round(100 - SMALLER * 100)}% smaller (width ${from.toFixed(3)} → ${logoWidth.toFixed(3)} of the post).`, patch: { logoWidth } as PostOverlayPatch };
    }
    if (MOVE_RE.test(t)) {
      const patch: PostOverlayPatch = {};
      const dir: string[] = [];
      if (/\b(left)\b/i.test(t)) {
        patch.logoDx = round((ov.logoDx ?? 0) - STEP);
        dir.push("left");
      }
      if (/\b(right)\b/i.test(t)) {
        patch.logoDx = round((ov.logoDx ?? 0) + STEP);
        dir.push("right");
      }
      if (/\b(up|higher|raise|top)\b/i.test(t)) {
        patch.logoDy = round((ov.logoDy ?? 0) - STEP);
        dir.push("up");
      }
      if (/\b(down|lower|bottom)\b/i.test(t)) {
        patch.logoDy = round((ov.logoDy ?? 0) + STEP);
        dir.push("down");
      }
      if (/\b(center|centre|middle)\b/i.test(t) && !dir.length) {
        patch.logoDx = 0;
        dir.push("to the centre");
      }
      if (dir.length) return { ...base, kind: "layer", change: `Move the logo ${dir.join(" and ")} (a nudge of ${STEP} of the width).`, patch };
    }
    if (/\b(remove|hide|take (out|off|away)|no logo|without the logo)\b/i.test(t)) return { ...base, kind: "layer", change: "Hide the logo on this post.", patch: { logoWidth: 0.02 } as PostOverlayPatch, ambiguity: "The layout's logo cannot be switched off per post yet; the patch makes it as small as allowed. Approve only if that is wanted." };
    return { ...base, kind: "unclear", change: t, ambiguity: "What should change about the logo: its size, its place?" };
  }

  // The words as a layer: size, place, colour.
  if (WORDS_LAYER.test(t) && (BIGGER_RE.test(t) || SMALLER_RE.test(t) || MOVE_RE.test(t) || COLOR_RE.test(t) || /\b(fade|scrim|shadow behind|dark band)\b/i.test(t))) {
    const patch: PostOverlayPatch = {};
    const what: string[] = [];
    const scale = ov.scale ?? 1;
    if (BIGGER_RE.test(t) && !SMALLER_RE.test(t)) {
      patch.scale = round(clamp(scale * BIGGER, 0.2, 4));
      what.push(`text ${Math.round(BIGGER * 100 - 100)}% larger`);
    } else if (SMALLER_RE.test(t)) {
      patch.scale = round(clamp(scale * SMALLER, 0.2, 4));
      what.push(`text ${Math.round(100 - SMALLER * 100)}% smaller`);
    }
    if (/\b(to|at|on) the (top|bottom|center|centre|middle)\b|\b(top|bottom|center|centre|middle) of the (post|picture|image)\b/i.test(t)) {
      const pos = /\btop\b/i.test(t) ? "top" : /\bbottom\b/i.test(t) ? "bottom" : "center";
      patch.position = pos;
      patch.pin = true;
      what.push(`words at the ${pos}`);
    } else if (MOVE_RE.test(t) && /\b(move|shift|higher|lower|raise|up|down|left|right)\b/i.test(t)) {
      if (/\b(up|higher|raise)\b/i.test(t)) {
        patch.dy = round((ov.dy ?? 0) - STEP);
        what.push("words up");
      }
      if (/\b(down|lower)\b/i.test(t)) {
        patch.dy = round((ov.dy ?? 0) + STEP);
        what.push("words down");
      }
      if (/\bleft\b/i.test(t)) {
        patch.dx = round((ov.dx ?? 0) - STEP);
        what.push("words left");
      }
      if (/\bright\b/i.test(t)) {
        patch.dx = round((ov.dx ?? 0) + STEP);
        what.push("words right");
      }
      if (patch.dx !== undefined || patch.dy !== undefined) patch.pin = true;
    }
    if (/\b(align|aligned)\b/i.test(t)) {
      if (/\bleft\b/i.test(t)) {
        patch.align = "left";
        what.push("aligned left");
      } else if (/\bright\b/i.test(t)) {
        patch.align = "right";
        what.push("aligned right");
      } else if (/\b(center|centre)/i.test(t)) {
        patch.align = "center";
        what.push("centred");
      }
    }
    const colour = COLOR_RE.exec(t);
    if (colour && /\b(colou?r|in|make|turn|paint)\b/i.test(t) && !/\bbackground\b/i.test(t)) {
      const named: Record<string, string> = { white: "#ffffff", black: "#000000", red: "#d62828", blue: "#1129d3", green: "#2e8b57", yellow: "#f2c200", orange: "#ff5a00", pink: "#e75480", purple: "#6a0dad", gold: "#c9a227", golden: "#c9a227", grey: "#8e8e93", gray: "#8e8e93", brown: "#6b4226", beige: "#ffe6d0", navy: "#0b1a8a", teal: "#008080" };
      const c = colour[0].toLowerCase();
      patch.color = c.startsWith("#") ? c : named[c] ?? c;
      what.push(`text in ${c}`);
    }
    if (/\b(remove|no|without|drop|lose)\b.{0,12}\b(fade|scrim|dark band|gradient)\b/i.test(t)) {
      patch.fade = false;
      what.push("no dark fade");
    }
    if (what.length) return { ...base, kind: "layer", change: `${what.join(", ").replace(/^./, (ch) => ch.toUpperCase())} (a layer edit: the picture stays).`, patch };
  }

  // The picture itself.
  if (IMAGE_WORDS.test(t) || (IMAGE_OBJECT.test(t) && !WORDS_LAYER.test(t) && !LOGO.test(t))) {
    const kind = "image" as const;
    const instruction = t.replace(/[.؟!]+$/, "").replace(/^\s*(please|kindly)\s+/i, "").trim();
    return { ...base, kind, change: `Edit the picture: ${instruction}.`, instruction: `${instruction.replace(/^./, (ch) => ch.toUpperCase())}.`, conflict: conflictOf(t, kind, post, ctx) };
  }

  return { ...base, kind: "unclear", change: t, ambiguity: "Is this about the words, the layout (logo, text) or the picture? Pick the kind and the post before approving.", conflict: conflictOf(t, "image", undefined, ctx) };
}

/** The deterministic reading: the feedback split into items, each resolved to a post and a change. */
export function interpretFeedback(text: string, ctx: FeedbackContext): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const item of splitFeedback(text)) {
    const target = resolveTarget(item, ctx);
    if (target.all) {
      const posts = ctx.posts.length ? ctx.posts : [];
      if (!posts.length) {
        out.push({ kind: "unclear", change: target.text, ambiguity: "Which post? The month has no posts yet." });
        continue;
      }
      for (const p of posts) out.push(classifyItem(target.text, { post: p.index }, ctx));
      continue;
    }
    if (target.ambiguity) {
      const read = classifyItem(target.text, { slide: target.slide }, ctx);
      // No guessed target: the designer picks the post; the reading is kept so a pick is all it needs.
      out.push({ ...read, post: undefined, kind: "unclear", ambiguity: target.ambiguity, change: read.kind === "unclear" ? read.change : `${read.change} (${read.kind === "layer" ? "layer edit" : read.kind === "words" ? "new words" : read.kind === "image" ? "picture edit" : "new idea"})` });
      continue;
    }
    out.push(classifyItem(target.text, { post: target.post, slide: target.slide }, ctx));
  }
  return out;
}

/* ───────────── The model's reading ───────────── */

export const FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          post: { type: "integer" },
          slide: { type: "integer" },
          kind: { type: "string", enum: ["layer", "image", "words", "idea", "unclear"] },
          change: { type: "string" },
          patch: {
            type: "object",
            properties: {
              logoWidth: { type: "number" },
              logoDx: { type: "number" },
              logoDy: { type: "number" },
              dx: { type: "number" },
              dy: { type: "number" },
              scale: { type: "number" },
              color: { type: "string" },
              position: { type: "string", enum: ["top", "center", "bottom"] },
              align: { type: "string", enum: ["left", "center", "right"] },
              fade: { type: "boolean" },
              headline: { type: "string" },
              subline: { type: "string" },
              caption: { type: "string" },
            },
          },
          instruction: { type: "string" },
          ambiguity: { type: "string" },
          conflict: { type: "string" },
        },
        required: ["kind", "change"],
      },
    },
  },
  required: ["actions"],
};

export const FEEDBACK_CONTEXT_MARK = "CONTEXT (JSON):";
export const FEEDBACK_TEXT_MARK = "THE CLIENT'S FEEDBACK:";

/** The instruction for the text model; the context and the feedback sit in marked blocks the demo fixture reads back. */
export function feedbackInstruction(r: { client: string; text: string; context: FeedbackContext }): string {
  const ctx = { posts: r.context.posts.map((p) => ({ index: p.index, title: p.title, headline: p.headline ?? "", caption: (p.caption ?? "").slice(0, 160), hasPicture: p.hasPicture, slides: p.slides ?? 0, logoWidth: p.ov?.logoWidth ?? p.logoWidth ?? DEFAULT_LOGO_WIDTH, scale: p.ov?.scale ?? 1 })), post: r.context.post, constraints: r.context.constraints ?? {} };
  return [
    `You read a client's feedback on ${r.client}'s month of social-media posts and turn it into separate changes, one per request, each on one post. You never apply anything; a designer approves each change.`,
    "RULES:",
    "- kind 'layer': the logo or the words as drawn over the picture (size, place, colour, the dark fade). patch is a PostOverlayPatch: logoWidth (a fraction of the width; bigger = ×1.25 of the current, smaller = ×0.8), logoDx/logoDy and dx/dy nudges of ±0.05, scale (×1.25 / ×0.8 of the current), color (#hex), position top|center|bottom, align, fade false.",
    "- kind 'words': the client gives new words. patch is {headline} or {caption} or {subline} with the exact words. When no new words are given, kind 'words' with an ambiguity asking for them.",
    "- kind 'image': the picture changes (an object removed, added or replaced; light, background, colour, crop). instruction: one imperative English sentence for the image engine. Never ask the engine to draw words, letters or signs.",
    "- kind 'idea': the client wants another concept for the post. change says so in one sentence.",
    "- kind 'unclear': which post is meant cannot be told ('the second one', 'the blue one'), or the request cannot be read. ambiguity: the question for the designer ('Which post? …'). NEVER guess a post: leave post out.",
    "- post: only when the feedback names it ('post 2', '#2') or the feedback was given on one post (context.post) or the month has one post. 'all posts' = one action per post.",
    "- conflict: when the request runs against the campaign (people when constraints.noPeople, words in the picture, a don't), one sentence; the action is still proposed.",
    "- change: the interpreted change in plain English, one sentence. Keep the client's language inside quotes only for new words.",
    `${FEEDBACK_CONTEXT_MARK}\n${JSON.stringify(ctx)}`,
    `${FEEDBACK_TEXT_MARK}\n"""\n${r.text.trim().slice(0, 6000)}\n"""`,
    'Return ONLY JSON: {"actions": [{"post": 2, "slide": 0, "kind": "layer", "change": "...", "patch": {"logoWidth": 0.2}, "instruction": "", "ambiguity": "", "conflict": ""}]}.',
  ].join("\n\n");
}

/** The context and the feedback back out of an instruction (the demo fixture and the tests). */
export function feedbackFromInstruction(instruction: string): { text: string; context: FeedbackContext } | null {
  const c = instruction.indexOf(FEEDBACK_CONTEXT_MARK);
  const t = instruction.indexOf(FEEDBACK_TEXT_MARK);
  if (c < 0 || t < 0) return null;
  try {
    const raw = JSON.parse(instruction.slice(c + FEEDBACK_CONTEXT_MARK.length, t).trim()) as { posts?: FeedbackPost[]; post?: number; constraints?: FeedbackConstraints };
    const body = instruction.slice(t + FEEDBACK_TEXT_MARK.length);
    const m = /"""\n?([\s\S]*?)\n?"""/.exec(body);
    return { text: m ? m[1] : body.trim(), context: { posts: Array.isArray(raw.posts) ? raw.posts : [], post: raw.post, constraints: raw.constraints } };
  } catch {
    return null;
  }
}

const KINDS: FeedbackKind[] = ["layer", "image", "words", "idea", "unclear"];
const LAYER_KEYS = new Set(["logoWidth", "logoDx", "logoDy", "dx", "dy", "scale", "color", "position", "align", "fade", "pin"]);
const WORDS_KEYS = new Set(["headline", "subline", "caption"]);

/** The model's answer checked: kinds, targets inside the month, patches of the right shape; the rules' reading when it is unusable. */
export function parseFeedbackActions(raw: unknown, ctx: FeedbackContext, fallback: ProposedAction[]): ProposedAction[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { actions?: unknown }).actions) ? ((raw as { actions: unknown[] }).actions as Record<string, unknown>[]) : [];
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const out: ProposedAction[] = [];
  for (const x of list.slice(0, MAX_ITEMS)) {
    if (!x || typeof x !== "object") continue;
    let kind = KINDS.includes(x.kind as FeedbackKind) ? (x.kind as FeedbackKind) : "unclear";
    const change = str(x.change, 400);
    if (!change) continue;
    const postNo = Number(x.post);
    let post = Number.isInteger(postNo) && postNo > 0 && ctx.posts.some((p) => p.index === postNo) ? postNo : undefined;
    let ambiguity = str(x.ambiguity, 300) || undefined;
    // A target the model made up is not a target.
    if (Number.isInteger(postNo) && postNo > 0 && post === undefined) {
      post = undefined;
      kind = "unclear";
      ambiguity = ambiguity ?? `Which post? Post ${postNo} is not in this month.`;
    }
    const slideNo = Number(x.slide);
    const slide = Number.isInteger(slideNo) && slideNo > 0 ? slideNo : undefined;
    let patch: PostOverlayPatch | WordsPatch | undefined;
    if (x.patch && typeof x.patch === "object") {
      const keys = kind === "layer" ? LAYER_KEYS : kind === "words" ? WORDS_KEYS : new Set<string>();
      const entries = Object.entries(x.patch as Record<string, unknown>).filter(([k, v]) => keys.has(k) && v !== null && v !== undefined && v !== "" && (typeof v === "number" ? Number.isFinite(v) : true));
      if (entries.length) patch = Object.fromEntries(entries) as PostOverlayPatch | WordsPatch;
    }
    if ((kind === "layer" || kind === "words") && !patch) ambiguity = ambiguity ?? (kind === "words" ? "What should it say? Type the new words before approving." : "Which layer change? The reading gave no patch.");
    const instruction = kind === "image" ? str(x.instruction, 600) || undefined : undefined;
    if (kind === "image" && !instruction) ambiguity = ambiguity ?? "What should change in the picture? Write the edit before approving.";
    const target = postOf(ctx, post);
    const conflict = str(x.conflict, 300) || conflictOf(change, kind, target, ctx);
    out.push({ post, slide, kind, change, patch, instruction, ambiguity, conflict: conflict || undefined });
  }
  return out.length ? out : fallback;
}

/** The chip the panel shows for a kind, and what it costs. */
export function kindLabel(kind: FeedbackKind): string {
  switch (kind) {
    case "layer":
      return "Layer edit · free";
    case "words":
      return "Words · free";
    case "image":
      return "AI image edit · paid, confirm before spending";
    case "idea":
      return "Idea";
    default:
      return "Unclear";
  }
}

/** True when an approved action has what it needs to be applied. */
export function canApply(a: Pick<FeedbackAction, "kind" | "post" | "status" | "patch" | "instruction">): boolean {
  if (a.status !== "approved" || a.post === undefined) return false;
  if (a.kind === "unclear") return false;
  if ((a.kind === "layer" || a.kind === "words") && !a.patch) return false;
  if (a.kind === "image" && !a.instruction?.trim()) return false;
  return true;
}
