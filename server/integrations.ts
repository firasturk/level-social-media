/**
 * Integration governance: the rules every outside provider behind an admin switch goes through
 * (Freepik's Photo lab, Higgsfield video, the video editor placeholder). docs/integrations.md has
 * the rules in plain words; this file is their one implementation.
 *
 *  1. Admins only, for now: `requireIntegrationAdmin` refuses a member with 403 before anything
 *     else is read. Viewing (listing jobs or videos, serving stored files) is not gated here.
 *  2. A switch per provider: `assertIntegrationEnabled` refuses with 503 when an admin turned the
 *     provider off (setting `integration_<provider>_enabled`). On by default.
 *  3. A ledger: `recordIntegrationOp` writes one `integration_ops` row per operation, with who,
 *     when, provider, kind, post, the provider's task id, the estimate and the reported cost.
 *  4. Confirm before spend: a route proposes an operation (`proposeOp`, status 'proposed', returns
 *     {opId, estimate, needsConfirmation: true}); its execution needs {opId, confirm: true}
 *     (`confirmSpend`). An estimate that is not known blocks the run ("cost not known: blocked
 *     until clarified") unless the kind is on the free list (searching, previewing, listing).
 *  5. No duplicates: `claimSubmission` claims a key in D1 before the provider is called; the same
 *     key within its time to live is refused.
 *  6. No automatic paid retries and no provider fallback: `noRetry` runs a provider call exactly
 *     once and lets its failure stand.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { getSetting, setSetting } from "./settings";
import type { User } from "@shared/types";

export type IntegrationProvider = "freepik" | "higgsfield" | "editor" | "audio";
export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = ["freepik", "higgsfield", "editor", "audio"] as const;
export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  freepik: "Freepik",
  higgsfield: "Higgsfield",
  editor: "Video editor",
  audio: "Video audio",
};
/** What each switch governs, for the admin panel. */
export const PROVIDER_SCOPE: Record<IntegrationProvider, string> = {
  freepik: "The Photo lab (remove or replace a background, relight, upscale) and the Freepik key.",
  higgsfield: "Videos made from a post's picture (not the picture engine, which keeps its own settings).",
  editor: "The video editor: saving a project and storing an export as a version of the post. Rendering happens in the browser; nothing is sent to a provider or charged. Off, saves and exports are refused; opening the editor to look stays open.",
  audio: "Tracks uploaded for a post's videos and each version's audio choice (no provider is paid: generated music is not connected yet).",
};

export type IntegrationOpStatus = "proposed" | "confirmed" | "running" | "done" | "failed" | "refused";

export interface IntegrationOp {
  id: string;
  provider: IntegrationProvider;
  kind: string;
  user_id: string;
  batch: string | null;
  post: number | null;
  task_id: string | null;
  estimate: number | null;
  reported: number | null;
  status: IntegrationOpStatus;
  note: string;
  created: number;
  updated: number;
}

/**
 * Kinds that never spend anything on the provider: searching, previewing, listing, asking a task's
 * status, verifying a key. Only these may run without a known estimate.
 */
export const FREE_KINDS: ReadonlySet<string> = new Set(["search", "preview", "list", "status", "verify"]);

export const COST_UNKNOWN = "cost not known: blocked until clarified";

function isProvider(p: string): p is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(p);
}

/* ───────────── 1. Admins only ───────────── */

export const ADMINS_ONLY = "Admins only for now";

/** The signed-in user when they are an admin; a member is refused with 403 and a plain reason. */
export function requireIntegrationAdmin(c: { get(k: "user"): User }, provider: IntegrationProvider): User {
  const user = c.get("user");
  if (!user || user.role !== "admin")
    throw new StudioError(`${ADMINS_ONLY}: ${PROVIDER_LABELS[provider]} runs are limited to admins until the integration is approved for the whole team.`, 403);
  return user;
}

/* ───────────── 2. The switch ───────────── */

export const switchSetting = (provider: IntegrationProvider) => `integration_${provider}_enabled`;

/** True unless an admin switched the provider off. */
export async function integrationSwitch(env: Env, provider: IntegrationProvider): Promise<boolean> {
  const v = await getSetting(env, switchSetting(provider));
  return v !== "0";
}

export async function setIntegrationSwitch(env: Env, provider: IntegrationProvider, enabled: boolean): Promise<void> {
  await setSetting(env, switchSetting(provider), enabled ? "1" : "0");
}

