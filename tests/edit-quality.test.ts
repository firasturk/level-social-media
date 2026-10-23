/**
 * Edit quality (docs/video-editor.md → Edit quality), without a browser: the frame measures (focus,
 * hash, histogram, camera shift, zoom, text band), shot boundaries on synthetic sequences (cuts,
 * a handheld shot that must not cut itself, a dissolve), the window scores and their flags, the
 * pulse and bars of a beat grid, the structure planner (hook, build, payoff, end card; cuts on the
 * pulse and sections on the bar; footage's own cuts, dark and blank stretches and near-duplicates
 * avoided; locks and speech kept; determinism), the reference read into a template, the mapping of
 * footage onto its slots, the shot-by-shot comparison, and the document's 3 → 4 migration.
 */
import { describe, expect, it } from "vitest";
import { analyseFootage, cameraMotion, colourHistogram, dHash, detectBoundaries, focusOf, frameFeatures, greyOf, hamming, histDistance, laplacianVariance, linkFrames, scoreWindows, motionSeries, shotsFrom, textBandOf, zoomHint, type FootageAnalysis, type FrameFeatures, type WindowScore } from "../shared/shot-analysis";
import { beatAccents, musicGrid, plainGrid, steadyBeat, type MusicGrid } from "../shared/music-bars";
import { cutPlan, fillSlots, panFor, planEdit, usableRuns, withEditPlan, PACE_SHAPE, type PlanSource } from "../shared/edit-plan";
import { analyseReference, checkReference, compareTimings, templateFromReference, type ReferenceAnalysis } from "../shared/reference-template";
import { applyTemplate } from "../shared/video-templates";
import { clipLength, cutTimes, migrateProject, newClip, newProject, placeClips, PROJECT_VERSION, totalLength, validateProject, type Clip } from "../shared/video-project";
import { newTextOverlay } from "../shared/video-compose";

const W = 64;
const H = 36;

/** A deterministic pseudo-random generator. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A textured picture: a base colour, a pattern of blobs that depends on `seed`, moved by (ox, oy) pixels, scaled by `zoom` about the centre, plus grain. */
function picture(opts: { colour: [number, number, number]; seed: number; ox?: number; oy?: number; zoom?: number; grain?: number; flat?: boolean; blur?: boolean; brightness?: number; noiseSeed?: number; phase?: number }): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  const r = rng(opts.seed);
  const blobs = Array.from({ length: 9 }, () => ({ x: r() * W * 1.4 - W * 0.2, y: r() * H * 1.4 - H * 0.2, s: 3 + r() * 7, v: r() * 2 - 1 }));
  const n = rng(opts.noiseSeed ?? 7);
  const z = opts.zoom ?? 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = (x - W / 2) / z + W / 2 - (opts.ox ?? 0);
      const sy = (y - H / 2) / z + H / 2 - (opts.oy ?? 0);
      let v = 0;
      if (!opts.flat) {
        // `phase` moves each blob its own way (a subject moving, not the camera).
        const ph = opts.phase ?? 0;
        for (const b of blobs) v += b.v * Math.exp(-((sx - b.x - ph * b.v * 4) ** 2 + (sy - b.y - ph * (b.s - 6)) ** 2) / (2 * b.s * b.s));
        // Fine detail (sharp edges), unless blurred.
        if (!opts.blur) v += ((Math.floor(sx / 3) + Math.floor(sy / 3)) % 2 ? 0.25 : -0.25) * (Math.sin(sx * 0.3 + opts.seed) > 0 ? 1 : 0.2);
      }
      const k = opts.brightness ?? 1;
      const g = (n() - 0.5) * (opts.grain ?? 6);
      for (let c = 0; c < 3; c++) px[(y * W + x) * 4 + c] = Math.max(0, Math.min(255, (opts.colour[c] + v * 70) * k + g));
      px[(y * W + x) * 4 + 3] = 255;
    }
  return px;
}

const feats = (t: number, px: Uint8ClampedArray) => frameFeatures(t, px, W, H);

