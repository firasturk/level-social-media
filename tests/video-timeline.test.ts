/**
 * Phase 2 of the video editor, without a browser: the timeline's maths (timecodes, frame steps,
 * zoom, snapping, selection, reorder, split, ripple and plain delete, beat alignment with locks
 * and speech), keyframes with their easings, the sound (clip levels under crossfades and dips,
 * the music's span, fades and ducking under speech and voice-over), the automatic first cut with
 * purpose, pace, beats, locked clips and protected speech, and the version 1 → 2 migration.
 */
import { describe, expect, it } from "vitest";
import { clipFramingAt, clipLength, cutTimes, dipAt, gapClip, migrateV1, newClip, newProject, placeClips, PROJECT_VERSION, splitClip, timelineBeats, totalLength, validateProject, type Clip, type VideoProject } from "../shared/video-project";
import { ease, keyAt, keyTimes, removeKey, setKey, splitKeyframes, valueAt, type Keyframe } from "../shared/video-keyframes";
import { alignCutsToBeats, clickSelect, deleteClips, diamondTimes, dropIndexAt, fitPps, formatTimecode, MAX_PPS, MIN_PPS, moveClips, parseTimecode, snapSpan, snapTargets, snapTime, splitAt, stepFrames, tickSpacing, tidyGaps, zoomAround } from "../shared/video-timeline";
import { clipGainAt, clipGainPoints, CURVE_RATE, curveFrom, duckFactor, DUCK_ATTACK, DUCK_RELEASE, mergeSpans, musicGainAt, musicGainCurve, speechSpans } from "../shared/video-mix";
import { planFirstCut, windowAvoiding, type FirstCutInput } from "../shared/video-autoedit";
import { newLogoOverlay, newTextOverlay, overlayState, textParagraphs, checkOverlays } from "../shared/video-compose";

const src = (id: string) => ({ kind: "version" as const, batch: "b1", videoId: id });
const clip = (id: string, duration: number, patch: Partial<Clip> = {}): Clip => ({ ...newClip(src(id), duration, id), ...patch });
const project = (patch: Partial<VideoProject> = {}): VideoProject => ({ ...newProject("Cut", 1000), ...patch });
const ids = (cs: readonly Clip[]) => cs.map((c) => c.id);

describe("timecodes and frame steps (30 fps)", () => {
  it("formats mm:ss:ff, rounding to the nearest frame", () => {
    expect(formatTimecode(0)).toBe("00:00:00");
    expect(formatTimecode(1.5)).toBe("00:01:15");
    expect(formatTimecode(61 + 29 / 30)).toBe("01:01:29");
    expect(formatTimecode(59.999)).toBe("01:00:00");
    expect(formatTimecode(-3)).toBe("00:00:00");
    expect(formatTimecode(NaN)).toBe("00:00:00");
  });
  it("parses what a person types, and refuses what is not a time", () => {
    expect(parseTimecode("00:01:15")).toBe(1.5);
    expect(parseTimecode("01:02")).toBe(62);
    expect(parseTimecode("12.5")).toBe(12.5);
    expect(parseTimecode("4s")).toBe(4);
    expect(parseTimecode("00:00:30")).toBeNull();
    expect(parseTimecode("00:61:00")).toBeNull();
    expect(parseTimecode("abc")).toBeNull();
    expect(parseTimecode("")).toBeNull();
    for (const t of [0, 0.5, 3 + 7 / 30, 42.1]) expect(parseTimecode(formatTimecode(t))).toBeCloseTo(Math.round(t * 30) / 30, 6);
  });
  it("steps one frame on the frame grid, inside the cut", () => {
    expect(stepFrames(1, 1, 10)).toBeCloseTo(1 + 1 / 30);
    expect(stepFrames(1.01, -1, 10)).toBeCloseTo(29 / 30);
    expect(stepFrames(0, -1, 10)).toBe(0);
    expect(stepFrames(9.99, 30, 10)).toBe(10);
  });
});

