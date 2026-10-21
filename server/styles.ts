/**
 * The style library: Pinterest pins read into reusable product-photo styles, in categories, paged
 * and searchable, with no fixed size. It grows by itself every day (new pins collected and read on
 * the cron), and the team adds its own pins, removes styles and asks for fresh ones.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { askText } from "./posts";
import { getSetting, setSetting } from "./settings";
import type { User } from "@shared/types";
import { gridSummary, type GridRead } from "@shared/posts";
import {
  describeStyleInstruction,
  GRID_STYLE_SCHEMA,
  gridStyleInstruction,
  parseGridStyle,
  parseStyle,
  PHOTO_CATEGORY_IDS,
  pictureSig,
  seasonWords,
  STYLE_CATEGORIES,
  STYLE_CATEGORY_IDS,
  STYLE_KINDS,
  STYLE_PAGE_SIZE,
  STYLE_QUERIES,
  STYLE_SCHEMA,
  TREND_DAYS,
  type StyleCategory,
  type StyleItem,
  type StyleKind,
  GRID_GENRES,
  gridGenre,
} from "@shared/styles";

type Variables = { user: User };
export const styleRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Pins read at once (each is one vision call). */
const READ_AT_ONCE = 6;
/** New pins read a day by the cron, a few each minute. */
const DAILY_READS = 160;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export interface StyleRow {
  id: string;
  kind: StyleKind;
  status: string;
  title: string;
  prompt: string;
  tags: string;
  pin: string | null;
  source: string;
  note: string;
  image_key: string | null;
  thumb_key: string | null;
  position: number;
  created: number;
  updated: number;
  score: number;
  w: number;
  h: number;
  category: string;
  tiles: number;
  /** The client a suggested grid was found for ('' for the shared library). */
  client: string;
}

function toItem(r: StyleRow, admin: boolean, clientNames: Map<string, string> = new Map()): StyleItem {
  return {
    genre: r.category === "grid" ? gridGenre(r.tags) : undefined,
    clientName: r.client ? clientNames.get(r.client) : undefined,
    id: r.id,
    kind: r.kind,
    category: (r.category as StyleCategory) || "",
    created: r.created,
    title: r.title,
    tags: r.tags,
    ...(admin ? { prompt: r.prompt } : {}),
    position: r.position,
    updated: r.updated,
    score: r.score,
    w: r.w,
    h: r.h,
    tiles: r.tiles ?? 0,
    client: r.client || undefined,
    waiting: r.status === "review" || undefined,
  };
}

/** One page of the library: a tab (all, trends or a category), a search and a page number. */
async function list(env: Env, user: User, opts: { tab?: string; q?: string; page?: number; client?: string; genre?: string } = {}) {
  const admin = user.role === "admin";
  // The admin's queue: what the daily update and New ideas brought, waiting for approval.
  // The admin's queue, whole or split into grids and photo styles (the Approvals page).
  const reviewing = admin && (opts.tab === "review" || opts.tab === "review-grid" || opts.tab === "review-style");
  // A client's own collection ("Add to Habibah's"): its styles and grids, approved or not.
  const saved = opts.tab === "saved" && !!opts.client;
  // Everywhere else, the team (the admin picking a grid too) sees only what the admin approved.
  const where = [reviewing ? "status = 'review'" : saved ? "status IN ('active', 'review')" : "status = 'active'"];
  const args: unknown[] = [];
  const trendsFrom = now() - TREND_DAYS * 86_400_000;
  if (reviewing) {
    if (opts.tab === "review-grid") where.push("category = 'grid'");
    if (opts.tab === "review-style") where.push("category != 'grid'");
  } else if (saved) {
    where.push("id IN (SELECT style FROM client_styles WHERE client = ?)");
    args.push(opts.client);
  } else if (opts.tab === "trends") {
    where.push("created >= ?", "category != 'grid'");
    args.push(trendsFrom);
  } else if (opts.tab === "grid-new") {
    // New: the grids of the last two weeks.
    where.push("category = 'grid'", "created >= ?");
    args.push(trendsFrom);
  } else if (opts.tab && STYLE_CATEGORY_IDS.includes(opts.tab as StyleCategory)) {
    where.push("category = ?");
    args.push(opts.tab);
  } else {
    // The grids have their own shelf: All shows the photo styles a post can take.
    where.push("category != 'grid'");
  }
  // A grid genre: grids read with it, or whose words say it (grids read before genres existed).
  const genre = GRID_GENRES.find((g) => g.id === opts.genre);
  if (genre && (opts.tab === "grid" || opts.tab === "grid-new" || saved)) {
    where.push(`(tags LIKE ? OR ${genre.words.map(() => "LOWER(title || ' ' || tags || ' ' || COALESCE(prompt, '') || ' ' || COALESCE(note, '')) LIKE ?").join(" OR ")})`);
    args.push(`genre:${genre.id}%`, ...genre.words.map((w) => `%${w}%`));
  }
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 60);
  if (q)
    for (const word of q.split(/\s+/).slice(0, 4)) {
      where.push("(LOWER(title) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(prompt) LIKE ? OR category LIKE ?)");
      const like = `%${word}%`;
      args.push(like, like, like, like);
    }
  // For a client: the styles saved to it first, then (on the Grids shelf) the grids its profile suggested.
  const forClient = `${opts.client ? "(id IN (SELECT style FROM client_styles WHERE client = ?)) DESC, " : ""}${opts.tab === "grid" && opts.client ? "(client = ?) DESC, " : ""}`;
  const order = `${forClient}${opts.tab === "trends" || opts.tab === "grid-new" || reviewing ? "created DESC" : "score DESC, created DESC"}`;
  const total = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM styles WHERE ${where.join(" AND ")}`, ...args))?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / STYLE_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, opts.page ?? 1));
  const rows = await all<StyleRow>(
    env.DB,
    `SELECT * FROM styles WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...args,
    ...(opts.client ? [opts.client] : []),
    ...(opts.tab === "grid" && opts.client ? [opts.client] : []),
    STYLE_PAGE_SIZE,
    (page - 1) * STYLE_PAGE_SIZE,
  );
  const cats = await all<{ category: string; n: number }>(env.DB, "SELECT category, COUNT(*) AS n FROM styles WHERE status = 'active' GROUP BY category");
  const trends = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'active' AND category != 'grid' AND created >= ?", trendsFrom))?.n ?? 0;
  const pool = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'pool'"))?.n ?? 0;
  const counts: Record<string, number> = { all: cats.filter((c) => c.category !== "grid").reduce((x, c) => x + c.n, 0), trends };
  counts["grid-new"] = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'active' AND category = 'grid' AND created >= ?", trendsFrom))?.n ?? 0;
  const clientNames = new Map((await all<{ id: string; name: string }>(env.DB, "SELECT id, name FROM clients")).map((r) => [r.id, r.name]));
  for (const c of STYLE_CATEGORIES) counts[c.id] = cats.find((x) => x.category === c.id)?.n ?? 0;
  if (admin) {
    const queue = await all<{ grid: number; n: number }>(env.DB, "SELECT category = 'grid' AS grid, COUNT(*) AS n FROM styles WHERE status = 'review' GROUP BY category = 'grid'");
    counts["review-grid"] = queue.find((x) => x.grid)?.n ?? 0;
    counts["review-style"] = queue.find((x) => !x.grid)?.n ?? 0;
    counts.review = counts["review-grid"] + counts["review-style"];
  }
  counts.gridWaiting = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'review' AND category = 'grid'"))?.n ?? 0;
  const mine = opts.client ? new Set((await all<{ style: string }>(env.DB, "SELECT style FROM client_styles WHERE client = ?", opts.client)).map((r) => r.style)) : new Set<string>();
  if (opts.client) counts.saved = mine.size;
  return { ok: true, styles: rows.map((r) => ({ ...toItem(r, user.role === "admin", clientNames), ...(mine.has(r.id) ? { saved: true } : {}) })), total, page, pages, counts, pool };
}

