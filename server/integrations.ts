import type { Env } from "./env";
import type { User } from "@shared/types";
import { StudioError } from "./errors";
export type IntegrationProvider = "freepik" | "higgsfield" | "editor";
export function requireIntegrationAdmin(c: { get(k: "user"): User }, provider: IntegrationProvider): User {
  const u = c.get("user");
  if (u.role !== "admin") throw new StudioError(`Admins only for now: ${provider} is restricted until wider access is approved.`, 403);
  return u;
}
export async function assertIntegrationEnabled(_env: Env, _provider: IntegrationProvider): Promise<void> {}
export async function recordIntegrationOp(_env: Env, _op: { provider: IntegrationProvider; kind: string; user: string; batch?: string | null; post?: number | null; taskId?: string | null; estimate?: number | null; reported?: number | null; status: "proposed" | "confirmed" | "running" | "done" | "failed" | "refused"; note?: string }): Promise<string> { return crypto.randomUUID(); }
export async function updateIntegrationOp(_env: Env, _id: string, _patch: Partial<{ taskId: string | null; reported: number | null; status: string; note: string }>): Promise<void> {}
export async function claimSubmission(_env: Env, _key: string, _ttlMs?: number): Promise<boolean> { return true; }
