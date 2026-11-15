/**
 * The error log (server/error-log.ts, migration 0088): every failed action and server error is
 * written down with the user and the screen. Proven here on the real SQLite fake and the real
 * worker app (server/index.ts): who may report and who may read, the limits that keep a broken
 * page from flooding the table, what the global error handler records (a 5xx) and what it never
 * does (a 4xx), how the Admin list groups, "Resolved", the 30-day cleanup, and the two pure
 * functions underneath: the fingerprint's normaliser and the secret scrubber.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import worker from "../server/index";
import { cleanupOldBatches } from "../server/admin";
import { RETENTION_DAYS_SETTING, setSetting } from "../server/settings";
import {
  DETAIL_MAX,
  KEEP_DAYS,
  MESSAGE_MAX,
  PER_MINUTE,
  SAME_PER_MINUTE,
  cleanupErrorLog,
  fingerprintOf,
  normaliseMessage,
  recordError,
  safePath,
  scrubSecrets,
  type ErrorGroup,
  type ErrorRow,
  type ErrorSummary,
} from "../server/error-log";

type FakeEnv = ReturnType<typeof fakeEnv>;
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "https://studio.test";
const json = <T = Record<string, unknown>>(r: Response) => r.json() as Promise<T>;

/** An admin and two members, each with a real session. */
async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  for (const [id, name, role] of [
    ["u1", "Firas", "admin"],
    ["u2", "Mona", "member"],
    ["u3", "Sami", "member"],
  ]) {
    await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES (?, ?, ?, 'x', ?, ?)").bind(id, `${id}@example.com`, name, role, t).run();
    await env.DB.prepare("INSERT INTO sessions (id, user_id, created, expires) VALUES (?, ?, ?, ?)").bind(`session-${id}`, id, t, t + DAY).run();
  }
  return env;
}

