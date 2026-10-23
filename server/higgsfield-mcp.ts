/**
 * Higgsfield MCP adapter: videos made on the owner's Higgsfield *subscription credits* through
 * https://mcp.higgsfield.ai/mcp, on the signed-in Higgsfield account, instead of the pay-per-clip
 * Cloud API key (server/higgsfield.ts). docs/higgsfield-mcp.md says what is verified and what is
 * assumed.
 *
 * Sign-in (OAuth 2.0, nothing pasted by anyone; the flow lives in server/oauth-signin.ts, shared with the Magnific MCP):
 *   1. Discovery: the protected-resource metadata of the MCP server names its authorization server
 *      (clerk.higgsfield.ai); that server's metadata gives the endpoints (verified 22 Oct 2026).
 *   2. Dynamic client registration (RFC 7591), once; the client id (and secret, if issued) is kept
 *      as an encrypted setting.
 *   3. Authorization code + PKCE (S256) with the redirect `${PUBLIC_BASE_URL}/api/studio/higgsfield/mcp/callback`,
 *      scopes `openid email offline_access`; the tokens are kept encrypted; the access token is
 *      refreshed before expiry and once on a 401.
 *   4. When registration with a redirect is refused, the device flow is the fallback behind the
 *      same button: the user code and the link are shown, the token endpoint is polled.
 *
 * Videos: `balance` before a run, `media_import_url` of the post's picture (cached an hour per
 * picture key), `generate_video` with `get_cost: true` for the estimate (nothing submitted), then
 * `generate_video_batch` (headless) for the real job, `jobs_wait` from `settlePending`, the mp4
 * into R2 as a version with `provider = 'higgsfield-mcp'`. An `unlim_choice` answer is handed to
 * the admin as a 409 and never answered here. A transport timeout keeps the claim and the row and
 * never resubmits. The same governance as every integration: admins only, the `higgsfield`
 * switch, one ledger row per operation (in credits, said so in the note), confirm before spend.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { first, now, run, uuid } from "./db";
import { getSetting, setSetting, resolveEngineKey, HIGGSFIELD_BILLING_SETTING, HIGGSFIELD_MCP_MODELS_SETTING } from "./settings";
import { OAuthSignIn, readJsonSetting } from "./oauth-signin";
import { CLOUD_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { signObjectUrl } from "./signed";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { McpClient, findNumber, findString, findValue, firstUrl, jsonOf, objectsWith, resultText, type McpCallResult, type McpTool } from "./mcp-client";
import { dataUrlBytes, frameFields, frameSettings, GIVE_UP_MS, parseSettings, postRows, registerPendingSettler, sha256, storeFinishedClip, versionNumbers, videoItem, type VideoItem, type VideoRow, type VideoStatus } from "./video";
import type { User } from "@shared/types";

export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
export const HIGGSFIELD_RESOURCE_METADATA = "https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp";
export const MCP_SCOPES = "openid email offline_access";
/** The `videos.provider` value of a clip made on the subscription credits. */
export const MCP_PROVIDER = "higgsfield-mcp";
export const NOT_SIGNED_IN = "Not signed in: Connection → Higgsfield → Sign in to Higgsfield. Videos on the subscription credits run on that sign-in.";
export const CALLBACK_PATH = "/api/studio/higgsfield/mcp/callback";
/** The tools the adapter calls, by the names the live server lists (docs/higgsfield-mcp.md). */
export const REQUIRED_TOOLS = ["balance", "models_explore", "media_import_url", "generate_video", "generate_video_batch", "jobs_wait"] as const;
/** The same clip (post, engine, idea, settings, source, picture) is not submitted twice within this window. */
const CLAIM_TTL_MS = 10 * 60 * 1000;
const BALANCE_TTL_MS = 60_000;
const MEDIA_TTL_MS = 60 * 60 * 1000;
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
const TOOLS_TTL_MS = 10 * 60 * 1000;
const POLL_LIMIT = 6;

/* ───────────── Fetch injection and caches ───────────── */

let fetchForTests: typeof fetch | null = null;
export function useHiggsfieldMcpFetch(fn: typeof fetch | null): void {
  fetchForTests = fn;
  higgsfieldSignIn.useFetch(fn);
}
/** The fetch the adapter uses: the test's stub when one is set, else the real one (always a plain call). */
export const fetcher = (): typeof fetch => fetchForTests ?? ((input, init) => fetch(input, init));

let toolsCache: { at: number; tools: McpTool[] } | null = null;
let balanceCache: { at: number; credits: number | null; plan: string | null } | null = null;
const mediaCache = new Map<string, { id: string; at: number }>();
let modelsMemo: { at: number; models: McpVideoModel[] } | null = null;

/** What a token had filled: dropped when the tokens change hands (sign-in, sign-out, a refused refresh). */
function dropTokenCaches(): void {
  toolsCache = null;
  balanceCache = null;
  mediaCache.clear();
  modelsMemo = null;
}

/** Tests start from nothing: the metadata is read again and every cache is empty. */
export function resetHiggsfieldMcpCaches(): void {
  higgsfieldSignIn.resetDiscovery();
  dropTokenCaches();
}

/* ───────────── The sign-in: server/oauth-signin.ts, shared with the Magnific MCP ───────────── */

