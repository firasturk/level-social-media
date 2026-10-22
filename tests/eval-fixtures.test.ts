import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { METHODS, run } from "../eval/providers/studio";
import { planCounts } from "../eval/providers/plan-scope";
import { FULL_PLAN } from "../eval/providers/fixtures";

/**
 * The eval providers (eval/providers/*.ts) run offline and return parseable output, so CI covers
 * what `npm run eval` checks even where promptfoo is not installed. A fetch guard fails the test
 * on any network call.
 */
let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

const BRIEF = "Plan 2 posts, each a single picture of one shake inside a road sign under noon sun. Post 1 the pistachio shake, post 2 the mango shake. No people in the pictures.";

describe("every eval method answers offline with JSON-safe output", () => {
  for (const method of Object.keys(METHODS))
    it(method, async () => {
      const out = await run(method, { brief: BRIEF, text: "make the logo larger" });
      expect(out.method).toBe(method);
      expect(() => JSON.stringify(out)).not.toThrow();
      expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    });

  it("an unknown method is a clear error", async () => {
    await expect(run("nope")).rejects.toThrow(/Unknown eval method/);
  });
});

describe("the four creation methods", () => {
  it("Quick Campaign: a brief for 2 posts after 3 existing plans posts 4 and 5 with the no-people rule", async () => {
    const out = (await run("brief-plan", { brief: BRIEF, existing: 3 })) as { counts: Record<string, unknown>; instruction: string };
    expect(out.counts).toMatchObject({ designs: 2, posts: 2, firstIndex: 4, lastIndex: 5, carousels: [] });
    expect(out.instruction).toContain("The month already has 3 posts; yours come after them.");
    expect(out.instruction).toContain("NEVER: no people in the pictures");
  });

  it("Follow a grid: nine tiles with one text tile, nine posts", async () => {
    const out = (await run("grid-ideas", { count: 9 })) as { counts: Record<string, number> };
    expect(out.counts).toMatchObject({ tiles: 9, textTiles: 1, posts: 9, picturesIfTextTilesDrawnHere: 8 });
  });

  it("Use theme references: three pins read into three shots, then one shot per post", async () => {
    const analysed = (await run("theme-analyse", { references: 3 })) as { counts: { shots: number } };
    expect(analysed.counts.shots).toBe(3);
    const shots = (await run("theme-shots", {})) as { counts: Record<string, number>; shots: { post: number; ref: number }[] };
    expect(shots.counts).toMatchObject({ posts: 3, shots: 3, postsWithShot: 3 });
    expect(shots.shots.every((s) => s.ref >= 1)).toBe(true);
  });

  it("One post from a style: the style is written for the real product", async () => {
    const out = (await run("style-scene", { style: "sign" })) as { scene: string; instruction: string };
    expect(out.scene.length).toBeGreaterThan(10);
    expect(out.instruction).toContain('THE STYLE "Sign symbol"');
    expect(out.instruction).toContain("pale green pistachio milkshake");
  });
});

describe("counts, append and replace", () => {
  it("planShape and planCounts agree on the full month", async () => {
    const out = (await run("plan-scope", { plan: "full" })) as { shape: string; counts: ReturnType<typeof planCounts> };
    expect(out.counts).toEqual({ posts: 9, designs: 13, pictures: 12, textTiles: 1, carousels: [5] });
    expect(out.shape).toBe("9 posts, one a 5-slide carousel: 13 designs, 12 pictures to make and 1 text tile drawn here.");
    expect(planCounts(FULL_PLAN)).toEqual(out.counts);
  });

  it("append keeps the first three posts unchanged and numbers the new ones 4 and 5", async () => {
    const out = (await run("plan-scope", { brief: BRIEF, only: false })) as Record<string, unknown>;
    expect(out).toMatchObject({ existing: 3, added: 2, total: 5, indexes: [1, 2, 3, 4, 5], firstUnchanged: true });
  });

  it("replace (only) leaves the two new posts alone", async () => {
    const out = (await run("plan-scope", { brief: BRIEF, only: true })) as Record<string, unknown>;
    expect(out).toMatchObject({ existing: 0, added: 2, total: 2, indexes: [1, 2] });
  });
});

