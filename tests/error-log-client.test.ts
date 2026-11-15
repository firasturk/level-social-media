/**
 * The page's side of the error log (src/lib/errorLog.ts) and its hooks in src/api.ts: one message
 * is reported once in 10 seconds, a tab sends at most 10 reports a minute, nothing here ever
 * throws, every error or warning toast is reported with its text, the browser's own noise and
 * extensions are left out, and a request reports itself when it got no answer or a 5xx, never on a
 * 4xx and never for the log's own call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Kind = "toast" | "crash" | "network" | "server";
interface Report {
  kind: Kind;
  message: string;
  detail?: string;
  screen?: string;
  build?: string;
}
/** The client module, as these tests use it (browser code: loaded at run time, outside the worker's types). */
interface ErrorLog {
  ERRORS_PATH: string;
  DUPLICATE_MS: number;
  PER_MINUTE: number;
  createReporter: (options: {
    send: (r: Report) => void;
    now?: () => number;
    context?: () => { screen?: string; build?: string };
    online?: () => boolean;
    quiet?: (kind: Kind) => boolean;
  }) => { report: (kind: Kind, message: unknown, detail?: unknown) => void; flush: () => void };
  reportError: (kind: Kind, message: unknown, detail?: unknown) => void;
  noteBuild: (b: string) => void;
  currentScreen: () => string;
  toastText: (message: unknown) => string;
  wrapToasts: (toast: { error: (...a: never[]) => unknown; warning: (...a: never[]) => unknown }, report?: (kind: Kind, message: unknown, detail?: unknown) => void) => void;
  stackTop: (stack: string | null | undefined, origin?: string, lines?: number) => string;
  crashFromError: (input: { message?: string; filename?: string; error?: unknown }, origin: string) => { message: string; detail: string } | null;
  crashFromRejection: (reason: unknown, origin: string) => { message: string; detail: string } | null;
  markReported: (e: unknown) => void;
}
interface Api {
  ApiError: new (message: string, status: number) => Error & { status: number };
  NO_CONNECTION: string;
  TOO_LONG: string;
  TIMEOUT_MS: number;
  get: <T>(path: string, timeoutMs?: number) => Promise<T>;
  post: <T>(path: string, body?: unknown, timeoutMs?: number) => Promise<T>;
}
const load = async () => (await import("../src/lib/errorLog".toString())) as ErrorLog;
const { DUPLICATE_MS, ERRORS_PATH, PER_MINUTE, crashFromError, crashFromRejection, createReporter, currentScreen, markReported, reportError, stackTop, toastText, wrapToasts } = await load();

const ORIGIN = "https://studio.test";

