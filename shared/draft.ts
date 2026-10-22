/**
 * Planning drafts: what the planner wrote is reviewed before it touches the month. The diff
 * says, post by post, what would be new, what would change, what stays as it is, and which
 * pictures would be left belonging to an older idea. Nothing here reads or writes storage.
 */
import type { Post } from "./posts";

export type DraftKind = "campaign" | "ideas" | "grid";
export type DraftMode = "append" | "replace";
export type DraftStatus = "draft" | "applied" | "discarded";

export interface DraftPost {
  index: number;
  title: string;
  type: string;
  group?: { id: string; kind: "carousel" | "series"; slide: number; of: number };
}

export interface DraftChange extends DraftPost {
  /** The fields that would change (title, idea, shot, words, product). */
  fields: string[];
}

export interface DraftDiff {
  mode: DraftMode;
  /** Posts the draft adds to the month. */
  added: DraftPost[];
  /** Existing posts whose words or idea would change. */
  changed: DraftChange[];
  /** Existing posts the draft leaves exactly as they are. */
  untouched: DraftPost[];
  /** Existing posts that leave the month (kept under Versions with their pictures). */
  removed: DraftPost[];
  /** Pictures that would belong to an older idea after the draft is applied. */
  olderIdea: (DraftPost & { why: string })[];
  /** The month after the draft: posts (a carousel counts once), designs, pictures to make, text tiles drawn here. */
  after: { posts: number; designs: number; pictures: number; tiles: number };
}

export interface PlanDraft {
  id: string;
  batch: string;
  kind: DraftKind;
  mode: DraftMode;
  posts: Post[];
  summary: string;
  diff: DraftDiff;
  status: DraftStatus;
  created: number;
  /** What the planner was asked (the brief text, the reference count, the notes). */
  input: { text?: string; references?: number; notes?: string; colours?: { name: string; hex: string }[] };
}

const FIELD_LABELS: [keyof Post, string][] = [
  ["title", "title"],
  ["brief", "idea"],
  ["scene", "shot"],
  ["headline", "headline"],
  ["caption", "caption"],
  ["product", "product"],
];

const asDraftPost = (p: Post): DraftPost => ({ index: p.index, title: p.title, type: p.type, group: p.group ? { id: p.group.id, kind: p.group.kind, slide: p.group.slide, of: p.group.of } : undefined });

export function shapeOf(plan: Pick<Post, "group" | "tileSpec" | "product">[]): DraftDiff["after"] {
  const groups = new Set(plan.filter((p) => p.group).map((p) => p.group!.id));
  const tiles = plan.filter((p) => p.tileSpec?.kind === "text" && !p.product).length;
  return { posts: plan.filter((p) => !p.group).length + groups.size, designs: plan.length, pictures: plan.length - tiles, tiles };
}

/**
 * The diff of a draft against the month as it is. `pictures` says which existing posts have a
 * picture (so a changed idea leaves it as an older idea). In append mode the draft's posts are new
 * and every existing post is untouched; in replace mode every existing post leaves (kept as a
 * version) and the draft is the whole month. A draft that carries an existing post's index with
 * different words is a change to that post.
 */
export function draftDiff(existing: Post[], proposed: Post[], mode: DraftMode, pictures: Set<number> = new Set()): DraftDiff {
  const byIndex = new Map(existing.map((p) => [p.index, p]));
  const added: DraftPost[] = [];
  const changed: DraftChange[] = [];
  const olderIdea: DraftDiff["olderIdea"] = [];
  const touched = new Set<number>();
  for (const p of proposed) {
    const was = mode === "append" ? byIndex.get(p.index) : undefined;
    if (!was) {
      added.push(asDraftPost(p));
      continue;
    }
    touched.add(p.index);
    const fields = FIELD_LABELS.filter(([k]) => (was[k] ?? "") !== (p[k] ?? "")).map(([, label]) => label);
    if (!fields.length) continue;
    changed.push({ ...asDraftPost(was), fields });
    if (pictures.has(was.index)) olderIdea.push({ ...asDraftPost(was), why: `its ${fields.join(", ")} change${fields.length === 1 ? "s" : ""}; the picture stays and is marked as made for the older idea` });
  }
  const removed: DraftPost[] = mode === "replace" ? existing.map(asDraftPost) : [];
  if (mode === "replace") for (const p of existing) if (pictures.has(p.index)) olderIdea.push({ ...asDraftPost(p), why: "the post leaves the month; its picture is kept under Versions" });
  const untouched = mode === "replace" ? [] : existing.filter((p) => !touched.has(p.index) || !changed.some((c) => c.index === p.index)).map(asDraftPost);
  const after = mode === "replace" ? proposed : [...existing.map((p) => proposed.find((q) => q.index === p.index) ?? p), ...proposed.filter((q) => !byIndex.has(q.index))];
  return { mode, added, changed, untouched, removed, olderIdea, after: shapeOf(after) };
}

/** One line for the confirm button: "Add 2 posts" / "Replace the month's 3 posts with 5". */
export function draftLabel(d: DraftDiff): string {
  if (d.mode === "replace") return `Replace the month's ${d.removed.length} post${d.removed.length === 1 ? "" : "s"} with ${d.after.designs} design${d.after.designs === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (d.added.length) parts.push(`add ${d.added.length} post${d.added.length === 1 ? "" : "s"}`);
  if (d.changed.length) parts.push(`change ${d.changed.length}`);
  if (!parts.length) return "Nothing changes";
  const s = parts.join(" and ");
  return s[0].toUpperCase() + s.slice(1);
}
