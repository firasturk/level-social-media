/**
 * The campaign's size, set on the Start board: how many posts the month has and how they are
 * shaped (single pictures, carousels of N slides, separators of N designs), and what that comes
 * to in designs and in pictures still to generate. Pure arithmetic: nothing here reads storage.
 *
 * Three numbers are always told apart:
 * - posts: what the feed shows (a carousel or a separator series counts once);
 * - designs: every slide and tile that is designed (a 4-slide carousel is 4 designs);
 * - images still to generate: the designs that need a picture from the engine and have none yet
 *   (text tiles are drawn in the studio for free, pictures already made are not made again).
 */
import { MAX_POST_COUNT, type Format, type Post } from "./posts";

export const MAX_SLIDES = 10;

export interface CampaignSize {
  /** Posts in the month: single pictures + carousels + separators. */
  posts: number;
  /** How many of the posts are carousels (several slides posted together). */
  carousels: number;
  /** How many of the posts are separators: a calm post (or a short series of them) between the others. */
  separators: number;
  /** Slides in each carousel (2..10). */
  slidesPerCarousel: number;
  /** Designs in each separator (1 = a single post; more = a series of separator designs). */
  slidesPerSeparator: number;
}

export const DEFAULT_CAMPAIGN_SIZE: CampaignSize = { posts: 12, carousels: 0, separators: 0, slidesPerCarousel: 4, slidesPerSeparator: 1 };

const int = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A size with every field inside its bounds: carousels and separators never outnumber the posts. */
export function normalizeSize(s: Partial<CampaignSize> | null | undefined): CampaignSize {
  const posts = clamp(int(s?.posts, DEFAULT_CAMPAIGN_SIZE.posts), 1, MAX_POST_COUNT);
  const carousels = clamp(int(s?.carousels, 0), 0, posts);
  const separators = clamp(int(s?.separators, 0), 0, posts - carousels);
  return {
    posts,
    carousels,
    separators,
    slidesPerCarousel: clamp(int(s?.slidesPerCarousel, DEFAULT_CAMPAIGN_SIZE.slidesPerCarousel), 2, MAX_SLIDES),
    slidesPerSeparator: clamp(int(s?.slidesPerSeparator, DEFAULT_CAMPAIGN_SIZE.slidesPerSeparator), 1, MAX_SLIDES),
  };
}

/**
 * The month's size from its settings: the saved size when the designer set one, else the post
 * count as single pictures (months saved before the size existed load unchanged).
 */
export function campaignSizeOf(config: { postCount?: number; campaignSize?: Partial<CampaignSize> } | null | undefined): CampaignSize {
  if (config?.campaignSize) return normalizeSize({ ...config.campaignSize, posts: config.postCount ?? config.campaignSize.posts });
  return normalizeSize({ ...DEFAULT_CAMPAIGN_SIZE, posts: config?.postCount ?? DEFAULT_CAMPAIGN_SIZE.posts });
}

export interface SizeCounts {
  posts: number;
  singles: number;
  carousels: number;
  separators: number;
  /** Every slide and tile designed. */
  designs: number;
}

/** What a size comes to: singles, and designs across the carousels and separators. */
export function sizeCounts(size: CampaignSize): SizeCounts {
  const s = normalizeSize(size);
  const singles = s.posts - s.carousels - s.separators;
  return { posts: s.posts, singles, carousels: s.carousels, separators: s.separators, designs: singles + s.carousels * s.slidesPerCarousel + s.separators * s.slidesPerSeparator };
}

export interface MonthNumbers {
  posts: number;
  designs: number;
  /** Designs that still need a picture from the engine. */
  images: number;
  /** Text tiles drawn in the studio, free. */
  tiles: number;
  /** Pictures already made. */
  made: number;
  /** Where the numbers come from: the saved plan, or the size set for a month without posts. */
  from: "plan" | "size";
}

/** A separator post: planned as one by the brief (its role), or a text tile of a grid. */
export function isSeparator(p: Pick<Post, "group" | "tileSpec" | "product">): boolean {
  return p.group?.role === "separator" || (p.tileSpec?.kind === "text" && !p.product);
}

/**
 * The three numbers of a month, from its saved plan when it has one (what is really there), else
 * from its size. `made` are the posts whose picture exists already (by post index).
 */
export function monthNumbers(plan: Pick<Post, "index" | "group" | "tileSpec" | "product">[], size: CampaignSize, made: Iterable<number> = []): MonthNumbers {
  if (!plan.length) {
    const c = sizeCounts(size);
    return { posts: c.posts, designs: c.designs, images: c.designs, tiles: 0, made: 0, from: "size" };
  }
  const groups = new Set(plan.filter((p) => p.group).map((p) => p.group!.id));
  const posts = plan.filter((p) => !p.group).length + groups.size;
  const tiles = plan.filter((p) => p.tileSpec?.kind === "text" && !p.product).length;
  const indexes = new Set(plan.map((p) => p.index));
  const tileIndexes = new Set(plan.filter((p) => p.tileSpec?.kind === "text" && !p.product).map((p) => p.index));
  let pictured = 0;
  for (const i of new Set(made)) if (indexes.has(i) && !tileIndexes.has(i)) pictured++;
  const designs = plan.length;
  return { posts, designs, images: Math.max(0, designs - tiles - pictured), tiles, made: pictured, from: "plan" };
}

