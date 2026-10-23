#!/usr/bin/env node
/**
 * The editors' dark look (Photo studio, Video studio and editor, Text studio), generated from their
 * own style sheets so it follows every later change: each rule that sets a colour gets a twin under
 * `:root:has(.ts)` (an editor is open) with the colour turned for a dark surface: white surfaces go
 * dark, dark text goes light, pale tints become deep ones, lines turn white-on-dark, the accent and
 * the warning colours stay. Run after changing an editor's CSS:
 *
 *   node scripts/editor-dark.mjs        (writes src/editor-dark.css)
 *
 * The page behind an open editor is covered by it, so the scope only reaches the editors.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SCOPE = ":root:has(.ts)";
/** Whole files that belong to the editors. */
const FILES = ["src/studio/text/text-studio.css", "src/studio/photo/photo-studio.css", "src/video-editor/ui/video-studio.css", "src/video-editor/ui/timeline.css", "src/video-editor/ui/music-library.css", "src/video-editor/ui/reference.css", "src/video-editor/ui/video-looks.css"];
/** From the app's sheet, only the editors' rules. */
const SHARED = "src/styles.css";
const EDITOR_SELECTOR = /(^|[\s,>+~(])\.(ts|ps|vs|ve)(\b|-)|\.ve-|\.ts-|\.ps-|\.vs-|\.tl-/;

/* ───────────── A small CSS reader: comments out, blocks nested ───────────── */

function parse(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const node = () => {
    const out = [];
    while (i < css.length) {
      const close = css.indexOf("}", i);
      const open = css.indexOf("{", i);
      const semi = css.indexOf(";", i);
      if (close !== -1 && (open === -1 || close < open) && (semi === -1 || close < semi || open === -1 || close < open)) {
        i = close + 1;
        return out;
      }
      if (open === -1) break;
      if (semi !== -1 && semi < open && css.slice(i, semi).trim().startsWith("@")) {
        i = semi + 1; // @import / @charset
        continue;
      }
      const head = css.slice(i, open).trim();
      i = open + 1;
      if (head.startsWith("@")) {
        out.push({ at: head, children: node() });
      } else {
        const end = findClose(css, i);
        out.push({ sel: head, body: css.slice(i, end) });
        i = end + 1;
      }
    }
    return out;
  };
  return node();
}
function findClose(s, from) {
  let depth = 0;
  for (let j = from; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return s.length;
}

/* ───────────── Colours ───────────── */

const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], "#fff": [255, 255, 255, 1], "#000": [0, 0, 0, 1] };
const COLOR_RE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b/g;

