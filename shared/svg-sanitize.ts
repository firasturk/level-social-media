/**
 * The SVG allow-list sanitiser: every element and attribute kept is written out again (never
 * copied as raw text), so a malformed or hostile file cannot slip markup through. Shared by the
 * Worker (every SVG stored: a Freepik vector, an uploaded graphic, a piece of a split vector) and
 * the browser (an SVG is sanitised again before it is measured in the page to be split).
 */

/** A vector's SVG is rarely over a few MB. */
export const MAX_SVG_BYTES = 8 * 1024 * 1024;

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

