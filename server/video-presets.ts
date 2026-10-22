/**
 * The Video studio's preset gallery, from the Higgsfield MCP (docs/video-studio.md): the presets
 * page's categories (Popular, Paid Ads, Motion Design, Marketing, Production, UGC, Faceless,
 * Effects, Genjutsu, Recipes) mapped to `get_presets` sources and queries, each answer normalised
 * into cards with the provider's own reference video (hotlinked, never copied here) and cached a
 * day per category in an encrypted settings row. Every member browses; only an admin runs a
 * preset, on the subscription credits, with the usual rules: the switch, confirm before spend
 * (the detail's price, or "cost not known" until confirmed), one claim per ask, a ledger row, no
 * retry. A run is `execute_preset` → job ids → a `videos` row with provider `higgsfield-mcp`
 * (the first job id as `request_id`, the rest noted) that the existing settler collects.
 *
 * Routes (mounted at /api/studio/video/presets):
 *   GET  /            ?category=&q=&cursor=&refresh=1   the cards of a category (every member)
 *   GET  /:id         ?source=&batch=&index=            one preset with its inputs, readiness, price and instructions
 *   POST /run         {batch, index, presetId, source, inputs?, confirm?}   admins
 *
 * Every answer shape below is assumed from the tool descriptions and read defensively; the first
 * live run must check them (docs/video-studio.md, "What the first live run must check").
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { first, uuid } from "./db";
import { setSetting } from "./settings";
import { readJsonSetting } from "./oauth-signin";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, switchedOffMessage, updateIntegrationOp } from "./integrations";
import { balanceOf, fetcher, HiggsfieldMcp, higgsfieldSignIn, MCP_PROVIDER, mediaFor, NOT_SIGNED_IN, parseJobs, unlimChoiceIn } from "./higgsfield-mcp";
import { CLOUD_CHOSEN, higgsfieldBilling } from "./higgsfield-billing";
import { findNumber, findString, findValue, jsonOf, objectsWith, resultText, type McpCallResult } from "./mcp-client";
import { insertVideoRow, sha256, versionItem, type VideoItem } from "./video";
import { EXECUTABLE_SOURCES, isPresetCategory, isVideoFromPictureRecipe, keepCard, NOTHING_IN_CATEGORY, outputKind, PRESET_CATEGORIES, type PresetCard, type PresetCategoryId, type PresetDetail } from "@shared/video-presets";
import type { User } from "@shared/types";

type Variables = { user: User };
export const videoPresetRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** A category's cards are kept this long before the provider is asked again (`?refresh=1` asks at once). */
export const PRESETS_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 60 * 60 * 1000;
const CLAIM_TTL_MS = 10 * 60 * 1000;
export const PRESETS_CACHE_PREFIX = "video_presets_cache_";

/* ───────────── The categories as asks to the provider ───────────── */

interface PresetAsk {
  source?: string;
  category?: string;
  query?: string;
  katana_source?: string;
  limit?: number;
}

/** What each category asks `get_presets`; "recipes" asks `get_preset_instructions` with no preset instead. */
export const CATEGORY_ASKS: Record<Exclude<PresetCategoryId, "recipes">, PresetAsk[]> = {
  popular: [{ limit: 24 }],
  "paid-ads": [{ source: "marketing_studio", query: "ad", limit: 24 }],
  motion: [{ source: "marketing_studio", category: "motion", limit: 24 }],
  marketing: [
    { source: "marketing_studio", category: "product-shot", limit: 24 },
    { source: "marketing_studio", category: "ads", limit: 24 },
  ],
  production: [{ source: "katana", katana_source: "higgsfield", limit: 20 }],
  ugc: [{ query: "ugc", limit: 24 }],
  faceless: [{ query: "faceless", limit: 24 }],
  effects: [{ source: "viral", limit: 24 }],
  genjutsu: [{ source: "genjutsu", category: "genjutsu-trending", limit: 24 }],
};

/* ───────────── Reading the answers ───────────── */

