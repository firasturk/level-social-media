/**
 * Pictures cut to another frame for free (server/picture-frame.ts) and the planner chat's "frame"
 * action: the chat sees each picture's size, a crop keeps the middle and the previous picture as a
 * version, a picture already in the frame is left alone, and a size request never asks for new
 * pictures. (Live: "crop all the photos to 4:5" was answered "done" with nothing done, then "made
 * again" was offered, which costs money; the pictures were already 4:5.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotonImage } from "@cf-wasm/photon";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, postJson, seed, type FakeEnv } from "./support/photo-mcp";
import { centreBox, frameOf, framePostPicture, sizeLabel, storedSize } from "../server/picture-frame";
import { ideasChatInstruction, parseIdeasChat } from "../shared/ideas-chat";
import { imageSize } from "../server/image-size";
import type { Config } from "../shared/config";
import type { Post } from "../shared/posts";

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(reached).toEqual([]);
});

function png(width: number, height: number): ArrayBuffer {
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    const x = (i / 4) % width;
    px[i] = x < width / 2 ? 200 : 20;
    px[i + 3] = 255;
  }
  const img = new PhotonImage(px, width, height);
  const out = img.get_bytes();
  img.free();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

const config = async (env: FakeEnv) => JSON.parse(((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first()) as { config: string }).config) as Config;
const output = async (env: FakeEnv) => ((await env.DB.prepare("SELECT output FROM tasks WHERE batch = 'b1' AND post = 1").first()) as { output: string }).output;

describe("frames", () => {
  it("names a size's frame and finds the middle box", () => {
    expect(frameOf({ width: 1086, height: 1358 })).toBe("4:5");
    expect(frameOf({ width: 1365, height: 1365 })).toBe("1:1");
    expect(frameOf({ width: 1080, height: 1920 })).toBe("9:16");
    expect(frameOf({ width: 1600, height: 900 })).toBeNull();
    expect(sizeLabel({ width: 1792, height: 2240 })).toBe("1792×2240 (4:5)");
    expect(centreBox(1000, 1000, "4:5")).toEqual({ x1: 100, y1: 0, x2: 900, y2: 1000 });
    expect(centreBox(800, 1600, "4:5")).toEqual({ x1: 0, y1: 300, x2: 800, y2: 1300 });
  });

  it("cuts a square picture to 4:5, keeps the old one as a version, and leaves a 4:5 picture alone", async () => {
    const env = await seed();
    await env.BUCKET.put("u2/b1/output/t1/a.png", png(100, 100), { httpMetadata: { contentType: "image/png" } });
    const cfg = await config(env);
    expect(await framePostPicture(env, { id: "b1", owner: "u2" }, cfg, 1, "4:5")).toBe("cropped");
    const key = await output(env);
    expect(key).not.toBe("u2/b1/output/t1/a.png");
    expect(await storedSize(env, key)).toEqual({ width: 80, height: 100 });
    expect(imageSize(await (await env.BUCKET.get("u2/b1/output/t1/a.png"))!.arrayBuffer())).toEqual({ width: 100, height: 100 });
    const take = (await env.DB.prepare("SELECT note, cost FROM post_takes WHERE batch = 'b1' AND post = 1").first()) as { note: string; cost: number };
    expect(take).toMatchObject({ cost: 0 });
    expect(take.note).toContain("Cut to 4:5 from 100×100 (1:1)");
    expect(((await env.DB.prepare("SELECT label FROM month_versions WHERE batch = 'b1'").first()) as { label: string }).label).toBe("Post 1 before the crop to 4:5");
    expect(await framePostPicture(env, { id: "b1", owner: "u2" }, cfg, 1, "4:5")).toBe("already");
  });

  it("keeps the client's answered version and puts the cut beside it", async () => {
    const env = await seed();
    await env.BUCKET.put("u2/b1/output/t1/a.png", png(100, 100), { httpMetadata: { contentType: "image/png" } });
    const cfg = { ...(await config(env)), approvals: { "1": { status: "approved", at: 1 } } } as unknown as Config;
    expect(await framePostPicture(env, { id: "b1", owner: "u2" }, cfg, 1, "4:5")).toBe("held");
    expect(await output(env)).toBe("u2/b1/output/t1/a.png");
  });
});

describe("the chat", () => {
  it("shows each picture's size and the frame action, and never offers a remake for a size", () => {
    const plan = [{ index: 1, type: "product", title: "Cup", brief: "A cup", caption: "", hashtags: "" } as Post];
    const text = ideasChatInstruction({ client: "C", month: "2026-10", posts: plan, products: [], history: [], message: "crop all to 4:5", pictures: { 1: "1086×1358 (4:5)" }, format: "4:5" });
    expect(text).toContain("picture: 1086×1358 (4:5)");
    expect(text).toContain("THE MONTH'S FRAME: 4:5");
    expect(text).toContain("Never use make to change a size or crop");
    expect(parseIdeasChat({ reply: "ok", actions: [{ op: "frame", post: 0, posts: [], fields: {}, format: "4:5" }, { op: "frame", posts: [1], format: "16:9" }] }, plan, [], "2026-10").actions).toEqual([{ op: "frame", indexes: [], format: "4:5" }]);
  });

  it("cuts the pictures when asked, tells what it did, and asks for no new pictures", async () => {
    const env = await seed();
    await env.BUCKET.put("u2/b1/output/t1/a.png", png(100, 100), { httpMetadata: { contentType: "image/png" } });
    // The text model stood in for: an OpenAI answer that asks for the frame.
    (env as unknown as { OPENAI_API_KEY: string }).OPENAI_API_KEY = "sk-test";
    const asked: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.openai.com/v1/chat/completions") {
        asked.push(String(init?.body));
        return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: "تمام", notes: "", actions: [{ op: "frame", post: 0, posts: [], fields: {}, format: "4:5" }] }) } }] });
      }
      return real(input, init);
    });
    const r = (await json(await postJson(app("admin"), env, "/api/studio/posts/chat", { batch: "b1", message: "crop all the photos to 4:5" }))) as { reply: string; make: number[] };
    expect(asked[0]).toContain("picture: 100×100 (1:1)");
    expect(r.make).toEqual([]);
    expect(r.reply).toContain("Cut to 4:5, free");
    expect(r.reply).toContain("post 1");
    expect((await config(env)).format).toBe("4:5");
    expect(await storedSize(env, await output(env))).toEqual({ width: 80, height: 100 });
    // Asked again: already 4:5.
    const again = (await json(await postJson(app("admin"), env, "/api/studio/posts/chat", { batch: "b1", message: "crop all the photos to 4:5" }))) as { reply: string };
    expect(again.reply).toContain("Already 4:5, nothing to cut: post 1.");
  });
});
