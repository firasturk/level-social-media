/**
 * Fades on every sound of a cut, without a browser: the one fade arithmetic (`fadeGain`) the music,
 * the voice-overs and each clip's own sound share; the clip's fades on its trimmed place on the
 * timeline, on top of crossfades and dips; the breakpoints the render hands to Web Audio and the
 * part of them the preview plays from the playhead (`pointsFrom`), which must agree with the level
 * the preview reads directly; and what `validateProject` takes and refuses. An older document
 * without the new fields reads back unchanged.
 */
import { describe, expect, it } from "vitest";
import { MAX_FADE_SECONDS, newClip, newProject, placeClips, splitClip, validateProject, type Clip, type VideoProject, type VoiceClip } from "../shared/video-project";
import { clipGainAt, clipGainPoints, FADE_STEP, fadeGain, fadeTimes, musicGainAt, pointsFrom, voiceGainAt, voiceGainPoints, voiceSpan } from "../shared/video-mix";

const src = (id: string) => ({ kind: "version" as const, batch: "b1", videoId: id });
const clip = (id: string, duration: number, patch: Partial<Clip> = {}): Clip => ({ ...newClip(src(id), duration, id), ...patch });
const project = (patch: Partial<VideoProject> = {}): VideoProject => ({ ...newProject("Cut", 1000), ...patch });
const voice = (patch: Partial<VoiceClip> = {}): VoiceClip => ({ id: "v1", source: { kind: "upload", name: "vo.wav", size: 10 }, name: "VO", start: 2, in: 1, out: 5, duration: 6, volume: 0.8, ...patch });

/** The level a list of breakpoints gives at t, read off the straight lines between them (what Web Audio's linear ramps play). */
function lineAt(points: readonly (readonly [number, number])[], t: number): number {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t0, g0] = points[i - 1];
    const [t1, g1] = points[i];
    if (t <= t1) return t1 > t0 ? g0 + ((g1 - g0) * (t - t0)) / (t1 - t0) : g1;
  }
  return points[points.length - 1][1];
}

describe("fadeGain: one fade for the music, the voice-overs and the clips", () => {
  it("rises over the fade in, holds, falls over the fade out, and is silent outside the span", () => {
    expect(fadeGain(1, 2, 10, 2, 4)).toBe(0); // before the span
    expect(fadeGain(2, 2, 10, 2, 4)).toBe(0); // the first instant of a fade in
    expect(fadeGain(3, 2, 10, 2, 4)).toBeCloseTo(0.5);
    expect(fadeGain(4, 2, 10, 2, 4)).toBe(1);
    expect(fadeGain(5.5, 2, 10, 2, 4)).toBe(1);
    expect(fadeGain(8, 2, 10, 2, 4)).toBeCloseTo(0.5);
    expect(fadeGain(10, 2, 10, 2, 4)).toBe(0);
    expect(fadeGain(10.01, 2, 10, 2, 4)).toBe(0); // after it
  });
  it("is 1 over the whole span without fades (absent = 0), and 0 for an empty span", () => {
    expect(fadeGain(2, 2, 10)).toBe(1);
    expect(fadeGain(10, 2, 10, 0, 0)).toBe(1);
    expect(fadeGain(5, 2, 10, -1, -1)).toBe(1);
    expect(fadeGain(2, 2, 2, 1, 1)).toBe(0);
  });
  it("multiplies overlapping fades so a short sound with long fades never jumps", () => {
    // 2 s long, 2 s in and 2 s out: at the middle each ramp is at a half.
    expect(fadeGain(1, 0, 2, 2, 2)).toBeCloseTo(0.25);
    for (let t = 0; t <= 2; t += 0.1) expect(fadeGain(t, 0, 2, 2, 2)).toBeLessThanOrEqual(0.25 + 1e-9);
  });
  it("is the music's fade: musicGainAt is volume × fadeGain over the music's span", () => {
    const p = project({
      clips: [clip("a", 20, { out: 12 })],
      music: { source: { kind: "upload", name: "m.mp3", size: 1 }, offset: 0, volume: 0.6, fadeIn: 1.5, fadeOut: 2, start: 1, end: 11, duck: { enabled: false, level: 0.3 } },
    });
    for (const t of [0.5, 1, 1.75, 2.5, 6, 9.5, 10.4, 11, 11.5]) expect(musicGainAt(p, t)).toBeCloseTo(0.6 * fadeGain(t, 1, 11, 1.5, 2), 10);
  });
});

