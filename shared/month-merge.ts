/**
 * A month is stored as one block (plan, words, settings, the client's answers). Two writers that
 * each read it, changed their part and wrote it back used to erase each other's work: a long engine
 * pass wrote its minutes-old copy over an edit saved meanwhile, a caption written by the server
 * was lost to a save from the page, a client's approval vanished under a plan save.
 *
 * These pure functions merge instead: given the copy a writer started from (`base`), what it wants
 * to write (`mine`) and what the database holds now (`theirs`), every part the writer did not touch
 * keeps the database's value, and every part it changed is written. When both changed the same
 * field of the same post, the writer that saves last wins that one field only.
 */

type Json = unknown;
type Obj = Record<string, Json>;

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep equality of JSON values; object key order does not matter, `undefined` equals a missing key. */
export function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameJson(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const x = a[k];
      const y = b[k];
      if (x === undefined && y === undefined) continue;
      if (x === undefined || y === undefined) return false;
      if (!sameJson(x, y)) return false;
    }
    return true;
  }
  return false;
}

/**
 * One object merged key by key: a key the writer left as it was in `base` takes the database's
 * value (or disappears with it); a key the writer changed, added or removed is the writer's.
 */
export function mergeKeys<T extends object>(base: T | undefined, mine: T, theirs: T | undefined, deeper?: (key: string, base: Json, mine: Json, theirs: Json) => Json | undefined): T {
  const b = (base ?? {}) as Obj;
  const m = mine as Obj;
  const t = (theirs ?? {}) as Obj;
  const out: Obj = {};
  // The writer's key order first, then what only the database has.
  for (const k of [...Object.keys(m), ...Object.keys(t).filter((k) => !(k in m))]) {
    const mineChanged = !sameJson(m[k], b[k]);
    const theirsChanged = !sameJson(t[k], b[k]);
    let v: Json;
    if (!mineChanged) v = t[k];
    else if (!theirsChanged) v = m[k];
    else v = deeper?.(k, b[k], m[k], t[k]) ?? m[k];
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

interface Numbered {
  index: number;
}

/**
 * The plan merged post by post (posts are known by their number):
 * - a post the writer did not touch is the database's (with whatever was changed there since);
 * - a post the writer changed is merged field by field, so a caption written by someone else on the
 *   same post survives an edit of its headline;
 * - a post added by someone else since the writer read the month is kept;
 * - a post the writer removed stays removed; a post removed by someone else stays removed unless
 *   the writer changed it meanwhile (work is never thrown away silently).
 * The writer's order is kept; posts it never saw follow in number order.
 */
export function mergePlan<P extends Numbered>(base: P[] | undefined, mine: P[] | undefined, theirs: P[] | undefined): P[] {
  const b = new Map((base ?? []).map((p) => [p.index, p]));
  const t = new Map((theirs ?? []).map((p) => [p.index, p]));
  const seen = new Set<number>();
  const out: P[] = [];
  for (const m of mine ?? []) {
    seen.add(m.index);
    const bp = b.get(m.index);
    const tp = t.get(m.index);
    if (!tp) {
      // Gone from the database: removed by someone else, unless it is the writer's own new post or the writer changed it.
      if (!bp || !sameJson(m, bp)) out.push(m);
      continue;
    }
    if (!bp) out.push(m);
    else if (sameJson(m, bp)) out.push(tp);
    else if (sameJson(tp, bp)) out.push(m);
    else out.push(mergeKeys(bp, m, tp));
  }
  const added = [...t.values()].filter((p) => !seen.has(p.index) && !b.has(p.index)).sort((x, y) => x.index - y.index);
  return [...out, ...added];
}

/**
 * The whole month merged: the plan post by post, the client's answers post by post, every other
 * setting as one value (an unchanged setting keeps the database's value).
 */
export function mergeMonth<C extends object>(base: C, mine: C, theirs: C): C {
  return mergeKeys(base, mine, theirs, (key, b, m, t) => {
    if (key === "plan" && Array.isArray(m) && Array.isArray(t)) return mergePlan(Array.isArray(b) ? (b as Numbered[]) : [], m as Numbered[], t as Numbered[]);
    if (key === "approvals" && isObj(m) && isObj(t)) return mergeKeys(isObj(b) ? b : {}, m, t);
    return undefined;
  });
}

/** Do two copies describe the same post (and not whatever post holds that number now)? */
export function samePost(a: { title?: string; brief?: string; ideaAt?: number }, b: { title?: string; brief?: string; ideaAt?: number }): boolean {
  return (!!a.title && a.title === b.title) || (!!a.brief && a.brief === b.brief) || (!!a.ideaAt && a.ideaAt === b.ideaAt);
}
