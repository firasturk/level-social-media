/** A closed button says what it waits for, in a person's words. */
import { describe, expect, it } from "vitest";

// Browser code: loaded at run time, outside the worker's types.
const { busyReason, fixWaitReason } = (await import("../src/studio/busyReason".toString())) as {
  busyReason: (busy: string, running?: boolean) => string;
  fixWaitReason: (fixing: number | null, index: number, running?: boolean) => string;
};

describe("busyReason", () => {
  it("is empty when nothing holds the button", () => {
    expect(busyReason("")).toBe("");
    expect(busyReason("", false)).toBe("");
  });

  it("names what is running, from the Workspace's busy values", () => {
    expect(busyReason("ideas")).toBe("Wait: ideas are being written");
    expect(busyReason("grid")).toMatch(/^Wait: .*reference grid/);
    expect(busyReason("upload")).toMatch(/^Wait: .*uploaded/);
    expect(busyReason("generate")).toMatch(/^Wait: pictures/);
    for (const b of ["reidea", "resume", "client", "continue"]) expect(busyReason(b), b).toMatch(/^Wait: \w/);
  });

  it("says pictures are being made while the month runs", () => {
    expect(busyReason("", true)).toBe("Wait: pictures are being made");
    // What was asked last is the more exact reason.
    expect(busyReason("ideas", true)).toBe("Wait: ideas are being written");
  });

  it("never leaves an unknown value without words", () => {
    expect(busyReason("something-new")).toBe("Wait: something else is still running");
  });
});

describe("fixWaitReason", () => {
  it("is empty for a free card and for the card being fixed", () => {
    expect(fixWaitReason(null, 3)).toBe("");
    expect(fixWaitReason(3, 3)).toBe("");
    expect(fixWaitReason(3, 3, true)).toBe("");
  });

  it("tells the other cards that one picture is fixed at a time", () => {
    expect(fixWaitReason(3, 4)).toBe("Another picture is being fixed; this one can start when it finishes");
  });

  it("says pictures are being made when the month itself is running", () => {
    expect(fixWaitReason(null, 4, true)).toBe("Wait: pictures are being made");
  });
});
