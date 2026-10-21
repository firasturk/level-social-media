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

export async function postForm<T>(path: string, form: FormData): Promise<T> {
  return parse<T>(await fetch(path, { method: "POST", credentials: "same-origin", body: form }));
}

export async function del<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { method: "DELETE", credentials: "same-origin" }));
}
