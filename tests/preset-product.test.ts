/**
 * The product in words for a preset run (server/photo-presets.ts productBrief and
 * GET /api/studio/photo/presets/product): the Drive photo's name and note when the post's picture
 * came from the client's Drive, else the post's product photo, else its title; the brand kit's
 * rule about the product; and the words a run sends (the product first, then the change asked for).
 * Live case: an Abu Saleh cup preset ran with only "mixed fruit instead of one fruit".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, seed, type FakeEnv } from "./support/photo-mcp";
import { presetPrompt, wordsFieldOf } from "../shared/photo-presets";

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => expect(reached).toEqual([]));

const product = async (env: FakeEnv, role: "admin" | "member" = "admin", index = 1) => {
  const r = await app(role).request(`/api/studio/photo/presets/product?batch=b1&index=${index}`, {}, env);
  return { status: r.status, body: (await json(r)) as { text: string; from: string[]; error?: string } };
};

async function fromDrive(env: FakeEnv) {
  const t = Date.now();
  await env.DB.prepare("UPDATE clients SET name = 'Abu Saleh', dos = ? WHERE id = 'c1'").bind("Bright, sunlit photography\nClear cups with the turquoise wordmark, fruit cut open").run();
  await env.DB.prepare(
    "INSERT INTO drive_photos (id, client, file, folder, role, name, kind, note, status, md5, modified, version, updated) VALUES ('drv1', 'c1', 'IMG_1.JPG', 'Drinks', 'product', 'Mango melon fruit cocktail', 'drink', 'A thick orange fruit drink in a clear cup.', 'read', 'm', '2026-09-06T09:00:00.000Z', 1, ?)",
  )
    .bind(t)
    .run();
  await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([1, 2, 3]).buffer, { customMetadata: { drive: "drv1" } });
}

describe("the product in words", () => {
  it("names the Drive photo the picture came from, says to keep it, and adds the post idea and the brand kit's product rule", async () => {
    const env = await seed();
    await fromDrive(env);
    const { status, body } = await product(env);
    expect(status).toBe(200);
    expect(body.from).toEqual(["the client's Drive", "the brand kit"]);
    expect(body.text).toContain("Abu Saleh's product: Mango melon fruit cocktail — A thick orange fruit drink in a clear cup.");
    expect(body.text).toContain("keep it exactly as it is");
    expect(body.text).toContain("Post idea: A cup");
    expect(body.text).toContain("Brand look: Clear cups with the turquoise wordmark, fruit cut open");
    expect(body.text).not.toContain("Bright, sunlit");
  });

  it("traces an edited picture back to the Drive photo through the post's first take", async () => {
    const env = await seed();
    await fromDrive(env);
    await env.BUCKET.put("u2/b1/output/t1/a.png", new Uint8Array([1]).buffer);
    await env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, created) VALUES ('k1', 'b1', 1, 't1', 'made', 'u2/b1/output/t1/first.png', 1)").run();
    await env.BUCKET.put("u2/b1/output/t1/first.png", new Uint8Array([1]).buffer, { customMetadata: { drive: "drv1" } });
    const { body } = await product(env);
    expect(body.from[0]).toBe("the client's Drive");
    expect(body.text).toContain("Mango melon fruit cocktail");
  });

  it("falls back to the post's product photo, then to the post's title", async () => {
    const env = await seed();
    await env.DB.prepare("UPDATE batches SET config = json_set(config, '$.plan[0].product', 'cup') WHERE id = 'b1'").run();
    let r = await product(env);
    expect(r.body.from).toEqual(["the post's product photo"]);
    expect(r.body.text).toContain("Sample's product: cup.");
    await env.DB.prepare("UPDATE batches SET config = json_remove(config, '$.plan[0].product') WHERE id = 'b1'").run();
    r = await product(env);
    expect(r.body.from).toEqual(["the post's title"]);
    expect(r.body.text).toContain("Sample's product: Cup.");
    await env.DB.prepare("UPDATE batches SET config = json_set(config, '$.plan[0].title', '01-talk') WHERE id = 'b1'").run();
    r = await product(env);
    expect(r.body.from).toEqual([]);
    expect(r.body.text).toMatch(/^The product\b|^It is the item/);
  });

  it("is for the month's owner or an admin only, and needs a post", async () => {
    const env = await seed();
    expect((await product(env, "member")).status).toBe(200);
    expect((await product(env, "admin", 0)).status).toBe(400);
    await env.DB.prepare("UPDATE batches SET owner = 'u1' WHERE id = 'b1'").run();
    expect((await product(env, "member")).status).toBeGreaterThanOrEqual(400);
  });
});

describe("the words a preset run sends", () => {
  it("puts the product first and the change after it", () => {
    expect(presetPrompt("Abu Saleh's product: a mango cup.", "mixed fruit instead of one fruit ")).toBe("Abu Saleh's product: a mango cup.\n\nChange for this picture: mixed fruit instead of one fruit");
    expect(presetPrompt("A mango cup.", "  ")).toBe("A mango cup.");
    expect(presetPrompt(" ", "mixed fruit")).toBe("mixed fruit");
  });

  it("uses the preset's prompt input, else its first text input", () => {
    expect(wordsFieldOf([{ name: "mood", label: "Mood" }, { name: "prompt", label: "Describe your result" }])).toBe("prompt");
    expect(wordsFieldOf([{ name: "notes", label: "Describe your result" }])).toBe("notes");
    expect(wordsFieldOf([{ name: "mood", label: "Mood" }])).toBe("mood");
    expect(wordsFieldOf([])).toBeNull();
  });
});
