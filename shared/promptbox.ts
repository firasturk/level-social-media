/**
 * The Prompt Box: the planner chat reads a sentence and, when it asks a tool to do something
 * ("find a minimal background from Freepik for post 3", "animate this post using Kling"), turns it
 * into an intent card the person confirms. Nothing here runs anything: the resolver only says
 * what was asked, on which post, through which provider, and what it would cost.
 *
 * The resolver is deterministic, so the brief's examples work with no model and the preview's
 * demo fixture answers the same way. A text model may propose an intent; `validateIntent` is the
 * only way a proposal becomes a card, and it applies the same rules.
 */
import { VIDEO_MODELS, VIDEO_SECONDS } from "./qa";
import { DEFAULT_FRAME, frameLabel, isFrame } from "./video-frame";

export type ToolName = "freepik.search" | "freepik.use" | "video.generate" | "photolab.run" | "none";
export type ToolProvider = "freepik" | "higgsfield" | "none";

export interface IntentTarget {
  batch: string;
  post: number | null;
  slide: number | null;
  version?: string | null;
}

export interface IntentAsset {
  id: string;
  source: string;
  /** A small preview the card shows; absent when the source has none. */
  url?: string;
  title?: string;
}

export interface ToolIntent {
  tool: ToolName;
  target: IntentTarget;
  asset?: IntentAsset;
  /** Plain English: "Search Freepik", "Add to the design", "Animate the picture". */
  operation: string;
  provider: ToolProvider;
  settings: Record<string, unknown>;
  /** Credits the run would use, when the catalog knows; null blocks the run until someone sets it. */
  estimate: number | null;
  estimateNote: string;
  needsConfirmation: boolean;
  /** At most one focused question when the sentence is ambiguous; the card cannot run while one is open. */
  questions: string[];
}

export interface VideoModelInfo {
  slug: string;
  name: string;
  note?: string;
  /** Credits for one clip at the default length, when the catalog publishes it. */
  credits?: number | null;
  /** The frames the engine offers; null when it follows the picture's own frame. */
  aspects?: string[] | null;
}

export interface PromptContext {
  batch: string;
  posts: { index: number; title: string; group?: { kind: string; slide: number; of: number } | null }[];
  /** The post open in the editor, when one is; "this post" means it. */
  openPost: number | null;
  openSlide?: number | null;
  /** The asset last shown or picked in the thread; "this asset" means it. */
  lastAsset: IntentAsset | null;
  /** The video engines on offer; `shared/video-models.ts` when it exists, else the catalog in shared/qa.ts. */
  videoModels?: VideoModelInfo[];
}

export const COST_UNKNOWN = "Cost not known yet";
export const FREE_NOTE = "Free: browsing costs nothing";

/** The video engines the box can name, with the credits the catalog knows. */
export function videoCatalog(): VideoModelInfo[] {
  return VIDEO_MODELS.map((m) => ({ slug: m.slug, name: m.name, note: m.note, credits: (m as { credits?: number }).credits ?? null, aspects: m.aspect ?? null }));
}

export function isToolName(v: unknown): v is ToolName {
  return v === "freepik.search" || v === "freepik.use" || v === "video.generate" || v === "photolab.run" || v === "none";
}

