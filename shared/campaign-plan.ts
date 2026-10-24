/**
 * Campaign Autopilot (docs/campaign-autopilot.md): the plan of a whole campaign (image posts and
 * multishot videos), what producing it takes, what that costs per provider, the cap the admin
 * approves and what an edit after approval changes. Pure: nothing here reads storage or calls a
 * provider; the server hands in the prices it learned (`PriceBook`).
 *
 * Three rules the numbers keep:
 * - A multishot video is not one generation: each shot that is generated is a clip, each shot that
 *   needs its own starting image is a picture first, and the Reel itself is assembled and rendered.
 * - Units are never added together: dollars, Higgsfield credits and Magnific credits stay apart.
 * - An unknown price is said, never guessed; the cap is the estimate times (1 + retries).
 */
import type { Format } from "./posts";
import type { FrameId } from "./video-frame";

/* ───────────── Setup ───────────── */

export type CampaignLanguage = "ar" | "en" | "both";

/** A product of the client: from the month's product photos (`library`) or the client's Drive (`drive`). */
export interface ProductPick {
  /** The source id (library) or the Drive file id (drive). */
  id: string;
  name: string;
  from: "library" | "drive";
  /** A thumbnail URL the studio serves (never a guessed picture). */
  thumb: string | null;
  note?: string;
}

/** Material shown with a plan item, always labelled for what it is. */
export interface PlanRef {
  /** reference: inspiration, not the expected result; asset: the client's own picture or clip used as it is; preview: something generated before (paid earlier). */
  kind: "reference" | "asset" | "preview";
  id: string;
  label: string;
  thumb: string | null;
  /** Where it comes from, in words ("the client's Drive", "Styles library", "a reference you added"). */
  from: string;
  /** For an asset: a picture or a clip. */
  media?: "photo" | "clip";
  /**
   * What an inspiration reference is for: its palette and light (`colour`) or its framing and
   * perspective (`composition`). Never the product: the product comes from its own photo.
   */
  role?: "colour" | "composition";
}

export interface CampaignSetup {
  objective: string;
  audience: string;
  offer: string;
  message: string;
  imagePosts: number;
  videos: number;
  platforms: string[];
  imageFormat: Format;
  videoFrame: FrameId;
  /** The finished video's length, seconds. */
  videoSeconds: number;
  /** Shots per video the planner aims for. */
  shotsPerVideo: number;
  periodStart: string;
  periodEnd: string;
  language: CampaignLanguage;
  /** Products picked by hand; `suggest` lets the planner choose among the client's products (shown for review). */
  products: ProductPick[];
  productMode: "manual" | "suggest";
  direction: { prompt: string; references: PlanRef[]; styleId: string | null };
}

export const SETUP_LIMITS = { imagePosts: 12, videos: 8, shotsPerVideo: 8, videoSeconds: 60 } as const;

export function defaultSetup(): CampaignSetup {
  return {
    objective: "",
    audience: "",
    offer: "",
    message: "",
    imagePosts: 3,
    videos: 4,
    platforms: ["instagram"],
    imageFormat: "4:5",
    videoFrame: "9:16",
    videoSeconds: 15,
    shotsPerVideo: 4,
    periodStart: "",
    periodEnd: "",
    language: "both",
    products: [],
    productMode: "suggest",
    direction: { prompt: "", references: [], styleId: null },
  };
}

const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
};
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function normalizeSetup(s: Partial<CampaignSetup> | null | undefined): CampaignSetup {
  const d = defaultSetup();
  const x = s ?? {};
  return {
    objective: str(x.objective, 600),
    audience: str(x.audience, 600),
    offer: str(x.offer, 600),
    message: str(x.message, 600),
    imagePosts: clamp(x.imagePosts, 0, SETUP_LIMITS.imagePosts, d.imagePosts),
    videos: clamp(x.videos, 0, SETUP_LIMITS.videos, d.videos),
    platforms: Array.isArray(x.platforms) ? x.platforms.map((p) => str(p, 40)).filter(Boolean).slice(0, 6) : d.platforms,
    imageFormat: x.imageFormat === "1:1" || x.imageFormat === "9:16" ? x.imageFormat : "4:5",
    videoFrame: x.videoFrame === "4:5" || x.videoFrame === "1:1" || x.videoFrame === "16:9" ? x.videoFrame : "9:16",
    videoSeconds: clamp(x.videoSeconds, 5, SETUP_LIMITS.videoSeconds, d.videoSeconds),
    shotsPerVideo: clamp(x.shotsPerVideo, 1, SETUP_LIMITS.shotsPerVideo, d.shotsPerVideo),
    periodStart: str(x.periodStart, 10),
    periodEnd: str(x.periodEnd, 10),
    language: x.language === "ar" || x.language === "en" ? x.language : "both",
    products: Array.isArray(x.products) ? x.products.filter((p) => p && typeof p.id === "string" && typeof p.name === "string").slice(0, 20) : [],
    productMode: x.productMode === "manual" ? "manual" : "suggest",
    direction: {
      prompt: str(x.direction?.prompt, 3000),
      references: Array.isArray(x.direction?.references) ? x.direction!.references.slice(0, 12) : [],
      styleId: typeof x.direction?.styleId === "string" && x.direction.styleId ? x.direction.styleId : null,
    },
  };
}

