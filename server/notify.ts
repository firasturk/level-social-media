/**
 * Notifications. Two things live here:
 *
 * 1. `notify()`: the admin's batch alerts (a Slack-compatible webhook and/or an e-mail through
 *    Resend), configured on the admin page. Unchanged.
 * 2. Client answers: when a client approves a post or asks for a change on the approval page, the
 *    answer is recorded as a pending notification. The cron groups a month's pending answers into
 *    one e-mail (after ten quiet minutes, or at once when every made post has an answer) and sends
 *    it with Resend to the team members subscribed to that client, or to every admin when nobody
 *    is. Without a Resend key the rows become "unsent": kept, shown, never retried until a key is
 *    saved and "Send the unsent" is pressed. The studio board shows "Client answered · n new" from
 *    the same rows, counted after each member's seen mark.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import {
  deleteSetting,
  getSetting,
  NOTIFY_EMAIL_SETTING,
  NOTIFY_FROM_SETTING,
  NOTIFY_WEBHOOK_SETTING,
  RESEND_KEY_SETTING,
  setSetting,
} from "./settings";
import { monthLabel } from "@shared/posts";
import type { Approval, Config } from "@shared/config";
import type { User } from "@shared/types";

export async function notify(env: Env, subject: string, text: string): Promise<void> {
  const [webhook, email, resend] = await Promise.all([
    getSetting(env, NOTIFY_WEBHOOK_SETTING),
    getSetting(env, NOTIFY_EMAIL_SETTING),
    getSetting(env, RESEND_KEY_SETTING),
  ]);
  const jobs: Promise<unknown>[] = [];
  if (webhook) {
    jobs.push(
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${subject}*\n${text}`, content: `**${subject}**\n${text}` }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined),
    );
  }
  if (email && resend) {
    jobs.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resend}` },
        body: JSON.stringify({
          from: "Level Social Media <onboarding@resend.dev>",
          to: email.split(/[,\s]+/).filter(Boolean),
          subject,
          text,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined),
    );
  }
  await Promise.all(jobs);
}

/* ───────────────────────────── Client answers ───────────────────────────── */

export const RESEND_URL = "https://api.resend.com/emails";
/** Resend's test sender: delivers only to the address that owns the Resend account. */
export const FALLBACK_FROM = "Level Social Media <onboarding@resend.dev>";
/** A month's answers wait this long for the client to finish before one mail goes out. */
export const GROUP_WAIT_MS = 10 * 60_000;

export interface ClientAnswer extends Approval {
  index: number;
}

export type NotificationStatus = "pending" | "sent" | "unsent" | "failed";

interface NotificationRow {
  id: string;
  client: string;
  batch: string;
  kind: string;
  payload: string;
  status: NotificationStatus;
  sent_at: number | null;
  error: string | null;
  created: number;
}

/** Recorded from the share review route: one pending notification per answer. */
export async function recordClientAnswer(
  env: Env,
  batch: { id: string; client: string | null | undefined },
  payload: ClientAnswer,
): Promise<void> {
  await run(
    env.DB,
    "INSERT INTO notifications (id, client, batch, kind, payload, status, created) VALUES (?, ?, ?, 'client_answer', ?, 'pending', ?)",
    uuid(),
    batch.client ?? "",
    batch.id,
    JSON.stringify(payload),
    now(),
  );
}

