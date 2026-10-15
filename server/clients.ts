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
  colors: string;
  fonts: string;
  tone: string;
  dos: string;
  donts: string;
  style: string;
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
    colors: parseJson<Client["colors"]>(r.colors, []),
    fonts: parseJson<Client["fonts"]>(r.fonts, {}),
    tone: r.tone,
    dos: r.dos,
    donts: r.donts,
    style: r.style,
    gridRhythm: r.grid_rhythm,
    language: (CLIENT_LANGUAGES as readonly string[]).includes(r.language)
      ? (r.language as Client["language"])
      : "ar",
    status: r.status === "archived" ? "archived" : "active",
    position: r.position,
    batches: Number(r.batches ?? 0),
    updated: r.updated,
  };
}

/** Clients in card order. Archived ones are included only on request. */
export async function listClients(env: Env, includeArchived = false): Promise<Client[]> {
  const rows = await all<ClientRow>(
    env.DB,
    `SELECT c.*, (SELECT COUNT(*) FROM batches b WHERE b.client = c.id) AS batches
     FROM clients c ${includeArchived ? "" : "WHERE c.status = 'active'"}
     ORDER BY c.position, c.created`,
  );
  return rows.map(toClient);
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
  gridRhythm: z.string().trim().max(4000).optional(),
  language: z.enum(CLIENT_LANGUAGES).optional(),
  colors: z
    .array(z.object({ name: z.string().trim().max(40), hex: z.string().trim().max(9) }))
    .max(12)
    .optional(),
  fonts: z
    .object({ headline: z.string().trim().max(80).optional(), body: z.string().trim().max(80).optional() })
    .optional(),
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
  if (d.gridRhythm !== undefined) set("grid_rhythm", d.gridRhythm);
  if (d.language !== undefined) set("language", d.language);
  if (d.colors !== undefined) set("colors", JSON.stringify(d.colors));
  if (d.fonts !== undefined) set("fonts", JSON.stringify(d.fonts));
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
    if (row.logo_key) await c.env.BUCKET.delete(row.logo_key);
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

/** Primary logo, shown on the card and (later) by the overlay layer. Never sent to an engine. */
clientRoutes.post("/:id/logo", async (c) => {
  const id = c.req.param("id");
  const row = await clientRow(c.env, id);
  const form = await c.req.formData();
  const f = form.get("file");
  if (!(f instanceof File)) throw new StudioError("Choose a logo file.");
  if (!LOGO_TYPES.includes(f.type)) throw new StudioError("Logo: use PNG, JPG, WebP or SVG.");
  if (f.size > MAX_LOGO) throw new StudioError("Logo: file is over 2 MB.");
  const key = `clients/${id}/logo-${uuid()}`;
  await c.env.BUCKET.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
  if (row.logo_key) await c.env.BUCKET.delete(row.logo_key);
  await run(c.env.DB, "UPDATE clients SET logo_key = ?, updated = ? WHERE id = ?", key, now(), id);
  return c.json(await payload(c.env));
});

clientRoutes.delete("/:id/logo", async (c) => {
  const id = c.req.param("id");
  const row = await clientRow(c.env, id);
  if (row.logo_key) await c.env.BUCKET.delete(row.logo_key);
  await run(c.env.DB, "UPDATE clients SET logo_key = NULL, updated = ? WHERE id = ?", now(), id);
  return c.json(await payload(c.env));
});

clientRoutes.get("/:id/logo", async (c) => {
  const row = await clientRow(c.env, c.req.param("id"));
  const obj = row.logo_key ? await c.env.BUCKET.get(row.logo_key) : null;
  if (!obj) throw new StudioError("No logo.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": "private, max-age=86400",
    },
  });
});
