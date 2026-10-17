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
import { advanceBatch, makeGoogleClient } from "./engine";
import { GOOGLE_MODELS, isGoogleModel } from "./google";
import { cleanGrid, testGridLayout, testGridPrompt, tileCell, type TestGridInfo } from "@shared/testgrid";
import { ambassadorRows, type AmbassadorRow } from "./ambassadors";
import { castLook } from "@shared/cast";
import { styleRow, type StyleRow } from "./styles";
import { ADAPT_SCHEMA, adaptStyleInstruction, gridPostCount } from "@shared/styles";
import { profileBrief, type ClientProfile } from "@shared/profile";
import { testSize } from "@shared/pricing";
import { postSchema } from "@shared/config-schema";
import { HOSTED_FONTS, resolveOverlay } from "@shared/overlay";
import { BRIEF_STEPS, postConfig, type BriefNote, type BriefStep, type Config } from "@shared/config";
import { requireActiveClient } from "./clients";
import { adaptShotsInstruction, BRIEF_SCHEMA, briefInstruction, briefLines, FOREIGN_ITEMS, parseBrief, SHOTS_SCHEMA, type ShotPost } from "@shared/brief";
import { occasionsOf, pickedOccasions, withDates } from "@shared/occasions";
import { stemKey, stemOf } from "@shared/naming";
import { clientDrivePhotos, importDrivePhoto } from "./drive";
import { freeName } from "@shared/drive";
import { renameProduct } from "@shared/qa";
import {
  NO_PRODUCT_TILES,
  PRODUCT_MATCH_SCHEMA,
  parseMatches,
  productMatchInstruction,
  type MatchPost,
  type ProductMatch,
  type ProductOption,
} from "@shared/drive";
import {
  buildPostPrompt,
  colourLabel,
  decodeEntities,
  photoRules,
  withoutColourWords,
  withoutPaletteText,
  withoutProductNames,
  captionsCsv,
  CAPTION_SCHEMA,
  captionFromImageInstruction,
  parseCaption,
  GRID_SCHEMA,
  gridIdeasInstruction,
  gridNotes,
  hexIn,
  overlayFromTile,
  TEXTURED_BACKGROUND,
  tileSpecOf,
  type GridFonts,
  IDEAS_SCHEMA,
  type GridRead,
  IDENTITY_SCHEMA,
  identityBuilderInstruction,
  ideasInstruction,
  MAX_POST_COUNT,
  matchProduct,
  monthLabel,
  offerReady,
  parseIdeas,
  PRODUCT_NOTE_SCHEMA,
  productNoteInstruction,
  PALETTE_SCHEMA,
  paletteInstruction,
  gridPaletteInstruction,
  outfitsOf,
  WARDROBE_SCHEMA,
  wardrobeInstruction,
  parsePalette,
  singleIdeaInstruction,
  type IdeasRequest,
  POST_TYPES,
  POST_TYPE_INFO,
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

export function parseJson<T>(text: string): T {
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
  service?: string | null;
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

/** The client's profile in a few lines (from its Analysis), for the writers; '' before one exists. */
export async function profileOf(env: Env, clientId: string): Promise<string> {
  const r = await first<{ profile: string | null }>(env.DB, "SELECT profile FROM client_profiles WHERE client = ?", clientId).catch(() => null);
  try {
    return profileBrief(r?.profile ? (JSON.parse(r.profile) as ClientProfile) : null);
  } catch {
    return "";
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
  wardrobe?: string;
  /** JSON array of strings. */
  shots: string | null;
  /** JSON array of {name, hex}. */
  palette: string | null;
  palette_auto: number | null;
  analysed?: number | null;
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

/** The theme's shots changed: months that rewrote the old ones write them again. */
async function dropMonthShots(env: Env, themeId: string): Promise<void> {
  await run(
    env.DB,
    "UPDATE batches SET config = json_remove(config, '$.shots', '$.shotsFor') WHERE theme = ? AND json_extract(config, '$.shots') IS NOT NULL",
    themeId,
  );
}

/** The pins' shots the ideas are planned over (each post gets its own scene later). */
function monthShots(_config: Config, theme: ThemeRow | null): string[] {
  return theme ? shotsOf(theme) : [];
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
  const counts = await all<{ skill: string; n: number; latest: number; thumb: string }>(
    env.DB,
    `SELECT skill, COUNT(*) AS n, MAX(created) AS latest, (SELECT id FROM refs r2 WHERE r2.skill = r.skill ORDER BY created LIMIT 1) AS thumb
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
    wardrobe: r.wardrobe ?? "",
    shots: shotsOf(r),
    palette: themePaletteOf(r),
    paletteAuto: r.palette_auto !== 0,
    hidden: !!r.hidden,
    references: byId.get(r.id)?.n ?? 0,
    thumb: byId.get(r.id)?.thumb,
    updated: r.updated,
    analysed: r.analysed ?? undefined,
    latestRef: byId.get(r.id)?.latest ?? undefined,
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
      wardrobe: z.string().trim().max(2000).optional(),
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
    "UPDATE skills SET title = ?, description = ?, goal = ?, library = ?, props = ?, wardrobe = ?, shots = ?, updated = ? WHERE id = ?",
    d.title ?? row.title,
    d.description ?? row.description,
    d.direction ?? row.goal,
    d.library ?? row.library,
    d.props ?? row.props ?? "",
    d.wardrobe ?? row.wardrobe ?? "",
    d.shots ? JSON.stringify(d.shots.filter((x) => x.trim())) : row.shots || "[]",
    now(),
    row.id,
  );
  if (d.shots) await dropMonthShots(c.env, row.id);
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
    "UPDATE skills SET description = ?, goal = ?, library = ?, shots = ?, auto = 1, updated = ?, analysed = ? WHERE id = ?",
    (d.description ?? "").trim().slice(0, 300),
    d.direction.trim(),
    d.library.trim(),
    JSON.stringify(shots),
    now(),
    now(),
    row.id,
  );
  await dropMonthShots(env, row.id);
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
  // A month that follows a grid takes its colours from that grid, not from the theme's pins.
  const grid = String(((await c.req.json().catch(() => ({}))) as { grid?: unknown }).grid ?? "").slice(0, 120);
  const gridRow = grid ? await gridImage(c.env, grid) : null;
  const gridObj = gridRow ? await c.env.BUCKET.get(gridRow.key) : null;
  const images = gridObj
    ? [{ bytes: await gridObj.arrayBuffer(), mime: gridObj.httpMetadata?.contentType || "image/jpeg" }]
    : await referenceImages(c.env, row.id, MAX_ANALYSE_IMAGES);
  if (!images.length) throw new StudioError("Add reference photos to this theme first.");
  const d = parseJson<{ palette?: unknown }>(
    await askText(c.env, gridObj ? gridPaletteInstruction() : paletteInstruction(images.length), PALETTE_SCHEMA, images),
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

/**
 * "Suggest" for the wardrobe: a few outfits for the month's people, in the month's colours, for the
 * grid or theme the month follows and each person's own rules (modest, hijab).
 */
postRoutes.post("/themes/:id/wardrobe", async (c) => {
  const row = await themeRow(c.env, c.req.param("id"));
  const batchId = String(((await c.req.json().catch(() => ({}))) as { batch?: unknown }).batch ?? "");
  const b = batchId ? await ownedPlan(c.env, c.get("user"), batchId).catch(() => null) : null;
  const config = b ? (JSON.parse(b.config) as Config) : null;
  const client = await clientRow(c.env, row.client ?? config?.client);
  const cast = config ? await monthAmbassadors(c.env, config) : (await ambassadorRows(c.env, client.id)).slice(0, 4);
  const palette = monthPaletteOf(row).length ? monthPaletteOf(row) : paletteOf(client);
  const d = parseJson<{ outfits?: unknown }>(
    await askText(
      c.env,
      wardrobeInstruction({
        client: client.name,
        palette,
        world: config?.gridRef ? config.gridNotes?.split("\n")[0] ?? "" : [row.goal, row.description].filter(Boolean).join(" "),
        people: cast.map((a) => ({ name: a.name, description: a.description, gender: a.gender, modest: a.modest !== 0, hijab: !!a.hijab })),
      }),
      WARDROBE_SCHEMA,
    ),
  );
  const outfits = (Array.isArray(d.outfits) ? d.outfits : []).map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
  if (!outfits.length) throw new StudioError("The model returned no outfits. Try again.", 502);
  await run(c.env.DB, "UPDATE skills SET wardrobe = ?, updated = ? WHERE id = ?", outfits.join("\n"), now(), row.id);
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
  category?: string | null;
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
  // Every writer and the image engine read the full look: gender and dress included.
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is AmbassadorRow => !!r)
    .slice(0, 3)
    .map((r) => ({ ...r, description: castLook({ ...r, modest: !!r.modest, hijab: !!r.hijab }) }));
}

/** A greeting post sits on its occasion's day. */
function greetingDates(plan: Post[], config: Config): Post[] {
  const picked = pickedOccasions(config.month ?? "", config.occasions);
  return plan.map((p) => {
    if (p.type !== "greeting") return p;
    const o = picked.find((x) => x.id === p.occasion) ?? picked.find((x) => x.date === p.date);
    return o ? { ...p, occasion: o.id, date: o.date, product: o.portrait ? undefined : p.product, people: o.portrait ? undefined : p.people } : p;
  });
}

/** Royal greeting posts carry the official portrait the team uploaded, framed on the design. */
function withPortraits(plan: Post[], config: Config, batchId: string): Post[] {
  const photos = config.occasions?.photos ?? {};
  return plan.map((p) => {
    if (p.type !== "greeting" || !p.occasion) return p;
    const key = photos[p.occasion];
    const ov = { ...(p.ov ?? {}) };
    if (key)
      ov.photo = `/api/studio/posts/occasion-photo?batch=${encodeURIComponent(batchId)}&occasion=${encodeURIComponent(p.occasion)}&v=${encodeURIComponent(key.slice(-8))}`;
    else delete ov.photo;
    return { ...p, ov };
  });
}

/** The fixed part of an ideas request: the client, its theme and its products. */
function ideasContext(
  client: ClientRow,
  theme: ThemeRow | null,
  config: Config,
  products: string[],
  productNotes: Record<string, string>,
  ambassadors: AmbassadorRow[] = [],
  profile = "",
): Omit<IdeasRequest, "count"> {
  // Chosen colours win: the colour words of the references and the brand style give way.
  const chosen = monthPaletteOf(theme).length > 0;
  const recolour = (t: string) => (chosen ? withoutPaletteText(t) : t);
  return {
    clientName: client.name,
    tone: client.tone,
    profile,
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
    shots: monthShots(config, theme).map((t) => (chosen ? withoutColourWords(t) : t)),
    products,
    productNotes,
    month: config.month ?? "",
    notes: config.notes,
    occasions: pickedOccasions(config.month ?? "", config.occasions).map((o) => ({
      id: o.id,
      date: o.date,
      name: o.name,
      elements: o.elements,
      portrait: o.portrait,
    })),
    // The shots are read after the ideas: their old reading never steers new ideas (props included).
    brief: briefLines(config.brief, ["shots"]),
    service: products.length ? undefined : client.service || undefined,
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
      /** The client has no photos of its shop: the post becomes a product post. */
      noPlace: z.boolean().optional(),
    }),
  );
  if (d.noPlace)
    d.wish = `${d.wish ? `${d.wish} ` : ""}The client has no photos of its shop or branch: this post shows one of its products instead (a close-up on a surface in the month's colours, with the tile's props), never an interior, a shop, a counter, shelves, or a wall with signs, logos or patterns.`;
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
    { ...ideasContext(client, theme, config, products, productNotes, cast, await profileOf(c.env, client.id)), count: 1 },
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
    occasion: current.occasion ?? fresh.occasion,
    // The post changed: its shot is written again on the shots screen.
    scene: undefined,
    // A place tile without photos of the shop becomes a food tile.
    tileSpec: d.noPlace && current.tileSpec?.kind === "place" ? { ...current.tileSpec, kind: "food" } : current.tileSpec,
  };
  // An offer shows exactly the designer's products.
  if (next.type === "offer" && next.offer?.products.length) {
    next.product = next.offer.products[0];
    next.products = next.offer.products.slice(1);
  }
  config.plan = withPortraits(plan.map((p) => (p.index === d.index ? next : p)), config, b.id);
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
    ...ideasContext(client, theme, config, products, productNotes, cast, await profileOf(c.env, client.id)),
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
  config.plan = withPortraits(withDates(greetingDates(plan, config), config.month ?? ""), config, b.id);
  // The writer may skip a picked occasion: it gets its greeting post all the same.
  config.plan = (await ensureOccasionPosts(c.env, b.id, config, client, theme, products, productNotes, cast)).plan;
  config.plannedAt = now();
  config.postCount = count;
  await refreshCountNote(c.env, b.id, config);
  if (d.notes !== undefined) config.notes = d.notes;
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan: config.plan });
});

/**
 * Every picked occasion has its greeting post. One that is missing (picked after the ideas were
 * written, or skipped by the writer) takes the post closest to its day that is not already an
 * occasion or an offer; only that post is written again, with its caption.
 */
async function ensureOccasionPosts(
  env: Env,
  batchId: string,
  config: Config,
  client: ClientRow,
  theme: ThemeRow | null,
  products: string[],
  productNotes: Record<string, string>,
  cast: AmbassadorRow[],
): Promise<{ plan: Post[]; added: string[] }> {
  const month = config.month ?? "";
  let plan = config.plan ?? [];
  const added: string[] = [];
  const day = (d?: string) => (d ? Number(d.slice(8, 10)) : 15);
  for (const o of pickedOccasions(month, config.occasions)) {
    if (plan.some((p) => p.type === "greeting" && p.occasion === o.id)) continue;
    const target = plan
      .filter((p) => p.type !== "greeting" && p.type !== "offer")
      .sort((a, b) => Math.abs(day(a.date) - day(o.date)) - Math.abs(day(b.date) - day(o.date)))[0];
    if (!target) break;
    const draft: Post = {
      ...target,
      type: "greeting",
      occasion: o.id,
      date: o.date,
      product: o.portrait ? undefined : target.product,
      products: o.portrait ? undefined : target.products,
      people: o.portrait ? undefined : target.people,
      scene: undefined,
    };
    const instruction = singleIdeaInstruction(
      { ...ideasContext(client, theme, config, products, productNotes, cast, await profileOf(env, client.id)), count: 1 },
      draft,
      plan.filter((p) => p.index !== target.index).map((p) => p.title),
      `This post is now the greeting for ${o.name} on ${o.date}: a greeting headline and a caption for the day, in the client's tone.`,
    );
    const [fresh] = parseIdeas(await askText(env, instruction, IDEAS_SCHEMA), 1, products, cast.map((a) => a.name));
    if (!fresh) continue;
    const next: Post = {
      ...draft,
      title: fresh.title,
      brief: fresh.brief,
      caption: fresh.caption,
      hashtags: fresh.hashtags,
      headline: fresh.headline,
      subline: hidesSubline(client) ? undefined : fresh.subline,
      product: o.portrait ? undefined : (fresh.product ?? draft.product),
      products: o.portrait ? undefined : (fresh.products ?? draft.products),
      people: o.portrait ? undefined : fresh.people,
    };
    plan = plan.map((p) => (p.index === target.index ? next : p));
    added.push(o.name);
  }
  return { plan: withPortraits(withDates(plan, month), config, batchId), added };
}

/** Occasions picked after the ideas were written get their greeting posts (the rest stays). */
postRoutes.post("/occasion-posts", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  if (!config.plan?.length) return c.json({ ok: true, added: [], plan: [] });
  const client = await clientRow(c.env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  const products = [...new Set(sources.map(productName))];
  const productNotes = Object.fromEntries(sources.filter((s) => s.note).map((s) => [productName(s), s.note!]));
  const cast = await monthAmbassadors(c.env, config);
  const r = await ensureOccasionPosts(c.env, b.id, config, client, theme, products, productNotes, cast);
  if (r.added.length) {
    const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
    const cfg = JSON.parse(fresh.config) as Config;
    cfg.plan = r.plan;
    await saveConfig(c.env, fresh, cfg);
  }
  return c.json({ ok: true, added: r.added, plan: r.plan });
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
  const ref = await gridImage(c.env, d.ref);
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
  const hasPlaces = !!(await first(c.env.DB, "SELECT 1 AS x FROM brand_assets WHERE client = ? AND kind = 'place' LIMIT 1", client.id));
  const instruction = gridIdeasInstruction({
    hasPlaces,
    clientName: client.name,
    tone: client.tone,
    profile: await profileOf(c.env, client.id),
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
    if (t) p.tile = `Tile ${i + 1} (${t.position}): ${t.scene} Product: ${t.productPlacement}${t.items ? ` Items: ${t.items}` : ""}`;
    // The tile's own role and lettering: a text tile becomes a typographic post, and the words sit
    // where the tile has them.
    const spec = tileSpecOf(t);
    // Without photos of the client's shop, a place tile is written as a food tile: no invented interior.
    if (spec?.kind === "place" && !hasPlaces) spec.kind = "food";
    if (spec) {
      p.tileSpec = spec;
      Object.assign(p, overlayFromTile(spec.text, spec.kind));
    }
    if (m) p.title = p.title.slice(m[0].length).trim() || p.title;
  }
  // The feed shows the newest post first (top left): the posts are posted from the grid's last
  // tile to its first, so at the end of the month the feed reads exactly like the reference.
  const posted = [...plan].reverse().map((p, i) => ({ ...p, index: i + 1 }));
  config.plan = withDates(posted, config.month ?? "");
  config.plannedAt = now();
  config.postCount = count;
  config.gridRef = ref.id;
  config.gridNotes = gridNotes(grid).slice(0, 12000);
  // The fonts closest to the grid's lettering, offered to the designer for this month.
  const f = (read as { fonts?: Partial<GridFonts> }).fonts;
  if (f?.headline && HOSTED_FONTS.includes(f.headline))
    config.gridFonts = { headline: f.headline, body: f.body && HOSTED_FONTS.includes(f.body) ? f.body : f.headline, why: String(f.why ?? "").slice(0, 400) };
  else delete config.gridFonts;
  if (d.notes !== undefined) config.notes = d.notes;
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan: config.plan, grid });
});

/** The designer's edits of the plan. */
postRoutes.put("/plan", async (c) => {
  const d = await body(
    c,
    z.object({ batch: z.string().min(1), plan: z.array(postSchema).max(MAX_POST_COUNT) }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const before = new Map((config.plan ?? []).map((p) => [p.index, p]));
  config.plan = d.plan.map((p, i) => ({ ...p, index: i + 1 }));
  // A caption edited by hand is the designer's: the post's task carries it, and a new image keeps it.
  for (const p of config.plan) {
    const old = before.get(p.index);
    if (!old || (old.caption === p.caption && old.hashtags === p.hashtags)) continue;
    p.captionHand = true;
    await run(
      c.env.DB,
      "UPDATE tasks SET caption = ? WHERE batch = ? AND post = ?",
      JSON.stringify({ text: p.caption, hashtags: p.hashtags }),
      b.id,
      p.index,
    );
  }
  // Adding or removing posts by hand sets the month's count, so Regenerate ideas keeps that number.
  if (config.plan.length) config.postCount = config.plan.length;
  await refreshCountNote(c.env, b.id, config);
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
      /** The fonts this month uses instead of the brand's (the grid's recommendation), or null for the brand's. */
      monthFonts: z.object({ headline: z.string().max(80), body: z.string().max(80) }).nullable().optional(),
      /** A grid from the style library ("style:<id>"), or null to take the grid off. */
      gridRef: z.string().regex(/^style:[\w-]{1,80}$/).nullable().optional(),
      ambassadors: z.array(z.string().max(80)).max(3).optional(),
      exact: z.boolean().optional(),
      shots: z.array(z.string().trim().max(1200)).max(200).optional(),
      occasions: z
        .object({
          picked: z.array(z.string().max(80)).max(60).optional(),
          custom: z
            .array(
              z.object({
                id: z.string().regex(/^c-[a-z0-9-]{1,40}$/),
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                name: z.string().trim().min(1).max(80),
                elements: z.string().trim().max(300).optional(),
              }),
            )
            .max(30)
            .optional(),
        })
        .optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  if (d.occasions)
    config.occasions = {
      ...(config.occasions ?? {}),
      ...(d.occasions.picked ? { picked: [...new Set(d.occasions.picked)] } : {}),
      ...(d.occasions.custom ? { custom: d.occasions.custom } : {}),
    };
  // A new theme brings its own shots: the month's rewrite of the old ones is dropped.
  if (d.theme !== undefined && (d.theme ?? undefined) !== config.theme) {
    delete config.shots;
    delete config.shotsFor;
  }
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
  if (d.postCount) {
    config.postCount = d.postCount;
    await refreshCountNote(c.env, b.id, config);
  }
  if (d.notes !== undefined) config.notes = d.notes;
  if (d.ambassadors) config.ambassadors = [...new Set(d.ambassadors)].slice(0, 3);
  if (d.exact !== undefined) config.exact = d.exact || undefined;
  if (d.monthFonts === null) delete config.monthFonts;
  else if (d.monthFonts) {
    if (!HOSTED_FONTS.includes(d.monthFonts.headline) || !HOSTED_FONTS.includes(d.monthFonts.body)) throw new StudioError("Pick fonts from the list.");
    config.monthFonts = d.monthFonts;
  }
  if (d.gridRef === null) {
    delete config.gridRef;
    delete config.gridNotes;
    config.gridAt = now();
  } else if (d.gridRef) {
    const st = await first<{ tiles: number; category: string; status: string }>(c.env.DB, "SELECT tiles, category, status FROM styles WHERE id = ?", d.gridRef.slice(6));
    if (!st || st.category !== "grid" || st.status !== "active") throw new StudioError("That grid is not in the library.", 404);
    // The month takes the grid's posts: one per tile. Its tiles are read when the ideas are written.
    if (config.gridRef !== d.gridRef) delete config.gridNotes;
    config.gridRef = d.gridRef;
    config.gridAt = now();
    config.postCount = gridPostCount(st.tiles, config.postCount ?? 12);
    await refreshCountNote(c.env, b.id, config);
  }
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, config });
});

/** The month's grid picture: a theme photo (refs) or a grid from the style library ("style:<id>"). */
/**
 * A post's own tile, cut once from the month's grid and kept next to it; null when the tile is not
 * one to copy closely or the grid is not a clean grid of cells.
 */
async function gridTileKey(env: Env, gridKey: string, cell: { row: number; col: number; rows: number; cols: number }): Promise<string | null> {
  const key = `${gridKey}.tile-${cell.rows}x${cell.cols}-${cell.row}-${cell.col}.jpg`;
  if (await env.BUCKET.head(key)) return key;
  const obj = await env.BUCKET.get(gridKey);
  if (!obj || (obj.size ?? 0) > 12_000_000) return null;
  const { PhotonImage, crop } = await import("@cf-wasm/photon");
  const img = PhotonImage.new_from_byteslice(new Uint8Array(await obj.arrayBuffer()));
  try {
    const w = img.get_width();
    const h = img.get_height();
    if (!cleanGrid(w, h, cell.rows, cell.cols)) return null;
    const cw = w / cell.cols;
    const ch = h / cell.rows;
    // A little inside the cell, so the white lines between tiles stay out.
    const inset = Math.round(Math.min(cw, ch) * 0.03);
    const x1 = Math.round((cell.col - 1) * cw) + inset;
    const y1 = Math.round((cell.row - 1) * ch) + inset;
    const cut = crop(img, x1, y1, Math.round(cell.col * cw) - inset, Math.round(cell.row * ch) - inset);
    try {
      await env.BUCKET.put(key, cut.get_bytes_jpeg(90), { httpMetadata: { contentType: "image/jpeg" } });
    } finally {
      cut.free();
    }
    return key;
  } catch (e) {
    console.error("[grid] tile", errorMessage(e));
    return null;
  } finally {
    img.free();
  }
}

async function gridImage(env: Env, gridRef: string | undefined): Promise<{ id: string; key: string } | null> {
  if (!gridRef) return null;
  if (gridRef.startsWith("style:")) {
    const st = await first<{ image_key: string | null }>(env.DB, "SELECT image_key FROM styles WHERE id = ?", gridRef.slice(6));
    return st?.image_key ? { id: gridRef, key: st.image_key } : null;
  }
  return first<{ id: string; key: string }>(env.DB, "SELECT id, key FROM refs WHERE id = ?", gridRef);
}

interface TaskLite {
  id: string;
  post: number | null;
  status: string;
  output: string | null;
  brief: string | null;
}

/** A plain background in one colour, the size of the post: a typographic tile's picture. */
async function plainBackground(hex: string, format: string): Promise<ArrayBuffer> {
  const [w, h] = format === "1:1" ? [1080, 1080] : format === "9:16" ? [1080, 1920] : [1080, 1350];
  const n = parseInt(hex.slice(1), 16);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = (n >> 16) & 255;
    px[i + 1] = (n >> 8) & 255;
    px[i + 2] = n & 255;
    px[i + 3] = 255;
  }
  const { PhotonImage } = await import("@cf-wasm/photon");
  const img = new PhotonImage(px, w, h);
  try {
    const bytes = img.get_bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } finally {
    img.free();
  }
}

/** The month's source row for drawn backgrounds (a task always points at a source). */
async function designSourceOf(env: Env, batchId: string, key: string): Promise<string> {
  const found = await first<{ id: string }>(env.DB, "SELECT id FROM sources WHERE batch = ? AND stem = 'design-background'", batchId);
  if (found) return found.id;
  const id = uuid();
  await run(
    env.DB,
    "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created) VALUES (?, ?, 'design/background.png', 'design-background', ?, NULL, 'image/png', 0, 'supporting', 'reference', ?)",
    id,
    batchId,
    key,
    now(),
  );
  return id;
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
      /** One post first, to check the month's look before the rest is paid for. */
      test: z.boolean().optional(),
      /** The designer asked for another take of this post (the take count goes up). */
      retake: z.boolean().optional(),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  if (!plan.length) throw new StudioError("Generate ideas first, then the posts.");
  if (d.test && d.indexes?.length !== 1) throw new StudioError("A test is one post.");
  const draft = d.test && testSize(config.model, config.size) === "1K" && config.size !== "1K" ? ("1K" as const) : undefined;
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
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ?",
    b.id,
  );
  // A post may name a product this month does not have (removed, or from another month): it is
  // brought from the client's gallery; a picture is never made of a product nobody photographed.
  {
    const monthNames = sources.filter((x) => x.kind === "product").map(productName);
    const named = plan
      .filter((p) => !d.indexes || d.indexes.includes(p.index))
      .flatMap((p) => (p.type === "offer" && p.offer ? p.offer.products : [p.product, ...(p.products ?? [])]))
      .filter((n): n is string => !!n && !matchProduct(n, monthNames));
    if (named.length) {
      const gallery = await all<SourceRow>(
        c.env.DB,
        "SELECT s.id, s.name, s.stem, s.key, s.reference_key, s.kind, s.role, s.note FROM sources s JOIN batches bb ON bb.id = s.batch WHERE bb.client = ? AND s.kind = 'product' AND s.batch != ? ORDER BY s.created DESC LIMIT 400",
        config.client ?? "",
        b.id,
      );
      const galleryNames = gallery.map(productName);
      const have = new Set(sources.map((x) => x.stem));
      const notInGallery: string[] = [];
      for (const n of [...new Set(named)]) {
        const m = matchProduct(n, galleryNames);
        if (!m) {
          notInGallery.push(n);
          continue;
        }
        const row = await copyGalleryProduct(c.env, user.id, b, config.client, gallery[galleryNames.indexOf(m)].id, have);
        if (row) sources.push(row);
      }
      // Then the client's Drive: its newest photo of that product joins the month.
      const drive = notInGallery.length ? await clientDrivePhotos(c.env, config.client ?? "") : [];
      if (drive.length) {
        const newest = [...drive].sort((x, y) => y.modified.localeCompare(x.modified));
        const driveNames = [...new Set(newest.map((x) => x.name))];
        for (const n of notInGallery) {
          const m = matchProduct(n, driveNames);
          const photo = m ? newest.find((x) => x.name === m) : undefined;
          if (!photo) continue;
          try {
            sources.push(await importDrivePhoto(c.env, user.id, b.id, photo.id, n, have));
          } catch (e) {
            console.error("[generate] drive", n, errorMessage(e));
          }
        }
      }
    }
  }
  await describeProducts(c.env, sources);
  const sellsDrinks = sources.some((s) => s.kind === "product" && FOREIGN_ITEMS.test(`${s.note ?? ""} ${s.category ?? ""}`));
  const tasks = await all<TaskLite>(
    c.env.DB,
    "SELECT id, post, status, output, brief FROM tasks WHERE batch = ?",
    b.id,
  );
  const byPost = new Map(tasks.filter((t) => t.post).map((t) => [t.post!, t]));
  const isDraft = (t: TaskLite) => {
    try {
      return !!(t.brief && (JSON.parse(t.brief) as Partial<PostBrief>).draft);
    } catch {
      return false;
    }
  };
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
  // Posts with a gallery style use its picture as their style reference.
  const styleIds = [...new Set(plan.map((p) => p.style).filter((x): x is string => !!x))];
  const styles = new Map(
    (await Promise.all(styleIds.map((id) => styleRow(c.env, id))))
      .filter((r): r is StyleRow => !!r?.image_key)
      .map((r) => [r.id, r]),
  );
  const statements: D1PreparedStatement[] = [];
  let designSource: string | undefined;
  // Photos of the client's own place: a grid's place tile is set there, one photo after another.
  const places = await all<{ key: string }>(c.env.DB, "SELECT key FROM brand_assets WHERE client = ? AND kind = 'place' ORDER BY created", client.id);
  let placeTurn = 0;
  let planned = 0;
  const skipped: number[] = [];
  const missingProduct: { index: number; product: string }[] = [];
  const monthOccasions = pickedOccasions(config.month ?? "", config.occasions);
  for (const post of plan) {
    if (!wanted.has(post.index)) continue;
    // An offer is generated only once the designer filled it: products, price and contents.
    if (post.type === "offer" && !offerReady(post.offer)) {
      skipped.push(post.index);
      continue;
    }
    const occasion =
      post.type === "greeting"
        ? (monthOccasions.find((o) => o.id === post.occasion) ?? monthOccasions.find((o) => o.date === post.date))
        : undefined;
    // A royal day shows the official portrait (added on the design), never a product or a person.
    const portraitDay = !!occasion?.portrait;
    const typographic = config.gridRef && post.tileSpec?.kind === "text";
    const leadName = post.type === "offer" ? post.offer!.products[0] : portraitDay || typographic ? undefined : post.product;
    const extraNames = post.type === "offer" ? post.offer!.products.slice(1) : portraitDay || typographic ? [] : (post.products ?? []);
    const existing = byPost.get(post.index);
    if (existing) {
      const busy = existing.status === "processing" || existing.status === "finalizing";
      if (busy) continue;
      // A smaller test image is made again at the month's size with the rest.
      if (!d.regenerate && existing.status !== "failed" && !(isDraft(existing) && !d.test)) continue;
    }
    // A text tile of the grid is a typographic post. A plain background is drawn here, exactly in its
    // colour and without the image engine; the headline goes on it as the tile has it.
    const spec = config.gridRef ? post.tileSpec : undefined;
    if (spec?.kind === "text" && !TEXTURED_BACKGROUND.test(spec.background)) {
      const taskId = existing?.id ?? uuid();
      const colour = hexIn(spec.background, monthPaletteOf(theme)[0] ? hexIn(monthPaletteOf(theme)[0], "#f3ece0") : hexIn(paletteOf(client)[0], "#f3ece0"));
      const key = `${b.owner}/${b.id}/output/${taskId}/${uuid()}.png`;
      await c.env.BUCKET.put(key, await plainBackground(colour, config.format ?? "4:5"), { httpMetadata: { contentType: "image/png" } });
      designSource ??= await designSourceOf(c.env, b.id, key);
      const qa = JSON.stringify({ found: false, count: 0, box: [], productConcern: false, notes: "A typographic post: its background is drawn in the tile's colour.", automated: true, flags: [] });
      const brief = JSON.stringify({ post: true, index: post.index, type: post.type, typographic: true, background: colour });
      const caption = JSON.stringify({ text: post.caption, hashtags: post.hashtags });
      statements.push(
        existing
          ? c.env.DB.prepare(
              "UPDATE tasks SET status = 'ready', source = ?, output = ?, prompt = '', brief = ?, caption = ?, qa = ?, error = NULL, edit = NULL, attempts = 0, request_id = NULL, lease = NULL, leased_at = NULL, updated = ? WHERE id = ?",
            ).bind(designSource, key, brief, caption, qa, now(), existing.id)
          : c.env.DB.prepare(
              "INSERT INTO tasks (id, batch, source, card, status, output, prompt, brief, post, caption, qa, updated) VALUES (?, ?, ?, ?, 'ready', ?, '', ?, ?, ?, ?, ?)",
            ).bind(taskId, b.id, designSource, post.index, key, brief, post.index, caption, qa, now()),
      );
      planned++;
      continue;
    }
    // A textured one (paper, marble…) is painted by the engine: its background only.
    const textured = spec?.kind === "text";
    const productSources = sources.filter((s) => s.kind === "product");
    const productNames = productSources.map(productName);
    const productMatch = matchProduct(leadName, productNames);
    if (leadName && !productMatch) {
      missingProduct.push({ index: post.index, product: leadName });
      continue;
    }
    const product = productMatch
      ? productSources.find((s) => productName(s) === productMatch)
      : undefined;
    // Further products shown in the same picture, attached after image 1.
    const extraProducts = product
      ? [...new Set(extraNames.map((n) => matchProduct(n, productNames)))]
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
    const gridRef = await gridImage(c.env, config.gridRef);
    if (gridRef && !refs.some((r) => r.id === gridRef.id)) refs.push(gridRef);
    const styled = post.style ? styles.get(post.style) : undefined;
    const refId = styled ? null : gridRef ? gridRef.id : pickLeastUsed(refs, used);
    if (refId) used.set(refId, (used.get(refId) ?? 0) + 1);
    // Exact product mode: one product, set into the picture afterwards; the reference is image 1.
    // Only a photo on a plain background is set in exactly; any other is drawn from its photo.
    const exactProduct =
      config.exact && product && !extraProducts.length && post.type !== "offer" && (refId || styled) && (await import("./exact").then((m) => m.cutsCleanly(c.env, product)))
        ? product
        : undefined;
    let sourceId = exactProduct ? undefined : product?.id;
    if (!sourceId && styled) {
      // No product photo in the picture: the style's own picture is image 1.
      const stem = `style-${styled.id}`;
      const existingStyle = sources.find((s) => s.stem === stem);
      if (existingStyle) sourceId = existingStyle.id;
      else {
        sourceId = uuid();
        await run(
          c.env.DB,
          "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created) VALUES (?, ?, ?, ?, ?, NULL, 'image/jpeg', 0, 'supporting', 'reference', ?)",
          sourceId,
          b.id,
          `style/${styled.id}.jpg`,
          stem,
          styled.image_key,
          now(),
        );
        sources.push({ id: sourceId, name: `style/${styled.id}.jpg`, stem, key: styled.image_key!, kind: "reference", role: "supporting" });
      }
    }
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
    // Only the designer's own Retake of the same idea counts up (each take asks for a different
    // picture); a new idea, a new shot or the system making a post again starts at take 1.
    let take = 1;
    if (existing?.brief && d.regenerate && d.retake) {
      try {
        const prev = JSON.parse(existing.brief) as Partial<PostBrief>;
        const shot = textured ? spec!.background : post.scene?.trim() || undefined;
        if (prev.brief === post.brief && (prev.shot ?? undefined) === shot) take = (prev.take ?? 1) + 1;
      } catch {
        take = 1;
      }
    }
    // A grid month: the post's own tile, cut from the grid, is its reference (the whole grid otherwise).
    const cell = !styled && gridRef && !textured && product && !exactProduct ? tileCell(post.tile, config.gridNotes, plan) : null;
    const tileKey = cell && gridRef ? await gridTileKey(c.env, gridRef.key, cell) : null;
    const brief: PostBrief = {
      post: true,
      draft,
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
      design: textured ? "background" : undefined,
      place: spec?.kind === "place" && places.length ? places[placeTurn++ % places.length] : undefined,
      shot: textured ? spec!.background : post.scene?.trim() || (post.shot ? monthShots(config, theme)[post.shot - 1] : undefined),
      always: client.dos?.trim() || undefined,
      never: client.donts?.trim() || undefined,
      grid: config.gridRef ? config.gridNotes || undefined : undefined,
      tile: config.gridRef ? post.tile : undefined,
      format: config.format ?? "4:5",
      ref: refId,
      styleKey: styled?.image_key ?? undefined,
      // A grid month: the post's own tile, cut from the grid, is its reference (the whole grid otherwise).
      tileKey: tileKey ?? undefined,
      // People wear the month's wardrobe, one outfit after another across the posts.
      wardrobe: (() => {
        const outfits = outfitsOf(theme?.wardrobe);
        const withPeople = (post.people?.length ?? 0) > 0 || post.tileSpec?.kind === "person";
        return outfits.length && withPeople && !portraitDay ? outfits[(post.index - 1) % outfits.length] : undefined;
      })(),
      refIsSource: (!product || !!exactProduct) && !!(refId || styled),
      hasProduct: !!product && !exactProduct,
      exact: exactProduct ? { source: exactProduct.id } : undefined,
      // Only what the photo shows: a file name in the prompt ends up printed on the packaging.
      product: product ? product.note?.trim() || undefined : undefined,
      // Every name the post carries is kept off the picture, found in the month or not.
      productNames: [...productNames, ...(leadName ? [leadName] : []), ...extraNames.filter((n): n is string => !!n)],
      extraProducts: extraProducts.length ? extraProducts : undefined,
      occasion: occasion ? { name: occasion.name, elements: occasion.elements, portrait: portraitDay } : undefined,
      offer: post.type === "offer" ? post.offer : undefined,
      sellsDrinks: sellsDrinks || undefined,
      occasionId: post.occasion || undefined,
      ambassadors: (() => {
        if (portraitDay) return undefined;
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
  if (d.test) {
    config.testPost = d.indexes![0];
    statements.push(
      c.env.DB.prepare("UPDATE batches SET config = ? WHERE id = ?").bind(JSON.stringify(config), b.id),
    );
  }
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
  return c.json({ ok: true, planned, skipped, missingProduct, draft: !!draft });
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
    p.captionHand = true;
    await saveConfig(c.env, b, config);
  }
  return c.json({ ok: true });
});

/**
 * Captions written from the finished pictures: every post whose image is newer than its caption
 * (a caption edited by hand stays), or the posts asked for again ("force").
 */
postRoutes.post("/captions", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      indexes: z.array(z.number().int().min(1).max(MAX_POST_COUNT)).max(MAX_POST_COUNT).optional(),
      force: z.boolean().optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const client = await clientRow(c.env, config.client);
  const tasks = await all<{ id: string; post: number | null; output: string | null }>(
    c.env.DB,
    "SELECT id, post, output FROM tasks WHERE batch = ? AND post IS NOT NULL AND output IS NOT NULL",
    b.id,
  );
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product'",
    b.id,
  );
  const notes = new Map(sources.map((s) => [productName(s).trim().toLowerCase(), s.note ?? undefined]));
  const occasions = pickedOccasions(config.month ?? "", config.occasions);
  const due = (config.plan ?? []).flatMap((p) => {
    const t = tasks.find((x) => x.post === p.index);
    if (!t?.output) return [];
    if (d.indexes && !d.indexes.includes(p.index)) return [];
    if (!(d.force && d.indexes) && (p.captionHand || p.captionFrom === t.output)) return [];
    return [{ post: p, task: t, output: t.output }];
  });
  const language = (["ar", "en", "both"].includes(client.language) ? client.language : "ar") as "ar" | "en" | "both";
  const profile = await profileOf(c.env, client.id);
  const written = new Map<number, { caption: string; hashtags: string; from: string }>();
  const failed: number[] = [];
  const write = async ({ post: p, task, output }: (typeof due)[number]) => {
    const obj = await c.env.BUCKET.get(output);
    if (!obj) return void failed.push(p.index);
    const names = [p.product, ...(p.products ?? [])].filter((n): n is string => !!n);
    const occ = occasions.find((o) => o.id === p.occasion);
    const instruction = captionFromImageInstruction({
      clientName: client.name,
      tone: client.tone,
      language,
      dos: photoRules(client.dos),
      donts: photoRules(client.donts),
      post: p,
      profile,
      occasion: occ ? { name: occ.name, date: occ.date } : undefined,
      products: names.map((n) => ({ name: n.trim(), note: notes.get(n.trim().toLowerCase()) })),
    });
    try {
      const image = { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" };
      const r = parseCaption(await askText(c.env, instruction, CAPTION_SCHEMA, [image]));
      if (!r) return void failed.push(p.index);
      written.set(p.index, { ...r, from: output });
      await run(
        c.env.DB,
        "UPDATE tasks SET caption = ? WHERE id = ?",
        JSON.stringify({ text: r.caption, hashtags: r.hashtags }),
        task.id,
      );
    } catch (e) {
      console.log(`[captions] post ${p.index}: ${errorMessage(e).slice(0, 160)}`);
      failed.push(p.index);
    }
  };
  // A few at a time: each one reads a full-size picture.
  for (let i = 0; i < due.length; i += 4) await Promise.all(due.slice(i, i + 4).map(write));
  // The month is read again before saving: edits made while the captions were written stay.
  const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
  const latest = JSON.parse(fresh.config) as Config;
  for (const p of latest.plan ?? []) {
    const w = written.get(p.index);
    if (!w) continue;
    p.caption = w.caption;
    p.hashtags = w.hashtags;
    p.captionFrom = w.from;
    p.captionHand = undefined;
  }
  if (written.size) await saveConfig(c.env, fresh, latest);
  return c.json({ ok: true, plan: latest.plan ?? [], written: [...written.keys()], failed });
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


/* ───────────── Journey: product gallery, the brief, the approval link ───────────── */

interface GalleryRow {
  id: string;
  batch: string;
  name: string;
  stem: string;
  note: string | null;
  category: string | null;
  month: string | null;
  created: number;
}

/** Every product photo ever uploaded for the client, newest copy of each name first. */
postRoutes.get("/gallery", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const rows = await all<GalleryRow>(
    c.env.DB,
    "SELECT s.id, s.batch, s.name, s.stem, s.note, s.category, b.month, s.created FROM sources s JOIN batches b ON b.id = s.batch WHERE b.client = ? AND s.kind = 'product' ORDER BY s.created DESC LIMIT 400",
    client,
  );
  const seen = new Set<string>();
  const items = [];
  for (const r of rows) {
    const name = productName(r as unknown as SourceRow);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id: r.id, name, note: r.note ?? "", category: r.category ?? "", month: r.month ?? "" });
  }
  return c.json({ items });
});

