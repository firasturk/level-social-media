/**
 * The Photo studio's preset gallery: pictures only, with the provider's own sample picture on each
 * card (hotlinked, never copied here), as the Video studio's gallery shows clips
 * (server/video-presets.ts). Four categories: Styles (Higgsfield's Soul 2.0 picture styles,
 * `get_presets {source: "soul"}`; "Use this style" fills the AI tools' Generate form), Product
 * shots (`get_presets {source: "marketing_studio", category: "product-shot"}`, runnable through
 * `execute_preset` on the post's picture), Magnific looks (`images_models_list` and
 * `images_upscale_presets_list`; a look with no sample says so) and Recipes
 * (`get_preset_instructions {}`). Anything whose type says video is dropped; a pseudo entry that
 * is only a category name ("All", "Motion", "Product shot", "Effects") never becomes a card.
 * Cached a day per category in an encrypted settings row; `?refresh=1` asks again. Members browse;
 * an admin runs a product-shot preset on the subscription credits with the usual rules (switch,
 * confirm before spend, a claim, a ledger row `preset.run` in credits, no retry); the run is a
 * `photo_tool_jobs` row the AI tools settler collects.
 *
 * Routes (mounted at /api/studio/photo/presets):
 *   GET  /            ?category=&q=&refresh=1        the cards of a category (every member)
 *   GET  /:id         ?source=&batch=&index=         one entry with its inputs, readiness, price and instructions
 *   POST /run         {batch, index, presetId, source, inputs?, confirm?}   admins
 *
 * Every answer shape is assumed from the tool descriptions and read defensively; the first live run
 * must check them (docs/photo-studio.md).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first } from "./db";
import type { Config } from "../shared/config";
import { setSetting } from "./settings";
import { readJsonSetting } from "./oauth-signin";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, switchedOffMessage } from "./integrations";
import { balanceOf, fetcher as higgsfieldFetcher, HiggsfieldMcp, higgsfieldSignIn, mediaFor, parseCost } from "./higgsfield-mcp";
/** The Higgsfield picture tools and styles run on the same sign-in as the videos. */
const NOT_SIGNED_IN = "Not signed in: Connection → Higgsfield → Sign in to Higgsfield. The picture styles and tools run on that sign-in, paid from the subscription credits.";
import { MagnificMcp, MCP_NOT_CONNECTED, tokenSource } from "./freepik-mcp";
import { fetchDetail, FULL_CATALOG_PAGES, imageInputOf, mediaOf, needsOf, parseRecipes, parseStudioV2, type StudioV2Entry } from "./video-presets";
import { STUDIO_V2_SOURCE } from "@shared/video-presets";
import { jsonOf, objectsWith, type McpCallResult } from "./mcp-client";
import { jobJson, magnificTools, parseMagnificEntries, startPhotoJob } from "./photo-tools";
import { isPhotoPresetCategory, NOTHING_IN_PHOTO_CATEGORY, PHOTO_PRESET_CATEGORIES, type PhotoPresetCard, type PhotoPresetCategoryId, type PhotoPresetDetail } from "@shared/photo-presets";
import type { PhotoToolJob } from "@shared/photo-tools";
import type { User } from "@shared/types";

type Variables = { user: User };
export const photoPresetRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const PHOTO_PRESETS_TTL_MS = 24 * 60 * 60 * 1000;
export const PHOTO_PRESETS_CACHE_PREFIX = "photo_presets_cache_";
const CLAIM_TTL_MS = 10 * 60 * 1000;

/* ───────────── Reading the answers ───────────── */

