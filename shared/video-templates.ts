/**
 * The editor's six templates (phase 3, docs/video-editor.md): original structures written for this
 * studio, not copies of any third-party template or asset. A template is a recipe for a project
 * document: shot slots (what to put there, a suggested length, framing and the join), text layers
 * with placeholder copy in English and Arabic, where the logo goes, a colour preset and intensity,
 * and a pace and music hint. `applyTemplate` turns it into an ordinary, fully editable
 * `VideoProject` filled with the footage at hand; nothing is generated and nothing is spent.
 *
 * Positions are fractions of the frame, so a template works in 9:16, 4:5, 1:1 and 16:9; it is
 * written for 9:16 (the safe areas of Reels and TikTok: nothing important in the top 8 % or the
 * bottom 15 % except the call to action, which sits just above).
 */
import type { MusicMood } from "./music";
import { gapClip, MAX_CLIPS, MAX_TIMELINE_SECONDS, newClip, placeClips, type Clip, type ClipSource, type Transition, type VideoProject } from "./video-project";
import { newOverlayId, type Framing, type LogoOverlay, type Overlay, type TextOverlay } from "./video-compose";

export interface TemplateSlot {
  /** What to put here, in a few words ("Close-up of the product"). */
  label: string;
  /** How to shoot or choose it. */
  hint: string;
  /** Suggested seconds on the timeline. */
  duration: number;
  framing: Framing;
  /** How it joins the slot before (ignored on the first). */
  transition: Transition;
  transitionDuration?: number;
  /** A slow zoom over the slot: the zoom it ends on, from the framing's (a push in above it, a pull out below). */
  push?: number;
  /** How much happens in the shot (0 … 1), when the template was read from a video ("Edit like this video"). */
  action?: number;
}

/** The footage chosen for a slot by a planner (shared/edit-plan.ts), in place of the gallery's round robin. */
export interface SlotWindow {
  source: ClipSource;
  duration: number;
  in: number;
  out: number;
  speed?: number;
  framing?: Framing;
  colour?: Clip["colour"];
}

export type TextRole = "headline" | "subline" | "offer" | "cta" | "caption" | "name";

export interface TemplateText {
  role: TextRole;
  /** Placeholder copy; the person replaces it. */
  en: string;
  ar: string;
  /** The slots it spans (first and last, inclusive, 0-based). */
  from: number;
  to: number;
  x: number;
  y: number;
  size: number;
  font: TextOverlay["font"];
  weight: TextOverlay["weight"];
  color: string;
  box: string | null;
  width?: number;
}

export interface VideoTemplate {
  id: string;
  name: string;
  /** One line for the gallery. */
  description: string;
  pace: "calm" | "steady" | "fast";
  music: { moods: MusicMood[]; bpm: [number, number] | null; note: string };
  look: { id: string; amount: number };
  protectSkin: boolean;
  background: string;
  slots: TemplateSlot[];
  texts: TemplateText[];
  /** Where the client's logo goes, and over which slots. */
  logo: { x: number; y: number; width: number; from: number; to: number };
}

const fill = (zoom = 1, x = 0, y = 0): Framing => ({ fit: "fill", zoom, x, y });
const fit = (): Framing => ({ fit: "fit", zoom: 1, x: 0, y: 0 });
const WHITE = "#ffffff";
const INK = "#111111";