/** The small copy of one gallery photo (any month of the client). */
postRoutes.get("/gallery/image", async (c) => {
  const row = await first<{ key: string; reference_key: string | null }>(
    c.env.DB,
    "SELECT key, reference_key FROM sources WHERE id = ? AND kind = 'product'",
    c.req.query("id") ?? "",
  );
  const obj = row ? await c.env.BUCKET.get(row.reference_key || row.key) : null;
  if (!obj) throw new StudioError("Image not found.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/**
 * Copies one product photo of the client's gallery (any month) into this month, as its own files,
 * so deleting the other month never breaks it. Returns the new row, or null when it is not the
 * client's, the month already has it, or its file is gone.
 */
async function copyGalleryProduct(
  env: Env,
  userId: string,
  b: BatchRow,
  client: string | undefined,
  id: string,
  have: Set<string>,
): Promise<SourceRow | null> {
  const src = await first<{
    name: string;
    stem: string;
    key: string;
    reference_key: string | null;
    mime: string;
    size: number;
    note: string | null;
    category: string | null;
    client: string | null;
  }>(
    env.DB,
    "SELECT s.name, s.stem, s.key, s.reference_key, s.mime, s.size, s.note, s.category, b.client FROM sources s JOIN batches b ON b.id = s.batch WHERE s.id = ? AND s.kind = 'product'",
    id,
  );
  if (!src || src.client !== client || have.has(src.stem)) return null;
  const newId = uuid();
  const key = `${userId}/${b.id}/source/${newId}`;
  const original = await env.BUCKET.get(src.key);
  if (!original) return null;
  // Bytes, not the stream: R2 needs a known length to store it again.
  await env.BUCKET.put(key, await original.arrayBuffer(), { httpMetadata: original.httpMetadata });
  let referenceKey: string | null = null;
  if (src.reference_key) {
    const small = await env.BUCKET.get(src.reference_key);
    if (small) {
      referenceKey = `${key}.reference`;
      await env.BUCKET.put(referenceKey, await small.arrayBuffer(), { httpMetadata: small.httpMetadata });
    }
  }
  await run(
    env.DB,
    "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, note, category, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', 'product', ?, ?, ?)",
    newId,
    b.id,
    src.name,
    src.stem,
    key,
    referenceKey,
    src.mime,
    src.size,
    src.note,
    src.category,
    now(),
  );
  have.add(src.stem);
  return { id: newId, name: src.name, stem: src.stem, key, kind: "product", role: "lead", reference_key: referenceKey, note: src.note };
}

/** Gallery photos join this month as its own copies, so deleting another month never breaks them. */
postRoutes.post("/gallery/add", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), ids: z.array(z.string().max(80)).min(1).max(60) }));
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const have = new Set(
    (await all<{ stem: string }>(c.env.DB, "SELECT stem FROM sources WHERE batch = ?", b.id)).map((r) => r.stem),
  );
  let added = 0;
  for (const id of d.ids) if (await copyGalleryProduct(c.env, user.id, b, config.client, id, have)) added++;
  await run(c.env.DB, "UPDATE batches SET updated = ? WHERE id = ?", now(), b.id);
  return c.json({ ok: true, added });
});

