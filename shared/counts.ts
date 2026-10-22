/**
 * The month in numbers, counted one way for every board: the Start screen, the Plan, the Studio's
 * counts line and every confirm dialog read the same arithmetic. A carousel counts once as a post
 * and once per slide as a design; a text tile is a design drawn here for free, never a picture the
 * engine makes. Pure functions over the plan and its tasks; nothing here reads storage.
 */
import { olderIdea, type Post, type RevisionConfig } from "./posts";

/** The part of a task row the counts need. */
export interface CountTask {
  post?: number | null;
  status: string;
  output?: string | null;
  made_for?: number | null;
}

export interface MonthCounts {
  /** Posts as the client sees them: a carousel or series counts once. */
  posts: number;
  /** Every design: each carousel slide is one. */
  designs: number;
  /** Text tiles drawn here, free: designs the engine never makes. */
  tiles: number;
  /** Designs the engine makes (designs minus text tiles). */
  pictures: number;
  /** Carousels and series in the month, with their slide counts. */
  carousels: { kind: "carousel" | "series"; slides: number }[];
  /** Pictures that exist now (made, needing a look, or made for an older idea). */
  existing: number;
  /** Made and nothing to check. */
  made: number;
  /** Made, the review found something to check. */
  look: number;
  /** Made for an earlier idea, product or direction: the picture stays, the post is due again. */
  older: number;
  /** In the engine now. */
  making: number;
  /** Tried and failed; due again. */
  failed: number;
  /** Never made (no task yet), text tiles included. */
  planned: number;
  /** Pictures still to generate: never made, failed, or made for an older idea. Text tiles are left out. */
  remaining: number;
  /** The posts (indexes) whose picture belongs to an older idea. */
  olderPosts: number[];
  /** The posts (indexes) still to generate. */
  remainingPosts: number[];
}

export const IN_FLIGHT = new Set(["queued", "processing", "finalizing"]);
export const inFlight = (t: Pick<CountTask, "status">) => IN_FLIGHT.has(t.status);
export const isTextTile = (p: Pick<Post, "tileSpec" | "product">) => p.tileSpec?.kind === "text" && !p.product;

/** The task that stands for a post: a finished or running one first, then whatever is there. */
export function taskForPost<T extends CountTask>(tasks: T[], index: number): T | null {
  return tasks.find((t) => t.post === index && (t.output || inFlight(t))) ?? tasks.find((t) => t.post === index) ?? null;
}

export function monthCounts(
  plan: Post[],
  tasks: CountTask[],
  config: RevisionConfig | null | undefined,
  /** How many review flags a finished picture carries (0 when nothing to check). */
  flags: (t: CountTask) => number = () => 0,
): MonthCounts {
  const groups = new Map<string, { kind: "carousel" | "series"; slides: number }>();
  for (const p of plan) if (p.group) groups.set(p.group.id, { kind: p.group.kind, slides: (groups.get(p.group.id)?.slides ?? 0) + 1 });
  const tiles = plan.filter(isTextTile).length;
  const c: MonthCounts = {
    posts: plan.filter((p) => !p.group).length + groups.size,
    designs: plan.length,
    tiles,
    pictures: plan.length - tiles,
    carousels: [...groups.values()],
    existing: 0,
    made: 0,
    look: 0,
    older: 0,
    making: 0,
    failed: 0,
    planned: 0,
    remaining: 0,
    olderPosts: [],
    remainingPosts: [],
  };
  for (const p of plan) {
    const t = taskForPost(tasks, p.index);
    const tile = isTextTile(p);
    if (!t) {
      c.planned += 1;
      if (!tile) {
        c.remaining += 1;
        c.remainingPosts.push(p.index);
      }
    } else if (inFlight(t)) c.making += 1;
    else if (!t.output) {
      c.failed += 1;
      if (!tile) {
        c.remaining += 1;
        c.remainingPosts.push(p.index);
      }
    } else {
      c.existing += 1;
      if (olderIdea(t, p, config)) {
        c.older += 1;
        c.olderPosts.push(p.index);
        if (!tile) {
          c.remaining += 1;
          c.remainingPosts.push(p.index);
        }
      } else if (flags(t) > 0) c.look += 1;
      else c.made += 1;
    }
  }
  return c;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 posts, one a 5-slide carousel = 16 designs" */
export function shapeLine(c: Pick<MonthCounts, "posts" | "designs" | "carousels">): string {
  const car = c.carousels.filter((g) => g.kind === "carousel");
  const shape = car.length ? (car.length === 1 ? `, one a ${car[0].slides}-slide carousel` : `, ${car.length} carousels (${car.map((g) => g.slides).join(", ")} slides)`) : "";
  return `${plural(c.posts, "post")}${shape} = ${plural(c.designs, "design")}`;
}

/** "15 pictures · 6 made · 9 remaining · 1 text tile drawn here, free" */
export function picturesLine(c: Pick<MonthCounts, "pictures" | "existing" | "remaining" | "tiles" | "making">): string {
  const parts = [plural(c.pictures, "picture")];
  if (c.existing) parts.push(`${c.existing} made`);
  if (c.making) parts.push(`${c.making} making`);
  parts.push(`${c.remaining} remaining`);
  if (c.tiles) parts.push(`${plural(c.tiles, "text tile")} drawn here, free`);
  return parts.join(" · ");
}

/** The Studio's counts line: "12 posts · 16 designs · 6 made · 2 need a look · 9 remaining". */
export function countsLine(c: MonthCounts): string {
  const parts = [plural(c.posts, "post"), plural(c.designs, "design")];
  if (c.made) parts.push(`${c.made} made`);
  if (c.making) parts.push(`${c.making} making`);
  if (c.look) parts.push(`${c.look} need${c.look === 1 ? "s" : ""} a look`);
  if (c.older) parts.push(`${plural(c.older, "older idea")}`);
  if (c.failed) parts.push(`${c.failed} failed`);
  parts.push(`${c.remaining} remaining`);
  return parts.join(" · ");
}