describe("timeline zoom", () => {
  it("fits the cut and zooms around a point without moving the time under it", () => {
    expect(fitPps(1000, 19)).toBeCloseTo(1000 / (19 * 1.05));
    expect(fitPps(100, 3600)).toBe(MIN_PPS);
    expect(fitPps(100000, 1)).toBe(MAX_PPS);
    const view = { pps: 20, scroll: 100 };
    const anchor = 300;
    const tBefore = (view.scroll + anchor) / view.pps;
    const z = zoomAround(view, 2, anchor);
    expect(z.pps).toBe(40);
    expect((z.scroll + anchor) / z.pps).toBeCloseTo(tBefore);
    const out = zoomAround(z, 1 / 2, anchor);
    expect(out.pps).toBe(20);
    expect(out.scroll).toBeCloseTo(100);
    expect(zoomAround({ pps: MAX_PPS, scroll: 0 }, 4, 0).pps).toBe(MAX_PPS);
    expect(zoomAround({ pps: 10, scroll: 0 }, 0.5, 200).scroll).toBe(0);
  });
  it("spaces the ruler's labels for the zoom", () => {
    expect(tickSpacing(400)).toBeCloseTo(5 / 30);
    expect(tickSpacing(60)).toBe(1);
    expect(tickSpacing(10)).toBe(10);
    expect(tickSpacing(0.5)).toBe(60);
  });
});

describe("snapping", () => {
  const p = project({
    clips: [clip("a", 10, { out: 4 }), clip("b", 10, { out: 3 })],
    overlays: [{ ...newTextOverlay("Hi", 1.5, 2.5, "t1") }, { ...newLogoOverlay("/logo.png", "Logo", 0, 6.2, "l1") }],
    voices: [{ id: "v1", source: { kind: "upload", name: "vo.wav", size: 1 }, name: "VO", start: 5, in: 0, out: 1, duration: 3, volume: 1 }],
  });
  it("collects the playhead, cuts, beats, layer, music and voice edges, leaving out what is dragged", () => {
    const targets = snapTargets(p, { playhead: 2.2, beats: [0.5, 1] });
    const kinds = new Set(targets.map((x) => x.kind));
    expect([...kinds].sort()).toEqual(["beat", "cut", "logo", "playhead", "text", "voice"]);
    expect(targets.filter((x) => x.kind === "cut").map((x) => x.t)).toEqual([0, 4, 4, 7]);
    expect(snapTargets(p, { exclude: new Set(["t1", "a"]) }).some((x) => x.kind === "text" || (x.kind === "cut" && x.t === 0))).toBe(false);
  });
  it("moves a time to the nearest target within the tolerance, and leaves it alone otherwise", () => {
    const targets = snapTargets(p, { playhead: 2.2 });
    expect(snapTime(4.05, targets, 0.1)).toMatchObject({ t: 4, target: { kind: "cut" } });
    expect(snapTime(2.25, targets, 0.1)).toMatchObject({ t: 2.2, target: { kind: "playhead" } });
    expect(snapTime(3.3, targets, 0.1)).toEqual({ t: 3.3, target: null });
    // A block snaps by whichever edge is closer.
    expect(snapSpan(2.95, 1, targets, 0.1).start).toBeCloseTo(3); // its end lands on the cut at 4
    expect(snapSpan(1.45, 1, targets, 0.1).start).toBeCloseTo(1.5); // its start lands on the text's start
    expect(snapSpan(3.3, 0.2, targets, 0.05)).toEqual({ start: 3.3, target: null });
  });
});

describe("selection, reorder, split", () => {
  const order = ["a", "b", "c", "d"];
  it("selects one, toggles with cmd, extends a range with shift", () => {
    expect(clickSelect([], "b", {}, order)).toEqual(["b"]);
    expect(clickSelect(["b"], "d", { toggle: true }, order)).toEqual(["b", "d"]);
    expect(clickSelect(["b", "d"], "b", { toggle: true }, order)).toEqual(["d"]);
    expect(clickSelect(["a"], "c", { shift: true }, order)).toEqual(["a", "b", "c"]);
    expect(clickSelect(["d"], "b", { shift: true }, order)).toEqual(["b", "c", "d"]);
  });
  it("moves several clips together and finds where a drag lands", () => {
    const cs = [clip("a", 2), clip("b", 2), clip("c", 2, { transition: "crossfade" }), clip("d", 2)];
    expect(ids(moveClips(cs, ["c", "a"], 4))).toEqual(["b", "d", "a", "c"]);
    expect(ids(moveClips(cs, ["d"], 0))).toEqual(["d", "a", "b", "c"]);
    expect(ids(moveClips(cs, ["b", "c"], 0))).toEqual(["b", "c", "a", "d"]);
    // The clip that ends up first never keeps a join.
    expect(moveClips(cs, ["c"], 0)[0]).toMatchObject({ id: "c", transition: "cut" });
    expect(dropIndexAt([clip("a", 2), clip("b", 2)], 0.5)).toBe(0);
    expect(dropIndexAt([clip("a", 2), clip("b", 2)], 1.5)).toBe(1);
    expect(dropIndexAt([clip("a", 2), clip("b", 2)], 3.5)).toBe(2);
  });
  it("splits the clip under the playhead (or the selected one), keyframes with it", () => {
    const kf = { zoom: [{ t: 0, v: 1, ease: "linear" as const }, { t: 2, v: 2, ease: "linear" as const }] };
    const cs = [clip("a", 10, { out: 2 }), clip("b", 10, { in: 1, out: 5, keyframes: kf })];
    const r = splitAt(cs, 3)!;
    expect(r.clips).toHaveLength(3);
    const [, left, right] = r.clips;
    expect(left).toMatchObject({ id: "b", in: 1, out: 2 });
    expect(right).toMatchObject({ in: 2, out: 5, transition: "cut" });
    expect(r.right).toEqual([right.id]);
    // The motion continues across the split: zoom 1.5 at the split point on both sides.
    expect(valueAt(left.keyframes?.zoom, 1, 0)).toBeCloseTo(1.5);
    expect(valueAt(right.keyframes?.zoom, 0, 0)).toBeCloseTo(1.5);
    expect(valueAt(right.keyframes?.zoom, 1, 0)).toBeCloseTo(2);
    expect(splitAt(cs, 3, ["a"])).toBeNull();
    expect(splitAt(cs, 9)).toBeNull();
    expect(splitAt(cs, 2.1)).toBeNull(); // too close to the edge
    const g = splitClip(gapClip(2, "g"), 0.5)!;
    expect(g.map(clipLength)).toEqual([0.5, 1.5]);
  });
});