/* ───────────── The plan ───────────── */

/** The image engine of the month (the post pipeline) or a picture tool. */
export interface ImageEngine {
  /** `engine`: an image engine (dollars, list price); for a shot, a new picture from the key frame and the shot's own words. `mg-camera`: Magnific "Change camera" (Magnific credits), the key frame seen from another angle. */
  kind: "engine" | "mg-camera";
  model: string;
}

/** A clip engine: Higgsfield on the subscription credits (`higgsfield-mcp`) or on the Cloud API (`higgsfield`, dollars). */
export interface ClipEngine {
  provider: "higgsfield-mcp" | "higgsfield";
  model: string;
  name: string;
}

export interface ImagePlanItem {
  key: string;
  selected: boolean;
  idea: string;
  objective: string;
  product: ProductPick | null;
  visual: string;
  reference: PlanRef | null;
  headline: string;
  caption: string;
  cta: string;
  engine: ImageEngine;
  /** Finished pictures this post needs (a single post: 1). */
  outputs: number;
}

/**
 * How a shot gets its picture:
 * - `existing`: the client's own clip or photo is used as it is (no cost);
 * - `animate`: a clip is generated from an existing picture (`asset`) or, without one, from the
 *   video's key frame (one clip);
 * - `start-image`: a starting image is made for this shot first (the key frame for the first such
 *   shot, "Change camera" from the key frame for the others), then the clip (one picture + one clip).
 */
export type ShotSource = "existing" | "animate" | "start-image";

export interface ShotPlan {
  key: string;
  seconds: number;
  action: string;
  framing: string;
  camera: string;
  reference: PlanRef | null;
  source: ShotSource;
  /** The client's picture or clip for `existing` and `animate` shots. */
  asset: PlanRef | null;
  /** On-screen words during this shot ("" for none). */
  text: string;
  /** Camera height and angle ("eye level", "low, from hip height", "over Omar's shoulder"). */
  angle?: string;
  /** Lens look, distance and depth of field ("50 mm look, 1.5 m away, f/4: background readable"). */
  lens?: string;
  /** Subject placement and foreground/background ("cup on the right third, car door soft in the foreground"). */
  placement?: string;
  /** Normal speed unless slow motion serves the idea. */
  speed?: "normal" | "slow";
}

/**
 * A Reel's one photographic direction: every shot is a different camera setup in the same scene,
 * filmed the same day with the same light and grade (the cinematographer's decisions, in words).
 */
export interface ReelDirection {
  /** The film look in one or two sentences: camera feel, finish, what it must not look like. */
  look: string;
  /** The light: motivated source, direction, softness, contrast, colour temperature. */
  lighting: string;
  /** The grade: palette, highlight and shadow treatment, saturation, contrast; skin and product true. */
  colour: string;
  /** The lens family and perspective rules for the whole Reel. */
  lens: string;
  /** People, wardrobe and props that stay the same in every shot. */
  wardrobe: string;
  /** The place, time of day and screen direction kept across the cuts. */
  place: string;
}

export interface VideoPlanItem {
  key: string;
  selected: boolean;
  concept: string;
  hook: string;
  product: ProductPick | null;
  seconds: number;
  frame: FrameId;
  shots: ShotPlan[];
  voiceover: string;
  music: { direction: string; trackId: string | null; trackTitle: string | null };
  transitions: "cuts" | "crossfades" | "mixed";
  /** A look from the editor's looks (shared/video-looks.ts), "" for none. */
  look: string;
  cta: string;
  caption: string;
  keyFrameEngine: ImageEngine;
  frameEngine: ImageEngine;
  clipEngine: ClipEngine;
  /** The Reel's shared photographic direction (plans written before it have none). */
  direction?: ReelDirection;
}

