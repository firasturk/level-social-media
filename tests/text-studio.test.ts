/**
 * The Text studio as a layer editor: stored designs still load, the new layer types validate and
 * draw, one look travels across the month without touching anyone's words, Arabic reads right to
 * left, and none of it ever asks for a picture to be generated.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  TEXT_DESIGN_SCHEMA,
  applyStyleToPosts,
  directionRuns,
  isImageLayer,
  isLogoLayer,
  isShapeLayer,
  isTextLayer,
  logoPlacementOf,
  newImageLayer,
  newLogoLayer,
  newShapeLayer,
  newTextLayer,
  replaceInLayers,
  styleOf,
  styleToApply,
  textLayersOf,
  upgradeDesign,
  wordsOf,
  type CanvasFx,
  type TextDesign,
  type TextLayer,
} from "../shared/layers";
import { resolveOverlay, type OverlaySpec, type PostOverlayPatch } from "../shared/overlay";

// The canvas never fetches a font in these tests: the font helpers are the browser's job.
vi.mock("../src/lib/fonts", () => ({
  ensureFont: async () => undefined,
  loadFont: async () => undefined,
  fontStack: (f: string) => `"${f}", sans-serif`,
  ARABIC: /[؀-ۿ]/,
}));

/*
 * The renderer and the editor's model are browser modules (DOM types, the "@/" alias), outside the
 * tests' TypeScript project: they are loaded at run time, with their shapes written out here.
 */
interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The drawing context as the tests see it: whatever the renderer sets or calls is recorded. */
type Ctx = Record<string, unknown>;
interface Renderer {
  drawDesign: (ctx: Ctx, W: number, H: number, design: TextDesign, opts?: { logoSrc?: string | null }) => Promise<Box[]>;
  drawBasePicture: (ctx: Ctx, img: unknown, W: number, H: number, fx?: CanvasFx) => void;
  renderDesignOnly: (design: TextDesign, W: number, H: number) => Promise<unknown>;
}
interface Model {
  designFromLegacy: (spec: OverlaySpec, headline: string, subline: string, patch: PostOverlayPatch | undefined, rect: null, W: number, H: number) => TextDesign;
}
const renderer = async () => (await import("../src/lib/textLayers".toString())) as Renderer;
const model = async () => (await import("../src/studio/text/model".toString())) as Model;

/* ───────────── A small canvas, enough to draw into and look at afterwards ───────────── */

interface Call {
  name: string;
  args: unknown[];
}

function fakeContext(calls: Call[]) {
  const state: Record<string, unknown> = { direction: "ltr", textAlign: "left", font: "" };
  return new Proxy(state, {
    get(target, prop: string) {
      if (prop === "measureText") return (t: string) => ({ width: [...t].length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => ({ addColorStop() {} });
      if (prop === "getImageData") return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) });
      if (prop === "canvas") return { width: 1080, height: 1350 };
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      calls.push({ name: `set:${prop}`, args: [value] });
      return true;
    },
    has() {
      return true;
    },
  }) as unknown as Ctx;
}

const calls: Call[] = [];

function fakeCanvas() {
  const c: Record<string, unknown> = { width: 0, height: 0 };
  c.getContext = () => fakeContext(calls);
  c.toDataURL = () => "data:image/png;base64,";
  c.toBlob = (cb: (b: null) => void) => cb(null);
  return c;
}

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  crossOrigin = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    // A logo file is 300×150 (twice as wide as tall); anything called "broken" fails to load.
    if (v.includes("broken")) queueMicrotask(() => this.onerror?.());
    else {
      this.naturalWidth = this.width = v.includes("logo") ? 300 : 800;
      this.naturalHeight = this.height = v.includes("logo") ? 150 : 600;
      queueMicrotask(() => this.onload?.());
    }
  }
}

const fetchSpy = vi.fn(async () => {
  throw new Error("The Text studio must never call the network while drawing or restyling.");
});

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => (tag === "canvas" ? fakeCanvas() : { style: {}, appendChild() {}, remove() {} }),
    fonts: { ready: Promise.resolve(), load: async () => [], add() {} },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  g.Image = FakeImage;
  g.fetch = fetchSpy;
});
afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.Image;
  delete g.fetch;
});