describe("delete: ripple (closing the gap) and plain (leaving it)", () => {
  const base = () =>
    project({
      clips: [clip("a", 10, { out: 2 }), clip("b", 10, { out: 3 }), clip("c", 10, { out: 4 })],
      overlays: [newTextOverlay("On a", 0.5, 1.5, "ta"), newTextOverlay("On c", 5.5, 7, "tc"), newLogoOverlay("/l.png", "Logo", 0, 9, "lg")],
      voices: [{ id: "v", source: { kind: "upload", name: "v.wav", size: 1 }, name: "VO", start: 6, in: 0, out: 2, duration: 2, volume: 1 }],
    });
  it("ripple delete closes the gap and moves the layers after it with the footage", () => {
    const r = deleteClips(base(), ["b"], true);
    expect(ids(r.clips)).toEqual(["a", "c"]);
    expect(totalLength(r)).toBe(6);
    const tc = r.overlays.find((o) => o.id === "tc")!;
    expect([tc.start, tc.end]).toEqual([2.5, 4]);
    expect(r.overlays.find((o) => o.id === "ta")).toMatchObject({ start: 0.5, end: 1.5 });
    // A layer that starts before the removed clip stays where it is.
    expect(r.overlays.find((o) => o.id === "lg")).toMatchObject({ start: 0, end: 9 });
    expect(r.voices[0].start).toBe(3);
  });
  it("plain delete leaves a gap of the same length, so nothing else moves", () => {
    const r = deleteClips(base(), ["b"], false);
    expect(r.clips.map((c) => c.source.kind)).toEqual(["version", "gap", "version"]);
    expect(totalLength(r)).toBe(9);
    expect(cutTimes(r.clips)).toEqual([2, 5]);
    expect(r.overlays).toEqual(base().overlays);
    // Deleting the neighbour joins the gaps; a gap at the very end is dropped.
    const r2 = deleteClips(r, ["c"], false);
    expect(ids(r2.clips)).toEqual(["a"]);
    const r3 = deleteClips(deleteClips(base(), ["a"], false), ["b"], false);
    expect(r3.clips.map((c) => [c.source.kind, clipLength(c)])).toEqual([
      ["gap", 5],
      ["version", 4],
    ]);
  });
  it("deletes several at once, and ignores unknown ids", () => {
    const r = deleteClips(base(), ["a", "c"], true);
    expect(ids(r.clips)).toEqual(["b"]);
    expect(deleteClips(base(), ["zz"], true)).toEqual(base());
    expect(tidyGaps([gapClip(1, "g1"), gapClip(2, "g2"), clip("x", 2)]).map(clipLength)).toEqual([3, 2]);
  });
});

describe("dips to black and white", () => {
  it("covers the footage fully at the cut and fades linearly on both sides", () => {
    const cs = [clip("a", 10, { out: 3 }), clip("b", 10, { out: 3, transition: "dipBlack", transitionDuration: 1 })];
    expect(placeClips(cs)[1].start).toBe(3); // no overlap
    expect(dipAt(cs, 3)).toEqual({ colour: "black", amount: 1 });
    expect(dipAt(cs, 2.75)?.amount).toBeCloseTo(0.5);
    expect(dipAt(cs, 3.25)?.amount).toBeCloseTo(0.5);
    expect(dipAt(cs, 2.4)).toBeNull();
    expect(dipAt([clip("a", 10, { out: 3 }), clip("b", 10, { out: 3, transition: "dipWhite", transitionDuration: 1 })], 3)?.colour).toBe("white");
  });
});