/**
 * Discovery, one registration, PKCE, the callback, refresh, the device fallback: all in the shared
 * helper. The settings keep the keys of the first release (`higgsfield_mcp_client`,
 * `higgsfield_mcp_tokens`, `higgsfield_mcp_pending`, see server/settings.ts) so an existing
 * sign-in is not lost.
 */
export const higgsfieldSignIn = new OAuthSignIn({
  label: "Higgsfield",
  ledgerProvider: "higgsfield",
  resource: HIGGSFIELD_MCP_URL,
  protectedResourceUrl: HIGGSFIELD_RESOURCE_METADATA,
  scopes: MCP_SCOPES,
  redirectPath: CALLBACK_PATH,
  settingsPrefix: "higgsfield_mcp",
  clientName: "Level Studio",
  returnParam: "higgsfield",
  signInHint: "Connection → Higgsfield",
  notSignedIn: NOT_SIGNED_IN,
  onReset: dropTokenCaches,
});
export type { AuthServer, StoredClient, StoredTokens } from "./oauth-signin";
export { pkcePair } from "./oauth-signin";
export const storedTokens = (env: Env) => higgsfieldSignIn.storedTokens(env);

/* ───────────── The MCP session: tools by name, one refresh on 401 ───────────── */

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  oneOf?: unknown[];
  anyOf?: unknown[];
}

export interface ToolShape {
  /** The argument names (the inner ones when nested under `params`). */
  names: string[];
  /** The names the schema requires, across every branch. */
  required: string[];
  /** The arguments go under `params`. */
  wrapped: boolean;
  /** Other top-level fields the tool takes beside `params` (`action`, `context`). */
  top: string[];
}

export class HiggsfieldMcp {
  private client: McpClient | null = null;
  private refreshed = false;
  constructor(
    private readonly env: Env,
    private readonly fetchFn: typeof fetch = fetcher(),
  ) {}

  /** Signed in, or a 409 saying so; no call to the MCP server yet. */
  async connect(force = false): Promise<void> {
    const token = await higgsfieldSignIn.accessToken(this.env, force);
    this.client = new McpClient(token, this.fetchFn, HIGGSFIELD_MCP_URL, { label: "Higgsfield MCP", unauthorizedHint: "the sign-in may have expired; sign in again under Connection → Higgsfield." });
  }

  private async withAuth<T>(fn: (c: McpClient) => Promise<T>): Promise<T> {
    if (!this.client) await this.connect();
    try {
      return await fn(this.client!);
    } catch (e) {
      // One token refresh, then the same call once more. This is not a job retry: nothing was submitted.
      if (e instanceof StudioError && e.status === 401 && e.data?.httpStatus === 401 && !this.refreshed) {
        this.refreshed = true;
        await this.connect(true);
        return fn(this.client!);
      }
      throw e;
    }
  }

