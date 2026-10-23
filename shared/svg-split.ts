/**
 * Taking a vector apart: the pure half of "Split into layers", "Remove background" and "Merge back"
 * in the Text studio. A vector image layer is one SVG file drawn as one picture; here its markup
 * becomes a tree, the tree is cut into meaningful pieces (top-level groups and shapes, through
 * single-child wrapper groups), each piece becomes a small SVG of its own that keeps every
 * definition it needs (gradients, clip paths, masks, filters, symbols reached through <use>, the
 * CSS rules that apply to it) and its exact place (the ancestors' transforms and inherited paint
 * are kept as wrapper groups; its view box is its bounding box in the vector's own coordinates).
 *
 * The bounding boxes themselves are measured by the browser (src/lib/svgSplit.ts: getBBox and
 * getScreenCTM on the SVG rendered offscreen); everything else (parsing, the splitting rules, the
 * definitions a piece depends on, background detection, the placement maths from the vector's
 * coordinates to the canvas, and the merge back into one SVG) is here, without a DOM, so the tests
 * drive it in Node. Whatever is built here is sanitised again by the Worker before it is stored.
 */

/* ───────────── A small tree for SVG markup ───────────── */

export interface SvgEl {
  name: string;
  attrs: Record<string, string>;
  children: SvgNode[];
}
export type SvgNode = SvgEl | string;

export const isEl = (n: SvgNode | undefined | null): n is SvgEl => !!n && typeof n !== "string";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    }
    return ENT[ref.toLowerCase()] ?? whole;
  });
}
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

export class SvgSplitError extends Error {}

/**
 * Parses SVG markup (the sanitiser's output, or any well-formed SVG) into a tree rooted at the
 * first <svg>. Comments, processing instructions and the DOCTYPE are skipped; CDATA is text.
 */
