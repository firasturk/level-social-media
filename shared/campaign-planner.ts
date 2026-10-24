/**
 * Campaign Autopilot's planner (docs/campaign-autopilot.md): what the text model is told, the
 * answer it must give, and how that answer becomes a plan. The model never names a product, a
 * reference or a client file by itself: it picks from numbered lists (P1, R1, M1) the server
 * built from the client's real products, the references the admin added and the client's Drive,
 * and anything it names outside those lists is dropped. Engines are not the model's to choose.
 * Pure; the preview's fixture answer (`demoCampaignAnswer`) lives here too.
 */
import { cinematography, normalDirection, normalizePlan, type ReelDirection, type ImagePlanItem, type VideoPlanItem, type CampaignPlan, type CampaignSetup, type ClipEngine, type ImageEngine, type PlanRef, type ProductPick, type ReelFormat, type ShotSource } from "./campaign-plan";
import type { FrameId } from "./video-frame";
import { CAMERA_ANGLES, angleById } from "./angle-library";

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
  /** The client's cast (ambassadors): the only people who may appear. */
  cast?: CastMember[];
  /** The client's approved brand rules and lessons (brand memory), as the ideas writer gets them. */
  rules?: string[];
}

export interface CastMember {
  name: string;
  gender: string | null;
  modest: boolean;
}

/**
 * Who may appear in a picture or a shot: the client's cast only. A cast of men means men only — no
 * woman or girl, not even her hand. Without a cast, people appear at most as hands, and only when
 * the brand's own rules show people.
 */
/**
 * Words meant for the screen (a hook, a headline): a description of the picture that the model
 * wrote there instead ("Close-up of Khaled's hand passing a Sakina…", seen live) is dropped.
 */
export function onScreenWords(w: string): string {
  const t = (w ?? "").trim();
  if (!t) return "";
  const words = t.split(/\s+/).length;
  const described = /^(close-?up|wide|medium|macro|shot|a |an |the |we see|camera|overhead|top view)\b/i.test(t) && !/[؀-ۿ]/.test(t);
  return words > 9 || described ? "" : t;
}

/** The audience is Muslim: no toasting ("cheers"), no clinking cups or glasses, nothing of a bar. Said wherever people are planned or pictured. */
export const CONDUCT_RULE = "CONDUCT: never show people toasting or clinking cups, glasses or drinks together (no 'cheers'); no alcohol, bars or pubs.";

/**
 * A brand's stored style was written from its past feed and often describes a studio (seamless
 * colour backgrounds, pedestals): seen live, that put every winter picture on a teal backdrop. The
 * style lends palette, attitude and finish; places come from the idea.
 */
export const STYLE_SCOPE_RULE =
  "THE BRAND'S STYLE gives its palette, energy, attitude and finish. Its studio elements (seamless or solid-colour backgrounds, pedestals, plain matte planes) describe past posts, not places: never set a post or a shot in a studio or against a plain backdrop unless the CREATIVE DIRECTION asks for a studio by name.";

/** Words that put a picture in a studio. */
export const STUDIO_WORDS = /\b(studio|seamless|backdrop|solid[- ]colou?r(ed)? background|plain background|monochrom\w* background|matte background|pedestal|infinity cove|sweep)\b/i;

/** Ideas before looks: a real moment and place per piece, a hook mechanic per Reel, the camera from the angle library, and variety everywhere. */
export function ideasFirstLines(): string[] {
  return [
    "IDEAS FIRST. Before any look, decide each piece's idea like a creative agency would:",
    "- Each image post and each Reel is a different idea: a real moment from the audience's own life (on the way to work, in the car, after the gym, at a family table, late at night with friends), in a real place they know (a street, a car, a balcony, a café terrace, stairs, a kitchen, a campus), at a definite time of day and weather. No two pieces share the same idea, the same place or the same camera position.",
    "- setting (image posts): that place and moment in one sentence. For a Reel, direction.place holds it.",
    '- format (Reels): "tv-spot" (a polished commercial: motivated light, lens choices, composed frames) or "ugc" (phone-shot creator content: handheld, deep focus, available light or direct flash, a little imperfect). With two or more Reels, use both formats.',
    "- hookMove (Reels): what happens on screen in the first second to stop the scroll, as an action (the cup is pushed through the car window toward the lens; a hand wipes the fogged windscreen and the product appears; a flash burst on the table and a hand grabs the cup). The hook words are separate.",
    "- angleId: the camera position, by id from CAMERA ANGLES below, for every image post and every shot. Across the campaign use many different ones. In a Reel every shot has a different angleId and a different distance: at least one tight, one mid and one wide; at most one shot at plain eye level; the last shot never repeats the first one's framing.",
    "- Products are always shown true to their note, at real size, in a real hand or on a real surface; never on a pedestal or a plain backdrop.",
    "CAMERA ANGLES (id: what the camera does · distance):",
    ...CAMERA_ANGLES.map((a) => `${a.id}: ${a.name}: ${a.words} · ${a.band}${a.register !== "any" ? ` · best for ${a.register}` : ""}`),
  ];
}