  /** The tools the live server lists (names, descriptions and input schemas), cached ten minutes. */
  async tools(fresh = false): Promise<McpTool[]> {
    if (!fresh && toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.tools;
    const tools = await this.withAuth((c) => c.listTools());
    toolsCache = { at: Date.now(), tools };
    return tools;
  }

  /** The tool names the live server lists, cached ten minutes. */
  async toolNames(fresh = false): Promise<string[]> {
    return (await this.tools(fresh)).map((t) => t.name);
  }

  /** The property names a tool's input schema declares (empty when the server lists no schema). */
  async toolParams(name: string): Promise<string[]> {
    const t = (await this.tools()).find((x) => x.name === name);
    const props = (t?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    return props && typeof props === "object" ? Object.keys(props) : [];
  }

  /**
   * The shape of a tool's arguments: the parameter names and whether they sit under a `params`
   * block (the live catalog nests most tools that way: `upscale_image` takes `{params: {image_id,
   * width, height, get_cost}}`, `remove_background` `{params: {media_id, media_type}}`,
   * `upscale_video` `{params: {provider, video_id, …}}` with two `oneOf` branches). `names` are the
   * inner names when nested, `required` the names the schema requires (every branch's), `top` the
   * other top-level fields (`action`, `context`) when there are any.
   */
  async toolShape(name: string): Promise<ToolShape> {
    const t = (await this.tools()).find((x) => x.name === name);
    const schema = (t?.inputSchema ?? {}) as JsonSchema;
    const props = schema.properties ?? {};
    const params = props.params as JsonSchema | undefined;
    const others = Object.keys(props).filter((k) => k !== "params");
    if (params && typeof params === "object" && others.every((k) => ["context", "action"].includes(k))) {
      const branches = [params, ...(params.oneOf ?? []), ...(params.anyOf ?? [])].filter((b): b is JsonSchema => !!b && typeof b === "object");
      const names = new Set<string>();
      const required = new Set<string>();
      for (const b of branches) {
        for (const k of Object.keys(b.properties ?? {})) names.add(k);
        for (const k of b.required ?? []) required.add(k);
      }
      return { names: [...names], required: [...required], wrapped: true, top: others };
    }
    return { names: Object.keys(props), required: schema.required ?? [], wrapped: false, top: [] };
  }

  async hasTool(name: string): Promise<boolean> {
    return (await this.toolNames()).includes(name);
  }

  async requireTool(name: string): Promise<void> {
    const names = await this.toolNames();
    if (!names.includes(name)) throw new StudioError(`Higgsfield MCP lists no tool named "${name}" (it lists ${names.length}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}). The studio was written for the tool names in docs/higgsfield-mcp.md; nothing was run.`, 502, false, { missingTool: name });
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.requireTool(name);
    return this.withAuth((c) => c.callTool(name, args));
  }
}

/* ───────────── Reading the answers ───────────── */

export interface Balance {
  credits: number | null;
  plan: string | null;
  text: string;
}

export function parseBalance(r: McpCallResult): Balance {
  const j = jsonOf(r);
  const text = resultText(r);
  let credits = findNumber(j, ["credits", "balance", "credits_remaining", "remaining_credits", "available_credits", "available", "total_credits", "amount"]);
  if (credits === null) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*credits?/i.exec(text);
    credits = m ? Number(m[1].replace(/,/g, "")) : null;
  }
  const plan = findString(j, ["plan", "plan_name", "subscription", "tier", "subscription_plan"]) ?? (/plan[:\s]+([A-Za-z][\w+ -]{1,30})/i.exec(text)?.[1]?.trim() ?? null);
  return { credits, plan, text };
}

/** The credits a `get_cost` answer names, or null; a numeric string counts. */
export function parseCost(r: McpCallResult): number | null {
  const j = jsonOf(r);
  const n = findNumber(j, ["cost", "credits", "cost_credits", "credits_cost", "total_cost", "estimated_cost", "estimate", "price", "total"]);
  if (n !== null) return n;
  const m = /(\d+(?:\.\d+)?)\s*credits?/i.exec(resultText(r));
  return m ? Number(m[1]) : null;
}

/** The `unlim_choice` question in an answer (the server asks instead of submitting), as it came; null when none. */
export function unlimChoiceIn(r: McpCallResult): unknown {
  const j = jsonOf(r);
  const direct = findValue(j, ["unlim_choice"], (v): v is unknown => v !== null && v !== undefined && v !== false);
  if (direct !== null) return direct;
  const o = j as Record<string, unknown> | null;
  if (o && typeof o === "object" && !Array.isArray(o) && (o.type === "unlim_choice" || o.question === "unlim_choice" || o.choice === "unlim")) return o;
  const text = resultText(r);
  return /unlim_choice/i.test(text) ? { text: text.slice(0, 500) } : null;
}

/** A media id out of `media_import_url` / `media_confirm`. */
export function parseMediaId(r: McpCallResult): string | null {
  const j = jsonOf(r);
  const id = findString(j, ["media_id", "mediaId"]) ?? findString((j as Record<string, unknown> | null)?.media ?? null, ["id"]) ?? findString(j, ["id"]);
  if (id) return id;
  const m = /media[_ ]id\W+([A-Za-z0-9_-]{6,})/i.exec(resultText(r));
  return m ? m[1] : null;
}

export interface JobEntry {
  index: number | null;
  jobId: string;
  status: string;
  url: string | null;
  error: string | null;
}

const DONE = /^(completed|complete|succeeded|success|successful|done|finished|ready)$/i;
const FAILED = /^(failed|failure|error|errored|cancelled|canceled|nsfw|rejected|moderated|timeout|timed_out)$/i;

/** The jobs an answer (`generate_video_batch`, `jobs_wait`, `show_generation_by_ids`) names, with what each says. */
export function parseJobs(r: McpCallResult): JobEntry[] {
  const j = jsonOf(r);
  const out: JobEntry[] = [];
  for (const o of objectsWith(j, "job_id")) {
    const jobId = String(o.job_id);
    const index = typeof o.index === "number" ? o.index : null;
    const status = String(findString(o, ["status", "state"]) ?? "").toLowerCase();
    const url = firstUrl(findValue(o, ["result", "results", "output", "outputs", "video", "media", "url", "video_url", "result_url", "download_url"], (v): v is unknown => v !== null && v !== undefined) ?? null, "");
    const error = findString(o, ["error", "error_message", "failure_reason", "reason", "message"]);
    if (!out.some((x) => x.jobId === jobId)) out.push({ index, jobId, status, url, error });
  }
  return out;
}

/** True when `jobs_wait` says every job is terminal (or no job is still running). */
export function allTerminal(r: McpCallResult, jobs: JobEntry[]): boolean {
  const j = jsonOf(r) as Record<string, unknown> | null;
  if (j && typeof j === "object" && typeof j.all_terminal === "boolean") return j.all_terminal;
  return jobs.every((x) => DONE.test(x.status) || FAILED.test(x.status));
}

/* ───────────── The engine catalog ───────────── */

export interface McpVideoModel {
  id: string;
  name: string;
  description: string;
  durations: number[];
  aspects: string[];
  supportsUnlim: boolean;
}

const numbersOf = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "number" ? x : typeof x === "string" ? Number(x.replace(/s$/i, "")) : typeof x === "object" && x ? Number((x as Record<string, unknown>).value ?? (x as Record<string, unknown>).seconds) : NaN)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as Record<string, unknown>).value ?? (x as Record<string, unknown>).id ?? "") : "")).filter(Boolean) : []);

