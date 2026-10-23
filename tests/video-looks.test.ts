/**
 * Phase 3 of the video editor, without a browser: the colour presets and their intensity, the
 * scope they apply to, skin protection, the colour match (Lab statistics, the fit, its stability
 * across frames), the LUT kept with the draft (serialise, parse, the size bound), the six templates
 * as valid projects, the music library's sources with their rights, and old drafts migrated.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_COLOUR, LOOKS, lookOf, musicSourceFromTrack, newClip, newProject, PRESET_IDS, PROJECT_VERSION, totalLength, validateProject, type Clip, type ColourParams, type VideoProject } from "../shared/video-project";
import { addParams, applyLook, applyParams, clearClipLooks, clipLook, gradePixel, hsv, presetParams, protectSkin, resolveGrade, setLookAmount, setMatch, skinWeight } from "../shared/video-looks";
import { applyMatch, checkMatch, fitTransfer, labStats, labToRgb, matchedStats, poolStats, rgbToLab, statsDistance, type ColourMatch, type Vec3 } from "../shared/colour-match";
import { MAX_STORED_LUT_SIZE, parseCube, parseStoredCube, resampleCube, sampleCube, serialiseCube, storedLutChars, type CubeLut } from "../shared/cube-lut";
import { applyTemplate, estimateLines, templateLength, TEMPLATES } from "../shared/video-templates";
import { catalogEntry } from "../shared/music-catalog";
import { catalogTrack } from "../server/music";
import type { MusicTrack } from "../shared/music";

const src = (id: string) => ({ kind: "version" as const, batch: "b1", videoId: id });
const clip = (id: string, duration: number, patch: Partial<Clip> = {}): Clip => ({ ...newClip(src(id), duration, id), ...patch });
const project = (patch: Partial<VideoProject> = {}): VideoProject => ({ ...newProject("Looks", 1000), clips: [clip("a", 4), clip("b", 4), clip("c", 4)], ...patch });
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const hueOf = (c: Vec3) => hsv(c)[0];
const hueDiff = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** A deterministic pseudo-random source (no Math.random in tests). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** RGBA bytes of `n` pixels around a colour with a spread (and an optional brightness shift for "this frame"). */
function picture(n: number, mean: Vec3, spread: number, seed: number, shift = 0): Uint8ClampedArray {
  const r = rng(seed);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const t = r() * 2 - 1;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, mean[c] + shift + t * spread + (r() - 0.5) * 0.04)));
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe("colour presets and intensity", () => {
  it("has the five presets, in order, plus None and Mono; the phase-1 looks stay readable", () => {
    expect(PRESET_IDS).toEqual(["clean", "warm-film", "cool-editorial", "soft-matte", "bold-sport"]);
    expect(PRESET_IDS.map((id) => lookOf(id).name)).toEqual(["Clean", "Warm Film", "Cool Editorial", "Soft Matte", "Bold Sport"]);
    for (const id of ["warm", "cool", "matte", "punch"]) {
      const l = lookOf(id);
      expect(l.id).toBe(id);
      expect(l.legacy).toBe(true);
      expect(PRESET_IDS as readonly string[]).toContain(l.replacedBy);
    }
    // Phase 1's values, unchanged: a saved draft that used them draws as before.
    expect(lookOf("warm").params).toEqual({ ...DEFAULT_COLOUR, temperature: 0.3, saturation: 0.08, shadows: 0.12, contrast: 0.06 });
    expect(lookOf("punch").params).toEqual({ ...DEFAULT_COLOUR, contrast: 0.3, saturation: 0.3, exposure: 0.1 });
    expect(lookOf("clean").params).toEqual({ ...DEFAULT_COLOUR, contrast: 0.12, saturation: 0.1 });
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    expect(lookOf("nope").id).toBe("none");
  });

  it("scales every parameter toward the preset: 0 % is unchanged, 100 % the preset, 60 % in between", () => {
    for (const id of PRESET_IDS) {
      expect(presetParams(id, 0)).toEqual(DEFAULT_COLOUR);
      expect(presetParams(id, 1)).toEqual(lookOf(id).params);
      const p60 = presetParams(id, 0.6);
      for (const k of Object.keys(DEFAULT_COLOUR) as (keyof ColourParams)[]) expect(near(p60[k], lookOf(id).params[k] * 0.6)).toBe(true);
    }
    expect(presetParams("bold-sport", 7)).toEqual(lookOf("bold-sport").params);
    expect(presetParams("bold-sport", -1)).toEqual(DEFAULT_COLOUR);
  });

  it("moves a pixel further from the original as the intensity rises (Warm Film warms, Cool Editorial cools)", () => {
    const grey: Vec3 = [0.5, 0.5, 0.5];
    const tan: Vec3 = [0.7, 0.5, 0.3];
    const dist = (c: Vec3) => Math.hypot(c[0] - tan[0], c[1] - tan[1], c[2] - tan[2]);
    for (const id of PRESET_IDS) {
      const d = [0, 0.3, 0.6, 1].map((a) => dist(applyParams(tan, presetParams(id, a))));
      expect(d[0]).toBeCloseTo(0, 9);
      expect(d[1]).toBeLessThan(d[2]);
      expect(d[2]).toBeLessThan(d[3]);
    }
    const warm = applyParams(grey, presetParams("warm-film", 1));
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const cool = applyParams(grey, presetParams("cool-editorial", 1));
    expect(cool[2]).toBeGreaterThan(cool[0]);
    // Bold Sport adds contrast: a dark grey gets darker, a light one lighter.
    expect(applyParams([0.2, 0.2, 0.2], presetParams("bold-sport", 1))[1]).toBeLessThan(0.2);
    expect(applyParams([0.75, 0.75, 0.75], presetParams("bold-sport", 1))[1]).toBeGreaterThan(0.75);
    // Soft Matte lifts the blacks.
    expect(applyParams([0.03, 0.03, 0.03], presetParams("soft-matte", 1))[1]).toBeGreaterThan(0.06);
  });

  it("vibrance moves muted colours more than saturated ones", () => {
    const p = { ...DEFAULT_COLOUR, vibrance: 0.6 };
    const muted: Vec3 = [0.55, 0.5, 0.45];
    const vivid: Vec3 = [0.9, 0.2, 0.1];
    const gain = (c: Vec3) => (hsv(applyParams(c, p))[1] - hsv(c)[1]) / hsv(c)[1];
    expect(gain(muted)).toBeGreaterThan(gain(vivid));
  });

  it("resolves each clip's grade: its own preset, else the project's, plus the sliders", () => {
    const p = project({ look: "warm-film", lookAmount: 0.6, colour: { ...DEFAULT_COLOUR, exposure: 0.1 } });
    p.clips[1] = { ...p.clips[1], look: { id: "bold-sport", amount: 1 }, colour: { ...DEFAULT_COLOUR, contrast: 0.05 } };
    expect(resolveGrade(p, p.clips[0]).params).toEqual(addParams(presetParams("warm-film", 0.6), { exposure: 0.1 }));
    expect(resolveGrade(p, p.clips[1]).params).toEqual(addParams(presetParams("bold-sport", 1), { exposure: 0.1 }, { contrast: 0.05 }));
    expect(resolveGrade(p, null).params).toEqual(addParams(presetParams("warm-film", 0.6), { exposure: 0.1 }));
  });

  it("applies to this clip, chosen clips or the whole video; the whole video clears the clips' own presets", () => {
    let p = project();
    p = applyLook(p, { kind: "clips", ids: ["a"] }, "warm-film", 0.6);
    p = applyLook(p, { kind: "clips", ids: ["b", "c"] }, "bold-sport", 1);
    expect(p.clips.map((c) => clipLook(p, c))).toEqual([{ id: "warm-film", amount: 0.6 }, { id: "bold-sport", amount: 1 }, { id: "bold-sport", amount: 1 }]);
    p = setLookAmount(p, { kind: "clips", ids: ["c"] }, 0.25);
    expect(p.clips[2].look).toEqual({ id: "bold-sport", amount: 0.25 });
    p = clearClipLooks(p, ["c"]);
    expect(p.clips[2].look).toBeUndefined();
    expect(clipLook(p, p.clips[2])).toEqual({ id: "none", amount: 1 });
    const all = applyLook(p, { kind: "all" }, "soft-matte", 0.4);
    expect(all.look).toBe("soft-matte");
    expect(all.lookAmount).toBe(0.4);
    expect(all.clips.every((c) => !c.look)).toBe(true);
    expect(validateProject(all).ok).toBe(true);
    expect(validateProject(p).ok).toBe(true);
  });
});

