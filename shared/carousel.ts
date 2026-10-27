/**
 * A carousel shown as one card (27 Oct): its slides are posts of their own in the plan (each with
 * its picture, style, words and edits), tied by `group.id`; the Studio board and the client's link
 * show them as one card that slides like Instagram's, in slide order, where the first slide stood.
 */
import { CAROUSEL_MAX } from "./publish";

interface Grouped {
  index: number;
  group?: { id: string; kind: "carousel" | "series"; slide: number; of: number } | null;
}

export interface CardEntry<P extends Grouped> {
  /** The slide shown (or the post, for a single post or a series part). */
  post: P;
  /** A carousel's slides in order; absent for anything else. */
  slides?: P[];
}

/** The cards of a list of posts: each carousel once, at its first slide's place, showing `shown[group id]` (a slide number) or slide 1. */
export function carouselEntries<P extends Grouped>(posts: P[], shown: Record<string, number> = {}): CardEntry<P>[] {
  const out: CardEntry<P>[] = [];
  const seen = new Set<string>();
  for (const p of posts) {
    const g = p.group;
    if (!g || g.kind !== "carousel" || !g.id) {
      out.push({ post: p });
      continue;
    }
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const slides = posts.filter((x) => x.group?.kind === "carousel" && x.group.id === g.id).sort((a, b) => a.group!.slide - b.group!.slide || a.index - b.index);
    out.push({ post: slides.find((x) => x.group!.slide === shown[g.id]) ?? slides[0], slides });
  }
  return out;
}

/** The plan with one more slide after the carousel's last (a single post becomes slide 1 of a new carousel). */
export function withSlide<P extends Grouped & { title: string; date?: string }>(plan: P[], at: number, makeSlide: (index: number, lead: P) => P, newId: () => string): { plan: P[]; index: number } | null {
  const lead = plan.find((p) => p.index === at);
  if (!lead || lead.group?.kind === "series") return null;
  const id = lead.group?.kind === "carousel" ? lead.group.id : newId();
  const members = lead.group?.kind === "carousel" ? plan.filter((p) => p.group?.id === id) : [lead];
  const of = members.length + 1;
  if (of > CAROUSEL_MAX) return null;
  const index = plan.reduce((m, p) => Math.max(m, p.index), 0) + 1;
  const slide = { ...makeSlide(index, lead), group: { id, kind: "carousel" as const, slide: of, of } };
  const next = plan.map((p) => (p.index === lead.index && !p.group ? { ...p, group: { id, kind: "carousel" as const, slide: 1, of } } : p.group?.id === id ? { ...p, group: { ...p.group, of } } : p));
  return { plan: [...next, slide], index };
}

/** One answer for the whole carousel on the client's link: a change asked on any slide wins, approved only when every slide is. */
export function carouselStatus(statuses: ("approved" | "changes" | null | undefined)[]): "approved" | "changes" | null {
  if (statuses.some((s) => s === "changes")) return "changes";
  return statuses.length > 0 && statuses.every((s) => s === "approved") ? "approved" : null;
}