/** The image-to-video engines a `models_explore` answer lists; the shape is read defensively. */
export function parseModels(r: McpCallResult): McpVideoModel[] {
  const j = jsonOf(r);
  const out: McpVideoModel[] = [];
  const seen = new Set<string>();
  const candidates = [...objectsWith(j, "model_id"), ...objectsWith(j, "id"), ...objectsWith(j, "model")];
  for (const o of candidates) {
    const id = [o.model_id, o.id, o.model].find((v) => typeof v === "string" && /^[a-z0-9][a-z0-9_.-]{1,60}$/i.test(v)) as string | undefined;
    if (!id || seen.has(id)) continue;
    const type = String(o.type ?? o.kind ?? o.category ?? "").toLowerCase();
    if (type && !/video/.test(type)) continue;
    const name = [o.name, o.title, o.display_name, o.label].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const params = (o.parameters ?? o.params ?? o.options ?? {}) as Record<string, unknown>;
    const durations = numbersOf(o.durations ?? o.duration_options ?? o.durations_supported ?? params.duration ?? (params.durations as unknown) ?? (o.duration as unknown));
    const aspects = stringsOf(o.aspect_ratios ?? o.aspects ?? params.aspect_ratio ?? (params.aspect_ratios as unknown));
    const describable = name || durations.length || aspects.length || typeof o.description === "string" || type;
    if (!describable) continue;
    seen.add(id);
    out.push({
      id,
      name: (name ?? id).slice(0, 80),
      description: typeof o.description === "string" ? o.description.slice(0, 300) : "",
      durations,
      aspects,
      supportsUnlim: o.supports_unlim === true || o.unlim === true || o.supports_unlimited === true,
    });
  }
  return out;
}

/** Entries of the catalog that are tools on an existing video, not engines that make one from a picture. */
const NOT_AN_ENGINE = /upscal|deflick|dubbing|voice|lip\s*sync|lipsync|reframe|remov|multiplier|recreate|\bedit\b|draw|preset|topaz|hyperion|motion\s*control|replace|extend|interpolat|background|analysis|caption|subtitle|translate/i;
/** The engines the studio shows first, in this order; the rest follow by name. */
const FAVOURITE_ENGINES = [/^seedance_2_5/i, /^kling3_0$/i, /^kling3_0_turbo/i, /^kling3_0_pro/i, /^minimax_h3$/i, /^marketing_studio_video/i, /^seedance_2_0$/i, /^kling2_6/i, /^wan_?2_6/i, /^hailuo/i];
function engineRank(m: McpVideoModel): number {
  const i = FAVOURITE_ENGINES.findIndex((re) => re.test(m.id));
  return i === -1 ? FAVOURITE_ENGINES.length : i;
}
/** Only engines that turn a picture into a clip, favourites first. */
export function engineList(models: McpVideoModel[]): McpVideoModel[] {
  return models
    .filter((m) => !NOT_AN_ENGINE.test(m.id) && !NOT_AN_ENGINE.test(m.name))
    .sort((a, b) => engineRank(a) - engineRank(b) || a.name.localeCompare(b.name));
}

