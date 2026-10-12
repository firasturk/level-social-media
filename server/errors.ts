/** Error carrying an HTTP status and a message that is safe to show to the user. */
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
    public fatal = false,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

/** True for failures that make further paid requests pointless (bad key, no credits, rate limit). */
/** The vendor's prepaid balance is empty (Google 402 "prepayment credits are depleted" and the like). */
export function isCreditsDepleted(e: unknown): boolean {
  return /\(402\)|prepayment credits|credits are (depleted|used up|exhausted)|insufficient (balance|credits|funds)|payment required/i.test(
    errorMessage(e),
  );
}

/** What the user has to do when a vendor's balance is empty. */
export function creditsMessage(e: unknown): string {
  const detail = errorMessage(e);
  const vendor = /google|gemini/i.test(detail)
    ? "Google"
    : /openai/i.test(detail)
      ? "OpenAI"
      : "The engine";
  const where =
    vendor === "Google"
      ? "Top up the prepaid balance in Google AI Studio (aistudio.google.com, Billing)"
      : vendor === "OpenAI"
        ? "Add credit at platform.openai.com (Billing)"
        : "Top up the balance";
  return `${vendor}'s prepaid balance is empty, so nothing can be generated or written. ${where}, then resume the batch. Nothing was charged for the images that waited.`;
}

export function isFatalEngineError(e: unknown): boolean {
  return e instanceof StudioError && e.fatal;
}

/**
 * True for failures worth one automatic retry: the engine's own 5xx, a dropped connection or a
 * timeout. Not a bad request, a moderation refusal or anything fatal.
 */
export function isTransientEngineError(e: unknown): boolean {
  if (isFatalEngineError(e)) return false;
  if (e instanceof StudioError) return e.status === 429 || /\((5\d\d|429)\)/.test(e.message);
  if (e instanceof Error)
    return (
      /TimeoutError|AbortError/.test(e.name) ||
      /fetch failed|network|socket|ECONNRESET/i.test(e.message)
    );
  return false;
}

export function errorMessage(e: unknown, fallback = "Request failed."): string {
  if (e instanceof StudioError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** True when a vendor said "slow down" (HTTP 429); the work is retried after `retryAfterMs(e)`. */
export function isRateLimit(e: unknown): boolean {
  return (
    (e instanceof StudioError && e.status === 429) || /\(429\)|rate limit/i.test(errorMessage(e))
  );
}

/** How long a vendor asked us to wait, from "try again in 1.2s" / "in 850ms" / Retry-After seconds; default 12 s. */
export function retryAfterMs(e: unknown): number {
  const text = errorMessage(e);
  // OpenAI: "try again in 1.2s"; Google: "Please retry in 32.5s" or "retryDelay": "32s".
  const m =
    /(?:try again|retry) in\s*(\d+(?:\.\d+)?)\s*(ms|s)/i.exec(text) ??
    /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*(s)/i.exec(text);
  if (!m) return 12_000;
  const n = Number(m[1]) * (m[2] === "ms" ? 1 : 1000);
  return Math.min(60_000, Math.max(2_000, Math.ceil(n) + 1_000));
}

/** A rate limit that will not clear within minutes: a daily or free-tier quota is used up. */
export function isDailyQuota(e: unknown): boolean {
  return /per[_ ]?day|daily|free[_ ]tier|free quota|quota exceeded|RESOURCE_EXHAUSTED.*(day|free)|limit: 0\b/i.test(
    errorMessage(e),
  );
}
