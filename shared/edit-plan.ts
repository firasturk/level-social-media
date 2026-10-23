/**
 * The auto edit, rebuilt for a sharable first cut (docs/video-editor.md → Edit quality): from what
 * the footage looks like (shared/shot-analysis.ts: quality and action per half second, the
 * footage's own cuts and fades, its movement frame by frame) and, when music is set, its pulse and
 * bars (shared/music-bars.ts), an ordinary editable timeline with a structure:
 *
 *  - **Hook**: the strongest shot first (sharp, well exposed, the most action), short.
 *  - **Build**: shots that alternate between sources, livelier toward the end, lengths varying
 *    around the pace (never the same length twice in a row).
 *  - **Payoff**: the next strongest shot, just before the end.
 *  - **End card**: a calm, clean shot held long enough to read, with a slow push in, a call to action
 *    and the logo's place (the brand kit's logo when there is one).
 *
 * The rules that make the cut look edited rather than chopped:
 *  - a shot never crosses a cut or a fade inside the footage, and never starts on a dark, blank,
 *    blown-out, blurry or shaky half second when anything better exists;
 *  - near-duplicate pictures (64-bit difference hash within 10 bits) are not shown twice;
 *  - within the stretch a shot may take, it starts and ends where the picture moves least (a cut on
 *    a still moment, not mid-gesture);
 *  - with music, cuts land on the pulse and the sections (after the hook, before the payoff, into
 *    the end card) on a bar line;
 *  - wide footage in a tall frame is panned toward its detail; footage used twice is punched in
 *    (a tighter framing), long calm shots get a slow push in;
 *  - optional, off by default: calm shots a little faster (1.25×), restrained;
 *  - locked clips stay exactly where they are; the seconds of clips marked "has speech" come back
 *    whole and no other shot overlaps them (the phase 2 rules).
 * Text: placeholder words from the purpose (the person replaces them), in English, Arabic or both.
 * Deterministic: the same footage and options give the same cut. Heuristics, not AI: nothing here
 * knows what the footage shows.
 */
import { DEFAULT_COLOUR, MAX_CLIPS, MAX_TIMELINE_SECONDS, MIN_CLIP_SECONDS, clipLength, gapClip, placeClips, type Clip, type ClipSource, type Transition, type VideoProject } from "./video-project";
import type { Framing, LogoOverlay, Overlay } from "./video-compose";
import { hamming, DUPLICATE_BITS, type FootageAnalysis, type WindowFlag, type WindowScore } from "./shot-analysis";
import type { MusicGrid } from "./music-bars";
import { hookFromPost, textOverlays, type PostWords, type TemplateLanguage, type TemplateText } from "./video-templates";
import type { Pace, Purpose } from "./video-autoedit";

export interface PlanSource {
  id: string;
  source: ClipSource;
  label: string;
  duration: number;
  /** The size the footage shows at (after rotation). */
  width: number;
  height: number;
  /** What the footage looks like; null when it could not be read (then its middle is used, plainly). */
  analysis: FootageAnalysis | null;
  /** Source seconds that carry speech: used whole or not at all. */
  speech?: readonly { in: number; out: number }[];
}

export interface PlanOptions {
  purpose: Purpose;
  pace: Pace;
  /** Wanted length, seconds. */
  target: number;
  /** The music's pulse and bars on the timeline, when music is set. */
  grid?: MusicGrid | null;
  /** Locked clips of the current timeline and where they start. */
  locked?: readonly { clip: Clip; start: number }[];
  output: { width: number; height: number };
  /** Words over the hook and on the end card (default on), in which language. */
  text?: boolean;
  language?: TemplateLanguage;
  /** The post's own words: its headline (and second line) go over the hook instead of placeholders; the brand closes a story. */
  words?: PostWords;
  logo?: { src: string; name: string } | null;
  /** Calm shots a little faster (1.25×). Off by default. */
  ramps?: boolean;
  /** Ids for clips and layers (tests pass a counter). */
  id?: () => string;
}

/** What the Auto edit panel asks for. */
export interface AutoRunOptions {
  purpose: Purpose;
  pace: Pace;
  target: number;
  /** Placeholder words over the hook and on the end card. */
  text: boolean;
  language: TemplateLanguage;
  /** Calm shots a little faster (1.25×). */
  ramps: boolean;
  /** A 9:16 Reel (1080×1920, the default) or the frame the cut already has. */
  frame: "reel" | "keep";
}

export type ShotRole = "hook" | "build" | "payoff" | "end" | "speech" | "locked" | "gap";

export interface PlannedShot {
  role: ShotRole;
  label: string;
  /** Timeline seconds of the cut that starts it. */
  at: number;
  length: number;
  in: number;
  out: number;
  quality: number;
  action: number;
  onBar: boolean;
  onBeat: boolean;
  punchIn: boolean;
}

export interface EditPlan {
  clips: Clip[];
  overlays: Overlay[];
  /** The preset it suggests when the cut has none. */
  look: { id: string; amount: number };
  /** What the auto edit did, in plain lines for the panel. */
  summary: string[];
  notes: string[];
  shots: PlannedShot[];
  /** What was left out, by reason (half seconds of footage). */
  skipped: Record<"dark" | "blank" | "soft" | "shaky" | "acrossCut" | "duplicate", number>;
}