/** A reporter on a clock the test moves, with what it sent. */
function reporter(options: { online?: () => boolean; quiet?: (kind: Kind) => boolean } = {}) {
  const sent: Report[] = [];
  let t = 1_000_000;
  const r = createReporter({ send: (x) => void sent.push(x), now: () => t, context: () => ({ screen: "/?client=habibah · Studio", build: "b1" }), ...options });
  return { sent, report: r.report, flush: r.flush, wait: (ms: number) => void (t += ms) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("reportError: duplicates and the rate limit", () => {
  it("sends a report with the screen and the build", () => {
    const { sent, report } = reporter();
    report("toast", "The caption could not be written; try again.", "warning");
    expect(sent).toEqual([{ kind: "toast", message: "The caption could not be written; try again.", detail: "warning", screen: "/?client=habibah · Studio", build: "b1" }]);
  });

  it("drops the same message within 10 seconds and sends it again after", () => {
    const { sent, report, wait } = reporter();
    report("toast", "Could not save.");
    report("toast", "Could not save.");
    wait(DUPLICATE_MS - 1);
    report("toast", "  Could not save.  ");
    expect(sent).toHaveLength(1);
    wait(1);
    report("toast", "Could not save.");
    expect(sent).toHaveLength(2);
    // Another message, and the same words as another kind, are not duplicates.
    report("toast", "Could not load.");
    report("crash", "Could not save.");
    expect(sent.map((x) => `${x.kind}:${x.message}`)).toEqual(["toast:Could not save.", "toast:Could not save.", "toast:Could not load.", "crash:Could not save."]);
  });

  it("sends at most 10 reports a minute, and again once the minute has passed", () => {
    const { sent, report, wait } = reporter();
    for (let i = 0; i < PER_MINUTE + 5; i++) {
      report("toast", `Problem ${i}`);
      wait(1_000);
    }
    expect(sent.map((x) => x.message)).toEqual(Array.from({ length: PER_MINUTE }, (_, i) => `Problem ${i}`));
    // 15 s in: the first ten are still inside the minute.
    report("toast", "Still too many");
    expect(sent).toHaveLength(PER_MINUTE);
    wait(46_000); // 61 s after the first report: one place is free again
    report("toast", "After the minute");
    expect(sent.at(-1)?.message).toBe("After the minute");
    expect(sent).toHaveLength(PER_MINUTE + 1);
    // A report dropped by the limit is not remembered as sent: it goes out when there is room.
    wait(60_000);
    report("toast", "Still too many");
    expect(sent.at(-1)?.message).toBe("Still too many");
  });

  it("never throws: not for a sender that fails, not for a message that is not text", () => {
    const r = createReporter({
      send: () => {
        throw new Error("the beacon broke");
      },
    });
    expect(() => r.report("crash", "Boom")).not.toThrow();
    expect(() => r.report("crash", undefined)).not.toThrow();
    expect(() => r.report("crash", { toString: () => "odd" })).not.toThrow();
    const { sent, report } = reporter();
    report("crash", "");
    report("crash", "   ");
    report("crash", null);
    expect(sent).toEqual([]);
    report("crash", 404);
    report("crash", "x".repeat(900), "y".repeat(1500));
    expect(sent[0].message).toBe("404");
    expect(sent[1].message).toHaveLength(500);
    expect(sent[1].detail).toHaveLength(1000);
  });

  it("keeps reports while the browser is offline and sends them when the connection is back", () => {
    let online = false;
    const { sent, report, flush } = reporter({ online: () => online });
    report("network", "No connection to the studio. Check the internet and try again.", "GET /api/studio/state");
    report("toast", "No connection to the studio. Check the internet and try again.");
    expect(sent).toEqual([]);
    online = true;
    flush();
    expect(sent.map((x) => x.kind)).toEqual(["network", "toast"]);
    flush();
    expect(sent).toHaveLength(2);
  });

  it("stays quiet for a kind it is told not to report (requests cut off by leaving the page)", () => {
    const { sent, report } = reporter({ quiet: (kind) => kind === "network" });
    report("network", "No connection to the studio.");
    report("toast", "No connection to the studio.");
    expect(sent.map((x) => x.kind)).toEqual(["toast"]);
  });

  it("sends nothing outside a page (a test, a script): the page's reporter needs a window", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => reportError("crash", "Boom in a test")).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the toast wrapper", () => {
  function toasts() {
    const shown: unknown[][] = [];
    const reports: [Kind, unknown, unknown][] = [];
    const toast = {
      error: (...args: unknown[]) => (shown.push(["error", ...args]), "id-e"),
      warning: (...args: unknown[]) => (shown.push(["warning", ...args]), "id-w"),
      success: (...args: unknown[]) => (shown.push(["success", ...args]), "id-s"),
    };
    const report = (kind: Kind, message: unknown, detail?: unknown) => void reports.push([kind, message, detail]);
    return { shown, reports, toast, report };
  }

  it("reports each error and warning toast with the text shown, and shows the toast as before", () => {
    const { shown, reports, toast, report } = toasts();
    wrapToasts(toast, report);
    expect(toast.error("The picture could not be made.")).toBe("id-e");
    expect(toast.error("Could not publish.", { description: "Instagram refused the caption." })).toBe("id-e");
    expect(toast.warning("3 posts have no picture yet.", { duration: 5000 })).toBe("id-w");
    toast.success("Saved.");
    expect(reports).toEqual([
      ["toast", "The picture could not be made.", undefined],
      ["toast", "Could not publish.", "Instagram refused the caption."],
      ["toast", "3 posts have no picture yet.", "warning"],
    ]);
    expect(shown).toEqual([
      ["error", "The picture could not be made."],
      ["error", "Could not publish.", { description: "Instagram refused the caption." }],
      ["warning", "3 posts have no picture yet.", { duration: 5000 }],
      ["success", "Saved."],
    ]);
  });

  it("reports a message that is not plain text as a rich message", () => {
    const { reports, toast, report } = toasts();
    wrapToasts(toast, report);
    toast.error({ type: "div", props: {} });
    toast.error(() => "made later");
    toast.error("");
    expect(reports.map((r) => r[1])).toEqual(["[rich message]", "[rich message]", "[rich message]"]);
    expect(toastText(12)).toBe("12");
  });

  it("wraps once, and a reporter that fails never stops the toast", () => {
    const { shown, reports, toast, report } = toasts();
    wrapToasts(toast, report);
    wrapToasts(toast, report);
    toast.error("Once.");
    expect(reports).toHaveLength(1);
    const other = toasts();
    wrapToasts(other.toast, () => {
      throw new Error("the reporter broke");
    });
    expect(other.toast.error("Still shown.")).toBe("id-e");
    expect(other.toast.warning("Still shown.")).toBe("id-w");
    expect(other.shown).toHaveLength(2);
    expect(shown).toHaveLength(1);
  });
});

describe("uncaught errors", () => {
  const stack = (file: string) => `TypeError: x is undefined\n    at render (${file}:12:34)\n    at commit (${ORIGIN}/assets/vendor-Ab12Cd34.js:1:2)\n    at a (${ORIGIN}/assets/vendor-Ab12Cd34.js:3:4)\n    at b (${ORIGIN}/assets/vendor-Ab12Cd34.js:5:6)`;
  const error = (message: string, file: string) => Object.assign(new TypeError(message), { stack: stack(file) });

  it("reports this site's own errors with the top of the stack, the address left out", () => {
    const e = error("x is undefined", `${ORIGIN}/assets/Workspace-D3kd9Ksl.js`);
    expect(crashFromError({ message: "Uncaught TypeError: x is undefined", filename: `${ORIGIN}/assets/Workspace-D3kd9Ksl.js`, error: e }, ORIGIN)).toEqual({
      message: "x is undefined",
      detail: "at render (/assets/Workspace-D3kd9Ksl.js:12:34)\nat commit (/assets/vendor-Ab12Cd34.js:1:2)\nat a (/assets/vendor-Ab12Cd34.js:3:4)",
    });
    expect(stackTop("f@https://studio.test/a.js:1:2\ng@https://studio.test/b.js:3:4", ORIGIN, 1)).toBe("f@/a.js:1:2");
  });

  it("ignores ResizeObserver loops, another site's 'Script error.' and browser extensions", () => {
    expect(crashFromError({ message: "ResizeObserver loop completed with undelivered notifications." }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "ResizeObserver loop limit exceeded" }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "Script error." }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "Uncaught TypeError: y", filename: "chrome-extension://abcdefgh/content.js", error: new TypeError("y") }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "Uncaught TypeError: y", filename: "https://cdn.other.test/widget.js" }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "Uncaught TypeError: y", error: error("y", "moz-extension://1234/inject.js") }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "Uncaught TypeError: y", error: Object.assign(new TypeError("y"), { stack: "TypeError: y\n    at z (https://cdn.other.test/widget.js:1:1)" }) }, ORIGIN)).toBeNull();
    expect(crashFromError({ message: "" }, ORIGIN)).toBeNull();
  });

  it("reports a promise nobody caught, but not a cancelled request, an extension's or one already reported", () => {
    expect(crashFromRejection(error("The plan could not be read", `${ORIGIN}/assets/Flow-Zz99Yy88.js`), ORIGIN)?.message).toBe("The plan could not be read");
    expect(crashFromRejection("a plain reason", ORIGIN)).toEqual({ message: "a plain reason", detail: "" });
    expect(crashFromRejection({ message: "an object with a message" }, ORIGIN)).toEqual({ message: "an object with a message", detail: "" });
    expect(crashFromRejection(undefined, ORIGIN)).toBeNull();
    expect(crashFromRejection(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }), ORIGIN)).toBeNull();
    expect(crashFromRejection(error("y", "chrome-extension://abcdefgh/content.js"), ORIGIN)).toBeNull();
    const known = new Error("No connection to the studio.");
    markReported(known);
    expect(crashFromRejection(known, ORIGIN)).toBeNull();
    expect(crashFromError({ message: known.message, error: known }, ORIGIN)).toBeNull();
  });
});

