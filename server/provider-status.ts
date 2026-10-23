/**
 * Reading what a provider says about one job it already has (the Photo studio's AI tools and the
 * Video studio's clips): the status words, the result's link wherever the answer keeps it, the
 * credits it names, and "Check again" asking with the STATUS tools only (Higgsfield's `jobs_wait`
 * and `show_generation_by_ids`, Magnific's `creations_wait` and `creations_get`). Those read what
 * the provider holds: the settlers call them on every poll of every member without a ledger row,
 * and none of them submits, re-runs or prices anything. The tool that made the result is never
 * called from here.
 */
import type { Env } from "./env";
import { StudioError } from "./errors";
import { fetcher as higgsfieldFetcher, HiggsfieldMcp, parseJobs } from "./higgsfield-mcp";
import { MagnificMcp, magnificFetcher, MCP_NOT_CONNECTED } from "./freepik-mcp";
import { parseCreations } from "./video-magnific";
import { findNumber, jsonOf, objectsWith, resultText, type McpCallResult } from "./mcp-client";

export const DONE = /^(completed|complete|succeeded|success|successful|done|finished|ready)$/i;
/**
 * The end of a job that went wrong. "timeout" / "timed_out" are not in it: the settlers ask with a
 * one-second `jobs_wait` / `creations_wait`, and a wait that ran out says nothing about the job,
 * which may finish a moment later (an Upscale that finished and was charged was once recorded as
 * failed). Such a job is asked again on the next poll and given up only after half an hour.
 */
export const FAILED = /^(failed|failure|error|errored|cancelled|canceled|nsfw|rejected|moderated)$/i;
export const RUNNING = /^(running|processing|in_progress|generating|started|pending|queued|rendering|timeout|timed_out|waiting)$/i;

/** A link the studio itself signed (the input handed to the provider), never a result. */
const ownLink = (env: Env, u: string) => !!env.PUBLIC_BASE_URL && u.startsWith(env.PUBLIC_BASE_URL.replace(/\/+$/, ""));