/* ───────────── Test grid: the month's feed in one picture ───────────── */

const testGridKey = (b: BatchRow) => `${b.owner}/${b.id}/testgrid`;

/**
 * Paints the month's whole feed as one picture (the cells in feed order, no words), from the shots,
 * the products and the grid the month follows. The studio draws the words on each cell.
 */
postRoutes.post("/test-grid", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  if (!plan.length) throw new StudioError("Write the month's posts first.");
  const client = await clientRow(c.env, config.client);
  const theme = config.theme ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme) : null;
  const layout = testGridLayout(plan);
  const shown = plan.filter((p) => layout.order.includes(p.index));
  // The products the cells show, a small copy of each (six at most).
  const sources = await all<SourceRow & { size: number }>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, size FROM sources WHERE batch = ? AND kind = 'product'",
    b.id,
  );
  const names = sources.map(productName);
  const wanted = [...new Set(shown.flatMap((p) => [p.product, ...(p.products ?? [])]).map((n) => matchProduct(n, names)).filter((n): n is string => !!n))].slice(0, 6);
  const images: ImageBytes[] = [];
  const products: string[] = [];
  for (const n of wanted) {
    const s = sources[names.indexOf(n)];
    const obj = await c.env.BUCKET.get(s.reference_key || s.key);
    if (!obj || (obj.size ?? 0) > MAX_NOTE_BYTES) continue;
    images.push({ bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" });
    products.push(n);
  }
  const ref = await gridImage(c.env, config.gridRef);
  const refObj = ref ? await c.env.BUCKET.get(ref.key) : null;
  if (refObj && (refObj.size ?? 0) <= MAX_NOTE_BYTES) images.push({ bytes: await refObj.arrayBuffer(), mime: refObj.httpMetadata?.contentType || "image/jpeg" });
  const palette = theme && monthPaletteOf(theme).length ? monthPaletteOf(theme) : paletteOf(client);
  const prompt = testGridPrompt({ client: client.name, layout, plan, palette, products, reference: !!refObj && images.length > products.length });
  const engine = await makeGoogleClient(c.env);
  const model = isGoogleModel(config.model) ? config.model! : GOOGLE_MODELS[0].slug;
  const out = await engine.edit({ model, prompt, images, aspectRatio: layout.aspectRatio, size: "2K" });
  const info: TestGridInfo = { ...layout, at: now() };
  await c.env.BUCKET.put(testGridKey(b), out.bytes, { httpMetadata: { contentType: out.mime }, customMetadata: { info: JSON.stringify(info) } });
  return c.json({ ok: true, grid: info });
});

