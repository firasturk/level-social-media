import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { setSetting } from "../server/settings";
import {
  DEFAULT_LANGFUSE_HOST,
  LANGFUSE_PUBLIC_KEY_SETTING,
  LANGFUSE_SECRET_KEY_SETTING,
  TRACE_TEXT_MAX,
  fingerprint,
  ingestionBody,
  postReferenceKeys,
  redact,
  resetTraceCache,
  traceEnabled,
  traceEvent,
  traceIdle,
  traceStatus,
  type TraceEvent,
} from "../server/trace";

/**
 * The tracing adapter mirrors the engine's steps to Langfuse only when keys exist, sends to the
 * configured host alone, redacts what leaves the studio, and never fails a caller: a fetch that
 * throws is logged and swallowed. The fetch guard fails the test on any call to another host.
 */
const HOST = "https://langfuse.test";

const sample: TraceEvent = {
  kind: "generation",
  traceId: "b1",
  spanId: "task-1",
  name: "submit",
  input: { prompt: "Image 1 is the product photo.", images: ["mood"] },
  model: "gemini-3-pro-image",
  cost: 0.13,
  metadata: { client: "c1", post: 2, revision: 1700, promptVersion: "abc12345", references: ["styles/s1.jpg"], engine: "gemini-3-pro-image", attempt: 1, error: null },
};

beforeEach(() => {
  resetTraceCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tracing is a no-op without keys", () => {
  it("is disabled, sends nothing and reports so", async () => {
    const { reached } = guardFetch();
    const env = fakeEnv();
    expect(await traceEnabled(env)).toBe(false);
    traceEvent(env, sample);
    await traceIdle();
    expect(reached).toEqual([]);
    expect(await traceStatus(env)).toMatchObject({ enabled: false, host: null, source: "none" });
  });

  it("one key alone is not enough", async () => {
    const { reached } = guardFetch();
    const env = fakeEnv({ LANGFUSE_PUBLIC_KEY: "pk" });
    expect(await traceEnabled(env)).toBe(false);
    traceEvent(env, sample);
    await traceIdle();
    expect(reached).toEqual([]);
  });
});

describe("tracing with keys", () => {
  it("posts one ingestion batch to the configured host with basic auth", async () => {
    const { reached } = guardFetch((url) => url.startsWith(HOST));
    const env = fakeEnv({ LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_HOST: `${HOST}/` });
    expect(await traceEnabled(env)).toBe(true);
    traceEvent(env, sample);
    await traceIdle();
    expect(reached).toHaveLength(1);
    const [{ url, init }] = reached;
    expect(url).toBe(`${HOST}/api/public/ingestion`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("pk-test:sk-test")}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as { batch: { type: string; body: Record<string, unknown> }[] };
    expect(body.batch.map((b) => b.type)).toEqual(["trace-create", "generation-create"]);
    expect(body.batch[0].body).toMatchObject({ id: "b1", tags: ["generation"] });
    expect(body.batch[1].body).toMatchObject({ traceId: "b1", name: "submit", model: "gemini-3-pro-image", costDetails: { total: 0.13 }, level: "DEFAULT" });
    expect((body.batch[1].body.metadata as Record<string, unknown>).post).toBe(2);
    expect((body.batch[1].body.metadata as Record<string, unknown>).kind).toBe("generation");
    expect(await traceStatus(env)).toMatchObject({ enabled: true, host: HOST, source: "env" });
  });

  it("reads the keys from the settings table when the environment has none", async () => {
    const { reached } = guardFetch((url) => url.startsWith(DEFAULT_LANGFUSE_HOST));
    const env = fakeEnv();
    await setSetting(env, LANGFUSE_PUBLIC_KEY_SETTING, "pk-stored");
    await setSetting(env, LANGFUSE_SECRET_KEY_SETTING, "sk-stored");
    expect(await traceStatus(env)).toMatchObject({ enabled: true, host: DEFAULT_LANGFUSE_HOST, source: "settings" });
    traceEvent(env, { ...sample, kind: "plan", spanId: "plan:1", name: "ideas", model: undefined, cost: undefined });
    await traceIdle();
    expect(reached).toHaveLength(1);
    const body = JSON.parse(String(reached[0].init?.body)) as { batch: { type: string; body: Record<string, unknown> }[] };
    expect(body.batch[1].type).toBe("span-create");
    expect(body.batch[1].body.model).toBeUndefined();
  });

  it("a failed attempt is an ERROR observation", () => {
    const body = ingestionBody({ ...sample, name: "failed", output: { error: "Generation failed (500)" }, metadata: { ...sample.metadata, error: "Generation failed (500)" } }, 1_700_000_000_000);
    expect(body.batch[1].body).toMatchObject({ level: "ERROR", statusMessage: "Generation failed (500)", startTime: "2023-11-14T22:13:20.000Z" });
    expect((body.batch[1].body as { id: string }).id).toBe("task-1:generation:failed:1");
  });

  it("a fetch that throws never reaches the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = fakeEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: HOST });
    expect(() => traceEvent(env, sample)).not.toThrow();
    await expect(traceIdle()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[trace]", "generation", "submit", "network down");
    expect(await traceStatus(env)).toMatchObject({ enabled: true, lastError: "network down" });
  });

  it("a non-2xx answer is counted as a failure, not thrown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = fakeEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: HOST });
    traceEvent(env, sample);
    await traceIdle();
    expect((await traceStatus(env)).lastError).toBe("Langfuse answered 401");
  });
});