export const TEMPLATES: readonly VideoTemplate[] = [
  {
    id: "product-launch",
    name: "Product launch",
    description: "Tease, reveal, details, in use, hero end card with “Available now”.",
    pace: "steady",
    music: { moods: ["upbeat", "corporate"], bpm: [100, 125], note: "A confident, steady track; the reveal lands on a downbeat." },
    look: { id: "cool-editorial", amount: 0.7 },
    protectSkin: false,
    background: "#0e0e10",
    slots: [
      { label: "Teaser", hint: "A tight crop that hides the product: an edge, a texture, a glint.", duration: 1.5, framing: fill(1.5), transition: "cut" },
      { label: "Reveal", hint: "The whole product, centred, clean background.", duration: 2.5, framing: fill(), transition: "crossfade", transitionDuration: 0.4 },
      { label: "Detail", hint: "The feature that matters most, close.", duration: 1.5, framing: fill(1.6, 0.3), transition: "cut" },
      { label: "In use", hint: "A hand or a person using it.", duration: 2, framing: fill(), transition: "cut" },
      { label: "Hero end card", hint: "The product again, room around it for the words.", duration: 2.5, framing: fill(1.1), transition: "crossfade", transitionDuration: 0.5 },
    ],
    texts: [
      { role: "headline", en: "NEW", ar: "جديد", from: 0, to: 0, x: 0.5, y: 0.2, size: 0.09, font: "display", weight: 800, color: WHITE, box: null },
      { role: "subline", en: "Meet your product name", ar: "تعرّف على اسم المنتج", from: 1, to: 1, x: 0.5, y: 0.74, size: 0.05, font: "sans", weight: 800, color: WHITE, box: "#000000" },
      { role: "cta", en: "Available now", ar: "متوفر الآن", from: 4, to: 4, x: 0.5, y: 0.8, size: 0.055, font: "sans", weight: 800, color: INK, box: WHITE },
    ],
    logo: { x: 0.5, y: 0.1, width: 0.26, from: 4, to: 4 },
  },
  {
    id: "food-closeup",
    name: "Food close-up",
    description: "Macro pour or steam, ingredients, plating, the bite, the dish with “Order now”.",
    pace: "calm",
    music: { moods: ["calm", "playful"], bpm: [85, 105], note: "Warm and unhurried; let the sizzle or the pour breathe." },
    look: { id: "warm-film", amount: 0.8 },
    protectSkin: true,
    background: "#1a120c",
    slots: [
      { label: "Pour or steam", hint: "Macro: sauce poured, steam rising, cheese pulled.", duration: 2, framing: fill(1.5), transition: "cut" },
      { label: "Ingredients", hint: "Fresh ingredients, close and well lit.", duration: 1.5, framing: fill(1.8, -0.2), transition: "crossfade", transitionDuration: 0.4 },
      { label: "Plating", hint: "Hands finishing the plate, from above or at 45°.", duration: 2, framing: fill(1.2), transition: "crossfade", transitionDuration: 0.4 },
      { label: "The bite", hint: "Someone taking the first bite, or the fork lifting.", duration: 1.5, framing: fill(1.3), transition: "cut" },
      { label: "The dish", hint: "The finished dish, centred, room for the words.", duration: 2.5, framing: fill(1.1), transition: "crossfade", transitionDuration: 0.5 },
    ],
    texts: [
      { role: "headline", en: "Freshly made today", ar: "طازج من اليوم", from: 0, to: 1, x: 0.5, y: 0.16, size: 0.055, font: "serif", weight: 600, color: WHITE, box: null },
      { role: "subline", en: "Dish name", ar: "اسم الطبق", from: 4, to: 4, x: 0.5, y: 0.68, size: 0.06, font: "serif", weight: 800, color: WHITE, box: null },
      { role: "cta", en: "Order now", ar: "اطلب الآن", from: 4, to: 4, x: 0.5, y: 0.8, size: 0.05, font: "sans", weight: 800, color: INK, box: WHITE },
    ],
    logo: { x: 0.84, y: 0.08, width: 0.2, from: 0, to: 4 },
  },
  {
    id: "beat-montage",
    name: "Fashion / sport beat montage",
    description: "Eight quick cuts on the beat, bold colour, one line up front and one at the end.",
    pace: "fast",
    music: { moods: ["energy", "upbeat"], bpm: [120, 140], note: "A driving beat: pick the track, then Snap cuts to beats so every cut lands on one." },
    look: { id: "bold-sport", amount: 1 },
    protectSkin: true,
    background: "#000000",
    slots: Array.from({ length: 8 }, (_, i) => ({
      label: ["Hero move", "Detail", "Wide", "Detail", "Motion", "Face", "Wide", "Final pose"][i],
      hint: ["The strongest movement.", "Fabric, shoe, a hand: close.", "Full body in the setting.", "Another close detail.", "Running, jumping, a spin.", "A look to camera.", "Full body again.", "A still pose to end on."][i],
      duration: 0.75,
      framing: i % 2 ? fill(1.25) : fill(),
      transition: "cut" as const,
    })),
    texts: [
      { role: "headline", en: "MOVE YOUR WAY", ar: "تحرّك بطريقتك", from: 0, to: 2, x: 0.5, y: 0.5, size: 0.08, font: "display", weight: 800, color: WHITE, box: null },
      { role: "cta", en: "Shop the drop", ar: "تسوّق الآن", from: 7, to: 7, x: 0.5, y: 0.8, size: 0.055, font: "display", weight: 800, color: INK, box: WHITE },
    ],
    logo: { x: 0.5, y: 0.1, width: 0.24, from: 7, to: 7 },
  },
  {
    id: "offer-promo",
    name: "Offer / promotion",
    description: "The offer big and early, the product, the deadline, a clear “Shop now”.",
    pace: "steady",
    music: { moods: ["upbeat", "energy"], bpm: [110, 130], note: "Bright and upbeat; the offer line should sit on the first strong beat." },
    look: { id: "clean", amount: 1 },
    protectSkin: false,
    background: "#ffffff",
    slots: [
      { label: "Product", hint: "The product on offer, filling the frame.", duration: 2, framing: fill(), transition: "cut" },
      { label: "Detail", hint: "Why it is worth it: a detail or the range.", duration: 1.5, framing: fill(1.4), transition: "cut" },
      { label: "Product again", hint: "Another angle, or the product in use.", duration: 2, framing: fill(), transition: "cut" },
      { label: "End card", hint: "The product whole, shown with room around it (Fit over the background).", duration: 2.5, framing: fit(), transition: "crossfade", transitionDuration: 0.4 },
    ],
    texts: [
      { role: "offer", en: "UP TO 30% OFF", ar: "خصم حتى ٣٠٪", from: 0, to: 1, x: 0.5, y: 0.2, size: 0.085, font: "display", weight: 800, color: WHITE, box: "#d1202f" },
      { role: "subline", en: "This weekend only", ar: "لنهاية هذا الأسبوع فقط", from: 2, to: 2, x: 0.5, y: 0.74, size: 0.05, font: "sans", weight: 800, color: WHITE, box: "#000000" },
      { role: "cta", en: "Shop now", ar: "تسوّق الآن", from: 3, to: 3, x: 0.5, y: 0.82, size: 0.055, font: "sans", weight: 800, color: WHITE, box: "#d1202f" },
    ],
    logo: { x: 0.5, y: 0.1, width: 0.28, from: 3, to: 3 },
  },
  {
    id: "testimonial",
    name: "Testimonial with captions",
    description: "A customer speaking, captioned line by line, a cutaway, their name, the brand.",
    pace: "calm",
    music: { moods: ["calm", "corporate"], bpm: [70, 95], note: "Best without music so the voice carries it: with music set, the render uses the music instead of the clips' sound." },
    look: { id: "soft-matte", amount: 0.6 },
    protectSkin: true,
    background: "#000000",
    slots: [
      { label: "Speaker", hint: "The customer talking to camera, eyes in the upper third.", duration: 4, framing: fill(1, 0, -0.3), transition: "cut" },
      { label: "Cutaway", hint: "The product or the customer using it (no talking needed).", duration: 2.5, framing: fill(1.2), transition: "crossfade", transitionDuration: 0.4 },
      { label: "Speaker again", hint: "The customer's strongest line.", duration: 4, framing: fill(1, 0, -0.3), transition: "crossfade", transitionDuration: 0.4 },
      { label: "Brand end", hint: "The product or the shop, calm.", duration: 2, framing: fill(1.1), transition: "crossfade", transitionDuration: 0.5 },
    ],
    texts: [
      { role: "name", en: "Customer name, city", ar: "اسم العميل، المدينة", from: 0, to: 0, x: 0.5, y: 0.12, size: 0.04, font: "sans", weight: 600, color: WHITE, box: "#000000" },
      { role: "caption", en: "“I use it every morning.”", ar: "«أستخدمه كل صباح.»", from: 0, to: 0, x: 0.5, y: 0.8, size: 0.045, font: "sans", weight: 800, color: WHITE, box: "#000000" },
      { role: "caption", en: "“It changed my routine.”", ar: "«لقد غيّر روتيني.»", from: 2, to: 2, x: 0.5, y: 0.8, size: 0.045, font: "sans", weight: 800, color: WHITE, box: "#000000" },
    ],
    logo: { x: 0.5, y: 0.5, width: 0.34, from: 3, to: 3 },
  },
  {
    id: "brand-story",
    name: "Minimal brand story",
    description: "Four slow shots with long dissolves and three short lines: the brand, quietly.",
    pace: "calm",
    music: { moods: ["cinematic", "calm"], bpm: [60, 90], note: "Sparse piano or strings; let the dissolves follow the phrases." },
    look: { id: "soft-matte", amount: 0.7 },
    protectSkin: true,
    background: "#f4f1ec",
    slots: [
      { label: "Place", hint: "The workshop, the shop or the landscape: wide and still.", duration: 3, framing: fill(1.1), transition: "cut" },
      { label: "Hands", hint: "Hands making, pouring, arranging.", duration: 3, framing: fill(1.3), transition: "crossfade", transitionDuration: 0.8 },
      { label: "Material", hint: "The material or the ingredient, close.", duration: 3, framing: fill(1.5), transition: "crossfade", transitionDuration: 0.8 },
      { label: "The result", hint: "The product, calm, room for the brand.", duration: 3.5, framing: fill(1.1), transition: "crossfade", transitionDuration: 0.8 },
    ],
    texts: [
      { role: "headline", en: "Made with care", ar: "صُنع بعناية", from: 0, to: 0, x: 0.5, y: 0.5, size: 0.055, font: "serif", weight: 400, color: WHITE, box: null },
      { role: "subline", en: "Since 2015", ar: "منذ ٢٠١٥", from: 2, to: 2, x: 0.5, y: 0.5, size: 0.045, font: "serif", weight: 400, color: WHITE, box: null },
      { role: "headline", en: "Brand name", ar: "اسم العلامة", from: 3, to: 3, x: 0.5, y: 0.78, size: 0.06, font: "serif", weight: 600, color: WHITE, box: null },
    ],
    logo: { x: 0.5, y: 0.66, width: 0.24, from: 3, to: 3 },
  },
];