const VIDEO_RE = /\.(mp4|webm|mov|m3u8)(\?|#|$)/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;
const VIDEO_KEYS = ["video_url", "preview_video", "preview_video_url", "reference_video", "reference_video_url", "demo_video", "example_video", "sample_video", "video"];
const POSTER_KEYS = ["poster", "poster_url", "thumbnail", "thumbnail_url", "image_url", "preview_image", "preview_image_url", "cover", "cover_url", "image"];
const EITHER_KEYS = ["preview", "preview_url", "media", "media_url", "example", "example_url", "demo_url", "previews", "medias", "examples"];

function urlOf(v: unknown): string | null {
  if (typeof v === "string") return /^https?:\/\/\S+$/.test(v.trim()) ? v.trim() : null;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["url", "src", "href", "video_url", "image_url"]) {
      const u = urlOf(o[k]);
      if (u) return u;
    }
  }
  return null;
}

/** The kind an object with a URL declares, when it does ("video", "image"). */
function kindOf(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const o = v as Record<string, unknown>;
  return String(o.type ?? o.kind ?? o.media_type ?? o.mime_type ?? o.mimeType ?? "").toLowerCase();
}

/** The reference video and the still of a preset object, whatever the answer calls them. */
export function mediaOf(o: Record<string, unknown>): { video: string | null; poster: string | null } {
  let video: string | null = null;
  let poster: string | null = null;
  const take = (u: string | null, kind: string, key: string) => {
    if (!u) return;
    const isVideo = /video/.test(kind) || VIDEO_RE.test(u) || (!/image|photo/.test(kind) && !IMAGE_RE.test(u) && /video/.test(key));
    const isImage = /image|photo/.test(kind) || IMAGE_RE.test(u);
    if (isVideo && !video) video = u;
    else if (isImage && !poster) poster = u;
    else if (!isVideo && !isImage && !video && !/poster|thumb|image|cover/.test(key)) video = u; // a bare CDN link under a preview key: taken as the reference video
    else if (!isVideo && !isImage && !poster) poster = u;
  };
  for (const k of VIDEO_KEYS) if (k in o) take(urlOf(o[k]), kindOf(o[k]) || "video", k);
  for (const k of POSTER_KEYS) if (k in o) take(urlOf(o[k]), kindOf(o[k]) || "image", k);
  for (const k of EITHER_KEYS) {
    const v = o[k];
    if (Array.isArray(v)) for (const x of v) take(urlOf(x), kindOf(x), k);
    else if (k in o) take(urlOf(v), kindOf(v), k);
  }
  // A nested block ("preview": {"video_url", "image_url"}, "media": {...}) is read the same way, one level down.
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !/preview|media|example|demo|asset|thumb|reference|cover/i.test(k)) continue;
    const inner = mediaOf(v as Record<string, unknown>);
    video ??= inner.video;
    poster ??= inner.poster;
  }
  return { video, poster };
}

/** The slash command of a preset ("/hero-shot"), with the slash added when the answer leaves it out. */
function commandOf(o: Record<string, unknown>): string | null {
  const c = [o.command, o.slash_command, o.slash, o.cmd, o.recipe].find((v) => typeof v === "string" && v.trim());
  if (typeof c !== "string") return null;
  const t = c.trim().split(/\s+/)[0];
  return t.startsWith("/") ? t : `/${t}`;
}

interface InputField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  minItems: number | null;
}

/** The inputs a preset declares: a JSON schema under `input_schema`, or a list under `inputs`. */
export function inputFields(schema: unknown): InputField[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) {
    return schema
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({ name: String(x.name ?? x.key ?? x.id ?? ""), type: String(x.type ?? ""), description: String(x.description ?? x.label ?? ""), required: x.required !== false, minItems: typeof x.min === "number" ? x.min : null }))
      .filter((f) => f.name);
  }
  const s = schema as { properties?: Record<string, unknown>; required?: unknown };
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required.map(String) : null;
  return Object.entries(props).map(([name, p]) => {
    const q = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const items = (q.items && typeof q.items === "object" ? q.items : {}) as Record<string, unknown>;
    return {
      name,
      type: `${String(q.type ?? "")} ${String(q.format ?? "")} ${String(q.media_type ?? items.type ?? "")}`.trim(),
      description: String(q.description ?? q.title ?? ""),
      required: required ? required.includes(name) : true,
      minItems: typeof q.minItems === "number" ? q.minItems : null,
    };
  });
}

