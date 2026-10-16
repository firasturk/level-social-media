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
}

export function concurrency(env: Env): number {
  // Workers hold at most six outgoing connections open at once; more would just queue inside the isolate.
  const n = Number(env.MAX_CONCURRENT_GENERATIONS ?? 6);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 6) : 6;
}
