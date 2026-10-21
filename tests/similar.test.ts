import { describe, expect, it } from "vitest";
import { hashDistance } from "../server/thumbs";

describe("picture fingerprints", () => {
  it("counts the differing bits", () => {
    expect(hashDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hashDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hashDistance("0000000000000001", "0000000000000003")).toBe(1);
    expect(hashDistance("00", "0000")).toBe(64);
  });
});