/** The catalog: the stored copy for a day, else `models_explore` (type video, image input); `refresh` asks again. */
export async function mcpModels(env: Env, mcp: HiggsfieldMcp, refresh = false): Promise<{ models: McpVideoModel[]; at: number }> {
  if (!refresh && modelsMemo && Date.now() - modelsMemo.at < MODELS_TTL_MS) return modelsMemo;
  if (!refresh) {
    const stored = await readJsonSetting<{ at: number; models: McpVideoModel[] }>(env, HIGGSFIELD_MCP_MODELS_SETTING);
    if (stored && Array.isArray(stored.models) && Date.now() - stored.at < MODELS_TTL_MS) {
      modelsMemo = stored;
      return stored;
    }
  }
  const r = await mcp.call("models_explore", { action: "list", type: "video", input: "image", limit: 60 });
  const models = parseModels(r);
  if (!models.length) throw new StudioError(`Higgsfield listed no image-to-video engine the studio could read. Answer: ${resultText(r).slice(0, 200)}`, 502);
  modelsMemo = { at: Date.now(), models };
  await setSetting(env, HIGGSFIELD_MCP_MODELS_SETTING, JSON.stringify(modelsMemo));
  return modelsMemo;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The subscription engine for a name or id the Prompt Box gives (a Cloud API slug such as
 * `bytedance/seedance-2.5/image-to-video`, a catalog name such as "Seedance 2.5", or an MCP id).
 */
export function matchMcpModel(models: McpVideoModel[], wanted: string): McpVideoModel | null {
  const w = squash(wanted);
  const exact = models.find((m) => m.id === wanted || squash(m.id) === w || squash(m.name) === w);
  if (exact) return exact;
  const tail = squash(wanted.replace(/\/(image|text)-to-video.*$/i, "").split("/").pop() ?? "");
  return models.find((m) => tail && (squash(m.id) === tail || squash(m.name) === tail || squash(m.name).includes(tail) || squash(m.id).includes(tail))) ?? models.find((m) => w.includes(squash(m.name)) || w.includes(squash(m.id))) ?? null;
}

/* ───────────── Balance and media ───────────── */

export async function balanceOf(mcp: HiggsfieldMcp, fresh = false): Promise<Balance> {
  if (!fresh && balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return { ...balanceCache, text: "" };
  const b = parseBalance(await mcp.call("balance", {}));
  balanceCache = { at: Date.now(), credits: b.credits, plan: b.plan };
  return b;
}

/** A stored object (the post's picture or artwork, or one of its clips) as a Higgsfield media id, imported through a short-lived signed link, once an hour per key. */
export async function mediaFor(env: Env, mcp: HiggsfieldMcp, key: string, type: "image" | "video" = "image"): Promise<string> {
  const cacheKey = `${type}:${key}`;
  const hit = mediaCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.id;
  const url = await signObjectUrl(env, key, 2 * 60 * 60 * 1000);
  const r = await mcp.call("media_import_url", { url, type });
  const id = r.isError ? null : parseMediaId(r);
  if (!id) throw new StudioError(`Higgsfield could not import the ${type === "video" ? "clip" : "picture"}: ${resultText(r).slice(0, 200) || "no media id in the answer"}.`, 502);
  mediaCache.set(cacheKey, { id, at: Date.now() });
  return id;
}

/* ───────────── Estimate and generate ───────────── */

const askSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(200),
  model: z.string().min(1).max(80),
  prompt: z.string().trim().max(5000).default(""),
  duration: z.number().int().min(1).max(60).optional(),
  aspect: z.string().max(10).optional(),
  source: z.enum(["picture", "artwork"]).default("picture"),
  /** The composed post (words and logo drawn by the browser, or the picture fitted to the frame) as a data URL, when source is "artwork". */
  artwork: z.string().max(17 * 1024 * 1024).optional(),
  useUnlim: z.boolean().optional(),
  ...frameFields,
});
const generateSchema = askSchema.extend({ confirm: z.boolean().optional(), note: z.string().trim().max(200).optional() });
export type McpAsk = z.infer<typeof askSchema>;
export type McpGenerateInput = z.infer<typeof generateSchema>;

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** The still the clip starts from: the task's picture, or the artwork stored under a key made from its bytes (so an estimate and its run share one import). */
export async function posterFor(env: Env, b: { id: string; owner: string }, t: { id: string; output: string }, d: Pick<McpAsk, "source" | "artwork">): Promise<string> {
  if (d.source !== "artwork") return t.output;
  if (!d.artwork) throw new StudioError("Send the artwork (the post with its words and logo) to make the clip from it.");
  const art = dataUrlBytes(d.artwork);
  const key = `${b.owner}/${b.id}/video/${t.id}/${(await sha256(d.artwork)).slice(0, 24)}.artwork.${art.mime === "image/png" ? "png" : art.mime === "image/webp" ? "webp" : "jpg"}`;
  if (!(await env.BUCKET.head(key))) await env.BUCKET.put(key, art.bytes, { httpMetadata: { contentType: art.mime } });
  return key;
}

/** The engine's catalog entry, with the asked settings checked against what it offers. */
async function engineFor(env: Env, mcp: HiggsfieldMcp, d: McpAsk): Promise<{ engine: McpVideoModel; duration: number | undefined; aspect: string | undefined }> {
  const { models } = await mcpModels(env, mcp);
  const engine = models.find((m) => m.id === d.model) ?? matchMcpModel(models, d.model);
  if (!engine) throw new StudioError(`"${d.model}" is not on the Higgsfield subscription catalog. Pick an engine from the list (refresh it under the Video dialog if it looks stale).`, 400, false, { unknownEngine: d.model });
  const duration = d.duration;
  if (duration !== undefined && engine.durations.length && !engine.durations.includes(duration)) throw new StudioError(`${engine.name} makes clips of ${engine.durations.join(", ")} seconds.`);
  const aspect = d.aspect || undefined;
  if (aspect && engine.aspects.length && !engine.aspects.includes(aspect)) throw new StudioError(`${engine.name} offers these frames: ${engine.aspects.join(", ")}.`);
  return { engine, duration, aspect };
}

function videoParams(engine: McpVideoModel, d: McpAsk, mediaId: string, duration: number | undefined, aspect: string | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = { model: engine.id, medias: [{ value: mediaId, role: "image" }], count: 1 };
  if (d.prompt.trim()) params.prompt = d.prompt.trim();
  if (duration !== undefined) params.duration = duration;
  if (aspect) params.aspect_ratio = aspect;
  if (d.useUnlim !== undefined) params.use_unlim = d.useUnlim;
  return params;
}

export interface McpEstimate {
  credits: number | null;
  balance: number | null;
  plan: string | null;
  unlimChoice: unknown;
  engine: McpVideoModel;
  mediaId: string;
  params: Record<string, unknown>;
  text: string;
}

/** The cost in credits of exactly this clip (`get_cost: true` submits nothing), with the balance. */
export async function estimateMcpVideo(env: Env, user: User, d: McpAsk, record = true): Promise<McpEstimate> {
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const mcp = new HiggsfieldMcp(env, fetcher());
  await mcp.connect();
  const { engine, duration, aspect } = await engineFor(env, mcp, d);
  const posterKey = await posterFor(env, b, { id: t.id, output: t.output }, d);
  const mediaId = await mediaFor(env, mcp, posterKey);
  const params = videoParams(engine, d, mediaId, duration, aspect);
  const r = await mcp.call("generate_video", { params: { ...params, get_cost: true } });
  const unlimChoice = unlimChoiceIn(r);
  const credits = r.isError ? null : parseCost(r);
  const bal = await balanceOf(mcp, !record).catch(() => ({ credits: null, plan: null, text: "" }));
  if (record)
    await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "mcp.estimate",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: credits,
    reported: 0,
    status: credits === null && !unlimChoice ? "refused" : "done",
    note: `${credits ?? "?"} credits · ${engine.name} · ${duration ?? "default"}s · ${d.source}${unlimChoice ? " · unlimited-allowance question" : ""}${credits === null ? ` · answer: ${resultText(r).slice(0, 200)}` : ""}`,
  });
  return { credits, balance: bal.credits, plan: bal.plan, unlimChoice, engine, mediaId, params, text: resultText(r) };
}

