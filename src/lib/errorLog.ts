/**
 * The page's side of the error log: what the user was shown (an error toast), what broke (an
 * uncaught error, a failed render), requests that got no answer and 5xx answers are sent to
 * POST /api/studio/errors with the screen and the build, so a problem is found the day it happens.
 *
 * Reporting is fire-and-forget. It never throws, never shows a toast and never reports its own
 * failure (it does not go through src/api.ts, so a failed report cannot come back as a report).
 * The same message is sent once in 10 seconds, and a tab sends at most 10 reports a minute.
 */

export type ErrorKind = "toast" | "crash" | "network" | "server";

export interface ErrorReport {
  kind: ErrorKind;
  message: string;
  detail?: string;
  screen?: string;
  build?: string;
}

export const ERRORS_PATH = "/api/studio/errors";
/** The same message again within this long is the same event: dropped. */
export const DUPLICATE_MS = 10_000;
/** The most reports one tab sends in a minute. */
export const PER_MINUTE = 10;
/** Reports kept while the browser says it is offline, sent when the connection is back. */
const HELD_MAX = 10;
const MESSAGE_MAX = 500;
const DETAIL_MAX = 1000;
const RICH = "[rich message]";

export interface ReporterOptions {
  /** Sends one report. Its failures are its own: nothing here hears about them. */
  send: (report: ErrorReport) => void;
  now?: () => number;
  /** The screen and the build, read at the moment of the report. */
  context?: () => { screen?: string; build?: string };
  /** False while the browser knows it has no connection: reports wait for `flush`. */
  online?: () => boolean;
  /** True for a kind that should not be reported right now (requests cut off by leaving the page). */
  quiet?: (kind: ErrorKind) => boolean;
}

export interface Reporter {
  report: (kind: ErrorKind, message: unknown, detail?: unknown) => void;
  /** Sends what waited for the connection. */
  flush: () => void;
}

/** A reporter with its own duplicate memory and rate limit (the page has one; tests make their own). */
export function createReporter(options: ReporterOptions): Reporter {
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, number>();
  let sentAt: number[] = [];
  let held: ErrorReport[] = [];

  function report(kind: ErrorKind, message: unknown, detail?: unknown): void {
    try {
      const text = (typeof message === "string" ? message : String(message ?? "")).trim().slice(0, MESSAGE_MAX);
      if (!text || options.quiet?.(kind)) return;
      const t = now();
      const key = `${kind}|${text}`;
      const last = lastSent.get(key);
      if (last !== undefined && t - last < DUPLICATE_MS) return;
      sentAt = sentAt.filter((x) => t - x < 60_000);
      if (sentAt.length >= PER_MINUTE) return;
      sentAt.push(t);
      if (lastSent.size > 100) for (const [k, at] of lastSent) if (t - at >= DUPLICATE_MS) lastSent.delete(k);
      lastSent.set(key, t);
      const context = options.context?.() ?? {};
      const out: ErrorReport = { kind, message: text };
      const more = typeof detail === "string" ? detail.trim().slice(0, DETAIL_MAX) : "";
      if (more) out.detail = more;
      if (context.screen) out.screen = context.screen;
      if (context.build) out.build = context.build;
      if (options.online && !options.online()) {
        if (held.length < HELD_MAX) held.push(out);
        return;
      }
      options.send(out);
    } catch {
      /* reporting a problem must never be a problem */
    }
  }

  function flush(): void {
    const waiting = held;
    held = [];
    for (const r of waiting) {
      try {
        options.send(r);
      } catch {
        /* dropped */
      }
    }
  }

  return { report, flush };
}

// ---------------------------------------------------------------------------------------------
// The page's own reporter

let build: string | null = null;
/** The build this page was loaded from (the first X-Build the server answered with); src/api.ts tells us. */
export function noteBuild(value: string): void {
  if (build === null && value) build = value;
}