const design = (): TextDesign => ({
  version: 1,
  layers: [
    newShapeLayer("rect", { id: "band", x: 0, y: 0.8, w: 1, h: 0.2, fill: { type: "solid", color: "#1129d3" } }),
    newShapeLayer("ellipse", { id: "dot", x: 0.1, y: 0.1, w: 0.1, h: 0.08, stroke: { color: "#ffffff", width: 0.005 } }),
    newShapeLayer("line", { id: "rule", x: 0.1, y: 0.5, w: 0.8, h: 0.004 }),
    newImageLayer("/api/studio/file?batch=b&id=p1&kind=reference", { id: "pic", x: 0.6, y: 0.1, w: 0.3, h: 0.3, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: "contain", radius: 0.02 }),
    newLogoLayer({ id: "logo", x: 0.4, y: 0.04, w: 0.2, variant: "white" }),
    newTextLayer("Eid sweets", { id: "head", role: "headline", x: 0.1, y: 0.82, w: 0.8 }),
  ],
  canvas: { crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, offset: { x: 0.05, y: -0.02 }, gradient: { color: "#000000", angle: 180, from: 0, to: 0.5 } },
});

describe("stored designs keep loading", () => {
  it("brings a version-1 text-only design back exactly as it was", () => {
    const old: TextDesign = { version: 1, layers: [newTextLayer("مرحبا", { role: "headline" }), newTextLayer("second", { role: "subline" })], canvas: { gradient: { color: "#000000", angle: 180, from: 0, to: 0.6 } } };
    const up = upgradeDesign(JSON.parse(JSON.stringify(old)));
    expect(up).toEqual(old);
    expect(TEXT_DESIGN_SCHEMA.safeParse(up).success).toBe(true);
  });
  it("reads a layer stored before `type` existed as a text layer and drops rubbish", () => {
    const raw = { version: 1, layers: [{ id: "a", text: "hi", x: 0, y: 0, w: 1, font: "Inter", weight: 700, size: 0.1, lineHeight: 1, align: "left", fill: { type: "solid", color: "#fff" } }, 42, { id: "b", type: "video" }] };
    const up = upgradeDesign(raw)!;
    expect(up.layers).toHaveLength(1);
    expect(up.layers[0].type).toBe("text");
    expect(upgradeDesign(null)).toBeNull();
    expect(upgradeDesign({ version: 1 })).toBeNull();
  });
  it("tells the layer types apart and keeps the words from the text layers only", () => {
    const d = design();
    expect(d.layers.filter(isTextLayer)).toHaveLength(1);
    expect(d.layers.filter(isLogoLayer)).toHaveLength(1);
    expect(d.layers.filter(isImageLayer)).toHaveLength(1);
    expect(d.layers.filter(isShapeLayer)).toHaveLength(3);
    expect(textLayersOf(d).map((l) => l.id)).toEqual(["head"]);
    expect(wordsOf(d)).toEqual({ headline: "Eid sweets", subline: "" });
    const r = replaceInLayers(d.layers, "sweets", "treats");
    expect(r.count).toBe(1);
    expect(r.layers.filter(isShapeLayer)).toHaveLength(3);
  });
});

describe("the schema accepts the new layers and refuses nonsense", () => {
  it("accepts logo, image and shape layers and the picture crop and offset", () => {
    const parsed = TEXT_DESIGN_SCHEMA.safeParse(design());
    expect(parsed.success).toBe(true);
  });
  it("refuses an unknown layer type, a bad shape, a zero crop and a logo variant it does not know", () => {
    const d = design();
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...d, layers: [{ ...d.layers[0], type: "video" }] }).success).toBe(false);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...d, layers: [{ ...d.layers[0], shape: "star" }] }).success).toBe(false);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...d, layers: [{ ...d.layers[3], crop: { x: 0, y: 0, w: 0, h: 1 } }] }).success).toBe(false);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...d, layers: [{ ...d.layers[4], variant: "gold" }] }).success).toBe(false);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...d, canvas: { crop: { x: 0, y: 0, w: 0.01, h: 1 } } }).success).toBe(false);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...d, canvas: { offset: { x: 3, y: 0 } } }).success).toBe(false);
  });
});

