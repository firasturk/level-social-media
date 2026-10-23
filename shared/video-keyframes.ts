/**
 * Keyframes: a property of a text layer, a logo layer or a clip's framing that changes over time.
 * Each property has its own list of keyframes `{ t, v, ease }`, `t` in seconds from the start of
 * the layer (or the clip, on the timeline), so the motion moves with the layer when it is moved.
 * Between two keyframes the value goes from one to the other with the first one's easing (linear,
 * ease in, ease out, ease in and out); before the first and after the last it holds. A property
 * with no keyframes keeps the layer's own value. Pure maths, shared by the preview and the render
 * (src/video-editor/engine/overlays.ts and compose.ts draw what these functions say).
 */

export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut";
export const EASINGS: readonly { id: Easing; name: string }[] = [
  { id: "linear", name: "Linear" },
  { id: "easeIn", name: "Ease in" },
  { id: "easeOut", name: "Ease out" },
  { id: "easeInOut", name: "Ease in and out" },
];

export interface Keyframe {
  /** Seconds from the layer's (or the clip's) start. */
  t: number;
  v: number;
  /** How the value travels to the next keyframe. */
  ease: Easing;
}

/** x, y: position (a layer's centre as a fraction of the frame; a clip's pan -1 … 1). scale: a layer's size × (1 = as set). opacity: 0 … 1. zoom: a clip's zoom 1 … 4. */
export type KeyProp = "x" | "y" | "scale" | "opacity" | "zoom";
export type Keyframes = Partial<Record<KeyProp, Keyframe[]>>;

export const OVERLAY_PROPS: readonly KeyProp[] = ["x", "y", "scale", "opacity"];
export const CLIP_PROPS: readonly KeyProp[] = ["x", "y", "zoom"];

/** The allowed range of each property, for layers and for clips. */
export const OVERLAY_RANGE: Record<KeyProp, [number, number]> = { x: [-0.5, 1.5], y: [-0.5, 1.5], scale: [0.1, 5], opacity: [0, 1], zoom: [1, 4] };
export const CLIP_RANGE: Record<KeyProp, [number, number]> = { x: [-1, 1], y: [-1, 1], scale: [0.1, 5], opacity: [0, 1], zoom: [1, 4] };

export const MAX_KEYFRAMES = 32;
/** Two keyframes closer than this are the same one (half a frame at 30 fps). */
export const KEY_EPSILON = 1 / 60;

/** The eased fraction for u in 0 … 1. */
export function ease(e: Easing, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  switch (e) {
    case "easeIn":
      return x * x;
    case "easeOut":
      return 1 - (1 - x) * (1 - x);
    case "easeInOut":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    default:
      return x;
  }
}

/** The value at local time t: the base without keyframes, held before the first and after the last. */
export function valueAt(keys: readonly Keyframe[] | undefined, t: number, base: number): number {
  if (!keys || !keys.length) return base;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.v;
      return a.v + (b.v - a.v) * ease(a.ease, (t - a.t) / span);
    }
  }
  return last.v;
}

/** A keyframe set (or replaced, when one is within half a frame) at t; the list stays sorted. */
export function setKey(keys: readonly Keyframe[] | undefined, t: number, v: number, easing?: Easing): Keyframe[] {
  const list = [...(keys ?? [])];
  const at = Math.max(0, t);
  const i = list.findIndex((k) => Math.abs(k.t - at) < KEY_EPSILON);
  if (i >= 0) list[i] = { t: list[i].t, v, ease: easing ?? list[i].ease };
  else list.push({ t: at, v, ease: easing ?? "easeInOut" });
  list.sort((a, b) => a.t - b.t);
  return list.slice(0, MAX_KEYFRAMES);
}

export function removeKey(keys: readonly Keyframe[] | undefined, t: number): Keyframe[] {
  return (keys ?? []).filter((k) => Math.abs(k.t - t) >= KEY_EPSILON);
}

/** The keyframe at t (within half a frame), if any. */
export function keyAt(keys: readonly Keyframe[] | undefined, t: number): Keyframe | null {
  return (keys ?? []).find((k) => Math.abs(k.t - t) < KEY_EPSILON) ?? null;
}