/** Where the mail's links point: the short public address, else the base URL, else nowhere. */
export function publicOrigin(env: Env): string {
  return (env.CANONICAL_ORIGIN || env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

/** The subscribed members' addresses for a client; every admin when nobody subscribed. Disabled accounts never. */
export async function recipientsFor(env: Env, client: string): Promise<string[]> {
  const subscribed = await all<{ email: string }>(
    env.DB,
    "SELECT u.email FROM notify_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.client = ? AND u.disabled = 0 ORDER BY u.email",
    client,
  );
  const rows = subscribed.length
    ? subscribed
    : await all<{ email: string }>(
        env.DB,
        "SELECT email FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY email",
      );
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];
}

function parseAnswer(row: NotificationRow): ClientAnswer | null {
  try {
    const p = JSON.parse(row.payload) as Partial<ClientAnswer>;
    if (typeof p.index !== "number" || (p.status !== "approved" && p.status !== "changes"))
      return null;
    return {
      index: p.index,
      status: p.status,
      note: p.note || undefined,
      by: p.by || undefined,
      at: p.at ?? row.created,
    };
  } catch {
    return null;
  }
}

/** The latest answer per post, in post order. */
export function latestPerPost(answers: ClientAnswer[]): ClientAnswer[] {
  const byIndex = new Map<number, ClientAnswer>();
  for (const a of answers) {
    const prev = byIndex.get(a.index);
    if (!prev || a.at >= prev.at) byIndex.set(a.index, a);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Habibah · November 2026: 2 approved, 1 change asked" */
export function answerSubject(
  client: string,
  month: string | null,
  answers: ClientAnswer[],
): string {
  const approved = answers.filter((a) => a.status === "approved").length;
  const changes = answers.filter((a) => a.status === "changes").length;
  const parts: string[] = [];
  if (approved) parts.push(`${approved} approved`);
  if (changes) parts.push(plural(changes, "change asked", "changes asked"));
  return `${client}${month ? ` · ${monthLabel(month)}` : ""}: ${parts.join(", ") || "answered"}`;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );

export interface AnswerMail {
  subject: string;
  text: string;
  html: string;
}

/** The grouped e-mail: each answer with the post's number and title, who answered, the note, and the two links. */
export function answerMail(args: {
  client: string;
  month: string | null;
  clientId: string;
  config: Config;
  answers: ClientAnswer[];
  origin: string;
}): AnswerMail {
  const { client, month, clientId, config, answers, origin } = args;
  const title = (index: number) => config.plan?.find((p) => p.index === index)?.title ?? "";
  const label = (a: ClientAnswer) => (a.status === "approved" ? "Approved" : "Change asked");
  const when = (at: number) =>
    new Date(at).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Amman",
    });
  const studioUrl = origin
    ? `${origin}/?client=${encodeURIComponent(clientId)}${month ? `&month=${encodeURIComponent(month)}` : ""}`
    : "";
  const clientUrl = origin && config.shareToken ? `${origin}/share/${config.shareToken}` : "";
  const heading = `${client} answered on the approval page${month ? ` for ${monthLabel(month)}` : ""}.`;
  const num = (index: number) => `Post ${String(index).padStart(2, "0")}`;
  const textLines = answers.map((a) => {
    const head = `${num(a.index)}${title(a.index) ? ` · ${title(a.index)}` : ""} — ${label(a)}${a.by ? ` · by ${a.by}` : ""} · ${when(a.at)}`;
    return a.note ? `${head}\n  "${a.note}"` : head;
  });
  const links = [
    studioUrl && `Open the studio: ${studioUrl}`,
    clientUrl && `Open the client page: ${clientUrl}`,
  ].filter(Boolean);
  const text = [heading, "", ...textLines, "", ...links].join("\n").trimEnd();
  const htmlItems = answers
    .map((a) => {
      const color = a.status === "approved" ? "#1d6b3a" : "#8a3b00";
      return `<li style="margin:0 0 10px"><b>${num(a.index)}${title(a.index) ? ` · ${esc(title(a.index))}` : ""}</b> — <span style="color:${color}">${label(a)}</span>${a.by ? ` · by ${esc(a.by)}` : ""} <span style="color:#777">· ${esc(when(a.at))}</span>${a.note ? `<br><q style="color:#444">${esc(a.note)}</q>` : ""}</li>`;
    })
    .join("");
  const htmlLinks = [
    studioUrl && `<a href="${esc(studioUrl)}">Open the studio</a>`,
    clientUrl && `<a href="${esc(clientUrl)}">Open the client page</a>`,
  ]
    .filter(Boolean)
    .join(" · ");
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222"><p>${esc(heading)}</p><ul style="padding-left:18px">${htmlItems}</ul>${htmlLinks ? `<p>${htmlLinks}</p>` : ""}</div>`;
  return { subject: answerSubject(client, month, answers), text, html };
}

/** One call to Resend. Throws a StudioError with Resend's message when it refuses. */
export async function sendResend(
  key: string,
  mail: { from: string; to: string[]; subject: string; text: string; html?: string },
): Promise<{ id: string | null }> {
  const r = await fetch(RESEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(mail),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await r.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (!r.ok)
    throw new StudioError(
      `Resend refused the e-mail (${r.status}): ${body.message || body.name || "no detail"}`,
      502,
    );
  return { id: body.id ?? null };
}

interface BatchRowLite {
  id: string;
  client: string | null;
  month: string | null;
  config: string;
}

/** True when every post that has a picture carries an answer: the client is done, no need to wait. */
async function everyMadePostAnswered(env: Env, batchId: string, config: Config): Promise<boolean> {
  const made = await all<{ post: number }>(
    env.DB,
    "SELECT DISTINCT post FROM tasks WHERE batch = ? AND post IS NOT NULL AND output IS NOT NULL",
    batchId,
  );
  const planned = new Set((config.plan ?? []).map((p) => p.index));
  const posts = made.map((r) => r.post).filter((p) => planned.has(p));
  if (!posts.length) return false;
  return posts.every((p) => !!config.approvals?.[String(p)]);
}

export interface SendSummary {
  /** Mails sent (one per month). */
  sent: number;
  /** Rows kept as unsent because no key is saved. */
  unsent: number;
  /** Months whose mail Resend refused. */
  failed: number;
  /** Months whose answers are still waiting for the quiet period. */
  waiting: number;
}

async function setStatus(
  env: Env,
  ids: string[],
  status: NotificationStatus,
  error: string | null = null,
): Promise<void> {
  if (!ids.length) return;
  const marks = ids.map(() => "?").join(", ");
  await run(
    env.DB,
    `UPDATE notifications SET status = ?, error = ?, sent_at = ? WHERE id IN (${marks})`,
    status,
    error,
    status === "sent" ? now() : null,
    ...ids,
  );
}

/**
 * The cron's pass: every pending answer is grouped by month; a month goes out once its oldest
 * pending answer is older than ten minutes, or when every made post has an answer. `all` sends every
 * group at once (the "Send the unsent" button). Without a Resend key nothing waits: every pending
 * row becomes "unsent" and stays visible until a key is saved.
 */
export async function sendDueNotifications(
  env: Env,
  opts: { at?: number; all?: boolean } = {},
): Promise<SendSummary> {
  const at = opts.at ?? now();
  const summary: SendSummary = { sent: 0, unsent: 0, failed: 0, waiting: 0 };
  const pending = await all<NotificationRow>(
    env.DB,
    "SELECT * FROM notifications WHERE status = 'pending' ORDER BY created, rowid",
  );
  if (!pending.length) return summary;
  const key = await getSetting(env, RESEND_KEY_SETTING);
  if (!key) {
    await setStatus(
      env,
      pending.map((r) => r.id),
      "unsent",
      "No Resend key is saved.",
    );
    summary.unsent = pending.length;
    return summary;
  }
  const from = (await getSetting(env, NOTIFY_FROM_SETTING)) || FALLBACK_FROM;
  const origin = publicOrigin(env);
  const groups = new Map<string, NotificationRow[]>();
  for (const r of pending) groups.set(r.batch, [...(groups.get(r.batch) ?? []), r]);
  for (const [batchId, rows] of groups) {
    const ids = rows.map((r) => r.id);
    const b = await first<BatchRowLite>(
      env.DB,
      "SELECT id, client, month, config FROM batches WHERE id = ?",
      batchId,
    );
    if (!b) {
      await setStatus(env, ids, "failed", "The month was deleted.");
      summary.failed += 1;
      continue;
    }
    let config: Config;
    try {
      config = JSON.parse(b.config) as Config;
    } catch {
      config = {} as Config;
    }
    const oldest = Math.min(...rows.map((r) => r.created));
    const due =
      opts.all || at - oldest >= GROUP_WAIT_MS || (await everyMadePostAnswered(env, b.id, config));
    if (!due) {
      summary.waiting += 1;
      continue;
    }
    const clientId = config.client ?? b.client ?? rows[0].client;
    const client = await first<{ id: string; name: string }>(
      env.DB,
      "SELECT id, name FROM clients WHERE id = ?",
      clientId,
    );
    const answers = latestPerPost(rows.map(parseAnswer).filter((a): a is ClientAnswer => !!a));
    if (!answers.length) {
      await setStatus(env, ids, "failed", "The answer could not be read.");
      summary.failed += 1;
      continue;
    }
    const to = await recipientsFor(env, clientId);
    if (!to.length) {
      await setStatus(
        env,
        ids,
        "failed",
        "Nobody to write to: no subscriptions and no admin account.",
      );
      summary.failed += 1;
      continue;
    }
    const mail = answerMail({
      client: client?.name ?? clientId,
      month: b.month,
      clientId,
      config,
      answers,
      origin,
    });
    try {
      await sendResend(key, { from, to, ...mail });
      await setStatus(env, ids, "sent");
      summary.sent += 1;
    } catch (e) {
      await setStatus(env, ids, "failed", errorMessage(e));
      summary.failed += 1;
    }
  }
  return summary;
}

/** "Send the unsent": the kept rows go back to pending and every group goes out now. */
export async function sendUnsent(env: Env): Promise<SendSummary> {
  await run(
    env.DB,
    "UPDATE notifications SET status = 'pending', error = NULL WHERE status = 'unsent'",
  );
  return sendDueNotifications(env, { all: true });
}

export interface NotifyStatus {
  connected: boolean;
  from: string;
  counts: Record<NotificationStatus, number>;
}

export async function notifyStatus(env: Env): Promise<NotifyStatus> {
  const [key, from, rows] = await Promise.all([
    getSetting(env, RESEND_KEY_SETTING),
    getSetting(env, NOTIFY_FROM_SETTING),
    all<{ status: NotificationStatus; n: number }>(
      env.DB,
      "SELECT status, COUNT(*) AS n FROM notifications GROUP BY status",
    ),
  ]);
  const counts: Record<NotificationStatus, number> = { pending: 0, sent: 0, unsent: 0, failed: 0 };
  for (const r of rows) if (r.status in counts) counts[r.status] = r.n;
  return { connected: !!key, from: from ?? "", counts };
}

/* ───────────────────────────── Routes ───────────────────────────── */

/** A member's own month, or any month for an admin (the same rule as the posts routes), without importing them. */
async function planFor(env: Env, user: User, id: string | undefined): Promise<BatchRowLite> {
  if (!id) throw new StudioError("Plan id is required.");
  const b =
    user.role === "admin"
      ? await first<BatchRowLite>(
          env.DB,
          "SELECT id, client, month, config FROM batches WHERE id = ? AND deleted IS NULL",
          id,
        )
      : await first<BatchRowLite>(
          env.DB,
          "SELECT id, client, month, config FROM batches WHERE id = ? AND owner = ? AND deleted IS NULL",
          id,
          user.id,
        );
  if (!b) throw new StudioError("Plan not found.", 404);
  return b;
}

type Variables = { user: User };
export const notifyRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function requireAdmin(user: User): void {
  if (user.role !== "admin")
    throw new StudioError("Only an admin can change the notification settings.", 403);
}

async function body<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid request.");
  return parsed.data as z.infer<T>;
}

notifyRoutes.get("/status", async (c) => c.json(await notifyStatus(c.env)));

/** The Resend key and the sender: saved encrypted; an empty key keeps the one saved, an empty from removes it. */
notifyRoutes.post("/settings", async (c) => {
  requireAdmin(c.get("user"));
  const d = await body(
    c,
    z.object({
      key: z.string().trim().max(200).optional(),
      from: z.string().trim().max(200).optional(),
    }),
  );
  if (d.key) await setSetting(c.env, RESEND_KEY_SETTING, d.key);
  if (d.from !== undefined) {
    if (d.from && !/^(?:[^<>@]+<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(d.from))
      throw new StudioError(
        'The from address must look like "Level Studio <studio@levelmena.com>" or "studio@levelmena.com".',
      );
    if (d.from) await setSetting(c.env, NOTIFY_FROM_SETTING, d.from);
    else await deleteSetting(c.env, NOTIFY_FROM_SETTING);
  }
  return c.json({ ok: true, ...(await notifyStatus(c.env)) });
});

notifyRoutes.delete("/settings/key", async (c) => {
  requireAdmin(c.get("user"));
  await deleteSetting(c.env, RESEND_KEY_SETTING);
  return c.json({ ok: true, ...(await notifyStatus(c.env)) });
});

/** Who hears about a client: the current member's own switch and the names of everyone subscribed. */
notifyRoutes.get("/subscriptions", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const rows = await all<{ user_id: string; name: string }>(
    c.env.DB,
    "SELECT s.user_id, u.name FROM notify_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.client = ? AND u.disabled = 0 ORDER BY u.name",
    client,
  );
  const me = c.get("user").id;
  return c.json({
    client,
    on: rows.some((r) => r.user_id === me),
    subscribers: rows.map((r) => r.name),
  });
});

notifyRoutes.post("/subscriptions", async (c) => {
  const d = await body(c, z.object({ client: z.string().min(1).max(80), on: z.boolean() }));
  const me = c.get("user").id;
  if (d.on)
    await run(
      c.env.DB,
      "INSERT OR IGNORE INTO notify_subscriptions (user_id, client, created) VALUES (?, ?, ?)",
      me,
      d.client,
      now(),
    );
  else
    await run(
      c.env.DB,
      "DELETE FROM notify_subscriptions WHERE user_id = ? AND client = ?",
      me,
      d.client,
    );
  return c.json({ ok: true, client: d.client, on: d.on });
});

/** The answers of a month newer than the member's seen mark (the board's "Client answered · n new"). */
notifyRoutes.get("/unseen", async (c) => {
  const b = await planFor(c.env, c.get("user"), c.req.query("batch"));
  const seen = await first<{ seen_at: number }>(
    c.env.DB,
    "SELECT seen_at FROM notify_seen WHERE user_id = ? AND batch = ?",
    c.get("user").id,
    b.id,
  );
  const rows = await all<NotificationRow>(
    c.env.DB,
    "SELECT * FROM notifications WHERE batch = ? AND kind = 'client_answer' AND created > ? ORDER BY created",
    b.id,
    seen?.seen_at ?? 0,
  );
  const answers = rows.map(parseAnswer).filter((a): a is ClientAnswer => !!a);
  return c.json({ batch: b.id, count: answers.length, answers, seenAt: seen?.seen_at ?? null });
});

notifyRoutes.post("/seen", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1) }));
  const b = await planFor(c.env, c.get("user"), d.batch);
  const t = now();
  await run(
    c.env.DB,
    "INSERT INTO notify_seen (user_id, batch, seen_at) VALUES (?, ?, ?) ON CONFLICT(user_id, batch) DO UPDATE SET seen_at = excluded.seen_at",
    c.get("user").id,
    b.id,
    t,
  );
  return c.json({ ok: true, batch: b.id, seenAt: t });
});

/** One test e-mail to the person pressing the button. It confirms the key and the sender, nothing else. */
notifyRoutes.post("/test", async (c) => {
  const key = await getSetting(c.env, RESEND_KEY_SETTING);
  if (!key) throw new StudioError("Not connected: save a Resend API key first.", 409);
  const from = (await getSetting(c.env, NOTIFY_FROM_SETTING)) || FALLBACK_FROM;
  const user = c.get("user");
  const origin = publicOrigin(c.env) || new URL(c.req.url).origin;
  await sendResend(key, {
    from,
    to: [user.email],
    subject: "Level Social Media: test e-mail",
    text: `Hello ${user.name},\n\nThis is the test e-mail from Level Social Media. Client answers on the approval page will arrive like this, from ${from}.\n\n${origin}`,
  });
  return c.json({ ok: true, to: user.email, from });
});

notifyRoutes.post("/send-unsent", async (c) => {
  requireAdmin(c.get("user"));
  if (!(await getSetting(c.env, RESEND_KEY_SETTING)))
    throw new StudioError("Not connected: save a Resend API key first.", 409);
  const summary = await sendUnsent(c.env);
  return c.json({ ok: true, ...summary, ...(await notifyStatus(c.env)) });
});
