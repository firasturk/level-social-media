/**
 * Colour presets, their intensity, the scope they apply to, and skin protection (phase 3,
 * docs/video-editor.md): which grade each clip gets, decided in one place for the preview, the
 * render and the thumbnails, plus `gradePixel`, the CPU twin of the shader in
 * src/video-editor/engine/grader.ts (same order, same formulas), used by the tests and to state what
 * a rendered pixel should be.
 *
 * A clip's grade: its colour match (shared/colour-match.ts), then the preset at its intensity (the
 * clip's own `look`, else the project's) plus the project's sliders plus the clip's own sliders,
 * then the project's LUT, then — when "Protect skin tones" is on — the skin protection.
 *
 * Skin protection is a HUE-RANGE HEURISTIC, not skin detection: a pixel whose ORIGINAL colour lies
 * in the warm hue band where skin tones fall (about 0°–45° on the HSV wheel, centred on 20°),
 * with moderate saturation (about 10–70 %) and not near black, is weighted 0 … 1; on those pixels
 * the grade keeps its brightness but the hue goes back to the original's and the chroma may change
 * by ±15 % at most. Wood, sand, terracotta or a beige product in that band are protected too; skin
 * under strongly coloured light (a blue stage) falls outside the band and is not.
 */
import { DEFAULT_COLOUR, lookOf, PRESET_IDS, type Clip, type ClipLook, type ColourParams, type VideoProject } from "./video-project";
import { applyMatch, type ColourMatch, type Vec3 } from "./colour-match";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Everything the shader needs for one clip's pixels. */
export interface ClipGrade {
  params: ColourParams;
  match: Pick<ColourMatch, "scale" | "offset" | "amount"> | null;
  protectSkin: boolean;
}

/** A preset's parameters at an intensity: every parameter scaled toward the preset (0 = unchanged, 1 = the full preset). */
export function presetParams(id: string, amount: number): ColourParams {
  const p = lookOf(id).params;
  const a = clamp01(Number.isFinite(amount) ? amount : 1);
  const out = { ...DEFAULT_COLOUR };
  for (const k of Object.keys(out) as (keyof ColourParams)[]) out[k] = (p[k] ?? 0) * a || 0;
  return out;
}

/** Parameter sets added (each sum held to −2 … 2); a missing set or key counts as 0. */
export function addParams(...sets: (Partial<ColourParams> | null | undefined)[]): ColourParams {
  const out = { ...DEFAULT_COLOUR };
  for (const s of sets) if (s) for (const k of Object.keys(out) as (keyof ColourParams)[]) out[k] = clamp(out[k] + (s[k] ?? 0), -2, 2);
  return out;
}

/** The preset a clip is drawn with: its own, else the project's at the project's intensity. */
export function clipLook(project: Pick<VideoProject, "look" | "lookAmount">, clip: Pick<Clip, "look"> | null | undefined): ClipLook {
  if (clip?.look) return clip.look;
  return { id: project.look ?? "none", amount: project.lookAmount ?? 1 };
}

/**
 * The grade of a clip (null: the background or an empty frame, graded with the project's colour only).
 * A phase-1 document (no lookAmount, no protectSkin, no clip look) resolves to exactly what phase 1 drew.
 */
export function resolveGrade(project: Pick<VideoProject, "look" | "lookAmount" | "colour" | "protectSkin">, clip: Pick<Clip, "look" | "colour" | "match"> | null | undefined): ClipGrade {
  const look = clipLook(project, clip);
  return {
    params: addParams(presetParams(look.id, look.amount), project.colour, clip?.colour),
    match: clip?.match && clip.match.amount > 0 ? { scale: clip.match.scale, offset: clip.match.offset, amount: clip.match.amount } : null,
    protectSkin: project.protectSkin === true,
  };
}

/* ───────────── Scope: this clip, chosen clips, the whole video ───────────── */

export type Scope = { kind: "all" } | { kind: "clips"; ids: readonly string[] };

/**
 * A preset applied to a scope. The whole video: the project's look and intensity, and the clips'
 * own presets removed (their own sliders and matches stay). Clips: each gets its own preset.
 */
export function applyLook(project: VideoProject, scope: Scope, id: string, amount: number): VideoProject {
  const a = clamp01(amount);
  if (scope.kind === "all") return { ...project, look: id, lookAmount: a, clips: project.clips.map((c) => (c.look ? withoutKey(c, "look") : c)) };
  const ids = new Set(scope.ids);
  return { ...project, clips: project.clips.map((c) => (ids.has(c.id) ? { ...c, look: { id, amount: a } } : c)) };
}

/** The intensity changed for what the scope covers (the clips' own presets keep their id). */
export function setLookAmount(project: VideoProject, scope: Scope, amount: number): VideoProject {
  const a = clamp01(amount);
  if (scope.kind === "all") return { ...project, lookAmount: a };
  const ids = new Set(scope.ids);
  return { ...project, clips: project.clips.map((c) => (ids.has(c.id) ? { ...c, look: { id: clipLook(project, c).id, amount: a } } : c)) };
}

/** A clip's own preset removed: it follows the project's again. */
export function clearClipLooks(project: VideoProject, ids: readonly string[]): VideoProject {
  const set = new Set(ids);
  return { ...project, clips: project.clips.map((c) => (set.has(c.id) && c.look ? withoutKey(c, "look") : c)) };
}