describe("keyframes", () => {
  const k = (t: number, v: number, e: Keyframe["ease"] = "linear"): Keyframe => ({ t, v, ease: e });
  it("eases in, out and both, from 0 to 1", () => {
    for (const e of ["linear", "easeIn", "easeOut", "easeInOut"] as const) {
      expect(ease(e, 0)).toBe(0);
      expect(ease(e, 1)).toBe(1);
    }
    expect(ease("linear", 0.25)).toBe(0.25);
    expect(ease("easeIn", 0.5)).toBe(0.25);
    expect(ease("easeOut", 0.5)).toBe(0.75);
    expect(ease("easeInOut", 0.25)).toBe(0.125);
    expect(ease("easeInOut", 0.5)).toBe(0.5);
    expect(ease("easeInOut", 0.75)).toBe(0.875);
    expect(ease("easeIn", 2)).toBe(1);
  });
  it("interpolates between keyframes with the first one's easing, and holds outside", () => {
    const keys = [k(1, 0, "linear"), k(2, 10, "easeIn"), k(4, 20)];
    expect(valueAt(undefined, 3, 7)).toBe(7);
    expect(valueAt([], 3, 7)).toBe(7);
    expect(valueAt(keys, 0, 99)).toBe(0);
    expect(valueAt(keys, 1.5, 99)).toBe(5);
    expect(valueAt(keys, 3, 99)).toBe(12.5); // ease in: a quarter of the way at half time
    expect(valueAt(keys, 9, 99)).toBe(20);
  });
  it("sets, replaces, removes and lists keyframes", () => {
    let keys = setKey(undefined, 2, 1);
    keys = setKey(keys, 1, 0, "linear");
    keys = setKey(keys, 2 + 1 / 120, 5); // within half a frame: the same keyframe
    expect(keys).toEqual([k(1, 0, "linear"), { t: 2, v: 5, ease: "easeInOut" }]);
    expect(keyAt(keys, 1.001)?.v).toBe(0);
    expect(removeKey(keys, 1)).toEqual([{ t: 2, v: 5, ease: "easeInOut" }]);
    expect(keyTimes({ x: [k(0, 0), k(2, 1)], opacity: [k(2, 1), k(3, 0)] })).toEqual([0, 2, 3]);
    expect(diamondTimes(10, { x: [k(0, 0), k(2, 1), k(9, 1)] }, 13)).toEqual([10, 12]);
  });
  it("splits a set so neither half jumps", () => {
    const [l, r] = splitKeyframes({ opacity: [k(0, 0), k(2, 1)] }, 1);
    expect(l?.opacity).toEqual([k(0, 0), k(1, 0.5)]);
    expect(r?.opacity).toEqual([k(0, 0.5), k(1, 1)]);
    expect(splitKeyframes(undefined, 1)).toEqual([undefined, undefined]);
  });
  it("moves a text or logo layer and a clip's framing over time", () => {
    const t = { ...newTextOverlay("Hello", 2, 6, "t"), keyframes: { opacity: [k(0, 0), k(1, 1)], y: [k(0, 0.9, "easeOut"), k(1, 0.8)] } };
    expect(overlayState(t, 2)).toMatchObject({ opacity: 0, y: 0.9, x: 0.5, scale: 1 });
    expect(overlayState(t, 2.5).opacity).toBeCloseTo(0.5);
    expect(overlayState(t, 2.5).y).toBeCloseTo(0.9 - 0.1 * 0.75);
    expect(overlayState(t, 5)).toMatchObject({ opacity: 1, y: 0.8 });
    const logo = { ...newLogoOverlay("/l.png", "L", 0, 4, "l"), opacity: 0.8, keyframes: { scale: [k(0, 0.5), k(2, 1.5)] } };
    expect(overlayState(logo, 1)).toMatchObject({ scale: 1, opacity: 0.8 });
    const c = clip("a", 10, { framing: { fit: "fill", zoom: 1, x: 0, y: 0 }, keyframes: { zoom: [k(0, 1), k(4, 2)], x: [k(0, -1), k(4, 1)] } });
    expect(clipFramingAt(project(), c, 2)).toEqual({ fit: "fill", zoom: 1.5, x: 0, y: 0 });
    expect(clipFramingAt(project(), clip("b", 3), 1)).toEqual(project().framing);
  });
  it("checks keyframes as saved and refuses bad ones", () => {
    const ok = checkOverlays([{ ...newTextOverlay("Hi", 0, 2, "t"), second: "مرحبا", keyframes: { opacity: [{ t: 1, v: 1 }, { t: 0, v: 0, ease: "easeIn" }] } }]);
    expect(Array.isArray(ok) && ok[0].kind === "text" && ok[0].keyframes?.opacity).toEqual([
      { t: 0, v: 0, ease: "easeIn" },
      { t: 1, v: 1, ease: "easeInOut" },
    ]);
    expect(checkOverlays([{ ...newTextOverlay("Hi", 0, 2, "t"), keyframes: { opacity: [{ t: 0, v: 3 }] } }])).toMatch(/between 0 and 1/);
    expect(checkOverlays([{ ...newTextOverlay("Hi", 0, 2, "t"), keyframes: { zoom: [{ t: 0, v: 1 }] } }])).toMatch(/cannot be keyframed/);
    expect(validateProject({ ...project(), clips: [clip("a", 5, { keyframes: { opacity: [{ t: 0, v: 1, ease: "linear" }] } })] })).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be keyframed") });
  });
});