const wordsOf = (t: string) => new Set((t ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3));
/** Two settings that share most of their words are the same place. */
export function samePlace(a: string, b: string): boolean {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.size < 2 || y.size < 2) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

/** What a plan breaks of the ideas-first rules, as notes for the admin (the plan is kept). */
export function varietyNotes(plan: Pick<CampaignPlan, "images" | "videos">, studioAsked: boolean): string[] {
  const notes: string[] = [];
  const places = [...plan.images.map((i) => ({ key: i.key, place: i.setting ?? "" })), ...plan.videos.map((v) => ({ key: v.key, place: v.direction?.place ?? "" }))].filter((p) => p.place);
  for (let i = 0; i < places.length; i++)
    for (let j = i + 1; j < places.length; j++) if (samePlace(places[i].place, places[j].place)) notes.push(`${places[i].key} and ${places[j].key} happen in the same place; give one of them a different setting.`);
  if (!studioAsked) {
    for (const i of plan.images) if (STUDIO_WORDS.test(`${i.setting ?? ""} ${i.visual}`)) notes.push(`${i.key} is set in a studio or on a plain backdrop; give it a real place.`);
    for (const v of plan.videos) if (STUDIO_WORDS.test(`${v.direction?.place ?? ""} ${v.shots.map((s) => s.placement ?? "").join(" ")}`)) notes.push(`${v.key} is set in a studio or on a plain backdrop; give it a real place.`);
  }
  const imageAngles = plan.images.map((i) => i.angleId).filter(Boolean);
  if (imageAngles.length > 2 && new Set(imageAngles).size < imageAngles.length) notes.push("Some image posts share the same camera position; vary them.");
  for (const v of plan.videos) {
    const shots = v.shots.filter((s) => s.source === "start-image");
    const ids = shots.map((s) => s.angleId).filter((a): a is string => !!a);
    if (new Set(ids).size < ids.length) notes.push(`${v.key}: two shots use the same camera position; every shot needs its own.`);
    const bands = new Set(ids.map((id) => angleById(id)?.band));
    if (shots.length >= 3 && bands.size < 2) notes.push(`${v.key}: all its shots are at the same distance; mix tight, mid and wide.`);
    const eye = shots.filter((s) => /\beye[- ]level\b/i.test(s.angle ?? "")).length;
    if (eye > 1) notes.push(`${v.key}: ${eye} shots at plain eye level; keep at most one.`);
  }
  const formats = plan.videos.map((v) => v.format).filter(Boolean);
  if (formats.length >= 2 && new Set(formats).size === 1) notes.push(`All Reels use the ${formats[0]} format; make one of them the other.`);
  return notes;
}

export function peopleRule(cast: CastMember[] | undefined): string {
  return `${castRule(cast)} ${CONDUCT_RULE}`;
}

function castRule(cast: CastMember[] | undefined): string {
  const c = cast ?? [];
  if (!c.length) return "PEOPLE: the brand has no cast. Show no faces; at most a hand holding the product, and only if the brand's style shows hands.";
  const genders = new Set(c.map((m) => (m.gender ?? "").toLowerCase()).filter(Boolean));
  const men = genders.size === 1 && genders.has("man");
  const women = genders.size === 1 && genders.has("woman");
  const list = c.map((m) => `${m.name}${m.gender ? ` (${m.gender}${m.modest ? ", dressed modestly" : ""})` : ""}`).join(", ");
  return `PEOPLE: only the brand's cast may appear: ${list}. Any person, face, arm or hand in a post or shot is one of them.${men ? " Men only: never a woman or a girl, not even a woman's hand." : women ? " Women only: never a man." : ""}`;
}

