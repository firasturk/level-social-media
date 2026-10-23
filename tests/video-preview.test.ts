/**
 * The shared rules of a video preview (shared/video-preview.ts): visible previews play by themselves,
 * a person's pause wins, reduced motion waits for a click, one sound at a time, a cap on how many play.
 */
import { describe, expect, it } from "vitest";
import { allowedToPlay, decidePlayback, nextAudible, type PlaybackState } from "@shared/video-preview";

const base: PlaybackState = { visible: true, active: true, tabHidden: false, userPaused: false, reducedMotion: false, autoplay: true, blocked: false, userStarted: false };

describe("a preview's playback", () => {
  it("plays when it is on screen, open and the tab is visible; pauses otherwise", () => {
    expect(decidePlayback(base)).toBe("play");
    expect(decidePlayback({ ...base, visible: false })).toBe("pause");
    expect(decidePlayback({ ...base, active: false })).toBe("pause");
    expect(decidePlayback({ ...base, tabHidden: true })).toBe("pause");
  });

  it("never resumes a video the person paused, nor one the browser refused", () => {
    expect(decidePlayback({ ...base, userPaused: true })).toBe("hold");
    expect(decidePlayback({ ...base, blocked: true })).toBe("hold");
    // Leaving the screen still pauses it (it does not keep decoding off screen).
    expect(decidePlayback({ ...base, userPaused: true, visible: false })).toBe("pause");
  });

  it("waits for a click under reduced motion, then plays like any other", () => {
    expect(decidePlayback({ ...base, reducedMotion: true })).toBe("hold");
    expect(decidePlayback({ ...base, reducedMotion: true, userStarted: true })).toBe("play");
  });

  it("leaves an editor's working preview to its timeline", () => {
    expect(decidePlayback({ ...base, autoplay: false })).toBe("hold");
    expect(decidePlayback({ ...base, autoplay: false, userStarted: true })).toBe("play");
  });
});

describe("a page of previews", () => {
  it("plays the person's choices first, then the most visible, up to the cap", () => {
    const ids = [...allowedToPlay([
      { id: "a", ratio: 0.4, priority: false },
      { id: "b", ratio: 1, priority: false },
      { id: "c", ratio: 0.5, priority: true },
      { id: "d", ratio: 0.9, priority: false },
    ], 3)].sort();
    expect(ids).toEqual(["b", "c", "d"]);
    expect(allowedToPlay([{ id: "a", ratio: 1, priority: false }], 0).size).toBe(0);
  });

  it("keeps one video audible: a new sound mutes the one before", () => {
    expect(nextAudible(null, "a", true)).toEqual({ audible: "a", mute: null });
    expect(nextAudible("a", "b", true)).toEqual({ audible: "b", mute: "a" });
    expect(nextAudible("b", "b", false)).toEqual({ audible: null, mute: null });
    expect(nextAudible("a", "b", false)).toEqual({ audible: "a", mute: null });
  });
});