describe("bilingual text", () => {
  it("gives each line its own direction: Arabic right to left, English left to right", () => {
    expect(textParagraphs({ text: "عرض خاص", second: "Special offer" })).toEqual([
      { text: "عرض خاص", dir: "rtl" },
      { text: "Special offer", dir: "ltr" },
    ]);
    expect(textParagraphs({ text: "New in\nجديد" })).toEqual([
      { text: "New in", dir: "ltr" },
      { text: "جديد", dir: "rtl" },
    ]);
    expect(textParagraphs({ text: "Only", second: "  " })).toHaveLength(1);
  });
});

describe("beat alignment with locks and speech", () => {
  const beats = [1, 2, 3, 4, 5, 6, 7, 8];
  it("rolls each cut onto its beat, keeping the total length and the other cuts", () => {
    const cs = [clip("a", 10, { out: 2.9 }), clip("b", 10, { in: 1, out: 3.2 }), clip("c", 10, { in: 1, out: 4 })];
    const r = alignCutsToBeats(cs, beats, 0.25);
    expect(cutTimes(r.clips)).toEqual([3, 5]);
    expect(totalLength({ clips: r.clips })).toBeCloseTo(totalLength({ clips: cs }));
    expect(r.moved).toBe(2);
    expect(r.clips[1].in).toBeCloseTo(1.1);
  });
  it("never moves a locked clip nor cuts inside speech", () => {
    const cs = [clip("a", 10, { out: 2.9 }), clip("b", 10, { in: 1, out: 3.2, locked: true }), clip("c", 10, { in: 1, out: 4, speech: true })];
    const r = alignCutsToBeats(cs, beats, 0.25);
    expect(r.clips).toEqual(cs);
    expect(r.kept).toBe(2);
    // Moving the cut earlier needs footage before the next clip's in point: none here, so the cut stays.
    const noRoom = alignCutsToBeats([clip("a", 10, { out: 3.1 }), clip("b", 10, { in: 0, out: 3 })], beats, 0.25);
    expect(noRoom.moved).toBe(0);
    expect(noRoom.kept).toBe(1);
  });
});

