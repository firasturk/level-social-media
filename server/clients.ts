/** Clients: the brands Level produces posts for. Cards on the studio page, one per batch. */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { CLIENT_LANGUAGES, slugify, uniqueSlug } from "@shared/clients";
import type { Client, User } from "@shared/types";

type Variables = { user: User };
export const clientRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const MAX_LOGO = 2 * 1024 * 1024;

interface ClientRow {
  id: string;
  slug: string;
  name: string;
  logo_key: string | null;
  badge_key: string | null;
  overlay: string | null;
  colors: string;
  fonts: string;
  tone: string;
  dos: string;
  donts: string;
  style: string;
  service?: string | null;
  grid_rhythm: string;
  language: string;
  status: string;
  position: number;
  created: number;
  updated: number;
  batches?: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toClient(r: ClientRow): Client {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    logo: !!r.logo_key,
    badge: !!r.badge_key,
    colors: parseJson<Client["colors"]>(r.colors, []),
    fonts: parseJson<Client["fonts"]>(r.fonts, {}),
    tone: r.tone,
    dos: r.dos,
    donts: r.donts,
    style: r.style,
    service: r.service ?? "",
    gridRhythm: r.grid_rhythm,
    language: (CLIENT_LANGUAGES as readonly string[]).includes(r.language)
      ? (r.language as Client["language"])
      : "ar",
    status: r.status === "archived" ? "archived" : "active",
    position: r.position,
    batches: Number(r.batches ?? 0),
    updated: r.updated,
    overlay: r.overlay ? parseJson<Client["overlay"]>(r.overlay, null) : null,
    fontFiles: [],
    places: [],
  };
}

/** Clients in card order. Archived ones are included only on request. */
export async function listClients(env: Env, includeArchived = false): Promise<Client[]> {
  const rows = await all<ClientRow>(
    env.DB,
    `SELECT c.*, (SELECT COUNT(*) FROM batches b WHERE b.client = c.id AND b.deleted IS NULL) AS batches
     FROM clients c ${includeArchived ? "" : "WHERE c.status = 'active'"}
     ORDER BY c.position, c.created`,
  );
  const assets = await all<{ id: string; client: string; name: string | null; kind: string }>(
    env.DB,
    "SELECT id, client, name, kind FROM brand_assets WHERE kind IN ('font', 'place', 'realref') ORDER BY created",
  );
  const drivePlaces = new Map(
    (await all<{ client: string; n: number }>(env.DB, "SELECT client, COUNT(*) AS n FROM drive_photos WHERE status = 'read' AND kind IN ('place', 'factory') GROUP BY client")).map((r) => [r.client, r.n]),
  );
  return rows.map((r) => ({
    ...toClient(r),
    drivePlaces: drivePlaces.get(r.id) ?? 0,
    fontFiles: assets
      .filter((f) => f.client === r.id && f.kind === "font")
      .map((f) => ({ id: f.id, name: f.name ?? "Font" })),
    places: assets
      .filter((f) => f.client === r.id && f.kind === "place")
      .map((f) => ({ id: f.id, name: f.name ?? "Place" })),
    realRefs: assets
      .filter((f) => f.client === r.id && f.kind === "realref")
      .map((f) => ({ id: f.id, name: f.name ?? "Real photo" })),
  }));
}

async function clientRow(env: Env, id: string): Promise<ClientRow> {
  const row = await first<ClientRow>(env.DB, "SELECT * FROM clients WHERE id = ?", id);
  if (!row) throw new StudioError("Client not found.", 404);
  return row;
}

/** The active client a new batch is filed under; throws when missing or archived. */
export async function requireActiveClient(env: Env, id: string | undefined): Promise<ClientRow> {
  if (!id) throw new StudioError("Pick a client first.");
  const row = await first<ClientRow>(
    env.DB,
    "SELECT * FROM clients WHERE id = ? AND status = 'active'",
    id,
  );
  if (!row) throw new StudioError("This client is archived or missing. Pick another client.");
  return row;
}

function requireAdmin(user: User) {
  if (user.role !== "admin") throw new StudioError("Only an admin can do that.", 403);
}

async function payload(env: Env) {
  return { ok: true, clients: await listClients(env, true) };
}

async function body<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid request.");
  return parsed.data;
}

clientRoutes.get("/", async (c) => {
  return c.json({ clients: await listClients(c.env, c.req.query("all") === "1") });
});