describe("skin protection (a hue-range heuristic)", () => {
  const skins: Vec3[] = [
    [0.96, 0.8, 0.69], // light
    [0.87, 0.67, 0.53], // medium
    [0.55, 0.37, 0.26], // deep
    [0.36, 0.22, 0.15], // very deep
  ];
  const notSkin: Vec3[] = [
    [0.1, 0.3, 0.9], // blue
    [0.2, 0.7, 0.3], // green
    [0.5, 0.5, 0.5], // grey
    [0.9, 0.1, 0.6], // magenta
    [0.05, 0.04, 0.03], // near black
  ];

  it("weighs skin tones near 1 and other colours at 0", () => {
    for (const c of skins) expect(skinWeight(c)).toBeGreaterThan(0.8);
    for (const c of notSkin) expect(skinWeight(c)).toBe(0);
  });

  it("keeps the hue of skin under a strong cool grade, keeps the grade's brightness, and leaves other colours alone", () => {
    const harsh = { params: addParams(presetParams("cool-editorial", 1), { temperature: -0.8, tint: -0.4, saturation: 0.4 }), match: null };
    for (const c of skins) {
      const free = gradePixel(c, { ...harsh, protectSkin: false });
      const kept = gradePixel(c, { ...harsh, protectSkin: true });
      const shift = hueDiff(hueOf(free), hueOf(c));
      expect(shift).toBeGreaterThan(3);
      // Most of the hue shift is taken back (90 % on a full-weight skin pixel; clipping near white leaves a little more).
      expect(hueDiff(hueOf(kept), hueOf(c))).toBeLessThan(Math.max(1, shift * 0.2));
      const luma = (x: Vec3) => 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
      expect(Math.abs(luma(kept) - luma(free))).toBeLessThan(0.03);
      // The colour part (RGB minus luma) may grow or shrink by about 15 % at most (plus the 10 % of the grade let through).
      // (Light skin pushed toward white by the grade is clipped there, which takes colour away: checked on the others.)
      const chroma = (x: Vec3) => Math.hypot(x[0] - luma(x), x[1] - luma(x), x[2] - luma(x));
      if (c !== skins[0]) {
        expect(chroma(kept) / chroma(c)).toBeGreaterThan(0.8);
        expect(chroma(kept) / chroma(c)).toBeLessThan(1.25);
      }
    }
    for (const c of notSkin) expect(gradePixel(c, { ...harsh, protectSkin: true })).toEqual(gradePixel(c, { ...harsh, protectSkin: false }));
  });

  it("is a no-op where the grade did not change the pixel", () => {
    expect(protectSkin(skins[1], skins[1]).map((v) => Math.round(v * 1e6))).toEqual(skins[1].map((v) => Math.round(v * 1e6)));
  });
});

