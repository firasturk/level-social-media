/**
 * A reader for Adobe/Resolve `.cube` colour lookup tables (the 3D kind, `LUT_3D_SIZE n`): n³ RGB
 * triples, red fastest, in 0…1 by default or in the DOMAIN_MIN/MAX range when given. The result is
 * a flat Float32Array (r, g, b per entry) the editor uploads as a 3D texture. Pure, so it is
 * tested without a browser. 1D LUTs are refused: the editor applies 3D tables only.
 */
export interface CubeLut {
  title: string;
  size: number;
  /** size³ × 3 floats, 0…1, red varying fastest. */
  data: Float32Array;
}

export const MAX_LUT_SIZE = 128;

export function parseCube(text: string): { ok: true; lut: CubeLut } | { ok: false; reason: string } {
  let size = 0;
  let title = "";
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const up = line.toUpperCase();
    if (up.startsWith("TITLE")) {
      title = line.slice(5).trim().replace(/^"|"$/g, "");
      continue;
    }
    if (up.startsWith("LUT_1D_SIZE")) return { ok: false, reason: "This is a 1D LUT; the editor applies 3D (.cube with LUT_3D_SIZE) tables." };
    if (up.startsWith("LUT_3D_SIZE")) {
      size = Number(line.split(/\s+/)[1]);
      if (!Number.isInteger(size) || size < 2 || size > MAX_LUT_SIZE) return { ok: false, reason: `LUT_3D_SIZE must be a whole number from 2 to ${MAX_LUT_SIZE}.` };
      continue;
    }
    if (up.startsWith("DOMAIN_MIN")) {
      min = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (up.startsWith("DOMAIN_MAX")) {
      max = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (up.startsWith("LUT_3D_INPUT_RANGE") || up.startsWith("LUT_1D_INPUT_RANGE")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) return { ok: false, reason: `A line is not three numbers: "${line.slice(0, 40)}".` };
    const [r, g, b] = parts.slice(0, 3).map(Number);
    if (![r, g, b].every(Number.isFinite)) return { ok: false, reason: `A line is not three numbers: "${line.slice(0, 40)}".` };
    values.push(r, g, b);
  }
  if (!size) return { ok: false, reason: "No LUT_3D_SIZE line: this is not a 3D .cube file." };
  const want = size * size * size * 3;
  if (values.length !== want) return { ok: false, reason: `Expected ${want / 3} entries for a ${size}³ table, found ${values.length / 3}.` };
  const data = new Float32Array(want);
  for (let i = 0; i < want; i++) {
    const ch = i % 3;
    const span = max[ch] - min[ch] || 1;
    data[i] = Math.min(1, Math.max(0, (values[i] - min[ch]) / span));
  }
  return { ok: true, lut: { title, size, data } };
}

/** The table applied to one colour (nearest-lower corner with trilinear interpolation), for tests and previews. */
export function sampleCube(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const at = (ri: number, gi: number, bi: number, ch: number) => lut.data[((bi * n + gi) * n + ri) * 3 + ch];
  const pos = (v: number) => {
    const x = Math.min(1, Math.max(0, v)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    return [i, x - i] as const;
  };
  const [ri, rf] = pos(r);
  const [gi, gf] = pos(g);
  const [bi, bf] = pos(b);
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const c00 = at(ri, gi, bi, ch) * (1 - rf) + at(ri + 1, gi, bi, ch) * rf;
    const c10 = at(ri, gi + 1, bi, ch) * (1 - rf) + at(ri + 1, gi + 1, bi, ch) * rf;
    const c01 = at(ri, gi, bi + 1, ch) * (1 - rf) + at(ri + 1, gi, bi + 1, ch) * rf;
    const c11 = at(ri, gi + 1, bi + 1, ch) * (1 - rf) + at(ri + 1, gi + 1, bi + 1, ch) * rf;
    const c0 = c00 * (1 - gf) + c10 * gf;
    const c1 = c01 * (1 - gf) + c11 * gf;
    out[ch] = c0 * (1 - bf) + c1 * bf;
  }
  return out;
}

/* ───────────── The table kept with the draft ───────────── */

/**
 * A saved project keeps its LUT's table (phase 3; phase 1 kept only the name): 8-bit RGB, red
 * fastest, base64 in the project document. The grader uploads the table as 8-bit RGB anyway, so
 * nothing is lost at that precision. Tables larger than 33³ are resampled to 33³ before they are
 * stored (33³ × 3 bytes = 108 KB, about 144 KB as base64), well inside the 512 KB a saved project
 * may weigh; 33 points per axis is what most grading tools export.
 */
export const MAX_STORED_LUT_SIZE = 33;

/** Bytes of a stored table of this size. */
export const storedLutBytes = (size: number): number => size * size * size * 3;

/** Characters of the base64 a stored table of this size takes. */
export const storedLutChars = (size: number): number => Math.ceil(storedLutBytes(size) / 3) * 4;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The table at `size` points per axis (trilinear), for a table too large to store. */
export function resampleCube(lut: CubeLut, size: number): CubeLut {
  if (size === lut.size) return lut;
  const data = new Float32Array(storedLutBytes(size));
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [R, G, B] = sampleCube(lut, r / (size - 1), g / (size - 1), b / (size - 1));
        data[i++] = R;
        data[i++] = G;
        data[i++] = B;
      }
  return { title: lut.title, size, data };
}

/** The table as it is stored with the draft: at most 33³, 8-bit, base64. */
export function serialiseCube(lut: CubeLut): { size: number; data: string } {
  const t = lut.size > MAX_STORED_LUT_SIZE ? resampleCube(lut, MAX_STORED_LUT_SIZE) : lut;
  const bytes = new Uint8Array(storedLutBytes(t.size));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, t.data[i])) * 255);
  return { size: t.size, data: toBase64(bytes) };
}

/** A stored table read back; null when the data does not have the size it claims (or is not base64). */
export function parseStoredCube(stored: { size: number; data: string; name?: string }): CubeLut | null {
  const { size, data } = stored;
  if (!Number.isInteger(size) || size < 2 || size > MAX_STORED_LUT_SIZE) return null;
  if (typeof data !== "string" || data.length !== storedLutChars(size) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = fromBase64(data);
  if (!bytes || bytes.length !== storedLutBytes(size)) return null;
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
  return { title: stored.name ?? "", size, data: out };
}