/** The query of a list request. */
function listQuery(c: { req: { query: (k: string) => string | undefined } }) {
  return {
    tab: c.req.query("tab") ?? "all",
    q: c.req.query("q") ?? "",
    page: Number(c.req.query("page") ?? 1) || 1,
    client: c.req.query("client") ?? "",
    genre: c.req.query("genre") ?? "",
  };
}

export async function styleRow(env: Env, id: string): Promise<StyleRow | null> {
  return first<StyleRow>(env.DB, "SELECT * FROM styles WHERE id = ?", id);
}

/* ───────────── Collecting pins ───────────── */

interface Pin {
  pin: string;
  url: string;
  note: string;
}

/** One page of Pinterest search results (best effort: Pinterest may answer a server with nothing). */
export async function searchPins(query: string): Promise<Pin[]> {
  const data = { options: { query, scope: "pins", page_size: 50, rs: "typed" }, context: {} };
  const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?${new URLSearchParams({
    source_url: `/search/pins/?q=${encodeURIComponent(query)}`,
    data: JSON.stringify(data),
  })}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-PWS-Handler": "www/search/[scope].js",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return [];
  const d = (await r.json().catch(() => null)) as {
    resource_response?: {
      data?: { results?: { id?: string; title?: string; grid_title?: string; description?: string; images?: Record<string, { url?: string }> }[] };
    };
  } | null;
  return (d?.resource_response?.data?.results ?? [])
    .map((x) => ({
      pin: String(x.id ?? ""),
      url: x.images?.["736x"]?.url ?? x.images?.orig?.url ?? "",
      note: [x.grid_title || x.title, x.description].filter(Boolean).join(" · ").slice(0, 1500),
    }))
    .filter((p) => p.pin && /^https:\/\/i\.pinimg\.com\//.test(p.url));
}

/** Pinterest's "more like this" for one pin: the way the pool grows at the bar the gallery holds. */
export async function relatedPins(pin: string): Promise<Pin[]> {
  const options = { pin_id: pin, context_pin_ids: [], search_query: "", source: "deep_linking", top_level_source: "deep_linking", top_level_source_depth: 1, is_pdp: false };
  const url = `https://www.pinterest.com/resource/RelatedModulesResource/get/?${new URLSearchParams({
    source_url: `/pin/${pin}/`,
    data: JSON.stringify({ options, context: {} }),
  })}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "X-Pinterest-PWS-Handler": "www/pin/[id].js" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return [];
  const d = (await r.json().catch(() => null)) as {
    resource_response?: { data?: { id?: string; type?: string; title?: string; grid_title?: string; description?: string; images?: Record<string, { url?: string }>; videos?: unknown }[] };
  } | null;
  return (Array.isArray(d?.resource_response?.data) ? d!.resource_response!.data! : [])
    .filter((x) => x.type === "pin" && !x.videos)
    .map((x) => ({
      pin: String(x.id ?? ""),
      url: x.images?.["736x"]?.url ?? "",
      note: [x.grid_title || x.title, x.description].filter(Boolean).join(" · ").slice(0, 1500),
    }))
    .filter((p) => p.pin.length >= 6 && /^https:\/\/i\.pinimg\.com\//.test(p.url));
}

/**
 * Collected pins join the pool. A pin already known is skipped, and so is a picture the library
 * has ever seen under another pin: a style the team took out never comes back.
 */
async function addToPool(env: Env, pins: Pin[], kind: StyleKind, category = "", client = ""): Promise<number> {
  let added = 0;
  for (const p of pins) {
    const sig = pictureSig(p.url);
    if (sig && (await first(env.DB, "SELECT 1 AS x FROM styles WHERE sig = ?", sig))) continue;
    const changed = await run(
      env.DB,
      "INSERT OR IGNORE INTO styles (id, kind, category, client, status, pin, source, note, sig, created, updated) VALUES (?, ?, ?, ?, 'pool', ?, ?, ?, ?, ?, ?)",
      uuid(),
      kind,
      category,
      client,
      p.pin,
      p.url,
      p.note,
      sig,
      now(),
      now(),
    );
    if (changed) added++;
  }
  return added;
}

/* ───────────── Reading a pin into a style ───────────── */

function own(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

type Stored = { image: string; thumb: string; bytes: ArrayBuffer; mime: string; w: number; h: number };

/** The pin's picture, stored with a small thumbnail so the gallery opens fast. */
async function storeImage(env: Env, row: StyleRow): Promise<Stored> {
  const r = await fetch(row.source, { headers: { "User-Agent": UA, Accept: "image/*" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new StudioError(`The pin's image is gone (${r.status}).`, 404);
  const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!mime.startsWith("image/")) throw new StudioError("The pin is not an image.", 415);
  return storeBytes(env, row.id, await r.arrayBuffer(), mime);
}