export function switchedOffMessage(provider: IntegrationProvider): string {
  return `${PROVIDER_LABELS[provider]} is switched off by an admin. Nothing was sent or charged. Turn it back on under Admin → Integrations.`;
}

/** Refuses with 503 while the provider's switch is off. */
export async function assertIntegrationEnabled(env: Env, provider: IntegrationProvider): Promise<void> {
  if (!(await integrationSwitch(env, provider))) throw new StudioError(switchedOffMessage(provider), 503);
}

export interface IntegrationAccess {
  admin: boolean;
  enabled: boolean;
  /** Empty when the viewer may run the provider; otherwise why not, in plain words. */
  reason: string;
}

/** What a viewer may do with a provider, for the entry points (Photo lab, Video). */
export async function integrationAccess(env: Env, user: User | undefined, provider: IntegrationProvider): Promise<IntegrationAccess> {
  const admin = user?.role === "admin";
  const enabled = await integrationSwitch(env, provider);
  const reason = !admin ? `${ADMINS_ONLY}: ${PROVIDER_LABELS[provider]} is open to admins until it is approved for the whole team.` : !enabled ? switchedOffMessage(provider) : "";
  return { admin, enabled, reason };
}

/* ───────────── 3. The ledger ───────────── */

export interface IntegrationOpInput {
  provider: IntegrationProvider;
  kind: string;
  user: string;
  batch?: string | null;
  post?: number | null;
  taskId?: string | null;
  estimate?: number | null;
  reported?: number | null;
  status: IntegrationOpStatus;
  note?: string;
}

/** One ledger row; returns its id. */
export async function recordIntegrationOp(env: Env, op: IntegrationOpInput): Promise<string> {
  const id = uuid();
  const t = now();
  await run(
    env.DB,
    "INSERT INTO integration_ops (id, provider, kind, user_id, batch, post, task_id, estimate, reported, status, note, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    op.provider,
    op.kind,
    op.user,
    op.batch ?? null,
    op.post ?? null,
    op.taskId ?? null,
    op.estimate ?? null,
    op.reported ?? null,
    op.status,
    (op.note ?? "").slice(0, 500),
    t,
    t,
  );
  return id;
}

export interface IntegrationOpPatch {
  taskId: string | null;
  reported: number | null;
  status: string;
  note: string;
  /** The admin who confirmed the run, when it changes hands from the proposer. */
  user: string;
}

export async function updateIntegrationOp(env: Env, id: string, patch: Partial<IntegrationOpPatch>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.taskId !== undefined) {
    sets.push("task_id = ?");
    params.push(patch.taskId);
  }
  if (patch.reported !== undefined) {
    sets.push("reported = ?");
    params.push(patch.reported);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note.slice(0, 500));
  }
  if (patch.user !== undefined) {
    sets.push("user_id = ?");
    params.push(patch.user);
  }
  if (!sets.length) return;
  sets.push("updated = ?");
  params.push(now(), id);
  await run(env.DB, `UPDATE integration_ops SET ${sets.join(", ")} WHERE id = ?`, ...params);
}

/** The running op that carries this provider task id, moved on when the provider finished it. */
export async function finishIntegrationOpByTask(env: Env, provider: IntegrationProvider, taskId: string, status: "done" | "failed", patch: { reported?: number | null; note?: string } = {}): Promise<void> {
  const row = await first<{ id: string }>(env.DB, "SELECT id FROM integration_ops WHERE provider = ? AND task_id = ? AND status IN ('confirmed', 'running') ORDER BY created DESC LIMIT 1", provider, taskId);
  if (row) await updateIntegrationOp(env, row.id, { status, ...patch });
}

export async function getIntegrationOp(env: Env, id: string | undefined): Promise<IntegrationOp | null> {
  if (!id) return null;
  return first<IntegrationOp>(env.DB, "SELECT * FROM integration_ops WHERE id = ?", id);
}

export interface IntegrationOpFilters {
  provider?: IntegrationProvider;
  user?: string;
  batch?: string;
  status?: IntegrationOpStatus;
  limit?: number;
}

export type IntegrationOpView = IntegrationOp & { user_name: string | null; user_email: string | null };