export interface CampaignPlan {
  rev: number;
  summary: { concept: string; mix: string; together: string };
  images: ImagePlanItem[];
  videos: VideoPlanItem[];
  /** Operations already paid or billable while planning (text calls, estimates), said apart from production. */
  planningNotes: string[];
}

export const SHOT_SECONDS = { min: 1, max: 15 } as const;

/* ───────────── Steps ───────────── */

/** `review`: the admin looks at a Reel's starting pictures and approves them before any of its clips is made (free; it waits for the admin). */
export type StepKind = "post" | "image" | "frame" | "review" | "clip" | "assemble" | "render";

/** What a priced step costs in: the image engines in dollars, Magnific and Higgsfield in their credits, Higgsfield Cloud in dollars. */
export type CostUnit = "usd" | "higgsfield-credits" | "magnific-credits";

export const UNIT_LABEL: Record<CostUnit, string> = { usd: "US dollars (image engine and Higgsfield Cloud list prices)", "higgsfield-credits": "Higgsfield credits (subscription)", "magnific-credits": "Magnific credits" };

export interface StepSpec {
  /** Unique within the plan: `<item>:<shot or ->:<kind>`. */
  id: string;
  item: string;
  shot: string | null;
  kind: StepKind;
  deps: string[];
  /** The price-book key of a paid step; null for free steps. */
  priceKey: string | null;
  unit: CostUnit | null;
  label: string;
}

export const stepId = (item: string, shot: string | null, kind: StepKind) => `${item}:${shot ?? "-"}:${kind}`;

/** The image engines that make a shot's own starting picture from the key frame (Google's, which take reference pictures). */
export const isFrameModel = (model: string | undefined): model is string => typeof model === "string" && /^gemini-/.test(model);

export const imagePriceKey = (e: ImageEngine) => (e.kind === "engine" ? `image:${e.model}` : `tool:${e.kind}`);
export const clipPriceKey = (e: ClipEngine, seconds: number, frame: FrameId) => `clip:${e.provider}:${e.model}:${seconds}:${frame}`;
export const imageUnit = (e: ImageEngine): CostUnit => (e.kind === "engine" ? "usd" : "magnific-credits");
export const clipUnit = (e: ClipEngine): CostUnit => (e.provider === "higgsfield-mcp" ? "higgsfield-credits" : "usd");

/** The video engines make whole seconds within their range: a shot's clip is asked at the nearest length they offer (the cut trims it). */
export function clipSeconds(shotSeconds: number, offered: number[] = [5, 10]): number {
  const want = Math.max(1, Math.ceil(shotSeconds));
  const fit = [...offered].sort((a, b) => a - b).find((s) => s >= want);
  return fit ?? Math.max(...offered);
}

/** Does the video need its key frame made (a start-image shot, or animate shots without their own picture)? */
export function needsKeyFrame(v: VideoPlanItem): boolean {
  return v.shots.some((s) => s.source === "start-image" || (s.source === "animate" && !s.asset));
}