describe("a clip's own sound: fades on its place on the timeline", () => {
  it("fades the trimmed, sped clip from its start and to its end on the timeline", () => {
    // Source 2 … 8 at ×2: 3 s on the timeline, after a 4 s clip.
    const cs = [clip("a", 10, { out: 4 }), clip("b", 10, { in: 2, out: 8, speed: 2, volume: 0.5, fadeIn: 1, fadeOut: 0.5 })];
    const placed = placeClips(cs);
    expect(placed[1].start).toBe(4);
    expect(placed[1].end).toBe(7);
    expect(clipGainAt(cs, 1, 4, placed)).toBe(0);
    expect(clipGainAt(cs, 1, 4.5, placed)).toBeCloseTo(0.25);
    expect(clipGainAt(cs, 1, 5.5, placed)).toBeCloseTo(0.5);
    expect(clipGainAt(cs, 1, 6.75, placed)).toBeCloseTo(0.25);
    expect(clipGainAt(cs, 1, 7, placed)).toBe(0);
    // The clip before is untouched.
    expect(clipGainAt(cs, 0, 3.9, placed)).toBe(1);
  });
  it("stacks with a crossfade: the product of both ramps", () => {
    const cs = [clip("a", 10, { out: 4, fadeOut: 2 }), clip("b", 10, { out: 4, transition: "crossfade", transitionDuration: 1, fadeIn: 2 })];
    const placed = placeClips(cs);
    // b starts at 3 under a 1 s crossfade; at 3.5 the crossfade gives 0.5 and its own fade in 0.25.
    expect(clipGainAt(cs, 1, 3.5, placed)).toBeCloseTo(0.5 * 0.25);
    // a ends at 4: at 3.5 the crossfade out gives 0.5 and its 2 s fade out 0.25.
    expect(clipGainAt(cs, 0, 3.5, placed)).toBeCloseTo(0.5 * 0.25);
  });
  it("hands the render breakpoints that follow the level the preview reads, to well under 1 %", () => {
    const cs = [clip("a", 10, { out: 4, fadeOut: 2 }), clip("b", 10, { out: 4, transition: "crossfade", transitionDuration: 1, fadeIn: 2, fadeOut: 1.3, volume: 0.7 }), clip("c", 10, { out: 3, transition: "dipBlack", transitionDuration: 1 })];
    const placed = placeClips(cs);
    for (const i of [0, 1, 2]) {
      const pts = clipGainPoints(cs, i, placed);
      for (let k = 1; k < pts.length; k++) expect(pts[k][0]).toBeGreaterThan(pts[k - 1][0]);
      for (let t = placed[i].start; t <= placed[i].end; t += 0.013) expect(Math.abs(lineAt(pts, t) - clipGainAt(cs, i, t, placed))).toBeLessThan(0.005);
    }
  });
  it("adds no breakpoints to a clip without fades", () => {
    const cs = [clip("a", 10, { out: 4 }), clip("b", 10, { out: 4, transition: "crossfade", transitionDuration: 1 })];
    expect(clipGainPoints(cs, 1)).toEqual([
      [3, 0],
      [4, 1],
      [7, 1],
    ]);
  });
  it("leaves a muted clip silent whatever its fades", () => {
    const cs = [clip("a", 10, { out: 4, muted: true, fadeIn: 1, fadeOut: 1 })];
    expect(clipGainAt(cs, 0, 2)).toBe(0);
  });
  it("keeps the fade in on the first half of a split and the fade out on the second", () => {
    const [l, r] = splitClip(clip("a", 10, { out: 8, fadeIn: 1, fadeOut: 2 }), 3)!;
    expect(l.fadeIn).toBe(1);
    expect(l.fadeOut).toBeUndefined();
    expect(r.fadeIn).toBeUndefined();
    expect(r.fadeOut).toBe(2);
  });
});

