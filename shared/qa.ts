/**
 * The checks a month's posts pass before any image is paid for: what the image engine would get
 * wrong if it were sent as it is. Each problem says where it is and how it is fixed.
 */
import { BAGS, FRESH_TAKE, LETTERED, decodeEntities, offerReady, type Post, withoutWordsSentences } from "./posts";
import { FOREIGN_ITEMS } from "./brief";
import { AI_LOOK_CHECK, AI_LOOK_FIX } from "./realism";

export type FixKind = "shot" | "post" | "unbag" | "include" | "noplace" | "blank" | "product" | "words";

export interface PostProblem {
  index: number;
  /** What is wrong, in plain words. */
  text: string;
  /**
   * "shot": write this post's shot again; "post": write the post (idea and caption) again; "unbag":
   * take out the sentences with a bag or a carrier (no writing needed); "include": the month's
   * products the post names join its picture (no writing needed); "noplace": the post is written
   * again about a product, since the client has no photos of its shop; "blank": a business card,
   * a price tag or a menu is taken out (no writing needed); "product": the best-fitting product is
   * put in the person's hands.
   */
  fix: FixKind;
  /** "include": the products to add to the post's picture. */
  products?: string[];
}

/** A picture inside the client's shop or branch (its counter, shelves, interior). */
export const SHOP_INSIDE =
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
  // A person tile shows someone holding the brand's product; with nothing in hand the engine fills
  // the hands from the reference (a branded bag, a cup).
  if (post.tileSpec?.kind === "person" && !post.product && post.type !== "offer" && post.type !== "greeting")
    out.push({ index: n, text: "shows a person with no product to hold", fix: "product" });
  if (LETTERED.test(scene) || LETTERED.test(post.brief))
    out.push({ index: n, text: "puts a card, a tag or a menu in its picture: the engine would write invented words on it, so it is taken out", fix: "blank" });
  if (BAGS.test(scene) || BAGS.test(post.brief)) out.push({ index: n, text: "puts the product in a bag or a carrier", fix: "unbag" });
  if (withoutWordsSentences(scene) !== scene.trim() || withoutWordsSentences(post.brief) !== post.brief.trim())
    out.push({ index: n, text: "describes words to draw in its picture (a headline, a slogan, a swipe arrow): the engine would paint them, so they are taken out", fix: "words" });
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

export type FlagKind = "product" | "size" | "invented" | "text" | "bag" | "foreign" | "people" | "tile" | "ailook" | "staging";

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
    aiLook: { type: "string" },
    staging: { type: "string" },
  },
  required: ["productSame", "productIssue", "sizeRight", "invented", "text", "bag", "foreign", "people", "tile", "aiLook", "staging"],
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
    `invented: name any product, box, package or branded item in the post that is not ${k ? "one of the product photos" : "allowed"} (an extra box with a printed name, a second tin nobody photographed), else "". Plain unprinted garments and shoes worn to complete an outfit around a clothing product (a plain t-shirt or top, trousers, socks, sneakers) are NOT invented products; only printed, branded or packaged items are.${r.style ? " Extra copies of the same photographed product are part of the picked style, never invented." : ""} Props and decoration (leaves, flowers, fabric, candles, stands, the set) are not products.`,
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
    r.people.length ? AI_LOOK_CHECK : 'aiLook: "".',
    'staging: describe in one short sentence any staging that would not happen in real life: a cup, glass or drink set inside a plate, bowl or saucer as if it were food; a product floating, hanging or balanced where nothing holds it; a tray or box standing on its edge. Else "".',
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
  if (!none(str(d.aiLook))) out.push({ kind: "ailook", text: `Looks AI-made: ${str(d.aiLook)}` });
  if (!none(str(d.staging))) out.push({ kind: "staging", text: `Not how it is served: ${str(d.staging)}` });
  return out;
}

/** The revision note that asks the engine to fix exactly what the review found. */
/**
 * One remembered mistake, worded as a rule for the next prompt: "the review found X in an earlier
 * picture of this client; it never happens again".
 */
