import { describe, expect, it } from "vitest";
import { demoAnswer } from "../server/demo";
import { BRIEF_PLAN_SCHEMA, parseBriefPlan } from "../shared/campaign";
import { GRID_SCHEMA, IDEAS_SCHEMA, parseIdeas, PALETTE_SCHEMA, THEME_SCHEMA } from "../shared/posts";
import { BRIEF_SCHEMA, parseBrief, SHOTS_SCHEMA } from "../shared/brief";
import { ADAPT_SCHEMA } from "../shared/styles";

const PRODUCTS = "PRODUCTS AVAILABLE AS PHOTOS (use the exact names):\n- Blue lagoon mojito: a blue cup\n- Iced karak: a tea cup\n\nTONE: warm";

describe("demo fixtures", () => {
  it("plan ideas the parser accepts, naming the instruction's products and count", () => {
    const text = demoAnswer(`You are planning 5 Instagram posts for the client "X".\n${PRODUCTS}\nReturn ONLY JSON with exactly 5 posts.`, IDEAS_SCHEMA);
    const posts = parseIdeas(text, 5, ["Blue lagoon mojito", "Iced karak"]);
    expect(posts).toHaveLength(5);
    expect(posts.map((p) => p.product)).toEqual(["Blue lagoon mojito", "Iced karak", "Blue lagoon mojito", "Iced karak", "Blue lagoon mojito"]);
    expect(posts[0].brief).toMatch(/DEMO FIXTURE/);
  });

  it("plan a brief with its carousel and colours", () => {
    const text = demoAnswer(`THE DESIGNER'S BRIEF: 4 posts and a 3-slide carousel in sky blue #0a7bd6.\n${PRODUCTS}`, BRIEF_PLAN_SCHEMA);
    const plan = parseBriefPlan(JSON.parse(text), ["Blue lagoon mojito", "Iced karak"], 1, () => "g");
    expect(plan.posts).toHaveLength(7);
    expect(plan.posts.filter((p) => p.post.group?.kind === "carousel")).toHaveLength(3);
    expect(plan.colours).toEqual([{ name: "colour 1", hex: "#0a7bd6" }]);
    expect(plan.summary).toMatch(/DEMO FIXTURE/);
  });

  it("read a grid into nine tiles and tile-numbered posts, a theme, shots, a note, colours and a style", () => {
    const grid = JSON.parse(demoAnswer(`plan 6 posts for the client "X".\n${PRODUCTS}`, GRID_SCHEMA));
    expect(grid.tiles).toHaveLength(9);
    expect(grid.posts).toHaveLength(6);
    expect(grid.posts[2].title).toMatch(/^T3 · /);
    const theme = JSON.parse(demoAnswer("references", THEME_SCHEMA));
    expect(theme.shots).toHaveLength(3);
    expect(theme.palette[0].hex).toMatch(/^#/);
    const shots = JSON.parse(demoAnswer("Post 2 (product): a\nPost 5 (product): b", SHOTS_SCHEMA));
    expect(shots.shots.map((s: { post: number }) => s.post)).toEqual([2, 5]);
    const note = parseBrief(JSON.parse(demoAnswer("CLIENT: X", BRIEF_SCHEMA)));
    expect(note.summary).toMatch(/DEMO FIXTURE/);
    expect(JSON.parse(demoAnswer("x", PALETTE_SCHEMA)).palette).toHaveLength(4);
    expect(JSON.parse(demoAnswer("x", ADAPT_SCHEMA))).toEqual({ prompt: expect.stringMatching(/DEMO/), brief: expect.stringMatching(/DEMO/) });
  });
});
