/**
 * One MCP client for every MCP server the studio talks to (Magnific at mcp.magnific.com, Higgsfield
 * at mcp.higgsfield.ai): JSON-RPC 2.0 over the streamable HTTP transport. `initialize` then the
 * `notifications/initialized` note, the `Mcp-Session-Id` the server hands back, paged
 * `tools/list`, `tools/call`; answers arrive as plain JSON or as the `data:` lines of an event
 * stream. `fetchFn` is injected so a test never reaches a real host.
 *
 * The answer helpers at the end read a tool result defensively: `structuredContent` when present,
 * else the first text block that parses as JSON, else the plain words. Callers keep the raw text in
 * the ledger when a figure cannot be read.
 */
import { StudioError } from "./errors";

export const MCP_PROTOCOL = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RpcAnswer {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** The first JSON-RPC answer in a response body: plain JSON, or the `data:` lines of an event stream. */
export function parseRpcBody(text: string, contentType: string): RpcAnswer | null {
  const t = text.trim();
  if (!t) return null;
  if (/text\/event-stream/i.test(contentType) || t.startsWith("event:") || t.startsWith("data:")) {
    for (const line of t.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as RpcAnswer;
        if (parsed && (parsed.result !== undefined || parsed.error)) return parsed;
      } catch {
        /* a keep-alive or a partial line */
      }
    }
    return null;
  }
  try {
    return JSON.parse(t) as RpcAnswer;
  } catch {
    return null;
  }
}

export interface McpClientOptions {
  /** How the server is named in error messages ("Magnific MCP"). */
  label?: string;
  /** What to do when the server refuses the bearer token. */
  unauthorizedHint?: string;
}

/** An MCP server over fetch; `fetchFn` is injected so a test never reaches the real host. */
export class McpClient {
  private session: string | null = null;
  private nextId = 1;
  private initialised = false;
  /** Always a plain call: Workers refuse the global `fetch` invoked as a method of another object ("Illegal invocation"). */
  private readonly fetchFn: typeof fetch;
  private readonly label: string;
  private readonly unauthorizedHint: string;
  constructor(
    private readonly token: string,
    fetchFn: typeof fetch,
    private readonly url: string,
    opts: McpClientOptions = {},
  ) {
    this.fetchFn = (input, init) => fetchFn(input, init);
    this.label = opts.label ?? "Magnific MCP";
    this.unauthorizedHint = opts.unauthorizedHint ?? "sign in again and save a fresh token under Connection → Freepik.";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
      "MCP-Protocol-Version": MCP_PROTOCOL,
    };
    if (this.session) h["Mcp-Session-Id"] = this.session;
    return h;
  }

  private async post(payload: Record<string, unknown>, expectAnswer: boolean): Promise<RpcAnswer | null> {
    const r = await this.fetchFn(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    const text = await r.text();
    // 401 and 403 both surface as "refused the token"; `httpStatus` lets a caller refresh only on 401.
    if (r.status === 401 || r.status === 403) throw new StudioError(`${this.label} refused the token (${r.status}): ${this.unauthorizedHint}`, 401, true, { httpStatus: r.status });
    if (!r.ok && r.status !== 202) throw new StudioError(`${this.label} (${r.status}): ${text.slice(0, 200) || r.statusText}`, 502);
    if (!expectAnswer) return null;
    const answer = parseRpcBody(text, r.headers.get("content-type") || "");
    if (!answer) throw new StudioError(`${this.label} sent no answer.`, 502);
    if (answer.error) throw new StudioError(`${this.label}: ${answer.error.message ?? "error"}${answer.error.code != null ? ` (${answer.error.code})` : ""}`, 502);
    return answer;
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const answer = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, true);
    return answer!.result as T;
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, false);
  }

  async initialize(): Promise<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> }> {
    const r = await this.rpc<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> }>("initialize", {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "level-social-media", version: "1.0" },
    });
    await this.notify("notifications/initialized");
    this.initialised = true;
    return r;
  }

  private async ready(): Promise<void> {
    if (!this.initialised) await this.initialize();
  }

  async listTools(): Promise<McpTool[]> {
    await this.ready();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.rpc<{ tools?: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.ready();
    const r = await this.rpc<McpCallResult>("tools/call", { name, arguments: args });
    return { content: Array.isArray(r?.content) ? r.content : [], structuredContent: r?.structuredContent, isError: !!r?.isError };
  }
}

/* ───────────── Reading a tool's answer ───────────── */

/** The text of a tool result as one string, for the ledger and for parsing. */
export function resultText(r: McpCallResult): string {
  return r.content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n");
}

/** The structured answer: `structuredContent`, else the first text block that is JSON, else null. */
export function jsonOf(r: McpCallResult): unknown {
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  for (const c of r.content) {
    if (c.type !== "text" || typeof c.text !== "string") continue;
    const t = c.text.trim();
    if (!/^[[{]/.test(t)) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* prose with a bracket */
    }
  }
  return null;
}

/**
 * The first value under any of `keys`, breadth first through objects and arrays, that passes
 * `accept`. Breadth first so a top-level `cost` wins over one buried in a model's parameters.
 */
export function findValue<T = unknown>(root: unknown, keys: string[], accept: (v: unknown) => v is T, depth = 6): T | null {
  const queue: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  while (queue.length) {
    const { v, d } = queue.shift()!;
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      if (d < depth) for (const x of v) queue.push({ v: x, d: d + 1 });
      continue;
    }
    const o = v as Record<string, unknown>;
    for (const k of keys) if (k in o && accept(o[k])) return o[k];
    if (d < depth) for (const x of Object.values(o)) queue.push({ v: x, d: d + 1 });
  }
  return null;
}

const isNumberish = (v: unknown): v is number | string => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()));
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** A number under one of the keys (a numeric string counts). */
export function findNumber(root: unknown, keys: string[]): number | null {
  const v = findValue(root, keys, isNumberish);
  return v === null ? null : Number(v);
}

/** A non-empty string under one of the keys. */
export function findString(root: unknown, keys: string[]): string | null {
  return findValue(root, keys, isText);
}

/** Every object in the answer that has a value under `key` (a list of jobs, of models…), breadth first. */
export function objectsWith(root: unknown, key: string, depth = 6): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const queue: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  while (queue.length) {
    const { v, d } = queue.shift()!;
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      if (d < depth) for (const x of v) queue.push({ v: x, d: d + 1 });
      continue;
    }
    const o = v as Record<string, unknown>;
    if (key in o && o[key] !== null && o[key] !== undefined && o[key] !== "") out.push(o);
    if (d < depth) for (const x of Object.values(o)) queue.push({ v: x, d: d + 1 });
  }
  return out;
}

/** The first https link in an answer, the mp4 ones first. */
export function firstUrl(root: unknown, text: string): string | null {
  const urls: string[] = [];
  const walk = (v: unknown, d: number) => {
    if (d > 6 || v === null) return;
    if (typeof v === "string") {
      if (/^https:\/\/\S+$/.test(v.trim())) urls.push(v.trim());
      return;
    }
    if (typeof v !== "object") return;
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(x, d + 1);
  };
  walk(root, 0);
  for (const m of text.matchAll(/https:\/\/[^\s"'<>)]+/g)) urls.push(m[0]);
  return urls.find((u) => /\.mp4(\?|$)/i.test(u)) ?? urls[0] ?? null;
}
