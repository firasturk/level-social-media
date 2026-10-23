/**
 * "Split into layers", "Remove background" and "Merge back" for vector layers: the pure half
 * (shared/svg-split.ts). The fixtures are real multi-element SVGs (tests/fixtures/svg): a badge
 * with a background rect, a gradient ring, clipped stripes, stars through <use> and lettering with
 * a filter; an Illustrator icon set in one wrapper group; a flat illustration with nested,
 * transformed groups. Bounding boxes come from the browser in the app; here they are given.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../shared/svg-sanitize";
import {
  buildPieceSvg,
  coverage,
  defsClosure,
  detectBackground,
  findPieces,
  frameOf,
  hasLettering,
  meaningfulId,
  mergePieces,
  mergeToBudget,
  parseSvg,
  pieceFacts,
  pieceKind,
  placePiece,
  prepareSplit,
  serializeSvg,
  userToCanvas,
  viewBoxTransform,
  visibleUserBox,
  walk,
  withoutElements,
  type Box,
  type LayerPlace,
  type SvgEl,
  type SvgFrame,
} from "../shared/svg-split";
import { extractSvgColors } from "../shared/svg-colors";
import { TEXT_DESIGN_SCHEMA } from "../shared/layers";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "svg", name), "utf8");
const BADGE = sanitizeSvg(fixture("badge.svg"));
const ICONS = sanitizeSvg(fixture("icon-set.svg"));
const SCENE = sanitizeSvg(fixture("illustration.svg"));
const ids = (els: SvgEl[]) => els.map((e) => e.attrs.id ?? e.attrs.class ?? e.name);

describe("parsing the sanitised SVG", () => {
  it("reads the tree back exactly (parse → write → parse is stable) and keeps entities as text", () => {
    const root = parseSvg(BADGE);
    expect(root.name).toBe("svg");
    const again = serializeSvg(parseSvg(serializeSvg(root)));
    expect(again).toBe(serializeSvg(root));
    const t = parseSvg(
      '<svg viewBox="0 0 1 1"><text>Fish &amp; chips &lt;3</text><title>a &quot;b&quot;</title></svg>',
    );
    expect((t.children[0] as SvgEl).children[0]).toBe("Fish & chips <3");
    expect(serializeSvg(t)).toContain("Fish &amp; chips &lt;3");
  });
  it("refuses what is not an SVG, and an SVG with no size cannot be placed", () => {
    expect(() => parseSvg("<html><body/></html>")).toThrow(/not an SVG/);
    expect(() => prepareSplit("<svg><rect width='1' height='1'/></svg>")).toThrow(/no size/);
  });
});

describe("the splitting rules", () => {
  it("takes the root's painted children as pieces, skipping definitions, styles and titles", () => {
    const { chain, items } = findPieces(parseSvg(BADGE));
    expect(chain).toEqual([]);
    expect(ids(items)).toEqual(["background", "ring", "inner-disc", "stripes", "stars", "label"]);
  });
  it("descends through single-child wrapper groups (Illustrator's Layer_1 and a named group)", () => {
    const { chain, items } = findPieces(parseSvg(ICONS));
    expect(ids(chain)).toEqual(["icons"]);
    expect(ids(items)).toEqual([
      "icon-heart",
      "icon-bell",
      "icon-bag",
      "icon-star",
      "icon-tag",
      "icon-bolt",
    ]);
    const scene = findPieces(parseSvg(SCENE));
    expect(ids(scene.chain)).toEqual(["scene"]);
    expect(ids(scene.items)).toEqual(["sky-rect", "sun", "cloud", "hills", "tree"]);
  });
  it("never descends into a group with a filter or a mask (its effect is on the whole), and skips hidden elements", () => {
    const fx = findPieces(
      parseSvg(
        '<svg viewBox="0 0 10 10"><g filter="url(#f)"><rect width="5" height="5"/><rect x="5" width="5" height="5"/></g></svg>',
      ),
    );
    expect(fx.items.map((e) => e.name)).toEqual(["g"]);
    const hid = findPieces(
      parseSvg(
        '<svg viewBox="0 0 10 10"><rect width="5" height="5" display="none"/><rect x="5" width="5" height="5"/><circle r="2" style="visibility:hidden"/></svg>',
      ),
    );
    expect(hid.items).toHaveLength(1);
  });
  it("names the pieces honestly: lettering is shapes of letters, editor ids are not names", () => {
    const { items } = findPieces(parseSvg(BADGE));
    expect(pieceKind([items[5]])).toBe("Lettering");
    expect(hasLettering([items[5]])).toBe(true);
    expect(pieceKind([items[4]])).toBe("Group");
    expect(pieceKind([items[0]])).toBe("Shape");
    expect(pieceKind([items[0], items[1]])).toBe("Shapes");
    expect(meaningfulId("icon-heart")).toBe("Icon heart");
    expect(meaningfulId("badge_ring")).toBe("Badge ring");
    expect(meaningfulId("cloud")).toBe("Cloud");
    for (const junk of [
      "path12",
      "g3",
      "Layer_1",
      "_x31_",
      "Group 4",
      "1.5",
      "st0",
      "cls-2",
      "fil1",
    ])
      expect(meaningfulId(junk)).toBeNull();
  });
});

describe("what a piece depends on (definitions closure)", () => {
  const doc = prepareSplit(BADGE);
  const piece = (id: string) => doc.items.filter((e) => (e.attrs.id ?? e.attrs.class) === id);
  const defIds = (id: string) => defsClosure(doc, piece(id)).defs.map((d) => d.attrs.id);
  it("keeps the gradient of a fill, through a gradient's own href", () => {
    expect(defIds("ring")).toEqual(["ring-grad"]);
    expect(defIds("inner-disc")).toEqual(["ring-grad", "ring-grad-2"]);
  });
  it("keeps the clip path, the symbol behind <use>, the filter, and only the CSS rules that apply", () => {
    expect(defIds("stripes")).toEqual(["stripe-clip"]);
    expect(defIds("stars")).toEqual(["star"]);
    expect(defIds("label")).toEqual(["shadow"]);
    const ring = defsClosure(doc, piece("ring")).rules.map((r) => r.selector);
    expect(ring).toEqual([".ring"]);
    const label = defsClosure(doc, piece("label")).rules.map((r) => r.selector);
    expect(label).toEqual([".label"]);
    expect(defsClosure(doc, piece("background"))).toEqual({ defs: [], rules: [] });
  });
  it("follows CSS url() references and keeps the wrappers' paint and classes (the illustration's clouds)", () => {
    const scene = prepareSplit(SCENE);
    const cloud = scene.items.find((e) => e.attrs.class === "cloud")!;
    expect(defsClosure(scene, [cloud]).rules.map((r) => r.selector)).toEqual([".cloud path"]);
    const css = prepareSplit(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g1"><stop offset="0" stop-color="#123456"/></linearGradient></defs><style>.a{fill:url(#g1)}.b{fill:red}</style><rect class="a" width="5" height="5"/><rect class="b" x="5" width="5" height="5"/></svg>',
    );
    expect(defsClosure(css, [css.items[0]]).defs.map((d) => d.attrs.id)).toEqual(["g1"]);
    expect(defsClosure(css, [css.items[1]]).defs).toEqual([]);
  });
  it("builds a piece that keeps every definition, the CSS, the wrapper transform and inherited fill, at its own view box", () => {
    const scene = prepareSplit(SCENE);
    const tree = scene.items.find((e) => e.attrs.id === "tree")!;
    const svg = buildPieceSvg(scene, [tree], { x: 150, y: 260, w: 90, h: 160 });
    const p = parseSvg(svg);
    expect(p.attrs.viewBox).toBe("150 260 90 160");
    expect(p.attrs.width).toBe("90");
    expect(p.attrs.preserveAspectRatio).toBe("none");
    const wrapper = walk(p).find((e) => e.attrs.id === "scene")!;
    expect(wrapper.attrs.transform).toBe("translate(20 10) scale(0.95)");
    expect(wrapper.attrs.fill).toBe("#334455");
    expect(walk(p).some((e) => e.attrs.id === "tree")).toBe(true);
    expect(walk(p).some((e) => e.attrs.id === "sun")).toBe(false);
    const badge = buildPieceSvg(doc, piece("stars"), { x: 145, y: 285, w: 110, h: 30 });
    expect(badge).toContain('<symbol id="star"');
    expect(badge).not.toContain("ring-grad");
    // Twice the vector's pixels per unit (800 px for a 400-unit view box).
    expect(parseSvg(badge).attrs.width).toBe("220");
  });
  it("every piece passes the sanitiser and keeps its look (colours)", () => {
    for (const it of doc.items) {
      const svg = buildPieceSvg(doc, [it], { x: 0, y: 0, w: 400, h: 400 });
      const clean = sanitizeSvg(svg);
      expect(clean).toContain("<svg");
      expect(parseSvg(clean).attrs.viewBox).toBe("0 0 400 400");
    }
    expect(
      extractSvgColors(buildPieceSvg(doc, piece("ring"), { x: 0, y: 0, w: 400, h: 400 })),
    ).toEqual(expect.arrayContaining(["#ffcc00", "#ff6600", "#7a1f00"]));
  });
  it("a hostile file is cleaned before it is split, and a piece built from it carries nothing dangerous", () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10" onclick="x()" fill="#000"/><foreignObject><iframe src="https://evil.test"/></foreignObject><image href="https://evil.test/x.png" width="5" height="5"/><circle r="2" fill="#f00"/></svg>';
    const doc2 = prepareSplit(sanitizeSvg(hostile));
    for (const it of doc2.items) {
      const svg = buildPieceSvg(doc2, [it], { x: 0, y: 0, w: 10, h: 10 });
      expect(svg).not.toMatch(/script|onload|onclick|evil\.test|foreignObject|iframe/i);
    }
  });
});

describe("background detection", () => {
  const vb = { x: 0, y: 0, w: 400, h: 400 };
  const doc = prepareSplit(BADGE);
  const boxes: Box[] = [
    { x: 0, y: 0, w: 400, h: 400 },
    { x: 45, y: 45, w: 310, h: 310 },
    { x: 82, y: 82, w: 236, h: 236 },
    { x: 82, y: 82, w: 236, h: 236 },
    { x: 150, y: 290, w: 100, h: 20 },
    { x: 90, y: 160, w: 220, h: 70 },
  ];
  it("finds the badge's full-size rect first in paint order, nothing else", () => {
    const facts = doc.items.map((e, i) => pieceFacts([e], boxes[i]));
    expect(detectBackground(facts, vb)).toEqual([0]);
  });
  it("finds the illustration's sky through the wrapper's transform (90.25% of the view box)", () => {
    const scene = prepareSplit(SCENE);
    const sky = { x: 20, y: 10, w: 760, h: 570 };
    expect(coverage(sky, scene.frame.vb)).toBeCloseTo(0.9025, 4);
    const facts = scene.items.map((e, i) =>
      pieceFacts([e], i === 0 ? sky : { x: 100, y: 100, w: 100, h: 100 }),
    );
    expect(detectBackground(facts, scene.frame.vb)).toEqual([0]);
  });
  it("refuses an outline, a clipped shape, a small shape, a shape that is not first, and never takes everything", () => {
    const f = (over: Partial<ReturnType<typeof pieceFacts>> = {}) => ({
      bbox: vb,
      shape: true,
      unfilled: false,
      named: false,
      ...over,
    });
    expect(detectBackground([f({ unfilled: true }), f()], vb)).toEqual([]);
    expect(detectBackground([f({ bbox: { x: 0, y: 0, w: 400, h: 300 } }), f()], vb)).toEqual([]);
    expect(detectBackground([f({ shape: false }), f()], vb)).toEqual([]);
    expect(
      detectBackground(
        [f({ shape: false, named: true }), f({ bbox: { x: 0, y: 0, w: 10, h: 10 } })],
        vb,
      ),
    ).toEqual([0]);
    expect(detectBackground([f({ bbox: { x: 0, y: 0, w: 10, h: 10 } }), f()], vb)).toEqual([]);
    expect(detectBackground([f()], vb)).toEqual([]);
    expect(detectBackground([f(), f(), f({ bbox: { x: 0, y: 0, w: 10, h: 10 } })], vb)).toEqual([
      0, 1,
    ]);
    const outline = parseSvg(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="#000"/></svg>',
    );
    expect(pieceFacts([outline.children[0] as SvgEl], vb).unfilled).toBe(true);
    const clipped = parseSvg(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" clip-path="url(#c)"/></svg>',
    );
    expect(pieceFacts([clipped.children[0] as SvgEl], vb).unfilled).toBe(true);
  });
  it("removing it leaves every other element and the frame as they were", () => {
    const out = parseSvg(withoutElements(doc, [doc.items[0]]));
    expect(walk(out).some((e) => e.attrs.id === "background")).toBe(false);
    expect(findPieces(out).items).toHaveLength(5);
    expect(out.attrs.viewBox).toBe("0 0 400 400");
    expect(out.attrs.width).toBe("800");
    expect(extractSvgColors(serializeSvg(out))).not.toContain("#1d3557");
  });
});

describe("placement: the vector's coordinates on the canvas", () => {
  const W = 1080;
  const H = 1350;
  /** Where a point of the vector lands through a layer (rotation about the layer's centre included). */
  const land = (f: SvgFrame, l: LayerPlace, p: { x: number; y: number }) => {
    const m = userToCanvas(f, l, W, H);
    const q = { x: p.x * m.ax + m.bx, y: p.y * m.ay + m.by };
    const c = { x: (l.x + l.w / 2) * W, y: (l.y + l.h / 2) * H };
    const a = ((l.rotate ?? 0) * Math.PI) / 180;
    return {
      x: c.x + (q.x - c.x) * Math.cos(a) - (q.y - c.y) * Math.sin(a),
      y: c.y + (q.x - c.x) * Math.sin(a) + (q.y - c.y) * Math.cos(a),
    };
  };
  const pieceFrame = (f: SvgFrame, b: Box): SvgFrame => {
    const t = viewBoxTransform(f);
    return { vb: b, width: b.w * t.sx, height: b.h * t.sy, par: "none" };
  };
  const cases: { name: string; frame: SvgFrame; layer: LayerPlace }[] = [
    {
      name: "square vector, fit inside, turned 30°",
      frame: { vb: { x: 0, y: 0, w: 400, h: 400 }, width: 800, height: 800, par: "xMidYMid meet" },
      layer: { x: 0.2, y: 0.3, w: 0.5, h: 0.4, rotate: 30, fit: "contain" },
    },
    {
      name: "wide view box in a tall file (meet offsets), fill the box",
      frame: {
        vb: { x: -50, y: 20, w: 600, h: 300 },
        width: 300,
        height: 400,
        par: "xMidYMid meet",
      },
      layer: { x: 0.1, y: 0.1, w: 0.7, h: 0.3, rotate: -12, fit: "cover" },
    },
    {
      name: "slice aligned to the bottom left, cropped",
      frame: { vb: { x: 0, y: 0, w: 100, h: 50 }, width: 200, height: 200, par: "xMinYMax slice" },
      layer: {
        x: 0,
        y: 0.5,
        w: 0.6,
        h: 0.3,
        fit: "contain",
        crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
      },
    },
    {
      name: "stretched (none)",
      frame: { vb: { x: 0, y: 0, w: 100, h: 100 }, width: 300, height: 100, par: "none" },
      layer: { x: 0.3, y: 0.3, w: 0.4, h: 0.2, rotate: 90, fit: "contain" },
    },
  ];
  for (const c of cases) {
    it(`a piece lands exactly where it was drawn: ${c.name}`, () => {
      const bbox = {
        x: c.frame.vb.x + c.frame.vb.w * 0.3,
        y: c.frame.vb.y + c.frame.vb.h * 0.25,
        w: c.frame.vb.w * 0.2,
        h: c.frame.vb.h * 0.3,
      };
      const placed = placePiece(c.frame, c.layer, W, H, bbox);
      const piece: LayerPlace = {
        x: placed.x,
        y: placed.y,
        w: placed.w,
        h: placed.h,
        rotate: placed.rotate,
        fit: "contain",
      };
      const pf = pieceFrame(c.frame, placed.bbox);
      for (const [fx, fy] of [
        [0, 0],
        [1, 0],
        [0.5, 0.5],
        [1, 1],
        [0.2, 0.9],
      ]) {
        const p = { x: bbox.x + bbox.w * fx, y: bbox.y + bbox.h * fy };
        const before = land(c.frame, c.layer, p);
        const after = land(pf, piece, p);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
    });
  }
  it("grows a tiny piece by transparent margin (never by scaling it) to the schema's minimum box", () => {
    const f: SvgFrame = {
      vb: { x: 0, y: 0, w: 1000, h: 1000 },
      width: 1000,
      height: 1000,
      par: "xMidYMid meet",
    };
    const l: LayerPlace = { x: 0.3, y: 0.3, w: 0.32, h: 0.256, fit: "contain" };
    const dot = { x: 500, y: 500, w: 4, h: 4 };
    const placed = placePiece(f, l, W, H, dot);
    expect(placed.w).toBeGreaterThanOrEqual(0.01);
    expect(placed.h).toBeGreaterThanOrEqual(0.01);
    expect(placed.bbox.x + placed.bbox.w / 2).toBeCloseTo(502, 6);
    const p = { x: 501, y: 503 };
    const pf = pieceFrame(f, placed.bbox);
    const after = land(pf, { ...placed, fit: "contain" }, p);
    const before = land(f, l, p);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
  it("the part shown: a cover fit or a crop trims the vector, and pieces are cut to it", () => {
    const f: SvgFrame = {
      vb: { x: 0, y: 0, w: 200, h: 100 },
      width: 200,
      height: 100,
      par: "xMidYMid meet",
    };
    expect(visibleUserBox(f, { x: 0, y: 0, w: 0.5, h: 0.4, fit: "contain" }, W, H)).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    });
    const cover = visibleUserBox(f, { x: 0, y: 0, w: 0.5, h: 0.4, fit: "cover" }, W, H);
    expect(cover.y).toBeCloseTo(0, 6);
    expect(cover.h).toBeCloseTo(100, 6);
    expect(cover.w).toBeLessThan(200);
    expect(cover.x + cover.w / 2).toBeCloseTo(100, 6);
    const crop = visibleUserBox(
      f,
      { x: 0, y: 0, w: 0.5, h: 0.4, fit: "contain", crop: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      W,
      H,
    );
    expect(crop.x).toBeCloseTo(100, 6);
    expect(crop.w).toBeCloseTo(100, 6);
  });
  it("reads the frame from the root, the view box first", () => {
    expect(frameOf(parseSvg(BADGE))).toEqual({
      vb: { x: 0, y: 0, w: 400, h: 400 },
      width: 800,
      height: 800,
      par: "xMidYMid meet",
    });
    expect(frameOf(parseSvg('<svg width="30" height="20"/>'))).toEqual({
      vb: { x: 0, y: 0, w: 30, h: 20 },
      width: 30,
      height: 20,
      par: "xMidYMid meet",
    });
    expect(frameOf(parseSvg("<svg/>"))).toBeNull();
  });
});