/** The ledger, newest first, with who did it. */
export async function listIntegrationOps(env: Env, filters: IntegrationOpFilters = {}): Promise<IntegrationOpView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.provider) {
    where.push("o.provider = ?");
    params.push(filters.provider);
  }
  if (filters.user) {
    where.push("o.user_id = ?");
    params.push(filters.user);
  }
  if (filters.batch) {
    where.push("o.batch = ?");
    params.push(filters.batch);
  }
  if (filters.status) {
    where.push("o.status = ?");
    params.push(filters.status);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(filters.limit ?? 100)));
  return all<IntegrationOpView>(
    env.DB,
    `SELECT o.*, u.name AS user_name, u.email AS user_email FROM integration_ops o LEFT JOIN users u ON u.id = o.user_id${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY o.created DESC LIMIT ?`,
    ...params,
    limit,
  );
}

/* ───────────── 4. Confirm before spend ───────────── */

export interface Proposal {
  opId: string;
  estimate: number | null;
  needsConfirmation: true;
}

/**
 * A paid operation proposed: the ledger row is written as 'proposed' with the estimate (null when
 * the price is not known) and the client is told to confirm it. Nothing reaches the provider.
 */
export async function proposeOp(env: Env, op: Omit<IntegrationOpInput, "status">): Promise<Proposal> {
  const opId = await recordIntegrationOp(env, { ...op, status: "proposed", note: op.note ?? (op.estimate == null ? COST_UNKNOWN : "") });
  return { opId, estimate: op.estimate ?? null, needsConfirmation: true };
}

/** The body fields every execution route reads. */
export const confirmSchema = z.object({ opId: z.string().min(1).optional(), confirm: z.boolean().optional() });

/**
 * The gate an execution route passes before it calls the provider: the proposal exists for this
 * provider and is still 'proposed'; the request says {opId, confirm: true}; the estimate is known
 * (or the kind is free); and nobody claimed this op in the last minute. The row then records the
 * confirming admin and moves to 'confirmed'. Every refusal is written to the row as 'refused'
 * where it makes sense, so the ledger shows what was blocked and why.
 */
export async function confirmSpend(env: Env, args: { provider: IntegrationProvider; user: User; opId?: string; confirm?: boolean; ttlMs?: number }): Promise<IntegrationOp> {
  const op = await getIntegrationOp(env, args.opId);
  if (!op || op.provider !== args.provider) throw new StudioError("That operation is not known: propose it again.", 404);
  if (args.confirm !== true)
    throw new StudioError(`Confirm the cost first: ${PROVIDER_LABELS[op.provider]} ${op.kind}${op.estimate != null ? ` is about $${op.estimate.toFixed(2)}` : ""}.`, 409, false, {
      opId: op.id,
      estimate: op.estimate,
      needsConfirmation: true,
    });
  if (op.status !== "proposed") throw new StudioError(`This operation was already ${op.status === "refused" ? "refused" : "confirmed"}: propose it again to run it once more.`, 409);
  if (op.estimate == null && !FREE_KINDS.has(op.kind) && !FREE_KINDS.has(op.kind.split(".").pop() ?? "")) {
    await updateIntegrationOp(env, op.id, { status: "refused", note: COST_UNKNOWN });
    throw new StudioError(`${COST_UNKNOWN}. ${PROVIDER_LABELS[op.provider]} has no price on file for "${op.kind}"; an admin sets one under Admin → Integrations before it can run.`, 409, false, { opId: op.id, estimate: null });
  }
  if (!(await claimSubmission(env, `op:${op.id}`, args.ttlMs))) throw new StudioError("This operation was submitted a moment ago: wait for its result instead of sending it again.", 409);
  await updateIntegrationOp(env, op.id, { status: "confirmed", user: args.user.id, note: "" });
  return { ...op, status: "confirmed", user_id: args.user.id, note: "" };
}

/* ───────────── 5. No duplicates ───────────── */

export const CLAIM_TTL_MS = 60_000;

/**
 * Claims `key` for `ttlMs`. False when the same key was claimed within that time: the caller has a
 * duplicate submission (a double click, a second tab, a retried request) and must not call the
 * provider. One atomic statement, so two requests racing for the same key cannot both win.
 */
export async function claimSubmission(env: Env, key: string, ttlMs: number = CLAIM_TTL_MS): Promise<boolean> {
  const t = now();
  const changed = await run(
    env.DB,
    "INSERT INTO integration_claims (key, created) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET created = excluded.created WHERE integration_claims.created <= ?",
    key,
    t,
    t - ttlMs,
  );
  return changed > 0;
}