/** Does an item's words put a person (or a hand) in the picture? */
export const showsPeople = (words: string) => /\b(hands?|man|men|guy|boy|person|people|someone|friends?|holds?|holding|reaching|sips?|sipping|customer)\b|يد|ايد|إيد|شاب|رجل|شخص|يمسك|ماسك|أصابع|اصابع/i.test(words);

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
          setting: { type: "string" },
          angleId: { type: "string" },
        },
        required: ["idea", "objective", "product", "visual", "reference", "headline", "caption", "cta", "setting", "angleId"],
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
                angle: { type: "string" },
                lens: { type: "string" },
                placement: { type: "string" },
                speed: { type: "string", enum: ["normal", "slow"] },
                angleId: { type: "string" },
              },
              required: ["seconds", "action", "framing", "camera", "reference", "source", "asset", "text", "angle", "lens", "placement", "speed", "angleId"],
            },
          },
          voiceover: { type: "string" },
          music: { type: "string" },
          transitions: { type: "string", enum: ["cuts", "crossfades", "mixed"] },
          look: { type: "string" },
          cta: { type: "string" },
          caption: { type: "string" },
          direction: {
            type: "object",
            properties: { look: { type: "string" }, lighting: { type: "string" }, colour: { type: "string" }, lens: { type: "string" }, wardrobe: { type: "string" }, place: { type: "string" } },
            required: ["look", "lighting", "colour", "lens", "wardrobe", "place"],
          },
          format: { type: "string", enum: ["tv-spot", "ugc"] },
          hookMove: { type: "string" },
        },
        required: ["concept", "hook", "product", "shots", "voiceover", "music", "transitions", "look", "cta", "caption", "direction", "format", "hookMove"],
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
    "The lines quoted in the brand's tone are examples of its style, already used: never reuse them, not even changed a little. Write new lines, in that style, about this campaign's own products and moments.",
    STYLE_SCOPE_RULE,
    peopleRule(x.cast),
    ...(x.rules?.length ? ["THE BRAND'S APPROVED RULES AND LESSONS (always follow them):", ...x.rules.slice(0, 30).map((r) => `- ${r}`)] : []),
    "",
    `PRODUCTS you may use (by id; never invent a product, never describe one differently from its note):${x.products.length ? "" : " none: the posts are about the brand, with no product in them."}`,
    ...x.products.map((p) => `${p.listId}: ${p.name}${p.note ? ` — ${p.note}` : ""}`),
    s.productMode === "manual" && x.products.length ? "Use only these products, spread over the posts and videos." : "Pick the products that fit the objective; each post or video names at most one product id.",
    "",
    `REFERENCES (inspiration only, never the expected result and never the product; name one by id where it guides a post or a shot):${x.references.length ? "" : " none."}`,
    ...x.references.map((r) => `${r.listId}: ${r.label}${r.from ? ` (${r.from})` : ""}${r.role === "colour" ? " · for its palette and light only" : r.role === "composition" ? " · for its framing and perspective only" : ""}`),
    "",
    `CLIENT MEDIA (the client's own photos and clips; a shot can use one as it is with source "existing", or animate a photo with source "animate"):${x.media.length ? "" : " none."}`,
    ...x.media.map((m) => `${m.listId}: ${m.media === "clip" ? "clip" : "photo"} — ${m.label}`),
    "",
    ...ideasFirstLines(),
    "",
    "RULES:",
    `- Exactly ${s.imagePosts} image posts and exactly ${s.videos} videos.`,
    `- Each video has ${s.shotsPerVideo} shots whose seconds add up to about ${s.videoSeconds}; shots are 1 to 15 seconds. The first shot is the hook.`,
    '- A shot\'s source: "start-image" (a new picture is made for it, then animated: the usual choice, it keeps the product and the scene consistent), "animate" (a client photo from CLIENT MEDIA is animated: give its id as asset), "existing" (a client clip or photo is used as it is: give its id as asset). Only ids from CLIENT MEDIA go in asset; otherwise asset is "".',
    "- action: what happens in the shot, concretely (subject, product, a small candid action with natural timing). framing: the shot size (wide, medium, medium close-up, close-up, insert of the product).",
    "- DIRECT EACH REEL AS ONE FILMED COMMERCIAL. First write its direction, decided like a commercial cinematographer, in concrete photographic terms (never just \"cinematic\" or \"photorealistic\"):",
    "  direction.look: the camera feel and finish (e.g. \"shot on a digital cinema camera with a fine film grain, gentle highlight roll-off, no glow\"); direction.lighting: the motivated source, its direction, softness, contrast and colour temperature (e.g. \"late-afternoon sun from camera left through the windscreen, soft fill from the white car interior, 4800 K, medium contrast\"); direction.colour: a film-inspired grade: palette, highlight and shadow treatment, saturation and contrast, skin tones natural and the product's colours exact (no orange-and-teal, no oversaturation, no HDR); direction.lens: the lens family and perspective for the Reel (e.g. \"normal primes, 35 to 85 mm looks, f/2.8 to f/5.6, faces and products never distorted, background still readable\"); direction.wardrobe: what the people wear and carry in every shot; direction.place: the location, time of day and screen direction kept across the cuts.",
    "  Each shot is then a different camera setup in that same scene: same people, wardrobe, product, place, light and grade, with an intentional change of angle and size. angleId: the camera position from CAMERA ANGLES for this shot. angle: that camera height and angle in your own words for this shot. lens: lens look, distance and depth of field (e.g. \"50 mm look, 1.5 m away, f/4, the street still readable behind\"; avoid excessive blur). placement: where the subject sits in frame and what is in the foreground and background. camera: the movement, restrained and physically plausible: static, handheld, slow push-in, tracking alongside, tilt; no orbiting unless the idea needs it, never a floating camera. speed: \"normal\" unless slow motion serves the idea.",
    "- In every shot of a video the product, the people, the wardrobe, the light and the time of day stay the same, so the shots cut together; the camera position changes every shot, and the place may move within the same world (from the car to the street outside it).",
    "- Client media goes into a video only when it shows that video's own product in a scene that cuts with the other shots; a photo or clip of another product is never used in it (use \"start-image\" instead).",
    "- text: the few words on screen during the shot (\"\" for none). headline: 2 to 5 words. caption: one or two short sentences. cta: a short call to action.",
    "- A video's hook: the 2 to 6 words shown on screen over its first shot, in the campaign's language, never a description of the picture (\"Close-up of a hand…\" is wrong).",
    `- look: one of ${x.looks.length ? x.looks.join(", ") : "(none)"} or "". music: the mood and tempo in a few words. transitions: cuts, crossfades or mixed.`,
    '- product and reference fields hold a list id (P1, R2) or "". Never write a list id inside any text (idea, concept, action, caption…): name the product by its name.',
    '- campaign: "plan". summary.concept: the campaign idea in two sentences. summary.mix: why this mix of posts and videos. summary.together: how the pieces work together over the period.',
  ];
  return lines.join("\n");
}