describe("colour match (Lab statistics)", () => {
  it("goes to Lab and back within a hair", () => {
    for (const c of [[0, 0, 0], [1, 1, 1], [0.8, 0.2, 0.1], [0.1, 0.5, 0.9], [0.5, 0.5, 0.5]] as Vec3[]) {
      const back = labToRgb(...rgbToLab(...c));
      for (let i = 0; i < 3; i++) expect(near(back[i], c[i], 1e-4)).toBe(true);
    }
    expect(rgbToLab(1, 1, 1)[0]).toBeCloseTo(100, 2);
  });

  it("pools frames exactly (the same as measuring them as one picture)", () => {
    const a = picture(500, [0.3, 0.4, 0.6], 0.2, 1);
    const b = picture(700, [0.5, 0.4, 0.3], 0.1, 2);
    const both = new Uint8ClampedArray(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    const pooled = poolStats([labStats(a), labStats(b)]);
    const whole = labStats(both);
    for (let c = 0; c < 3; c++) {
      expect(pooled.mean[c]).toBeCloseTo(whole.mean[c], 6);
      expect(pooled.std[c]).toBeCloseTo(whole.std[c], 6);
    }
  });

  it("fits a transfer that brings a cool clip close to a warm reference", () => {
    const clipPx = picture(4000, [0.35, 0.45, 0.65], 0.18, 3);
    const refPx = picture(4000, [0.75, 0.55, 0.35], 0.12, 4);
    const s = labStats(clipPx);
    const r = labStats(refPx);
    const t = fitTransfer(s, r);
    const m = { ...t, amount: 1 };
    const before = statsDistance(s, r);
    const afterStats = matchedStats(clipPx, m);
    const after = statsDistance(afterStats, r);
    expect(before).toBeGreaterThan(20);
    expect(after).toBeLessThan(before * 0.15);
    // Half strength lands in between.
    const half = statsDistance(matchedStats(clipPx, { ...t, amount: 0.5 }), r);
    expect(half).toBeLessThan(before);
    expect(half).toBeGreaterThan(after);
    // A pixel moves toward the reference's cast: warmer (more red than blue) after.
    const px = applyMatch([0.35, 0.45, 0.65], m);
    expect(px[0]).toBeGreaterThan(px[2]);
  });

  it("is stable across frames: fitting on different frames of a flickering clip gives nearly the same transfer, and one transfer is applied to every frame", () => {
    const ref = labStats(picture(3000, [0.7, 0.55, 0.4], 0.15, 9));
    // Ten frames of the same scene with grain and a small brightness flicker (±3 %).
    const frames = Array.from({ length: 10 }, (_, i) => labStats(picture(2000, [0.3, 0.42, 0.6], 0.2, 100 + i, (i % 2 ? 1 : -1) * 0.03)));
    const fitA = fitTransfer(poolStats(frames.slice(0, 5)), ref);
    const fitB = fitTransfer(poolStats(frames.slice(5)), ref);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(fitA.scale[c] - fitB.scale[c])).toBeLessThan(0.03);
      expect(Math.abs(fitA.offset[c] - fitB.offset[c])).toBeLessThan(1.5);
    }
    // Fitting each frame on its own would chase the flicker: the pooled fits differ far less than single-frame fits do.
    const single = frames.map((f) => fitTransfer(f, ref).offset[0]);
    const spreadSingle = Math.max(...single) - Math.min(...single);
    expect(Math.abs(fitA.offset[0] - fitB.offset[0])).toBeLessThan(spreadSingle / 2);
    // The stored transfer is a pure function of the colour: the same input gives the same output on every frame.
    const m = { ...fitA, amount: 1 };
    expect(applyMatch([0.3, 0.42, 0.6], m)).toEqual(applyMatch([0.3, 0.42, 0.6], m));
  });

  it("bounds the scales (a flat or extreme reference cannot blow a clip out)", () => {
    const flat = labStats(picture(1000, [0.5, 0.5, 0.5], 0, 5));
    const busy = labStats(picture(1000, [0.5, 0.5, 0.5], 0.45, 6));
    const t = fitTransfer(busy, flat);
    expect(t.scale[0]).toBeGreaterThanOrEqual(0.6);
    const t2 = fitTransfer(flat, busy);
    expect(t2.scale.every((v) => v <= 2)).toBe(true);
  });

  it("checks a stored match", () => {
    const good: ColourMatch = { ref: { kind: "studio", id: "r1", name: "Pin" }, scale: [1.1, 0.9, 1], offset: [3, -2, 5], amount: 0.8, frames: 5, at: 1 };
    expect(checkMatch(good, "clip 1")).toEqual(good);
    expect(checkMatch({ ...good, ref: { ...good.ref, kind: "web" } }, "clip 1")).toMatch(/kind/);
    expect(checkMatch({ ...good, scale: [9, 1, 1] }, "clip 1")).toMatch(/scale/);
    expect(checkMatch({ ...good, amount: 2 }, "clip 1")).toMatch(/amount/);
    expect(checkMatch({ ...good, ref: { ...good.ref, thumb: "data:image/jpeg;base64," + "A".repeat(9000) } }, "clip 1")).toMatch(/thumb/);
    const p = setMatch(project(), ["b"], good);
    const r = validateProject(p);
    expect(r.ok && r.project.clips[1].match).toEqual(good);
    expect(setMatch(p, ["b"], null).clips[1].match).toBeUndefined();
    expect(validateProject({ ...p, clips: [p.clips[0], { ...p.clips[1], match: { ...good, offset: [0, 0] } }] })).toMatchObject({ ok: false, reason: expect.stringContaining("clip 2") });
  });

  it("resolves a clip's match into its grade, and the grade applies it before the sliders", () => {
    const m: ColourMatch = { ref: { kind: "upload", id: "ref.jpg", name: "ref.jpg" }, scale: [1, 1, 1], offset: [0, 20, 30], amount: 1, frames: 5, at: 1 };
    const p = setMatch(project(), ["a"], m);
    const g = resolveGrade(p, p.clips[0]);
    expect(g.match).toEqual({ scale: m.scale, offset: m.offset, amount: 1 });
    const out = gradePixel([0.5, 0.5, 0.5], g);
    expect(out[0]).toBeGreaterThan(out[2]);
    expect(resolveGrade(p, p.clips[1]).match).toBeNull();
    expect(resolveGrade(setMatch(p, ["a"], { ...m, amount: 0 }), p.clips[0]).match).toEqual({ scale: m.scale, offset: m.offset, amount: 1 });
  });
});

