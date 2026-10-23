/**
 * The Photo studio's AI tools: provider tools on a post's picture through the Higgsfield MCP
 * (`upscale_image`, `remove_background`, `outpaint_image`, `reframe`, `relight_image`,
 * `generate_image` with a Soul style) and the Magnific MCP (`images_*`), paid in credits. The same
 * governance as every integration (docs/integrations.md): admins only, the provider's switch
 * (`higgsfield`, or `freepik` for Magnific), one ledger row per run (`image.tool`, credits in the
 * estimate and said so in the note), the estimate before the confirm (`get_cost` where the tool
 * lists it, `simulate_cost` for Magnific), one claim per ask, no retry, an unknown cost blocked
 * (Higgsfield's may be confirmed anyway, as the Video studio does; Magnific's stay blocked, as the
 * Freepik rules say).
 *
 * A run is a `photo_tool_jobs` row: the post's picture goes to the provider (Higgsfield: a media
 * id through `media_import_url`; Magnific: a short-lived signed link where the tool takes one,
 * else a creation uploaded first), the job id or creation identifier is kept, and the settler the
 * panel polls (`GET /jobs`) asks `jobs_wait` / `creations_wait`, downloads the finished picture
 * under the post's output prefix and closes the ledger row with the credits the balance moved by.
 * "Use as the post's picture" then points the post at it (a take; the previous picture stays under
 * Versions), "Save as a product photo" copies it among the month's product photos.
 *
 * Routes (mounted at /api/studio/photo/tools):
 *   GET  /catalog?refresh=1         what each provider offers today (every member; live calls for admins only)
 *   POST /estimate                  {batch, index, tool, options}             admins
 *   POST /run                       {batch, index, tool, options, confirm?}   admins
 *   GET  /jobs?batch=&index=        the post's jobs, the pending ones settled first (every member of the month)
 *   GET  /jobs/:id/image?which=in|out
 *   POST /jobs/:id/use              {as: "picture" | "product", batch, post?, name?}   admins
 *   POST /jobs/:id/check            a job recorded as failed asked about again (a status read, free)   admins
 *
 * Every answer shape and argument name is assumed from the tool descriptions and read defensively;
 * the first live run must check them (docs/photo-studio.md, "What the first live run must check").
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { imageSize } from "./ocr";
import { setSetting } from "./settings";
import { readJsonSetting } from "./oauth-signin";
import { ownedPlan } from "./posts";
import { signObjectUrl } from "./signed";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, noRetry, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp, type IntegrationProvider } from "./integrations";
import { balanceOf, fetcher as higgsfieldFetcher, HiggsfieldMcp, higgsfieldSignIn, mediaFor, parseCost, parseJobs, unlimChoiceIn, type ToolShape } from "./higgsfield-mcp";
/** The Higgsfield picture tools and styles run on the same sign-in as the videos. */
const NOT_SIGNED_IN = "Not signed in: Connection → Higgsfield → Sign in to Higgsfield. The picture styles and tools run on that sign-in, paid from the subscription credits.";
import { creditsIn, MagnificMcp, magnificFetcher, MCP_NOT_CONNECTED, tokenSource } from "./freepik-mcp";
import { parseCreations, parseIdentifiers } from "./video-magnific";
import { findNumber, findString, firstUrl, jsonOf, objectsWith, resultText, type McpCallResult } from "./mcp-client";
import { askJobStatus, DONE, FAILED, jobObject, notCollected, resultLink, RUNNING } from "./provider-status";
import { PHOTO_TOOLS, photoTool, TOOL_PROVIDER_LABELS, type PhotoToolJob, type ProviderCatalog, type ToolCatalog, type ToolChoice, type ToolDef, type ToolOption, type ToolProvider } from "@shared/photo-tools";
import { postRevision } from "@shared/posts";
import { clientHold, heldMessage } from "@shared/client-hold";
import { freeName } from "@shared/drive";
import { stemKey } from "@shared/naming";
import type { Config } from "@shared/config";
import type { User } from "@shared/types";

type Variables = { user: User };
export const photoToolRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CLAIM_TTL_MS = 10 * 60 * 1000;
/** A job with no end after this long is given up (nothing is sent again). */
export const GIVE_UP_MS = 30 * 60 * 1000;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const LISTS_TTL_MS = 60 * 60 * 1000;
const TOOLS_TTL_MS = 10 * 60 * 1000;
const CREATION_TTL_MS = 60 * 60 * 1000;
const POLL_LIMIT = 6;
export const MAGNIFIC_LISTS_SETTING = "photo_tools_magnific_lists";

/** The integration switch and ledger provider a tool provider answers to (Magnific is the Freepik integration). */
export const ledgerProvider = (p: ToolProvider): IntegrationProvider => (p === "higgsfield" ? "higgsfield" : "freepik");

/* ───────────── Caches (tests start from nothing) ───────────── */

let catalogMemo: { at: number; catalog: ToolCatalog } | null = null;
let magnificToolsMemo: { at: number; tools: Map<string, string[]> } | null = null;
let magnificBalanceMemo: { at: number; credits: number | null } | null = null;
let listsMemo: { at: number; lists: MagnificLists } | null = null;
const creationMemo = new Map<string, { id: string; at: number }>();

export function resetPhotoToolCaches(): void {
  catalogMemo = null;
  magnificToolsMemo = null;
  magnificBalanceMemo = null;
  listsMemo = null;
  creationMemo.clear();
}

/* ───────────── Jobs ───────────── */

export interface PhotoJobRow {
  id: string;
  batch: string;
  post: number;
  task: string;
  owner: string;
  provider: ToolProvider;
  tool: string;
  label: string;
  options: string;
  input_key: string;
  output_key: string | null;
  status: "queued" | "running" | "done" | "failed";
  provider_job: string | null;
  estimate: number | null;
  reported: number | null;
  error: string | null;
  op_id: string | null;
  settings: string;
  created: number;
  updated: number;
}

interface JobSettings {
  balanceBefore?: number | null;
  mcpTool?: string;
  args?: Record<string, unknown>;
  notes?: string[];
  jobIds?: string[];
  outcomeUnknown?: boolean;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function jobJson(j: PhotoJobRow): PhotoToolJob {
  const base = `/api/studio/photo/tools/jobs/${j.id}/image`;
  return {
    id: j.id,
    batch: j.batch,
    post: j.post,
    provider: j.provider,
    tool: j.tool,
    label: j.label,
    options: parseJson<Record<string, string>>(j.options, {}),
    status: j.status,
    estimate: j.estimate,
    reported: j.reported,
    error: j.error,
    input: `${base}?which=in`,
    output: j.output_key ? `${base}?which=out&v=${j.updated}` : null,
    created: j.created,
    updated: j.updated,
  };
}

async function jobById(env: Env, id: string | undefined): Promise<PhotoJobRow> {
  if (!id) throw new StudioError("Job id is required.");
  const j = await first<PhotoJobRow>(env.DB, "SELECT * FROM photo_tool_jobs WHERE id = ?", id);
  if (!j) throw new StudioError("That AI tools job is gone.", 404);
  return j;
}

export async function postJobs(env: Env, batch: string, post: number): Promise<PhotoJobRow[]> {
  return all<PhotoJobRow>(env.DB, "SELECT * FROM photo_tool_jobs WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 30", batch, post);
}

/** Links in the stored arguments are short-lived signed URLs: the ledger keeps their place, not the link. */
function redactArgs(v: unknown): unknown {
  if (typeof v === "string") return /^https?:\/\//.test(v) ? "<link>" : v.slice(0, 500);
  if (Array.isArray(v)) return v.map(redactArgs);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactArgs(x)]));
  return v;
}

const extOf = (mime: string, url = "") => (/jpe?g/i.test(mime) ? "jpg" : /webp/i.test(mime) ? "webp" : /png/i.test(mime) ? "png" : /\.(jpe?g)(\?|$)/i.test(url) ? "jpg" : /\.webp(\?|$)/i.test(url) ? "webp" : "png");

