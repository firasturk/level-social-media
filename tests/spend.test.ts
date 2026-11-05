import { describe, expect, it } from "vitest";
import { approveSpend, releaseSpend, reserveSpend, spendFits, spendStatus } from "../server/spend";
import { fakeEnv } from "./support/fakes";

describe("the spending ledger", () => {
  it("records every reservation and refuses none: there is no cap (Firas, 5 Nov)", async () => {
    const env = fakeEnv();
    // A scope with no approval still takes the reservation: the ledger is a record, not a gate.
    expect((await reserveSpend(env, "m1", 0.1)).ok).toBe(true);
    await approveSpend(env, "m1", 0.3);
    expect((await reserveSpend(env, "m1", 0.134)).ok).toBe(true);
    expect((await reserveSpend(env, "m1", 0.134)).ok).toBe(true);
    const third = await reserveSpend(env, "m1", 0.134);
    expect(third.ok).toBe(true);
    expect(third.status).toEqual({ approved: 0.3, reserved: 0.502, remaining: 0, uncertain: 0 });
    expect((await spendFits(env, "m1", 0.03)).ok).toBe(true);
    expect((await spendFits(env, "m1", 100)).ok).toBe(true);
  });

  it("three concurrent reservations are all recorded", async () => {
    const env = fakeEnv();
    await approveSpend(env, "m2", 0.2);
    const results = await Promise.all([
      reserveSpend(env, "m2", 0.134),
      reserveSpend(env, "m2", 0.134),
      reserveSpend(env, "m2", 0.134),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await spendStatus(env, "m2")).reserved).toBe(0.402);
  });

  it("adds approvals atomically and releases a reservation that produced nothing", async () => {
    const env = fakeEnv();
    await Promise.all([
      approveSpend(env, "m3", 1),
      approveSpend(env, "m3", 2),
      approveSpend(env, "m3", 0.5),
    ]);
    expect((await spendStatus(env, "m3")).approved).toBe(3.5);
    await reserveSpend(env, "m3", 3);
    await releaseSpend(env, "m3", 3);
    expect(await spendStatus(env, "m3")).toEqual({ approved: 3.5, reserved: 0, remaining: 3.5, uncertain: 0 });
    await releaseSpend(env, "m3", 10);
    expect((await spendStatus(env, "m3")).reserved).toBe(0);
  });
});
