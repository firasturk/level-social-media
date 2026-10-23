/**
 * The video editor's project document and its arithmetic, without a browser: validation, the
 * timeline (lengths, trims, speed, crossfade overlap, splits), beat snapping, the onset-based beat
 * detector on a synthetic pulse, the auto-edit planner on fake energy curves, and the .cube reader.
 */
import { describe, expect, it } from "vitest";
import {
  bestWindow,
  clipLength,
  cutTimes,
  detectBeats,
  estimateBytes,
  frameAt,
  moveClip,
  nearestBeat,
  newClip,
  newProject,
  placeClips,
  planAutoEdit,
  PROJECT_VERSION,
  snapCutsToBeats,
  splitClip,
  timelineBeats,
  totalLength,
  trimClip,
  validateProject,
  type Clip,
} from "../shared/video-project";
import { parseCube, sampleCube } from "../shared/cube-lut";

const src = (id: string) => ({ kind: "version" as const, batch: "b1", videoId: id });
const clip = (id: string, duration: number, patch: Partial<Clip> = {}): Clip => ({ ...newClip(src(id), duration, id), ...patch });

describe("validateProject", () => {
  it("accepts a new project and a full one, and fills the defaults", () => {
    const p = newProject("Cut 1", 1000);
    expect(validateProject(p)).toMatchObject({ ok: true, project: { name: "Cut 1", clips: [], look: "none", snapToBeats: false } });
    const full = { ...p, clips: [clip("a", 10, { in: 1, out: 4 }), { ...clip("b", 8, { transition: "crossfade", speed: 2 }), colour: { exposure: 0.2 } }], music: { source: { kind: "upload", name: "song.mp3", size: 10 }, offset: 2, volume: 0.8, fadeIn: 1, fadeOut: 2, beats: [0.5, 1, 1.5] }, lut: { name: "warm.cube", size: 17 }, snapToBeats: true };
    const r = validateProject(full);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.clips[1].colour).toEqual({ exposure: 0.2, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vibrance: 0, whites: 0, blacks: 0 });
    expect(r.project.lut).toEqual({ name: "warm.cube", size: 17, strength: 1 });
    expect(r.project.music?.beats).toEqual([0.5, 1, 1.5]);
    expect(r.project.snapToBeats).toBe(true);
  });

  it("refuses what cannot be rendered, with a plain reason", () => {
    const p = newProject("x");
    expect(validateProject({ ...p, v: PROJECT_VERSION + 1 })).toMatchObject({ ok: false, reason: expect.stringContaining("version") });
    expect(validateProject({ ...p, v: 0 })).toMatchObject({ ok: false, reason: expect.stringContaining("version") });
    expect(validateProject({ ...p, v: 99 })).toMatchObject({ ok: false, reason: expect.stringContaining("version") });
    expect(validateProject({ ...p, clips: [clip("a", 5, { in: 4, out: 2 })] })).toMatchObject({ ok: false, reason: expect.stringContaining("in before out") });
    expect(validateProject({ ...p, clips: [clip("a", 5, { speed: 9 })] })).toMatchObject({ ok: false, reason: expect.stringContaining("speed") });
    expect(validateProject({ ...p, clips: [clip("a", 5), clip("a", 5)] })).toMatchObject({ ok: false, reason: expect.stringContaining("unique id") });
    expect(validateProject({ ...p, output: { ...p.output, width: 1081 } })).toMatchObject({ ok: false, reason: expect.stringContaining("even") });
    expect(validateProject({ ...p, clips: [clip("a", 50), clip("b", 50)] })).toMatchObject({ ok: false, reason: expect.stringContaining("up to 60 s") });
    expect(validateProject({ ...p, music: { source: { kind: "nope" } } })).toMatchObject({ ok: false });
    expect(validateProject("nope")).toMatchObject({ ok: false });
  });
});

