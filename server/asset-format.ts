/**
 * What a downloaded stock file really is, read from its bytes (never from its name alone), and
 * what an image layer of a design can draw from it:
 *
 * - an SVG (on its own, or inside a vector's ZIP): sanitised (no script, no event handler, no
 *   outside reference) and stored as the layer's file; its fill and stroke colours become the
 *   swatches the layer can recolour;
 * - a PNG, JPG, WebP or GIF (a photo, or the raster a vector's ZIP carries): drawn as it is;
 * - EPS, AI, PDF and PSD: no Worker can render them without an outside converter, so nothing is
 *   pretended: the preview picture is placed instead and the note says the colours cannot change.
 *
 * Everything here is pure (bytes in, bytes out), so the tests drive it without a bucket.
 */
import { unzipSync } from "fflate";
import { extractSvgColors } from "@shared/svg-colors";

export type SourceFormat = "svg" | "png" | "jpg" | "webp" | "gif" | "eps" | "ai" | "pdf" | "psd" | "zip" | "unknown";

export interface LayerFile {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  /** Where it came from inside a bundle ("lightning.svg"), when it did. */
  entry?: string;
}

export interface Inspection {
  /** The outer file. */
  format: SourceFormat;
  /** The formats found inside a ZIP (svg, eps, ai, png, jpg…), sorted; empty for a single file. */
  contents: SourceFormat[];
  /** What an image layer draws; null when only the preview picture can stand in. */
  layer: LayerFile | null;
  /** True for a sanitised SVG: its colours can be changed on the layer. */
  editable: boolean;
  /** The SVG's distinct paint colours, most used first. */
  colors: string[];
  /** One plain sentence for the UI. */
  note: string;
}

/** Limits that keep a Worker's memory safe: a vector's SVG is rarely over a few MB. */
export const MAX_SVG_BYTES = 8 * 1024 * 1024;
export const MAX_RASTER_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 400;

export const NOTES = {
  svg: "Editable vector (SVG): its colours can be changed on the layer.",
  zipSvg: "Vector bundle with an SVG: the SVG is placed as an editable vector; the EPS/AI files stay in the library.",
  raster: "A picture (JPG/PNG): placed as it is; its colours cannot be changed here.",
  epsRaster: "This file is EPS/AI: colours cannot be changed here. The PNG/JPG it carries is placed instead.",
  eps: "This file is EPS/AI: colours cannot be changed here. The preview picture is placed instead.",
  psd: "This file is PSD: its layers and colours cannot be changed here. The flattened preview picture is placed instead.",
  pdf: "This file is a PDF: colours cannot be changed here. The preview picture is placed instead.",
  unknown: "This file type cannot be drawn here. The preview picture is placed instead.",
  badSvg: "The SVG could not be read safely, so it is not used. The preview picture is placed instead.",
} as const;

const MIME: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(b.length, to)));

/** The format from the first bytes; the name only decides between a PDF and an Illustrator file. */
export function sniffFormat(bytes: Uint8Array, filename = ""): SourceFormat {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (ascii(bytes, 0, 4) === "8BPS") return "psd";
  if (startsWith(bytes, [0xc5, 0xd0, 0xd3, 0xc6])) return "eps";
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, "");
  if (head.startsWith("%PDF")) return /\.ai$/i.test(filename) || /Illustrator/.test(head) ? "ai" : "pdf";
  if (head.startsWith("%!PS")) return /Illustrator/.test(head) || /\.ai$/i.test(filename) ? "ai" : "eps";
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) || (/^\s*</.test(head) && /<svg[\s>]/i.test(head))) return "svg";
  return "unknown";
}

const extOfName = (name: string): SourceFormat => {
  const e = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  if (e === "jpeg" || e === "jpg") return "jpg";
  if (e === "svg" || e === "png" || e === "webp" || e === "gif" || e === "eps" || e === "ai" || e === "pdf" || e === "psd" || e === "zip") return e;
  return "unknown";
};

/* ───────────── SVG sanitising ───────────── */

/** Elements an image layer may draw. Anything else (script, foreignObject, iframe, an editor's own data) is dropped with its content. */
const ALLOWED = new Set(
  [
    "svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
    "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "image", "title", "desc", "style", "marker",
    "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
    "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode",
    "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
  ].map((n) => n.toLowerCase()),
);
/** Wrappers whose children are kept: a link (its target is dropped), a switch. */
const UNWRAP = new Set(["a", "switch"]);
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "text"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string, custom: Map<string, string>): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z_][\w.-]*);/gi, (_whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return PREDEFINED[ref] ?? custom.get(ref) ?? "";
  });
}
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