export function parseSvg(text: string): SvgEl {
  const doc: SvgEl = { name: "#doc", attrs: {}, children: [] };
  const stack: SvgEl[] = [doc];
  let i = 0;
  const n = text.length;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      if (stack.length > 1) top().children.push(decode(text.slice(i)));
      break;
    }
    if (lt > i && stack.length > 1) top().children.push(decode(text.slice(i, lt)));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (stack.length > 1) top().children.push(text.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<!", lt) || text.startsWith("<?", lt)) {
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const ch = text[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth = Math.max(0, depth - 1);
        else if (ch === ">" && depth === 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    const inner = text.slice(lt + 1, j);
    i = j + 1;
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const selfClose = /\/\s*$/.test(inner);
    const body = selfClose ? inner.replace(/\/\s*$/, "") : inner;
    const name = /^([^\s/>]+)/.exec(body)?.[1] ?? "";
    if (!name) continue;
    const attrs: Record<string, string> = {};
    for (const m of body
      .slice(name.length)
      .matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const raw = m[2] ?? "";
      attrs[m[1]] = decode(raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw);
    }
    const el: SvgEl = { name: name.replace(/^svg:/, ""), attrs, children: [] };
    top().children.push(el);
    if (!selfClose) stack.push(el);
  }
  const root = findFirst(doc, (e) => e.name === "svg");
  if (!root) throw new SvgSplitError("This file is not an SVG picture.");
  return root;
}

/** Writes the tree back as markup; `extra` adds attributes to chosen elements (the measuring keys). */
export function serializeSvg(el: SvgEl, extra?: Map<SvgEl, Record<string, string>>): string {
  const attrs = { ...el.attrs, ...(extra?.get(el) ?? {}) };
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join("");
  if (!el.children.length) return `<${el.name}${a}/>`;
  return `<${el.name}${a}>${el.children.map((c) => (typeof c === "string" ? escText(c) : serializeSvg(c, extra))).join("")}</${el.name}>`;
}

export function findFirst(el: SvgEl, test: (e: SvgEl) => boolean): SvgEl | null {
  for (const c of el.children) {
    if (!isEl(c)) continue;
    if (test(c)) return c;
    const inner = findFirst(c, test);
    if (inner) return inner;
  }
  return null;
}

/** Every element under `el` (and `el` itself), depth first, in paint order. */
export function walk(el: SvgEl, out: SvgEl[] = []): SvgEl[] {
  out.push(el);
  for (const c of el.children) if (isEl(c)) walk(c, out);
  return out;
}

const clone = (el: SvgEl): SvgEl => ({
  name: el.name,
  attrs: { ...el.attrs },
  children: el.children.map((c) => (typeof c === "string" ? c : clone(c))),
});

/* ───────────── The vector's frame ───────────── */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The vector's coordinates (its view box), its natural size in pixels and how one maps to the other. */
export interface SvgFrame {
  vb: Box;
  width: number;
  height: number;
  /** The root's preserveAspectRatio ("xMidYMid meet" when unset). */
  par: string;
}

const numOf = (v: string | undefined): number | null => {
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(px)?\s*$/i.exec(v ?? "");
  return m ? Number(m[1]) : null;
};

/** The frame of a vector from its root; null when it has neither a view box nor a size. */
export function frameOf(root: SvgEl): SvgFrame | null {
  const vbRaw = (root.attrs.viewBox ?? root.attrs.viewbox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasVb = vbRaw.length === 4 && vbRaw.every(Number.isFinite) && vbRaw[2] > 0 && vbRaw[3] > 0;
  let width = numOf(root.attrs.width);
  let height = numOf(root.attrs.height);
  if (!hasVb && !(width && height)) return null;
  const vb = hasVb
    ? { x: vbRaw[0], y: vbRaw[1], w: vbRaw[2], h: vbRaw[3] }
    : { x: 0, y: 0, w: width!, h: height! };
  if (!width || !height) {
    width = vb.w;
    height = vb.h;
  }
  return {
    vb,
    width,
    height,
    par: (root.attrs.preserveAspectRatio ?? "xMidYMid meet").trim() || "xMidYMid meet",
  };
}

/** The view box → natural pixels transform: x' = sx·x + tx, y' = sy·y + ty. */
export function viewBoxTransform(f: SvgFrame): { sx: number; sy: number; tx: number; ty: number } {
  const [align = "xMidYMid", mode = "meet"] = f.par.split(/\s+/);
  const kx = f.width / f.vb.w;
  const ky = f.height / f.vb.h;
  if (align === "none") return { sx: kx, sy: ky, tx: -f.vb.x * kx, ty: -f.vb.y * ky };
  const s = mode === "slice" ? Math.max(kx, ky) : Math.min(kx, ky);
  const ax = /xMin/.test(align) ? 0 : /xMax/.test(align) ? 1 : 0.5;
  const ay = /YMin/.test(align) ? 0 : /YMax/.test(align) ? 1 : 0.5;
  return {
    sx: s,
    sy: s,
    tx: ax * (f.width - f.vb.w * s) - f.vb.x * s,
    ty: ay * (f.height - f.vb.h * s) - f.vb.y * s,
  };
}

/* ───────────── Placement: the vector's coordinates on the canvas ───────────── */

/** The parts of an image layer that decide where its picture lands (fractions of the canvas). */
export interface LayerPlace {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  fit?: "cover" | "contain";
  crop?: Box;
}

/**
 * How a point of the vector (view box units) lands on the canvas before the layer's rotation:
 * the view box → natural pixels, the crop, then the fit inside the layer's box, exactly as the
 * renderer draws an image layer (src/lib/textLayers.ts, paintImage). A linear map per axis:
 * X = ax·x + bx, Y = ay·y + by.
 */
export function userToCanvas(
  f: SvgFrame,
  l: LayerPlace,
  W: number,
  H: number,
): { ax: number; bx: number; ay: number; by: number } {
  const t = viewBoxTransform(f);
  const crop = l.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx0 = crop.x * f.width;
  const sy0 = crop.y * f.height;
  const sw = Math.max(1e-9, crop.w * f.width);
  const sh = Math.max(1e-9, crop.h * f.height);
  const bw = l.w * W;
  const bh = l.h * H;
  const k = l.fit === "contain" ? Math.min(bw / sw, bh / sh) : Math.max(bw / sw, bh / sh);
  const dx = l.x * W + (bw - sw * k) / 2;
  const dy = l.y * H + (bh - sh * k) / 2;
  return { ax: t.sx * k, bx: dx + (t.tx - sx0) * k, ay: t.sy * k, by: dy + (t.ty - sy0) * k };
}

/** The part of the vector (view box units) the layer shows: its viewport, its crop and its box (cover trims). */
export function visibleUserBox(f: SvgFrame, l: LayerPlace, W: number, H: number): Box {
  const m = userToCanvas(f, l, W, H);
  const t = viewBoxTransform(f);
  const crop = l.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  // In natural pixels: the viewport, the crop.
  const nat = intersect(
    { x: 0, y: 0, w: f.width, h: f.height },
    { x: crop.x * f.width, y: crop.y * f.height, w: crop.w * f.width, h: crop.h * f.height },
  );
  const inUser = nat
    ? { x: (nat.x - t.tx) / t.sx, y: (nat.y - t.ty) / t.sy, w: nat.w / t.sx, h: nat.h / t.sy }
    : null;
  // The layer's box, back in user units.
  const boxUser = {
    x: (l.x * W - m.bx) / m.ax,
    y: (l.y * H - m.by) / m.ay,
    w: (l.w * W) / m.ax,
    h: (l.h * H) / m.ay,
  };
  return (inUser && intersect(inUser, boxUser)) ?? { x: 0, y: 0, w: 0, h: 0 };
}

export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

export function union(a: Box | null, b: Box): Box {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const rotateAbout = (p: { x: number; y: number }, c: { x: number; y: number }, deg: number) => {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return {
    x: c.x + dx * Math.cos(a) - dy * Math.sin(a),
    y: c.y + dx * Math.sin(a) + dy * Math.cos(a),
  };
};

/** The smallest box a layer may have (the design schema's minimum width and height). */
export const MIN_LAYER = 0.01;

/**
 * Where a piece goes: the image layer (fractions of the canvas, same rotation as the vector's
 * layer) that draws the piece's own SVG (view box = `bbox`) exactly where it was drawn inside
 * the vector's layer. The rotation pivot is the piece's own centre, so its centre is turned
 * about the vector layer's centre first. A box smaller than the schema allows is grown around its
 * centre in view box units (transparent margin), never by scaling the drawing; the grown `bbox`
 * is returned and is what the piece's SVG must use.
 */
export function placePiece(
  f: SvgFrame,
  l: LayerPlace,
  W: number,
  H: number,
  bbox: Box,
): { x: number; y: number; w: number; h: number; rotate?: number; bbox: Box } {
  const m = userToCanvas(f, l, W, H);
  let b = { ...bbox };
  const minW = MIN_LAYER * W * 1.0001;
  const minH = MIN_LAYER * H * 1.0001;
  if (b.w * m.ax < minW) {
    const nw = minW / m.ax;
    b = { ...b, x: b.x - (nw - b.w) / 2, w: nw };
  }
  if (b.h * m.ay < minH) {
    const nh = minH / m.ay;
    b = { ...b, y: b.y - (nh - b.h) / 2, h: nh };
  }
  const rw = b.w * m.ax;
  const rh = b.h * m.ay;
  const c = { x: b.x * m.ax + m.bx + rw / 2, y: b.y * m.ay + m.by + rh / 2 };
  const pivot = { x: (l.x + l.w / 2) * W, y: (l.y + l.h / 2) * H };
  const turned = rotateAbout(c, pivot, l.rotate ?? 0);
  return {
    x: (turned.x - rw / 2) / W,
    y: (turned.y - rh / 2) / H,
    w: rw / W,
    h: rh / H,
    ...(l.rotate ? { rotate: l.rotate } : {}),
    bbox: b,
  };
}

/** A view box (user units) as the polygon it covers on the canvas, rotation included (for the highlight). */
export function userBoxOnCanvas(
  f: SvgFrame,
  l: LayerPlace,
  W: number,
  H: number,
  b: Box,
): { x: number; y: number }[] {
  const m = userToCanvas(f, l, W, H);
  const pivot = { x: (l.x + l.w / 2) * W, y: (l.y + l.h / 2) * H };
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ].map(([x, y]) => rotateAbout({ x: x * m.ax + m.bx, y: y * m.ay + m.by }, pivot, l.rotate ?? 0));
}

/* ───────────── The splitting rules ───────────── */

/** Elements that paint (a piece can be one of these). */
const RENDER = new Set([
  "g",
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
  "svg",
  "a",
  "switch",
]);
/** A single painted shape (a candidate background). */
const SHAPE = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "image"]);