const isImageField = (f: InputField) => /image|photo|picture|product|character|reference|media|frame/i.test(`${f.name} ${f.type} ${f.description}`) && !/video|clip|footage/i.test(`${f.name} ${f.type}`);
const isVideoField = (f: InputField) => /video|clip|footage/i.test(`${f.name} ${f.type} ${f.description}`);
const isTextField = (f: InputField) => /prompt|text|caption|description|script|idea|words|title/i.test(`${f.name} ${f.description}`) || /^string$/i.test(f.type);

/** What a preset needs, in plain words, from its required inputs. */
export function needsOf(schema: unknown): string[] {
  const out: string[] = [];
  for (const f of inputFields(schema).filter((f) => f.required)) {
    let line: string;
    if (isVideoField(f)) line = "a video clip";
    else if (isImageField(f)) line = f.minItems && f.minItems > 1 ? `${f.minItems} pictures` : /array/i.test(f.type) && !f.minItems ? "1 or more pictures" : "1 product picture";
    else if (isTextField(f)) line = "a few words of prompt";
    else line = f.name.replace(/[_-]+/g, " ").toLowerCase();
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** The input that takes the post's picture, when the preset has one. */
export function imageInputOf(schema: unknown): InputField | null {
  const fields = inputFields(schema);
  return fields.find((f) => isImageField(f) && f.required) ?? fields.find(isImageField) ?? null;
}

/** Is this object a preset (an id and a name), not a job, a schema or a media entry? */
function looksLikePreset(o: Record<string, unknown>): boolean {
  if ("job_id" in o || "properties" in o || ("url" in o && !("name" in o || "title" in o))) return false;
  const id = o.id ?? o.preset_id ?? o.slug ?? o.command;
  const name = o.name ?? o.title;
  return (typeof id === "string" || typeof id === "number") && typeof name === "string" && name.trim() !== "";
}

function cardOf(o: Record<string, unknown>, fallbackSource: string): PresetCard {
  const id = String(o.preset_id ?? o.id ?? o.slug ?? o.command);
  const { video, poster } = mediaOf(o);
  const exec = (o.execution && typeof o.execution === "object" ? o.execution : null) as Record<string, unknown> | null;
  const schema = exec?.input_schema ?? o.input_schema ?? o.inputs ?? null;
  const source = typeof o.source === "string" && o.source ? o.source : fallbackSource;
  const price = findNumber({ price: o.price, credits: o.credits, cost: o.cost, price_credits: o.price_credits, credits_cost: o.credits_cost, cost_credits: o.cost_credits, estimated_credits: o.estimated_credits }, ["price", "credits", "cost", "price_credits", "credits_cost", "cost_credits", "estimated_credits"]);
  const engine = [o.model, o.engine, o.model_id, o.default_model].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const prompt = [o.prompt, o.default_prompt, o.prompt_template, o.example_prompt, o.suggested_prompt].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const category = typeof o.category === "string" ? o.category : Array.isArray(o.categories) && typeof o.categories[0] === "string" ? o.categories[0] : null;
  // What the preset makes: the execution block's word first, then the preset's own output fields, then a "motion" category.
  const output = outputKind(exec?.output_type, exec?.output, exec?.outputs, exec?.result_type, exec?.produces, exec?.media_type, o.output_type, o.output, o.result_type, o.output_kind, o.produces, o.media_type, o.kind) ?? (/motion/i.test(category ?? "") ? "video" : null);
  return {
    id,
    source,
    title: String(o.name ?? o.title).trim().slice(0, 120),
    description: String(o.description ?? o.summary ?? o.subtitle ?? "").trim().slice(0, 600),
    command: commandOf(o),
    category,
    type: typeof o.type === "string" ? o.type : null,
    video,
    poster,
    price: price !== null && price >= 0 ? price : null,
    needs: needsOf(schema),
    runnable: EXECUTABLE_SOURCES.includes(source) && exec?.available !== false,
    engine: engine?.slice(0, 80) ?? null,
    prompt: prompt?.slice(0, 2000) ?? null,
    output,
  };
}

/**
 * The presets a `get_presets` answer lists, whatever it calls the list; the shape is read
 * defensively. The gallery keeps videos only (`keepCard`, shared/video-presets.ts): category
 * entries, cards with no preview and image presets are dropped. `all: true` (a detail lookup)
 * keeps every preset-shaped object.
 */
export function parsePresets(r: McpCallResult, fallbackSource: string, opts: { all?: boolean } = {}): PresetCard[] {
  const j = jsonOf(r);
  const out: PresetCard[] = [];
  const seen = new Set<string>();
  const candidates = [...objectsWith(j, "preset_id"), ...objectsWith(j, "id"), ...objectsWith(j, "slug"), ...objectsWith(j, "command")];
  for (const o of candidates) {
    if (!looksLikePreset(o)) continue;
    const card = cardOf(o, fallbackSource);
    if (seen.has(card.id)) continue;
    if (!opts.all && !keepCard(card)) continue;
    seen.add(card.id);
    out.push(card);
  }
  return out;
}

/** The `cursor` for the next page, when the answer carries one. */
export function nextCursorOf(r: McpCallResult): string | null {
  const j = jsonOf(r);
  return findString(j, ["next_cursor", "nextCursor", "cursor"]) ?? null;
}

/**
 * The recipes and commands `get_preset_instructions` lists with no preset: objects with a command
 * and a title, or lines such as "/hero-shot — a product hero shot". Recipes are read-only cards.
 * Only recipes that make a video from a picture are kept (`isVideoFromPictureRecipe`): the
 * Blender, After Effects, DaVinci, website and 3D recipes are not the Video studio's. `all: true`
 * (a detail lookup) keeps every recipe.
 */
export function parseRecipes(r: McpCallResult, opts: { all?: boolean } = {}): PresetCard[] {
  const j = jsonOf(r);
  const out: PresetCard[] = [];
  const seen = new Set<string>();
  const push = (command: string, title: string, description: string, o: Record<string, unknown> = {}) => {
    const c = command.startsWith("/") ? command : `/${command}`;
    if (seen.has(c)) return;
    const { video, poster } = mediaOf(o);
    const needs = needsOf(o.input_schema ?? o.inputs ?? null);
    const flag = [o.runnable, o.executable, o.available].find((v) => typeof v === "boolean") as boolean | undefined;
    if (!opts.all && !isVideoFromPictureRecipe(`${c} ${title} ${description} ${String(o.category ?? "")} ${String(o.type ?? "")}`, { inputs: o.inputs ?? o.input_schema ?? o.input_types ?? o.requires ?? o.accepts ?? o.media, runnable: flag ?? null, needs })) return;
    seen.add(c);
    out.push({ id: c, source: "recipe", title: title.slice(0, 120) || c, description: description.slice(0, 600), command: c, category: typeof o.category === "string" ? o.category : "recipe", type: typeof o.type === "string" ? o.type : "recipe", video, poster, price: null, needs, runnable: false, engine: null, prompt: typeof o.prompt === "string" ? o.prompt.slice(0, 2000) : null, output: "video" });
  };
  for (const o of [...objectsWith(j, "command"), ...objectsWith(j, "slash"), ...objectsWith(j, "slash_command"), ...objectsWith(j, "recipe")]) {
    const c = commandOf(o);
    if (!c) continue;
    const title = String(o.title ?? o.name ?? "").trim();
    const desc = String(o.description ?? o.summary ?? "").trim();
    if (title || desc) push(c, title, desc, o);
  }
  if (!out.length) {
    for (const line of resultText(r).split(/\r?\n/)) {
      const m = /^\s*(?:[-*•]|\d+[.)])?\s*`?(\/[a-z0-9][\w/-]*)`?\s*(?:[—–:-]|\.)\s+(.+?)\s*$/i.exec(line);
      if (m) push(m[1], m[1].slice(1).replace(/[/-]+/g, " "), m[2]);
    }
  }
  return out;
}

/* ───────────── The cache: a day per category, encrypted like every setting ───────────── */

interface CachedCategory {
  at: number;
  items: PresetCard[];
  nextCursor: string | null;
}

const memo = new Map<string, CachedCategory>();
const detailMemo = new Map<string, { at: number; detail: PresetDetail }>();

/** Tests start from nothing. */
export function resetPresetCaches(): void {
  memo.clear();
  detailMemo.clear();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export const cacheKey = (category: string, q: string) => `${PRESETS_CACHE_PREFIX}${category}${q ? `_q_${slug(q)}` : ""}`;

async function readCache(env: Env, key: string): Promise<CachedCategory | null> {
  const m = memo.get(key);
  if (m && Date.now() - m.at < PRESETS_TTL_MS) return m;
  const stored = await readJsonSetting<CachedCategory>(env, key);
  if (stored && Array.isArray(stored.items) && typeof stored.at === "number" && Date.now() - stored.at < PRESETS_TTL_MS) {
    memo.set(key, stored);
    return stored;
  }
  return null;
}

async function writeCache(env: Env, key: string, value: CachedCategory): Promise<void> {
  memo.set(key, value);
  await setSetting(env, key, JSON.stringify(value));
}

/* ───────────── Asking the provider ───────────── */

/** One category's cards from the live server: the asks of the category merged, or the recipes list. */
export async function fetchCategory(mcp: HiggsfieldMcp, category: PresetCategoryId, q: string, cursor: string | null): Promise<{ items: PresetCard[]; nextCursor: string | null }> {
  if (category === "recipes") {
    const r = await mcp.call("get_preset_instructions", {});
    let items = parseRecipes(r);
    if (q) items = items.filter((c) => matches(c, q));
    return { items, nextCursor: null };
  }
  const asks = CATEGORY_ASKS[category];
  const items: PresetCard[] = [];
  const seen = new Set<string>();
  let nextCursor: string | null = null;
  for (const [i, ask] of asks.entries()) {
    const args: Record<string, unknown> = { ...ask };
    // Katana takes no query: its cards are searched here instead.
    if (q && ask.source !== "katana") args.query = q;
    if (cursor && i === 0) args.cursor = cursor;
    const r = await mcp.call("get_presets", args);
    if (r.isError) continue;
    for (const card of parsePresets(r, ask.source ?? "viral")) {
      if (seen.has(`${card.source}:${card.id}`)) continue;
      if (q && ask.source === "katana" && !matches(card, q)) continue;
      seen.add(`${card.source}:${card.id}`);
      items.push(card);
    }
    if (i === 0) nextCursor = nextCursorOf(r);
  }
  return { items, nextCursor };
}

/** A search across what a card says (the gallery's search box uses the same rule in the browser). */
export function matches(c: PresetCard, q: string): boolean {
  const t = q.toLowerCase();
  return [c.title, c.description, c.command ?? "", c.category ?? "", c.type ?? "", c.source].some((s) => s.toLowerCase().includes(t));
}

/** The execution block of a detail answer (`execution: {available, input_schema, readiness}`), wherever it sits. */
function executionOf(r: McpCallResult): { available: boolean | null; schema: Record<string, unknown> | null; readiness: unknown } {
  const j = jsonOf(r);
  const exec = findValue(j, ["execution"], (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  const schema = (exec?.input_schema ?? findValue(j, ["input_schema"], (v): v is Record<string, unknown> => !!v && typeof v === "object")) as Record<string, unknown> | null;
  const availableRaw = exec?.available;
  return { available: typeof availableRaw === "boolean" ? availableRaw : null, schema: schema ?? null, readiness: exec?.readiness ?? findValue(j, ["readiness"], (v): v is unknown => v !== undefined && v !== null) ?? null };
}

/** One preset in full: the lookup by id, its execution block, and the instructions of its command. */
export async function fetchDetail(mcp: HiggsfieldMcp, id: string, source: string | null, initialInputs: Record<string, unknown> | null = null): Promise<PresetDetail> {
  const key = `${source ?? ""}:${id}`;
  const m = detailMemo.get(key);
  if (!initialInputs && m && Date.now() - m.at < DETAIL_TTL_MS) return m.detail;
  let card: PresetCard | null = null;
  let exec: ReturnType<typeof executionOf> = { available: null, schema: null, readiness: null };
  let price: number | null = null;
  if (source !== "recipe") {
    const args: Record<string, unknown> = { preset_id: id, category: "all" };
    if (source && source !== "viral") args.source = source;
    if (initialInputs) args.initial_inputs = initialInputs;
    const r = await mcp.call("get_presets", args);
    if (r.isError) throw new StudioError(`Higgsfield could not open this preset: ${resultText(r).slice(0, 200)}`, 502);
    const cards = parsePresets(r, source ?? "viral", { all: true });
    card = cards.find((c) => c.id === id) ?? cards[0] ?? null;
    exec = executionOf(r);
    price = card?.price ?? findNumber(jsonOf(r), ["price", "credits", "cost", "price_credits", "credits_cost"]);
  }
  let instructions = "";
  const command = card?.command ?? (source === "recipe" ? (id.startsWith("/") ? id : `/${id}`) : null);
  if (command) {
    try {
      const ri = await mcp.call("get_preset_instructions", { preset: command });
      if (!ri.isError) {
        instructions = resultText(ri).slice(0, 8000);
        if (!card) {
          const recipe = parseRecipes(ri, { all: true }).find((c) => c.command === command);
          card = recipe ?? { id, source: "recipe", title: command.slice(1).replace(/[/-]+/g, " "), description: "", command, category: "recipe", type: "recipe", video: null, poster: null, price: null, needs: [], runnable: false, engine: null, prompt: null, output: null };
        }
        if (!card.video || !card.poster) {
          const media = mediaOf((jsonOf(ri) as Record<string, unknown> | null) ?? {});
          card = { ...card, video: card.video ?? media.video ?? firstVideoUrl(resultText(ri)), poster: card.poster ?? media.poster };
        }
      }
    } catch (e) {
      console.error("[video-presets] instructions", command, errorMessage(e));
    }
  }
  if (!card) throw new StudioError("Higgsfield did not describe this preset (no card in the answer).", 502);
  const detail: PresetDetail = { ...card, price: card.price ?? price, needs: card.needs.length ? card.needs : needsOf(exec.schema), runnable: card.runnable && exec.available !== false, inputSchema: exec.schema, readiness: exec.readiness, available: exec.available, instructions };
  if (!initialInputs) detailMemo.set(key, { at: Date.now(), detail });
  return detail;
}

function firstVideoUrl(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/[^\s"'<>)]+/g)) if (VIDEO_RE.test(m[0])) return m[0];
  return null;
}

/* ───────────── Routes ───────────── */

/** The cards of a category: the cache for a day, else the provider (signed in, switch on). Every member. */
videoPresetRoutes.get("/", async (c) => {
  const user = c.get("user");
  const category = c.req.query("category") ?? "popular";
  if (!isPresetCategory(category)) throw new StudioError("Unknown preset category.");
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const cursor = c.req.query("cursor") || null;
  const refresh = c.req.query("refresh") === "1";
  const access = await integrationAccess(c.env, user, "higgsfield");
  const signedIn = await higgsfieldSignIn.isSignedIn(c.env);
  const base = { ok: true, category, categories: PRESET_CATEGORIES, signedIn, admin: user.role === "admin", access, billing: await higgsfieldBilling(c.env), empty: NOTHING_IN_CATEGORY };
  const key = cacheKey(category, q);
  if (!cursor && !refresh) {
    const hit = await readCache(c.env, key);
    if (hit) return c.json({ ...base, items: hit.items, nextCursor: hit.nextCursor, cachedAt: hit.at, cached: true, reason: "" });
  }
  if (!signedIn) return c.json({ ...base, items: [], nextCursor: null, cachedAt: null, cached: false, reason: NOT_SIGNED_IN });
  if (!access.enabled) return c.json({ ...base, items: [], nextCursor: null, cachedAt: null, cached: false, reason: switchedOffMessage("higgsfield") });
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  const { items, nextCursor } = await fetchCategory(mcp, category, q, cursor);
  const at = Date.now();
  // An empty answer is not kept for a day: the next visit asks again.
  if (!cursor && items.length) await writeCache(c.env, key, { at, items, nextCursor });
  await recordIntegrationOp(c.env, { provider: "higgsfield", kind: "preset.browse", user: user.id, estimate: 0, reported: 0, status: "done", note: `${category}${q ? ` · "${q}"` : ""} · ${items.length} preset${items.length === 1 ? "" : "s"} (browsing, nothing spent)` });
  return c.json({ ...base, items, nextCursor, cachedAt: at, cached: false, reason: "" });
});

/** One preset with its inputs, readiness (the post's picture prefilled for an admin), price and instructions. Every member. */
videoPresetRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const source = c.req.query("source") || null;
  if (!(await higgsfieldSignIn.isSignedIn(c.env))) throw new StudioError(NOT_SIGNED_IN, 409, false, { notSignedIn: true });
  await assertIntegrationEnabled(c.env, "higgsfield");
  const mcp = new HiggsfieldMcp(c.env, fetcher());
  await mcp.connect();
  let detail = await fetchDetail(mcp, id, source);
  let readinessError = "";
  const batch = c.req.query("batch");
  const index = Number(c.req.query("index"));
  // The readiness for exactly this post: its picture imported and offered as the preset's picture input (an admin's call: it imports media).
  if (user.role === "admin" && batch && Number.isInteger(index) && index > 0 && detail.runnable && detail.inputSchema) {
    try {
      const b = await ownedPlan(c.env, user, batch);
      const t = await first<{ output: string | null }>(c.env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, index);
      const field = imageInputOf(detail.inputSchema);
      if (t?.output && field) {
        const mediaId = await mediaFor(c.env, mcp, t.output, "image");
        const ready = await fetchDetail(mcp, id, source, { [field.name]: [{ id: mediaId, type: "image" }] });
        detail = { ...detail, readiness: ready.readiness ?? detail.readiness, available: ready.available ?? detail.available };
      }
    } catch (e) {
      readinessError = errorMessage(e);
    }
  }
  return c.json({ ok: true, preset: detail, readinessError, admin: user.role === "admin" });
});

const inputValue = z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.union([z.string().max(2000), z.number(), z.boolean(), z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))])).max(20)]);
const runSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(200),
  presetId: z.string().min(1).max(200),
  source: z.string().min(1).max(40),
  inputs: z.record(z.string().max(80), inputValue).default({}),
  confirm: z.boolean().optional(),
  note: z.string().trim().max(200).optional(),
});
export type PresetRunInput = z.infer<typeof runSchema>;