async function failJob(env: Env, row: PhotoJobRow, message: string): Promise<void> {
  await run(env.DB, "UPDATE photo_tool_jobs SET status = 'failed', error = ?, updated = ? WHERE id = ?", message.slice(0, 500), now(), row.id);
  row.status = "failed";
  row.error = message;
  if (row.op_id) await updateIntegrationOp(env, row.op_id, { status: "failed", note: message.slice(0, 500) });
}

/** The kind of picture the bytes are, from their first bytes (PNG, JPEG, WebP), or null. */
export function sniffPicture(bytes: ArrayBuffer): "png" | "jpg" | "webp" | null {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

const PICTURE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

/**
 * The finished picture downloaded under the post's output prefix, always at the same key for a job
 * (`<owner>/<batch>/output/<task>/<job>.<ext>`), so a second download replaces the first instead of
 * adding one. A storage answer labelled `application/octet-stream` is taken when its bytes are a picture.
 */
async function storeResult(env: Env, b: { id: string; owner: string }, row: PhotoJobRow, url: string, fetchFn: typeof fetch): Promise<string> {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new StudioError(`The result could not be downloaded (${r.status}).`, 502);
  const declared = (r.headers.get("content-type") || "").split(";")[0].trim();
  const bytes = await r.arrayBuffer();
  if (!bytes.byteLength) throw new StudioError("The result was empty.", 502);
  const sniffed = sniffPicture(bytes);
  if (declared && !declared.startsWith("image/") && !sniffed) throw new StudioError(`The result is not a picture (${declared}).`, 502);
  const mime = declared.startsWith("image/") ? declared : sniffed ? PICTURE_TYPES[sniffed] : declared;
  const ext = extOf(mime, url);
  const contentType = mime || (ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png");
  const key = `${b.owner}/${b.id}/output/${row.task}/${row.id}.${ext}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return key;
}

/** The finished picture stored; the ledger row closed with the credits the balance moved by (its note keeps the tool's label first, which `lastReportedRun` reads). */
async function finishJob(env: Env, b: { id: string; owner: string }, row: PhotoJobRow, url: string, fetchFn: typeof fetch, balanceAfter: () => Promise<number | null>): Promise<void> {
  const key = await storeResult(env, b, row, url, fetchFn);
  const s = parseJson<JobSettings>(row.settings, {});
  const after = await balanceAfter().catch(() => null);
  const reported = typeof s.balanceBefore === "number" && after !== null && after <= s.balanceBefore ? s.balanceBefore - after : row.estimate;
  await run(env.DB, "UPDATE photo_tool_jobs SET status = 'done', output_key = ?, reported = ?, error = NULL, updated = ? WHERE id = ?", key, reported, now(), row.id);
  row.status = "done";
  row.output_key = key;
  row.reported = reported;
  if (row.op_id) await updateIntegrationOp(env, row.op_id, { status: "done", reported, note: `${row.label} · ${reported ?? "?"} credits reported${typeof s.balanceBefore === "number" && after !== null ? ` (balance ${s.balanceBefore} → ${after})` : " (from the estimate; the balance could not be read)"}` });
}

/* ───────────── Mapping our options onto a tool's arguments (names assumed; the live schema decides) ───────────── */

const OPTION_PARAMS: Record<ToolOption["id"], RegExp[]> = {
  prompt: [/^(prompt|text|description|instruction|instructions)$/i, /prompt/i],
  aspect: [/^aspect_?ratio$/i, /aspect|ratio/i],
  styleId: [/^style_?id$/i, /style/i],
  preset: [/^preset(_?id)?$/i, /preset/i],
  mode: [/^mode$/i, /mode|engine/i],
  model: [/^model(_?id|_?slug)?$/i, /model/i],
  camera: [/^(camera|angle|camera_?angle|view|direction)$/i, /camera|angle|view/i],
  scale: [/^scale(_?factor)?$/i, /scale|factor/i],
};
/** The names the ask's shapes use when a tool wraps everything under `params` and the schema says nothing more. */
const ASSUMED_INNER: Record<ToolOption["id"], string> = { prompt: "prompt", aspect: "aspect_ratio", styleId: "style_id", preset: "preset", mode: "mode", model: "model", camera: "camera", scale: "scale" };

/** The argument name a tool's schema has for one of our options, or null when it lists none that fits. */
export function paramFor(params: string[], option: ToolOption["id"]): string | null {
  for (const re of OPTION_PARAMS[option]) {
    const hit = params.find((p) => re.test(p));
    if (hit) return hit;
  }
  return null;
}

export interface BuiltArgs {
  args: Record<string, unknown>;
  /** The call can be asked for its cost without running (`get_cost`). */
  costable: boolean;
  notes: string[];
}

/** A picture's size, for the tools that require it (`upscale_image`: "You MUST pass the source image's width and height"). */
export interface PictureSize {
  width: number;
  height: number;
}

/**
 * The arguments of a Higgsfield picture tool, from the live schema's shape (`HiggsfieldMcp.toolShape`):
 * the picture under the name the tool has (`image_id`, `media_id`, or `medias` for the generators),
 * `media_type: "image"` where the tool asks which kind the media is, the source size where the tool
 * requires it, the options under their names, and `get_cost` only where the tool lists it (or for
 * `generate_image`, whose description says so), so an estimate can never turn into a submission by
 * mistake. Everything goes under `params` when the schema nests it there.
 */
export function higgsfieldArgs(tool: ToolDef, shape: ToolShape, mediaId: string, options: Record<string, string>, getCost: boolean, size: PictureSize | null = null): BuiltArgs {
  const notes: string[] = [];
  const generator = tool.mcpTool === "generate_image";
  const names = shape.names;
  const inner: Record<string, unknown> = {};
  if (generator) {
    inner.model = "soul_2";
    inner.medias = [{ value: mediaId, role: "image" }];
    inner.count = 1;
  } else if (names.includes("image_id")) {
    inner.image_id = mediaId;
  } else if (!names.length || names.includes("media_id")) {
    inner.media_id = mediaId;
  } else if (names.includes("medias")) {
    inner.medias = [{ value: mediaId, role: "image" }];
  } else {
    const k = names.find((n) => /^(image|media|input|source|picture)(_?id)?$/i.test(n)) ?? names.find((n) => /media|image/i.test(n) && !/url/i.test(n)) ?? "media_id";
    inner[k] = mediaId;
    notes.push(`picture as ${k}`);
  }
  if (names.includes("media_type")) inner.media_type = "image";
  if (shape.required.includes("width") && shape.required.includes("height")) {
    if (size) {
      inner.width = size.width;
      inner.height = size.height;
    } else notes.push("the picture's size could not be read; the tool requires it");
  }
  for (const o of tool.options) {
    const v = options[o.id]?.trim();
    if (!v) continue;
    const k = names.length ? paramFor(names, o.id) : ASSUMED_INNER[o.id];
    if (k) inner[k] = v;
    else notes.push(`${o.label.toLowerCase()} not taken by ${tool.mcpTool}`);
  }
  const costable = generator || names.includes("get_cost");
  if (getCost && costable) inner.get_cost = true;
  const wrapped = generator || shape.wrapped;
  return { args: wrapped ? { params: inner } : inner, costable, notes };
}

/** The option arguments of a Magnific tool under the names its schema has. */
export function magnificOptionArgs(tool: ToolDef, params: string[], options: Record<string, string>): BuiltArgs {
  const notes: string[] = [];
  const args: Record<string, unknown> = {};
  for (const o of tool.options) {
    const v = options[o.id]?.trim();
    if (!v) continue;
    const k = paramFor(params, o.id);
    if (k) args[k] = v;
    else notes.push(`${o.label.toLowerCase()} not taken by ${tool.mcpTool}`);
  }
  return { args, costable: params.length > 0, notes };
}

/* ───────────── Magnific: the tool list, the option lists, the balance, the picture ───────────── */

/** The live tools by name with their argument names, cached ten minutes. */
export async function magnificTools(mcp: MagnificMcp, fresh = false): Promise<Map<string, string[]>> {
  if (!fresh && magnificToolsMemo && Date.now() - magnificToolsMemo.at < TOOLS_TTL_MS) return magnificToolsMemo.tools;
  const list = await mcp.listTools();
  const tools = new Map<string, string[]>();
  for (const t of list) tools.set(t.name, Object.keys(((t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>));
  magnificToolsMemo = { at: Date.now(), tools };
  return tools;
}

export interface MagnificEntry {
  id: string;
  label: string;
  description: string;
  image: string | null;
}

const VIDEO_URL_RE = /\.(mp4|webm|mov|m3u8)(\?|#|$)/i;

function imageIn(o: Record<string, unknown>): string | null {
  for (const k of ["sample", "sample_url", "sampleUrl", "preview", "preview_url", "previewUrl", "previewImageUrl", "preview_image_url", "previewImage", "thumbnail", "thumbnail_url", "thumbnailUrl", "image", "image_url", "imageUrl", "cover", "coverUrl", "example", "exampleUrl", "samples", "examples", "previews", "images"]) {
    const v = o[k];
    const candidates = Array.isArray(v) ? v : [v];
    for (const c of candidates) {
      const u = typeof c === "string" ? c : c && typeof c === "object" ? ((c as Record<string, unknown>).url ?? (c as Record<string, unknown>).src) : null;
      if (typeof u === "string" && /^https:\/\/\S+$/.test(u) && !VIDEO_URL_RE.test(u)) return u;
    }
  }
  return null;
}

/** Entries of a Magnific list answer (`images_models_list`, `images_upscale_presets_list`, `retouch_models_list`): an id or slug with a name, and a sample picture when the entry has one. */
export function parseMagnificEntries(r: McpCallResult): MagnificEntry[] {
  const j = jsonOf(r);
  const out: MagnificEntry[] = [];
  const seen = new Set<string>();
  const push = (id: string, label: string, description: string, image: string | null) => {
    const key = id.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ id: key.slice(0, 120), label: (label || key).trim().slice(0, 80), description: description.trim().slice(0, 300), image });
  };
  for (const o of [...objectsWith(j, "slug"), ...objectsWith(j, "id"), ...objectsWith(j, "name"), ...objectsWith(j, "preset"), ...objectsWith(j, "mode")]) {
    const id = [o.slug, o.id, o.preset, o.mode, o.name].find((v) => typeof v === "string" && v.trim() !== "" || (typeof v === "number" && Number.isFinite(v)));
    if (id === undefined) continue;
    if ("url" in o && !("name" in o || "title" in o)) continue;
    const label = [o.name, o.title, o.label, o.displayName, o.display_name].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    push(String(id), label ?? String(id), String(o.description ?? o.summary ?? ""), imageIn(o));
  }
  if (!out.length && Array.isArray(j)) for (const x of j) if (typeof x === "string" && x.trim()) push(x, x, "", null);
  if (!out.length) {
    for (const line of resultText(r).split(/\r?\n/)) {
      const m = /^\s*(?:[-*•]|\d+[.)])\s*`?([A-Za-z0-9][\w.:/-]{1,60})`?\s*(?:[—–:-]\s*(.+?))?\s*$/.exec(line);
      if (m) push(m[1], m[1].replace(/[_-]+/g, " "), m[2] ?? "", null);
    }
  }
  return out;
}

export interface MagnificLists {
  upscalePresets: ToolChoice[];
  upscaleModes: ToolChoice[];
  retouchModels: ToolChoice[];
}

const choices = (entries: MagnificEntry[]): ToolChoice[] => entries.map((e) => ({ id: e.id, label: e.label }));

/** The option lists the Magnific tools take, kept an hour in an encrypted setting; `refresh` asks again. */
export async function magnificLists(env: Env, mcp: MagnificMcp, tools: Map<string, string[]>, refresh = false): Promise<MagnificLists> {
  if (!refresh && listsMemo && Date.now() - listsMemo.at < LISTS_TTL_MS) return listsMemo.lists;
  if (!refresh) {
    const stored = await readJsonSetting<{ at: number; lists: MagnificLists }>(env, MAGNIFIC_LISTS_SETTING);
    if (stored && stored.lists && typeof stored.at === "number" && Date.now() - stored.at < LISTS_TTL_MS) {
      listsMemo = stored;
      return stored.lists;
    }
  }
  const ask = async (name: string): Promise<ToolChoice[]> => {
    if (!tools.has(name)) return [];
    try {
      const r = await mcp.callTool(name, {});
      return r.isError ? [] : choices(parseMagnificEntries(r));
    } catch (e) {
      console.error("[photo-tools]", name, errorMessage(e));
      return [];
    }
  };
  const lists: MagnificLists = { upscalePresets: await ask("images_upscale_presets_list"), upscaleModes: await ask("images_upscale_modes_list"), retouchModels: await ask("retouch_models_list") };
  listsMemo = { at: Date.now(), lists };
  await setSetting(env, MAGNIFIC_LISTS_SETTING, JSON.stringify(listsMemo));
  return lists;
}

/** The Magnific balance (`account_balance`, free), cached a minute. */
export async function magnificBalance(mcp: MagnificMcp, tools: Map<string, string[]>, fresh = false): Promise<number | null> {
  if (!tools.has("account_balance")) return null;
  if (!fresh && magnificBalanceMemo && Date.now() - magnificBalanceMemo.at < 60_000) return magnificBalanceMemo.credits;
  const r = await mcp.callTool("account_balance", {});
  let credits = r.isError ? null : findNumber(jsonOf(r), ["credits", "balance", "available", "remaining", "amount", "total"]);
  if (credits === null) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*credits?/i.exec(resultText(r));
    credits = m ? Number(m[1].replace(/,/g, "")) : null;
  }
  magnificBalanceMemo = { at: Date.now(), credits };
  return credits;
}

/**
 * Our picture as a Magnific creation, once an hour per key: `creations_upload_image` when it takes
 * a link, else `creations_request_upload` → PUT → `creations_finalize_upload`. Which exists is
 * read from the live tool list.
 */
export async function creationForPicture(env: Env, mcp: MagnificMcp, key: string, tools: Map<string, string[]>): Promise<string> {
  const hit = creationMemo.get(key);
  if (hit && Date.now() - hit.at < CREATION_TTL_MS) return hit.id;
  const obj = await env.BUCKET.head(key);
  if (!obj) throw new StudioError("The picture is not in storage.", 404);
  const mime = obj.httpMetadata?.contentType || "image/png";
  const fileName = `${key.split("/").pop() ?? "picture"}`;
  let id: string | null = null;
  const byLink = tools.get("creations_upload_image");
  const linkParam = byLink?.find((p) => /^(url|imageUrl|image_url|fileUrl|file_url|sourceUrl|source_url|link)$/i.test(p)) ?? byLink?.find((p) => /url/i.test(p));
  if (byLink && linkParam) {
    const url = await signObjectUrl(env, key, 2 * 60 * 60 * 1000);
    const r = await mcp.callTool("creations_upload_image", { [linkParam]: url, fileName, contentType: mime });
    if (r.isError) throw new StudioError(`Magnific refused the picture: ${resultText(r).slice(0, 200)}`, 502);
    id = parseIdentifiers(r)[0] ?? null;
  } else if (tools.has("creations_request_upload") && tools.has("creations_finalize_upload")) {
    const full = await env.BUCKET.get(key);
    if (!full) throw new StudioError("The picture is not in storage.", 404);
    const bytes = await full.arrayBuffer();
    const r1 = await mcp.callTool("creations_request_upload", { fileName, contentType: mime, size: bytes.byteLength, type: "image" });
    if (r1.isError) throw new StudioError(`Magnific refused the upload: ${resultText(r1).slice(0, 200)}`, 502);
    const j1 = jsonOf(r1);
    const uploadUrl = findString(j1, ["uploadUrl", "upload_url", "signedUrl", "signed_url", "url"]) ?? firstUrl(j1, resultText(r1));
    const uploadId = findString(j1, ["identifier", "uploadId", "upload_id", "creationIdentifier", "id"]);
    if (!uploadUrl || !uploadId) throw new StudioError(`Magnific's upload answer had no link or id: ${resultText(r1).slice(0, 200)}`, 502);
    const put = await magnificFetcher()(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes, signal: AbortSignal.timeout(120_000) });
    if (!put.ok) throw new StudioError(`The picture could not be uploaded to Magnific (${put.status}).`, 502);
    const r2 = await mcp.callTool("creations_finalize_upload", { identifier: uploadId, uploadId });
    if (r2.isError) throw new StudioError(`Magnific could not finish the upload: ${resultText(r2).slice(0, 200)}`, 502);
    id = parseIdentifiers(r2)[0] ?? uploadId;
  } else {
    throw new StudioError("Magnific lists no upload tool the studio knows (creations_upload_image, creations_request_upload + creations_finalize_upload), so the picture cannot be handed to it. Nothing was run.", 502, false, { missingTool: "creations_upload" });
  }
  if (!id) throw new StudioError("Magnific gave no creation identifier for the uploaded picture.", 502);
  creationMemo.set(key, { id, at: Date.now() });
  return id;
}

