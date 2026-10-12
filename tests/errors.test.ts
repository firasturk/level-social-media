import { isCreditsDepleted, creditsMessage, describe, expect, it } from "vitest";
import {
  StudioError,
  isRateLimit,
  isTransientEngineError,
  retryAfterMs,
  isCreditsDepleted,
  creditsMessage,
} from "../server/errors";

describe("rate limits", () => {
  const e = new StudioError(
    'Prompt builder (OpenAI) rate limited (429): {"error":{"message":"Rate limit reached ... Please try again in 1.2s."}}',
    429,
  );
  it("are transient, never fatal, and carry the vendor's wait", () => {
    expect(isRateLimit(e)).toBe(true);
    expect(isTransientEngineError(e)).toBe(true);
    expect(retryAfterMs(e)).toBe(2200);
    expect(retryAfterMs(new StudioError("try again in 850ms", 429))).toBe(2000);
    expect(retryAfterMs(new StudioError("Rate limit", 429))).toBe(12000);
  });
  it("a plain 5xx is transient too but not a rate limit", () => {
    const s = new StudioError("OpenAI request failed (502): bad gateway", 502);
    expect(isTransientEngineError(s)).toBe(true);
    expect(isRateLimit(s)).toBe(false);
  });
});

describe("vendor wait times", () => {
  it("reads Google and OpenAI retry hints and spots used-up daily quotas", async () => {
    const { retryAfterMs, isDailyQuota } = await import("../server/errors");
    expect(retryAfterMs(new Error("Rate limit reached. Please try again in 1.2s."))).toBe(2200);
    expect(retryAfterMs(new Error("Google rate limit or quota: Please retry in 32.5s."))).toBe(
      33500,
    );
    expect(retryAfterMs(new Error('{"retryDelay":"20s"}'))).toBe(21000);
    expect(retryAfterMs(new Error("Too many requests"))).toBe(12000);
    expect(
      isDailyQuota(
        new Error("Quota exceeded for metric: generate_content_free_tier_requests, limit: 0"),
      ),
    ).toBe(true);
    expect(isDailyQuota(new Error("Rate limit reached on tokens per min"))).toBe(false);
  });
});

describe("empty prepaid balance", () => {
  it("is recognised and explained", () => {
    const e = new Error(
      'Prompt builder (Google) failed (402): [{"error": {"code": 402, "message": "Your prepayment credits are depleted. Please go to AI Studio"}}]',
    );
    expect(isCreditsDepleted(e)).toBe(true);
    expect(creditsMessage(e)).toContain("Google's prepaid balance is empty");
    expect(creditsMessage(e)).toContain("aistudio.google.com");
    expect(isCreditsDepleted(new Error("Prompt builder (Google) failed (429): rate limit"))).toBe(
      false,
    );
  });
});