const styleHas = (el: SvgEl, prop: string, value?: RegExp) => {
  const m = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(el.attrs.style ?? "");
  return !!m && (!value || value.test(m[2]));
};
const propOf = (el: SvgEl, prop: string): string | undefined =>
  el.attrs[prop] ??
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(el.attrs.style ?? "")?.[1]?.trim();

function hidden(el: SvgEl): boolean {
  return (
    el.attrs.display === "none" ||
    el.attrs.visibility === "hidden" ||
    styleHas(el, "display", /none/) ||
    styleHas(el, "visibility", /hidden/)
  );
}

/** A group that only wraps: descending through it keeps the look (its transform and paint go on every piece). */
function isWrapper(el: SvgEl): boolean {
  return (
    el.name === "g" &&
    !el.attrs.filter &&
    !el.attrs.mask &&
    !styleHas(el, "filter") &&
    !styleHas(el, "mask")
  );
}

const renderables = (el: SvgEl) =>
  el.children.filter((c): c is SvgEl => isEl(c) && RENDER.has(c.name) && !hidden(c));

/**
 * The pieces of a vector: the painted children of the root, descending through every group that
 * is the only painted child of its parent (an editor's "Layer 1" wrapper). `chain` is that path of
 * wrapper groups (outermost first): each piece is wrapped in copies of them, so their transforms
 * and inherited paint still apply. A group with a filter or a mask is never descended into (its
 * effect is on the whole group).
 */