/** The picture for a Magnific tool: a signed link where the tool takes one, else a creation. */
export async function magnificPicture(env: Env, mcp: MagnificMcp, mcpTool: string, params: string[], key: string, tools: Map<string, string[]>): Promise<{ args: Record<string, unknown>; how: string }> {
  const urlParam = params.find((p) => /^(imageUrl|image_url|url|imageURL|sourceUrl|source_url|image|imageUrls|image_urls)$/i.test(p)) ?? params.find((p) => /url/i.test(p) && !/mask|reference|background|style/i.test(p));
  if (urlParam) {
    const url = await signObjectUrl(env, key, 2 * 60 * 60 * 1000);
    return { args: { [urlParam]: /s$/i.test(urlParam) ? [url] : url }, how: `link as ${urlParam}` };
  }
  const idParam = params.find((p) => /^(creationIdentifier|creation_identifier|identifier|creationId|creation_id)$/i.test(p)) ?? params.find((p) => /creation/i.test(p));
  if (idParam) {
    const id = await creationForPicture(env, mcp, key, tools);
    return { args: { [idParam]: id }, how: `creation as ${idParam}` };
  }
  throw new StudioError(`Magnific's ${mcpTool} takes neither a picture link nor a creation the studio knows (its inputs: ${params.join(", ") || "none listed"}). Nothing was run.`, 502, false, { missingParam: mcpTool });
}

