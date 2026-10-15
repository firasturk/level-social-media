/**
 * Minimal client for the Higgsfield Cloud API (https://api.higgsfield.ai).
 * Contract taken from the official SDKs (@higgsfield/client v2, higgsfield-client for Python):
 *   - Authorization: Key KEY_ID:KEY_SECRET
 *   - POST /{model-slug}  -> { request_id, status_url, cancel_url, status }
 *   - GET  /requests/{request_id}/status -> { status, images?: [{url}], video?: {url} }
 *   - POST /files/generate-upload-url { content_type } -> { upload_url, public_url, upload_headers? }
 *   - optional webhook: ?hf_webhook=<url> on the submit call
 */
import { StudioError } from "./errors";

export interface EngineConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface GenerationJob {
  prompt: string;
  /** Public URLs of reference images, in order: garment, identity/first card, latest result. */
  imageUrls: string[];
  aspectRatio: string;
  /** "1K" | "2K" | "4K" from the batch config; sent lowercase as the API expects. */
  size: string;
  webhookUrl?: string;
}

export type EngineStatus =
  | { state: "pending"; raw: string }
  | { state: "done"; url: string }
  | { state: "failed"; message: string; retryable: boolean };

export type Fetch = typeof fetch;

function credentialsValid(key: string): boolean {
  return /^[^:\s]+:[^:\s]+$/.test(key);
}