/** A sequence of shots at `fps`: each a picture moving by `move` px per frame (and jittering by `shake` px). */
function sequence(shots: { frames: number; colour: [number, number, number]; seed: number; move?: number; shake?: number; zoomRate?: number; brightness?: number; flat?: boolean; blur?: boolean; animate?: number }[], fps = 10): FrameFeatures[] {
  const out: FrameFeatures[] = [];
  let i = 0;
  shots.forEach((s, si) => {
    const j = rng(100 + si);
    for (let f = 0; f < s.frames; f++) {
      const sh = s.shake ?? 0;
      const ox = (s.move ?? 0) * f + (sh ? (j() - 0.5) * 2 * sh : 0);
      const oy = sh ? (j() - 0.5) * 2 * sh : 0;
      out.push(feats(i / fps, picture({ colour: s.colour, seed: s.seed, ox, oy, zoom: Math.pow(1 + (s.zoomRate ?? 0), f), brightness: s.brightness, flat: s.flat, blur: s.blur, noiseSeed: i + 1, phase: (s.animate ?? 0) * f })));
      i++;
    }
  });
  return out;
}

describe("frame measures", () => {
  it("scores a sharp picture above the same picture blurred (variance of the Laplacian)", () => {
    const sharp = greyOf(picture({ colour: [120, 120, 120], seed: 3, grain: 0 }), W, H);
    const soft = greyOf(picture({ colour: [120, 120, 120], seed: 3, grain: 0, blur: true }), W, H);
    expect(laplacianVariance(sharp, W, H)).toBeGreaterThan(laplacianVariance(soft, W, H) * 4);
    expect(laplacianVariance(new Float32Array(W * H).fill(0.5), W, H)).toBe(0);
  });

  it("hashes the same picture alike under grain and a different picture far apart", () => {
    const a = dHash(greyOf(picture({ colour: [100, 140, 90], seed: 5, noiseSeed: 1 }), W, H), W, H);
    const b = dHash(greyOf(picture({ colour: [100, 140, 90], seed: 5, noiseSeed: 2 }), W, H), W, H);
    const c = dHash(greyOf(picture({ colour: [100, 140, 90], seed: 9 }), W, H), W, H);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(a, a)).toBe(0);
    expect(hamming(a, b)).toBeLessThanOrEqual(10);
    expect(hamming(a, c)).toBeGreaterThan(14);
  });

  it("measures colour histograms: same colours 0, nothing in common 1", () => {
    const red = colourHistogram(picture({ colour: [230, 20, 20], seed: 1, flat: true, grain: 0 }), W, H);
    const blue = colourHistogram(picture({ colour: [20, 20, 230], seed: 1, flat: true, grain: 0 }), W, H);
    expect(red.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
    expect(histDistance(red, red)).toBe(0);
    expect(histDistance(red, blue)).toBeCloseTo(1, 6);
  });

  it("finds the camera's shift and a push in", () => {
    const a = greyOf(picture({ colour: [120, 120, 120], seed: 4, grain: 0 }), W, H);
    const b = greyOf(picture({ colour: [120, 120, 120], seed: 4, grain: 0, ox: 4, oy: -2 }), W, H);
    const m = cameraMotion(a, b, W, H);
    expect(m.dx * W).toBeCloseTo(4, 0);
    expect(m.dy * H).toBeCloseTo(-2, 0);
    expect(m.residual).toBeLessThan(cameraMotion(a, b, W, H).residual + 1e-9);
    expect(cameraMotion(a, a, W, H)).toMatchObject({ dx: 0, dy: 0 });
    const zin = greyOf(picture({ colour: [120, 120, 120], seed: 4, grain: 0, zoom: 1.04 }), W, H);
    expect(zoomHint(a, zin, W, H)).toBeGreaterThan(1.01);
    expect(zoomHint(zin, a, W, H)).toBeLessThan(0.99);
    expect(zoomHint(a, a, W, H)).toBe(1);
  });

  it("places the detail: blobs on the right read right of centre", () => {
    const g = new Float32Array(W * H).fill(0.5);
    for (let y = 0; y < H; y++) for (let x = 48; x < 60; x++) g[y * W + x] = (x + y) % 2 ? 1 : 0;
    expect(focusOf(g, W, H)).toBeGreaterThan(0.7);
    expect(focusOf(new Float32Array(W * H).fill(0.3), W, H)).toBe(0.5);
  });

  it("guesses a band of text, and none on a plain or natural picture", () => {
    const w = 160;
    const h = 90;
    const g = new Float32Array(w * h).fill(0.2);
    // "Letters": short bright strokes in rows 64 … 74 (about 0.77 of the height).
    for (let y = 64; y < 75; y++) for (let x = 20; x < 140; x++) if (x % 4 === 0 || (x % 7 === 0 && y % 3 === 0)) g[y * w + x] = 0.95;
    const y = textBandOf(g, w, h);
    expect(y).not.toBeNull();
    expect(Math.abs((y as number) - 0.77)).toBeLessThan(0.08);
    expect(textBandOf(new Float32Array(w * h).fill(0.4), w, h)).toBeNull();
    expect(textBandOf(greyOf(picture({ colour: [90, 120, 80], seed: 2, blur: true }), W, H), W, H)).toBeNull();
  });
});