export function lessonLine(kind: FlagKind, text: string): string {
  const t = text.replace(/\.$/, "").trim();
  const strip = (prefix: RegExp) => t.replace(prefix, "").trim();
  switch (kind) {
    case "text":
      return `No writing: an earlier picture carried ${strip(/^Writing in the picture:\s*/i)}. Nothing is written, lettered or drawn as a word, arrow or sign anywhere in the picture.`;
    case "people":
      return `People: an earlier picture went wrong this way: ${t}. The people are exactly the ambassadors described, with correct hands and faces.`;
    case "ailook":
      return `Realism: an earlier picture ${strip(/^Looks AI-made:\s*/i).replace(/^The\b/, "the")}. Real skin texture, real hair, a candid moment, no CGI smoothness.`;
    case "product":
      return `Product truth: an earlier picture had this fault: ${t}. The product is reproduced exactly as photographed.`;
    case "invented":
      return `Nothing invented: an earlier picture added ${strip(/^Invented product:\s*/i)}. Only the photographed products appear; anything else worn or shown is plain and unbranded.`;
    case "tile":
      return `Grid tile: an earlier picture drifted from its tile (${strip(/^Not like its grid tile:\s*/i)}). Follow the tile's staging and props exactly.`;
    case "foreign":
      return `Only the brand's product: an earlier picture ${strip(/^Shows what the brand does not sell:\s*/i) ? `showed ${strip(/^Shows what the brand does not sell:\s*/i)}` : "showed other food or drinks"}. No other food, drink, cup or glass appears.`;
    case "bag":
      return "No bags: an earlier picture put the product in or next to a bag. The product is held or set on a surface, never bagged.";
    case "size":
      return "True size: an earlier picture gave the product a wrong size or an unreal hold. Real-world size against hands and furniture, held level or set down.";
    case "staging":
      return `Staging: an earlier picture was ${strip(/^Not how it is served:\s*/i)}. Everything rests where it really would.`;
  }
}

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
    ailook: AI_LOOK_FIX,
    staging: "Stage it as it is really served: a drink stays in its cup on the table or in a hand, never inside a plate, bowl or saucer; every object rests where it really would",
  };
  return FRESH_TAKE + flags.map((f) => `${ask[f.kind]} (${f.text.replace(/\.$/, "")}).`).join(" ");
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


/* ───────────── Text on design: the words as drawn on the finished post ───────────── */

export const TEXT_CHECK_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    readable: { type: "boolean" },
    covers: { type: "string" },
    position: { type: "string", enum: ["keep", "top", "center", "bottom"] },
    color: { type: "string" },
    fade: { type: "string", enum: ["keep", "on", "off"] },
    scale: { type: "number" },
    note: { type: "string" },
  },
  required: ["ok", "readable", "covers", "position", "color", "fade", "scale", "note"],
};

export function textCheckInstruction(r: { client: string; headline: string; subline?: string; palette: string[]; shadow?: string }): string {
  return [
    `You are the art director of the brand "${r.client}" checking one finished Instagram post. The attached image is the post AS IT WILL BE PUBLISHED: the photograph with the headline "${r.headline}"${r.subline ? ` and the second line "${r.subline}"` : ""} and the logo already drawn on it.`,
    [
      "Check the text on the design, strictly:",
      "- readable: every letter reads at a glance on a phone (enough contrast with what is behind it, no busy texture under it, not too small, not cut by the edge);",
      "- covers: the words never sit on the product, the food, a face, a hand holding the product, or the logo; name what they cover, or write nothing;",
      "- position: keep when the words are well placed; otherwise where they should move (top, center, bottom) to the calmest area away from the product and the logo;",
      "- color: always an empty string. The text is white for every client and only the designer changes it by hand; when white cannot read, ask for the fade or a new position instead;",
      "- fade: keep, or on when a soft dark fade under the words is the only way to read them, or off when the fade is there but darkens a clean picture for nothing;",
      "- scale: 1 to keep the size; between 0.75 and 1.3 when the words should be smaller or bigger;",
      "- ok: true only when readable is true, nothing is covered and position, color and fade can all be kept;",
      "- note: one short sentence for the designer, in English: what is right, or what to change and why.",
    ].join("\n"),
    "Return ONLY the JSON.",
  ].join("\n\n");
}

