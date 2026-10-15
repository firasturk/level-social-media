/**
 * Google Cloud Vertex AI: the same Gemini models as AI Studio, billed to a Google Cloud project
 * (so the project's credits pay for them). Authentication is a service account: the Worker signs
 * a JWT with the account's private key and swaps it for a one-hour access token.
 */
import { StudioError } from "./errors";
import type { ImageBytes } from "./openai";
import type { GoogleJob } from "./google";

export interface VertexCreds {
  projectId: string;
  clientEmail: string;
  /** PEM, PKCS#8 ("-----BEGIN PRIVATE KEY-----"). */
  privateKey: string;
  /** "global" or a region such as "us-central1". */
  location: string;
}

/** How Google is reached: an AI Studio key, or a Vertex service account. */
export type GoogleAuth = { key: string } | { vertex: VertexCreds };

export function isVertexAuth(auth: GoogleAuth | string): auth is { vertex: VertexCreds } {
  return typeof auth === "object" && "vertex" in auth;
}

/** Reads a service-account JSON file (as downloaded from Google Cloud) into the fields we need. */
export function parseServiceAccount(json: string, location = "global"): VertexCreds {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new StudioError(
      "Paste the whole service-account JSON file, as downloaded from Google Cloud.",
    );
  }
  const projectId = String(d.project_id ?? "").trim();
  const clientEmail = String(d.client_email ?? "").trim();
  const privateKey = String(d.private_key ?? "").trim();
  if (d.type !== "service_account" || !projectId || !clientEmail || !privateKey)
    throw new StudioError(
      'This is not a service-account key file: it needs "type": "service_account", project_id, client_email and private_key.',
    );
  if (!/-----BEGIN PRIVATE KEY-----/.test(privateKey))
    throw new StudioError("The private_key in the file is not a PKCS#8 PEM key.");
  const loc = location.trim().toLowerCase() || "global";
  if (!/^[a-z0-9-]{2,40}$/.test(loc)) throw new StudioError("Invalid Vertex location.");
  return { projectId, clientEmail, privateKey, location: loc };
}

/**
 * The ids Vertex AI may publish a model under, in the order to try: the plain id (GA models keep
 * the AI Studio name), then the "-preview" id a model carries before it goes GA.
 */
export function vertexModelIds(slug: string): string[] {
  return slug.endsWith("-preview") ? [slug] : [slug, `${slug}-preview`];
}

/* ───────────── access token ───────────── */

const b64url = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const s =
    typeof bytes === "string"
      ? btoa(unescape(encodeURIComponent(bytes)))
      : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A signed JWT assertion for the OAuth token endpoint. */
export async function signAssertion(
  creds: VertexCreds,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(creds.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(sig)}`;
}

const tokens = new Map<string, { token: string; expires: number }>(); // per isolate

export async function vertexToken(
  creds: VertexCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cached = tokens.get(creds.clientEmail);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  let assertion: string;
  try {
    assertion = await signAssertion(creds);
  } catch (e) {
    throw new StudioError(
      `The service-account private key could not be used: ${e instanceof Error ? e.message : String(e)}`,
      400,
      true,
    );
  }
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok)
    throw new StudioError(
      `Google Cloud refused the service account (${r.status}): ${(await r.text()).slice(0, 200)}`,
      502,
      true,
    );
  const d = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new StudioError("Google Cloud returned no access token.", 502, true);
  tokens.set(creds.clientEmail, {
    token: d.access_token,
    expires: Date.now() + (d.expires_in ?? 3600) * 1000,
  });
  return d.access_token;
}

/* ───────────── generateContent ───────────── */

function host(creds: VertexCreds): string {
  return creds.location === "global"
    ? "https://aiplatform.googleapis.com"
    : `https://${creds.location}-aiplatform.googleapis.com`;
}

