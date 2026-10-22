/**
 * Plan scope: what a month holds (posts, designs, pictures, text tiles) and what a brief does to
 * it. The append and replace steps follow server/posts.ts /campaign exactly: with "only" the month
 * is the brief's posts alone; otherwise the new posts take the numbers after the existing ones and
 * the existing ones are untouched. The counting is shared/posts.ts planShape.
 */
import { BRIEF_PLAN_SCHEMA, briefPlanInstruction, parseBriefPlan } from "../../shared/campaign";
import { planShape, type Post } from "../../shared/posts";
import { demoAnswer } from "../../server/demo";
import { CLIENT, EXISTING_PLAN, FULL_PLAN, PRODUCTS, PRODUCT_NAMES, bool, obj, str } from "./fixtures";

/** The numbers planShape words, as numbers. */
export function planCounts(plan: Post[]) {
  const groups = new Map<string, number>();
  for (const p of plan) if (p.group) groups.set(p.group.id, (groups.get(p.group.id) ?? 0) + 1);
  const textTiles = plan.filter((p) => p.tileSpec?.kind === "text" && !p.product).length;
  return {
    posts: plan.filter((p) => !p.group).length + groups.size,
    designs: plan.length,
    pictures: plan.length - textTiles,
    textTiles,
    carousels: [...groups.values()],
  };
}

export function planScope(vars: Record<string, unknown>) {
  const named = str(vars.plan);
  const plan: Post[] = named === "full" ? FULL_PLAN : named === "none" ? [] : obj<Post[]>(vars.plan, EXISTING_PLAN);
  const brief = str(vars.brief).trim();
  const only = bool(vars.only);
  if (!brief) return { method: "plan-scope", existing: plan.length, added: 0, total: plan.length, indexes: plan.map((p) => p.index), firstUnchanged: true, shape: planShape(plan), counts: planCounts(plan) };
  // As /campaign does it: the posts kept, the planner told how many there are, the new ones after them.
  const existing = only ? [] : plan;
  const instruction = briefPlanInstruction({
    client: CLIENT.name,
    brief,
    month: "2026-11",
    products: PRODUCTS.map((p) => ({ name: p.name, note: p.note })),
    references: 0,
    brand: { style: CLIENT.style, tone: CLIENT.tone, dos: CLIENT.dos, donts: CLIENT.donts },
    language: CLIENT.language,
    existing: existing.length,
  });
  const nextIndex = existing.reduce((m, p) => Math.max(m, p.index), 0) + 1;
  let n = 0;
  const planned = parseBriefPlan(JSON.parse(demoAnswer(instruction, BRIEF_PLAN_SCHEMA)), PRODUCT_NAMES, nextIndex, () => `g${++n}`);
  const added = planned.posts.map(({ post }) => post);
  const final = [...existing, ...added];
  const firstUnchanged = existing.every((p, i) => JSON.stringify(final[i]) === JSON.stringify(p));
  return {
    method: "plan-scope",
    only,
    existing: existing.length,
    added: added.length,
    total: final.length,
    indexes: final.map((p) => p.index),
    firstUnchanged,
    shape: planShape(final),
    counts: planCounts(final),
    instruction,
  };
}