/** Every keyframe time of a set, sorted, each once: the diamonds on a lane. */
export function keyTimes(kf: Keyframes | undefined): number[] {
  if (!kf) return [];
  const out: number[] = [];
  for (const list of Object.values(kf)) for (const k of list ?? []) if (!out.some((t) => Math.abs(t - k.t) < KEY_EPSILON)) out.push(k.t);
  return out.sort((a, b) => a - b);
}

export const hasKeys = (kf: Keyframes | undefined): boolean => !!kf && Object.values(kf).some((l) => !!l && l.length > 0);

/** A set with empty lists removed; undefined when nothing is left. */
export function tidyKeyframes(kf: Keyframes | undefined): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const [p, list] of Object.entries(kf) as [KeyProp, Keyframe[] | undefined][]) if (list && list.length) out[p] = list;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A set split at local time `at` (a clip split in two): the first part keeps the keyframes before
 * `at`, the second the ones after, moved to its own start; both get a keyframe at the cut with the
 * value there, so neither part jumps.
 */
export function splitKeyframes(kf: Keyframes | undefined, at: number): [Keyframes | undefined, Keyframes | undefined] {
  if (!hasKeys(kf)) return [undefined, undefined];
  const left: Keyframes = {};
  const right: Keyframes = {};
  for (const [p, list] of Object.entries(kf!) as [KeyProp, Keyframe[] | undefined][]) {
    if (!list || !list.length) continue;
    const v = valueAt(list, at, list[0].v);
    const before = list.filter((k) => k.t < at - KEY_EPSILON);
    const after = list.filter((k) => k.t > at + KEY_EPSILON).map((k) => ({ ...k, t: k.t - at }));
    const easeAt = [...before].reverse()[0]?.ease ?? list[0].ease;
    left[p] = [...before, { t: at, v, ease: easeAt }];
    right[p] = [{ t: 0, v, ease: easeAt }, ...after];
  }
  return [tidyKeyframes(left), tidyKeyframes(right)];
}

/** Keyframes moved by dt seconds (a layer whose start moved while its motion should stay put); those that fall before 0 are dropped. */
export function shiftKeyframes(kf: Keyframes | undefined, dt: number): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const [p, list] of Object.entries(kf) as [KeyProp, Keyframe[] | undefined][]) out[p] = (list ?? []).map((k) => ({ ...k, t: k.t + dt })).filter((k) => k.t >= 0);
  return tidyKeyframes(out);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Keyframes as saved, checked: known properties only, times 0 … 3600, values in range, sorted; the reason says what is wrong. */
export function checkKeyframes(x: unknown, props: readonly KeyProp[], range: Record<KeyProp, [number, number]>, where: string): Keyframes | undefined | string {
  if (x === undefined || x === null) return undefined;
  if (!isObj(x)) return `${where}: keyframes must be an object.`;
  const out: Keyframes = {};
  for (const [p, list] of Object.entries(x)) {
    if (!props.includes(p as KeyProp)) return `${where}: "${p}" cannot be keyframed here.`;
    if (!Array.isArray(list) || list.length > MAX_KEYFRAMES) return `${where}: ${p} keyframes must be a list of at most ${MAX_KEYFRAMES}.`;
    const [lo, hi] = range[p as KeyProp];
    const keys: Keyframe[] = [];
    for (const k of list as unknown[]) {
      if (!isObj(k) || typeof k.t !== "number" || !Number.isFinite(k.t) || k.t < 0 || k.t > 3600) return `${where}: a ${p} keyframe needs a time in seconds.`;
      if (typeof k.v !== "number" || !Number.isFinite(k.v) || k.v < lo || k.v > hi) return `${where}: a ${p} keyframe's value must be between ${lo} and ${hi}.`;
      const e: Easing = k.ease === "linear" || k.ease === "easeIn" || k.ease === "easeOut" ? k.ease : "easeInOut";
      keys.push({ t: k.t, v: k.v, ease: e });
    }
    keys.sort((a, b) => a.t - b.t);
    if (keys.length) out[p as KeyProp] = keys;
  }
  return tidyKeyframes(out);
}
