/**
 * The brand block (shared/brandMemory.ts): what an AI edit and a video carry about the client after
 * the typed words. An edit gets limits only, a video the brand's rules; both stay short, lose whole
 * rules when they must give way, are never added twice, and are nothing at all for an empty kit.
 */
import { describe, expect, it } from "vitest";
import { asksForWords, BRAND_BLOCK_MAX, brandBlock, fitBrandBlock, memoryLine, stripBrandBlock, withBrandBlock, type BrandKit } from "../shared/brandMemory";
import { videoIdeaInstruction } from "../shared/qa";
import { blocksIn, COLOUR, EDIT_LABEL, KIT, NEVER, VIDEO_LABEL } from "./support/brand-kit";

const MEMORY = [
  memoryLine("brand_rule", "rule", "No red backgrounds"),
  memoryLine("brand_rule", "rule", "The logo sits in the top right corner"),
  memoryLine("campaign_instruction", "rule", "Autumn leaves, never snow"),
  memoryLine("post_instruction", "rule", "Show the tray from above"),
  memoryLine("lesson", "people", "An earlier picture showed a stranger"),
];

describe("the brand block of an edit", () => {
  it("is limits only: the never rules, the brand's and the month's approved rules, the image rules, the colours of what is added", () => {
    const block = brandBlock(KIT, MEMORY, "edit");
    expect(block).toBe(
      [
        `${EDIT_LABEL} (keep everything not named above exactly as it is; these apply only to what is added or changed):`,
        "- Colours of anything added stay within: deep blue #0042aa, cream #f5e9d0.",
        "- NEVER: No plastic cups.",
        "- Brand rule: No red backgrounds.",
        "- This month: Autumn leaves, never snow.",
        "- Every box keeps its printed lid.",
        "- If a person is added or changed: Women wear modest clothing with long sleeves.",
      ].join("\n"),
    );
    expect(block).toContain(NEVER);
    expect(block).toContain(COLOUR);
  });

  it("leaves out what would pull an edit away from its picture: ALWAYS scenes, the photography direction, one post's instructions, lessons, layout rules", () => {
    const block = brandBlock({ ...KIT, ...({ style: "Warm family hospitality", tone: "Playful", audience: "Families" } as object) }, MEMORY, "edit");
    for (const absent of ["brass tray", "50mm", "Show the tray from above", "stranger", "logo", "Warm family", "Playful", "Families", "ALWAYS"]) expect(block).not.toContain(absent);
  });

  it("keeps the photo part of a mixed rule, as the generated posts do, and never says NEVER twice", () => {
    const block = brandBlock({ donts: "Never show glass bottles\nNo gradients, frames, stickers or shadows" }, [memoryLine("brand_rule", "rule", "No steam, logos or smoke")], "edit");
    expect(block.split("\n").slice(1)).toEqual(["- NEVER: show glass bottles.", "- NEVER: No gradients, frames or shadows.","- Brand rule: No steam or smoke."]);
  });

  it("drops the 'keep everything else' line for a tool that makes a new picture, and the colours for a relight", () => {
    const remake = brandBlock(KIT, [], "edit", { keepRest: false });
    expect(remake.split("\n")[0]).toBe(`${EDIT_LABEL} (they apply to everything this picture adds or changes):`);
    expect(remake).toContain(COLOUR);
    const relight = brandBlock(KIT, [], "edit", { colours: false });
    expect(relight).toContain(NEVER);
    expect(relight).not.toContain("#0042aa");
  });
});