/* ───────────── The catalog ───────────── */

async function emptyProvider(env: Env, user: User, provider: ToolProvider, connected: boolean, notConnected: string): Promise<ProviderCatalog> {
  const access = await integrationAccess(env, user, ledgerProvider(provider));
  const available: Record<string, boolean | null> = {};
  for (const t of PHOTO_TOOLS) if (t.provider === provider) available[t.id] = null;
  return { provider, connected, enabled: access.enabled, admin: access.admin, reason: !connected ? notConnected : access.reason, balance: null, available };
}

/** What each provider offers today. Members get the static list with no live call; admins get the live tool list, the option lists and the balances, kept an hour. */
export async function toolCatalog(env: Env, user: User, refresh = false): Promise<ToolCatalog> {
  const admin = user.role === "admin";
  if (admin && !refresh && catalogMemo && Date.now() - catalogMemo.at < CATALOG_TTL_MS) return catalogMemo.catalog;
  const hfSigned = await higgsfieldSignIn.isSignedIn(env);
  const mgConnected = (await tokenSource(env)) !== null;
  const higgsfield = await emptyProvider(env, user, "higgsfield", hfSigned, NOT_SIGNED_IN);
  const magnific = await emptyProvider(env, user, "magnific", mgConnected, MCP_NOT_CONNECTED);
  let lists: MagnificLists = { upscalePresets: [], upscaleModes: [], retouchModels: [] };
  if (admin && hfSigned && higgsfield.enabled) {
    try {
      const mcp = new HiggsfieldMcp(env, higgsfieldFetcher());
      await mcp.connect();
      const names = await mcp.toolNames(refresh);
      for (const t of PHOTO_TOOLS) if (t.provider === "higgsfield") higgsfield.available[t.id] = names.includes(t.mcpTool);
      higgsfield.balance = (await balanceOf(mcp, refresh).catch(() => ({ credits: null }))).credits;
    } catch (e) {
      higgsfield.reason = errorMessage(e);
    }
  }
  if (admin && mgConnected && magnific.enabled) {
    try {
      const mcp = await MagnificMcp.open(env);
      if (mcp) {
        const tools = await magnificTools(mcp, refresh);
        for (const t of PHOTO_TOOLS) if (t.provider === "magnific") magnific.available[t.id] = tools.has(t.mcpTool);
        lists = await magnificLists(env, mcp, tools, refresh);
        magnific.balance = await magnificBalance(mcp, tools, refresh).catch(() => null);
      }
    } catch (e) {
      magnific.reason = errorMessage(e);
    }
  }
  const catalog: ToolCatalog = { admin, tools: [...PHOTO_TOOLS], higgsfield, magnific, ...lists, cachedAt: Date.now() };
  if (admin) catalogMemo = { at: Date.now(), catalog };
  return catalog;
}

/* ───────────── Estimate and run ───────────── */

const optionsSchema = z.record(z.enum(["prompt", "aspect", "styleId", "preset", "mode", "model", "camera", "scale"]), z.string().trim().max(2000)).default({});
const askSchema = z.object({ batch: z.string().min(1), index: z.number().int().min(1).max(200), tool: z.string().min(1).max(40), options: optionsSchema });
const runSchema = askSchema.extend({ confirm: z.boolean().optional() });
export type PhotoToolAsk = z.infer<typeof askSchema>;
export type PhotoToolRun = z.infer<typeof runSchema>;

interface PostPicture {
  b: Awaited<ReturnType<typeof ownedPlan>>;
  t: { id: string; output: string };
}