describe("the LUT kept with the draft", () => {
  const identity = (n: number): CubeLut => {
    const data = new Float32Array(n * n * n * 3);
    let i = 0;
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) {
          data[i++] = r / (n - 1);
          data[i++] = g / (n - 1);
          data[i++] = b / (n - 1);
        }
    return { title: "id", size: n, data };
  };

  it("serialises and reads back a 17³ table to 8-bit precision", () => {
    const warm: CubeLut = { ...identity(17), data: identity(17).data.map((v, i) => (i % 3 === 0 ? Math.min(1, v * 1.1) : i % 3 === 2 ? v * 0.9 : v)) };
    const s = serialiseCube(warm);
    expect(s.size).toBe(17);
    expect(s.data.length).toBe(storedLutChars(17));
    const back = parseStoredCube({ ...s, name: "warm.cube" })!;
    expect(back.size).toBe(17);
    expect(back.title).toBe("warm.cube");
    let worst = 0;
    for (let i = 0; i < warm.data.length; i++) worst = Math.max(worst, Math.abs(back.data[i] - warm.data[i]));
    expect(worst).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
    expect(sampleCube(back, 0.5, 0.5, 0.5)[0]).toBeCloseTo(0.55, 2);
  });

  it("resamples a table above 33³ to 33³ and keeps its effect", () => {
    const text = ["LUT_3D_SIZE 40", ...Array.from({ length: 40 ** 3 }, (_, i) => {
      const r = (i % 40) / 39;
      const g = (Math.floor(i / 40) % 40) / 39;
      const b = Math.floor(i / 1600) / 39;
      return `${(1 - r).toFixed(5)} ${(1 - g).toFixed(5)} ${(1 - b).toFixed(5)}`;
    })].join("\n");
    const parsed = parseCube(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s = serialiseCube(parsed.lut);
    expect(s.size).toBe(MAX_STORED_LUT_SIZE);
    const back = parseStoredCube(s)!;
    const out = sampleCube(back, 0.2, 0.6, 0.9);
    expect(out[0]).toBeCloseTo(0.8, 1);
    expect(out[2]).toBeCloseTo(0.1, 1);
    expect(resampleCube(parsed.lut, 9).data.length).toBe(9 ** 3 * 3);
  });

  it("refuses data that does not match its size, sizes above 33, and garbage", () => {
    const s = serialiseCube(identity(5));
    expect(parseStoredCube({ size: 6, data: s.data })).toBeNull();
    expect(parseStoredCube({ size: 5, data: s.data.slice(4) })).toBeNull();
    expect(parseStoredCube({ size: 5, data: "!".repeat(s.data.length) })).toBeNull();
    expect(parseStoredCube({ size: 40, data: "AAAA" })).toBeNull();
    const p = newProject("lut");
    expect(validateProject({ ...p, lut: { name: "a.cube", size: 5, strength: 1, data: s.data } })).toMatchObject({ ok: true, project: { lut: { name: "a.cube", size: 5, strength: 1, data: s.data } } });
    expect(validateProject({ ...p, lut: { name: "a.cube", size: 6, strength: 1, data: s.data } })).toMatchObject({ ok: false, reason: expect.stringContaining("lut.data") });
    expect(validateProject({ ...p, lut: { name: "a.cube", size: 65, strength: 1, data: "AAAA" } })).toMatchObject({ ok: false, reason: expect.stringContaining("33") });
  });

  it("keeps a project with a 33³ table well inside the 512 KB a save may weigh", () => {
    const s = serialiseCube(identity(33));
    const p = { ...project(), lut: { name: "big.cube", size: 33, strength: 0.7, data: s.data } };
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.ok && r.project).length).toBeLessThan(200 * 1024);
  });
});