describe("the timeline", () => {
  it("adds clip lengths, divides by speed and overlaps crossfades", () => {
    const clips = [clip("a", 10, { in: 2, out: 6 }), clip("b", 10, { out: 4, speed: 2 }), clip("c", 10, { out: 3, transition: "crossfade", transitionDuration: 1 })];
    expect(clipLength(clips[0])).toBe(4);
    expect(clipLength(clips[1])).toBe(2);
    const placed = placeClips(clips);
    expect(placed.map((p) => [p.start, p.end, p.overlap])).toEqual([
      [0, 4, 0],
      [4, 6, 0],
      [5, 8, 1],
    ]);
    expect(totalLength({ clips })).toBe(8);
    expect(cutTimes(clips)).toEqual([4, 5.5]);
    // A crossfade never takes more than half of either clip.
    const short = [clip("a", 10, { out: 1 }), clip("b", 10, { out: 1, transition: "crossfade", transitionDuration: 3 })];
    expect(placeClips(short)[1].overlap).toBe(0.5);
  });

  it("maps a timeline time to the clip's source time, with a mix inside a crossfade", () => {
    const clips = [clip("a", 10, { in: 2, out: 6 }), clip("b", 10, { out: 4, speed: 2, transition: "crossfade", transitionDuration: 1 })];
    expect(frameAt(clips, 1)).toMatchObject({ a: { source: 3 }, b: null });
    const mid = frameAt(clips, 3.5);
    expect(mid.a?.placed.clip.id).toBe("a");
    expect(mid.a?.source).toBe(5.5);
    expect(mid.b?.placed.clip.id).toBe("b");
    expect(mid.b?.source).toBe(1);
    expect(mid.b?.mix).toBe(0.5);
    expect(frameAt(clips, 4.5)).toMatchObject({ a: { placed: { clip: { id: "b" } }, source: 3 }, b: null });
    expect(frameAt(clips, 99).a?.source).toBe(4);
    expect(frameAt([], 0)).toEqual({ a: null, b: null });
  });

  it("splits, trims, moves and sizes", () => {
    const c = clip("a", 10, { in: 2, out: 8, speed: 2 });
    const [l, r] = splitClip(c, 1)!;
    expect(l).toMatchObject({ in: 2, out: 4 });
    expect(r).toMatchObject({ in: 4, out: 8, transition: "cut" });
    expect(r.id).not.toBe(l.id);
    expect(splitClip(c, 0.1)).toBeNull();
    expect(trimClip(c, { in: -5 })).toMatchObject({ in: 0, out: 8 });
    expect(trimClip(c, { out: 50 })).toMatchObject({ in: 2, out: 10 });
    expect(trimClip(c, { in: 7.9 }).out - trimClip(c, { in: 7.9 }).in).toBeCloseTo(0.5);
    expect(moveClip([clip("a", 1), clip("b", 1), clip("c", 1)], 0, 2).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(estimateBytes({ width: 1080, height: 1920, fps: 30, bitrate: 8_000_000 }, 10)).toBe(10_160_000);
  });
});

describe("beats", () => {
  it("snaps each cut to the nearest beat by trimming the clip that ends there", () => {
    const clips = [clip("a", 10, { out: 3.1 }), clip("b", 10, { out: 2.2 }), clip("c", 10, { out: 2 })];
    const beats = [1, 2, 3, 4, 5, 6, 7, 8];
    const snapped = snapCutsToBeats(clips, beats, 0.25);
    expect(cutTimes(snapped)).toEqual([3, 5]);
    expect(snapped[0].out).toBe(3);
    expect(snapped[1].out).toBeCloseTo(2);
    expect(snapped[2]).toEqual(clips[2]);
    // Out of tolerance: nothing moves. Speed is honoured when the out point moves.
    expect(cutTimes(snapCutsToBeats([clip("a", 10, { out: 3.5 }), clip("b", 10, { out: 2 })], beats, 0.25))).toEqual([3.5]);
    const fast = snapCutsToBeats([clip("a", 10, { out: 6.2, speed: 2 }), clip("b", 10, { out: 2 })], beats, 0.25);
    expect(fast[0].out).toBeCloseTo(6);
    expect(nearestBeat(2.3, beats)).toBe(2.3);
    expect(nearestBeat(2.1, beats)).toBe(2);
    expect(timelineBeats({ beats: [1, 2, 3, 4], offset: 1.5 }, 2)).toEqual([0.5, 1.5]);
  });

  it("finds a steady pulse in an energy envelope and fits a grid through quiet bars", () => {
    // A pulse every 0.5 s at hop 0.05 s; one beat is missing (quiet bar) and the grid still ticks there.
    const hop = 0.05;
    const energy = new Float32Array(Math.round(10 / hop));
    for (let i = 0; i < energy.length; i++) energy[i] = 0.1;
    for (let t = 0.5; t < 10; t += 0.5) if (Math.abs(t - 5) > 1e-6) energy[Math.round(t / hop)] = 1;
    const beats = detectBeats(energy, hop);
    expect(beats.length).toBeGreaterThanOrEqual(18);
    const gaps = beats.slice(1).map((b, i) => +(b - beats[i]).toFixed(2));
    expect(gaps.every((g) => Math.abs(g - 0.5) < 0.06)).toBe(true);
    expect(beats.some((b) => Math.abs(b - 5) < 0.06)).toBe(true);
    expect(detectBeats(new Float32Array(100).fill(0.2), hop)).toEqual([]);
    expect(detectBeats([], hop)).toEqual([]);
  });
});

describe("auto edit", () => {
  const curve = (duration: number, peakAt: number, step = 0.5) => {
    const n = Math.round(duration / step);
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) e[i] = Math.max(0, 1 - Math.abs(i * step - peakAt) / 3);
    return { energy: e, step };
  };

  it("trims each clip to its most active window", () => {
    const c = { id: "a", source: src("a"), duration: 20, ...curve(20, 12) };
    expect(bestWindow(c, 4)).toBe(10);
    expect(bestWindow(c, 4, 1)).not.toBe(10);
    expect(bestWindow({ ...c, energy: [], step: 0.5 }, 4)).toBe(8);
    expect(bestWindow(c, 30)).toBe(0);
  });

  it("builds a calm cut in the given order with crossfades, close to the target length", () => {
    const inputs = [
      { id: "a", source: src("a"), duration: 20, ...curve(20, 12) },
      { id: "b", source: src("b"), duration: 15, ...curve(15, 2) },
      { id: "c", source: src("c"), duration: 10, ...curve(10, 9) },
    ];
    const plan = planAutoEdit(inputs, { target: 15, style: "calm" });
    expect(plan.map((c) => c.source)).toEqual([src("a"), src("b"), src("c")]);
    expect(plan[0].transition).toBe("cut");
    expect(plan.slice(1).every((c) => c.transition === "crossfade")).toBe(true);
    // The liveliest 5 s of clip a sit around its peak at 12 s.
    expect(plan[0].in).toBeGreaterThanOrEqual(9);
    expect(plan[0].in).toBeLessThanOrEqual(10.5);
    expect(plan[0].out - plan[0].in).toBe(5);
    const total = totalLength({ clips: plan });
    expect(total).toBeGreaterThan(12);
    expect(total).toBeLessThanOrEqual(15.01);
    expect(planAutoEdit(inputs, { target: 15, style: "calm" })).toEqual(plan);
  });

  it("builds an energetic cut liveliest first with short hard cuts, rounded to the beat grid", () => {
    const inputs = [
      { id: "a", source: src("a"), duration: 20, energy: new Float32Array(40).fill(0.2), step: 0.5 },
      { id: "b", source: src("b"), duration: 15, energy: new Float32Array(30).fill(0.9), step: 0.5 },
    ];
    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const plan = planAutoEdit(inputs, { target: 10, style: "energetic", beats });
    expect(plan[0].source).toEqual(src("b"));
    expect(plan.every((c) => c.transition === "cut")).toBe(true);
    expect(plan.every((c) => clipLength(c) <= 2.5 && clipLength(c) >= 0.5)).toBe(true);
    for (const c of plan) expect(Math.abs(clipLength(c) / 0.5 - Math.round(clipLength(c) / 0.5))).toBeLessThan(1e-6);
    expect(totalLength({ clips: plan })).toBeGreaterThanOrEqual(9);
    expect(totalLength({ clips: plan })).toBeLessThanOrEqual(10.25);
    // Footage shorter than the target is reused rather than stretched.
    const short = planAutoEdit([{ id: "s", source: src("s"), duration: 3, energy: [], step: 0.5 }], { target: 8, style: "energetic" });
    expect(short.length).toBeGreaterThan(1);
    expect(planAutoEdit([], { target: 8, style: "calm" })).toEqual([]);
  });
});