export function findPieces(root: SvgEl): { chain: SvgEl[]; items: SvgEl[] } {
  const chain: SvgEl[] = [];
  let level = root;
  for (let guard = 0; guard < 64; guard++) {
    const r = renderables(level);
    if (r.length === 1 && isWrapper(r[0]) && renderables(r[0]).length > 0) {
      chain.push(r[0]);
      level = r[0];
      continue;
    }
    return { chain, items: r };
  }
  return { chain, items: renderables(level) };
}

/** What a piece is, for its name: a group, a shape, lettering (an SVG <text>: shapes of letters, not editable text), a copy of a symbol. */
export function pieceKind(
  nodes: SvgEl[],
): "Group" | "Shape" | "Lettering" | "Symbol" | "Picture" | "Shapes" {
  if (nodes.length > 1) return "Shapes";
  const n = nodes[0];
  if (n.name === "text") return "Lettering";
  if (n.name === "use") return "Symbol";
  if (n.name === "image") return "Picture";
  if (n.name === "g" || n.name === "svg" || n.name === "a" || n.name === "switch")
    return walk(n).some((e) => e.name === "text") && !walk(n).some((e) => SHAPE.has(e.name))
      ? "Lettering"
      : "Group";
  return "Shape";
}

/** True when a piece contains SVG text (drawn as a picture: never editable words). */
export const hasLettering = (nodes: SvgEl[]) =>
  nodes.some((n) => walk(n).some((e) => e.name === "text"));