describe("templates", () => {
  const media = [
    { source: src("v1"), duration: 6 },
    { source: src("v2"), duration: 2 },
    { source: { kind: "upload" as const, name: "own.mp4", size: 10 }, duration: 12 },
  ];
  let n = 0;
  const id = () => String(++n);

  it("has six original templates with unique ids, each under the editor's limits", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["product-launch", "food-closeup", "beat-montage", "offer-promo", "testimonial", "brand-story"]);
    for (const t of TEMPLATES) {
      expect(t.slots.length).toBeGreaterThan(2);
      expect(templateLength(t)).toBeLessThanOrEqual(60);
      expect(PRESET_IDS as readonly string[]).toContain(t.look.id);
      for (const tx of t.texts) {
        expect(tx.en.trim()).not.toBe("");
        expect(/[؀-ۿ]/.test(tx.ar)).toBe(true);
        expect(tx.to).toBeLessThan(t.slots.length);
      }
    }
  });

  it("turns every template into a valid, editable project (footage, no footage, each language, with and without the logo)", () => {
    for (const t of TEMPLATES)
      for (const m of [media, media.slice(0, 1), []])
        for (const language of ["en", "ar", "both"] as const)
          for (const logo of [null, { src: "/api/studio/clients/c1/logo", name: "Logo" }]) {
            const p = applyTemplate(t, newProject("T", 1000), m, { language, logo, now: 5, id });
            const r = validateProject(p);
            expect(r.ok, `${t.id} ${m.length} ${language}: ${r.ok ? "" : r.reason}`).toBe(true);
            if (!r.ok) continue;
            expect(r.project.template).toEqual({ id: t.id, at: 5 });
            expect(r.project.look).toBe(t.look.id);
            expect(r.project.lookAmount).toBe(t.look.amount);
            expect(r.project.protectSkin).toBe(t.protectSkin);
            expect(r.project.clips.length).toBe(m.length ? t.slots.length : 0);
            const texts = r.project.overlays.filter((o) => o.kind === "text");
            expect(texts.length).toBe(t.texts.length * (language === "both" ? 2 : 1));
            expect(r.project.overlays.some((o) => o.kind === "logo")).toBe(!!logo);
            if (language !== "en") expect(texts.some((o) => o.kind === "text" && /[؀-ۿ]/.test(o.text))).toBe(true);
            if (m.length) {
              const len = totalLength(r.project);
              for (const o of r.project.overlays) expect(o.end).toBeLessThanOrEqual(len + 1e-6);
            }
          }
  });

  it("makes the cut a 9:16 Reel by default, or keeps its frame when asked", () => {
    const square = { ...newProject("T", 1000), output: { ...newProject("T").output, width: 1080, height: 1080 } };
    const reel = applyTemplate(TEMPLATES[0], square, media, { id });
    expect([reel.output.width, reel.output.height]).toEqual([1080, 1920]);
    const kept = applyTemplate(TEMPLATES[0], square, media, { id, frame: "keep" });
    expect([kept.output.width, kept.output.height]).toEqual([1080, 1080]);
    expect(validateProject(reel).ok).toBe(true);
  });

  it("stacks Arabic above English without overlap, by their estimated lines, in every frame", () => {
    for (const out of [{ width: 1080, height: 1920 }, { width: 1080, height: 1350 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }])
      for (const t of TEMPLATES) {
        const p = applyTemplate(t, { ...newProject("T", 1000), output: { ...newProject("T").output, ...out } }, media, { language: "both", id, frame: "keep" });
        const texts = p.overlays.filter((o): o is Extract<typeof o, { kind: "text" }> => o.kind === "text");
        for (let i = 0; i < texts.length; i += 2) {
          const [ar, en] = [texts[i], texts[i + 1]];
          expect(/[؀-ۿ]/.test(ar.text)).toBe(true);
          const aspect = out.width / out.height;
          const bottomAr = ar.y + (estimateLines(ar.text, ar.size, ar.width, aspect) * ar.size * 1.22) / 2;
          const topEn = en.y - (estimateLines(en.text, en.size, en.width, aspect) * en.size * 1.22) / 2;
          expect(bottomAr, `${t.id}: ${ar.text} / ${en.text}`).toBeLessThan(topEn);
        }
      }
    expect(estimateLines("Meet your product name", 0.0425, 0.86, 9 / 16)).toBe(2);
    expect(estimateLines("NEW", 0.08, 0.86, 9 / 16)).toBe(1);
  });

  it("fills the slots with the footage in order, reusing it with different windows, inside each clip", () => {
    const t = TEMPLATES.find((x) => x.id === "beat-montage")!;
    const p = applyTemplate(t, newProject("T", 1000), media, { id });
    expect(p.clips.map((c) => (c.source.kind === "version" ? c.source.videoId : "own"))).toEqual(["v1", "v2", "own", "v1", "v2", "own", "v1", "v2"]);
    const v1 = p.clips.filter((c) => c.source.kind === "version" && c.source.videoId === "v1");
    expect(new Set(v1.map((c) => c.in)).size).toBe(3);
    for (const c of p.clips) {
      expect(c.in).toBeGreaterThanOrEqual(0);
      expect(c.out).toBeLessThanOrEqual(c.duration);
      expect(c.out - c.in).toBeCloseTo(0.75, 6);
    }
    expect(p.look).toBe("bold-sport");
    // A slot longer than its footage takes the whole clip.
    const launch = applyTemplate(TEMPLATES[0], newProject("T", 1000), [{ source: src("short"), duration: 1 }], { id });
    expect(launch.clips.every((c) => c.out - c.in <= 1)).toBe(true);
  });
});