/** Every step the selected items need, in an order that respects their dependencies. */
export function planSteps(plan: CampaignPlan, selected?: Set<string>, clipLengths?: (e: ClipEngine) => number[]): StepSpec[] {
  const on = (key: string, sel: boolean) => (selected ? selected.has(key) : sel);
  const out: StepSpec[] = [];
  for (const it of plan.images) {
    if (!on(it.key, it.selected)) continue;
    const post = stepId(it.key, null, "post");
    out.push({ id: post, item: it.key, shot: null, kind: "post", deps: [], priceKey: null, unit: null, label: "The post's card" });
    for (let n = 0; n < Math.max(1, it.outputs); n++)
      out.push({ id: n ? `${stepId(it.key, null, "image")}#${n + 1}` : stepId(it.key, null, "image"), item: it.key, shot: null, kind: "image", deps: [post], priceKey: imagePriceKey(it.engine), unit: imageUnit(it.engine), label: "The picture (image engine)" });
  }
  for (const v of plan.videos) {
    if (!on(v.key, v.selected)) continue;
    const post = stepId(v.key, null, "post");
    out.push({ id: post, item: v.key, shot: null, kind: "post", deps: [], priceKey: null, unit: null, label: "The Reel's card" });
    const key = needsKeyFrame(v) ? stepId(v.key, null, "image") : null;
    if (key) out.push({ id: key, item: v.key, shot: null, kind: "image", deps: [post], priceKey: imagePriceKey(v.keyFrameEngine), unit: imageUnit(v.keyFrameEngine), label: "The key frame (the card's picture, image engine)" });
    const firstStart = v.shots.find((s) => s.source === "start-image")?.key ?? null;
    const shotSteps: string[] = [];
    // The starting pictures first (the key frame, then the other angles)…
    const starts = new Map<string, string>();
    for (const s of v.shots) {
      if (s.source === "existing") continue;
      if (s.source === "start-image") {
        if (s.key === firstStart) starts.set(s.key, key!);
        else {
          const frame = stepId(v.key, s.key, "frame");
          out.push({ id: frame, item: v.key, shot: s.key, kind: "frame", deps: [key!], priceKey: imagePriceKey(v.frameEngine), unit: imageUnit(v.frameEngine), label: v.frameEngine.kind === "engine" ? "The shot's starting picture (its own, made from the key frame)" : "The shot's starting image (the key frame from another angle)" });
          starts.set(s.key, frame);
        }
      } else starts.set(s.key, s.asset ? post : key!);
    }
    // …then the admin's look at them: no clip of this Reel is made before its pictures are approved.
    // Every clip of the Reel waits for it, a client's photo to animate included.
    const made = [...new Set([...starts.values()].filter((x) => x !== post))];
    const review = starts.size ? stepId(v.key, null, "review") : null;
    if (review) out.push({ id: review, item: v.key, shot: null, kind: "review", deps: made.length ? made : [post], priceKey: null, unit: null, label: "Your approval of the shots' starting pictures" });
    for (const s of v.shots) {
      const start = starts.get(s.key);
      if (!start) continue;
      const clip = stepId(v.key, s.key, "clip");
      const len = clipSeconds(s.seconds, clipLengths?.(v.clipEngine));
      out.push({ id: clip, item: v.key, shot: s.key, kind: "clip", deps: [review ?? start], priceKey: clipPriceKey(v.clipEngine, len, v.frame), unit: clipUnit(v.clipEngine), label: `The shot's clip (${v.clipEngine.name}, ${len} s)` });
      shotSteps.push(clip);
    }
    const assemble = stepId(v.key, null, "assemble");
    out.push({ id: assemble, item: v.key, shot: null, kind: "assemble", deps: [post, ...shotSteps], priceKey: null, unit: null, label: "Assemble the Reel (editable project)" });
    out.push({ id: stepId(v.key, null, "render"), item: v.key, shot: null, kind: "render", deps: [assemble], priceKey: null, unit: null, label: "Render the Reel onto its card (in the browser)" });
  }
  return out;
}

/* ───────────── Counts ───────────── */

export interface PlanCounts {
  imagePosts: number;
  videos: number;
  shots: number;
  generatedShots: number;
  existingShots: number;
  startImages: number;
  keyFrames: number;
  pictures: number;
  clips: number;
  assemblies: number;
  renders: number;
}

export function planCounts(plan: CampaignPlan, selected?: Set<string>): PlanCounts {
  const steps = planSteps(plan, selected);
  const on = (key: string, sel: boolean) => (selected ? selected.has(key) : sel);
  const videos = plan.videos.filter((v) => on(v.key, v.selected));
  const shots = videos.reduce((n, v) => n + v.shots.length, 0);
  const existing = videos.reduce((n, v) => n + v.shots.filter((s) => s.source === "existing").length, 0);
  const keyFrames = videos.filter(needsKeyFrame).length;
  const frames = steps.filter((s) => s.kind === "frame").length;
  return {
    imagePosts: plan.images.filter((i) => on(i.key, i.selected)).length,
    videos: videos.length,
    shots,
    generatedShots: shots - existing,
    existingShots: existing,
    startImages: frames + videos.filter((v) => v.shots.some((s) => s.source === "start-image")).length,
    keyFrames,
    pictures: steps.filter((s) => s.kind === "image" || s.kind === "frame").length,
    clips: steps.filter((s) => s.kind === "clip").length,
    assemblies: steps.filter((s) => s.kind === "assemble").length,
    renders: steps.filter((s) => s.kind === "render").length,
  };
}

/* ───────────── Costs ───────────── */

/** One price the server learned, and where from. */
export interface Price {
  amount: number | null;
  unit: CostUnit;
  /** catalog: the maintained price table; setting: the admin's price; provider: the provider's own estimate for this request; demo: a preview fixture (never a live price). */
  source: "catalog" | "setting" | "provider" | "demo" | null;
  note?: string;
}
export type PriceBook = Record<string, Price>;

