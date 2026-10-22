/**
 * What an action touches, said the same way on every button and in every confirm dialog: which
 * post, slide, selection or month it concerns, and whether it changes the plan, edits the picture
 * that exists, or creates another version of it. One post from a style is one post's scope; the
 * month's figures never stand in for it. Pure functions over words; nothing here reads storage.
 */
import { formatUsd } from "./pricing";
import { monthLabel } from "./posts";

export type ScopeTarget =
  | { kind: "post"; index: number; title?: string }
  | { kind: "slide"; index: number; slide: number; of: number; title?: string }
  | { kind: "selection"; indexes: number[] }
  | { kind: "month"; month: string; designs: number };

export type ScopeEffect =
  /** The idea, shot, words or dates change; no picture is made. */
  | "plan"
  /** The picture that exists is changed in place; the picture before it stays under Versions. */
  | "edit-image"
  /** Another version of the picture is made; the current one stays under Versions. */
  | "new-version"
  /** The post's first picture is made. */
  | "first-image";

const listOf = (ns: number[]) => (ns.length <= 1 ? ns.join("") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);

/** "post 3 “Mango”" · "slide 2 of 5 of post 4" · "posts 2, 5 and 7" · "October 2026, 16 designs" */
export function scopeLabel(t: ScopeTarget): string {
  switch (t.kind) {
    case "post":
      return `post ${t.index}${t.title ? ` “${t.title}”` : ""}`;
    case "slide":
      return `slide ${t.slide} of ${t.of} of post ${t.index}${t.title ? ` “${t.title}”` : ""}`;
    case "selection":
      return t.indexes.length === 1 ? `post ${t.indexes[0]}` : `posts ${listOf(t.indexes)}`;
    case "month":
      return `${monthLabel(t.month)}, ${t.designs} design${t.designs === 1 ? "" : "s"}`;
  }
}

/** How many pictures the target stands for. */
export function scopeCount(t: ScopeTarget): number {
  return t.kind === "selection" ? t.indexes.length : t.kind === "month" ? t.designs : 1;
}

/** One sentence on what the action does to what exists. */
export function effectLine(e: ScopeEffect, t: ScopeTarget): string {
  const many = scopeCount(t) > 1;
  switch (e) {
    case "plan":
      return `Changes the plan only: ${many ? "their" : "its"} idea, shot or words. No picture is made and nothing is paid.`;
    case "edit-image":
      return `Edits the picture that exists; the picture before the edit stays under Versions.`;
    case "new-version":
      return `Creates another version of ${many ? "each picture" : "its picture"}; the current one${many ? "s stay" : " stays"} under Versions.`;
    case "first-image":
      return many ? "Makes their first pictures." : "Makes its first picture.";
  }
}

export interface ScopedAction {
  /** What is touched: the target and the effect, for the button's tooltip and the dialog. */
  target: ScopeTarget;
  effect: ScopeEffect;
  /** The estimate for the whole action, when a picture is made. */
  cost?: number;
  /** What stays untouched, when it is worth saying ("the month's other 11 posts"). */
  untouched?: string;
}

/** The confirm dialog's text and its button, from the scope alone. */
export function confirmScope(a: ScopedAction): { message: string; ok: string } {
  const n = scopeCount(a.target);
  const label = scopeLabel(a.target);
  const verb = a.effect === "new-version" ? "Make another version of" : a.effect === "edit-image" ? "Edit" : a.effect === "plan" ? "Change" : "Make";
  // "post 3's picture", "posts 2 and 5's pictures", "every picture of October 2026 (12 designs)", "the plan of October 2026 (12 designs)".
  const what =
    a.target.kind === "month"
      ? a.effect === "plan"
        ? `the plan of ${monthLabel(a.target.month)} (${label.split(", ")[1]})`
        : `every picture of ${monthLabel(a.target.month)} (${label.split(", ")[1]})`
      : a.effect === "plan"
        ? label
        : `${label}'s picture${n > 1 ? "s" : ""}`;
  const cost = a.cost != null && a.effect !== "plan" ? ` About ${formatUsd(a.cost)} (list price, an estimate).` : "";
  const untouched = a.untouched ? ` ${a.untouched[0].toUpperCase()}${a.untouched.slice(1)} untouched.` : "";
  const message = `${verb} ${what}? ${effectLine(a.effect, a.target)}${cost}${untouched}`;
  const okVerb = a.effect === "plan" ? "Change" : a.effect === "edit-image" ? "Edit" : "Make";
  const okWhat = a.target.kind === "month" ? `all ${n}` : a.target.kind === "selection" ? `${n}` : a.target.kind === "slide" ? `slide ${a.target.slide}` : `post ${a.target.index}`;
  const ok = `${okVerb} ${okWhat}${a.cost != null && a.effect !== "plan" ? ` · about ${formatUsd(a.cost)}` : ""}`;
  return { message, ok };
}

/** The one-line scope under a button: "Only post 3 changes; the month's other 11 posts are untouched." */
export function scopeNote(t: ScopeTarget, monthDesigns?: number): string {
  if (t.kind === "month") return `The whole month: ${t.designs} design${t.designs === 1 ? "" : "s"}.`;
  const n = scopeCount(t);
  const others = monthDesigns != null ? Math.max(0, monthDesigns - n) : null;
  const only = n === 1 ? `Only ${scopeLabel(t)} changes` : `Only ${scopeLabel(t)} change`;
  return others ? `${only}; the month's other ${others} post${others === 1 ? " is" : "s are"} untouched.` : `${only}.`;
}