describe("the brand block of a video", () => {
  it("carries the never rules, the colours, how people look, the approved rules, the image rules and the photography direction", () => {
    const block = brandBlock(KIT, MEMORY, "video");
    expect(block).toBe(
      [
        `${VIDEO_LABEL} (for everything that moves, enters or changes in the clip; none of this is shown as words):`,
        "- Colours of anything that enters or changes stay within: deep blue #0042aa, cream #f5e9d0.",
        "- NEVER: No plastic cups.",
        "- People: Women wear modest clothing with long sleeves.",
        "- Brand rule: No red backgrounds.",
        "- This month: Autumn leaves, never snow.",
        "- Every box keeps its printed lid.",
        "- Camera and light: 50mm, eye level, soft window light.",
      ].join("\n"),
    );
    // The ALWAYS scene, a post's own instruction and a lesson stay out of a clip too.
    for (const absent of ["brass tray", "Show the tray from above", "stranger"]) expect(block).not.toContain(absent);
  });

  it("names the language only when the idea asks for words on screen or a voice", () => {
    expect(brandBlock(KIT, [], "video")).not.toContain("Arabic");
    expect(brandBlock(KIT, [], "video", { words: true })).toContain("- Any words on screen or spoken are in Arabic.");
    expect(brandBlock({ ...KIT, language: "both" }, [], "video", { words: true })).toContain("in Arabic and English.");
    expect(asksForWords("She lifts the cup and says welcome to camera")).toBe(true);
    expect(asksForWords("A title card with words on screen at the end")).toBe(true);
    expect(asksForWords("The steam rises. No text appears; no new objects or people.")).toBe(false);
    expect(asksForWords("The cup turns slowly, no voiceover")).toBe(false);
  });
});

describe("an empty kit", () => {
  it("adds nothing, and never invents a rule or a colour", () => {
    const empty: BrandKit = { colors: "[]", dos: "", donts: "", image_rules: null, photography: null, language: "ar" };
    expect(brandBlock(empty, [], "edit")).toBe("");
    expect(brandBlock(empty, [], "video", { words: true })).toBe("");
    expect(brandBlock(null, [], "edit")).toBe("");
    expect(brandBlock({ colors: "not json" }, [memoryLine("lesson", "people", "a lesson only")], "video")).toBe("");
    // A kit whose only never-rule is about the layout has nothing for the picture.
    expect(brandBlock({ donts: "No logos in the corners" }, [], "edit")).toBe("");
    expect(withBrandBlock("warm light", "")).toEqual({ text: "warm light", block: "" });
  });
});

describe("the length caps", () => {
  const long: BrandKit = { ...KIT, donts: Array.from({ length: 30 }, (_, i) => `No prop number ${i + 1} made of shiny plastic anywhere`).join("\n") };

  it("keeps an edit to 600 characters and a video to 900, cutting whole rules from the end", () => {
    const edit = brandBlock(long, [], "edit");
    const video = brandBlock(long, [], "video");
    expect(BRAND_BLOCK_MAX).toEqual({ edit: 600, video: 900 });
    expect(edit.length).toBeLessThanOrEqual(600);
    expect(video.length).toBeLessThanOrEqual(900);
    expect(video.length).toBeGreaterThan(edit.length);
    for (const b of [edit, video]) {
      // Every line is a whole rule ending in its full stop; the colours and the first never-rules are the ones kept.
      for (const line of b.split("\n").slice(1)) expect(line).toMatch(/^- .+\.$/);
      expect(b).toContain(COLOUR);
      expect(b).toContain("- NEVER: No prop number 1 made of shiny plastic anywhere.");
      expect(b).not.toContain("No prop number 30");
    }
    // A caller may ask for less, never for more.
    expect(brandBlock(long, [], "edit", { max: 300 }).length).toBeLessThanOrEqual(300);
    expect(brandBlock(long, [], "edit", { max: 5000 }).length).toBeLessThanOrEqual(600);
  });

  it("takes a long rule by its sentences and leaves out a sentence that cannot fit, never half of one", () => {
    const sentence = `Never show ${"very ".repeat(60)}old props.`;
    const block = brandBlock({ image_rules: `${sentence} Every box keeps its printed lid.` }, [], "edit");
    expect(block).toContain("- Every box keeps its printed lid.");
    expect(block).not.toContain("very very");
  });

  it("gives way to the typed words at a provider limit: they stay whole, the block loses rules or goes", () => {
    const block = brandBlock(KIT, MEMORY, "edit");
    const typed = "x".repeat(700);
    const fits = withBrandBlock(typed, block, 2000);
    expect(fits.text).toBe(`${typed}\n\n${block}`);
    const tight = withBrandBlock(typed, block, 700 + 2 + 250);
    expect(tight.text.startsWith(`${typed}\n\n${EDIT_LABEL}`)).toBe(true);
    expect(tight.text.length).toBeLessThanOrEqual(952);
    expect(tight.block).toContain(COLOUR);
    expect(tight.block.split("\n").length).toBeLessThan(block.split("\n").length);
    expect(tight.block.endsWith(".")).toBe(true);
    // No room for even one rule: the typed words go alone.
    expect(withBrandBlock(typed, block, 760)).toEqual({ text: typed, block: "" });
    expect(withBrandBlock("y".repeat(2000), block, 2000)).toEqual({ text: "y".repeat(2000), block: "" });
    expect(fitBrandBlock(block, 10)).toBe("");
  });
});