interface RawShot {
  angleId?: string;
  angle?: string;
  lens?: string;
  placement?: string;
  speed?: string;
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
  images?: { idea?: string; objective?: string; product?: string; visual?: string; reference?: string; headline?: string; caption?: string; cta?: string; setting?: string; angleId?: string }[];
  videos?: { concept?: string; hook?: string; product?: string; shots?: RawShot[]; voiceover?: string; music?: string; transitions?: string; look?: string; cta?: string; caption?: string; direction?: Partial<ReelDirection>; format?: string; hookMove?: string }[];
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
  const a = scrubAnswer((raw ?? {}) as RawAnswer, x);
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
    ...(i.setting?.trim() ? { setting: i.setting.trim() } : {}),
    ...(angleById(i.angleId) ? { angleId: i.angleId!.trim() } : {}),
  }));
  const videos = (a.videos ?? []).slice(0, x.setup.videos).map((v, n) => ({
    key: `vid-${n + 1}`,
    selected: true,
    concept: v.concept ?? "",
    hook: onScreenWords(v.hook ?? ""),
    product: product(v.product),
    seconds: 0,
    frame: x.setup.videoFrame,
    shots: (v.shots ?? []).slice(0, x.setup.shotsPerVideo).map((s, k) => {
      const media = asset(s.asset);
      let source = (["start-image", "animate", "existing"].includes(s.source ?? "") ? s.source : "start-image") as ShotSource;
      // Animating needs a photo; a clip asked to be animated is used as it is.
      if (source === "animate" && media?.media === "clip") source = "existing";
      return { key: `s${k + 1}`, seconds: Number(s.seconds) || 3, action: s.action ?? "", framing: s.framing ?? "", camera: s.camera ?? "", reference: reference(s.reference), source, asset: source === "start-image" ? null : media, text: s.text ?? "", ...cinematography({ angle: s.angle, lens: s.lens, placement: s.placement, speed: s.speed === "slow" ? "slow" : s.speed === "normal" ? "normal" : undefined, angleId: s.angleId }) };
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
    ...(normalDirection(v.direction) ? { direction: normalDirection(v.direction)! } : {}),
    ...(v.format === "tv-spot" || v.format === "ugc" ? { format: v.format as ReelFormat } : {}),
    ...(v.hookMove?.trim() ? { hookMove: v.hookMove.trim() } : {}),
  }));
  // A client's photo or clip of another product does not go into a Reel about this one (seen live: a
  // Sahlab clip in a Hot Chocolate Reel). Those shots are made instead, and the plan says so.
  for (const v of videos) {
    const own = v.product?.name.toLowerCase() ?? "";
    const others = x.products.map((p) => p.name.toLowerCase()).filter((n) => n && n !== own && !own.includes(n) && !n.includes(own));
    v.shots = v.shots.map((sh, k) => {
      if (sh.source === "start-image" || !sh.asset) return sh;
      const words = `${sh.action} ${sh.asset.label}`.toLowerCase();
      const other = others.find((n) => n.length > 2 && words.includes(n));
      if (!other) return sh;
      notes.push(`${v.key} shot ${k + 1}: the client's ${sh.asset.media ?? "photo"} shows ${other}, not this Reel's product, so a new starting picture is made instead.`);
      return { ...sh, source: "start-image" as ShotSource, asset: null };
    });
  }
  // The brand's tone quotes example lines: one reused as a headline, hook or on-screen line is said.
  const quoted = [...(x.brand.tone ?? "").matchAll(/[\u0600-\u06FF][\u0600-\u06FF\s\u0640]{3,}/g)].map((m) => m[0].replace(/\u0640/g, "").replace(/(.)\1+/g, "$1").trim()).filter((q) => q.length > 3);
  const reused = (w: string) => {
    const t = (w ?? "").replace(/\u0640/g, "").replace(/(.)\1+/g, "$1").trim();
    return !!t && quoted.some((q) => t.includes(q) || q.includes(t));
  };
  for (const i of images) if (reused(i.headline)) notes.push(`${i.key}: its headline repeats an example line from the brand's tone; write a new one.`);
  for (const v of videos) if (reused(v.hook) || v.shots.some((sh) => reused(sh.text))) notes.push(`${v.key}: its words repeat an example line from the brand's tone; write new ones.`);
  notes.push(...varietyNotes({ images, videos }, /\bstudio\b/i.test(x.setup.direction.prompt)));
  if (images.length < x.setup.imagePosts) notes.push(`The planner wrote ${images.length} of the ${x.setup.imagePosts} image posts asked for; add or regenerate the missing ones.`);
  if (videos.length < x.setup.videos) notes.push(`The planner wrote ${videos.length} of the ${x.setup.videos} videos asked for; add or regenerate the missing ones.`);
  const plan = normalizePlan({ rev, summary: { concept: a.summary?.concept ?? "", mix: a.summary?.mix ?? "", together: a.summary?.together ?? "" }, images, videos, planningNotes: [...new Set(notes)] }, defaults, rev);
  return plan;
}

/**
 * List ids the model wrote inside its words ("a cup of blueberry mojito (P16)") are never shown:
 * a product's id becomes its name, a reference's or a file's id is taken out.
 */
export function scrubListIds(text: string, x: Pick<PlannerInput, "products" | "references" | "media">): string {
  if (!text) return text;
  const names = new Map<string, string>([...x.products.map((p) => [p.listId, p.name] as const), ...x.references.map((r) => [r.listId, ""] as const), ...x.media.map((m) => [m.listId, ""] as const)]);
  return text
    .replace(/\s*[([]\s*\b([PRM]\d{1,3})\b\s*[)\]]/g, (all, id: string) => (names.has(id) ? (names.get(id) && !text.toLowerCase().includes(names.get(id)!.toLowerCase()) ? ` (${names.get(id)})` : "") : all))
    .replace(/\b([PRM]\d{1,3})\b/g, (all, id: string) => (names.has(id) ? names.get(id) || "" : all))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?،؛])/g, "$1")
    .trim();
}