const isTimeout = (e: unknown) => e instanceof Error && (/TimeoutError|AbortError/.test(e.name) || /timed? ?out/i.test(e.message));

/**
 * One clip on the subscription credits: the estimate is asked with `get_cost` (an unlimited-
 * allowance question goes back to the admin), the person confirms the credits shown, the same ask
 * within ten minutes is refused, the op is recorded, the job goes out as a one-item batch. Nothing
 * retries by itself: a timeout keeps the row and the claim and says the outcome is unknown.
 */
export async function submitMcpVideo(env: Env, user: User, d: McpGenerateInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  if ((await higgsfieldBilling(env)) !== "credits") throw new StudioError(CLOUD_CHOSEN, 409, false, { billing: "cloud" });
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  // The estimate is asked again with the same body the job gets (the balance fresh, for the reported cost); the run's own row is the `video` op below.
  const est = await estimateMcpVideo(env, user, d, false);
  const { engine, params } = est;
  if (est.unlimChoice && d.useUnlim === undefined) throw new StudioError(`Higgsfield asks whether this ${engine.name} clip should use the unlimited allowance or pay credits${est.credits !== null ? ` (${est.credits})` : ""}. Choose, then run again.`, 409, false, { unlimChoice: est.unlimChoice, credits: est.credits });
  if (est.credits === null && !d.confirm) throw new StudioError(`The cost of a ${engine.name} clip is not known: Higgsfield gave no figure. Confirm it at an unknown cost, or pick another engine.`, 409, false, { needsEstimate: true, model: engine.id });
  if (!d.confirm) throw new StudioError(`Confirm the clip: about ${est.credits} credits from the subscription balance${est.balance !== null ? ` (${est.balance} available)` : ""}.`, 409, false, { needsConfirm: true, credits: est.credits, balance: est.balance });
  const posterKey = await posterFor(env, b, { id: t.id, output: t.output }, d);
  const duration = typeof params.duration === "number" ? params.duration : undefined;
  const aspect = typeof params.aspect_ratio === "string" ? params.aspect_ratio : undefined;
  const mcp = new HiggsfieldMcp(env, fetcher());
  // The submission tool must exist before anything is claimed or recorded: a missing name is a clear refusal, not a failed version.
  await mcp.requireTool("generate_video_batch");
  const fingerprint = await sha256([MCP_PROVIDER, engine.id, d.prompt.trim(), duration ?? "", aspect ?? "", d.source, posterKey, String(d.useUnlim ?? "")].join("\n"));
  if (!(await claimSubmission(env, `video:${b.id}:${d.index}:${fingerprint}`, CLAIM_TTL_MS))) throw new StudioError("This exact clip was asked for a moment ago. Wait for it, or change the idea or the settings.", 409);
  const before = est.balance;
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "video",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: est.credits,
    status: "confirmed",
    note: `${engine.name} · ${duration ?? "default"}s · ${d.source}${d.frame ? ` · frame ${d.frame}${d.fill ? ` (${d.fill})` : ""}` : ""} · ${est.credits ?? "unknown"} credits (subscription, MCP)${d.useUnlim ? " · unlimited allowance" : ""}${before !== null ? ` · balance before ${before}` : ""}${d.note ? ` · ${d.note}` : ""}`,
  });
  const id = uuid();
  const stored = { duration, aspect, ...frameSettings(d), estimate: est.credits, credits: est.credits, estimateSource: est.credits === null ? "confirmed" : "provider", unit: "credits", mcpModel: engine.id, engineName: engine.name, useUnlim: d.useUnlim ?? null, balanceBefore: before, plan: est.plan, note: d.note, outcomeUnknown: false };
  const ts = now();
  const insert = (status: VideoStatus, requestId: string | null, error: string | null, extra: Record<string, unknown> = {}) =>
    run(
      env.DB,
      "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      id,
      b.id,
      d.index,
      t.id,
      user.id,
      engine.id,
      d.prompt.trim(),
      status,
      requestId,
      error,
      ts,
      ts,
      MCP_PROVIDER,
      JSON.stringify({ ...stored, ...extra }),
      posterKey,
      d.source,
      opId,
    );
  let r: McpCallResult;
  try {
    r = await mcp.call("generate_video_batch", { requests: [{ index: 0, params }] });
  } catch (e) {
    if (isTimeout(e)) {
      const note = "Higgsfield did not answer in time: the clip may still have started, so nothing was sent again. The version stays queued and is given up after half an hour if no job id can be learned; check the balance and the Higgsfield history.";
      await insert("queued", null, null, { outcomeUnknown: true });
      await updateIntegrationOp(env, opId, { status: "running", note: `outcome unknown (timeout) · ${note}` });
      throw new StudioError(note, 504, false, { outcomeUnknown: true, videoId: id });
    }
    const message = errorMessage(e).slice(0, 400);
    await insert("failed", null, message);
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  const unlim = unlimChoiceIn(r);
  if (unlim && d.useUnlim === undefined) {
    await updateIntegrationOp(env, opId, { status: "proposed", note: "waiting for the unlimited-allowance choice; nothing submitted" });
    throw new StudioError(`Higgsfield asks whether this ${engine.name} clip should use the unlimited allowance or pay credits. Choose, then run again.`, 409, false, { unlimChoice: unlim, credits: est.credits });
  }
  const job = parseJobs(r).find((x) => x.index === 0 || x.index === null);
  if (r.isError || !job) {
    const message = `Higgsfield did not start the clip: ${resultText(r).slice(0, 300) || "no job id in the answer"}`;
    await insert("failed", null, message);
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insert("queued", job.jobId, null);
  await updateIntegrationOp(env, opId, { taskId: job.jobId, status: "running" });
  const rows = await postRows(env, b.id, d.index);
  const row = rows.find((v) => v.id === id)!;
  return videoItem(row, versionNumbers(rows).get(id) ?? rows.length);
}

/* ───────────── Polling, from settlePending ───────────── */

/**
 * The in-flight subscription clips asked about with one `jobs_wait` (a short wait), six at most:
 * a finished one is fetched into R2 and marked done with the credits the balance moved by, a
 * failed one keeps the message, one with no job id (a timed-out submission) or older than half an
 * hour is given up. Nothing is submitted again here.
 */
export async function settleMcpPending(env: Env, b: { id: string; owner: string }, rows: VideoRow[]): Promise<void> {
  const pending = rows.filter((v) => (v.status === "queued" || v.status === "generating") && v.provider === MCP_PROVIDER).slice(0, POLL_LIMIT);
  if (!pending.length) return;
  const fail = async (v: VideoRow, message: string) => {
    await run(env.DB, "UPDATE videos SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 400), now(), v.id);
    v.status = "failed";
    v.error = message;
    if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "failed", note: message });
  };
  const old = (v: VideoRow) => now() - v.created > GIVE_UP_MS;
  const withJob: VideoRow[] = [];
  for (const v of pending) {
    if (v.request_id) withJob.push(v);
    else if (old(v)) await fail(v, "The submission's outcome was never learned (Higgsfield did not answer in time) and nothing was sent again. Check the Higgsfield history and balance.");
  }
  if (!withJob.length) return;
  const mcp = new HiggsfieldMcp(env, fetcher());
  try {
    await mcp.connect();
  } catch {
    for (const v of withJob) if (old(v)) await fail(v, "Higgsfield is not signed in; the clip could not be collected in half an hour.");
    return;
  }
  let answer: McpCallResult;
  try {
    answer = await mcp.call("jobs_wait", { jobs: withJob.map((v, i) => ({ index: i, job_id: v.request_id })), timeout_seconds: 1 });
  } catch (e) {
    console.error("[higgsfield-mcp] jobs_wait", errorMessage(e));
    for (const v of withJob) if (old(v)) await fail(v, "The engine could not be asked for half an hour.");
    return;
  }
  const jobs = parseJobs(answer);
  for (const [i, v] of withJob.entries()) {
    const job = jobs.find((x) => x.jobId === v.request_id) ?? jobs.find((x) => x.index === i);
    try {
      if (!job) {
        if (old(v)) await fail(v, "Higgsfield no longer lists this job.");
        continue;
      }
      if (DONE.test(job.status)) {
        let url = job.url;
        if (!url && (await mcp.hasTool("show_generation_by_ids"))) {
          const shown = await mcp.call("show_generation_by_ids", { jobs: [{ index: 0, job_id: v.request_id }] });
          url = parseJobs(shown).find((x) => x.jobId === v.request_id)?.url ?? firstUrl(jsonOf(shown), resultText(shown));
        }
        if (!url) {
          await fail(v, "The clip finished without a video link.");
          continue;
        }
        await storeFinishedClip(env, b, v, url, fetcher());
        const s = parseSettings(v) as ReturnType<typeof parseSettings> & { balanceBefore?: number | null };
        const after = await balanceOf(mcp, true).catch(() => ({ credits: null as number | null }));
        const reported = typeof s.balanceBefore === "number" && after.credits !== null && after.credits <= s.balanceBefore ? s.balanceBefore - after.credits : (s.estimate ?? null);
        if (v.op_id) await updateIntegrationOp(env, v.op_id, { status: "done", reported, note: `${reported ?? "?"} credits reported${typeof s.balanceBefore === "number" && after.credits !== null ? ` (balance ${s.balanceBefore} → ${after.credits})` : " (from the estimate; the balance could not be read)"}` });
      } else if (FAILED.test(job.status)) {
        await fail(v, job.error ? `Generation failed on Higgsfield: ${job.error}` : "Generation failed on Higgsfield.");
      } else if (old(v)) {
        await fail(v, "The engine did not finish in half an hour.");
      } else if (v.status === "queued" && /^(running|processing|in_progress|generating|started)$/.test(job.status)) {
        await run(env.DB, "UPDATE videos SET status = 'generating', updated = ? WHERE id = ?", now(), v.id);
        v.status = "generating";
      }
    } catch (e) {
      console.error("[higgsfield-mcp] settle", v.id, errorMessage(e));
    }
  }
}

