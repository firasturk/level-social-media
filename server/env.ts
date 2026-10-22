export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  HIGGSFIELD_API_KEY?: string;
  HIGGSFIELD_MODEL: string;
  HIGGSFIELD_BASE_URL: string;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  FAL_KEY?: string;
  INVITE_CODE?: string;
  SESSION_SECRET?: string;
  WEBHOOK_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  /** The short public address (levelstudio.pages.dev); page visits on workers.dev go there. */
  CANONICAL_ORIGIN?: string;
  MAX_CONCURRENT_GENERATIONS?: string;
  /** "1" on a preview deployment: no picture or video is ever sent to an image engine. */
  PREVIEW_NO_IMAGES?: string;
  /** Langfuse tracing (server/trace.ts): off unless both keys are set here or in the settings table. */
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  /** The Langfuse host; https://cloud.langfuse.com when unset. */
  LANGFUSE_HOST?: string;
}

/** A preview deployment: the plan can be written and read, but no picture or video is made. */
export function previewNoImages(env: Env): boolean {
  return env.PREVIEW_NO_IMAGES === "1";
}
export const PREVIEW_MESSAGE = "This is the preview: image and video generation is blocked here. Planning and analysis run on demo fixtures until a text key is connected; with one, those calls are billed by the provider.";

export function concurrency(env: Env): number {
  // Workers hold at most six outgoing connections open at once; more would just queue inside the isolate.
  const n = Number(env.MAX_CONCURRENT_GENERATIONS ?? 6);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 6) : 6;
}
