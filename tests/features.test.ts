import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURES } from "../shared/features";
import { HELP_GUIDE } from "../shared/help-guide";
import { costSafe, creditsTag, formatUsd, HIDDEN_PRICE, pricesAreHidden, setPricesHidden, withoutCosts } from "../shared/pricing";
import { intentRunnable, resolveIntent, type PromptContext } from "../shared/promptbox";

/**
 * The owner's two decisions of 15 Nov, as far as they can be checked without a browser:
 *  A. four features nobody used are hidden behind shared/features.ts (their code and routes stay);
 *  B. employees run the video and edit tools, and a member who is not shown prices reads no amount.
 */

const src = (path: string) => readFileSync(path, "utf8");
/** The first `needle` in a file with the few lines before it: where a control is drawn. */
function before(path: string, needle: string, lines = 4): string {
  const text = src(path);
  const at = text.indexOf(needle);
  expect(at, `${path} no longer has: ${needle}`).toBeGreaterThan(-1);
  return text.slice(0, at).split("\n").slice(-lines).join("\n");
}

describe("A. hidden features (shared/features.ts)", () => {
  it("publishing, Drive delivery, the music library, the radio and influencers are off", () => {
    expect(FEATURES).toEqual({ publish: false, driveDelivery: false, music: false, radio: false, influencers: false });
  });

  it("every entry point is drawn only when its flag is on", () => {
    // The Studio's More menu.
    expect(before("src/studio/Workspace.tsx", "Deliver to the client&apos;s Drive…")).toContain("FEATURES.driveDelivery && (");
    expect(before("src/studio/Workspace.tsx", "Schedule the approved posts…")).toContain("FEATURES.publish && (");
    // The floating radio button.
    expect(src("src/studio/Workspace.tsx")).toContain("{FEATURES.radio && <Radio ");
    expect(src("src/studio/Workspace.tsx")).not.toMatch(/^\s*<Radio /m);
    // A card's menu: both menus (the client's own picture, a planned post).
    const plan = src("src/studio/PlanView.tsx");
    expect(plan.match(/label: "Publish to Instagram…"/g)).toHaveLength(2);
    expect(plan.match(/\.\.\.\(FEATURES\.publish \? \[\{ label: "Publish to Instagram…"/g)).toHaveLength(2);
    // Connection → Instagram.
    expect(src("src/studio/MetaConnection.tsx")).toContain("{FEATURES.publish && <PublishReadiness />}");
    expect(src("src/studio/MetaConnection.tsx")).not.toMatch(/^\s*<PublishReadiness \/>/m);
    // The video editor's Music tab: the library's button and the library itself; the track from the computer stays.
    const music = src("src/video-editor/ui/MusicSourcePanel.tsx");
    expect(before("src/video-editor/ui/MusicSourcePanel.tsx", '<button type="button" className="ts-btn" onClick={() => setBrowse(', 2)).toContain("{FEATURES.music && (");
    expect(music).toContain("{FEATURES.music && browse && (");
    expect(music).not.toMatch(/^\s*\{browse && \(/m);
    expect(src("src/video-editor/ui/Panels.tsx")).toContain("Pick a track");
  });

  it("nothing imports the influencers screen, and nothing else opens the two dialogs", () => {
    const files = ["src/App.tsx", "src/studio/Workspace.tsx", "src/studio/PlanView.tsx", "src/studio/Flow.tsx", "src/studio/Journey.tsx", "src/studio/BrandPanel.tsx", "src/studio/Sidebar.tsx", "src/studio/StudioBoard.tsx"];
    for (const f of files) expect(src(f), f).not.toMatch(/from "\.\/Influencers"|import\("\.\/Influencers"\)/);
    const work = src("src/studio/Workspace.tsx");
    expect(work.match(/setDeliverOpen\(true\)/g)).toHaveLength(1);
    expect(work.match(/setScheduleApproved\(true\)/g)).toHaveLength(1);
    expect(src("src/studio/PlanView.tsx").match(/setPublishFor\(p\.index\)/g)).toHaveLength(2);
  });

  it("the worker does not depend on the flags: the routes of the hidden features stay as they are", () => {
    for (const f of ["server/studio.ts", "server/publish.ts", "server/drive-delivery.ts", "server/music.ts", "server/influencers.ts"]) expect(src(f), f).not.toMatch(/features"/);
    const studio = src("server/studio.ts");
    for (const mount of ['studioRoutes.route("/publish", publishRoutes)', 'studioRoutes.route("/drive/delivery", deliveryRoutes)', 'studioRoutes.route("/music", musicRoutes)', 'studioRoutes.route("/influencers", influencerRoutes)']) expect(studio).toContain(mount);
  });

  it("the help guide no longer sends anyone to a hidden control", () => {
    for (const label of ['"Publish to Instagram…"', '"Schedule the approved posts…"', "\"Deliver to the client's Drive…\"", '"Browse the music library"', "deliver to Drive"]) expect(HELP_GUIDE, label).not.toContain(label);
    expect(HELP_GUIDE).toMatch(/Publishing or scheduling to Instagram.*switched off/);
    // And it no longer tells members the video and edit tools are closed to them.
    expect(HELP_GUIDE).not.toMatch(/AI tools" \(admins only|Photo lab" \(admins only|"Generate" \(admins\)|"Enhance" \(admins\)|video \(admins\)/);
    expect(HELP_GUIDE).toMatch(/Members can:.*making, enhancing and checking videos.*"Combine into one video".*Prompt box tool cards/);
    expect(HELP_GUIDE).toMatch(/Admins only: Connection \(sign-ins, keys, the billing choice\), the Admin and Approvals pages, Campaign Autopilot/);
  });
});

describe("B. the cost is the admins' to see", () => {
  afterEach(() => setPricesHidden(false));

  it("takes credit and dollar amounts out of a provider's message", () => {
    expect(withoutCosts("Confirm the clip: about 12 credits from the subscription balance (300 available).")).toBe(`Confirm the clip: ${HIDDEN_PRICE} from the subscription balance.`);
    expect(withoutCosts("Higgsfield asks whether this Kling clip should use the unlimited allowance or pay credits (12). Choose, then run again.")).toBe("Higgsfield asks whether this Kling clip should use the unlimited allowance or pay credits. Choose, then run again.");
    expect(withoutCosts("Video 3 is being made on Kling with the subscription credits (about 12 credits); it appears on the card.")).toBe("Video 3 is being made on Kling with the subscription credits; it appears on the card.");
    expect(withoutCosts("Confirm upscale: about 1,250.5 credits from the Magnific balance.")).toBe(`Confirm upscale: ${HIDDEN_PRICE} from the Magnific balance.`);
    expect(withoutCosts("Confirm the cost first: Freepik photolab.upscale is about $0.10.")).toBe(`Confirm the cost first: Freepik photolab.upscale is about ${HIDDEN_PRICE}.`);
    expect(withoutCosts("That post has no picture yet.")).toBe("That post has no picture yet.");
    // Lengths, sizes and counts are not amounts.
    expect(withoutCosts("A 5 s clip, 9:16, post 12 of 15.")).toBe("A 5 s clip, 9:16, post 12 of 15.");
  });

  it("shows everything to whoever is shown prices, and no amount to a member who is not", () => {
    const message = "Confirm the run: about 40 credits from the subscription balance (900 available).";
    expect(pricesAreHidden()).toBe(false);
    expect(costSafe(message)).toBe(message);
    expect(creditsTag(40)).toBe(" · 40 credits");
    expect(creditsTag(null)).toBe("");
    expect(formatUsd(0.13)).toBe("$0.13");

    setPricesHidden(true);
    expect(pricesAreHidden()).toBe(true);
    expect(costSafe(message)).toBe(`Confirm the run: ${HIDDEN_PRICE} from the subscription balance.`);
    expect(costSafe(message)).not.toMatch(/\d/);
    expect(creditsTag(40)).toBe("");
    expect(formatUsd(0.13)).toBe(HIDDEN_PRICE);
  });

  it("the video and edit panels read the viewer's price setting wherever they print an amount", () => {
    // A panel that prints credits or dollars must go through shared/pricing (pricesAreHidden / creditsTag / costSafe / formatUsd).
    const panels = [
      "src/video-editor/ui/studio/GeneratePanel.tsx",
      "src/video-editor/ui/studio/EnhancePanel.tsx",
      "src/video-editor/ui/studio/CheckPanel.tsx",
      "src/video-editor/ui/studio/PresetsPanel.tsx",
      "src/studio/VideoDialog.tsx",
      "src/studio/photo/panels/Tools.tsx",
      "src/studio/photo/panels/Presets.tsx",
      "src/studio/photo/usePhotoTools.ts",
      "src/studio/AmbassadorTrends.tsx",
      "src/studio/IntentCard.tsx",
      "src/studio/FreepikPanel.tsx",
      "src/studio/videoApi.ts",
    ];
    for (const f of panels) expect(src(f), f).toMatch(/import \{[^}]*\b(pricesAreHidden|creditsTag|costSafe)\b[^}]*\} from "@shared\/pricing"/);
    for (const f of ["src/studio/photo/panels/Lab.tsx", "src/studio/PhotoLabPanel.tsx", "src/studio/photolab/usePhotoLab.ts"]) expect(src(f), f).toMatch(/formatUsd/);
    // The "Get the cost" step is not drawn for a member who is not shown prices.
    const generate = src("src/video-editor/ui/studio/GeneratePanel.tsx");
    expect(generate.match(/\{hidden \? \(\s*<button[^>]*onClick=\{\(\) => void (makeCredits\(\)|makeMagnific\(true\))\}/g)).toHaveLength(2);
    expect(generate).toContain("onClick={() => void makeCloud(hidden)}");
    expect(before("src/studio/photo/panels/Tools.tsx", "<Wallet size={14} />} Get the cost", 3)).toContain("{!hidden && (");
  });

  it("a member's Prompt Box card is not held back by a price the catalog lacks; an admin's still is", () => {
    const ctx: PromptContext = { batch: "b1", posts: [{ index: 1, title: "Pistachio cup" }], openPost: 1, lastAsset: null };
    const card = resolveIntent("Animate this post using Kling through Higgsfield", ctx);
    expect(card.estimate).toBeNull();
    expect(intentRunnable(card)).toEqual({ ok: false, why: "Cost not known yet · blocked until clarified" });
    expect(intentRunnable(card, { unknownCostOk: true })).toEqual({ ok: true, why: "" });
    // Everything else still holds a member's card back: no post chosen, an open question.
    const noPost = resolveIntent("Animate the picture with Kling", { ...ctx, openPost: null });
    expect(intentRunnable(noPost, { unknownCostOk: true }).ok).toBe(false);
    // The two cards the team could not run from the box: the buttons follow the server's answer, not the role.
    const intent = src("src/studio/IntentCard.tsx");
    expect(intent).toContain("const canRun = card.canRun && runnable.ok && !card.running && !card.done;");
    expect(intent).not.toMatch(/disabled=\{!admin\}/);
    expect(src("src/studio/MediaSelection.tsx")).toContain("disabled={count < 2} onClick={onCombine}");
  });
});