registerPendingSettler(MCP_PROVIDER, settleMcpPending);

/* ───────────── Routes: /api/studio/higgsfield/mcp ───────────── */

type Variables = { user: User };
export const higgsfieldMcpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  return u;
}

/** Signed in?, the account, the plan and credits (cached a minute), the billing choice, the switch. Every member. */
higgsfieldMcpRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const signin = await higgsfieldSignIn.status(c.env, user);
  const access = await integrationAccess(c.env, user, "higgsfield");
  const billingSet = await getSetting(c.env, HIGGSFIELD_BILLING_SETTING);
  let credits: number | null = null;
  let plan: string | null = null;
  let balanceError = "";
  if (signin.signedIn && access.enabled) {
    try {
      const mcp = new HiggsfieldMcp(c.env, fetcher());
      const bal = await balanceOf(mcp, c.req.query("fresh") === "1");
      credits = bal.credits;
      plan = bal.plan;
    } catch (e) {
      balanceError = errorMessage(e);
    }
  }
  return c.json({
    signedIn: signin.signedIn,
    expired: signin.expired,
    email: signin.email,
    signedInAt: signin.signedInAt,
    expiresAt: signin.expiresAt,
    refresh: signin.refresh,
    plan,
    credits,
    creditsAt: balanceCache?.at ?? null,
    balanceError,
    billing: await higgsfieldBilling(c.env),
    billingChosen: billingSet === "credits" || billingSet === "cloud",
    cloudConfigured: (await resolveEngineKey(c.env)).key !== null,
    admin: user.role === "admin",
    switch: { enabled: access.enabled },
    access,
    url: HIGGSFIELD_MCP_URL,
    device: signin.device,
  });
});