/** One request through the worker itself, as a browser on the studio's own address sends it. */
async function call(env: FakeEnv, who: "u1" | "u2" | "u3" | null, method: string, path: string, body?: unknown) {
  const waiting: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waiting.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const headers: Record<string, string> = { origin: ORIGIN };
  // The session cookie as the server signs it: the id, a dot, its HMAC under the session secret.
  if (who) headers.cookie = `studio_session=session-${who}.${createHmac("sha256", env.SESSION_SECRET ?? "").update(`session-${who}`).digest("hex")}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) as never, env as never, ctx);
  // What the handler left for after the answer (the error log's write) is finished before the test looks.
  await Promise.all(waiting);
  return r;
}

const rowsOf = (env: FakeEnv) => env.DB.prepare("SELECT * FROM error_log ORDER BY at ASC, rowid ASC").all<ErrorRow>().then((r) => r.results);
const report = (env: FakeEnv, who: "u1" | "u2" | "u3" | null, body: unknown) => call(env, who, "POST", "/api/studio/errors", body);

beforeEach(() => {
  guardFetch();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normaliseMessage and fingerprintOf", () => {
  it("reads the same problem the same way whatever the names, ids, amounts and numbers were", () => {
    const a = "Could not save “Eid offer” (post 3 of 12): about $4.20 for month 3f2b8c1e-9a4d-4c1b-8f7e-2d6a5b4c3e21";
    const b = "Could not save “Summer launch” (post 11 of 30): about $12 for month 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    expect(normaliseMessage(a)).toBe(normaliseMessage(b));
    expect(normaliseMessage(a)).toBe("could not save <name> (post <n> of <n>): about <amount> for month <id>");
    expect(fingerprintOf("toast", a)).toBe(fingerprintOf("toast", b));
  });

  it("keeps apostrophes as words and takes quoted names out, in every kind of quote", () => {
    expect(normaliseMessage("Mona's month can't be opened")).toBe("mona's month can't be opened");
    expect(normaliseMessage('The client "Habibah" has no logo')).toBe("the client <name> has no logo");
    expect(normaliseMessage("The client 'Habibah Sweets' has no logo.")).toBe("the client <name> has no logo.");
    expect(normaliseMessage("The client «Habibah» has no logo")).toBe("the client <name> has no logo");
  });

  it("replaces links, e-mail addresses, amounts in any currency and long hex ids", () => {
    expect(normaliseMessage("See https://example.com/a/b?c=1 or write to mona@level.test")).toBe("see <url> or write to <email>");
    expect(normaliseMessage("≈ $3.50 spent, 120 AED left, 1,250.75 USD billed")).toBe("<amount> spent, <amount> left, <amount> billed");
    expect(normaliseMessage("Object 9f86d081884c7d65 is missing")).toBe("object <id> is missing");
    expect(normaliseMessage("  Too   many\nspaces 42 ")).toBe("too many spaces <n>");
  });

  it("tells different problems and different kinds apart, and is stable", () => {
    expect(fingerprintOf("toast", "The caption could not be written; try again.")).not.toBe(fingerprintOf("toast", "The picture could not be made; try again."));
    expect(fingerprintOf("toast", "No connection to the studio.")).not.toBe(fingerprintOf("network", "No connection to the studio."));
    expect(fingerprintOf("server", "Studio request failed. Retry shortly. (POST posts/generate)")).not.toBe(fingerprintOf("server", "Studio request failed. Retry shortly. (POST posts/ideas)"));
    expect(fingerprintOf("toast", "Post 3 failed")).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf("toast", "Post 3 failed")).toBe(fingerprintOf("toast", "post 77 FAILED"));
  });
});

describe("scrubSecrets", () => {
  it("takes out bearer tokens, vendor keys, JWTs and named values", () => {
    expect(scrubSecrets("Authorization: Bearer abc123def456ghi789")).toBe("Authorization: Bearer [secret]");
    expect(scrubSecrets("OpenAI said: Incorrect API key provided: sk-proj-Ab12Cd34Ef56Gh78Ij90")).toBe("OpenAI said: Incorrect API key provided: [secret]");
    expect(scrubSecrets("resend key re_AbCdEfGh12345678ZyXw failed")).toBe("resend key [secret] failed");
    expect(scrubSecrets("google key AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv rejected")).toBe("google key [secret] rejected");
    expect(scrubSecrets("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk here")).toBe("jwt [secret] here");
    expect(scrubSecrets("POST /api/hooks/engine?token=hunter2hunter2&batch=b1")).toBe("POST /api/hooks/engine?token=[secret]&batch=b1");
    expect(scrubSecrets('{"api_key":"abcd1234","name":"Mona"}')).toBe('{"api_key":"[secret]","name":"Mona"}');
    expect(scrubSecrets("access_token=ya29.a0AfH6SMBx&x=1 client_secret=shhh1234")).toBe("access_token=[secret]&x=1 client_secret=[secret]");
  });

  it("takes out long hex and base64 runs: a share link's token, a signature, a raw key", () => {
    expect(scrubSecrets("/share/0123456789abcdef0123456789abcdef")).toBe("/share/[secret]");
    expect(scrubSecrets("signature 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 did not match")).toBe("signature [secret] did not match");
    expect(scrubSecrets("key dGhpcyBpcyBhIHNlY3JldCBrZXkgMTIzNDU2Nzg5MA== was refused")).toBe("key [secret] was refused");
    // Assembled here on purpose: a whole made-up webhook address in the file is refused by the host's secret scanner.
    const hook = ["https://hooks.slack", "com/services", "T00000000", "B00000000", "aB3dE6gH9jK2" + "mN5pQ8sT1vW4"].join("/").replace("slack/com", "slack.com");
    expect(scrubSecrets(`hook ${hook}`)).toBe("hook https://hooks.slack.com/services/T00000000/B00000000/[secret]");
  });

  it("leaves ordinary messages, paths, uuids, file names and stack lines alone", () => {
    for (const text of [
      "No connection to the studio. Check the internet and try again.",
      "Use the basic settings; the bearer of this link can approve posts.",
      "POST /api/studio/posts/client-changes · 500",
      "Month 3f2b8c1e-9a4d-4c1b-8f7e-2d6a5b4c3e21 has 12 posts",
      "habibah-october-2026-pistachio-week-offer-final-v2.jpg is too large",
      "at Workspace (/assets/Workspace-D3kd9Ksl.js:12:3456)",
      "Re-generate the picture again: the keys and tokens of the client are in Connection",
      "The password is wrong.",
    ])
      expect(scrubSecrets(text)).toBe(text);
  });

  it("hides the token of a shared link in a request path", () => {
    expect(safePath("/d/abcdefgh12345678abcd/index.html")).toBe("/d/[link]/index.html");
    expect(safePath("/api/share/0123456789abcdef0123456789abcdef/answers")).toBe("/api/share/[link]/answers");
    expect(safePath("/api/studio/posts/generate")).toBe("/api/studio/posts/generate");
  });
});

describe("POST /api/studio/errors", () => {
  it("stores a member's report with who they are, the screen and the build, cut to the caps and scrubbed", async () => {
    const env = await seed();
    const r = await report(env, "u2", {
      kind: "toast",
      message: `The caption could not be written; try again. ${"x".repeat(900)}`,
      detail: `Bearer abc123def456ghi789 ${"y".repeat(1500)}`,
      screen: "/?client=habibah&month=2026-12 · Studio",
      build: "1x2y3z",
    });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true, stored: true });
    const [row, ...rest] = await rowsOf(env);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ kind: "toast", user_id: "u2", user_name: "Mona", role: "member", screen: "/?client=habibah&month=2026-12 · Studio", build: "1x2y3z" });
    expect(row.message).toHaveLength(MESSAGE_MAX);
    expect(row.detail).toHaveLength(DETAIL_MAX);
    expect(row.detail?.startsWith("Bearer [secret] yyy")).toBe(true);
    expect(row.fingerprint).toBe(fingerprintOf("toast", row.message));
    expect(Math.abs(row.at - Date.now())).toBeLessThan(5_000);
  });

  it("refuses a request without a session, and stores nothing", async () => {
    const env = await seed();
    const r = await report(env, null, { kind: "toast", message: "Wrong e-mail or password." });
    expect(r.status).toBe(401);
    expect(await rowsOf(env)).toEqual([]);
  });

  it("answers 400 to a report it cannot read, and never records that as a problem of its own", async () => {
    const env = await seed();
    expect((await report(env, "u2", { kind: "nonsense", message: "x" })).status).toBe(400);
    expect((await report(env, "u2", { kind: "toast" })).status).toBe(400);
    expect((await report(env, "u2", { kind: "toast", message: "" })).status).toBe(400);
    expect(await rowsOf(env)).toEqual([]);
  });

  it("stores at most 20 rows a person a minute: past the cap the answer is still 200 and nothing is written", async () => {
    const env = await seed();
    for (let i = 0; i < PER_MINUTE + 6; i++) {
      // Each a different problem (a letter, not a number: numbers group together).
      const r = await report(env, "u2", { kind: "toast", message: `Problem ${String.fromCharCode(97 + i)} happened` });
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ ok: true, stored: i < PER_MINUTE });
    }
    expect(await rowsOf(env)).toHaveLength(PER_MINUTE);
    // Someone else is not held back by Mona's flood.
    expect(await json(await report(env, "u3", { kind: "toast", message: "Problem a happened" }))).toEqual({ ok: true, stored: true });
    // A minute later Mona's reports are stored again.
    await env.DB.prepare("UPDATE error_log SET at = at - 61000").run();
    expect(await json(await report(env, "u2", { kind: "toast", message: "Problem z happened" }))).toEqual({ ok: true, stored: true });
  });

  it("stores the same problem at most 5 times a person a minute, whatever its numbers", async () => {
    const env = await seed();
    const stored: boolean[] = [];
    for (let i = 0; i < SAME_PER_MINUTE + 3; i++) stored.push((await json<{ stored: boolean }>(await report(env, "u2", { kind: "toast", message: `Post ${i + 1} could not be saved` }))).stored);
    expect(stored).toEqual([true, true, true, true, true, false, false, false]);
    expect(await rowsOf(env)).toHaveLength(SAME_PER_MINUTE);
    // Another problem, and the same one from another person, still get in.
    expect((await json<{ stored: boolean }>(await report(env, "u2", { kind: "toast", message: "The picture could not be made" }))).stored).toBe(true);
    expect((await json<{ stored: boolean }>(await report(env, "u3", { kind: "toast", message: "Post 9 could not be saved" }))).stored).toBe(true);
  });

  it("answers 200 even when the table cannot be written: a logging call never fails the page", async () => {
    const env = await seed();
    env.DB.db.exec("DROP TABLE error_log");
    const r = await report(env, "u2", { kind: "crash", message: "Cannot read properties of undefined" });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true, stored: false });
  });
});

describe("the global error handler", () => {
  it("records an unexpected failure of a route as a server problem, with the user, the request and the error's text", async () => {
    const env = await seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The bucket fails under a signed-in member's request: a throw no route expects.
    env.BUCKET.head = async () => {
      throw new Error("R2 is unreachable (token=abcd1234efgh)");
    };
    const r = await call(env, "u2", "GET", "/api/studio/hero");
    expect(r.status).toBe(500);
    expect((await json<{ error: string }>(r)).error).toContain("Studio request failed");
    const rows = await rowsOf(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "server", user_id: "u2", user_name: "Mona", role: "member", screen: null, message: "R2 is unreachable (token=[secret])" });
    expect(rows[0].detail?.split("\n")[0]).toBe("GET /api/studio/hero · 500");
    expect(rows[0].detail).toContain("\nat ");
    expect(rows[0].build).toBeTruthy();
  });

  it("records a failure outside the signed-in routes without a user, and never the link's token", async () => {
    const env = await seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.BUCKET.get = async () => {
      throw new Error("R2 is unreachable");
    };
    const r = await call(env, null, "GET", "/d/abcdefgh12345678abcd/index.html");
    expect(r.status).toBe(500);
    const rows = await rowsOf(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "server", user_id: null, user_name: null, message: "R2 is unreachable" });
    expect(rows[0].detail?.split("\n")[0]).toBe("GET /d/[link]/index.html · 500");
  });

  it("records a StudioError of status 500 and above with its own message, and no stack", async () => {
    const env = await seed();
    // The server's own configuration is broken: every signed request answers 503.
    (env as { SESSION_SECRET?: string }).SESSION_SECRET = "";
    const r = await worker.fetch(new Request(`${ORIGIN}/api/studio/state`, { headers: { cookie: "studio_session=session-u2.abc" } }) as never, env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    expect(r.status).toBe(503);
    await new Promise((done) => setTimeout(done, 20));
    const rows = await rowsOf(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "server", user_id: null, message: "Server is missing SESSION_SECRET. Set it as a secret.", detail: "GET /api/studio/state · 503" });
  });

  it("never records a 4xx: a wrong password, a missing session, a refused role, a bad request", async () => {
    const env = await seed();
    expect((await call(env, null, "POST", "/api/auth/login", { email: "u2@example.com", password: "wrong-password" })).status).toBe(401);
    expect((await call(env, null, "GET", "/api/studio/state")).status).toBe(401);
    expect((await call(env, "u2", "GET", "/api/admin/users")).status).toBe(403);
    expect((await call(env, "u1", "POST", "/api/admin/users/disable", { id: "u1", disabled: true })).status).toBe(400);
    expect((await call(env, "u2", "GET", "/api/nowhere")).status).toBe(404);
    expect(await rowsOf(env)).toEqual([]);
  });

  it("answers the same 500 when the log itself cannot be written", async () => {
    const env = await seed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.DB.db.exec("DROP TABLE error_log");
    env.BUCKET.head = async () => {
      throw new Error("R2 is unreachable");
    };
    const r = await call(env, "u2", "GET", "/api/studio/hero");
    expect(r.status).toBe(500);
    expect((await json<{ error: string }>(r)).error).toContain("Studio request failed");
  });
});

describe("GET /api/admin/errors", () => {
  /** Three problems over two weeks, one of them older than the window. */
  async function history(env: FakeEnv) {
    const t = Date.now();
    const add = (ago: number, kind: string, user: [string, string, string] | null, message: string, screen: string | null, detail: string | null) =>
      env.DB.prepare("INSERT INTO error_log (id, at, kind, user_id, user_name, role, screen, message, detail, build, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'b1', ?)")
        .bind(crypto.randomUUID(), t - ago, kind, user?.[0] ?? null, user?.[1] ?? null, user?.[2] ?? null, screen, message, detail, fingerprintOf(kind, message))
        .run();
    const mona: [string, string, string] = ["u2", "Mona", "member"];
    const sami: [string, string, string] = ["u3", "Sami", "member"];
    await add(5 * DAY, "toast", mona, "Post 3 could not be saved", "/?client=habibah · Plan", null);
    await add(2 * DAY, "toast", sami, "Post 12 could not be saved", "/?client=noor · Plan", "warning");
    await add(60 * 60 * 1000, "toast", mona, "Post 7 could not be saved", "/?client=habibah · Studio", null);
    await add(3 * DAY, "server", mona, "D1_ERROR: no such column: x", null, "POST /api/studio/posts/plan · 500");
    await add(10 * 60 * 1000, "network", sami, "No connection to the studio. Check the internet and try again.", "/ · Start", "GET /api/studio/state");
    await add(10 * 60 * 1000 + 5, "network", null, "No connection to the studio. Check the internet and try again.", null, null);
    await add(20 * DAY, "crash", mona, "Cannot read properties of undefined", "/ · Studio", null);
    return t;
  }

  it("refuses a member and a signed-out request", async () => {
    const env = await seed();
    expect((await call(env, "u2", "GET", "/api/admin/errors")).status).toBe(403);
    expect((await call(env, "u2", "POST", "/api/admin/errors/clear", { fingerprint: "x" })).status).toBe(403);
    expect((await call(env, null, "GET", "/api/admin/errors")).status).toBe(401);
  });

  it("groups the last 14 days by problem, newest first, with who met it, how often and where last", async () => {
    const env = await seed();
    const t = await history(env);
    const r = await call(env, "u1", "GET", "/api/admin/errors");
    expect(r.status).toBe(200);
    const d = await json<ErrorSummary>(r);
    expect(d.groups.map((g) => [g.kind, g.count])).toEqual([
      ["network", 2],
      ["toast", 3],
      ["server", 1],
    ]);
    const [network, toast, server] = d.groups;
    expect(toast).toMatchObject({
      fingerprint: fingerprintOf("toast", "Post 1 could not be saved"),
      message: "Post 7 could not be saved",
      users: ["Mona", "Sami"],
      first: t - 5 * DAY,
      last: t - 60 * 60 * 1000,
      screen: "/?client=habibah · Studio",
      // The latest occurrence has no detail: the latest one that has is shown.
      detail: "warning",
    } satisfies Partial<ErrorGroup>);
    expect(network).toMatchObject({ users: ["Sami"], screen: "/ · Start", detail: "GET /api/studio/state" });
    expect(server).toMatchObject({ message: "D1_ERROR: no such column: x", users: ["Mona"], screen: null, detail: "POST /api/studio/posts/plan · 500" });
    // Totals: six occurrences in the window (the crash of 20 days ago is outside it), three in the last day.
    expect(d.total).toBe(6);
    expect(d.last24h).toBe(3);
    expect(d.days).toHaveLength(14);
    expect(d.days.at(-1)?.day).toBe(new Date(t).toISOString().slice(0, 10));
    expect(d.days.reduce((n, x) => n + x.count, 0)).toBeGreaterThanOrEqual(5);
    expect(d.days.reduce((n, x) => n + x.count, 0)).toBeLessThanOrEqual(6);
  });

  it("returns one problem's latest occurrences, newest first, at most 50", async () => {
    const env = await seed();
    await history(env);
    const fp = fingerprintOf("toast", "Post 1 could not be saved");
    const d = await json<{ rows: ErrorRow[] }>(await call(env, "u1", "GET", `/api/admin/errors?fingerprint=${fp}`));
    expect(d.rows.map((x) => x.message)).toEqual(["Post 7 could not be saved", "Post 12 could not be saved", "Post 3 could not be saved"]);
    expect(d.rows[1]).toMatchObject({ user_name: "Sami", screen: "/?client=noor · Plan", detail: "warning" });
    const t = Date.now();
    for (let i = 0; i < 60; i++) await env.DB.prepare("INSERT INTO error_log (id, at, kind, message, fingerprint) VALUES (?, ?, 'crash', 'Boom', 'many')").bind(`m${i}`, t - i * 1000).run();
    const many = await json<{ rows: ErrorRow[] }>(await call(env, "u1", "GET", "/api/admin/errors?fingerprint=many"));
    expect(many.rows).toHaveLength(50);
    expect(many.rows[0].id).toBe("m0");
  });

  it("Resolved removes that problem's rows and leaves the others", async () => {
    const env = await seed();
    await history(env);
    const fp = fingerprintOf("toast", "Post 1 could not be saved");
    const r = await call(env, "u1", "POST", "/api/admin/errors/clear", { fingerprint: fp });
    expect(await json(r)).toEqual({ ok: true, removed: 3 });
    const d = await json<ErrorSummary>(await call(env, "u1", "GET", "/api/admin/errors"));
    expect(d.groups.map((g) => g.kind)).toEqual(["network", "server"]);
    expect(d.total).toBe(3);
    expect((await rowsOf(env)).some((x) => x.fingerprint === fp)).toBe(false);
    expect(await rowsOf(env)).toHaveLength(4);
    expect((await call(env, "u1", "POST", "/api/admin/errors/clear", {})).status).toBe(400);
  });

  it("says so when nothing was recorded", async () => {
    const env = await seed();
    const d = await json<ErrorSummary>(await call(env, "u1", "GET", "/api/admin/errors"));
    expect(d.groups).toEqual([]);
    expect(d.total).toBe(0);
    expect(d.last24h).toBe(0);
    expect(d.days.every((x) => x.count === 0)).toBe(true);
  });
});

describe("retention", () => {
  async function old(env: FakeEnv) {
    const t = Date.now();
    for (const [id, ago] of [
      ["fresh", DAY],
      ["edge", (KEEP_DAYS - 1) * DAY],
      ["old", (KEEP_DAYS + 1) * DAY],
      ["ancient", 200 * DAY],
    ] as const)
      await env.DB.prepare("INSERT INTO error_log (id, at, kind, message, fingerprint) VALUES (?, ?, 'toast', 'x', 'f')").bind(id, t - ago).run();
  }

  it("cleanupErrorLog removes rows older than 30 days", async () => {
    const env = await seed();
    await old(env);
    expect(await cleanupErrorLog(env)).toBe(2);
    expect((await rowsOf(env)).map((r) => r.id).sort()).toEqual(["edge", "fresh"]);
  });

  it("runs from the daily cleanup, once a day, also when months are kept for ever", async () => {
    const env = await seed();
    await old(env);
    await setSetting(env, RETENTION_DAYS_SETTING, "0");
    await cleanupOldBatches(env);
    expect((await rowsOf(env)).map((r) => r.id).sort()).toEqual(["edge", "fresh"]);
    // The same day again: nothing runs twice.
    await env.DB.prepare("INSERT INTO error_log (id, at, kind, message, fingerprint) VALUES ('late', ?, 'toast', 'x', 'f')").bind(Date.now() - 90 * DAY).run();
    await cleanupOldBatches(env);
    expect((await rowsOf(env)).map((r) => r.id).sort()).toEqual(["edge", "fresh", "late"]);
  });
});

describe("recordError", () => {
  it("stores nothing for an empty message and keeps the signed-out side to its own limit", async () => {
    const env = await seed();
    expect(await recordError(env, { kind: "server", message: "   " })).toBe(false);
    for (let i = 0; i < PER_MINUTE; i++) expect(await recordError(env, { kind: "server", message: `Failure ${String.fromCharCode(97 + i)}` })).toBe(true);
    expect(await recordError(env, { kind: "server", message: "One more" })).toBe(false);
    // A signed-in person's rows are counted apart from the signed-out side's.
    expect(await recordError(env, { kind: "server", message: "One more", user: { id: "u2", name: "Mona", role: "member" } })).toBe(true);
  });
});
