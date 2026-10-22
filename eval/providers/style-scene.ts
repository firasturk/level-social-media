/**
 * One post from a style: the picked style is written for the post's real product
 * (shared/styles.ts adaptStyleInstruction, answered by the demo fixture). The instruction is also
 * where a style's people meet the brand's "no people" rule, so the conflict case reads it.
 */
import { ADAPT_SCHEMA, adaptStyleInstruction } from "../../shared/styles";
import { photoRules } from "../../shared/posts";
import { demoAnswer } from "../../server/demo";
import { CLIENT, EMPTY_STYLE, EXISTING_PLAN, HAND_STYLE, PALETTE, PRODUCT_NOTES, approvedLessonLines, bool, obj, str, unapprovedLessonLines } from "./fixtures";
import { conflictsBetween } from "./feedback";

export async function styleScene(vars: Record<string, unknown>) {
  const style = str(vars.style) === "hand" ? HAND_STYLE : EMPTY_STYLE;
  const post = obj(vars.post, EXISTING_PLAN[0]);
  const headline = vars.headline === undefined ? (post.headline ?? "") : str(vars.headline);
  const never = vars.donts === undefined ? CLIENT.donts : str(vars.donts);
  const instruction = adaptStyleInstruction({
    style: { title: style.title, kind: style.kind, prompt: style.prompt },
    product: PRODUCT_NOTES[post.product ?? ""] ?? "",
    category: "drink",
    post: { type: post.type, headline, brief: post.brief.slice(0, 500) },
    brand: { name: CLIENT.name, style: CLIENT.style, always: photoRules(CLIENT.dos), never: photoRules(never) },
    palette: PALETTE,
    people: [],
    sellsDrinks: true,
    lessons: approvedLessonLines(),
    reference: bool(vars.reference),
  });
  const answer = JSON.parse(demoAnswer(instruction, ADAPT_SCHEMA)) as { prompt: string; brief: string };
  return {
    method: "style-scene",
    instruction,
    scene: answer.prompt,
    brief: answer.brief,
    headline,
    memory: { approved: approvedLessonLines(), unapproved: unapprovedLessonLines() },
    /** What the inputs disagree on, when the conflicts module exists; see feedback.ts. */
    conflicts: await conflictsBetween({ brief: post.brief, never, stylePrompt: style.prompt }),
  };
}
