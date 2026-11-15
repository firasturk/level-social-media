/**
 * A revise (or a fix) of a generated picture builds its prompt from the brief stored at the last
 * generate. The brand's own fields of that brief are read again from the client at revise time, so
 * a rule the kit or the memory got since then is in the prompt; the idea and the review's lessons
 * stay as stored, and a first generation is not touched. The engine is a mocked transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceBatch } from "../server/engine";
import { approveSpend } from "../server/spend";
import { setSetting, ENGINE_KEY_SETTING } from "../server/settings";
import { postConfig } from "../shared/config";
import type { PostBrief } from "../shared/posts";
import { fakeEnv } from "./support/fakes";
import { giveBrandRule, giveKit } from "./support/brand-kit";

/** The brief as the last generate stored it: the kit had one never-rule then, and the review had left one lesson. */
const stored: PostBrief = {
  post: true,
  index: 1,
  type: "product",
  title: "Pistachio crossing",
  brief: "The pistachio shake standing in the crossing sign.",
  palette: [],
  style: "",
  theme: "",
  format: "4:5",
  ref: null,
  refIsSource: false,
  hasProduct: true,
  product: "pistachio shake: a green cup",
  never: "No cutlery",
  lessons: ["Brand rule: An old rule the team has since removed", "The product is never shown in a bag."],
};

async function seed(edit: string | null) {
  const env = fakeEnv();
  await setSetting(env, ENGINE_KEY_SETTING, "id:secret");
  const t = Date.now();
  const config = postConfig("c1", "2026-10", { model: "nano-banana-pro", plan: [{ index: 1, type: "product", title: stored.title, brief: stored.brief } as never] });
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'running', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?)").bind(t).run();
  for (const k of ["u1/b1/src/s1.jpg", "u1/b1/output/t1/a.png"]) await env.BUCKET.put(k, new TextEncoder().encode(k).buffer as ArrayBuffer, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, prompt, brief, post, caption, preflight, output, edit, updated) VALUES ('t1', 'b1', 's1', 1, 'queued', '', ?, 1, '{}', '{\"at\":1,\"notes\":[]}', ?, ?, ?)")
    .bind(JSON.stringify(stored), edit ? "u1/b1/output/t1/a.png" : null, edit, t)
    .run();
  await approveSpend(env, "b1", 1);
  // Since that generate the client's kit got a second never-rule, image rules and a photography direction, and the team approved a brand rule.
  await giveKit(env, "c1", { donts: "No cutlery\nNo plastic cups", dos: "" });
  await giveBrandRule(env);
  return env;
}

let calls: { url: string; init?: RequestInit }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, init });
      if (url.endsWith("/files/generate-upload-url")) return json({ upload_url: "https://up.test/put", public_url: `https://cdn.test/${calls.length}.jpg` });
      if (url.startsWith("https://up.test/")) return new Response("", { status: 200 });
      if (/\/requests\/[^/]+\/status/.test(url)) return json({ status: "in_progress" });
      if (url.startsWith("https://higgsfield.test/")) return json({ request_id: "hf-1", status: "queued" });
      return json({}, 500);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const sentPrompt = () => (JSON.parse(String(calls.find((c) => c.url.startsWith("https://higgsfield.test/nano-banana-pro"))!.init?.body)) as { prompt: string }).prompt;
const briefOf = async (env: ReturnType<typeof fakeEnv>) => JSON.parse((await env.DB.prepare("SELECT brief FROM tasks WHERE id = 't1'").first<{ brief: string }>())!.brief) as PostBrief;

describe("revising a generated picture", () => {
  it("reads the brand's rules again: a never-rule, the image rules and a brand rule added since the generate are in the prompt, a removed one is gone, the lesson and the idea stay", async () => {
    const env = await seed("make the light warmer");
    await advanceBatch(env, "b1", {});
    const prompt = sentPrompt();
    expect(prompt).toContain("REVISION: make the light warmer");
    expect(prompt).toContain("NEVER: No cutlery\nNo plastic cups");
    expect(prompt).toContain("THE CLIENT'S OWN IMAGE RULES");
    expect(prompt).toContain("Every box keeps its printed lid.");
    expect(prompt).toContain("PHOTOGRAPHY DIRECTION");
    expect(prompt).toContain("- Brand rule: No red backgrounds");
    expect(prompt).not.toContain("An old rule the team has since removed");
    expect(prompt).toContain("- The product is never shown in a bag.");
    expect(prompt).toContain(stored.brief);
    // What is stored is what was sent.
    expect(await briefOf(env)).toMatchObject({ never: "No cutlery\nNo plastic cups", rules: "Every box keeps its printed lid.", photography: "50mm, eye level, soft window light.", lessons: ["Brand rule: No red backgrounds", "The product is never shown in a bag."], brief: stored.brief, title: stored.title });
  });

  it("a fresh take of a rejected picture reads them again too; a first generation keeps the brief the plan stored", async () => {
    const fresh = await seed("FRESH TAKE: the cup was cut off");
    await advanceBatch(fresh, "b1", {});
    expect(sentPrompt()).toContain("No plastic cups");
    calls = [];
    const first = await seed(null);
    await advanceBatch(first, "b1", {});
    expect(sentPrompt()).not.toContain("No plastic cups");
    expect(sentPrompt()).toContain("An old rule the team has since removed");
    expect(await briefOf(first)).toEqual(stored);
  });
});