/**
 * A preset run on the subscription credits: the detail's price is the estimate (none → "cost not
 * known" until confirmed), the post's picture fills the preset's picture input, the same ask within
 * ten minutes is refused, one ledger row, `execute_preset` once; its job ids become one version
 * (the first job polled by the existing settler, the rest noted). Admins.
 */
export async function runPreset(env: Env, user: User, d: PresetRunInput): Promise<VideoItem> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  if ((await higgsfieldBilling(env)) !== "credits") throw new StudioError(CLOUD_CHOSEN, 409, false, { billing: "cloud" });
  if (!EXECUTABLE_SOURCES.includes(d.source)) throw new StudioError(`This preset is ${d.source === "recipe" ? "a recipe" : d.source === "katana" ? "a Katana production" : "not runnable from here"}: it cannot be run from the studio. Use its words in Generate, or open it on Higgsfield.`, 400, false, { notRunnable: true });
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const mcp = new HiggsfieldMcp(env, fetcher());
  await mcp.connect();
  await mcp.requireTool("execute_preset");
  const detail = await fetchDetail(mcp, d.presetId, d.source);
  if (!detail.runnable) throw new StudioError(`"${detail.title}" cannot be run from here${detail.available === false ? " (Higgsfield says it is not available)" : ""}.`, 409, false, { notRunnable: true });
  const inputs: Record<string, unknown> = { ...d.inputs };
  const field = imageInputOf(detail.inputSchema);
  let mediaId: string | null = null;
  if (field && inputs[field.name] === undefined) {
    mediaId = await mediaFor(env, mcp, t.output, "image");
    inputs[field.name] = /array/i.test(field.type) ? [{ id: mediaId, type: "image" }] : mediaId;
  }
  const credits = detail.price;
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null, plan: null as string | null, text: "" }));
  if (credits === null && !d.confirm) throw new StudioError(`The cost of "${detail.title}" is not known: Higgsfield names no price for it. Confirm it at an unknown cost, or pick another preset.`, 409, false, { needsEstimate: true, presetId: d.presetId });
  if (!d.confirm) throw new StudioError(`Confirm the run: about ${credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits, balance: bal.credits });
  const fingerprint = await sha256([MCP_PROVIDER, "preset", d.source, d.presetId, JSON.stringify(d.inputs), t.output].join("\n"));
  if (!(await claimSubmission(env, `preset:${b.id}:${d.index}:${fingerprint}`, CLAIM_TTL_MS))) throw new StudioError("This exact preset run was asked for a moment ago. Wait for it, or change its inputs.", 409);
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "preset.run",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: credits,
    status: "confirmed",
    note: `Preset "${detail.title}" (${d.source}${detail.command ? ` ${detail.command}` : ""}) · ${credits ?? "unknown"} credits (subscription, MCP)${credits === null ? " · cost unknown, confirmed" : ""}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}${d.note ? ` · ${d.note}` : ""}`,
  });
  const id = uuid();
  const base = {
    id,
    batch: b.id,
    post: d.index,
    task: t.id,
    owner: user.id,
    model: `preset:${d.presetId}`,
    prompt: typeof d.inputs.prompt === "string" ? d.inputs.prompt : (detail.prompt ?? detail.title),
    provider: MCP_PROVIDER,
    posterKey: t.output,
    source: "picture" as const,
    opId,
  };
  const settings = { preset: { id: d.presetId, name: detail.title, source: d.source, command: detail.command }, label: `Preset · ${detail.title}`, inputs: d.inputs, estimate: credits, credits, estimateSource: credits === null ? "confirmed" : "provider", unit: "credits", balanceBefore: bal.credits, plan: bal.plan, note: d.note, outcomeUnknown: false, jobIds: [] as string[] };
  let r: McpCallResult;
  try {
    r = await mcp.call("execute_preset", { source: d.source, preset_id: d.presetId, inputs });
  } catch (e) {
    const timeout = e instanceof Error && (/TimeoutError|AbortError/.test(e.name) || /timed? ?out/i.test(e.message));
    if (timeout) {
      const note = "Higgsfield did not answer in time: the preset may still have started, so nothing was sent again. The version stays queued and is given up after half an hour if no job id can be learned; check the balance and the Higgsfield history.";
      await insertVideoRow(env, { ...base, status: "queued", requestId: null, error: null, settings: { ...settings, outcomeUnknown: true } });
      await updateIntegrationOp(env, opId, { status: "running", note: `outcome unknown (timeout) · ${note}` });
      throw new StudioError(note, 504, false, { outcomeUnknown: true, videoId: id });
    }
    const message = errorMessage(e).slice(0, 400);
    await insertVideoRow(env, { ...base, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw e;
  }
  if (unlimChoiceIn(r)) {
    await updateIntegrationOp(env, opId, { status: "proposed", note: "waiting for the unlimited-allowance choice; nothing submitted" });
    throw new StudioError(`Higgsfield asks whether "${detail.title}" should use the unlimited allowance or pay credits. Run it from the Generate panel with that choice, or try another preset.`, 409, false, { unlimChoice: unlimChoiceIn(r), credits });
  }
  const jobs = parseJobs(r);
  if (r.isError || !jobs.length) {
    const message = `Higgsfield did not start the preset: ${resultText(r).slice(0, 300) || "no job id in the answer"}`;
    await insertVideoRow(env, { ...base, status: "failed", requestId: null, error: message, settings });
    await updateIntegrationOp(env, opId, { status: "failed", note: message });
    throw new StudioError(message, 502);
  }
  await insertVideoRow(env, { ...base, status: "queued", requestId: jobs[0].jobId, error: null, settings: { ...settings, jobIds: jobs.map((j) => j.jobId) } });
  // Several jobs: the first is the version's job id; the others are kept in its settings (`jobIds`).
  await updateIntegrationOp(env, opId, { taskId: jobs[0].jobId, status: "running" });
  return versionItem(env, b.id, d.index, id);
}

videoPresetRoutes.post("/run", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return c.json({ ok: true, video: await runPreset(c.env, user, parsed.data) });
});
