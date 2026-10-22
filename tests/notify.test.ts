/**
 * Client answers reach the team: an answer on the approval page becomes a pending notification; the
 * cron groups a month's answers into one e-mail (after ten quiet minutes, or at once when every made
 * post is answered) and sends it with Resend to the subscribed members, else to every admin; without a
 * key the rows are kept as unsent; a Resend refusal is kept with its message; the board's "n new"
 * badge counts after each member's seen mark. Every fetch is a fake: nothing here reaches Resend.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
type App = Awaited<ReturnType<typeof app>>;

const TOKEN = "a".repeat(32);
const ADMIN: User = { id: "u1", email: "Admin@test", name: "Firas", role: "admin" };
const MEMBER: User = { id: "u2", email: "member@test", name: "Sara", role: "member" };
let who: User = ADMIN;

async function app() {
  const { StudioError } = await import("../server/errors");
  const { shareRoutes } = await import("../server/share");
  const { notifyRoutes } = await import("../server/notify");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("/api/studio/*", async (c, next) => {
    c.set("user", who);
    await next();
  });
  a.route("/api/share", shareRoutes);
  a.route("/api/studio/notify", notifyRoutes);
  a.onError((e, c) =>
    e instanceof StudioError
      ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400)
      : c.json({ error: String(e) }, 500),
  );
  return a;
}

async function seed() {
  const env = fakeEnv({ CANONICAL_ORIGIN: "https://levelstudio.test" } as never);
  const t = Date.now();
  for (const [id, email, name, role, disabled] of [
    ["u1", "Admin@test", "Firas", "admin", 0],
    ["u2", "member@test", "Sara", "member", 0],
    ["u3", "gone@test", "Old", "admin", 1],
  ] as const)
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES (?, ?, ?, 'x', ?, ?, ?)",
    )
      .bind(id, email, name, role, disabled, t)
      .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)",
  )
    .bind(t, t)
    .run();
  const post = (index: number, title: string) =>
    ({ index, type: "product", title, brief: "", caption: "", hashtags: "" }) as never;
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    shareToken: TOKEN,
    plan: [post(1, "Mango crossing"), post(2, "Tip card"), post(3, "Not made yet")],
  });
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'mango.jpg', 'mango', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')",
  )
    .bind(t)
    .run();
  for (const i of [1, 2])
    await env.DB.prepare(
      "INSERT INTO tasks (id, batch, source, card, status, output, prompt, post, updated) VALUES (?, 'b1', 's1', 1, 'ready', ?, '', ?, ?)",
    )
      .bind(`t${i}`, `u1/b1/output/t${i}/a.jpg`, i, t)
      .run();
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const JSON_HEADERS = { "content-type": "application/json" };
const answer = (a: App, env: FakeEnv, body: Record<string, unknown>) =>
  a.request(
    `/api/share/${TOKEN}/review`,
    { method: "POST", body: JSON.stringify(body), headers: JSON_HEADERS },
    env,
  );
const rows = (env: FakeEnv) =>
  env.DB.db
    .prepare("SELECT status, error, payload, batch FROM notifications ORDER BY created, rowid")
    .all() as {
    status: string;
    error: string | null;
    payload: string;
    batch: string;
  }[];
const connect = async (env: FakeEnv, from = "Level Studio <studio@levelmena.test>") => {
  const { setSetting, RESEND_KEY_SETTING, NOTIFY_FROM_SETTING } =
    await import("../server/settings");
  await setSetting(env, RESEND_KEY_SETTING, "re_test_key");
  await setSetting(env, NOTIFY_FROM_SETTING, from);
};
const resendBody = (r: Reached) =>
  JSON.parse(String(r.init?.body)) as {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html: string;
  };
const TEN_MINUTES = 10 * 60_000;

let reached: Reached[];
beforeEach(() => {
  who = ADMIN;
  reached = guardFetch((url) => url === "https://api.resend.com/emails").reached;
});
afterEach(() => vi.unstubAllGlobals());

describe("a client's answer", () => {
  it("becomes a pending notification with the answer in it", async () => {
    const env = await seed();
    const a = await app();
    const r = await answer(a, env, {
      index: 1,
      status: "changes",
      note: "Use the other cup",
      by: "Lina",
    });
    expect(r.status).toBe(200);
    const all = rows(env);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "pending", batch: "b1" });
    expect(JSON.parse(all[0].payload)).toMatchObject({
      index: 1,
      status: "changes",
      note: "Use the other cup",
      by: "Lina",
    });
    expect(reached).toEqual([]);
  });
});

describe("the cron", () => {
  it("waits ten quiet minutes, then sends one grouped mail per month to the subscribed members", async () => {
    const env = await seed();
    const a = await app();
    await connect(env);
    const { sendDueNotifications } = await import("../server/notify");
    who = MEMBER;
    expect(
      await json(
        await a.request(
          "/api/studio/notify/subscriptions",
          {
            method: "POST",
            body: JSON.stringify({ client: "c1", on: true }),
            headers: JSON_HEADERS,
          },
          env,
        ),
      ),
    ).toMatchObject({ ok: true, on: true });
    expect(
      await json(await a.request("/api/studio/notify/subscriptions?client=c1", {}, env)),
    ).toMatchObject({ on: true, subscribers: ["Sara"] });
    who = ADMIN;
    expect(
      await json(await a.request("/api/studio/notify/subscriptions?client=c1", {}, env)),
    ).toMatchObject({ on: false, subscribers: ["Sara"] });

    const start = Date.now();
    await answer(a, env, { index: 1, status: "approved", by: "Lina" });
    await answer(a, env, { index: 1, status: "changes", note: "Darker cup", by: "Lina" });
    // Post 2 is made and unanswered: the month waits for the client to finish.
    expect(await sendDueNotifications(env, { at: start + TEN_MINUTES - 1 })).toMatchObject({
      sent: 0,
      waiting: 1,
    });
    expect(reached).toEqual([]);
    expect(rows(env).every((r) => r.status === "pending")).toBe(true);

    expect(await sendDueNotifications(env, { at: start + TEN_MINUTES + 1000 })).toMatchObject({
      sent: 1,
      waiting: 0,
      failed: 0,
    });
    expect(reached).toHaveLength(1);
    expect(reached[0].url).toBe("https://api.resend.com/emails");
    expect(new Headers(reached[0].init?.headers).get("authorization")).toBe("Bearer re_test_key");
    const mail = resendBody(reached[0]);
    expect(mail.from).toBe("Level Studio <studio@levelmena.test>");
    expect(mail.to).toEqual(["member@test"]);
    // The latest answer per post makes the subject: post 1 ended as a change.
    expect(mail.subject).toBe("Sample · October 2026: 1 change asked");
    expect(mail.text).toContain("Post 01 · Mango crossing — Change asked · by Lina");
    expect(mail.text).toContain('"Darker cup"');
    expect(mail.text).toContain(
      "Open the studio: https://levelstudio.test/?client=c1&month=2026-10",
    );
    expect(mail.text).toContain(`Open the client page: https://levelstudio.test/share/${TOKEN}`);
    expect(mail.html).toContain("Mango crossing");
    expect(rows(env).map((r) => r.status)).toEqual(["sent", "sent"]);
    // Nothing left: a second pass sends nothing.
    expect(await sendDueNotifications(env, { at: start + TEN_MINUTES + 1000 })).toMatchObject({
      sent: 0,
      waiting: 0,
    });
    expect(reached).toHaveLength(1);
  });

  it("sends at once when every made post is answered, to every enabled admin when nobody subscribed", async () => {
    const env = await seed();
    const a = await app();
    await connect(env);
    const { sendDueNotifications } = await import("../server/notify");
    await answer(a, env, { index: 1, status: "approved", by: "Lina" });
    await answer(a, env, { index: 2, status: "approved", by: "Lina" });
    expect(await sendDueNotifications(env, { at: Date.now() })).toMatchObject({ sent: 1 });
    const mail = resendBody(reached[0]);
    expect(mail.to).toEqual(["admin@test"]);
    expect(mail.subject).toBe("Sample · October 2026: 2 approved");
    expect(mail.text).toContain("Post 02 · Tip card — Approved");
  });

  it("keeps the answers as unsent without a key, and sends them when a key is saved and the button is pressed", async () => {
    const env = await seed();
    const a = await app();
    const { sendDueNotifications } = await import("../server/notify");
    await answer(a, env, { index: 1, status: "approved" });
    expect(await json(await a.request("/api/studio/notify/status", {}, env))).toMatchObject({
      connected: false,
      from: "",
      counts: { pending: 1, unsent: 0 },
    });
    expect(await sendDueNotifications(env, { at: Date.now() + TEN_MINUTES })).toMatchObject({
      sent: 0,
      unsent: 1,
    });
    expect(reached).toEqual([]);
    expect(rows(env)[0]).toMatchObject({ status: "unsent", error: "No Resend key is saved." });
    // Never retried on its own.
    expect(await sendDueNotifications(env, { at: Date.now() + 2 * TEN_MINUTES })).toMatchObject({
      sent: 0,
      unsent: 0,
    });
    expect(reached).toEqual([]);
    // The button without a key says so.
    expect(
      (
        await a.request(
          "/api/studio/notify/send-unsent",
          { method: "POST", body: "{}", headers: JSON_HEADERS },
          env,
        )
      ).status,
    ).toBe(409);

    await a.request(
      "/api/studio/notify/settings",
      {
        method: "POST",
        body: JSON.stringify({ key: "re_test_key", from: "studio@levelmena.test" }),
        headers: JSON_HEADERS,
      },
      env,
    );
    expect(await json(await a.request("/api/studio/notify/status", {}, env))).toMatchObject({
      connected: true,
      from: "studio@levelmena.test",
      counts: { unsent: 1 },
    });
    const r = await json(
      await a.request(
        "/api/studio/notify/send-unsent",
        { method: "POST", body: "{}", headers: JSON_HEADERS },
        env,
      ),
    );
    expect(r).toMatchObject({ ok: true, sent: 1, counts: { sent: 1, unsent: 0 } });
    expect(reached).toHaveLength(1);
    expect(resendBody(reached[0]).from).toBe("studio@levelmena.test");
  });

  it("keeps a refused mail as failed with Resend's message", async () => {
    const env = await seed();
    const a = await app();
    await connect(env);
    const { sendDueNotifications } = await import("../server/notify");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 403,
              name: "validation_error",
              message: "The levelmena.test domain is not verified.",
            }),
            { status: 403, headers: JSON_HEADERS },
          ),
      ),
    );
    await answer(a, env, { index: 1, status: "approved" });
    expect(await sendDueNotifications(env, { at: Date.now() + TEN_MINUTES })).toMatchObject({
      sent: 0,
      failed: 1,
    });
    expect(rows(env)[0]).toMatchObject({
      status: "failed",
      error: "Resend refused the e-mail (403): The levelmena.test domain is not verified.",
    });
  });

  it("refuses the settings and the resend button to a member", async () => {
    const env = await seed();
    const a = await app();
    who = MEMBER;
    expect(
      (
        await a.request(
          "/api/studio/notify/settings",
          { method: "POST", body: JSON.stringify({ key: "re_x" }), headers: JSON_HEADERS },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.request(
          "/api/studio/notify/send-unsent",
          { method: "POST", body: "{}", headers: JSON_HEADERS },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.request(
          "/api/studio/notify/test",
          { method: "POST", body: "{}", headers: JSON_HEADERS },
          env,
        )
      ).status,
    ).toBe(409);
  });
});

describe("the test e-mail", () => {
  it("goes to the person pressing the button and nowhere else", async () => {
    const env = await seed();
    const a = await app();
    await connect(env);
    who = MEMBER;
    expect(
      await json(
        await a.request(
          "/api/studio/notify/test",
          { method: "POST", body: "{}", headers: JSON_HEADERS },
          env,
        ),
      ),
    ).toMatchObject({ ok: true, to: "member@test" });
    expect(reached).toHaveLength(1);
    const mail = resendBody(reached[0]);
    expect(mail.to).toEqual(["member@test"]);
    expect(mail.subject).toBe("Level Social Media: test e-mail");
    expect(rows(env)).toEqual([]);
  });
});

describe("the board's badge", () => {
  it("counts the answers newer than the member's seen mark", async () => {
    const env = await seed();
    const a = await app();
    await answer(a, env, { index: 1, status: "approved", by: "Lina" });
    await answer(a, env, { index: 2, status: "changes", note: "Smaller logo", by: "Lina" });
    let r = await json(await a.request("/api/studio/notify/unseen?batch=b1", {}, env));
    expect(r.count).toBe(2);
    expect((r.answers as { index: number }[]).map((x) => x.index)).toEqual([1, 2]);
    expect(
      await json(
        await a.request(
          "/api/studio/notify/seen",
          { method: "POST", body: JSON.stringify({ batch: "b1" }), headers: JSON_HEADERS },
          env,
        ),
      ),
    ).toMatchObject({ ok: true, batch: "b1" });
    r = await json(await a.request("/api/studio/notify/unseen?batch=b1", {}, env));
    expect(r.count).toBe(0);
    // Each member has their own mark.
    who = MEMBER;
    expect((await a.request("/api/studio/notify/unseen?batch=b1", {}, env)).status).toBe(404); // not the member's month
    who = ADMIN;
    await new Promise((f) => setTimeout(f, 2));
    await answer(a, env, { index: 2, status: "approved", by: "Lina" });
    r = await json(await a.request("/api/studio/notify/unseen?batch=b1", {}, env));
    expect(r.count).toBe(1);
    expect(reached).toEqual([]);
  });
});
