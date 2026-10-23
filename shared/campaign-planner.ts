/**
 * Campaign Autopilot's planner (docs/campaign-autopilot.md): what the text model is told, the
 * answer it must give, and how that answer becomes a plan. The model never names a product, a
 * reference or a client file by itself: it picks from numbered lists (P1, R1, M1) the server
 * built from the client's real products, the references the admin added and the client's Drive,
 * and anything it names outside those lists is dropped. Engines are not the model's to choose.
 * Pure; the preview's fixture answer (`demoCampaignAnswer`) lives here too.
 */
import { normalizePlan, type VideoPlanItem, type CampaignPlan, type CampaignSetup, type ClipEngine, type ImageEngine, type PlanRef, type ProductPick, type ShotSource } from "./campaign-plan";
import type { FrameId } from "./video-frame";

/** A product the planner may pick, with its list id (P1…). */
export interface PlannerProduct extends ProductPick {
  listId: string;
}
/** A client file (Drive photo or clip) the planner may use as it is, with its list id (M1…). */
export interface PlannerMedia extends PlanRef {
  listId: string;
}
/** A reference the admin gave (inspiration), with its list id (R1…). */
export interface PlannerReference extends PlanRef {
  listId: string;
}

export interface PlannerBrand {
  name: string;
  tone: string;
  audience: string;
  language: string;
  dos: string;
  donts: string;
  style: string;
}

export interface PlannerInput {
  setup: CampaignSetup;
  brand: PlannerBrand;
  products: PlannerProduct[];
  media: PlannerMedia[];
  references: PlannerReference[];
  /** The editor's looks the planner may name ("" for none). */
  looks: string[];
  month: string;
}

export const CAMPAIGN_PLAN_SCHEMA = {
  type: "object",
  properties: {
    campaign: { type: "string" },
    summary: { type: "object", properties: { concept: { type: "string" }, mix: { type: "string" }, together: { type: "string" } }, required: ["concept", "mix", "together"] },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          idea: { type: "string" },
          objective: { type: "string" },
          product: { type: "string" },
          visual: { type: "string" },
          reference: { type: "string" },
          headline: { type: "string" },
          caption: { type: "string" },
          cta: { type: "string" },
        },
        required: ["idea", "objective", "product", "visual", "reference", "headline", "caption", "cta"],
      },
    },
    videos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concept: { type: "string" },
          hook: { type: "string" },
          product: { type: "string" },
          shots: {
            type: "array",
            items: {
              type: "object",
              properties: {
                seconds: { type: "number" },
                action: { type: "string" },
                framing: { type: "string" },
                camera: { type: "string" },
                reference: { type: "string" },
                source: { type: "string", enum: ["start-image", "animate", "existing"] },
                asset: { type: "string" },
                text: { type: "string" },
              },
              required: ["seconds", "action", "framing", "camera", "reference", "source", "asset", "text"],
            },
          },
          voiceover: { type: "string" },
          music: { type: "string" },
          transitions: { type: "string", enum: ["cuts", "crossfades", "mixed"] },
          look: { type: "string" },
          cta: { type: "string" },
          caption: { type: "string" },
        },
        required: ["concept", "hook", "product", "shots", "voiceover", "music", "transitions", "look", "cta", "caption"],
      },
    },
  },
  required: ["campaign", "summary", "images", "videos"],
} as const;

const LANGUAGE_WORDS: Record<CampaignSetup["language"], string> = {
  ar: "Arabic (every headline, caption, call to action, on-screen text and voiceover in Arabic)",
  en: "English",
  both: "both: headlines and on-screen text in the language that reads best for the audience, captions in Arabic then English",
};

