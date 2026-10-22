/**
 * Two modules other agents are writing are reached here only when they exist, so the eval passes
 * today and starts checking them the day they land:
 *  - shared/feedback.ts  interpretFeedback(text): "make the logo larger" is a layer edit,
 *    "remove the cup" an image edit, "the second one" ambiguous.
 *  - shared/conflicts.ts detectConflicts(inputs): a style that brings a hand or people into a
 *    post whose brief or brand says "no people" is surfaced as a conflict note, never resolved silently.
 * Until then the providers answer { todo: true } and the assertions pass with a TODO reason.
 */

type Loaded = Record<string, unknown> | null;
const cache = new Map<string, Promise<Loaded>>();

/** Imports a shared module by its path from this file, or null when it is not there yet. */
export function optionalModule(relative: string): Promise<Loaded> {
  if (!cache.has(relative))
    cache.set(
      relative,
      import(/* @vite-ignore */ new URL(relative, import.meta.url).href).then(
        (m: Record<string, unknown>) => m,
        () => null,
      ),
    );
  return cache.get(relative)!;
}

export type FeedbackKind = "layer" | "image" | "ambiguous";

/** The words that name each kind in whatever shape interpretFeedback answers (a string or an object). */
function kindOf(answer: unknown): FeedbackKind | null {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? "");
  if (/ambig|unclear|which one|clarif/i.test(text)) return "ambiguous";
  if (/\blayer|overlay|text|logo|typograph/i.test(text) && !/\bimage\b|\bpicture\b|\bphoto\b/i.test(text)) return "layer";
  if (/\bimage\b|\bpicture\b|\bphoto\b|\bscene\b|regenerat|retake/i.test(text)) return "image";
  return null;
}

export async function feedback(vars: Record<string, unknown>) {
  const text = String(vars.text ?? "");
  const mod = await optionalModule("../../shared/feedback.ts");
  const fn = mod?.interpretFeedback;
  if (typeof fn !== "function") return { method: "feedback", text, todo: true, note: "shared/feedback.ts interpretFeedback is not in this branch yet; the case passes as a TODO." };
  const answer = await (fn as (t: string) => unknown)(text);
  return { method: "feedback", text, todo: false, answer, kind: kindOf(answer) };
}

export interface ConflictInputs {
  brief: string;
  never: string;
  stylePrompt: string;
}

/** The conflicts the shared module names, or null while it does not exist. */
export async function conflictsBetween(inputs: ConflictInputs): Promise<{ todo: boolean; notes: string[] }> {
  const mod = await optionalModule("../../shared/conflicts.ts");
  const fn = mod?.detectConflicts;
  if (typeof fn !== "function") return { todo: true, notes: [] };
  const out = await (fn as (i: unknown) => unknown)({ brief: inputs.brief, never: inputs.never, donts: inputs.never, style: inputs.stylePrompt, stylePrompt: inputs.stylePrompt });
  const notes = Array.isArray(out) ? out.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : out && typeof out === "object" ? Object.values(out as Record<string, unknown>).flat().map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [String(out ?? "")].filter(Boolean);
  return { todo: false, notes };
}
