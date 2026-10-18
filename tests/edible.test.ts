import { describe, expect, it } from "vitest";
import { foreignFood } from "../shared/brief";
import { buildPostPrompt, splitEdit, withoutEdibleItems, withoutSentencesNaming } from "../shared/posts";
import { fixNote } from "../shared/qa";

describe("the reference's food never reaches a product post", () => {
  it("drops edible items from a tile line and keeps the props", () => {
    expect(withoutEdibleItems("Tile 1 (row 1, col 1, person): A person holding a tray. Product: center on tray Text: top Items: wooden tray, cinnamon rolls Background: cyan #63c7c9")).toBe(
      "Tile 1 (row 1, col 1, person): A person holding a tray. Product: center on tray Text: top Items: wooden tray Background: cyan #63c7c9",
    );
    expect(withoutEdibleItems("Items: cookie")).toBe("Items: none (the product stands there)");
    expect(withoutEdibleItems("Items: saucer, linen napkin")).toBe("Items: saucer, linen napkin");
  });
  it("names the food a shot invented beyond its products", () => {
    const shot = "A hand dips a biscuit into thick brown syrup over a creamy milkshake topped with corn flakes.";
    expect(foreignFood(shot, "drink: a clear cup of corn flakes milkshake with a teal logo")).toEqual(["biscuit", "syrup"]);
    expect(foreignFood("Omar holds a tray with the paper cup of sahlab and cinnamon rolls.", "drink: paper cup of sahlab with nuts")).toEqual(["cinnamon rolls"]);
    expect(foreignFood("The box of mini tarts on a wooden tray.", "dessert: box of mini tarts")).toEqual([]);
    expect(foreignFood("A hand holds the milkshake drink topped with yellow cornflakes.", "A creamy milkshake topped with corn flakes")).toEqual([]);
  });
});

describe("a fix note is a fresh take", () => {
  it("marks the note and reads it back", () => {
    const note = fixNote([{ kind: "ailook", text: "Looks AI-made: waxy skin" }]);
    expect(splitEdit(note)).toMatchObject({ fresh: true });
    expect(splitEdit(note).text).not.toContain("FRESH TAKE");
    expect(splitEdit("make the wall darker")).toEqual({ fresh: false, text: "make the wall darker" });
  });
  it("writes a new take instead of a revision of the rejected picture", () => {
    const brief = {
      post: true, index: 1, type: "lifestyle", title: "Omar with the cup", brief: "Omar holds the cup.", palette: ["#63c7c9"], paletteChosen: true, style: "", theme: "", format: "4:5", hasProduct: true, product: "a paper cup",
      productNames: [], grid: "Tile 1 (row 1, col 1, person): A person. Items: tray, cinnamon rolls Background: cyan", tile: "Tile 1 (row 1, col 1): A person. Items: tray, cinnamon rolls",
    } as unknown as Parameters<typeof buildPostPrompt>[0];
    const prompt = buildPostPrompt(brief, fixNote([{ kind: "size", text: "toy-sized" }]));
    expect(prompt).toContain("NEW TAKE:");
    expect(prompt).not.toContain("REVISION:");
    expect(prompt).not.toContain("cinnamon rolls");
    expect(buildPostPrompt(brief, "make the wall darker")).toContain("REVISION: make the wall darker");
    expect(buildPostPrompt({ ...brief, notInPicture: ["biscuit", "syrup"] })).toContain("NOT IN THE PICTURE: biscuit, syrup.");
  });
  it("drops the idea's sentences that name the foreign food", () => {
    const idea = "A hand dips a tan biscuit into the thick syrup of the milkshake. The wall is cyan. The syrup glistens on the corn flakes. The top is clear for the headline.";
    expect(withoutSentencesNaming(idea, ["biscuit", "syrup"])).toBe("The wall is cyan. The top is clear for the headline.");
    expect(withoutSentencesNaming("Omar holds a tray with the cup and cinnamon-rolls.", ["cinnamon rolls"])).toBe("");
    const prompt = buildPostPrompt({
      post: true, index: 3, type: "behind", title: "Choco Chips Detail", brief: idea, shot: idea, palette: [], style: "", theme: "", format: "4:5", hasProduct: true, product: "a milkshake", productNames: [], notInPicture: ["biscuit", "syrup"],
    } as unknown as Parameters<typeof buildPostPrompt>[0]);
    expect(prompt).not.toMatch(/dips a tan biscuit/);
    expect(prompt).toContain("The wall is cyan.");
  });
});
