/**
 * Brand ambassadors: up to four recurring AI people per client. Each has a written look and a
 * portrait (generated from the look or uploaded); posts that cast them attach the portrait so
 * the engine keeps the same face.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { makeGoogleClient } from "./engine";
import type { Ambassador, User } from "@shared/types";
import { castLook } from "@shared/cast";

type Variables = { user: User };
export const ambassadorRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const MAX_AMBASSADORS = 4;
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PHOTO = 12 * 1024 * 1024;

export interface AmbassadorRow {
  id: string;
  client: string;
  name: string;
  description: string;
  image_key: string | null;
  gender: string;
  modest: number;
  hijab: number;
  position: number;
  created: number;
  updated: number;
}

function toAmbassador(r: AmbassadorRow): Ambassador {
  return {
    id: r.id,
    client: r.client,
    name: r.name,
    description: r.description,
    gender: r.gender === "man" || r.gender === "woman" ? r.gender : "",
    modest: !!r.modest,
    hijab: !!r.hijab,
    image: !!r.image_key,
    position: r.position,
    updated: r.updated,
  };
}

export async function ambassadorRows(env: Env, client: string): Promise<AmbassadorRow[]> {
  return all<AmbassadorRow>(
    env.DB,
    "SELECT * FROM ambassadors WHERE client = ? ORDER BY position, created",
    client,
  );
}

async function list(env: Env, client: string) {
  return { ok: true, ambassadors: (await ambassadorRows(env, client)).map(toAmbassador) };
}

async function row(env: Env, id: string): Promise<AmbassadorRow> {
  const r = await first<AmbassadorRow>(env.DB, "SELECT * FROM ambassadors WHERE id = ?", id);
  if (!r) throw new StudioError("Ambassador not found.", 404);
  return r;
}

async function body<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid request.");
  return parsed.data;
}

/** The portrait prompt: one person, neutral studio, the face clearly visible, no text. */
export function portraitPrompt(name: string, look: string, wish = ""): string {
  return [
    `A photorealistic studio portrait of one person, the brand ambassador "${name}": ${look.trim() || "a friendly, natural-looking adult"}.`,
    wish.trim() ? `Designer's note: ${wish.trim()}.` : "",
    "Head and shoulders, facing the camera with a natural, warm expression, the whole face clearly visible and evenly lit by soft daylight-balanced studio light, sharp focus on the eyes.",
    "Plain light-grey seamless backdrop. Real skin texture, natural proportions, one head, two eyes, no accessories covering the face.",
    "No text, logos, watermarks or frames. A modest, respectful look suitable for a Middle Eastern family brand.",
  ]
    .filter(Boolean)
    .join(" ");
}

ambassadorRoutes.get("/", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  return c.json(await list(c.env, client));
});

ambassadorRoutes.post("/", async (c) => {
  const d = await body(
    c,
    z.object({
      client: z.string().min(1).max(80),
      name: z.string().trim().min(1).max(40),
      description: z.string().trim().max(1200).default(""),
      gender: z.enum(["man", "woman", ""]).default(""),
    }),
  );
  const exists = await first(c.env.DB, "SELECT id FROM clients WHERE id = ?", d.client);
  if (!exists) throw new StudioError("Client not found.", 404);
  const count = await first<{ n: number; p: number | null }>(
    c.env.DB,
    "SELECT COUNT(*) AS n, MAX(position) AS p FROM ambassadors WHERE client = ?",
    d.client,
  );
  if ((count?.n ?? 0) >= MAX_AMBASSADORS)
    throw new StudioError(`A client has at most ${MAX_AMBASSADORS} ambassadors.`, 409);
  await run(
    c.env.DB,
    "INSERT INTO ambassadors (id, client, name, description, gender, image_key, position, created, updated) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    uuid(),
    d.client,
    d.name,
    d.description,
    d.gender,
    (count?.p ?? -1) + 1,
    now(),
    now(),
  );
  return c.json(await list(c.env, d.client));
});

ambassadorRoutes.put("/:id", async (c) => {
  const r = await row(c.env, c.req.param("id"));
  const d = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(40).optional(),
      description: z.string().trim().max(1200).optional(),
      gender: z.enum(["man", "woman", ""]).optional(),
      modest: z.boolean().optional(),
      hijab: z.boolean().optional(),
    }),
  );
  await run(
    c.env.DB,
    "UPDATE ambassadors SET name = ?, description = ?, gender = ?, modest = ?, hijab = ?, updated = ? WHERE id = ?",
    d.name ?? r.name,
    d.description ?? r.description,
    d.gender ?? r.gender,
    d.modest === undefined ? r.modest : d.modest ? 1 : 0,
    d.hijab === undefined ? r.hijab : d.hijab ? 1 : 0,
    now(),
    r.id,
  );
  return c.json(await list(c.env, r.client));
});

ambassadorRoutes.delete("/:id", async (c) => {
  const r = await row(c.env, c.req.param("id"));
  if (r.image_key) await c.env.BUCKET.delete(r.image_key);
  await run(c.env.DB, "DELETE FROM ambassadors WHERE id = ?", r.id);
  return c.json(await list(c.env, r.client));
});

async function storePortrait(env: Env, r: AmbassadorRow, bytes: ArrayBuffer, mime: string) {
  const key = `clients/${r.client}/ambassador-${r.id}-${uuid()}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  if (r.image_key) await env.BUCKET.delete(r.image_key);
  await run(env.DB, "UPDATE ambassadors SET image_key = ?, updated = ? WHERE id = ?", key, now(), r.id);
}

/** Generates the portrait from the written look (Google image model). */
ambassadorRoutes.post("/:id/portrait", async (c) => {
  const r = await row(c.env, c.req.param("id"));
  const d = await body(c, z.object({ wish: z.string().max(600).optional() }));
  if (!r.gender) throw new StudioError(`Choose whether ${r.name} is a man or a woman first.`);
  const engine = await makeGoogleClient(c.env);
  const img = await engine.edit({
    model: "gemini-3-pro-image",
    prompt: portraitPrompt(r.name, castLook({ ...r, modest: !!r.modest, hijab: !!r.hijab }), d.wish ?? ""),
    images: [],
    aspectRatio: "4:5",
    size: "1K",
  });
  await storePortrait(c.env, r, img.bytes, img.mime || "image/png");
  return c.json(await list(c.env, r.client));
});

/** Uses a photo the designer uploads as the portrait instead. */
ambassadorRoutes.post("/:id/photo", async (c) => {
  const r = await row(c.env, c.req.param("id"));
  const form = await c.req.formData();
  const f = form.get("file");
  if (!(f instanceof File)) throw new StudioError("Choose a photo.");
  if (!PHOTO_TYPES.includes(f.type)) throw new StudioError("Portrait: use JPG, PNG or WebP.");
  if (f.size > MAX_PHOTO) throw new StudioError("Portrait: file is over 12 MB.");
  await storePortrait(c.env, r, await f.arrayBuffer(), f.type);
  return c.json(await list(c.env, r.client));
});

ambassadorRoutes.get("/:id/image", async (c) => {
  const r = await row(c.env, c.req.param("id"));
  const obj = r.image_key ? await c.env.BUCKET.get(r.image_key) : null;
  if (!obj) throw new StudioError("No portrait yet.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": "private, max-age=86400",
    },
  });
});