export interface CostLine {
  step: string;
  item: string;
  shot: string | null;
  kind: StepKind;
  label: string;
  unit: CostUnit;
  amount: number | null;
  source: Price["source"];
}

export interface CostSummary {
  lines: CostLine[];
  /** Per unit: the estimate of the known steps, how many steps are unknown. */
  totals: Partial<Record<CostUnit, { estimate: number; steps: number; unknown: number }>>;
  /** The steps whose cost could not be established (flagged before approval). */
  unknown: CostLine[];
}

const round = (n: number, unit: CostUnit) => (unit === "usd" ? Math.round(n * 10000) / 10000 : Math.round(n * 100) / 100);

export function planCosts(steps: StepSpec[], prices: PriceBook): CostSummary {
  const lines: CostLine[] = [];
  const totals: CostSummary["totals"] = {};
  for (const s of steps) {
    if (!s.priceKey || !s.unit) continue;
    const p = prices[s.priceKey];
    const amount = p && p.unit === s.unit && typeof p.amount === "number" && Number.isFinite(p.amount) ? p.amount : null;
    lines.push({ step: s.id, item: s.item, shot: s.shot, kind: s.kind, label: s.label, unit: s.unit, amount, source: amount === null ? null : (p?.source ?? null) });
    const t = (totals[s.unit] ??= { estimate: 0, steps: 0, unknown: 0 });
    t.steps++;
    if (amount === null) t.unknown++;
    else t.estimate = round(t.estimate + amount, s.unit);
  }
  return { lines, totals, unknown: lines.filter((l) => l.amount === null) };
}

/** The most the approval lets each unit spend: the estimate with the retry allowance, said apart. */
export interface BudgetCap {
  unit: CostUnit;
  estimate: number;
  retries: number;
  retryAllowance: number;
  cap: number;
  /** Steps of this unit whose cost is unknown: they are not inside the cap unless an amount is entered for them. */
  unknown: number;
}

export function budgetCaps(costs: CostSummary, retries: number): BudgetCap[] {
  const r = Math.max(0, Math.min(3, Math.round(retries)));
  const order: CostUnit[] = ["usd", "higgsfield-credits", "magnific-credits"];
  return (Object.entries(costs.totals) as [CostUnit, { estimate: number; steps: number; unknown: number }][]).sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])).map(([unit, t]) => ({
    unit,
    estimate: t.estimate,
    retries: r,
    retryAllowance: round(t.estimate * r, unit),
    cap: round(t.estimate * (1 + r), unit),
    unknown: t.unknown,
  }));
}

/** What the cap does not cover, said before approval. */
export const OUTSIDE_THE_CAP: readonly string[] = [
  "Planning: the text calls that write and rewrite the plan, billed by the text provider (Google or OpenAI) at their text rates.",
  "Estimates: asking Higgsfield and Magnific what a step costs is free (get_cost / simulate_cost submit nothing).",
  "Music: tracks from the client's licensed library are used as they are; nothing is bought.",
  "The render: done in this browser, free.",
  "Copies from the client's Drive and reading references: free.",
];

/* ───────────── Approval and edits ───────────── */

/** A small stable hash (FNV-1a, 2 × 32 bits, hex): the same input always gives the same signature, here and in the browser. */
export function stableHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const refSig = (r: PlanRef | null) => (r ? `${r.kind}:${r.id}${r.role ? `:${r.role}` : ""}` : "");
const productSig = (p: ProductPick | null) => (p ? `${p.from}:${p.id}` : "");

/** What a paid step of the item depends on: changing any of it is a material change. */
export function itemProductionSignature(it: ImagePlanItem | VideoPlanItem): string {
  if ("shots" in it) {
    return stableHash(
      JSON.stringify([
        it.concept,
        productSig(it.product),
        it.frame,
        it.keyFrameEngine,
        it.frameEngine,
        it.clipEngine,
        it.shots.map((s) => [s.key, s.seconds, s.action, s.framing, s.camera, s.source, refSig(s.reference), refSig(s.asset)]),
      ]),
    );
  }
  return stableHash(JSON.stringify([it.idea, it.visual, productSig(it.product), refSig(it.reference), it.engine, it.outputs]));
}

/**
 * What one step's result depends on: a step whose signature changed since it was made is made
 * again (its earlier result stays a version); a step whose signature is unchanged keeps its result.
 * The assembly and the render follow everything in the video, its words included (both are free).
 */