/** The billing choice: the subscription credits (sign-in) or the Cloud API key. Admins. */
higgsfieldMcpRoutes.post("/billing", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  const d = await parseBody(c, z.object({ billing: z.enum(["credits", "cloud"]) }));
  await setSetting(c.env, HIGGSFIELD_BILLING_SETTING, d.billing);
  await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "mcp.billing", user: user.id, estimate: 0, reported: 0, status: "done", note: d.billing === "credits" ? "Videos billed to the subscription credits (Higgsfield sign-in)" : "Videos billed to the Cloud API key (pay per clip)" });
  return c.json({ ok: true, billing: d.billing });
});

/**
 * Starts the sign-in (server/oauth-signin.ts): the authorize link for a new tab, or, when the
 * redirect registration is refused, the device flow's user code with what was refused.
 */
higgsfieldMcpRoutes.post("/signin/start", async (c) => {
  const user = await gate(c);
  const body = (await c.req.json().catch(() => ({}))) as { fresh?: unknown };
  return c.json({ ok: true, ...(await higgsfieldSignIn.start(c.env, user, { fresh: body.fresh === true })) });
});

/** The device flow's poll: one token request per call; the page calls it every `interval` seconds. */
higgsfieldMcpRoutes.post("/signin/poll", async (c) => {
  const user = await gate(c);
  return c.json({ ok: true, ...(await higgsfieldSignIn.poll(c.env, user)) });
});

/** Where the browser lands after Higgsfield: the code is exchanged, the tokens kept, back to the studio. */
higgsfieldMcpRoutes.get("/callback", async (c) => {
  const result = await higgsfieldSignIn.callback(c.env, c.get("user"), c.req.query());
  return c.redirect(higgsfieldSignIn.returnPath(result), 302);
});

/** The tokens and the cached catalog are dropped (the registered client stays); a ledger row says who. Admins. */
higgsfieldMcpRoutes.post("/signout", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  await higgsfieldSignIn.signOut(c.env, user, [HIGGSFIELD_MCP_MODELS_SETTING]);
  return c.json({ ok: true });
});

/** The subscription's image-to-video engines, cached per sign-in; `?refresh=1` asks again. Admins. */
higgsfieldMcpRoutes.get("/models", async (c) => {
  await gate(c);
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  const { models, at } = await mcpModels(c.env, mcp, c.req.query("refresh") === "1");
  // The dialog gets the engines that make a clip from a picture, favourites first; `?all=1` lists the raw catalog.
  return c.json({ ok: true, models: c.req.query("all") === "1" ? models : engineList(models), at });
});

/** The cost in credits of exactly this clip (nothing is submitted), with the balance. Admins. */
higgsfieldMcpRoutes.post("/estimate", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, askSchema);
  const e = await estimateMcpVideo(c.env, user, d);
  return c.json({ ok: true, credits: e.credits, balance: e.balance, plan: e.plan, unlimChoice: e.unlimChoice ?? null, engine: e.engine, mediaId: e.mediaId });
});

/** The clip, with `confirm: true` for the credits shown and `useUnlim` when Higgsfield asked. Admins. */
higgsfieldMcpRoutes.post("/generate", async (c) => {
  const user = await gate(c);
  const d = await parseBody(c, generateSchema);
  return c.json({ ok: true, video: await submitMcpVideo(c.env, user, d) });
});
