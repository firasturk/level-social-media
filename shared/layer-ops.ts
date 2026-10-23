/**
 * The layer operations of a design as pure data changes: add, duplicate, remove, reorder, bring
 * forward or back, and the background. The Text studio calls these (and adds undo, selection and
 * saving around them); the tests drive them without a browser. None of them makes a picture: a
 * design is data drawn by the browser over the photograph, so every change here is free.
 */
import { isTextLayer, layerId, newImageLayer, type ImageLayer, type Layer, type TextDesign } from "./layers";
import { cleanColorMap } from "./svg-colors";

/** A new layer on top of the stack (the last drawn). */
export function addLayer(design: TextDesign, layer: Layer): TextDesign {
  return { ...design, layers: [...design.layers, layer] };
}

/**
 * Copies of the given layers, each a little down and to the right, on top of the stack. A copy
 * never keeps the headline or second-line role (the plan's words stay with the original) and a
 * copy of the background is no background (it would hide behind the original).
 */
export function duplicateLayers(design: TextDesign, ids: string[], makeId: () => string = layerId): { design: TextDesign; copies: string[] } {
  const copies: Layer[] = [];
  for (const id of ids) {
    const l = design.layers.find((x) => x.id === id);
    if (!l) continue;
    const c = { ...l, id: makeId(), name: l.name ? `${l.name} copy` : undefined, x: l.x + 0.02, y: l.y + 0.02 } as Layer;
    if (isTextLayer(c)) c.role = undefined;
    if (c.type === "image" && c.behind) delete c.behind;
    if (c.type === "image" && c.recolor) c.recolor = { ...c.recolor };
    copies.push(c);
  }
  if (!copies.length) return { design, copies: [] };
  return { design: { ...design, layers: [...design.layers, ...copies] }, copies: copies.map((c) => c.id) };
}

export function removeLayers(design: TextDesign, ids: string[]): TextDesign {
  return { ...design, layers: design.layers.filter((l) => !ids.includes(l.id)) };
}

/** Moves the layer at `fromTop` (top-first order, as the layers list shows them) to `toTop`. */
export function reorderLayer(design: TextDesign, fromTop: number, toTop: number): TextDesign {
  const n = design.layers.length;
  const from = n - 1 - fromTop;
  const to = n - 1 - toTop;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return design;
  const next = [...design.layers];
  const [l] = next.splice(from, 1);
  next.splice(to, 0, l);
  return { ...design, layers: next };
}

/** Bring forward (up), send backward (down), to the front or to the back. */
export function zOrderLayers(design: TextDesign, ids: string[], how: "up" | "down" | "front" | "back"): TextDesign {
  if (!ids.length) return design;
  const picked = design.layers.filter((l) => ids.includes(l.id));
  const rest = design.layers.filter((l) => !ids.includes(l.id));
  if (how === "front") return { ...design, layers: [...rest, ...picked] };
  if (how === "back") return { ...design, layers: [...picked, ...rest] };
  const next = [...design.layers];
  const i = next.findIndex((l) => l.id === ids[0]);
  const j = how === "up" ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= next.length) return design;
  [next[i], next[j]] = [next[j], next[i]];
  return { ...design, layers: next };
}

/** Changes the given layers (position, size, rotation, opacity, visibility, colours…). */
export function patchLayers(design: TextDesign, ids: string[], patch: Partial<Layer> | ((l: Layer) => Partial<Layer>)): TextDesign {
  return { ...design, layers: design.layers.map((l) => (ids.includes(l.id) ? ({ ...l, ...(typeof patch === "function" ? patch(l) : patch) } as Layer) : l)) };
}

/**
 * The asset as the design's background: a full-canvas image layer at the bottom of the stack,
 * drawn behind the photograph (the renderer draws `behind` layers before the photograph). One
 * background at a time: an earlier one is replaced. Nothing is generated; the photograph is untouched.
 */
export function setBackground(design: TextDesign, src: string, over: Partial<ImageLayer> = {}): { design: TextDesign; layer: ImageLayer } {
  const layer = newImageLayer(src, { name: "Background", ...over, x: 0, y: 0, w: 1, h: 1, fit: "cover", behind: true, rotate: undefined });
  const rest = design.layers.filter((l) => !(l.type === "image" && l.behind));
  return { design: { ...design, layers: [layer, ...rest] }, layer };
}

/** The background layer of a design, when it has one. */
export function backgroundOf(design: TextDesign): ImageLayer | null {
  return (design.layers.find((l) => l.type === "image" && l.behind) as ImageLayer | undefined) ?? null;
}

/** What the library says about an asset placed in a design (the server's design-use answer). */
export interface AssetLayerInfo {
  src: string;
  name: string;
  assetId?: string;
  source?: ImageLayer["source"];
  kind?: string;
  format?: string | null;
  note?: string | null;
  editable?: boolean;
  colors?: string[];
  lettering?: boolean;
  /** Width over height, when known. */
  aspect?: number | null;
}

/**
 * The image layer an asset becomes: centred, keeping its proportions; a vector or an icon fits
 * inside its box at about a third of the width, a photograph fills half of it. An editable SVG
 * keeps its colours (the swatches); decorative lettering is marked as a picture, not text.
 */
export function imageLayerFromAsset(info: AssetLayerInfo, W: number, H: number, makeId: () => string = layerId): ImageLayer {
  const aspect = info.aspect && info.aspect > 0 ? info.aspect : 1;
  const vector = info.kind === "vector" || !!info.editable;
  let w = vector ? 0.32 : 0.5;
  let h = (w * W) / H / aspect;
  if (h > 0.6) {
    h = 0.6;
    w = (h * H * aspect) / W;
  }
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return newImageLayer(info.src, {
    id: makeId(),
    name: info.name.replace(/\s*\(demo\)$/, "").slice(0, 60),
    x: r((1 - w) / 2),
    y: r((1 - h) / 2),
    w: r(w),
    h: r(h),
    fit: vector ? "contain" : "cover",
    source: info.source ?? "freepik",
    ...(info.assetId ? { asset: info.assetId } : {}),
    ...(info.format ? { format: info.format.slice(0, 20) } : {}),
    ...(info.note ? { note: info.note.slice(0, 240) } : {}),
    ...(info.editable && info.colors?.length ? { colors: info.colors.slice(0, 24) } : {}),
    ...(info.lettering ? { lettering: true } : {}),
  });
}

/** One colour of an editable vector layer changed (or put back when `to` is its original). */
export function recolorLayer(layer: ImageLayer, from: string, to: string): ImageLayer {
  const map = { ...(layer.recolor ?? {}), [from.toLowerCase()]: to.toLowerCase() };
  const clean = cleanColorMap(map);
  return { ...layer, recolor: Object.keys(clean).length ? clean : undefined };
}
