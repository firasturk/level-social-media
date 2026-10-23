/**
 * Beats grouped into a pulse and bars (docs/video-editor.md → Edit quality). `detectBeats`
 * (shared/video-project.ts) finds onsets on a steady grid; for a busy track that grid is often the
 * eighth notes, which is too fast to cut on. Here:
 *  1. the pulse: when the grid is faster than 0.36 s (above ~167 BPM), every other tick is kept,
 *     the half whose ticks are louder (the kick and snare usually sit on the counted beats);
 *  2. the bars: four pulses to a bar, the downbeat being the phase (0–3) whose ticks are loudest on
 *     average, with a confidence (that phase's mean accent over the average of all four).
 * Accents are read from the track's energy envelope (the rise at each tick). Heuristics: a track in
 * 3/4, with a pickup or with the accent on the backbeat gets bars in the wrong place; the cut still
 * lands on a beat.
 */

/** How loud each beat lands: the largest rise of the envelope within ±40 ms of it. */
export function beatAccents(beats: readonly number[], envelope: ArrayLike<number>, hop: number): number[] {
  const r = Math.max(1, Math.round(0.04 / hop));
  return beats.map((b) => {
    const i = Math.round(b / hop);
    let best = 0;
    for (let k = Math.max(1, i - r); k <= Math.min(envelope.length - 1, i + r); k++) best = Math.max(best, envelope[k] - envelope[k - 1], envelope[k]);
    return best;
  });
}

export interface MusicGrid {
  /** The counted beats (seconds, as given: track or timeline). */
  pulse: number[];
  /** The first beat of every bar. */
  bars: number[];
  /** Seconds per pulse. */
  period: number;
  /** Beats per minute of the pulse. */
  bpm: number;
  /** 1 = no preference; 1.3 and above is a clear downbeat. */
  confidence: number;
}

const medianGap = (xs: readonly number[]) => {
  const g = xs
    .slice(1)
    .map((x, i) => x - xs[i])
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  return g.length ? g[Math.floor(g.length / 2)] : 0;
};

/** The pulse and the bars from beats and their accents (same length); see the file's header. */
export function musicGrid(beats: readonly number[], accents: readonly number[], perBar = 4): MusicGrid {
  if (beats.length < 2) return { pulse: [...beats], bars: [...beats], period: 0, bpm: 0, confidence: 1 };
  let pulse = [...beats];
  let acc = [...accents];
  let period = medianGap(pulse);
  while (period > 0 && period < 0.36 && pulse.length >= 4) {
    const even = acc.filter((_, i) => i % 2 === 0);
    const odd = acc.filter((_, i) => i % 2 === 1);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const keep = mean(odd) > mean(even) * 1.05 ? 1 : 0;
    pulse = pulse.filter((_, i) => i % 2 === keep);
    acc = acc.filter((_, i) => i % 2 === keep);
    period = medianGap(pulse);
  }
  const sums = new Array<number>(perBar).fill(0);
  const counts = new Array<number>(perBar).fill(0);
  acc.forEach((a, i) => {
    sums[i % perBar] += a;
    counts[i % perBar]++;
  });
  const means = sums.map((s, i) => s / Math.max(1, counts[i]));
  let phase = 0;
  for (let p = 1; p < perBar; p++) if (means[p] > means[phase] * 1.02) phase = p;
  const all = means.reduce((s, m) => s + m, 0) / perBar;
  const bars = pulse.filter((_, i) => i % perBar === phase);
  return { pulse, bars, period, bpm: period ? Math.round(600 / period) / 10 : 0, confidence: all > 0 ? Math.round((means[phase] / all) * 100) / 100 : 1 };
}

/**
 * Whether a track has a steady beat worth cutting on: at least eight pulses, and the envelope at the
 * pulse (±40 ms) clearly louder than half a pulse off it and than on average (speech or ambience
 * gives a grid of syllables that does not stand out). A heuristic.
 */
export function steadyBeat(grid: MusicGrid, envelope: ArrayLike<number>, hop: number): boolean {
  if (grid.pulse.length < 8 || !envelope.length || grid.period <= 0) return false;
  let mean = 0;
  for (let i = 0; i < envelope.length; i++) mean += envelope[i];
  mean /= envelope.length;
  if (mean < 1e-4) return false;
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const onBeat = avg(beatAccents(grid.pulse, envelope, hop));
  const offBeat = avg(beatAccents(grid.pulse.map((t) => t + grid.period / 2), envelope, hop));
  return onBeat > Math.max(offBeat, mean) * 1.4;
}

/** A grid with no accents known (a reopened draft whose track is not decoded yet): the pulse as above, bars from the first beat. */
export function plainGrid(beats: readonly number[], perBar = 4): MusicGrid {
  return musicGrid(beats, beats.map(() => 1), perBar);
}