/** The month's test grid, if one was made: its layout (the picture is served below). */
postRoutes.get("/test-grid", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const head = await c.env.BUCKET.head(testGridKey(b));
  let grid: TestGridInfo | null = null;
  try {
    grid = head?.customMetadata?.info ? (JSON.parse(head.customMetadata.info) as TestGridInfo) : null;
  } catch {
    grid = null;
  }
  return c.json({ ok: true, grid });
});

postRoutes.get("/test-grid/image", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const obj = await c.env.BUCKET.get(testGridKey(b));
  if (!obj) throw new StudioError("No test grid yet.", 404);
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "private, max-age=3600" } });
});

/* ───────────── Products per post: recommended, chosen, replaced ───────────── */

/** Every product photo a post can use: this month's, the client's earlier months', its Drive's. */
async function productOptions(env: Env, b: BatchRow, client: string): Promise<ProductOption[]> {
  const month = await all<SourceRow>(env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name", b.id);
  const out: ProductOption[] = month.map((s) => ({ source: "month", id: s.id, name: productName(s), note: s.note ?? "" }));
  const names = out.map((o) => o.name);
  const gallery = await all<SourceRow>(
    env.DB,
    "SELECT s.id, s.name, s.stem, s.key, s.reference_key, s.kind, s.role, s.note FROM sources s JOIN batches bb ON bb.id = s.batch WHERE bb.client = ? AND s.kind = 'product' AND s.batch != ? ORDER BY s.created DESC LIMIT 400",
    client,
    b.id,
  );
  for (const g of gallery) {
    const name = productName(g);
    if (names.some((n) => n.toLowerCase() === name.toLowerCase()) || out.filter((o) => o.source === "gallery").length >= 80) continue;
    names.push(name);
    out.push({ source: "gallery", id: g.id, name, note: g.note ?? "" });
  }
  // Drive: one option per product name (its newest photo), with how many photos it has. Photos
  // vision read as a place, people or a design are not products.
  const drive = new Map<string, { id: string; name: string; folder: string; note: string; n: number }>();
  for (const p of (await clientDrivePhotos(env, client)).sort((a, z) => z.modified.localeCompare(a.modified))) {
    if (p.kind && p.kind !== "product") continue;
    const k = p.name.toLowerCase();
    const had = drive.get(k);
    if (had) had.n++;
    else drive.set(k, { id: p.id, name: p.name, folder: p.folder, note: p.note ?? "", n: 1 });
  }
  for (const d of drive.values()) {
    if (names.some((n) => n.toLowerCase() === d.name.toLowerCase()) || out.filter((o) => o.source === "drive").length >= 150) continue;
    out.push({ source: "drive", id: d.id, name: d.name, note: `${d.note ? `${d.note} ` : ""}(${d.n} photo${d.n > 1 ? "s" : ""}${d.folder ? ` in ${d.folder}` : ""})` });
  }
  return out;
}

const matchPost = (p: Post): MatchPost => ({
  index: p.index,
  type: p.type,
  headline: p.headline,
  brief: p.brief,
  product: p.product,
  tile: p.tileSpec ? { kind: p.tileSpec.kind, items: p.tileSpec.items } : undefined,
});

/** The best products for each post, and how many Drive photos the client's folder offered. */
async function matchProducts(env: Env, b: BatchRow, config: Config, posts: Post[], preferDrive = false): Promise<{ matches: ProductMatch[]; drive: number }> {
  const client = await clientRow(env, config.client);
  const options = await productOptions(env, b, client.id);
  const drive = options.filter((o) => o.source === "drive").length;
  if (!options.length || !posts.length) return { matches: posts.map((p) => ({ index: p.index, picks: [] })), drive };
  const list = posts.map(matchPost);
  const raw = await askText(env, productMatchInstruction({ client: client.name, posts: list, options, preferDrive, exact: !!config.exact }), PRODUCT_MATCH_SCHEMA);
  return { matches: parseMatches(parseJson<unknown>(raw), list, options), drive };
}

/**
 * Puts one product on a post: a gallery or Drive photo first joins the month as its own copy. The
 * post's shot is cleared, so it is written again for the new product.
 */
async function useProduct(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  user: User,
  b: BatchRow,
  config: Config,
  index: number,
  option: { source: ProductOption["source"]; id: string; name: string },
): Promise<Post> {
  const plan = config.plan ?? [];
  const current = plan.find((p) => p.index === index);
  if (!current) throw new StudioError("That post is not in the plan.", 404);
  const month = await all<SourceRow>(env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ?", b.id);
  const taken = new Set(month.map((s) => s.stem));
  let name: string;
  if (option.source === "month") {
    const row = month.find((s) => s.id === option.id && s.kind === "product");
    if (!row) throw new StudioError("That photo is no longer in this month.", 404);
    name = productName(row);
  } else if (option.source === "gallery") {
    const row = await copyGalleryProduct(env, user.id, b, config.client, option.id, taken);
    // Already in the month under the same name: that copy is used.
    name = row ? productName(row) : (matchProduct(option.name, month.filter((s) => s.kind === "product").map(productName)) ?? option.name);
  } else {
    const row = await importDrivePhoto(env, user.id, b.id, option.id, option.name, taken);
    ctx.waitUntil(describeUpload(env, row.id).catch((e) => console.error("[drive] describe", errorMessage(e))));
    name = productName(row);
  }
  const next = withProduct(current, name);
  config.plan = plan.map((p) => (p.index === index ? next : p));
  await saveConfig(env, b, config);
  return next;
}

/** The post with its new product: the old one's name changes wherever it is written, and its shot is written again. */
function withProduct(current: Post, name: string): Post {
  const old = current.product && current.product.toLowerCase() !== name.toLowerCase() ? current.product : "";
  const swap = (t: string | undefined) => (old && t ? renameProduct(t, old, name) : t);
  return {
    ...current,
    product: name,
    products: current.products?.filter((x) => x.toLowerCase() !== name.toLowerCase()),
    title: swap(current.title) ?? current.title,
    brief: swap(current.brief) ?? current.brief,
    caption: swap(current.caption) ?? current.caption,
    headline: swap(current.headline),
    subline: swap(current.subline),
    scene: undefined,
  };
}

/** The products that fit each post best (this month, earlier months, Drive), for the team to pick. */
postRoutes.post("/products/match", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), indexes: z.array(z.number().int()).max(MAX_POST_COUNT).optional() }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const posts = (config.plan ?? []).filter((p) => !d.indexes || d.indexes.includes(p.index));
  return c.json({ ok: true, ...(await matchProducts(c.env, b, config, posts)) });
});

