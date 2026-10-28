/**
 * A carousel shown as one card (27 Oct): its slides are posts of their own in the plan (each with
 * its picture, style, words and edits), tied by `group.id`; the Studio board and the client's link
 * show them as one card that slides like Instagram's, in slide order, where the first slide stood.
 */
import { CAROUSEL_MAX } from "./publish";
import type { Post } from "./posts";
export { CAROUSEL_MAX };

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

/**
 * A slide taken out of its carousel (28 Oct): it stands as a post of its own where it is; the other
 * slides are numbered again, and a carousel left with one slide becomes a plain post. Null when the
 * post is not a carousel slide.
 */
export function leaveCarousel<P extends Grouped & { title: string }>(plan: P[], index: number): P[] | null {
  const at = plan.find((p) => p.index === index);
  if (!at?.group || at.group.kind !== "carousel") return null;
  const id = at.group.id;
  const rest = plan.filter((p) => p.group?.id === id && p.index !== index).sort((a, b) => a.group!.slide - b.group!.slide || a.index - b.index);
  const of = rest.length;
  return plan.map((p) => {
    if (p.index === index) return { ...p, group: undefined, title: p.title.replace(/(\s·\sslide \d+)+$/u, "").trim() || p.title };
    if (p.group?.id !== id) return p;
    const slide = rest.findIndex((x) => x.index === p.index) + 1;
    return of > 1 ? { ...p, group: { ...p.group, slide, of } } : { ...p, group: undefined };
  });
}

/**
 * The slides of every group counted again (28 Oct): each keeps its place in the SLIDE order (slide
 * number first, post number second), never the card order, so a refresh, a move or a removal
 * elsewhere in the month leaves a carousel's order as the team set it. A group of one slide is
 * a plain post again.
 */
export function recountSlides<P extends Grouped>(plan: P[]): P[] {
  const groups = new Map<string, P[]>();
  for (const p of plan) if (p.group?.id) groups.set(p.group.id, [...(groups.get(p.group.id) ?? []), p]);
  const place = new Map<number, { slide: number; of: number }>();
  for (const members of groups.values()) {
    const ordered = [...members].sort((a, b) => a.group!.slide - b.group!.slide || a.index - b.index);
    ordered.forEach((p, i) => place.set(p.index, { slide: i + 1, of: ordered.length }));
  }
  return plan.map((p) => {
    if (!p.group) return p;
    const at = place.get(p.index)!;
    return at.of > 1 ? { ...p, group: { ...p.group, slide: at.slide, of: at.of } } : { ...p, group: undefined };
  });
}

/** One slide moved to another place in its carousel (slide numbers only; the posts stay where they are). Null when it is not a slide or the place is out of range. */
export function reorderSlide<P extends Grouped>(plan: P[], index: number, to: number): P[] | null {
  const at = plan.find((p) => p.index === index);
  if (!at?.group || at.group.kind !== "carousel") return null;
  const id = at.group.id;
  const members = plan.filter((p) => p.group?.id === id).sort((a, b) => a.group!.slide - b.group!.slide || a.index - b.index);
  if (to < 1 || to > members.length) return null;
  const rest = members.filter((p) => p.index !== index);
  const ordered = [...rest.slice(0, to - 1), at, ...rest.slice(to - 1)];
  const slideOf = new Map(ordered.map((p, i) => [p.index, i + 1]));
  return plan.map((p) => (p.group?.id === id ? { ...p, group: { ...p.group!, slide: slideOf.get(p.index)!, of: ordered.length } } : p));
}

/** One answer for the whole carousel on the client's link: a change asked on any slide wins, approved only when every slide is. */
export function carouselStatus(statuses: ("approved" | "changes" | null | undefined)[]): "approved" | "changes" | null {
  if (statuses.some((s) => s === "changes")) return "changes";
  return statuses.length > 0 && statuses.every((s) => s === "approved") ? "approved" : null;
}

/**
 * A post copied beside another (a tool's result, a carousel's slide): the same idea, words, product,
 * style and layout under its own index and title; nothing the original earned from its reviews,
 * the client's comments or its place in a group comes along. A media post keeps its file under a
 * new fingerprint.
 */
export function copyPost(from: Post, index: number, title: string, fp: string, at: number): Post {
  const post: Post = { ...from, index, title: title.slice(0, 80), ideaAt: at };
  for (const k of ["textCheck", "prechecks", "group", "clientNote", "clientNotes", "clientSteps", "seenBefore", "date", "tile", "tileSpec", "shot"] as const) delete post[k];
  if (from.source === "media" && from.media) post.media = { ...from.media, fp, at };
  return post;
}

/** "Kunafa · slide 3" from any slide's title: the base without an earlier " · slide N". */
export function slideTitle(title: string, slide: number): string {
  return `${title.replace(/(\s·\sslide \d+)+$/u, "").trim()} · slide ${slide}`;
}

/**
 * One card dropped onto another (27 Oct): the dropped post becomes the next slide of the target's
 * carousel (a single target becomes slide 1 of a new one). The dropped post keeps its picture, words
 * and style. Null when either is a series part, the dropped post already belongs to a carousel, or
 * the carousel is full.
 */
export function joinCarousel<P extends Grouped>(plan: P[], dragged: number, into: number, newId: () => string): { plan: P[]; group: string; slide: number } | null {
  const from = plan.find((p) => p.index === dragged);
  const to = plan.find((p) => p.index === into);
  if (!from || !to || from.index === to.index) return null;
  if (from.group || to.group?.kind === "series") return null;
  const id = to.group?.kind === "carousel" ? to.group.id : newId();
  const members = to.group?.kind === "carousel" ? plan.filter((p) => p.group?.id === id) : [to];
  const of = members.length + 1;
  if (of > CAROUSEL_MAX) return null;
  const next = plan.map((p) => {
    if (p.index === from.index) return { ...p, group: { id, kind: "carousel" as const, slide: of, of } };
    if (p.index === to.index && !p.group) return { ...p, group: { id, kind: "carousel" as const, slide: 1, of } };
    if (p.group?.id === id) return { ...p, group: { ...p.group, of } };
    return p;
  });
  return { plan: next, group: id, slide: of };
}