/** A style's picture (a pin's or an upload), kept with its thumbnail. */
export async function storeBytes(env: Env, id: string, bytes: ArrayBuffer, mime: string): Promise<Stored> {
  // Only a picture the decoder reads: an SVG, a HEIC or a PDF would crash it (a wasm trap, not an error).
  if (!/^image\/(jpeg|png|webp|gif|bmp)$/i.test(mime)) throw new StudioError("Attach the picture as JPG, PNG or WebP. An SVG, HEIC or PDF can't be read here.", 415);
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon");
  let img: InstanceType<typeof PhotonImage>;
  try {
    img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
  } catch (e) {
    console.error("[styles] picture not readable", mime, bytes.byteLength, e instanceof Error ? e.message : e);
    throw new StudioError("This picture can't be read. Save it as PNG or JPG, at most 4000 px wide, and attach it again.", 415);
  }
  let thumbBytes: Uint8Array;
  const w = img.get_width();
  const h = img.get_height();
  try {
    const tw = Math.min(360, w);
    const small = resize(img, tw, Math.round((h * tw) / w), SamplingFilter.Triangle);
    thumbBytes = small.get_bytes_jpeg(80);
    small.free();
  } finally {
    img.free();
  }
  const image = `styles/${id}.${/png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : "jpg"}`;
  const thumb = `styles/${id}-thumb.jpg`;
  await env.BUCKET.put(image, bytes, { httpMetadata: { contentType: mime } });
  await env.BUCKET.put(thumb, own(thumbBytes), { httpMetadata: { contentType: "image/jpeg" } });
  return { image, thumb, bytes, mime, w, h };
}

type Reading = { keep: boolean; score: number; kind: StyleKind; category: string; title: string; tags: string; prompt: string; tiles: number };

