/**
 * Demo fixtures: on a preview deployment with no text key connected, every text and vision call
 * is answered here instead of by a provider, so the four ways of creating a month (a brief, a
 * grid, theme references, a style) can be walked through without a paid call. Every answer says
 * "DEMO FIXTURE" in its words. Pictures are never made on a preview whatever is pressed.
 */
import { previewNoImages, type Env } from "./env";
import { resolveGoogleAuth, resolveOpenAIKey } from "./settings";
import { feedbackFromInstruction, interpretFeedback } from "../shared/feedback";
import { intentRequestFrom, resolveIntent } from "../shared/promptbox";
import { demoCampaignAnswer, demoRetarget, isCampaignSchema, isRetargetSchema } from "../shared/campaign-planner";
import { demoSuggestions, isSuggestSchema } from "../shared/campaign-suggest";

export async function demoMode(env: Env): Promise<boolean> {
  if (!previewNoImages(env)) return false;
  return !(await resolveGoogleAuth(env)).auth && !(await resolveOpenAIKey(env)).key;
}

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; enum?: string[]; required?: string[] };

const DEMO = "DEMO FIXTURE";
const COLOURS = [
  { name: "sky blue", hex: "#0a7bd6" },
  { name: "sign yellow", hex: "#f2c200" },
  { name: "asphalt", hex: "#2b2b2b" },
  { name: "cup white", hex: "#f6f3ee" },
];

/** The product names an instruction lists ("- name: note" lines after a PRODUCTS heading). */
function productsIn(instruction: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const raw of instruction.split("\n")) {
    const line = raw.trim();
    if (/^PRODUCTS?\b/i.test(line) || /PRODUCTS AVAILABLE AS PHOTOS/i.test(line) || /^THE PRODUCT PHOTOS OF THE MONTH/i.test(line)) inList = true;
    else if (inList && /^- /.test(line)) out.push(line.slice(2).split(/\s*(?::|\[)/)[0].trim());
    else if (inList && line && !/^- /.test(line)) inList = false;
  }
  return [...new Set(out.filter(Boolean))].slice(0, 20);
}

function countIn(instruction: string, fallback: number): number {
  const m = /(?:plan(?:ning)?|exactly|write the)\s+(\d{1,2})\s+(?:Instagram\s+)?posts/i.exec(instruction);
  const n = m ? Number(m[1]) : fallback;
  return Math.max(1, Math.min(30, n || fallback));
}

function demoPost(i: number, product: string, shots: number, tile?: number) {
  return {
    type: "product",
    title: `${tile ? `T${tile} · ` : ""}${product || "The product"} · ${DEMO} ${i}`,
    brief: `${DEMO}: the ${product || "product"} stands inside a Jordanian road sign under noon sun, blue sky behind the plate, a hard shadow to the left; the sign's own symbol stays readable around it and a calm band at the bottom is left for the headline.`,
    caption: `${DEMO}: جرّب ${product || "المنتج"} اليوم. مرّ علينا.`,
    hashtags: "#demo #sample #drinks",
    product: product || "",
    products: [],
    headline: product || "Sample headline",
    subline: "",
    shot: shots ? ((i - 1) % shots) + 1 : 0,
    people: [],
    date: "",
    occasion: "",
  };
}

function ideas(instruction: string, tiles = 0) {
  const products = productsIn(instruction);
  const count = countIn(instruction, 8);
  const shots = (instruction.match(/^\d+\. /gm) ?? []).length;
  return Array.from({ length: count }, (_, k) => demoPost(k + 1, products[k % Math.max(1, products.length)] ?? "", shots, tiles ? (k % tiles) + 1 : undefined));
}

