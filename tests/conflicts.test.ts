import { describe, expect, it } from "vitest";
import { blockingConflicts, constraintsOf, detectConflicts, guideFor, precedenceLine, presentIn } from "../shared/conflicts";

describe("input conflicts", () => {
  const brief = { text: "Plan 6 posts of the drinks in the street, no people in any picture, no text in the pictures." };
  it("reads constraints and presences from words, English and Arabic", () => {
    expect(constraintsOf(brief.text)).toEqual(["people", "text"]);
    expect(constraintsOf("صور المنتج بدون ناس وبدون كتابة")).toEqual(["people", "text"]);
    expect(presentIn("A woman's hand holds the cup against a yellow wall.")).toEqual(["people", "hands"]);
    expect(presentIn("The cup on a kerb, no people, hard shadow.")).toEqual([]);
  });
  it("a style that brings a hand into a no-people brief is a conflict, not a quiet fix", () => {
    const c = detectConflicts({ campaign: brief, post: { brief: "The mango cup in the bike-lane sign.", scene: "" }, style: { title: "Held up", prompt: "A hand holds the cup up against the sky, soft light." } });
    expect(c).toEqual([{ kind: "people", source: "style", against: "brief", allowed: false, text: "The style brings in a hand; the brief asks for no people." }]);
    expect(blockingConflicts(c).length).toBe(1);
  });
  it("an exception allowed on the post keeps the note but no longer blocks; a post that names people has no people conflict", () => {
    const allowed = detectConflicts({ campaign: brief, post: { brief: "x", allow: ["people"] }, style: { prompt: "A hand holds the cup." } });
    expect(allowed[0]?.allowed).toBe(true);
    expect(blockingConflicts(allowed)).toEqual([]);
    const named = detectConflicts({ campaign: brief, post: { brief: "x", people: ["Lina"] }, style: { prompt: "A woman holds the cup." } });
    expect(named.filter((c) => c.kind === "people")).toEqual([]);
  });
  it("a shot written from the style settles the style's hand: the shot's own 'no people' line is no conflict with the style's prompt", () => {
    // 27 Oct: three of Abu Saleh's posts were held back because their style's prompt names a hand
    // while the shot the writer made from it ends "No people, hands or other food appear".
    const style = { title: "Tic-Tac-Toe Play", prompt: "A hand places the product on a tic-tac-toe grid drawn in red crayon." };
    const dropped = detectConflicts({ post: { brief: "", scene: "Top-down shot of a tic-tac-toe grid in red crayon, four pots of the dessert on the squares, sharp shadows. No people, hands, drinks or other food appear.", sceneFromStyle: true }, style });
    expect(blockingConflicts(dropped)).toEqual([]);
    // Kept on purpose ("a man's hand ... no people besides the hand"): still no conflict with itself.
    const kept = detectConflicts({ post: { brief: "A man's hand bursts out of a sea of ice holding the smoothie.", scene: "Top-down: a man's bare hand rises from the ice cubes gripping the cup. No people besides the hand, and no text except the product's own logo.", sceneFromStyle: true }, style: { title: "Ice Cube Mosaic", prompt: "The brand ambassador's hand rises from the ice cubes gripping the product." } });
    expect(blockingConflicts(kept)).toEqual([]);
    // The brief's own "no people" still holds against a shot that brings a hand in.
    const brief = detectConflicts({ campaign: { text: "No people in any picture." }, post: { brief: "x", scene: "A man's hand rises from the ice gripping the cup.", sceneFromStyle: true }, style });
    expect(blockingConflicts(brief).map((c) => [c.kind, c.source, c.against])).toEqual([["people", "style", "brief"]]);
    // Without the flag, the style's raw prompt is still read against the post's words.
    const raw = detectConflicts({ post: { brief: "", scene: "No people appear." }, style });
    expect(blockingConflicts(raw).length).toBe(1);
  });
  it("a grid tile with a croissant against a brand that sells no food, and a brand rule against writing", () => {
    const c = detectConflicts({ brand: { donts: "The brand sells no food.", rules: "No writing in the picture." }, post: { brief: "x", tileSpec: { scene: "A croissant beside the cup, bold text across the top." } } });
    expect(c.map((x) => [x.kind, x.source, x.against]).sort()).toEqual([
      ["food", "grid tile", "brand kit"],
      ["text", "grid tile", "brand kit"],
    ]);
  });
  it("the five guide layers name their sources", () => {
    const layers = guideFor({ brand: { rules: "The cup is always whole with its dome lid.", colours: [] }, campaign: { text: brief.text, summary: "Every drink in a road sign." }, post: { brief: "The mango cup in the roundabout sign.", headline: "لفّة وحدة", caption: "Turn once.", product: "Mango smoothie" }, style: { title: "Sign", prompt: "The cup in a round sign at eye level." }, palette: ["#0a7bd6", "#f2c200"] });
    expect(layers.map((l) => l.id)).toEqual(["product", "constraints", "composition", "light", "words"]);
    expect(layers[0].items[0]).toEqual({ text: "Mango smoothie: drawn from its photo, as the photo shows it", from: "post" });
    expect(layers[1].items.map((i) => i.from)).toContain("brief");
    expect(layers[2].items[0].from).toBe("style");
    expect(layers[4].items[0].text).toContain("drawn here on the picture");
  });
  it("input precedence is one plain sentence, said for the way the month was started", () => {
    expect(precedenceLine("brief")).toBe("On one post the product photo wins, then a picture pinned to the post; the brief keeps the words and colours, and brand rules apply on top of all of them.");
    expect(precedenceLine("brief", { grid: true, theme: true })).toBe("On one post the product photo wins, then a picture pinned to the post, then the grid tile, then the theme references; the brief keeps the words and colours, and brand rules apply on top of all of them.");
    expect(precedenceLine("style")).toBe("On one post the product photo wins, then a picture pinned to the post, then the post's style; the style writes that post's idea and shot, and brand rules apply on top of all of them.");
    expect(precedenceLine("grid")).toContain("then the grid tile; the brief supplies the words");
    expect(precedenceLine("refs")).toContain("then the theme references; the references set only the light and palette");
  });
});

import { lessonLine, preflightInstruction } from "../shared/qa";

describe("the preflight and the lessons around a picked style (post 10, 28 Oct)", () => {
  it("keeps a style picture attached for its product and printed words", () => {
    const text = preflightInstruction({ client: "Abu Saleh", scene: "Two piles of chocolate frame the cup.", products: ["Hot chocolate in a teal cup"], people: [], reference: "style", lessons: [] });
    expect(text).toContain("never a reason to leave the image out");
    expect(text).toContain("dropReference is true only when it shows people");
    expect(text).toContain("the product's own ingredients and flavours set around it as props");
    const tile = preflightInstruction({ client: "Abu Saleh", scene: "x", products: [], people: [], reference: "tile", lessons: [] });
    expect(tile).toContain("tends to copy everything in it");
  });
  it("never describes the wrong picture in an idea lesson", () => {
    const line = lessonLine("idea", "Not like its idea: the cup stands on a cork pedestal with cinnamon");
    expect(line).not.toContain("cork");
    expect(line).toContain("drifted from its idea.");
  });
});
