/**
 * Campaign memory: the client's earlier months are remembered so an idea is never planned twice.
 * A post that reads like one made before is marked "Seen before" with where it was.
 */
export interface EarlierPost {
  /** Where it was: "October 2026 · post 4". */
  label: string;
  title: string;
  brief: string;
}

const STOP = new Set(["with", "that", "this", "from", "into", "onto", "over", "under", "their", "there", "where", "while", "then", "than", "them", "they", "have", "been", "being", "your", "about", "after", "before", "light", "shot", "picture", "post", "brand", "product", "products", "client", "cup", "real", "clean", "soft", "warm", "bright", "natural", "background", "close", "frame", "centre", "center", "left", "right", "scene", "mood", "style", "look", "colour", "colours", "color", "colors"]);

/** The content words of a text: lower case, four letters or more, no stop words. */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

/** How much two texts share (Jaccard of their content words), 0 to 1. */
export function overlap(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** The earlier post this one repeats, when it reads too much like it (its label), else undefined. */
export function seenBefore(post: { title: string; brief: string }, earlier: EarlierPost[], threshold = 0.42): string | undefined {
  let best: { label: string; score: number } | null = null;
  for (const e of earlier) {
    const score = Math.max(overlap(`${post.title} ${post.brief}`, `${e.title} ${e.brief}`), overlap(post.title, e.title) * 0.9);
    if (score >= threshold && (!best || score > best.score)) best = { label: e.label, score };
  }
  return best?.label;
}

/** One line per earlier post for the planner, the newest month first. */
export function earlierLines(earlier: EarlierPost[], max = 36): string[] {
  return earlier.slice(0, max).map((e) => `${e.label}: ${e.title} — ${e.brief.split(/(?<=[.!?])\s+/)[0]?.slice(0, 160) ?? ""}`);
}