describe("the renderer draws every layer type", () => {
  it("draws a logo, a picture, three shapes and the words without throwing, and places them", async () => {
    const { drawDesign } = await renderer();
    calls.length = 0;
    const ctx = fakeContext(calls);
    const boxes = await drawDesign(ctx, 1080, 1350, design(), { logoSrc: "/api/studio/clients/c/logo" });
    expect(boxes.map((b) => b.id)).toEqual(["band", "dot", "rule", "pic", "logo", "head"]);
    // The logo's height follows its file: twice as wide as tall.
    const logo = boxes.find((b) => b.id === "logo")!;
    expect(logo.w).toBeCloseTo(216);
    expect(logo.h).toBeCloseTo(108);
    const names = calls.map((c) => c.name);
    expect(names.filter((n) => n === "drawImage").length).toBeGreaterThanOrEqual(2);
    expect(names).toContain("ellipse");
    expect(names).toContain("stroke");
    expect(names).toContain("clip");
    expect(names).toContain("fillText");
    // The picture layer draws the cropped quarter of its 800×600 source: a nine-argument drawImage.
    const nine = calls.filter((c) => c.name === "drawImage" && c.args.length === 9);
    expect(nine.length).toBeGreaterThanOrEqual(1);
    expect(nine[0].args.slice(1, 5)).toEqual([200, 150, 400, 300]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("still draws when a picture cannot load and when there is no logo file", async () => {
    const { drawDesign } = await renderer();
    const d: TextDesign = { version: 1, layers: [newImageLayer("/broken.png", { id: "x" }), newLogoLayer({ id: "l" })] };
    const boxes = await drawDesign(fakeContext([]), 1080, 1350, d, { logoSrc: null });
    expect(boxes.map((b) => b.id)).toEqual(["x", "l"]);
  });
  it("crops and shifts the photograph under the layers, and leaves it whole when nothing is set", async () => {
    const { drawBasePicture } = await renderer();
    const plain: Call[] = [];
    const img = new FakeImage();
    img.src = "/photo.jpg";
    drawBasePicture(fakeContext(plain), img, 1080, 1350, undefined);
    expect(plain.filter((c) => c.name === "drawImage")[0].args).toEqual([img, 0, 0, 1080, 1350]);
    const cropped: Call[] = [];
    drawBasePicture(fakeContext(cropped), img, 1080, 1350, { crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, offset: { x: 0.1, y: 0 } });
    const d = cropped.filter((c) => c.name === "drawImage")[0].args as number[];
    expect(d.length).toBe(9);
    expect(d.slice(1, 5)).toEqual([200, 0, 400, 600]);
    // The 400×600 crop covers the canvas (×2.7 → 1080×1620, centred) and is shifted 10% to the right.
    expect(d[7]).toBeCloseTo(1080);
    expect(d[8]).toBeCloseTo(1620);
    expect(d[5]).toBeCloseTo(108);
    expect(d[6]).toBeCloseTo((1350 - 1620) / 2);
  });
});

describe("Arabic reads right to left", () => {
  it("renders an Arabic headline without exceptions, right to left", async () => {
    const { renderDesignOnly } = await renderer();
    calls.length = 0;
    const d: TextDesign = { version: 1, layers: [newTextLayer("حلويات العيد\nعرض خاص 2026", { id: "ar", direction: "auto", align: "center" })] };
    await expect(renderDesignOnly(d, 1080, 1350)).resolves.toBeTruthy();
    const dirs = calls.filter((c) => c.name === "set:direction").map((c) => c.args[0]);
    expect(dirs).toContain("rtl");
    const drawn = calls.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);
    expect(drawn).toContain("حلويات");
    expect(drawn).toContain("2026");
    // In a right-to-left line the first word sits furthest right.
    const first = calls.find((c) => c.name === "fillText" && c.args[0] === "حلويات")!;
    const second = calls.find((c) => c.name === "fillText" && c.args[0] === "العيد")!;
    expect(first.args[1] as number).toBeGreaterThan(second.args[1] as number);
  });
  it("keeps a Latin phrase in order inside an Arabic line, and an Arabic one inside a Latin line", () => {
    const t = (s: string) => s.split(/(\s+)/).filter(Boolean).map((text) => ({ text }));
    const rtl = directionRuns(t("عرض Eid Sale 2026 خاص"), "rtl");
    expect(rtl.map((r) => [r.dir, r.tokens.map((x) => x.text).join("")])).toEqual([
      ["rtl", "عرض "],
      ["ltr", "Eid Sale 2026 "],
      ["rtl", "خاص"],
    ]);
    const ltr = directionRuns(t("Try the حلويات العيد today"), "ltr");
    expect(ltr.map((r) => r.dir)).toEqual(["ltr", "rtl", "ltr"]);
    expect(ltr[1].tokens.map((x) => x.text).join("")).toBe("حلويات العيد ");
  });
});

describe("one look for the whole month", () => {
  it("applies a headline style to the other posts' headlines and leaves their words, place and second lines alone", async () => {

    const styled = newTextLayer("A", { role: "headline", font: "Cairo", weight: 900, size: 0.1, fill: { type: "solid", color: "#ff0000" }, shadow: { color: "#000000", blur: 0.2, x: 0, y: 0.1 }, x: 0.2, y: 0.2, w: 0.6 });
    const other: TextDesign = { version: 1, layers: [newTextLayer("كلمات أخرى", { id: "h2", role: "headline", font: "Inter", weight: 400, size: 0.05, x: 0.05, y: 0.7, w: 0.9 }), newTextLayer("sub", { id: "s2", role: "subline", font: "Inter" })] };
    const plan = [
      { index: 1, headline: "A", ov: { design: { version: 1 as const, layers: [styled] } } },
      { index: 2, headline: "كلمات أخرى", ov: { design: other } },
      { index: 3, headline: "Third", subline: "line" },
      { index: 4 },
    ];
    const made = (p: { index: number; headline?: string }) => (p.headline ? ({ version: 1, layers: [newTextLayer(p.headline, { id: `m${p.index}`, role: "headline", font: "Inter", weight: 400, size: 0.06 })] } as TextDesign) : null);
    const r = applyStyleToPosts(plan, 1, styleOf(styled), "headline", made);
    expect(r.changed).toBe(2);
    expect(r.plan[0]).toBe(plan[0]);
    const h2 = r.plan[1].ov!.design!.layers.find((l) => l.id === "h2") as TextLayer;
    expect(h2.text).toBe("كلمات أخرى");
    expect(h2.font).toBe("Cairo");
    expect(h2.weight).toBe(900);
    expect(h2.size).toBe(0.1);
    expect(h2.shadow).toEqual(styled.shadow);
    expect([h2.x, h2.y, h2.w]).toEqual([0.05, 0.7, 0.9]);
    const s2 = r.plan[1].ov!.design!.layers.find((l) => l.id === "s2") as TextLayer;
    expect(s2.font).toBe("Inter");
    const m3 = r.plan[2].ov!.design!.layers[0] as TextLayer;
    expect(m3.text).toBe("Third");
    expect(m3.font).toBe("Cairo");
    expect(r.plan[3]).toBe(plan[3]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("puts the logo in the same place on every post, adding a logo layer where there is none", async () => {

    const logo = newLogoLayer({ id: "L", x: 0.7, y: 0.05, w: 0.25, variant: "white", opacity: 0.9 });
    expect(styleToApply(logo)).toEqual({ style: logoPlacementOf(logo), role: "logo" });
    expect(styleToApply(newTextLayer("no role"))).toBeNull();
    const plan = [
      { index: 1, ov: { design: { version: 1 as const, layers: [logo] } } },
      { index: 2, ov: { design: { version: 1 as const, layers: [newLogoLayer({ id: "L2", x: 0.1, y: 0.1, w: 0.1 }), newTextLayer("words", { id: "w" })] } } },
      { index: 3, headline: "x" },
    ];
    const r = applyStyleToPosts(plan, 1, logoPlacementOf(logo), "logo", () => ({ version: 1, layers: [newTextLayer("x", { role: "headline" })] }));
    expect(r.changed).toBe(2);
    const l2 = r.plan[1].ov!.design!.layers.find((l) => l.id === "L2")!;
    expect(l2).toMatchObject({ type: "logo", x: 0.7, y: 0.05, w: 0.25, variant: "white", opacity: 0.9 });
    expect(r.plan[1].ov!.design!.layers.find((l) => l.id === "w")).toBeTruthy();
    const added = r.plan[2].ov!.design!.layers.filter(isLogoLayer);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ x: 0.7, y: 0.05, w: 0.25 });
  });
  it("makes a first design from a post's own words when it was never opened in the studio", async () => {
    const { designFromLegacy } = await model();
    const d = designFromLegacy(resolveOverlay({ template: "united" }), "حلويات العيد", "عرض خاص", undefined, null, 1080, 1350);
    expect(d.layers.map((l) => (l as TextLayer).role)).toEqual(["headline", "subline"]);
    expect(TEXT_DESIGN_SCHEMA.safeParse(d).success).toBe(true);
  });
});

describe("the studio never asks for a picture", () => {
  it("talks to no generation route: only fonts and graphics are ever uploaded, and the export is drawn in the browser", () => {
    const files = ["src/studio/text/TextStudio.tsx", "src/studio/text/Panels.tsx", "src/studio/text/Properties.tsx", "src/studio/text/model.ts", "src/lib/textLayers.ts"];
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/\/api\/studio\/posts\/(generate|refit|reidea|style|typography|text-check|continue)/);
      expect(src, f).not.toMatch(/regenerate|generatePosts|onFix\(/);
    }
    // Drawing a whole design and restyling a month made no network request at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