describe("the screen", () => {
  it("is the path and search, with a client's approval link left out; empty outside a page", () => {
    expect(currentScreen()).toBe("");
    vi.stubGlobal("location", { pathname: "/", search: "?client=habibah&month=2026-12" });
    expect(currentScreen()).toBe("/?client=habibah&month=2026-12");
    vi.stubGlobal("location", { pathname: "/share/0123456789abcdef0123456789abcdef", search: "" });
    expect(currentScreen()).toBe("/share/[link]");
  });

  it("adds the stage of the workflow, the selected tab and an open dialog when the page shows them", () => {
    vi.stubGlobal("location", { pathname: "/", search: "?client=habibah" });
    const el = (text: string, extra: Record<string, unknown> = {}) => ({ textContent: text, closest: () => null, getAttribute: () => null, querySelector: () => null, ...extra });
    const page = (found: Record<string, unknown>) => ({
      querySelectorAll: (q: string) => (found[q] as unknown[]) ?? [],
      querySelector: (q: string) => found[q] ?? null,
    });
    vi.stubGlobal("document", page({ ".flow-stage.now": [el("4 Studio")], 'main [role="tab"][aria-selected="true"]': el("Feed") }));
    expect(currentScreen()).toBe("/?client=habibah · Studio · Feed");
    // The journey's rail wins over the Studio's own; a dialog is named by its label.
    vi.stubGlobal("document", page({ ".flow-stage.now": [el("4 Studio", { closest: () => ({}) }), el("2 Direction")], '[role="dialog"]': [el("", { getAttribute: () => "Brand kit" })] }));
    expect(currentScreen()).toBe("/?client=habibah · Direction · Brand kit");
    // No stage on the page: its title.
    vi.stubGlobal("document", page({ "main .workspace-head h1": el("Admin") }));
    expect(currentScreen()).toBe("/?client=habibah · Admin");
    // A page that cannot be read is not a reason to fail.
    vi.stubGlobal("document", { querySelectorAll: () => { throw new Error("no"); } });
    expect(currentScreen()).toBe("");
  });
});