/** One picture read into a style: a photo style, or a whole feed for the Grids shelf. */
export async function readPicture(env: Env, image: { bytes: ArrayBuffer; mime: string }, note: string, grid: boolean, previous?: { title: string; prompt: string }): Promise<Reading> {
  const clean = (t: string) => JSON.parse(t.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as unknown;
  if (grid) {
    const g = parseGridStyle(clean(await askText(env, gridStyleInstruction(note, previous), GRID_STYLE_SCHEMA, [image])));
    return { ...g, kind: "product", category: "grid" };
  }
  const s = parseStyle(clean(await askText(env, describeStyleInstruction(note, previous), STYLE_SCHEMA, [image])));
  return { ...s, tiles: 0 };
}

/**
 * Reads one pool pin: a usable style waits for the admin's approval (or is rejected); its picture
 * is kept. Only what the admin approves reaches the team's library.
 */
async function readPin(env: Env, row: StyleRow): Promise<"review" | "rejected"> {
  try {
    const stored = await storeImage(env, row);
    const s = await readPicture(env, { bytes: stored.bytes, mime: stored.mime }, row.note, row.category === "grid");
    if (!s.keep) {
      await env.BUCKET.delete([stored.image, stored.thumb]);
      await run(env.DB, "UPDATE styles SET status = 'rejected', score = ?, image_key = NULL, thumb_key = NULL, updated = ? WHERE id = ?", s.score, now(), row.id);
      return "rejected";
    }
    await run(
      env.DB,
      "UPDATE styles SET status = 'review', kind = ?, category = ?, score = ?, tiles = ?, w = ?, h = ?, title = ?, tags = ?, prompt = ?, image_key = ?, thumb_key = ?, created = ?, updated = ? WHERE id = ? AND status = 'pool'",
      s.kind,
      s.category,
      s.score,
      s.tiles,
      stored.w,
      stored.h,
      s.title,
      s.tags,
      s.prompt,
      stored.image,
      stored.thumb,
      now(),
      now(),
      row.id,
    );
    return "review";
  } catch (e) {
    console.error("[styles] read failed", row.pin, errorMessage(e));
    await run(env.DB, "UPDATE styles SET status = 'rejected', updated = ? WHERE id = ?", now(), row.id);
    return "rejected";
  }
}

/** Reads up to `budget` pins from the pool (refilling it from Pinterest when it runs low). */
export async function readSome(env: Env, budget = READ_AT_ONCE, only?: "grid" | "photo"): Promise<number> {
  const where = only === "grid" ? "status = 'pool' AND category = 'grid'" : only === "photo" ? "status = 'pool' AND category != 'grid'" : "status = 'pool'";
  const left = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM styles WHERE ${where}`))?.n ?? 0;
  if (left < budget) await (only === "grid" ? collectGrids(env, 3) : collect(env, 2));
  // The newest pins first: what was collected today is read before older leftovers.
  const pool = await all<StyleRow>(env.DB, `SELECT * FROM styles WHERE ${where} ORDER BY created DESC LIMIT ?`, budget);
  const done = await Promise.all(pool.map((r) => readPin(env, r)));
  return done.filter((x) => x === "review").length;
}

/** Feed grids for the Grids shelf: a few of the grid searches, each with the season's words now and then. */
export async function collectGrids(env: Env, searches: number): Promise<number> {
  let added = 0;
  const season = seasonWords(new Date());
  const list = [...STYLE_QUERIES.grid].sort(() => Math.random() - 0.5).slice(0, Math.max(1, searches));
  for (const base of list) {
    const query = Math.random() < 0.2 ? `${season[Math.floor(Math.random() * season.length)]} ${base}` : base;
    try {
      added += await addToPool(env, await searchPins(query), "product", "grid");
    } catch (e) {
      console.error("[styles] grid search failed", query, errorMessage(e));
    }
  }
  return added;
}

/** New pins for the pool: "more like this" of the library's best styles and the day's searches. */
async function collect(env: Env, searches: number): Promise<number> {
  let added = 0;
  const best = await all<{ pin: string; kind: StyleKind }>(
    env.DB,
    "SELECT pin, kind FROM styles WHERE status = 'active' AND category != 'grid' AND score >= 9 AND pin GLOB '[0-9]*' ORDER BY RANDOM() LIMIT 3",
  );
  for (const b of best) {
    try {
      added += await addToPool(env, await relatedPins(b.pin), b.kind);
    } catch (e) {
      console.error("[styles] related failed", b.pin, errorMessage(e));
    }
  }
  const season = seasonWords(new Date());
  for (let i = 0; i < searches; i++) {
    // The day's first two searches bring feeds for the Grids shelf; the others, photo styles.
    const cat = i < 2 && searches >= 4 ? "grid" : PHOTO_CATEGORY_IDS[Math.floor(Math.random() * PHOTO_CATEGORY_IDS.length)];
    const list = STYLE_QUERIES[cat];
    let query = list[Math.floor(Math.random() * list.length)];
    if (cat === "seasonal" || Math.random() < 0.25) query = `${season[Math.floor(Math.random() * season.length)]} ${query}`;
    try {
      added += await addToPool(env, await searchPins(query), "product", cat === "grid" ? "grid" : "");
    } catch (e) {
      console.error("[styles] search failed", query, errorMessage(e));
    }
  }
  return added;
}

/**
 * Feed grids for one client, from the Pinterest searches its profile wrote. They are read on the
 * cron within minutes and wait for the admin's approval like every new style.
 */
export async function suggestGrids(env: Env, client: string, queries: string[]): Promise<number> {
  let added = 0;
  for (const q of queries.slice(0, 5)) {
    try {
      added += await addToPool(env, (await searchPins(q)).slice(0, 10), "product", "grid", client);
    } catch (e) {
      console.error("[styles] grid search failed", q, errorMessage(e));
    }
  }
  return added;
}

/**
 * The library's daily refresh, on the cron: once a day new pins are collected, and through the day
 * a few are read each minute until DAILY_READS is reached.
 */
export async function dailyStyles(env: Env): Promise<void> {
  // Grids found for a client's profile are read first, outside the day's budget.
  const suggested = await all<StyleRow>(env.DB, "SELECT * FROM styles WHERE status = 'pool' AND client != '' ORDER BY created DESC LIMIT 4");
  if (suggested.length) {
    await Promise.all(suggested.map((r) => readPin(env, r)));
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const mark = await getSetting(env, "styles_daily");
  const [lastDay, readStr] = (mark ?? "").split("|");
  let read = lastDay === day ? Number(readStr) || 0 : 0;
  if (lastDay !== day) {
    await collect(env, 6);
    await setSetting(env, "styles_daily", `${day}|0`);
  }
  if (read >= DAILY_READS) return;
  const budget = Math.min(4, DAILY_READS - read);
  const pool = await all<StyleRow>(env.DB, "SELECT * FROM styles WHERE status = 'pool' ORDER BY created DESC LIMIT ?", budget);
  if (!pool.length) return;
  read += pool.length;
  await setSetting(env, "styles_daily", `${day}|${read}`);
  await Promise.all(pool.map((r) => readPin(env, r)));
}

/* ───────────── Routes ───────────── */

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid request.");
  return parsed.data;
}

styleRoutes.get("/", async (c) => c.json(await list(c.env, c.get("user"), listQuery(c))));

/** Styles by id (a month's posts show their style's name and picture). */
styleRoutes.get("/lookup", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 60);
  if (!ids.length) return c.json({ ok: true, styles: [] });
  const rows = await all<StyleRow>(c.env.DB, `SELECT * FROM styles WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
  return c.json({ ok: true, styles: rows.map((r) => toItem(r, c.get("user").role === "admin")) });
});