describe("shot boundaries (adaptive threshold)", () => {
  it("finds every cut on a synthetic sequence, to the frame, and nothing inside a busy handheld shot", () => {
    const frames = sequence([
      { frames: 20, colour: [200, 120, 80], seed: 1, move: 0.6 },
      { frames: 12, colour: [60, 120, 200], seed: 2, shake: 3 },
      { frames: 28, colour: [90, 160, 90], seed: 3, move: -1 },
      // A cut between two shots of the same scene (same colours, different picture): the grey difference votes.
      { frames: 15, colour: [90, 160, 90], seed: 11 },
    ]);
    const b = detectBoundaries(frames);
    expect(b.filter((x) => x.kind === "cut").map((x) => Math.round(x.t * 10))).toEqual([20, 32, 60]);
    expect(shotsFrom(b, 7.5).map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 3.2],
      [3.2, 6],
      [6, 7.5],
    ]);
  });

  it("reads a dissolve as a gradual transition, not a run of cuts", () => {
    const a = { colour: [220, 60, 60] as [number, number, number], seed: 1 };
    const c = { colour: [40, 90, 220] as [number, number, number], seed: 2 };
    const frames: FrameFeatures[] = [];
    for (let i = 0; i < 40; i++) {
      const pa = picture({ ...a, noiseSeed: i + 1 });
      const pc = picture({ ...c, noiseSeed: i + 1 });
      const k = i < 15 ? 0 : i >= 25 ? 1 : (i - 14) / 11;
      const px = new Uint8ClampedArray(pa.length);
      for (let j = 0; j < px.length; j++) px[j] = pa[j] * (1 - k) + pc[j] * k;
      frames.push(feats(i / 10, px));
    }
    const b = detectBoundaries(frames, { fades: true });
    expect(b.filter((x) => x.kind === "cut")).toEqual([]);
    const fade = b.find((x) => x.kind === "fade");
    expect(fade).toBeDefined();
    expect(fade!.from!).toBeGreaterThanOrEqual(1.3);
    expect(fade!.to!).toBeLessThanOrEqual(2.6);
  });

  it("computes the same boundaries from linked frames whose grey copies were dropped", () => {
    const frames = sequence([
      { frames: 10, colour: [200, 120, 80], seed: 1, move: 1 },
      { frames: 10, colour: [60, 120, 200], seed: 2 },
    ]);
    const before = detectBoundaries(frames);
    const linked = frames.map((f) => ({ ...f }));
    for (let i = 1; i < linked.length; i++) linkFrames(linked[i - 1], linked[i]);
    for (const f of linked) f.grey = new Float32Array(0);
    expect(detectBoundaries(linked)).toEqual(before);
    expect(motionSeries(linked).map((m) => m.t)).toEqual(motionSeries(frames).map((m) => m.t));
  });
});

describe("window scores", () => {
  const frames = sequence([
    { frames: 10, colour: [130, 120, 110], seed: 1, move: 0.5 }, // 0–1 s good
    { frames: 10, colour: [14, 12, 10], seed: 2, brightness: 0.25 }, // 1–2 s dark
    { frames: 10, colour: [128, 128, 128], seed: 3, flat: true, grain: 0 } as never, // 2–3 s blank
    { frames: 10, colour: [140, 110, 100], seed: 4, blur: true }, // 3–4 s soft
    { frames: 10, colour: [110, 140, 120], seed: 5, shake: 4 }, // 4–5 s shaky
    { frames: 10, colour: [120, 130, 150], seed: 6, animate: 1.2 }, // 5–6 s good, lively (the subject moves)
  ]);
  const an = analyseFootage(frames, 6);
  const at = (t: number) => an.windows.find((w) => Math.abs(w.t - t) < 1e-6)!;

  it("flags dark, blank, blurry, shaky and across-a-cut windows, and scores the good ones higher", () => {
    expect(an.windows).toHaveLength(12);
    expect(at(1).flags).toContain("dark");
    expect(at(2.5).flags).toContain("flat");
    expect(at(3.5).flags).toContain("blurry");
    expect(at(4.5).flags).toContain("shaky");
    expect(at(0).flags).toEqual([]);
    expect(at(5.5).flags).toEqual([]);
    for (const bad of [1, 2.5, 3.5, 4.5]) expect(at(bad).quality).toBeLessThan(at(0).quality);
    // The 0.5 s windows that straddle no cut are clean; the shots are 1 s long so the cuts fall on window edges.
    expect(an.shots).toHaveLength(6);
  });

  it("rates the shot whose subject moves above the slowly panning one", () => {
    expect(at(5.5).action).toBeGreaterThan(at(0.5).action);
  });

  it("flags a window that has a cut inside it", () => {
    const f = sequence([
      { frames: 7, colour: [200, 120, 80], seed: 1 },
      { frames: 8, colour: [60, 120, 200], seed: 2 },
    ]);
    const w = scoreWindows(f, motionSeries(f), detectBoundaries(f), 1.5);
    expect(w[1].flags).toContain("cut");
    expect(w[0].flags).not.toContain("cut");
  });
});