/** A colour match set (or removed with null) on the clips in `ids`. */
export function setMatch(project: VideoProject, ids: readonly string[], match: ColourMatch | null): VideoProject {
  const set = new Set(ids);
  return { ...project, clips: project.clips.map((c) => (set.has(c.id) ? (match ? { ...c, match } : withoutKey(c, "match")) : c)) };
}

function withoutKey<T extends object, K extends keyof T>(o: T, k: K): T {
  const out = { ...o };
  delete out[k];
  return out;
}

export const isPreset = (id: string): boolean => (PRESET_IDS as readonly string[]).includes(id);

/* ───────────── The shader, on the CPU ───────────── */

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The sliders on one colour, in the shader's order (exposure → white balance → contrast → saturation → vibrance → tones). */
export function applyParams(rgb: Vec3, p: ColourParams): Vec3 {
  const e = Math.pow(2, p.exposure);
  let c: Vec3 = [rgb[0] * e, rgb[1] * e, rgb[2] * e];
  c = [c[0] * (1 + 0.15 * p.temperature - 0.05 * p.tint), c[1] * (1 - 0.1 * p.tint), c[2] * (1 - 0.15 * p.temperature - 0.05 * p.tint)];
  c = [(c[0] - 0.5) * (1 + p.contrast) + 0.5, (c[1] - 0.5) * (1 + p.contrast) + 0.5, (c[2] - 0.5) * (1 + p.contrast) + 0.5];
  const luma = dot(c, LUMA);
  c = mix3([luma, luma, luma], c, 1 + p.saturation);
  // Vibrance: more (or less) colour where there is little of it; saturated colours move less.
  const sat = clamp01(Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]));
  const l2 = dot(c, LUMA);
  c = mix3([l2, l2, l2], c, 1 + (p.vibrance ?? 0) * (1 - sat));
  const l = clamp01(dot(c, LUMA));
  const sw = 1 - smoothstep(0, 0.6, l);
  const hw = smoothstep(0.4, 1, l);
  const ww = smoothstep(0.65, 1, l);
  const bw = 1 - smoothstep(0, 0.35, l);
  const add = p.shadows * 0.25 * sw + p.highlights * 0.25 * hw + (p.whites ?? 0) * 0.2 * ww + (p.blacks ?? 0) * 0.15 * bw;
  return [clamp01(c[0] + add), clamp01(c[1] + add), clamp01(c[2] + add)];
}

/** HSV of a colour: hue in degrees (0 … 360), saturation and value 0 … 1. */
export function hsv(rgb: Vec3): Vec3 {
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx > 0 ? d / mx : 0, mx];
}

/** The skin-tone band, as the shader has it: hue centre and half-widths (degrees), saturation and value ramps. */
export const SKIN_BAND = { hue: 20, inner: 15, outer: 32, sat: [0.08, 0.16, 0.62, 0.8], val: [0.15, 0.3] } as const;

/** How much a colour counts as a skin tone, 0 … 1 (hue band × saturation window × not too dark). */
export function skinWeight(rgb: Vec3): number {
  const [h, s, v] = hsv(rgb);
  const d0 = Math.abs(h - SKIN_BAND.hue);
  const dh = Math.min(d0, 360 - d0);
  const hw = 1 - smoothstep(SKIN_BAND.inner, SKIN_BAND.outer, dh);
  const sw = smoothstep(SKIN_BAND.sat[0], SKIN_BAND.sat[1], s) * (1 - smoothstep(SKIN_BAND.sat[2], SKIN_BAND.sat[3], s));
  const vw = smoothstep(SKIN_BAND.val[0], SKIN_BAND.val[1], v);
  return hw * sw * vw;
}

/** How much of the protection reaches a full-weight skin pixel, and how far its chroma may move (±). */
export const SKIN_STRENGTH = 0.9;
export const SKIN_CHROMA = 0.15;

/**
 * The graded colour of an original skin-tone pixel pulled back to the original's hue: the graded
 * brightness (luma) is kept, the colour part (RGB minus luma: its direction is the hue) is the
 * original's, scaled by the graded chroma ratio bounded to 1 ± 15 %; blended by the skin weight.
 */
export function protectSkin(orig: Vec3, graded: Vec3): Vec3 {
  const w = skinWeight(orig) * SKIN_STRENGTH;
  if (w <= 0) return graded;
  const yo = dot(orig, LUMA);
  const yg = dot(graded, LUMA);
  const co: Vec3 = [orig[0] - yo, orig[1] - yo, orig[2] - yo];
  const cg: Vec3 = [graded[0] - yg, graded[1] - yg, graded[2] - yg];
  const mo = Math.hypot(...co);
  if (mo < 1e-5) return graded;
  const k = clamp(Math.hypot(...cg) / mo, 1 - SKIN_CHROMA, 1 + SKIN_CHROMA);
  const kept: Vec3 = [clamp01(yg + co[0] * k), clamp01(yg + co[1] * k), clamp01(yg + co[2] * k)];
  return mix3(graded, kept, w);
}

/**
 * One colour through a clip's whole grade, as the shader draws it (without a LUT): match →
 * sliders → skin protection against the original. sRGB 0 … 1 in and out.
 */
export function gradePixel(rgb: Vec3, grade: ClipGrade): Vec3 {
  let c: Vec3 = grade.match ? applyMatch(rgb, grade.match) : [...rgb];
  c = applyParams(c, grade.params);
  return grade.protectSkin ? protectSkin(rgb, c) : c;
}
