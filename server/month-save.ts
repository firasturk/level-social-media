import type { Config } from "@shared/config";
import { mergeMonth } from "@shared/month-merge";
import { first, now, run } from "./db";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";

/** What each row object last wrote, so a second save in the same request merges from the right copy. */
const lastWritten = new WeakMap<object, string>();

/**
 * The month is written as one block, so it is merged, never laid over what is there: the copy this
 * writer read (`b.config`) is the base, and every part it did not change keeps what the database
 * holds now (shared/month-merge.ts). A long engine pass no longer erases an edit saved meanwhile,
 * a plan save no longer drops a client's answer, and a card added by someone else is kept. The
 * write lands only if the database still holds what was merged against; otherwise it is merged
 * again (two saves in the same instant). `config` is left holding what was written.
 */
export async function writeMonth(env: Env, b: { id: string; config: string }, config: Config): Promise<void> {
  const baseText = lastWritten.get(b) ?? b.config;
  let base: Config;
  try {
    base = JSON.parse(baseText) as Config;
  } catch {
    base = {} as Config;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await first<{ config: string }>(env.DB, "SELECT config FROM batches WHERE id = ?", b.id);
    if (!current) return;
    let merged = config;
    if (current.config !== baseText) {
      try {
        merged = mergeMonth(base, config, JSON.parse(current.config) as Config);
      } catch (e) {
        console.error("[month] merge failed, writing as is", b.id, errorMessage(e));
      }
    }
    const text = JSON.stringify(merged);
    const changed = await run(env.DB, "UPDATE batches SET config = ?, theme = ?, updated = ? WHERE id = ? AND config = ?", text, merged.theme ?? null, now(), b.id, current.config);
    if (changed) {
      if (merged !== config) {
        for (const k of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[k];
        Object.assign(config, merged);
      }
      lastWritten.set(b, text);
      return;
    }
  }
  throw new StudioError("The month is being saved from several places at once. Try again in a moment; nothing was lost.", 409);
}