function none(batch: string): ToolIntent {
  return { tool: "none", target: { batch, post: null, slide: null }, operation: "", provider: "none", settings: {}, estimate: null, estimateNote: "", needsConfirmation: false, questions: [] };
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
function latinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

/** "post 3", "#3", "بوست ٣", "slide 2 of post 4". */
function explicitPost(text: string): number | null {
  const m = /(?:\bpost|بوست|#)\s*(\d{1,2})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}
function explicitSlide(text: string): number | null {
  const m = /\bslide\s*(\d{1,2})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

const STOP = new Set(["the", "a", "an", "this", "that", "post", "posts", "for", "of", "to", "on", "in", "with", "and", "it", "its", "using", "through", "via", "from", "by", "one", "please", "animate", "make", "video", "add", "use", "find", "search", "look", "get", "me", "freepik", "kling", "seedance", "higgsfield", "picture", "image", "design"]);

/**
 * Which post the sentence means: a number first, then the open post for "this post"/"it", then a
 * title the words name when exactly one post carries it. Several matches or none: a question.
 */
function targetPost(text: string, ctx: PromptContext, what: string): { post: number | null; question: string | null } {
  const n = explicitPost(text);
  if (n !== null) {
    if (ctx.posts.length && !ctx.posts.some((p) => p.index === n)) return { post: null, question: `There is no post ${n} this month. Which post do you mean?` };
    return { post: n, question: null };
  }
  const refersToOpen = /\b(this|the open|the current|the selected)\s+(post|design|picture|one|slide)\b|\bthis one\b|\bit\b/i.test(text);
  if (refersToOpen && ctx.openPost !== null) return { post: ctx.openPost, question: null };
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const hits = ctx.posts.filter((p) => {
    const title = p.title.toLowerCase();
    return words.some((w) => title.includes(w));
  });
  if (hits.length === 1) return { post: hits[0].index, question: null };
  if (hits.length > 1) return { post: null, question: `Which post should ${what}: ${hits.map((p) => `${p.index} (${p.title})`).join(" or ")}?` };
  if (ctx.openPost !== null && refersToOpen) return { post: ctx.openPost, question: null };
  return { post: null, question: `Which post should ${what}? Say its number, or open it first.` };
}

const FREEPIK = /\bfreepik\b/i;
const STOCK = /\b(stock|asset|assets|background|backgrounds|vector|vectors|icon|icons|texture|textures|illustration|illustrations|photo|photos|image|images)\b/i;
const SEARCH_VERB = /\b(find|search|look\s+for|browse|show\s+me|get\s+me|fetch|pull|bring)\b/i;
const USE_VERB = /\b(add|use|put|place|set|insert|drop|apply|attach)\b/i;
const THIS_ASSET = /\b(this|that|the|it|the\s+(first|second|third|last)\s+one)\b/i;
const VIDEO = /\b(animate|animation|video|motion|clip|reel|kling|seedance|higgsfield|move|moving)\b/i;
const PHOTOLAB = /\b(photo\s*lab|photolab|magnific|upscale|upscaling|retouch|relight|remove\s+(the\s+)?background|cut\s*out|expand\s+the\s+(picture|image|frame)|outpaint|enhance)\b/i;

/** The words to search for: what sits between the verb and "from Freepik" / "for post N". */
function searchQuery(text: string): string {
  let q = text;
  q = q.replace(/^[\s,.!?]*(please\s+)?(can|could|would)\s+you\s+/i, "").replace(/^\s*please\s+/i, "");
  q = q.replace(SEARCH_VERB, " ");
  q = q.replace(/\b(from|on|in|at|via|through|using)\s+freepik\b/gi, " ").replace(FREEPIK, " ");
  q = q.replace(/\b(for|on|to|behind|under|over)\s+(the\s+)?(post|بوست|#)\s*\d{1,2}\b.*$/i, " ");
  q = q.replace(/\b(for|on|to|behind|under)\s+(this|the open|the current|the)\s+(post|design|picture|one|headline|slide)\b.*$/i, " ");
  q = q.replace(/\b(for|to)\s+(me|us)\b/gi, " ");
  q = q.replace(/^\s*(a|an|some|the)\s+/i, " ");
  q = q.replace(/\b(stock)\b/gi, " ");
  return q.replace(/[,.!?]+$/g, "").replace(/\s+/g, " ").trim();
}

function assetType(text: string): string {
  if (/\bvectors?\b/i.test(text)) return "vector";
  if (/\bicons?\b/i.test(text)) return "icon";
  if (/\b(video|videos|footage)\b/i.test(text)) return "video";
  if (/\b(psd|template|templates)\b/i.test(text)) return "psd";
  return "photo";
}
function orientation(text: string): string {
  if (/\b(landscape|horizontal|wide)\b/i.test(text)) return "landscape";
  if (/\b(portrait|vertical|tall)\b/i.test(text)) return "portrait";
  if (/\bsquare\b/i.test(text)) return "square";
  return "";
}

function videoModel(text: string, models: VideoModelInfo[]): VideoModelInfo | null {
  const named = models.find((m) => {
    const key = m.name.split(/\s+/)[0].toLowerCase();
    return new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text) || text.toLowerCase().includes(m.slug.split("/")[0].toLowerCase());
  });
  return named ?? models[0] ?? null;
}
function duration(text: string): number {
  const m = /\b(\d{1,2})\s*(?:s|sec|secs|second|seconds)\b/i.exec(text);
  const n = m ? Number(m[1]) : VIDEO_SECONDS;
  return Math.min(15, Math.max(3, n));
}
/**
 * The `aspect` handed to the engine: the frame when the engine has a frame choice that includes it,
 * "" (the engine follows the picture) otherwise. The frame itself is kept apart in `settings.frame`.
 */
function frameFor(model: VideoModelInfo | null | undefined, asked: string): string {
  if (!model || model.aspects === undefined) return asked;
  if (model.aspects === null) return "";
  return model.aspects.includes(asked) ? asked : "";
}

/** The frame the sentence asks for; a Reel (9:16) unless it says otherwise (shared/video-frame.ts). */
function aspect(text: string): string {
  const m = /\b(9:16|16:9|1:1|4:5)\b/.exec(text);
  if (m) return m[1];
  if (/\b(square)\b/i.test(text)) return "1:1";
  if (/\b(landscape|wide|horizontal)\b/i.test(text)) return "16:9";
  if (/\b(feed post|portrait post|4 by 5)\b/i.test(text)) return "4:5";
  return DEFAULT_FRAME;
}

/** True when the sentence sounds like a tool request at all (a model is asked only then). */
export function hintsTool(text: string): boolean {
  return FREEPIK.test(text) || VIDEO.test(text) || PHOTOLAB.test(text) || (USE_VERB.test(text) && /\b(asset|reference)\b/i.test(text));
}

/**
 * The sentence read without a model. "none" when it is about the ideas (the planner answers as
 * before); otherwise a card, with one question when something is missing. Never a guess: an
 * unknown post or asset is asked about, never picked.
 */
export function resolveIntent(rawText: string, ctx: PromptContext): ToolIntent {
  const text = latinDigits(rawText.trim());
  const batch = ctx.batch;
  if (!text) return none(batch);
  const models = ctx.videoModels ?? videoCatalog();
  const slide = explicitSlide(text) ?? (ctx.openSlide ?? null);

  // Photo Lab edits of a finished picture (named first: "remove the background" is not a Freepik search).
  if (PHOTOLAB.test(text) && !FREEPIK.test(text)) {
    const op = /\bupscal/i.test(text) ? "Upscale the picture" : /\bremove\s+(the\s+)?background|cut\s*out/i.test(text) ? "Remove the background" : /\brelight/i.test(text) ? "Relight the picture" : /\bexpand|outpaint/i.test(text) ? "Expand the picture" : /\bretouch/i.test(text) ? "Retouch the picture" : "Enhance the picture";
    const t = targetPost(text, ctx, "be edited");
    return {
      tool: "photolab.run",
      target: { batch, post: t.post, slide },
      operation: op,
      provider: "freepik",
      settings: { operation: op.split(" ")[0].toLowerCase(), prompt: text },
      estimate: null,
      estimateNote: `${COST_UNKNOWN}: Photo Lab prices are not in the catalog.`,
      needsConfirmation: true,
      questions: t.question ? [t.question] : [],
    };
  }

  // Animate a post: image-to-video through Higgsfield.
  if (VIDEO.test(text) && !/\b(video|videos|footage)\s+(from|on)\s+freepik\b/i.test(text) && !(FREEPIK.test(text) && SEARCH_VERB.test(text))) {
    const model = videoModel(text, models);
    const t = targetPost(text, ctx, "be animated");
    const questions = t.question ? [t.question] : [];
    if (!model) questions.push("Which video engine? None is on the catalog yet.");
    const credits = model?.credits ?? null;
    return {
      tool: "video.generate",
      target: { batch, post: t.post, slide },
      operation: `Animate the ${/\b(artwork|design|the design|with the words)\b/i.test(text) ? "design" : "picture"}`,
      provider: "higgsfield",
      settings: {
        model: model?.slug ?? "",
        modelName: model?.name ?? "",
        duration: duration(text),
        frame: aspect(text),
        aspect: frameFor(model, aspect(text)),
        source: /\b(artwork|design|with the words)\b/i.test(text) ? "artwork" : "picture",
        prompt: text,
      },
      estimate: credits,
      estimateNote: credits === null ? `${COST_UNKNOWN}: ${model ? `${model.name} has no price in the catalog` : "no engine chosen"}.` : `About ${credits} credits for one ${duration(text)}-second clip.`,
      needsConfirmation: true,
      questions: questions.slice(0, 1),
    };
  }

  // Search Freepik: free browsing, nothing is made or added.
  if (FREEPIK.test(text) && (SEARCH_VERB.test(text) || (STOCK.test(text) && !USE_VERB.test(text)))) {
    const q = searchQuery(text);
    const n = explicitPost(text);
    const post = n !== null && ctx.posts.some((p) => p.index === n) ? n : n === null && /\b(this|the open|the current)\s+(post|design)\b/i.test(text) ? ctx.openPost : null;
    const questions = q ? [] : ["What should I search Freepik for?"];
    return {
      tool: "freepik.search",
      target: { batch, post, slide },
      operation: "Search Freepik",
      provider: "freepik",
      settings: { q, type: assetType(text), orientation: orientation(text), page: 1 },
      estimate: 0,
      estimateNote: FREE_NOTE,
      needsConfirmation: false,
      questions,
    };
  }

  // Use an asset on a post: as a reference for the next take, or added to the design.
  if (USE_VERB.test(text) && (THIS_ASSET.test(text) || /\basset\b/i.test(text)) && /\b(asset|image|picture|photo|background|vector|icon|texture|illustration|one|it|reference)\b/i.test(text) && (ctx.lastAsset || /\basset\b/i.test(text) || /\bas\s+(a\s+)?reference\b/i.test(text) || /\b(behind|under|over|into|to)\s+(the\s+)?(headline|design|post|picture|layout)\b/i.test(text))) {
    const role = /\b(reference|inspiration|mood|for the next take)\b/i.test(text) ? "reference" : "design";
    const t = targetPost(text.replace(/\b(it|this)\b/i, "this post"), ctx, role === "design" ? "receive the asset" : "take the reference");
    const questions: string[] = [];
    if (!ctx.lastAsset) questions.push("Which asset? Search Freepik first, or pick one from the results.");
    else if (t.question) questions.push(t.question);
    const placement = /\bbehind\s+the\s+headline\b/i.test(text) ? "behind the headline" : /\b(as\s+(the\s+)?background|in\s+the\s+background)\b/i.test(text) ? "background" : /\bbehind\b/i.test(text) ? "behind" : role === "design" ? "layer" : "";
    return {
      tool: "freepik.use",
      target: { batch, post: t.post, slide },
      ...(ctx.lastAsset ? { asset: ctx.lastAsset } : {}),
      operation: role === "design" ? "Add to the design" : "Use as a reference",
      provider: "freepik",
      settings: { role, placement },
      estimate: 0,
      estimateNote: "No credit from the studio: the asset is already selected.",
      needsConfirmation: true,
      questions: questions.slice(0, 1),
    };
  }

  return none(batch);
}

/** JSON schema for a text model's proposal; the proposal is only advice until `validateIntent` accepts it. */
export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", enum: ["freepik.search", "freepik.use", "video.generate", "photolab.run", "none"] },
    post: { type: "integer" },
    slide: { type: "integer" },
    q: { type: "string" },
    assetType: { type: "string" },
    orientation: { type: "string" },
    role: { type: "string" },
    model: { type: "string" },
    duration: { type: "integer" },
    aspect: { type: "string" },
    operation: { type: "string" },
    question: { type: "string" },
  },
  required: ["tool", "post", "slide", "q", "assetType", "orientation", "role", "model", "duration", "aspect", "operation", "question"],
};

export function intentInstruction(message: string, ctx: PromptContext): string {
  return [
    "You read one sentence from a designer in a social-media studio and say whether it asks a tool to act, and which. You never run anything; a person confirms a card afterwards.",
    `TOOLS: freepik.search (browse stock assets on Freepik; q is the search words), freepik.use (put the asset shown last onto a post: role "design" adds it to the layout, role "reference" guides the next take), video.generate (animate a post's picture through Higgsfield; model is one of ${(ctx.videoModels ?? videoCatalog()).map((m) => `"${m.slug}" (${m.name})`).join(", ")}), photolab.run (upscale, remove background, relight, expand a finished picture), none (the sentence is about the ideas, words, dates or products: the planner handles it).`,
    `CONTEXT JSON: ${JSON.stringify({ batch: ctx.batch, posts: ctx.posts.map((p) => ({ index: p.index, title: p.title })), openPost: ctx.openPost, openSlide: ctx.openSlide ?? null, lastAsset: ctx.lastAsset ? { id: ctx.lastAsset.id, source: ctx.lastAsset.source } : null })}`,
    `MESSAGE: ${JSON.stringify(message.trim().slice(0, 1500))}`,
    "RULES: post is the post's number as the designer wrote it (\"this post\" is openPost; 0 when none is clear). When two posts could be meant, ask one short question in question and leave post 0; never guess. Fields a tool has no use for are \"\" or 0.",
    'Return ONLY JSON: {"tool": "freepik.search", "post": 3, "slide": 0, "q": "minimal background", "assetType": "photo", "orientation": "", "role": "", "model": "", "duration": 0, "aspect": "", "operation": "", "question": ""}.',
  ].join("\n\n");
}

/** The message and context the instruction carries, so the demo fixture can answer deterministically. */
export function intentRequestFrom(instruction: string): { message: string; ctx: PromptContext } | null {
  const ctxLine = /^CONTEXT JSON: (.*)$/m.exec(instruction);
  const msgLine = /^MESSAGE: (.*)$/m.exec(instruction);
  if (!ctxLine || !msgLine) return null;
  try {
    const c = JSON.parse(ctxLine[1]) as Partial<PromptContext>;
    return { message: JSON.parse(msgLine[1]) as string, ctx: { batch: c.batch ?? "", posts: c.posts ?? [], openPost: c.openPost ?? null, openSlide: c.openSlide ?? null, lastAsset: c.lastAsset ? { id: c.lastAsset.id, source: c.lastAsset.source } : null } };
  } catch {
    return null;
  }
}

/**
 * A proposed intent (a model's, or one sent back by the browser) checked against the context:
 * known tool and provider, a real post, the model from the catalog, the asset that was shown, the
 * estimate from the catalog (never from the proposal), and the same questions the resolver asks.
 */
export function validateIntent(raw: unknown, ctx: PromptContext): ToolIntent | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isToolName(d.tool)) return null;
  if (d.tool === "none") return none(ctx.batch);
  const models = ctx.videoModels ?? videoCatalog();
  const target = (d.target && typeof d.target === "object" ? d.target : {}) as Record<string, unknown>;
  const settings = (d.settings && typeof d.settings === "object" ? d.settings : {}) as Record<string, unknown>;
  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  const postRaw = int(target.post) ?? int(d.post);
  const post = postRaw !== null && (!ctx.posts.length || ctx.posts.some((p) => p.index === postRaw)) ? postRaw : null;
  const slide = int(target.slide) ?? int(d.slide) ?? ctx.openSlide ?? null;
  const question = str(d.question);
  const base = { target: { batch: ctx.batch, post, slide }, questions: [] as string[] };
  if (d.tool === "freepik.search") {
    const q = str(settings.q ?? d.q, 200);
    return { ...base, tool: "freepik.search", operation: "Search Freepik", provider: "freepik", settings: { q, type: str(settings.type ?? d.assetType) || "photo", orientation: str(settings.orientation ?? d.orientation), page: int(settings.page) ?? 1 }, estimate: 0, estimateNote: FREE_NOTE, needsConfirmation: false, questions: q ? [] : ["What should I search Freepik for?"] };
  }
  if (d.tool === "freepik.use") {
    const role = str(settings.role ?? d.role) === "reference" ? "reference" : "design";
    const proposed = (d.asset && typeof d.asset === "object" ? d.asset : null) as IntentAsset | null;
    const asset = ctx.lastAsset && (!proposed || proposed.id === ctx.lastAsset.id) ? ctx.lastAsset : null;
    const questions = !asset ? ["Which asset? Search Freepik first, or pick one from the results."] : post === null ? [question || "Which post should receive the asset? Say its number, or open it first."] : [];
    return { ...base, tool: "freepik.use", ...(asset ? { asset } : {}), operation: role === "design" ? "Add to the design" : "Use as a reference", provider: "freepik", settings: { role, placement: str(settings.placement) }, estimate: 0, estimateNote: "No credit from the studio: the asset is already selected.", needsConfirmation: true, questions };
  }
  if (d.tool === "video.generate") {
    const slug = str(settings.model ?? d.model);
    const model = models.find((m) => m.slug === slug) ?? null;
    const dur = int(settings.duration ?? d.duration) ?? VIDEO_SECONDS;
    const askedFrame = str(settings.frame ?? settings.aspect ?? d.aspect);
    const frame = isFrame(askedFrame) ? askedFrame : DEFAULT_FRAME;
    const asp = frameFor(model, frame);
    const credits = model?.credits ?? null;
    const questions = post === null ? [question || "Which post should be animated? Say its number, or open it first."] : !model ? ["Which video engine? Name one from the catalog."] : [];
    return { ...base, tool: "video.generate", operation: `Animate the ${str(settings.source) === "artwork" ? "design" : "picture"}`, provider: "higgsfield", settings: { model: model?.slug ?? "", modelName: model?.name ?? "", duration: Math.min(15, Math.max(3, dur)), frame, aspect: asp, source: str(settings.source) === "artwork" ? "artwork" : "picture", prompt: str(settings.prompt, 1500) }, estimate: credits, estimateNote: credits === null ? `${COST_UNKNOWN}: ${model ? `${model.name} has no price in the catalog` : "no engine chosen"}.` : `About ${credits} credits for one ${dur}-second clip.`, needsConfirmation: true, questions };
  }
  const op = str(settings.operation ?? d.operation) || "enhance";
  return { ...base, tool: "photolab.run", operation: `${op.charAt(0).toUpperCase()}${op.slice(1)} the picture`, provider: "freepik", settings: { operation: op.toLowerCase(), prompt: str(settings.prompt, 1500) }, estimate: null, estimateNote: `${COST_UNKNOWN}: Photo Lab prices are not in the catalog.`, needsConfirmation: true, questions: post === null ? [question || "Which post should be edited? Say its number, or open it first."] : [] };
}

/** One line for the thread: what the box understood, in plain English. */
export function intentSummary(i: ToolIntent, posts: PromptContext["posts"] = []): string {
  const where = i.target.post === null ? "no post chosen yet" : `post ${i.target.post}${i.target.slide ? ` · slide ${i.target.slide}` : ""}${posts.find((p) => p.index === i.target.post)?.title ? ` (${posts.find((p) => p.index === i.target.post)!.title})` : ""}`;
  const s = i.settings;
  const detail =
    i.tool === "freepik.search" ? `“${String(s.q ?? "")}”${s.type && s.type !== "photo" ? ` · ${String(s.type)}` : ""}${s.orientation ? ` · ${String(s.orientation)}` : ""}` : i.tool === "video.generate" ? `${String(s.modelName || s.model || "no engine")} · ${String(s.duration)} s · Frame: ${frameLabel(String(s.frame ?? "")) || frameLabel(DEFAULT_FRAME)}` : i.tool === "freepik.use" ? `${i.asset ? `asset ${i.asset.id}` : "no asset yet"}${s.placement ? ` · ${String(s.placement)}` : ""}` : String(s.operation ?? "");
  const cost = i.estimate === null ? i.estimateNote : i.estimate === 0 ? "free" : `about ${i.estimate} credits`;
  const q = i.questions[0] ? ` ${i.questions[0]}` : "";
  return `${i.operation}: ${detail} · ${where} · ${cost}.${q}`;
}

/** The card can run: nothing to ask, a post where one is needed, and a known cost for paid tools. */
export function intentRunnable(i: ToolIntent): { ok: boolean; why: string } {
  if (i.tool === "none") return { ok: false, why: "Nothing to run." };
  if (i.questions.length) return { ok: false, why: i.questions[0] };
  if (i.tool !== "freepik.search" && i.target.post === null) return { ok: false, why: "Choose a post first." };
  if (i.tool === "freepik.use" && !i.asset) return { ok: false, why: "Pick an asset first." };
  if (i.estimate === null) return { ok: false, why: `${COST_UNKNOWN} · blocked until clarified` };
  return { ok: true, why: "" };
}
