import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { askVisionAnthropic, claudeCap, claudeSpend, CLAUDE_MODELS, priceOf, tierFor, tryClaude, verifyAnthropicKey } from "../server/anthropic";
import { ANTHROPIC_CAP_SETTING, ANTHROPIC_KEY_SETTING, setSetting } from "../server/settings";
import { askText } from "../server/posts";

/**
 * Claude as the first text model (27 Oct): which Claude answers which job, what the request holds
 * (the pictures, the instruction, the JSON-only system line, the schema), the month's spend from
 * the tokens reported and the cap that stops it, and the fall-through to the next provider when
 * Claude cannot answer. The fake fetch stands in for the API; the guard fails any real call.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;
type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A fetch that answers as the API would, keeping what was sent. */
function fakeApi(answer: string | ((sent: Sent) => Response), usage = { input_tokens: 1000, output_tokens: 200 }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Whatever shape the SDK sends (a URL with an init, or a Request), read it as one Request.
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const url = req.url;
    const headers = Object.fromEntries(req.headers.entries());
    const raw = await req.text();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const s = { url, body, headers };
    sent.push(s);
    if (typeof answer === "function") return answer(s);
    if (url.endsWith("/v1/models?limit=5")) return Response.json({ data: Object.values(CLAUDE_MODELS).map((id) => ({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" })), has_more: false, first_id: null, last_id: null });
    return Response.json({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: answer }], stop_reason: "end_turn", stop_sequence: null, usage });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

const png = { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer as ArrayBuffer, mime: "image/png" };

describe("which Claude", () => {
  it("sends plans and creative direction to Opus, help and the Prompt Box to Haiku, the rest to Sonnet", () => {
    expect(tierFor({ type: "object", properties: { posts: { type: "array" } } })).toBe("opus");
    expect(tierFor({ properties: { shots: {}, direction: {} } })).toBe("opus");
    expect(tierFor({ properties: { world: {}, tiles: {} } })).toBe("opus");
    expect(tierFor({ properties: { answer: {}, steps: {}, known: {} } })).toBe("haiku");
    expect(tierFor({ properties: { tool: {}, q: {}, model: {}, post: {} } })).toBe("haiku");
    expect(tierFor({ properties: { caption: {}, hashtags: {} } })).toBe("sonnet");
    expect(tierFor({ properties: { ok: {}, problems: {} } })).toBe("sonnet");
    expect(tierFor(null)).toBe("sonnet");
  });
  it("prices an answer from its tokens, cache reads at a tenth", () => {
    expect(priceOf("sonnet", { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(3, 6);
    expect(priceOf("opus", { input_tokens: 500_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(2 + 0.4, 6);
    expect(priceOf("haiku", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6, 6);
  });
});

describe("one answer", () => {
  it("sends the pictures first, then the instruction, with a JSON-only system line and the schema, to the model of the job", async () => {
    const env = fakeEnv() as FakeEnv;
    const api = fakeApi('{"caption": "جرّب الكنافة اليوم", "hashtags": "#habibah"}');
    const schema = { type: "object", properties: { caption: { type: "string" }, hashtags: { type: "string" } }, required: ["caption", "hashtags"] };
    const text = await askVisionAnthropic(env, "sk-ant-test", "Write the caption.", [png], schema, api.fetchImpl);
    expect(JSON.parse(text)).toEqual({ caption: "جرّب الكنافة اليوم", hashtags: "#habibah" });
    const [s] = api.sent;
    expect(s.url).toBe("https://api.anthropic.com/v1/messages");
    // The SDK sends the key as a bearer token (its current wire shape).
    expect(s.headers.authorization).toBe("Bearer sk-ant-test");
    expect(s.body.model).toBe("claude-sonnet-5-5");
    expect(s.body.output_config).toEqual({ effort: "low" });
    expect(String(s.body.system)).toMatch(/Answer with the JSON/);
    expect(String(s.body.system)).toContain('"caption"');
    const content = (s.body.messages as { content: { type: string; source?: { media_type: string; data: string }; text?: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(content[0].source).toMatchObject({ media_type: "image/png", data: Buffer.from(new Uint8Array(png.bytes)).toString("base64") });
    expect(content[1].text).toBe("Write the caption.");
    // The month's spend: 1000 in and 200 out on Sonnet.
    const spend = await claudeSpend(env);
    expect(spend).toMatchObject({ calls: 1, input: 1000, output: 200 });
    expect(spend.usd).toBeCloseTo(0.002 + 0.002, 6);
  });
  it("plans on Opus at medium effort with room to write", async () => {
    const env = fakeEnv() as FakeEnv;
    const api = fakeApi('{"posts": []}');
    await askVisionAnthropic(env, "k".repeat(30), "Plan the month.", [], { properties: { posts: {} } }, api.fetchImpl);
    expect(api.sent[0].body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "medium" } });
  });
  it("refuses a picture Claude cannot take, before anything is sent", async () => {
    const env = fakeEnv() as FakeEnv;
    const api = fakeApi("{}");
    await expect(askVisionAnthropic(env, "k".repeat(30), "x", [{ bytes: new ArrayBuffer(8), mime: "image/tiff" }], null, api.fetchImpl)).rejects.toThrow(/image\/tiff/);
    await expect(askVisionAnthropic(env, "k".repeat(30), "x", [{ bytes: new ArrayBuffer(4_000_000), mime: "image/jpeg" }], null, api.fetchImpl)).rejects.toThrow(/too large/);
    expect(api.sent).toEqual([]);
  });
  it("treats a decline as no answer", async () => {
    const env = fakeEnv() as FakeEnv;
    const api = fakeApi(() => Response.json({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" }, usage: { input_tokens: 10, output_tokens: 0 } }));
    await expect(askVisionAnthropic(env, "k".repeat(30), "x", [], null, api.fetchImpl)).rejects.toThrow(/declined/);
  });
});

describe("Claude first, the others when it cannot", () => {
  it("answers nothing without a key, and nothing is sent", async () => {
    const env = fakeEnv() as FakeEnv;
    const api = fakeApi("{}");
    expect(await tryClaude(env, "x", [], null, api.fetchImpl)).toBeNull();
    expect(api.sent).toEqual([]);
  });
  it("stops at the month's cap (US$200 unless set) and starts again under a higher one", async () => {
    const env = fakeEnv() as FakeEnv;
    await setSetting(env, ANTHROPIC_KEY_SETTING, "k".repeat(30));
    expect(await claudeCap(env)).toBe(200);
    await setSetting(env, "anthropic_spend:" + (await claudeSpend(env)).month, JSON.stringify({ usd: 200, calls: 900, input: 1, output: 1 }));
    const api = fakeApi('{"ok": true}');
    expect(await tryClaude(env, "x", [], null, api.fetchImpl)).toBeNull();
    expect(api.sent).toEqual([]);
    await setSetting(env, ANTHROPIC_CAP_SETTING, "250");
    expect(await tryClaude(env, "x", [], null, api.fetchImpl)).toBe('{"ok": true}');
    expect(api.sent).toHaveLength(1);
  });
  it("hands over to the next provider when the call fails (a bad key here), without throwing", async () => {
    const env = fakeEnv() as FakeEnv;
    await setSetting(env, ANTHROPIC_KEY_SETTING, "k".repeat(30));
    const api = fakeApi(() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
    expect(await tryClaude(env, "x", [], null, api.fetchImpl)).toBeNull();
  });
  it("askText with only a Claude key asks Claude, and names every provider when none is connected", async () => {
    const env = fakeEnv() as FakeEnv;
    await expect(askText(env, "x", null)).rejects.toThrow(/Claude, Google or OpenAI key/);
    await setSetting(env, ANTHROPIC_KEY_SETTING, "k".repeat(30));
    // askText uses the global fetch: the guard lets this one call through to the fake answer.
    const api = fakeApi('{"caption": "x"}');
    reached.length = 0;
    const guard = guardFetch(() => true);
    guard.stub.mockImplementation(api.fetchImpl as never);
    expect(await askText(env, "Write it.", { properties: { caption: {} } })).toBe('{"caption": "x"}');
    expect(api.sent[0].body.model).toBe("claude-sonnet-5-5");
    reached = guard.reached;
    reached.length = 0;
  });
});

describe("the key", () => {
  it("is verified against the models list and names the models found", async () => {
    const api = fakeApi("{}");
    const r = await verifyAnthropicKey("k".repeat(30), api.fetchImpl);
    expect(r).toEqual({ ok: true, message: "Claude key verified · Opus, Sonnet and Haiku 5.5 available." });
    expect(api.sent[0].url).toContain("/v1/models");
  });
  it("reports a rejected key", async () => {
    const api = fakeApi(() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
    const r = await verifyAnthropicKey("k".repeat(30), api.fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid x-api-key|401/);
  });
});