describe("the mix: clip levels, music span, fades and ducking", () => {
  it("keeps a clip's volume, mutes it, and ramps it under crossfades and dips", () => {
    const cs = [clip("a", 10, { out: 4, volume: 0.5 }), clip("b", 10, { out: 4, transition: "crossfade", transitionDuration: 1 }), clip("c", 10, { out: 4, transition: "dipBlack", transitionDuration: 1, muted: true })];
    const placed = placeClips(cs);
    expect(clipGainAt(cs, 0, 1, placed)).toBe(0.5);
    expect(clipGainAt(cs, 0, 3.5, placed)).toBeCloseTo(0.25); // fading out under the crossfade
    expect(clipGainAt(cs, 1, 3.5, placed)).toBeCloseTo(0.5); // fading in
    expect(clipGainAt(cs, 1, 6.75, placed)).toBeCloseTo(0.5); // half way down the dip
    expect(clipGainAt(cs, 2, 8, placed)).toBe(0); // muted
    expect(clipGainAt(cs, 0, 9, placed)).toBe(0); // outside the clip
    expect(clipGainPoints(cs, 1, placed)).toEqual([
      [3, 0],
      [4, 1],
      [6.5, 1],
      [7, 0],
    ]);
  });
  it("merges speech spans from clips marked 'has speech' and the voice-over", () => {
    const p = project({
      clips: [clip("a", 10, { out: 2, speech: true }), clip("b", 10, { out: 2, speech: true }), clip("c", 10, { out: 2, speech: true, muted: true })],
      voices: [{ id: "v", source: { kind: "upload", name: "v.wav", size: 1 }, name: "VO", start: 4.5, in: 1, out: 2, duration: 3, volume: 1 }],
    });
    expect(speechSpans(p)).toEqual([
      [0, 4],
      [4.5, 5.5],
    ]);
    expect(mergeSpans([[3, 4], [1, 2], [2, 2.5]])).toEqual([
      [1, 2.5],
      [3, 4],
    ]);
  });
  it("ducks sidechain-style: down before the words, back up after them", () => {
    const spans = [[2, 3]] as const;
    expect(duckFactor(spans, 0.3, 1)).toBe(1);
    expect(duckFactor(spans, 0.3, 2 - DUCK_ATTACK / 2)).toBeCloseTo(0.65);
    expect(duckFactor(spans, 0.3, 2.5)).toBe(0.3);
    expect(duckFactor(spans, 0.3, 3 + DUCK_RELEASE / 2)).toBeCloseTo(0.65);
    expect(duckFactor(spans, 0.3, 3 + DUCK_RELEASE + 0.01)).toBe(1);
  });
  it("plays the music only inside its span, with volume, fades and ducking, as one curve", () => {
    const p = project({
      clips: [clip("a", 20, { out: 10 }), clip("b", 20, { out: 4, speech: true })],
      music: { source: { kind: "upload", name: "m.mp3", size: 1 }, offset: 3, volume: 0.8, fadeIn: 1, fadeOut: 2, start: 1, end: 13, duration: 60, duck: { enabled: true, level: 0.25 } },
    });
    expect(musicGainAt(p, 0.5)).toBe(0);
    expect(musicGainAt(p, 1.5)).toBeCloseTo(0.4); // half way through the fade in
    expect(musicGainAt(p, 5)).toBeCloseTo(0.8);
    expect(musicGainAt(p, 11)).toBeCloseTo(0.8 * 0.25); // under the speech clip (10 … 14)
    expect(musicGainAt(p, 12)).toBeCloseTo(0.8 * 0.25 * 0.5); // and fading out (11 … 13)
    expect(musicGainAt(p, 13.5)).toBe(0); // after its end
    const curve = musicGainCurve(p);
    expect(curve.length).toBe(Math.ceil(14 * CURVE_RATE) + 1);
    expect(curve[500]).toBeCloseTo(musicGainAt(p, 5));
    expect(curve[1100]).toBeCloseTo(musicGainAt(p, 11));
    // The preview starts mid-cut on the same samples.
    expect(curveFrom(curve, 5)[0]).toBe(curve[500]);
    expect(curveFrom(curve, 99).length).toBe(2);
    // Ducking off: the music stays at its volume under speech.
    expect(musicGainAt({ ...p, music: { ...p.music!, duck: { enabled: false, level: 0.25 } } }, 11)).toBeCloseTo(0.8);
    // Beats follow the music's place: track second 3 plays at timeline 1.
    expect(timelineBeats({ beats: [3, 4, 20], offset: 3, start: 1, end: 13 }, 14)).toEqual([1, 2]);
  });
});