/** A plan written before the scrub: a bracketed list id ("(P16)") left in its words is taken out. */
export function stripListIdRefs(plan: CampaignPlan): CampaignPlan {
  const t = (s: string) => s.replace(/\s*[([]\s*[PRM]\d{1,3}\s*[)\]]/g, "").replace(/\s+([.,!?،؛])/g, "$1");
  return {
    ...plan,
    summary: { concept: t(plan.summary.concept), mix: t(plan.summary.mix), together: t(plan.summary.together) },
    images: plan.images.map((i) => ({ ...i, idea: t(i.idea), visual: t(i.visual), headline: t(i.headline), caption: t(i.caption), cta: t(i.cta) })),
    videos: plan.videos.map((v) => ({ ...v, concept: t(v.concept), hook: t(v.hook), voiceover: t(v.voiceover), caption: t(v.caption), cta: t(v.cta), shots: v.shots.map((s) => ({ ...s, action: t(s.action), text: t(s.text) })) })),
  };
}

function scrubAnswer(a: RawAnswer, x: PlannerInput): RawAnswer {
  const t = (s: string | undefined) => (s === undefined ? s : scrubListIds(s, x));
  return {
    ...a,
    summary: a.summary ? { concept: t(a.summary.concept), mix: t(a.summary.mix), together: t(a.summary.together) } : a.summary,
    images: a.images?.map((i) => ({ ...i, idea: t(i.idea), objective: t(i.objective), visual: t(i.visual), headline: t(i.headline), caption: t(i.caption), cta: t(i.cta) })),
    videos: a.videos?.map((v) => ({ ...v, concept: t(v.concept), hook: t(v.hook), voiceover: t(v.voiceover), cta: t(v.cta), caption: t(v.caption), shots: v.shots?.map((s) => ({ ...s, action: t(s.action), text: t(s.text) })) })),
  };
}

