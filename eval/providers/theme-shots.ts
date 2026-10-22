/**
 * Use theme references: "Analyse theme" reads the pins into shots (themeBuilderInstruction, THEME_SCHEMA),
 * then the month's shoot list writes one shot per post over them (adaptShotsInstruction, SHOTS_SCHEMA).
 * Both calls are answered by the demo fixture.
 */
import { adaptShotsInstruction, SHOTS_SCHEMA, type ShotPost } from "../../shared/brief";
import { POST_TYPE_INFO, THEME_SCHEMA, themeBuilderInstruction, type Post } from "../../shared/posts";
import { demoAnswer } from "../../server/demo";
import { EXISTING_PLAN, PALETTE, PRODUCT_NOTES, THEME_SHOTS, approvedLessonLines, num, obj, unapprovedLessonLines } from "./fixtures";

/** Step 1: the theme's references read into a direction, a library and shots. */
export function themeAnalyse(vars: Record<string, unknown>) {
  const references = num(vars.references, 3);
  const instruction = themeBuilderInstruction("Street signs", references);
  const read = JSON.parse(demoAnswer(instruction, THEME_SCHEMA, references)) as { description: string; direction: string; library: string; shots: string[]; palette: { name: string; hex: string }[] };
  return { method: "theme-analyse", instruction, direction: read.direction, library: read.library, shots: read.shots, palette: read.palette, counts: { shots: read.shots.length, palette: read.palette.length } };
}

/** Step 2: one shot per planned post, in the look of the theme's shots. */
export function themeShots(vars: Record<string, unknown>) {
  // promptfoo turns a top-level array var into one test per element, so a single post may arrive alone.
  const given = obj<Post[] | Post>(vars.plan, EXISTING_PLAN);
  const plan: Post[] = Array.isArray(given) ? given : [given];
  const posts: ShotPost[] = plan.map((p) => ({
    index: p.index,
    type: p.type,
    typeRule: POST_TYPE_INFO[p.type]?.description ?? "",
    products: [p.product, ...(p.products ?? [])].filter((n): n is string => !!n).map((n) => PRODUCT_NOTES[n] ?? n),
    people: [],
    headline: p.headline ?? "",
    brief: p.scene?.trim() && p.handShot ? p.scene : p.brief,
  }));
  const instruction = adaptShotsInstruction({ shots: obj<string[]>(vars.shots, THEME_SHOTS), posts, palette: PALETTE, lessons: approvedLessonLines() });
  const answer = JSON.parse(demoAnswer(instruction, SHOTS_SCHEMA)) as { shots: { post: number; ref: number; shot: string }[] };
  return {
    method: "theme-shots",
    instruction,
    shots: answer.shots,
    counts: { posts: posts.length, shots: answer.shots.length, postsWithShot: new Set(answer.shots.map((s) => s.post)).size },
    memory: { approved: approvedLessonLines(), unapproved: unapprovedLessonLines() },
  };
}
