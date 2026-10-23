/**
 * The shared rules of a video preview (shared/video-preview.ts): visible previews play by themselves,
 * a person's pause wins, reduced motion waits for a click, one sound at a time, a cap on how many play.
 */
import { describe, expect, it } from "vitest";
import { allowedToPlay, decidePlayback, nextAudible, onScreenShare, PREVIEW_RENDITION, renditionSize, VISIBLE_RATIO, worthKeeping, type PlaybackState } from "@shared/video-preview";

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

  it("does not start a preview that may not start by itself until the person does", () => {
    expect(decidePlayback({ ...base, autoplay: false })).toBe("hold");
    expect(decidePlayback({ ...base, autoplay: false, userStarted: true })).toBe("play");
  });

  it("leaves an editor's working preview to its timeline: only a background tab pauses it", () => {
    const driven = { ...base, autoplay: false, driven: true };
    expect(decidePlayback(driven)).toBe("hold");
    // A play the timeline made is not a reason to keep starting it, nor is leaving the screen a reason to stop it.
    expect(decidePlayback({ ...driven, userStarted: true })).toBe("hold");
    expect(decidePlayback({ ...driven, visible: false })).toBe("hold");
    expect(decidePlayback({ ...driven, active: false })).toBe("hold");
    expect(decidePlayback({ ...driven, tabHidden: true })).toBe("pause");
  });

  it("keeps a player that reached its end on its last frame until the person plays it again", () => {
    expect(decidePlayback({ ...base, finished: true })).toBe("hold");
    expect(decidePlayback({ ...base, finished: true, userStarted: true })).toBe("hold");
    expect(decidePlayback({ ...base, finished: true, visible: false })).toBe("pause");
  });
});

describe("what counts as on screen", () => {
  it("is the visible share, or enough when a large player covers half the screen", () => {
    expect(onScreenShare(0, 0)).toBe(0);
    expect(onScreenShare(0.2, 0.1)).toBe(0.2);
    expect(onScreenShare(0.8, 0.4)).toBe(0.8);
    // A player taller than the screen: only a quarter of it shows, but it fills the screen.
    expect(onScreenShare(0.25, 1)).toBe(VISIBLE_RATIO);
    expect(onScreenShare(0.25, 0.3)).toBe(0.25);
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

describe("the lightweight preview rendition", () => {
  it("brings the short side down to 360 px, keeps the frame, and keeps both sides even", () => {
    expect(renditionSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(renditionSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(renditionSize(1080, 1350)).toEqual({ width: 360, height: 450 });
    // Odd sizes become even (H.264 needs it); a clip already small is never scaled up.
    expect(renditionSize(721, 1281)).toEqual({ width: 360, height: 640 });
    expect(renditionSize(200, 355)).toEqual({ width: 200, height: 356 });
    expect(renditionSize(1080, 1920, 540)).toEqual({ width: 540, height: 960 });
  });

  it("is short, small and silent by design, and kept only when clearly lighter than the clip", () => {
    expect(PREVIEW_RENDITION).toMatchObject({ seconds: 8, shortSide: 360 });
    expect(worthKeeping(500_000, 6_000_000)).toBe(true);
    expect(worthKeeping(900_000, 1_000_000)).toBe(false);
    expect(worthKeeping(0, 1_000_000)).toBe(false);
  });
});
