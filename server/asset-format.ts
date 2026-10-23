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
import { MAX_SVG_BYTES, sanitizeSvg } from "@shared/svg-sanitize";

export { MAX_SVG_BYTES, sanitizeCss, sanitizeSvg, SvgRefused } from "@shared/svg-sanitize";

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
