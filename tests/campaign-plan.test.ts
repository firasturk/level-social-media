/**
 * The plan of a campaign (shared/campaign-plan.ts): the steps of 3 image posts and 4 multishot Reels,
 * their counts (a multishot Reel is not one generation), the cost per provider in its own unit, the
 * cap with its retry allowance, unknown prices flagged, and what an edit changes after approval.
 */
import { describe, expect, it } from "vitest";
import { approvalSignature, budgetCaps, countsLine, itemProductionSignature, normalizePlan, planChanges, planCosts, planCounts, planSteps, stepId } from "../shared/campaign-plan";
import { campaign3x4, DEFAULTS, PRICES } from "./support/campaign-fixture";

describe("3 image posts and 4 multishot Reels", () => {
  it("counts every shot, clip and starting image, not four generations", () => {
    const c = planCounts(campaign3x4());
    expect(c).toEqual({ imagePosts: 3, videos: 4, shots: 16, generatedShots: 13, existingShots: 3, startImages: 8, keyFrames: 3, pictures: 11, clips: 13, assemblies: 4, renders: 4 });
    expect(countsLine(c)).toBe("3 image posts · 4 videos (16 shots: 13 generated clips, 3 from existing media) · 11 pictures to generate (3 post pictures, 3 key frames, 5 shot starting images)");
  });

  it("orders the steps after what they need", () => {
    const steps = planSteps(campaign3x4());
    const at = new Map(steps.map((s, i) => [s.id, i]));
    for (const s of steps) for (const d of s.deps) expect(at.get(d)!).toBeLessThan(at.get(s.id)!);
    expect(steps.find((s) => s.id === stepId("vid-1", "s2", "clip"))!.deps).toEqual([stepId("vid-1", "s2", "frame")]);
    expect(steps.find((s) => s.id === stepId("vid-1", "s1", "clip"))!.deps).toEqual([stepId("vid-1", null, "image")]);
    expect(steps.find((s) => s.id === stepId("vid-1", "s3", "clip"))!.deps).toEqual([stepId("vid-1", null, "image")]);
    expect(steps.find((s) => s.id === stepId("vid-4", "s1", "clip"))!.deps).toEqual([stepId("vid-4", null, "post")]);
    expect(steps.some((s) => s.id === stepId("vid-4", null, "image"))).toBe(false);
    expect(steps.find((s) => s.id === stepId("vid-2", "s3", "clip"))!.priceKey).toBe("clip:higgsfield-mcp:kling-3.0:10:9:16");
  });

  it("prices each unit apart and caps it with the retry allowance", () => {
    const costs = planCosts(planSteps(campaign3x4()), PRICES);
    expect(costs.totals).toEqual({
      usd: { estimate: 0.606, steps: 6, unknown: 0 },
      "magnific-credits": { estimate: 50, steps: 5, unknown: 0 },
      "higgsfield-credits": { estimate: 12 * 30 + 55, steps: 13, unknown: 0 },
    });
    expect(budgetCaps(costs, 1)).toEqual([
      { unit: "usd", estimate: 0.606, retries: 1, retryAllowance: 0.606, cap: 1.212, unknown: 0 },
      { unit: "higgsfield-credits", estimate: 415, retries: 1, retryAllowance: 415, cap: 830, unknown: 0 },
      { unit: "magnific-credits", estimate: 50, retries: 1, retryAllowance: 50, cap: 100, unknown: 0 },
    ]);
  });

  it("flags a step whose price is not known instead of guessing it", () => {
    const { "tool:mg-camera": _drop, ...rest } = PRICES;
    void _drop;
    const costs = planCosts(planSteps(campaign3x4()), rest);
    expect(costs.unknown.map((l) => l.step)).toEqual([stepId("vid-1", "s2", "frame"), stepId("vid-2", "s2", "frame"), stepId("vid-3", "s2", "frame"), stepId("vid-3", "s3", "frame"), stepId("vid-3", "s4", "frame")]);
    expect(costs.totals["magnific-credits"]).toEqual({ estimate: 0, steps: 5, unknown: 5 });
  });

  it("counts only the selected items", () => {
    const c = planCounts(campaign3x4(), new Set(["img-1", "vid-3"]));
    expect(c).toMatchObject({ imagePosts: 1, videos: 1, shots: 4, clips: 4, pictures: 1 + 1 + 3 });
  });
});

describe("edits and approval", () => {
  it("tells a material change from a words-only change", () => {
    const before = campaign3x4();
    const after = campaign3x4();
    after.images[0].headline = "New headline";
    after.videos[1].shots[2].camera = "orbit";
    after.videos[2].shots[0].text = "new words";
    expect(planChanges(before, after)).toEqual({ material: ["vid-2"], words: ["img-1", "vid-3"], added: [], removed: [] });
  });

  it("ties the approval to the revision, the items, their production and the caps", () => {
    const plan = campaign3x4();
    const caps = budgetCaps(planCosts(planSteps(plan), PRICES), 1);
    const terms = { rev: plan.rev, items: ["img-1", "vid-1"], retries: 1, caps, acceptedUnknown: [] };
    const sig = approvalSignature(plan, terms);
    expect(approvalSignature(plan, { ...terms, items: ["vid-1", "img-1"] })).toBe(sig);
    expect(approvalSignature({ ...plan, rev: 2 }, terms)).not.toBe(sig);
    expect(approvalSignature(plan, { ...terms, retries: 0 })).not.toBe(sig);
    const changed = campaign3x4();
    changed.videos[0].clipEngine = { provider: "higgsfield-mcp", model: "seedance-2.0", name: "Seedance 2.0" };
    expect(approvalSignature(changed, terms)).not.toBe(sig);
    // A change to an item outside the approval does not touch it.
    const other = campaign3x4();
    other.videos[3].shots[0].seconds = 5;
    expect(approvalSignature(other, terms)).toBe(sig);
  });

  it("keeps a plan in its bounds: an existing shot without the client's media becomes generated, shot keys stay unique", () => {
    const p = normalizePlan({ videos: [{ shots: [{ key: "s1", source: "existing", seconds: 99 }, { key: "s1", source: "animate" }] }] } as never, DEFAULTS);
    expect(p.videos[0].shots.map((s) => [s.key, s.source, s.seconds])).toEqual([
      ["s1", "start-image", 15],
      ["s2", "animate", 3],
    ]);
    expect(itemProductionSignature(p.videos[0])).toMatch(/^[0-9a-f]{16}$/);
  });
});
