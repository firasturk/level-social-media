/**
 * A month's files in R2. They live under `<owner>/<batch>/`, but a month moved to another person
 * (a member who left) keeps its files under the first owner's folder, so the keys stored on its
 * rows are removed too, not only the folder of the current owner.
 */
import type { Env } from "./env";
import { all } from "./db";

/** Days a deleted month waits in the bin before its rows and files are purged for good. */
export const TRASH_DAYS = 30;

/**
 * The month's working rows, removed with it. The records of money and of what reached people stay:
 * spend, publications, Drive deliveries, notifications, the client's feedback and the tool jobs.
 * (QA: a purged month left its version rows behind, pointing at files already deleted.)
 */
export const MONTH_TABLES = [
  "tasks",
  "sources",
  "month_versions",
  "post_comments",
  "videos",
  "post_takes",
  "plan_drafts",
  "plan_preflights",
  "ocr_checks",
  "notify_seen",
  "video_renders",
  "video_projects",
  "video_audio",
] as const;

/** A month gone for good: its files, then every row that belongs to it. */
export async function purgeBatch(env: Env, batch: { id: string; owner: string }): Promise<void> {
  await deleteBatchFiles(env, batch);
  await env.DB.batch([...MONTH_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE batch = ?`).bind(batch.id)), env.DB.prepare("DELETE FROM batches WHERE id = ?").bind(batch.id)]);
}

export async function deleteBatchFiles(env: Env, batch: { id: string; owner: string }): Promise<void> {
  const prefix = `${batch.owner}/${batch.id}/`;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 500 });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const rows = await all<{ k: string | null }>(
    env.DB,
    // Only the month's own files: its "reference" rows point at the theme's shared photos.
    `SELECT key AS k FROM sources WHERE batch = ?1 AND kind = 'product'
     UNION ALL SELECT reference_key FROM sources WHERE batch = ?1 AND kind = 'product'
     UNION ALL SELECT output FROM tasks WHERE batch = ?1`,
    batch.id,
  );
  // Files of another owner's folder only (a moved month); never a client asset or a theme photo.
  const keys = [
    ...new Set(
      rows
        .map((r) => r.k)
        .filter((k): k is string => !!k && !k.startsWith(prefix) && !k.startsWith("clients/") && !k.startsWith("refs/") && /^[^/]+\/[^/]+\//.test(k)),
    ),
  ];
  for (let i = 0; i < keys.length; i += 500) await env.BUCKET.delete(keys.slice(i, i + 500));
}