export interface TextCheck {
  ok: boolean;
  readable: boolean;
  covers: string;
  position: "keep" | "top" | "center" | "bottom";
  color: string;
  fade: "keep" | "on" | "off";
  scale: number;
  note: string;
}

export function parseTextCheck(raw: unknown): TextCheck | null {
  const x = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!x) return null;
  const str = (v: unknown) => String(v ?? "").trim();
  const position = ["top", "center", "bottom"].includes(str(x.position)) ? (str(x.position) as TextCheck["position"]) : "keep";
  const fade = ["on", "off"].includes(str(x.fade)) ? (str(x.fade) as TextCheck["fade"]) : "keep";
  const color = /^#[0-9a-f]{6}$/i.test(str(x.color)) ? str(x.color).toLowerCase() : "";
  const scaleRaw = Number(x.scale);
  const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? Math.max(0.75, Math.min(1.3, scaleRaw)) : 1;
  const readable = x.readable !== false;
  const covers = /^(nothing|none|no|-)?\.?$/i.test(str(x.covers)) ? "" : str(x.covers).slice(0, 160);
  const ok = x.ok === true && readable && !covers && position === "keep" && !color && fade === "keep" && Math.abs(scale - 1) < 0.05;
  return { ok, readable, covers, position, color, fade, scale, note: str(x.note).slice(0, 300) };
}


/* ───────────── Video: a finished post set in motion ───────────── */

/** The image-to-video engines on Higgsfield Cloud, by their API paths. */
export const VIDEO_MODELS: { slug: string; name: string; note: string; resolution?: string }[] = [
  { slug: "bytedance/seedance-2.5/image-to-video", name: "Seedance 2.5", note: "Natural motion, keeps the product exact; the default", resolution: "720p" },
  { slug: "kling-video/v3.0/std/image-to-video", name: "Kling 3.0", note: "Cinematic camera moves and people" },
];
export const VIDEO_SECONDS = 5;

export const VIDEO_IDEA_SCHEMA = {
  type: "object",
  properties: { idea: { type: "string" }, reason: { type: "string" } },
  required: ["idea", "reason"],
};

export function videoIdeaInstruction(r: { client: string; type: string; title: string; brief: string; headline?: string; product?: string; people?: string[] }): string {
  return [
    `You are the motion director of the brand "${r.client}". The attached image is a finished Instagram post (${r.type}: ${r.title}) that will become a ${VIDEO_SECONDS}-second ad clip with an image-to-video model: the picture is the first frame and everything in it starts to move.`,
    `THE POST'S IDEA: ${r.brief}${r.headline ? `\nHEADLINE (drawn on later, not part of the picture): ${r.headline}` : ""}${r.product ? `\nTHE PRODUCT: ${r.product}` : ""}${r.people?.length ? `\nPEOPLE: ${r.people.join(", ")} (the brand's ambassadors)` : ""}`,
    [
      "Write ONE motion idea (2-3 sentences, English, for the video model) that sells the product in five seconds:",
      "- what moves and how: the person lifts, sips, turns, smiles or hands the product to camera; steam, condensation, splashes, crumbs or pouring that fit the product; a slow push-in or orbit of the camera;",
      "- the product stays exactly as in the picture (shape, colours, label, size): it is never swapped, duplicated, opened or melted away;",
      "- the frame stays the same composition and light; no cuts, no text, no logos, no new people;",
      "- gentle and premium, never frantic.",
    ].join("\n"),
    'Return ONLY JSON: {"idea": "...", "reason": "a few words"}.',
  ].join("\n\n");
}


/* ───────────── The preflight: the prompt is read before the engine is paid ───────────── */

export const PREFLIGHT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    problems: { type: "array", items: { type: "string" } },
    scene: { type: "string" },
    dropReference: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["ok", "problems", "scene", "dropReference", "note"],
};

