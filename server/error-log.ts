/**
 * The error log: every failed action and server error is written down with the user and the
 * screen, so a problem is found the day it happens (the owner's decision, 15 Nov 2026).
 *
 * Rows come from two sides. The page reports what the user was shown (an error toast), what broke
 * (an uncaught error, a failed render), requests that got no answer and 5xx answers: POST
 * /api/studio/errors. The server records its own side in the global error handler: unexpected
 * throws and StudioErrors of status 500 and above, never a 4xx (a wrong password, a validation
 * message, a conflict: the user is shown those, and they arrive through the page as toasts).
 *
 * What is never stored: request bodies, cookies, headers. Anything that looks like a key or a
 * token is stripped from the message, the detail and the screen before a row is written.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import type { User } from "@shared/types";

export const ERROR_KINDS = ["toast", "crash", "network", "server"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const MESSAGE_MAX = 500;
export const DETAIL_MAX = 1000;
const SCREEN_MAX = 300;
const BUILD_MAX = 40;
/** The most rows one person (or the signed-out side) adds in a minute; the rest are dropped. */
export const PER_MINUTE = 20;
/** The most rows of one problem one person adds in a minute. */
export const SAME_PER_MINUTE = 5;
/** What the Admin page looks back over. */
export const WINDOW_DAYS = 14;
/** How long a row is kept. */
export const KEEP_DAYS = 30;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A run of letters and digits that reads as a generated key, not as a word, a file name or an id. */
function looksRandom(runOfChars: string): boolean {
  if (UUID.test(runOfChars)) return false;
  const mixed = (s: string) => /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
  const separators = (runOfChars.match(/[-_+=]/g) ?? []).length;
  // Mixed case with digits and hardly a separator: a base64 key. A name-like-this-2026-Final has many.
  if (runOfChars.length >= 24 && mixed(runOfChars) && separators <= runOfChars.length / 12) return true;
  return runOfChars.split(/[-_+=]/).some((piece) => piece.length >= 32 && /\d/.test(piece) && /[a-z]/i.test(piece));
}

/** The names a secret travels under in a query string or a JSON body: api_key, access-token, password… */
const NAMED = "[\\w-]*(?:key|token|secret|password|passwd|signature|authorization)";
const NAMED_IN_QUERY = new RegExp(`\\b(${NAMED}|sig)=[^\\s&"',;)]{4,}`, "gi");
const NAMED_IN_JSON = new RegExp(`"(${NAMED})"\\s*:\\s*"[^"]{4,}"`, "gi");