/** Every product photo the posts can use, for "Choose a product". */
postRoutes.get("/products/options", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const config = JSON.parse(b.config) as Config;
  return c.json({ ok: true, options: await productOptions(c.env, b, config.client ?? "") });
});

/** Drive photos picked by the team join the month as product photos. */
postRoutes.post("/products/drive", async (c) => {
  const d = await body(
    c,
    z.object({ batch: z.string().min(1), photos: z.array(z.object({ id: z.string().min(1).max(120), name: z.string().max(200) })).min(1).max(40) }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const taken = new Set((await all<{ stem: string }>(c.env.DB, "SELECT stem FROM sources WHERE batch = ?", b.id)).map((r) => r.stem));
  const added: string[] = [];
  const failed: string[] = [];
  for (const p of d.photos)
    try {
      const row = await importDrivePhoto(c.env, user.id, b.id, p.id, p.name, taken);
      c.executionCtx.waitUntil(describeUpload(c.env, row.id).catch((e) => console.error("[drive] describe", errorMessage(e))));
      added.push(productName(row));
    } catch (e) {
      failed.push(`${p.name}: ${errorMessage(e)}`);
    }
  await run(c.env.DB, "UPDATE batches SET updated = ? WHERE id = ?", now(), b.id);
  return c.json({ ok: true, added, failed });
});

/** The team chooses (or replaces) a post's product. */
postRoutes.post("/products/use", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      index: z.number().int().min(1).max(MAX_POST_COUNT),
      source: z.enum(["month", "gallery", "drive"]),
      id: z.string().min(1).max(120),
      name: z.string().max(200).default(""),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const post = await useProduct(c.env, c.executionCtx, user, b, JSON.parse(b.config) as Config, d.index, d);
  return c.json({ ok: true, post });
});

/**
 * Every post whose product has no photo this month gets the best fit by itself (from earlier months
 * or the client's Drive); posts that show no product are left alone. Run after a grid's ideas.
 */
postRoutes.post("/products/fill", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      /** "Fill from Drive": every post that shows a product gets the Drive photo that fits it and its tile best. */
      drive: z.boolean().optional(),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  let config = JSON.parse(b.config) as Config;
  const monthNames = (await all<SourceRow>(c.env.DB, "SELECT id, name, stem, key, kind, role FROM sources WHERE batch = ? AND kind = 'product'", b.id)).map(productName);
  const missing = (config.plan ?? []).filter(
    (p) => p.type !== "greeting" && p.type !== "offer" && !NO_PRODUCT_TILES.has(p.tileSpec?.kind ?? "") && (d.drive || !matchProduct(p.product, monthNames)),
  );
  if (!missing.length) return c.json({ ok: true, filled: [] });
  const { matches, drive } = await matchProducts(c.env, b, config, missing, !!d.drive);
  if (d.drive && !drive) throw new StudioError("No Drive photos yet: connect the client's Drive folder from the gallery on the Products screen.", 409);
  const filled: { index: number; product: string; source: string }[] = [];
  if (d.drive) {
    // From Drive: each post's best Drive photo, the photos brought in four at a time under names
    // reserved first; a post whose Drive picks do not fit keeps its product.
    const chosen = matches.flatMap((m) => {
      const pick = m.picks.find((x) => x.source === "drive");
      return pick ? [{ index: m.index, pick }] : [];
    });
    const taken = new Set((await all<{ stem: string }>(c.env.DB, "SELECT stem FROM sources WHERE batch = ?", b.id)).map((r) => r.stem));
    const named = chosen.map((x) => {
      const name = freeName(x.pick.name, taken);
      taken.add(stemKey(`${name}.jpg`));
      return { ...x, name };
    });
    const names = new Map<number, string>();
    for (let i = 0; i < named.length; i += 4)
      await Promise.all(
        named.slice(i, i + 4).map(async (x) => {
          try {
            const row = await importDrivePhoto(c.env, user.id, b.id, x.pick.id, x.name, new Set());
            c.executionCtx.waitUntil(describeUpload(c.env, row.id).catch((e) => console.error("[drive] describe", errorMessage(e))));
            names.set(x.index, productName(row));
          } catch (e) {
            console.error("[products] drive", x.index, errorMessage(e));
          }
        }),
      );
    const fresh = await first<BatchRow>(c.env.DB, "SELECT * FROM batches WHERE id = ?", b.id);
    config = JSON.parse(fresh!.config) as Config;
    config.plan = (config.plan ?? []).map((p) => (names.has(p.index) ? withProduct(p, names.get(p.index)!) : p));
    await saveConfig(c.env, fresh!, config);
    for (const [index, product] of names) filled.push({ index, product, source: "drive" });
    return c.json({ ok: true, filled });
  }
  for (const m of matches) {
    const pick = m.picks[0];
    if (!pick) continue;
    try {
      const fresh = await first<BatchRow>(c.env.DB, "SELECT * FROM batches WHERE id = ?", b.id);
      config = JSON.parse(fresh!.config) as Config;
      const post = await useProduct(c.env, c.executionCtx, user, fresh!, config, m.index, pick);
      filled.push({ index: m.index, product: post.product ?? pick.name, source: pick.source });
    } catch (e) {
      console.error("[products] fill", m.index, errorMessage(e));
    }
  }
  return c.json({ ok: true, filled });
});

