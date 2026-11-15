/**
 * No endless waits, no raw "Failed to fetch": every request has a deadline, and a request that got
 * no answer says so in words a person can act on. Answers the server did give (an HTTP error with
 * its message) keep their ApiError exactly as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** The client's request helpers, as these tests use them (browser code: loaded at run time, outside the worker's types). */
interface Api {
  ApiError: new (message: string, status: number, data?: Record<string, unknown>) => Error & { status: number; data: Record<string, unknown> };
  TIMEOUT_MS: number;
  LONG_TIMEOUT_MS: number;
  NO_CONNECTION: string;
  TOO_LONG: string;
  timeoutFor: (method: string, path: string) => number;
  connectionError: (timedOut: boolean) => Error;
  get: <T>(path: string, timeoutMs?: number) => Promise<T>;
  post: <T>(path: string, body?: unknown, timeoutMs?: number) => Promise<T>;
  put: <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;
  postForm: <T>(path: string, form: FormData, timeoutMs?: number) => Promise<T>;
}
const { ApiError, LONG_TIMEOUT_MS, NO_CONNECTION, TIMEOUT_MS, TOO_LONG, connectionError, get, post, postForm, put, timeoutFor } = (await import("../src/api".toString())) as Api;
type ApiError = InstanceType<Api["ApiError"]>;
/** What the helpers hand to fetch. */
type Init = { method?: string; credentials?: string; body?: unknown; headers?: unknown; signal?: AbortSignal };

/** A fetch that never answers on its own, and fails the way a browser does when its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_path: string, init?: Init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      }),
  );
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("timeoutFor", () => {
  it("gives reads and deletes the ordinary wait, whatever they read", () => {
    expect(timeoutFor("GET", "/api/studio/posts/themes?client=a")).toBe(TIMEOUT_MS);
    expect(timeoutFor("DELETE", "/api/studio/posts/chat?batch=b")).toBe(TIMEOUT_MS);
  });

  it("gives minutes to the work that takes minutes on the server", () => {
    for (const path of [
      "/api/studio/posts/generate",
      "/api/studio/posts/ideas",
      "/api/studio/posts/grid-ideas",
      "/api/studio/posts/shots",
      "/api/studio/posts/reidea",
      "/api/studio/posts/typography",
      "/api/studio/posts/client-changes",
      "/api/studio/posts/plan-preview",
      "/api/studio/posts/themes/t1/analyze",
      "/api/studio/posts/video/editor/renders",
      "/api/studio/profiles/c1/analyse",
      "/api/studio/styles/s1/grid-read?again=1",
      "/api/studio/campaigns/k1/tick",
      "/api/studio/ambassadors/a1/portrait",
      "/api/studio/photo/tools/run",
      "/api/studio/photolab/run",
      "/api/studio/video/magnific/generate",
      "/api/studio/higgsfield/mcp/generate",
      "/api/studio/promptbox/execute",
      "/api/studio/drive/delivery/c1/deliver",
      "/api/studio/publish/p1/retry",
      "/api/studio/clients/c1/realrefs",
      "/api/studio/tick",
      "/api/studio/revise",
      "/api/admin/audit",
    ])
      expect(timeoutFor("POST", path), path).toBe(LONG_TIMEOUT_MS);
  });

  it("keeps plain saves and settings on the ordinary wait", () => {
    for (const path of ["/api/studio/posts/plan", "/api/studio/posts/remove", "/api/studio/posts/share", "/api/studio/clients/c1", "/api/studio/batch", "/api/auth/login", "/api/admin/settings", "/api/team/messages"])
      expect(timeoutFor("POST", path), path).toBe(TIMEOUT_MS);
    expect(timeoutFor("PUT", "/api/studio/posts/plan")).toBe(TIMEOUT_MS);
    // "plan" the save is not "plan-preview" the paid look ahead.
    expect(timeoutFor("POST", "/api/studio/posts/plan-preview")).toBe(LONG_TIMEOUT_MS);
  });
});

describe("a request that gets no answer", () => {
  it("says there is no connection instead of the browser's 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(get("/api/studio/state")).rejects.toThrow(NO_CONNECTION);
    await expect(post("/api/studio/posts/plan", { a: 1 })).rejects.toThrow(NO_CONNECTION);
    const e = await put("/api/studio/posts/plan", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ApiError);
  });

  it("gives up after the ordinary wait and says nothing was lost", async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    vi.stubGlobal("fetch", fetch);
    const answer = get("/api/studio/state").catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe(TOO_LONG);
  });

  it("waits minutes for long server work, and for a form with files", async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    vi.stubGlobal("fetch", fetch);
    const ideas = post("/api/studio/posts/ideas", { batch: "b" }).catch((e: Error) => e.message);
    const upload = postForm("/api/studio/clients/c1/logo", new FormData()).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1000);
    expect(fetch.mock.calls.every((c) => c[1]?.signal?.aborted === false)).toBe(true);
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS);
    expect(await ideas).toBe(TOO_LONG);
    expect(await upload).toBe(TOO_LONG);
  });

  it("lets a caller name its own wait", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const answer = post("/api/studio/batch", {}, 5000).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await answer).toBe(TOO_LONG);
  });

  it("does not take an answer cut off by the deadline for an empty one", async () => {
    vi.useFakeTimers();
    // The headers arrive, the body never does.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: Init) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      })),
    );
    const answer = get("/api/studio/state").then(
      () => "an answer",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await answer).toBe(TOO_LONG);
  });
});

describe("an answer the server did give", () => {
  it("returns the JSON and sends same-origin cookies", async () => {
    const fetch = vi.fn<(path: string, init?: Init) => Promise<Response>>(async () => json({ ok: true, n: 3 }));
    vi.stubGlobal("fetch", fetch);
    expect(await post<{ n: number }>("/api/studio/batch", { a: 1 })).toEqual({ ok: true, n: 3 });
    const init = fetch.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("keeps the server's own message, status and data on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Pick a client first.", needsApproval: true }, 409)));
    const e = (await post("/api/studio/posts/generate", {}).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("Pick a client first.");
    expect(e.status).toBe(409);
    expect(e.data.needsApproval).toBe(true);
  });

  it("still names the status when an error carries no JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const e = (await get("/api/studio/state").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("Request failed (502)");
  });
});

describe("connectionError", () => {
  it("has one plain sentence for each case", () => {
    expect(connectionError(false).message).toBe("No connection to the studio. Check the internet and try again.");
    expect(connectionError(true).message).toBe("This is taking too long. Check the connection and try again; nothing was lost.");
  });
});