/* ───────────── Pace ───────────── */

/** Base shot length (s), hook, end card hold, and the shortest shot, per pace. */
export const PACE_SHAPE: Record<Pace, { base: number; hook: number; end: number; min: number; join: Transition; joinD: number }> = {
  calm: { base: 3, hook: 2.2, end: 3.4, min: 1.6, join: "crossfade", joinD: 0.5 },
  balanced: { base: 1.8, hook: 1.4, end: 2.6, min: 0.9, join: "cut", joinD: 0 },
  energetic: { base: 1.05, hook: 0.9, end: 2.2, min: 0.5, join: "cut", joinD: 0 },
};
/** Lengths vary around the base in this order (never the same twice in a row). */
export const VARIATION = [1, 0.75, 1.3, 0.85, 1.45, 0.7, 1.15, 0.9];

/* ───────────── Cut times ───────────── */

export interface Slot {
  role: "hook" | "build" | "payoff" | "end" | "speech";
  start: number;
  end: number;
  onBar: boolean;
  onBeat: boolean;
  /** For a speech slot: the source and its seconds. */
  speech?: { src: string; in: number; out: number };
}

const near = (xs: readonly number[], t: number, tol: number) => xs.find((x) => Math.abs(x - t) <= tol);

/**
 * The cut times of one stretch of the timeline [start, end): the hook first when asked, the end
 * card last when asked, speech segments whole after the hook, the rest by the pace with its
 * variation. With a grid, each cut goes to the pulse nearest the wanted time (never shorter than
 * the pace's shortest shot), and the section changes (hook → build, build → payoff, payoff → end
 * card) to the nearest bar line within a pulse and a half.
 */
export function cutPlan(start: number, end: number, pace: Pace, opts: { hook: boolean; endCard: boolean; grid?: MusicGrid | null; speech?: readonly { src: string; in: number; out: number }[] }): Slot[] {
  const shape = PACE_SHAPE[pace];
  const grid = opts.grid && opts.grid.pulse.length > 1 && opts.grid.period > 0 ? opts.grid : null;
  const P = grid?.period ?? 0;
  const onBar = (t: number) => !!grid && !!near(grid.bars, t, 0.02);
  const onBeat = (t: number) => !!grid && !!near(grid.pulse, t, 0.02);
  const snap = (want: number, from: number, section: boolean, limit: number): number => {
    if (!grid) return want;
    const min = from + Math.max(MIN_CLIP_SECONDS, shape.min * 0.8);
    const ok = (x: number) => x >= min - 1e-6 && x <= limit + 1e-6;
    if (section) {
      const bars = grid.bars.filter(ok).sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
      if (bars.length && Math.abs(bars[0] - want) <= P * 1.5) return bars[0];
    }
    const beats = grid.pulse.filter(ok).sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
    return beats.length && Math.abs(beats[0] - want) <= P ? beats[0] : want;
  };
  const len = end - start;
  if (len < MIN_CLIP_SECONDS) return [];
  const slots: Slot[] = [];
  let endLen = opts.endCard ? Math.min(shape.end, Math.max(shape.min, len * 0.3)) : 0;
  let bodyEnd = end - endLen;
  if (opts.endCard && grid) {
    bodyEnd = snap(bodyEnd, start, true, end - shape.min);
    endLen = end - bodyEnd;
  }
  if (opts.endCard && len < shape.min * 2) {
    // Too short for anything but the end card.
    return [{ role: "end", start, end, onBar: onBar(start), onBeat: onBeat(start) }];
  }
  let t = start;
  let k = 0;
  const speech = [...(opts.speech ?? [])];
  const push = (role: Slot["role"], to: number, extra: Partial<Slot> = {}) => {
    slots.push({ role, start: t, end: to, onBar: onBar(t), onBeat: onBeat(t), ...extra });
    t = to;
  };
  if (opts.hook && bodyEnd - t >= shape.min) {
    const to = Math.min(bodyEnd, snap(t + shape.hook, t, true, bodyEnd));
    push("hook", bodyEnd - to < shape.min * 0.75 ? bodyEnd : to);
  }
  while (speech.length && t < bodyEnd - 1e-6) {
    const s = speech[0];
    const l = s.out - s.in;
    if (l > bodyEnd - t + 1e-6) break;
    speech.shift();
    push("speech", t + l, { speech: s });
  }
  while (t < bodyEnd - 1e-6) {
    const remaining = bodyEnd - t;
    const factor = VARIATION[k++ % VARIATION.length];
    let want = t + shape.base * factor;
    // The last shot before the end card is the payoff: a little longer, its start on a bar.
    const lastFew = remaining <= shape.base * 2.2;
    if (lastFew) want = t + Math.max(shape.base * 1.2, remaining / Math.max(1, Math.round(remaining / (shape.base * 1.2))));
    let to = Math.min(bodyEnd, snap(want, t, false, bodyEnd));
    if (bodyEnd - to < shape.min * 0.75) to = bodyEnd;
    const role: Slot["role"] = to >= bodyEnd - 1e-6 && slots.some((s) => s.role !== "payoff") ? "payoff" : "build";
    push(role, to);
  }
  if (opts.endCard && end - t > 1e-6) push("end", end);
  // Without an end card the last body shot of a stretch is plain build.
  return slots;
}