/**
 * "Continue with the same direction": a new month that starts from the client's last month: the
 * theme (pins, colours, props, shots), the cast, the size and count, last month's products and the
 * brand, theme and colour notes. The posts, occasions and shots are written fresh for the new month.
 */
postRoutes.post("/continue", async (c) => {
  const d = await body(c, z.object({ client: z.string().min(1).max(80), month: z.string().regex(/^\d{4}-\d{2}$/) }));
  const user = c.get("user");
  await requireActiveClient(c.env, d.client);
  const taken = await first(c.env.DB, "SELECT id FROM batches WHERE owner = ? AND client = ? AND month = ?", user.id, d.client, d.month);
  if (taken) throw new StudioError("This month already has a plan.", 409);
  const prev = await first<BatchRow>(
    c.env.DB,
    "SELECT * FROM batches WHERE owner = ? AND client = ? AND month IS NOT NULL AND month < ? ORDER BY month DESC, updated DESC LIMIT 1",
    user.id,
    d.client,
    d.month,
  );
  if (!prev) throw new StudioError("There is no earlier month for this account yet.", 404);
  const old = JSON.parse(prev.config) as Config;
  const keep = (["products", "brand", "theme", "colours"] as const).filter((k) => old.brief?.[k]);
  const config = postConfig(d.client, d.month, {
    theme: old.theme,
    model: old.model,
    format: old.format,
    ratio: old.ratio,
    size: old.size,
    economy: old.economy,
    output: old.output,
    outputQuality: old.outputQuality,
    outputSize: old.outputSize,
    postCount: old.postCount,
    ambassadors: old.ambassadors,
    exact: old.exact,
    brief: keep.length ? Object.fromEntries(keep.map((k) => [k, old.brief![k]!])) : undefined,
    continuedFrom: old.month,
  });
  const id = uuid();
  const client = await first<{ name: string }>(c.env.DB, "SELECT name FROM clients WHERE id = ?", d.client);
  await run(
    c.env.DB,
    "INSERT INTO batches (id, owner, name, config, client, month, theme, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)",
    id,
    user.id,
    `${client?.name ?? "Client"} · ${d.month}`.slice(0, 100),
    JSON.stringify(config),
    d.client,
    d.month,
    config.theme ?? null,
    now(),
    now(),
  );
  const b = (await first<BatchRow>(c.env.DB, "SELECT * FROM batches WHERE id = ?", id))!;
  const products = await all<{ id: string }>(
    c.env.DB,
    "SELECT id FROM sources WHERE batch = ? AND kind = 'product' ORDER BY created",
    prev.id,
  );
  const have = new Set<string>();
  let copied = 0;
  for (const p of products) if (await copyGalleryProduct(c.env, user.id, b, d.client, p.id, have)) copied++;
  return c.json({ ok: true, id, from: old.month, products: copied });
});

