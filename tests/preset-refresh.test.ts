/**
 * The daily refresh of the preset galleries (server/preset-refresh.ts): nothing while Higgsfield is
 * not signed in, the stalest category (never stored first) read again on a pass, one pass per few
 * minutes, fresh categories left alone. Browsing only: the guard fails the test on any other call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { higgsfieldStub, ops, seed, signedInHiggsfield } from "./support/photo-mcp";
import { resetHiggsfieldMcpCaches, useHiggsfieldMcpFetch } from "../server/higgsfield-mcp";
import { cacheKey, resetPresetCaches } from "../server/video-presets";
import { photoCacheKey, resetPhotoPresetCaches } from "../server/photo-presets";
import { refreshStalePresets, refreshTargets, stalestTarget, PRESET_REFRESH_AGE_MS } from "../server/preset-refresh";
import { getSetting, setSetting } from "../server/settings";

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  useHiggsfieldMcpFetch(null);
  resetHiggsfieldMcpCaches();
  resetPresetCaches();
  resetPhotoPresetCaches();
});
afterEach(() => {
  expect(reached).toEqual([]);
  useHiggsfieldMcpFetch(null);
});

describe("the daily refresh of the preset galleries", () => {
  it("covers every Higgsfield category of both studios, not Magnific's looks", () => {
    const t = refreshTargets();
    expect(t.filter((x) => x.studio === "video").map((x) => x.category)).toContain("genjutsu-styles");
    expect(t.filter((x) => x.studio === "photo").map((x) => x.category)).toEqual(["styles", "product-shots", "ads", "posters", "marketplace", "recipes"]);
  });

  it("does nothing before the sign-in, then reads the stalest category once per pass and stores it", async () => {
    const env = await seed();
    const stub = higgsfieldStub();
    useHiggsfieldMcpFetch(stub.fn);
    expect(await refreshStalePresets(env)).toBeNull();
    expect(stub.rpc).toEqual([]);
    await signedInHiggsfield(env);
    // Every video category fresh, the photo styles a day old, the rest fresh: the styles are the ones read.
    const fresh = JSON.stringify({ at: Date.now(), items: [{ id: "x" }], nextCursor: null });
    for (const t of refreshTargets()) await setSetting(env, t.studio === "video" ? cacheKey(t.category, "") : photoCacheKey(t.category, ""), fresh);
    await setSetting(env, photoCacheKey("styles", ""), JSON.stringify({ at: Date.now() - PRESET_REFRESH_AGE_MS - 1000, items: [] }));
    expect(await stalestTarget(env)).toEqual({ studio: "photo", category: "styles" });
    expect(await refreshStalePresets(env)).toBe("photo · styles");
    expect(stub.rpc.filter((x) => x.name === "get_presets").map((x) => x.args)).toEqual([{ source: "soul", limit: 50 }]);
    const stored = JSON.parse((await getSetting(env, photoCacheKey("styles", "")))!) as { at: number; items: { id: string }[] };
    expect(stored.items.map((i) => i.id)).toEqual(["soul_film", "soul_editorial"]);
    expect(Date.now() - stored.at).toBeLessThan(60_000);
    const browsed = (await ops(env)).results.filter((o) => o.kind === "preset.browse");
    expect(browsed).toHaveLength(1);
    expect(browsed[0].note).toMatch(/daily refresh · photo · styles · 2 presets/);
    // All fresh now: nothing more to read.
    expect(await stalestTarget(env)).toBeNull();
    expect(await refreshStalePresets(env)).toBeNull();
    // A category that was never stored comes first, but not within a few minutes of the last pass.
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(photoCacheKey("product-shots", "")).run();
    expect(await stalestTarget(env)).toEqual({ studio: "photo", category: "product-shots" });
    expect(await refreshStalePresets(env)).toBeNull();
    expect(stub.rpc.filter((x) => x.name === "get_presets")).toHaveLength(1);
  });
});