/* ───────────── A new product on an item: its words rewritten for it ───────────── */

/** The words of one item the rewrite may change; everything else (shots' order, seconds, framing, camera, sources, engines) stays. */
export const RETARGET_SCHEMA = {
  type: "object",
  properties: {
    retarget: { type: "string" },
    idea: { type: "string" },
    objective: { type: "string" },
    visual: { type: "string" },
    headline: { type: "string" },
    concept: { type: "string" },
    hook: { type: "string" },
    voiceover: { type: "string" },
    caption: { type: "string" },
    cta: { type: "string" },
    shots: { type: "array", items: { type: "object", properties: { key: { type: "string" }, action: { type: "string" }, text: { type: "string" } }, required: ["key", "action", "text"] } },
  },
  required: ["retarget", "idea", "objective", "visual", "headline", "concept", "hook", "voiceover", "caption", "cta", "shots"],
} as const;

export const isRetargetSchema = (props: Record<string, unknown>) => "retarget" in props && "shots" in props && "concept" in props;

type ItemWords = { idea?: string; objective?: string; visual?: string; headline?: string; concept?: string; hook?: string; voiceover?: string; caption?: string; cta?: string; shots?: { key: string; action: string; text: string }[] };

export function itemWords(it: ImagePlanItem | VideoPlanItem): ItemWords {
  if ("shots" in it) return { concept: it.concept, hook: it.hook, voiceover: it.voiceover, caption: it.caption, cta: it.cta, shots: it.shots.map((s) => ({ key: s.key, action: s.action, text: s.text })) };
  return { idea: it.idea, objective: it.objective, visual: it.visual, headline: it.headline, caption: it.caption, cta: it.cta };
}