/** The "count" screen needs no model: products, posts and the month's occasions. */
function countNote(config: Config, products: number, service = ""): Omit<BriefNote, "at"> {
  const count = config.postCount ?? 12;
  const month = config.month ?? "";
  const label = monthLabel(month);
  const occasions = pickedOccasions(month, config.occasions);
  const picked = new Set(occasions.map((o) => o.id));
  const missed = occasionsOf(month).filter((o) => o.major && !picked.has(o.id));
  const points = [
    products
      ? count >= products
        ? `${products} products for ${count} posts: every product appears once before any product repeats.`
        : `${products} products for ${count} posts: the most varied products lead; ${products - count} wait for another month or share a picture.`
      : service
        ? `No products: every post shows a moment of the service (${service.slice(0, 80)}).`
        : "No products yet: the posts are brand and lifestyle pictures.",
    `About one post every ${Math.max(1, Math.round(30 / Math.max(1, count)))} days, from the 1st to the end of ${label}.`,
    ...occasions.slice(0, 4).map((o) => `${o.name} (${o.date.slice(8)}): one greeting post on the day.`),
    ...missed.map((o) => `Warning: ${o.name} (${o.date.slice(8)}) is a big day and has no post. Add it if the brand should greet.`),
  ];
  return {
    summary: `${count} posts in ${label}${occasions.length ? `, ${occasions.length} occasion${occasions.length > 1 ? "s" : ""} greeted` : ""}.`,
    points,
    logic: `Plan exactly ${count} posts across ${label}, spread over the month${occasions.length ? `, with one greeting post on ${occasions.map((o) => `${o.name} (${o.date})`).join(", ")}` : ", with no occasion posts"}.`,
  };
}

/** The count rule follows the month's count wherever it changes (ideas, plan edits, settings). */
async function refreshCountNote(env: Env, batchId: string, config: Config): Promise<void> {
  if (!config.brief?.count) return;
  const n = await first<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM sources WHERE batch = ? AND kind = 'product'",
    batchId,
  );
  // Same time stamp: a count that follows the ideas does not make the ideas look stale.
  config.brief.count = { ...countNote(config, n?.n ?? 0), at: config.brief.count.at };
}

/** One journey screen read like a brief; the rule it writes steers the month's ideas. */
postRoutes.post("/brief", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), step: z.enum(BRIEF_STEPS) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const client = await clientRow(c.env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  const sources = await all<SourceRow & { category: string | null }>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  const step = d.step as BriefStep;
  let note: Omit<BriefNote, "at">;
  if (step === "count") note = countNote(config, sources.length, client.service ?? "");
  else {
    if (step === "products" || step === "colours" || step === "shots") await describeProducts(c.env, sources);
    const productLines = sources.map(
      (s) => `- ${productName(s)}${s.category ? ` [${s.category}]` : ""}: ${s.note ?? "(not read yet)"}`,
    );
    const cast = await monthAmbassadors(c.env, config);
    // Chosen colours win here too: the analysis never brings back the pins' own colours.
    const chosen = monthPaletteOf(theme).length > 0;
    const recolour = (t: string) => (chosen ? withoutPaletteText(t) : t);
    const context =
      step === "products"
        ? productLines.length
          ? `PRODUCTS (${productLines.length}):\n${productLines.join("\n")}`
          : client.service?.trim()
            ? `NO PRODUCTS: ${client.name} sells a service: ${client.service.trim()}.`
            : "No products were added."
        : step === "brand"
          ? [
              `CLIENT: ${client.name}`,
              `BRAND COLOURS: ${paletteOf(client).join(", ") || "none"}`,
              `TONE OF VOICE: ${client.tone || "not set"}`,
              `LANGUAGE OF THE POSTS: ${client.language}`,
              `ALWAYS: ${client.dos || "-"}`,
              `NEVER: ${client.donts || "-"}`,
              `VISUAL IDENTITY: ${client.style || "not set"}`,
            ].join("\n")
          : step === "theme"
            ? theme
              ? [
                  `THEME: ${theme.title}`,
                  `DIRECTION: ${recolour(theme.goal || theme.description || "") || "not written yet"}`,
                  `VISUAL LANGUAGE: ${recolour(theme.library || "") || "-"}`,
                  chosen ? `THE MONTH'S COLOURS (chosen by the designer, they replace the pins' colours): ${monthPaletteOf(theme).join(", ")}` : "",
                  `BRAND AMBASSADORS THIS MONTH: ${cast.map((a) => `${a.name} (${a.description})`).join("; ") || "none (product-only posts)"}`,
                ].join("\n")
              : "No theme: the month follows the brand identity only."
            : step === "colours"
              ? [
                  `CHOSEN COLOURS (first = background): ${monthPaletteOf(theme).join(", ") || "none, the brand colours are used"}`,
                  `BRAND COLOURS: ${paletteOf(client).join(", ") || "none"}`,
                  `PRODUCTS AND THEIR PACKAGING:\n${productLines.join("\n") || "none"}`,
                ].join("\n")
              : [
                  `THIS MONTH'S SHOTS (one per post):\n${
                    (config.plan ?? []).filter((x) => x.scene).map((x) => `Post ${x.index} (${x.type}): ${x.scene}`).join("\n") ||
                    monthShots(config, theme).map((t, i) => `${i + 1}. ${chosen ? withoutColourWords(t) : t}`).join("\n") ||
                    "none"
                  }`,
                  chosen ? `THE MONTH'S COLOURS (first = background; they replace every colour of the pins): ${monthPaletteOf(theme).join(", ")}` : "",
                  `PROPS: ${theme?.props || "none"}`,
                  `PRODUCTS:\n${productLines.join("\n") || "none"}`,
                ].join("\n");
    const parsed = parseBrief(parseJson(await askText(c.env, briefInstruction(step, context), BRIEF_SCHEMA)));
    if (!parsed.summary && !parsed.logic) throw new StudioError("The model returned an empty analysis. Try again.", 502);
    if (step === "products" && parsed.categories.length) {
      const byName = new Map(sources.map((s) => [productName(s).toLowerCase(), s]));
      const updates = parsed.categories
        .map((cat) => ({ cat, src: byName.get(cat.product.toLowerCase()) ?? sources.find((s) => matchProduct(cat.product, [productName(s)])) }))
        .filter((x) => !!x.src)
        .map(({ cat, src }) => c.env.DB.prepare("UPDATE sources SET category = ? WHERE id = ?").bind(cat.category, src!.id));
      if (updates.length) await c.env.DB.batch(updates);
    }
    note = { summary: parsed.summary, points: parsed.points, logic: parsed.logic };
  }
  // Re-read: the designer may have changed the month meanwhile.
  const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
  const cfg = JSON.parse(fresh.config) as Config;
  cfg.brief = { ...(cfg.brief ?? {}), [step]: { ...note, at: now() } };
  await saveConfig(c.env, fresh, cfg);
  return c.json({ ok: true, note: cfg.brief[step], brief: cfg.brief });
});

/**
 * The month's shoot list: one shot per post (or the posts given), in the pins' look, written for
 * each post's product, type, occasion and people. Stored on the posts; the image prompt uses it.
 */