const VIDEO_URL_RE = /\.(mp4|webm|mov|m3u8)(\?|#|$)/i;
/** Names a category page would carry as a pseudo entry, never a preset. */
const PSEUDO_TITLES = /^(all|popular|trending|motion|motion design|product[- ]?shots?|effects?|viral|marketing|marketing studio|ads|paid ads|ugc|faceless|production|genjutsu|recipes?|styles?|new|featured)$/i;
/** Entry types that are not a picture. */
const VIDEO_TYPE_RE = /video|clip|motion|animation|animate|reel(?!-?cover)|footage|katana|genjutsu/i;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/** The sample picture of an entry: the still `mediaOf` finds, else any https link under a preview-ish key that is not a video. */
export function sampleImageOf(o: Record<string, unknown>): string | null {
  const { poster, video } = mediaOf(o);
  if (poster) return poster;
  for (const [k, v] of Object.entries(o)) {
    if (!/preview|thumb|image|cover|sample|example|photo|picture|media|url/i.test(k)) continue;
    const cands = Array.isArray(v) ? v : [v];
    for (const c of cands) {
      const u = typeof c === "string" ? c : c && typeof c === "object" ? ((c as Record<string, unknown>).url ?? (c as Record<string, unknown>).src ?? (c as Record<string, unknown>).image_url) : null;
      if (typeof u === "string" && /^https:\/\/\S+$/.test(u.trim()) && !VIDEO_URL_RE.test(u) && u !== video) return u.trim();
    }
  }
  return null;
}

/** Is the entry about a video (its type, output or mode), not a picture? */
export function saysVideo(o: Record<string, unknown>): boolean {
  const typed = [o.type, o.kind, o.output, o.output_type, o.outputType, o.media_type, o.mode, o.result_type].map(str).filter(Boolean);
  if (typed.some((t) => VIDEO_TYPE_RE.test(t))) return true;
  if (typed.some((t) => /image|photo|picture|still/i.test(t))) return false;
  const desc = `${str(o.description)} ${str(o.summary)}`;
  return /\b(video|clip|footage|animation)\b/i.test(desc) && !/\b(image|photo|picture|still|cover)\b/i.test(desc);
}

/** A real entry: an id, a title that is not a category name, and (for the provider catalogs) a sample picture. */
export function isRealEntry(o: Record<string, unknown>, needsImage: boolean): boolean {
  if ("job_id" in o || "properties" in o || ("url" in o && !("name" in o || "title" in o))) return false;
  const id = str(o.preset_id ?? o.style_id ?? o.id ?? o.slug);
  const title = str(o.name ?? o.title);
  if (!id || !title || PSEUDO_TITLES.test(title) || PSEUDO_TITLES.test(id.replace(/[_-]+/g, " "))) return false;
  return !needsImage || !!sampleImageOf(o);
}

function priceOf(o: Record<string, unknown>): number | null {
  for (const k of ["price", "credits", "cost", "price_credits", "credits_cost", "cost_credits", "estimated_credits"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  }
  return null;
}

function commandOf(o: Record<string, unknown>): string | null {
  const c = [o.command, o.slash_command, o.slash, o.cmd].find((v) => typeof v === "string" && v.trim());
  if (typeof c !== "string") return null;
  const t = c.trim().split(/\s+/)[0];
  return t.startsWith("/") ? t : `/${t}`;
}

/** The Soul 2.0 styles a `get_presets {source: "soul"}` answer lists: each id is the `style_id` for `generate_image` with `model: "soul_2"`. */
export function parseSoulStyles(r: McpCallResult): PhotoPresetCard[] {
  const j = jsonOf(r);
  const out: PhotoPresetCard[] = [];
  const seen = new Set<string>();
  for (const o of [...objectsWith(j, "style_id"), ...objectsWith(j, "preset_id"), ...objectsWith(j, "id"), ...objectsWith(j, "slug")]) {
    if (!isRealEntry(o, true) || saysVideo(o)) continue;
    const id = str(o.style_id ?? o.preset_id ?? o.id ?? o.slug);
    if (seen.has(id)) continue;
    seen.add(id);
    const title = str(o.name ?? o.title).slice(0, 120);
    const prompt = [o.prompt, o.default_prompt, o.prompt_template, o.example_prompt, o.suggested_prompt].map(str).find(Boolean) ?? null;
    out.push({
      id,
      source: "soul",
      provider: "higgsfield",
      kind: "style",
      title,
      description: str(o.description ?? o.summary ?? o.subtitle).slice(0, 600),
      command: commandOf(o),
      category: str(o.category) || null,
      type: str(o.type) || "style",
      image: sampleImageOf(o),
      price: priceOf(o),
      needs: ["this post's picture", "a few words of prompt"],
      runnable: false,
      prompt: prompt?.slice(0, 2000) ?? null,
      use: { provider: "higgsfield", tool: "hf-generate", options: { styleId: id, ...(prompt ? { prompt: prompt.slice(0, 2000) } : {}) } },
    });
  }
  return out;
}

/** The product-shot presets a Marketing Studio answer lists: picture output, runnable through `execute_preset`. */
export function parseProductShots(r: McpCallResult): PhotoPresetCard[] {
  const j = jsonOf(r);
  const out: PhotoPresetCard[] = [];
  const seen = new Set<string>();
  for (const o of [...objectsWith(j, "preset_id"), ...objectsWith(j, "id"), ...objectsWith(j, "slug")]) {
    if (!isRealEntry(o, true) || saysVideo(o)) continue;
    const id = str(o.preset_id ?? o.id ?? o.slug);
    if (seen.has(id)) continue;
    seen.add(id);
    const exec = (o.execution && typeof o.execution === "object" ? o.execution : null) as Record<string, unknown> | null;
    const schema = exec?.input_schema ?? o.input_schema ?? o.inputs ?? null;
    const prompt = [o.prompt, o.default_prompt, o.prompt_template, o.example_prompt].map(str).find(Boolean) ?? null;
    out.push({
      id,
      source: str(o.source) || "marketing_studio",
      provider: "higgsfield",
      kind: "preset",
      title: str(o.name ?? o.title).slice(0, 120),
      description: str(o.description ?? o.summary ?? o.subtitle).slice(0, 600),
      command: commandOf(o),
      category: str(o.category) || "product-shot",
      type: str(o.type) || null,
      image: sampleImageOf(o),
      price: priceOf(o),
      needs: needsOf(schema),
      runnable: exec?.available !== false,
      prompt: prompt?.slice(0, 2000) ?? null,
      use: null,
    });
  }
  return out;
}

/** Magnific's picture models and upscale presets as looks; an entry with no sample keeps its name and says so in the card. */
export function parseMagnificLooks(models: McpCallResult | null, presets: McpCallResult | null): PhotoPresetCard[] {
  const out: PhotoPresetCard[] = [];
  const seen = new Set<string>();
  const push = (card: PhotoPresetCard) => {
    const key = `${card.category}:${card.id}`;
    if (seen.has(key) || PSEUDO_TITLES.test(card.title)) return;
    seen.add(key);
    out.push(card);
  };
  if (presets)
    for (const e of parseMagnificEntries(presets))
      push({ id: e.id, source: "magnific", provider: "magnific", kind: "look", title: e.label, description: e.description, command: null, category: "upscale preset", type: "upscale", image: e.image, price: null, needs: ["this post's picture"], runnable: false, prompt: null, use: { provider: "magnific", tool: "mg-upscale", options: { preset: e.id } } });
  if (models)
    for (const e of parseMagnificEntries(models)) {
      if (VIDEO_TYPE_RE.test(`${e.id} ${e.label}`) && !/image|photo/i.test(`${e.id} ${e.label}`)) continue;
      push({ id: e.id, source: "magnific", provider: "magnific", kind: "look", title: e.label, description: e.description, command: null, category: "picture model", type: "model", image: e.image, price: null, needs: ["this post's picture", "a few words of prompt"], runnable: false, prompt: null, use: { provider: "magnific", tool: "mg-restyle", options: { model: e.id } } });
    }
  return out;
}

/** The recipes `get_preset_instructions {}` lists, picture ones only (/hero-shot, /reel-cover…); read-only cards. */
export function parsePhotoRecipes(r: McpCallResult): PhotoPresetCard[] {
  // The Video studio's reader keeps every recipe with `all: true` (its default, on the videos-only gallery, keeps video recipes only); the picture ones are filtered here.
  const every = parseRecipes as (r: McpCallResult, opts?: { all?: boolean }) => ReturnType<typeof parseRecipes>;
  return every(r, { all: true })
    .filter((c) => !VIDEO_TYPE_RE.test(`${c.type ?? ""} ${c.category ?? ""}`) && !/\b(video|clip|footage|animation|katana)\b/i.test(`${c.command ?? ""} ${c.description}`))
    .map((c) => ({
      id: c.id,
      source: "recipe",
      provider: "higgsfield" as const,
      kind: "recipe" as const,
      title: c.title,
      description: c.description,
      command: c.command,
      category: c.category,
      type: c.type,
      image: c.poster,
      price: null,
      needs: c.needs,
      runnable: false,
      prompt: c.prompt,
      use: c.prompt ? { provider: "higgsfield" as const, tool: "hf-generate", options: { prompt: c.prompt } } : null,
    }));
}

/** A search across what a card says (the gallery's search box uses the same rule in the browser). */
export function matchesPhoto(c: PhotoPresetCard, q: string): boolean {
  const t = q.toLowerCase();
  return [c.title, c.description, c.command ?? "", c.category ?? "", c.type ?? "", c.source].some((s) => s.toLowerCase().includes(t));
}

/* ───────────── The cache: a day per category, encrypted like every setting ───────────── */

interface CachedCategory {
  at: number;
  items: PhotoPresetCard[];
}

const memo = new Map<string, CachedCategory>();
export function resetPhotoPresetCaches(): void {
  memo.clear();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export const photoCacheKey = (category: string, q: string) => `${PHOTO_PRESETS_CACHE_PREFIX}${category}${q ? `_q_${slug(q)}` : ""}`;

async function readCache(env: Env, key: string): Promise<CachedCategory | null> {
  const m = memo.get(key);
  if (m && Date.now() - m.at < PHOTO_PRESETS_TTL_MS) return m;
  const stored = await readJsonSetting<CachedCategory>(env, key);
  if (stored && Array.isArray(stored.items) && typeof stored.at === "number" && Date.now() - stored.at < PHOTO_PRESETS_TTL_MS) {
    memo.set(key, stored);
    return stored;
  }
  return null;
}

async function writeCache(env: Env, key: string, value: CachedCategory): Promise<void> {
  memo.set(key, value);
  await setSetting(env, key, JSON.stringify(value));
}

/** The words of a refused tool call, for the error the person sees. */
function errorTextOf(r: McpCallResult): string {
  const t = r.content.map((c) => (typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join(" ").trim();
  return t.slice(0, 200) || "no details";
}

/* ───────────── Asking the providers ───────────── */

/** The Marketing Studio widget tab a photo category reads, and the picture type its presets are made with. */
export const STUDIO_V2_PHOTO_TABS: Partial<Record<PhotoPresetCategoryId, string>> = { ads: "ads", posters: "posters", marketplace: "marketplace" };

/** A widget picture preset as a card: run with Marketing Studio's picture model and the preset's id, on the post's product picture. */
export function studioV2PhotoCard(e: StudioV2Entry, tab: string): PhotoPresetCard {
  return {
    id: e.id,
    source: STUDIO_V2_SOURCE,
    provider: "higgsfield",
    kind: "preset",
    title: e.name,
    description: `Marketing Studio ${tab}${e.group ? ` · ${e.group}` : ""}: recreated with this post's product picture.`,
    command: null,
    category: tab,
    type: e.type || null,
    image: e.image,
    price: null,
    needs: ["1 product picture"],
    runnable: !!e.type,
    prompt: null,
    use: null,
  };
}

export async function fetchHiggsfieldCategory(mcp: HiggsfieldMcp, category: Exclude<PhotoPresetCategoryId, "magnific-looks">, q: string): Promise<PhotoPresetCard[]> {
  if (category === "recipes") {
    const r = await mcp.call("get_preset_instructions", {});
    const items = parsePhotoRecipes(r);
    return q ? items.filter((c) => matchesPhoto(c, q)) : items;
  }
  const tab = STUDIO_V2_PHOTO_TABS[category];
  if (tab) {
    // The widget lists the first twelve of a tab and takes no page.
    const r = await mcp.call("show_marketing_studio_v2", { category: tab });
    if (r.isError) throw new StudioError(`Higgsfield refused the Marketing Studio list: ${errorTextOf(r)}`, 502);
    const items = parseStudioV2(r)
      .filter((e) => e.image && !e.video)
      .map((e) => studioV2PhotoCard(e, tab));
    return q ? items.filter((c) => matchesPhoto(c, q)) : items;
  }
  // The gallery takes at most 50 per page (the server refuses more): every page is read, so the whole catalog shows (418 product shots on 24 Oct).
  const args: Record<string, unknown> = category === "styles" ? { source: "soul", limit: 50 } : { source: "marketing_studio", category: "product-shot", limit: 50 };
  if (q) args.query = q;
  let items: PhotoPresetCard[] = [];
  const seen = new Set<string>();
  let cursor: unknown = null;
  for (let page = 0; page < FULL_CATALOG_PAGES; page++) {
    const r = await mcp.call("get_presets", cursor === null ? args : { ...args, cursor });
    if (r.isError) {
      if (page === 0) throw new StudioError(`Higgsfield refused the preset list: ${errorTextOf(r)}`, 502);
      break;
    }
    const more = (category === "styles" ? parseSoulStyles(r) : parseProductShots(r)).filter((x) => !seen.has(x.id));
    for (const x of more) seen.add(x.id);
    items = items.concat(more);
    const next = (jsonOf(r) as { next_cursor?: unknown } | null)?.next_cursor;
    if (!more.length || (typeof next !== "number" && typeof next !== "string") || next === cursor) break;
    cursor = next;
  }
  return q ? items.filter((c) => matchesPhoto(c, q)) : items;
}

export async function fetchMagnificLooks(mcp: MagnificMcp, q: string): Promise<PhotoPresetCard[]> {
  const tools = await magnificTools(mcp);
  const ask = async (name: string, args: Record<string, unknown> = {}) => {
    if (!tools.has(name)) return null;
    const r = await mcp.callTool(name, args);
    return r.isError ? null : r;
  };
  const items = parseMagnificLooks(await ask("images_models_list", { includePreviews: true }), await ask("images_upscale_presets_list"));
  return q ? items.filter((c) => matchesPhoto(c, q)) : items;
}

/** How old a category's stored list is (ms), or null when none is stored. */
export async function photoCacheAge(env: Env, category: PhotoPresetCategoryId): Promise<number | null> {
  const stored = await readJsonSetting<CachedCategory>(env, photoCacheKey(category, ""));
  return stored && typeof stored.at === "number" ? Date.now() - stored.at : null;
}

/** A Higgsfield category read again and stored for the day (the cron's daily refresh). An empty answer is not stored. */
export async function refreshPhotoCategory(env: Env, mcp: HiggsfieldMcp, category: Exclude<PhotoPresetCategoryId, "magnific-looks">): Promise<number> {
  const items = await fetchHiggsfieldCategory(mcp, category, "");
  if (items.length) await writeCache(env, photoCacheKey(category, ""), { at: Date.now(), items });
  return items.length;
}

/* ───────────── Routes ───────────── */

/** The cards of a category: the cache for a day, else the provider (signed in, switch on). Every member. */
photoPresetRoutes.get("/", async (c) => {
  const user = c.get("user");
  const category = c.req.query("category") ?? "styles";
  if (!isPhotoPresetCategory(category)) throw new StudioError("Unknown preset category.");
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const refresh = c.req.query("refresh") === "1";
  const cat = PHOTO_PRESET_CATEGORIES.find((x) => x.id === category)!;
  const provider = cat.provider === "higgsfield" ? "higgsfield" : "freepik";
  const access = await integrationAccess(c.env, user, provider);
  const signedIn = cat.provider === "higgsfield" ? await higgsfieldSignIn.isSignedIn(c.env) : (await tokenSource(c.env)) !== null;
  const base = { ok: true, category, categories: PHOTO_PRESET_CATEGORIES, provider: cat.provider, signedIn, admin: user.role === "admin", access, empty: NOTHING_IN_PHOTO_CATEGORY };
  const key = photoCacheKey(category, q);
  if (!refresh) {
    const hit = await readCache(c.env, key);
    if (hit) return c.json({ ...base, items: hit.items, cachedAt: hit.at, cached: true, reason: "" });
  }
  if (!signedIn) return c.json({ ...base, items: [], cachedAt: null, cached: false, reason: cat.provider === "higgsfield" ? NOT_SIGNED_IN : MCP_NOT_CONNECTED });
  if (!access.enabled) return c.json({ ...base, items: [], cachedAt: null, cached: false, reason: switchedOffMessage(provider) });
  let items: PhotoPresetCard[];
  if (cat.provider === "higgsfield") {
    const mcp = new HiggsfieldMcp(c.env, higgsfieldFetcher());
    await mcp.connect();
    items = await fetchHiggsfieldCategory(mcp, category as Exclude<PhotoPresetCategoryId, "magnific-looks">, q);
  } else {
    const mcp = await MagnificMcp.open(c.env);
    if (!mcp) return c.json({ ...base, items: [], cachedAt: null, cached: false, reason: MCP_NOT_CONNECTED });
    items = await fetchMagnificLooks(mcp, q);
  }
  const at = Date.now();
  // An empty answer is not kept for a day: the next visit asks again (a refusal or a changed answer shape would otherwise stick).
  if (items.length) await writeCache(c.env, key, { at, items });
  await recordIntegrationOp(c.env, { provider, kind: "preset.browse", user: user.id, estimate: 0, reported: 0, status: "done", note: `photo · ${category}${q ? ` · "${q}"` : ""} · ${items.length} ${items.length === 1 ? "entry" : "entries"} (browsing, nothing spent)` });
  return c.json({ ...base, items, cachedAt: at, cached: false, reason: "" });
});

async function cardFromCache(env: Env, id: string, source: string): Promise<PhotoPresetCard | null> {
  const categories: PhotoPresetCategoryId[] = source === "soul" ? ["styles"] : source === "magnific" ? ["magnific-looks"] : source === "recipe" ? ["recipes"] : source === STUDIO_V2_SOURCE ? ["ads", "posters", "marketplace"] : ["product-shots"];
  for (const category of categories) {
    const hit = await readCache(env, photoCacheKey(category, ""));
    const card = hit?.items.find((c) => c.id === id);
    if (card) return card;
  }
  return null;
}

/** The clean picture of the product a preset's "Product image" gets, when the studio has one. */
export interface ProductPicture {
  key: string;
  name: string;
  /** "the post's product photo" (the month's product photo the post names) or "the client's Drive" (the original the post's picture was copied from). */
  from: string;
}

/**
 * What the product in the post's picture is, for a preset run, from what the studio already knows
 * (no text call, nothing paid): the post's product photo and its note, else the Drive file the
 * picture was copied from (the copy keeps its Drive id; an edited picture is traced through the
 * post's first takes), else the post's title. Only the product: never the post's scene or the brand's
 * photography, which would pull the result back to the post's own scene instead of the preset's (live:
 * "Chilled Can" came back in the post's shelf scene because its idea was sent). The same lookup names
 * the clean product picture the preset's product input gets instead of the post's whole picture.
 */
export async function productBrief(env: Env, user: User, batchId: string, index: number): Promise<{ text: string; from: string[]; picture: ProductPicture | null }> {
  const b = await ownedPlan(env, user, batchId);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === index);
  const from: string[] = [];
  let name = "";
  let note = "";
  let picture: ProductPicture | null = null;
  const clean = (n: string | null | undefined) => (n ?? "").trim().replace(/[.\s]+$/, "");
  const wanted = post?.product ?? post?.products?.[0];
  if (wanted) {
    const src = await first<{ name: string; note: string | null; key: string }>(env.DB, "SELECT name, note, key FROM sources WHERE batch = ? AND kind = 'product' AND (lower(stem) = lower(?) OR lower(name) = lower(?)) ORDER BY created LIMIT 1", b.id, wanted, wanted);
    if (src) {
      name = src.name.replace(/\.[a-z0-9]+$/i, "");
      note = clean(src.note);
      picture = { key: src.key, name: src.name, from: "the post's product photo" };
      from.push("the post's product photo");
    }
  }
  const keys = [
    ...(await all<{ output: string | null }>(env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, index)).map((r) => r.output),
    ...(await all<{ key: string | null }>(env.DB, "SELECT key FROM post_takes WHERE batch = ? AND post = ? AND key IS NOT NULL ORDER BY created ASC LIMIT 3", b.id, index)).map((r) => r.key),
  ].filter((k): k is string => !!k);
  if (!name || !picture) {
    for (const key of [...new Set(keys)]) {
      const head = await env.BUCKET.head(key).catch(() => null);
      const drive = head?.customMetadata?.drive;
      if (!drive) continue;
      const photo = await first<{ name: string; note: string; kind: string | null }>(env.DB, "SELECT name, note, kind FROM drive_photos WHERE id = ?", drive);
      if (!photo) continue;
      if (!name && (photo.name || photo.note)) {
        name = photo.name.replace(/\.[a-z0-9]+$/i, "");
        note = clean(photo.note);
        from.push("the client's Drive");
      }
      // A Drive original stands in as the product picture only when it is a product shot, not a scene.
      if (!photo.kind || /product|drink|food|dessert|pack/i.test(photo.kind)) picture ??= { key, name: photo.name || "the Drive original", from: "the client's Drive" };
      break;
    }
  }
  if (!name && wanted) {
    name = wanted;
    from.push("the post's product name");
  }
  // "Post 3" and a file's name ("01-talk", "IMG_2041") say nothing about the product.
  if (!name && post?.title && !/^post \d+$/i.test(post.title) && !/^[\w.-]*\d[\w.-]*$/.test(post.title.trim())) {
    name = post.title;
    from.push("the post's title");
  }
  const client = config.client ? await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", config.client) : null;
  const parts: string[] = [];
  const who = client?.name ? `${client.name}'s product` : "The product";
  if (name || note) parts.push(`${who}: ${[name, note].filter(Boolean).join(" — ")}.`);
  parts.push("It is the item in the product picture: keep it exactly as it is (shape, cup or packaging, label, logo, colours and proportions); do not redraw, replace or relabel it.");
  parts.push("Use this preset's own scene, setting, people, light and background; take nothing else from the product picture.");
  return { text: parts.join(" ").slice(0, 900), from, picture };
}

/** The product, in words, for the "The product" box of a preset run (filled in, editable). Every member; nothing is called. */
photoPresetRoutes.get("/product", async (c) => {
  const index = Number(c.req.query("index"));
  if (!Number.isInteger(index) || index < 1) throw new StudioError("Which post?");
  return c.json({ ok: true, ...(await productBrief(c.env, c.get("user"), c.req.query("batch") ?? "", index)) });
});

/** One entry in full: a product shot's inputs, readiness (the post's picture prefilled for an admin), price and instructions; a style or a look from the cached list; a recipe's instructions. Every member. */
photoPresetRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const source = c.req.query("source") || "marketing_studio";
  const cached = await cardFromCache(c.env, id, source);
  if (source === "soul" || source === "magnific" || source === STUDIO_V2_SOURCE) {
    if (!cached) throw new StudioError("That entry is not in today's list: open the category again.", 404);
    const instructions = source === STUDIO_V2_SOURCE ? "Recreated by Higgsfield's Marketing Studio picture model from this post's product picture (the clean product photo when the post has one). Its price is asked from Higgsfield before you confirm." : "";
    // Marketing Studio's ads and marketplace pictures take a few words of notes (the product, the offer); posters take none.
    const notes = source === STUDIO_V2_SOURCE && (cached.type === "ads" || cached.type === "marketplace") ? { properties: { notes: { type: "string", title: "Notes for the design (the offer, the headline)" } }, required: [] } : null;
    const detail: PhotoPresetDetail = { ...cached, inputSchema: notes, readiness: null, available: source === STUDIO_V2_SOURCE ? cached.runnable : null, instructions };
    return c.json({ ok: true, preset: detail, readinessError: "", admin: user.role === "admin" });
  }
  if (!(await higgsfieldSignIn.isSignedIn(c.env))) throw new StudioError(NOT_SIGNED_IN, 409, false, { notSignedIn: true });
  await assertIntegrationEnabled(c.env, "higgsfield");
  const mcp = new HiggsfieldMcp(c.env, higgsfieldFetcher());
  await mcp.connect();
  let d = await fetchDetail(mcp, id, source === "recipe" ? "recipe" : source);
  let readinessError = "";
  const batch = c.req.query("batch");
  const index = Number(c.req.query("index"));
  if (user.role === "admin" && source !== "recipe" && batch && Number.isInteger(index) && index > 0 && d.runnable && d.inputSchema) {
    try {
      const b = await ownedPlan(c.env, user, batch);
      const t = await first<{ output: string | null }>(c.env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, index);
      const field = imageInputOf(d.inputSchema);
      if (t?.output && field) {
        const mediaId = await mediaFor(c.env, mcp, t.output, "image");
        const ready = await fetchDetail(mcp, id, source, { [field.name]: [{ id: mediaId, type: "image" }] });
        d = { ...d, readiness: ready.readiness ?? d.readiness, available: ready.available ?? d.available };
      }
    } catch (e) {
      readinessError = errorMessage(e);
    }
  }
  const detail: PhotoPresetDetail = {
    id: d.id,
    source: source === "recipe" ? "recipe" : d.source,
    provider: "higgsfield",
    kind: source === "recipe" ? "recipe" : "preset",
    title: d.title,
    description: d.description,
    command: d.command,
    category: d.category,
    type: d.type,
    image: cached?.image ?? d.poster,
    price: d.price,
    needs: d.needs,
    runnable: source !== "recipe" && d.runnable,
    prompt: d.prompt,
    use: cached?.use ?? (d.prompt ? { provider: "higgsfield", tool: "hf-generate", options: { prompt: d.prompt } } : null),
    inputSchema: d.inputSchema,
    readiness: d.readiness,
    available: d.available,
    instructions: d.instructions,
  };
  return c.json({ ok: true, preset: detail, readinessError, admin: user.role === "admin" });
});

const inputValue = z.union([z.string().max(5000), z.number(), z.boolean()]);
const runSchema = z.object({
  batch: z.string().min(1),
  index: z.number().int().min(1).max(200),
  presetId: z.string().min(1).max(200),
  source: z.string().min(1).max(40).default("marketing_studio"),
  inputs: z.record(z.string().max(80), inputValue).default({}),
  confirm: z.boolean().optional(),
  /** The preset's product picture: the post's clean product photo (default, when there is one) or the post's whole picture. */
  picture: z.enum(["product", "post"]).optional(),
});
export type PhotoPresetRun = z.infer<typeof runSchema>;

/**
 * A product-shot preset on the post's picture, on the subscription credits: the detail's price is
 * the estimate (none → "cost not known" until confirmed), the picture fills the preset's picture
 * input, the same ask within ten minutes is refused, one ledger row, `execute_preset` once; the job
 * becomes a `photo_tool_jobs` row the AI tools panel shows. Admins.
 */
export async function runPhotoPreset(env: Env, user: User, d: PhotoPresetRun): Promise<PhotoToolJob> {
  if (previewNoImages(env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  if (d.source === "recipe" || d.source === "soul" || d.source === "magnific") throw new StudioError(d.source === "recipe" ? "A recipe is a set of steps, not one run: use its words under AI tools." : "A style or a look is used from AI tools, not run here.", 400, false, { notRunnable: true });
  if (d.source === STUDIO_V2_SOURCE) return runStudioV2Photo(env, user, d);
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const mcp = new HiggsfieldMcp(env, higgsfieldFetcher());
  await mcp.connect();
  await mcp.requireTool("execute_preset");
  const detail = await fetchDetail(mcp, d.presetId, d.source);
  if (!detail.runnable) throw new StudioError(`"${detail.title}" cannot be run from here${detail.available === false ? " (Higgsfield says it is not available)" : ""}.`, 409, false, { notRunnable: true });
  const inputs: Record<string, unknown> = { ...d.inputs };
  const field = imageInputOf(detail.inputSchema);
  // A "Product image" input gets the clean product photo when the post has one (the post's whole
  // picture would bring its scene along); "the post's picture" when asked, or when there is none.
  const productInput = !!field && /product/i.test(`${field.name} ${field.description}`);
  const clean = productInput && d.picture !== "post" ? (await productBrief(env, user, d.batch, d.index)).picture : null;
  const sent = clean?.key ?? t.output;
  if (field && inputs[field.name] === undefined) {
    const mediaId = await mediaFor(env, mcp, sent, "image");
    inputs[field.name] = /array/i.test(field.type) ? [{ id: mediaId, type: "image" }] : mediaId;
  }
  const credits = detail.price;
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  if (credits === null && !d.confirm) throw new StudioError(`The cost of "${detail.title}" is not known: Higgsfield names no price for it. Confirm it at an unknown cost, or pick another preset.`, 409, false, { needsEstimate: true, presetId: d.presetId, balance: bal.credits });
  if (!d.confirm) throw new StudioError(`Confirm the run: about ${credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits, balance: bal.credits });
  const fp = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(["photo-preset", d.source, d.presetId, JSON.stringify(d.inputs), sent].join("\n"))))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (!(await claimSubmission(env, `photopreset:${b.id}:${d.index}:${fp}`, CLAIM_TTL_MS))) throw new StudioError("This exact preset run was asked for a moment ago. Wait for it, or change its inputs.", 409);
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "preset.run",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: credits,
    status: "confirmed",
    note: `Picture preset "${detail.title}" (${d.source}${detail.command ? ` ${detail.command}` : ""}) · ${credits ?? "unknown"} credits (subscription, MCP)${credits === null ? " · cost unknown, confirmed" : ""}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}`,
  });
  const options: Record<string, string> = Object.fromEntries(Object.entries(d.inputs).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, String(v)]));
  const row = await startPhotoJob(env, {
    b,
    t: { id: t.id, output: t.output },
    post: d.index,
    user,
    provider: "higgsfield",
    tool: `preset:${d.presetId}`,
    label: `Preset · ${detail.title}`,
    options,
    estimate: credits,
    balanceBefore: bal.credits,
    opId,
    mcpTool: "execute_preset",
    args: { source: d.source, preset_id: d.presetId, inputs },
    notes: clean ? [`product picture: ${clean.name} (${clean.from})`] : [],
    call: () => mcp.call("execute_preset", { source: d.source, preset_id: d.presetId, inputs }),
    fetchFn: higgsfieldFetcher(),
    balanceAfter: async () => (await balanceOf(mcp, true)).credits,
  });
  return jobJson(row);
}

/** Marketing Studio's picture model, for the widget's ads, posters and marketplace presets. */
export const STUDIO_V2_IMAGE_MODEL = "marketing_studio_2_image";

/** The request a widget picture preset runs with: its type and id, the product picture, the words as notes where the type takes them. */
export function studioV2ImageParams(card: Pick<PhotoPresetCard, "id" | "type">, mediaId: string, words: string): Record<string, unknown> {
  const params: Record<string, unknown> = { model: STUDIO_V2_IMAGE_MODEL, type: card.type, preset_id: card.id, medias: [{ value: mediaId, role: "product_image" }], count: 1 };
  if (words.trim() && (card.type === "ads" || card.type === "marketplace")) params.notes = words.trim().slice(0, 5000);
  return params;
}

/**
 * A Marketing Studio ad, poster or marketplace picture on the post's product picture: the price
 * asked first (`get_cost`, nothing submitted), the confirm, one claim, a ledger row, `generate_image`
 * once; the job becomes a `photo_tool_jobs` row the AI tools panel shows. Admins.
 */
async function runStudioV2Photo(env: Env, user: User, d: PhotoPresetRun): Promise<PhotoToolJob> {
  const card = await cardFromCache(env, d.presetId, STUDIO_V2_SOURCE);
  if (!card || !card.type) throw new StudioError("That preset is not in today's list: open the category again.", 404);
  const b = await ownedPlan(env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const mcp = new HiggsfieldMcp(env, higgsfieldFetcher());
  await mcp.connect();
  await mcp.requireTool("generate_image");
  const clean = d.picture !== "post" ? (await productBrief(env, user, d.batch, d.index)).picture : null;
  const sent = clean?.key ?? t.output;
  const mediaId = await mediaFor(env, mcp, sent, "image");
  const words = Object.values(d.inputs).filter((v): v is string => typeof v === "string").join("\n");
  const params = studioV2ImageParams(card, mediaId, words);
  const quote = await mcp.call("generate_image", { params: { ...params, get_cost: true } });
  const credits = quote.isError ? null : parseCost(quote);
  const bal = await balanceOf(mcp).catch(() => ({ credits: null as number | null }));
  if (credits === null && !d.confirm) throw new StudioError(`The cost of "${card.title}" is not known: Higgsfield gave no figure. Confirm it at an unknown cost, or pick another preset.`, 409, false, { needsEstimate: true, presetId: d.presetId, balance: bal.credits });
  if (!d.confirm) throw new StudioError(`Confirm the run: about ${credits} credits from the subscription balance${bal.credits !== null ? ` (${bal.credits} available)` : ""}.`, 409, false, { needsConfirm: true, credits, balance: bal.credits });
  const fp = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(["photo-preset-v2", d.presetId, words, sent].join("\n"))))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (!(await claimSubmission(env, `photopreset:${b.id}:${d.index}:${fp}`, CLAIM_TTL_MS))) throw new StudioError("This exact preset run was asked for a moment ago. Wait for it, or change its inputs.", 409);
  const opId = await recordIntegrationOp(env, {
    provider: "higgsfield",
    kind: "preset.run",
    user: user.id,
    batch: b.id,
    post: d.index,
    estimate: credits,
    status: "confirmed",
    note: `Marketing Studio ${card.category ?? "picture"} "${card.title}" · ${credits ?? "unknown"} credits (subscription, MCP)${credits === null ? " · cost unknown, confirmed" : ""}${bal.credits !== null ? ` · balance before ${bal.credits}` : ""}`,
  });
  const row = await startPhotoJob(env, {
    b,
    t: { id: t.id, output: t.output },
    post: d.index,
    user,
    provider: "higgsfield",
    tool: `preset:${d.presetId}`,
    label: `Preset · ${card.title}`,
    options: words.trim() ? { notes: words.trim().slice(0, 500) } : {},
    estimate: credits,
    balanceBefore: bal.credits,
    opId,
    mcpTool: "generate_image",
    args: { params },
    notes: clean ? [`product picture: ${clean.name} (${clean.from})`] : [],
    call: () => mcp.call("generate_image", { params }),
    fetchFn: higgsfieldFetcher(),
    balanceAfter: async () => (await balanceOf(mcp, true)).credits,
  });
  return jobJson(row);
}

photoPresetRoutes.post("/run", async (c) => {
  const user = requireIntegrationAdmin(c, "higgsfield");
  await assertIntegrationEnabled(c.env, "higgsfield");
  const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return c.json({ ok: true, job: await runPhotoPreset(c.env, user, parsed.data) });
});