async function postPicture(env: Env, user: User, batch: string, index: number): Promise<PostPicture> {
  const b = await ownedPlan(env, user, batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  return { b, t: { id: t.id, output: t.output } };
}

export interface Prepared {
  tool: ToolDef;
  mcpTool: string;
  args: Record<string, unknown>;
  /** Credits for exactly this call; null = cost not known. */
  credits: number | null;
  balance: number | null;
  notes: string[];
  text: string;
  call: () => Promise<McpCallResult>;
  balanceAfter: () => Promise<number | null>;
}

async function prepareHiggsfield(env: Env, tool: ToolDef, t: { output: string }, options: Record<string, string>): Promise<Prepared> {
  const mcp = new HiggsfieldMcp(env, higgsfieldFetcher());
  await mcp.connect();
  await mcp.requireTool(tool.mcpTool);
  const shape = await mcp.toolShape(tool.mcpTool);
  const mediaId = await mediaFor(env, mcp, t.output, "image");
  const size = shape.required.includes("width") ? await pictureSize(env, t.output) : null;
  const est = higgsfieldArgs(tool, shape, mediaId, options, true, size);
  let credits: number | null = null;
  let text = "";
  if (est.costable) {
    const r = await mcp.call(tool.mcpTool, est.args);
    text = resultText(r);
    if (!r.isError && !unlimChoiceIn(r)) credits = parseCost(r);
  } else est.notes.push(`${tool.mcpTool} lists no get_cost: cost not known before the run`);
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  const { args } = higgsfieldArgs(tool, shape, mediaId, options, false, size);
  return { tool, mcpTool: tool.mcpTool, args, credits, balance: bal.credits, notes: est.notes, text, call: () => mcp.call(tool.mcpTool, args), balanceAfter: async () => (await balanceOf(mcp, true)).credits };
}

async function prepareMagnific(env: Env, tool: ToolDef, t: { output: string }, options: Record<string, string>): Promise<Prepared> {
  const mcp = await MagnificMcp.open(env);
  if (!mcp) throw new StudioError(MCP_NOT_CONNECTED, 409, false, { connected: false });
  const tools = await magnificTools(mcp);
  if (!tools.has(tool.mcpTool)) throw new StudioError(`Magnific MCP lists no tool named "${tool.mcpTool}" (it lists ${tools.size}). The studio was written for the names in docs/photo-studio.md; nothing was run.`, 502, false, { missingTool: tool.mcpTool });
  const params = tools.get(tool.mcpTool)!;
  const opts = magnificOptionArgs(tool, params, options);
  const pic = await magnificPicture(env, mcp, tool.mcpTool, params, t.output, tools);
  const args = { ...opts.args, ...pic.args };
  let credits: number | null = null;
  let text = "";
  if (tools.has("simulate_cost")) {
    try {
      const sim = await mcp.callTool("simulate_cost", { tool: tool.mcpTool, arguments: args });
      text = resultText(sim);
      credits = sim.isError ? null : creditsIn(sim);
    } catch (e) {
      text = errorMessage(e);
    }
  } else text = "Magnific lists no simulate_cost";
  const balance = await magnificBalance(mcp, tools).catch(() => null);
  return { tool, mcpTool: tool.mcpTool, args, credits, balance, notes: [...opts.notes, `picture: ${pic.how}`], text, call: () => mcp.callTool(tool.mcpTool, args), balanceAfter: () => magnificBalance(mcp, tools, true) };
}

function requireOptions(tool: ToolDef, options: Record<string, string>): void {
  for (const o of tool.options) if (o.required && !options[o.id]?.trim()) throw new StudioError(`${o.label} is needed for ${tool.label}.`);
}

/** The cost in credits of exactly this tool on this post's picture (nothing is run), with the balance. Admins. */
export async function estimatePhotoTool(env: Env, user: User, d: PhotoToolAsk): Promise<{ credits: number | null; balance: number | null; notes: string[]; text: string }> {
  const tool = photoTool(d.tool);
  if (!tool) throw new StudioError("Unknown tool.");
  requireOptions(tool, d.options);
  const { b, t } = await postPicture(env, user, d.batch, d.index);
  const p = tool.provider === "higgsfield" ? await prepareHiggsfield(env, tool, t, d.options) : await prepareMagnific(env, tool, t, d.options);
  // Higgsfield's picture tools take no `get_cost`: when the provider names no price, the credits the
  // last finished run of the same tool reported (balance before → after) stand as the estimate, said so.
  if (p.credits === null && tool.provider === "higgsfield") {
    const last = await lastReportedRun(env, tool);
    if (last) {
      p.credits = last.credits;
      p.notes.push(`estimate from the last run of ${tool.label.toLowerCase()} (${last.credits} credits reported on ${new Date(last.at).toISOString().slice(0, 10)}); Higgsfield names no price before a run`);
    }
  }
  await recordIntegrationOp(env, {
    provider: ledgerProvider(tool.provider),
    kind: "image.estimate",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: p.credits,
    reported: 0,
    status: p.credits === null ? "refused" : "done",
    note: `${p.credits ?? "?"} credits · ${tool.label} (${TOOL_PROVIDER_LABELS[tool.provider]} · ${p.mcpTool})${p.notes.length ? ` · ${p.notes.join("; ")}` : ""}${p.credits === null ? ` · answer: ${p.text.slice(0, 160)}` : ""}`,
  });
  return { credits: p.credits, balance: p.balance, notes: p.notes, text: p.text.slice(0, 300) };
}

/** The credits the newest finished run of this tool reported, from the ledger (`image.tool`, done, a figure above zero). */
export async function lastReportedRun(env: Env, tool: ToolDef): Promise<{ credits: number; at: number } | null> {
  const row = await first<{ reported: number; updated: number }>(
    env.DB,
    "SELECT reported, updated FROM integration_ops WHERE provider = ? AND kind = 'image.tool' AND status = 'done' AND reported > 0 AND note LIKE ? ORDER BY updated DESC LIMIT 1",
    ledgerProvider(tool.provider),
    `${tool.label} (${TOOL_PROVIDER_LABELS[tool.provider]}) · %`,
  );
  return row ? { credits: row.reported, at: row.updated } : null;
}

/** The stored picture's width and height from its file header (PNG, JPEG, WebP). */
export async function pictureSize(env: Env, key: string): Promise<PictureSize | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  return imageSize(await obj.arrayBuffer());
}

async function fingerprint(parts: string[]): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const isTimeout = (e: unknown) => e instanceof Error && (/TimeoutError|AbortError/.test(e.name) || /timed? ?out/i.test(e.message));

export interface StartJob {
  b: { id: string; owner: string };
  t: { id: string; output: string };
  post: number;
  user: User;
  provider: ToolProvider;
  tool: string;
  label: string;
  options: Record<string, string>;
  estimate: number | null;
  balanceBefore: number | null;
  opId: string;
  mcpTool: string;
  args: Record<string, unknown>;
  notes: string[];
  call: () => Promise<McpCallResult>;
  fetchFn: typeof fetch;
  balanceAfter: () => Promise<number | null>;
}

/**
 * One provider call, exactly once, into a job row: the row is written first (queued), the call made,
 * a job id or creation identifier kept (or a result link finished at once), a timeout kept as
 * "outcome unknown" without resubmitting, any other failure recorded on the row and the ledger.
 */
export async function startPhotoJob(env: Env, s: StartJob): Promise<PhotoJobRow> {
  const id = uuid();
  const ts = now();
  const settings: JobSettings = { balanceBefore: s.balanceBefore, mcpTool: s.mcpTool, args: redactArgs(s.args) as Record<string, unknown>, notes: s.notes, jobIds: [] };
  await run(
    env.DB,
    "INSERT INTO photo_tool_jobs (id, batch, post, task, owner, provider, tool, label, options, input_key, status, estimate, op_id, settings, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
    id,
    s.b.id,
    s.post,
    s.t.id,
    s.user.id,
    s.provider,
    s.tool,
    s.label.slice(0, 120),
    JSON.stringify(s.options),
    s.t.output,
    s.estimate,
    s.opId,
    JSON.stringify(settings),
    ts,
    ts,
  );
  let row = await jobById(env, id);
  let r: McpCallResult;
  try {
    r = await noRetry(s.call);
  } catch (e) {
    if (isTimeout(e)) {
      const note = `${TOOL_PROVIDER_LABELS[s.provider]} did not answer in time: the tool may still have started, so nothing was sent again. The job stays queued and is given up after half an hour if no result can be learned; check the balance and the provider's history.`;
      await run(env.DB, "UPDATE photo_tool_jobs SET settings = ?, updated = ? WHERE id = ?", JSON.stringify({ ...settings, outcomeUnknown: true }), now(), id);
      await updateIntegrationOp(env, s.opId, { status: "running", note: `outcome unknown (timeout) · ${note}` });
      throw new StudioError(note, 504, false, { outcomeUnknown: true, jobId: id });
    }
    await failJob(env, row, errorMessage(e).slice(0, 400));
    throw e;
  }
  if (s.provider === "higgsfield" && unlimChoiceIn(r)) {
    const message = `Higgsfield asks whether this should use the unlimited allowance or pay credits; the Photo studio does not answer that question yet. Nothing was made.`;
    await failJob(env, row, message);
    throw new StudioError(message, 409, false, { unlimChoice: unlimChoiceIn(r) });
  }
  const text = resultText(r);
  const providerJobs = s.provider === "higgsfield" ? parseJobs(r).map((j) => ({ id: j.jobId, status: j.status, url: j.url, error: j.error })) : parseCreations(r).map((c) => ({ id: c.identifier, status: c.status, url: c.url, error: c.error }));
  const ids = s.provider === "higgsfield" ? providerJobs.map((j) => j.id) : parseIdentifiers(r);
  const direct = providerJobs.find((j) => DONE.test(j.status) && j.url)?.url ?? (ids.length ? null : r.isError ? null : firstUrl(jsonOf(r), text));
  // "Preset submitted … job_ids: [...]" can come back flagged as an error (Higgsfield's guard against a second
  // submission): it was submitted, so it is followed like any started job, never recorded as not started.
  const submitted = ids.length > 0 && /\bsubmitted\b/i.test(text);
  if ((r.isError && !submitted) || (!ids.length && !direct)) {
    const message = `${TOOL_PROVIDER_LABELS[s.provider]} did not start the tool: ${text.slice(0, 300) || "no job id in the answer"}`;
    // An error answer that still names a job keeps the id, so "Check again" can ask about it later.
    if (ids.length) await run(env.DB, "UPDATE photo_tool_jobs SET provider_job = ?, settings = ? WHERE id = ?", ids[0], JSON.stringify({ ...settings, jobIds: ids }), id);
    await failJob(env, row, message);
    throw new StudioError(message, 502);
  }
  if (ids.length) {
    await run(env.DB, "UPDATE photo_tool_jobs SET status = 'running', provider_job = ?, settings = ?, updated = ? WHERE id = ?", ids[0], JSON.stringify({ ...settings, jobIds: ids }), now(), id);
    await updateIntegrationOp(env, s.opId, { taskId: ids[0], status: "running" });
  }
  row = await jobById(env, id);
  if (direct && (!ids.length || providerJobs.some((j) => DONE.test(j.status)))) {
    try {
      await finishJob(env, s.b, row, direct, s.fetchFn, s.balanceAfter);
    } catch (e) {
      await failJob(env, row, errorMessage(e));
    }
    row = await jobById(env, id);
  }
  return row;
}