export function stepSignature(plan: CampaignPlan, spec: Pick<StepSpec, "item" | "shot" | "kind">): string {
  const img = plan.images.find((i) => i.key === spec.item);
  if (img) return spec.kind === "post" ? itemWordsSignature(img) + itemProductionSignature(img) : itemProductionSignature(img);
  const v = plan.videos.find((x) => x.key === spec.item);
  if (!v) return "missing";
  // The cinematography counts only where it is written (plans from before it keep their signatures).
  const cine = (s: ShotPlan) => (s.angle || s.lens || s.placement || s.speed ? [[s.angle ?? "", s.lens ?? "", s.placement ?? "", s.speed ?? ""]] : []);
  const shotSig = (s: ShotPlan) => [s.key, s.seconds, s.action, s.framing, s.camera, s.source, refSig(s.reference), refSig(s.asset), ...cine(s)];
  const first = v.shots.find((s) => s.source === "start-image") ?? null;
  const keyFrame = stableHash(JSON.stringify([v.concept, productSig(v.product), v.frame, v.keyFrameEngine, first ? shotSig(first) : null, ...(v.direction ? [v.direction] : [])]));
  if (spec.kind === "post") return stableHash(JSON.stringify([v.concept, v.hook, v.caption, v.cta, productSig(v.product), v.frame]));
  if (spec.kind === "image") return keyFrame;
  const shot = v.shots.find((s) => s.key === spec.shot);
  if (spec.kind === "frame") return stableHash(JSON.stringify([keyFrame, v.frameEngine, shot ? shotSig(shot) : null]));
  if (spec.kind === "review") {
    // The pictures it approves: a change to the key frame or any angle asks for the look again.
    return stableHash(JSON.stringify([keyFrame, v.frameEngine, v.shots.filter((x) => x.source === "start-image").map(shotSig)]));
  }
  if (spec.kind === "clip") {
    const start = !shot ? "" : shot.source === "start-image" ? (shot.key === first?.key ? keyFrame : stableHash(JSON.stringify([keyFrame, v.frameEngine, shotSig(shot)]))) : shot.asset ? refSig(shot.asset) : keyFrame;
    return stableHash(JSON.stringify([start, v.clipEngine, shot ? shotSig(shot) : null]));
  }
  return stableHash(JSON.stringify([itemProductionSignature(v), itemWordsSignature(v)]));
}

/** The words of an item: changing them needs no new approval (they are drawn by the studio, free). */
export function itemWordsSignature(it: ImagePlanItem | VideoPlanItem): string {
  if ("shots" in it) return stableHash(JSON.stringify([it.hook, it.cta, it.caption, it.voiceover, it.music, it.transitions, it.look, it.shots.map((s) => s.text)]));
  return stableHash(JSON.stringify([it.headline, it.caption, it.cta, it.objective]));
}

export interface ApprovalTerms {
  rev: number;
  items: string[];
  retries: number;
  caps: BudgetCap[];
  /** Unknown-cost steps the admin accepted explicitly, with the amount they authorise for each. */
  acceptedUnknown: { step: string; unit: CostUnit; amount: number }[];
}

/** The signature an approval is tied to: the revision, the items, what each item's production depends on, and the caps. */
export function approvalSignature(plan: CampaignPlan, terms: ApprovalTerms): string {
  const items = [...terms.items].sort();
  const all = [...plan.images, ...plan.videos];
  const sigs = items.map((k) => {
    const it = all.find((x) => x.key === k);
    return it ? `${k}=${itemProductionSignature(it)}` : `${k}=missing`;
  });
  return stableHash(JSON.stringify([plan.rev, sigs, terms.retries, terms.caps.map((c) => [c.unit, c.cap]), terms.acceptedUnknown]));
}

/** The items whose production an edit changed (material: their unfinished work pauses) and those whose words changed (applied as they are). */
export function planChanges(before: CampaignPlan, after: CampaignPlan): { material: string[]; words: string[]; added: string[]; removed: string[] } {
  const a = new Map([...before.images, ...before.videos].map((x) => [x.key, x]));
  const b = new Map([...after.images, ...after.videos].map((x) => [x.key, x]));
  const material: string[] = [];
  const words: string[] = [];
  for (const [k, x] of b) {
    const y = a.get(k);
    if (!y) continue;
    if (itemProductionSignature(x) !== itemProductionSignature(y)) material.push(k);
    else if (itemWordsSignature(x) !== itemWordsSignature(y)) words.push(k);
  }
  return { material, words, added: [...b.keys()].filter((k) => !a.has(k)), removed: [...a.keys()].filter((k) => !b.has(k)) };
}

