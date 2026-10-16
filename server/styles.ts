/**
 * The style gallery: Pinterest pins read into reusable product-photo styles. The gallery always
 * shows STYLE_TARGET styles of each kind; a style taken out is replaced at once by a ready spare,
 * and the spares are topped up in the background from the pool of collected pins.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { askText } from "./posts";
import type { User } from "@shared/types";
import {
  describeStyleInstruction,
  parseStyle,
  STYLE_KINDS,
  STYLE_QUERIES,
  STYLE_SCHEMA,
  STYLE_TARGET,
  type StyleItem,
  type StyleKind,
} from "@shared/styles";

type Variables = { user: User };
export const styleRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Read, ready styles kept behind the gallery so a removed one is replaced instantly. */
const SPARES = 8;
/** Pins read at once (each is one vision call). */
const READ_AT_ONCE = 6;
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
}

function toItem(r: StyleRow, admin: boolean): StyleItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    tags: r.tags,
    ...(admin ? { prompt: r.prompt } : {}),
    position: r.position,
    updated: r.updated,
  };
}

async function list(env: Env, user: User) {
  const rows = await all<StyleRow>(
    env.DB,
    "SELECT * FROM styles WHERE status = 'active' ORDER BY kind, position, created",
  );
  const counts = await all<{ status: string; kind: string; n: number }>(
    env.DB,
    "SELECT status, kind, COUNT(*) AS n FROM styles WHERE status IN ('pool','spare') GROUP BY status, kind",
  );
  return {
    ok: true,
    styles: rows.map((r) => toItem(r, user.role === "admin")),
    pool: counts.filter((c) => c.status === "pool").reduce((s, c) => s + c.n, 0),
    spare: counts.filter((c) => c.status === "spare").reduce((s, c) => s + c.n, 0),
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

/** Collected pins join the pool (a pin already known is skipped). */
async function addToPool(env: Env, pins: Pin[], kind: StyleKind): Promise<number> {
  let added = 0;
  for (const p of pins) {
    const changed = await run(
      env.DB,
      "INSERT OR IGNORE INTO styles (id, kind, status, pin, source, note, created, updated) VALUES (?, ?, 'pool', ?, ?, ?, ?, ?)",
      uuid(),
      kind,
      p.pin,
      p.url,
      p.note,
      now(),
      now(),
    );
    if (changed) added++;
  }
  return added;
}

/** The pool runs low: one more Pinterest search for that kind. */
async function refillPool(env: Env, kind: StyleKind): Promise<void> {
  const left = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM styles WHERE status = 'pool' AND kind = ?", kind);
  if ((left?.n ?? 0) >= 12) return;
  const queries = STYLE_QUERIES[kind];
  const query = queries[Math.floor(Math.random() * queries.length)];
  try {
    await addToPool(env, await searchPins(query), kind);
  } catch (e) {
    console.error("[styles] search failed", query, errorMessage(e));
  }
}

/* ───────────── Reading a pin into a style ───────────── */

function own(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** The pin's picture, stored with a small thumbnail so the gallery opens fast. */
async function storeImage(env: Env, row: StyleRow): Promise<{ image: string; thumb: string; bytes: ArrayBuffer; mime: string }> {
  const r = await fetch(row.source, { headers: { "User-Agent": UA, Accept: "image/*" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new StudioError(`The pin's image is gone (${r.status}).`, 404);
  const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!mime.startsWith("image/")) throw new StudioError("The pin is not an image.", 415);
  const bytes = await r.arrayBuffer();
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon");
  const img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
  let thumbBytes: Uint8Array;
  try {
    const w = img.get_width();
    const h = img.get_height();
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
  return { image, thumb, bytes, mime };
}

/** Reads one pool pin: a usable style becomes a spare (or rejected); its picture is kept. */
async function readPin(env: Env, row: StyleRow): Promise<"spare" | "rejected"> {
  try {
    const stored = await storeImage(env, row);
    const text = await askText(env, describeStyleInstruction(row.note), STYLE_SCHEMA, [{ bytes: stored.bytes, mime: stored.mime }]);
    const s = parseStyle(JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
    if (!s.keep) {
      await env.BUCKET.delete([stored.image, stored.thumb]);
      await run(env.DB, "UPDATE styles SET status = 'rejected', image_key = NULL, thumb_key = NULL, updated = ? WHERE id = ?", now(), row.id);
      return "rejected";
    }
    await run(
      env.DB,
      "UPDATE styles SET status = 'spare', kind = ?, title = ?, tags = ?, prompt = ?, image_key = ?, thumb_key = ?, updated = ? WHERE id = ? AND status = 'pool'",
      s.kind,
      s.title,
      s.tags,
      s.prompt,
      stored.image,
      stored.thumb,
      now(),
      row.id,
    );
    return "spare";
  } catch (e) {
    console.error("[styles] read failed", row.pin, errorMessage(e));
    await run(env.DB, "UPDATE styles SET status = 'rejected', updated = ? WHERE id = ?", now(), row.id);
    return "rejected";
  }
}

/** Spares fill the gallery's empty places, in the places that were emptied. */
async function promote(env: Env, kind: StyleKind, positions: number[] = []): Promise<number> {
  const active = await first<{ n: number; p: number | null }>(
    env.DB,
    "SELECT COUNT(*) AS n, MAX(position) AS p FROM styles WHERE status = 'active' AND kind = ?",
    kind,
  );
  const missing = STYLE_TARGET[kind] - (active?.n ?? 0);
  if (missing <= 0) return 0;
  const spares = await all<StyleRow>(
    env.DB,
    "SELECT * FROM styles WHERE status = 'spare' AND kind = ? ORDER BY created LIMIT ?",
    kind,
    missing,
  );
  let next = (active?.p ?? -1) + 1;
  for (const s of spares) {
    const position = positions.shift() ?? next++;
    await run(env.DB, "UPDATE styles SET status = 'active', position = ?, updated = ? WHERE id = ? AND status = 'spare'", position, now(), s.id);
  }
  return spares.length;
}

/**
 * Keeps the gallery full and the spares stocked: reads up to `budget` pins from the pool, the kind
 * that is short first, then moves spares into the gallery.
 */
export async function topUp(env: Env, budget = READ_AT_ONCE): Promise<void> {
  for (const kind of STYLE_KINDS) await promote(env, kind);
  for (const kind of STYLE_KINDS) {
    const have = await first<{ a: number; s: number }>(
      env.DB,
      "SELECT SUM(status = 'active') AS a, SUM(status = 'spare') AS s FROM styles WHERE kind = ?",
      kind,
    );
    const need = STYLE_TARGET[kind] - (have?.a ?? 0) + SPARES - (have?.s ?? 0);
    if (need <= 0 || budget <= 0) continue;
    await refillPool(env, kind);
    const pool = await all<StyleRow>(
      env.DB,
      "SELECT * FROM styles WHERE status = 'pool' AND kind = ? ORDER BY created LIMIT ?",
      kind,
      Math.min(need, budget),
    );
    budget -= pool.length;
    await Promise.all(pool.map((r) => readPin(env, r)));
    await promote(env, kind);
  }
  // A read pin may turn out to be of the other kind: it fills that gallery instead.
  for (const kind of STYLE_KINDS) await promote(env, kind);
}

/* ───────────── Routes ───────────── */

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid request.");
  return parsed.data;
}

styleRoutes.get("/", async (c) => c.json(await list(c.env, c.get("user"))));

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

/** Reads a few more pins and fills the gallery; the browser calls it until nothing is missing. */
styleRoutes.post("/fill", async (c) => {
  await topUp(c.env, READ_AT_ONCE);
  return c.json(await list(c.env, c.get("user")));
});

/** Takes styles out of the gallery; spares take their places at once, and more are read behind. */
async function replace(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, ids: string[]) {
  const rows = (await Promise.all(ids.map((id) => styleRow(c.env, id)))).filter((r): r is StyleRow => !!r && r.status === "active");
  const freed: Record<StyleKind, number[]> = { product: [], people: [] };
  for (const r of rows) {
    await run(c.env.DB, "UPDATE styles SET status = 'removed', updated = ? WHERE id = ?", now(), r.id);
    freed[r.kind].push(r.position);
  }
  for (const kind of STYLE_KINDS) await promote(c.env, kind, freed[kind]);
  c.executionCtx.waitUntil(topUp(c.env, READ_AT_ONCE).catch((e) => console.error("[styles] top up failed", errorMessage(e))));
}

styleRoutes.delete("/:id", async (c) => {
  await replace(c, [c.req.param("id")]);
  return c.json(await list(c.env, c.get("user")));
});

/** "Bring new fresh ideas": the selected styles leave, new ones take their places. */
styleRoutes.post("/replace", async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().max(80)).min(1).max(70) }));
  await replace(c, d.ids);
  return c.json(await list(c.env, c.get("user")));
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
  return c.json(await list(c.env, c.get("user")));
});
