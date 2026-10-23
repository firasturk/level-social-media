/**
 * The colours of an editable vector (an SVG a Freepik download carried), read and rewritten as
 * text: the server lists them once when the file is stored (the swatches), and the browser
 * rewrites them for one image layer when it draws it (the layer's colour map). Both sides use the
 * one scanner below, so a colour the swatches show is exactly a colour the recolour can change.
 *
 * Only paint properties are touched: fill, stroke, stop-color, flood-color, lighting-color and
 * color, as attributes (fill="#fff") or declarations (style="fill:#fff", a <style> rule).
 * Gradients keep working: their stops are colours like any other. `none`, `currentColor` and
 * `url(#…)` references are left alone.
 */

/** The named colours an exported SVG actually uses (Illustrator, Figma and Inkscape write hex). */
const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  navy: "#000080",
  teal: "#008080",
  maroon: "#800000",
  olive: "#808000",
  aqua: "#00ffff",
  cyan: "#00ffff",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  gold: "#ffd700",
};

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** A paint value as #rrggbb (lower case), or null when it is not a plain colour. */
export function normalizeColor(value: string): string | null {
  const v = value.trim().replace(/\s*!important$/i, "").toLowerCase();
  if (!v) return null;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`;
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f]{6})[0-9a-f]{2}$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*[,\s]\s*([\d.]+)(%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(v);
  if (m) {
    const ch = (n: string, pct: string) => (pct ? (Number(n) * 255) / 100 : Number(n));
    return `#${hex2(ch(m[1], m[2]))}${hex2(ch(m[3], m[4]))}${hex2(ch(m[5], m[6]))}`;
  }
  return NAMED[v] ?? null;
}

/**
 * Every paint value in the text: an attribute `fill="…"` (either quote) or a declaration
 * `fill: …` up to `;`, `}`, a quote or the end of a style attribute. Group 1 is the property,
 * group 2 the text up to the value, group 3 the value.
 */
const PAINT_RE = /\b(fill|stroke|stop-color|flood-color|lighting-color|color)(\s*=\s*["']|\s*:\s*)([^"';}<>]*)/gi;

/** The distinct colours the vector paints with, most used first (at most `max`). */
export function extractSvgColors(svg: string, max = 24): string[] {
  const counts = new Map<string, number>();
  for (const m of svg.matchAll(PAINT_RE)) {
    // A CSS property name inside a longer word (e.g. "background-color") is not a paint.
    const before = svg[(m.index ?? 0) - 1];
    if (before === "-") continue;
    const c = normalizeColor(m[3]);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([c]) => c);
}

/** A colour map that is safe to apply: #rrggbb keys and values only, at most 32 entries, no identities. */
export function cleanColorMap(map: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!map) return out;
  for (const [k, v] of Object.entries(map).slice(0, 32)) {
    const from = normalizeColor(k);
    const to = normalizeColor(v);
    if (from && to && from !== to) out[from] = to;
  }
  return out;
}

/**
 * The vector with its colours rewritten: every paint value whose colour is a key of `map` takes
 * the mapped colour; everything else stays byte for byte. An empty map returns the text as it is.
 */
export function recolorSvg(svg: string, map: Record<string, string> | undefined | null): string {
  const clean = cleanColorMap(map);
  if (!Object.keys(clean).length) return svg;
  return svg.replace(PAINT_RE, (whole, prop: string, sep: string, value: string, offset: number) => {
    if (svg[offset - 1] === "-") return whole;
    const c = normalizeColor(value);
    if (!c || !clean[c]) return whole;
    const important = /!important\s*$/i.test(value) ? " !important" : "";
    const lead = /^\s*/.exec(value)?.[0] ?? "";
    const trail = important ? "" : (/\s*$/.exec(value)?.[0] ?? "");
    return `${prop}${sep}${lead}${clean[c]}${important}${trail}`;
  });
}