describe("a voice-over's fades", () => {
  it("fades over its trimmed place on the timeline at its volume", () => {
    const v = voice({ fadeIn: 1, fadeOut: 2 }); // 2 … 6 on the timeline
    expect(voiceSpan(v)).toEqual({ start: 2, end: 6 });
    expect(voiceGainAt(v, 1.9)).toBe(0);
    expect(voiceGainAt(v, 2.5)).toBeCloseTo(0.4);
    expect(voiceGainAt(v, 3.5)).toBeCloseTo(0.8);
    expect(voiceGainAt(v, 5)).toBeCloseTo(0.4);
    expect(voiceGainAt(v, 6)).toBe(0);
  });
  it("plays at its volume from end to end without fades: two breakpoints", () => {
    expect(voiceGainPoints(voice())).toEqual([
      [2, 0.8],
      [6, 0.8],
    ]);
  });
  it("gives breakpoints the render and the preview share, on the same line as voiceGainAt", () => {
    const v = voice({ fadeIn: 1.2, fadeOut: 3.5 }); // the fades overlap on a 4 s recording
    const pts = voiceGainPoints(v);
    expect(pts[0]).toEqual([2, 0]);
    expect(pts[pts.length - 1]).toEqual([6, 0]);
    expect(fadeTimes(2, 6, 1.2, 3.5).length).toBeGreaterThan(1.2 / FADE_STEP);
    for (let t = 2; t <= 6; t += 0.011) expect(Math.abs(lineAt(pts, t) - voiceGainAt(v, t))).toBeLessThan(0.005);
    // The preview starting at 3.3 s: the same line from there on.
    const from = pointsFrom(pts, 3.3);
    expect(from[0][0]).toBe(3.3);
    for (let t = 3.3; t <= 6; t += 0.017) expect(lineAt(from, t)).toBeCloseTo(lineAt(pts, t), 9);
  });
});

describe("pointsFrom: the render's breakpoints from the playhead on", () => {
  const pts: [number, number][] = [
    [1, 0],
    [2, 1],
    [5, 1],
    [6, 0],
  ];
  it("keeps every point when the playhead is before the first", () => {
    expect(pointsFrom(pts, 0)).toEqual(pts);
  });
  it("starts with the value on the line at the playhead", () => {
    expect(pointsFrom(pts, 1.5)).toEqual([
      [1.5, 0.5],
      [2, 1],
      [5, 1],
      [6, 0],
    ]);
    expect(pointsFrom(pts, 5.75)).toEqual([
      [5.75, 0.25],
      [6, 0],
    ]);
  });
  it("holds the last value after the end, and gives nothing for no points", () => {
    expect(pointsFrom(pts, 9)).toEqual([[9, 0]]);
    expect(pointsFrom([], 1)).toEqual([]);
  });
});

describe("validateProject and the new fades", () => {
  const withVoice = (v: Partial<VoiceClip> & Record<string, unknown>) => ({ ...project({ clips: [clip("a", 10)] }), voices: [{ ...voice(), ...v }] });
  it("keeps the fades of a clip and a voice-over", () => {
    const r = validateProject({ ...project({ clips: [clip("a", 10, { fadeIn: 0.5, fadeOut: 1.5 })] }), voices: [voice({ fadeIn: 1, fadeOut: 2.5 })] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.clips[0]).toMatchObject({ fadeIn: 0.5, fadeOut: 1.5 });
    expect(r.project.voices[0]).toMatchObject({ fadeIn: 1, fadeOut: 2.5 });
  });
  it("reads an older document unchanged: no fades are added where there were none", () => {
    const r = validateProject({ ...project({ clips: [clip("a", 10, { volume: 0.5 })] }), voices: [voice()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("fadeIn" in r.project.clips[0]).toBe(false);
    expect("fadeOut" in r.project.clips[0]).toBe(false);
    expect("fadeIn" in r.project.voices[0]).toBe(false);
    expect("fadeOut" in r.project.voices[0]).toBe(false);
    // A zero fade is no fade, and is not kept.
    const z = validateProject({ ...project({ clips: [clip("a", 10, { fadeIn: 0 })] }), voices: [voice({ fadeOut: 0 })] });
    expect(z.ok && "fadeIn" in z.project.clips[0]).toBe(false);
    expect(z.ok && "fadeOut" in z.project.voices[0]).toBe(false);
  });
  it("refuses fades that are not seconds between 0 and the maximum", () => {
    expect(MAX_FADE_SECONDS).toBe(30);
    expect(validateProject({ ...project({ clips: [clip("a", 10, { fadeIn: 31 })] }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/clip 1: the sound's fade in and fade out/) });
    expect(validateProject({ ...project({ clips: [clip("a", 10, { fadeOut: -1 })] }) }).ok).toBe(false);
    expect(validateProject({ ...project({ clips: [{ ...clip("a", 10), fadeIn: "2" as unknown as number }] }) }).ok).toBe(false);
    expect(validateProject(withVoice({ fadeIn: 30.5 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/voice-over 1: the fade in and fade out/) });
    expect(validateProject(withVoice({ fadeOut: Number.NaN }))).toMatchObject({ ok: false });
    expect(validateProject(withVoice({ fadeOut: "1" as unknown as number }))).toMatchObject({ ok: false });
    expect(validateProject(withVoice({ fadeIn: 30, fadeOut: 0.1 })).ok).toBe(true);
  });
});