postRoutes.post("/shots", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      sig: z.string().max(400).optional(),
      indexes: z.array(z.number().int().min(1).max(MAX_POST_COUNT)).max(MAX_POST_COUNT).optional(),
      /** "Rewrite": every shot again, the styled posts' from their styles too. */
      all: z.boolean().optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  if (!plan.length) throw new StudioError("Write the month's ideas first: each post gets its own shot.", 409);
  const theme = config.theme
    ? await first<ThemeRow>(c.env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  // A month that follows a grid takes its shots from the grid's tiles, each post from its own tile.
  const tiles = config.gridRef ? [...new Set(plan.map((p) => p.tile).filter((t): t is string => !!t))] : [];
  const base = tiles.length ? tiles : theme ? shotsOf(theme) : [];
  const allStyled = plan.every((p) => p.style || p.type === "greeting");
  if (!base.length && !allStyled) throw new StudioError("The theme has no shots yet: add pins and read them first.", 409);
  const client = await clientRow(c.env, config.client);
  const sources = await all<SourceRow & { category: string | null }>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const names = sources.map(productName);
  const describe = (n: string | undefined) => {
    const m = matchProduct(n, names);
    const src = m ? sources.find((x) => productName(x) === m) : undefined;
    return src ? `${src.category || "product"}: ${src.note || "as in its photo"}` : "";
  };
  const cast = await monthAmbassadors(c.env, config);
  const occasions = pickedOccasions(config.month ?? "", config.occasions);
  // A post with a gallery style keeps its own shot (that style written for its product).
  const wanted = new Set((d.indexes ?? plan.map((p) => p.index)).filter((i) => !plan.find((p) => p.index === i)?.style));
  const styledMissing = plan
    .filter((p) => p.style && (d.all || !p.scene) && (!d.indexes || d.indexes.includes(p.index)))
    .map((p) => ({ index: p.index, style: p.style! }));
  const styledScenes = styledMissing.length ? await writeStyleScenes(c.env, b, config, styledMissing) : new Map<number, { style?: string; scene?: string }>();
  if (!wanted.size) {
    const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
    const cfg = JSON.parse(fresh.config) as Config;
    cfg.plan = (cfg.plan ?? []).map((p) => (styledScenes.get(p.index)?.scene ? { ...p, scene: styledScenes.get(p.index)!.scene } : p));
    if (!d.indexes) cfg.shotsFor = d.sig;
    await saveConfig(c.env, fresh, cfg);
    return c.json({ ok: true, plan: cfg.plan });
  }
  const posts: ShotPost[] = plan
    .filter((p) => wanted.has(p.index))
    .map((p) => {
      const occasion = p.type === "greeting" ? occasions.find((o) => o.id === p.occasion) : undefined;
      const productNamesOf =
        p.type === "offer" && p.offer ? p.offer.products : occasion?.portrait ? [] : [p.product, ...(p.products ?? [])];
      return {
        index: p.index,
        type: POST_TYPE_INFO[p.type]?.label ?? p.type,
        typeRule: POST_TYPE_INFO[p.type]?.description ?? "",
        products: productNamesOf.map((n) => describe(n ?? undefined)).filter(Boolean),
        occasion: occasion ? { name: occasion.name, elements: occasion.elements, portrait: occasion.portrait } : undefined,
        people: occasion?.portrait
          ? []
          : (p.people ?? [])
              .map((n) => cast.find((a) => a.name.toLowerCase() === n.toLowerCase()))
              .filter((a): a is AmbassadorRow => !!a)
              .map((a) => `${a.name} (${a.description})`),
        headline: p.headline ?? "",
        brief: (tiles.length && p.tile ? `Use reference shot ${tiles.indexOf(p.tile) + 1} (its tile of the grid). ` : "") + withoutProductNames(p.brief, [...names, ...[p.product, ...(p.products ?? []), ...(p.offer?.products ?? [])].filter((n): n is string => !!n)]).slice(0, 600),
      };
    });
  // The client may sell drinks: then cups and glasses are their products, not foreign items.
  const sellsDrinks = sources.some((s) => FOREIGN_ITEMS.test(`${s.note ?? ""} ${s.category ?? ""}`));
  const palette = monthPaletteOf(theme);
  // A grid month: the writer looks at each post's own tile (cut from the grid), not only its words.
  const tileImages: ImageBytes[] = [];
  const tileFor = new Map<number, number>();
  const grid = config.gridRef ? await gridImage(c.env, config.gridRef) : null;
  if (grid)
    for (const p of plan.filter((x) => wanted.has(x.index))) {
      const cell = tileCell(p.tile, config.gridNotes, plan, true);
      const key = cell ? await gridTileKey(c.env, grid.key, cell) : null;
      const obj = key ? await c.env.BUCKET.get(key) : null;
      if (!obj) continue;
      tileImages.push({ bytes: await obj.arrayBuffer(), mime: "image/jpeg" });
      tileFor.set(p.index, tileImages.length);
    }
  // Each post with people wears the outfit Generate gives it (the same turn), so shot and picture agree.
  const outfits = outfitsOf(theme?.wardrobe);
  const dressed = outfits.length
    ? plan.filter((p) => wanted.has(p.index) && ((p.people?.length ?? 0) > 0 || p.tileSpec?.kind === "person")).map((p) => `post ${p.index} wears ${outfits[(p.index - 1) % outfits.length]}`)
    : [];
  const wardrobeRule = dressed.length
    ? `\n\nWARDROBE (never the clothes of the reference or the tile): ${dressed.join("; ")}. Write each of these shots with exactly that outfit.`
    : "";
  const tileRule = tileImages.length
    ? `\n\nTILE PICTURES: ${[...tileFor].map(([post, img]) => `image ${img} is the grid tile post ${post} recreates`).join("; ")}. Write each of these posts' shot from its tile picture, not only from its words: the same composition (how the items are arranged, stacked, tilted or scattered, how many and where), camera angle and distance, surface and set, light direction and shadows, with the client's own product in place of the tile's items (several pieces or copies of it when the tile shows several). Never its brand, packaging, bags, cups, cards, text or logos.`
    : "";
  const ask = async (strict: boolean) => {
    const raw = parseJson<{ shots?: unknown }>(
      await askText(
        c.env,
        adaptShotsInstruction({
          shots: palette.length ? base.map(withoutColourWords) : base,
          posts,
          palette,
          props: theme?.props,
          strict,
          service: sources.length ? undefined : client.service || undefined,
        }) + tileRule + wardrobeRule,
        SHOTS_SCHEMA,
        tileImages,
      ),
    );
    const out = new Map<number, string>();
    for (const x of Array.isArray(raw.shots) ? (raw.shots as { post?: unknown; shot?: unknown }[]) : []) {
      const i = Number(x?.post);
      const t = String(x?.shot ?? "").trim().slice(0, 1500);
      if (wanted.has(i) && t) out.set(i, t);
    }
    return out;
  };
  let shots = await ask(false);
  if (!sellsDrinks && [...shots.values()].some((t) => FOREIGN_ITEMS.test(t))) shots = await ask(true);
  if (!shots.size) throw new StudioError("The model returned no shots. Try again.", 502);
  const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
  const cfg = JSON.parse(fresh.config) as Config;
  cfg.plan = (cfg.plan ?? []).map((p) =>
    shots.has(p.index)
      ? { ...p, scene: shots.get(p.index) }
      : styledScenes.get(p.index)?.scene
        ? { ...p, scene: styledScenes.get(p.index)!.scene }
        : p,
  );
  if (!d.indexes) cfg.shotsFor = d.sig;
  delete cfg.shots;
  await saveConfig(c.env, fresh, cfg);
  return c.json({ ok: true, plan: cfg.plan });
});

/** Gallery styles written for their posts' real products: the new shot of each post, by index. */
async function writeStyleScenes(
  env: Env,
  b: BatchRow,
  config: Config,
  assign: { index: number; style: string | null }[],
): Promise<Map<number, { style?: string; scene?: string }>> {
  const plan = config.plan ?? [];
  const client = await clientRow(env, config.client);
  const theme = config.theme ? await first<ThemeRow>(env.DB, "SELECT * FROM skills WHERE id = ?", config.theme) : null;
  const sources = await all<SourceRow>(
    env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(env, sources);
  const names = sources.map(productName);
  const sellsDrinks = sources.some((s) => FOREIGN_ITEMS.test(`${s.note ?? ""} ${s.category ?? ""}`));
  const cast = await monthAmbassadors(env, config);
  const palette = monthPaletteOf(theme).length ? monthPaletteOf(theme) : paletteOf(client);
  const scenes = new Map<number, { style?: string; scene?: string }>();
  await Promise.all(
    assign.map(async (a) => {
      const post = plan.find((p) => p.index === a.index);
      if (!post) return;
      if (!a.style) return scenes.set(a.index, {});
      const style = await styleRow(env, a.style);
      if (!style || !style.prompt) throw new StudioError("That style is no longer in the gallery.", 404);
      const m = matchProduct(post.type === "offer" ? post.offer?.products[0] : post.product, names);
      const src = m ? sources.find((x) => productName(x) === m) : undefined;
      const text = await askText(
        env,
        adaptStyleInstruction({
          style: { title: style.title, kind: style.kind, prompt: style.prompt },
          product: src?.note?.trim() || "",
          category: src?.category || undefined,
          post: { type: POST_TYPE_INFO[post.type]?.label ?? post.type, headline: post.headline ?? "", brief: withoutProductNames(post.brief, names).slice(0, 500) },
          brand: { name: client.name, style: client.style, always: photoRules(client.dos), never: photoRules(client.donts) },
          palette,
          people: (post.people ?? [])
            .map((n) => cast.find((x) => x.name.toLowerCase() === n.toLowerCase()))
            .filter((x): x is AmbassadorRow => !!x)
            .map((x) => `${x.name} (${x.description})`),
          sellsDrinks,
          service: sources.length ? undefined : client.service || undefined,
        }),
        ADAPT_SCHEMA,
      );
      const scene = withoutProductNames(String(parseJson<{ prompt?: unknown }>(text).prompt ?? "").trim(), names).slice(0, 1500);
      if (!scene) throw new StudioError("The model returned no shot. Try again.", 502);
      scenes.set(a.index, { style: style.id, scene });
    }),
  );
  return scenes;
}

/**
 * "Pick your style": gallery styles assigned to posts. Each style is written for its post's real
 * product (its ingredients, packaging and colours), the brand and the post's people; the result is
 * the post's shot, and the style's picture becomes its style reference at Generate.
 */
postRoutes.post("/style", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      assign: z
        .array(z.object({ index: z.number().int().min(1).max(MAX_POST_COUNT), style: z.string().max(80).nullable() }))
        .min(1)
        .max(MAX_POST_COUNT),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const scenes = await writeStyleScenes(c.env, b, JSON.parse(b.config) as Config, d.assign);
  const fresh = await ownedPlan(c.env, user, d.batch);
  const cfg = JSON.parse(fresh.config) as Config;
  cfg.plan = (cfg.plan ?? []).map((p) => {
    const s = scenes.get(p.index);
    if (!s) return p;
    const { style: _style, scene: _scene, ...rest } = p;
    void _style;
    void _scene;
    return s.style ? { ...rest, style: s.style, scene: s.scene } : rest;
  });
  await saveConfig(c.env, fresh, cfg);
  return c.json({ ok: true, plan: cfg.plan });
});

/** The official portrait of a royal day: uploaded by the team, framed on the post exactly as it is. */
postRoutes.post("/occasion-photo", async (c) => {
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, c.req.query("batch"));
  const occasion = c.req.query("occasion") ?? "";
  const config = JSON.parse(b.config) as Config;
  const day = occasionsOf(config.month ?? "").find((o) => o.id === occasion);
  if (!day?.portrait) throw new StudioError("This occasion takes no portrait.");
  const form = await c.req.formData();
  const f = form.get("file");
  if (!(f instanceof File) || !/^image\/(jpeg|png|webp)$/.test(f.type))
    throw new StudioError("Use a JPG, PNG or WebP photo.");
  if (f.size > 12 * 1024 * 1024) throw new StudioError("The photo is over 12 MB.");
  const key = `${user.id}/${b.id}/occasion/${occasion}-${uuid()}`;
  await c.env.BUCKET.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
  const old = config.occasions?.photos?.[occasion];
  config.occasions = { ...(config.occasions ?? {}), photos: { ...(config.occasions?.photos ?? {}), [occasion]: key } };
  config.plan = withPortraits(config.plan ?? [], config, b.id);
  await saveConfig(c.env, b, config);
  if (old) await c.env.BUCKET.delete(old);
  return c.json({ ok: true });
});

postRoutes.get("/occasion-photo", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const config = JSON.parse(b.config) as Config;
  const key = config.occasions?.photos?.[c.req.query("occasion") ?? ""];
  const obj = key ? await c.env.BUCKET.get(key) : null;
  if (!obj) throw new StudioError("No portrait yet.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
});

/** The client's approval link for this month (made once, then reused). */
postRoutes.post("/share", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  if (!config.shareToken) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    config.shareToken = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
    await saveConfig(c.env, b, config);
  }
  const origin = c.env.CANONICAL_ORIGIN || new URL(c.req.url).origin;
  return c.json({ ok: true, url: `${origin}/share/${config.shareToken}` });
});

export type { Post };
