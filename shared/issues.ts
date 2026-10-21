import type { Config } from "./config";
import { occasionsOf, pickedOccasions } from "./occasions";
import { matchProduct, offerReady, type Post } from "./posts";
import { postProblems, type PostProblem } from "./qa";
import { FOREIGN_ITEMS } from "./brief";

/**
 * What stands between a month and its pictures, read from the month's data alone: the same list
 * for the Journey, the Studio's header ("2 things to fix before Generate") and the server's plan
 * preview. A blocking issue stops Generate for the post it names (or the month); a warning only
 * says so. Screen state (an upload in progress, a reading running) is the screens' own business.
 */
export interface MonthIssue {
  /** A stable name for the kind of problem, so a screen can offer its own fix. */
  code: string;
  text: string;
  how?: string;
  warn?: boolean;
  /** The post it concerns, when it concerns one. */
  post?: number;
  /** A post's own problem (its shot, a bag, words to draw): the Journey fixes these in one go. */
  problem?: PostProblem;
}

export interface MonthIssueInput {
  config: Pick<Config, "plan" | "postCount" | "month" | "occasions" | "campaign" | "gridRef" | "palette" | "theme"> | null;
  client: { logo?: boolean; tone?: string; colors?: { hex: string }[]; service?: string | null } | null;
  theme: { references: number; shots: string[]; analysed?: number; latestRef?: number; palette: { hex: string }[] } | null;
  /** Display names of this month's product photos. */
  products: string[];
  /** The month's cast. */
  cast: { name: string; gender?: string; image?: boolean; description?: string; modest?: boolean }[];
  /**
   * The context of each post's own checks (shot, bags, words, foreign items, places). Left out,
   * only the offer and product checks run.
   */
  scene?: { needsScene: boolean; sellsDrinks?: boolean; hasPlaces?: boolean };
}

export function monthIssues(i: MonthIssueInput): MonthIssue[] {
  const out: MonthIssue[] = [];
  const { config, client, theme } = i;
  if (!client) return [{ code: "client", text: "Pick the account you are working on." }];
  if (!config) return out;
  const plan = config.plan ?? [];
  const month = config.month ?? "";
  // Products
  if (!i.products.length && !client.service?.trim() && !config.campaign)
    out.push({ code: "products", text: "No products yet.", how: "Upload product photos, pick them from the gallery, write a brief (it picks products from the Drive), or tick \"sells a service\"." });
  // Count and occasions
  if ((config.postCount ?? 0) < 1 && !plan.length) out.push({ code: "count", text: "Pick how many posts this month has." });
  const sel = config.occasions;
  for (const o of pickedOccasions(month, sel))
    if (o.portrait && !sel?.photos?.[o.id]) out.push({ code: "portrait", warn: true, text: `${o.name}: upload the official portrait before Generate.` });
  const ticked = new Set(sel?.picked ?? []);
  for (const o of occasionsOf(month)) if (o.major && !ticked.has(o.id)) out.push({ code: "occasion", warn: true, text: `${o.name} (${o.date.slice(5)}) is a big day without a post.` });
  // Brand
  if (!client.logo) out.push({ code: "logo", warn: true, text: "No logo: the posts go out without one." });
  if (!client.tone?.trim()) out.push({ code: "tone", warn: true, text: "No tone of voice: captions use a neutral tone." });
  if (!client.colors?.length) out.push({ code: "colours", warn: true, text: "No brand colours yet." });
  // People
  for (const a of i.cast) {
    if (!a.gender) out.push({ code: "gender", text: `Choose whether ${a.name} is a man or a woman.` });
    if (!a.image) out.push({ code: "portrait-missing", text: `${a.name} has no portrait yet.`, how: "Create the portrait, or take them out of this month." });
  }
  // Theme
  if (theme && !theme.references && !config.gridRef) out.push({ code: "pins", text: "The theme has no pins or photos.", how: "Add photos, or paste Pinterest links and import them." });
  else if (theme && theme.references && (!theme.shots.length || !theme.analysed || (theme.latestRef ?? 0) > theme.analysed))
    out.push({ code: "pins-unread", text: "The pins were not read since the last change: the month would follow the old theme.", how: "Analyse the pins." });
  if (theme && !theme.palette.length && !config.palette?.length) out.push({ code: "palette", warn: true, text: "No colours for this month.", how: "Add the colours, or let the pins or the grid suggest them." });
  // Ideas and posts
  if (!plan.length) out.push({ code: "ideas", text: "No ideas yet.", how: "Write the ideas, or write a brief." });
  else {
    if (config.postCount && plan.length !== config.postCount) out.push({ code: "count-mismatch", warn: true, text: `The month has ${config.postCount} posts but ${plan.length} ideas.` });
    const missing = pickedOccasions(month, sel).filter((o) => !plan.some((x) => x.type === "greeting" && x.occasion === o.id));
    if (missing.length) out.push({ code: "greeting", warn: true, text: `No greeting post yet for ${missing.map((o) => o.name).join(", ")}.` });
    for (const p of plan) out.push(...postIssues(p, i.products, i.scene ? { ...i.scene, cast: i.cast.map((a) => ({ name: a.name, description: a.description ?? "", gender: a.gender, modest: a.modest })) } : undefined));
  }
  return out;
}

