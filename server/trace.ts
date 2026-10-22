/**
 * Tracing adapter: mirrors what the engine and the planner do (a submission, a stored picture, a
 * failure, a review, a plan written) to Langfuse, when keys are set. D1 stays the authority on
 * history (tasks, post_takes, spend, plan_preflights); this only mirrors, never blocks, never
 * fails a caller. With nothing configured every call is a no-op.
 *
 *   traceEvent(env, event)   fire-and-forget: returns at once; failures go to console.error
 *   traceEnabled(env)        keys found in the environment or the settings table
 *   traceStatus(env)         for an admin screen: enabled, host, source, counters
 *   traceIdle()              waits for the sends in flight (tests; a Worker's ctx.waitUntil)
 */
import type { Env } from "./env";
import { getSetting } from "./settings";

export type TraceKind = "generation" | "review" | "plan" | "edit";

export interface TraceMetadata {
  client?: string | null;
  post?: number | null;
  /** The post revision the picture is made for (tasks.making_for / made_for). */
  revision?: number | null;
  /** A fingerprint of the prompt sent (there is no named prompt version yet; see docs/tracing.md). */
  promptVersion?: string | null;
  /** The reference pictures attached after image 1 (R2 keys), in order. */
  references?: string[];
  engine?: string | null;
  attempt?: number | null;
  error?: string | null;
  [k: string]: unknown;
}

export interface TraceEvent {
  kind: TraceKind;
  /** The month's batch id: one trace per month. */
  traceId: string;
  /** The task id (or "plan:<stamp>" for a plan): one observation per step of it. */
  spanId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  /** USD, as recorded against the budget. */
  cost?: number | null;
  metadata?: TraceMetadata;
}

export const LANGFUSE_PUBLIC_KEY_SETTING = "langfuse_public_key";
export const LANGFUSE_SECRET_KEY_SETTING = "langfuse_secret_key";
export const LANGFUSE_HOST_SETTING = "langfuse_host";
export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";
export const TRACE_TIMEOUT_MS = 5_000;
/** Prompts and other long strings are cut here before they leave the studio. */
export const TRACE_TEXT_MAX = 4_000;
const CONFIG_TTL_MS = 60_000;

export interface TraceConfig {
  publicKey: string;
  secretKey: string;
  host: string;
  source: "env" | "settings";
}

let cachedConfig: { at: number; value: TraceConfig | null } | null = null;
const inFlight = new Set<Promise<void>>();
const counters = { sent: 0, failed: 0, lastError: null as string | null, lastAt: null as number | null };

/** Forgets the cached keys (tests, or right after the admin saves new ones). */
export function resetTraceCache(): void {
  cachedConfig = null;
}

function hostOf(raw: string | null | undefined): string {
  const h = (raw ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(h) ? h : DEFAULT_LANGFUSE_HOST;
}

/** The Langfuse keys: the environment wins, then the settings table; null when neither has both. */
export async function traceConfig(env: Env): Promise<TraceConfig | null> {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) return cachedConfig.value;
  let value: TraceConfig | null = null;
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) value = { publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, host: hostOf(env.LANGFUSE_HOST), source: "env" };
  else if (env.DB) {
    try {
      const [publicKey, secretKey, host] = await Promise.all([getSetting(env, LANGFUSE_PUBLIC_KEY_SETTING), getSetting(env, LANGFUSE_SECRET_KEY_SETTING), getSetting(env, LANGFUSE_HOST_SETTING)]);
      if (publicKey && secretKey) value = { publicKey, secretKey, host: hostOf(host ?? env.LANGFUSE_HOST), source: "settings" };
    } catch (e) {
      // No settings table, no SESSION_SECRET: tracing simply stays off.
      console.error("[trace] settings unavailable", e instanceof Error ? e.message : String(e));
    }
  }
  cachedConfig = { at: Date.now(), value };
  return value;
}

export async function traceEnabled(env: Env): Promise<boolean> {
  return !!(await traceConfig(env));
}

const SECRET_FIELD = /^(key|token|secret|password|authorization)$|api[_-]?key|secret|token|password/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * What may leave the studio: no field named like a credential, no e-mail address, no string longer
 * than TRACE_TEXT_MAX characters (a prompt is cut, the fingerprint still identifies it).
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const clean = value.replace(EMAIL, "[email]");
    return clean.length > TRACE_TEXT_MAX ? `${clean.slice(0, TRACE_TEXT_MAX)}…[truncated ${clean.length - TRACE_TEXT_MAX} chars]` : clean;
  }
  if (typeof value !== "object") return value;
  if (depth > 8) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(k)) continue;
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/** A short stable fingerprint of a text (djb2), used as the prompt's version until prompts are named. */
export function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The reference pictures a post's brief attaches after image 1, in the order server/engine.ts
 * postImages sends them, from the task's stored brief (JSON) or a parsed one.
 */
