import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, run, now } from "./db";
import {
  getSetting,
  setSetting,
  deleteSetting,
  INVITE_CODE_SETTING,
  SPEND_THRESHOLD_SETTING,
  RETENTION_DAYS_SETTING,
  NOTIFY_WEBHOOK_SETTING,
  NOTIFY_EMAIL_SETTING,
  RESEND_KEY_SETTING,
  HERO_KEYS,
  heroStamp,
} from "./settings";
import { notify } from "./notify";
import { purgeBatch, TRASH_DAYS } from "./batchfiles";
import type { User } from "@shared/types";

type Variables = { user: User };
export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

adminRoutes.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admin only.", 403);
  await next();
});

export interface AdminSettings {
  inviteCode: string;
  spendThreshold: number;
  retentionDays: number;
  notifyWebhook: string;
  notifyEmail: string;
  resendConfigured: boolean;
}

export async function readAdminSettings(env: Env): Promise<AdminSettings> {
  return {
    inviteCode: (await getSetting(env, INVITE_CODE_SETTING)) || env.INVITE_CODE || "",
    spendThreshold: Number((await getSetting(env, SPEND_THRESHOLD_SETTING)) ?? 20),
    retentionDays: Number((await getSetting(env, RETENTION_DAYS_SETTING)) ?? 90),
    notifyWebhook: (await getSetting(env, NOTIFY_WEBHOOK_SETTING)) || "",
    notifyEmail: (await getSetting(env, NOTIFY_EMAIL_SETTING)) || "",
    resendConfigured: !!(await getSetting(env, RESEND_KEY_SETTING)),
  };
}

adminRoutes.get("/users", async (c) => {
  const users = await all(
    c.env.DB,
    `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created, u.last_seen,
       COUNT(DISTINCT b.id) AS batches,
       COALESCE(SUM(t.cost), 0) AS spent,
       COUNT(t.id) AS images
     FROM users u LEFT JOIN batches b ON b.owner = u.id LEFT JOIN tasks t ON t.batch = b.id
     GROUP BY u.id ORDER BY u.created ASC`,
  );
  return c.json({ users, settings: await readAdminSettings(c.env) });
});

adminRoutes.post("/users/disable", async (c) => {
  const { id, disabled } = z
    .object({ id: z.string(), disabled: z.boolean() })
    .parse(await c.req.json());
  if (id === c.get("user").id) throw new StudioError("You cannot disable your own account.");
  await run(c.env.DB, "UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, id);
  if (disabled) await run(c.env.DB, "DELETE FROM sessions WHERE user_id = ?", id);
  return c.json({ ok: true });
});

/** A member who leaves: their months move to the admin, so the work stays in the studio. */
adminRoutes.post("/users/transfer", async (c) => {
  const { id } = z.object({ id: z.string() }).parse(await c.req.json());
  const me = c.get("user").id;
  if (id === me) throw new StudioError("These months are already yours.");
  const moved = await run(c.env.DB, "UPDATE batches SET owner = ? WHERE owner = ?", me, id);
  return c.json({ ok: true, moved });
});

adminRoutes.post("/users/role", async (c) => {
  const { id, role } = z
    .object({ id: z.string(), role: z.enum(["admin", "member"]) })
    .parse(await c.req.json());
  if (id === c.get("user").id)
    throw new StudioError("Change your own role from another admin account.");
  await run(c.env.DB, "UPDATE users SET role = ? WHERE id = ?", role, id);
  return c.json({ ok: true });
});

const settingsSchema = z.object({
  inviteCode: z.string().trim().max(100).optional(),
  spendThreshold: z.number().min(0).max(100000).optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
  notifyWebhook: z.string().trim().max(500).optional(),
  notifyEmail: z.string().trim().max(500).optional(),
  resendApiKey: z.string().trim().max(200).optional(),
});

adminRoutes.post("/settings", async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid settings.");
  const d = parsed.data;
  if (d.inviteCode !== undefined) {
    if (d.inviteCode) await setSetting(c.env, INVITE_CODE_SETTING, d.inviteCode);
    else await deleteSetting(c.env, INVITE_CODE_SETTING);
  }
  if (d.spendThreshold !== undefined)
    await setSetting(c.env, SPEND_THRESHOLD_SETTING, String(d.spendThreshold));
  if (d.retentionDays !== undefined)
    await setSetting(c.env, RETENTION_DAYS_SETTING, String(d.retentionDays));
  if (d.notifyWebhook !== undefined) {
    if (d.notifyWebhook && !/^https:\/\//.test(d.notifyWebhook))
      throw new StudioError("Webhook must be an https URL.");
    if (d.notifyWebhook) await setSetting(c.env, NOTIFY_WEBHOOK_SETTING, d.notifyWebhook);
    else await deleteSetting(c.env, NOTIFY_WEBHOOK_SETTING);
  }
  if (d.notifyEmail !== undefined) {
    if (d.notifyEmail) await setSetting(c.env, NOTIFY_EMAIL_SETTING, d.notifyEmail);
    else await deleteSetting(c.env, NOTIFY_EMAIL_SETTING);
  }
  if (d.resendApiKey !== undefined) {
    if (d.resendApiKey) await setSetting(c.env, RESEND_KEY_SETTING, d.resendApiKey);
    else await deleteSetting(c.env, RESEND_KEY_SETTING);
  }
  return c.json({ ok: true, settings: await readAdminSettings(c.env) });
});

const HERO_MAX = 40 * 1024 * 1024;

/** Upload the looping hero video shown under the studio title. */
adminRoutes.post("/hero", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const f = form?.get("file");
  if (!(f instanceof File)) throw new StudioError("Attach a video file.");
  if (!/^video\/(mp4|webm|quicktime)$/.test(f.type))
    throw new StudioError("Use an MP4 or WebM video.");
  if (f.size > HERO_MAX) throw new StudioError("Keep the hero video under 40 MB.");
  const key = f.type === "video/webm" ? HERO_KEYS.webm : HERO_KEYS.mp4;
  await c.env.BUCKET.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
  return c.json({ ok: true, hero: await heroStamp(c.env, true) });
});

adminRoutes.delete("/hero", async (c) => {
  await c.env.BUCKET.delete(Object.values(HERO_KEYS));
  await heroStamp(c.env, true);
  return c.json({ ok: true });
});

adminRoutes.post("/notify/test", async (c) => {
  await notify(
    c.env,
    "Level Social Media test",
    `Notifications are working. Sent ${new Date().toISOString()}.`,
  );
  return c.json({ ok: true });
});

/** Deletes batches (rows and R2 objects) not touched for the retention period. Runs from the cron once a day. */
export async function cleanupOldBatches(env: Env): Promise<number> {
  const days = Number((await getSetting(env, RETENTION_DAYS_SETTING)) ?? 90);
  if (!days) return 0;
  const last = Number((await getSetting(env, "last_cleanup")) ?? 0);
  if (now() - last < 24 * 60 * 60 * 1000) return 0;
  await setSetting(env, "last_cleanup", String(now()));
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  // Untouched months go to the bin first; what has waited in the bin long enough is purged.
  await run(env.DB, "UPDATE batches SET deleted = ?, state = 'idle' WHERE deleted IS NULL AND updated < ? AND state != 'running'", now(), cutoff);
  const old = await all<{ id: string; owner: string }>(
    env.DB,
    "SELECT id, owner FROM batches WHERE deleted IS NOT NULL AND deleted < ? LIMIT 20",
    now() - TRASH_DAYS * 24 * 60 * 60 * 1000,
  );
  for (const b of old) await purgeBatch(env, b);
  return old.length;
}
