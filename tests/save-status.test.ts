import { describe, expect, it } from "vitest";
import { SAVE_IDLE, saveLabel, saveReducer, type SaveStatus } from "../shared/save-status";

describe("the autosave's status", () => {
  it("says saving while a save runs, saved when it lands, and how long ago after a while", () => {
    let s: SaveStatus = saveReducer(SAVE_IDLE, { type: "start", at: 1000 });
    expect(s).toEqual({ state: "saving", started: 1000, pending: 1 });
    expect(saveLabel(s, 1500)).toBe("Saving…");
    s = saveReducer(s, { type: "done", at: 2000 });
    expect(s).toEqual({ state: "saved", at: 2000 });
    expect(saveLabel(s, 3000)).toBe("Saved");
    expect(saveLabel(s, 2000 + 120_000)).toBe("Saved 2 min ago");
    expect(saveLabel(SAVE_IDLE, 0)).toBe("");
  });
  it("two fields left in a row stay 'saving' until the last save lands", () => {
    let s = saveReducer(SAVE_IDLE, { type: "start", at: 1 });
    s = saveReducer(s, { type: "start", at: 2 });
    expect(s).toEqual({ state: "saving", started: 1, pending: 2 });
    s = saveReducer(s, { type: "done", at: 3 });
    expect(s.state).toBe("saving");
    s = saveReducer(s, { type: "done", at: 4 });
    expect(s).toEqual({ state: "saved", at: 4 });
  });
  it("a failure keeps its message for the retry and is not cleared by another save landing", () => {
    let s = saveReducer(SAVE_IDLE, { type: "start", at: 1 });
    s = saveReducer(s, { type: "start", at: 2 });
    s = saveReducer(s, { type: "fail", at: 3, error: "Offline" });
    expect(s).toEqual({ state: "failed", at: 3, error: "Offline", pending: 1 });
    expect(saveLabel(s, 9)).toBe("Save failed");
    s = saveReducer(s, { type: "done", at: 4 });
    expect(s.state).toBe("failed");
    // The retry starts a new save and clears the failure once it lands.
    s = saveReducer(s, { type: "start", at: 5 });
    expect(s.state).toBe("saving");
    s = saveReducer(s, { type: "done", at: 6 });
    expect(s).toEqual({ state: "saved", at: 6 });
    expect(saveReducer(s, { type: "reset" })).toEqual(SAVE_IDLE);
  });
});