/**
 * A tool on the post's picture, on the provider's credits: the estimate first (the admin confirms
 * the credits shown; an unknown Higgsfield cost may be confirmed anyway, an unknown Magnific cost is
 * blocked), the same ask within ten minutes refused, one ledger row, the call once. Admins.
 */
export async function runPhotoTool(env: Env, user: User, d: PhotoToolRun): Promise<PhotoToolJob> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const tool = photoTool(d.tool);
  if (!tool) throw new StudioError("Unknown tool.");
  requireOptions(tool, d.options);
  const { b, t } = await postPicture(env, user, d.batch, d.index);
  const provider = ledgerProvider(tool.provider);
  const p = tool.provider === "higgsfield" ? await prepareHiggsfield(env, tool, t, d.options) : await prepareMagnific(env, tool, t, d.options);
  const label = `${tool.label} (${TOOL_PROVIDER_LABELS[tool.provider]})`;
  const base = { provider, kind: "image.tool", user: user.id, batch: b.id, post: d.index };
  if (p.credits === null) {
    if (tool.provider === "magnific") {
      await recordIntegrationOp(env, { ...base, estimate: null, status: "refused", note: `cost not known: simulate_cost gave no figure for ${p.mcpTool} · ${p.text.slice(0, 200)}` });
      throw new StudioError(`Cost not known: Magnific could not estimate ${tool.label.toLowerCase()}, so it was not run. Every Magnific tool draws on the credit balance.`, 409, false, { blocked: true });
    }
    if (!d.confirm) throw new StudioError(`The cost of ${tool.label.toLowerCase()} is not known: Higgsfield gave no figure. Confirm it at an unknown cost, or pick another tool.`, 409, false, { needsEstimate: true, tool: tool.id, balance: p.balance });
  }
  if (!d.confirm) throw new StudioError(`Confirm ${tool.label.toLowerCase()}: about ${p.credits} credits from the ${TOOL_PROVIDER_LABELS[tool.provider]} balance${p.balance !== null ? ` (${p.balance} available)` : ""}.`, 409, false, { needsConfirm: true, credits: p.credits, balance: p.balance });
  const fp = await fingerprint([tool.id, p.mcpTool, JSON.stringify(d.options), t.output]);
  if (!(await claimSubmission(env, `phototool:${b.id}:${d.index}:${fp}`, CLAIM_TTL_MS))) throw new StudioError("This exact tool run was asked for a moment ago. Wait for it, or change its options.", 409);
  const opId = await recordIntegrationOp(env, {
    ...base,
    estimate: p.credits,
    status: "confirmed",
    note: `${label} · ${p.mcpTool} · ${p.credits ?? "unknown"} credits${p.credits === null ? " · cost unknown, confirmed" : ""}${p.balance !== null ? ` · balance before ${p.balance}` : ""}${p.notes.length ? ` · ${p.notes.join("; ")}` : ""}`,
  });
  const row = await startPhotoJob(env, {
    b,
    t,
    post: d.index,
    user,
    provider: tool.provider,
    tool: tool.id,
    label,
    options: d.options,
    estimate: p.credits,
    balanceBefore: p.balance,
    opId,
    mcpTool: p.mcpTool,
    args: p.args,
    notes: p.notes,
    call: p.call,
    fetchFn: tool.provider === "higgsfield" ? higgsfieldFetcher() : magnificFetcher(),
    balanceAfter: p.balanceAfter,
  });
  return jobJson(row);
}

/* ───────────── The settler: the pending jobs asked about, six at most ───────────── */

export async function settlePhotoJobs(env: Env, b: { id: string; owner: string }, rows: PhotoJobRow[]): Promise<void> {
  const pending = rows.filter((j) => j.status === "queued" || j.status === "running").slice(0, POLL_LIMIT);
  if (!pending.length) return;
  const old = (j: PhotoJobRow) => now() - j.created > GIVE_UP_MS;
  for (const j of pending) if (!j.provider_job && old(j)) await failJob(env, j, "The submission's outcome was never learned (the provider did not answer in time) and nothing was sent again. Check the provider's history and balance.");
  const hf = pending.filter((j) => j.provider === "higgsfield" && j.provider_job && j.status !== "failed");
  const mg = pending.filter((j) => j.provider === "magnific" && j.provider_job && j.status !== "failed");
  const settle = async (j: PhotoJobRow, entry: { status: string; url: string | null; error: string | null } | undefined, fetchFn: typeof fetch, balanceAfter: () => Promise<number | null>, more: () => Promise<string | null>) => {
    try {
      if (!entry) {
        if (old(j)) await failJob(env, j, "The provider no longer lists this job.");
        return;
      }
      if (DONE.test(entry.status)) {
        const url = entry.url ?? (await more().catch(() => null));
        if (!url) {
          await failJob(env, j, "The tool finished without a picture link.");
          return;
        }
        await finishJob(env, b, j, url, fetchFn, balanceAfter);
      } else if (FAILED.test(entry.status)) {
        await failJob(env, j, entry.error ? `The tool failed on the provider: ${entry.error}` : "The tool failed on the provider.");
      } else if (old(j)) {
        await failJob(env, j, "The tool did not finish in half an hour.");
      } else if (j.status === "queued" && RUNNING.test(entry.status)) {
        await run(env.DB, "UPDATE photo_tool_jobs SET status = 'running', updated = ? WHERE id = ?", now(), j.id);
        j.status = "running";
      }
    } catch (e) {
      console.error("[photo-tools] settle", j.id, errorMessage(e));
    }
  };
  if (hf.length) {
    const mcp = new HiggsfieldMcp(env, higgsfieldFetcher());
    try {
      await mcp.connect();
      const answer = await mcp.call("jobs_wait", { jobs: hf.map((j, i) => ({ index: i, job_id: j.provider_job })), timeout_seconds: 1 });
      const jobs = parseJobs(answer);
      for (const [i, j] of hf.entries()) {
        const found = jobs.find((x) => x.jobId === j.provider_job) ?? jobs.find((x) => x.index === i);
        const raw = found ? jobObject(answer, "job_id", found.jobId) : null;
        await settle(j, found ? { status: found.status, url: resultLink(env, found.url, raw), error: found.error } : undefined, higgsfieldFetcher(), async () => (await balanceOf(mcp, true)).credits, async () => {
          if (!(await mcp.hasTool("show_generation_by_ids"))) return null;
          const shown = await mcp.call("show_generation_by_ids", { jobs: [{ index: 0, job_id: j.provider_job }] });
          return resultLink(env, parseJobs(shown).find((x) => x.jobId === j.provider_job)?.url ?? null, jobObject(shown, "job_id", j.provider_job!) ?? jsonOf(shown), resultText(shown));
        });
      }
    } catch (e) {
      console.error("[photo-tools] jobs_wait", errorMessage(e));
      for (const j of hf) if (old(j)) await failJob(env, j, "Higgsfield could not be asked for half an hour.");
    }
  }
  if (mg.length) {
    try {
      const mcp = await MagnificMcp.open(env);
      if (!mcp) throw new StudioError(MCP_NOT_CONNECTED, 409);
      const tools = await magnificTools(mcp);
      const answer = await mcp.callTool("creations_wait", { identifiers: mg.map((j) => j.provider_job), timeoutSeconds: 1 });
      const entries = parseCreations(answer);
      for (const j of mg) {
        const found = entries.find((x) => x.identifier === j.provider_job);
        await settle(j, found ? { status: found.status, url: resultLink(env, found.url, jobObject(answer, "identifier", found.identifier)), error: found.error } : undefined, magnificFetcher(), () => magnificBalance(mcp, tools, true), async () => {
          if (!tools.has("creations_get")) return null;
          const got = await mcp.callTool("creations_get", { identifier: j.provider_job, creationIdentifier: j.provider_job });
          return resultLink(env, parseCreations(got).find((x) => x.identifier === j.provider_job)?.url ?? null, jobObject(got, "identifier", j.provider_job!) ?? jsonOf(got), resultText(got));
        });
      }
    } catch (e) {
      console.error("[photo-tools] creations_wait", errorMessage(e));
      for (const j of mg) if (old(j)) await failJob(env, j, "Magnific could not be asked for half an hour.");
    }
  }
}