export function postReferenceKeys(brief: string | Record<string, unknown> | null | undefined): string[] {
  let b: Record<string, unknown>;
  try {
    b = typeof brief === "string" ? (JSON.parse(brief) as Record<string, unknown>) : (brief ?? {});
  } catch {
    return [];
  }
  const keys: string[] = [];
  const list = (v: unknown) => (Array.isArray(v) ? (v as { key?: unknown }[]) : []);
  for (const e of list(b.extraProducts)) if (typeof e?.key === "string") keys.push(e.key);
  for (const a of list(b.ambassadors)) if (typeof a?.key === "string") keys.push(a.key);
  const place = b.place as { key?: unknown } | undefined;
  if (typeof place?.key === "string") keys.push(place.key);
  const realRef = b.realRef as { key?: unknown } | undefined;
  if (typeof realRef?.key === "string") keys.push(realRef.key);
  if (!b.refIsSource && !b.noRefImage) {
    const look = (typeof b.styleKey === "string" && b.styleKey) || (typeof b.tileKey === "string" && b.tileKey) || (typeof b.ref === "string" && b.ref);
    if (look) keys.push(look);
  }
  const editRef = b.editRef as { key?: unknown } | undefined;
  if (typeof editRef?.key === "string") keys.push(editRef.key);
  return keys;
}

/** The Langfuse ingestion batch for one event: the trace (upserted) and one observation. */
export function ingestionBody(event: TraceEvent, at = Date.now()): { batch: Record<string, unknown>[] } {
  const ts = new Date(at).toISOString();
  const meta = (redact(event.metadata ?? {}) as Record<string, unknown>) ?? {};
  const error = event.metadata?.error ?? null;
  const observationType = event.kind === "generation" || event.kind === "review" ? "generation-create" : "span-create";
  const observationId = [event.spanId, event.kind, event.name, event.metadata?.attempt ?? null].filter((x) => x !== null && x !== undefined && x !== "").join(":");
  const observation: Record<string, unknown> = {
    id: observationId,
    traceId: event.traceId,
    name: event.name,
    startTime: ts,
    endTime: ts,
    input: redact(event.input ?? null),
    output: redact(event.output ?? null),
    metadata: { ...meta, kind: event.kind },
    level: error ? "ERROR" : "DEFAULT",
    statusMessage: error ? String(redact(error)) : undefined,
  };
  if (observationType === "generation-create") {
    observation.model = event.model ?? undefined;
    if (typeof event.cost === "number") observation.costDetails = { total: event.cost };
  }
  return {
    batch: [
      {
        id: `${event.traceId}:trace:${at}`,
        type: "trace-create",
        timestamp: ts,
        body: { id: event.traceId, name: `month ${event.traceId}`, metadata: { client: meta.client ?? null }, tags: [event.kind] },
      },
      { id: `${observationId}:${at}`, type: observationType, timestamp: ts, body: observation },
    ],
  };
}

async function send(env: Env, event: TraceEvent): Promise<void> {
  const cfg = await traceConfig(env);
  if (!cfg) return;
  const auth = `Basic ${btoa(`${cfg.publicKey}:${cfg.secretKey}`)}`;
  const r = await fetch(`${cfg.host}/api/public/ingestion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(ingestionBody(event)),
    signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
  });
  if (!r.ok && r.status !== 207) throw new Error(`Langfuse answered ${r.status}`);
  counters.sent += 1;
  counters.lastAt = Date.now();
}

/**
 * Mirrors one event. Returns at once; the send runs behind and every failure is logged, never
 * thrown. With no keys configured nothing is sent at all.
 */
export function traceEvent(env: Env, event: TraceEvent): void {
  const p = send(env, event)
    .catch((e) => {
      counters.failed += 1;
      counters.lastError = e instanceof Error ? e.message : String(e);
      counters.lastAt = Date.now();
      console.error("[trace]", event.kind, event.name, counters.lastError);
    })
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** Resolves when every send started so far has finished (never rejects). */
export async function traceIdle(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

export interface TraceStatus {
  enabled: boolean;
  host: string | null;
  source: TraceConfig["source"] | "none";
  sent: number;
  failed: number;
  lastError: string | null;
  lastAt: number | null;
}

/** For an admin screen: whether tracing is on, where it goes, and how the sends went in this isolate. */
export async function traceStatus(env: Env): Promise<TraceStatus> {
  const cfg = await traceConfig(env);
  return { enabled: !!cfg, host: cfg?.host ?? null, source: cfg?.source ?? "none", ...counters };
}