async function readError(r: Response): Promise<string> {
  const text = await r.text().catch(() => "");
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    const detail = d.detail ?? d.details ?? d.message ?? d.error;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") return JSON.stringify(detail).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

/** Map an HTTP failure from the engine to a user-facing error. */
export async function engineError(r: Response): Promise<StudioError> {
  const detail = await readError(r);
  const code = detail.trim().toLowerCase();
  if (code === "not_enough_credits")
    return new StudioError(
      "Higgsfield Cloud account has no credits. Top up at cloud.higgsfield.ai and resume.",
      502,
      true,
    );
  if (code === "model_disabled")
    return new StudioError(
      "This model is disabled on your Higgsfield Cloud account. Pick another model in Connection.",
      502,
      true,
    );
  if (code === "model_not_found")
    return new StudioError(
      "This model slug does not exist on Higgsfield. Pick another model in Connection.",
      502,
      true,
    );
  if (r.status === 401 || r.status === 403)
    return new StudioError(
      `Higgsfield rejected the API key (${r.status}). ${detail}`.trim(),
      502,
      true,
    );
  if (r.status === 402)
    return new StudioError(
      `Higgsfield account has insufficient credits. ${detail}`.trim(),
      502,
      true,
    );
  if (r.status === 429)
    return new StudioError("Higgsfield rate limit reached. Pause and retry later.", 429, true);
  if (r.status === 404)
    return new StudioError(
      `Higgsfield endpoint not found (${r.status}). ${detail}`.trim(),
      502,
      true,
    );
  if (r.status === 400 || r.status === 422)
    return new StudioError(`Higgsfield rejected the request (${r.status}): ${detail}`, 502);
  return new StudioError(`Higgsfield request failed (${r.status}). ${detail}`.trim(), 502);
}

export class HiggsfieldClient {
  private fetchImpl: Fetch;

  constructor(
    private cfg: EngineConfig,
    fetchImpl: Fetch = fetch,
  ) {
    // Store an unbound-safe reference: calling a stored global fetch with a class `this` throws in Workers.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    if (!credentialsValid(cfg.apiKey)) {
      throw new StudioError(
        "HIGGSFIELD_API_KEY must be in the form KEY_ID:KEY_SECRET (from cloud.higgsfield.ai).",
        503,
        true,
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "level-social-media/0.1",
    };
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  }

  /** Request body for the image model. Field names follow the Higgsfield model docs (prompt, image_urls, aspect_ratio, resolution). */
  buildInput(job: GenerationJob): Record<string, unknown> {
    const input: Record<string, unknown> = {
      prompt: job.prompt,
      aspect_ratio: job.aspectRatio,
      resolution: job.size.toLowerCase(),
    };
    if (job.imageUrls.length) input.image_urls = job.imageUrls;
    return input;
  }

  /** Submit a generation. Returns the engine request id; the result is collected later with `status()`. */
  async submit(job: GenerationJob): Promise<string> {
    const target = new URL(this.url(this.cfg.model));
    if (job.webhookUrl) target.searchParams.set("hf_webhook", job.webhookUrl);
    const r = await this.fetchImpl(target.toString(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildInput(job)),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 400 && job.size.toLowerCase() !== "2k") {
      const detail = await r.clone().text();
      if (/resolution/i.test(detail)) return this.submit({ ...job, size: "2K" });
    }
    if (!r.ok) throw await engineError(r);
    const d = (await r.json()) as { request_id?: string };
    if (!d.request_id) throw new StudioError("Higgsfield did not return a request id.", 502);
    return d.request_id;
  }

  async status(requestId: string): Promise<EngineStatus> {
    const r = await this.fetchImpl(this.url(`requests/${encodeURIComponent(requestId)}/status`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 404)
      return { state: "failed", message: "Engine request no longer exists.", retryable: true };
    if (!r.ok) throw await engineError(r);
    const d = (await r.json()) as {
      status?: string;
      images?: { url?: string }[];
      video?: { url?: string };
      error?: unknown;
      detail?: unknown;
    };
    const status = String(d.status ?? "").toLowerCase();
    if (status === "completed") {
      const url = d.images?.find((i) => i?.url)?.url;
      if (!url)
        return {
          state: "failed",
          message: "Generation completed without an image.",
          retryable: true,
        };
      return { state: "done", url };
    }
    if (status === "queued" || status === "in_progress" || status === "pending" || status === "")
      return { state: "pending", raw: status || "unknown" };
    if (status === "nsfw")
      return {
        state: "failed",
        message: "Rejected by content moderation. Adjust the prompt or source image.",
        retryable: false,
      };
    if (status === "canceled" || status === "cancelled")
      return { state: "failed", message: "Generation was cancelled.", retryable: true };
    const detail =
      typeof d.error === "string" ? d.error : typeof d.detail === "string" ? d.detail : "";
    return {
      state: "failed",
      message: `Generation failed on the engine. ${detail}`.trim(),
      retryable: true,
    };
  }

  /** Upload bytes to Higgsfield's storage and return a public URL usable as an image reference. */
  async upload(bytes: ArrayBuffer, contentType: string): Promise<string> {
    const link = await this.fetchImpl(this.url("files/generate-upload-url"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content_type: contentType }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!link.ok) throw await engineError(link);
    const d = (await link.json()) as {
      upload_url?: string;
      public_url?: string;
      upload_headers?: Record<string, string>;
    };
    if (!d.upload_url || !d.public_url)
      throw new StudioError("Higgsfield did not return an upload URL.", 502);
    const put = await this.fetchImpl(d.upload_url, {
      method: "PUT",
      headers: d.upload_headers ?? { "Content-Type": contentType },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) throw new StudioError(`Reference upload failed (${put.status}).`, 502);
    return d.public_url;
  }

  /** Diagnostic: POST an empty body to a model slug and report how the API answers (no generation is started). */
  async probeModel(slug: string, body = "{}"): Promise<{ status: number; detail: string }> {
    const r = await this.fetchImpl(this.url(slug), {
      method: "POST",
      headers: this.headers(),
      body,
      signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, detail: await readError(r) };
  }

  /** The account's model catalogue as the API returns it (shape not fixed; callers inspect it). */
  async catalog(): Promise<unknown> {
    const r = await this.fetchImpl(this.url("models"), {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw await engineError(r);
    return r.json();
  }

  /** Cheap credential check: an authenticated GET on a random request id returns 404, an unauthenticated one 401/403. */
  async verify(): Promise<{ ok: boolean; message: string }> {
    const r = await this.fetchImpl(this.url(`requests/${crypto.randomUUID()}/status`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: "API key rejected." };
    if (r.status === 404 || r.ok) return { ok: true, message: "Connected to Higgsfield." };
    return { ok: false, message: `Unexpected response ${r.status}.` };
  }
}

/** Download a generated image from the engine's CDN. */
export async function downloadImage(
  url: string,
  fetchImpl: Fetch = fetch,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const r = await fetchImpl.call(globalThis, url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new StudioError(`Could not download the generated image (${r.status}).`, 502);
  const mime = r.headers.get("content-type")?.split(";")[0] || "image/png";
  return { bytes: await r.arrayBuffer(), mime };
}
