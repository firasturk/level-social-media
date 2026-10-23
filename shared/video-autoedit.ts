/**
 * The automatic first cut (phase 2), extending `planAutoEdit` (shared/video-project.ts): from the
 * footage's motion energy, a purpose, a target length, a pace and (optionally) the music's beats,
 * an editable timeline. Heuristics, not AI, and deterministic: the same inputs give the same cut.
 *
 * - Pace sets the shot lengths (calm 2–6 s, balanced 1.2–3.5 s, energetic 0.8–2.5 s) and the joins
 *   (calm: 0.5 s crossfades; balanced: cuts, short crossfades for a story; energetic: cuts).
 * - Purpose sets the order and the ending: a product launch opens on the liveliest shot (the hook),
 *   keeps the rest in order and holds the last shot longer after a dip to black (room for the
 *   product name or the logo); a promo runs liveliest first; a story keeps the footage's order.
 * - Each shot is the liveliest window of its length in its clip (later rounds take the next-best,
 *   so the same seconds are not shown twice when the clip is long enough).
 * - With beats, shot lengths are whole beats, so cuts land on the grid.
 * - Speech: a clip marked "has speech" on the timeline marks those source seconds; they come back
 *   whole (never cut inside, joined by cuts so the words do not fade), and no other shot takes a
 *   window that overlaps them.
 * - Locked clips stay exactly where they are on the timeline: the planner fills the time before,
 *   between and after them; when the footage cannot fill a stretch exactly, the last shot is
 *   lengthened or shortened, and only when that is impossible a gap is left (and said).
 */
import { bestWindow, clipLength, gapClip, MAX_CLIPS, MAX_TIMELINE_SECONDS, MIN_CLIP_SECONDS, placeClips, totalLength, type AutoClipInput, type Clip, type Transition } from "./video-project";

export type Purpose = "launch" | "promo" | "story";
export type Pace = "calm" | "balanced" | "energetic";

export const PURPOSES: readonly { id: Purpose; name: string; hint: string }[] = [
  { id: "launch", name: "Product launch", hint: "Opens on the liveliest shot, ends on a held shot after a dip to black (room for the name or the logo)." },
  { id: "promo", name: "Promo", hint: "Liveliest footage first, straight cuts." },
  { id: "story", name: "Story", hint: "The footage in its order, gentle joins." },
];
export const PACES: readonly { id: Pace; name: string; shots: [number, number] }[] = [
  { id: "calm", name: "Calm", shots: [2, 6] },
  { id: "balanced", name: "Balanced", shots: [1.2, 3.5] },
  { id: "energetic", name: "Energetic", shots: [0.8, 2.5] },
];

export interface FirstCutInput extends AutoClipInput {
  /** Source seconds that carry speech (from clips marked "has speech"): used whole or not at all. */
  speech?: readonly { in: number; out: number }[];
}

export interface FirstCutOptions {
  purpose: Purpose;
  pace: Pace;
  /** Wanted length, seconds. */
  target: number;
  /** Beat times on the timeline, when music is set. */
  beats?: readonly number[];
  /** Locked clips of the current timeline and where they start: kept exactly there. */
  locked?: readonly { clip: Clip; start: number }[];
}

export interface FirstCut {
  clips: Clip[];
  /** What the planner did that the person should know (a gap left, speech kept whole). */
  notes: string[];
  /** The look it suggests when none was chosen. */
  look: string;
}

const meanEnergy = (c: AutoClipInput): number => {
  const n = c.energy.length;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += c.energy[i];
  return s / n;
};