/* ───────────── 6. No retries, no fallback ───────────── */

/**
 * Runs one provider call exactly once. A failure is the answer: it is not retried (a retry would
 * pay again for work that may already be running) and no other provider is tried in its place (the
 * admin confirmed this provider at this price, not another). The call sites of every integration
 * submission wrap the provider in this so the rule is visible where it matters.
 */
export async function noRetry<T>(call: () => Promise<T>): Promise<T> {
  return call();
}

/* ───────────── Estimates on file ───────────── */

export const estimateSetting = (provider: IntegrationProvider, kind: string) => `integration_${provider}_estimate_${kind}`;

/**
 * The USD estimate an admin typed for a kind of operation that has no published price in
 * shared/pricing (a Higgsfield video clip); null when none was entered, which blocks the run.
 */
export async function integrationEstimate(env: Env, provider: IntegrationProvider, kind: string): Promise<number | null> {
  const v = await getSetting(env, estimateSetting(provider, kind));
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ───────────── Admin routes: /api/admin/integrations ───────────── */

type Variables = { user: User };
/** Mounted under the admin router, whose middleware already refuses members. */
export const integrationAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export interface ProviderState {
  provider: IntegrationProvider;
  label: string;
  scope: string;
  enabled: boolean;
  /** The admin-entered estimates on file, by kind. */
  estimates: Record<string, number | null>;
}

/** The kinds whose estimate an admin may enter, per provider. */
export const ESTIMATE_KINDS: Record<IntegrationProvider, { kind: string; label: string }[]> = {
  freepik: [],
  higgsfield: [{ kind: "video", label: "One video clip" }],
  editor: [],
  audio: [],
};

export async function providerStates(env: Env): Promise<ProviderState[]> {
  const out: ProviderState[] = [];
  for (const provider of INTEGRATION_PROVIDERS) {
    const estimates: Record<string, number | null> = {};
    for (const k of ESTIMATE_KINDS[provider]) estimates[k.kind] = await integrationEstimate(env, provider, k.kind);
    out.push({ provider, label: PROVIDER_LABELS[provider], scope: PROVIDER_SCOPE[provider], enabled: await integrationSwitch(env, provider), estimates });
  }
  return out;
}

integrationAdminRoutes.get("/", async (c) => {
  const provider = c.req.query("provider");
  const status = c.req.query("status");
  const ops = await listIntegrationOps(c.env, {
    provider: provider && isProvider(provider) ? provider : undefined,
    status: status as IntegrationOpStatus | undefined,
    user: c.req.query("user") || undefined,
    batch: c.req.query("batch") || undefined,
    limit: Number(c.req.query("limit")) || 100,
  });
  return c.json({ providers: await providerStates(c.env), ops, estimateKinds: ESTIMATE_KINDS });
});

integrationAdminRoutes.post("/switch", async (c) => {
  const parsed = z.object({ provider: z.enum(["freepik", "higgsfield", "editor", "audio"]), enabled: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Say which integration and whether it is on.");
  const { provider, enabled } = parsed.data;
  await setIntegrationSwitch(c.env, provider, enabled);
  await recordIntegrationOp(c.env, { provider, kind: enabled ? "switch.on" : "switch.off", user: c.get("user").id, estimate: 0, status: "done", note: enabled ? "Switched on" : "Switched off: runs are refused until it is on again" });
  return c.json({ ok: true, providers: await providerStates(c.env) });
});

integrationAdminRoutes.post("/estimate", async (c) => {
  const parsed = z.object({ provider: z.enum(["freepik", "higgsfield", "editor", "audio"]), kind: z.string().min(1).max(40), usd: z.number().min(0).max(10000).nullable() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Give the integration, the kind of operation and its cost in dollars (or null to clear it).");
  const { provider, kind, usd } = parsed.data;
  if (!ESTIMATE_KINDS[provider].some((k) => k.kind === kind)) throw new StudioError(`${PROVIDER_LABELS[provider]} has no "${kind}" estimate to set.`);
  await setSetting(c.env, estimateSetting(provider, kind), usd == null ? "" : String(usd));
  await recordIntegrationOp(c.env, { provider, kind: `estimate.${kind}`, user: c.get("user").id, estimate: usd, status: "done", note: usd == null ? "Estimate cleared: runs of this kind are blocked until one is set" : `Estimate set to $${usd.toFixed(2)}` });
  return c.json({ ok: true, providers: await providerStates(c.env) });
});