/** An editor's own id or class ("path12", "g3", "Layer_1", "_x31_", "st0", "cls-2") says nothing; a designer's ("badge-ring", "cloud") does. */
export function meaningfulId(id: string | undefined): string | null {
  if (!id) return null;
  const s = id
    .replace(/_x([0-9a-f]{2})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[_-]+/g, " ")
    .trim();
  if (
    !s ||
    /^(path|g|group|rect|circle|ellipse|polygon|polyline|line|use|text|layer|shape|svg|object|clip|mask|defs|image|surface|id)\s*\d*$/i.test(
      s,
    ) ||
    /^(st|cls|fil|str|fnt|s|c)\s*\d+$/i.test(s) ||
    /^[\d\s.]+$/.test(s) ||
    s.length > 40
  )
    return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The single painted shape a piece is (through groups of one), or null. */
function singleShape(el: SvgEl): SvgEl | null {
  if (SHAPE.has(el.name)) return el;
  if (el.name === "g") {
    const r = renderables(el);
    return r.length === 1 ? singleShape(r[0]) : null;
  }
  return null;
}

/** What background detection reads of a piece. */
export interface PieceFacts {
  /** Its bounding box in view box units. */
  bbox: Box;
  /** A single shape (through groups of one): rect, path, polygon, circle, ellipse, image. */
  shape: boolean;
  /** Its fill is none (an outline), or it is clipped or masked: never a background. */
  unfilled: boolean;
  /** Its id or class says background ("bg", "background", "backdrop"). */
  named: boolean;
}

export function pieceFacts(nodes: SvgEl[], bbox: Box): PieceFacts {
  const one = nodes.length === 1 ? nodes[0] : null;
  const shape = one ? singleShape(one) : null;
  const fill = shape
    ? (propOf(shape, "fill") ?? (one ? propOf(one, "fill") : undefined))
    : undefined;
  const clipped = nodes.some((n) =>
    walk(n).some(
      (e) =>
        !!(e.attrs["clip-path"] || e.attrs.mask || styleHas(e, "clip-path") || styleHas(e, "mask")),
    ),
  );
  const opacity = shape
    ? Number(propOf(shape, "opacity") ?? propOf(shape, "fill-opacity") ?? 1)
    : 1;
  const named = nodes.some((n) =>
    /(^|[\s_-])(bg|background|backdrop)([\s_\d-]|$)/i.test(
      `${n.attrs.id ?? ""} ${n.attrs.class ?? ""}`,
    ),
  );
  return {
    bbox,
    shape: !!shape,
    unfilled: (fill ?? "").trim().toLowerCase() === "none" || clipped || opacity < 0.05,
    named,
  };
}

/** How much of the view box a box covers (0..1). */
export function coverage(b: Box, vb: Box): number {
  const i = intersect(b, vb);
  return i ? (i.w * i.h) / (vb.w * vb.h) : 0;
}

/** At least this much of the view box: a background. */
export const BACKGROUND_COVER = 0.9;

/**
 * The pieces that are the vector's background, by index: from the bottom of the paint order, each
 * filled single shape (or a piece named background) whose box covers at least 90% of the view
 * box; the run stops at the first piece that is not. Never every piece (something must remain),
 * never more than three.
 */
export function detectBackground(pieces: PieceFacts[], vb: Box): number[] {
  const out: number[] = [];
  for (let i = 0; i < pieces.length && out.length < 3; i++) {
    const p = pieces[i];
    if (p.unfilled || !(p.shape || p.named) || coverage(p.bbox, vb) < BACKGROUND_COVER) break;
    out.push(i);
  }
  return out.length >= pieces.length ? [] : out;
}

/**
 * Pieces merged until there are at most `budget`: the adjacent pair (in paint order, so the
 * stacking never changes) with the smallest combined box is merged first. `fixed` pieces (the
 * background) are never merged. Returns the groups of indices, in order.
 */
export function mergeToBudget(
  boxes: Box[],
  budget: number,
  fixed: Set<number> = new Set(),
): number[][] {
  const groups = boxes.map((b, i) => ({ idx: [i], box: b, fixed: fixed.has(i) }));
  const target = Math.max(1, budget);
  while (groups.length > target) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i + 1 < groups.length; i++) {
      if (groups[i].fixed || groups[i + 1].fixed) continue;
      const u = union(groups[i].box, groups[i + 1].box);
      const area = u.w * u.h;
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best < 0) break;
    const a = groups[best];
    const b = groups[best + 1];
    groups.splice(best, 2, { idx: [...a.idx, ...b.idx], box: union(a.box, b.box), fixed: false });
  }
  return groups.map((g) => g.idx);
}

/* ───────────── What a piece depends on ───────────── */