describe("music library sources", () => {
  const kevin = catalogTrack(catalogEntry("upbeat-forever")!);
  const testLoop = catalogTrack(catalogEntry("test-beat-120")!);
  const base = () => ({ ...newProject("M", 1000), music: { source: musicSourceFromTrack(kevin), offset: 0, volume: 0.9, fadeIn: 0.5, fadeOut: 1 } });

  it("keeps a CC BY catalog track with its licence, the credit the caption must carry and Content ID", () => {
    const s = musicSourceFromTrack(kevin);
    expect(s).toMatchObject({ kind: "catalog", trackId: "cat:upbeat-forever", name: "Upbeat Forever", rights: { attributionRequired: true, licence: { id: "cc-by-3.0" }, contentId: { status: "registered" } } });
    if (s.kind !== "catalog") return;
    expect(s.rights.credit).toContain("Kevin MacLeod (incompetech.com)");
    expect(s.rights.credit).toContain("https://creativecommons.org/licenses/by/3.0/");
    const r = validateProject(base());
    expect(r.ok && r.project.music?.source).toEqual(s);
    const t = musicSourceFromTrack(testLoop);
    expect(t).toMatchObject({ kind: "catalog", rights: { test: true, attributionRequired: false } });
  });

  it("keeps a client's library track with its client", () => {
    const lib: MusicTrack = { ...kevin, id: "lib:1234-abcd", kind: "library", client: "c1", title: "Client jingle", licence: { ...kevin.licence, id: "own", name: "Own work or commissioned", version: "", url: "", attribution: "", attributionRequired: false }, contentId: { status: "not_registered", note: "" } };
    const s = musicSourceFromTrack(lib);
    expect(s).toMatchObject({ kind: "library", trackId: "lib:1234-abcd", client: "c1", rights: { attributionRequired: false } });
    expect(validateProject({ ...newProject("M", 1000), music: { source: s, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 } }).ok).toBe(true);
  });

  it("refuses a library source that does not say its rights, and keeps the older kinds working", () => {
    const p = base();
    const s = p.music.source as Extract<ReturnType<typeof musicSourceFromTrack>, { kind: "catalog" }>;
    const bad = (source: unknown) => validateProject({ ...p, music: { ...p.music, source } });
    expect(bad({ ...s, trackId: "upbeat-forever" })).toMatchObject({ ok: false, reason: expect.stringContaining("trackId") });
    expect(bad({ ...s, rights: { ...s.rights, licence: { ...s.rights.licence, id: "cc-by-nc-4.0" } } })).toMatchObject({ ok: false, reason: expect.stringContaining("licence") });
    expect(bad({ ...s, rights: { ...s.rights, credit: "" } })).toMatchObject({ ok: false, reason: expect.stringContaining("credit") });
    expect(bad({ ...s, rights: { ...s.rights, contentId: { status: "maybe", note: "" } } })).toMatchObject({ ok: false, reason: expect.stringContaining("contentId") });
    expect(bad({ ...s, kind: "library" })).toMatchObject({ ok: false, reason: expect.stringContaining("trackId") });
    expect(bad({ kind: "library", trackId: "lib:1234-abcd", name: "x", rights: s.rights })).toMatchObject({ ok: false, reason: expect.stringContaining("client") });
    expect(bad({ kind: "spotify", id: "x" })).toMatchObject({ ok: false, reason: expect.stringContaining("music.source") });
    expect(bad({ kind: "audioKey", key: "a1", name: "Song" })).toMatchObject({ ok: true });
    expect(bad({ kind: "upload", name: "song.mp3", size: 10 })).toMatchObject({ ok: true });
  });
});