const productLine = (p: ProductPick | null) => (p ? `${p.name}${p.note ? ` (${p.note})` : ""}` : "no product (the brand itself)");

/** The rewrite's instruction: the same idea, the new product in every word that named the old one. */
export function retargetInstruction(it: ImagePlanItem | VideoPlanItem, before: ProductPick | null, after: ProductPick | null, language: CampaignSetup["language"]): string {
  return [
    `A ${"shots" in it ? "short video (Reel)" : "social media post"} of a campaign was planned for one product; the admin changed its product. Rewrite its words for the new product.`,
    `OLD PRODUCT: ${productLine(before)}`,
    `NEW PRODUCT: ${productLine(after)}`,
    `LANGUAGE: ${LANGUAGE_WORDS[language]}.`,
    "RULES: keep the same idea, mood, structure and length; replace everything that described the old product (its name, flavour, colour, ingredients, packaging) with the new product as its note describes it, never inventing details; keep every shot, in the same order, with the same key; only change words that need to change; never write a list id.",
    "Fields the item does not use stay as they are (empty stays empty). retarget: \"item\".",
    `CURRENT: ${JSON.stringify(itemWords(it))}`,
  ].join("\n");
}

/** The rewritten words put back on the item: shots matched by key; anything missing keeps its old words. */
export function applyRetarget<T extends ImagePlanItem | VideoPlanItem>(it: T, raw: unknown, product: ProductPick | null): T {
  const a = (raw ?? {}) as ItemWords;
  const pick = (v: unknown, old: string) => (typeof v === "string" && v.trim() ? v.trim() : old);
  if ("shots" in it) {
    const v = it as VideoPlanItem;
    const byKey = new Map((a.shots ?? []).map((s) => [s.key, s]));
    return { ...v, product, concept: pick(a.concept, v.concept), hook: pick(a.hook, v.hook), voiceover: typeof a.voiceover === "string" ? a.voiceover.trim() : v.voiceover, caption: pick(a.caption, v.caption), cta: pick(a.cta, v.cta), shots: v.shots.map((s) => ({ ...s, action: pick(byKey.get(s.key)?.action, s.action), text: typeof byKey.get(s.key)?.text === "string" ? byKey.get(s.key)!.text.trim() : s.text })) } as T;
  }
  const i = it as ImagePlanItem;
  return { ...i, product, idea: pick(a.idea, i.idea), objective: pick(a.objective, i.objective), visual: pick(a.visual, i.visual), headline: pick(a.headline, i.headline), caption: pick(a.caption, i.caption), cta: pick(a.cta, i.cta) } as T;
}