/** The ids an element (and everything under it) points at: href="#id", url(#id). */
export function refsOf(el: SvgEl, out = new Set<string>()): Set<string> {
  for (const e of walk(el)) {
    for (const [k, v] of Object.entries(e.attrs)) {
      if ((k === "href" || k === "xlink:href") && v.trim().startsWith("#"))
        out.add(v.trim().slice(1));
      for (const m of v.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) out.add(m[1]);
    }
  }
  return out;
}

/** Every element with an id, the first wins (as a browser resolves it). */
export function idIndex(root: SvgEl): Map<string, SvgEl> {
  const map = new Map<string, SvgEl>();
  for (const e of walk(root)) if (e.attrs.id && !map.has(e.attrs.id)) map.set(e.attrs.id, e);
  return map;
}

/** The text of every <style> in the file, in order. */
export function cssOf(root: SvgEl): string {
  return walk(root)
    .filter((e) => e.name === "style")
    .map((e) => e.children.filter((c): c is string => typeof c === "string").join(""))
    .join("\n");
}

interface CssRule {
  selector: string | null;
  text: string;
}

/** Top-level CSS rules; an at-rule (@media, @font-face) is kept whole with no selector. */
export function cssRules(css: string): CssRule[] {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
      j++;
    }
    const head = s.slice(i, open).trim();
    const text = s.slice(i, j).trim();
    if (head) out.push({ selector: head.startsWith("@") ? null : head, text });
    i = j;
  }
  return out;
}

/** The class and id names a CSS selector needs; empty when it names none (it may apply anywhere). */
const selectorTokens = (sel: string) =>
  [...sel.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)].map((m) => `${m[1]}${m[2]}`);

/** The rules that can apply to elements carrying these classes and ids. */
export function rulesFor(rules: CssRule[], tokens: Set<string>): CssRule[] {
  return rules.filter((r) => {
    if (!r.selector) return true;
    const t = selectorTokens(r.selector);
    return !t.length || t.some((x) => tokens.has(x));
  });
}

function tokensOf(els: SvgEl[], into = new Set<string>()): Set<string> {
  for (const el of els)
    for (const e of walk(el)) {
      for (const c of (e.attrs.class ?? "").split(/\s+/)) if (c) into.add(`.${c}`);
      if (e.attrs.id) into.add(`#${e.attrs.id}`);
    }
  return into;
}

/** The parsed vector, ready to be cut. */
export interface SplitDoc {
  root: SvgEl;
  frame: SvgFrame;
  chain: SvgEl[];
  items: SvgEl[];
  ids: Map<string, SvgEl>;
  rules: CssRule[];
}

export function prepareSplit(svg: string): SplitDoc {
  const root = parseSvg(svg);
  const frame = frameOf(root);
  if (!frame)
    throw new SvgSplitError("This SVG has no size or view box, so its pieces cannot be placed.");
  const { chain, items } = findPieces(root);
  return { root, frame, chain, items, ids: idIndex(root), rules: cssRules(cssOf(root)) };
}

/** Root attributes that size the file; every other root attribute (paint, font, class, id) wraps the piece. */
const SIZING = new Set([
  "xmlns",
  "xmlns:xlink",
  "viewBox",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "preserveAspectRatio",
  "version",
  "baseProfile",
  "enable-background",
  "overflow",
  "xml:space",
]);

/**
 * The definitions a piece needs, closed over: everything its elements, its wrappers and the CSS
 * rules that apply to it point at, and what those point at in turn (a gradient's href, a clip
 * path's <use>, a symbol's own gradients). Elements already inside the piece are not copied.
 */
