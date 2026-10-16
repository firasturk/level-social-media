/**
 * The checks a month's posts pass before any image is paid for: what the image engine would get
 * wrong if it were sent as it is. Each problem says where it is and how it is fixed.
 */
import { decodeEntities, offerReady, type Post } from "./posts";
import { FOREIGN_ITEMS } from "./brief";

export type FixKind = "shot" | "post";

export interface PostProblem {
  index: number;
  /** What is wrong, in plain words. */
  text: string;
  /** "shot": write this post's shot again; "post": write the post (idea and caption) again. */
  fix: FixKind;
}

const BAGS = /\b(bags?|carriers?|baskets?|totes?|shopping)\b/i;
const MALE = /\b(man|male|boy|gentleman|husband|father|son)\b|رجل|شاب|ولد/i;
const FEMALE = /\b(woman|female|girl|lady|wife|mother|daughter)\b|امرأة|بنت|سيدة|فتاة/i;
const WOMENS_WEAR = /\b(headscarf|head scarf|hijab|veil|dress|skirt|abaya)\b|حجاب|فستان|تنورة/i;

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
    cast: { name: string; description: string }[];
    /** The client sells drinks: cups and glasses are then its own products. */
    sellsDrinks?: boolean;
    /** The theme has shots, so every post should have its own. */
    needsScene: boolean;
  },
): PostProblem[] {
  const out: PostProblem[] = [];
  const n = post.index;
  const scene = post.scene ?? "";
  if (ctx.needsScene && !scene.trim()) out.push({ index: n, text: "has no shot yet", fix: "shot" });
  if (post.type === "offer" && !offerReady(post.offer))
    out.push({ index: n, text: "is an offer without its products, price and contents", fix: "post" });
  if (BAGS.test(scene)) out.push({ index: n, text: "puts the product in a bag or a carrier in its shot", fix: "shot" });
  if (BAGS.test(post.brief)) out.push({ index: n, text: "puts the product in a bag or a carrier in its idea", fix: "post" });
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
  if (extraCaption.length)
    out.push({ index: n, text: `names ${extraCaption.join(", ")} in its text, which is not in its picture`, fix: "post" });
  const extraScene = extraProductsIn(`${post.brief} ${scene}`, allowed, ctx.products);
  if (extraScene.length)
    out.push({ index: n, text: `shows ${extraScene.join(", ")} in its picture, which is not one of its products`, fix: scene ? "shot" : "post" });
  for (const name of post.people ?? []) {
    const a = ctx.cast.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (a && MALE.test(a.description) && !FEMALE.test(a.description) && WOMENS_WEAR.test(`${scene} ${post.brief}`))
      out.push({ index: n, text: `dresses ${a.name} (a man) in a headscarf or a dress`, fix: scene ? "shot" : "post" });
  }
  return out;
}