function modelUrl(creds: VertexCreds, model: string, method = "generateContent"): string {
  return `${host(creds)}/v1/projects/${encodeURIComponent(creds.projectId)}/locations/${creds.location}/publishers/google/models/${encodeURIComponent(model)}:${method}`;
}

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000)
    s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function readError(r: Response): Promise<string> {
  const text = await r.text().catch(() => "");
  try {
    const d = JSON.parse(text) as
      { error?: { message?: string } } | { error?: { message?: string } }[];
    const e = Array.isArray(d) ? d[0]?.error : d.error;
    return e?.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function vertexError(r: Response): Promise<StudioError> {
  const detail = await readError(r);
  if (r.status === 401 || r.status === 403)
    return new StudioError(
      `Google Cloud refused the request (${r.status}): ${detail}. Check that the Vertex AI API is enabled on the project and the service account has the Vertex AI User role.`,
      502,
      true,
    );
  if (r.status === 404)
    return new StudioError(`Google Cloud (Vertex) model not found (404): ${detail}`, 502, true);
  if (r.status === 429)
    return new StudioError(`Google Cloud (Vertex) rate limit or quota (429): ${detail}`, 429);
  if (/billing|credits|payment/i.test(detail))
    return new StudioError(`Google Cloud billing problem: ${detail}`, 502, true);
  return new StudioError(`Google Cloud (Vertex) request failed (${r.status}): ${detail}`, 502);
}

interface GenerateResponse {
  candidates?: {
    content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export async function vertexGenerate(
  creds: VertexCreds,
  model: string,
  parts: unknown[],
  generationConfig: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerateResponse> {
  const token = await vertexToken(creds, fetchImpl);
  const r = await fetchImpl(modelUrl(creds, model), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw await vertexError(r);
  return (await r.json()) as GenerateResponse;
}

/** Text models to try on Vertex, newest first; a 404 falls through to the next. */
export const VERTEX_TEXT_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro"];

/** One JSON-schema-constrained text answer (vision or text), as the AI Studio path returns it. */
export async function vertexText(
  creds: VertexCreds,
  instruction: string,
  images: ImageBytes[],
  schema: unknown,
  fetchImpl: typeof fetch = fetch,
  models: string[] = VERTEX_TEXT_MODELS,
): Promise<string> {
  const parts: unknown[] = [
    { text: instruction },
    ...images.map((img) => ({ inlineData: { mimeType: img.mime, data: toBase64(img.bytes) } })),
  ];
  let last: StudioError | null = null;
  // A model that is missing (404), overloaded (503), rate limited (429) or failing (5xx) hands over
  // to the next one; a second pass after a short wait covers a moment when all of them are busy.
  const passes = 2;
  for (let pass = 0; pass < passes; pass++) {
    if (pass) await new Promise((r) => setTimeout(r, 2500));
    for (const model of models) {
      try {
        const d = await vertexGenerate(
          creds,
          model,
          parts,
          { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 },
          120_000,
          fetchImpl,
        );
        const text = (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
        if (!text) throw new StudioError("Google Cloud (Vertex) returned no text.", 502);
        return text;
      } catch (e) {
        if (e instanceof StudioError && /\((404|408|429|500|502|503|504|529)\)/.test(e.message)) {
          last = e;
          continue;
        }
        throw e;
      }
    }
  }
  throw last ?? new StudioError("No Vertex text model available.", 502);
}

/** Image generation through Vertex: same jobs as the AI Studio client, synchronous. */
export class VertexImageClient {
  constructor(
    private creds: VertexCreds,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get project(): string {
    return this.creds.projectId;
  }

  /** Mints a token and runs the cheapest possible call, so a bad key, a disabled API or a missing role shows now. */
  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      await vertexText(
        this.creds,
        'Reply with {"ok": true}.',
        [],
        { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        this.fetchImpl,
      );
      return {
        ok: true,
        message: `Connected to Google Cloud project ${this.creds.projectId} (${this.creds.location}) through Vertex AI.`,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async hasModel(slug: string): Promise<boolean> {
    const token = await vertexToken(this.creds, this.fetchImpl);
    for (const id of vertexModelIds(slug)) {
      const r = await this.fetchImpl(
        `${host(this.creds)}/v1/publishers/google/models/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
      );
      // A model the account may not describe is still usable; only a clear 404 says it is missing.
      if (r.status !== 404) return true;
    }
    return false;
  }

  async edit(job: GoogleJob): Promise<ImageBytes> {
    const parts: unknown[] = [{ text: job.prompt }];
    for (const img of job.images)
      parts.push({ inlineData: { mimeType: img.mime, data: toBase64(img.bytes) } });
    const ids = vertexModelIds(job.model);
    let d: GenerateResponse | null = null;
    for (let i = 0; i < ids.length; i++) {
      try {
        d = await vertexGenerate(
          this.creds,
          ids[i],
          parts,
          {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: job.aspectRatio, imageSize: job.size.toUpperCase() },
          },
          5 * 60 * 1000,
          this.fetchImpl,
        );
        break;
      } catch (e) {
        // The next published id of the same model answers a 404; anything else is final.
        if (i < ids.length - 1 && e instanceof StudioError && /\(404\)/.test(e.message)) continue;
        throw e;
      }
    }
    if (!d) throw new StudioError("Google Cloud (Vertex) returned nothing.", 502);
    const blocked = d.promptFeedback?.blockReason;
    if (blocked)
      throw new StudioError(`Google Cloud (Vertex) blocked the request: ${blocked}`, 502);
    const img = (d.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    if (!img?.inlineData?.data) {
      const reason =
        d.candidates?.[0]?.finishReason ?? d.error?.message ?? "no image in the response";
      throw new StudioError(
        `Google Cloud (Vertex) returned no image (${reason}). Adjust the prompt or check model restrictions.`,
        502,
      );
    }
    return { bytes: fromBase64(img.inlineData.data), mime: img.inlineData.mimeType || "image/png" };
  }
}