describe("the automatic first cut", () => {
  const curve = (duration: number, peakAt: number, step = 0.5) => {
    const n = Math.round(duration / step);
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) e[i] = Math.max(0, 1 - Math.abs(i * step - peakAt) / 3);
    return { energy: e, step };
  };
  const inputs: FirstCutInput[] = [
    { id: "a", source: src("a"), duration: 20, ...curve(20, 12) },
    { id: "b", source: src("b"), duration: 15, ...curve(15, 2) },
    { id: "c", source: src("c"), duration: 10, energy: new Float32Array(20).fill(2), step: 0.5 },
  ];
  it("follows the purpose: a launch opens on the liveliest clip and ends on a dip to black; a story keeps the order", () => {
    const launch = planFirstCut(inputs, { purpose: "launch", pace: "balanced", target: 12 });
    expect(launch.clips[0].source).toEqual(src("c"));
    expect(launch.clips[launch.clips.length - 1].transition).toBe("dipBlack");
    const story = planFirstCut(inputs, { purpose: "story", pace: "calm", target: 12 });
    expect(story.clips.slice(0, 3).map((c) => c.source)).toEqual([src("a"), src("b"), src("c")]);
    expect(story.clips.slice(1).every((c) => c.transition === "crossfade")).toBe(true);
    const promo = planFirstCut(inputs, { purpose: "promo", pace: "energetic", target: 10 });
    expect(promo.clips[0].source).toEqual(src("c"));
    expect(promo.clips.every((c) => c.transition === "cut")).toBe(true);
    expect(promo.look).toBe("punch");
  });
  it("sets shot lengths by pace and lands near the target", () => {
    for (const pace of ["calm", "balanced", "energetic"] as const) {
      const r = planFirstCut(inputs, { purpose: "promo", pace, target: 15 });
      const total = totalLength({ clips: r.clips });
      expect(total).toBeGreaterThan(10);
      expect(total).toBeLessThanOrEqual(15.6);
    }
    const calm = planFirstCut(inputs, { purpose: "promo", pace: "calm", target: 15 }).clips.map(clipLength);
    const fast = planFirstCut(inputs, { purpose: "promo", pace: "energetic", target: 15 }).clips.map(clipLength);
    expect(Math.max(...fast)).toBeLessThanOrEqual(2.5 + 1e-9);
    expect(calm.length).toBeLessThan(fast.length);
  });
  it("cuts on whole beats when music is set", () => {
    const beats = Array.from({ length: 60 }, (_, i) => i * 0.5);
    const r = planFirstCut(inputs, { purpose: "promo", pace: "energetic", target: 10, beats });
    for (const c of r.clips) expect(Math.abs(clipLength(c) / 0.5 - Math.round(clipLength(c) / 0.5))).toBeLessThan(1e-6);
  });
  it("keeps locked clips exactly where they were", () => {
    const locked = clip("L", 30, { in: 10, out: 13, locked: true });
    const r = planFirstCut(inputs, { purpose: "promo", pace: "balanced", target: 15, locked: [{ clip: locked, start: 5 }] });
    const pl = placeClips(r.clips).find((p) => p.clip.id === "L")!;
    expect(pl.start).toBeCloseTo(5, 3);
    expect(pl.clip).toEqual(locked);
    // Twice with crossfades around it: still exactly in place.
    const calm = planFirstCut(inputs, { purpose: "story", pace: "calm", target: 20, locked: [{ clip: locked, start: 7 }] });
    expect(placeClips(calm.clips).find((p) => p.clip.id === "L")!.start).toBeCloseTo(7, 3);
    // Not enough footage before it: a gap is left and said.
    const thin = planFirstCut([{ id: "s", source: src("s"), duration: 1, energy: [], step: 0.5 }], { purpose: "story", pace: "balanced", target: 6, locked: [{ clip: locked, start: 4 }] });
    expect(placeClips(thin.clips).find((p) => p.clip.id === "L")!.start).toBeCloseTo(4, 3);
    expect(thin.notes.join(" ")).toMatch(/gap/);
  });
  it("uses speech whole, never cutting inside it, and no other shot takes those seconds", () => {
    const withSpeech: FirstCutInput[] = [{ ...inputs[0], speech: [{ in: 11, out: 14.5 }] }, inputs[1]];
    const r = planFirstCut(withSpeech, { purpose: "promo", pace: "energetic", target: 12 });
    const speech = r.clips.filter((c) => c.speech);
    expect(speech).toHaveLength(1);
    expect(speech[0]).toMatchObject({ in: 11, out: 14.5, transition: "cut" });
    const others = r.clips.filter((c) => !c.speech && c.source.kind === "version" && c.source.videoId === "a");
    for (const o of others) expect(o.out <= 11 + 1e-9 || o.in >= 14.5 - 1e-9).toBe(true);
    expect(r.notes.join(" ")).toMatch(/speech segment kept whole/);
    expect(windowAvoiding(inputs[0], 4, 0, [{ in: 9, out: 15 }])).not.toBeNull();
    expect(windowAvoiding({ ...inputs[2], duration: 3 }, 2, 0, [{ in: 0.5, out: 2.5 }])).toBeNull();
  });
  it("is deterministic and copes with no footage", () => {
    expect(planFirstCut(inputs, { purpose: "launch", pace: "calm", target: 14 })).toEqual(planFirstCut(inputs, { purpose: "launch", pace: "calm", target: 14 }));
    expect(planFirstCut([], { purpose: "promo", pace: "calm", target: 10 }).clips).toEqual([]);
    const r = planFirstCut(inputs, { purpose: "promo", pace: "balanced", target: 15 });
    expect(validateProject({ ...project(), clips: r.clips }).ok).toBe(true);
  });
});