/** The size a saved plan has (to show it beside the size the designer asks for). */
export function sizeOfPlan(plan: Pick<Post, "group" | "tileSpec" | "product">[]): CampaignSize {
  const groups = new Map<string, { kind: string; n: number; separator: boolean }>();
  let singles = 0;
  let singleSeparators = 0;
  for (const p of plan) {
    if (p.group) {
      const g = groups.get(p.group.id) ?? { kind: p.group.kind, n: 0, separator: false };
      g.n++;
      if (p.group.role === "separator") g.separator = true;
      groups.set(p.group.id, g);
    } else if (isSeparator(p)) singleSeparators++;
    else singles++;
  }
  const all = [...groups.values()];
  const carousels = all.filter((g) => g.kind === "carousel" && !g.separator);
  const separatorGroups = all.filter((g) => g.kind !== "carousel" || g.separator);
  const avg = (xs: number[], fallback: number) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : fallback);
  return normalizeSize({
    posts: singles + singleSeparators + all.length,
    carousels: carousels.length,
    separators: singleSeparators + separatorGroups.length,
    slidesPerCarousel: avg(carousels.map((g) => g.n), DEFAULT_CAMPAIGN_SIZE.slidesPerCarousel),
    slidesPerSeparator: avg([...separatorGroups.map((g) => g.n), ...Array.from({ length: singleSeparators }, () => 1)], 1),
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 posts: 8 single pictures, 3 carousels of 4 slides, 1 separator · 20 designs". */
export function sizeLine(size: CampaignSize, format?: Format): string {
  const c = sizeCounts(size);
  const s = normalizeSize(size);
  const parts: string[] = [];
  if (c.singles) parts.push(`${plural(c.singles, "single picture")}`);
  if (c.carousels) parts.push(`${plural(c.carousels, "carousel")} of ${s.slidesPerCarousel} slides`);
  if (c.separators) parts.push(`${plural(c.separators, "separator")}${s.slidesPerSeparator > 1 ? ` of ${s.slidesPerSeparator} designs` : ""}`);
  return `${plural(c.posts, "post")}${parts.length ? `: ${parts.join(", ")}` : ""} · ${plural(c.designs, "design")}${format ? ` · ${format}` : ""}`;
}

export const SIZE_MARK = "CAMPAIGN SIZE";

/**
 * The size written into the brief for the planner, as a last paragraph it can read ("exactly 12
 * posts: ..."). Only when the brief is the whole month: posts added to a month keep their own count.
 */
export function sizeBriefLine(size: CampaignSize, format?: Format): string {
  const c = sizeCounts(size);
  const s = normalizeSize(size);
  const parts: string[] = [];
  if (c.singles) parts.push(`${plural(c.singles, "single post")} (one picture each)`);
  if (c.carousels) parts.push(`${plural(c.carousels, "carousel")} of exactly ${s.slidesPerCarousel} slides each`);
  if (c.separators) parts.push(`${plural(c.separators, "separator post")}${s.slidesPerSeparator > 1 ? ` of ${s.slidesPerSeparator} designs each (a series)` : ""} between the others`);
  return `${SIZE_MARK} (set by the designer; it wins over any count in the request above): exactly ${plural(c.posts, "post")}${parts.length ? `: ${parts.join(", ")}` : ""}; ${plural(c.designs, "design")} in all${format ? `; format ${format}` : ""}.`;
}

/** The brief as the designer wrote it: the size paragraph added for the planner is taken off. */
export function withoutSizeLine(text: string): string {
  const i = text.lastIndexOf(`\n\n${SIZE_MARK}`);
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

/**
 * What a change of size means for a month that already has posts: posts are only ever added by
 * an explicit step, never taken away or rebuilt by a number. Null when nothing changes.
 */
export function sizeChange(plan: Pick<Post, "index" | "group" | "tileSpec" | "product">[], target: CampaignSize): { kind: "add"; count: number; from: number; to: number; text: string } | { kind: "fewer"; count: number; text: string } | null {
  const have = monthNumbers(plan, target).posts;
  const want = normalizeSize(target).posts;
  if (!plan.length || have === want) return null;
  if (want > have) {
    const n = want - have;
    const last = plan.reduce((m, p) => Math.max(m, p.index), 0);
    return { kind: "add", count: n, from: last + 1, to: last + n, text: `Add ${plural(n, "post")} (${last + 1}${n > 1 ? `–${last + n}` : ""}) written in the month's world. Posts 1–${last} stay exactly as they are, with their pictures.` };
  }
  const n = have - want;
  return { kind: "fewer", count: n, text: `The month has ${plural(have, "post")}; a smaller number never removes any by itself. Take ${plural(n, "post")} out from the Plan one by one (each is kept under Versions), or replace the month from a new request with the changes shown first.` };
}
