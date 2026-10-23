/**
 * The browser half of taking a vector apart (shared/svg-split.ts is the pure half): the layer's
 * SVG is read, sanitised again, rendered offscreen in this page and measured (getBBox on every
 * painted element, mapped into the vector's own coordinates with getScreenCTM, the stroke width
 * and filter effects added), then cut into pieces, each placed so the composition looks exactly
 * as the single layer did. Nothing here stores anything: the Text studio sends the pieces to the
 * Worker, which sanitises and stores them.
 */
import { sanitizeSvg } from "@shared/svg-sanitize";
import { extractSvgColors, cleanColorMap } from "@shared/svg-colors";
import {
  buildPieceSvg,
  coverage,
  detectBackground,
  hasLettering,
  intersect,
  meaningfulId,
  mergeToBudget,
  pieceFacts,
  pieceKind,
  placePiece,
  prepareSplit,
  serializeSvg,
  union,
  userBoxOnCanvas,
  visibleUserBox,
  withoutElements,
  type Box,
  type LayerPlace,
  type SplitDoc,
  type SvgEl,
} from "@shared/svg-split";

/** The SVG text of a layer's file; null when the file is not an SVG (a PNG, a JPG, an EPS preview). */
export async function fetchSvgText(src: string): Promise<string | null> {
  try {
    const r = await fetch(src, { credentials: "same-origin" });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    const text = await r.text();
    if (
      /svg/i.test(type) ||
      /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
        text.slice(0, 4096),
      )
    )
      return text;
    return null;
  } catch {
    return null;
  }
}

const LEAVES = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "use",
  "image",
]);
const NOT_PAINTED =
  "defs, clipPath, mask, symbol, pattern, marker, linearGradient, radialGradient, filter";

/**
 * The bounding box of each of the given elements in the vector's coordinates (view box units),
 * stroke included; null for an element that paints nothing. Measured on the SVG rendered offscreen.
 */