/* ───────────── Normalising a plan (what the planner wrote, or an edit) ───────────── */

const SOURCES: ShotSource[] = ["existing", "animate", "start-image"];

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A shot's cinematography, the fields written only (an empty one is left out). */
export function cinematography(s: Partial<ShotPlan> | null | undefined): Pick<ShotPlan, "angle" | "lens" | "placement" | "speed"> {
  const out: Pick<ShotPlan, "angle" | "lens" | "placement" | "speed"> = {};
  const angle = text(s?.angle, 160);
  const lens = text(s?.lens, 160);
  const placement = text(s?.placement, 240);
  if (angle) out.angle = angle;
  if (lens) out.lens = lens;
  if (placement) out.placement = placement;
  if (s?.speed === "slow" || s?.speed === "normal") out.speed = s.speed;
  return out;
}

/** A Reel's direction when any of it is written, else none. */
export function normalDirection(d: Partial<ReelDirection> | null | undefined): ReelDirection | null {
  if (!d || typeof d !== "object") return null;
  const out: ReelDirection = { look: text(d.look, 400), lighting: text(d.lighting, 400), colour: text(d.colour, 400), lens: text(d.lens, 300), wardrobe: text(d.wardrobe, 300), place: text(d.place, 300) };
  return Object.values(out).some(Boolean) ? out : null;
}