describe("pulse and bars", () => {
  /** An eighth-note grid at 120 BPM (0.25 s), its loudest hit on every 8th tick starting at tick 2. */
  const beats = Array.from({ length: 64 }, (_, i) => i * 0.25);
  const accents = beats.map((_, i) => (i % 8 === 2 ? 1 : i % 2 === 0 ? 0.6 : 0.2));

  it("halves a grid faster than 0.36 s to the counted beats, keeping the louder half", () => {
    const g = musicGrid(beats, accents);
    expect(g.period).toBeCloseTo(0.5, 6);
    expect(g.bpm).toBe(120);
    expect(g.pulse[0]).toBe(0);
    expect(g.pulse).toHaveLength(32);
  });

  it("puts the bars on the loudest of the four phases, with a confidence", () => {
    const g = musicGrid(beats, accents);
    // Tick 2 is pulse 1: bars at 0.5, 2.5, 4.5 …
    expect(g.bars.slice(0, 3)).toEqual([0.5, 2.5, 4.5]);
    expect(g.confidence).toBeGreaterThan(1.3);
    const flat = plainGrid([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(flat.bars).toEqual([0, 2]);
    expect(flat.confidence).toBe(1);
  });

  it("reads accents from an envelope", () => {
    const env = new Float32Array(200);
    for (const t of [0.5, 1.5]) env[Math.round(t / 0.02)] = 1;
    expect(beatAccents([0.5, 1, 1.5], env, 0.02)).toEqual([1, 0, 1]);
  });

  it("tells a steady beat from speech-like sound", () => {
    const hop = 0.02;
    const g = plainGrid(Array.from({ length: 16 }, (_, i) => i * 0.5));
    const beat = new Float32Array(450).fill(0.05);
    for (const t of g.pulse) beat[Math.round(t / hop)] = 0.6;
    expect(steadyBeat(g, beat, hop)).toBe(true);
    const r = rng(3);
    const talk = Float32Array.from({ length: 450 }, () => 0.05 + r() * 0.3);
    expect(steadyBeat(g, talk, hop)).toBe(false);
    expect(steadyBeat(plainGrid([0, 0.5, 1]), beat, hop)).toBe(false);
  });
});

/* ───────────── The planner ───────────── */

/** A footage analysis written by hand: its own shots, windows with quality/action, flags where asked. */
function footage(duration: number, spec: { shots?: [number, number][]; bad?: Record<number, WindowScore["flags"]>; action?: (t: number) => number; quality?: (t: number) => number; hash?: (t: number) => string; luma?: number }): FootageAnalysis {
  const step = 0.5;
  const windows: WindowScore[] = [];
  for (let t = 0; t + 1e-6 < duration; t += step) {
    const flags = spec.bad?.[t] ?? [];
    windows.push({ t, quality: flags.length ? 0.1 : (spec.quality?.(t) ?? 0.8), action: spec.action?.(t) ?? 0.4, luma: spec.luma ?? 0.45, focus: 0.5, hash: spec.hash?.(t) ?? (Math.round(t * 1000) + 1).toString(16).padStart(16, "0").replace(/0/g, (_, i) => "0123456789abcdef"[(i * 7 + Math.round(t * 10)) % 16]), flags, textY: null });
  }
  const shots = (spec.shots ?? [[0, duration]]).map(([start, end]) => ({ start, end }));
  const motion: { t: number; v: number }[] = [];
  for (let t = 0; t <= duration + 1e-6; t += 0.1) motion.push({ t: Math.round(t * 1000) / 1000, v: 0.05 + 0.05 * Math.sin(t * 3) ** 2 });
  return { duration, step, windows, shots, boundaries: [], motion };
}

/** Distinct hashes per source and time, far apart from each other. */
const hashOf = (k: number) => (t: number) => {
  const r = rng(k * 1000 + Math.round(t * 10) + 1);
  return Array.from({ length: 16 }, () => Math.floor(r() * 16).toString(16)).join("");
};

const src = (id: string, duration: number, an: FootageAnalysis | null, extra: Partial<PlanSource> = {}): PlanSource => ({ id, source: { kind: "upload", name: `${id}.mp4`, size: 1 }, label: id, duration, width: 1920, height: 1080, analysis: an, ...extra });
const REEL = { width: 1080, height: 1920 };
const idc = () => {
  let n = 0;
  return () => String(++n);
};

function grid120(len = 40): MusicGrid {
  const pulse = Array.from({ length: len * 2 }, (_, i) => i * 0.5);
  return { pulse, bars: pulse.filter((_, i) => i % 4 === 0), period: 0.5, bpm: 120, confidence: 1.5 };
}

describe("cut plan", () => {
  it("lays a hook, a build that varies, a payoff and an end card that fill the stretch exactly", () => {
    const slots = cutPlan(0, 15, "balanced", { hook: true, endCard: true });
    expect(slots[0].role).toBe("hook");
    expect(slots.at(-1)!.role).toBe("end");
    expect(slots.at(-2)!.role).toBe("payoff");
    expect(slots[0].start).toBe(0);
    expect(slots.at(-1)!.end).toBe(15);
    for (let i = 1; i < slots.length; i++) expect(slots[i].start).toBeCloseTo(slots[i - 1].end, 9);
    const lens = slots.map((s) => s.end - s.start);
    for (let i = 1; i < lens.length - 1; i++) expect(Math.abs(lens[i] - lens[i - 1])).toBeGreaterThan(1e-3);
    expect(Math.min(...lens)).toBeGreaterThanOrEqual(PACE_SHAPE.balanced.min * 0.75 - 1e-9);
  });

  it("with a grid, cuts on the pulse and moves the sections onto bars", () => {
    const g = grid120();
    for (const pace of ["calm", "balanced", "energetic"] as const) {
      const slots = cutPlan(0, 16, pace, { hook: true, endCard: true, grid: g });
      for (const s of slots.slice(1)) expect(s.onBeat).toBe(true);
      // The hook ends on a bar when one is within a pulse and a half (energetic's 0.9 s hook is nearer the beat at 1 s than the bar at 2 s).
      const hookEnd = slots[0].end;
      if (pace !== "energetic") expect(g.bars.some((b) => Math.abs(b - hookEnd) < 1e-6)).toBe(true);
      const endStart = slots.at(-1)!.start;
      expect(g.bars.some((b) => Math.abs(b - endStart) < 1e-6)).toBe(true);
    }
  });

  it("puts speech segments whole after the hook", () => {
    const slots = cutPlan(0, 12, "balanced", { hook: true, endCard: true, speech: [{ src: "a", in: 2, out: 4.7 }] });
    expect(slots[1]).toMatchObject({ role: "speech" });
    expect(slots[1].end - slots[1].start).toBeCloseTo(2.7, 9);
  });
});

describe("planEdit", () => {
  const a = src("a", 8, footage(8, { shots: [[0, 3], [3, 8]], bad: { 5: ["dark"], 5.5: ["dark"] }, action: (t) => (t >= 1 && t < 2 ? 0.95 : 0.4), hash: hashOf(1) }));
  const b = src("b", 7, footage(7, { shots: [[0, 4], [4, 7]], bad: { 0: ["flat"] }, action: (t) => (t >= 5 ? 0.05 : 0.5), quality: (t) => (t >= 5 ? 0.95 : 0.7), hash: hashOf(2) }));
  const c = src("c", 6, footage(6, { action: () => 0.5, hash: hashOf(3) }));
  const plan = planEdit([a, b, c], { purpose: "promo", pace: "balanced", target: 15, output: REEL, id: idc() });
  const placed = placeClips(plan.clips);

  it("fills the target exactly, opens on the liveliest good moment and ends on a calm one", () => {
    expect(totalLength({ clips: plan.clips })).toBeCloseTo(15, 6);
    expect(plan.shots[0].role).toBe("hook");
    expect(plan.shots[0].label).toBe("a");
    expect(plan.clips[0].in).toBeGreaterThanOrEqual(0.5);
    expect(plan.clips[0].out).toBeLessThanOrEqual(2.88 + 1e-6);
    const end = plan.shots.at(-1)!;
    expect(end.role).toBe("end");
    expect(end.label).toBe("b");
    expect(plan.clips.at(-1)!.in).toBeGreaterThanOrEqual(4);
    expect(plan.clips.at(-1)!.keyframes?.zoom?.length).toBe(2);
  });

  it("never crosses the footage's own cuts, nor takes its dark or blank seconds", () => {
    const own: Record<string, [number, number][]> = { a: [[0, 3], [3, 8]], b: [[0, 4], [4, 7]], c: [[0, 6]] };
    for (const cl of plan.clips) {
      if (cl.source.kind !== "upload") continue;
      const id = cl.source.name.replace(".mp4", "");
      expect(own[id].some(([s, e]) => cl.in >= s - 1e-6 && cl.out <= e + 1e-6)).toBe(true);
      if (id === "a") expect(cl.out <= 5 + 1e-6 || cl.in >= 6 - 1e-6).toBe(true);
      if (id === "b") expect(cl.in).toBeGreaterThanOrEqual(0.5 - 1e-6);
    }
  });

  it("shows the same seconds twice only punched in, and alternates sources", () => {
    const bySrc = new Map<string, Clip[]>();
    for (const cl of plan.clips) {
      const k = JSON.stringify(cl.source);
      for (const o of bySrc.get(k) ?? []) if (!(cl.in >= o.out - 1e-6 || cl.out <= o.in + 1e-6)) expect(Math.max(cl.framing?.zoom ?? 1, o.framing?.zoom ?? 1)).toBeGreaterThan(1.1);
      bySrc.set(k, [...(bySrc.get(k) ?? []), cl]);
    }
    let same = 0;
    for (let i = 1; i < plan.clips.length; i++) if (JSON.stringify(plan.clips[i].source) === JSON.stringify(plan.clips[i - 1].source)) same++;
    expect(same).toBeLessThanOrEqual(1);
  });

  it("writes placeholder words over the hook and the end card, and says what it did", () => {
    expect(plan.overlays.filter((o) => o.kind === "text").map((o) => (o.kind === "text" ? o.text : ""))).toEqual(["عرض لفترة محدودة", "LIMITED OFFER", "تسوّق الآن", "Shop now"]);
    const hookText = plan.overlays[1];
    expect(hookText.start).toBeGreaterThanOrEqual(placed[0].start);
    expect(hookText.end).toBeLessThanOrEqual(placed[0].end + 1e-6);
    expect(plan.summary[0]).toMatch(/^Hook: a at 0:0\d\.\d/);
    expect(plan.summary.join(" ")).toMatch(/Ends on b held/);
    expect(plan.summary.join(" ")).toMatch(/Left out \(half seconds\): 2 dark, 1 blank/);
    expect(plan.look).toEqual({ id: "bold-sport", amount: 0.5 });
  });

  it("passes validation and is deterministic", () => {
    const again = planEdit([a, b, c], { purpose: "promo", pace: "balanced", target: 15, output: REEL, id: idc() });
    expect(again).toEqual(plan);
    const doc = { ...newProject("Auto", 1), clips: plan.clips, overlays: plan.overlays };
    const v = validateProject(doc);
    expect(v.ok).toBe(true);
  });

  it("lands cuts on the pulse and sections on bars with music", () => {
    const g = grid120();
    const p = planEdit([a, b, c], { purpose: "launch", pace: "energetic", target: 15.2, output: REEL, grid: g, id: idc() });
    const cuts = cutTimes(p.clips);
    for (const t of cuts) expect(g.pulse.some((x) => Math.abs(x - t) < 1e-6)).toBe(true);
    expect(totalLength({ clips: p.clips })).toBeCloseTo(15, 6); // snapped to the bar at 15 s
    expect(p.summary.join(" ")).toMatch(/cuts on the beat \(\d+ of \d+\), \d+ on the bar, 120 BPM/);
  });

  it("keeps crossfades centred on the planned cuts (calm pace)", () => {
    const p = planEdit([a, b, c], { purpose: "story", pace: "calm", target: 14, output: REEL, id: idc() });
    expect(p.clips.slice(1).some((cl) => cl.transition === "crossfade")).toBe(true);
    const starts = p.shots.map((s) => s.at);
    const cuts = cutTimes(p.clips);
    cuts.forEach((t, i) => expect(t).toBeCloseTo(starts[i + 1], 6));
    expect(totalLength({ clips: p.clips })).toBeCloseTo(14, 6);
  });

  it("punches in when footage has to be reused", () => {
    const short = src("s", 3, footage(3, { hash: hashOf(9) }));
    const p = planEdit([short], { purpose: "promo", pace: "energetic", target: 8, output: REEL, id: idc() });
    expect(totalLength({ clips: p.clips })).toBeCloseTo(8, 6);
    expect(p.clips.some((cl) => (cl.framing?.zoom ?? 1) > 1.1)).toBe(true);
    expect(p.summary.join(" ")).toMatch(/punched in/);
  });

  it("keeps locked clips exactly in place and speech whole", () => {
    const lockedClip: Clip = { ...newClip({ kind: "upload", name: "c.mp4", size: 1 }, 6, "L"), in: 1, out: 3, locked: true };
    const withSpeech = src("a", 8, footage(8, { shots: [[0, 3], [3, 8]], hash: hashOf(1) }), { speech: [{ in: 3.4, out: 5.4 }] });
    const p = planEdit([withSpeech, b], { purpose: "story", pace: "balanced", target: 16, output: REEL, locked: [{ clip: lockedClip, start: 6 }], id: idc() });
    const pl = placeClips(p.clips);
    const li = p.clips.findIndex((x) => x.id === "L");
    expect(pl[li].start).toBeCloseTo(6, 6);
    expect(p.clips[li]).toBe(lockedClip);
    const sp = p.clips.find((x) => x.speech)!;
    expect([sp.in, sp.out]).toEqual([3.4, 5.4]);
    for (const cl of p.clips) if (!cl.speech && cl.source.kind === "upload" && cl.source.name === "a.mp4") expect(cl.out <= 3.4 + 1e-6 || cl.in >= 5.4 - 1e-6).toBe(true);
    expect(totalLength({ clips: p.clips })).toBeCloseTo(16, 6);
    expect(p.summary.join(" ")).toMatch(/1 locked clip kept in place/);
  });

  it("falls back to the middle of footage it could not read", () => {
    const p = planEdit([src("x", 10, null)], { purpose: "promo", pace: "balanced", target: 6, output: REEL, id: idc() });
    expect(totalLength({ clips: p.clips })).toBeCloseTo(6, 6);
  });

  it("goes on the project as one step: the person's words kept, the preset only when none, the frame and the summary", () => {
    const base = { ...newProject("P", 1), output: { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 } };
    const reel = { ...base.output, width: 1080, height: 1920 };
    const fresh = withEditPlan(base, plan, { purpose: "promo", pace: "balanced", at: 7, output: reel });
    expect(fresh.output).toEqual(reel);
    expect(fresh.look).toBe("bold-sport");
    expect(fresh.overlays).toEqual(plan.overlays);
    expect(fresh.edit).toEqual({ purpose: "promo", pace: "balanced", summary: plan.summary, at: 7 });
    const mine = newTextOverlay("My own words", 0, 3, "mine");
    const kept = withEditPlan({ ...base, look: "warm-film", overlays: [mine] }, plan, { purpose: "promo", pace: "balanced", at: 8 });
    expect(kept.overlays).toEqual([mine]);
    expect(kept.look).toBe("warm-film");
    expect(kept.output).toEqual(base.output);
    expect(kept.edit!.summary.at(-1)).toMatch(/own words were kept/);
    expect(validateProject(kept).ok).toBe(true);
  });

  it("pans a tall crop of wide footage toward its detail", () => {
    expect(panFor(0.5, { width: 1920, height: 1080 }, REEL)).toBe(0);
    expect(panFor(0.8, { width: 1920, height: 1080 }, REEL)).toBeGreaterThan(0.3);
    expect(panFor(0.1, { width: 1920, height: 1080 }, REEL)).toBeLessThan(-0.5);
    expect(panFor(0.9, { width: 1080, height: 1920 }, REEL)).toBe(0);
  });

  it("leaves hard-flagged windows out of the runs a shot may take", () => {
    const runs = usableRuns(a);
    expect(runs.map((r) => [r.a, r.b])).toEqual([
      [0, 2.88],
      [3.12, 5],
      [6, 8],
    ]);
  });
});

/* ───────────── Edit like this video ───────────── */

describe("reference template", () => {
  // A reference with a known rhythm at 30 fps: 0.6 s / 1.2 s alternating shots, the third pushes in, text on the second.
  const fps = 30;
  const lens = [0.6, 1.2, 0.6, 1.2, 0.6, 1.2];
  const frames: FrameFeatures[] = [];
  let f = 0;
  const truth: number[] = [];
  lens.forEach((l, si) => {
    truth.push(f / fps);
    const n = Math.round(l * fps);
    for (let k = 0; k < n; k++) {
      const px = picture({ colour: [[200, 80, 60], [60, 90, 200], [80, 180, 90]][si % 3] as [number, number, number], seed: si + 1, ox: si === 0 ? k * 0.8 : 0, zoom: si === 2 ? Math.pow(1.012, k) : 1, noiseSeed: f + 1 });
      if (si === 1) for (let y = 28; y < 32; y++) for (let x = 6; x < 58; x++) if (x % 3 === 0) px.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 3);
      frames.push(feats(f / fps, px));
      f++;
    }
  });
  const duration = f / fps;
  const ref = analyseReference(frames, { duration, width: 1080, height: 1920, fps, source: { kind: "upload", id: "ref.mp4", name: "ref.mp4" } }, { now: 5 });

  it("finds the shots to the frame", () => {
    expect(ref.shots).toHaveLength(6);
    ref.shots.forEach((s, i) => expect(Math.round((s.start - truth[i]) * fps)).toBe(0));
    expect(ref.shots.map((s) => Math.round((s.end - s.start) * 10) / 10)).toEqual(lens);
    expect(ref.shots[2].camera).toBe("push");
    expect(ref.shots[0].action).toBeGreaterThan(ref.shots[3].action);
    expect(ref.pace.length).toBe(3);
  });

  it("becomes a template of the same rhythm, with a text layer where text was seen", () => {
    const { template, notes } = templateFromReference(ref);
    expect(notes).toEqual([]);
    expect(template.slots.map((s) => s.duration)).toEqual(lens);
    expect(template.slots[2].push).toBeGreaterThan(1);
    expect(template.slots.every((s) => s.transition === "cut")).toBe(true);
    if (ref.text === "found") expect(template.texts.some((t) => t.from === 1)).toBe(true);
  });

  it("maps the person's footage by action and lines both cuts up shot by shot", () => {
    const { template } = templateFromReference(ref);
    const lively = src("lively", 6, footage(6, { action: () => 0.95, hash: hashOf(4) }));
    const calm = src("calm", 6, footage(6, { action: () => 0.05, hash: hashOf(5) }));
    const fills = fillSlots([calm, lively], template.slots.map((s) => ({ duration: s.duration, action: s.action ?? 0.5 })), REEL);
    // The busiest reference shot (the first, panning) gets the lively footage.
    expect(fills[0]!.label).toBe("lively");
    const p = applyTemplate(template, newProject("Ref", 1), [], { windows: fills.map((x) => (x ? { ...x } : null)), keepLook: true, now: 1, id: idc() });
    expect(p.clips.map((c) => Math.round(clipLength(c) * 1000) / 1000)).toEqual(lens);
    expect(p.clips[2].keyframes?.zoom?.at(-1)?.v).toBeGreaterThan(1);
    const rows = compareTimings(ref, p.clips);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(Math.abs(r.deltaFrames!)).toBeLessThanOrEqual(1);
    expect(rows[1].ours!.length).toBeCloseTo(1.2, 3);
  });

  it("notes a reference longer than the editor holds", () => {
    const long: ReferenceAnalysis = { ...ref, shots: Array.from({ length: 30 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.5, action: 0.5, camera: "still" as const, luma: 0.4, textY: null })) };
    const { template, notes } = templateFromReference(long);
    expect(template.slots).toHaveLength(24);
    expect(notes[0]).toMatch(/30 shots/);
  });

  it("is stored with the project (version 4) and checked; a version 3 draft opens unchanged", () => {
    expect(PROJECT_VERSION).toBe(4);
    expect(checkReference(ref)).toEqual(ref);
    expect(checkReference({ ...ref, shots: [{ start: 2, end: 1 }] })).toMatch(/shots/);
    expect(checkReference({ ...ref, source: { kind: "web", id: "x", name: "x" } })).toMatch(/kind/);
    const doc = { ...newProject("R", 1), reference: { analysis: ref, appliedAt: 9, matchColour: true }, edit: { purpose: "promo", pace: "balanced", summary: ["Hook: a"], at: 3 } };
    const v = validateProject(JSON.parse(JSON.stringify(doc)));
    expect(v.ok && v.project.reference).toEqual({ analysis: ref, appliedAt: 9, matchColour: true });
    expect(v.ok && v.project.edit?.summary).toEqual(["Hook: a"]);
    const v3 = { ...newProject("Old", 1), v: 3 } as Record<string, unknown>;
    delete v3.edit;
    expect(migrateProject(v3)).toMatchObject({ v: 4, edit: null, reference: null });
    const r3 = validateProject(v3);
    expect(r3.ok && r3.project.v).toBe(4);
    expect(r3.ok && r3.project.reference).toBeUndefined();
    expect(validateProject({ ...doc, reference: { analysis: { ...ref, duration: 999 } } })).toMatchObject({ ok: false });
  });
});
