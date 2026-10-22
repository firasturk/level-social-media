/**
 * Deterministic fixtures shared by the eval providers: one sample client, its product photos, a
 * month with three posts already in it, a full month for counting, and a lesson list with every
 * review status. Nothing here reaches a network or a database; the text calls are answered by
 * server/demo.ts (the same fixture a preview deployment uses).
 */
import type { Post } from "../../shared/posts";
import { lessonLine, type FlagKind } from "../../shared/qa";

export const CLIENT = {
  id: "c-sample",
  name: "Sample Shakes",
  style: "Bright street photography: hard noon light, blue sky, the cup as the hero of a Jordanian street.",
  tone: "friendly, playful, short",
  dos: "the dome lid stays on the cup",
  donts: "no people in the pictures\nno hands",
  language: "ar" as const,
};

export const PRODUCTS = [
  { id: "s1", name: "pistachio shake", key: "u1/b1/src/s1.jpg", note: "a tall clear plastic cup of pale green pistachio milkshake with a dome lid and a wide straw, about 20 cm tall" },
  { id: "s2", name: "mango shake", key: "u1/b1/src/s2.jpg", note: "a tall clear cup of orange mango shake with a dome lid, about 20 cm tall" },
  { id: "s3", name: "strawberry shake", key: "u1/b1/src/s3.jpg", note: "a tall clear cup of pink strawberry shake with whipped cream under a dome lid, about 20 cm tall" },
];
export const PRODUCT_NAMES = PRODUCTS.map((p) => p.name);
export const PRODUCT_NOTES = Object.fromEntries(PRODUCTS.map((p) => [p.name, p.note]));

export const PALETTE = ["Sky blue #0a7bd6", "Sign yellow #f2c200", "Asphalt #2b2b2b"];

/** The month before a brief is added: three single posts, numbered 1 to 3. */
export const EXISTING_PLAN: Post[] = [
  { index: 1, type: "product", title: "Pistachio crossing", brief: "The pistachio shake stands on the white stripes of a zebra crossing, noon sun, hard shadow to the left, a calm band of asphalt below for the words.", caption: "جرّب الفستق اليوم.", hashtags: "#shakes #amman", product: "pistachio shake", headline: "فستق مثلّج", date: "2026-11-02", ideaAt: 1_000 },
  { index: 2, type: "product", title: "Mango stop sign", brief: "The mango shake sits in the middle of a red octagonal stop sign plate, straight on, blue sky behind.", caption: "وقّف للمانجا.", hashtags: "#shakes #amman", product: "mango shake", headline: "مانجا الآن", date: "2026-11-05", ideaAt: 1_000 },
  { index: 3, type: "product", title: "Strawberry kerb", brief: "The strawberry shake on a yellow-painted kerb, low angle, the street falling away behind it.", caption: "فراولة على الرصيف.", hashtags: "#shakes #amman", product: "strawberry shake", headline: "فراولة طازجة", date: "2026-11-08", ideaAt: 1_000 },
];

/** A whole month for counting: 7 single pictures, 1 text tile and a 5-slide carousel. */
export const FULL_PLAN: Post[] = [
  ...EXISTING_PLAN,
  { index: 4, type: "product", title: "Pistachio pole", brief: "The pistachio shake taped to a sign pole, eye level.", caption: "", hashtags: "", product: "pistachio shake" },
  { index: 5, type: "product", title: "Mango bus stop", brief: "The mango shake on the bus-stop bench, afternoon light.", caption: "", hashtags: "", product: "mango shake" },
  {
    index: 6,
    type: "quote",
    title: "T3 · Sky quote",
    brief: "A plain sky-blue background for the words.",
    caption: "",
    hashtags: "",
    headline: "الشارع إلنا",
    tileSpec: { kind: "text", items: "", background: "sky blue #0a7bd6", text: { position: "center", align: "center", size: "huge", color: "#ffffff", style: "bold sans" } },
  },
  { index: 7, type: "product", title: "Strawberry rooftop", brief: "The strawberry shake on a rooftop ledge over the city.", caption: "", hashtags: "", product: "strawberry shake" },
  { index: 8, type: "product", title: "Pistachio taxi", brief: "The pistachio shake on a yellow taxi roof.", caption: "", hashtags: "", product: "pistachio shake" },
  ...[1, 2, 3, 4, 5].map((slide): Post => ({
    index: 8 + slide,
    type: "lifestyle",
    title: `Reveal ${slide}`,
    brief: `Slide ${slide} of the strawberry reveal carousel.`,
    caption: "",
    hashtags: "",
    product: slide === 2 ? undefined : "strawberry shake",
    ingredients: slide === 2 ? "strawberries, cream" : undefined,
    group: { id: "car-1", kind: "carousel", slide, of: 5, role: slide === 1 ? "teaser" : slide === 2 ? "ingredients" : slide === 5 ? "cta" : "reveal" },
  })),
];

/** The review's remembered mistakes for this client, with the status the admin gave each. */
export const LESSONS: { kind: FlagKind; text: string; status: "approved" | "pending" | "rejected" }[] = [
  { kind: "bag", text: "The product is in or next to a bag.", status: "approved" },
  { kind: "foreign", text: "Shows what the brand does not sell: a croissant", status: "approved" },
  { kind: "text", text: "Writing in the picture: a price tag", status: "pending" },
  { kind: "people", text: "A second person appeared behind the counter", status: "rejected" },
];

/** The lines the prompts carry: approved lessons only, as server/lessons.ts lessonsFor selects them. */
export function approvedLessonLines(): string[] {
  return LESSONS.filter((l) => l.status === "approved").map((l) => lessonLine(l.kind, l.text));
}
/** The lines that must never reach a prompt: pending and rejected lessons. */
export function unapprovedLessonLines(): string[] {
  return LESSONS.filter((l) => l.status !== "approved").map((l) => lessonLine(l.kind, l.text));
}

/** The theme's shots, as "Analyse theme" writes them (one per reference picture). */
export const THEME_SHOTS = [
  "The product inside a round road sign at eye level, noon sun, a hard shadow to the left; the plate fills the upper two thirds and the pole leaves calm space below.",
  "The product set in a warning triangle on a kerb, low angle, blue sky; the stripes of the kerb lead to it.",
  "The product on a shop door's sign, straight on, 35 mm, the door's glass reflecting the street.",
];

/** A gallery style with a hand in it: the source of the no-people conflict case. */
export const HAND_STYLE = {
  id: "st-hand",
  title: "Hand to the sky",
  kind: "people" as const,
  prompt: "A hand raises the product high against a clear sky, low angle, the arm cutting the frame diagonally; hard sun, a single sharp shadow, nothing else in frame.",
  imageKey: "styles/st-hand.jpg",
};

/** A gallery style with nobody in it. */
export const EMPTY_STYLE = {
  id: "st-sign",
  title: "Sign symbol",
  kind: "product" as const,
  prompt: "The product stands inside a round blue road sign as its symbol, eye level, noon sun, blue sky behind the plate, a hard shadow to the left.",
  imageKey: "styles/st-sign.jpg",
};

/** Reads a var that promptfoo may hand over as an object or as its JSON text. */
export function obj<T>(v: unknown, fallback: T): T {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as unknown as T;
    }
  }
  return v as T;
}

export function str(v: unknown, fallback = ""): string {
  return v === undefined || v === null ? fallback : String(v);
}

export function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v !== null && v !== undefined ? n : fallback;
}

export function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}