/** What a library grid holds, for the picker: its tiles by kind and layout once it was read, else its tile count. */
styleRoutes.get("/:id/grid", async (c) => {
  const r = await styleRow(c.env, c.req.param("id"));
  if (!r) throw new StudioError("Not found.", 404);
  const row = await first<{ read: string }>(c.env.DB, "SELECT read FROM grid_reads WHERE style = ?", r.id);
  let read: GridRead | null = null;
  try {
    read = row ? (JSON.parse(row.read) as GridRead) : null;
  } catch {
    read = null;
  }
  const sum = gridSummary(read);
  return c.json({ ok: true, ...sum, tiles: sum.tiles || r.tiles });
});

styleRoutes.get("/:id/image", async (c) => {
  const r = await styleRow(c.env, c.req.param("id"));
  const key = c.req.query("size") === "full" ? r?.image_key : (r?.thumb_key ?? r?.image_key);
  const obj = key ? await c.env.BUCKET.get(key) : null;
  if (!obj) throw new StudioError("No picture.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      // The picture of a style never changes: the gallery URL carries ?v=updated anyway.
      "Cache-Control": "private, max-age=2592000, immutable",
    },
  });
});

/** Pins collected elsewhere (the team or a seeding script) join the pool. */
styleRoutes.post("/import", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const d = await body(
    c,
    z.object({
      kind: z.enum(STYLE_KINDS),
      /** "grid": the pins are whole feeds, read for the Grids shelf. */
      category: z.enum(["grid"]).optional(),
      pins: z
        .array(z.object({ pin: z.string().min(3).max(120), url: z.string().url().max(600), note: z.string().max(2000).default("") }))
        .max(300),
    }),
  );
  const pins = d.pins.filter((p) => /^https:\/\/i\.pinimg\.com\//.test(p.url));
  return c.json({ ok: true, added: await addToPool(c.env, pins, d.kind, d.category ?? "") });
});

