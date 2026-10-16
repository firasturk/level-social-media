/**
 * Level Social Media: themes per client, the month's plan of posts (ideas), generation of the
 * posts through the batch engine, captions and reference imports (Pinterest pins).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { resolveGoogleAuth, resolveOpenAIKey } from "./settings";
import { askVisionGoogle, askVisionOpenAI } from "./editorial";
import type { ImageBytes } from "./openai";
import { advanceBatch } from "./engine";
import { ambassadorRows, type AmbassadorRow } from "./ambassadors";
import { postSchema } from "@shared/config-schema";
import { resolveOverlay } from "@shared/overlay";
import type { Config } from "@shared/config";
import { stemOf } from "@shared/naming";
import {
  buildPostPrompt,
  colourLabel,
  decodeEntities,
  photoRules,
  withoutColourWords,
  withoutPaletteText,
  captionsCsv,
  GRID_SCHEMA,
  gridIdeasInstruction,
  gridNotes,
  IDEAS_SCHEMA,
  type GridRead,
  IDENTITY_SCHEMA,
  identityBuilderInstruction,
  ideasInstruction,
  MAX_POST_COUNT,
  matchProduct,
  parseIdeas,
  PRODUCT_NOTE_SCHEMA,
  productNoteInstruction,
  PALETTE_SCHEMA,
  paletteInstruction,
  parsePalette,
  singleIdeaInstruction,
  type IdeasRequest,
  POST_TYPES,
  postFileName,
  THEME_SCHEMA,
  themeBuilderInstruction,
  type Post,
  type PostBrief,
} from "@shared/posts";
import type { Theme, User } from "@shared/types";

type Variables = { user: User };
export const postRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_REFERENCE = 12 * 1024 * 1024;
const MAX_ANALYSE_IMAGES = 12;

/** Reference-library scope of a client's identity photos (past posts). */
export function identityScope(clientId: string): string {
  return `idn-${clientId}`.slice(0, 40);
}

async function body<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(
      `Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`,
    );
  }
  return parsed.data;
}

/** One JSON answer from the text model: Google (API key or Vertex) first, OpenAI as the stand-in. */
export async function askText(
  env: Env,
  instruction: string,
  schema: unknown,
  images: ImageBytes[] = [],
): Promise<string> {
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  if (!google && !openai)
    throw new StudioError("This needs a Google or OpenAI key in Connection.", 428);
  if (google) {
    try {
      return await askVisionGoogle(google, instruction, images, schema);
    } catch (e) {
      if (openai) {
        console.log(`[text] Google unavailable, using OpenAI: ${errorMessage(e).slice(0, 160)}`);
        return askVisionOpenAI(openai, instruction, images);
      }
      throw e;
    }
  }
  return askVisionOpenAI(openai!, instruction, images);
}

function parseJson<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new StudioError("The model returned an unreadable answer. Try again.", 502);
  }
}

/* ───────────── Clients and themes ───────────── */

interface ClientRow {
  id: string;
  slug: string;
  name: string;
  colors: string;
  tone: string;
  dos: string;
  donts: string;
  style: string;
  language: string;
  status: string;
  overlay: string | null;
}

/** True when the client's overlay hides the second line, so no sublines are written. */
function hidesSubline(client: ClientRow): boolean {
  try {
    return resolveOverlay(client.overlay ? JSON.parse(client.overlay) : null).subline.show === false;
  } catch {
    return false;
  }
}

async function clientRow(env: Env, id: string | undefined): Promise<ClientRow> {
  const row = id ? await first<ClientRow>(env.DB, "SELECT * FROM clients WHERE id = ?", id) : null;
  if (!row) throw new StudioError("Client not found.", 404);
  return row;
}

function paletteOf(c: ClientRow): string[] {
  try {
    const list = JSON.parse(c.colors) as { name?: string; hex?: string }[];
    return list
      .filter((x) => x && x.hex)
      .map((x) => colourLabel(String(x.hex)));
  } catch {
    return [];
  }
}

interface ThemeRow {
  id: string;
  client: string | null;
  title: string;
  caption: string;
  description: string;
  goal: string;
  library: string;
  props: string;
  /** JSON array of strings. */
  shots: string | null;
  /** JSON array of {name, hex}. */
  palette: string | null;
  palette_auto: number | null;
  hidden: number;
  created: number;
  updated: number;
}

function themePaletteOf(r: ThemeRow): { name: string; hex: string }[] {
  try {
    return parsePalette(JSON.parse(r.palette || "[]"));
  } catch {
    return [];
  }
}

/** The theme's chosen colours as prompt strings ("deep blue #0042aa", named from the hex); empty when it has none. */
function monthPaletteOf(theme: ThemeRow | null): string[] {
  return theme ? themePaletteOf(theme).map((c) => colourLabel(c.hex)) : [];
}

