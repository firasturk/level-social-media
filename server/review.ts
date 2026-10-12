/**
 * Automated review of a generated image against its source: person bounding box (centering),
 * product differences, and, when an identity image is supplied, whether it is the same face.
 * Uses Google (Gemini Flash) when a key exists, otherwise OpenAI (GPT-4.1 vision).
 */
import type { QA } from "@shared/types";
import { StudioError } from "./errors";
import type { ImageBytes } from "./openai";
import { GOOGLE_TEXT_MODELS } from "./editorial";
import { isVertexAuth, vertexText, type GoogleAuth } from "./vertex";

const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    count: { type: "integer" },
    box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    productConcern: { type: "boolean" },
    sameFace: { type: "boolean" },
    notes: { type: "string" },
  },
  required: ["found", "count", "box", "productConcern", "sameFace", "notes"],
};

function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000)
    s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s);
}

export function manualQA(
  notes = "Automatic review not configured. Compare with the original manually.",
): QA {
  return { found: false, count: 0, box: [], productConcern: false, notes, automated: false };
}

function instruction(fabric: boolean, identity: boolean): string {
  const images = identity
    ? "Image 1: original garment. Image 2: identity reference (the model's face from card 1). Image 3: the result to assess."
    : "Image 1: original garment. Image 2: the result to assess.";
  return (
    `${images} Return JSON: found (boolean, a person is visible in the result), count (people), box [ymin,xmin,ymax,xmax] of the ENTIRE person including clothes normalised 0..1000 (use [0,0,0,0] when none), productConcern (true if colour, pattern, print, seams, length or garment construction differ from image 1), sameFace (${identity ? "true only if the result shows the same person's face as the identity reference" : "always true"}), notes (one short sentence). ` +
    (fabric
      ? "This card should be a fabric macro with NO person; set found=false and productConcern=true if a person or mannequin appears."
      : "Do not invent a box if no person is detectable.")
  );
}

function finish(q: Omit<QA, "automated">, fabric: boolean): QA {
  const badBox =
    !Array.isArray(q.box) ||
    q.box.length !== 4 ||
    q.box.some((x) => !Number.isFinite(x) || x < 0 || x > 1000) ||
    (q.found && (q.box[0] >= q.box[2] || q.box[1] >= q.box[3]));
  if (q.found && badBox) throw new StudioError("Review returned invalid bounds.", 502);
  const offset = q.found ? Math.abs((q.box[1] + q.box[3]) / 2 - 500) / 10 : 100;
  return {
    ...q,
    offset,
    centered: fabric || (q.found && q.count === 1 && offset <= 1),
    automated: true,
  };
}

export async function reviewWithGoogle(
  auth: GoogleAuth | string,
  source: ImageBytes,
  result: ImageBytes,
  fabric: boolean,
  identity?: ImageBytes,
  fetchImpl: typeof fetch = fetch,
): Promise<QA> {
  if (isVertexAuth(auth)) {
    const images = [source, ...(identity ? [identity] : []), result];
    const text = await vertexText(
      auth.vertex,
      instruction(fabric, !!identity),
      images,
      SCHEMA,
      fetchImpl,
    );
    return finish(JSON.parse(text) as Omit<QA, "automated">, fabric);
  }
  const key = typeof auth === "string" ? auth : auth.key;
  const input: unknown[] = [
    { type: "text", text: instruction(fabric, !!identity) },
    { type: "image", mime_type: source.mime, data: toBase64(source.bytes) },
  ];
  if (identity)
    input.push({ type: "image", mime_type: identity.mime, data: toBase64(identity.bytes) });
  input.push({ type: "image", mime_type: result.mime, data: toBase64(result.bytes) });
  let last: StudioError | null = null;
  for (const model of GOOGLE_TEXT_MODELS) {
    const r = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model,
        store: false,
        input,
        response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (r.status === 404) {
      last = new StudioError(`Review model ${model} unavailable.`, 502);
      continue;
    }
    if (!r.ok) throw new StudioError(`Review request failed (${r.status}).`, 502);
    const d = (await r.json()) as {
      status?: string;
      output_text?: string;
      steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };
    if (d.status === "failed") throw new StudioError("Review model could not complete.", 502);
    const text =
      d.output_text ??
      (d.steps ?? [])
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    return finish(JSON.parse(text) as Omit<QA, "automated">, fabric);
  }
  throw last ?? new StudioError("No review model available.", 502);
}

export async function reviewWithOpenAI(
  key: string,
  source: ImageBytes,
  result: ImageBytes,
  fabric: boolean,
  identity?: ImageBytes,
  fetchImpl: typeof fetch = fetch,
): Promise<QA> {
  const content: unknown[] = [
    { type: "text", text: instruction(fabric, !!identity) },
    {
      type: "image_url",
      image_url: { url: `data:${source.mime};base64,${toBase64(source.bytes)}`, detail: "low" },
    },
  ];
  if (identity)
    content.push({
      type: "image_url",
      image_url: { url: `data:${identity.mime};base64,${toBase64(identity.bytes)}`, detail: "low" },
    });
  content.push({
    type: "image_url",
    image_url: { url: `data:${result.mime};base64,${toBase64(result.bytes)}`, detail: "low" },
  });
  const r = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new StudioError(`Review request failed (${r.status}).`, 502);
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (d.choices?.[0]?.message?.content ?? "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "");
  return finish(JSON.parse(text) as Omit<QA, "automated">, fabric);
}