/* ───────────── "Check again": a job recorded as failed, asked about once more ───────────── */

/** Two presses at once are one check: the second waits for the first's answer. */
const CHECK_CLAIM_MS = 60 * 1000;

/**
 * The ledger row of a job collected late: the run's own row (`op_id`, else the row that carries the
 * provider's job id) closed as done with the credits, exactly as the settler closes it. A row that
 * is already done with a figure is left as it is (never counted twice); a job with no row at all
 * gets one. Returns the credits the ledger holds for the job.
 */
async function closeLedgerLate(env: Env, row: PhotoJobRow, credits: number | null, how: string, before: string | null): Promise<number | null> {
  const provider = ledgerProvider(row.provider);
  const op = row.op_id
    ? await first<{ id: string; status: string; reported: number | null }>(env.DB, "SELECT id, status, reported FROM integration_ops WHERE id = ?", row.op_id)
    : await first<{ id: string; status: string; reported: number | null }>(env.DB, "SELECT id, status, reported FROM integration_ops WHERE provider = ? AND task_id = ? AND kind IN ('image.tool', 'preset.run') ORDER BY created LIMIT 1", provider, row.provider_job);
  if (op && op.status === "done" && typeof op.reported === "number") return op.reported;
  const note = `${row.label} · ${credits ?? "?"} credits ${how} · collected by Check again${before ? ` (recorded as failed before: ${before.slice(0, 160)})` : ""}`;
  if (op) await updateIntegrationOp(env, op.id, { status: "done", reported: credits, taskId: row.provider_job, note });
  else await recordIntegrationOp(env, { provider, kind: "image.tool", user: row.owner, batch: row.batch, post: row.post, taskId: row.provider_job, estimate: row.estimate, reported: credits, status: "done", note });
  return credits;
}

export interface RecheckAnswer {
  /** done: collected now (or already); running: the provider is still on it; failed: the provider says so; unknown: no clear answer. */
  outcome: "done" | "running" | "failed" | "unknown";
  message: string;
  job: PhotoToolJob;
}

/**
 * "Check again" on a job recorded as failed: the provider is asked for the job's status (a read,
 * nothing is sent again). Finished there: the picture is downloaded exactly as the settler does
 * (the same key, so a second press adds nothing), the job set done, and the ledger row closed with
 * the credits the provider names, else the job's estimate, once. Still running: said so, nothing
 * changed. Failed there: kept failed, with the provider's reason. Admins.
 */
export async function recheckPhotoJob(env: Env, user: User, id: string): Promise<RecheckAnswer> {
  const row = await jobById(env, id);
  const b = await ownedPlan(env, user, row.batch);
  const who = TOOL_PROVIDER_LABELS[row.provider];
  if (row.status === "done") return { outcome: "done", message: "Already collected: the result is here. Nothing was asked again.", job: jobJson(row) };
  if (row.status !== "failed") return { outcome: "running", message: `${who} is still working on it; the panel collects it by itself.`, job: jobJson(row) };
  // A run recorded before job ids in prose were read keeps its id only in the error text: recover it from there.
  if (!row.provider_job) {
    const named = /job|submitted/i.test(row.error ?? "") ? (row.error ?? "").match(/(?<![0-9a-f-])([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?![0-9a-f-])/i)?.[1]?.toLowerCase() : undefined;
    if (!named) throw new StudioError(`${who} never gave this run a job id, so there is nothing to ask about. Check ${who}'s own history and balance.`, 409);
    await run(env.DB, "UPDATE photo_tool_jobs SET provider_job = ? WHERE id = ?", named, row.id);
    row.provider_job = named;
  }
  const claim = `phototool-check:${row.id}`;
  if (!(await claimSubmission(env, claim, CHECK_CLAIM_MS))) throw new StudioError("This job is being checked right now. Wait a moment.", 409);
  try {
    const { said, fetchFn } = await askJobStatus(env, row.provider, row.provider_job);
    const not = notCollected(who, row.provider_job, said);
    if (said && !not && said.url) {
      const before = row.error;
      const key = await storeResult(env, b, row, said.url, fetchFn);
      const credits = said.credits ?? row.estimate;
      const how = said.credits !== null ? `reported by ${who}` : "(from the estimate)";
      // Only the press that turns the job from failed to done writes the ledger: a second press finds it done.
      const changed = await run(env.DB, "UPDATE photo_tool_jobs SET status = 'done', output_key = ?, reported = ?, error = NULL, updated = ? WHERE id = ? AND status = 'failed'", key, credits, now(), row.id);
      if (!changed) return { outcome: "done", message: "Already collected: the result is here.", job: jobJson(await jobById(env, row.id)) };
      const counted = await closeLedgerLate(env, row, credits, how, before);
      if (counted !== credits) await run(env.DB, "UPDATE photo_tool_jobs SET reported = ? WHERE id = ?", counted, row.id);
      const done = await jobById(env, row.id);
      return { outcome: "done", message: `${who} had finished it: the result is collected${counted !== null ? ` (${counted} credits)` : ""}. Use it as the post's picture when you are ready.`, job: jobJson(done) };
    }
    const answer = not!;
    if (answer.reason) await run(env.DB, "UPDATE photo_tool_jobs SET error = ?, updated = ? WHERE id = ?", `The tool failed on the provider: ${answer.reason}`.slice(0, 500), now(), row.id);
    return { outcome: answer.outcome, message: answer.message, job: jobJson(await jobById(env, row.id)) };
  } finally {
    await run(env.DB, "DELETE FROM integration_claims WHERE key = ?", claim);
  }
}

/* ───────────── Routes ───────────── */

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** Every member sees the list; the live availability, lists and balances are read for admins only. */
photoToolRoutes.get("/catalog", async (c) => {
  return c.json({ ok: true, ...(await toolCatalog(c.env, c.get("user"), c.req.query("refresh") === "1")) });
});

async function gate(c: { get(k: "user"): User; env: Env }, toolId: string | undefined): Promise<{ user: User; tool: ToolDef }> {
  const tool = toolId ? photoTool(toolId) : undefined;
  if (!tool) throw new StudioError("Unknown tool.");
  const user = requireIntegrationAdmin(c, ledgerProvider(tool.provider));
  await assertIntegrationEnabled(c.env, ledgerProvider(tool.provider));
  return { user, tool };
}

photoToolRoutes.post("/estimate", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tool?: string };
  const { user } = await gate(c, typeof body.tool === "string" ? body.tool : undefined);
  const d = askSchema.safeParse(body);
  if (!d.success) throw new StudioError(`Invalid request: ${d.error.issues[0]?.path.join(".") || "body"} ${d.error.issues[0]?.message ?? "is invalid"}.`);
  const e = await estimatePhotoTool(c.env, user, d.data);
  return c.json({ ok: true, unit: "credits", ...e });
});