function shotsOf(r: ThemeRow): string[] {
  try {
    const v = JSON.parse(r.shots || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  } catch {
    return [];
  }
}

async function themeRows(env: Env, client: string): Promise<ThemeRow[]> {
  return all<ThemeRow>(
    env.DB,
    "SELECT * FROM skills WHERE client = ? AND hidden = 0 ORDER BY created",
    client,
  );
}

async function toThemes(env: Env, rows: ThemeRow[]): Promise<Theme[]> {
  if (!rows.length) return [];
  const counts = await all<{ skill: string; n: number; thumb: string }>(
    env.DB,
    `SELECT skill, COUNT(*) AS n, (SELECT id FROM refs r2 WHERE r2.skill = r.skill ORDER BY created LIMIT 1) AS thumb
     FROM refs r WHERE skill IN (${rows.map(() => "?").join(",")}) GROUP BY skill`,
    ...rows.map((r) => r.id),
  );
  const byId = new Map(counts.map((c) => [c.skill, c]));
  return rows.map((r) => ({
    id: r.id,
    client: r.client ?? "",
    title: r.title,
    caption: r.caption,
    description: r.description,
    direction: r.goal,
    library: r.library,
    props: r.props ?? "",
    shots: shotsOf(r),
    palette: themePaletteOf(r),
    paletteAuto: r.palette_auto !== 0,
    hidden: !!r.hidden,
    references: byId.get(r.id)?.n ?? 0,
    thumb: byId.get(r.id)?.thumb,
    updated: r.updated,
  }));
}

export async function listThemes(env: Env, client: string): Promise<Theme[]> {
  return toThemes(env, await themeRows(env, client));
}

async function themeRow(env: Env, id: string): Promise<ThemeRow> {
  const row = await first<ThemeRow>(
    env.DB,
    "SELECT * FROM skills WHERE id = ? AND client IS NOT NULL",
    id,
  );
  if (!row) throw new StudioError("Theme not found.", 404);
  return row;
}

/** Short id that also serves as the reference-library scope (a-z0-9-, max 40). */
function themeId(): string {
  return "t-" + uuid().replace(/-/g, "").slice(0, 12);
}

postRoutes.get("/themes", async (c) => {
  const client = c.req.query("client") ?? "";
  return c.json({ themes: client ? await listThemes(c.env, client) : [] });
});

postRoutes.post("/themes", async (c) => {
  const d = await body(
    c,
    z.object({
      client: z.string().min(1).max(80),
      title: z.string().trim().min(1).max(60),
      direction: z.string().trim().max(20000).default(""),
    }),
  );
  await clientRow(c.env, d.client);
  const id = themeId();
  await run(
    c.env.DB,
    "INSERT INTO skills (id, title, caption, description, goal, library, hidden, created, updated, client) VALUES (?, ?, '', '', ?, '', 0, ?, ?, ?)",
    id,
    d.title,
    d.direction,
    now(),
    now(),
    d.client,
  );
  return c.json({ ok: true, id, themes: await listThemes(c.env, d.client) });
});

postRoutes.put("/themes/:id", async (c) => {
  const row = await themeRow(c.env, c.req.param("id"));
  const d = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(60).optional(),
      description: z.string().trim().max(400).optional(),
      direction: z.string().trim().max(20000).optional(),
      library: z.string().trim().max(20000).optional(),
      props: z.string().trim().max(1000).optional(),
      shots: z.array(z.string().trim().max(1200)).max(200).optional(),
      palette: z
        .array(z.object({ name: z.string().max(40), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) }))
        .max(8)
        .optional(),
    }),
  );
  if (d.palette)
    await run(
      c.env.DB,
      "UPDATE skills SET palette = ?, palette_auto = 0 WHERE id = ?",
      JSON.stringify(parsePalette(d.palette)),
      row.id,
    );
  await run(
    c.env.DB,
    "UPDATE skills SET title = ?, description = ?, goal = ?, library = ?, props = ?, shots = ?, updated = ? WHERE id = ?",
    d.title ?? row.title,
    d.description ?? row.description,
    d.direction ?? row.goal,
    d.library ?? row.library,
    d.props ?? row.props ?? "",
    d.shots ? JSON.stringify(d.shots.filter((x) => x.trim())) : row.shots || "[]",
    now(),
    row.id,
  );
  return c.json({ ok: true, themes: await listThemes(c.env, row.client!) });
});

postRoutes.delete("/themes/:id", async (c) => {
  const row = await themeRow(c.env, c.req.param("id"));
  await run(c.env.DB, "UPDATE skills SET hidden = 1, updated = ? WHERE id = ?", now(), row.id);
  return c.json({ ok: true, themes: await listThemes(c.env, row.client!) });
});

async function referenceImages(env: Env, scope: string, limit: number): Promise<ImageBytes[]> {
  const refs = await all<{ key: string }>(
    env.DB,
    "SELECT key FROM refs WHERE skill = ? ORDER BY created LIMIT ?",
    scope,
    limit,
  );
  const images: ImageBytes[] = [];
  for (const r of refs) {
    const obj = await env.BUCKET.get(r.key);
    if (obj)
      images.push({
        bytes: await obj.arrayBuffer(),
        mime: obj.httpMetadata?.contentType || "image/jpeg",
      });
  }
  return images;
}

/** Writes the theme's direction and visual language from its references. */
async function analyseTheme(env: Env, row: ThemeRow): Promise<void> {
  const images = await referenceImages(env, row.id, MAX_ANALYSE_IMAGES);
  if (!images.length) throw new StudioError("Add reference photos to this theme first.");
  const d = parseJson<{
    description?: string;
    direction?: string;
    library?: string;
    shots?: unknown;
    palette?: unknown;
  }>(await askText(env, themeBuilderInstruction(row.title, images.length), THEME_SCHEMA, images));
  if (!d.direction || !d.library)
    throw new StudioError("The model returned an incomplete theme.", 502);
  const shots = (Array.isArray(d.shots) ? d.shots : [])
    .filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => x.trim().slice(0, 1200))
    .slice(0, 200);
  await run(
    env.DB,
    "UPDATE skills SET description = ?, goal = ?, library = ?, shots = ?, auto = 1, updated = ? WHERE id = ?",
    (d.description ?? "").trim().slice(0, 300),
    d.direction.trim(),
    d.library.trim(),
    JSON.stringify(shots),
    now(),
    row.id,
  );
  // The suggested colours replace the palette only while the designer has not chosen their own.
  const palette = parsePalette(d.palette);
  if (palette.length && (row.palette_auto !== 0 || !themePaletteOf(row).length))
    await run(
      env.DB,
      "UPDATE skills SET palette = ?, palette_auto = 1 WHERE id = ?",
      JSON.stringify(palette),
      row.id,
    );
}