/** CSS with nothing that reaches out or runs: no @import, no url() but #ids, no expression(), no bindings. */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)\s*(?!#)[^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "(")
    .replace(/(-moz-binding|behavior)\s*:[^;}]*/gi, "")
    .replace(/(java|vb)script\s*:/gi, "")
    .replace(/</g, "\\3c ");
}

/** True when a value would reach out of the file or run something. */
function dangerous(value: string): boolean {
  // Whitespace and control characters hide a scheme ("java\tscript:"); they are dropped before the check.
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  if (/(java|vb)script:|data:(?!image\/(png|jpe?g|gif|webp);base64,)/.test(v)) return true;
  if (/url\((?!['"]?#)/.test(v)) return true;
  if (/expression\(/.test(v)) return true;
  return false;
}

interface Attr {
  name: string;
  value: string;
}

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function parseAttrs(src: string, custom: Map<string, string>): Attr[] {
  const out: Attr[] = [];
  for (const m of src.matchAll(ATTR_RE)) {
    const raw = m[2] ?? "";
    const unquoted = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    out.push({ name: m[1], value: decodeEntities(unquoted, custom) });
    if (out.length > 200) break;
  }
  return out;
}

export class SvgRefused extends Error {}

/**
 * The SVG rebuilt from an allow-list: every element and attribute that is kept is written out
 * again by this function (never copied as raw text), so a malformed or hostile file cannot slip
 * markup through. Removed: scripts, foreignObject and every unknown element with its content,
 * event handlers (on…), links out (href other than #id or an embedded PNG/JPG/GIF/WebP),
 * url() to anything but #id, @import, DOCTYPE and processing instructions. The root gets the SVG
 * namespace and a size (from its viewBox) so a browser draws it as an <img>.
 */
export function sanitizeSvg(input: string): string {
  if (input.length > MAX_SVG_BYTES) throw new SvgRefused("The SVG is too large to use here.");
  const text = input.replace(/^\uFEFF/, "");
  // Plain internal entities (Illustrator declares its namespaces this way); no nesting, no markup.
  const custom = new Map<string, string>();
  const doctype = /<!DOCTYPE[^[>]*\[([\s\S]*?)\]\s*>/i.exec(text);
  if (doctype) {
    for (const m of doctype[1].matchAll(/<!ENTITY\s+([a-z_][\w.-]*)\s+(["'])([^"'&<%]{0,512})\2\s*>/gi)) {
      if (custom.size < 50) custom.set(m[1], m[3]);
    }
  }
  const out: string[] = [];
  /** For each open element: how it is written (kept, unwrapped or dropped with its content). */
  const stack: { name: string; mode: "keep" | "unwrap" | "drop" }[] = [];
  let dropping = 0;
  let rootAt = -1;
  let rootAttrs: Attr[] = [];
  let rootClosed = false;
  let needsBlack = false;
  let i = 0;
  const n = text.length;
  const inStyle = () => stack.length > 0 && stack[stack.length - 1].name === "style" && stack[stack.length - 1].mode === "keep";
  const emitText = (raw: string, cdata = false) => {
    if (dropping || rootAt < 0 || rootClosed) return;
    const decoded = cdata ? raw : decodeEntities(raw, custom);
    out.push(inStyle() ? sanitizeCss(decoded) : escText(decoded));
  };
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      emitText(text.slice(i));
      break;
    }
    if (lt > i) emitText(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      emitText(text.slice(lt + 9, end < 0 ? n : end), true);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<!", lt) || text.startsWith("<?", lt)) {
      // DOCTYPE (with its internal subset), processing instructions: never written.
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
    // A tag: find its end outside quoted attribute values.
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
    if (j >= n) break;
    const inner = text.slice(lt + 1, j);
    i = j + 1;
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      // Close up to the matching element; a stray closing tag is ignored.
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) {
        const top = stack.pop()!;
        if (top.mode === "drop") dropping--;
        else if (top.mode === "keep" && !dropping) out.push(`</${top.name === "svg" ? "svg" : canonical(top.name)}>`);
        if (stack.length === 0 && top.name === "svg") rootClosed = true;
      }
      continue;
    }
    const selfClose = /\/\s*$/.test(inner);
    const body = selfClose ? inner.replace(/\/\s*$/, "") : inner;
    const nm = /^([^\s/>]+)/.exec(body)?.[1] ?? "";
    // A malformed name ("scr<script") is no element: nothing of it is written, and it opens nothing.
    if (!/^[a-z_][\w.:-]*$/i.test(nm)) continue;
    const local = nm.toLowerCase();
    const prefixed = local.includes(":") && !local.startsWith("svg:");
    const name = local.replace(/^svg:/, "");
    const mode: "keep" | "unwrap" | "drop" = dropping || prefixed || rootClosed ? "drop" : ALLOWED.has(name) ? "keep" : UNWRAP.has(name) ? "unwrap" : "drop";
    if (rootAt < 0 && mode !== "drop" && name !== "svg") throw new SvgRefused("This file is not an SVG picture.");
    if (mode === "keep") {
      const attrs = parseAttrs(body.slice(nm.length), custom);
      const kept: Attr[] = [];
      let hasFill = false;
      let hasClass = false;
      for (const a of attrs) {
        const an = a.name.toLowerCase();
        if (!/^[a-z_][\w.:-]*$/i.test(a.name)) continue;
        if (an.startsWith("on")) continue;
        if (an === "xmlns" || an.startsWith("xmlns:")) continue;
        if (an === "href" || an === "xlink:href") {
          const v = a.value.trim();
          if (/^#[\w.:-]+$/.test(v) || (name === "image" && DATA_IMAGE.test(v))) kept.push({ name: an === "href" ? "href" : "xlink:href", value: v });
          continue;
        }
        if (an.includes(":") && an !== "xml:space") continue;
        if (an === "style") {
          const css = sanitizeCss(a.value).trim();
          if (css) kept.push({ name: "style", value: css });
          if (/(^|;)\s*fill\s*:/i.test(a.value)) hasFill = true;
          continue;
        }
        if (dangerous(a.value)) continue;
        if (an === "fill") hasFill = true;
        if (an === "class") hasClass = true;
        kept.push({ name: a.name, value: a.value });
      }
      if (SHAPES.has(name) && !hasFill && !hasClass) needsBlack = true;
      if (rootAt < 0) {
        rootAt = out.length;
        rootAttrs = kept;
        out.push("");
        if (selfClose) {
          out.push("</svg>");
          rootClosed = true;
        }
      } else out.push(`<${canonical(name)}${kept.map((a) => ` ${a.name}="${escAttr(a.value)}"`).join("")}${selfClose ? "/" : ""}>`);
      if (!selfClose) stack.push({ name, mode });
    } else if (!selfClose) {
      stack.push({ name, mode });
      if (mode === "drop") dropping++;
    }
  }
  if (rootAt < 0) throw new SvgRefused("This file is not an SVG picture.");
  while (stack.length) {
    const top = stack.pop()!;
    if (top.mode === "drop") dropping--;
    else if (top.mode === "keep") out.push(`</${top.name === "svg" ? "svg" : canonical(top.name)}>`);
  }
  out[rootAt] = rootTag(rootAttrs, needsBlack);
  return out.join("");
}

/** SVG element names are case-sensitive: the allow-list's spelling, from the lower-case key. */
const CANONICAL = new Map(
  ["linearGradient", "radialGradient", "clipPath", "textPath", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence"].map((n) => [n.toLowerCase(), n]),
);
const canonical = (name: string) => CANONICAL.get(name) ?? name;

const num = (v: string | undefined) => {
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v ?? "");
  return m ? Number(m[1]) : null;
};

function rootTag(attrs: Attr[], needsBlack: boolean): string {
  const get = (k: string) => attrs.find((a) => a.name.toLowerCase() === k)?.value;
  const rest = attrs.filter((a) => !["width", "height", "viewbox"].includes(a.name.toLowerCase()));
  const vb = (get("viewBox") ?? get("viewbox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  let w = num(get("width"));
  let h = num(get("height"));
  if ((!w || !h) && hasVb) {
    w = vb[2];
    h = vb[3];
  }
  const viewBox = hasVb ? vb.join(" ") : w && h ? `0 0 ${w} ${h}` : null;
  const parts = [`xmlns="${SVG_NS}"`, `xmlns:xlink="${XLINK_NS}"`];
  if (viewBox) parts.push(`viewBox="${viewBox}"`);
  if (w && h) parts.push(`width="${w}"`, `height="${h}"`);
  // A shape with no fill paints black; saying so on the root makes that black a colour the layer can change.
  if (needsBlack && !rest.some((a) => a.name.toLowerCase() === "fill")) parts.push('fill="#000000"');
  for (const a of rest) parts.push(`${a.name}="${escAttr(a.value)}"`);
  return `<svg ${parts.join(" ")}>`;
}

/* ───────────── The inspection ───────────── */

function svgLayer(bytes: Uint8Array, entry?: string): { layer: LayerFile; colors: string[] } {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  const clean = sanitizeSvg(text);
  return { layer: { bytes: new TextEncoder().encode(clean), mime: MIME.svg, ext: "svg", ...(entry ? { entry } : {}) }, colors: extractSvgColors(clean) };
}

const isJunk = (name: string) => /(^|\/)(__MACOSX|\.)/.test(name) || /\/\._/.test(name);

/** Reads the downloaded file and decides what the layer draws. Never throws for a bad file: the note says what happened. */
export function inspectAssetFile(data: ArrayBuffer | Uint8Array, filename = ""): Inspection {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const format = sniffFormat(bytes, filename);
  const base: Inspection = { format, contents: [], layer: null, editable: false, colors: [], note: NOTES.unknown };
  if (format === "svg") {
    try {
      const s = svgLayer(bytes);
      return { ...base, layer: s.layer, editable: true, colors: s.colors, note: NOTES.svg };
    } catch {
      return { ...base, note: NOTES.badSvg };
    }
  }
  if (format === "png" || format === "jpg" || format === "webp" || format === "gif") {
    if (bytes.byteLength > MAX_RASTER_BYTES) return { ...base, note: NOTES.unknown };
    return { ...base, layer: { bytes, mime: MIME[format], ext: format }, note: NOTES.raster };
  }
  if (format === "eps" || format === "ai") return { ...base, note: NOTES.eps };
  if (format === "pdf") return { ...base, note: NOTES.pdf };
  if (format === "psd") return { ...base, note: NOTES.psd };
  if (format !== "zip") return base;

  // A bundle: list the entries first (nothing is inflated), then inflate only the one the layer needs.
  const listed: { name: string; size: number; originalSize: number; kind: SourceFormat }[] = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (listed.length < MAX_ZIP_ENTRIES && !isJunk(f.name) && !f.name.endsWith("/")) listed.push({ name: f.name, size: f.size, originalSize: f.originalSize, kind: extOfName(f.name) });
        return false;
      },
    });
  } catch {
    return { ...base, note: "The ZIP could not be read. The preview picture is placed instead." };
  }
  const contents = [...new Set(listed.map((e) => e.kind).filter((k) => k !== "unknown"))].sort() as SourceFormat[];
  const pick = (kinds: SourceFormat[], max: number) =>
    listed
      .filter((e) => kinds.includes(e.kind) && e.originalSize > 0 && e.originalSize <= max && e.originalSize <= Math.max(e.size, 1) * 200)
      .sort((a, b) => b.originalSize - a.originalSize)[0];
  const inflate = (name: string): Uint8Array | null => {
    try {
      const got = unzipSync(bytes, { filter: (f) => f.name === name });
      return got[name] ?? null;
    } catch {
      return null;
    }
  };
  const svg = pick(["svg"], MAX_SVG_BYTES);
  if (svg) {
    const b = inflate(svg.name);
    if (b && sniffFormat(b, svg.name) === "svg") {
      try {
        const s = svgLayer(b, svg.name);
        return { ...base, contents, layer: s.layer, editable: true, colors: s.colors, note: NOTES.zipSvg };
      } catch {
        /* fall through to the raster */
      }
    }
  }
  const raster = pick(["png", "jpg", "webp"], MAX_RASTER_BYTES);
  if (raster) {
    const b = inflate(raster.name);
    const kind = b ? sniffFormat(b, raster.name) : "unknown";
    if (b && (kind === "png" || kind === "jpg" || kind === "webp")) {
      const vectorOnly = contents.some((k) => k === "eps" || k === "ai" || k === "pdf");
      return { ...base, contents, layer: { bytes: b, mime: MIME[kind], ext: kind, entry: raster.name }, note: vectorOnly ? NOTES.epsRaster : NOTES.raster };
    }
  }
  const note = contents.includes("psd") && !contents.some((k) => k === "eps" || k === "ai") ? NOTES.psd : contents.some((k) => k === "eps" || k === "ai" || k === "pdf") ? NOTES.eps : NOTES.unknown;
  return { ...base, contents, note };
}

/** The short label of a stored format, for the UI ("SVG", "EPS/AI", "PNG"…). */
export function formatLabelOf(format: SourceFormat, contents: SourceFormat[] = []): string {
  if (format === "zip") {
    if (contents.includes("svg")) return "SVG";
    if (contents.includes("eps") || contents.includes("ai")) return "EPS/AI";
    if (contents.includes("psd")) return "PSD";
    return "ZIP";
  }
  if (format === "eps" || format === "ai") return "EPS/AI";
  return format.toUpperCase();
}