photoToolRoutes.post("/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tool?: string };
  const { user } = await gate(c, typeof body.tool === "string" ? body.tool : undefined);
  const d = runSchema.safeParse(body);
  if (!d.success) throw new StudioError(`Invalid request: ${d.error.issues[0]?.path.join(".") || "body"} ${d.error.issues[0]?.message ?? "is invalid"}.`);
  return c.json({ ok: true, job: await runPhotoTool(c.env, user, d.data) });
});

/** The post's jobs, newest first, the pending ones asked about first. Every member of the month. */
photoToolRoutes.get("/jobs", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const index = Number(c.req.query("index"));
  if (!Number.isInteger(index) || index < 1) throw new StudioError("Say which post.");
  const rows = await postJobs(c.env, b.id, index);
  await settlePhotoJobs(c.env, b, rows);
  return c.json({ ok: true, jobs: rows.map(jobJson) });
});

photoToolRoutes.get("/jobs/:id/image", async (c) => {
  const job = await jobById(c.env, c.req.param("id"));
  await ownedPlan(c.env, c.get("user"), job.batch);
  const key = c.req.query("which") === "out" ? job.output_key : job.input_key;
  if (!key) throw new StudioError("No result yet.", 404);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw new StudioError("Not found.", 404);
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "private, max-age=604800" } });
});

/** "Check again" on a failed job: a status read at the provider, free, never a new run. Admins. */
photoToolRoutes.post("/jobs/:id/check", async (c) => {
  const job = await jobById(c.env, c.req.param("id"));
  const user = requireIntegrationAdmin(c, ledgerProvider(job.provider));
  return c.json({ ok: true, ...(await recheckPhotoJob(c.env, user, job.id)) });
});

const useSchema = z.discriminatedUnion("as", [
  z.object({ as: z.literal("product"), batch: z.string().min(1), name: z.string().max(120).optional() }),
  z.object({ as: z.literal("picture"), batch: z.string().min(1), post: z.number().int().min(1).optional() }),
]);

/**
 * The result into the month: as the post's picture (the task's output replaced by the stored
 * result, a take recorded with the credits in its note, the previous picture kept as a take and with
 * the month's earlier pictures) or as a product photo (a `sources` row like a Drive import). Nothing
 * is sent to a provider here. Admins.
 */
photoToolRoutes.post("/jobs/:id/use", async (c) => {
  const job = await jobById(c.env, c.req.param("id"));
  const user = requireIntegrationAdmin(c, ledgerProvider(job.provider));
  await assertIntegrationEnabled(c.env, ledgerProvider(job.provider));
  if (job.status !== "done" || !job.output_key) throw new StudioError("The result is not ready yet.", 409);
  const d = await parseBody(c, useSchema);
  const b = await ownedPlan(c.env, user, d.batch);
  if (b.id !== job.batch) throw new StudioError("This result belongs to another month.", 409);
  const post = d.as === "picture" ? (d.post ?? job.post) : job.post;
  await recordIntegrationOp(c.env, { provider: ledgerProvider(job.provider), kind: `image.result.${d.as}`, user: user.id, batch: b.id, post, taskId: job.provider_job, estimate: 0, reported: 0, status: "done", note: `Job ${job.id} (${job.label}) used as ${d.as === "picture" ? `post ${post}'s picture` : "a product photo"}` });
  const obj = await c.env.BUCKET.get(job.output_key);
  if (!obj) throw new StudioError("The result is no longer in storage.", 404);
  const mime = obj.httpMetadata?.contentType || "image/png";
  const credits = job.reported ?? job.estimate;
  const note = `AI tools: ${job.label}${job.options && job.options !== "{}" ? ` (${Object.values(parseJson<Record<string, string>>(job.options, {})).filter(Boolean).join(", ").slice(0, 80)})` : ""}${credits !== null ? ` · ${credits} credits` : " · cost not known"}`;
  const config = JSON.parse(b.config) as Config;

  if (d.as === "product") {
    const bytes = await obj.arrayBuffer();
    const taken = new Set((await all<{ stem: string }>(c.env.DB, "SELECT stem FROM sources WHERE batch = ?", b.id)).map((r) => r.stem.normalize("NFC").toLowerCase()));
    const wanted = (d.name?.trim() || `Post ${job.post} ${job.label.replace(/\s*\(.*\)$/, "").toLowerCase()}`).trim();
    const free = freeName(wanted, taken);
    const fileName = `${free}.${extOf(mime)}`;
    const id = uuid();
    const key = `${b.owner}/${b.id}/source/${id}`;
    await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    let referenceKey: string | null = null;
    try {
      const { resizedPicture } = await import("./thumbs");
      const small = await resizedPicture(c.env, key, 720);
      if (small) referenceKey = small.key;
    } catch {
      referenceKey = null;
    }
    await run(c.env.DB, "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', 'product', ?, ?)", id, b.id, fileName, stemKey(fileName), key, referenceKey, mime, bytes.byteLength, note, now());
    return c.json({ ok: true, source: { id, name: fileName, stem: stemKey(fileName), key, kind: "product", role: "lead", reference_key: referenceKey, note } });
  }

  const t = await first<{ id: string; output: string | null; status: string }>(c.env.DB, "SELECT id, output, status FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, post);
  if (!t) throw new StudioError(`Post ${post} has no picture slot yet: make its picture once first.`, 409);
  if (["queued", "processing", "finalizing"].includes(t.status)) throw new StudioError("This post is being made: wait for it first.", 409);
  if (!job.output_key.startsWith(`${b.owner}/${b.id}/output/`)) throw new StudioError("Not this month's picture.", 400);
  const plan = (config.plan ?? []).find((p) => p.index === post);
  const madeFor = plan ? postRevision(plan, config) : null;
  // The client answered this post (approved it, or asked for a change): the result is kept as a new
  // version beside the client's, which stays until the team sends it for review (shared/client-hold.ts).
  const hold = clientHold(config, post);
  if (hold) {
    await run(c.env.DB, "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)", uuid(), b.id, post, t.id, job.output_key, `${note} · new version (the client's version stays)`.slice(0, 500), madeFor, now());
    return c.json({ ok: true, task: t.id, key: job.output_key, previous: t.output, current: t.output, held: hold, message: heldMessage(hold) });
  }
  await run(c.env.DB, "UPDATE tasks SET output = ?, status = 'ready', error = NULL, edit = NULL, qa = NULL, made_for = ?, updated = ? WHERE id = ?", job.output_key, madeFor, now() + 1, t.id);
  await run(c.env.DB, "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)", uuid(), b.id, post, t.id, job.output_key, note.slice(0, 500), madeFor, now());
  if (t.output && t.output !== job.output_key)
    await run(c.env.DB, "INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES (?, ?, 'snapshot', ?, ?, ?, ?)", uuid(), b.id, `Post ${post} before the AI tools`, JSON.stringify({ [String(post)]: t.output }), JSON.stringify([{ post, key: t.output, at: now() }]), now());
  return c.json({ ok: true, task: t.id, key: job.output_key, previous: t.output, current: job.output_key, held: null });
});