/** The planner's instruction: the brief, the brand, and the only products, references and client files it may use. */
export function campaignInstruction(x: PlannerInput): string {
  const s = x.setup;
  const lines = [
    "You plan a social media campaign for a brand. Plan the whole campaign: image posts and short multishot videos (Reels). You write ideas and storyboards only; nothing is produced from your answer until a person reviews and approves it.",
    `CAMPAIGN SETUP: IMAGE POSTS: ${s.imagePosts}. VIDEOS: ${s.videos}. SHOTS PER VIDEO: ${s.shotsPerVideo}. VIDEO LENGTH: ${s.videoSeconds} seconds. VIDEO FRAME: ${s.videoFrame}. IMAGE FORMAT: ${s.imageFormat}. PLATFORMS: ${s.platforms.join(", ") || "instagram"}. PERIOD: ${s.periodStart || x.month} to ${s.periodEnd || x.month}.`,
    `OBJECTIVE: ${s.objective || "(not given: infer a sensible one from the brand)"}`,
    `AUDIENCE: ${s.audience || x.brand.audience || "(the brand's usual audience)"}`,
    `OFFER: ${s.offer || "(none)"}`,
    `KEY MESSAGE: ${s.message || "(not given)"}`,
    `CREATIVE DIRECTION: ${s.direction.prompt || "(none: follow the brand)"}`,
    `LANGUAGE: ${LANGUAGE_WORDS[s.language]}.`,
    `THE BRAND: ${x.brand.name}. Tone: ${x.brand.tone || "-"}. Style: ${x.brand.style || "-"}. Always: ${x.brand.dos || "-"}. Never: ${x.brand.donts || "-"}.`,
    "",
    `PRODUCTS you may use (by id; never invent a product, never describe one differently from its note):${x.products.length ? "" : " none: the posts are about the brand, with no product in them."}`,
    ...x.products.map((p) => `${p.listId}: ${p.name}${p.note ? ` — ${p.note}` : ""}`),
    s.productMode === "manual" && x.products.length ? "Use only these products, spread over the posts and videos." : "Pick the products that fit the objective; each post or video names at most one product id.",
    "",
    `REFERENCES (inspiration only, never the expected result; name one by id where it guides a post or a shot):${x.references.length ? "" : " none."}`,
    ...x.references.map((r) => `${r.listId}: ${r.label}${r.from ? ` (${r.from})` : ""}`),
    "",
    `CLIENT MEDIA (the client's own photos and clips; a shot can use one as it is with source "existing", or animate a photo with source "animate"):${x.media.length ? "" : " none."}`,
    ...x.media.map((m) => `${m.listId}: ${m.media === "clip" ? "clip" : "photo"} — ${m.label}`),
    "",
    "RULES:",
    `- Exactly ${s.imagePosts} image posts and exactly ${s.videos} videos.`,
    `- Each video has ${s.shotsPerVideo} shots whose seconds add up to about ${s.videoSeconds}; shots are 1 to 15 seconds. The first shot is the hook.`,
    '- A shot\'s source: "start-image" (a new picture is made for it, then animated: the usual choice, it keeps the product and the scene consistent), "animate" (a client photo from CLIENT MEDIA is animated: give its id as asset), "existing" (a client clip or photo is used as it is: give its id as asset). Only ids from CLIENT MEDIA go in asset; otherwise asset is "".',
    "- action: what happens in the shot, concretely (subject, product, movement). framing: wide, medium, close-up or macro. camera: the camera move (static, slow push in, orbit left, pan right, tilt up, handheld follow) or the angle (low, top, left, right).",
    "- In every shot of a video the product, the place and the people stay the same, so the shots cut together.",
    "- text: the few words on screen during the shot (\"\" for none). headline: 2 to 5 words. caption: one or two short sentences. cta: a short call to action.",
    `- look: one of ${x.looks.length ? x.looks.join(", ") : "(none)"} or "". music: the mood and tempo in a few words. transitions: cuts, crossfades or mixed.`,
    '- product and reference fields hold a list id (P1, R2) or "".',
    '- campaign: "plan". summary.concept: the campaign idea in two sentences. summary.mix: why this mix of posts and videos. summary.together: how the pieces work together over the period.',
  ];
  return lines.join("\n");
}

interface RawShot {
  seconds?: number;
  action?: string;
  framing?: string;
  camera?: string;
  reference?: string;
  source?: string;
  asset?: string;
  text?: string;
}
interface RawAnswer {
  summary?: { concept?: string; mix?: string; together?: string };
  images?: { idea?: string; objective?: string; product?: string; visual?: string; reference?: string; headline?: string; caption?: string; cta?: string }[];
  videos?: { concept?: string; hook?: string; product?: string; shots?: RawShot[]; voiceover?: string; music?: string; transitions?: string; look?: string; cta?: string; caption?: string }[];
}

