/**
 * "Check again" on a Video studio clip recorded as failed (Generate, Enhance, a preset: Higgsfield
 * through the MCP sign-in or the Cloud API, or Magnific). The same risk as the Photo studio's AI
 * tools: the settler asks with a one-second wait and records the clip as failed when it cannot read
 * a result, while the provider may have finished it (and charged for it). Asked again, the provider
 * is read with its status tools only (server/provider-status.ts; the Cloud API's request status),
 * never with the tool that made the clip, and:
 *   - finished: the mp4 is stored exactly as the settler stores it (`storeFinishedClip`: the same
 *     key, the same "first finished clip" rule for the client), the version done, the run's ledger
 *     row closed once with the credits the provider names, else the estimate;
 *   - still running: said so; failed there: kept failed with the provider's reason.
 *
 * Route (mounted at /api/studio/posts/video/check):
 *   POST /   {batch, id}   admins
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { first, now, run } from "./db";
import { makeClient } from "./engine";
import { ownedPlan } from "./posts";
import { claimSubmission, recordIntegrationOp, requireIntegrationUser, updateIntegrationOp, type IntegrationProvider } from "./integrations";
import { MCP_PROVIDER } from "./higgsfield-mcp";
import { MAGNIFIC_PROVIDER } from "./video-magnific";
import { askJobStatus, notCollected, type Said } from "./provider-status";
import { parseSettings, storeFinishedClip, versionItem, type VideoItem, type VideoRow } from "./video";
import type { User } from "@shared/types";

type Variables = { user: User };
export const videoRecheckRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CHECK_CLAIM_MS = 60 * 1000;

export interface VideoRecheckAnswer {
  outcome: "done" | "running" | "failed" | "unknown";
  message: string;
  video: VideoItem;
}

const LEDGER: Record<string, IntegrationProvider> = { [MCP_PROVIDER]: "higgsfield", higgsfield: "higgsfield", [MAGNIFIC_PROVIDER]: "freepik" };
const WHO: Record<string, string> = { [MCP_PROVIDER]: "Higgsfield", higgsfield: "Higgsfield", [MAGNIFIC_PROVIDER]: "Magnific" };

/** The Cloud API's request status (a GET, the same read the settler makes), in the shape the MCP answers have. */
async function cloudStatus(env: Env, requestId: string): Promise<{ said: Said | null; fetchFn: typeof fetch }> {
  const engine = await makeClient(env);
  const st = await engine.videoStatus(requestId);
  const said: Said = st.state === "done" ? { status: "completed", url: st.url, error: null, credits: null } : st.state === "failed" ? { status: "failed", url: null, error: st.message, credits: null } : { status: st.raw === "unknown" ? "pending" : st.raw, url: null, error: null, credits: null };
  return { said, fetchFn: fetch };
}

/** The version's ledger row closed once (see the Photo studio's twin in server/photo-tools.ts). */
async function closeLedgerLate(env: Env, v: VideoRow, provider: IntegrationProvider, credits: number | null, note: string): Promise<void> {
  const op = v.op_id
    ? await first<{ id: string; status: string; reported: number | null }>(env.DB, "SELECT id, status, reported FROM integration_ops WHERE id = ?", v.op_id)
    : await first<{ id: string; status: string; reported: number | null }>(env.DB, "SELECT id, status, reported FROM integration_ops WHERE provider = ? AND task_id = ? AND kind LIKE 'video%' ORDER BY created LIMIT 1", provider, v.request_id);
  if (op && op.status === "done" && typeof op.reported === "number") return;
  // The Cloud API's row is closed as its settler closes it: done, the figure left to the reconciliation.
  const patch = v.provider === "higgsfield" ? { status: "done", note } : { status: "done", reported: credits, note };
  if (op) await updateIntegrationOp(env, op.id, { ...patch, taskId: v.request_id });
  else await recordIntegrationOp(env, { provider, kind: "video", user: v.owner, batch: v.batch, post: v.post, taskId: v.request_id, estimate: credits, reported: v.provider === "higgsfield" ? null : credits, status: "done", note });
}

/** "Check again" on a failed clip: asked of the provider (a status read, free; nothing is run again). Admins. */
export async function recheckVideo(env: Env, user: User, batch: string, id: string): Promise<VideoRecheckAnswer> {
  const b = await ownedPlan(env, user, batch);
  const read = () => first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", id, b.id);
  const v = await read();
  if (!v) throw new StudioError("Video not found.", 404);
  const item = () => versionItem(env, b.id, v.post, v.id);
  const who = WHO[v.provider];
  if (v.status === "done") return { outcome: "done", message: "Already collected: the clip is here. Nothing was asked again.", video: await item() };
  if (v.status !== "failed") return { outcome: "running", message: "This clip is still being made; the versions collect it by themselves.", video: await item() };
  if (!who) throw new StudioError("This version was not made by a provider, so there is nothing to ask.", 409);
  if (!v.request_id) throw new StudioError(`${who} never gave this clip a job id, so there is nothing to ask about. Check ${who}'s own history and balance.`, 409);
  const claim = `video-check:${v.id}`;
  if (!(await claimSubmission(env, claim, CHECK_CLAIM_MS))) throw new StudioError("This clip is being checked right now. Wait a moment.", 409);
  try {
    // Read again under the claim: a press that finished a moment ago has collected it.
    const row = (await read())!;
    if (row.status === "done") return { outcome: "done", message: "Already collected: the clip is here.", video: await item() };
    const { said, fetchFn } = v.provider === "higgsfield" ? await cloudStatus(env, v.request_id) : await askJobStatus(env, v.provider === MAGNIFIC_PROVIDER ? "magnific" : "higgsfield", v.request_id, "clip");
    const not = notCollected(who, v.request_id, said);
    if (said && !not && said.url) {
      const before = row.error;
      await storeFinishedClip(env, b, row, said.url, fetchFn);
      const s = parseSettings(row);
      const credits = said.credits ?? (typeof s.estimate === "number" ? s.estimate : null);
      const how = said.credits !== null ? `reported by ${who}` : "(from the estimate)";
      await closeLedgerLate(env, row, LEDGER[v.provider], credits, `${credits ?? "?"} credits ${how} · collected by Check again${before ? ` (recorded as failed before: ${before.slice(0, 160)})` : ""}`);
      return { outcome: "done", message: `${who} had finished it: the clip is collected. It is a version of the post now.`, video: await item() };
    }
    const answer = not!;
    if (answer.reason) await run(env.DB, "UPDATE videos SET error = ?, updated = ? WHERE id = ?", `Failed on ${who}: ${answer.reason}`.slice(0, 400), now(), v.id);
    return { outcome: answer.outcome, message: answer.message, video: await item() };
  } finally {
    await run(env.DB, "DELETE FROM integration_claims WHERE key = ?", claim);
  }
}

videoRecheckRoutes.post("/", async (c) => {
  const parsed = z.object({ batch: z.string().min(1), id: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Say which month and which version.");
  const v = await first<{ provider: string }>(c.env.DB, "SELECT provider FROM videos WHERE id = ?", parsed.data.id);
  const user = requireIntegrationUser(c, LEDGER[v?.provider ?? ""] ?? "higgsfield");
  return c.json({ ok: true, ...(await recheckVideo(c.env, user, parsed.data.batch, parsed.data.id)) });
});
