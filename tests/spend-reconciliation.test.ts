import { describe, expect, it } from "vitest";
import { approveSpend, holdUncertain, reserveSpend, spendStatus } from "../server/spend";
import { attemptBilling } from "../server/engine";
import { StudioError } from "../server/errors";
import { fakeEnv } from "./support/fakes";

describe("approvals and uncertain attempts", () => {
  it("adds an approval once per run, however often the same request is sent", async () => {
    const env = fakeEnv();
    await approveSpend(env, "m1", 2, "run-a");
    await approveSpend(env, "m1", 2, "run-a");
    await Promise.all([approveSpend(env, "m1", 2, "run-a"), approveSpend(env, "m1", 2, "run-a")]);
    expect((await spendStatus(env, "m1")).approved).toBe(2);
    await approveSpend(env, "m1", 1, "run-b");
    expect((await spendStatus(env, "m1")).approved).toBe(3);
    // Without a run id every call adds (the engine's own, never a client resend).
    await approveSpend(env, "m1", 1);
    expect((await spendStatus(env, "m1")).approved).toBe(4);
  });

  it("keeps an uncertain attempt reserved and counts it for reconciliation", async () => {
    const env = fakeEnv();
    await approveSpend(env, "m2", 1);
    await reserveSpend(env, "m2", 0.134);
    await holdUncertain(env, "m2", 0.134);
    expect(await spendStatus(env, "m2")).toEqual({ approved: 1, reserved: 0.134, remaining: 0.866, uncertain: 0.134 });
  });

  it("releases only when the vendor is known to have done no work", () => {
    expect(attemptBilling(new StudioError("fal.ai rejected the request: bad input (422)", 502))).toBe("none");
    expect(attemptBilling(new StudioError("Google rejected the API key: invalid (400)", 502, true))).toBe("none");
    expect(attemptBilling(new StudioError("Google rate limit or quota: slow down (429)", 429))).toBe("none");
    expect(attemptBilling(new StudioError("Google credits are used up (402)", 502, true))).toBe("none");
    expect(attemptBilling(new StudioError("Google is not connected.", 428, true))).toBe("none");
    expect(attemptBilling(new StudioError("The request was blocked by the content policy.", 502))).toBe("billable");
    expect(attemptBilling(new StudioError("fal.ai request failed (503): upstream unavailable", 502))).toBe("uncertain");
    const t = new Error("The operation was aborted due to timeout");
    t.name = "TimeoutError";
    expect(attemptBilling(t)).toBe("uncertain");
    expect(attemptBilling(new TypeError("fetch failed"))).toBe("uncertain");
    expect(attemptBilling(new Error("something odd"))).toBe("uncertain");
  });
});