clientRoutes.post("/", async (c) => {
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
  const taken = (await all<{ slug: string }>(c.env.DB, "SELECT slug FROM clients")).map(
    (r) => r.slug,
  );
  const slug = uniqueSlug(slugify(name), taken);
  const last = await first<{ max: number | null }>(
    c.env.DB,
    "SELECT MAX(position) AS max FROM clients",
  );
  const id = uuid();
  await run(
    c.env.DB,
    "INSERT INTO clients (id, slug, name, position, created, updated) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    slug,
    name,
    (last?.max ?? 0) + 1,
    now(),
    now(),
  );
  return c.json({ ...(await payload(c.env)), id });
});

const patch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  tone: z.string().trim().max(2000).optional(),
  dos: z.string().trim().max(4000).optional(),
  donts: z.string().trim().max(4000).optional(),
  style: z.string().trim().max(20000).optional(),
  service: z.string().trim().max(600).optional(),
  gridRhythm: z.string().trim().max(4000).optional(),
  language: z.enum(CLIENT_LANGUAGES).optional(),
  colors: z
    .array(z.object({ name: z.string().trim().max(40), hex: z.string().trim().max(9) }))
    .max(12)
    .optional(),
  fonts: z
    .object({ headline: z.string().trim().max(80).optional(), body: z.string().trim().max(80).optional() })
    .optional(),
  /** Overlay spec; validated loosely, the client fills the gaps from the template. */
  overlay: z.record(z.unknown()).nullable().optional(),
});

clientRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  await clientRow(c.env, id);
  const d = await body(c, patch);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (d.name !== undefined) set("name", d.name);
  if (d.tone !== undefined) set("tone", d.tone);
  if (d.dos !== undefined) set("dos", d.dos);
  if (d.donts !== undefined) set("donts", d.donts);
  if (d.style !== undefined) set("style", d.style);
  if (d.service !== undefined) set("service", d.service);
  if (d.gridRhythm !== undefined) set("grid_rhythm", d.gridRhythm);
  if (d.language !== undefined) set("language", d.language);
  if (d.colors !== undefined) set("colors", JSON.stringify(d.colors));
  if (d.fonts !== undefined) set("fonts", JSON.stringify(d.fonts));
  if (d.overlay !== undefined) {
    const text = d.overlay === null ? null : JSON.stringify(d.overlay);
    if (text && text.length > 8000) throw new StudioError("Overlay settings are too long.");
    set("overlay", text);
  }
  set("updated", now());
  params.push(id);
  await run(c.env.DB, `UPDATE clients SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return c.json(await payload(c.env));
});

/** Card order on the studio page. */
clientRoutes.post("/order", async (c) => {
  const { ids } = await body(c, z.object({ ids: z.array(z.string().max(80)).max(200) }));
  const stmts = ids.map((id, i) =>
    c.env.DB.prepare("UPDATE clients SET position = ? WHERE id = ?").bind(i + 1, id),
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json(await payload(c.env));
});

/** Archive a client (hard delete only when it has no batches). Admin only. */
clientRoutes.delete("/:id", async (c) => {
  requireAdmin(c.get("user"));
  const id = c.req.param("id");
  const row = await clientRow(c.env, id);
  const used = await first<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM batches WHERE client = ?",
    id,
  );
  if (used?.n) {
    await run(c.env.DB, "UPDATE clients SET status = 'archived', updated = ? WHERE id = ?", now(), id);
  } else {
    const keys = [row.logo_key, row.badge_key].filter((k): k is string => !!k);
    if (keys.length) await c.env.BUCKET.delete(keys);
    await run(c.env.DB, "DELETE FROM clients WHERE id = ?", id);
  }
  const left = await first<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM clients WHERE status = 'active'",
  );
  if (!left?.n) {
    await run(c.env.DB, "UPDATE clients SET status = 'active', updated = ? WHERE id = ?", now(), id);
    throw new StudioError("Keep at least one client active.");
  }
  return c.json(await payload(c.env));
});

clientRoutes.post("/:id/restore", async (c) => {
  requireAdmin(c.get("user"));
  const id = c.req.param("id");
  await clientRow(c.env, id);
  await run(c.env.DB, "UPDATE clients SET status = 'active', updated = ? WHERE id = ?", now(), id);
  return c.json(await payload(c.env));
});

/**
 * The primary logo (cards and the overlay's main logo) and the corner badge (a parent or partner
 * mark drawn small in a corner of every post). Neither is ever sent to an image engine.
 */
const MARKS = { logo: "logo_key", badge: "badge_key" } as const;
type Mark = keyof typeof MARKS;

for (const mark of Object.keys(MARKS) as Mark[]) {
  const column = MARKS[mark];
  const label = mark === "logo" ? "Logo" : "Corner logo";

  clientRoutes.post(`/:id/${mark}`, async (c) => {
    const id = c.req.param("id");
    const row = await clientRow(c.env, id);
    const form = await c.req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new StudioError(`Choose a ${label.toLowerCase()} file.`);
    if (!LOGO_TYPES.includes(f.type)) throw new StudioError(`${label}: use PNG, JPG, WebP or SVG.`);
    if (f.size > MAX_LOGO) throw new StudioError(`${label}: file is over 2 MB.`);
    const key = `clients/${id}/${mark}-${uuid()}`;
    await c.env.BUCKET.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
    const old = row[column];
    if (old) await c.env.BUCKET.delete(old);
    await run(c.env.DB, `UPDATE clients SET ${column} = ?, updated = ? WHERE id = ?`, key, now(), id);
    return c.json(await payload(c.env));
  });

  clientRoutes.delete(`/:id/${mark}`, async (c) => {
    const id = c.req.param("id");
    const row = await clientRow(c.env, id);
    const old = row[column];
    if (old) await c.env.BUCKET.delete(old);
    await run(c.env.DB, `UPDATE clients SET ${column} = NULL, updated = ? WHERE id = ?`, now(), id);
    return c.json(await payload(c.env));
  });
}

/* ───────────── Brand fonts (files the overlay loads) ───────────── */

const FONT_TYPES = ["font/ttf", "font/otf", "font/woff", "font/woff2", "application/font-sfnt", "application/x-font-ttf", "application/octet-stream", "application/font-woff", "application/font-woff2"];
const MAX_FONT = 4 * 1024 * 1024;

clientRoutes.post("/:id/fonts", async (c) => {
  const id = c.req.param("id");
  await clientRow(c.env, id);
  const form = await c.req.formData();
  const f = form.get("file");
  if (!(f instanceof File)) throw new StudioError("Choose a font file.");
  if (!/\.(ttf|otf|woff2?)$/i.test(f.name) && !FONT_TYPES.includes(f.type))
    throw new StudioError("Font: use a .ttf, .otf, .woff or .woff2 file.");
  if (f.size > MAX_FONT) throw new StudioError("Font: file is over 4 MB.");
  const name = String(form.get("name") || f.name.replace(/\.[^.]+$/, "")).trim().slice(0, 80);
  const assetId = uuid();
  const key = `clients/${id}/font-${assetId}`;
  const type = /\.woff2$/i.test(f.name)
    ? "font/woff2"
    : /\.woff$/i.test(f.name)
      ? "font/woff"
      : /\.otf$/i.test(f.name)
        ? "font/otf"
        : "font/ttf";
  await c.env.BUCKET.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: type } });
  await run(
    c.env.DB,
    "INSERT INTO brand_assets (id, client, kind, key, name, created) VALUES (?, ?, 'font', ?, ?, ?)",
    assetId,
    id,
    key,
    name,
    now(),
  );
  return c.json(await payload(c.env));
});

/** Photos of the client's own place: a grid's place tile is set in the real shop or café. */
clientRoutes.post("/:id/places", async (c) => {
  const id = c.req.param("id");
  await clientRow(c.env, id);
  const form = await c.req.formData();
  const files = form.getAll("file").filter((f): f is File => f instanceof File).slice(0, 12);
  if (!files.length) throw new StudioError("Choose one or more photos of the place.");
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) throw new StudioError(`${f.name}: use a JPG, PNG or WebP photo.`);
    if (f.size > 15 * 1024 * 1024) throw new StudioError(`${f.name}: the photo is over 15 MB.`);
    const assetId = uuid();
    const key = `clients/${id}/place-${assetId}`;
    await c.env.BUCKET.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
    await run(
      c.env.DB,
      "INSERT INTO brand_assets (id, client, kind, key, name, created) VALUES (?, ?, 'place', ?, ?, ?)",
      assetId,
      id,
      key,
      f.name.replace(/\.[^.]+$/, "").slice(0, 80),
      now(),
    );
  }
  return c.json(await payload(c.env));
});

/**
 * Photos of real people (Pinterest links or uploads): the image model sees what a real photo of a
 * person looks like, so the brand's people stop looking generated. Never their faces or clothes.
 */
clientRoutes.post("/:id/realrefs", async (c) => {
  const id = c.req.param("id");
  await clientRow(c.env, id);
  const add = async (bytes: ArrayBuffer, mime: string, name: string) => {
    const assetId = uuid();
    const key = `clients/${id}/realref-${assetId}`;
    await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    await run(c.env.DB, "INSERT INTO brand_assets (id, client, kind, key, name, created) VALUES (?, ?, 'realref', ?, ?, ?)", assetId, id, key, name.slice(0, 80), now());
  };
  const failed: string[] = [];
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    const d = z.object({ links: z.array(z.string().url().max(600)).min(1).max(12) }).parse(await c.req.json());
    const { pageImage } = await import("./posts");
    for (const link of d.links) {
      const img = await pageImage(link).catch(() => null);
      if (img && /^image\/(jpeg|png|webp)$/.test(img.mime)) await add(img.bytes, img.mime, "Pinterest");
      else failed.push(link);
    }
  } else {
    const form = await c.req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File).slice(0, 12);
    if (!files.length) throw new StudioError("Choose one or more photos of real people.");
    for (const f of files) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) throw new StudioError(`${f.name}: use a JPG, PNG or WebP photo.`);
      if (f.size > 15 * 1024 * 1024) throw new StudioError(`${f.name}: the photo is over 15 MB.`);
      await add(await f.arrayBuffer(), f.type, f.name.replace(/\.[^.]+$/, ""));
    }
  }
  return c.json({ ...(await payload(c.env)), failed });
});

clientRoutes.delete("/:id/realrefs/:assetId", async (c) => {
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'realref'",
    c.req.param("assetId"),
    c.req.param("id"),
  );
  if (!row) throw new StudioError("Photo not found.", 404);
  await c.env.BUCKET.delete(row.key);
  await run(c.env.DB, "DELETE FROM brand_assets WHERE id = ?", c.req.param("assetId"));
  return c.json(await payload(c.env));
});

clientRoutes.get("/:id/realrefs/:assetId/file", async (c) => {
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'realref'",
    c.req.param("assetId"),
    c.req.param("id"),
  );
  const obj = row ? await c.env.BUCKET.get(row.key) : null;
  if (!obj) throw new StudioError("Photo not found.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=604800" },
  });
});

clientRoutes.delete("/:id/places/:assetId", async (c) => {
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'place'",
    c.req.param("assetId"),
    c.req.param("id"),
  );
  if (!row) throw new StudioError("Photo not found.", 404);
  await c.env.BUCKET.delete(row.key);
  await run(c.env.DB, "DELETE FROM brand_assets WHERE id = ?", c.req.param("assetId"));
  return c.json(await payload(c.env));
});

clientRoutes.get("/:id/places/:assetId/file", async (c) => {
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'place'",
    c.req.param("assetId"),
    c.req.param("id"),
  );
  const obj = row ? await c.env.BUCKET.get(row.key) : null;
  if (!obj) throw new StudioError("Photo not found.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=604800" },
  });
});

clientRoutes.delete("/:id/fonts/:assetId", async (c) => {
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'font'",
    c.req.param("assetId"),
    c.req.param("id"),
  );
  if (!row) throw new StudioError("Font not found.", 404);
  await c.env.BUCKET.delete(row.key);
  await run(c.env.DB, "DELETE FROM brand_assets WHERE id = ?", c.req.param("assetId"));
  return c.json(await payload(c.env));
});

clientRoutes.get("/:id/fonts/:assetId/file", async (c) => {
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'font'",
    c.req.param("assetId"),
    c.req.param("id"),
  );
  const obj = row ? await c.env.BUCKET.get(row.key) : null;
  if (!obj) throw new StudioError("Font not found.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "font/ttf",
      "Cache-Control": "private, max-age=604800",
    },
  });
});

for (const mark of Object.keys(MARKS) as Mark[]) {
  clientRoutes.get(`/:id/${mark}`, async (c) => {
    const row = await clientRow(c.env, c.req.param("id"));
    const key = row[MARKS[mark]];
    const obj = key ? await c.env.BUCKET.get(key) : null;
    if (!obj) throw new StudioError(mark === "logo" ? "No logo." : "No corner logo.", 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || "image/png",
        "Cache-Control": "private, max-age=86400",
      },
    });
  });
}