describe("src/api.ts reports its own failures", () => {
  /** A page: a window, a beacon that records what it was given, and a fetch the test scripts. */
  async function page(fetch: (path: string, init?: { method?: string; signal?: AbortSignal }) => Promise<Response>) {
    vi.resetModules();
    const beacons: { url: string; body: Blob }[] = [];
    const fetched = vi.fn(fetch);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { onLine: true, sendBeacon: (url: string, body: Blob) => (beacons.push({ url, body }), true) });
    vi.stubGlobal("location", { pathname: "/", search: "?client=habibah" });
    vi.stubGlobal("fetch", fetched);
    const api = (await import("../src/api".toString())) as Api;
    const reports = async () => Promise.all(beacons.map(async (b) => ({ url: b.url, type: b.body.type, ...(JSON.parse(await b.body.text()) as Report) })));
    return { api, reports, fetched };
  }
  const answer = (body: unknown, status = 200, build = "build-7") => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Build": build } });

  it("a request with no answer is reported as network, with the method and the path", async () => {
    const { api, reports } = await page(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.post("/api/studio/posts/plan", { batch: "b1" })).rejects.toThrow(api.NO_CONNECTION);
    expect(await reports()).toEqual([{ url: ERRORS_PATH, type: "application/json", kind: "network", message: api.NO_CONNECTION, detail: "POST /api/studio/posts/plan", screen: "/?client=habibah" }]);
  });

  it("a request that takes too long is reported as network, saying so", async () => {
    vi.useFakeTimers();
    const { api, reports } = await page(
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    const pending = api.get("/api/studio/state").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(api.TIMEOUT_MS + 1);
    expect(((await pending) as Error).message).toBe(api.TOO_LONG);
    vi.useRealTimers();
    expect(await reports()).toMatchObject([{ kind: "network", message: api.TOO_LONG, detail: "GET /api/studio/state · no answer in time" }]);
  });

  it("a 5xx answer is reported as server with the status, and the build the page runs", async () => {
    let n = 0;
    const { api, reports } = await page(async () => (n++ === 0 ? answer({ ok: true }) : answer({ error: "Studio request failed. Retry shortly. (POST posts/generate)" }, 500)));
    await api.get("/api/studio/state");
    await expect(api.post("/api/studio/posts/generate", {})).rejects.toMatchObject({ status: 500 });
    expect(await reports()).toMatchObject([{ kind: "server", message: "Studio request failed. Retry shortly. (POST posts/generate)", detail: "POST /api/studio/posts/generate · 500", build: "build-7", screen: "/?client=habibah" }]);
  });

  it("a 4xx answer is not reported here: the user reads it as a message", async () => {
    const { api, reports } = await page(async (path) => (path.includes("login") ? answer({ error: "Email or password is incorrect." }, 401) : answer({ error: "Approve first.", needsApproval: true }, 409)));
    await expect(api.post("/api/auth/login", {})).rejects.toMatchObject({ status: 401 });
    await expect(api.post("/api/studio/posts/generate", {})).rejects.toMatchObject({ status: 409 });
    expect(await reports()).toEqual([]);
  });

  it("never reports a failure of the error log's own call", async () => {
    const { api, reports, fetched } = await page(async (path) => {
      if (path.startsWith(ERRORS_PATH)) return answer({ error: "Studio request failed." }, 500);
      throw new TypeError("Failed to fetch");
    });
    await expect(api.post(ERRORS_PATH, { kind: "toast", message: "x" })).rejects.toMatchObject({ status: 500 });
    await expect(api.get(`${ERRORS_PATH}?x=1`)).rejects.toMatchObject({ status: 500 });
    expect(await reports()).toEqual([]);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it("falls back to a keep-alive fetch when the browser has no beacon, and swallows its failure", async () => {
    const { api, fetched } = await page(async (path) => {
      if (path === ERRORS_PATH) throw new TypeError("Failed to fetch");
      return answer({ error: "Bad gateway." }, 502);
    });
    vi.stubGlobal("navigator", { onLine: true });
    await expect(api.get("/api/studio/state")).rejects.toMatchObject({ status: 502 });
    await new Promise((r) => setTimeout(r, 5));
    const calls = fetched.mock.calls.filter((c) => c[0] === ERRORS_PATH);
    // One report, sent once: its own failure is not reported again.
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin" });
    expect(JSON.parse((calls[0][1] as { body: string }).body)).toMatchObject({ kind: "server", message: "Bad gateway.", detail: "GET /api/studio/state · 502" });
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});