function medianGap(beats: readonly number[]): number {
  const gaps = beats
    .slice(1)
    .map((b, i) => b - beats[i])
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - 1e-9 && b0 < a1 - 1e-9;

/** The liveliest `len`-second window of rank `rank` that does not overlap any span in `avoid`; null when none is left. */
export function windowAvoiding(c: AutoClipInput, len: number, rank: number, avoid: readonly { in: number; out: number }[]): number | null {
  if (!avoid.length) return bestWindow(c, len, rank);
  if (len > c.duration + 1e-9) return null;
  const step = c.step > 0 && c.energy.length ? c.step : 0.25;
  const n = Math.max(1, Math.floor((c.duration - len) / step + 1e-9) + 1);
  const cands: { start: number; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.min(i * step, c.duration - len);
    if (avoid.some((s) => overlaps(start, start + len, s.in, s.out))) continue;
    let score: number;
    if (c.energy.length && c.step > 0) {
      const a = Math.floor(start / c.step);
      const b = Math.max(a + 1, Math.round((start + len) / c.step));
      let sum = 0;
      for (let j = a; j < Math.min(b, c.energy.length); j++) sum += c.energy[j];
      score = sum;
    } else score = -Math.abs(start + len / 2 - c.duration / 2);
    cands.push({ start, score });
  }
  cands.sort((x, y) => y.score - x.score || x.start - y.start);
  const taken: number[] = [];
  for (const cand of cands) {
    if (taken.some((t) => Math.abs(t - cand.start) < len - 1e-9)) continue;
    taken.push(cand.start);
    if (taken.length > rank) break;
  }
  return taken.length ? taken[Math.min(rank, taken.length - 1)] : null;
}

/** A deterministic first cut; see the file's header for the rules. */
export function planFirstCut(inputs: readonly FirstCutInput[], opts: FirstCutOptions): FirstCut {
  const notes: string[] = [];
  const usable = inputs.filter((c) => c.duration >= MIN_CLIP_SECONDS);
  const look = opts.purpose === "promo" || opts.pace === "energetic" ? "punch" : "clean";
  const locked = [...(opts.locked ?? [])].sort((a, b) => a.start - b.start);
  if (!usable.length && !locked.length) return { clips: [], notes: ["There is no footage to cut."], look };
  const target = Math.min(MAX_TIMELINE_SECONDS, Math.max(1, opts.target));
  const [minShot, maxShot] = PACES.find((p) => p.id === opts.pace)?.shots ?? [2, 6];
  const join: { transition: Transition; d: number } = opts.pace === "calm" ? { transition: "crossfade", d: 0.5 } : opts.pace === "balanced" && opts.purpose === "story" ? { transition: "crossfade", d: 0.3 } : { transition: "cut", d: 0.3 };
  const beatPeriod = opts.beats && opts.beats.length > 1 ? medianGap(opts.beats) : 0;
  const floor = Math.max(MIN_CLIP_SECONDS, beatPeriod ? Math.min(beatPeriod, minShot) : minShot * 0.5);

  // The order the footage comes in.
  const byEnergy = [...usable].sort((a, b) => meanEnergy(b) - meanEnergy(a) || a.id.localeCompare(b.id));
  const ordered = opts.purpose === "promo" ? byEnergy : opts.purpose === "launch" && byEnergy.length > 1 ? [byEnergy[0], ...usable.filter((c) => c.id !== byEnergy[0].id)] : [...usable];

  // The speech segments each source must give whole, once.
  const speechLeft = new Map<string, { in: number; out: number }[]>();
  for (const c of ordered) if (c.speech?.length) speechLeft.set(c.id, [...c.speech].sort((a, b) => a.in - b.in));
  let speechKept = 0;

  let counter = 0;
  let pointer = 0;
  const rounds = new Map<string, number>();
  /** The next shot for a stretch with `rem` seconds left, or null when no source can give one. */
  const nextShot = (rem: number, isFirst: boolean): Clip | null => {
    for (let k = 0; k < ordered.length; k++) {
      const src = ordered[(pointer + k) % ordered.length];
      const transition: Transition = isFirst ? "cut" : join.transition;
      const overlap = transition === "crossfade" ? join.d : 0;
      const speech = speechLeft.get(src.id) ?? [];
      // A speech segment, whole, when it fits.
      const fit = speech.find((s) => s.out - s.in <= rem + 0.05);
      if (fit) {
        speechLeft.set(src.id, speech.filter((s) => s !== fit));
        pointer = (pointer + k + 1) % ordered.length;
        speechKept++;
        return { id: `${src.id}-${counter++}`, source: src.source, duration: src.duration, in: fit.in, out: fit.out, speed: 1, transition: "cut", transitionDuration: 0.3, speech: true };
      }
      const share = Math.min(maxShot, Math.max(minShot, rem / Math.max(1, ordered.length)));
      let len = Math.min(share, src.duration, rem + overlap);
      if (beatPeriod) len = Math.min(src.duration, Math.max(beatPeriod, Math.round(len / beatPeriod) * beatPeriod));
      if (len < MIN_CLIP_SECONDS) continue;
      const round = rounds.get(src.id) ?? 0;
      const avoid = src.speech ?? [];
      const start = windowAvoiding(src, len, round, avoid);
      if (start === null) continue;
      rounds.set(src.id, round + 1);
      pointer = (pointer + k + 1) % ordered.length;
      return { id: `${src.id}-${counter++}`, source: src.source, duration: src.duration, in: start, out: start + len, speed: 1, transition, transitionDuration: overlap || 0.3 };
    }
    return null;
  };

  /** Shots for a stretch of `len` seconds, as close to it as the footage allows. */
  const fill = (len: number, after: Clip | null, exact: boolean): Clip[] => {
    const shots: Clip[] = [];
    const lengthOf = () => (shots.length ? totalLength({ clips: after ? [after, ...shots] : shots }) - (after ? clipLength(after) : 0) : 0);
    for (let guard = 0; guard < MAX_CLIPS && len - lengthOf() >= floor; guard++) {
      const s = nextShot(len - lengthOf(), !after && shots.length === 0);
      if (!s) break;
      shots.push(s);
    }
    if (exact) {
      // Lengthen or shorten the last shot that may change so the stretch ends exactly where the locked clip starts.
      const miss = len - lengthOf();
      const last = [...shots].reverse().find((s) => !s.speech);
      if (last && Math.abs(miss) > 1e-3) {
        const out = Math.min(last.duration, Math.max(last.in + MIN_CLIP_SECONDS, last.out + miss * last.speed));
        shots[shots.indexOf(last)] = { ...last, out };
      }
      const still = len - lengthOf();
      if (still > 0.02) {
        shots.push(gapClip(still));
        notes.push(`The footage ran short before a locked clip: a ${still.toFixed(1)} s gap is left there.`);
      }
    }
    return shots;
  };

  const clips: Clip[] = [];
  let cursor = 0;
  for (const l of locked) {
    const gap = l.start - cursor;
    if (gap > 0.02) clips.push(...fill(gap, clips[clips.length - 1] ?? null, true));
    clips.push(l.clip);
    cursor = l.start + clipLength(l.clip);
  }
  if (target - cursor >= floor) clips.push(...fill(target - cursor, clips[clips.length - 1] ?? null, false));

  // The launch's ending: a dip to black into a last shot held longer.
  if (opts.purpose === "launch" && clips.length >= 2) {
    const i = clips.length - 1;
    const last = clips[i];
    if (!last.locked && !last.speech && last.source.kind !== "gap") {
      const want = Math.min(last.duration - last.in, (last.out - last.in) * 1.5);
      const held: Clip = { ...last, out: last.in + Math.max(last.out - last.in, Math.min(want, maxShot * 1.5)), transition: "dipBlack", transitionDuration: 0.6 };
      clips[i] = totalLength({ clips: [...clips.slice(0, i), held] }) <= MAX_TIMELINE_SECONDS ? held : { ...last, transition: "dipBlack", transitionDuration: 0.6 };
    }
  }

  // Locked clips back exactly on their seconds: a crossfade into or out of them, or the rounding, may have moved them a little.
  for (let pass = 0; pass < 3; pass++) {
    const placed = placeClips(clips);
    for (const l of locked) {
      const i = clips.findIndex((c) => c.id === l.clip.id);
      const delta = placed[i].start - l.start;
      if (Math.abs(delta) < 1e-3 || i === 0) continue;
      // The nearest clip before it that may change and can take the whole correction.
      for (let j = i - 1; j >= 0; j--) {
        const prev = clips[j];
        if (prev.locked || prev.speech) break;
        if (prev.source.kind === "gap") {
          if (clipLength(prev) - delta >= MIN_CLIP_SECONDS) {
            clips[j] = gapClip(clipLength(prev) - delta, prev.id);
            break;
          }
          continue;
        }
        const out = prev.out - delta * prev.speed;
        if (out >= prev.in + MIN_CLIP_SECONDS * prev.speed && out <= prev.duration + 1e-9) {
          clips[j] = { ...prev, out: Math.min(prev.duration, out) };
          break;
        }
      }
    }
  }

  // The first clip never joins a previous one.
  if (clips[0] && clips[0].transition !== "cut" && !clips[0].locked) clips[0] = { ...clips[0], transition: "cut" };
  if (speechKept) notes.push(`${speechKept} speech segment${speechKept === 1 ? "" : "s"} kept whole.`);
  if (locked.length) notes.push(`${locked.length} locked clip${locked.length === 1 ? "" : "s"} kept in place.`);
  return { clips: clips.slice(0, MAX_CLIPS), notes, look };
}