function readColor(t) {
  if (NAMED[t]) return [...NAMED[t]];
  if (t[0] === "#") {
    let h = t.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (k) => parseInt(h.slice(k, k + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const parts = t.replace(/rgba?\(|\)/g, "").split(/[\s,/]+/).filter(Boolean);
  const nums = parts.map((x, k) => (x.endsWith("%") ? (parseFloat(x) / 100) * (k === 3 ? 1 : 255) : parseFloat(x)));
  if (nums.length < 3 || nums.some((x) => Number.isNaN(x))) return null;
  let a = nums[3] ?? 1;
  if (a > 1) a = a / 100;
  return [nums[0], nums[1], nums[2], a];
}
function hsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h, s, l, a) {
  const k = (n) => (n + h / 30) % 12;
  const f = (n) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return write([Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255), a]);
}
const grey = (v, a) => write([Math.round(v * 255), Math.round(v * 255), Math.round(v * 255 + 6), a]);
function write([r, g, b, a]) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return a >= 1 ? `#${[r, g, b].map((x) => c(x).toString(16).padStart(2, "0")).join("")}` : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${+a.toFixed(3)})`;
}

/** One colour turned for a dark surface; `role` says what it paints. */
function turn(t, role) {
  const c = readColor(t);
  if (!c) return t;
  const [r, g, b, a] = c;
  if (a === 0) return t;
  const [h, s, l] = hsl(c);
  const neutral = s < 0.18 || (r === g && g === b);
  if (role === "text") {
    if (neutral) return l < 0.5 ? grey(Math.min(0.94, 1 - l * 0.95), a) : t;
    return l < 0.5 ? fromHsl(h, Math.min(1, s), 0.7, a) : t;
  }
  if (role === "line") {
    if (neutral) {
      if (l < 0.2) return write([255, 255, 255, Math.min(0.28, a * 1.3)]); // black lines at low alpha
      if (l > 0.6) return a < 1 ? write([255, 255, 255, Math.min(0.2, a)]) : grey(Math.max(0.16, 1.08 - l), 1);
      return grey(0.32, a);
    }
    return l > 0.82 ? fromHsl(h, s * 0.6, 0.28, a) : t;
  }
  // backgrounds
  if (neutral) {
    if (a < 1) {
      // translucent: white glass turns dark glass; black tints turn white tints
      if (l > 0.5) return write([24, 24, 30, a]);
      // a strong black scrim sits over a picture (a price chip, a caption band): it stays
      return a >= 0.3 ? t : write([255, 255, 255, Math.min(0.16, a * 1.4)]);
    }
    if (l > 0.9) return grey(0.105 + (1 - l) * 1.5, 1); // #fff → panel, the darker greys lighter
    if (l > 0.55) return grey(Math.max(0.2, 1.05 - l), 1);
    if (l < 0.25) return grey(Math.max(l, 0.2), 1); // dark fills stay dark but visible
    return t;
  }
  if (l > 0.84) return fromHsl(h, Math.min(0.6, s * 0.55), 0.2, a); // pale tints → deep tints
  return t;
}

function roleOf(prop) {
  if (/^(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color)$/.test(prop)) return "text";
  if (/border|outline|box-shadow|column-rule/.test(prop)) return "line";
  if (/^background(-color|-image)?$/.test(prop)) return "bg";
  if (/^--ts-line$/.test(prop)) return "line";
  return null;
}

/** The declarations of a rule turned for the dark editor; "" when nothing paints a colour. */
function darkBody(body) {
  const out = [];
  for (const raw of body.split(";")) {
    const i = raw.indexOf(":");
    if (i < 0) continue;
    const prop = raw.slice(0, i).trim();
    const value = raw.slice(i + 1).trim();
    if (!prop || !value || /url\(/.test(value)) continue;
    const role = roleOf(prop);
    if (!role) continue;
    // Every colour declaration is repeated (turned or as it is), so a modifier written after its
    // base rule (.ts-btn.primary after .ts-btn) still wins inside the scope, as it does outside.
    if (!COLOR_RE.test(value) && !/var\(|transparent|currentcolor|inherit|none|initial/i.test(value)) {
      COLOR_RE.lastIndex = 0;
      continue;
    }
    COLOR_RE.lastIndex = 0;
    // box-shadow: soft drop shadows stay dark (deeper); rings and insets act as lines
    let r = role;
    if (prop === "box-shadow" && !/inset/.test(value) && !/(^|,)\s*0(px)?\s+0(px)?\s+0(px)?\s/.test(value)) r = "shadow";
    const next = r === "shadow" ? value.replace(/rgba?\(\s*0[\s,]+0[\s,]+0[\s,/]+([\d.]+)\s*\)/g, (_m, al) => `rgba(0, 0, 0, ${Math.min(0.7, parseFloat(al) * 2.2).toFixed(2)})`) : value.replace(COLOR_RE, (t) => (/var\(/.test(t) ? t : turn(t, r)));
    out.push(`${prop}: ${next}`);
  }
  return out.join("; ");
}

function scoped(sel) {
  return sel
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith(":root") ? s.replace(/^:root(\[[^\]]*\])?/, SCOPE) : `${SCOPE} ${s}`))
    .join(",\n");
}

function emit(nodes, keep) {
  let css = "";
  for (const n of nodes) {
    if (n.at) {
      if (/^@(keyframes|font-face|-webkit-keyframes)/.test(n.at)) continue;
      const inner = emit(n.children, keep);
      if (inner.trim()) css += `${n.at} {\n${inner}}\n`;
    } else {
      if (!keep(n.sel) || /^(from|to|\d+%)/.test(n.sel)) continue;
      if (/data-theme/.test(n.sel)) continue;
      const body = darkBody(n.body);
      if (body) css += `${scoped(n.sel)} { ${body}; }\n`;
    }
  }
  return css;
}

const header = `/* GENERATED by scripts/editor-dark.mjs from the editors' own style sheets: do not edit by hand.
   The editors (Photo, Video, Text) in a dark look while one is open. */
${SCOPE} .ts {
  color-scheme: dark;
  background: #0b0b0e;
  color: #ececf0;
  --ts-line: rgba(255, 255, 255, 0.1);
  --ts-panel: rgba(22, 22, 27, 0.9);
  --ts-accent: #5b6ff5;
  --surface: #16161b;
  --surface-2: #1d1d23;
  --surface-3: #26262d;
  --line: #2a2a31;
  --line-strong: #3a3a42;
  --ink-900: #fffdfd;
  --ink-700: #ececf0;
  --ink-500: #a1a1a6;
  --ink-400: #8e8e93;
  --ink-300: #636366;
  --accent: #5b6ff5;
  --accent-hover: #7b8cff;
  --accent-soft: #131a46;
  --blue-soft: #131a46;
}
${SCOPE} .ts input,
${SCOPE} .ts select,
${SCOPE} .ts textarea {
  color-scheme: dark;
}
${SCOPE} .ts input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  accent-color: #5b6ff5;
}
${SCOPE} .ts input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f2f2f7;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}
${SCOPE} .ts input[type="range"]::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 50%;
  background: #f2f2f7;
}
${SCOPE} .ts input[type="range"]::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
}
`;

let css = header;
for (const f of FILES) css += `\n/* ── ${f} ── */\n` + emit(parse(readFileSync(f, "utf8")), () => true);
css += `\n/* ── ${SHARED} (editor rules) ── */\n` + emit(parse(readFileSync(SHARED, "utf8")), (sel) => EDITOR_SELECTOR.test(sel));
writeFileSync("src/editor-dark.css", css);
console.log(`[editor-dark] ${css.split("\n").length} lines -> src/editor-dark.css`);