export function measure(doc: SplitDoc, targets: SvgEl[]): (Box | null)[] {
  const keys = new Map<SvgEl, Record<string, string>>(
    targets.map((t, i) => [t, { "data-sk": String(i) }]),
  );
  // The tree is written back from its own parse (already sanitised): no script, no handler, no outside reference.
  const markup = serializeSvg(doc.root, keys);
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return targets.map(() => null);
  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  svg.setAttribute("width", String(doc.frame.width));
  svg.setAttribute("height", String(doc.frame.height));
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
  host.appendChild(svg);
  document.body.appendChild(host);
  try {
    const rootCtm = svg.getScreenCTM();
    if (!rootCtm) return targets.map(() => null);
    const inv = rootCtm.inverse();
    return targets.map((_, i) => {
      const el = svg.querySelector(`[data-sk="${i}"]`) as SVGGraphicsElement | null;
      if (!el) return null;
      const leaves = [el, ...Array.from(el.querySelectorAll("*"))].filter(
        (n): n is SVGGraphicsElement =>
          LEAVES.has(n.localName) && !(n.parentElement?.closest(NOT_PAINTED) && n !== el),
      );
      let box: Box | null = null;
      for (const leaf of leaves) {
        let bb: DOMRect;
        try {
          bb = leaf.getBBox();
        } catch {
          continue;
        }
        if (!(bb.width > 0 || bb.height > 0)) continue;
        const cs = getComputedStyle(leaf);
        if (cs.display === "none") continue;
        let pad = 0;
        if (cs.stroke && cs.stroke !== "none") {
          const sw = parseFloat(cs.strokeWidth) || 0;
          const join = cs.strokeLinejoin;
          const miter = Math.min(4, parseFloat(cs.strokeMiterlimit) || 4);
          pad =
            (sw / 2) * (join === "miter" || join === "miter-clip" || join === "arcs" ? miter : 1.5);
        }
        const ctm = leaf.getScreenCTM();
        if (!ctm) continue;
        const m = inv.multiply(ctm);
        const pts = [
          [bb.x - pad, bb.y - pad],
          [bb.x + bb.width + pad, bb.y - pad],
          [bb.x + bb.width + pad, bb.y + bb.height + pad],
          [bb.x - pad, bb.y + bb.height + pad],
        ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        box = union(box, {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        });
      }
      if (!box) return null;
      // A filter (a shadow, a blur) paints outside the shapes: its default region is 10% around them.
      const filtered =
        !!el.closest("[filter]") ||
        !!el.querySelector("[filter]") ||
        /filter\s*:/.test(el.getAttribute("style") ?? "");
      if (filtered)
        box = { x: box.x - box.w * 0.15, y: box.y - box.h * 0.15, w: box.w * 1.3, h: box.h * 1.3 };
      return box;
    });
  } finally {
    host.remove();
  }
}

/** One piece, ready to become an image layer. */
export interface PlannedPiece {
  svg: string;
  /** Its layer box (fractions of the canvas), rotation included. */
  place: { x: number; y: number; w: number; h: number; rotate?: number };
  name: string;
  kind: string;
  bg: boolean;
  lettering: boolean;
  colors: string[];
  bbox: Box;
}

export interface SplitPlan {
  doc: SplitDoc;
  pieces: PlannedPiece[];
  /** The elements found to be the vector's background, their boxes, and their outline on the canvas (pixels). */
  background: { nodes: SvgEl[]; bbox: Box; polygon: { x: number; y: number }[]; cover: number }[];
  /** How many painted elements the vector has at the level it is split (before merging to the budget). */
  elements: number;
  /** True when pieces were merged to stay within the layer budget. */
  merged: boolean;
}

/** Reads and cuts a vector for a layer at this place on a canvas of W × H; `budget` is how many layers the pieces may take. */
export function planSplit(
  svgText: string,
  layer: LayerPlace,
  W: number,
  H: number,
  budget: number,
): SplitPlan {
  const doc = prepareSplit(sanitizeSvg(svgText));
  const boxes = measure(doc, doc.items);
  const visible = visibleUserBox(doc.frame, layer, W, H);
  const found: { node: SvgEl; bbox: Box }[] = [];
  doc.items.forEach((node, i) => {
    const b = boxes[i];
    const seen = b ? intersect(b, visible) : null;
    if (seen) found.push({ node, bbox: seen });
  });
  const facts = found.map((f) => pieceFacts([f.node], f.bbox));
  const bgIdx = detectBackground(facts, doc.frame.vb);
  const groups = mergeToBudget(
    found.map((f) => f.bbox),
    budget,
    new Set(bgIdx),
  );
  const counts = new Map<string, number>();
  const pieces: PlannedPiece[] = groups.map((g) => {
    const nodes = g.map((i) => found[i].node);
    const bbox = g.map((i) => found[i].bbox).reduce<Box | null>((u, b) => union(u, b), null)!;
    const bg = g.length === 1 && bgIdx.includes(g[0]);
    const kind = pieceKind(nodes);
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    const named =
      nodes.length === 1
        ? (meaningfulId(nodes[0].attrs.id) ??
          meaningfulId((nodes[0].attrs.class ?? "").trim().split(/\s+/)[0]))
        : null;
    const name = bg ? "Background shape" : kind === "Lettering" ? (named ? `${named} (lettering)` : `Lettering ${n}`) : (named ?? `${kind} ${n}`);
    const placed = placePiece(doc.frame, layer, W, H, bbox);
    const svg = buildPieceSvg(doc, nodes, placed.bbox);
    const { bbox: _b, ...place } = placed;
    void _b;
    return {
      svg,
      place,
      name,
      kind,
      bg,
      lettering: hasLettering(nodes),
      colors: extractSvgColors(svg),
      bbox: placed.bbox,
    };
  });
  const background = bgIdx.map((i) => ({
    nodes: [found[i].node],
    bbox: found[i].bbox,
    polygon: userBoxOnCanvas(doc.frame, layer, W, H, found[i].bbox),
    cover: coverage(found[i].bbox, doc.frame.vb),
  }));
  return { doc, pieces, background, elements: found.length, merged: groups.length < found.length };
}

/** The vector without its background elements (same frame: the layer does not move), with its colours. */
export function stripBackground(plan: SplitPlan): { svg: string; colors: string[] } {
  const svg = withoutElements(
    plan.doc,
    plan.background.flatMap((b) => b.nodes),
  );
  return { svg, colors: extractSvgColors(svg) };
}

/** A layer's colour map kept for the colours a piece still has. */
export function recolorFor(
  map: Record<string, string> | undefined,
  colors: string[],
): Record<string, string> | undefined {
  const clean = cleanColorMap(map);
  const kept = Object.fromEntries(Object.entries(clean).filter(([k]) => colors.includes(k)));
  return Object.keys(kept).length ? kept : undefined;
}