function briefPlan(instruction: string) {
  const products = productsIn(instruction);
  const briefText = instruction.slice(instruction.search(/BRIEF/i));
  const singles = Math.max(1, Math.min(20, Number(/(\d{1,2})\s+posts/i.exec(briefText)?.[1] ?? 6)));
  const slides = Number(/(\d)[- ]slide/i.exec(briefText)?.[1] ?? 0);
  const hexes = [...new Set(briefText.match(/#[0-9a-fA-F]{6}/g) ?? [])].slice(0, 6);
  const colours = hexes.length ? hexes.map((hex, i) => ({ name: `colour ${i + 1}`, hex })) : COLOURS.slice(0, 3);
  const posts: Record<string, unknown>[] = [];
  const one = (i: number, extra: Record<string, unknown>) => {
    const p = demoPost(i, products[(i - 1) % Math.max(1, products.length)] ?? "", 0);
    posts.push({ type: p.type, group: "single", slide: 1, of: 1, role: "", title: p.title, headline: p.headline, subline: "", brief: p.brief, product: p.product, products: [], ingredients: "", exact: false, reference: 0, caption: p.caption, hashtags: p.hashtags, ...extra });
  };
  for (let i = 1; i <= singles; i++) one(i, {});
  for (let s = 1; s <= slides; s++) one(singles + s, { group: "carousel", slide: s, of: slides, role: s === 1 ? "cover" : s === slides ? "closing" : "" });
  return { summary: `${DEMO}: planned ${singles} post${singles === 1 ? "" : "s"}${slides ? ` and a ${slides}-slide carousel` : ""} from the brief; colours read from the brief.`, colours, posts };
}

function gridRead(instruction: string) {
  const kinds = ["product", "drink", "text", "product", "detail", "drink", "product", "texture", "drink"];
  const tiles = kinds.map((kind, i) => ({
    position: `row ${Math.floor(i / 3) + 1}, col ${(i % 3) + 1}`,
    scene: `${DEMO}: a cup set into a road sign, noon sun, blue sky`,
    productPlacement: "centred in the sign plate",
    textPlacement: "a calm band at the bottom",
    kind,
    items: "road sign, kerb, cup",
    background: kind === "text" ? "sky blue #0a7bd6" : "blue sky",
    text: { position: kind === "text" ? "center" : "bottom", align: "left", size: kind === "text" ? "huge" : "medium", color: "#ffffff", style: "bold sans" },
  }));
  return { world: `${DEMO} world: street signs under noon sun, hard shadows, blue sky, the brand's cup as the sign's symbol, sky blue and sign yellow with asphalt grey.`, tiles, fonts: { headline: "", body: "", why: `${DEMO}: no font chosen.` }, posts: ideas(instruction, tiles.length) };
}

/**
 * Products matched to posts: each post gets the options whose names share a word with its words
 * (its product first), so the preview's "Choose for me" walks through with a readable pick.
 */
function productMatches(instruction: string) {
  const posts = [...instruction.matchAll(/^Post (\d+) \[[^\]]*\](.*)$/gm)].map((m) => ({ post: Number(m[1]), text: m[2].toLowerCase() }));
  const options = [...instruction.matchAll(/^(\d+)\. (.+?) \((this month|an earlier month|the client's Drive)\)/gm)].map((m) => ({ option: Number(m[1]), name: m[2].toLowerCase() }));
  const words = (t: string) => new Set(t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  const matches = posts.map(({ post, text }) => {
    const named = /product now: (.+)$/.exec(text)?.[1]?.trim();
    const pw = words(text);
    const picks = options
      .map((o) => ({ o, hits: named && named === o.name ? 99 : [...words(o.name)].filter((w) => pw.has(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3)
      .map((x) => ({ option: x.o.option, reason: `${DEMO}: its name is in the post's words.`, same: !!named && named === x.o.name }));
    return { post, picks };
  });
  return { matches };
}

function generic(schema: Schema, name = ""): unknown {
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, generic(v, k)]));
    case "array":
      return [];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return ["ok", "readable", "same"].includes(name);
    default:
      return name === "hex" ? "#0a7bd6" : `${DEMO} ${name}`.trim();
  }
}

/** The fixture answer for one call, as the JSON text a provider would return. */
export function demoAnswer(instruction: string, schema: unknown, images = 0): string {
  const s = (schema ?? {}) as Schema;
  const props = s.properties ?? {};
  let out: unknown;
  if (props.known && props.request && props.steps) {
    // The Help assistant: a fixed answer that says it is the preview's.
    out = { answer: `${DEMO}: the preview answers without a text model. On the live studio the Help assistant answers from the studio's guide.`, steps: ["Open the post's card", 'Press "Edit picture"'], known: !/\bnot exist|missing feature|doesn.t exist\b/i.test(instruction.split("The member's question:").pop() ?? ""), request: "" };
    if (!(out as { known: boolean }).known) (out as { request: string }).request = `${DEMO}: a request for Firas.`;
  } else if (isSuggestSchema(props)) {
    // Campaign Autopilot, "Suggest a campaign": three labelled suggestions from the listed products.
    out = demoSuggestions(instruction);
  } else if (isRetargetSchema(props)) {
    // Campaign Autopilot, a new product on an item: the old name swapped for the new one.
    out = demoRetarget(instruction);
  } else if (isCampaignSchema(props)) {
    // Campaign Autopilot: a whole plan for the counts asked, every line labelled as the preview's.
    out = demoCampaignAnswer(instruction);
  } else if (props.actions && (props.actions.items?.properties ?? {}).kind) {
    // Client feedback: the same deterministic reading the rules give, so the preview answers consistently.
    const fb = feedbackFromInstruction(instruction);
    const actions = fb ? interpretFeedback(fb.text, fb.context) : [];
    out = { actions: actions.map((a) => ({ ...a, change: `${DEMO}: ${a.change}` })) };
  } else if (props.tool && props.q && props.model) {
    // The Prompt Box: the fixture answers with the deterministic resolver's own reading of the sentence.
    const req = intentRequestFrom(instruction);
    const i = req ? resolveIntent(req.message, req.ctx) : null;
    out = i ? { tool: i.tool, post: i.target.post ?? 0, slide: i.target.slide ?? 0, q: String(i.settings.q ?? ""), assetType: String(i.settings.type ?? ""), orientation: String(i.settings.orientation ?? ""), role: String(i.settings.role ?? ""), model: String(i.settings.model ?? ""), duration: Number(i.settings.duration ?? 0), aspect: String(i.settings.aspect ?? ""), operation: String(i.settings.operation ?? ""), question: i.questions[0] ?? "" } : { tool: "none", post: 0, slide: 0, q: "", assetType: "", orientation: "", role: "", model: "", duration: 0, aspect: "", operation: "", question: "" };
  } else if (props.posts && (props.posts.items?.properties ?? {}).lesson) {
    // "Do client comments": each asked post comes back with its brief marked and the client's words in the summary.
    const asks = [...instruction.matchAll(/^Post (\d+) "[^"]*"[\s\S]*?THE CLIENT ASKS: "([^"]*)"/gm)];
    out = { posts: asks.map((m) => ({ index: Number(m[1]), product: "", brief: `${DEMO}: the post's shot, changed as the client asked.`, scene: "", headline: "", caption: `${DEMO}: كما طلب العميل.`, hashtags: "#demo", summary: `${DEMO}: applied "${m[2].slice(0, 120)}".`, lesson: "", steps: /carousel|كاروسيل|كروسيل|سلايد/i.test(m[2]) ? [{ tool: "rewrite", what: "The caption for a carousel." }, { tool: "carousel-camera", what: "Four slides: from above, closer, from the left, wider." }] : [{ tool: "rewrite", what: "The shot and the words as the client asked." }, { tool: "remake", what: "A new picture from the new shot." }] })) };
  } else if (props.posts && props.tiles) out = gridRead(instruction);
  else if (props.tiles && props.world) {
    // The grid read on its own, for the preview: the same tiles, no posts.
    const { world, tiles, fonts } = gridRead(instruction);
    out = { world, tiles, fonts };
  }
  else if (props.posts && (props.posts.items?.properties ?? {}).group) out = briefPlan(instruction);
  else if (props.posts) out = { posts: ideas(instruction) };
  else if (props.shots && props.direction)
    out = { description: `${DEMO}: street signs under noon sun.`, direction: `${DEMO}: every drink stands inside a road sign; the cup is the sign's symbol.`, library: `${DEMO}: blue sky, hard shadows, 35 mm at eye level, the sign plate filling the upper two thirds.`, shots: [`${DEMO} shot 1: the cup inside a round sign, eye level, noon sun.`, `${DEMO} shot 2: the cup in a warning triangle, low angle, hard shadow.`, `${DEMO} shot 3: the cup at the shop door's sign, straight on.`], palette: COLOURS.slice(0, 3) };
  else if (props.shots) {
    const posts = [...new Set((instruction.match(/Post (\d+)/g) ?? []).map((m) => Number(m.slice(5))))];
    out = { shots: (posts.length ? posts : [1]).map((post) => ({ post, ref: 1, shot: `${DEMO} shot for post ${post}: the cup inside the sign plate, eye level, 35 mm, noon sun, hard shadow to the left, nothing else on the pole.` })) };
  } else if (props.summary && props.points) out = { summary: `${DEMO}: this screen was read without a provider.`, points: [`${DEMO}: the inputs on this screen were read.`, "Nothing here cost a provider call.", `Images seen: ${images}.`], logic: `${DEMO}: plan the month from what this screen shows.`, categories: [] };
  else if (props.matches) out = productMatches(instruction);
  else if (props.palette) out = { palette: COLOURS };
  else if (props.prompt && props.brief) out = { prompt: `${DEMO} prompt: the product in the style's staging, the brand's colours, no text in the picture.`, brief: `${DEMO}: the product set in the style's scene, lit as the style is lit, with the brand's colours on the surfaces.` };
  else if (props.note && Object.keys(props).length === 1) out = { note: `${DEMO}: the product as its photo shows it, whole and undistorted.` };
  else if (props.caption && props.hashtags) out = { caption: `${DEMO}: جرّب المنتج اليوم.`, hashtags: "#demo #sample" };
  else if (props.ok && props.problems) out = { ok: true, problems: [], scene: "", dropReference: false, note: `${DEMO}: nothing to take out.` };
  else out = generic(s);
  return JSON.stringify(out);
}
