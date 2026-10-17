/**
 * The checks a month's posts pass before any image is paid for: what the image engine would get
 * wrong if it were sent as it is. Each problem says where it is and how it is fixed.
 */
import { BAGS, decodeEntities, offerReady, type Post } from "./posts";
import { FOREIGN_ITEMS } from "./brief";

export type FixKind = "shot" | "post" | "unbag" | "include" | "noplace";

export interface PostProblem {
  index: number;
  /** What is wrong, in plain words. */
  text: string;
  /**
   * "shot": write this post's shot again; "post": write the post (idea and caption) again; "unbag":
   * take out the sentences with a bag or a carrier (no writing needed); "include": the month's
   * products the post names join its picture (no writing needed); "noplace": the post is written
   * again about a product, since the client has no photos of its shop.
   */
  fix: FixKind;
  /** "include": the products to add to the post's picture. */
  products?: string[];
}

/** A picture inside the client's shop or branch (its counter, shelves, interior). */
const SHOP_INSIDE =
  /\b(interior|inside)\b[^.]{0,60}\b(shop|store|branch|bakery|caf[eé]|boutique|showroom)\b|\b(shop|store|branch|bakery|caf[eé]|boutique|showroom)\b[^.]{0,60}\b(interior|counter|shelf|shelves|display case|storefront|shop window)\b/i;
const MALE = /\b(man|male|boy|gentleman|husband|father|son)\b|رجل|شاب|ولد/i;
const FEMALE = /\b(woman|female|girl|lady|wife|mother|daughter)\b|امرأة|بنت|سيدة|فتاة/i;
const WOMENS_WEAR = /\b(headscarf|head scarf|hijab|veil|dress|skirt|abaya)\b|حجاب|فستان|تنورة/i;
const IMMODEST = /\b(bare[- ]shoulders?|bare arms|sleeveless|strapless|off[- ]the[- ]shoulder|off[- ]shoulder|tank top|crop top|mini ?skirt|shorts|low[- ]cut|plunging|swimsuit|bikini)\b/i;

function norm(t: string): string {
  return decodeEntities(t)
    .normalize("NFC")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_\-–—.,'"()&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ways a product name shows up in text: the whole name and every run of two or more of its parts. */
function variants(name: string): string[] {
  const parts = decodeEntities(name)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .split(/\s*[-–—_]\s*/)
    .map(norm)
    .filter(Boolean);
  const out = new Set<string>([norm(name)]);
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 2; j <= parts.length; j++) {
      const v = parts.slice(i, j).join(" ");
      if (v.length >= 6 && !/^\d+( \d+)*$/.test(v)) out.add(v);
    }
  return [...out].filter((v) => v.length >= 6);
}

/** Month products a text names although they are not in the post's picture. */
export function extraProductsIn(text: string, allowed: string[], all: string[]): string[] {
  const t = ` ${norm(text)} `;
  const mine = new Set(allowed.flatMap(variants));
  return all.filter((n) => {
    if (allowed.some((a) => norm(a) === norm(n))) return false;
    return variants(n).some((v) => !mine.has(v) && t.includes(` ${v} `));
  });
}