export function normalizePlan(p: Partial<CampaignPlan> | null | undefined, defaults: { imageEngine: ImageEngine; frameEngine: ImageEngine; clipEngine: ClipEngine; frame: FrameId; videoSeconds: number }, rev = 1): CampaignPlan {
  const x = (p ?? {}) as Partial<CampaignPlan>;
  const ref = (r: unknown): PlanRef | null => {
    const o = r as PlanRef | null;
    return o && typeof o.id === "string" && (o.kind === "reference" || o.kind === "asset" || o.kind === "preview") ? { kind: o.kind, id: o.id, label: str(o.label, 160) || o.id, thumb: typeof o.thumb === "string" ? o.thumb : null, from: str(o.from, 120), ...(o.media ? { media: o.media === "clip" ? "clip" : "photo" } : {}), ...(o.role === "colour" || o.role === "composition" ? { role: o.role } : {}) } : null;
  };
  const product = (q: unknown): ProductPick | null => {
    const o = q as ProductPick | null;
    return o && typeof o.id === "string" && typeof o.name === "string" ? { id: o.id, name: str(o.name, 160), from: o.from === "drive" ? "drive" : "library", thumb: typeof o.thumb === "string" ? o.thumb : null, ...(o.note ? { note: str(o.note, 400) } : {}) } : null;
  };
  const images = (Array.isArray(x.images) ? x.images : []).slice(0, SETUP_LIMITS.imagePosts).map((i, n): ImagePlanItem => ({
    key: typeof i?.key === "string" && /^img-\d+$/.test(i.key) ? i.key : `img-${n + 1}`,
    selected: i?.selected !== false,
    idea: str(i?.idea, 1200),
    objective: str(i?.objective, 300),
    product: product(i?.product),
    visual: str(i?.visual, 1500),
    reference: ref(i?.reference),
    headline: str(i?.headline, 120),
    caption: str(i?.caption, 600),
    cta: str(i?.cta, 120),
    engine: i?.engine?.kind === "engine" && typeof i.engine.model === "string" && i.engine.model ? { kind: "engine", model: i.engine.model } : defaults.imageEngine,
    outputs: clamp(i?.outputs, 1, 4, 1),
  }));
  const videos = (Array.isArray(x.videos) ? x.videos : []).slice(0, SETUP_LIMITS.videos).map((v, n): VideoPlanItem => {
    const shots = (Array.isArray(v?.shots) ? v.shots : []).slice(0, SETUP_LIMITS.shotsPerVideo).map((s, k): ShotPlan => {
      const source = SOURCES.includes(s?.source as ShotSource) ? (s!.source as ShotSource) : "start-image";
      const asset = ref(s?.asset);
      return {
        key: typeof s?.key === "string" && /^s\d+$/.test(s.key) ? s.key : `s${k + 1}`,
        seconds: Math.max(SHOT_SECONDS.min, Math.min(SHOT_SECONDS.max, Math.round(Number(s?.seconds) * 10) / 10 || 3)),
        action: str(s?.action, 600),
        framing: str(s?.framing, 120),
        camera: str(s?.camera, 120),
        reference: ref(s?.reference),
        // An existing shot without the client's media cannot be used as it is: it becomes a generated one.
        source: source === "existing" && (!asset || asset.kind !== "asset") ? "start-image" : source,
        asset: asset && asset.kind === "asset" ? asset : null,
        text: str(s?.text, 140),
        ...cinematography(s),
      };
    });
    // Shot keys unique and in order.
    const seen = new Set<string>();
    shots.forEach((s, k) => {
      if (seen.has(s.key)) s.key = `s${k + 1}`;
      seen.add(s.key);
    });
    const seconds = shots.reduce((t, s) => t + s.seconds, 0);
    return {
      key: typeof v?.key === "string" && /^vid-\d+$/.test(v.key) ? v.key : `vid-${n + 1}`,
      selected: v?.selected !== false,
      concept: str(v?.concept, 1200),
      hook: str(v?.hook, 200),
      product: product(v?.product),
      seconds: Math.round(seconds * 10) / 10 || defaults.videoSeconds,
      frame: v?.frame === "4:5" || v?.frame === "1:1" || v?.frame === "16:9" || v?.frame === "9:16" ? v.frame : defaults.frame,
      shots,
      voiceover: str(v?.voiceover, 1200),
      music: { direction: str(v?.music?.direction, 300), trackId: typeof v?.music?.trackId === "string" ? v.music.trackId : null, trackTitle: typeof v?.music?.trackTitle === "string" ? v.music.trackTitle : null },
      transitions: v?.transitions === "crossfades" || v?.transitions === "mixed" ? v.transitions : "cuts",
      look: str(v?.look, 60),
      cta: str(v?.cta, 120),
      caption: str(v?.caption, 600),
      keyFrameEngine: v?.keyFrameEngine?.kind === "engine" && v.keyFrameEngine.model ? { kind: "engine", model: v.keyFrameEngine.model } : defaults.imageEngine,
      frameEngine: v?.frameEngine?.kind === "mg-camera" ? { kind: "mg-camera", model: "images_change_camera" } : v?.frameEngine?.kind === "engine" && isFrameModel(v.frameEngine.model) ? { kind: "engine", model: v.frameEngine.model } : defaults.frameEngine,
      clipEngine: v?.clipEngine && (v.clipEngine.provider === "higgsfield-mcp" || v.clipEngine.provider === "higgsfield") && v.clipEngine.model ? { provider: v.clipEngine.provider, model: v.clipEngine.model, name: str(v.clipEngine.name, 80) || v.clipEngine.model } : defaults.clipEngine,
      ...(normalDirection(v?.direction) ? { direction: normalDirection(v?.direction)! } : {}),
    };
  });
  // Item keys unique.
  const keys = new Set<string>();
  for (const it of [...images, ...videos]) {
    let k = it.key;
    let n = 1;
    while (keys.has(k)) k = `${it.key.split("-")[0]}-${++n + 50}`;
    it.key = k;
    keys.add(k);
  }
  return {
    rev,
    summary: { concept: str(x.summary?.concept, 1500), mix: str(x.summary?.mix, 800), together: str(x.summary?.together, 1200) },
    images,
    videos,
    planningNotes: Array.isArray(x.planningNotes) ? x.planningNotes.map((n) => str(n, 300)).filter(Boolean).slice(0, 12) : [],
  };
}

/** Counted in words for the summary line: "3 image posts · 4 videos (16 shots: 12 generated clips, 4 existing) · 8 starting images". */
export function countsLine(c: PlanCounts): string {
  const parts = [`${c.imagePosts} image post${c.imagePosts === 1 ? "" : "s"}`, `${c.videos} video${c.videos === 1 ? "" : "s"} (${c.shots} shot${c.shots === 1 ? "" : "s"}: ${c.clips} generated clip${c.clips === 1 ? "" : "s"}${c.existingShots ? `, ${c.existingShots} from existing media` : ""})`, `${c.pictures} picture${c.pictures === 1 ? "" : "s"} to generate (${c.imagePosts ? `${c.imagePosts} post pictures, ` : ""}${c.keyFrames} key frames, ${c.pictures - c.keyFrames - c.imagePosts} shot starting images)`];
  return parts.join(" · ");
}