export function defsClosure(doc: SplitDoc, nodes: SvgEl[]): { defs: SvgEl[]; rules: CssRule[] } {
  const inside = new Set<SvgEl>(nodes.flatMap((n) => walk(n)));
  const wrappers = [doc.root, ...doc.chain];
  const defs: SvgEl[] = [];
  const seen = new Set<string>();
  let rules: CssRule[] = [];
  const wrapperShells = wrappers.map((w) => ({ ...w, children: [] }));
  for (let round = 0; round < 32; round++) {
    const tokens = tokensOf([...nodes, ...defs, ...wrapperShells]);
    rules = rulesFor(doc.rules, tokens);
    const refs = new Set<string>();
    for (const n of [...nodes, ...defs, ...wrapperShells]) refsOf(n, refs);
    for (const r of rules)
      for (const m of r.text.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) refs.add(m[1]);
    let added = false;
    for (const id of refs) {
      if (seen.has(id)) continue;
      seen.add(id);
      const target = doc.ids.get(id);
      if (!target || inside.has(target) || wrappers.includes(target)) continue;
      // A definition nested in another one already copied comes along with it.
      if (defs.some((d) => walk(d).includes(target))) continue;
      defs.push(target);
      added = true;
    }
    if (!added) break;
  }
  // Paint order of the source: definitions keep their relative order.
  const order = new Map(walk(doc.root).map((e, i) => [e, i]));
  defs.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { defs, rules };
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000);

/**
 * One piece as its own SVG: view box = `bbox` (the vector's units, so the piece's coordinates are
 * the vector's), its natural size the same pixels per unit as the vector's, the root's paint and
 * the wrapper groups around it, and the closed-over definitions and CSS in front.
 */
export function buildPieceSvg(doc: SplitDoc, nodes: SvgEl[], bbox: Box): string {
  const t = viewBoxTransform(doc.frame);
  const { defs, rules } = defsClosure(doc, nodes);
  const rootPaint = Object.fromEntries(
    Object.entries(doc.root.attrs).filter(([k]) => !SIZING.has(k) && !k.startsWith("xmlns")),
  );
  let body: SvgEl[] = nodes.map(clone);
  for (const w of [...doc.chain].reverse())
    body = [{ name: w.name, attrs: { ...w.attrs }, children: body }];
  if (Object.keys(rootPaint).length) body = [{ name: "g", attrs: rootPaint, children: body }];
  const children: SvgNode[] = [];
  if (defs.length) children.push({ name: "defs", attrs: {}, children: defs.map(clone) });
  if (rules.length)
    children.push({ name: "style", attrs: {}, children: [rules.map((r) => r.text).join("\n")] });
  children.push(...body);
  const root: SvgEl = {
    name: "svg",
    attrs: {
      xmlns: "http://www.w3.org/2000/svg",
      "xmlns:xlink": "http://www.w3.org/1999/xlink",
      viewBox: `${fmt(bbox.x)} ${fmt(bbox.y)} ${fmt(bbox.w)} ${fmt(bbox.h)}`,
      width: fmt(bbox.w * t.sx),
      height: fmt(bbox.h * t.sy),
      preserveAspectRatio: "none",
    },
    children,
  };
  return serializeSvg(root);
}

/** The vector without some of its elements (the background), same frame: the layer does not move. */
export function withoutElements(doc: SplitDoc, remove: SvgEl[]): string {
  const drop = new Set(remove);
  const strip = (el: SvgEl): SvgEl => ({
    ...el,
    children: el.children
      .filter((c) => !(isEl(c) && drop.has(c)))
      .map((c) => (typeof c === "string" ? c : strip(c))),
  });
  return serializeSvg(strip(doc.root));
}

/* ───────────── Merge back: the pieces as one SVG again ───────────── */

/** A piece as it stands on the canvas now (pixels), with its file. */
export interface MergePiece {
  svg: string;
  /** Its layer box in canvas pixels, before rotation. */
  box: Box;
  rotate?: number;
  opacity?: number;
  fit?: "cover" | "contain";
  recolored?: boolean;
}

/** Ids prefixed, and every href/url(#…) that points at them, so pieces cannot collide. */
function prefixIds(root: SvgEl, prefix: string): void {
  const ids = new Set(
    walk(root)
      .map((e) => e.attrs.id)
      .filter((x): x is string => !!x),
  );
  const fix = (v: string) =>
    v.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (whole, q: string, id: string) =>
      ids.has(id) ? `url(${q}#${prefix}${id}${q})` : whole,
    );
  for (const e of walk(root)) {
    for (const [k, v] of Object.entries(e.attrs)) {
      if (k === "id") e.attrs[k] = `${prefix}${v}`;
      else if (
        (k === "href" || k === "xlink:href") &&
        v.trim().startsWith("#") &&
        ids.has(v.trim().slice(1))
      )
        e.attrs[k] = `#${prefix}${v.trim().slice(1)}`;
      else if (v.includes("url(")) e.attrs[k] = fix(v);
    }
    if (e.name === "style")
      e.children = e.children.map((c) =>
        typeof c === "string" ? scopeCss(fix(c), prefix, ids) : c,
      );
  }
}

