import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceBatch } from "../server/engine";
import { approveSpend, spendStatus } from "../server/spend";
import {
  setSetting,
  FAL_KEY_SETTING,
  GOOGLE_KEY_SETTING,
  ENGINE_KEY_SETTING,
} from "../server/settings";
import { postConfig } from "../shared/config";
import type { PostBrief } from "../shared/posts";
import { fakeEnv } from "./support/fakes";

/**
 * The vendor request each engine path builds for one post, read off a mocked transport: the
 * pictures arrive in the order the prompt numbers them, and "Image n" in the prompt counts them.
 * Live vendor behaviour (what each API does with the request) is not verified here.
 */

const SIGNED = /^https:\/\/studio\.test\/api\/public\/object\?k=([^&]+)&/;
const keyOf = (url: string) => decodeURIComponent(SIGNED.exec(url)?.[1] ?? url);
function highestImage(prompt: string): number {
  let n = 0;
  for (const m of prompt.matchAll(/Images? (\d+)(?: to (\d+))?/g))
    n = Math.max(n, Number(m[2] ?? m[1]));
  return n;
}

const brief: PostBrief = {
  post: true,
  index: 1,
  type: "product",
  title: "Pistachio crossing",
  brief: "The pistachio shake standing in the crossing sign.",
  palette: [],
  style: "",
  theme: "",
  format: "4:5",
  ref: "style:g9",
  refIsSource: false,
  hasProduct: true,
  product: "pistachio shake: a green cup",
  extraProducts: [{ name: "karak", key: "p/karak.jpg" }],
  tileKey: "styles/g9-tile-1.jpg",
  editRef: { key: "u1/b1/refs/pin.jpg", note: "keep the sign" },
};

async function seed(model: string, economy = false) {
  const env = fakeEnv();
  await setSetting(env, GOOGLE_KEY_SETTING, "AIzaSyTestKey_0123456789abcdefghijk");
  await setSetting(
    env,
    FAL_KEY_SETTING,
    "00000000-0000-0000-0000-000000000000:0123456789abcdef0123456789abcdef",
  );
  await setSetting(env, ENGINE_KEY_SETTING, "id:secret");
  const t = Date.now();
  const config = postConfig("c1", "2026-10", {
    model,
    economy,
    plan: [{ index: 1, type: "product", title: "Pistachio crossing", brief: brief.brief } as never],
  });
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'running', ?, ?, 'c1', '2026-10')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO sources (id, batch, name, stem, key, mime, size, created) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?)",
  )
    .bind(t)
    .run();
  for (const k of ["u1/b1/src/s1.jpg", "p/karak.jpg", "styles/g9-tile-1.jpg", "u1/b1/refs/pin.jpg"])
    await env.BUCKET.put(k, new TextEncoder().encode(k).buffer as ArrayBuffer, {
      httpMetadata: { contentType: "image/jpeg" },
    });
  await env.DB.prepare(
    "INSERT INTO tasks (id, batch, source, card, status, prompt, brief, post, caption, preflight, updated) VALUES ('t1', 'b1', 's1', 1, 'queued', '', ?, 1, '{}', '{\"at\":1,\"notes\":[]}', ?)",
  )
    .bind(JSON.stringify(brief), t)
    .run();
  await approveSpend(env, "b1", 1);
  return env;
}

type Call = { url: string; init?: RequestInit };
let calls: Call[];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function vendorAnswers(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  calls.push({ url, init });
  if (url.endsWith("/files/generate-upload-url"))
    return json({
      upload_url: "https://up.test/put",
      public_url: `https://cdn.test/${calls.length}.jpg`,
    });
  if (url.startsWith("https://up.test/")) return new Response("", { status: 200 });
  if (/\/requests\/[^/]+\/status/.test(url)) return json({ status: "in_progress" });
  if (url.startsWith("https://higgsfield.test/"))
    return json({ request_id: "hf-1", status: "queued" });
  if (url.startsWith("https://queue.fal.run/")) return json({ request_id: "fal-1" });
  if (url.includes("generativelanguage.googleapis.com"))
    return json({ id: "int-1", status: "in_progress" });
  return json({}, 500);
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(vendorAnswers));
});
afterEach(() => vi.unstubAllGlobals());

