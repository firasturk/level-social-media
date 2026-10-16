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
import {
  describeStyleInstruction,
  parseStyle,
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
} from "@shared/styles";

type Variables = { user: User };
export const styleRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Pins read at once (each is one vision call). */
const READ_AT_ONCE = 6;
/** New pins read a day by the cron, a few each minute. */
const DAILY_READS = 40;
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
}

function toItem(r: StyleRow, admin: boolean): StyleItem {
  return {
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
  };
}

/** One page of the library: a tab (all, trends or a category), a search and a page number. */
async function list(env: Env, user: User, opts: { tab?: string; q?: string; page?: number } = {}) {
  const admin = user.role === "admin";
  // The admin's queue: what the daily update and New ideas brought, waiting for approval.
  const reviewing = admin && opts.tab === "review";
  const where = [reviewing ? "status = 'review'" : "status = 'active'"];
  const args: unknown[] = [];
  const trendsFrom = now() - TREND_DAYS * 86_400_000;
  if (reviewing) {
    /* the whole queue */
  } else if (opts.tab === "trends") {
    where.push("created >= ?");
    args.push(trendsFrom);
  } else if (opts.tab && STYLE_CATEGORY_IDS.includes(opts.tab as StyleCategory)) {
    where.push("category = ?");
    args.push(opts.tab);
  }
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 60);
  if (q)
    for (const word of q.split(/\s+/).slice(0, 4)) {
      where.push("(LOWER(title) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(prompt) LIKE ? OR category LIKE ?)");
      const like = `%${word}%`;
      args.push(like, like, like, like);
    }
  const order = opts.tab === "trends" || reviewing ? "created DESC" : "score DESC, created DESC";
  const total = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM styles WHERE ${where.join(" AND ")}`, ...args))?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / STYLE_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, opts.page ?? 1));
  const rows = await all<StyleRow>(
    env.DB,
    `SELECT * FROM styles WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...args,
    STYLE_PAGE_SIZE,
    (page - 1) * STYLE_PAGE_SIZE,
  );
  const cats = await all<{ category: string; n: number }>(env.DB, "SELECT category, COUNT(*) AS n FROM styles WHERE status = 'active' GROUP BY category");
  const trends = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'active' AND created >= ?", trendsFrom))?.n ?? 0;
  const pool = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'pool'"))?.n ?? 0;
  const counts: Record<string, number> = { all: cats.reduce((x, c) => x + c.n, 0), trends };
  for (const c of STYLE_CATEGORIES) counts[c.id] = cats.find((x) => x.category === c.id)?.n ?? 0;
  if (admin) counts.review = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'review'"))?.n ?? 0;
  return { ok: true, styles: rows.map((r) => toItem(r, user.role === "admin")), total, page, pages, counts, pool };
}