describe("constraints, memory, references and hand edits in the prompts", () => {
  it("a hand style on a no-people brand: the constraint reaches the writer", async () => {
    const out = (await run("style-scene", { style: "hand" })) as { instruction: string; conflicts: { todo: boolean; notes: string[] } };
    expect(out.instruction).toContain("NEVER: no people in the pictures\nno hands");
    expect(out.instruction).toContain("A hand raises the product high");
    // TODO shared/conflicts.ts detectConflicts: when it lands, a people/hand conflict must be named.
    if (!out.conflicts.todo) expect(out.conflicts.notes.some((n) => /people|person|hand/i.test(n))).toBe(true);
  });

  it("approved lessons are in the image prompt, pending and rejected ones are not", async () => {
    const out = (await run("post-prompt", { variant: "theme" })) as { prompt: string; memory: { approved: string[]; unapproved: string[] } };
    expect(out.memory.approved.length).toBeGreaterThan(0);
    for (const l of out.memory.approved) expect(out.prompt).toContain(l);
    for (const l of out.memory.unapproved) expect(out.prompt).not.toContain(l);
    expect(out.prompt).toContain("NEVER: no people in the pictures");
  });

  it("image 1 is the product photo and the references follow in postImages order", async () => {
    const theme = (await run("post-prompt", { variant: "theme" })) as { firstImage: { from: number; role: string }; highestImage: number; expectedImages: number; prompt: string };
    expect(theme.firstImage).toMatchObject({ from: 1, role: "the product photo" });
    expect(theme.highestImage).toBe(2);
    expect(theme.expectedImages).toBe(2);
    const many = (await run("post-prompt", {
      variant: "style",
      brief: { extraProducts: [{ name: "mango shake", note: "a tall clear cup of orange mango shake", key: "u1/b1/src/s2.jpg" }], ambassadors: [{ name: "Lina", description: "woman, 30s", key: "amb/lina.jpg" }] },
    })) as { highestImage: number; expectedImages: number; prompt: string };
    expect(many.highestImage).toBe(4);
    expect(many.expectedImages).toBe(4);
    const order = ["Images 1 to 2 are product photos", "Image 3 is the portrait of the brand's ambassador", "Image 4 is the style the designer picked"].map((t) => many.prompt.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("a hand-edited shot and headline survive into the prompts", async () => {
    // Product file names never reach the engine (they become "the product"), so the edit says "the cup".
    const shot = "HAND-EDITED SHOT: the cup rests on a yellow kerb at dusk, 50 mm.";
    const post = (await run("post-prompt", { variant: "theme", brief: { shot } })) as { prompt: string };
    expect(post.prompt).toContain(shot);
    const scene = (await run("style-scene", { style: "sign", headline: "Hand-edited headline" })) as { instruction: string };
    expect(scene.instruction).toContain('headline "Hand-edited headline"');
  });

  it("feedback interpretation is a TODO until shared/feedback.ts lands", async () => {
    const expected: Record<string, string> = { "make the logo larger": "layer", "remove the cup": "image", "the second one": "ambiguous" };
    for (const [text, kind] of Object.entries(expected)) {
      const out = (await run("feedback", { text })) as { todo: boolean; kind?: string };
      if (!out.todo) expect(out.kind).toBe(kind);
    }
  });
});

describe("prompt snapshots under eval/snapshots", () => {
  const dir = join(process.cwd(), "eval", "snapshots");
  const variants: Record<string, string> = { "post-prompt-brief-campaign": "brief", "post-prompt-grid-tile": "grid", "post-prompt-theme-reference": "theme", "post-prompt-gallery-style": "style" };

  it("the four creation methods' prompts match their stored snapshots", async () => {
    expect(existsSync(dir)).toBe(true);
    for (const [name, variant] of Object.entries(variants)) {
      const file = join(dir, `${name}.txt`);
      expect(existsSync(file), `missing ${file}: run npm run eval:update`).toBe(true);
      const out = (await run("post-prompt", { variant })) as { prompt: string };
      expect(out.prompt, name).toBe(readFileSync(file, "utf8"));
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".txt")).length).toBeGreaterThanOrEqual(4);
  });
});
