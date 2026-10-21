/** Small fetch wrapper: same-origin cookies, JSON errors surfaced as Error messages. */
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
  if (build === null) build = b;
  else if (b !== build && !announced) {
    announced = true;
    onNewBuild?.();
  }
}

async function parse<T>(r: Response): Promise<T> {
  watchBuild(r);
  const data = (await r.json().catch(() => ({}))) as { error?: string } & T;
  if (!r.ok) throw new ApiError(data.error || `Request failed (${r.status})`, r.status, data as Record<string, unknown>);
  return data;
}

export async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { credentials: "same-origin" }));
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
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
  try {
    return await post<T>(path, body);
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
    return post<T>(path, { ...body, approve: true });
  }
}

export async function postForm<T>(path: string, form: FormData): Promise<T> {
  return parse<T>(await fetch(path, { method: "POST", credentials: "same-origin", body: form }));
}

export async function del<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { method: "DELETE", credentials: "same-origin" }));
}