/** The preview's rewrite (no text model): the old product's name replaced by the new one in every word. */
export function demoRetarget(instruction: string): ItemWords & { retarget: string } {
  const current = JSON.parse(/^CURRENT: (.*)$/m.exec(instruction)?.[1] ?? "{}") as ItemWords;
  const name = (label: string) => (new RegExp(`^${label}: (.*)$`, "m").exec(instruction)?.[1] ?? "").replace(/ \(.*\)$/, "");
  const from = name("OLD PRODUCT");
  const to = name("NEW PRODUCT");
  const swap = (s: string | undefined) => (s && from && !from.startsWith("no product") ? s.split(from).join(to) : (s ?? ""));
  return { retarget: "item", idea: swap(current.idea), objective: swap(current.objective), visual: swap(current.visual), headline: swap(current.headline), concept: swap(current.concept), hook: swap(current.hook), voiceover: swap(current.voiceover), caption: swap(current.caption), cta: swap(current.cta), shots: (current.shots ?? []).map((sh) => ({ key: sh.key, action: swap(sh.action), text: swap(sh.text) })) };
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
  const nameOf = (id: string) => new RegExp(`^${id}: (.*?)(?: — |$)`, "m").exec(instruction)?.[1] ?? "the product";
  const refs = ids("R");
  const media = [...instruction.matchAll(/^(M\d+): (photo|clip)/gm)].map((m) => ({ id: m[1], kind: m[2] }));
  const clip = media.find((m) => m.kind === "clip")?.id ?? "";
  const photo = media.find((m) => m.kind === "photo")?.id ?? "";
  const pick = <T>(list: T[], n: number, d: T) => (list.length ? list[n % list.length] : d);
  const each = Math.max(1, Math.round((seconds / shotsN) * 10) / 10);
  const cameras = ["slow push in", "orbit left", "static, low angle", "tilt up", "pan right", "top view"];
  const angleIds = [...instruction.matchAll(/^([a-z0-9-]+): [^:\n]+: .* · (tight|mid|wide)/gm)].map((m) => m[1]);
  const places = ["a car at a takeaway window on a cold evening", "a café terrace in the afternoon sun", "an apartment balcony over the city at blue hour", "old stone stairs between houses at dusk", "a kitchen counter on a weekday morning", "a campus bench between classes"];
  return {
    campaign: "plan",
    summary: { concept: `${DEMO}: one idea told in pictures and short Reels across the period.`, mix: `${DEMO}: ${imagesN} image posts carry the offer; ${videosN} Reels show the product in use.`, together: `${DEMO}: the posts open and close the period; the Reels run between them.` },
    images: Array.from({ length: imagesN }, (_, n) => ({
      idea: `${DEMO}: image post ${n + 1}, ${products.length ? nameOf(pick(products, n, "")) : "the product"} in a bright everyday moment.`,
      objective: n === 0 ? "Awareness" : n === imagesN - 1 ? "Conversion" : "Engagement",
      product: pick(products, n, ""),
      visual: `${DEMO}: soft daylight, the product sharp in the foreground, the brand's colours in the surfaces.`,
      reference: pick(refs, n, ""),
      headline: `Demo headline ${n + 1}`,
      caption: `${DEMO}: a short caption for post ${n + 1}.`,
      cta: "Order today",
      setting: `${DEMO}: ${places[n % places.length]}.`,
      angleId: pick(angleIds, n * 3, ""),
    })),
    videos: Array.from({ length: videosN }, (_, v) => ({
      concept: `${DEMO}: Reel ${v + 1}, a short lifestyle story around ${products.length ? nameOf(pick(products, v, "")) : "the product"}.`,
      hook: `Demo hook ${v + 1}`,
      product: pick(products, v, ""),
      shots: Array.from({ length: shotsN }, (_, k) => {
        // The fixture shows every kind of shot: the second video ends on the client's clip, the third animates a client photo.
        const existing = v === 1 && k === shotsN - 1 && clip;
        const animate = v === 2 && k === 0 && photo;
        return {
          seconds: each,
          action: `${DEMO}: shot ${k + 1} of Reel ${v + 1}, ${k === 0 ? "the hook" : "in use"}: ${products.length ? nameOf(pick(products, v, "")) : "the product"} (${pick(products, v, "")}).`.replace(" ()", ""),
          framing: ["close-up", "medium", "wide", "macro"][k % 4],
          camera: cameras[(k + v) % cameras.length],
          reference: k === 0 ? pick(refs, v, "") : "",
          source: existing ? "existing" : animate ? "animate" : "start-image",
          asset: existing ? clip : animate ? photo : "",
          text: k === 0 ? `Demo hook ${v + 1}` : k === shotsN - 1 ? "Order today" : "",
          angle: ["eye level", "over the shoulder", "eye level, slightly high", "low, from table height"][k % 4],
          lens: ["35 mm look, 2 m away, f/4", "50 mm look, 1.5 m away, f/2.8", "85 mm look, 2 m away, f/2.8", "macro insert, 30 cm away, f/5.6"][k % 4],
          placement: `${DEMO}: the product on the right third, the person on the left, the street soft behind.`,
          speed: "normal",
          angleId: pick(angleIds, v * shotsN + k + 1, ""),
        };
      }),
      direction: { look: `${DEMO}: digital cinema camera, fine grain, gentle highlight roll-off.`, lighting: `${DEMO}: late-afternoon sun from camera left, soft fill, 4800 K.`, colour: `${DEMO}: warm neutral grade, natural skin, product colours exact.`, lens: `${DEMO}: normal primes, 35 to 85 mm looks.`, wardrobe: `${DEMO}: the cast in the same clothes in every shot.`, place: `${DEMO}: ${places[(v + imagesN) % places.length]}.` },
      format: v % 2 ? "ugc" : "tv-spot",
      hookMove: `${DEMO}: the product is pushed toward the lens in the first second.`,
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
