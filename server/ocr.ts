/**
 * OCR: what is written on a picture, read by Google Cloud Vision (DOCUMENT_TEXT_DETECTION) when a
 * Google key or a Vertex service account is connected, else answered by a deterministic demo
 * provider that never touches the network. The checks themselves live in shared/ocr-check.ts.
 */
import type { Env } from "./env";
import type { ImageBytes } from "./openai";
import { StudioError, errorMessage } from "./errors";
import { resolveGoogleKey, resolveVertex } from "./settings";
import { vertexToken, type VertexCreds } from "./vertex";
import { all, first, run, now, uuid } from "./db";
import type { QA } from "@shared/types";
import { checkRawImage, ocrFlags, type Finding, type OcrBlock, type OcrResult } from "@shared/ocr-check";

export type { OcrBlock, OcrResult } from "@shared/ocr-check";

export interface OcrProvider {
  name: string;
  detect(image: ImageBytes): Promise<OcrResult>;
}

export const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** When the provider gives no confidence for a run (the textAnnotations fallback), it is taken as fairly sure. */
const DEFAULT_CONFIDENCE = 0.8;

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ───────────── Google Cloud Vision ───────────── */

interface Vertex {
  x?: number;
  y?: number;
}
interface Poly {
  vertices?: Vertex[];
  normalizedVertices?: Vertex[];
}
interface Symbol_ {
  text?: string;
  confidence?: number;
  property?: { detectedBreak?: { type?: string } };
}
interface Word {
  symbols?: Symbol_[];
  confidence?: number;
}
interface Paragraph {
  boundingBox?: Poly;
  words?: Word[];
  confidence?: number;
}
interface Block {
  paragraphs?: Paragraph[];
}
interface Page {
  width?: number;
  height?: number;
  blocks?: Block[];
  property?: { detectedLanguages?: { languageCode?: string; confidence?: number }[] };
}
interface AnnotateResponse {
  responses?: {
    error?: { message?: string };
    fullTextAnnotation?: { text?: string; pages?: Page[] };
    textAnnotations?: { description?: string; boundingPoly?: Poly; locale?: string }[];
  }[];
  error?: { message?: string };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The polygon as a normalised box; null when it has no usable corners. */
function boxOf(poly: Poly | undefined, width: number, height: number): [number, number, number, number] | null {
  const nv = poly?.normalizedVertices?.filter((v) => Number.isFinite(v.x) || Number.isFinite(v.y));
  const pv = poly?.vertices?.filter((v) => Number.isFinite(v.x) || Number.isFinite(v.y));
  const pts = nv?.length ? nv.map((v) => ({ x: v.x ?? 0, y: v.y ?? 0 })) : pv?.length && width > 0 && height > 0 ? pv.map((v) => ({ x: (v.x ?? 0) / width, y: (v.y ?? 0) / height })) : null;
  if (!pts) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return [clamp01(Math.min(...xs)), clamp01(Math.min(...ys)), clamp01(Math.max(...xs)), clamp01(Math.max(...ys))];
}

function paragraphText(p: Paragraph): string {
  let s = "";
  for (const w of p.words ?? []) {
    for (const sym of w.symbols ?? []) {
      s += sym.text ?? "";
      const br = sym.property?.detectedBreak?.type;
      if (br && br !== "UNKNOWN") s += " ";
    }
    if (!s.endsWith(" ")) s += " ";
  }
  return s.replace(/\s+/g, " ").trim();
}

function paragraphConfidence(p: Paragraph): number {
  if (typeof p.confidence === "number") return clamp01(p.confidence);
  const words = (p.words ?? []).map((w) => w.confidence).filter((c): c is number => typeof c === "number");
  if (words.length) return clamp01(Math.round((words.reduce((a, b) => a + b, 0) / words.length) * 1000) / 1000);
  return DEFAULT_CONFIDENCE;
}

/** Width and height from the file header (PNG, JPEG, WebP, GIF); null when unreadable. */
export function imageSize(bytes: ArrayBuffer): { width: number; height: number } | null {
  const b = new Uint8Array(bytes);
  const dv = new DataView(bytes);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** The provider's answer as blocks with normalised boxes: paragraphs of the full text, else the word annotations. */
export function mapVisionResponse(d: AnnotateResponse, image?: ImageBytes): OcrResult {
  const r = d.responses?.[0];
  if (!r) throw new StudioError("OCR returned no reading.", 502);
  if (r.error?.message) throw new StudioError(`OCR failed: ${r.error.message}`, 502);
  const blocks: OcrBlock[] = [];
  let language: string | undefined;
  const pages = r.fullTextAnnotation?.pages ?? [];
  for (const page of pages) {
    const lang = (page.property?.detectedLanguages ?? []).slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]?.languageCode;
    if (lang && !language) language = lang;
    const size = page.width && page.height ? { width: page.width, height: page.height } : image ? imageSize(image.bytes) : null;
    for (const block of page.blocks ?? []) {
      for (const p of block.paragraphs ?? []) {
        const text = paragraphText(p);
        if (!text) continue;
        const box = boxOf(p.boundingBox, size?.width ?? 0, size?.height ?? 0) ?? [0, 0, 0, 0];
        blocks.push({ text, confidence: paragraphConfidence(p), box });
      }
    }
  }
  if (!blocks.length && r.textAnnotations?.length) {
    // The first annotation is the whole text; the rest are the words with pixel corners.
    const size = image ? imageSize(image.bytes) : null;
    const words = r.textAnnotations.slice(1);
    language = language ?? r.textAnnotations[0]?.locale ?? undefined;
    for (const w of words) {
      const text = (w.description ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      blocks.push({ text, confidence: DEFAULT_CONFIDENCE, box: boxOf(w.boundingPoly, size?.width ?? 0, size?.height ?? 0) ?? [0, 0, 0, 0] });
    }
  }
  return { blocks, language, provider: "google-vision" };
}

export type VisionAuth = { key: string } | { vertex: VertexCreds };

/** Google Cloud Vision over REST: an API key when the studio has one, else the Vertex service account's token. */
export class GoogleVisionOcr implements OcrProvider {
  readonly name = "google-vision";
  constructor(
    private auth: VisionAuth,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    if ("key" in this.auth) return { "Content-Type": "application/json", "x-goog-api-key": this.auth.key };
    const token = await vertexToken(this.auth.vertex, this.fetchImpl, CLOUD_SCOPE);
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-goog-user-project": this.auth.vertex.projectId };
  }

  async detect(image: ImageBytes): Promise<OcrResult> {
    const r = await this.fetchImpl(VISION_URL, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        requests: [
          {
            image: { content: toBase64(image.bytes) },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["ar", "en"] },
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      let detail = "";
      try {
        detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
      } catch {
        detail = body.slice(0, 200);
      }
      if (r.status === 403 && /not been used|is disabled|SERVICE_DISABLED/i.test(detail)) throw new StudioError("The Cloud Vision API is not enabled on this Google project: enable it in the Google Cloud console, then try again.", 502);
      throw new StudioError(`OCR request failed (${r.status})${detail ? `: ${detail}` : "."}`, 502);
    }
    return mapVisionResponse((await r.json()) as AnnotateResponse, image);
  }
}

/* ───────────── The demo provider ───────────── */

/** A short deterministic hash of the bytes (FNV-1a, 32 bits, hex): the key of a demo fixture. */
export function shortHash(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Fixtures the demo provider answers from, by the short hash of the picture's bytes. Tests and demos add to it. */
export const DEMO_OCR_FIXTURES = new Map<string, OcrBlock[]>();

/** Reads nothing from the network: answers from the fixture map, or with no text at all. */
export class MockOcr implements OcrProvider {
  readonly name = "demo";
  constructor(private fixtures: Map<string, OcrBlock[]> = DEMO_OCR_FIXTURES) {}
  async detect(image: ImageBytes): Promise<OcrResult> {
    const blocks = this.fixtures.get(shortHash(image.bytes)) ?? [];
    return { blocks: blocks.map((b) => ({ ...b, box: [...b.box] as OcrBlock["box"] })), provider: "demo" };
  }
}

/* ───────────── Which provider ───────────── */

export interface ResolvedOcr {
  provider: OcrProvider;
  connected: boolean;
  /** Why this provider: how Google is reached, or why it is the demo. */
  reason: string;
}

export const NOT_CONNECTED = "Not connected: no Google key or Vertex credential";

/** Google Vision when a Google key or a Vertex service account is saved, else the demo provider. Never throws. */
export async function resolveOcr(env: Env, fetchImpl: typeof fetch = fetch): Promise<ResolvedOcr> {
  try {
    const key = (await resolveGoogleKey(env)).key;
    if (key) return { provider: new GoogleVisionOcr({ key }, fetchImpl), connected: true, reason: "Google Vision connected (API key)" };
    const vertex = await resolveVertex(env);
    if (vertex) return { provider: new GoogleVisionOcr({ vertex }, fetchImpl), connected: true, reason: "Google Vision connected (Vertex service account)" };
  } catch (e) {
    return { provider: new MockOcr(), connected: false, reason: `Not connected: ${errorMessage(e)}` };
  }
  return { provider: new MockOcr(), connected: false, reason: NOT_CONNECTED };
}

/* ───────────── Stored checks ───────────── */

export interface OcrCheckRow {
  id: string;
  batch: string;
  post: number;
  task: string | null;
  kind: "raw" | "artwork";
  provider: string;
  connected: number;
  expected: string | null;
  detected: string;
  findings: string;
  created: number;
}

export interface OcrCheck {
  id: string;
  batch: string;
  post: number;
  task: string | null;
  kind: "raw" | "artwork";
  provider: string;
  connected: boolean;
  expected: unknown;
  detected: OcrResult;
  findings: Finding[];
  created: number;
}

export function parseCheck(r: OcrCheckRow): OcrCheck {
  const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    ...r,
    connected: !!r.connected,
    expected: parse<unknown>(r.expected, null),
    detected: parse<OcrResult>(r.detected, { blocks: [], provider: r.provider }),
    findings: parse<Finding[]>(r.findings, []),
  };
}

export async function storeCheck(
  env: Env,
  c: { batch: string; post: number; task: string | null; kind: "raw" | "artwork"; provider: string; connected: boolean; expected: unknown; detected: OcrResult; findings: Finding[] },
): Promise<OcrCheck> {
  const row: OcrCheckRow = {
    id: uuid(),
    batch: c.batch,
    post: c.post,
    task: c.task,
    kind: c.kind,
    provider: c.provider,
    connected: c.connected ? 1 : 0,
    expected: c.expected === undefined || c.expected === null ? null : JSON.stringify(c.expected),
    detected: JSON.stringify(c.detected),
    findings: JSON.stringify(c.findings),
    created: now(),
  };
  await run(
    env.DB,
    "INSERT INTO ocr_checks (id, batch, post, task, kind, provider, connected, expected, detected, findings, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.id,
    row.batch,
    row.post,
    row.task,
    row.kind,
    row.provider,
    row.connected,
    row.expected,
    row.detected,
    row.findings,
    row.created,
  );
  return parseCheck(row);
}

export async function listChecks(env: Env, batch: string, post: number, limit = 50): Promise<OcrCheck[]> {
  const rows = await all<OcrCheckRow>(env.DB, "SELECT * FROM ocr_checks WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT ?", batch, post, limit);
  return rows.map(parseCheck);
}

/* ───────────── The engine's extra ───────────── */

/**
 * The raw check as a non-blocking extra of the engine's review: when Google Vision is connected,
 * the stored picture is read and writing that is not the product's packaging or the brand's name
 * becomes a "text" review flag (a faint reading becomes a "check the writing" flag). The flags are
 * notes for the team only: they are added after the retake decisions and never make the engine
 * spend. Nothing here throws, and nothing runs when OCR is not connected (no demo flags).
 */
export async function ocrReviewFlags(
  env: Env,
  batch: { id: string; client: string | null },
  task: { id: string; post: number | null },
  qa: QA,
  image: ImageBytes,
  allowed: string[],
): Promise<QA> {
  try {
    const o = await resolveOcr(env);
    if (!o.connected) return qa;
    const words = [...allowed];
    if (batch.client) {
      const client = await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", batch.client).catch(() => null);
      if (client?.name) words.push(client.name);
    }
    const detected = await o.provider.detect(image);
    const findings = checkRawImage(detected, words.filter(Boolean));
    await storeCheck(env, { batch: batch.id, post: task.post ?? 0, task: task.id, kind: "raw", provider: o.provider.name, connected: true, expected: { allowed: words }, detected, findings }).catch((e) => console.error("[ocr] store", errorMessage(e)));
    const flags = ocrFlags(findings);
    if (!flags.length) return qa;
    const next = [...(qa.flags ?? []), ...flags];
    const notes = qa.automated ? `${next.length} thing${next.length > 1 ? "s" : ""} to check before publishing.` : `${qa.notes} The OCR check read writing in the picture.`.trim();
    return { ...qa, flags: next, notes };
  } catch (e) {
    console.error("[ocr] review extra skipped", errorMessage(e));
    return qa;
  }
}
