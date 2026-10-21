import { first, now, run } from "./db";
import { PREVIEW_MESSAGE, previewNoImages, type Env } from "./env";
import { StudioError } from "./errors";

/**
 * The spending ledger. Every paid engine call reserves its list-price estimate against a scope's
 * approved allowance before it is sent; the reservation is one conditional UPDATE, so concurrent
 * requests cannot spend the same remaining allowance. A scope with no row has approved nothing:
 * nothing is spent on it by itself.
 */
export interface SpendStatus {
  approved: number;
  reserved: number;
  /** What is still free to reserve. */
  remaining: number;
  /** Reserved amounts whose billing is not established (kept for reconciliation, never released by themselves). */
  uncertain: number;
}

const cents = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Adds to a scope's approved allowance (creating the row) and returns the new state. With a run
 * id, the allowance is added once for that run: a retried or repeated request adds nothing more.
 */
export async function approveSpend(env: Env, scope: string, amount: number, runId?: string): Promise<SpendStatus> {
  if (runId) {
    const fresh = await run(env.DB, "INSERT OR IGNORE INTO spend_runs (run, scope, amount, created) VALUES (?, ?, ?, ?)", runId, scope, cents(Math.max(0, amount)), now());
    if (!fresh) return spendStatus(env, scope);
  }
  await run(
    env.DB,
    "INSERT INTO spend (scope, approved, reserved, updated) VALUES (?, ?, 0, ?) ON CONFLICT(scope) DO UPDATE SET approved = approved + excluded.approved, updated = excluded.updated",
    scope,
    cents(Math.max(0, amount)),
    now(),
  );
  return spendStatus(env, scope);
}

/**
 * Reserves `amount` against the scope if, and only if, the allowance still covers it. The check
 * and the write are one statement: under two concurrent calls at most one succeeds when only one
 * fits. A missing row (nothing approved yet) never reserves.
 */
export async function reserveSpend(
  env: Env,
  scope: string,
  amount: number,
): Promise<{ ok: boolean; status: SpendStatus }> {
  const a = cents(Math.max(0, amount));
  const changed = await run(
    env.DB,
    "UPDATE spend SET reserved = reserved + ?, updated = ? WHERE scope = ? AND reserved + ? <= approved + 0.0005",
    a,
    now(),
    scope,
    a,
  );
  return { ok: changed === 1, status: await spendStatus(env, scope) };
}

/** Gives a reservation back: an attempt that produced nothing and is known not to be billed. */
export async function releaseSpend(env: Env, scope: string, amount: number): Promise<void> {
  await run(
    env.DB,
    "UPDATE spend SET reserved = MAX(0, reserved - ?), updated = ? WHERE scope = ?",
    cents(Math.max(0, amount)),
    now(),
    scope,
  );
}

/**
 * An attempt whose billing is not known (a timeout, a dropped connection, a vendor failure after
 * it accepted the request): its reservation stays and the amount is counted for reconciliation.
 */
export async function holdUncertain(env: Env, scope: string, amount: number): Promise<void> {
  await run(env.DB, "UPDATE spend SET uncertain = uncertain + ?, updated = ? WHERE scope = ?", cents(Math.max(0, amount)), now(), scope);
}

export async function spendStatus(env: Env, scope: string): Promise<SpendStatus> {
  const row = await first<{ approved: number; reserved: number; uncertain: number }>(env.DB, "SELECT approved, reserved, uncertain FROM spend WHERE scope = ?", scope);
  const approved = row?.approved ?? 0;
  const reserved = row?.reserved ?? 0;
  return { approved, reserved, remaining: Math.max(0, cents(approved - reserved)), uncertain: row?.uncertain ?? 0 };
}

/** Would a reservation of `amount` fit right now? A read, not a reservation: the submit reserves. */
export async function spendFits(
  env: Env,
  scope: string,
  amount: number,
): Promise<{ ok: boolean; status: SpendStatus }> {
  const status = await spendStatus(env, scope);
  return { ok: cents(amount) <= status.remaining + 0.0005, status };
}

/** The scope a client's own paid work (portraits) is approved under. */
export const clientScope = (clientId: string) => `client:${clientId}`;

/**
 * Approves (when the caller confirmed) and reserves one paid call outside a month's run, in that
 * order. Without `approve`, answers with the estimate so the caller can ask the designer once.
 */
export async function reserveOrAsk(
  env: Env,
  scope: string,
  amount: number,
  approve: boolean | undefined,
  what: string,
  /** The caller's run id: the same approval sent twice adds the allowance once. */
  runId?: string,
): Promise<void> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  if (approve) await approveSpend(env, scope, amount, runId);
  const r = await reserveSpend(env, scope, amount);
  if (r.ok) return;
  throw new StudioError(`${what}: about $${amount.toFixed(2)}. Confirm to go ahead.`, 409, false, {
    needsApproval: true,
    images: 1,
    estimate: amount,
    perImage: amount,
    known: true,
    approved: r.status.approved,
    reserved: r.status.reserved,
  });
}