describe("staying within the layers a design holds", () => {
  it("merges neighbours in paint order, smallest first, never the background", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 10, y: 10, w: 2, h: 2 },
      { x: 12, y: 10, w: 2, h: 2 },
      { x: 60, y: 60, w: 30, h: 30 },
      { x: 14, y: 10, w: 2, h: 2 },
    ];
    expect(mergeToBudget(boxes, 10)).toEqual([[0], [1], [2], [3], [4]]);
    expect(mergeToBudget(boxes, 4, new Set([0]))).toEqual([[0], [1, 2], [3], [4]]);
    const two = mergeToBudget(boxes, 2, new Set([0]));
    expect(two).toEqual([[0], [1, 2, 3, 4]]);
    expect(two.flat()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("merge back", () => {
  const doc = prepareSplit(BADGE);
  it("composes pieces at their places, ids and CSS scoped per piece, as one SVG the sanitiser keeps", () => {
    const ring = buildPieceSvg(doc, [doc.items[1]], { x: 45, y: 45, w: 310, h: 310 });
    const disc = buildPieceSvg(doc, [doc.items[2]], { x: 82, y: 82, w: 236, h: 236 });
    const { svg, box } = mergePieces([
      { svg: ring, box: { x: 100, y: 100, w: 310, h: 310 } },
      {
        svg: disc.replace(/#ffcc00/g, "#00aa55"),
        box: { x: 500, y: 200, w: 100, h: 100 },
        rotate: 90,
        opacity: 0.5,
        fit: "contain",
      },
    ]);
    expect(box).toEqual({ x: 100, y: 100, w: 500, h: 310 });
    const clean = sanitizeSvg(svg);
    const root = parseSvg(clean);
    expect(root.attrs.viewBox).toBe("0 0 500 310");
    const nested = walk(root).filter((e) => e.name === "svg" && e !== root);
    expect(nested.map((n) => [n.attrs.x, n.attrs.y, n.attrs.width])).toEqual([
      ["0", "0", "310"],
      ["400", "100", "100"],
    ]);
    // The two pieces each had "ring-grad": now m0-ring-grad and m1-ring-grad, with their own colours.
    const grads = walk(root)
      .filter((e) => e.name === "linearGradient")
      .map((e) => e.attrs.id);
    expect(grads).toEqual(
      expect.arrayContaining(["m0-ring-grad", "m1-ring-grad", "m1-ring-grad-2"]),
    );
    expect(clean).toContain('fill="url(#m1-ring-grad-2)"');
    expect(clean).toContain(".m0-scope .ring");
    expect(clean).toContain('transform="rotate(90 450 150)"');
    expect(clean).toContain('opacity="0.5"');
    expect(extractSvgColors(clean)).toEqual(expect.arrayContaining(["#00aa55", "#ffcc00"]));
  });
});

describe("pieces in a saved design", () => {
  it("the design schema keeps a piece's marks (piece, background shape, group) and its colours", () => {
    const design = {
      version: 1 as const,
      layers: [
        {
          id: "P1",
          type: "image",
          src: "/api/studio/posts/graphic?batch=b1&id=0123456789abcdef0123456789abcdef",
          x: 0.1,
          y: 0.1,
          w: 0.2,
          h: 0.2,
          fit: "contain",
          format: "SVG",
          colors: ["#ffcc00"],
          recolor: { "#ffcc00": "#1129d3" },
          group: "Gv1",
          piece: true,
          bgShape: true,
        },
      ],
    };
    const parsed = TEXT_DESIGN_SCHEMA.parse(design);
    expect(parsed.layers[0]).toMatchObject({
      piece: true,
      bgShape: true,
      group: "Gv1",
      recolor: { "#ffcc00": "#1129d3" },
    });
  });
});

describe("the preview's demo catalogue", () => {
  it("ships a sale badge that can be split (five elements, its square background found) and a lightning icon that is one shape", async () => {
    const { DEMO_CATALOGUE, demoArtSvg } = await import("../server/freepik");
    const badgeDemo = prepareSplit(sanitizeSvg(demoArtSvg(DEMO_CATALOGUE.find((f) => f.id === "demo-4")!)));
    expect(ids(badgeDemo.items)).toEqual(["badge-background", "badge-ring", "ribbon", "text", "dots"]);
    const facts = badgeDemo.items.map((e, i) => pieceFacts([e], i === 0 ? { x: 0, y: 0, w: 100, h: 100 } : { x: 20, y: 20, w: 60, h: 60 }));
    expect(detectBackground(facts, badgeDemo.frame.vb)).toEqual([0]);
    const bolt = prepareSplit(sanitizeSvg(demoArtSvg(DEMO_CATALOGUE.find((f) => f.id === "demo-7")!)));
    expect(bolt.items).toHaveLength(1);
  });
});