/* ───────────── Candidates ───────────── */

const HARD: WindowFlag[] = ["dark", "flat", "cut", "fade", "bright"];

interface Run {
  src: PlanSource;
  shot: number;
  a: number;
  b: number;
  soft: boolean;
}

/** Stretches of each source that a shot may take: inside one of its own shots, trimmed off the cuts, without hard-flagged half seconds or speech. */
export function usableRuns(src: PlanSource, relax = 0): Run[] {
  const an = src.analysis;
  const shots = an?.shots.length ? an.shots : [{ start: 0, end: src.duration }];
  const speech = src.speech ?? [];
  const runs: Run[] = [];
  shots.forEach((sh, si) => {
    const margin = an ? 0.12 : 0;
    let a = sh.start + (sh.start > 0 ? margin : 0);
    const end = sh.end - (sh.end < src.duration - 1e-6 ? margin : 0);
    const bad = (w: WindowScore) => w.flags.some((f) => HARD.includes(f) && (relax < 2 || f === "flat" || f === "cut" || f === "fade")) || (relax < 1 && w.flags.some((f) => f === "blurry" || f === "shaky"));
    const wins = an ? an.windows.filter((w) => w.t + an.step > a && w.t < end) : [];
    const flush = (to: number) => {
      // Speech seconds are never part of another shot.
      let pieces = [{ a, b: to }];
      for (const s of speech) pieces = pieces.flatMap((p) => (s.out <= p.a || s.in >= p.b ? [p] : [{ a: p.a, b: s.in }, { a: s.out, b: p.b }]));
      for (const p of pieces) if (p.b - p.a >= MIN_CLIP_SECONDS) runs.push({ src, shot: si, a: p.a, b: p.b, soft: relax > 0 });
    };
    for (const w of wins) {
      if (bad(w)) {
        // A cut flag at a run's edge is the footage's own cut (already trimmed): the window is only bad inside.
        const cutAtEdge = w.flags.length === 1 && w.flags[0] === "cut" && (w.t <= sh.start + 1e-6 || w.t + an!.step >= sh.end - 1e-6);
        if (cutAtEdge) continue;
        flush(Math.max(a, w.t));
        a = Math.max(a, w.t + an!.step);
      }
    }
    if (end > a) flush(end);
  });
  return runs;
}

/** The analysis's windows that a span covers. */
const covered = (an: FootageAnalysis, a: number, b: number) => an.windows.filter((w) => w.t + an.step > a + 1e-6 && w.t < b - 1e-6);

const motionRefs = new WeakMap<FootageAnalysis, number>();
/** Movement at source time t (the analysed frame nearest it), relative to the source's busiest tenth (0 … 1). */
function motionAt(an: FootageAnalysis, t: number): number {
  const m = an.motion;
  if (!m.length) return 0;
  let ref = motionRefs.get(an);
  if (ref === undefined) {
    const s = m.map((x) => x.v).sort((a, b) => a - b);
    ref = Math.max(1e-4, s[Math.floor(0.9 * (s.length - 1))]);
    motionRefs.set(an, ref);
  }
  return Math.min(1, rawMotionAt(m, t) / ref);
}

function rawMotionAt(m: FootageAnalysis["motion"], t: number): number {
  let lo = 0;
  let hi = m.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(m[lo].t - t) <= Math.abs(m[hi].t - t) ? m[lo].v : m[hi].v;
}

interface Placement {
  run: Run;
  in: number;
  out: number;
  quality: number;
  action: number;
  focus: number;
  luma: number;
  hash: string;
  textY: number | null;
  score: number;
}

/** How a role weighs a placement: quality always, action up for the hook and payoff, down for the end card, toward a demand when a reference asks. */
function roleScore(role: Slot["role"] | "match", q: number, act: number, still: number, demand: number, progress: number): number {
  switch (role) {
    case "hook":
      return q * 1.0 + act * 1.1 - still * 0.15;
    case "payoff":
      return q * 1.0 + act * 0.8 - still * 0.2;
    case "end":
      return q * 1.3 - act * 0.6 - still * 0.3;
    case "match":
      return q * 1.0 - Math.abs(act - demand) * 1.2 - still * 0.2;
    default:
      // The build rises toward the payoff.
      return q * 1.0 + act * (0.2 + 0.5 * progress) - still * 0.25;
  }
}

/* ───────────── The picker ───────────── */

interface Used {
  src: string;
  shot: number;
  in: number;
  out: number;
  hash: string;
}

class Picker {
  used: Used[] = [];
  /** The sources of the shots on either side of the slot being filled (the timeline is filled out of order). */
  neighbours = new Set<string>();
  /** Pictures passed over because another source already showed the same thing. */
  duplicateHashes = new Set<string>();
  constructor(private sources: readonly PlanSource[]) {}