/** "Suggest colours": the references' colour story only, replacing the theme's palette. */
postRoutes.post("/themes/:id/palette", async (c) => {
  const row = await themeRow(c.env, c.req.param("id"));
  const images = await referenceImages(c.env, row.id, MAX_ANALYSE_IMAGES);
  if (!images.length) throw new StudioError("Add reference photos to this theme first.");
  const d = parseJson<{ palette?: unknown }>(
    await askText(c.env, paletteInstruction(images.length), PALETTE_SCHEMA, images),
  );
  const palette = parsePalette(d.palette);
  if (!palette.length) throw new StudioError("The model returned no colours. Try again.", 502);
  await run(
    c.env.DB,
    "UPDATE skills SET palette = ?, palette_auto = 1, updated = ? WHERE id = ?",
    JSON.stringify(palette),
    now(),
    row.id,
  );
  return c.json({ ok: true, themes: await listThemes(c.env, row.client!) });
});

/** "Analyse theme", also run automatically after references are added. */
postRoutes.post("/themes/:id/analyze", async (c) => {
  const row = await themeRow(c.env, c.req.param("id"));
  await analyseTheme(c.env, row);
  return c.json({ ok: true, themes: await listThemes(c.env, row.client!) });
});

/** "Analyse identity": the client's style text from its past posts. */
postRoutes.post("/analyze-identity", async (c) => {
  const { client } = await body(c, z.object({ client: z.string().min(1).max(80) }));
  const row = await clientRow(c.env, client);
  const images = await referenceImages(c.env, identityScope(row.id), MAX_ANALYSE_IMAGES);
  if (!images.length) throw new StudioError("Add photos of the client's past posts first.");
  const d = parseJson<{ description?: string; style?: string }>(
    await askText(
      c.env,
      identityBuilderInstruction(row.name, images.length),
      IDENTITY_SCHEMA,
      images,
    ),
  );
  if (!d.style) throw new StudioError("The model returned no style text.", 502);
  await run(
    c.env.DB,
    "UPDATE clients SET style = ?, updated = ? WHERE id = ?",
    d.style.trim().slice(0, 20000),
    now(),
    row.id,
  );
  return c.json({ ok: true, style: d.style.trim() });
});

/* ───────────── Reference imports (Pinterest pins and other image pages) ───────────── */

const importBody = z.object({
  skill: z.string().regex(/^[a-z0-9-]{1,40}$/),
  urls: z.array(z.string().url().max(2000)).min(1).max(30),
});

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Fetched = { bytes: ArrayBuffer; mime: string };

/** Pinterest's own share graphic (its logo on a 1200x630 card), served instead of the pin to bots. */
const PINTEREST_PLACEHOLDER = /s\.pinimg\.com|facebook_share_image|pinterest_share|\/images\/(?:pin_)?logo/i;

async function fetchImage(url: string): Promise<Fetched | null> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "image/*" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return null;
  const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!mime.startsWith("image/")) return null;
  const bytes = await r.arrayBuffer();
  return bytes.byteLength <= MAX_REFERENCE ? { bytes, mime } : null;
}