/** CSS of one piece scoped to its wrapper class, its id selectors renamed with the piece's prefix. */
export function scopeCss(css: string, prefix: string, ids: Set<string>): string {
  return cssRules(css)
    .map((r) => {
      if (!r.selector) return r.text;
      const body = r.text.slice(r.text.indexOf("{"));
      const sel = r.selector
        .split(",")
        .map(
          (s) =>
            `.${prefix}scope ${s.trim().replace(/#(-?[_a-zA-Z][\w-]*)/g, (whole, id: string) => (ids.has(id) ? `#${prefix}${id}` : whole))}`,
        )
        .join(", ");
      return `${sel}${body}`;
    })
    .join("\n");
}

/**
 * The pieces composed into one SVG: each nested at its place (its box, its rotation about its
 * centre, its opacity; "Fit inside" as meet, "Fill the box" as slice), ids and CSS scoped per
 * piece. The result's view box is the union of the pieces' turned boxes in canvas pixels, so the
 * merged layer is that box (fractions of the canvas), unrotated, fit inside.
 */
export function mergePieces(pieces: MergePiece[]): { svg: string; box: Box } {
  if (!pieces.length) throw new SvgSplitError("Nothing to merge.");
  let u: Box | null = null;
  for (const p of pieces) {
    const c = { x: p.box.x + p.box.w / 2, y: p.box.y + p.box.h / 2 };
    const pts = [
      [p.box.x, p.box.y],
      [p.box.x + p.box.w, p.box.y],
      [p.box.x + p.box.w, p.box.y + p.box.h],
      [p.box.x, p.box.y + p.box.h],
    ].map(([x, y]) => rotateAbout({ x, y }, c, p.rotate ?? 0));
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    u = union(u, {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    });
  }
  const U = u!;
  const children: SvgNode[] = pieces.map((p, i) => {
    const r = parseSvg(p.svg);
    const prefix = `m${i}-`;
    prefixIds(r, prefix);
    const inner = Object.fromEntries(
      Object.entries(r.attrs).filter(([k]) => !SIZING.has(k) && !k.startsWith("xmlns")),
    );
    const nested: SvgEl = {
      name: "svg",
      attrs: {
        x: fmt(p.box.x - U.x),
        y: fmt(p.box.y - U.y),
        width: fmt(p.box.w),
        height: fmt(p.box.h),
        ...(r.attrs.viewBox ? { viewBox: r.attrs.viewBox } : {}),
        preserveAspectRatio: p.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet",
      },
      children: Object.keys(inner).length
        ? [{ name: "g", attrs: inner, children: r.children }]
        : r.children,
    };
    const cx = p.box.x - U.x + p.box.w / 2;
    const cy = p.box.y - U.y + p.box.h / 2;
    const attrs: Record<string, string> = { class: `${prefix}scope` };
    if (p.rotate) attrs.transform = `rotate(${fmt(p.rotate)} ${fmt(cx)} ${fmt(cy)})`;
    if (p.opacity !== undefined && p.opacity < 1) attrs.opacity = fmt(p.opacity);
    return { name: "g", attrs, children: [nested] };
  });
  const root: SvgEl = {
    name: "svg",
    attrs: {
      xmlns: "http://www.w3.org/2000/svg",
      "xmlns:xlink": "http://www.w3.org/1999/xlink",
      viewBox: `0 0 ${fmt(U.w)} ${fmt(U.h)}`,
      width: fmt(U.w),
      height: fmt(U.h),
    },
    children,
  };
  return { svg: serializeSvg(root), box: U };
}
