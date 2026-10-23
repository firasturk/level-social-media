/**
 * The client's automatic layout draws the logo; opening the Text studio turns that layout into
 * layers. The logo has to become a layer too, in the same place, or it is drawn where nothing can
 * select, move or hide it. Found in the QA round on a real client (Habibah's top-centre logo).
 */
import { describe, expect, it } from "vitest";
import { designFromLegacy } from "../src/studio/text/model";
import { OVERLAY_TEMPLATES } from "../shared/overlay";

describe("the automatic layout as layers", () => {
  const spec = OVERLAY_TEMPLATES.habibah;

  it("makes the drawn logo a logo layer in the same place, under the words", () => {
    const d = designFromLegacy(spec, "عرض خاص", "", undefined, { x: 100, y: 1100, w: 880, h: 120 }, 1080, 1350, { x: 378, y: 54, w: 324, h: 120 });
    expect(d.layers[0]).toMatchObject({ type: "logo", x: 378 / 1080, y: 54 / 1350, w: 324 / 1080 });
    expect(d.layers[1]).toMatchObject({ type: "text", role: "headline" });
  });

  it("adds no logo layer when the layout drew none (no logo, or the post hides it)", () => {
    const d = designFromLegacy(spec, "عرض خاص", "", undefined, null, 1080, 1350);
    expect(d.layers.some((l) => l.type === "logo")).toBe(false);
  });

  it("keeps the fade for the words only: a logo alone does not darken the picture", () => {
    const d = designFromLegacy(spec, "", "", undefined, null, 1080, 1350, { x: 378, y: 54, w: 324, h: 120 });
    expect(d.layers.map((l) => l.type)).toEqual(["logo"]);
    expect(d.canvas).toBeUndefined();
  });
});
