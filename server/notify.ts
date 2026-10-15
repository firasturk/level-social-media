/** Batch notifications: a Slack-compatible webhook and/or an email through Resend, both configured from the admin page. */
import type { Env } from "./env";
import {
  getSetting,
  NOTIFY_EMAIL_SETTING,
  NOTIFY_WEBHOOK_SETTING,
  RESEND_KEY_SETTING,
} from "./settings";

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