/** A pin link (pin.it short link or pinterest.com/pin/…) as a pool pin: its id, picture and text. */
async function pinFromLink(link: string): Promise<Pin | null> {
  let id = /pinterest\.[a-z.]+\/pin\/(\d{6,})/i.exec(link)?.[1] ?? null;
  if (!id) {
    const r = await fetch(link, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    id = /\/pin\/(\d{6,})/.exec(r.url)?.[1] ?? /\/pin\/(\d{6,})/.exec(await r.text())?.[1] ?? null;
  }
  if (!id) return null;
  const r = await fetch(`https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${id}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) return null;
  const d = (await r.json()) as { data?: { title?: string; description?: string; images?: Record<string, { url?: string }> }[] };
  const x = d.data?.[0];
  const url = x?.images?.["736x"]?.url ?? x?.images?.["564x"]?.url ?? "";
  return url ? { pin: id, url, note: [x?.title, x?.description].filter(Boolean).join(" · ").slice(0, 1500) } : null;
}

/**
 * The team's own pins: read and put at the front of the gallery at once, whatever their score
 * (the team chose them). The gallery's weakest style of that kind steps back to the spares.
 */
/** One of the team's pins read into the library (or found already there): its style id, or null. */
async function addOwnPin(env: Env, admin: boolean, pin: Pin, grid: boolean): Promise<string | null> {
  const known = await first<StyleRow>(env.DB, "SELECT * FROM styles WHERE pin = ?", pin.pin);
  if (known?.image_key && known.prompt && (known.status === "active" || known.status === "review")) return known.id;
  await run(
    env.DB,
    "INSERT INTO styles (id, kind, status, pin, source, note, sig, created, updated) VALUES (?, 'product', 'pool', ?, ?, ?, ?, ?, ?) ON CONFLICT(pin) DO UPDATE SET status = 'pool', source = excluded.source, updated = excluded.updated",
    uuid(),
    pin.pin,
    pin.url,
    pin.note,
    pictureSig(pin.url),
    now(),
    now(),
  );
  const row = await first<StyleRow>(env.DB, "SELECT * FROM styles WHERE pin = ?", pin.pin);
  if (!row) return null;
  const stored = await storeImage(env, row);
  const st = await readPicture(env, { bytes: stored.bytes, mime: stored.mime }, row.note, grid);
  if (!st.prompt) return null;
  await run(
    env.DB,
    "UPDATE styles SET status = ?, position = -1, kind = ?, category = ?, score = ?, tiles = ?, w = ?, h = ?, title = ?, tags = ?, prompt = ?, image_key = ?, thumb_key = ?, created = ?, updated = ? WHERE id = ?",
    // The admin's own pins go straight in; anyone else's wait for the admin.
    admin ? "active" : "review",
    st.kind,
    st.category,
    Math.max(st.score, 9),
    st.tiles,
    stored.w,
    stored.h,
    st.title || "Team pick",
    st.tags,
    st.prompt,
    stored.image,
    stored.thumb,
    now(),
    now(),
    row.id,
  );
  return row.id;
}

/** How many of a pin's related pins come along with it. */
const RELATED_WITH_PIN = 24;

styleRoutes.post("/add", async (c) => {
  const d = await body(
    c,
    z.object({
      links: z.array(z.string().url().max(600)).min(1).max(20),
      grid: z.boolean().optional(),
      /** The pins Pinterest shows under each link come along too. */
      related: z.boolean().optional(),
      /** Everything added joins this client's own styles. */
      client: z.string().max(80).optional(),
    }),
  );
  const admin = c.get("user").role === "admin";
  const client = d.client ? await first<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM clients WHERE id = ?", d.client) : null;
  if (d.client && !client) throw new StudioError("Client not found.", 404);
  const added: string[] = [];
  const failed: string[] = [];
  const pins: Pin[] = [];
  /** A grid added for a client carries the client's name and joins its collection. */
  const own = async (id: string) => {
    if (!client) return;
    await run(c.env.DB, "INSERT OR IGNORE INTO client_styles (client, style, added) VALUES (?, ?, ?)", client.id, id, now());
    if (!d.grid) return;
    const n = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM styles WHERE client = ? AND category = 'grid'", client.id))?.n ?? 0;
    await run(c.env.DB, "UPDATE styles SET client = ?, title = CASE WHEN title LIKE ? THEN title ELSE ? || title END WHERE id = ?", client.id, `${client.name} ·%`, `${client.name} · ${n + 1} · `, id);
  };
  await Promise.all(
    d.links.map(async (link) => {
      try {
        const pin = await pinFromLink(link);
        if (!pin) return failed.push(link);
        const id = await addOwnPin(c.env, admin, pin, !!d.grid);
        if (!id) return failed.push(link);
        added.push(id);
        await own(id);
        pins.push(pin);
      } catch (e) {
        console.error("[styles] add failed", link, errorMessage(e));
        failed.push(link);
      }
    }),
  );
  // The related pins (up to 24 per link, each downloaded and read by vision) take minutes: they are
  // added in the background after the answer, so the screen never waits on them.
  let background = 0;
  if (d.related && pins.length) {
    background = pins.length * RELATED_WITH_PIN;
    c.executionCtx.waitUntil(
      (async () => {
        for (const pin of pins) {
          try {
            const related = (await relatedPins(pin.pin)).slice(0, RELATED_WITH_PIN);
            for (let i = 0; i < related.length; i += 4) {
              const ids = await Promise.all(
                related.slice(i, i + 4).map((r) =>
                  addOwnPin(c.env, admin, r, !!d.grid).catch((e) => {
                    console.error("[styles] related add failed", r.pin, errorMessage(e));
                    return null;
                  }),
                ),
              );
              for (const x of ids) if (x) await own(x);
            }
          } catch (e) {
            console.error("[styles] related failed", pin.pin, errorMessage(e));
          }
        }
      })(),
    );
  }
  return c.json({ ...(await list(c.env, c.get("user"), { tab: d.grid ? "grid" : admin ? "trends" : "all", client: d.client })), added: new Set(added).size, failed, background });
});

/**
 * The team's own pictures: a feed grid (or a photo style) uploaded from the computer. The admin's
 * go straight in; anyone else's wait for the admin's approval.
 */
styleRoutes.post("/upload", async (c) => {
  const form = await c.req.formData();
  const grid = form.get("grid") === "1";
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f).slice(0, 10);
  if (!files.length) throw new StudioError("Choose one or more pictures.");
  const admin = c.get("user").role === "admin";
  const added: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      if (!file.type.startsWith("image/")) throw new StudioError("Not a picture.", 415);
      if (file.size > 15 * 1024 * 1024) throw new StudioError("Larger than 15 MB.", 413);
      const id = uuid();
      const stored = await storeBytes(c.env, id, await file.arrayBuffer(), file.type);
      const st = await readPicture(c.env, { bytes: stored.bytes, mime: stored.mime }, file.name.replace(/\.[a-z0-9]+$/i, ""), grid);
      await run(
        c.env.DB,
        "INSERT INTO styles (id, kind, status, category, score, tiles, w, h, title, tags, prompt, source, note, image_key, thumb_key, position, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?, -1, ?, ?)",
        id,
        st.kind,
        admin ? "active" : "review",
        grid ? "grid" : st.category,
        Math.max(st.score, 9),
        st.tiles,
        stored.w,
        stored.h,
        st.title || (grid ? "Team grid" : "Team pick"),
        st.tags,
        st.prompt,
        file.name.slice(0, 200),
        stored.image,
        stored.thumb,
        now(),
        now(),
      );
      added.push(id);
    } catch (e) {
      console.error("[styles] upload failed", file.name, errorMessage(e));
      failed.push(file.name);
    }
  }
  return c.json({ ...(await list(c.env, c.get("user"), { tab: admin ? (grid ? "grid" : "trends") : "all" })), added: added.length, failed });
});

/** Reads a few more pins into the library now (admins may read more at once, and grids or photos only). */
styleRoutes.post("/fill", async (c) => {
  const asked = Number(c.req.query("budget") ?? READ_AT_ONCE) || READ_AT_ONCE;
  const admin = c.get("user").role === "admin";
  const only = admin && (c.req.query("only") === "grid" || c.req.query("only") === "photo") ? (c.req.query("only") as "grid" | "photo") : undefined;
  const added = await readSome(c.env, admin ? Math.min(12, Math.max(1, asked)) : READ_AT_ONCE, only);
  return c.json({ ...(await list(c.env, c.get("user"), listQuery(c))), added });
});

/** Admins: more pins for the pool now (feed grids or photo styles), read on the cron and by "fill". */
styleRoutes.post("/collect", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const d = await body(
    c,
    z.object({
      only: z.enum(["grid", "photo"]),
      searches: z.number().int().min(1).max(12).default(4),
      /** Exact searches to run instead of the library's own (a client's kind, a season). */
      queries: z.array(z.string().min(3).max(120)).max(12).optional(),
      /** Pins whose "more like this" fills the pool: the team's own picks set the taste. */
      related: z.array(z.string().regex(/^\d{6,}$/)).max(30).optional(),
    }),
  );
  let added = 0;
  if (d.related?.length)
    for (const pin of d.related)
      try {
        added += await addToPool(c.env, await relatedPins(pin), "product", d.only === "grid" ? "grid" : "");
      } catch (e) {
        console.error("[styles] related failed", pin, errorMessage(e));
      }
  else if (d.queries?.length)
    for (const query of d.queries)
      try {
        added += await addToPool(c.env, await searchPins(query), "product", d.only === "grid" ? "grid" : "");
      } catch (e) {
        console.error("[styles] search failed", query, errorMessage(e));
      }
  else added = d.only === "grid" ? await collectGrids(c.env, d.searches) : await collect(c.env, d.searches);
  const pool = (await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM styles WHERE status = 'pool' AND category ${d.only === "grid" ? "=" : "!="} 'grid'`))?.n ?? 0;
  return c.json({ ok: true, added, pool });
});