  /**
   * The best placement of `len` source seconds for a role. Passes, until one gives a shot: fresh
   * footage with no soft flags; fresh footage allowing soft (blurry, shaky); footage already used,
   * a different window of it (at least half a shot from any earlier start, then a fifth), punched
   * in; at last dark or blown-out stretches (never blank ones, never across a cut).
   */
  pick(len: number, role: Slot["role"] | "match", progress: number, demand = 0.5): { p: Placement; reuse: boolean } | null {
    for (const [relax, apart] of [
      [0, 0],
      [1, 0],
      [0, 0.5],
      [1, 0.5],
      [0, 0.2],
      [1, 0.2],
      [2, 0.2],
    ] as const) {
      const p = this.best(len, role, progress, demand, relax, apart);
      if (p) {
        this.used.push({ src: p.run.src.id, shot: p.run.shot, in: p.in, out: p.out, hash: p.hash });
        return { p, reuse: apart > 0 };
      }
    }
    return null;
  }

  /** `apart` 0: fresh seconds only; above 0: footage may be reused, its start at least that many shot lengths from an earlier one. */
  private best(len: number, role: Slot["role"] | "match", progress: number, demand: number, relax: number, apart: number): Placement | null {
    const reuse = apart > 0;
    let best: Placement | null = null;
    for (const src of this.sources) {
      const an = src.analysis;
      for (const run of usableRuns(src, relax)) {
        if (run.b - run.a < len - 1e-6) continue;
        const stepT = 0.1;
        const n = Math.max(1, Math.floor((run.b - run.a - len) / stepT + 1e-6) + 1);
        for (let i = 0; i < n; i++) {
          const a = Math.min(run.a + i * stepT, run.b - len);
          const b = a + len;
          const mine = this.used.filter((u) => u.src === src.id);
          const overlap = mine.some((u) => a < u.out - 1e-6 && u.in < b - 1e-6);
          if (overlap && !reuse) continue;
          // A reuse still never repeats the same seconds closely.
          if (reuse && mine.some((u) => Math.abs(u.in - a) < len * apart - 1e-6)) continue;
          let q = 0.5;
          let act = 0.3;
          let focus = 0.5;
          let luma = 0.4;
          let hash = `${src.id}:${a.toFixed(1)}`;
          let textY: number | null = null;
          let still = 0;
          if (an) {
            const ws = covered(an, a, b);
            if (!ws.length) continue;
            q = ws.reduce((s, w) => s + w.quality, 0) / ws.length;
            act = ws.reduce((s, w) => s + w.action, 0) / ws.length;
            focus = ws.reduce((s, w) => s + w.focus, 0) / ws.length;
            luma = ws.reduce((s, w) => s + w.luma, 0) / ws.length;
            const mid = ws[Math.floor(ws.length / 2)];
            hash = mid.hash;
            textY = mid.textY;
            still = (motionAt(an, a) + motionAt(an, b)) / 2;
          }
          // Near-duplicates of a picture already shown are left out (a reuse of the same shot is punched in instead).
          if (!reuse && an) {
            const twin = this.used.find((u) => hamming(u.hash, hash) <= DUPLICATE_BITS);
            if (twin) {
              if (twin.src !== src.id || twin.shot !== run.shot) this.duplicateHashes.add(hash);
              continue;
            }
          }
          let score = roleScore(role, q, act, still, demand, progress);
          if (this.neighbours.has(src.id)) score -= 0.25;
          // Variety: each earlier use of the same footage counts against it, more so the same shot of it.
          score -= 0.12 * mine.length + 0.15 * mine.filter((u) => u.shot === run.shot).length;
          // Footage with words already burned in competes with the cut's own text.
          if (textY !== null) score -= 0.15;
          if (reuse) score -= 0.3;
          if (relax) score -= 0.2 * relax;
          if (!best || score > best.score + 1e-9) best = { run, in: round6(a), out: round6(b), quality: q, action: act, focus, luma, hash, textY, score };
        }
      }
    }
    return best;
  }
}

/** How many half seconds each reason left out across the footage (for the summary). */
function skippedOf(sources: readonly PlanSource[]): EditPlan["skipped"] {
  const out = { dark: 0, blank: 0, soft: 0, shaky: 0, acrossCut: 0, duplicate: 0 };
  for (const s of sources) {
    for (const w of s.analysis?.windows ?? []) {
      if (w.flags.includes("cut") || w.flags.includes("fade")) out.acrossCut++;
      else if (w.flags.includes("flat") || w.flags.includes("bright")) out.blank++;
      else if (w.flags.includes("dark")) out.dark++;
      else if (w.flags.includes("blurry")) out.soft++;
      else if (w.flags.includes("shaky")) out.shaky++;
    }
  }
  return out;
}

/* ───────────── Framing ───────────── */