describe("never twice", () => {
  it("recognises its own label, takes an earlier block off and puts the fresh one on", () => {
    const edit = brandBlock(KIT, MEMORY, "edit");
    const video = brandBlock(KIT, MEMORY, "video");
    const once = withBrandBlock("warm evening light from the left", edit);
    expect(blocksIn(once.text)).toBe(1);
    expect(stripBrandBlock(once.text)).toBe("warm evening light from the left");
    // A retry of the stored text, a revise of a revise, a clip made from an edit's words.
    const twice = withBrandBlock(once.text, edit);
    expect(twice.text).toBe(once.text);
    const asVideo = withBrandBlock(twice.text, video);
    expect(blocksIn(asVideo.text)).toBe(1);
    expect(asVideo.text).toBe(`warm evening light from the left\n\n${video}`);
    // The kit changed since: the old block goes, the new one stands.
    const changed = withBrandBlock(once.text, brandBlock({ donts: "No glass" }, [], "edit"));
    expect(changed.text).not.toContain("plastic cups");
    expect(changed.text).toContain("- NEVER: No glass.");
    // Words with no block are returned exactly as typed.
    expect(stripBrandBlock("  keep my spaces  ")).toBe("  keep my spaces  ");
  });

  it("adds nothing where nothing was typed: no prompt is invented", () => {
    const block = brandBlock(KIT, [], "edit");
    expect(withBrandBlock("", block)).toEqual({ text: "", block: "" });
    expect(withBrandBlock("   ", block)).toEqual({ text: "   ", block: "" });
  });
});

describe("the motion idea writer", () => {
  const ask = { client: "Sample", type: "Product", title: "Cup", brief: "A cup on a marble counter" };

  it("is told the client's rules so the idea it writes stays inside them, and is unchanged for an empty kit", () => {
    const block = brandBlock(KIT, MEMORY, "video");
    const told = videoIdeaInstruction({ ...ask, brand: block });
    expect(told).toContain(`THE CLIENT'S OWN RULES (the idea stays inside them and never asks for anything they forbid; do not repeat them in the idea):\n${block}`);
    expect(told).toContain(NEVER);
    expect(told).toContain(COLOUR);
    expect(told.endsWith('Return ONLY JSON: {"idea": "...", "reason": "a few words"}.')).toBe(true);
    const plain = videoIdeaInstruction(ask);
    expect(plain).not.toContain("THE CLIENT'S OWN RULES");
    expect(videoIdeaInstruction({ ...ask, brand: "" })).toBe(plain);
    expect(told.replace(/THE CLIENT'S OWN RULES[\s\S]*?\n\n(?=Return ONLY)/, "")).toBe(plain);
  });
});