/** Takes styles out of the library. */
async function remove(env: Env, ids: string[]) {
  for (const id of ids) await run(env.DB, "UPDATE styles SET status = 'removed', updated = ? WHERE id = ? AND status IN ('active','review')", now(), id);
}

styleRoutes.delete("/:id", async (c) => {
  // Crossed out is gone: nothing takes its place, and the picture never comes back.
  await remove(c.env, [c.req.param("id")]);
  return c.json(await list(c.env, c.get("user"), listQuery(c)));
});

/** "New ideas": the selected styles leave and as many new ones are read now (they wait for the admin's approval). */
styleRoutes.post("/replace", async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().max(80)).min(1).max(200) }));
  await remove(c.env, d.ids);
  const added = await readSome(c.env, Math.min(12, d.ids.length));
  if (d.ids.length > 12)
    c.executionCtx.waitUntil(readSome(c.env, Math.min(12, d.ids.length - 12)).catch((e) => console.error("[styles] read failed", errorMessage(e))));
  return c.json({ ...(await list(c.env, c.get("user"), listQuery(c))), added });
});

/**
 * Admins: every style in the gallery and the spares are read again under the current rules; the
 * ones that no longer pass leave, and ready styles take their places.
 */
styleRoutes.post("/recheck", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const d = await body(c, z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(12).default(8) }));
  const rows = await all<StyleRow>(
    c.env.DB,
    "SELECT * FROM styles WHERE status = 'active' AND category != 'grid' ORDER BY created LIMIT ? OFFSET ?",
    d.limit,
    d.offset,
  );
  const out: string[] = [];
  await Promise.all(
    rows.map(async (r) => {
      const obj = r.image_key ? await c.env.BUCKET.get(r.image_key) : null;
      if (!obj) return;
      try {
        const text = await askText(c.env, describeStyleInstruction(r.note), STYLE_SCHEMA, [
          { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" },
        ]);
        const s = parseStyle(JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
        let w = r.w;
        let h = r.h;
        if (!w || !h) {
          const thumb = r.thumb_key ? await c.env.BUCKET.get(r.thumb_key) : null;
          if (thumb) {
            const { PhotonImage } = await import("@cf-wasm/photon");
            const img = PhotonImage.new_from_byteslice(new Uint8Array(await thumb.arrayBuffer()));
            w = img.get_width();
            h = img.get_height();
            img.free();
          }
        }
        if (!s.keep) {
          await run(c.env.DB, "UPDATE styles SET status = 'rejected', score = ?, w = ?, h = ?, updated = ? WHERE id = ?", s.score, w, h, now(), r.id);
          out.push(r.title);
        } else
          await run(
            c.env.DB,
            "UPDATE styles SET score = ?, category = ?, w = ?, h = ?, title = ?, tags = ?, prompt = ?, kind = ?, updated = ? WHERE id = ?",
            s.score,
            s.category,
            w,
            h,
            s.title || r.title,
            s.tags || r.tags,
            s.prompt || r.prompt,
            s.kind,
            now(),
            r.id,
          );
      } catch (e) {
        console.error("[styles] recheck failed", r.id, errorMessage(e));
      }
    }),
  );
  return c.json({ ok: true, checked: rows.length, rejected: out });
});

