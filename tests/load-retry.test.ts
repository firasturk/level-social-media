/**
 * A load that failed is not remembered for the rest of the session: a picture, a font file or a
 * font stylesheet that could not be fetched is asked for again by a later render, and a file that
 * never answers holds nothing for ever. What did load stays loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Browser code: loaded at run time, outside the worker's types.
const { ensureFont, faceLoaded, loadFont } = (await import("../src/lib/fonts".toString())) as {
  ensureFont: (family: string, weight: number, italic: boolean, sample: string) => Promise<void>;
  faceLoaded: (font: string, sample?: string, ms?: number) => Promise<void>;
  loadFont: (name: string, url: string) => Promise<void>;
};
const { loadLayerImage } = (await import("../src/lib/textLayers".toString())) as { loadLayerImage: (src: string) => Promise<unknown> };

/** What the fake browser does with the next file asked for. */
let outcome: "ok" | "fail" | "never" = "ok";
const asked: string[] = [];
const added: unknown[] = [];
const links: { href: string; remove: () => void }[] = [];

class FakeImage {
  onload?: () => void;
  onerror?: () => void;
  crossOrigin = "";
  width = 10;
  height = 10;
  set src(v: string) {
    asked.push(v);
    const how = outcome;
    queueMicrotask(() => (how === "ok" ? this.onload?.() : how === "fail" ? this.onerror?.() : undefined));
  }
}

class FakeFontFace {
  constructor(
    public family: string,
    public source: string,
  ) {
    asked.push(source);
  }
  load(): Promise<this> {
    const how = outcome;
    return how === "ok" ? Promise.resolve(this) : how === "fail" ? Promise.reject(new Error("no file")) : new Promise(() => undefined);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  asked.length = 0;
  added.length = 0;
  links.length = 0;
  outcome = "ok";
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("FontFace", FakeFontFace);
  vi.stubGlobal("document", {
    fonts: {
      ready: Promise.resolve(),
      add: (f: unknown) => added.push(f),
      load: () => (outcome === "ok" ? Promise.resolve([]) : outcome === "fail" ? Promise.reject(new Error("bad font")) : new Promise(() => undefined)),
    },
    createElement: () => {
      const link = { href: "", rel: "", onload: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), remove: vi.fn() };
      links.push(link);
      return link;
    },
    head: {
      appendChild: (link: { onload?: () => void; onerror?: () => void }) => {
        const how = outcome;
        queueMicrotask(() => (how === "ok" ? link.onload?.() : how === "fail" ? link.onerror?.() : undefined));
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a layer's picture", () => {
  it("is asked for again after a failed load, and kept once it has loaded", async () => {
    outcome = "fail";
    expect(await loadLayerImage("/logo-a.png")).toBeNull();
    // Not on every redraw: for a moment the failure is remembered.
    expect(await loadLayerImage("/logo-a.png")).toBeNull();
    expect(asked).toEqual(["/logo-a.png"]);

    await vi.advanceTimersByTimeAsync(2000);
    outcome = "ok";
    const picture = await loadLayerImage("/logo-a.png");
    expect(picture).toBeInstanceOf(FakeImage);
    expect(asked).toEqual(["/logo-a.png", "/logo-a.png"]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(await loadLayerImage("/logo-a.png")).toBe(picture);
    expect(asked).toHaveLength(2);
  });

  it("does not hold the render for ever when the file never answers", async () => {
    outcome = "never";
    let done: unknown = "waiting";
    void loadLayerImage("/logo-b.png").then((p) => (done = p));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBeNull();
    // And that failure is forgotten too.
    await vi.advanceTimersByTimeAsync(2000);
    outcome = "ok";
    expect(await loadLayerImage("/logo-b.png")).toBeInstanceOf(FakeImage);
  });
});

describe("a brand font file", () => {
  it("is asked for again after a failed load", async () => {
    outcome = "fail";
    await expect(loadFont("Brand A", "/fonts/a")).resolves.toBeUndefined();
    expect(added).toHaveLength(0);
    outcome = "ok";
    await loadFont("Brand A", "/fonts/a");
    expect(asked).toEqual(["url(/fonts/a)", "url(/fonts/a)"]);
    expect(added).toHaveLength(1);
  });

  it("is loaded once when it loads", async () => {
    await loadFont("Brand B", "/fonts/b");
    await loadFont("Brand B", "/fonts/b");
    expect(asked).toEqual(["url(/fonts/b)"]);
    expect(added).toHaveLength(1);
  });

  it("is waited for a few seconds only", async () => {
    outcome = "never";
    let done = false;
    void loadFont("Brand C", "/fonts/c").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });
});

describe("a hosted face", () => {
  it("never waits for ever, and never throws, when the browser cannot load it", async () => {
    outcome = "fail";
    await expect(faceLoaded("700 48px Tajawal", "حب")).resolves.toBeUndefined();
    outcome = "never";
    let done = false;
    void faceLoaded("700 48px Tajawal", "حب").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(6000);
    expect(done).toBe(true);
  });

  it("asks for its stylesheet again after the stylesheet failed", async () => {
    outcome = "fail";
    await ensureFont("Mirza", 500, false, "حب");
    expect(links).toHaveLength(1);
    expect(links[0].remove).toHaveBeenCalled();
    // Not on every redraw while the connection is down.
    await ensureFont("Mirza", 500, false, "حب");
    expect(links).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    outcome = "ok";
    await ensureFont("Mirza", 500, false, "حب");
    expect(links).toHaveLength(2);
    // Loaded: not asked for again.
    await vi.advanceTimersByTimeAsync(60_000);
    await ensureFont("Mirza", 500, false, "حب");
    expect(links).toHaveLength(2);
  });
});
