/**
 * The compositor's shared definition (shared/video-compose.ts), the part the preview and the export
 * both draw from: the encoded size of each frame, Fill and Fit with zoom and pan (never stretched),
 * the display rotation read from a phone's track matrix and its inverse used by the shader, the text
 * and logo layers' timing and checks, the text direction, and the colour assumed for a file that
 * says nothing. Plus the project document keeping all of it through a save.
 */
import { describe, expect, it } from "vitest";
import { assumedColour, checkOverlays, codedUv, colourFromNclx, displaySize, frameOfOutput, isHdr, newLogoOverlay, newTextOverlay, outputForFrame, overlaysAt, placeSource, placementUniform, rotationOfMatrix, textDirection, type Framing } from "../shared/video-compose";
import { clipFraming, newClip, newProject, validateProject } from "../shared/video-project";

const F = (p: Partial<Framing> = {}): Framing => ({ fit: "fill", zoom: 1, x: 0, y: 0, ...p });

describe("frames and encoded sizes", () => {
  it("maps each frame to its encoded size and back", () => {
    expect(outputForFrame("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(outputForFrame("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(outputForFrame("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(outputForFrame("16:9")).toEqual({ width: 1920, height: 1080 });
    for (const f of ["9:16", "4:5", "1:1", "16:9"] as const) expect(frameOfOutput(outputForFrame(f))).toBe(f);
  });
});

describe("placing a source in the frame", () => {
  const out = { width: 1080, height: 1920 };
  const land = { width: 1920, height: 1080 };
  it("Fill covers the frame, centred, keeping the picture's shape", () => {
    const r = placeSource(land, out, F());
    expect(r.h).toBeCloseTo(1920);
    expect(r.w / r.h).toBeCloseTo(16 / 9);
    expect(r.x).toBeCloseTo((1080 - r.w) / 2);
    expect(r.y).toBeCloseTo(0);
  });
  it("Fill panned to an edge shows that edge and never leaves a gap", () => {
    const left = placeSource(land, out, F({ x: -1 }));
    expect(left.x).toBeCloseTo(0);
    const right = placeSource(land, out, F({ x: 1 }));
    expect(right.x + right.w).toBeCloseTo(1080);
  });
  it("Fit shows the whole picture inside the frame, with bands", () => {
    const r = placeSource(land, out, F({ fit: "fit" }));
    expect(r.w).toBeCloseTo(1080);
    expect(r.h).toBeCloseTo(607.5);
    expect(r.y).toBeCloseTo((1920 - 607.5) / 2);
    const top = placeSource(land, out, F({ fit: "fit", y: -1 }));
    expect(top.y).toBeCloseTo(0);
  });
  it("zoom enlarges uniformly and is bounded", () => {
    const r = placeSource(land, out, F({ zoom: 2 }));
    expect(r.h).toBeCloseTo(3840);
    expect(r.w / r.h).toBeCloseTo(16 / 9);
    expect(placeSource(land, out, F({ zoom: 99 })).h).toBeCloseTo(1920 * 4);
  });
  it("turns a placement into the shader's scale and offset", () => {
    const r = placeSource(land, out, F());
    const [sx, sy, ox, oy] = placementUniform(r, out);
    // The output's centre samples the source's centre.
    expect((0.5 - ox) * sx).toBeCloseTo(0.5);
    expect((0.5 - oy) * sy).toBeCloseTo(0.5);
  });
});

describe("rotation", () => {
  it("reads a phone's track matrix (signed or unsigned) as a clockwise rotation", () => {
    const m90 = [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824];
    expect(rotationOfMatrix(m90)).toBe(90);
    expect(rotationOfMatrix(Uint32Array.from(m90.map((v) => (v < 0 ? v + 0x100000000 : v))))).toBe(90);
    expect(rotationOfMatrix([65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824])).toBe(0);
    expect(rotationOfMatrix([-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824])).toBe(180);
    expect(rotationOfMatrix([0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824])).toBe(270);
    expect(rotationOfMatrix(null)).toBe(0);
  });
  it("swaps the shown size for 90 and 270", () => {
    expect(displaySize({ width: 1920, height: 1080 }, 90)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize({ width: 1920, height: 1080 }, 180)).toEqual({ width: 1920, height: 1080 });
  });
  it("maps a shown point back to the coded picture (the shader's lookup)", () => {
    // Shown top-left of a 90° clip is the coded bottom-left.
    expect(codedUv(0, 0, 90)).toEqual([0, 1]);
    expect(codedUv(1, 0, 90)).toEqual([0, 0]);
    expect(codedUv(0, 0, 270)).toEqual([1, 0]);
    expect(codedUv(0.25, 0.75, 180)).toEqual([0.75, 0.25]);
    expect(codedUv(0.3, 0.6, 0)).toEqual([0.3, 0.6]);
  });
});

describe("text and logo layers", () => {
  it("shows a layer from its start up to (not including) its end", () => {
    const t = newTextOverlay("Hi", 1, 2, "t");
    const l = newLogoOverlay("/api/studio/clients/c1/logo?v=1", "Logo", 0, 4, "l");
    expect(overlaysAt([t, l], 0.5).map((o) => o.id)).toEqual(["l"]);
    expect(overlaysAt([t, l], 1).map((o) => o.id)).toEqual(["t", "l"]);
    expect(overlaysAt([t, l], 2).map((o) => o.id)).toEqual(["l"]);
  });
  it("reads the direction from the first strong letter", () => {
    expect(textDirection("تحرّك بطريقتك")).toBe("rtl");
    expect(textDirection("2026 مجموعة جديدة")).toBe("rtl");
    expect(textDirection("New collection · مجموعة")).toBe("ltr");
  });
  it("checks layers with plain reasons", () => {
    expect(checkOverlays([newTextOverlay("Hi", 0, 1, "a")])).toHaveLength(1);
    expect(checkOverlays([{ ...newTextOverlay("Hi", 2, 1, "a") }])).toMatch(/start before end/);
    expect(checkOverlays([{ ...newTextOverlay("", 0, 1, "a") }])).toMatch(/1 to 300 characters/);
    expect(checkOverlays([{ ...newTextOverlay("Hi", 0, 1, "a"), color: "red" }])).toMatch(/hex colour/);
    expect(checkOverlays([newLogoOverlay("https://evil.example/x.png", "x", 0, 1, "a")])).toMatch(/picture from the studio/);
    expect(checkOverlays([newLogoOverlay(`data:image/png;base64,${"A".repeat(210 * 1024)}`, "x", 0, 1, "a")])).toMatch(/too large/);
    expect(checkOverlays([newTextOverlay("a", 0, 1, "a"), newTextOverlay("b", 0, 1, "a")])).toMatch(/unique id/);
  });
});

describe("colour on import", () => {
  it("names the nclx numbers and assumes the size's convention when the file says nothing", () => {
    expect(colourFromNclx(1, 1, 1, false)).toEqual({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false });
    expect(colourFromNclx(9, 16, 9, false).transfer).toBe("pq");
    expect(isHdr(colourFromNclx(9, 18, 9, false))).toBe(true);
    expect(assumedColour(null, 1080).matrix).toBe("bt709");
    expect(assumedColour(null, 360).matrix).toBe("smpte170m");
    expect(assumedColour({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: true }, 360)).toMatchObject({ matrix: "bt709", fullRange: true });
  });
});

describe("the project keeps the frame, the framing, the background and the layers", () => {
  it("survives validation exactly, and an older document gets the defaults", () => {
    const p = { ...newProject("Cut", 1), output: { ...outputForFrame("4:5"), fps: 30, bitrate: 8_000_000 }, framing: F({ fit: "fit" }), background: "#202020", overlays: [newTextOverlay("تحرّك", 0, 1, "t"), newLogoOverlay("/api/studio/clients/c1/logo?v=2", "Logo", 0, 2, "l")], clips: [{ ...newClip({ kind: "version", batch: "b", videoId: "v" }, 3, "c"), framing: F({ zoom: 1.5, x: -0.4 }) }] };
    const r = validateProject(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project).toEqual(p);
    expect(clipFraming(r.project, r.project.clips[0])).toEqual(F({ zoom: 1.5, x: -0.4 }));
    const old = { ...p } as Record<string, unknown>;
    delete old.framing;
    delete old.background;
    delete old.overlays;
    const o = validateProject(old);
    expect(o.ok && o.project.framing).toEqual(F());
    expect(o.ok && o.project.overlays).toEqual([]);
    expect(o.ok && o.project.background).toBe("#000000");
  });
});