/** The query of a list request. */
function listQuery(c: { req: { query: (k: string) => string | undefined } }) {
  return { tab: c.req.query("tab") ?? "all", q: c.req.query("q") ?? "", page: Number(c.req.query("page") ?? 1) || 1 };
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
async function addToPool(env: Env, pins: Pin[], kind: StyleKind): Promise<number> {
  let added = 0;
  for (const p of pins) {
    const sig = pictureSig(p.url);
    if (sig && (await first(env.DB, "SELECT 1 AS x FROM styles WHERE sig = ?", sig))) continue;
    const changed = await run(
      env.DB,
      "INSERT OR IGNORE INTO styles (id, kind, status, pin, source, note, sig, created, updated) VALUES (?, ?, 'pool', ?, ?, ?, ?, ?, ?)",
      uuid(),
      kind,
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

/** The pin's picture, stored with a small thumbnail so the gallery opens fast. */
async function storeImage(env: Env, row: StyleRow): Promise<{ image: string; thumb: string; bytes: ArrayBuffer; mime: string; w: number; h: number }> {
  const r = await fetch(row.source, { headers: { "User-Agent": UA, Accept: "image/*" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new StudioError(`The pin's image is gone (${r.status}).`, 404);
  const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!mime.startsWith("image/")) throw new StudioError("The pin is not an image.", 415);
  const bytes = await r.arrayBuffer();
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon");
  const img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
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
  const image = `styles/${row.id}.${/png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : "jpg"}`;
  const thumb = `styles/${row.id}-thumb.jpg`;
  await env.BUCKET.put(image, bytes, { httpMetadata: { contentType: mime } });
  await env.BUCKET.put(thumb, own(thumbBytes), { httpMetadata: { contentType: "image/jpeg" } });
  return { image, thumb, bytes, mime, w, h };
}

/**
 * Reads one pool pin: a usable style waits for the admin's approval (or is rejected); its picture
 * is kept. Only what the admin approves reaches the team's library.
 */
async function readPin(env: Env, row: StyleRow): Promise<"review" | "rejected"> {
  try {
    const stored = await storeImage(env, row);
    const text = await askText(env, describeStyleInstruction(row.note), STYLE_SCHEMA, [{ bytes: stored.bytes, mime: stored.mime }]);
    const s = parseStyle(JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
    if (!s.keep) {
      await env.BUCKET.delete([stored.image, stored.thumb]);
      await run(env.DB, "UPDATE styles SET status = 'rejected', score = ?, image_key = NULL, thumb_key = NULL, updated = ? WHERE id = ?", s.score, now(), row.id);
      return "rejected";
    }
    await run(
      env.DB,
      "UPDATE styles SET status = 'review', kind = ?, category = ?, score = ?, w = ?, h = ?, title = ?, tags = ?, prompt = ?, image_key = ?, thumb_key = ?, created = ?, updated = ? WHERE id = ? AND status = 'pool'",
      s.kind,
      s.category,
      s.score,
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
export async function readSome(env: Env, budget = READ_AT_ONCE): Promise<number> {
  const left = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'pool'"))?.n ?? 0;
  if (left < budget) await collect(env, 2);
  // The newest pins first: what was collected today is read before older leftovers.
  const pool = await all<StyleRow>(env.DB, "SELECT * FROM styles WHERE status = 'pool' ORDER BY created DESC LIMIT ?", budget);
  const done = await Promise.all(pool.map((r) => readPin(env, r)));
  return done.filter((x) => x === "review").length;
}

/** New pins for the pool: "more like this" of the library's best styles and the day's searches. */
async function collect(env: Env, searches: number): Promise<number> {
  let added = 0;
  const best = await all<{ pin: string; kind: StyleKind }>(
    env.DB,
    "SELECT pin, kind FROM styles WHERE status = 'active' AND score >= 9 AND pin GLOB '[0-9]*' ORDER BY RANDOM() LIMIT 3",
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
    const cat = STYLE_CATEGORY_IDS[Math.floor(Math.random() * STYLE_CATEGORY_IDS.length)];
    const list = STYLE_QUERIES[cat];
    let query = list[Math.floor(Math.random() * list.length)];
    if (cat === "seasonal" || Math.random() < 0.25) query = `${season[Math.floor(Math.random() * season.length)]} ${query}`;
    try {
      added += await addToPool(env, await searchPins(query), "product");
    } catch (e) {
      console.error("[styles] search failed", query, errorMessage(e));
    }
  }
  return added;
}

/**
 * The library's daily refresh, on the cron: once a day new pins are collected, and through the day
 * a few are read each minute until DAILY_READS is reached.
 */
export async function dailyStyles(env: Env): Promise<void> {
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
      pins: z
        .array(z.object({ pin: z.string().min(3).max(120), url: z.string().url().max(600), note: z.string().max(2000).default("") }))
        .max(300),
    }),
  );
  const pins = d.pins.filter((p) => /^https:\/\/i\.pinimg\.com\//.test(p.url));
  return c.json({ ok: true, added: await addToPool(c.env, pins, d.kind) });
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
styleRoutes.post("/add", async (c) => {
  const d = await body(c, z.object({ links: z.array(z.string().url().max(600)).min(1).max(20) }));
  const added: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    d.links.map(async (link) => {
      try {
        const pin = await pinFromLink(link);
        if (!pin) return failed.push(link);
        await run(
          c.env.DB,
          "INSERT INTO styles (id, kind, status, pin, source, note, sig, created, updated) VALUES (?, 'product', 'pool', ?, ?, ?, ?, ?, ?) ON CONFLICT(pin) DO UPDATE SET status = 'pool', source = excluded.source, updated = excluded.updated",
          uuid(),
          pin.pin,
          pin.url,
          pin.note,
          pictureSig(pin.url),
          now(),
          now(),
        );
        const row = await first<StyleRow>(c.env.DB, "SELECT * FROM styles WHERE pin = ?", pin.pin);
        if (!row) return failed.push(link);
        const stored = await storeImage(c.env, row);
        const text = await askText(c.env, describeStyleInstruction(row.note), STYLE_SCHEMA, [{ bytes: stored.bytes, mime: stored.mime }]);
        const st = parseStyle(JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
        if (!st.prompt) return failed.push(link);
        await run(
          c.env.DB,
          "UPDATE styles SET status = ?, position = -1, kind = ?, category = ?, score = ?, w = ?, h = ?, title = ?, tags = ?, prompt = ?, image_key = ?, thumb_key = ?, created = ?, updated = ? WHERE id = ?",
          // The admin's own pins go straight in; anyone else's wait for the admin.
          c.get("user").role === "admin" ? "active" : "review",
          st.kind,
          st.category,
          Math.max(st.score, 9),
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
        added.push(row.id);
      } catch (e) {
        console.error("[styles] add failed", link, errorMessage(e));
        failed.push(link);
      }
    }),
  );
  return c.json({ ...(await list(c.env, c.get("user"), { tab: c.get("user").role === "admin" ? "trends" : "all" })), added: added.length, failed });
});

/** Reads a few more pins into the library now (admins may read more at once). */
styleRoutes.post("/fill", async (c) => {
  const asked = Number(c.req.query("budget") ?? READ_AT_ONCE) || READ_AT_ONCE;
  const added = await readSome(c.env, c.get("user").role === "admin" ? Math.min(12, Math.max(1, asked)) : READ_AT_ONCE);
  return c.json({ ...(await list(c.env, c.get("user"), listQuery(c))), added });
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
    "SELECT * FROM styles WHERE status = 'active' ORDER BY created LIMIT ? OFFSET ?",
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
  const rows = await all<StyleRow>(c.env.DB, "SELECT * FROM styles WHERE status = 'active' ORDER BY created LIMIT ? OFFSET ?", d.limit, d.offset);
  if (!rows.length) return c.json({ ok: true, done: 0 });
  const shelves = STYLE_CATEGORIES.map((x) => x.id);
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
        const text = await askText(c.env, describeStyleInstruction(r.note, { title: r.title, prompt: r.prompt }), STYLE_SCHEMA, [
          { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" },
        ]);
        const s = parseStyle(JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
        if (s.prompt)
          await run(c.env.DB, "UPDATE styles SET title = ?, tags = ?, prompt = ?, updated = ? WHERE id = ?", s.title || r.title, s.tags || r.tags, s.prompt, now(), r.id);
      } catch (e) {
        console.error("[styles] refresh failed", id, errorMessage(e));
      }
    }),
  );
  return c.json(await list(c.env, c.get("user"), listQuery(c)));
});