/** The pan (−1 … 1) that keeps the detail at `focus` (0 … 1 across the source) in a Fill crop of this frame, damped a little. */
export function panFor(focus: number, src: { width: number; height: number }, out: { width: number; height: number }, zoom = 1): number {
  const scale = Math.max(out.width / Math.max(1, src.width), out.height / Math.max(1, src.height)) * zoom;
  const visible = out.width / (src.width * scale);
  if (visible >= 0.95) return 0;
  const p = (focus - 0.5) / ((1 - visible) / 2);
  return round3(Math.max(-1, Math.min(1, p * 0.85)));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/* ───────────── Words ───────────── */

const ARABIC = /[\u0600-\u06FF]/;


/** Placeholder words per purpose: an opening line over the hook and a call to action on the end card. */
export const PURPOSE_TEXT: Record<Purpose, { hook: TemplateText; end: TemplateText; look: { id: string; amount: number } }> = {
  launch: {
    hook: { role: "headline", en: "NEW", ar: "جديد", from: 0, to: 0, x: 0.5, y: 0.2, size: 0.085, font: "display", weight: 800, color: "#ffffff", box: null },
    end: { role: "cta", en: "Available now", ar: "متوفر الآن", from: 0, to: 0, x: 0.5, y: 0.78, size: 0.055, font: "sans", weight: 800, color: "#111111", box: "#ffffff" },
    look: { id: "cool-editorial", amount: 0.6 },
  },
  promo: {
    hook: { role: "offer", en: "LIMITED OFFER", ar: "عرض لفترة محدودة", from: 0, to: 0, x: 0.5, y: 0.2, size: 0.07, font: "display", weight: 800, color: "#ffffff", box: "#d1202f" },
    end: { role: "cta", en: "Shop now", ar: "تسوّق الآن", from: 0, to: 0, x: 0.5, y: 0.78, size: 0.055, font: "sans", weight: 800, color: "#ffffff", box: "#d1202f" },
    look: { id: "bold-sport", amount: 0.5 },
  },
  story: {
    hook: { role: "headline", en: "Our story", ar: "قصتنا", from: 0, to: 0, x: 0.5, y: 0.2, size: 0.06, font: "serif", weight: 600, color: "#ffffff", box: null },
    end: { role: "headline", en: "Brand name", ar: "اسم العلامة", from: 0, to: 0, x: 0.5, y: 0.78, size: 0.06, font: "serif", weight: 600, color: "#ffffff", box: null },
    look: { id: "warm-film", amount: 0.5 },
  },
};

/* ───────────── The plan ───────────── */

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** A deterministic first cut; see the file's header for the rules. */
export function planEdit(sources: readonly PlanSource[], opts: PlanOptions): EditPlan {
  let counter = 0;
  const nextId = opts.id ?? (() => String(++counter));
  const usable = sources.filter((s) => s.duration >= MIN_CLIP_SECONDS);
  const locked = [...(opts.locked ?? [])].sort((a, b) => a.start - b.start);
  const purposeText = PURPOSE_TEXT[opts.purpose];
  const empty: EditPlan = { clips: [], overlays: [], look: purposeText.look, summary: [], notes: ["There is no footage to cut."], shots: [], skipped: skippedOf(sources) };
  if (!usable.length && !locked.length) return empty;
  const shape = PACE_SHAPE[opts.pace];
  let target = Math.min(MAX_TIMELINE_SECONDS, Math.max(2, opts.target));
  const grid = opts.grid && opts.grid.pulse.length > 1 ? opts.grid : null;
  if (grid) {
    // The cut ends on a pulse (a bar when one is within a pulse), so the music's phrase closes with it.
    const bar = near(grid.bars, target, grid.period);
    const beat = near(grid.pulse, target, grid.period * 0.6);
    const end = bar ?? beat;
    if (end && end >= 2 && end <= MAX_TIMELINE_SECONDS) target = end;
  }

  // The stretches between locked clips.
  const stretches: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const l of locked) {
    if (l.start - cursor > 1e-3) stretches.push({ start: cursor, end: l.start });
    cursor = l.start + clipLength(l.clip);
  }
  if (target - cursor > 1e-3) stretches.push({ start: cursor, end: target });
  const speechAll = usable.flatMap((s) => (s.speech ?? []).map((sp) => ({ src: s.id, in: sp.in, out: sp.out })));
  const plans: Slot[][] = stretches.map((st, i) =>
    cutPlan(st.start, st.end, opts.pace, { hook: i === 0 && st.start < 1e-3, endCard: i === stretches.length - 1 && st.end >= target - 1e-3, grid, speech: i === 0 ? speechAll : [] }),
  );
  const notes: string[] = [];
  const placedSpeech = plans.flat().filter((s) => s.role === "speech").length;
  if (placedSpeech < speechAll.length) notes.push(`${speechAll.length - placedSpeech} speech segment${speechAll.length - placedSpeech === 1 ? " is" : "s are"} longer than the room before the end card and ${speechAll.length - placedSpeech === 1 ? "was" : "were"} left out.`);

  // Fill the slots: the hook first, then the end card, the payoff, and the build in order.
  const picker = new Picker(usable);
  const filled = new Map<Slot, { clip: Clip; shot: PlannedShot }>();
  const all = plans.flat();
  const order = [...all.filter((s) => s.role === "hook"), ...all.filter((s) => s.role === "end"), ...all.filter((s) => s.role === "payoff"), ...all.filter((s) => s.role === "speech"), ...all.filter((s) => s.role === "build")];
  const builds = all.filter((s) => s.role === "build");
  const joinOf = (slot: Slot): { transition: Transition; d: number } => {
    const first = slot.start < 1e-3 || locked.some((l) => Math.abs(l.start + clipLength(l.clip) - slot.start) < 1e-3);
    if (first || slot.role === "speech") return { transition: "cut", d: 0.3 };
    if (slot.role === "end" && opts.pace !== "energetic") return { transition: "crossfade", d: 0.4 };
    return { transition: shape.join, d: shape.joinD || 0.3 };
  };
  // Each slot's crossfade halves: its own join's (before the cut that starts it) and the next one's (after the cut that ends it).
  const halves = new Map<Slot, { in: number; out: number }>();
  for (const [si, st] of stretches.entries()) {
    const list = plans[si];
    const after = locked.find((l) => Math.abs(l.start - st.end) < 1e-3);
    list.forEach((slot, i) => {
      const own = joinOf(slot);
      const next = list[i + 1];
      const nextJoin = next ? joinOf(next) : null;
      const hIn = own.transition === "crossfade" ? own.d / 2 : 0;
      // A locked clip that crossfades in takes its whole overlap from the shot before it, so it stays on its second.
      const hOut = next ? (nextJoin!.transition === "crossfade" && next.role !== "speech" ? nextJoin!.d / 2 : 0) : after && after.clip.transition === "crossfade" ? after.clip.transitionDuration : 0;
      halves.set(slot, { in: hIn, out: hOut });
    });
  }
  const reused = new Set<string>();
  let punches = 0;
  for (const slot of order) {
    const len = slot.end - slot.start;
    const join = joinOf(slot);
    if (slot.role === "speech" && slot.speech) {
      const src = usable.find((s) => s.id === slot.speech!.src)!;
      const clip: Clip = { id: `c${nextId()}`, source: src.source, duration: src.duration, in: slot.speech.in, out: slot.speech.out, speed: 1, transition: "cut", transitionDuration: 0.3, speech: true };
      filled.set(slot, { clip, shot: { role: "speech", label: src.label, at: slot.start, length: len, in: clip.in, out: clip.out, quality: 1, action: 0, onBar: slot.onBar, onBeat: slot.onBeat, punchIn: false } });
      picker.used.push({ src: src.id, shot: -1, in: clip.in, out: clip.out, hash: "speech" });
      continue;
    }
    // A crossfade takes half its length from each side of the cut, so the cut's middle stays on the planned time.
    const h = halves.get(slot) ?? { in: 0, out: 0 };
    const tl = len + h.in + h.out;
    const ramp = !!opts.ramps && slot.role === "build";
    const progress = builds.length > 1 ? builds.indexOf(slot) / (builds.length - 1) : 0.5;
    const need = tl * (ramp ? 1.25 : 1);
    const idx = all.indexOf(slot);
    const srcOf = (sl: Slot | undefined) => (sl ? filled.get(sl)?.clip.source : undefined);
    picker.neighbours = new Set(
      [srcOf(all[idx - 1]), srcOf(all[idx + 1])]
        .filter((x): x is ClipSource => !!x)
        .map((x) => usable.find((u) => JSON.stringify(u.source) === JSON.stringify(x))?.id ?? ""),
    );
    const got = picker.pick(need, slot.role, progress);
    if (!got) {
      filled.set(slot, { clip: { ...gapClip(tl, `c${nextId()}`), transition: join.transition, transitionDuration: join.d }, shot: { role: "gap", label: "gap", at: slot.start, length: len, in: 0, out: len, quality: 0, action: 0, onBar: slot.onBar, onBeat: slot.onBeat, punchIn: false } });
      notes.push(`The footage ran out at ${fmt(slot.start)}: a ${len.toFixed(1)} s gap is left there.`);
      continue;
    }
    const { p, reuse } = got;
    let speed = 1;
    if (ramp && p.action < 0.35) speed = 1.25;
    const srcLen = tl * speed;
    const src = p.run.src;
    const key = `${src.id}:${p.run.shot}`;
    const punchIn = reuse || reused.has(key);
    reused.add(key);
    if (punchIn) punches++;
    const zoom = punchIn ? (punches % 2 ? 1.35 : 1.2) : slot.role === "end" ? 1.04 : 1;
    const framing: Framing = { fit: "fill", zoom, x: panFor(p.focus, src, opts.output, zoom), y: 0 };
    let clip: Clip = { id: `c${nextId()}`, source: src.source, duration: src.duration, in: p.in, out: round6(Math.min(src.duration, p.in + srcLen)), speed, transition: join.transition, transitionDuration: join.d, framing };
    // A slow push in on the end card and on long calm shots.
    if (slot.role === "end" || (tl >= 1.8 && p.action < 0.35)) clip.keyframes = { zoom: [{ t: 0, v: zoom, ease: "linear" }, { t: round3(tl), v: round3(Math.min(4, zoom + (slot.role === "end" ? 0.08 : 0.05))), ease: "easeOut" }] };
    // Dark footage brightened a little (half a stop at most); the person can undo it under Colour.
    if (p.luma < 0.26) clip = { ...clip, colour: { ...DEFAULT_COLOUR, exposure: round3(Math.min(0.5, (0.36 - p.luma) * 2.5)) } };
    filled.set(slot, { clip, shot: { role: slot.role, label: src.label, at: slot.start, length: len, in: clip.in, out: clip.out, quality: round3(p.quality), action: round3(p.action), onBar: slot.onBar, onBeat: slot.onBeat, punchIn } });
  }

  // The timeline: the stretches' shots in order with the locked clips between them.
  const clips: Clip[] = [];
  const shots: PlannedShot[] = [];
  let li = 0;
  for (const [si, st] of stretches.entries()) {
    while (li < locked.length && locked[li].start < st.start - 1e-6) {
      clips.push(locked[li].clip);
      shots.push({ role: "locked", label: "locked clip", at: locked[li].start, length: clipLength(locked[li].clip), in: locked[li].clip.in, out: locked[li].clip.out, quality: 1, action: 0, onBar: false, onBeat: false, punchIn: false });
      li++;
    }
    for (const slot of plans[si]) {
      const f = filled.get(slot)!;
      clips.push(f.clip);
      shots.push(f.shot);
    }
  }
  while (li < locked.length) {
    clips.push(locked[li].clip);
    shots.push({ role: "locked", label: "locked clip", at: locked[li].start, length: clipLength(locked[li].clip), in: locked[li].clip.in, out: locked[li].clip.out, quality: 1, action: 0, onBar: false, onBeat: false, punchIn: false });
    li++;
  }
  // A crossfade after speech (which comes back whole, not a frame longer) becomes a cut, its own half trimmed off.
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i];
    const prev = clips[i - 1];
    if (c.transition !== "crossfade" || c.locked || !prev.speech) continue;
    const half = c.transitionDuration / 2;
    clips[i] = { ...c, transition: "cut", in: round6(c.in + half * c.speed) };
    if (c.keyframes?.zoom) clips[i].keyframes = { zoom: c.keyframes.zoom.map((k, j) => (j ? { ...k, t: round3(Math.max(0, k.t - half)) } : k)) };
  }
  if (clips[0] && !clips[0].locked) clips[0] = { ...clips[0], transition: "cut" };

  // Words: the opening line over the hook, the call to action (and the logo) on the end card.
  const overlays: Overlay[] = [];
  const aspect = opts.output.width / Math.max(1, opts.output.height);
  const placed = placeClips(clips);
  const hookAt = shots.findIndex((s) => s.role === "hook");
  const endAt = shots.findIndex((s) => s.role === "end");
  const language = opts.language ?? "both";
  const own = hookFromPost(purposeText.hook, opts.words, language);
  const hookText = own?.tx ?? purposeText.hook;
  const brand = opts.words?.brand?.trim();
  // A story ends on the brand's name when it is known; launch and promo end on their call to action.
  const endText = opts.purpose === "story" && brand ? { ...purposeText.end, en: brand, ar: brand } : purposeText.end;
  if (opts.text !== false) {
    if (hookAt >= 0) overlays.push(...textOverlays(hookText, placed[hookAt].start + 0.1, placed[hookAt].end, own?.language ?? language, aspect, nextId));
    if (endAt >= 0) overlays.push(...textOverlays(endText, placed[endAt].start + 0.3, placed[endAt].end, endText === purposeText.end ? language : ARABIC.test(brand ?? "") ? "ar" : "en", aspect, nextId));
  }
  if (endAt >= 0 && opts.logo?.src) {
    const l: LogoOverlay = { id: `o${nextId()}`, kind: "logo", src: opts.logo.src, name: opts.logo.name || "Logo", start: round3(placed[endAt].start + 0.2), end: round3(placed[endAt].end), x: 0.5, y: 0.12, width: 0.26, opacity: 1 };
    overlays.push(l);
  }

  // The summary, in plain words.
  const skipped = skippedOf(sources);
  skipped.duplicate = picker.duplicateHashes.size;
  const content = shots.filter((s) => s.role !== "locked" && s.role !== "gap");
  const total = placed.length ? placed[placed.length - 1].end : 0;
  const summary: string[] = [];
  const hook = shots[hookAt];
  if (hook) summary.push(`Hook: ${hook.label} at ${fmt(hook.in)}, ${hook.length.toFixed(1)} s (the sharpest, liveliest moment found).`);
  const lens = content.map((s) => s.length);
  if (lens.length) {
    const cuts = shots.slice(1);
    const onBar = cuts.filter((s) => s.onBar).length;
    const onBeat = cuts.filter((s) => s.onBeat).length;
    const rhythm = grid ? `cuts on the beat (${onBeat} of ${cuts.length}), ${onBar} on the bar, ${Math.round(grid.bpm)} BPM` : "cut where the picture is still, not mid-movement";
    summary.push(`${shots.length} shots of ${Math.min(...lens).toFixed(1)}–${Math.max(...lens).toFixed(1)} s, ${total.toFixed(1)} s in all; ${rhythm}.`);
  }
  const payoff = shots.find((s) => s.role === "payoff");
  if (payoff) summary.push(`Payoff: ${payoff.label} at ${fmt(payoff.in)} before the end.`);
  const end = shots[endAt];
  if (end) summary.push(`Ends on ${end.label} held ${end.length.toFixed(1)} s with a slow push in, ${opts.logo?.src ? "the logo" : "room for the logo (add it under Logo)"} and the call to action.`);
  const left = [skipped.dark && `${skipped.dark} dark`, skipped.blank && `${skipped.blank} blank or blown-out`, skipped.soft && `${skipped.soft} blurry`, skipped.shaky && `${skipped.shaky} shaky`, skipped.acrossCut && `${skipped.acrossCut} across a cut or fade in the footage`].filter(Boolean);
  if (left.length) summary.push(`Left out (half seconds): ${left.join(", ")}.`);
  if (punches) summary.push(`${punches} reused shot${punches === 1 ? " is" : "s are"} punched in so ${punches === 1 ? "it reads" : "they read"} as new angles.`);
  const brightened = clips.filter((c) => c.colour && c.colour.exposure > 0).length;
  if (opts.text !== false) {
    const hookLine = own ? `the post's headline “${own.language === "ar" ? hookText.ar : hookText.en}”` : `“${purposeText.hook.en}”`;
    const endLine = `“${endText.en}”`;
    const tail = own ? "." : ": placeholders to replace (the post has no headline yet).";
    summary.push(`Text: ${hookAt >= 0 ? `${hookLine} over the hook` : ""}${hookAt >= 0 && endAt >= 0 ? " and " : ""}${endAt >= 0 ? `${endLine} on the end card` : ""}${tail}`);
  }
  if (brightened) summary.push(`${brightened} dark shot${brightened === 1 ? "" : "s"} brightened a little (Colour → the clip's exposure).`);
  if (speechAll.length) summary.push(`${placedSpeech} speech segment${placedSpeech === 1 ? "" : "s"} kept whole.`);
  if (locked.length) summary.push(`${locked.length} locked clip${locked.length === 1 ? "" : "s"} kept in place.`);
  return { clips: clips.slice(0, MAX_CLIPS), overlays, look: purposeText.look, summary, notes, shots, skipped };
}