describe("project version 2 and the migration from version 1", () => {
  const v1 = {
    v: 1,
    rev: 3,
    createdAt: 1,
    updatedAt: 2,
    name: "Old cut",
    clips: [
      { id: "a", source: src("a"), duration: 10, in: 0, out: 4, speed: 1, transition: "cut", transitionDuration: 0.5 },
      { id: "b", source: src("b"), duration: 10, in: 1, out: 5, speed: 1, transition: "crossfade", transitionDuration: 0.5 },
    ],
    look: "warm",
    colour: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 },
    lut: null,
    music: { source: { kind: "audioKey", key: "t1", name: "Song" }, offset: 2, volume: 0.9, fadeIn: 0.5, fadeOut: 1, beats: [2, 2.5, 3] },
    output: { width: 1080, height: 1920, fps: 30, bitrate: 8_000_000 },
    snapToBeats: true,
    framing: { fit: "fill", zoom: 1, x: 0, y: 0 },
    background: "#000000",
    overlays: [{ id: "t", kind: "text", text: "Hello", start: 0, end: 2, x: 0.5, y: 0.8, size: 0.06, color: "#ffffff", font: "sans", weight: 800, align: "center", box: null, width: 0.86 }],
  };
  it("opens a version 1 draft as version 2, sounding as it did (clips muted under its music)", () => {
    // Phase 3 moved the current version to 3 (2 → 3 after this 1 → 2 step); the phase-2 fields are unchanged.
    expect(PROJECT_VERSION).toBe(3);
    const r = validateProject(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.v).toBe(PROJECT_VERSION);
    expect(r.project.rev).toBe(3);
    expect(r.project.clips.every((c) => c.muted === true)).toBe(true);
    expect(r.project.music).toMatchObject({ start: 0, offset: 2, duck: { enabled: false } });
    expect(r.project.voices).toEqual([]);
    expect(r.project.overlays[0]).toMatchObject({ text: "Hello" });
    expect(timelineBeats(r.project.music, 10)).toEqual([0, 0.5, 1]);
    // Without music, the clips keep their sound.
    const noMusic = validateProject({ ...v1, music: null });
    expect(noMusic.ok && noMusic.project.clips.some((c) => c.muted)).toBe(false);
    expect(migrateV1({ ...v1 }).v).toBe(2);
    // Saved again, it stays version 2 and round-trips.
    if (r.ok) expect(validateProject(JSON.parse(JSON.stringify(r.project)))).toEqual(r);
  });
  it("keeps every version 2 field through a save, and refuses an unknown version", () => {
    const p = project({
      clips: [clip("a", 10, { out: 4, volume: 0.4, locked: true, speech: true, keyframes: { zoom: [{ t: 0, v: 1, ease: "linear" }, { t: 2, v: 1.4, ease: "easeOut" }] } }), gapClip(1.5, "g"), clip("b", 10, { out: 3, transition: "dipWhite", transitionDuration: 0.8, muted: true })],
      overlays: [{ ...newTextOverlay("عرض", 0, 3, "t"), second: "Offer", opacity: 0.9, keyframes: { opacity: [{ t: 0, v: 0, ease: "linear" }, { t: 0.5, v: 0.9, ease: "linear" }] } }],
      music: { source: { kind: "upload", name: "m.mp3", size: 10 }, offset: 1, volume: 0.7, fadeIn: 1, fadeOut: 1, start: 0.5, end: 8, duck: { enabled: true, level: 0.2 } },
      voices: [{ id: "v", source: { kind: "audioKey", key: "k", name: "VO" }, name: "VO", start: 1, in: 0, out: 3, duration: 4, volume: 0.9 }],
    });
    const r = validateProject(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.clips).toEqual(p.clips);
    expect(r.project.overlays).toEqual(p.overlays);
    expect(r.project.music).toEqual(p.music);
    expect(r.project.voices).toEqual(p.voices);
    expect(validateProject({ ...p, v: 99 })).toMatchObject({ ok: false, reason: expect.stringContaining("version") });
    expect(validateProject({ ...p, music: { ...p.music, start: 5, end: 4 } })).toMatchObject({ ok: false, reason: expect.stringContaining("start before the end") });
    expect(validateProject({ ...p, voices: [{ ...p.voices[0], out: 9 }] })).toMatchObject({ ok: false, reason: expect.stringContaining("voice-over 1") });
    expect(validateProject({ ...p, clips: [clip("a", 5, { volume: 3 })] })).toMatchObject({ ok: false, reason: expect.stringContaining("volume") });
    expect(validateProject({ ...p, clips: [clip("a", 5, { transition: "wipe" as never })] })).toMatchObject({ ok: false, reason: expect.stringContaining("dip") });
  });
});