describe(".cube LUTs", () => {
  const identity2 = `TITLE "Identity"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;
  it("reads a 3D table and interpolates through it", () => {
    const r = parseCube(identity2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lut).toMatchObject({ title: "Identity", size: 2 });
    expect(sampleCube(r.lut, 0.25, 0.5, 1)).toEqual([0.25, 0.5, 1]);
    const inverted = parseCube(identity2.replace(/\n(\d) (\d) (\d)/g, (_, a, b, c) => `\n${1 - a} ${1 - b} ${1 - c}`));
    if (inverted.ok) expect(sampleCube(inverted.lut, 0.25, 0.5, 1)).toEqual([0.75, 0.5, 0]);
    const ranged = parseCube(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n` + identity2.split("\n").slice(2).join("\n"));
    if (ranged.ok) expect(sampleCube(ranged.lut, 1, 1, 1)).toEqual([0.5, 0.5, 0.5]);
  });
  it("refuses 1D tables, wrong counts and junk", () => {
    expect(parseCube("LUT_1D_SIZE 2\n0\n1\n")).toMatchObject({ ok: false, reason: expect.stringContaining("1D") });
    expect(parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toMatchObject({ ok: false, reason: expect.stringContaining("Expected 8") });
    expect(parseCube("LUT_3D_SIZE 2\n0 0\n")).toMatchObject({ ok: false, reason: expect.stringContaining("three numbers") });
    expect(parseCube("hello")).toMatchObject({ ok: false });
    expect(parseCube("LUT_3D_SIZE 999\n")).toMatchObject({ ok: false });
  });
});