const short = (text: string | null | undefined, max = 40) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Where the user is: the path and search, then what the page itself shows as current (the stage
 * of the workflow or the page's title, the selected tab, an open dialog), read from the DOM so no
 * screen has to tell us.
 */
export function currentScreen(): string {
  try {
    if (typeof location === "undefined") return "";
    // A client's approval link carries its secret in the path: it is not written down.
    const where = (location.pathname + location.search).replace(/^\/share\/[^/?]+/, "/share/[link]");
    const parts = [where];
    if (typeof document !== "undefined") {
      const stages = [...document.querySelectorAll(".flow-stage.now")];
      // The journey's own rail wins over the Studio's when both are on the page.
      const stage = stages.find((el) => !el.closest(".studio-rail")) ?? stages[0];
      const step = stage ? short(stage.textContent).replace(/^\d+\s*/, "") : short(document.querySelector("main .workspace-head h1")?.textContent);
      if (step) parts.push(step);
      const tab = short(document.querySelector('main [role="tab"][aria-selected="true"]')?.textContent);
      if (tab && tab !== step) parts.push(tab);
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const dialog = dialogs[dialogs.length - 1];
      const title = dialog ? short(dialog.getAttribute("aria-label") || dialog.querySelector("h1, h2, h3")?.textContent) : "";
      if (title) parts.push(title);
    }
    return parts.join(" · ").slice(0, 300);
  } catch {
    return "";
  }
}

/** A beacon where the browser has one (it survives the page closing), else a keep-alive fetch. Never throws. */
function sendToServer(report: ErrorReport): void {
  // Only a page reports: nothing is sent from a test or any other place without a window.
  if (typeof window === "undefined") return;
  const body = JSON.stringify(report);
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ERRORS_PATH, new Blob([body], { type: "application/json" }))) return;
  } catch {
    /* fall through to fetch */
  }
  try {
    void fetch(ERRORS_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch {
    /* dropped: a failed report is not reported */
  }
}

/** Requests cut off because the page is closing or reloading are not connection problems. */
let leavingUntil = 0;

const page = createReporter({
  send: sendToServer,
  context: () => ({ screen: currentScreen() || undefined, build: build ?? undefined }),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  quiet: (kind) => kind === "network" && Date.now() < leavingUntil,
});

/** Errors already written to the log by the code that raised them (src/api.ts), so they are not logged again as uncaught. */
const reported = new WeakSet<object>();
export function markReported(error: unknown): void {
  if (error && typeof error === "object") reported.add(error);
}

/**
 * Records one problem: `toast` = an error message the user was shown, `crash` = an uncaught error
 * or a failed render, `network` = no connection or a timeout, `server` = a 5xx answer.
 */
export function reportError(kind: ErrorKind, message: unknown, detail?: unknown): void {
  page.report(kind, message, detail);
}

// ---------------------------------------------------------------------------------------------
// Hooks

/** What a toast said, when it said it in plain text. */
export function toastText(message: unknown): string {
  if (typeof message === "string") return message.trim() || RICH;
  if (typeof message === "number") return String(message);
  return RICH;
}

const WRAPPED = Symbol.for("level.errorLog.toasts");

/**
 * Wraps `toast.error` and `toast.warning` once, so every error message the user is shown is also
 * written to the log. Call sites stay as they are; the toast itself is untouched.
 */
export function wrapToasts<F extends (...args: never[]) => unknown>(toast: { error: F; warning: F }, report: (kind: ErrorKind, message: unknown, detail?: unknown) => void = reportError): void {
  const marked = toast as { error: F; warning: F; [WRAPPED]?: true };
  if (marked[WRAPPED]) return;
  marked[WRAPPED] = true;
  const error = toast.error;
  const warning = toast.warning;
  toast.error = ((...args: Parameters<F>) => {
    try {
      const description = (args[1] as { description?: unknown } | undefined)?.description;
      report("toast", toastText(args[0]), typeof description === "string" ? description : undefined);
    } catch {
      /* the toast still shows */
    }
    return error.apply(toast, args);
  }) as F;
  toast.warning = ((...args: Parameters<F>) => {
    try {
      report("toast", toastText(args[0]), "warning");
    } catch {
      /* the toast still shows */
    }
    return warning.apply(toast, args);
  }) as F;
}

const EXTENSION = /(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|webkit-masked-url:\/\//i;
const NOISE = /ResizeObserver loop|^Script error\.?$/i;

/** The first lines of a stack under its message, without the site's address. */
export function stackTop(stack: string | null | undefined, origin = "", lines = 3): string {
  return (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^at\s|@/.test(l))
    .slice(0, lines)
    .map((l) => (origin ? l.split(origin).join("") : l))
    .join("\n");
}

/** True when a stack names scripts and none of them is this site's: an extension or an embedded tool, not the app. */
function foreignStack(stack: string | null | undefined, origin: string): boolean {
  if (!stack) return false;
  if (EXTENSION.test(stack)) return true;
  const urls = stack.match(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi) ?? [];
  return urls.length > 0 && !!origin && !urls.some((u) => u.startsWith(origin));
}

/**
 * What an uncaught error is worth: null for the browser's own noise (ResizeObserver loops, "Script
 * error." from another site's script) and for scripts that are not this site's (extensions).
 */
export function crashFromError(input: { message?: string; filename?: string; error?: unknown }, origin: string): { message: string; detail: string } | null {
  const err = input.error;
  const message = (err instanceof Error ? err.message : "") || input.message || "";
  if (!message || NOISE.test(message) || NOISE.test(input.message ?? "")) return null;
  if (err && typeof err === "object" && reported.has(err)) return null;
  const file = input.filename ?? "";
  if (file && (EXTENSION.test(file) || (!!origin && /^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.startsWith(origin)))) return null;
  const stack = err instanceof Error ? err.stack : "";
  if (foreignStack(stack, origin)) return null;
  return { message, detail: stackTop(stack, origin) || (file ? file.split(origin).join("") : "") };
}

/** The same for a promise nobody caught. A cancelled request is not a problem. */
export function crashFromRejection(reason: unknown, origin: string): { message: string; detail: string } | null {
  if (reason && typeof reason === "object" && reported.has(reason)) return null;
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return null;
    return crashFromError({ error: reason, message: reason.message || reason.name }, origin);
  }
  const text = typeof reason === "string" ? reason : reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string" ? (reason as { message: string }).message : "";
  if (!text || NOISE.test(text)) return null;
  return { message: text, detail: "" };
}

let installed = false;

/** The page-wide hooks: uncaught errors and unhandled promise rejections, once. */
export function installGlobalHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const origin = window.location.origin;
  window.addEventListener("error", (ev) => {
    try {
      const crash = crashFromError({ message: ev.message, filename: ev.filename, error: ev.error }, origin);
      if (crash) reportError("crash", crash.message, crash.detail);
    } catch {
      /* never from here */
    }
  });
  window.addEventListener("unhandledrejection", (ev) => {
    try {
      const crash = crashFromRejection(ev.reason, origin);
      if (crash) reportError("crash", crash.message, crash.detail);
    } catch {
      /* never from here */
    }
  });
  window.addEventListener("online", () => page.flush());
  // Leaving cuts the requests in flight: those are not "no connection".
  window.addEventListener("beforeunload", () => {
    leavingUntil = Date.now() + 4_000;
  });
  window.addEventListener("pagehide", () => {
    leavingUntil = Infinity;
  });
  window.addEventListener("pageshow", () => {
    leavingUntil = 0;
  });
}