const PICTURE_LINK = /\.(png|jpe?g|webp)(\?|#|$)/i;
const CLIP_LINK = /\.(mp4|mov|webm)(\?|#|$)/i;

/**
 * The result's link in what a provider said about one job: the link the parser found, else any
 * https link in that job's own part of the answer (a picture's, or a clip's, first), else one in
 * the answer's text. The studio's own links (the input it signed) never count.
 */
export function resultLink(env: Env, parsed: string | null, raw: unknown, text = "", kind: "picture" | "clip" = "picture"): string | null {
  if (parsed && !ownLink(env, parsed)) return parsed;
  const urls: string[] = [];
  const walk = (v: unknown, d: number) => {
    if (d > 6 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (/^https:\/\/\S+$/.test(v.trim())) urls.push(v.trim());
      return;
    }
    if (typeof v !== "object") return;
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(x, d + 1);
  };
  walk(raw, 0);
  for (const m of text.matchAll(/https:\/\/[^\s"'<>)]+/g)) urls.push(m[0]);
  const theirs = urls.filter((u) => !ownLink(env, u));
  return theirs.find((u) => (kind === "clip" ? CLIP_LINK : PICTURE_LINK).test(u)) ?? theirs[0] ?? null;
}

/** One job's own object in an answer (`job_id` for Higgsfield, `identifier` for Magnific), as it came. */
export function jobObject(r: McpCallResult, key: "job_id" | "identifier", id: string): Record<string, unknown> | null {
  const j = jsonOf(r);
  return objectsWith(j, key).find((o) => String(o[key]) === id) ?? (key === "identifier" ? (objectsWith(j, "creationIdentifier").find((o) => String(o.creationIdentifier) === id) ?? null) : null);
}

/** What a provider said about one job when asked again. */
export interface Said {
  status: string;
  url: string | null;
  error: string | null;
  /** Credits the provider names for the job in its answer, when it names any. */
  credits: number | null;
}

/** Credits a job's own part of an answer names (what it cost), or null. */
export function jobCredits(raw: unknown): number | null {
  if (!raw) return null;
  const n = findNumber(raw, ["credits_used", "credits_spent", "credits_charged", "cost_credits", "credits_cost", "cost", "credits"]);
  return n !== null && n >= 0 ? n : null;
}

/** Finished there: a done word, or a link with no status at all. */
export const finishedSaid = (s: Said) => DONE.test(s.status) || (!s.status && !!s.url);

/** The answer that knows most: a finished job over a failed one over a running one. */
function bestOf(said: (Said | null)[]): Said | null {
  const all = said.filter((x): x is Said => !!x);
  const done = all.find(finishedSaid);
  if (done) return { ...done, url: done.url ?? all.find((x) => x.url)?.url ?? null, credits: done.credits ?? all.find((x) => x.credits !== null)?.credits ?? null };
  return all.find((x) => FAILED.test(x.status)) ?? all.find((x) => RUNNING.test(x.status)) ?? all[0] ?? null;
}

/**
 * "Check again": one job asked about with the status tools only (see the top of this file). Null
 * when the provider does not list the job. The fetch to download the result with comes along.
 */
export async function askJobStatus(env: Env, provider: "higgsfield" | "magnific", id: string, kind: "picture" | "clip" = "picture"): Promise<{ said: Said | null; fetchFn: typeof fetch }> {
  if (provider === "higgsfield") {
    const mcp = new HiggsfieldMcp(env, higgsfieldFetcher());
    await mcp.connect();
    const wait = await mcp.call("jobs_wait", { jobs: [{ index: 0, job_id: id }], timeout_seconds: 1 });
    const jobs = parseJobs(wait);
    const e = jobs.find((x) => x.jobId === id) ?? (jobs.length === 1 ? jobs[0] : undefined);
    const raw = e ? jobObject(wait, "job_id", e.jobId) : null;
    const fromWait: Said | null = e ? { status: e.status, url: resultLink(env, e.url, raw, "", kind), error: e.error, credits: jobCredits(raw) } : null;
    let fromShow: Said | null = null;
    if (!(fromWait && finishedSaid(fromWait) && fromWait.url) && (await mcp.hasTool("show_generation_by_ids"))) {
      const shown = await mcp.call("show_generation_by_ids", { jobs: [{ index: 0, job_id: id }] });
      const s = parseJobs(shown).find((x) => x.jobId === id);
      const rawShown = jobObject(shown, "job_id", id);
      if (s) fromShow = { status: s.status, url: resultLink(env, s.url, rawShown, "", kind), error: s.error, credits: jobCredits(rawShown) };
      else if (!shown.isError && fromWait && finishedSaid(fromWait)) fromShow = { status: fromWait.status, url: resultLink(env, null, jsonOf(shown), resultText(shown), kind), error: null, credits: null };
    }
    return { said: bestOf([fromWait, fromShow]), fetchFn: higgsfieldFetcher() };
  }
  const mcp = await MagnificMcp.open(env);
  if (!mcp) throw new StudioError(MCP_NOT_CONNECTED, 409, false, { connected: false });
  const wait = await mcp.callTool("creations_wait", { identifiers: [id], timeoutSeconds: 1 });
  const e = parseCreations(wait).find((x) => x.identifier === id);
  const raw = jobObject(wait, "identifier", id);
  const fromWait: Said | null = e ? { status: e.status, url: resultLink(env, e.url, raw, "", kind), error: e.error, credits: jobCredits(raw) } : null;
  let fromGet: Said | null = null;
  if (!(fromWait && finishedSaid(fromWait) && fromWait.url) && (await mcp.listTools()).some((t) => t.name === "creations_get")) {
    const got = await mcp.callTool("creations_get", { identifier: id, creationIdentifier: id });
    const g = parseCreations(got).find((x) => x.identifier === id);
    const rawGot = jobObject(got, "identifier", id);
    if (g) fromGet = { status: g.status, url: resultLink(env, g.url, rawGot, "", kind), error: g.error, credits: jobCredits(rawGot) };
    else if (!got.isError && fromWait && finishedSaid(fromWait)) fromGet = { status: fromWait.status, url: resultLink(env, null, jsonOf(got), resultText(got), kind), error: null, credits: null };
  }
  return { said: bestOf([fromWait, fromGet]), fetchFn: magnificFetcher() };
}

/** "Check again" said in plain words when nothing was collected; null when the job finished with a link (the caller collects it). */
export function notCollected(who: string, providerJob: string, said: Said | null): { outcome: "running" | "failed" | "unknown"; message: string; reason: string } | null {
  if (!said) return { outcome: "unknown", message: `${who} does not list this job (${providerJob}) any more. Nothing was changed; check ${who}'s own history.`, reason: "" };
  if (finishedSaid(said)) return said.url ? null : { outcome: "unknown", message: `${who} says the job finished but gave no link to the result. Nothing was changed; check ${who}'s own history.`, reason: "" };
  if (FAILED.test(said.status)) {
    const reason = (said.error?.trim() || "").replace(/\.+$/, "");
    return { outcome: "failed", message: `${who} says the job failed${reason ? `: ${reason}` : " (it gives no reason)"}.`, reason };
  }
  if (RUNNING.test(said.status)) return { outcome: "running", message: `${who} says the job is still running (${said.status}). Nothing was changed; check again in a minute.`, reason: "" };
  return { outcome: "unknown", message: `${who} answers "${said.status || "no status"}" for this job. Nothing was changed.`, reason: "" };
}