export function postProblems(
  post: Post,
  ctx: {
    /** Display names of the month's product photos. */
    products: string[];
    /** The month's cast with their look, to know each one's gender. */
    cast: { name: string; description: string; gender?: string; modest?: boolean }[];
    /** The client sells drinks: cups and glasses are then its own products. */
    sellsDrinks?: boolean;
    /** The theme has shots, so every post should have its own. */
    needsScene: boolean;
    /** The client has photos of its own shop; without them a shop interior would be invented. */
    hasPlaces?: boolean;
  },
): PostProblem[] {
  const out: PostProblem[] = [];
  const n = post.index;
  const scene = post.scene ?? "";
  if (ctx.needsScene && !scene.trim()) out.push({ index: n, text: "has no shot yet", fix: "shot" });
  if (post.type === "offer" && !offerReady(post.offer))
    out.push({ index: n, text: "is an offer without its products, price and contents", fix: "post" });
  if (ctx.hasPlaces === false && post.type !== "greeting" && (post.tileSpec?.kind === "place" || SHOP_INSIDE.test(`${post.brief} ${scene}`)))
    out.push({ index: n, text: "shows the client's shop, which has no photos: it would be invented", fix: "noplace" });
  if (BAGS.test(scene) || BAGS.test(post.brief)) out.push({ index: n, text: "puts the product in a bag or a carrier", fix: "unbag" });
  // Coffee Day may show coffee; every other post shows only what the client sells.
  if (!ctx.sellsDrinks && post.occasion !== "coffee-day") {
    const drink = (t: string) => {
      const m = FOREIGN_ITEMS.exec(t);
      return m ? m[0] : "";
    };
    const s = drink(scene);
    if (s) out.push({ index: n, text: `shows "${s}" in its shot, which the client does not sell`, fix: "shot" });
    else {
      const b = drink(post.brief);
      if (b) out.push({ index: n, text: `shows "${b}" in its idea, which the client does not sell`, fix: "post" });
    }
  }
  const allowed = [
    ...(post.type === "offer" && post.offer ? post.offer.products : [post.product, ...(post.products ?? [])]),
  ].filter((x): x is string => !!x);
  const extraCaption = extraProductsIn(`${post.headline ?? ""} ${post.subline ?? ""} ${post.caption}`, allowed, ctx.products);
  const extraScene = extraProductsIn(`${post.brief} ${scene}`, allowed, ctx.products);
  // A product the post names and the month has a photo of simply joins its picture: writing the
  // text again tends to name it again. Offers keep exactly the designer's products.
  const include = (names: string[]) => post.type !== "offer" && (post.products?.length ?? 0) + names.length <= 3;
  if (extraCaption.length) {
    const text = `names ${extraCaption.join(", ")} in its text, which is not in its picture`;
    out.push(include(extraCaption) ? { index: n, text, fix: "include", products: extraCaption } : { index: n, text, fix: "post" });
  }
  const sceneOnly = extraScene.filter((x) => !extraCaption.includes(x));
  if (sceneOnly.length) {
    const text = `shows ${sceneOnly.join(", ")} in its picture, which is not one of its products`;
    out.push(include([...extraCaption, ...sceneOnly]) ? { index: n, text, fix: "include", products: sceneOnly } : { index: n, text, fix: scene ? "shot" : "post" });
  }
  for (const name of post.people ?? []) {
    const a = ctx.cast.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!a) continue;
    const man = a.gender ? a.gender === "man" : MALE.test(a.description) && !FEMALE.test(a.description);
    if (man && WOMENS_WEAR.test(`${scene} ${post.brief}`))
      out.push({ index: n, text: `dresses ${a.name} (a man) in a headscarf or a dress`, fix: scene ? "shot" : "post" });
    const bare = IMMODEST.exec(`${scene} ${post.brief}`);
    if (a.modest !== false && bare)
      out.push({ index: n, text: `shows "${bare[0]}" although ${a.name} dresses modestly`, fix: scene ? "shot" : "post" });
  }
  return out;
}

/* ───────────── The automatic review of a finished post image ───────────── */

export type FlagKind = "product" | "size" | "invented" | "text" | "bag" | "foreign" | "people" | "tile";

/** One thing the review found wrong in a generated post. */
export interface PostFlag {
  kind: FlagKind;
  text: string;
}

export const POST_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    productSame: { type: "boolean" },
    productIssue: { type: "string" },
    sizeRight: { type: "boolean" },
    invented: { type: "string" },
    text: { type: "string" },
    bag: { type: "boolean" },
    foreign: { type: "array", items: { type: "string" } },
    people: { type: "string" },
    tile: { type: "string" },
  },
  required: ["productSame", "productIssue", "sizeRight", "invented", "text", "bag", "foreign", "people", "tile"],
};

/** What the reviewer is told about the post it checks. */
export interface ReviewContext {
  /** Number of product photos attached before the result (0 for a post without a product). */
  products: number;
  /** What each product photo shows, in order. */
  productNotes: string[];
  type: string;
  /** The people the post may show, with their look; empty means nobody (a hand at most). */
  people: { name: string; description: string }[];
  /** The client sells drinks: cups and glasses are then allowed. */
  sellsDrinks?: boolean;
  /** Coffee Day may show coffee. */
  coffeeDay?: boolean;
  /** The picked style's scene: it may stage the product giant or several times on purpose. */
  style?: string;
  /** The grid tile this post follows: its role and staging in the feed. */
  tile?: string;
}

