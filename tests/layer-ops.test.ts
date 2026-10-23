import { describe, expect, it } from "vitest";
import { addLayer, backgroundOf, duplicateLayers, imageLayerFromAsset, patchLayers, recolorLayer, removeLayers, reorderLayer, setBackground, zOrderLayers } from "../shared/layer-ops";
import { TEXT_DESIGN_SCHEMA, newImageLayer, newTextLayer, type ImageLayer, type TextDesign } from "../shared/layers";

/**
 * The layer machinery an inserted asset relies on: add, duplicate, remove, reorder, bring
 * forward or back, move, resize, rotate and fade, and "Set as background" as a full-canvas layer
 * at the bottom of the stack, drawn behind the photograph. All of it is data: nothing is generated.
 */

let n = 0;
const id = () => `T${++n}`;
const icon = (): ImageLayer => newImageLayer("/api/studio/freepik/assets/a1/file?layer=1", { id: "icon", name: "Icon", x: 0.6, y: 0.1, w: 0.3, h: 0.24, fit: "contain", source: "freepik", asset: "a1", format: "SVG", colors: ["#c6f432", "#111111"] });
const design = (): TextDesign => ({ version: 1, layers: [newImageLayer("/p.jpg", { id: "photo", name: "Image" }), newTextLayer("MOVE YOUR WAY", { id: "head", role: "headline" }), icon()] });
const ids = (d: TextDesign) => d.layers.map((l) => l.id);