/** Admins: the library's styles sorted onto the shelves again from what they say (one text call per batch). */
styleRoutes.post("/classify", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const d = await body(c, z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(60).default(40) }));
  const rows = await all<StyleRow>(c.env.DB, "SELECT * FROM styles WHERE status = 'active' AND category != 'grid' ORDER BY created LIMIT ? OFFSET ?", d.limit, d.offset);
  if (!rows.length) return c.json({ ok: true, done: 0 });
  const shelves = PHOTO_CATEGORY_IDS;
  const text = await askText(
    c.env,
    [
      `Put each photo style on one shelf, by what its picture advertises: ${shelves.join(", ")}. corporate = banks, insurance, telecom, tech, services; fashion = clothes, shoes, bags, accessories; food = meals and savoury food; drinks = any beverage; sweets = desserts, chocolate, pastries, ice cream; lifestyle = home, everyday products, people living with a product; beauty = skincare, cosmetics, perfume; seasonal = an occasion or season; luxury = premium gifts, jewellery, high-end boxes.`,
      rows.map((r, i) => `${i + 1}. ${r.title} | ${r.tags} | ${(r.note || "").slice(0, 200)} | ${r.prompt.slice(0, 300)}`).join("\n"),
      'Return ONLY JSON: {"shelves": ["sweets", "beauty", ...]} with one shelf per style, in order.',
    ].join("\n\n"),
    { type: "object", properties: { shelves: { type: "array", items: { type: "string", enum: shelves } } }, required: ["shelves"] },
  );
  const got = (JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as { shelves?: string[] }).shelves ?? [];
  let done = 0;
  for (let i = 0; i < rows.length; i++) {
    const shelf = got[i];
    if (!shelf || !shelves.includes(shelf as StyleCategory)) continue;
    await run(c.env.DB, "UPDATE styles SET category = ? WHERE id = ?", shelf, rows[i].id);
    done++;
  }
  return c.json({ ok: true, done, checked: rows.length });
});

/** The admin approves styles from the queue: they join the library (and show as new on Trends). */
styleRoutes.post("/approve", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Only an admin approves styles.", 403);
  const d = await body(c, z.object({ ids: z.array(z.string().max(80)).min(1).max(200) }));
  for (const id of d.ids)
    await run(c.env.DB, "UPDATE styles SET status = 'active', created = ?, updated = ? WHERE id = ? AND status = 'review'", now(), now(), id);
  return c.json({ ...(await list(c.env, c.get("user"), listQuery(c))), approved: d.ids.length });
});

/**
 * "Add to Habibah's": the selected styles and grids join the client's own collection, shown first
 * whenever the team picks for that client. The admin's pick also approves the ones still waiting.
 */
styleRoutes.post("/save", async (c) => {
  const d = await body(c, z.object({ client: z.string().min(1).max(80), ids: z.array(z.string().max(80)).min(1).max(200) }));
  if (!(await first(c.env.DB, "SELECT 1 AS x FROM clients WHERE id = ?", d.client))) throw new StudioError("Client not found.", 404);
  for (const id of d.ids) {
    await run(c.env.DB, "INSERT OR IGNORE INTO client_styles (client, style, added) VALUES (?, ?, ?)", d.client, id, now());
    if (c.get("user").role === "admin")
      await run(c.env.DB, "UPDATE styles SET status = 'active', created = ?, updated = ? WHERE id = ? AND status = 'review'", now(), now(), id);
  }
  return c.json({ ...(await list(c.env, c.get("user"), listQuery(c))), saved: d.ids.length });
});

styleRoutes.post("/unsave", async (c) => {
  const d = await body(c, z.object({ client: z.string().min(1).max(80), ids: z.array(z.string().max(80)).min(1).max(200) }));
  for (const id of d.ids) await run(c.env.DB, "DELETE FROM client_styles WHERE client = ? AND style = ?", d.client, id);
  return c.json(await list(c.env, c.get("user"), listQuery(c)));
});

/** Takes several styles out at once (the admin's Reject, or a team member's clean-up). */
styleRoutes.post("/remove", async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().max(80)).min(1).max(200) }));
  await remove(c.env, d.ids);
  return c.json(await list(c.env, c.get("user"), listQuery(c)));
});

/** How many styles wait for the admin (the sidebar's badge). */
styleRoutes.get("/pending", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ ok: true, n: 0 });
  const n = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'review'"))?.n ?? 0;
  return c.json({ ok: true, n });
});

/** "Update": the selected styles are read again into a fresh variation of the same idea. */
styleRoutes.post("/refresh", async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().max(80)).min(1).max(12) }));
  await Promise.all(
    d.ids.map(async (id) => {
      const r = await styleRow(c.env, id);
      if (!r?.image_key) return;
      const obj = await c.env.BUCKET.get(r.image_key);
      if (!obj) return;
      try {
        const image = { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" };
        const s = await readPicture(c.env, image, r.note, r.category === "grid", { title: r.title, prompt: r.prompt });
        if (s.prompt)
          await run(c.env.DB, "UPDATE styles SET title = ?, tags = ?, prompt = ?, updated = ? WHERE id = ?", s.title || r.title, s.tags || r.tags, s.prompt, now(), r.id);
      } catch (e) {
        console.error("[styles] refresh failed", id, errorMessage(e));
      }
    }),
  );
  return c.json(await list(c.env, c.get("user"), listQuery(c)));
});