export interface PlanDefaults {
  imageEngine: ImageEngine;
  frameEngine: ImageEngine;
  clipEngine: ClipEngine;
  frame: FrameId;
  videoSeconds: number;
}

const strip = <T extends { listId: string }>(x: T): Omit<T, "listId"> => {
  const { listId: _id, ...rest } = x;
  void _id;
  return rest;
};

/** The model's answer as a plan: ids resolved against the lists; anything outside them dropped, and said so. */
export function planFromAnswer(raw: unknown, x: PlannerInput, defaults: PlanDefaults, rev = 1): CampaignPlan {
  const a = (raw ?? {}) as RawAnswer;
  const notes: string[] = [];
  const product = (id: string | undefined): ProductPick | null => {
    if (!id) return null;
    const p = x.products.find((q) => q.listId === id.trim());
    if (!p) {
      notes.push(`The planner named a product that is not the client's (${id.slice(0, 20)}); it was left out.`);
      return null;
    }
    return strip(p);
  };
  const reference = (id: string | undefined): PlanRef | null => {
    if (!id) return null;
    const r = x.references.find((q) => q.listId === id.trim());
    return r ? strip(r) : null;
  };
  const asset = (id: string | undefined): PlanRef | null => {
    if (!id) return null;
    const m = x.media.find((q) => q.listId === id.trim());
    return m ? strip(m) : null;
  };
  const images = (a.images ?? []).slice(0, x.setup.imagePosts).map((i, n) => ({
    key: `img-${n + 1}`,
    selected: true,
    idea: i.idea ?? "",
    objective: i.objective ?? "",
    product: product(i.product),
    visual: i.visual ?? "",
    reference: reference(i.reference),
    headline: i.headline ?? "",
    caption: i.caption ?? "",
    cta: i.cta ?? "",
    engine: defaults.imageEngine,
    outputs: 1,
  }));
  const videos = (a.videos ?? []).slice(0, x.setup.videos).map((v, n) => ({
    key: `vid-${n + 1}`,
    selected: true,
    concept: v.concept ?? "",
    hook: v.hook ?? "",
    product: product(v.product),
    seconds: 0,
    frame: x.setup.videoFrame,
    shots: (v.shots ?? []).slice(0, x.setup.shotsPerVideo).map((s, k) => {
      const media = asset(s.asset);
      let source = (["start-image", "animate", "existing"].includes(s.source ?? "") ? s.source : "start-image") as ShotSource;
      // Animating needs a photo; a clip asked to be animated is used as it is.
      if (source === "animate" && media?.media === "clip") source = "existing";
      return { key: `s${k + 1}`, seconds: Number(s.seconds) || 3, action: s.action ?? "", framing: s.framing ?? "", camera: s.camera ?? "", reference: reference(s.reference), source, asset: source === "start-image" ? null : media, text: s.text ?? "" };
    }),
    voiceover: v.voiceover ?? "",
    music: { direction: v.music ?? "", trackId: null, trackTitle: null },
    transitions: (v.transitions === "crossfades" || v.transitions === "mixed" ? v.transitions : "cuts") as VideoPlanItem["transitions"],
    look: x.looks.includes(v.look ?? "") ? (v.look as string) : "",
    cta: v.cta ?? "",
    caption: v.caption ?? "",
    keyFrameEngine: defaults.imageEngine,
    frameEngine: defaults.frameEngine,
    clipEngine: defaults.clipEngine,
  }));
  if (images.length < x.setup.imagePosts) notes.push(`The planner wrote ${images.length} of the ${x.setup.imagePosts} image posts asked for; add or regenerate the missing ones.`);
  if (videos.length < x.setup.videos) notes.push(`The planner wrote ${videos.length} of the ${x.setup.videos} videos asked for; add or regenerate the missing ones.`);
  const plan = normalizePlan({ rev, summary: { concept: a.summary?.concept ?? "", mix: a.summary?.mix ?? "", together: a.summary?.together ?? "" }, images, videos, planningNotes: [...new Set(notes)] }, defaults, rev);
  return plan;
}