describe("layer operations on an inserted asset", () => {
  it("adds on top, duplicates (offset, no role, no background), removes", () => {
    let d = addLayer({ version: 1, layers: [] }, icon());
    expect(ids(d)).toEqual(["icon"]);
    d = design();
    const dup = duplicateLayers(d, ["icon", "head", "missing"], id);
    expect(dup.copies).toHaveLength(2);
    const [c1, c2] = dup.copies.map((cid) => dup.design.layers.find((l) => l.id === cid)!);
    expect(c1).toMatchObject({ type: "image", name: "Icon copy", w: 0.3, asset: "a1", colors: ["#c6f432", "#111111"] });
    expect(c1.x).toBeCloseTo(0.62, 6);
    expect(c1.y).toBeCloseTo(0.12, 6);
    expect(c2).toMatchObject({ type: "text", role: undefined });
    expect(ids(dup.design).slice(-2)).toEqual(dup.copies);
    const removed = removeLayers(dup.design, [dup.copies[0]]);
    expect(removed.layers).toHaveLength(4);
    expect(duplicateLayers(d, ["nope"]).design).toBe(d);
  });

  it("reorders top-first as the layers list shows them, and brings forward or back", () => {
    const d = design();
    // Top-first: icon(0), head(1), photo(2). Moving the icon to the bottom of the list.
    expect(ids(reorderLayer(d, 0, 2))).toEqual(["icon", "photo", "head"]);
    expect(reorderLayer(d, 0, 0)).toBe(d);
    expect(reorderLayer(d, 5, 0)).toBe(d);
    expect(ids(zOrderLayers(d, ["photo"], "front"))).toEqual(["head", "icon", "photo"]);
    expect(ids(zOrderLayers(d, ["icon"], "back"))).toEqual(["icon", "photo", "head"]);
    expect(ids(zOrderLayers(d, ["head"], "up"))).toEqual(["photo", "icon", "head"]);
    expect(ids(zOrderLayers(d, ["head"], "down"))).toEqual(["head", "photo", "icon"]);
    expect(zOrderLayers(d, ["icon"], "up")).toBe(d);
  });

  it("moves, resizes, rotates, fades and hides a layer", () => {
    const d = patchLayers(design(), ["icon"], { x: 0.05, y: 0.7, w: 0.2, h: 0.16, rotate: -12, opacity: 0.6, hidden: true });
    expect(d.layers.find((l) => l.id === "icon")).toMatchObject({ x: 0.05, y: 0.7, w: 0.2, h: 0.16, rotate: -12, opacity: 0.6, hidden: true, src: "/api/studio/freepik/assets/a1/file?layer=1" });
    expect(d.layers.find((l) => l.id === "head")).toEqual(design().layers[1]);
    const fn = patchLayers(design(), ["icon"], (l) => ({ rotate: (l.rotate ?? 0) + 90 }));
    expect(fn.layers.find((l) => l.id === "icon")?.rotate).toBe(90);
  });

  it("Set as background: a full-canvas layer at the bottom, behind the photo; one at a time", () => {
    const d = design();
    const first = setBackground(d, "/api/studio/freepik/assets/bg1/file", { source: "freepik", asset: "bg1", name: "Concrete" });
    expect(first.design.layers[0]).toMatchObject({ id: first.layer.id, type: "image", x: 0, y: 0, w: 1, h: 1, fit: "cover", behind: true, name: "Concrete", source: "freepik" });
    expect(ids(first.design).slice(1)).toEqual(ids(d));
    expect(backgroundOf(first.design)?.id).toBe(first.layer.id);
    const second = setBackground(first.design, "/bg2.jpg");
    expect(second.design.layers.filter((l) => l.type === "image" && l.behind)).toHaveLength(1);
    expect(second.design.layers[0]).toMatchObject({ src: "/bg2.jpg", behind: true, name: "Background" });
    const copy = duplicateLayers(second.design, [second.layer.id], id);
    expect(copy.design.layers.find((l) => l.id === copy.copies[0])).not.toHaveProperty("behind");
    expect(backgroundOf(design())).toBeNull();
  });

  it("recolours an editable vector per layer, and puts a colour back", () => {
    const l = recolorLayer(icon(), "#C6F432", "#1129D3");
    expect(l.recolor).toEqual({ "#c6f432": "#1129d3" });
    const two = recolorLayer(l, "#111111", "#ffffff");
    expect(two.recolor).toEqual({ "#c6f432": "#1129d3", "#111111": "#ffffff" });
    expect(recolorLayer(two, "#c6f432", "#c6f432").recolor).toEqual({ "#111111": "#ffffff" });
    expect(recolorLayer(recolorLayer(icon(), "#111111", "#111111"), "#c6f432", "#c6f432").recolor).toBeUndefined();
  });

  it("an asset becomes a centred layer that keeps its proportions; lettering stays a picture", () => {
    const vec = imageLayerFromAsset({ src: "/v.svg", name: "Lightning icon (demo)", assetId: "a7", kind: "vector", editable: true, colors: ["#c6f432"], format: "SVG", note: "Editable vector", aspect: 1 }, 1080, 1350, () => "L7");
    expect(vec).toMatchObject({ id: "L7", name: "Lightning icon", fit: "contain", w: 0.32, h: 0.256, x: 0.34, y: 0.372, source: "freepik", asset: "a7", colors: ["#c6f432"], format: "SVG" });
    const photo = imageLayerFromAsset({ src: "/p.jpg", name: "Marble", kind: "photo", aspect: 2 }, 1080, 1080, () => "L8");
    expect(photo).toMatchObject({ fit: "cover", w: 0.5, h: 0.25 });
    expect(photo).not.toHaveProperty("colors");
    const tall = imageLayerFromAsset({ src: "/t.jpg", name: "Tall", kind: "photo", aspect: 0.25 }, 1080, 1080, () => "L9");
    expect(tall.h).toBe(0.6);
    expect(tall.w).toBeCloseTo(0.15, 3);
    const word = imageLayerFromAsset({ src: "/w.png", name: "Brush lettering", kind: "vector", lettering: true, editable: false, colors: ["#e2336b"] }, 1080, 1350);
    expect(word).toMatchObject({ type: "image", lettering: true });
    expect(word).not.toHaveProperty("colors");
    expect(word).not.toHaveProperty("text");
  });

  it("the saved design keeps the background, the source and the colour map (the schema does not strip them)", () => {
    const bg = setBackground(design(), "/bg.jpg", { source: "freepik", asset: "bg1" }).design;
    const withColours = patchLayers(bg, ["icon"], { recolor: { "#c6f432": "#1129d3" } } as Partial<ImageLayer>);
    const parsed = TEXT_DESIGN_SCHEMA.parse({ ...withColours, canvas: { photoScale: 0.8 } });
    expect(parsed.layers[0]).toMatchObject({ behind: true, source: "freepik", asset: "bg1" });
    expect(parsed.layers.find((l) => l.id === "icon")).toMatchObject({ recolor: { "#c6f432": "#1129d3" }, colors: ["#c6f432", "#111111"], format: "SVG" });
    expect(parsed.canvas?.photoScale).toBe(0.8);
    expect(TEXT_DESIGN_SCHEMA.safeParse({ ...withColours, canvas: { photoScale: 0.1 } }).success).toBe(false);
  });
});
