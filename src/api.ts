/** Small fetch wrapper: same-origin cookies, JSON errors surfaced as Error messages. */
import { ERRORS_PATH, markReported, noteBuild, reportError } from "./lib/errorLog";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The server's JSON body, for answers that carry more than a message (a run to approve). */
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let build: string | null = null;
let announced = false;
/** Called once when the server reports a newer build than the one this page was loaded from. */
export let onNewBuild: (() => void) | null = null;
export function setNewBuildHandler(fn: () => void): void {
  onNewBuild = fn;
}

function watchBuild(r: Response): void {
  const b = r.headers.get("X-Build");
  if (!b) return;
  if (build === null) {
    build = b;
    // The error log names the build a problem happened on.
    noteBuild(b);
  } else if (b !== build && !announced) {
    announced = true;
    onNewBuild?.();
  }
}

/** The longest an ordinary request waits before the studio says so, instead of waiting for ever. */
export const TIMEOUT_MS = 90_000;
/** Work that honestly takes minutes on the server: writing ideas, reading pictures, paid pictures, uploads. */
export const LONG_TIMEOUT_MS = 6 * 60_000;
export const NO_CONNECTION = "No connection to the studio. Check the internet and try again.";
export const TOO_LONG = "This is taking too long. Check the connection and try again; nothing was lost.";

// Requests that ask the server to write, read pictures, make something or call an outside service.
// A family is listed whole when most of it does such work: a wait cut short there fails work that
// would have finished, while a generous wait on a quick call costs nothing.
const LONG_WORK =
  /^\/api\/(admin\/audit|studio\/(posts|profiles?|styles|campaigns|ambassadors|influencers|promptbox|ocr|photo|photolab|video|higgsfield|freepik|media|music|drive|publish|feedback|help|skills|references|upload|start|tick|retry|revise|task|clients\/[^/]+\/realrefs))(?:[/?]|$)/;
// Plain saves inside those families answer at once: they keep the ordinary wait.
const QUICK_SAVE = /^\/api\/studio\/posts\/(plan|caption|remove|reorder|accept|share|comments)(?:\?|$)/;

/** The wait a request gets when its caller names none: reads are quick, long server work gets minutes. */
export function timeoutFor(method: string, path: string): number {
  if (method === "GET" || method === "DELETE") return TIMEOUT_MS;
  return LONG_WORK.test(path) && !QUICK_SAVE.test(path) ? LONG_TIMEOUT_MS : TIMEOUT_MS;
}

/** A request that got no answer, in words a person can act on (the browser only says "Failed to fetch"). */
export function connectionError(timedOut: boolean): Error {
  return new Error(timedOut ? TOO_LONG : NO_CONNECTION);
}

/**
 * Writes a failed request to the error log (src/lib/errorLog.ts) and hands the error back: a
 * request that got no answer is `network`, a 5xx answer is `server`. Never a 4xx (the user reads
 * those as a message, and the log hears of them from there), never the log's own call.
 */
function logged<E extends Error>(kind: "network" | "server", error: E, method: string, path: string, what = ""): E {
  if (!path.startsWith(ERRORS_PATH)) {
    reportError(kind, error.message, `${method} ${path.slice(0, 300)}${what ? ` · ${what}` : ""}`);
    markReported(error);
  }
  return error;
}