export interface Preflight {
  ok: boolean;
  problems: string[];
  /** The scene paragraph written again without the problems ("" to keep it). */
  scene: string;
  /** The attached style or tile image would be copied wrongly (its people, its words): leave it out. */
  dropReference: boolean;
  note: string;
}

export function preflightInstruction(r: {
  client: string;
  /** The paragraph the engine makes the picture from (the shot or the brief). */
  scene: string;
  /** What each product photo shows. */
  products: string[];
  /** The people the picture may show, with their look ("" for nobody). */
  people: string[];
  /** A style or tile image is attached: the engine will copy what it sees in it. */
  reference: "style" | "tile" | "";
  /** The client's lessons: what went wrong before. */
  lessons: string[];
}): string {
  return [
    `You are the art director of "${r.client}" reading what an image engine is about to be paid to make. Nothing has been generated yet: your job is to catch, in the words and in the attached reference, what the engine would get wrong, and to fix it in writing now.`,
    `THE SCENE THE ENGINE WILL MAKE:\n${r.scene}`,
    r.products.length ? `THE PRODUCTS (as photographed; they are reproduced exactly):\n${r.products.map((p, i) => `${i + 1}. ${p}`).join("\n")}` : "THE POST HAS NO PRODUCT PHOTO.",
    r.people.length ? `THE ONLY PEOPLE ALLOWED (their portraits are attached to the engine): ${r.people.join("; ")}.` : "NO PEOPLE are allowed (a hand at most).",
    r.reference
      ? `THE ATTACHED IMAGE is the ${r.reference === "style" ? "style the designer picked" : "grid tile this post recreates"}; the engine sees it too and tends to copy everything in it: its people (their age and gender), its words, its bags, its products.`
      : "No style or tile image is attached.",
    r.lessons.length ? `WHAT WENT WRONG IN THIS CLIENT'S EARLIER PICTURES:\n${r.lessons.map((l) => `- ${l}`).join("\n")}` : "",
    [
      "Check, strictly:",
      "- people: the scene and the reference agree with the allowed people (children stay children, a girl stays a girl, nobody extra); a reference showing adults when the people are children, or people when none are allowed, is a problem;",
      "- words: nothing in the scene asks for a headline, slogan, sign, label or arrow, and the reference carries no big words the engine would copy;",
      "- product: each product is staged as its photo shows it (a garment printed on the back is seen from behind; a box stays closed; nothing added, recoloured or invented; no plain item is described as a second product);",
      "- staging: the product does something its material can do (clothes do not pour or float; a drink stays in its cup); it is never in or next to a bag or carrier;",
      "- foreign: no food, drink, cup or glass the brand does not sell.",
      'Return JSON: ok (true when nothing is wrong); problems (one short sentence each, "" none); scene: when any problem lives in the words, THE SCENE WRITTEN AGAIN in full (same length and style, same set, camera and idea) with the problems removed, else ""; dropReference: true when the attached image itself would make the engine copy wrong people or words, else false; note: one sentence for the designer.',
    ].join("\n"),
    "Return ONLY the JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parsePreflight(raw: unknown): Preflight | null {
  const d = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!d) return null;
  const problems = Array.isArray(d.problems) ? (d.problems as unknown[]).map((x) => String(x ?? "").trim()).filter((x) => x && !/^(none|no|-)\.?$/i.test(x)) : [];
  const scene = String(d.scene ?? "").replace(/\s+/g, " ").trim();
  return {
    ok: d.ok === true && !problems.length,
    problems,
    scene: scene.length > 40 ? scene.slice(0, 1600) : "",
    dropReference: d.dropReference === true,
    note: String(d.note ?? "").trim().slice(0, 300),
  };
}
