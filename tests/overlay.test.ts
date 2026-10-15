import { describe, expect, it } from "vitest";
import { NO_OVERLAY, OVERLAY_TEMPLATES, resolveOverlay } from "../shared/overlay";

describe("overlay specs", () => {
  it("fills a stored partial spec from its template", () => {
    const s = resolveOverlay({ template: "united", headline: { size: 0.1 } as never });
    expect(s.logo.position).toBe("top-center");
    expect(s.headline.size).toBe(0.1);
    expect(s.headline.font).toBe(OVERLAY_TEMPLATES.united.headline.font);
  });
  it("defaults to the clean layout and honours none", () => {
    expect(resolveOverlay(null).template).toBe("clean");
    expect(resolveOverlay({ template: "none" })).toEqual(NO_OVERLAY);
  });
  it("keeps every metric as a fraction of the width", () => {
    for (const t of Object.values(OVERLAY_TEMPLATES)) {
      expect(t.logo.width).toBeGreaterThan(0);
      expect(t.logo.width).toBeLessThan(1);
      expect(t.headline.size).toBeLessThan(0.2);
      expect(t.margin).toBeLessThan(0.2);
    }
  });
});