/** The full-size copy of a pinimg URL, with the sized copy as fallback. */
async function fetchPinimg(url: string): Promise<Fetched | null> {
  const sized = url.replace(/&amp;/g, "&");
  const original = sized.replace(/\/(?:\d{2,4}x|originals)\//, "/originals/");
  return (await fetchImage(original)) ?? (original !== sized ? await fetchImage(sized) : null);
}

const pinIdOf = (url: string): string | null =>
  /pinterest\.[a-z.]+\/pin\/(\d{6,})/i.exec(url)?.[1] ?? null;

/**
 * A pin's image through Pinterest's pin endpoints, which answer servers plainly while the pin page
 * itself often comes back as a sign-in page carrying the Pinterest logo as og:image.
 */
async function pinterestImage(pinId: string): Promise<Fetched | null> {
  try {
    const r = await fetch(`https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${pinId}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const d = (await r.json()) as {
        data?: { images?: Record<string, { url?: string; width?: number }> }[];
      };
      const images = Object.values(d.data?.[0]?.images ?? {})
        .filter((i) => !!i.url)
        .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
      if (images[0]?.url) {
        const img = await fetchPinimg(images[0].url);
        if (img) return img;
      }
    }
  } catch (e) {
    console.error("[import] pin info failed", pinId, errorMessage(e));
  }
  try {
    const r = await fetch(
      `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(`https://www.pinterest.com/pin/${pinId}/`)}`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
    );
    if (r.ok) {
      const d = (await r.json()) as { thumbnail_url?: string };
      if (d.thumbnail_url) return await fetchPinimg(d.thumbnail_url);
    }
  } catch (e) {
    console.error("[import] pin oembed failed", pinId, errorMessage(e));
  }
  return null;
}

/** The main image of a web page: og:image, twitter:image, or the URL itself when it is an image. */
async function pageImage(url: string): Promise<Fetched | null> {
  const directPin = pinIdOf(url);
  if (directPin) {
    const img = await pinterestImage(directPin);
    if (img) return img;
  }
  const head = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,image/*;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!head.ok) return null;
  const type = head.headers.get("content-type") || "";
  if (type.startsWith("image/")) {
    const bytes = await head.arrayBuffer();
    return bytes.byteLength <= MAX_REFERENCE ? { bytes, mime: type.split(";")[0] } : null;
  }
  // A short link (pin.it) lands on the pin page: read the pin through Pinterest's endpoints first.
  const pinId = directPin ?? pinIdOf(head.url);
  if (pinId && !directPin) {
    const img = await pinterestImage(pinId);
    if (img) return img;
  }
  const html = (await head.text()).slice(0, 2_000_000);
  const candidates = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /"url":"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/i,
    /(https:\/\/i\.pinimg\.com\/(?:originals|736x)\/[A-Za-z0-9/_.-]+\.(?:jpg|jpeg|png|webp))/i,
  ];
  let image: string | null = null;
  for (const re of candidates) {
    const m = re.exec(html);
    // The site's own logo or share card is never the pin.
    if (m && !PINTEREST_PLACEHOLDER.test(m[1])) {
      image = m[1].replace(/&amp;/g, "&");
      break;
    }
  }
  if (!image) return null;
  if (/i\.pinimg\.com/i.test(image)) return fetchPinimg(image);
  return fetchImage(image);
}

postRoutes.post("/import-references", async (c) => {
  const { skill, urls } = await body(c, importBody);
  const added: string[] = [];
  const failed: string[] = [];
  for (const url of urls) {
    try {
      const img = await pageImage(url);
      if (!img) {
        failed.push(url);
        continue;
      }
      const id = uuid();
      const key = `refs/${skill}/${id}`;
      await c.env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
      await run(
        c.env.DB,
        "INSERT INTO refs (id, skill, key, name, framing, notes, created) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
        id,
        skill,
        key,
        new URL(url).hostname.replace(/^www\./, "").slice(0, 120),
        now(),
      );
      added.push(id);
    } catch (e) {
      console.error("[import] failed", url, errorMessage(e));
      failed.push(url);
    }
  }
  // A theme reads its references as soon as it has some: the direction is written without a click.
  let analysed = false;
  if (added.length && skill.startsWith("t-")) {
    const row = await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", skill);
    if (row) {
      try {
        await analyseTheme(c.env, row);
        analysed = true;
      } catch (e) {
        console.error("[import] analyse failed", errorMessage(e));
      }
    }
  }
  return c.json({ ok: true, added, failed, analysed });
});

/* ───────────── The month's plan ───────────── */

interface BatchRow {
  id: string;
  owner: string;
  name: string;
  config: string;
  state: string;
  client: string | null;
  month: string | null;
}

async function ownedPlan(env: Env, user: User, id: string | undefined): Promise<BatchRow> {
  if (!id) throw new StudioError("Plan id is required.");
  const b = await first<BatchRow>(
    env.DB,
    "SELECT * FROM batches WHERE id = ? AND owner = ?",
    id,
    user.id,
  );
  if (!b) throw new StudioError("Plan not found.", 404);
  const config = JSON.parse(b.config) as Config;
  if (config.mode !== "post") throw new StudioError("This is not a month of posts.", 409);
  return b;
}

interface SourceRow {
  id: string;
  name: string;
  stem: string;
  key: string;
  kind: string;
  role: string;
  /** The small JPEG copy made in the browser at upload; vision reads this, never the original. */
  reference_key?: string | null;
  /** What the product photo shows, read by vision (null until read). */
  note?: string | null;
}

const MAX_NOTE_BYTES = 6 * 1024 * 1024;

/**
 * Reads every product photo that has no note yet and stores one; failures leave the note empty.
 * Runs a few photos at a time: it is called in the background right after an upload, and again
 * (for anything still missing) before ideas are written.
 */
export async function describeProducts(env: Env, sources: SourceRow[]): Promise<void> {
  const pending = sources.filter((s) => s.kind === "product" && !s.note);
  const describe = async (s: SourceRow) => {
    try {
      // Another request (the upload's background read) may have finished it meanwhile.
      const row = await first<{ note: string | null }>(
        env.DB,
        "SELECT note FROM sources WHERE id = ?",
        s.id,
      );
      if (row?.note) {
        s.note = row.note;
        return;
      }
      // Originals run to 25 MB; the Worker has 128 MB in all, so only the small copy is read.
      const obj = await env.BUCKET.get(s.reference_key || s.key);
      if (!obj) return;
      if ((obj.size ?? 0) > MAX_NOTE_BYTES) return;
      const image: ImageBytes = {
        bytes: await obj.arrayBuffer(),
        mime: obj.httpMetadata?.contentType || "image/jpeg",
      };
      const d = parseJson<{ note?: string }>(
        await askText(env, productNoteInstruction(productName(s)), PRODUCT_NOTE_SCHEMA, [image]),
      );
      const note = (d.note ?? "").trim().slice(0, 300);
      if (!note) return;
      s.note = note;
      await run(env.DB, "UPDATE sources SET note = ? WHERE id = ?", note, s.id);
    } catch (e) {
      console.error("[products] describe failed", s.name, errorMessage(e));
    }
  };
  const limit = 2;
  for (let i = 0; i < pending.length; i += limit)
    await Promise.all(pending.slice(i, i + limit).map(describe));
}

/** Reads one freshly uploaded product in the background (called by the upload route). */
export async function describeUpload(env: Env, sourceId: string): Promise<void> {
  const row = await first<SourceRow>(
    env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE id = ?",
    sourceId,
  );
  if (row) await describeProducts(env, [row]);
}

/** Product uploads of the plan, by their display name (upload name without folder and extension). */
function productName(s: SourceRow): string {
  return decodeEntities(stemOf(s.name).split("/").pop() ?? s.name);
}

async function saveConfig(env: Env, b: BatchRow, config: Config): Promise<void> {
  await run(
    env.DB,
    "UPDATE batches SET config = ?, theme = ?, updated = ? WHERE id = ?",
    JSON.stringify(config),
    config.theme ?? null,
    now(),
    b.id,
  );
}

/** "Generate ideas": the text model plans the month from the brand kit, the theme and the products. */
/** The month's chosen ambassadors, in the order picked (at most 3). */
async function monthAmbassadors(env: Env, config: Config): Promise<AmbassadorRow[]> {
  const ids = config.ambassadors ?? [];
  if (!ids.length || !config.client) return [];
  const rows = await ambassadorRows(env, config.client);
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is AmbassadorRow => !!r)
    .slice(0, 3);
}

/** The fixed part of an ideas request: the client, its theme and its products. */
function ideasContext(
  client: ClientRow,
  theme: ThemeRow | null,
  config: Config,
  products: string[],
  productNotes: Record<string, string>,
  ambassadors: AmbassadorRow[] = [],
): Omit<IdeasRequest, "count"> {
  // Chosen colours win: the colour words of the references and the brand style give way.
  const chosen = monthPaletteOf(theme).length > 0;
  const recolour = (t: string) => (chosen ? withoutPaletteText(t) : t);
  return {
    clientName: client.name,
    tone: client.tone,
    // Layout rules (logo placement, bands, marks) are the overlay's business, not the scene's.
    dos: photoRules(client.dos),
    donts: photoRules(client.donts),
    language: (["ar", "en", "both"].includes(client.language) ? client.language : "ar") as
      | "ar"
      | "en"
      | "both",
    palette: paletteOf(client),
    style: recolour(client.style),
    themeTitle: theme?.title ?? "",
    themeDirection: recolour(theme ? [theme.goal, theme.description].filter(Boolean).join("\n") : ""),
    themeLibrary: recolour(theme?.library ?? ""),
    props: theme?.props ?? "",
    noSubline: hidesSubline(client),
    monthPalette: monthPaletteOf(theme),
    ambassadors: ambassadors.map((a) => ({ name: a.name, description: a.description })),
    shots: theme ? shotsOf(theme).map((t) => (chosen ? withoutColourWords(t) : t)) : [],
    products,
    productNotes,
    month: config.month ?? "",
    notes: config.notes,
  };
}

/** A fresh idea for one post: new scene, action and headline; same type and product. */
postRoutes.post("/reidea", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      index: z.number().int().min(1).max(MAX_POST_COUNT),
      wish: z.string().max(1000).optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  const current = plan.find((p) => p.index === d.index);
  if (!current) throw new StudioError("That post is not in the plan.", 404);
  const client = await clientRow(c.env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const products = [...new Set(sources.map(productName))];
  const productNotes = Object.fromEntries(
    sources.filter((s) => s.note).map((s) => [productName(s), s.note!]),
  );
  const others = plan.filter((p) => p.index !== d.index).map((p) => p.title);
  const cast = await monthAmbassadors(c.env, config);
  const instruction = singleIdeaInstruction(
    { ...ideasContext(client, theme, config, products, productNotes, cast), count: 1 },
    current,
    others,
    d.wish ?? "",
  );
  const [fresh] = parseIdeas(
    await askText(c.env, instruction, IDEAS_SCHEMA),
    1,
    products,
    cast.map((a) => a.name),
  );
  if (!fresh) throw new StudioError("The model returned no usable idea. Try again.", 502);
  const next: Post = {
    ...current,
    type: current.type,
    product: current.product ?? fresh.product,
    title: fresh.title,
    brief: fresh.brief,
    caption: fresh.caption,
    hashtags: fresh.hashtags,
    headline: fresh.headline,
    subline: hidesSubline(client) ? undefined : fresh.subline,
    shot: fresh.shot ?? current.shot,
    products: fresh.products ?? current.products,
    people: fresh.people,
  };
  config.plan = plan.map((p) => (p.index === d.index ? next : p));
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, post: next });
});

postRoutes.post("/ideas", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      notes: z.string().max(2000).optional(),
      types: z.array(z.enum(POST_TYPES)).max(POST_TYPES.length).optional(),
      count: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const client = await clientRow(c.env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const products = [...new Set(sources.map(productName))];
  const productNotes = Object.fromEntries(
    sources.filter((s) => s.note).map((s) => [productName(s), s.note!]),
  );
  const count = d.count ?? config.postCount ?? 12;
  const cast = await monthAmbassadors(c.env, config);
  const instruction = ideasInstruction({
    ...ideasContext(client, theme, config, products, productNotes, cast),
    count,
    notes: d.notes ?? config.notes,
    types: d.types,
  });
  const plan = parseIdeas(
    await askText(c.env, instruction, IDEAS_SCHEMA),
    count,
    products,
    cast.map((a) => a.name),
  ).map(
    (p) => (hidesSubline(client) ? { ...p, subline: undefined } : p),
  );
  if (!plan.length) throw new StudioError("The model returned no usable ideas. Try again.", 502);
  config.plan = plan;
  config.plannedAt = now();
  config.postCount = count;
  if (d.notes !== undefined) config.notes = d.notes;
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan });
});

/**
 * "Grid from reference": one reference image that shows a whole feed grid is read tile by tile,
 * and the month's posts are planned to recreate its world with the client's products.
 */
postRoutes.post("/grid-ideas", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      ref: z.string().min(1).max(80),
      notes: z.string().max(2000).optional(),
      count: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const ref = await first<{ id: string; key: string }>(
    c.env.DB,
    "SELECT id, key FROM refs WHERE id = ?",
    d.ref,
  );
  const obj = ref ? await c.env.BUCKET.get(ref.key) : null;
  if (!ref || !obj) throw new StudioError("Reference image not found.", 404);
  const image = {
    bytes: await obj.arrayBuffer(),
    mime: obj.httpMetadata?.contentType || "image/jpeg",
  };
  const client = await clientRow(c.env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const products = [...new Set(sources.map(productName))];
  const productNotes = Object.fromEntries(
    sources.filter((s) => s.note).map((s) => [productName(s), s.note!]),
  );
  const count = d.count ?? config.postCount ?? 12;
  const gridCast = await monthAmbassadors(c.env, config);
  const instruction = gridIdeasInstruction({
    clientName: client.name,
    tone: client.tone,
    dos: client.dos,
    donts: client.donts,
    language: (["ar", "en", "both"].includes(client.language) ? client.language : "ar") as
      | "ar"
      | "en"
      | "both",
    palette: paletteOf(client),
    style: client.style,
    themeTitle: theme?.title ?? "",
    themeDirection: theme?.goal ?? "",
    props: theme?.props ?? "",
    noSubline: hidesSubline(client),
    monthPalette: monthPaletteOf(theme),
    ambassadors: gridCast.map((a) => ({ name: a.name, description: a.description })),
    products,
    productNotes,
    month: config.month ?? "",
    count,
    notes: d.notes ?? config.notes,
  });
  const text = await askText(c.env, instruction, GRID_SCHEMA, [image]);
  const read = parseJson<Partial<GridRead> & { posts?: unknown }>(text);
  const plan = parseIdeas(
    JSON.stringify({ posts: read.posts ?? [] }),
    count,
    products,
    gridCast.map((a) => a.name),
  ).map(
    (p) => (hidesSubline(client) ? { ...p, subline: undefined } : p),
  );
  if (!plan.length) throw new StudioError("The model returned no usable posts. Try again.", 502);
  const grid: GridRead = {
    world: String(read.world ?? "").trim(),
    tiles: Array.isArray(read.tiles)
      ? (read.tiles as GridRead["tiles"]).filter((t) => t && typeof t === "object").slice(0, 30)
      : [],
  };
  // Each post remembers the tile it follows (from the title's "T3 ·" prefix, else by order).
  for (const p of plan) {
    const m = /^T(\d+)\s*[·:-]/i.exec(p.title);
    const i = m ? Number(m[1]) - 1 : (p.index - 1) % Math.max(1, grid.tiles.length);
    const t = grid.tiles[i];
    if (t) p.tile = `Tile ${i + 1} (${t.position}): ${t.scene} Product: ${t.productPlacement}`;
    if (m) p.title = p.title.slice(m[0].length).trim() || p.title;
  }
  config.plan = plan;
  config.plannedAt = now();
  config.postCount = count;
  config.gridRef = ref.id;
  config.gridNotes = gridNotes(grid).slice(0, 12000);
  if (d.notes !== undefined) config.notes = d.notes;
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan, grid });
});

/** The designer's edits of the plan. */
postRoutes.put("/plan", async (c) => {
  const d = await body(
    c,
    z.object({ batch: z.string().min(1), plan: z.array(postSchema).max(MAX_POST_COUNT) }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  config.plan = d.plan.map((p, i) => ({ ...p, index: i + 1 }));
  // Adding or removing posts by hand sets the month's count, so Regenerate ideas keeps that number.
  if (config.plan.length) config.postCount = config.plan.length;
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan: config.plan, postCount: config.postCount });
});

/** Month settings: theme, format, engine, count, notes. */
postRoutes.put("/settings", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      theme: z.string().max(80).nullable().optional(),
      format: z.enum(["1:1", "4:5", "9:16"]).optional(),
      model: z.string().max(120).optional(),
      size: z.enum(["1K", "2K", "4K"]).optional(),
      postCount: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
      notes: z.string().max(2000).optional(),
      gridRef: z.null().optional(),
      ambassadors: z.array(z.string().max(80)).max(3).optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  if (d.theme !== undefined) config.theme = d.theme ?? undefined;
  if (d.format) {
    config.format = d.format;
    config.ratio = d.format;
  }
  if (d.model !== undefined) {
    if (d.model && !/^[\w./-]+$/.test(d.model)) throw new StudioError("Invalid model slug.");
    config.model = d.model || undefined;
  }
  if (d.size) config.size = d.size;
  if (d.postCount) config.postCount = d.postCount;
  if (d.notes !== undefined) config.notes = d.notes;
  if (d.ambassadors) config.ambassadors = [...new Set(d.ambassadors)].slice(0, 3);
  if (d.gridRef === null) {
    delete config.gridRef;
    delete config.gridNotes;
  }
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, config });
});

interface TaskLite {
  id: string;
  post: number | null;
  status: string;
  output: string | null;
  brief: string | null;
}

/** A random reference among those used the fewest times in this plan. */
function pickLeastUsed(refs: { id: string }[], used: Map<string, number>): string | null {
  if (!refs.length) return null;
  const min = Math.min(...refs.map((r) => used.get(r.id) ?? 0));
  const pool = refs.filter((r) => (used.get(r.id) ?? 0) === min);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/**
 * "Generate posts": one task per planned post (all of them, or the indexes given). A post with a
 * product uses the product photo as image 1 and a theme reference as image 2; a post without a
 * product uses a theme reference as image 1. Existing results are kept unless `regenerate` is set.
 */
postRoutes.post("/generate", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      indexes: z.array(z.number().int().min(1).max(MAX_POST_COUNT)).optional(),
      regenerate: z.boolean().optional(),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  if (!plan.length) throw new StudioError("Generate ideas first, then the posts.");
  const client = await clientRow(c.env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  // Ambassadors chosen for the month with a portrait: posts that cast them attach the portrait.
  const cast = (await monthAmbassadors(c.env, config)).filter((a) => !!a.image_key);
  const refs = theme
    ? await all<{ id: string; key: string }>(
        c.env.DB,
        "SELECT id, key FROM refs WHERE skill = ? ORDER BY created",
        theme.id,
      )
    : [];
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ?",
    b.id,
  );
  await describeProducts(c.env, sources);
  const tasks = await all<TaskLite>(
    c.env.DB,
    "SELECT id, post, status, output, brief FROM tasks WHERE batch = ?",
    b.id,
  );
  const byPost = new Map(tasks.filter((t) => t.post).map((t) => [t.post!, t]));
  const used = new Map<string, number>();
  for (const t of tasks) {
    try {
      const pb = t.brief ? (JSON.parse(t.brief) as Partial<PostBrief>) : null;
      if (pb?.ref) used.set(pb.ref, (used.get(pb.ref) ?? 0) + 1);
    } catch {
      /* unreadable brief counts for nothing */
    }
  }
  const wanted = new Set(d.indexes ?? plan.map((p) => p.index));
  const statements: D1PreparedStatement[] = [];
  let planned = 0;
  for (const post of plan) {
    if (!wanted.has(post.index)) continue;
    const existing = byPost.get(post.index);
    if (existing) {
      const busy = existing.status === "processing" || existing.status === "finalizing";
      if (busy) continue;
      if (!d.regenerate && existing.status !== "failed") continue;
    }
    const productSources = sources.filter((s) => s.kind === "product");
    const productNames = productSources.map(productName);
    const productMatch = matchProduct(post.product, productNames);
    const product = productMatch
      ? productSources.find((s) => productName(s) === productMatch)
      : undefined;
    // Further products shown in the same picture, attached after image 1.
    const extraProducts = product
      ? [...new Set((post.products ?? []).map((n) => matchProduct(n, productNames)))]
          .filter((n): n is string => !!n && n !== productMatch)
          .slice(0, 3)
          .map((n) => productSources.find((s) => productName(s) === n)!)
          .filter(Boolean)
          .map((s) => ({
            name: productName(s).trim(),
            note: s.note?.trim() || undefined,
            key: s.reference_key || s.key,
          }))
      : [];
    // Grid mode: every post follows the same reference grid; otherwise rotate the theme's photos.
    const gridRef = config.gridRef
      ? await first<{ id: string, key: string }>(c.env.DB, "SELECT id, key FROM refs WHERE id = ?", config.gridRef)
      : null;
    if (gridRef && !refs.some((r) => r.id === gridRef.id)) refs.push(gridRef);
    const refId = gridRef ? gridRef.id : pickLeastUsed(refs, used);
    if (refId) used.set(refId, (used.get(refId) ?? 0) + 1);
    let sourceId = product?.id;
    if (!sourceId) {
      if (!refId)
        throw new StudioError(
          `Post ${post.index} has no product. Add reference photos to the theme so the post can use one as its image, or pick a product for it.`,
          428,
        );
      const ref = refs.find((r) => r.id === refId)!;
      const stem = `ref-${refId}`;
      const existingRef = sources.find((s) => s.stem === stem);
      if (existingRef) sourceId = existingRef.id;
      else {
        sourceId = uuid();
        await run(
          c.env.DB,
          "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created) VALUES (?, ?, ?, ?, ?, NULL, 'image/jpeg', 0, 'supporting', 'reference', ?)",
          sourceId,
          b.id,
          `reference/${refId}.jpg`,
          stem,
          ref.key,
          now(),
        );
        sources.push({
          id: sourceId,
          name: `reference/${refId}.jpg`,
          stem,
          key: ref.key,
          kind: "reference",
          role: "supporting",
        });
      }
    }
    let take = 1;
    if (existing?.brief && d.regenerate) {
      try {
        take = ((JSON.parse(existing.brief) as Partial<PostBrief>).take ?? 1) + 1;
      } catch {
        take = 2;
      }
    }
    const brief: PostBrief = {
      post: true,
      take,
      index: post.index,
      type: post.type,
      title: post.title,
      brief: post.brief,
      palette: monthPaletteOf(theme).length ? monthPaletteOf(theme) : paletteOf(client),
      paletteChosen: monthPaletteOf(theme).length > 0,
      style: client.style,
      theme: theme ? [theme.goal, theme.description].filter(Boolean).join("\n") : "",
      library: theme?.library || undefined,
      props: theme?.props?.trim() || undefined,
      shot: theme && post.shot ? shotsOf(theme)[post.shot - 1] : undefined,
      always: client.dos?.trim() || undefined,
      never: client.donts?.trim() || undefined,
      grid: config.gridRef ? config.gridNotes || undefined : undefined,
      tile: config.gridRef ? post.tile : undefined,
      format: config.format ?? "4:5",
      ref: refId,
      refIsSource: !product && !!refId,
      hasProduct: !!product,
      // Only what the photo shows: a file name in the prompt ends up printed on the packaging.
      product: product ? product.note?.trim() || undefined : undefined,
      productNames: product ? productNames : undefined,
      extraProducts: extraProducts.length ? extraProducts : undefined,
      ambassadors: (() => {
        const list = (post.people ?? [])
          .map((n) => cast.find((a) => a.name.trim().toLowerCase() === n.trim().toLowerCase()))
          .filter((a): a is AmbassadorRow => !!a)
          .slice(0, 3)
          .map((a) => ({ name: a.name, description: a.description, key: a.image_key! }));
        return list.length ? list : undefined;
      })(),
    };
    const prompt = buildPostPrompt(brief);
    const caption = JSON.stringify({ text: post.caption, hashtags: post.hashtags });
    if (existing)
      statements.push(
        c.env.DB.prepare(
          "UPDATE tasks SET status = 'queued', source = ?, prompt = ?, brief = ?, caption = ?, error = NULL, edit = NULL, recenter = 0, attempts = 0, request_id = NULL, lease = NULL, leased_at = NULL, updated = ? WHERE id = ? AND status NOT IN ('processing','finalizing')",
        ).bind(sourceId, prompt, JSON.stringify(brief), caption, now(), existing.id),
      );
    else
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO tasks (id, batch, source, card, status, prompt, brief, post, caption, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
        ).bind(
          uuid(),
          b.id,
          sourceId,
          post.index,
          prompt,
          JSON.stringify(brief),
          post.index,
          caption,
          now(),
        ),
      );
    planned++;
  }
  if (!planned) throw new StudioError("Nothing to generate: every post already has an image.");
  statements.push(
    c.env.DB
      .prepare(
        "UPDATE batches SET state = 'running', last_error = NULL, updated = ? WHERE id = ?",
      )
      .bind(now(), b.id),
  );
  await c.env.DB.batch(statements);
  c.executionCtx.waitUntil(
    advanceBatch(c.env, b.id, {
      background: (p) => c.executionCtx.waitUntil(p),
      deferSync: true,
    }).catch((e) => console.error("[posts] first pass failed", e)),
  );
  return c.json({ ok: true, planned });
});

/** Remove a product upload from the plan (its posts keep nothing: their tasks are removed too). */
postRoutes.delete("/product", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const id = c.req.query("id") ?? "";
  const src = await first<{ id: string; key: string; reference_key: string | null; kind: string }>(
    c.env.DB,
    "SELECT id, key, reference_key, kind FROM sources WHERE id = ? AND batch = ?",
    id,
    b.id,
  );
  if (!src) throw new StudioError("Product not found.", 404);
  const busy = await first<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM tasks WHERE source = ? AND status IN ('processing','finalizing')",
    src.id,
  );
  if (busy?.n) throw new StudioError("A post using this product is generating. Wait for it first.", 409);
  const outputs = await all<{ output: string | null }>(
    c.env.DB,
    "SELECT output FROM tasks WHERE source = ?",
    src.id,
  );
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tasks WHERE source = ?").bind(src.id),
    c.env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(src.id),
  ]);
  const keys = outputs.map((o) => o.output).filter((k): k is string => !!k);
  if (src.kind === "product") keys.push(src.key, ...(src.reference_key ? [src.reference_key] : []));
  if (keys.length) await c.env.BUCKET.delete(keys);
  return c.json({ ok: true });
});

postRoutes.put("/caption", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      id: z.string().min(1),
      text: z.string().max(2200),
      hashtags: z.string().max(400),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const changed = await run(
    c.env.DB,
    "UPDATE tasks SET caption = ?, updated = ? WHERE id = ? AND batch = ?",
    JSON.stringify({ text: d.text, hashtags: d.hashtags }),
    now(),
    d.id,
    b.id,
  );
  if (!changed) throw new StudioError("Post not found.", 404);
  // Keep the plan in step so a later regeneration carries the edited caption.
  const config = JSON.parse(b.config) as Config;
  const task = await first<{ post: number | null }>(
    c.env.DB,
    "SELECT post FROM tasks WHERE id = ?",
    d.id,
  );
  const p = config.plan?.find((x) => x.index === task?.post);
  if (p) {
    p.caption = d.text;
    p.hashtags = d.hashtags;
    await saveConfig(c.env, b, config);
  }
  return c.json({ ok: true });
});

/** captions.csv for the month: one row per generated post, file names as the export names them. */
postRoutes.get("/captions.csv", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const config = JSON.parse(b.config) as Config;
  const client = await clientRow(c.env, config.client);
  const tasks = await all<{ post: number | null; caption: string | null; output: string | null }>(
    c.env.DB,
    "SELECT post, caption, output FROM tasks WHERE batch = ? AND post IS NOT NULL ORDER BY post",
    b.id,
  );
  const rows = tasks.map((t) => {
    const p = config.plan?.find((x) => x.index === t.post);
    let cap = { text: "", hashtags: "" };
    try {
      cap = { ...cap, ...(JSON.parse(t.caption ?? "{}") as Partial<typeof cap>) };
    } catch {
      /* empty */
    }
    return {
      index: t.post!,
      type: p?.type ?? "",
      title: p?.title ?? "",
      file: postFileName(client.slug, config.month ?? "", t.post!, "jpg"),
      caption: cap.text,
      hashtags: cap.hashtags,
    };
  });
  return new Response(captionsCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${client.slug}_${config.month ?? "month"}_captions.csv"`,
    },
  });
});

export type { Post };
