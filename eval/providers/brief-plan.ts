/**
 * Quick Campaign: the brief becomes the planner's instruction (shared/campaign.ts), the demo
 * fixture answers it (server/demo.ts), and parseBriefPlan turns the answer into numbered posts.
 */
import { BRIEF_PLAN_SCHEMA, briefPlanInstruction, parseBriefPlan } from "../../shared/campaign";
import { demoAnswer } from "../../server/demo";
import { CLIENT, PRODUCTS, PRODUCT_NAMES, bool, num, obj, str } from "./fixtures";

export interface BriefPlanVars {
  brief: string;
  /** Posts already in the month (the new ones come after them). */
  existing?: number;
  /** How many reference pictures the designer attached. */
  references?: number;
  /** The brand's NEVER rules; the default client's say "no people". */
  donts?: string;
  language?: "ar" | "en" | "both";
}

export function briefPlan(vars: Record<string, unknown>) {
  const v: BriefPlanVars = { brief: str(vars.brief), existing: num(vars.existing, 0), references: num(vars.references, 0), donts: vars.donts === undefined ? CLIENT.donts : str(vars.donts), language: obj(vars.language, "ar") as "ar" };
  const instruction = briefPlanInstruction({
    client: CLIENT.name,
    brief: v.brief,
    month: "2026-11",
    products: PRODUCTS.map((p) => ({ name: p.name, note: p.note })),
    references: v.references ?? 0,
    brand: { style: CLIENT.style, tone: CLIENT.tone, dos: CLIENT.dos, donts: v.donts },
    language: v.language ?? "ar",
    existing: v.existing ?? 0,
  });
  const raw = JSON.parse(demoAnswer(instruction, BRIEF_PLAN_SCHEMA, v.references ?? 0)) as unknown;
  let n = 0;
  const planned = parseBriefPlan(raw, PRODUCT_NAMES, (v.existing ?? 0) + 1, () => `g${++n}`);
  const groups = new Map<string, number>();
  for (const { post } of planned.posts) if (post.group) groups.set(post.group.id, (groups.get(post.group.id) ?? 0) + 1);
  return {
    method: "brief-plan",
    instruction,
    summary: planned.summary,
    colours: planned.colours,
    posts: planned.posts.map(({ post, reference }) => ({ index: post.index, type: post.type, title: post.title, headline: post.headline, product: post.product ?? "", group: post.group ?? null, reference })),
    counts: {
      designs: planned.posts.length,
      singles: planned.posts.filter(({ post }) => !post.group).length,
      carousels: [...groups.values()],
      /** Instagram posts: each single and each group count once. */
      posts: planned.posts.filter(({ post }) => !post.group).length + groups.size,
      firstIndex: planned.posts[0]?.post.index ?? null,
      lastIndex: planned.posts.at(-1)?.post.index ?? null,
    },
    noPeople: bool(/no people|no person|nobody/i.test(instruction)),
  };
}