/** The problems that keep one post from being made. */
export function postIssues(
  p: Post,
  products: string[],
  scene?: { needsScene: boolean; sellsDrinks?: boolean; hasPlaces?: boolean; cast: { name: string; description: string; gender?: string; modest?: boolean }[] },
): MonthIssue[] {
  const out: MonthIssue[] = [];
  if (p.type === "offer" && !offerReady(p.offer)) out.push({ code: "offer", post: p.index, text: `Post ${p.index}: fill the offer's products, price and contents.` });
  const typographic = p.tileSpec?.kind === "text" && !p.product;
  const names = p.type === "offer" ? (p.offer?.products ?? []) : typographic ? [] : [p.product, ...(p.products ?? [])].filter((n): n is string => !!n);
  for (const n of names) if (!matchProduct(n, products)) out.push({ code: "product-missing", post: p.index, text: `Post ${p.index}: no photo of ${n} this month.`, how: "Pick it from the gallery or the Drive, or choose another product on the post." });
  // The post's own problems (shot, bag, words to draw, foreign items, an invented shop): the same
  // list the Journey's Props and shots screen fixes, so the Studio and the plan preview agree.
  if (scene)
    for (const pr of postProblems(p, { products, cast: scene.cast, sellsDrinks: scene.sellsDrinks, needsScene: scene.needsScene, hasPlaces: scene.hasPlaces }))
      // The empty offer is already the "offer" issue above; it is not listed twice.
      if (!(pr.fix === "post" && pr.text.startsWith("is an offer without"))) out.push({ code: `post-${pr.fix}`, post: p.index, text: `Post ${pr.index} ${pr.text}.`, problem: pr });
  return out;
}

/**
 * The context of the posts' own checks, read the same way everywhere: whether the posts need a
 * written shot (a theme with shots, or a grid month), whether the brand sells drinks (so a cup in
 * a shot is not foreign) and whether it has photos of its own place.
 */
export function sceneContext(i: {
  config: Pick<Config, "gridRef" | "plan"> | null;
  theme: { shots: string[] } | null;
  products: { note?: string | null; category?: string | null }[];
  client: { places?: unknown[]; drivePlaces?: number } | null;
}): NonNullable<MonthIssueInput["scene"]> {
  const plan = i.config?.plan ?? [];
  const gridMonth = !!i.config?.gridRef && plan.some((x) => x.tile);
  return {
    needsScene: !!i.theme?.shots.length || gridMonth,
    sellsDrinks: i.products.some((x) => FOREIGN_ITEMS.test(`${x.note ?? ""} ${x.category ?? ""}`)),
    hasPlaces: !!i.client?.places?.length || !!i.client?.drivePlaces,
  };
}

/** The issues that stop Generate (the warnings are left out). */
export const blocking = (issues: MonthIssue[]) => issues.filter((x) => !x.warn);