export function postReviewInstruction(r: ReviewContext): string {
  const k = r.products;
  return [
    "You are the art director checking one generated social-media post image before the designer sees it. Be strict and concrete: the brand's real product must never change.",
    k
      ? `${k > 1 ? `Images 1 to ${k} are the real product photos` : "Image 1 is the real product photo"} (the truth${r.productNotes.some(Boolean) ? `: ${r.productNotes.map((n, i) => `image ${i + 1}: ${n || "the product"}`).join("; ")}` : ""}). Image ${k + 1} is the generated post.`
      : "The only image is the generated post. This post has no product photo: no product, box or package of the brand should be in it.",
    k
      ? "productSame: judge only the product itself, never the props or the set around it. productSame: true only if every product in the post looks like its photo: the same shape, proportions, colours, packaging, lid, label artwork and open or closed state (a closed box stays closed; colours never changed to match the scene). productIssue: when false, say in one short sentence what changed (\"the box is navy instead of white\", \"the tin lost its gold lid\"), else \"\"."
      : 'productSame: always true. productIssue: "".',
    k && r.style
      ? `sizeRight: the designer picked a style that stages the product this way: "${r.style.slice(0, 600)}". A giant product or several copies of the same product are then right. sizeRight is false only when a person holds the product in a way no hand could (balanced on fingertips, hanging from a finger).`
      : k
      ? "sizeRight: true when each product has its real size next to hands and furniture (a gift box about a forearm wide, one sweet between two fingers) and is held naturally (level, from below, or set on a surface); false when it is giant or tiny, balanced on fingertips or hanging from a finger."
      : "sizeRight: always true.",
    `invented: name any product, box, package or branded item in the post that is not ${k ? "one of the product photos" : "allowed"} (an extra box with a printed name, a second tin nobody photographed), else "".${r.style ? " Extra copies of the same photographed product are part of the picked style, never invented." : ""} Props and decoration (leaves, flowers, fabric, candles, stands, the set) are not products.`,
    "text: quote or describe any letters, words, numbers, logos or labels anywhere in the post that are NOT the product's own printed packaging from its photo (signs, invented brand names, gibberish lettering, price tags), else \"\".",
    "bag: true when a product is in or next to a shopping bag, paper bag, carrier, basket or tote.",
    r.sellsDrinks || r.coffeeDay
      ? 'foreign: [] (the brand may show drinks here).'
      : "foreign: list every drink, cup, mug, glass, bottle, straw or food that is not the brand's product (\"a glass of juice\", \"a coffee cup\"), else []. Only drinks, their vessels and food count: leaves, flowers, fabric, candles and other props never do, and neither do the product's own ingredients (its nuts, syrup, cream, fruit or pieces of the product itself, as its photo and description show).",
    r.people.length
      ? `people: the post may show only ${r.people.map((p) => `${p.name} (${p.description})`).join("; ")}. Describe in one sentence any problem: more people than these, a man in a headscarf, hijab or dress, clothes that break the look (bare shoulders, a low neckline or short skirt when the look says modest; a hijab missing or added against the look), or broken hands, fingers or faces. Else "".`
      : 'people: this post shows nobody, but one or two hands holding, touching or dipping the product or its ingredient are allowed and never a problem. Describe only a face, a body or more than two hands, or hands with broken or extra fingers. Else "".',
    r.tile
      ? `tile: this post recreates one tile of a reference feed grid: "${r.tile.slice(0, 500)}". Describe in one sentence how the post drifts from that tile's role and staging (a drink tile showing a box, a close-up shot from far away, a place tile with no room), else "". Colours, products and people are the client's own and never count as drift.`
      : 'tile: "".',
    `Post type: ${r.type}. Return ONLY the JSON.`,
  ].join("\n");
}

export function parsePostReview(raw: unknown, r: Pick<ReviewContext, "products" | "sellsDrinks" | "coffeeDay" | "tile">): PostFlag[] {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const none = (t: string) => !t || /^(none|no|n\/a|nothing|-)\.?$/i.test(t);
  const out: PostFlag[] = [];
  if (r.products && d.productSame === false)
    out.push({ kind: "product", text: str(d.productIssue) || "The product does not look like its photo." });
  if (r.products && d.sizeRight === false) out.push({ kind: "size", text: "The product's size or the way it is held is not real." });
  if (!none(str(d.invented))) out.push({ kind: "invented", text: `Invented product: ${str(d.invented)}` });
  if (!none(str(d.text))) out.push({ kind: "text", text: `Writing in the picture: ${str(d.text)}` });
  if (d.bag === true) out.push({ kind: "bag", text: "The product is in or next to a bag." });
  const foreign = Array.isArray(d.foreign) ? (d.foreign as unknown[]).map(str).filter((x) => !none(x)) : [];
  if (foreign.length && !r.sellsDrinks && !r.coffeeDay)
    out.push({ kind: "foreign", text: `Shows what the brand does not sell: ${foreign.join(", ")}` });
  if (!none(str(d.people))) out.push({ kind: "people", text: str(d.people) });
  if (r.tile && !none(str(d.tile))) out.push({ kind: "tile", text: `Not like its grid tile: ${str(d.tile)}` });
  return out;
}

/** The revision note that asks the engine to fix exactly what the review found. */
export function fixNote(flags: PostFlag[]): string {
  const ask: Record<FlagKind, string> = {
    product: "Make the product exactly as in its photo: the same shape, colours, packaging, lid and label",
    size: "Give the product the size the post describes and hold it naturally, level with both hands or set on a surface",
    invented: "Remove every product, box or package that is not in the product photos",
    text: "Remove all writing, letters, numbers and logos that are not on the product's own packaging",
    bag: "Remove the bag, carrier or basket; the product is held or set on a surface",
    foreign: "Remove every drink, cup, glass, bottle and food that is not the brand's product",
    people: "Fix the people as described",
    tile: "Stage it like its tile of the reference grid",
  };
  return flags.map((f) => `${ask[f.kind]} (${f.text.replace(/\.$/, "")}).`).join(" ");
}

/**
 * The text with one product's name changed to another's, however it was written ("كنافة-ناعمة-سوبر",
 * "كنافة ناعمة سوبر"): a post whose product is replaced no longer names the old one.
 */
export function renameProduct(text: string, from: string, to: string): string {
  const words = from.split(/[\s_\-\u0640]+/).filter(Boolean);
  if (!text || !words.length || !to.trim()) return text;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_\\-\\u0640]+");
  return text.replace(new RegExp(pattern, "gi"), to.trim());
}