describe("drafts saved before phase 3", () => {
  /** A document exactly as phase 1 saved it (version 1, seven sliders, a LUT by name, a post's track). */
  const v1 = {
    v: 1,
    rev: 3,
    createdAt: 1000,
    updatedAt: 2000,
    name: "Phase 1 cut",
    clips: [
      { id: "a", source: src("v1"), duration: 5, in: 0, out: 3, speed: 1, transition: "cut", transitionDuration: 0.5, colour: { exposure: 0.1, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 } },
      { id: "b", source: src("v2"), duration: 5, in: 1, out: 4, speed: 1, transition: "crossfade", transitionDuration: 0.5 },
    ],
    look: "warm",
    colour: { exposure: 0, contrast: 0.1, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 },
    lut: { name: "film.cube", size: 33, strength: 0.8 },
    music: { source: { kind: "audioKey", key: "t1", name: "Song" }, offset: 2, volume: 0.9, fadeIn: 0.5, fadeOut: 1, beats: [0.5, 1] },
    output: { width: 1080, height: 1920, fps: 30, bitrate: 8000000 },
    snapToBeats: false,
    framing: { fit: "fill", zoom: 1, x: 0, y: 0 },
    background: "#000000",
    overlays: [{ id: "t1", kind: "text", text: "مرحبا", start: 0, end: 2, x: 0.5, y: 0.8, size: 0.06, color: "#ffffff", font: "sans", weight: 800, align: "center", box: null, width: 0.86 }],
  };

  it("opens a version-1 draft as version 2 with the same picture", () => {
    const r = validateProject(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.project;
    expect(p.v).toBe(PROJECT_VERSION);
    expect(p).toMatchObject({ rev: 3, name: "Phase 1 cut", look: "warm", lookAmount: 1, protectSkin: false, lut: { name: "film.cube", size: 33, strength: 0.8 }, music: { source: { kind: "audioKey", key: "t1" } } });
    expect(p.lut?.data).toBeUndefined();
    expect(p.clips[0].colour).toEqual({ ...DEFAULT_COLOUR, exposure: 0.1 });
    expect(p.clips.every((c) => !c.look && !c.match)).toBe(true);
    // Phase 1 drew: look params + project colour + clip colour. The phase-3 grade is exactly that.
    const phase1 = (clipColour?: Partial<ColourParams>) => addParams(lookOf("warm").params, v1.colour, clipColour);
    expect(resolveGrade(p, p.clips[0]).params).toEqual(phase1(v1.clips[0].colour));
    expect(resolveGrade(p, p.clips[1]).params).toEqual(phase1());
    expect(resolveGrade(p, p.clips[1]).protectSkin).toBe(false);
    expect(resolveGrade(p, p.clips[1]).match).toBeNull();
    // Saved again, it stays version 2 and round-trips.
    const again = validateProject(JSON.parse(JSON.stringify(p)));
    expect(again).toEqual({ ok: true, project: p });
  });

  it("opens a phase-2 (version 2) draft as version 3, keeping its phase-2 fields, and chains 1 → 2 → 3", () => {
    const v2 = { ...newProject("Phase 2 cut", 1000), v: 2, look: "punch", clips: [{ ...clip("a", 5), muted: true, volume: 0.5 }], voices: [{ id: "vo", source: { kind: "audioKey", key: "k", name: "VO" }, name: "VO", start: 1, in: 0, out: 2, duration: 3, volume: 0.8 }] } as Record<string, unknown>;
    delete v2.lookAmount;
    delete v2.protectSkin;
    const r = validateProject(v2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project).toMatchObject({ v: PROJECT_VERSION, look: "punch", lookAmount: 1, protectSkin: false, voices: [{ id: "vo", volume: 0.8 }] });
    expect(r.project.clips[0]).toMatchObject({ muted: true, volume: 0.5 });
    expect(resolveGrade(r.project, r.project.clips[0]).params).toEqual(addParams(lookOf("punch").params));
    // Version 1 goes through phase 2's step (its clips muted under the music) and then phase 3's.
    const one = validateProject(v1);
    expect(one.ok && one.project).toMatchObject({ v: PROJECT_VERSION, lookAmount: 1, clips: [{ muted: true }, { muted: true }], voices: [] });
  });

  it("draws a phase-1 document handed straight to the engine (no lookAmount, no protectSkin) like phase 1", () => {
    const raw = { ...v1, v: 1 } as unknown as VideoProject;
    expect(resolveGrade(raw, raw.clips[1]).params).toEqual(addParams(lookOf("warm").params, v1.colour));
  });
});
