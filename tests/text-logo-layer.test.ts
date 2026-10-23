/**
 * The client's automatic layout draws the logo; opening the Text studio turns that layout into
 * layers. The logo has to become a layer too, in the same place, or it is drawn where nothing can
 * select, move or hide it. Found in the QA round on a real client (Habibah's top-centre logo).
 * (src/studio/text/model.ts designFromLegacy puts this layer first, under the words.)
 */
import { describe, expect, it } from "vitest";
import { logoLayerAt } from "../shared/layers";

describe("the layout's logo as a layer", () => {
  it("lands where the layout drew it, as fractions of the canvas", () => {
    expect(logoLayerAt({ x: 378, y: 54, w: 324, h: 120 }, 1080, 1350)).toMatchObject({ type: "logo", x: 378 / 1080, y: 54 / 1350, w: 324 / 1080 });
  });

  it("is no layer when the layout drew no logo (no logo, or the post hides it)", () => {
    expect(logoLayerAt(null, 1080, 1350)).toBeNull();
    expect(logoLayerAt({ x: 0, y: 0, w: 0, h: 0 }, 1080, 1350)).toBeNull();
    expect(logoLayerAt({ x: 1, y: 1, w: 10, h: 10 }, 0, 1350)).toBeNull();
  });
});