/** One request with a deadline over the whole exchange, the answer's body included. */
async function send<T>(path: string, init: RequestInit, timeoutMs?: number): Promise<T> {
  const stop = new AbortController();
  let timedOut = false;
  const method = init.method ?? "GET";
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, timeoutMs ?? timeoutFor(method, path));
  try {
    let r: Response;
    try {
      r = await fetch(path, { ...init, credentials: "same-origin", signal: stop.signal });
    } catch {
      throw logged("network", connectionError(timedOut), method, path, timedOut ? "no answer in time" : "");
    }
    watchBuild(r);
    const data = (await r.json().catch(() => {
      // A body cut off by the deadline is not an empty answer.
      if (timedOut) throw logged("network", connectionError(true), method, path, "no answer in time");
      return {};
    })) as { error?: string } & T;
    if (!r.ok) {
      const failed = new ApiError(data.error || `Request failed (${r.status})`, r.status, data as Record<string, unknown>);
      throw r.status >= 500 ? logged("server", failed, method, path, String(r.status)) : failed;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** `timeoutMs`, here and below: a longer or shorter wait than this path's default. */
export async function get<T>(path: string, timeoutMs?: number): Promise<T> {
  return send<T>(path, {}, timeoutMs);
}

export async function post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return send<T>(
    path,
    {
      method: "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    timeoutMs,
  );
}

export async function put<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  return send<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
}

/** A paid request's answer when the server wants the designer's confirmation first. */
export interface ApprovalAsk {
  needsApproval?: boolean;
  images?: number;
  /** The run's estimate, list prices. */
  estimate?: number;
  /** The most it can cost with automatic retakes, when the server allows them. */
  maximum?: number;
  threshold?: number;
}

/**
 * A request that may cost money: when the server answers 409 "approve first", the designer is
 * asked once with the estimate, and the same request is sent again approved. Null when declined.
 */
export async function postPaid<T>(path: string, body: Record<string, unknown>, what: string): Promise<T | null> {
  // One run id per action: the approval resend carries the same one, so the allowance is added once.
  body = { ...body, run: body.run ?? crypto.randomUUID() };
  try {
    return await post<T>(path, body, LONG_TIMEOUT_MS);
  } catch (e) {
    const err = e as ApiError;
    const d = (err.data ?? {}) as ApprovalAsk;
    if (err.status !== 409 || !d.needsApproval || body.approve) throw e;
    const { askConfirm } = await import("@/lib/confirm");
    const { formatUsd } = await import("@shared/pricing");
    const estimate = formatUsd(d.estimate ?? 0);
    const most = d.maximum && d.maximum > (d.estimate ?? 0) ? ` At most ${formatUsd(d.maximum)} with automatic retakes.` : "";
    const ok = await askConfirm(`${what}: about ${estimate} (list prices, an estimate).${most} Go ahead?`, { ok: `Go ahead · about ${estimate}`, danger: false, cancel: "Not now" });
    if (!ok) return null;
    return post<T>(path, { ...body, approve: true }, LONG_TIMEOUT_MS);
  }
}

/** A form carries files: it gets the long wait whatever its path. */
export async function postForm<T>(path: string, form: FormData, timeoutMs = LONG_TIMEOUT_MS): Promise<T> {
  return send<T>(path, { method: "POST", body: form }, timeoutMs);
}

/** A form sent with the bytes counted as they go (an upload with a progress bar). */
export function uploadForm<T>(path: string, form: FormData, onProgress?: (sent: number, of: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    // The wait counts from the last sign of life, not from the start: a large file on a slow line
    // is still moving, while an upload (or the server's answer after it) that stalls is given up.
    let timer = setTimeout(() => xhr.abort(), LONG_TIMEOUT_MS);
    xhr.upload.onprogress = (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), LONG_TIMEOUT_MS);
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onloadend = () => clearTimeout(timer);
    xhr.onabort = () => reject(logged("network", connectionError(true), "POST", path, "upload, no answer in time"));
    xhr.onerror =() => reject(logged("network", new Error("The upload was interrupted. Check the connection and try again."), "POST", path, "upload"));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        const failed = new ApiError((data as { error?: string } | null)?.error ?? `Request failed (${xhr.status})`, xhr.status, (data ?? undefined) as Record<string, unknown> | undefined);
        reject(xhr.status >= 500 ? logged("server", failed, "POST", path, `upload · ${xhr.status}`) : failed);
      }
    };
    xhr.send(form);
  });
}

export async function del<T>(path: string, timeoutMs?: number): Promise<T> {
  return send<T>(path, { method: "DELETE" }, timeoutMs);
}