/* ───────────── The preview's fixture answer (no text model) ───────────── */

const DEMO = "Demo (preview, no text model)";

/** A complete, deterministic plan for the counts the instruction asks for, labelled as the preview's. */
export function demoCampaignAnswer(instruction: string): RawAnswer & { campaign: string } {
  const num = (label: string, d: number) => Number(new RegExp(`${label}: (\\d+)`).exec(instruction)?.[1] ?? d);
  const imagesN = num("IMAGE POSTS", 3);
  const videosN = num("VIDEOS", 4);
  const shotsN = Math.max(1, num("SHOTS PER VIDEO", 4));
  const seconds = num("VIDEO LENGTH", 15);
  const ids = (prefix: string) => [...instruction.matchAll(new RegExp(`^(${prefix}\\d+):`, "gm"))].map((m) => m[1]);
  const products = ids("P");
  const refs = ids("R");
  const media = [...instruction.matchAll(/^(M\d+): (photo|clip)/gm)].map((m) => ({ id: m[1], kind: m[2] }));
  const clip = media.find((m) => m.kind === "clip")?.id ?? "";
  const photo = media.find((m) => m.kind === "photo")?.id ?? "";
  const pick = <T>(list: T[], n: number, d: T) => (list.length ? list[n % list.length] : d);
  const each = Math.max(1, Math.round((seconds / shotsN) * 10) / 10);
  const cameras = ["slow push in", "orbit left", "static, low angle", "tilt up", "pan right", "top view"];
  return {
    campaign: "plan",
    summary: { concept: `${DEMO}: one idea told in pictures and short Reels across the period.`, mix: `${DEMO}: ${imagesN} image posts carry the offer; ${videosN} Reels show the product in use.`, together: `${DEMO}: the posts open and close the period; the Reels run between them.` },
    images: Array.from({ length: imagesN }, (_, n) => ({
      idea: `${DEMO}: image post ${n + 1}, the product in a bright everyday moment.`,
      objective: n === 0 ? "Awareness" : n === imagesN - 1 ? "Conversion" : "Engagement",
      product: pick(products, n, ""),
      visual: `${DEMO}: soft daylight, the product sharp in the foreground, the brand's colours in the surfaces.`,
      reference: pick(refs, n, ""),
      headline: `Demo headline ${n + 1}`,
      caption: `${DEMO}: a short caption for post ${n + 1}.`,
      cta: "Order today",
    })),
    videos: Array.from({ length: videosN }, (_, v) => ({
      concept: `${DEMO}: Reel ${v + 1}, a short lifestyle story around the product.`,
      hook: `Demo hook ${v + 1}`,
      product: pick(products, v, ""),
      shots: Array.from({ length: shotsN }, (_, k) => {
        // The fixture shows every kind of shot: the second video ends on the client's clip, the third animates a client photo.
        const existing = v === 1 && k === shotsN - 1 && clip;
        const animate = v === 2 && k === 0 && photo;
        return {
          seconds: each,
          action: `${DEMO}: shot ${k + 1} of Reel ${v + 1}, ${k === 0 ? "the hook: the product revealed" : "the product in use"}.`,
          framing: ["close-up", "medium", "wide", "macro"][k % 4],
          camera: cameras[(k + v) % cameras.length],
          reference: k === 0 ? pick(refs, v, "") : "",
          source: existing ? "existing" : animate ? "animate" : "start-image",
          asset: existing ? clip : animate ? photo : "",
          text: k === 0 ? `Demo hook ${v + 1}` : k === shotsN - 1 ? "Order today" : "",
        };
      }),
      voiceover: "",
      music: "upbeat, 110 bpm",
      transitions: "cuts",
      look: "",
      cta: "Order today",
      caption: `${DEMO}: a short caption for Reel ${v + 1}.`,
    })),
  };
}

export const isCampaignSchema = (props: Record<string, unknown>) => "campaign" in props && "images" in props && "videos" in props;