describe("redaction", () => {
  it("drops credential fields, masks e-mails and cuts long strings", () => {
    const out = redact({
      key: "an r2 key is dropped too",
      token: "t",
      secret: "s",
      password: "p",
      authorization: "Basic xyz",
      apiKey: "a",
      api_key: "b",
      HIGGSFIELD_API_KEY: "c",
      prompt: "x".repeat(TRACE_TEXT_MAX + 10),
      owner: "designer@levelmena.com asked for it",
      nested: { token: "t2", picture: "u1/b1/output/t/a.jpg", list: ["a@b.co", 3, null] },
    }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["nested", "owner", "prompt"]);
    expect(out.owner).toBe("[email] asked for it");
    expect(String(out.prompt).length).toBeLessThan(TRACE_TEXT_MAX + 40);
    expect(String(out.prompt).endsWith("…[truncated 10 chars]")).toBe(true);
    expect(out.nested).toEqual({ picture: "u1/b1/output/t/a.jpg", list: ["[email]", 3, null] });
  });

  it("redacts the event before it is sent", async () => {
    const { reached } = guardFetch((url) => url.startsWith(HOST));
    const env = fakeEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: HOST });
    traceEvent(env, { ...sample, input: { prompt: "p", apiKey: "leak", by: "u@test.io" }, metadata: { ...sample.metadata, token: "leak" } });
    await traceIdle();
    const text = String(reached[0].init?.body);
    expect(text).not.toContain("leak");
    expect(text).not.toContain("u@test.io");
    expect(text).toContain("[email]");
  });

  it("fingerprints are short, stable and change with the text", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });

  it("lists a brief's reference keys in the order the engine attaches them", () => {
    const keys = postReferenceKeys(
      JSON.stringify({ hasProduct: true, extraProducts: [{ key: "p2" }], ambassadors: [{ key: "amb" }], place: { key: "place" }, realRef: { key: "real" }, styleKey: "style", editRef: { key: "pin" } }),
    );
    expect(keys).toEqual(["p2", "amb", "place", "real", "style", "pin"]);
    expect(postReferenceKeys(JSON.stringify({ ref: "ref-1", noRefImage: true }))).toEqual([]);
    expect(postReferenceKeys("not json")).toEqual([]);
    expect(postReferenceKeys(null)).toEqual([]);
  });
});