/**
 * Takes out anything that looks like a key or a token: "Bearer …", `sk-…` and the other vendor
 * prefixes, JWTs, `token=…` / `"api_key": "…"` values, long hex runs (a share link's token is
 * one) and long base64 runs. Ordinary words, numbers, paths and uuids stay.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(bearer)\s+(?=\S*\d)[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]")
    .replace(/\b(basic)\s+[A-Za-z0-9+/=]{16,}/gi, "$1 [secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/g, "[secret]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[secret]")
    .replace(/\b(?:re_|ghp_|gho_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{16,}/g, "[secret]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[secret]")
    .replace(NAMED_IN_QUERY, "$1=[secret]")
    .replace(NAMED_IN_JSON, '"$1":"[secret]"')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[secret]")
    .replace(/[A-Za-z0-9+_=-]{24,}/g, (r) => (looksRandom(r) ? "[secret]" : r));
}

/** Scrubbed, runs of spaces closed up (line breaks stay: a stack has lines), and cut to its cap. */
function clean(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = scrubSecrets(String(text)).replace(/[ \t]+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/**
 * The message with everything that changes from one occurrence to the next replaced: links,
 * e-mail addresses, quoted names, ids, amounts and numbers. "Could not save “Eid offer” (post 3)"
 * and "Could not save “Summer” (post 12)" read the same afterwards.
 */
export function normaliseMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/[“"«][^”"»\n]{0,160}[”"»]/g, "<name>")
    // Single quotes only where they open and close a quotation, never an apostrophe (can't, Mona's).
    .replace(/(^|[\s([:,])['‘][^'’\n]{1,160}['’](?=$|[\s.,;:!?)\]])/g, "$1<name>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/g, "<id>")
    .replace(/(?:≈\s*)?[$€£]\s?\d[\d,]*(?:\.\d+)?/g, "<amount>")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:usd|aed|sar|egp|kwd|qar|bhd|omr|jod|eur|gbp)\b/g, "<amount>")
    .replace(/\d+(?:[.,:]\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Two 32-bit FNV-1a passes (different seeds) as 16 hex characters: stable across deploys. */
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193) >>> 0;
    b = Math.imul(b ^ ch, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The same problem, whoever met it and whatever the numbers were, has the same fingerprint. */
export function fingerprintOf(kind: string, message: string): string {
  return hash(`${kind}|${normaliseMessage(message)}`);
}

/** A request path that is safe to keep: the token of a shared deck or approval link is not written down. */
export function safePath(path: string): string {
  return path.replace(/^\/d\/[^/]+/, "/d/[link]").replace(/^(\/api\/share|\/share)\/[^/]+/, "$1/[link]");
}

/** The first lines of a stack under its message: where it broke, without the whole trace. */
export function stackTop(e: unknown, lines = 3): string {
  const stack = e instanceof Error ? (e.stack ?? "") : "";
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^at\s/.test(l))
    .slice(0, lines)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Storing

export interface ErrorInput {
  kind: ErrorKind;
  message: string;
  detail?: string | null;
  screen?: string | null;
  build?: string | null;
  user?: Pick<User, "id" | "name" | "role"> | null;
}

/**
 * Writes one row, unless this person has already added too many this minute (in all, or of this
 * same problem). True when a row was stored. Throws only what the database throws: callers that
 * must never fail wrap it.
 */
export async function recordError(env: Env, input: ErrorInput): Promise<boolean> {
  const message = clean(input.message, MESSAGE_MAX);
  if (!message) return false;
  const fingerprint = fingerprintOf(input.kind, message);
  const userId = input.user?.id ?? null;
  const at = now();
  const recent = await first<{ n: number; same: number | null }>(
    env.DB,
    "SELECT COUNT(*) AS n, SUM(CASE WHEN fingerprint = ? THEN 1 ELSE 0 END) AS same FROM error_log WHERE at > ? AND user_id IS ?",
    fingerprint,
    at - MINUTE,
    userId,
  );
  if ((recent?.n ?? 0) >= PER_MINUTE || (recent?.same ?? 0) >= SAME_PER_MINUTE) return false;
  await run(
    env.DB,
    "INSERT INTO error_log (id, at, kind, user_id, user_name, role, screen, message, detail, build, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    uuid(),
    at,
    input.kind,
    userId,
    input.user?.name ?? null,
    input.user?.role ?? null,
    clean(input.screen, SCREEN_MAX),
    message,
    clean(input.detail, DETAIL_MAX),
    clean(input.build, BUILD_MAX),
    fingerprint,
  );
  return true;
}

/**
 * The server's side, called from the global error handler: an unexpected throw or a StudioError of
 * status 500 and above, with the user when the request had one, the method and path, and the
 * error's text. Never a 4xx. Never throws and never holds the answer back: the write runs after
 * the response where the runtime allows it, and its own failure is swallowed.
 */
export function captureServerError(c: Context, e: unknown, status: number, build?: string): void {
  try {
    if (status < 500) return;
    let user: User | undefined;
    try {
      user = (c as Context<{ Variables: { user?: User } }>).get("user");
    } catch {
      /* no user on this request */
    }
    const text = e instanceof Error ? e.message || e.name : typeof e === "string" ? e : "Unknown error";
    const request = `${c.req.method} ${safePath(c.req.path)} · ${status}`;
    const top = e instanceof StudioError ? "" : stackTop(e);
    const work = recordError(c.env as Env, {
      kind: "server",
      message: text,
      detail: top ? `${request}\n${top}` : request,
      build,
      user: user ? { id: user.id, name: user.name, role: user.role } : null,
    }).catch(() => false);
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      /* no execution context (a test, a local run): the write goes on by itself */
    }
  } catch {
    /* recording a problem must never be a problem */
  }
}

/** Removes rows older than 30 days. Called from the daily cleanup. */
export async function cleanupErrorLog(env: Env): Promise<number> {
  return run(env.DB, "DELETE FROM error_log WHERE at < ?", now() - KEEP_DAYS * DAY);
}

// ---------------------------------------------------------------------------------------------
// Routes

type Variables = { user: User };

const reportSchema = z.object({
  kind: z.enum(ERROR_KINDS),
  // Longer strings are cut, not refused; only an absurd body is turned away.
  message: z.string().min(1).max(20_000),
  detail: z.string().max(20_000).nullish(),
  screen: z.string().max(4_000).nullish(),
  build: z.string().max(200).nullish(),
});

/** POST /api/studio/errors: the page's reports. Signed-in users only (the /api/studio guard). */
export const errorLogRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

errorLogRoutes.post("/", async (c) => {
  const parsed = reportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new StudioError("Invalid report.");
  const user = c.get("user");
  // Over the limit, or the database is having a bad minute: the answer is still fine. A logging
  // call never fails the page.
  const stored = await recordError(c.env, { ...parsed.data, user: { id: user.id, name: user.name, role: user.role } }).catch(() => false);
  return c.json({ ok: true, stored });
});

export interface ErrorRow {
  id: string;
  at: number;
  kind: ErrorKind;
  user_id: string | null;
  user_name: string | null;
  role: string | null;
  screen: string | null;
  message: string;
  detail: string | null;
  build: string | null;
  fingerprint: string;
}

export interface ErrorGroup {
  fingerprint: string;
  kind: ErrorKind;
  /** The latest occurrence's message, as the user saw it. */
  message: string;
  count: number;
  /** The names of the people who met it. */
  users: string[];
  first: number;
  last: number;
  /** The screen and detail of the latest occurrence that has one. */
  screen: string | null;
  detail: string | null;
}

export interface ErrorSummary {
  groups: ErrorGroup[];
  /** Occurrences per day (UTC), oldest first, the last 14 days with today. */
  days: { day: string; count: number }[];
  last24h: number;
  total: number;
}

export async function errorSummary(env: Env): Promise<ErrorSummary> {
  const t = now();
  const since = t - WINDOW_DAYS * DAY;
  const groups = await all<Omit<ErrorGroup, "users">>(
    env.DB,
    `SELECT g.fingerprint, g.kind, g.count, g.first, g.last,
       (SELECT message FROM error_log x WHERE x.fingerprint = g.fingerprint ORDER BY x.at DESC LIMIT 1) AS message,
       (SELECT screen FROM error_log x WHERE x.fingerprint = g.fingerprint AND x.screen IS NOT NULL ORDER BY x.at DESC LIMIT 1) AS screen,
       (SELECT detail FROM error_log x WHERE x.fingerprint = g.fingerprint AND x.detail IS NOT NULL ORDER BY x.at DESC LIMIT 1) AS detail
     FROM (SELECT fingerprint, MIN(kind) AS kind, COUNT(*) AS count, MIN(at) AS first, MAX(at) AS last
           FROM error_log WHERE at >= ? GROUP BY fingerprint) g
     ORDER BY g.last DESC LIMIT 200`,
    since,
  );
  const people = await all<{ fingerprint: string; name: string }>(
    env.DB,
    "SELECT fingerprint, MAX(user_name) AS name FROM error_log WHERE at >= ? AND user_id IS NOT NULL GROUP BY fingerprint, user_id ORDER BY MAX(at) DESC",
    since,
  );
  const names = new Map<string, string[]>();
  for (const p of people) {
    if (!p.name) continue;
    const list = names.get(p.fingerprint) ?? [];
    if (!list.includes(p.name)) list.push(p.name);
    names.set(p.fingerprint, list);
  }
  const today = Math.floor(t / DAY);
  const perDay = await all<{ d: number; n: number }>(env.DB, "SELECT CAST(at / 86400000 AS INTEGER) AS d, COUNT(*) AS n FROM error_log WHERE at >= ? GROUP BY d", (today - (WINDOW_DAYS - 1)) * DAY);
  const byDay = new Map(perDay.map((r) => [Number(r.d), Number(r.n)]));
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const d = today - (WINDOW_DAYS - 1) + i;
    return { day: new Date(d * DAY).toISOString().slice(0, 10), count: byDay.get(d) ?? 0 };
  });
  const counts = await first<{ total: number; recent: number | null }>(env.DB, "SELECT COUNT(*) AS total, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS recent FROM error_log WHERE at >= ?", t - DAY, since);
  return {
    groups: groups.map((g) => ({ ...g, users: names.get(g.fingerprint) ?? [] })),
    days,
    last24h: counts?.recent ?? 0,
    total: counts?.total ?? 0,
  };
}

/** /api/admin/errors: the list for the Admin page, one group's occurrences, and "Resolved". */
export const errorAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

errorAdminRoutes.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admin only.", 403);
  await next();
});

errorAdminRoutes.get("/", async (c) => {
  const fingerprint = c.req.query("fingerprint");
  if (fingerprint) {
    const rows = await all<ErrorRow>(c.env.DB, "SELECT * FROM error_log WHERE fingerprint = ? ORDER BY at DESC LIMIT 50", fingerprint.slice(0, 64));
    return c.json({ rows });
  }
  return c.json(await errorSummary(c.env));
});

errorAdminRoutes.post("/clear", async (c) => {
  const parsed = z.object({ fingerprint: z.string().min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new StudioError("Choose a problem to mark as resolved.");
  const removed = await run(c.env.DB, "DELETE FROM error_log WHERE fingerprint = ?", parsed.data.fingerprint);
  return c.json({ ok: true, removed });
});