export const templateOf = (id: string | null | undefined): VideoTemplate | undefined => TEMPLATES.find((t) => t.id === id);

/** A template's suggested length, seconds (the slots, less the crossfades' overlaps). */
export function templateLength(t: VideoTemplate): number {
  let total = 0;
  t.slots.forEach((s, i) => {
    total += s.duration - (i > 0 && s.transition === "crossfade" ? Math.min(s.transitionDuration ?? 0.5, s.duration / 2, t.slots[i - 1].duration / 2) : 0);
  });
  return Math.round(total * 100) / 100;
}

export interface TemplateMedia {
  source: ClipSource;
  /** Seconds. */
  duration: number;
}

export type TemplateLanguage = "en" | "ar" | "both";

export interface ApplyOptions {
  /** The words in English, Arabic, or both (Arabic above English). */
  language?: TemplateLanguage;
  /** The client's logo (a same-origin address or a small data: URL); without it the logo slot stays empty. */
  logo?: { src: string; name: string } | null;
  now?: number;
  /** Ids for the clips and layers (tests pass a counter). */
  id?: () => string;
  /** The cut's frame: a Reel (9:16, 1080×1920) by default, or the frame the cut already has. */
  frame?: "reel" | "keep";
  /** The footage for each slot, chosen by a planner (shared/edit-plan.ts); a null slot becomes a gap of its length. */
  windows?: readonly (SlotWindow | null)[];
  /** Keep the project's colour (a template read from a reference video has no look of its own). */
  keepLook?: boolean;
}