/* ───────────── Slots from a reference ───────────── */

export interface MatchSlot {
  /** Timeline seconds. */
  duration: number;
  /** How much happens in the reference's shot, 0 … 1 (relative to the reference's busiest). */
  action: number;
}

export interface SlotFill {
  source: ClipSource;
  label: string;
  duration: number;
  in: number;
  out: number;
  framing: Framing;
  quality: number;
  action: number;
}

/**
 * The footage for each slot of a template read from a reference: the slots and the candidate
 * shots are both ranked (the slots by the reference's action, the footage by its own), and each
 * slot gets the unused placement whose action is closest to what the reference shot had, among the
 * good ones (quality first), never crossing the footage's own cuts, never a near-duplicate; the
 * busiest slots choose first. A slot nothing fits gets null (a gap of its length).
 */
export function fillSlots(sources: readonly PlanSource[], slots: readonly MatchSlot[], output: { width: number; height: number }): (SlotFill | null)[] {
  const usable = sources.filter((s) => s.duration >= MIN_CLIP_SECONDS);
  const picker = new Picker(usable);
  // The footage's own action is relative to each source; spread the slots' demand over the same 0 … 1.
  const acts = slots.map((s) => s.action);
  const lo = Math.min(...acts, 0);
  const hi = Math.max(...acts, 1e-6);
  const demand = acts.map((a) => (hi - lo > 1e-6 ? (a - lo) / (hi - lo) : 0.5));
  const order = slots.map((_, i) => i).sort((a, b) => demand[b] - demand[a] || a - b);
  const out: (SlotFill | null)[] = slots.map(() => null);
  const idOf = (f: SlotFill | null | undefined) => (f ? (usable.find((u) => JSON.stringify(u.source) === JSON.stringify(f.source))?.id ?? "") : "");
  for (const i of order) {
    picker.neighbours = new Set([idOf(out[i - 1]), idOf(out[i + 1])].filter(Boolean));
    const got = picker.pick(slots[i].duration, "match", 0.5, demand[i]);
    if (!got) continue;
    const { p, reuse } = got;
    const zoom = reuse ? 1.3 : 1;
    out[i] = { source: p.run.src.source, label: p.run.src.label, duration: p.run.src.duration, in: p.in, out: p.out, framing: { fit: "fill", zoom, x: panFor(p.focus, p.run.src, output, zoom), y: 0 }, quality: round3(p.quality), action: round3(p.action) };
  }
  return out;
}

/**
 * The plan put on the project, as one undoable step: the new timeline; the placeholder words and
 * logo unless the cut already has text (the person's words are kept); the purpose's preset when the
 * cut has none; and the summary, kept with the draft so a reopen still says what the auto edit did.
 */
export function withEditPlan(p: VideoProject, plan: EditPlan, meta: { purpose: Purpose; pace: Pace; at: number; output?: VideoProject["output"] }): VideoProject {
  const hasText = p.overlays.some((o) => o.kind === "text");
  const overlays = hasText ? p.overlays : [...p.overlays.filter((o) => !(o.kind === "logo" && plan.overlays.some((x) => x.kind === "logo"))), ...plan.overlays];
  const look = p.look === "none" ? { look: plan.look.id, lookAmount: plan.look.amount } : {};
  const summary = hasText ? [...plan.summary.filter((l) => !l.startsWith("Text:")), "Text: the cut's own words were kept (no placeholders added)."] : plan.summary;
  return { ...p, ...(meta.output ? { output: meta.output } : {}), clips: plan.clips, overlays, ...look, edit: { purpose: meta.purpose, pace: meta.pace, summary: summary.slice(0, 16).map((l) => l.slice(0, 400)), at: meta.at } };
}