describe("the request each engine path builds", () => {
  it("Higgsfield: the product photo upload, then the post's pictures as signed links, in the prompt's order", async () => {
    const env = await seed("nano-banana-pro");
    await advanceBatch(env, "b1", {});
    const submit = calls.find((c) => c.url.startsWith("https://higgsfield.test/nano-banana-pro"));
    expect(submit).toBeDefined();
    const body = JSON.parse(String(submit!.init?.body)) as { prompt: string; image_urls: string[] };
    expect(body.image_urls[0]).toMatch(/^https:\/\/cdn\.test\//);
    expect(body.image_urls.slice(1).map(keyOf)).toEqual([
      "p/karak.jpg",
      "styles/g9-tile-1.jpg",
      "u1/b1/refs/pin.jpg",
    ]);
    expect(highestImage(body.prompt)).toBe(body.image_urls.length);
    expect((await spendStatus(env, "b1")).reserved).toBeCloseTo(0.15, 3);
  });

  it("fal: signed links to the stored pictures, the product photo first", async () => {
    const env = await seed("fal/bytedance/seedream/v5/pro/edit");
    await advanceBatch(env, "b1", {});
    const submit = calls.find((c) => c.url.startsWith("https://queue.fal.run/"));
    expect(submit).toBeDefined();
    const body = JSON.parse(String(submit!.init?.body)) as {
      prompt: string;
      image_urls: string[];
      num_images: number;
    };
    expect(body.image_urls.map(keyOf)).toEqual([
      "u1/b1/src/s1.jpg",
      "p/karak.jpg",
      "styles/g9-tile-1.jpg",
      "u1/b1/refs/pin.jpg",
    ]);
    expect(body.num_images).toBe(1);
    expect(highestImage(body.prompt)).toBe(4);
  });

  it("Google Flex: the bytes inline after the prompt, as a background Flex job", async () => {
    const env = await seed("gemini-3-pro-image", true);
    await advanceBatch(env, "b1", {});
    const submit = calls.find((c) => c.url.endsWith("/interactions"));
    expect(submit).toBeDefined();
    const body = JSON.parse(String(submit!.init?.body)) as {
      input: { type: string; text?: string; data?: string }[];
      service_tier?: string;
      background?: boolean;
    };
    expect(body.service_tier).toBe("flex");
    expect(body.background).toBe(true);
    expect(body.input[0].type).toBe("text");
    const sent = body.input.slice(1).map((i) => Buffer.from(i.data!, "base64").toString());
    expect(sent).toEqual([
      "u1/b1/src/s1.jpg",
      "p/karak.jpg",
      "styles/g9-tile-1.jpg",
      "u1/b1/refs/pin.jpg",
    ]);
    expect(highestImage(body.input[0].text!)).toBe(4);
    const task = await env.DB.prepare("SELECT request_id FROM tasks WHERE id = 't1'").first<{
      request_id: string;
    }>();
    expect(task?.request_id).toBe("google:int-1");
  });

  it("Google standard: the same pictures inline, sent synchronously", async () => {
    const env = await seed("gemini-3-pro-image");
    const jobs: Promise<unknown>[] = [];
    await advanceBatch(env, "b1", { background: (p) => void jobs.push(p) });
    await Promise.allSettled(jobs);
    const submit = calls.find((c) => c.url.endsWith("/interactions"));
    expect(submit).toBeDefined();
    const body = JSON.parse(String(submit!.init?.body)) as {
      input: { type: string; text?: string; data?: string }[];
      background?: boolean;
    };
    expect(body.background).toBeUndefined();
    expect(body.input.slice(1).map((i) => Buffer.from(i.data!, "base64").toString())).toEqual([
      "u1/b1/src/s1.jpg",
      "p/karak.jpg",
      "styles/g9-tile-1.jpg",
      "u1/b1/refs/pin.jpg",
    ]);
    expect(highestImage(body.input[0].text!)).toBe(4);
  });

  it("keeps an uncertain failure's reservation for reconciliation and a refusal's, both bounded by the attempt cap", async () => {
    // fal answers 503 after taking the request: whether it billed is not known, so the attempt's
    // cost and reservation stay, counted as uncertain, and the post is queued once more.
    const env = await seed("fal/bytedance/seedream/v5/pro/edit");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url });
      return url.startsWith("https://queue.fal.run/")
        ? json({ detail: "upstream unavailable" }, 503)
        : json({}, 500);
    });
    await advanceBatch(env, "b1", {});
    let task = await env.DB.prepare(
      "SELECT status, attempts, cost, model FROM tasks WHERE id = 't1'",
    ).first<{ status: string; attempts: number; cost: number; model: string | null }>();
    expect(task).toEqual({ status: "queued", attempts: 1, cost: expect.closeTo(0.135, 3), model: null });
    const after = await spendStatus(env, "b1");
    expect(after.reserved).toBeCloseTo(0.135, 3);
    expect(after.uncertain).toBeCloseTo(0.135, 3);
    // Google refuses the picture: the attempt may be billed, so its cost and reservation stay, and the
    // post moves to another engine once (still within the month's approval).
    const env2 = await seed("gemini-3-pro-image");
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/interactions")) {
        calls.push({ url, init });
        return json({ error: { message: "The request was blocked by the content policy." } }, 400);
      }
      return vendorAnswers(input, init);
    });
    const jobs: Promise<unknown>[] = [];
    await advanceBatch(env2, "b1", { background: (p) => void jobs.push(p) });
    await Promise.allSettled(jobs);
    // The refused Google attempt stays billed; the post went on to Higgsfield with its own reservation.
    task = await env2.DB.prepare(
      "SELECT status, attempts, cost, model FROM tasks WHERE id = 't1'",
    ).first<{ status: string; attempts: number; cost: number; model: string | null }>();
    expect(task?.model).toBe("nano-banana-pro");
    expect(task?.status).toBe("processing");
    expect(task?.cost).toBeCloseTo(0.134 + 0.15, 3);
    expect((await spendStatus(env2, "b1")).reserved).toBeCloseTo(0.134 + 0.15, 3);
  });

  it("sends nothing when the month has no approved budget left, and says so", async () => {
    const env = await seed("fal/bytedance/seedream/v5/pro/edit");
    await env.DB.prepare("UPDATE spend SET approved = 0.01 WHERE scope = 'b1'").run();
    await advanceBatch(env, "b1", {});
    expect(calls.filter((c) => c.url.startsWith("https://queue.fal.run/"))).toHaveLength(0);
    const batch = await env.DB.prepare(
      "SELECT state, last_error FROM batches WHERE id = 'b1'",
    ).first<{ state: string; last_error: string }>();
    expect(batch?.state).toBe("paused");
    expect(batch?.last_error).toMatch(/approved budget/);
    const task = await env.DB.prepare("SELECT status, attempts FROM tasks WHERE id = 't1'").first<{
      status: string;
      attempts: number;
    }>();
    expect(task).toEqual({ status: "queued", attempts: 0 });
  });
});