/**
 * A new draft from a template: the base project's identity (rev, dates, name) and output frame, the
 * template's clips filled with the footage given (in order, reused when there is less footage than
 * slots, each use a different window of the clip where it is long enough), the template's look,
 * texts and logo placed on the clips' actual times. With no footage the timeline is empty and the
 * texts keep the template's suggested times. Everything stays editable; nothing is generated.
 */
export function applyTemplate(t: VideoTemplate, base: VideoProject, media: readonly TemplateMedia[], opts: ApplyOptions = {}): VideoProject {
  const nextId = opts.id ?? (() => newOverlayId());
  const usable = media.filter((m) => m.duration > 0.3);
  const slots = t.slots.slice(0, MAX_CLIPS);
  const uses = new Map<number, number>();
  const plan = slots.map((_, i) => (usable.length ? i % usable.length : -1));
  const totalUses = new Map<number, number>();
  for (const m of plan) if (m >= 0) totalUses.set(m, (totalUses.get(m) ?? 0) + 1);
  const clips: Clip[] = [];
  const pushed = (c: Clip, slot: TemplateSlot): Clip => {
    if (!slot.push || Math.abs(slot.push - slot.framing.zoom) < 1e-3) return c;
    const len = round3((c.out - c.in) / c.speed);
    return { ...c, keyframes: { zoom: [{ t: 0, v: slot.framing.zoom, ease: "linear" }, { t: len, v: Math.min(4, Math.max(1, slot.push)), ease: "linear" }] } };
  };
  if (opts.windows) {
    slots.forEach((slot, i) => {
      const w = opts.windows![i];
      const join = { transition: i === 0 ? ("cut" as const) : slot.transition, transitionDuration: slot.transitionDuration ?? 0.5 };
      if (!w) {
        clips.push({ ...gapClip(slot.duration, `c${nextId()}`), ...join });
        return;
      }
      const c = newClip(w.source, w.duration, `c${nextId()}`);
      const framing = { ...(w.framing ?? slot.framing) };
      clips.push(pushed({ ...c, in: round6(w.in), out: round6(w.out), speed: w.speed ?? 1, ...join, framing, ...(w.colour ? { colour: w.colour } : {}) }, { ...slot, framing }));
    });
  }
  slots.forEach((slot, i) => {
    if (opts.windows) return;
    const mi = plan[i];
    if (mi < 0) return;
    const m = usable[mi];
    const k = uses.get(mi) ?? 0;
    uses.set(mi, k + 1);
    const n = totalUses.get(mi) ?? 1;
    const len = Math.min(slot.duration, m.duration);
    const spare = Math.max(0, m.duration - len);
    // The k-th use of the same footage takes the k-th window across it; a single use takes the middle.
    const start = n > 1 ? (spare * k) / (n - 1) : spare / 2;
    const c = newClip(m.source, m.duration, `c${nextId()}`);
    clips.push(pushed({ ...c, in: round3(start), out: round3(start + len), transition: i === 0 ? "cut" : slot.transition, transitionDuration: slot.transitionDuration ?? 0.5, framing: { ...slot.framing } }, slot));
  });
  // When the timeline would run past the limit (it cannot with these templates), the last clips are dropped.
  while (clips.length && placeClips(clips).at(-1)!.end > MAX_TIMELINE_SECONDS) clips.pop();
  // Each slot's start and end on the timeline: the placed clips', else the template's suggested times.
  const placed = placeClips(clips);
  const times: { start: number; end: number }[] = [];
  let at = 0;
  slots.forEach((s, i) => {
    if (placed[i]) times.push({ start: placed[i].start, end: placed[i].end });
    else {
      const overlap = i > 0 && s.transition === "crossfade" ? Math.min(s.transitionDuration ?? 0.5, s.duration / 2) : 0;
      const start = Math.max(0, at - overlap);
      times.push({ start, end: start + s.duration });
      at = start + s.duration;
      return;
    }
    at = placed[i].end;
  });
  const span = (from: number, to: number) => {
    const a = times[Math.min(from, times.length - 1)];
    const b = times[Math.min(to, times.length - 1)];
    return { start: round3(a.start), end: round3(Math.max(a.start + 0.2, b.end)) };
  };
  const language = opts.language ?? "both";
  const output = opts.frame === "keep" ? base.output : { ...base.output, width: 1080, height: 1920 };
  const aspect = output.width / Math.max(1, output.height);
  const overlays: Overlay[] = [];
  for (const tx of t.texts) {
    const { start, end } = span(tx.from, tx.to);
    overlays.push(...textOverlays(tx, start, end, language, aspect, nextId));
  }
  if (opts.logo?.src) {
    const { start, end } = span(t.logo.from, t.logo.to);
    const l: LogoOverlay = { id: `o${nextId()}`, kind: "logo", src: opts.logo.src, name: opts.logo.name || "Logo", start, end, x: t.logo.x, y: t.logo.y, width: t.logo.width, opacity: 1 };
    overlays.push(l);
  }
  return {
    ...base,
    output,
    clips,
    ...(opts.keepLook ? {} : { look: t.look.id, lookAmount: t.look.amount, protectSkin: t.protectSkin, background: t.background }),
    overlays,
    snapToBeats: t.pace === "fast" && !!base.music?.beats?.length,
    template: { id: t.id, at: opts.now ?? Date.now() },
    updatedAt: opts.now ?? Date.now(),
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * A template text as layers from `start` to `end`: one block in English or Arabic, or both (Arabic
 * above English, a little smaller, stacked by their estimated line counts so they never overlap).
 */
export function textOverlays(tx: Pick<TemplateText, "en" | "ar" | "x" | "y" | "size" | "font" | "weight" | "color" | "box" | "width">, start: number, end: number, language: TemplateLanguage, aspect: number, nextId: () => string): TextOverlay[] {
  const width = tx.width ?? 0.86;
  let blocks: { text: string; dy: number; size: number }[];
  if (language === "en") blocks = [{ text: tx.en, dy: 0, size: tx.size }];
  else if (language === "ar") blocks = [{ text: tx.ar, dy: 0, size: tx.size }];
  else {
    const size = round3(tx.size * 0.85);
    const hA = estimateLines(tx.ar, size, width, aspect) * size * LINE;
    const hE = estimateLines(tx.en, size, width, aspect) * size * LINE;
    const gap = size * 0.45;
    const top = -(hA + gap + hE) / 2;
    blocks = [
      { text: tx.ar, dy: top + hA / 2, size },
      { text: tx.en, dy: top + hA + gap + hE / 2, size },
    ];
  }
  return blocks.map((b) => ({ id: `o${nextId()}`, kind: "text", text: b.text, start: round3(start), end: round3(end), x: tx.x, y: round3(tx.y + b.dy), size: b.size, color: tx.color, font: tx.font, weight: tx.weight, align: "center", box: tx.box, width }));
}

/** The overlay engine's line height, as a multiple of the font size (src/video-editor/engine/overlays.ts). */
const LINE = 1.22;

/**
 * How many lines a text block wraps to, estimated (the browser measures the real glyphs when it
 * draws; this errs on the wide side): bold Latin about 0.6 of the size per character, Arabic about
 * 0.5, wrapped at spaces within the block's width of a frame of this aspect (width / height).
 */
export function estimateLines(text: string, size: number, width: number, aspect: number): number {
  const perChar = /[؀-ۿ]/.test(text) ? 0.5 : 0.6;
  const perLine = Math.max(4, (width * aspect) / (size * perChar));
  let lines = 1;
  let cur = 0;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur + 1 + w.length > perLine) {
      lines++;
      cur = w.length;
    } else cur += (cur ? 1 : 0) + w.length;
  }
  return lines;
}
