/**
 * Level Social Media: themes per client, the month's plan of posts (ideas), generation of the
 * posts through the batch engine, captions and reference imports (Pinterest pins).
 */
import { Hono } from "hono";
import { z } from "zod";
import { PREVIEW_MESSAGE, previewNoImages, type Env } from "./env";
import { demoAnswer, demoMode } from "./demo";
import { StudioError, errorMessage } from "./errors";
import { all, first, run, now, uuid } from "./db";
import { getSetting, resolveEngineModel, resolveGoogleAuth, resolveOpenAIKey, SPEND_THRESHOLD_SETTING } from "./settings";
import { askVisionGoogle, askVisionOpenAI } from "./editorial";
import type { ImageBytes } from "./openai";
import { advanceBatch, makeClient, makeGoogleClient, MAX_AUTO_TAKES } from "./engine";
import { approveSpend, reserveOrAsk, reserveSpend, spendFits, spendStatus } from "./spend";
import { exactCallsCost } from "./exact";
import { signObjectUrl } from "./signed";
import { GOOGLE_MODELS, isGoogleModel } from "./google";
import { cleanGrid, testGridLayout, testGridPrompt, tileCell, type TestGridInfo } from "@shared/testgrid";
import { ambassadorRows, type AmbassadorRow } from "./ambassadors";
import { castLook } from "@shared/cast";
import { readPicture, storeBytes, styleRow, type StyleRow } from "./styles";
import { instagramPostSlides } from "./meta";
import { BRIEF_PLAN_SCHEMA, briefMonth, briefPlanInstruction, parseBriefPlan } from "@shared/campaign";
import { CLIENT_CHANGES_SCHEMA, clientChangesInstruction, parseClientChanges, type ClientAsk } from "@shared/client-changes";
import { IDEAS_CHAT_SCHEMA, ideasChatInstruction, parseIdeasChat, type ChatMake, type ChatRemove } from "@shared/ideas-chat";
import { ASSIST_ACTIONS, ASSIST_SCHEMA, assistInstruction, parseAssist } from "@shared/text-assist";
import { earlierLines, seenBefore, type EarlierPost } from "@shared/memory";
import { ADAPT_SCHEMA, adaptStyleInstruction, gridPostCount } from "@shared/styles";
import { profileBrief, type ClientProfile } from "@shared/profile";
import { estimateCost, formatUsd, rateFor, testSize } from "@shared/pricing";
import { olderIdea, planShape, postRevision } from "@shared/posts";
import { monthIssues, sceneContext } from "@shared/issues";
import { postSchema } from "@shared/config-schema";
import { HOSTED_FONTS, resolveOverlay, type OverlaySpec, type PostOverlayPatch } from "@shared/overlay";
import { parseTypography, TYPO_SCHEMA, TYPO_STYLES, typographyInstruction, type PostTypography, type SubjectMask } from "@shared/typography";
import { BRIEF_STEPS, postConfig, type BriefNote, type BriefStep, type Config } from "@shared/config";
import { requireActiveClient } from "./clients";
import { adaptShotsInstruction, BRIEF_SCHEMA, briefInstruction, briefLines, FOREIGN_ITEMS, foreignFood, foreignItemIn, parseBrief, SHOTS_SCHEMA, type ShotPost } from "@shared/brief";
import { occasionsOf, pickedOccasions, withDates } from "@shared/occasions";
import { stemKey, stemOf } from "@shared/naming";
import { clientDrivePhotos, clientPlacePhotos, drivePlaceKey, importDrivePhoto } from "./drive";
import { freeName, PRODUCT_KINDS, productRank, wantsFactory } from "@shared/drive";
import { renameProduct, SHOP_INSIDE, FACES_ASK, FACES_SCHEMA, facesIn, parseTextCheck, TEXT_CHECK_SCHEMA, textCheckInstruction, VIDEO_IDEA_SCHEMA, VIDEO_MODELS, VIDEO_SECONDS, videoIdeaInstruction } from "@shared/qa";
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
  productKeyOf,
  gatePostText,
  sellsClothing,
} from "@shared/posts";
import type { Theme, User } from "@shared/types";
import { lessonsFor, rememberLesson } from "./lessons";

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
  // A preview with no key answers from demo fixtures: no provider is called.
  if (!google && !openai && (await demoMode(env))) return demoAnswer(instruction, schema, images.length);
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
  /** The client's own picture rules, sent with every post. */
  image_rules?: string | null;
  audience?: string | null;
  photography?: string | null;
  style: string;
  language: string;
  status: string;
  overlay: string | null;
  /** R2 key of the primary logo. */
  logo_key?: string | null;
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

/** The client has photos of its own spaces: uploaded ones, or the shop, kitchen or factory in its Drive. */
async function clientHasPlaces(env: Env, client: string): Promise<boolean> {
  return !!(await first(
    env.DB,
    "SELECT 1 AS x FROM brand_assets WHERE client = ?1 AND kind = 'place' UNION ALL SELECT 1 FROM drive_photos WHERE client = ?1 AND status = 'read' AND kind IN ('place', 'factory') LIMIT 1",
    client,
  ));
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

/**
 * This month's colours as prompt strings: the month's own palette (a brief's, a grid's or the
 * designer's, kept on the month) wins; otherwise the shared theme's. A month never writes the
 * theme's palette by itself: that is a separate, explicit action (see /palette).
 */
function monthPalette(config: Pick<Config, "palette"> | null | undefined, theme: ThemeRow | null): string[] {
  if (config?.palette?.length) return parsePalette(config.palette).map((c) => colourLabel(c.hex));
  return monthPalette(config, theme);
}

/**
 * This month's colours, chosen by the designer. The shared theme is only updated when asked for
 * explicitly, and the answer says how many months follow that theme.
 */
postRoutes.post("/palette", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      palette: z.array(z.object({ name: z.string().max(40), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(8),
      /** Also write these colours to the month's theme (every month on it follows). */
      theme: z.boolean().optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const palette = parsePalette(d.palette);
  config.palette = palette.length ? palette : undefined;
  config.paletteFrom = palette.length ? "designer" : undefined;
  await saveConfig(c.env, b, config);
  let months = 0;
  if (d.theme && config.theme) {
    await run(c.env.DB, "UPDATE skills SET palette = ?, palette_auto = 0, updated = ? WHERE id = ?", JSON.stringify(palette), now(), config.theme);
    months = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM batches WHERE theme = ? AND deleted IS NULL", config.theme))?.n ?? 0;
  }
  return c.json({ ok: true, palette: config.palette ?? [], theme: d.theme ? { updated: true, months } : undefined });
});

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
  const months = new Map(
    (
      await all<{ theme: string; n: number }>(
        env.DB,
        `SELECT theme, COUNT(*) AS n FROM batches WHERE deleted IS NULL AND theme IN (${rows.map(() => "?").join(",")}) GROUP BY theme`,
        ...rows.map((r) => r.id),
      )
    ).map((m) => [m.theme, m.n]),
  );
  return rows.map((r) => ({
    id: r.id,
    months: months.get(r.id) ?? 0,
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
export async function pageImage(url: string): Promise<Fetched | null> {
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

/** A member's own months; an admin opens every month of the team (the maker stays its owner). */
async function ownedPlan(env: Env, user: User, id: string | undefined): Promise<BatchRow> {
  if (!id) throw new StudioError("Plan id is required.");
  const b =
    user.role === "admin"
      ? await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ? AND deleted IS NULL", id)
      : await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ? AND owner = ? AND deleted IS NULL", id, user.id);
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
  /** Bytes of the original (a light original goes to the engine as it is; a heavy one as its small copy). */
  size?: number | null;
}

/** Originals up to this size go to the engine as they are, so a print or a logo stays readable. */
const ENGINE_ORIGINAL_MAX = 7 * 1024 * 1024;
const engineKey = (s: SourceRow) => (s.reference_key && (s.size ?? 0) > ENGINE_ORIGINAL_MAX ? s.reference_key : s.key);

const MAX_NOTE_BYTES = 6 * 1024 * 1024;

/**
 * Reads every product photo that has no note yet and stores one; failures leave the note empty.
 * Runs a few photos at a time: it is called in the background right after an upload, and again
 * (for anything still missing) before ideas are written.
 */
/** A note written before the describer was told to leave out the photo's surroundings: described again. */
const STALE_NOTE = /\b(?:surrounded by|next to|beside|alongside|on a (?:wooden |serving |marble |white )?(?:tray|plate|board|table)|social media handles?)\b/i;
/** A garment with a print or words whose note does not say where they sit: the writers then invent a side. */
const PRINT_WORDS = /\b(print|printed|graphic|text|lettering|slogan|embroider\w*|logo|artwork|design)\b/i;
const PLACEMENT_WORDS = /\b(chest|front|back|sleeve|sleeves|hem|collar|pocket)\b/i;
function needsPlacement(note: string | null | undefined): boolean {
  return !!note && CLOTHING_NOTE.test(note) && PRINT_WORDS.test(note) && !PLACEMENT_WORDS.test(note);
}
const CLOTHING_NOTE =
  /\b(sweatshirt|sweater|hoodie|t-?shirt|tee|shirt|blouse|top|dress|skirt|jeans|trousers|pants|shorts|leggings|jacket|coat|abaya|kaftan|thobe|jumpsuit|romper|onesie|pyjamas?|pajamas?|tracksuit|cap|beanie)\b/i;

export async function describeProducts(env: Env, sources: SourceRow[]): Promise<void> {
  const pending = sources.filter((s) => s.kind === "product" && (!s.note || STALE_NOTE.test(s.note) || needsPlacement(s.note)));
  const describe = async (s: SourceRow) => {
    try {
      // Another request (the upload's background read) may have finished it meanwhile.
      const row = await first<{ note: string | null }>(
        env.DB,
        "SELECT note FROM sources WHERE id = ?",
        s.id,
      );
      if (row?.note && !STALE_NOTE.test(row.note) && !needsPlacement(row.note)) {
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
  // Whatever wrote the plan (ideas, shots, a style, a refit, the designer's card), the words to
  // draw, bags and lettered items leave the idea and the shot here, quietly, before anything else
  // reads them.
  for (const post of config.plan ?? []) {
    const g = gatePostText(post);
    if (!g.notes.length) continue;
    post.brief = g.brief;
    if (g.scene !== undefined) post.scene = g.scene;
  }
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
/** Campaign memory: the client's last three months' posts, newest first ("October 2026 · post 4"). */
async function earlierIdeas(env: Env, clientId: string | undefined, month: string | undefined): Promise<EarlierPost[]> {
  if (!clientId || !month) return [];
  const rows = await all<{ month: string; config: string }>(
    env.DB,
    "SELECT month, config FROM batches WHERE client = ? AND month < ? AND deleted IS NULL ORDER BY month DESC, updated DESC LIMIT 3",
    clientId,
    month,
  );
  const out: EarlierPost[] = [];
  for (const r of rows) {
    let plan: Post[] = [];
    try {
      plan = (JSON.parse(r.config) as Config).plan ?? [];
    } catch {
      continue;
    }
    for (const p of plan) if (p.brief?.trim()) out.push({ label: `${monthLabel(r.month)} · post ${p.index}`, title: p.title, brief: p.brief });
  }
  return out;
}

/** The plan with "Seen before" on every post that reads like one of the client's earlier posts. */
function withMemory(plan: Post[], earlier: EarlierPost[]): Post[] {
  return plan.map((p) => {
    const hit = earlier.length ? seenBefore(p, earlier) : undefined;
    const rest: Post = { ...p };
    delete rest.seenBefore;
    return hit ? { ...rest, seenBefore: hit } : rest;
  });
}

/** Trending looks: the newest styles in the library (the last two weeks), one line each. */
async function trendingLooks(env: Env): Promise<string[]> {
  const rows = await all<{ title: string; note: string | null; prompt: string | null; category: string | null }>(
    env.DB,
    "SELECT title, note, prompt, category FROM styles WHERE status = 'active' AND category != 'grid' AND created >= ? ORDER BY created DESC LIMIT 6",
    now() - 14 * 86_400_000,
  );
  return rows.map((r) => `${r.title}${r.category ? ` (${r.category})` : ""}: ${(r.note || r.prompt || "").replace(/\s+/g, " ").slice(0, 140)}`);
}

function ideasContext(
  client: ClientRow,
  theme: ThemeRow | null,
  config: Config,
  products: string[],
  productNotes: Record<string, string>,
  ambassadors: AmbassadorRow[] = [],
  profile = "",
  lessons: string[] = [],
  more: { earlier?: string[]; trends?: string[] } = {},
): Omit<IdeasRequest, "count"> {
  // Chosen colours win: the colour words of the references and the brand style give way.
  const chosen = monthPalette(config, theme).length > 0;
  const recolour = (t: string) => (chosen ? withoutPaletteText(t) : t);
  return {
    clientName: client.name,
    tone: client.tone,
    profile,
    audience: client.audience?.trim() || undefined,
    photography: client.photography?.trim() || undefined,
    earlier: more.earlier,
    trends: more.trends,
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
    monthPalette: monthPalette(config, theme),
    ambassadors: ambassadors.map((a) => ({ name: a.name, description: a.description })),
    lessons,
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
  const next = await rewritePostIdea(c.env, b, config, d.index, d.wish ?? "", !!d.noPlace);
  return c.json({ ok: true, post: next });
});

/**
 * The card's logic: the designer changed the post's product, added a second one or changed its
 * people. The words and the idea are written again for exactly what is on the card now, and the
 * old shot is dropped, so Generate makes the post the card describes.
 */
postRoutes.post("/refit", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), index: z.number().int().min(1).max(MAX_POST_COUNT) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const next = await refitWords(c.env, b, JSON.parse(b.config) as Config, d.index);
  return c.json({ ok: true, post: next });
});

/** The post's words and idea written again for exactly the products and people it has now. */
async function refitWords(env: Env, b: BatchRow, config: Config, index: number): Promise<Post> {
  const post = (config.plan ?? []).find((p) => p.index === index);
  if (!post) throw new StudioError("That post is not in the plan.", 404);
  const sources = await all<SourceRow>(env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product'", b.id);
  await describeProducts(env, sources);
  const describe = (n: string) => {
    const src = sources.find((x) => productName(x) === n);
    return src?.note ? `${n} (${src.note})` : n;
  };
  const all_ = [post.product, ...(post.products ?? [])].filter((x): x is string => !!x);
  // A styled post stays in its style: the style is written again for the products and people it
  // has now, and only the words follow; the idea is never written from scratch.
  if (post.style) {
    const scenes = await writeStyleScenes(env, b, config, [{ index, style: post.style }]);
    const s = scenes.get(index);
    const fresh = await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE id = ?", b.id);
    const cfg = JSON.parse((fresh ?? b).config) as Config;
    if (s?.scene) {
      cfg.plan = (cfg.plan ?? []).map((p) => (p.index === index ? { ...p, scene: s.scene, ...(s.brief && !p.captionHand ? { brief: s.brief } : {}) } : p));
      await saveConfig(env, fresh ?? b, cfg);
    }
    // Words the designer wrote (a brief's text on design, a hand-written caption) stay as they are.
    if (post.captionHand) return (cfg.plan ?? []).find((p) => p.index === index) ?? post;
    return rewritePostIdea(
      env,
      fresh ?? b,
      cfg,
      index,
      `The picture of this post is its style: ${(s?.scene ?? post.scene ?? "").slice(0, 700)}${all_.length ? ` It shows ${all_.map(describe).join(" and ")}.` : ""} Write the title, headline, second line and caption for this picture and these products.`,
      { wordsOnly: true },
    );
  }
  const wish = [
    all_.length
      ? `The post now shows exactly ${all_.length === 1 ? "this product" : `these ${all_.length} products together in one picture`}: ${all_.map(describe).join("; ")}. The title, headline, second line, idea and caption are about ${all_.length === 1 ? "it" : "them, naming each"}, as the photos show them; no other product.`
      : "The post has no product now: a moment of the brand without a packaged product.",
    post.tile ? `It still follows ${post.tile} of the month's grid: the same staging, place and props as that tile, now with these products.` : "",
    post.people?.length ? `The people in the picture are ${post.people.join(" and ")}; the idea gives them a natural action with the product.` : "No people in the picture.",
    "Keep the post's type and date.",
  ].join(" ");
  return rewritePostIdea(env, b, config, index, wish, { keepProducts: true });
}

/** One post written again (its words, idea and shot) for the month as it is now; the plan is saved. */
interface RewriteOptions {
  /** A place tile without photos of the shop becomes a food tile. */
  noPlace?: boolean;
  /** Only the words change (title, headline, second line, caption, hashtags): the picture's idea, shot, products and people stay. */
  wordsOnly?: boolean;
  /** The designer's product picks stay exactly (the model never drops a second product). */
  keepProducts?: boolean;
}

async function rewritePostIdea(env: Env, b: BatchRow, config: Config, index: number, wish: string, opts: RewriteOptions | boolean = {}): Promise<Post> {
  const { noPlace = false, wordsOnly = false, keepProducts = false } = typeof opts === "boolean" ? { noPlace: opts } : opts;
  const plan = config.plan ?? [];
  const current = plan.find((p) => p.index === index);
  if (!current) throw new StudioError("That post is not in the plan.", 404);
  const client = await clientRow(env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  const sources = await all<SourceRow>(
    env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(env, sources);
  const products = [...new Set(sources.map(productName))];
  const productNotes = Object.fromEntries(
    sources.filter((s) => s.note).map((s) => [productName(s), s.note!]),
  );
  const others = plan.filter((p) => p.index !== index).map((p) => p.title);
  const cast = await monthAmbassadors(env, config);
  const instruction = singleIdeaInstruction(
    { ...ideasContext(client, theme, config, products, productNotes, cast, await profileOf(env, client.id), await lessonsFor(env, client.id).catch(() => [])), count: 1 },
    current,
    others,
    wish,
  );
  const [fresh] = parseIdeas(
    await askText(env, instruction, IDEAS_SCHEMA),
    1,
    products,
    cast.map((a) => a.name),
  );
  if (!fresh) throw new StudioError("The model returned no usable idea. Try again.", 502);
  const next: Post = wordsOnly
    ? {
        ...current,
        title: fresh.title,
        caption: fresh.caption,
        hashtags: fresh.hashtags,
        // A brief's text on design is the designer's: the style's words never replace it.
        headline: current.group ? current.headline : fresh.headline,
        subline: current.group ? current.subline : hidesSubline(client) ? undefined : fresh.subline,
        captionHand: undefined,
        captionFrom: undefined,
      }
    : {
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
        products: keepProducts ? current.products : (fresh.products ?? current.products),
        people: keepProducts ? current.people : fresh.people,
        occasion: current.occasion ?? fresh.occasion,
        captionHand: undefined,
        captionFrom: undefined,
        // The post changed: its shot is written again on the shots screen.
        scene: undefined,
        // A place tile without photos of the shop becomes a food tile.
        tileSpec: noPlace && current.tileSpec?.kind === "place" ? { ...current.tileSpec, kind: "food" } : current.tileSpec,
      };
  // An offer shows exactly the designer's products.
  if (next.type === "offer" && next.offer?.products.length) {
    next.product = next.offer.products[0];
    next.products = next.offer.products.slice(1);
  }
  config.plan = withPortraits(plan.map((p) => (p.index === index ? next : p)), config, b.id);
  await saveConfig(env, b, config);
  return next;
}

postRoutes.post("/ideas", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      notes: z.string().max(2000).optional(),
      types: z.array(z.enum(POST_TYPES)).max(POST_TYPES.length).optional(),
      count: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
      /** The team chose to replace a brief's posts with written ideas. */
      force: z.boolean().optional(),
      /** Only the posts the month is short of are written and added; the posts already there stay as they are. */
      append: z.boolean().optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const append = !!d.append && (config.plan?.length ?? 0) > 0;
  // A month made from a brief is the brief's posts: nothing rewrites them by itself.
  if (briefMonth(config) && !d.force && !append)
    throw new StudioError("This month is your brief's posts. Change the brief to plan it again, or confirm writing new ideas in their place.", 409);
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
  const wanted = d.count ?? config.postCount ?? 12;
  const kept = append ? (config.plan ?? []) : [];
  const count = append ? wanted - kept.length : wanted;
  if (append && count < 1) throw new StudioError(`The month already has ${kept.length} posts. Remove posts by hand to go lower.`, 409);
  const cast = await monthAmbassadors(c.env, config);
  const earlier = await earlierIdeas(c.env, config.client, config.month).catch(() => [] as EarlierPost[]);
  // The posts already in the month count as earlier ideas: the new ones never repeat them.
  const thisMonth: EarlierPost[] = kept.map((p) => ({ label: `this month · post ${p.index}`, title: p.title, brief: p.brief }));
  const instruction = ideasInstruction({
    ...ideasContext(client, theme, config, products, productNotes, cast, await profileOf(c.env, client.id), await lessonsFor(c.env, client.id).catch(() => []), {
      earlier: earlierLines([...thisMonth, ...earlier]),
      trends: await trendingLooks(c.env).catch(() => []),
    }),
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
  if (append) {
    // The new posts take the next numbers and days of their own; everything made stays as it is.
    const next = kept.reduce((m, p) => Math.max(m, p.index), 0) + 1;
    const added = withDates(plan, config.month ?? "").map((p, i) => ({ ...p, index: next + i, ideaAt: now() }));
    config.plan = withMemory([...kept, ...withPortraits(added, config, b.id)], earlier);
    config.postCount = wanted;
    await refreshCountNote(c.env, b.id, config);
    await saveConfig(c.env, b, config);
    return c.json({ ok: true, plan: config.plan, added: added.length });
  }
  config.plan = withPortraits(withDates(greetingDates(plan, config), config.month ?? ""), config, b.id);
  // The writer may skip a picked occasion: it gets its greeting post all the same.
  config.plan = withMemory((await ensureOccasionPosts(c.env, b.id, config, client, theme, products, productNotes, cast)).plan, earlier);
  config.plannedAt = now();
  config.postCount = count;
  await refreshCountNote(c.env, b.id, config);
  if (d.notes !== undefined) config.notes = d.notes;
  await keepMonthVersion(c.env, b);
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
      { ...ideasContext(client, theme, config, products, productNotes, cast, await profileOf(env, client.id), await lessonsFor(env, client.id).catch(() => [])), count: 1 },
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
      /** A brief month planned again over the grid: the brief gives the content, the grid the rhythm and the world. */
      force: z.boolean().optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  if (briefMonth(config) && !d.force)
    throw new StudioError("This month is your brief's posts. Change the brief to plan it again.", 409);
  const briefText = config.campaign?.text?.trim() ? `THE DESIGNER'S BRIEF FOR THIS MONTH (every post's content comes from it; the grid gives the rhythm, the sets and the world): ${config.campaign.text.trim().slice(0, 4000)}` : "";
  const notesForGrid = [d.notes ?? config.notes ?? "", briefText].filter(Boolean).join("\n\n") || undefined;
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
  const hasPlaces = await clientHasPlaces(c.env, client.id);
  const placeCounts = await all<{ kind: string; n: number }>(
    c.env.DB,
    "SELECT kind, COUNT(*) AS n FROM drive_photos WHERE client = ? AND status = 'read' AND kind IN ('place', 'factory') GROUP BY kind",
    client.id,
  );
  const instruction = gridIdeasInstruction({
    hasPlaces,
    places: placeCounts.map((x) => `its ${x.kind === "factory" ? "kitchen or factory" : "shop"} (${x.n} photo${x.n > 1 ? "s" : ""})`).join(", ") || undefined,
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
    monthPalette: monthPalette(config, theme),
    ambassadors: gridCast.map((a) => ({ name: a.name, description: a.description })),
    products,
    productNotes,
    month: config.month ?? "",
    count,
    notes: notesForGrid,
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
  await rememberGridRead(c.env, ref.id, grid);
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
  const dated = withDates(posted, config.month ?? "");
  // A post that survives the re-plan (same title, headline and idea) keeps its pictures, comments
  // and videos under its new number.
  const sigOf = (p: Post) => `${p.title}|${p.headline ?? ""}|${p.brief}`;
  const oldByKey = new Map((config.plan ?? []).map((p) => [sigOf(p), p.index]));
  const moves = dated.flatMap((p) => (oldByKey.has(sigOf(p)) ? [{ from: oldByKey.get(sigOf(p))!, to: p.index }] : []));
  await movePostRows(c.env, b.id, moves);
  config.plan = dated;
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
  // The grid's plan now carries the brief: the month is no longer "the brief's posts alone".
  if (config.campaign?.only) config.campaign = { ...config.campaign, only: false };
  await keepMonthVersion(c.env, b);
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan: config.plan, grid });
});

/** The designer's edits of the plan. */
/**
 * One post taken out of the month. The posts after it move up one number together with their
 * pictures, comments and videos (a picture belongs to its post, never to a number), and the
 * removed post's picture is kept under Earlier versions. A carousel's slides are counted again.
 */
postRoutes.post("/remove", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), index: z.number().int().min(1).max(MAX_POST_COUNT) }));
  const cfg = await removePostAt(c.env, c.get("user"), d.batch, d.index);
  return c.json({ ok: true, plan: cfg.plan, postCount: cfg.postCount });
});

/** One post leaves the month: its picture stays under Earlier versions, the later posts move up one number. */
async function removePostAt(env: Env, user: User, batchId: string, index: number): Promise<Config> {
  const d = { batch: batchId, index };
  const c = { env };
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  if (!plan.some((p) => p.index === d.index)) throw new StudioError("That post is not in the month.", 404);
  const busy = await first(c.env.DB, "SELECT 1 AS x FROM tasks WHERE batch = ? AND post = ? AND status IN ('queued','processing','finalizing') LIMIT 1", b.id, d.index);
  if (busy) throw new StudioError("This post is being made: wait for it, then remove it.", 409);
  // The removed post's picture stays reachable under Earlier versions.
  const gone = await first<{ id: string; output: string | null }>(c.env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ?", b.id, d.index);
  if (gone?.output) {
    const title = plan.find((p) => p.index === d.index)?.title ?? `Post ${d.index}`;
    await run(
      c.env.DB,
      "INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES (?, ?, 'snapshot', ?, ?, ?, ?)",
      uuid(),
      b.id,
      `Removed: ${title}`.slice(0, 80),
      JSON.stringify({ [String(d.index)]: gone.output }),
      JSON.stringify([{ post: d.index, key: gone.output, at: now() }]),
      now(),
    );
  }
  if (gone) await run(c.env.DB, "DELETE FROM tasks WHERE id = ?", gone.id);
  await run(c.env.DB, "DELETE FROM post_comments WHERE batch = ? AND post = ?", b.id, d.index);
  await run(c.env.DB, "DELETE FROM videos WHERE batch = ? AND post = ?", b.id, d.index);
  // The later posts move up one number, lowest first so no two rows share a number on the way.
  const later = plan.filter((p) => p.index > d.index).map((p) => p.index).sort((a, z) => a - z);
  for (const n of later) {
    await run(c.env.DB, "UPDATE tasks SET post = ? WHERE batch = ? AND post = ?", n - 1, b.id, n);
    await run(c.env.DB, "UPDATE post_comments SET post = ? WHERE batch = ? AND post = ?", n - 1, b.id, n);
    await run(c.env.DB, "UPDATE videos SET post = ? WHERE batch = ? AND post = ?", n - 1, b.id, n);
  }
  const fresh = await ownedPlan(c.env, user, d.batch);
  const cfg = JSON.parse(fresh.config) as Config;
  const kept = (cfg.plan ?? []).filter((p) => p.index !== d.index).map((p, i) => ({ ...p, index: i + 1 }));
  // A carousel or series counts its slides again.
  const groups = new Map<string, number>();
  for (const p of kept) if (p.group) groups.set(p.group.id, (groups.get(p.group.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  cfg.plan = kept.map((p) => {
    if (!p.group) return p;
    const slide = (seen.get(p.group.id) ?? 0) + 1;
    seen.set(p.group.id, slide);
    const of = groups.get(p.group.id) ?? 1;
    return of > 1 ? { ...p, group: { ...p.group, slide, of } } : { ...p, group: undefined };
  });
  cfg.postCount = cfg.plan.length;
  await saveConfig(c.env, fresh, cfg);
  return cfg;
}

/**
 * Posts kept across a re-plan keep their rows: tasks, comments and videos move to the posts' new
 * numbers, through a free range so no two posts share a number on the way.
 */
async function movePostRows(env: Env, batchId: string, moves: { from: number; to: number }[]): Promise<void> {
  const changed = moves.filter((m) => m.from !== m.to);
  if (!changed.length) return;
  const PARK = 10000;
  for (const table of ["tasks", "post_comments", "videos"]) {
    for (const m of changed) await run(env.DB, `UPDATE ${table} SET post = ? WHERE batch = ? AND post = ?`, m.to + PARK, batchId, m.from);
    for (const m of changed) await run(env.DB, `UPDATE ${table} SET post = ? WHERE batch = ? AND post = ?`, m.to, batchId, m.to + PARK);
  }
}

postRoutes.put("/plan", async (c) => {
  const d = await body(
    c,
    z.object({ batch: z.string().min(1), plan: z.array(postSchema).max(MAX_POST_COUNT) }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const before = new Map((config.plan ?? []).map((p) => [p.index, p]));
  // A post keeps its number: the pictures, comments and versions are filed under it. Moving a post
  // in the month is a change of its posting day, never a renumbering; a new post takes the next
  // free number.
  {
    const taken = new Set<number>();
    let next = Math.max(0, ...(config.plan ?? []).map((p) => p.index), ...d.plan.map((p) => p.index || 0)) + 1;
    config.plan = d.plan.map((p) => {
      const index = p.index && !taken.has(p.index) ? p.index : next++;
      taken.add(index);
      return { ...p, index };
    });
  }
  // An idea or shot edited by hand is stamped: a picture made before it is offered an update.
  for (const p of config.plan) {
    const old = before.get(p.index);
    if (old && (old.brief !== p.brief || (old.scene ?? "") !== (p.scene ?? ""))) p.ideaAt = now();
  }
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
  config.plan = withMemory(config.plan, await earlierIdeas(c.env, config.client, config.month).catch(() => []));
  // Adding or removing posts by hand sets the month's count, so Regenerate ideas keeps that number.
  if (config.plan.length) config.postCount = config.plan.length;
  await refreshCountNote(c.env, b.id, config);
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan: config.plan, postCount: config.postCount });
});

/**
 * A grid picked for a month that already has its posts: the grid is read and every post takes a
 * tile of it (its scene, product placement and lettering) and the grid's world, keeping its own
 * idea, words and pictures. The next Generate or Make again then follows the grid.
 */
async function applyGridToMonth(env: Env, b: BatchRow, config: Config): Promise<number> {
  const plan = [...(config.plan ?? [])].sort((x, y) => x.index - y.index);
  if (!plan.length || !config.gridRef) return 0;
  const ref = await gridImage(env, config.gridRef);
  const obj = ref ? await env.BUCKET.get(ref.key) : null;
  if (!ref || !obj) throw new StudioError("Reference image not found.", 404);
  const image = { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" };
  const client = await clientRow(env, config.client);
  const theme = config.theme ? await first<ThemeRow>(env.DB, "SELECT * FROM skills WHERE id = ?", config.theme) : null;
  const sources = await all<SourceRow>(env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name", b.id);
  await describeProducts(env, sources);
  const products = [...new Set(sources.map(productName))];
  const productNotes = Object.fromEntries(sources.filter((s) => s.note).map((s) => [productName(s), s.note!]));
  const cast = await monthAmbassadors(env, config);
  const hasPlaces = await clientHasPlaces(env, client.id);
  const instruction = gridIdeasInstruction({
    hasPlaces,
    clientName: client.name,
    tone: client.tone,
    profile: await profileOf(env, client.id),
    dos: client.dos,
    donts: client.donts,
    language: (["ar", "en", "both"].includes(client.language) ? client.language : "ar") as "ar" | "en" | "both",
    palette: paletteOf(client),
    style: client.style,
    themeTitle: theme?.title ?? "",
    themeDirection: theme?.goal ?? "",
    props: theme?.props ?? "",
    noSubline: hidesSubline(client),
    monthPalette: monthPalette(config, theme),
    ambassadors: cast.map((a) => ({ name: a.name, description: a.description })),
    products,
    productNotes,
    month: config.month ?? "",
    count: plan.length,
    notes: config.notes,
  });
  const read = parseJson<Partial<GridRead>>(await askText(env, instruction, GRID_SCHEMA, [image]));
  const grid: GridRead = {
    world: String(read.world ?? "").trim(),
    tiles: Array.isArray(read.tiles) ? (read.tiles as GridRead["tiles"]).filter((t) => t && typeof t === "object").slice(0, 30) : [],
  };
  if (!grid.tiles.length) throw new StudioError("The grid could not be read into tiles. Try again.", 502);
  if (ref) await rememberGridRead(env, ref.id, grid);
  // The feed shows the newest post first: the first posts of the month take the grid's last tiles.
  const n = plan.length;
  const used = grid.tiles.slice(0, Math.min(n, grid.tiles.length));
  const byIndex = new Map(plan.map((p, k) => [p.index, used.length - 1 - (k % used.length)]));
  config.plan = (config.plan ?? []).map((p) => {
    const i = byIndex.get(p.index) ?? 0;
    const t = used[i];
    if (!t) return p;
    const tileNo = grid.tiles.indexOf(t) + 1;
    const spec = tileSpecOf(t);
    if (spec?.kind === "place" && !hasPlaces) spec.kind = "food";
    return {
      ...p,
      tile: `Tile ${tileNo} (${t.position}): ${t.scene} Product: ${t.productPlacement}${t.items ? ` Items: ${t.items}` : ""}`,
      ...(spec ? { tileSpec: spec, ...overlayFromTile(spec.text, spec.kind) } : {}),
    };
  });
  config.gridNotes = gridNotes(grid).slice(0, 12000);
  config.gridAt = now();
  const f = (read as { fonts?: Partial<GridFonts> }).fonts;
  if (f?.headline && HOSTED_FONTS.includes(f.headline)) config.gridFonts = { headline: f.headline, body: f.body && HOSTED_FONTS.includes(f.body) ? f.body : f.headline, why: String(f.why ?? "").slice(0, 400) };
  return n;
}

/** A library grid's read is kept once, so the picker can say what the grid holds without reading it again. */
export async function rememberGridRead(env: Env, ref: string, grid: GridRead): Promise<void> {
  const id = ref.replace(/^style:/, "");
  if (!id || !grid.tiles.length) return;
  await run(env.DB, "INSERT OR REPLACE INTO grid_reads (style, read, created) VALUES (?, ?, ?)", id, JSON.stringify(grid), now()).catch((e) => console.error("[grid] remember", errorMessage(e)));
}

/** The picked grid is applied to the month's posts as they are (after a pick on a made month, or to apply it again). */
postRoutes.post("/grid-apply", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  if (!config.gridRef) throw new StudioError("Pick a grid first.");
  const n = await applyGridToMonth(c.env, b, config);
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, posts: n, plan: config.plan });
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
    if (!st || st.category !== "grid" || !(st.status === "active" || st.status === "review")) throw new StudioError("That grid is not in the library.", 404);
    // A grid still waiting for the admin's approval can be picked for a month: the admin's pick approves
    // it for everyone; a team member's pick is fine when the grid is in this client's own collection.
    if (st.status === "review") {
      const user = c.get("user");
      if (user.role === "admin") await run(c.env.DB, "UPDATE styles SET status = 'active', updated = ? WHERE id = ?", now(), d.gridRef.slice(6));
      else if (!(await first(c.env.DB, "SELECT 1 AS x FROM client_styles WHERE client = ? AND style = ?", config.client ?? "", d.gridRef.slice(6))))
        throw new StudioError("That grid is waiting for the admin's approval. Ask the admin to approve it on the Approvals page, or add it to this client's own grids first.", 409);
    }
    // The month takes the grid's posts: one per tile. Its tiles are read when the ideas are written.
    const changedGrid = config.gridRef !== d.gridRef;
    if (changedGrid) delete config.gridNotes;
    config.gridRef = d.gridRef;
    config.gridAt = now();
    // A month that already has its posts keeps them: they take the grid's tiles and world as they are.
    if (config.plan?.length && (changedGrid || !config.gridNotes || config.plan.some((p) => !p.tile))) {
      try {
        await applyGridToMonth(c.env, b, config);
      } catch (e) {
        console.error("[grid] apply failed", errorMessage(e));
      }
    } else config.postCount = gridPostCount(st.tiles, config.postCount ?? 12);
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
  qa?: string | null;
  updated?: number;
  /** The post revision the picture was made for; null when unknown (made before lineage was kept). */
  made_for?: number | null;
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
const GENERATE_BODY = z.object({
      batch: z.string().min(1),
      indexes: z.array(z.number().int().min(1).max(MAX_POST_COUNT)).optional(),
      regenerate: z.boolean().optional(),
      /** One post first, to check the month's look before the rest is paid for. */
      test: z.boolean().optional(),
      /** The designer asked for another take of this post (the take count goes up). */
      retake: z.boolean().optional(),
      /** "Make it again": the review's findings, carried into the fresh take of a brief rebuilt from the plan as it is now. */
      note: z.string().trim().max(3000).optional(),
      /** The designer approved this run's estimate (shown when it exceeds the spend limit). */
      approve: z.boolean().optional(),
      /** false: no automatic retake after the review this month (the budget covers the pictures only). */
      retakes: z.boolean().optional(),
      /** The client's id for this run: the same approval sent twice adds the allowance once. */
      run: z.string().max(80).optional(),
    });
type GenerateBody = z.infer<typeof GENERATE_BODY>;

/** What one post comes to when a run is prepared: made already, making, blocked, or ready (paid or drawn here). */
export interface PreparedPost {
  index: number;
  title: string;
  status: "ready" | "made" | "making" | "blocked";
  kind?: "picture" | "text-tile";
  paid?: boolean;
  exact?: boolean;
  why?: string;
  /** The brief and prompt the engine would get (a ready picture). */
  brief?: PostBrief;
  prompt?: string;
  /** A picture exists and would be replaced. */
  existing?: boolean;
}

interface PreparedPlan {
  statements: D1PreparedStatement[];
  planned: number;
  paid: number;
  exactPlanned: number;
  skipped: number[];
  missingProduct: { index: number; product: string }[];
  outcomes: PreparedPost[];
  /** What a dry run would do when the real one starts (gallery and Drive imports). */
  notes: string[];
  draft: "1K" | undefined;
}

/**
 * The preparation of a run, shared by Generate and the plan preview: the same resolution of
 * products, references, styles and briefs, so the preview shows exactly what the run sends.
 * A dry run writes nothing but product notes that did not exist yet (and the cut grid tiles it
 * caches); the real run gets the statements that queue the posts.
 */
async function preparePlan(env: Env, user: User, b: BatchRow, config: Config, d: GenerateBody, dry = false): Promise<PreparedPlan> {
  const outcomes: PreparedPost[] = [];
  const notes: string[] = [];
  const plan = config.plan ?? [];
  if (!plan.length) throw new StudioError("Generate ideas first, then the posts.");
  if (d.test && d.indexes?.length !== 1) throw new StudioError("A test is one post.");
  const draft = d.test && testSize(config.model, config.size) === "1K" && config.size !== "1K" ? ("1K" as const) : undefined;
  const client = await clientRow(env, config.client);
  const theme = config.theme
    ? await first<ThemeRow>(env.DB, "SELECT * FROM skills WHERE id = ?", config.theme)
    : null;
  // Ambassadors chosen for the month with a portrait: posts that cast them attach the portrait.
  const cast = (await monthAmbassadors(env, config)).filter((a) => !!a.image_key);
  const refs = theme
    ? await all<{ id: string; key: string }>(
        env.DB,
        "SELECT id, key FROM refs WHERE skill = ? ORDER BY created",
        theme.id,
      )
    : [];
  const sources = await all<SourceRow>(
    env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category, size FROM sources WHERE batch = ?",
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
        env.DB,
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
        if (dry) {
          notes.push(`${n} comes from the client's gallery when the run starts.`);
          continue;
        }
        const row = await copyGalleryProduct(env, user.id, b, config.client, gallery[galleryNames.indexOf(m)].id, have);
        if (row) sources.push(row);
      }
      // Then the client's Drive: its newest photo of that product joins the month.
      const drive = notInGallery.length ? (await clientDrivePhotos(env, config.client ?? "")).filter((x) => !x.video && (!x.kind || PRODUCT_KINDS.has(x.kind))) : [];
      if (drive.length) {
        // The cleanest photo of each product first (a packshot), the newest among equals.
        const newest = [...drive].sort((x, y) => productRank(x.kind) - productRank(y.kind) || y.modified.localeCompare(x.modified));
        const driveNames = [...new Set(newest.map((x) => x.name))];
        for (const n of notInGallery) {
          const m = matchProduct(n, driveNames);
          const photo = m ? newest.find((x) => x.name === m) : undefined;
          if (!photo) continue;
          if (dry) {
            notes.push(`${n} comes from the client's Drive when the run starts.`);
            continue;
          }
          try {
            sources.push(await importDrivePhoto(env, user.id, b.id, photo.id, n, have));
          } catch (e) {
            console.error("[generate] drive", n, errorMessage(e));
          }
        }
      }
    }
  }
  await describeProducts(env, sources);
  const sellsDrinks = sources.some((s) => s.kind === "product" && FOREIGN_ITEMS.test(`${s.note ?? ""} ${s.category ?? ""}`));
  const tasks = await all<TaskLite>(
    env.DB,
    "SELECT id, post, status, output, brief, qa, updated, made_for FROM tasks WHERE batch = ?",
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
    (await Promise.all(styleIds.map((id) => styleRow(env, id))))
      .filter((r): r is StyleRow => !!r?.image_key)
      .map((r) => [r.id, r]),
  );
  const statements: D1PreparedStatement[] = [];
  let designSource: string | undefined;
  // Photos of the client's own place: a grid's place tile is set there, one photo after another.
  const places = await all<{ key: string }>(env.DB, "SELECT key FROM brand_assets WHERE client = ? AND kind = 'place' ORDER BY created", client.id);
  // Photos of real people: a post with people sees one, for real skin, light and lens.
  const realRefs = await all<{ key: string }>(env.DB, "SELECT key FROM brand_assets WHERE client = ? AND kind = 'realref' ORDER BY created", client.id);
  let realTurn = 0;
  // And the shop, kitchen and factory photos in its Drive, as vision read them.
  const drivePlaces = await clientPlacePhotos(env, client.id);
  let placeTurn = 0;
  const placeFor = async (p: Post): Promise<PostBrief["place"]> => {
    const factory = wantsFactory(`${p.title} ${p.brief} ${p.scene ?? ""}`);
    const shops = drivePlaces.filter((x) => x.kind === "place");
    const kitchens = drivePlaces.filter((x) => x.kind === "factory");
    // A behind-the-scenes post is set in the kitchen or factory; any other in the shop.
    if (!(factory && kitchens.length) && places.length) return { ...places[placeTurn++ % places.length], what: "shop or space" };
    const pool = factory && kitchens.length ? kitchens : shops.length ? shops : kitchens;
    if (!pool.length) return undefined;
    const photo = pool[placeTurn++ % pool.length];
    try {
      return { key: await drivePlaceKey(env, client.id, photo.id), what: photo.kind === "factory" ? "kitchen or factory" : "shop" };
    } catch (e) {
      console.error("[generate] drive place", errorMessage(e));
      return undefined;
    }
  };
  let planned = 0;
  /** Posts that go to the image engine: a text tile drawn here is planned but never paid for. */
  let paid = 0;
  let exactPlanned = 0;
  const skipped: number[] = [];
  const missingProduct: { index: number; product: string }[] = [];
  const monthOccasions = pickedOccasions(config.month ?? "", config.occasions);
  // What went wrong in this client's earlier pictures: the prompt forbids it by name.
  const lessons = await lessonsFor(env, client.id).catch(() => [] as string[]);
  for (const post of plan) {
    // The gate before paying: what the review would flag and the words already show is taken out
    // of the idea and the shot here, so no credit is spent on a picture that would be rejected
    // (the config is saved with the run, so the cleaned text is kept).
    {
      const g = gatePostText(post);
      if (g.notes.length) {
        post.brief = g.brief;
        if (g.scene !== undefined) post.scene = g.scene;
      }
    }
    if (!wanted.has(post.index)) continue;
    // An offer is generated only once the designer filled it: products, price and contents.
    if (post.type === "offer" && !offerReady(post.offer)) {
      skipped.push(post.index);
      outcomes.push({ index: post.index, title: post.title, status: "blocked", why: "The offer needs its products, price and contents first." });
      continue;
    }
    const occasion =
      post.type === "greeting"
        ? (monthOccasions.find((o) => o.id === post.occasion) ?? monthOccasions.find((o) => o.date === post.date))
        : undefined;
    // A royal day shows the official portrait (added on the design), never a product or a person.
    const portraitDay = !!occasion?.portrait;
    // A text tile stands alone only when the post names no product; with one, the product is in it.
    const typographic = config.gridRef && post.tileSpec?.kind === "text" && !post.product;
    const leadName = post.type === "offer" ? post.offer!.products[0] : portraitDay || typographic ? undefined : post.product;
    const extraNames = post.type === "offer" ? post.offer!.products.slice(1) : portraitDay || typographic ? [] : (post.products ?? []);
    const existing = byPost.get(post.index);
    if (existing) {
      const busy = existing.status === "processing" || existing.status === "finalizing";
      if (busy) {
        outcomes.push({ index: post.index, title: post.title, status: "making" });
        continue;
      }
      // The pictures follow the ideas: a post whose idea, reference, client note or grid changed
      // after its picture is made again without being asked. A picture with unknown lineage (made
      // before it was kept) stays as it is until the designer asks.
      const changed = olderIdea(existing, post, config);
      // A smaller test image is made again at the month's size with the rest.
      if (!d.regenerate && !changed && existing.status !== "failed" && !(isDraft(existing) && !d.test)) {
        outcomes.push({ index: post.index, title: post.title, status: "made" });
        continue;
      }
    }
    // A text tile of the grid is a typographic post. A plain background is drawn here, exactly in its
    // colour and without the image engine; the headline goes on it as the tile has it.
    const spec = config.gridRef ? post.tileSpec : undefined;
    if (typographic && spec?.kind === "text" && !TEXTURED_BACKGROUND.test(spec.background)) {
      const taskId = existing?.id ?? uuid();
      const colour = hexIn(spec.background, monthPalette(config, theme)[0] ? hexIn(monthPalette(config, theme)[0], "#f3ece0") : hexIn(paletteOf(client)[0], "#f3ece0"));
      const key = `${b.owner}/${b.id}/output/${taskId}/${uuid()}.png`;
      await env.BUCKET.put(key, await plainBackground(colour, config.format ?? "4:5"), { httpMetadata: { contentType: "image/png" } });
      designSource ??= await designSourceOf(env, b.id, key);
      const qa = JSON.stringify({ found: false, count: 0, box: [], productConcern: false, notes: "A typographic post: its background is drawn in the tile's colour.", automated: true, flags: [] });
      const brief = JSON.stringify({ post: true, index: post.index, type: post.type, typographic: true, background: colour });
      const caption = JSON.stringify({ text: post.caption, hashtags: post.hashtags });
      statements.push(
        existing
          ? env.DB.prepare(
              "UPDATE tasks SET status = 'ready', source = ?, output = ?, prompt = '', brief = ?, caption = ?, qa = ?, error = NULL, edit = NULL, attempts = 0, request_id = NULL, lease = NULL, leased_at = NULL, making_for = ?, made_for = ?, updated = ? WHERE id = ?",
            ).bind(designSource, key, brief, caption, qa, postRevision(post, config), postRevision(post, config), now(), existing.id)
          : env.DB.prepare(
              "INSERT INTO tasks (id, batch, source, card, status, output, prompt, brief, post, caption, qa, making_for, made_for, updated) VALUES (?, ?, ?, ?, 'ready', ?, '', ?, ?, ?, ?, ?, ?, ?)",
            ).bind(taskId, b.id, designSource, post.index, key, brief, post.index, caption, qa, postRevision(post, config), postRevision(post, config), now()),
      );
      planned++;
      outcomes.push({ index: post.index, title: post.title, status: "ready", kind: "text-tile", paid: false });
      continue;
    }
    // A textured one (paper, marble…) is painted by the engine: its background only.
    // A text tile with no product; one with a product is a real picture with calm room for the words.
    const textured = spec?.kind === "text" && !leadName;
    const productSources = sources.filter((s) => s.kind === "product");
    const productNames = productSources.map(productName);
    const productMatch = matchProduct(leadName, productNames);
    if (leadName && !productMatch) {
      missingProduct.push({ index: post.index, product: leadName });
      outcomes.push({ index: post.index, title: post.title, status: "blocked", why: `No photo of ${leadName} this month.` });
      continue;
    }
    const product = productMatch
      ? productSources.find((s) => productName(s) === productMatch)
      : undefined;
    // Further products shown in the same picture, attached after image 1.
    // "Sahlab" next to "Sahlab with nuts" is the same product twice, not two products together.
    const sameBase = (a: string, b: string) => {
      const [x, y] = [productKeyOf(a), productKeyOf(b)];
      return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
    };
    const extraProducts = product
      ? [...new Set(extraNames.map((n) => matchProduct(n, productNames)))]
          .filter((n): n is string => !!n && n !== productMatch && !sameBase(n, productMatch!))
          .slice(0, 3)
          .map((n) => productSources.find((s) => productName(s) === n)!)
          .filter(Boolean)
          .map((s) => ({
            name: productName(s).trim(),
            note: s.note?.trim() || undefined,
            key: engineKey(s),
          }))
      : [];
    // Grid mode: every post follows the same reference grid; otherwise rotate the theme's photos.
    const gridRef = await gridImage(env, config.gridRef);
    if (gridRef && !refs.some((r) => r.id === gridRef.id)) refs.push(gridRef);
    // A grid picked for the month leads: a brief's reference style and its colour world step back for a post that has its tile.
    const gridLeads = !!config.gridRef && !!post.tile;
    const styled0 = post.style ? styles.get(post.style) : undefined;
    const styled = gridLeads && styled0?.status === "brief" ? undefined : styled0;
    // A post from a campaign brief: the designer's reference picture and brief decide the look, the
    // colours and the ingredients; a carousel's slides share the ingredients of its ingredients slide.
    const campaign =
      (post.group || styled?.status === "brief") && !gridLeads
        ? {
            ingredients: (post.ingredients?.trim() || (post.group ? plan.find((x) => x.group?.id === post.group?.id && x.ingredients?.trim())?.ingredients?.trim() : undefined)) || undefined,
            colours: config.campaign?.colours?.length ? config.campaign.colours.map((x) => `${x.name} ${x.hex}`.trim()) : undefined,
          }
        : undefined;
    const refId = styled ? null : gridRef ? gridRef.id : pickLeastUsed(refs, used);
    if (refId) used.set(refId, (used.get(refId) ?? 0) + 1);
    // Exact product mode: one product, set into the picture afterwards; the reference is image 1.
    // Only a photo on a plain background is set in exactly; any other is drawn from its photo.
    // The real photo is set in when the month or the post asks for it, and when the designer makes
    // the post again after the review found the product itself wrong (its shape, its print): the
    // engine redraws a cup from a photo badly next to a strong reference, a cut-out never does.
    // A photo on a busy background is cut out once by the image model and kept.
    // Only a photo on a plain background (or a cut-out PNG) is set in: a cut-out guessed from a busy
    // photo never looks right. A product in someone's hand cannot be set in: such a post is drawn.
    const held = /\b(hands?|held|holding|holds|lifts?|lifting|grips?)\b/i.test(`${post.brief} ${post.scene ?? ""}`);
    const wantsExact = !!(config.exact || post.exact) && !held && !!product && !extraProducts.length && post.type !== "offer" && !!(refId || styled);
    const exactProduct = wantsExact && (await import("./exact").then((m) => m.cutsCleanly(env, product!))) ? product : undefined;
    let sourceId = exactProduct ? undefined : product?.id;
    if (!sourceId && styled) {
      // No product photo in the picture: the style's own picture is image 1.
      const stem = `style-${styled.id}`;
      const existingStyle = sources.find((s) => s.stem === stem);
      if (existingStyle) sourceId = existingStyle.id;
      else {
        sourceId = uuid();
        if (!dry) await run(
          env.DB,
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
        if (!dry) await run(
          env.DB,
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
    const tileKey = cell && gridRef ? await gridTileKey(env, gridRef.key, cell) : null;
    const brief: PostBrief = {
      post: true,
      draft,
      take,
      index: post.index,
      type: post.type,
      title: post.title,
      brief: post.brief,
      palette: campaign?.colours?.length ? campaign.colours : monthPalette(config, theme).length ? monthPalette(config, theme) : paletteOf(client),
      paletteChosen: !!campaign?.colours?.length || monthPalette(config, theme).length > 0,
      style: client.style,
      theme: theme ? [theme.goal, theme.description].filter(Boolean).join("\n") : "",
      library: theme?.library || undefined,
      props: theme?.props?.trim() || undefined,
      design: textured ? "background" : undefined,
      wordsSpace: spec?.kind === "text" && !textured ? true : undefined,
      place: post.type !== "greeting" && (spec?.kind === "place" || SHOP_INSIDE.test(`${post.brief} ${post.scene ?? ""}`)) ? await placeFor(post) : undefined,
      shot: textured ? spec!.background : post.scene?.trim() || (post.shot ? monthShots(config, theme)[post.shot - 1] : undefined),
      // What the shot or the idea added to the product (a biscuit dipped in, syrup, rolls beside it): named so the engine leaves it out.
      notInPicture: (() => {
        if ((!product || exactProduct) && !campaign) return undefined;
        // A brief's reference brings its own ingredients (its chilies, its lychees): named so they stay out.
        const shotText = `${post.scene ?? ""} ${post.brief ?? ""} ${campaign && styled ? styled.prompt ?? "" : ""}`;
        const own = [...(product ? [product] : []), ...extraProducts.map((e) => productSources.find((s) => (s.reference_key || s.key) === e.key))]
          .filter((x): x is SourceRow => !!x)
          .map((x) => `${productName(x)} ${x.note ?? ""} ${(x as { category?: string | null }).category ?? ""}`)
          .join(" ");
        const found = foreignFood(shotText, `${own} ${campaign?.ingredients ?? ""}`);
        return found.length ? found : undefined;
      })(),
      always: client.dos?.trim() || undefined,
      never: client.donts?.trim() || undefined,
      rules: client.image_rules?.trim() || undefined,
      photography: client.photography?.trim() || undefined,
      lessons: lessons.length ? lessons : undefined,
      // A post with a style follows the style alone: the grid gives it only the month's colours.
      grid: config.gridRef && !styled ? config.gridNotes || undefined : undefined,
      tile: config.gridRef && !styled ? post.tile : undefined,
      format: config.format ?? "4:5",
      ref: refId,
      styleKey: styled?.image_key ?? undefined,
      clientChange: post.clientNote?.note?.trim() || undefined,
      originalRef: post.reference?.key ?? styled?.image_key ?? undefined,
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
      // A quote or tip without a product: its backdrop is made of the brand's own foods and textures.
      brandFoods: !product && (post.type === "quote" || post.type === "tip") ? productSources.map((s) => s.note?.trim()).filter((n): n is string => !!n).slice(0, 8).join("; ") || undefined : undefined,
      ingredients: !product && post.ingredients?.trim() ? post.ingredients.trim() : undefined,
      campaign,
      // The designer's own reference for this post: attached to every take until it is taken off.
      editRef: post.reference?.key ? { key: post.reference.key, note: post.reference.note?.trim() || undefined } : undefined,
      occasionId: post.occasion || undefined,
      ambassadors: (() => {
        if (portraitDay) return undefined;
        const list = (post.people ?? [])
          .map((n) => cast.find((a) => a.name.trim().toLowerCase() === n.trim().toLowerCase()))
          .filter((a): a is AmbassadorRow => !!a)
          .slice(0, 3)
          .map((a) => ({ name: a.name, description: a.description, key: a.image_key! }));
        // A clothing brand's detail tile shows the garment on a body (the grid's tile does): with
        // nobody cast, the month's first ambassador wears it, so it is never laid flat.
        const wornTile = post.tileSpec?.kind === "detail" && /\b(wear|wearing|worn|person|body|waist|hip|sleeve|thigh)\b/i.test(post.tile ?? "");
        if (!list.length && product && wornTile && sellsClothing(productSources.map((s) => s.note?.trim() || "")) && cast[0]?.image_key)
          return [{ name: cast[0].name, description: cast[0].description, key: cast[0].image_key }];
        return list.length ? list : undefined;
      })(),
      realRef: realRefs.length && !portraitDay && post.people?.length ? realRefs[realTurn++ % realRefs.length] : undefined,
    };
    // The real-people photo only goes with a post that shows the brand's people.
    if (!brief.ambassadors?.length) delete brief.realRef;
    // With ambassadors in the picture, a reference that shows people is described, not attached:
    // the engine copies a reference's people (their age, their gender) over the portraits.
    if (brief.ambassadors?.length && ((styled?.kind === "people" && brief.styleKey) || ((brief.tileKey || (brief.ref && brief.grid)) && post.tileSpec?.kind === "person"))) brief.noRefImage = true;
    const prompt = buildPostPrompt(brief);
    const caption = JSON.stringify({ text: post.caption, hashtags: post.hashtags });
    if (existing)
      statements.push(
        env.DB.prepare(
          "UPDATE tasks SET status = 'queued', source = ?, prompt = ?, brief = ?, caption = ?, preflight = NULL, error = NULL, edit = ?, recenter = 0, attempts = 0, request_id = NULL, lease = NULL, leased_at = NULL, making_for = ?, updated = ? WHERE id = ? AND status NOT IN ('processing','finalizing')",
        ).bind(sourceId, prompt, JSON.stringify(brief), caption, d.note?.trim() || null, postRevision(post, config), now(), existing.id),
      );
    else
      statements.push(
        env.DB.prepare(
          "INSERT INTO tasks (id, batch, source, card, status, prompt, brief, post, caption, making_for, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
        ).bind(
          uuid(),
          b.id,
          sourceId,
          post.index,
          prompt,
          JSON.stringify(brief),
          post.index,
          caption,
          postRevision(post, config),
          now(),
        ),
      );
    planned++;
    paid++;
    if (exactProduct) exactPlanned++;
    outcomes.push({ index: post.index, title: post.title, status: "ready", kind: "picture", paid: true, exact: !!exactProduct, brief, prompt, existing: !!existing?.output });
  }
  return { statements, planned, paid, exactPlanned, skipped, missingProduct, outcomes, notes, draft };
}

postRoutes.post("/generate", async (c) => {
  const d = await body(c, GENERATE_BODY);
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const { statements, planned, paid, exactPlanned, skipped, missingProduct, draft } = await preparePlan(c.env, user, b, config, d);
  if (!planned)
    throw new StudioError(
      skipped.length || missingProduct.length
        ? "Nothing to generate yet: see the posts that were skipped."
        : "Every post already has its picture. Change a post's idea, words or reference and press Generate again (it is made again by itself), or press Make again on the post.",
    );
  // The spend limit: every run's estimate (one automatic retake per picture included, and the
  // exact-mode cut-out and harmonising calls) is approved into the month's ledger when it starts;
  // a run above the limit waits for the designer's one approval. Every engine attempt, automatic
  // retakes included, then reserves its own cost against that ledger (see reserveSpend).
  const threshold = Number((await getSetting(c.env, SPEND_THRESHOLD_SETTING)) ?? 20);
  const model = config.model || (await resolveEngineModel(c.env));
  const estimate = estimateCost({ ...config, model, size: draft ?? config.size }, paid);
  const exactExtras = exactPlanned * exactCallsCost();
  const perRun = estimate.total + exactExtras;
  // The automatic retake is the designer's choice: off, the approval covers the pictures alone and
  // the engine never retakes by itself this month.
  if (d.retakes !== undefined) config.autoRetakes = d.retakes;
  const retakes = config.autoRetakes === false ? 0 : MAX_AUTO_TAKES;
  const budget = perRun * (1 + retakes);
  if (threshold > 0 && estimate.known && budget > threshold && !d.approve)
    return c.json(
      {
        error: `${paid} image${paid === 1 ? "" : "s"} ≈ ${formatUsd(perRun)}${retakes ? `, at most ${formatUsd(budget)} with one automatic retake each` : ""}, above the $${threshold} limit. Press Generate on the month to approve this run.`,
        needsApproval: true,
        images: paid,
        estimate: perRun,
        maximum: budget,
        perImage: estimate.perImage,
        known: estimate.known,
        threshold,
      },
      409,
    );
  await approveSpend(c.env, b.id, budget, d.run);
  if (d.test) config.testPost = d.indexes![0];
  statements.push(
    c.env.DB.prepare("UPDATE batches SET config = ? WHERE id = ?").bind(JSON.stringify(config), b.id),
  );
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
  return c.json({ ok: true, planned, paid, skipped, missingProduct, draft: !!draft, approved: budget });
});

/**
 * The plan as a run would send it, without starting one: every post's outcome (ready, made,
 * making, blocked and why), the pictures the engine would get and the prompt's numbering, the
 * executable scope and its estimate. Nothing is written but product notes that did not exist yet.
 */
postRoutes.post("/plan-preview", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), indexes: z.array(z.number().int().min(1).max(MAX_POST_COUNT)).optional(), regenerate: z.boolean().optional() }));
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const prep = await preparePlan(c.env, user, b, config, d, true);
  const client = await clientRow(c.env, config.client);
  const theme = config.theme ? (await toThemes(c.env, [await themeRow(c.env, config.theme)]))[0] : null;
  const cast = await monthAmbassadors(c.env, config);
  const productRows = await all<SourceRow>(c.env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product'", b.id);
  const products = productRows.map(productName);
  const placeCount = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM brand_assets WHERE client = ? AND kind = 'place'", client.id);
  const drivePlaces = (await clientPlacePhotos(c.env, client.id)).length;
  const issues = monthIssues({
    config,
    client: { logo: !!client.logo_key, tone: client.tone, colors: (() => { try { return JSON.parse(client.colors) as { hex: string }[]; } catch { return []; } })(), service: client.service },
    theme: theme ? { references: theme.references, shots: theme.shots, analysed: theme.analysed, latestRef: theme.latestRef, palette: theme.palette } : null,
    products,
    cast: cast.map((a) => ({ name: a.name, gender: a.gender, image: !!a.image_key, description: a.description, modest: !!a.modest })),
    scene: sceneContext({ config, theme, products: productRows, client: { places: Array.from({ length: placeCount?.n ?? 0 }), drivePlaces } }),
  });
  const model = config.model || (await resolveEngineModel(c.env));
  const estimate = estimateCost({ ...config, model }, prep.paid);
  const perRun = estimate.total + prep.exactPlanned * exactCallsCost();
  const { postImages } = await import("./engine");
  const resolveRef = async (id: string) =>
    id.startsWith("style:")
      ? ((await first<{ image_key: string | null }>(c.env.DB, "SELECT image_key FROM styles WHERE id = ?", id.slice(6)))?.image_key ?? null)
      : ((await first<{ key: string }>(c.env.DB, "SELECT key FROM refs WHERE id = ?", id))?.key ?? null);
  const posts = [];
  for (const o of prep.outcomes) {
    if (!o.brief) {
      posts.push(o);
      continue;
    }
    const sent = await postImages(o.brief, resolveRef);
    let highest = 0;
    for (const m of (o.prompt ?? "").matchAll(/Images? (\d+)(?: to (\d+))?/g)) highest = Math.max(highest, Number(m[2] ?? m[1]));
    posts.push({
      ...o,
      prompt: undefined,
      reference: o.brief.editRef ? "pinned picture" : o.brief.styleKey ? "style" : o.brief.tileKey ? "grid tile" : o.brief.ref && o.brief.grid ? "grid" : o.brief.ref ? "theme reference" : "brief",
      images: [{ role: o.brief.hasProduct ? "product" : "reference", key: "" }, ...sent.images.map((i) => ({ role: i.role, key: i.key }))],
      highestImage: highest,
      brief: c.get("user").role === "admin" ? o.brief : undefined,
    });
  }
  return c.json({
    ok: true,
    posts,
    planned: prep.planned,
    paid: prep.paid,
    blocked: prep.outcomes.filter((o) => o.status === "blocked").map((o) => ({ index: o.index, why: o.why })),
    notes: prep.notes,
    issues,
    estimate: { model, size: config.size, perImage: estimate.perImage, total: perRun, maximum: perRun * (1 + MAX_AUTO_TAKES), known: estimate.known, retakes: MAX_AUTO_TAKES },
    spend: await spendStatus(c.env, b.id),
  });
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
      audience: client.audience?.trim() || undefined,
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

/* ───────────── Earlier versions of a month ───────────── */

/**
 * Before new ideas replace a month that has pictures, its plan and pictures are kept as a version
 * (the pictures stay in the bucket: a new take never deletes the old one).
 */
async function keepMonthVersion(env: Env, b: BatchRow): Promise<void> {
  const old = JSON.parse(b.config) as Config;
  const tasks = await all<{ post: number | null; output: string | null }>(env.DB, "SELECT post, output FROM tasks WHERE batch = ? AND post IS NOT NULL AND output IS NOT NULL", b.id);
  if (!tasks.length || !old.plan?.length) return;
  const outputs = Object.fromEntries(tasks.map((t) => [String(t.post), t.output!]));
  const grid = old.gridRef?.startsWith("style:") ? await first<{ title: string }>(env.DB, "SELECT title FROM styles WHERE id = ?", old.gridRef.slice(6)) : null;
  const label = grid?.title ? `Grid “${grid.title}”` : old.gridRef ? "Grid" : "Ideas";
  await run(
    env.DB,
    "INSERT INTO month_versions (id, batch, kind, label, grid, plan, outputs, created) VALUES (?, ?, 'snapshot', ?, ?, ?, ?, ?)",
    uuid(),
    b.id,
    label,
    old.gridRef ?? null,
    JSON.stringify(old.plan),
    JSON.stringify(outputs),
    old.plannedAt ?? now(),
  );
}

/**
 * The months made before versions were kept: their earlier pictures, read from the bucket and
 * grouped by when they were made (a pause of half an hour or more starts another version).
 */
async function rebuildMonthVersions(env: Env, b: BatchRow): Promise<void> {
  const tasks = await all<{ id: string; post: number | null; output: string | null }>(env.DB, "SELECT id, post, output FROM tasks WHERE batch = ? AND post IS NOT NULL", b.id);
  const postOf = new Map(tasks.map((t) => [t.id, t.post!]));
  const current = new Set(tasks.map((t) => t.output).filter(Boolean));
  const kept = new Set(
    (await all<{ outputs: string; takes: string }>(env.DB, "SELECT outputs, takes FROM month_versions WHERE batch = ? AND kind = 'snapshot'", b.id)).flatMap((v) => [
      ...Object.values(JSON.parse(v.outputs) as Record<string, string>),
      ...(JSON.parse(v.takes) as { key: string }[]).map((t) => t.key),
    ]),
  );
  const old: { key: string; post: number; at: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `${b.owner}/${b.id}/output/`, cursor, limit: 1000 });
    for (const o of page.objects) {
      // Resized copies (…png.w1080.jpg) are the same picture, not another take.
      if (!/\.(png|jpe?g|webp)$/i.test(o.key) || /\.w\d+\.jpg$/i.test(o.key) || current.has(o.key) || kept.has(o.key)) continue;
      const post = postOf.get(o.key.split("/")[3] ?? "");
      if (post) old.push({ key: o.key, post, at: o.uploaded.getTime() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  old.sort((x, y) => x.at - y.at);
  const groups: (typeof old)[] = [];
  for (const o of old) {
    const g = groups.at(-1);
    if (g && o.at - g[g.length - 1].at < 30 * 60_000) g.push(o);
    else groups.push([o]);
  }
  // A retake or two is not a grid of its own: it joins the version before it.
  for (let i = groups.length - 1; i > 0; i--)
    if (groups[i].length < 3) {
      groups[i - 1].push(...groups[i]);
      groups.splice(i, 1);
    }
  for (const g of groups) {
    // The latest picture of each post makes the feed; every take stays in the version.
    const outputs: Record<string, string> = {};
    for (const o of g) outputs[String(o.post)] = o.key;
    const takes = g.map((o) => ({ post: o.post, key: o.key, at: o.at }));
    await run(
      env.DB,
      "INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES (?, ?, 'backfill', ?, ?, ?, ?)",
      uuid(),
      b.id,
      `${g.length} pictures`,
      JSON.stringify(outputs),
      JSON.stringify(takes),
      g[0].at,
    );
  }
  await run(env.DB, "INSERT INTO month_versions (id, batch, kind, created) VALUES (?, ?, 'scanned', ?)", uuid(), b.id, now());
}

/** The month's earlier versions, newest first: their grid, their posts and pictures. */
postRoutes.get("/versions", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  if (!(await first(c.env.DB, "SELECT 1 AS x FROM month_versions WHERE batch = ? AND kind = 'scanned'", b.id))) await rebuildMonthVersions(c.env, b);
  const rows = await all<{ id: string; label: string; grid: string | null; plan: string | null; outputs: string; takes: string; created: number }>(
    c.env.DB,
    "SELECT id, label, grid, plan, outputs, takes, created FROM month_versions WHERE batch = ? AND kind != 'scanned' ORDER BY created DESC",
    b.id,
  );
  const imageUrl = (key: string) => `/api/studio/posts/versions/image?batch=${b.id}&key=${encodeURIComponent(key)}`;
  return c.json({
    ok: true,
    versions: rows.map((v) => {
      const plan = v.plan ? (JSON.parse(v.plan) as Post[]) : [];
      const outputs = JSON.parse(v.outputs) as Record<string, string>;
      const indexes = [...new Set([...plan.map((p) => p.index), ...Object.keys(outputs).map(Number)])].sort((x, y) => y - x);
      return {
        id: v.id,
        label: v.label,
        grid: v.grid,
        created: v.created,
        posts: indexes.map((i) => {
          const p = plan.find((x) => x.index === i);
          return { index: i, headline: p?.headline ?? "", subline: p?.subline ?? "", ov: p?.ov, key: outputs[String(i)] ?? null, image: outputs[String(i)] ? imageUrl(outputs[String(i)]) : null };
        }),
        // Every picture of the version, newest first (all the takes of each post).
        takes: (JSON.parse(v.takes) as { post: number; key: string; at: number }[])
          .sort((x, y) => y.at - x.at)
          .map((t) => ({ index: t.post, key: t.key, image: imageUrl(t.key) })),
        // A version that kept its plan brings its ideas and words back too.
        withPlan: plan.length > 0,
      };
    }),
  });
});

/**
 * An earlier version back in the studio: the month as it is now is kept as a version first, then
 * the version's pictures (and its plan and grid, when it kept them) become the month's. One picture
 * alone can also come back to its post.
 */
postRoutes.post("/versions/restore", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), version: z.string().min(1).optional(), index: z.number().int().min(1).optional(), key: z.string().max(400).optional() }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  if (!d.version && !(d.index && d.key)) throw new StudioError("Say which version, or which picture for which post.");
  const v = d.version ? await first<{ plan: string | null; grid: string | null; outputs: string }>(c.env.DB, "SELECT plan, grid, outputs FROM month_versions WHERE id = ? AND batch = ?", d.version, b.id) : null;
  if (d.version && !v) throw new StudioError("That version is gone.", 404);
  const busy = await first(c.env.DB, "SELECT 1 AS x FROM tasks WHERE batch = ? AND status IN ('queued','processing','finalizing') LIMIT 1", b.id);
  if (busy) throw new StudioError("Posts are being made: wait for them, then bring the version back.", 409);
  const config = JSON.parse(b.config) as Config;
  const tasks = await all<{ id: string; post: number | null; output: string | null }>(c.env.DB, "SELECT id, post, output FROM tasks WHERE batch = ? AND post IS NOT NULL", b.id);
  const put = async (index: number, key: string) => {
    if (!key.startsWith(`${b.owner}/${b.id}/output/`)) throw new StudioError("Not this month's picture.", 400);
    const t = tasks.find((x) => x.post === index);
    if (!t) return false;
    await run(
      c.env.DB,
      "UPDATE tasks SET output = ?, status = 'ready', error = NULL, edit = NULL, qa = NULL, made_for = NULL, updated = ? WHERE id = ?",
      key,
      now() + 1,
      t.id,
    );
    return true;
  };
  // One picture back to its post: the picture it replaces is kept with the month's earlier pictures.
  if (d.index && d.key) {
    if (!(await c.env.BUCKET.head(d.key))) throw new StudioError("That picture is no longer in storage.", 404);
    const was = tasks.find((x) => x.post === d.index)?.output;
    if (!(await put(d.index, d.key))) throw new StudioError(`Post ${d.index} is not in the month any more.`, 409);
    if (was)
      await run(
        c.env.DB,
        "INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES (?, ?, 'snapshot', ?, ?, ?, ?)",
        uuid(),
        b.id,
        `Post ${d.index} before`,
        JSON.stringify({ [String(d.index)]: was }),
        JSON.stringify([{ post: d.index, key: was, at: now() }]),
        now(),
      );
    return c.json({ ok: true, restored: 1 });
  }
  await keepMonthVersion(c.env, b);
  const outputs = JSON.parse(v!.outputs) as Record<string, string>;
  if (v!.plan) {
    config.plan = JSON.parse(v!.plan) as Post[];
    config.gridRef = v!.grid ?? undefined;
    config.plannedAt = now();
    config.postCount = config.plan.length;
    await saveConfig(c.env, b, config);
  }
  let restored = 0;
  for (const [i, key] of Object.entries(outputs)) if (await put(Number(i), key)) restored++;
  return c.json({ ok: true, restored });
});

/** One picture of an earlier version (only the month's own pictures). */
postRoutes.get("/versions/image", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const key = c.req.query("key") ?? "";
  if (!key.startsWith(`${b.owner}/${b.id}/output/`)) throw new StudioError("Not found.", 404);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw new StudioError("Not found.", 404);
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "private, max-age=604800" } });
});

/* ───────────── Typography: words set as part of the picture ───────────── */

/** A copy of a picture small enough for a quick reading (the long side at most `max`). */
async function smallCopy(bytes: ArrayBuffer, max = 1024): Promise<ImageBytes> {
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon");
  const img = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
  const k = Math.min(1, max / Math.max(img.get_width(), img.get_height()));
  const out = k < 1 ? resize(img, Math.round(img.get_width() * k), Math.round(img.get_height() * k), SamplingFilter.Lanczos3) : img;
  const jpeg = out.get_bytes_jpeg(88);
  if (out !== img) out.free();
  img.free();
  return { bytes: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer, mime: "image/jpeg" };
}

/** The paint-by-colour matte the image model makes of a post: the product white, the rest black. */
const MATTE_PROMPT =
  "Turn this photo into a matte for compositing. Paint the main subject solid pure white #FFFFFF: the product (the food, cake, sweets, drink, box, tin or tray, with the plate, cup or tray it sits in) and any person holding or presenting it. Paint everything else solid pure black #000000: the background, the table, the props, the shadows, the logo and any words. Keep exactly the same framing, size and position, so the white shape lines up with the subject in the photo pixel for pixel. Flat white and black only: no grey, no texture, no details.";

function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The outline of the picture's product (and the person holding it), as a full-frame matte. */
async function readSubject(env: Env, image: ImageBytes, aspectRatio: string): Promise<SubjectMask[]> {
  const engine = await makeGoogleClient(env);
  const out = await engine.edit({ model: "gemini-3.1-flash-image", prompt: MATTE_PROMPT, images: [image], aspectRatio, size: "1K" });
  return [{ box: [0, 0, 1, 1], mask: `data:${out.mime};base64,${base64Of(out.bytes)}`, label: "matte" }];
}

/**
 * The typographer: for each finished post, a style for its words (behind the product, crossing it,
 * repeated or outlined, or the plain headline), the word set big and a second font; the product's
 * outline is read for the styles that need it.
 */
postRoutes.post("/typography", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      indexes: z.array(z.number().int().min(1).max(MAX_POST_COUNT)).max(MAX_POST_COUNT).optional(),
      force: z.boolean().optional(),
      /** The style the team chose for every post; none lets the typographer pick per post. */
      style: z.enum(TYPO_STYLES).optional(),
      /** The designer confirmed the product-outline mattes' cost. */
      approve: z.boolean().optional(),
      run: z.string().max(80).optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const client = await clientRow(c.env, config.client);
  const theme = config.theme ? await themeRow(c.env, config.theme).catch(() => null) : null;
  const palette = monthPalette(config, theme).length ? monthPalette(config, theme) : paletteOf(client);
  const spec = resolveOverlay(client.overlay ? (JSON.parse(client.overlay) as Partial<OverlaySpec>) : null);
  const headlineFont = config.monthFonts?.headline ?? spec.headline.font;
  const tasks = await all<{ post: number | null; output: string | null }>(
    c.env.DB,
    "SELECT post, output FROM tasks WHERE batch = ? AND post IS NOT NULL AND output IS NOT NULL",
    b.id,
  );
  const plan = [...(config.plan ?? [])].sort((x, y) => x.index - y.index);
  const due = plan.filter((p) => {
    const t = tasks.find((x) => x.post === p.index);
    if (!t?.output || !p.headline?.trim() || p.overlay === false) return false;
    if (d.indexes && !d.indexes.includes(p.index)) return false;
    return d.force || d.style || !p.ov?.typo || p.ov.typoFor !== t.output;
  });
  // The product outline is a paid image-model call per post (the words are a text call): the set
  // is approved once by the designer, and each matte reserves its own cost before it is asked for.
  const MATTE_COST = rateFor("gemini-3.1-flash-image")!["1K"];
  if (due.length && previewNoImages(c.env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  if (due.length) {
    if (d.approve) await approveSpend(c.env, b.id, due.length * MATTE_COST, d.run);
    else if (!(await spendFits(c.env, b.id, due.length * MATTE_COST)).ok)
      throw new StudioError(`Typography on ${due.length} post${due.length === 1 ? "" : "s"}: reading each product's outline is about ${formatUsd(due.length * MATTE_COST)}. Confirm to go ahead.`, 409, false, {
        needsApproval: true,
        images: due.length,
        estimate: due.length * MATTE_COST,
        perImage: MATTE_COST,
        known: true,
      });
  }
  const chosen = new Map<number, { typo: PostTypography | null; for: string }>();
  const used: string[] = plan.flatMap((p) => (p.ov?.typo ? [`post ${p.index}: ${p.ov.typo.style}`] : []));
  const failed: number[] = [];
  const one = async (p: Post) => {
    const output = tasks.find((x) => x.post === p.index)!.output!;
    try {
      const obj = await c.env.BUCKET.get(output);
      if (!obj) throw new Error("the picture is missing");
      const image = await smallCopy(await obj.arrayBuffer());
      const kind = p.tileSpec ? `${p.tileSpec.kind} tile, ${p.type} post` : `${p.type} post`;
      const raw = await askText(
        c.env,
        typographyInstruction({ client: client.name, headline: p.headline!, subline: p.subline, kind, headlineFont, palette, used: used.slice(-4), force: d.style, tile: p.tileSpec?.text ? { position: p.tileSpec.text.position, size: p.tileSpec.text.size } : undefined }),
        TYPO_SCHEMA,
        [image],
      );
      const typo = parseTypography(parseJson<unknown>(raw), p.headline!, headlineFont, d.style);
      if (typo) {
        used.push(`post ${p.index}: ${typo.style}`);
        // The product's outline: the letters go behind it, or the repeated word stops at it.
        if (typo.style !== "outline") {
          const masks = !(await reserveSpend(c.env, b.id, MATTE_COST)).ok
            ? ([] as SubjectMask[])
            : await readSubject(c.env, image, config.format ?? "4:5").catch((e) => {
            console.log(`[typography] post ${p.index} outline: ${errorMessage(e).slice(0, 160)}`);
            return [] as SubjectMask[];
          });
          if (masks.length) {
            await c.env.BUCKET.put(`${output}.subject.json`, JSON.stringify(masks), { httpMetadata: { contentType: "application/json" } });
            typo.subject = `/api/studio/posts/subject/${b.id}/${p.index}?v=${encodeURIComponent(output.split("/").at(-1) ?? "")}`;
          }
        }
      }
      // Without the product's outline, letters behind it or repeated over it would cover it: plain headline.
      const covers = typo && !typo.subject && (typo.style === "behind" || typo.style === "overlap" || (typo.style === "repeat" && p.tileSpec?.kind !== "text"));
      chosen.set(p.index, { typo: covers ? null : typo, for: output });
    } catch (e) {
      console.log(`[typography] post ${p.index}: ${errorMessage(e).slice(0, 160)}`);
      failed.push(p.index);
    }
  };
  // In feed order, a few at a time, so each knows the styles before it.
  for (let i = 0; i < due.length; i += 3) await Promise.all(due.slice(i, i + 3).map(one));
  const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
  const latest = JSON.parse(fresh.config) as Config;
  for (const p of latest.plan ?? []) {
    const ch = chosen.get(p.index);
    if (!ch) continue;
    const rest = { ...p.ov };
    delete rest.typo;
    delete rest.typoOff;
    p.ov = ch.typo ? { ...rest, typo: ch.typo, typoFor: ch.for } : { ...rest, typoFor: ch.for };
  }
  // Setting the typography switches it on.
  latest.typographyOff = undefined;
  if (chosen.size) await saveConfig(c.env, fresh, latest);
  return c.json({
    ok: true,
    plan: latest.plan ?? [],
    set: [...chosen.entries()].filter(([, v]) => v.typo).map(([k, v]) => ({ index: k, style: v.typo!.style, word: v.typo!.word, font: v.typo!.font })),
    plain: [...chosen.entries()].filter(([, v]) => !v.typo).map(([k]) => k),
    failed,
  });
});

/**
 * The month's typography on or off: off keeps each post's typography aside and shows the plain
 * headline (the layout as it was before), on brings it back.
 */
postRoutes.post("/typography/switch", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), on: z.boolean() }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  config.plan = (config.plan ?? []).map((p) => {
    if (!p.ov) return p;
    const { typo, typoOff, ...rest } = p.ov;
    const kept = typo ?? typoOff;
    if (!kept) return p;
    return { ...p, ov: d.on ? { ...rest, typo: kept } : { ...rest, typoOff: kept } };
  });
  config.typographyOff = d.on ? undefined : true;
  await saveConfig(c.env, b, config);
  return c.json({ ok: true, plan: config.plan });
});

/** The team accepts a post as it is: the review's flags are cleared and the post counts as ready. */
postRoutes.post("/accept", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), index: z.number().int().min(1) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const t = await first<{ id: string; qa: string | null }>(c.env.DB, "SELECT id, qa FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t) throw new StudioError("That post has no picture.", 404);
  let qa: Record<string, unknown> = {};
  try {
    qa = t.qa ? (JSON.parse(t.qa) as Record<string, unknown>) : {};
  } catch {
    qa = {};
  }
  const who = c.get("user");
  await run(c.env.DB, "UPDATE tasks SET status = 'ready', qa = ?, updated = ? WHERE id = ?", JSON.stringify({ ...qa, flags: [], productConcern: false, automated: true, notes: `Accepted by ${who.name || "the team"}.`, acceptedBy: who.name || who.email }), now(), t.id);
  return c.json({ ok: true });
});


/**
 * Faces for pictures reviewed before the review learned to see them: one small vision call per
 * picture, once, so the words keep off every face from now on.
 */
/**
 * A reference for one post: the designer attaches a picture (and what to take from it) and the
 * next take or revision of the post gets it as an extra image. It stays on the post until taken off.
 */
postRoutes.post("/reference", async (c) => {
  const form = await c.req.formData();
  const batchId = String(form.get("batch") ?? "");
  const index = Math.round(Number(form.get("index")));
  const note = String(form.get("note") ?? "").trim().slice(0, 600);
  const file = form.get("file");
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, batchId);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === index);
  if (!post) throw new StudioError("That post is not in the month.", 404);
  let reference = post.reference;
  if (typeof file === "object" && file !== null && "arrayBuffer" in file) {
    if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) throw new StudioError("Attach a picture (JPG, PNG or WebP, up to 15 MB).");
    const id = uuid();
    const stored = await storeBytes(c.env, id, await file.arrayBuffer(), file.type);
    if (post.reference?.key) await c.env.BUCKET.delete([post.reference.key, post.reference.thumb]).catch(() => undefined);
    reference = { key: stored.image, thumb: stored.thumb, name: file.name.slice(0, 200), at: now() };
  }
  if (!reference) throw new StudioError("Attach a picture first.");
  reference = { ...reference, note: note || undefined };
  const fresh = await ownedPlan(c.env, user, batchId);
  const cfg = JSON.parse(fresh.config) as Config;
  cfg.plan = (cfg.plan ?? []).map((p) => (p.index === index ? { ...p, reference } : p));
  await saveConfig(c.env, fresh, cfg);
  return c.json({ ok: true, reference });
});

/** The reference of one post taken off (its picture is deleted). */
postRoutes.delete("/reference", async (c) => {
  const batchId = c.req.query("batch") ?? "";
  const index = Math.round(Number(c.req.query("index")));
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, batchId);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === index);
  if (post?.reference?.key) await c.env.BUCKET.delete([post.reference.key, post.reference.thumb]).catch(() => undefined);
  config.plan = (config.plan ?? []).map((p) => {
    if (p.index !== index) return p;
    const { reference: _r, ...rest } = p;
    void _r;
    return rest;
  });
  await saveConfig(c.env, b, config);
  return c.json({ ok: true });
});

/** The thumbnail of a post's reference. */
postRoutes.get("/reference/image", async (c) => {
  const batchId = c.req.query("batch") ?? "";
  const index = Math.round(Number(c.req.query("index")));
  const b = await ownedPlan(c.env, c.get("user"), batchId);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === index);
  const key = c.req.query("size") === "full" ? post?.reference?.key : post?.reference?.thumb || post?.reference?.key;
  const obj = key ? await c.env.BUCKET.get(key) : null;
  if (!obj) throw new StudioError("No picture.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
});

export interface PostComment {
  id: string;
  post: number;
  user: string;
  name: string;
  text: string;
  created: number;
}

/** The team's comments on the posts of a month. */
postRoutes.get("/comments", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch") ?? "");
  const rows = await all<PostComment>(c.env.DB, "SELECT id, post, user, name, text, created FROM post_comments WHERE batch = ? ORDER BY created ASC", b.id);
  return c.json({ comments: rows });
});

postRoutes.post("/comments", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), index: z.number().int().min(1).max(MAX_POST_COUNT), text: z.string().trim().min(1).max(2000) }));
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const row: PostComment = { id: uuid(), post: d.index, user: user.id, name: user.name || user.email, text: d.text, created: now() };
  await run(c.env.DB, "INSERT INTO post_comments (id, batch, post, user, name, text, created) VALUES (?, ?, ?, ?, ?, ?, ?)", row.id, b.id, row.post, row.user, row.name, row.text, row.created);
  return c.json({ ok: true, comment: row });
});

postRoutes.delete("/comments/:id", async (c) => {
  const user = c.get("user");
  const row = await first<{ id: string; batch: string; user: string }>(c.env.DB, "SELECT id, batch, user FROM post_comments WHERE id = ?", c.req.param("id"));
  if (!row) return c.json({ ok: true });
  await ownedPlan(c.env, user, row.batch);
  if (row.user !== user.id && user.role !== "admin") throw new StudioError("Only the person who wrote it can delete it.", 403);
  await run(c.env.DB, "DELETE FROM post_comments WHERE id = ?", row.id);
  return c.json({ ok: true });
});

postRoutes.post("/faces", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), force: z.boolean().optional() }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const rows = await all<{ id: string; output: string | null; qa: string | null }>(
    c.env.DB,
    "SELECT id, output, qa FROM tasks WHERE batch = ? AND output IS NOT NULL AND status IN ('ready','review','approved')",
    b.id,
  );
  let filled = 0;
  for (const t of rows) {
    let qa: Record<string, unknown> | null = null;
    try {
      qa = t.qa ? (JSON.parse(t.qa) as Record<string, unknown>) : null;
    } catch {
      qa = null;
    }
    if (!qa || (Array.isArray(qa.faces) && !(d.force && !(qa.faces as unknown[]).length))) continue;
    try {
      const obj = await c.env.BUCKET.get(t.output!);
      if (!obj) continue;
      const image: ImageBytes = { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" };
      const raw = parseJson<unknown>(
        await askText(
          c.env,
          `Look at the attached picture. ${FACES_ASK} Return ONLY JSON: {"faces": [...]}.`,
          FACES_SCHEMA,
          [image],
        ),
      );
      qa.faces = facesIn(raw);
      await run(c.env.DB, "UPDATE tasks SET qa = ? WHERE id = ? AND output = ?", JSON.stringify(qa), t.id, t.output);
      filled++;
    } catch (e) {
      console.error("[faces]", t.id, errorMessage(e));
    }
  }
  return c.json({ ok: true, filled });
});

/**
 * A campaign brief: the designer's text (a carousel, a series on one product, a single post) with
 * reference pictures. The references become this client's private styles, the planner turns the
 * brief into posts after the month's existing ones, and each post's shot is written in its
 * reference's style for the real products.
 */
postRoutes.post("/campaign", async (c) => {
  const form = await c.req.formData();
  const batchId = String(form.get("batch") ?? "");
  const text = String(form.get("brief") ?? "").trim();
  // "Only these posts": the month is the brief's posts alone; earlier ideas (and their pictures) are kept as a version.
  const only = form.get("only") === "1";
  if (!batchId) throw new StudioError("Batch id is required.");
  if (text.length < 20) throw new StudioError("Write the brief first (what the posts are about, how many, the text on each).");
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f).slice(0, 12);
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, batchId);
  // The references: the attached pictures, and the slides of any Instagram post linked in the brief.
  const refs: { name: string; bytes: ArrayBuffer; mime: string }[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/") || file.size > 15 * 1024 * 1024) continue;
    refs.push({ name: file.name, bytes: await file.arrayBuffer(), mime: file.type });
  }
  const links = [...new Set((text.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s)]+/gi) ?? []))].slice(0, 2);
  const linkNotes: string[] = [];
  for (const link of links) {
    const post = await instagramPostSlides(c.env, link);
    let n = 0;
    for (const slide of post.slides.slice(0, 6)) {
      if (refs.length >= 12) break;
      try {
        const r = await fetch(slide.url, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) continue;
        const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
        if (!mime.startsWith("image/")) continue;
        refs.push({ name: `@${post.username} slide ${++n}.jpg`, bytes: await r.arrayBuffer(), mime });
      } catch (e) {
        console.error("[brief] instagram slide", errorMessage(e));
      }
    }
    if (!n) throw new StudioError(`The pictures of ${link} could not be fetched. Attach the slides as pictures instead.`, 502);
    linkNotes.push(`${link} → @${post.username}, ${n} slide${n === 1 ? "" : "s"}${post.partial ? ` (${post.partial})` : ""}`);
  }
  // The planner reads the slides themselves: the link in the text becomes a plain mention of them.
  const briefText = links.reduce((t, link, i) => t.split(link).join(`(the attached Instagram carousel ${i + 1}: its slides are the reference pictures)`), text);
  const config = JSON.parse(b.config) as Config;
  const client = await clientRow(c.env, config.client);
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const names = [...new Set(sources.map(productName))];
  // The client's Drive is part of the studio: its product photos are offered to the planner too,
  // and the ones it picks join the month as its own copies.
  const drivePhotos = (await clientDrivePhotos(c.env, client.id).catch(() => [] as Awaited<ReturnType<typeof clientDrivePhotos>>)).filter(
    (p) => !p.video && !!p.kind && PRODUCT_KINDS.has(p.kind) && !names.some((n) => n.toLowerCase() === p.name.toLowerCase()),
  );
  const driveOptions = [...new Map(drivePhotos.map((p) => [p.name.toLowerCase(), p])).values()].slice(0, 60);
  // The references: read into private styles of this client (never listed in the gallery).
  const styleIds: string[] = [];
  const images: ImageBytes[] = [];
  for (const file of refs) {
    const id = uuid();
    const stored = await storeBytes(c.env, id, file.bytes, file.mime);
    images.push({ bytes: stored.bytes, mime: stored.mime });
    let prompt = "Follow the attached reference closely: its composition, light, scale, surfaces and mood, with this brand's product in place of its product.";
    let title = "Brief reference";
    let kind = "product";
    let category = "lifestyle";
    try {
      const st = await readPicture(c.env, { bytes: stored.bytes, mime: stored.mime }, "brief reference", false);
      if (st.prompt.length > 40) prompt = st.prompt;
      if (st.title) title = st.title;
      kind = st.kind;
      category = st.category;
    } catch (e) {
      console.error("[brief] reference read", errorMessage(e));
    }
    await run(
      c.env.DB,
      "INSERT INTO styles (id, kind, status, category, score, tiles, w, h, title, tags, prompt, source, note, image_key, thumb_key, position, created, updated, client) VALUES (?, ?, 'brief', ?, 9, 0, ?, ?, ?, '', ?, ?, ?, ?, ?, -1, ?, ?, ?)",
      id,
      kind,
      category,
      stored.w,
      stored.h,
      title,
      prompt,
      file.name.slice(0, 200),
      "brief reference",
      stored.image,
      stored.thumb,
      now(),
      now(),
      client.id,
    );
    styleIds.push(id);
  }
  // The brief planned again without its pictures: the references it had are used again.
  if (!styleIds.length && config.campaign?.styles?.length) {
    for (const id of config.campaign.styles) {
      const st = await styleRow(c.env, id);
      if (!st?.image_key) continue;
      const obj = await c.env.BUCKET.get(st.image_key);
      if (!obj) continue;
      images.push({ bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" });
      styleIds.push(id);
    }
  }
  const existing = only ? [] : (config.plan ?? []);
  const raw = parseJson<unknown>(
    await askText(
      c.env,
      briefPlanInstruction({
        client: client.name,
        brief: briefText,
        month: config.month ?? "",
        products: [
          ...sources.map((s) => ({ name: productName(s), note: s.note ?? "" })),
          ...driveOptions.map((p) => ({ name: p.name, note: `${p.note ?? ""} (in the client's Drive, not in this month yet: name it and it joins the month)`.trim() })),
        ],
        references: images.length,
        brand: { style: client.style, tone: client.tone, dos: client.dos, donts: client.donts },
        language: (["ar", "en", "both"].includes(client.language) ? client.language : "ar") as "ar" | "en" | "both",
        existing: existing.length,
      }),
      BRIEF_PLAN_SCHEMA,
      images,
    ),
  );
  const nextIndex = existing.reduce((m, p) => Math.max(m, p.index), 0) + 1;
  const planned = parseBriefPlan(raw, [...names, ...driveOptions.map((p) => p.name)], nextIndex, () => uuid().slice(0, 8));
  // This month's colours come from the brief: the colours it names, else the colour story of its
  // reference pictures (the Colours screen shows them, the first as the background).
  let monthColours = planned.colours;
  if (!monthColours.length && images.length && config.theme) {
    try {
      const d = parseJson<{ palette?: unknown }>(await askText(c.env, paletteInstruction(images.length), PALETTE_SCHEMA, images));
      monthColours = parsePalette(d.palette).slice(0, 6);
    } catch (e) {
      console.error("[brief] reference colours", errorMessage(e));
    }
  }
  // The brief's colours are this month's: the theme, shared by other months, is left as it is
  // (the designer can push them to the theme from the Direction screen).
  if (monthColours.length) {
    config.palette = monthColours;
    config.paletteFrom = "brief";
  }
  // Drive products the planner picked: imported once into the month, with what vision read in them.
  const imported = new Map<string, string>();
  const taken = new Set(sources.map((s) => s.stem));
  for (const { post } of planned.posts)
    for (const n of [post.product, ...(post.products ?? [])]) {
      if (!n || imported.has(n) || names.includes(n)) continue;
      const photo = driveOptions.find((p) => p.name === n);
      if (!photo) continue;
      try {
        const row = await importDrivePhoto(c.env, user.id, b.id, photo.id, photo.name, taken);
        if (photo.note || photo.kind) await run(c.env.DB, "UPDATE sources SET note = ?, category = ? WHERE id = ?", photo.note ?? null, photo.kind ?? null, row.id);
        imported.set(n, productName(row as unknown as SourceRow));
      } catch (e) {
        console.error("[brief] drive import", photo.name, errorMessage(e));
      }
    }
  for (const { post } of planned.posts) {
    if (post.product && imported.has(post.product)) post.product = imported.get(post.product);
    if (post.products) post.products = post.products.map((n) => imported.get(n) ?? n);
  }
  const failed = async (message: string) => {
    // What went wrong stays on the month, so the box can show it after a reload.
    const cfgNow = JSON.parse((await ownedPlan(c.env, user, b.id)).config) as Config;
    cfgNow.campaign = { text: text.slice(0, 6000), at: now(), error: message.slice(0, 300) };
    await saveConfig(c.env, b, cfgNow);
    return new StudioError(message, 502);
  };
  if (!planned.posts.length) throw await failed("The planner wrote no posts from this brief. Say what each post or slide shows and the text on it, then try again.");
  if (existing.length + planned.posts.length > MAX_POST_COUNT) throw await failed(`The month can hold ${MAX_POST_COUNT} posts; this brief adds ${planned.posts.length} to ${existing.length}.`);
  // The new posts come after the month's last day: a carousel's slides share one day (one post on
  // Instagram), a series takes consecutive days. The month's numbering follows the dates.
  const month = config.month ?? "";
  const lastDay = /^\d{4}-\d{2}$/.test(month) ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate() : 28;
  const dayOf = (d: string | undefined) => (d && d.startsWith(month) ? Number(d.slice(8, 10)) || 0 : 0);
  let day = Math.min(lastDay, Math.max(1, existing.reduce((m, p) => Math.max(m, dayOf(p.date)), 0) + 1));
  const dayDate = (n: number) => `${month}-${String(Math.min(lastDay, n)).padStart(2, "0")}`;
  let lastGroup = "";
  const added = planned.posts.map(({ post, reference }) => {
    // A separator (a plain backdrop with no product) follows no reference picture.
    const separator = post.type === "quote" && !post.product && !post.group;
    const style = separator ? undefined : (styleIds[reference - 1] ?? styleIds[0] ?? undefined);
    if (post.group?.kind === "carousel") {
      if (post.group.id !== lastGroup && lastGroup) day = Math.min(lastDay, day + 1);
      lastGroup = post.group.id;
      return { ...post, style, date: month ? dayDate(day) : undefined };
    }
    if (lastGroup && post.group?.id !== lastGroup) day = Math.min(lastDay, day + 1);
    lastGroup = post.group?.id ?? "";
    const dated = { ...post, style, date: month ? dayDate(day) : undefined };
    day = Math.min(lastDay, day + 1);
    return dated;
  });
  if (only && config.plan?.length) await keepMonthVersion(c.env, b);
  config.plan = withPortraits(withDates([...existing, ...added], month), config, b.id);
  // The month is exactly these posts: the count follows, and the ideas count as freshly written.
  config.postCount = config.plan.length;
  // The brief and the plan share one stamp: the month is the brief's posts until the ideas are written again.
  const stamp = now();
  config.plannedAt = stamp;
  // The outcome in the studio's own words: what was planned and what came in from Drive. The
  // planner's instructions to "the designer" are dropped when the studio already did the work.
  const groups = [...new Map(added.filter((p) => p.group).map((p) => [p.group!.id, p.group!])).values()];
  const shape = groups.length
    ? groups.map((g) => `a ${g.of}-${g.kind === "carousel" ? "slide carousel" : "post series"}`).join(", ")
    : `${added.length} post${added.length === 1 ? "" : "s"}`;
  const pulled = [...new Set([...imported.values()])];
  // The planner's sentences addressed to the designer are dropped: the studio did or will do that work.
  const plannerNote = planned.summary
    .split(/(?<=[.!?])\s+/)
    .filter((x) => !/\b(designer|upload|must|needs? to|should|ensure|make sure)\b/i.test(x))
    .join(" ")
    .trim();
  const summary = [`Planned ${shape}.`, linkNotes.length ? `Read from Instagram: ${linkNotes.join("; ")}.` : "", pulled.length ? `Pulled from Drive into this month: ${pulled.join(", ")}.` : "", monthColours.length ? `${planned.colours.length ? "Colours read from the brief" : "Colours read from the reference pictures"} and set as this month's colours: ${monthColours.map((x) => `${x.name} ${x.hex}`.trim()).join(", ")}.` : "", plannerNote].filter(Boolean).join(" ").slice(0, 600);
  config.campaign = { text: text.slice(0, 6000), at: stamp, added: added.length, summary, only: only || undefined, styles: styleIds.length ? styleIds : undefined, colours: planned.colours.length ? planned.colours : undefined };
  await saveConfig(c.env, b, config);
  // Each new post's shot, written in its reference's style for its real products (the posts are
  // found again by their words: the dates renumbered the month).
  const fresh0 = await ownedPlan(c.env, user, b.id);
  const cfg0 = JSON.parse(fresh0.config) as Config;
  const sig = (p: Post) => `${p.title}|${p.headline ?? ""}|${p.brief}`;
  const mine = new Set(added.map(sig));
  const assign = (cfg0.plan ?? []).filter((p) => mine.has(sig(p)) && p.style).map((p) => ({ index: p.index, style: p.style! }));
  if (assign.length) {
    const fresh = fresh0;
    const cfg = cfg0;
    try {
      const scenes = await writeStyleScenes(c.env, fresh, cfg, assign);
      // A slide the writer missed is asked for once more on its own.
      for (const a of assign)
        if (!scenes.get(a.index)?.scene) {
          try {
            const again = await writeStyleScenes(c.env, fresh, cfg, [a]);
            const s = again.get(a.index);
            if (s?.scene) scenes.set(a.index, s);
          } catch (e) {
            console.error("[brief] scene retry", a.index, errorMessage(e));
          }
        }
      cfg.plan = (cfg.plan ?? []).map((p) => {
        const s = scenes.get(p.index);
        // The planner's brief is the designer's idea: only the shot comes from the style writer.
        return s?.scene ? { ...p, scene: s.scene } : p;
      });
      await saveConfig(c.env, fresh, cfg);
    } catch (e) {
      console.error("[brief] scenes", errorMessage(e));
    }
  }
  const done = await ownedPlan(c.env, user, b.id);
  return c.json({ ok: true, added: added.length, summary, plan: (JSON.parse(done.config) as Config).plan });
});

/**
 * Text on design: the finished post, with its words and logo drawn on by the studio, is looked at
 * by the art director. What it finds goes on the post (note), and its corrections into the post's
 * text layout (position, fade, size), so the words move off the product and stay readable. The colour
 * is never touched: the text is white for every client unless the designer changes it by hand.
 */
postRoutes.post("/text-check", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      index: z.number().int().min(1).max(MAX_POST_COUNT),
      /** The composed post as a JPEG data URL (the browser draws the words; the server cannot). */
      image: z.string().regex(/^data:image\/jpeg;base64,/).max(1_500_000),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === d.index);
  if (!post) throw new StudioError("That post is not in the plan.", 404);
  const t = await first<{ output: string | null }>(c.env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const client = await clientRow(c.env, config.client);
  const theme = config.theme ? await themeRow(c.env, config.theme).catch(() => null) : null;
  const palette = monthPalette(config, theme).length ? monthPalette(config, theme) : paletteOf(client);
  const spec = resolveOverlay(client.overlay ? (JSON.parse(client.overlay) as Partial<OverlaySpec>) : null);
  const bytes = Uint8Array.from(atob(d.image.slice(d.image.indexOf(",") + 1)), (ch) => ch.charCodeAt(0));
  const check = parseTextCheck(
    parseJson<unknown>(
      await askText(
        c.env,
        textCheckInstruction({ client: client.name, headline: post.headline ?? "", subline: post.subline || undefined, palette, shadow: spec.headline.shadow || undefined }),
        TEXT_CHECK_SCHEMA,
        [{ bytes: bytes.buffer as ArrayBuffer, mime: "image/jpeg" }],
      ),
    ),
  );
  if (!check) throw new StudioError("The art director gave no usable answer. Try again.", 502);
  // The corrections go into the post's text layout; a designer's own placement (dx/dy, or a pinned place) is kept.
  const ov: PostOverlayPatch = { ...(post.ov ?? {}) };
  // A post laid out in the Text studio keeps the designer's layout: the check only reports.
  const designed = !!ov.design?.layers.length;
  if (!designed && check.position !== "keep" && ov.dx === undefined && ov.dy === undefined && !ov.pin) ov.position = check.position;
  // The text is white for every client; only the designer changes its colour, by hand.
  if (!designed && check.fade === "on") delete ov.fade;
  if (!designed && check.fade === "off") ov.fade = false;
  if (!designed && Math.abs(check.scale - 1) >= 0.05) ov.scale = Math.round((ov.scale ?? 1) * check.scale * 100) / 100;
  const fresh = await ownedPlan(c.env, c.get("user"), d.batch);
  const cfg = JSON.parse(fresh.config) as Config;
  const next: Post = { ...post, ov: Object.keys(ov).length ? ov : undefined, textCheck: { ok: check.ok, note: check.note || (check.ok ? "The words read well and cover nothing." : [check.covers ? `The words cover ${check.covers}.` : "", !check.readable ? "The words are hard to read." : ""].filter(Boolean).join(" ")), for: t.output, at: now() } };
  cfg.plan = (cfg.plan ?? []).map((p) => (p.index === d.index ? next : p));
  await saveConfig(c.env, fresh, cfg);
  return c.json({ ok: true, post: next, check });
});

const safeJson = <T,>(raw: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
};

/** The Text studio's writing assistant: suggestions only, applied by the designer. */
postRoutes.post("/text-assist", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      index: z.number().int().min(1).max(MAX_POST_COUNT),
      action: z.enum(ASSIST_ACTIONS),
      text: z.string().trim().min(1).max(1500),
      /** The composed post as a JPEG data URL, for the layout judgement. */
      image: z.string().regex(/^data:image\/jpeg;base64,/).max(1_500_000).optional(),
    }),
  );
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === d.index);
  if (!post) throw new StudioError("That post is not in the plan.", 404);
  const client = await clientRow(c.env, config.client);
  const theme = config.theme ? await themeRow(c.env, config.theme).catch(() => null) : null;
  const palette = monthPalette(config, theme).length ? monthPalette(config, theme) : paletteOf(client);
  const fontsRow = await first<{ fonts: string | null }>(c.env.DB, "SELECT fonts FROM clients WHERE id = ?", client.id);
  const images = d.image && d.action === "layout" ? [{ bytes: Uint8Array.from(atob(d.image.slice(d.image.indexOf(",") + 1)), (ch) => ch.charCodeAt(0)).buffer as ArrayBuffer, mime: "image/jpeg" }] : [];
  const answer = parseAssist(
    parseJson<unknown>(
      await askText(
        c.env,
        assistInstruction({
          action: d.action,
          text: d.text,
          client: client.name,
          tone: client.tone || undefined,
          audience: client.audience || undefined,
          language: (["ar", "en", "both"] as const).find((l) => l === client.language),
          brief: post.brief || post.title,
          brand: { fonts: Object.values(safeJson<Record<string, string>>(fontsRow?.fonts ?? "{}")).filter((f): f is string => !!f), colours: palette },
        }),
        ASSIST_SCHEMA,
        images,
      ),
    ),
  );
  if (!answer.suggestions.length && !answer.verdict) throw new StudioError("The assistant gave no usable answer. Try again.", 502);
  return c.json(answer);
});

/* ───────────── Video: a finished post set in motion on Higgsfield ───────────── */

interface VideoRow {
  id: string;
  batch: string;
  post: number;
  task: string;
  owner: string;
  model: string;
  prompt: string;
  status: string;
  request_id: string | null;
  key: string | null;
  error: string | null;
  created: number;
  updated: number;
}

function videoItem(v: VideoRow) {
  return { id: v.id, post: v.post, model: v.model, prompt: v.prompt, status: v.status, error: v.error, created: v.created, url: v.key ? `/api/studio/posts/video/file?batch=${encodeURIComponent(v.batch)}&id=${encodeURIComponent(v.id)}` : null };
}

/** The motion idea for one finished post, written from its picture and its brief. */
postRoutes.post("/video/idea", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), index: z.number().int().min(1).max(MAX_POST_COUNT) }));
  const b = await ownedPlan(c.env, c.get("user"), d.batch);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === d.index);
  if (!post) throw new StudioError("That post is not in the plan.", 404);
  const t = await first<{ output: string | null }>(c.env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  const obj = await c.env.BUCKET.get(t.output);
  if (!obj) throw new StudioError("The picture is missing.", 404);
  const client = await clientRow(c.env, config.client);
  const sources = await all<SourceRow>(c.env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product'", b.id);
  const product = sources.find((x) => productName(x) === post.product);
  const raw = parseJson<{ idea?: unknown }>(
    await askText(
      c.env,
      videoIdeaInstruction({ client: client.name, type: POST_TYPE_INFO[post.type]?.label ?? post.type, title: post.title, brief: post.brief, headline: post.headline, product: product ? `${productName(product)}${product.note ? ` (${product.note})` : ""}` : post.product, people: post.people }),
      VIDEO_IDEA_SCHEMA,
      [{ bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" }],
    ),
  );
  const idea = String(raw.idea ?? "").trim().slice(0, 1200);
  if (!idea) throw new StudioError("No idea came back. Try again.", 502);
  return c.json({ ok: true, idea });
});

/** Makes the video: the post's picture is the first frame, the idea is the motion. */
postRoutes.post("/video", async (c) => {
  const d = await body(
    c,
    z.object({
      batch: z.string().min(1),
      index: z.number().int().min(1).max(MAX_POST_COUNT),
      prompt: z.string().trim().min(5).max(1500),
      model: z.string().refine((m) => VIDEO_MODELS.some((x) => x.slug === m), "Unknown video engine."),
    }),
  );
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const t = await first<{ id: string; output: string | null }>(c.env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, d.index);
  if (!t?.output) throw new StudioError("That post has no picture yet.", 409);
  if (previewNoImages(c.env)) throw new StudioError(PREVIEW_MESSAGE, 403);
  const engine = await makeClient(c.env);
  const model = VIDEO_MODELS.find((x) => x.slug === d.model)!;
  const id = uuid();
  const requestId = await engine.submitVideo({ model: model.slug, prompt: d.prompt, imageUrl: await signObjectUrl(c.env, t.output, 6 * 60 * 60 * 1000), duration: VIDEO_SECONDS, resolution: model.resolution });
  await run(
    c.env.DB,
    "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
    id,
    b.id,
    d.index,
    t.id,
    user.id,
    model.slug,
    d.prompt,
    requestId,
    now(),
    now(),
  );
  const row = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ?", id);
  return c.json({ ok: true, video: videoItem(row!) });
});

/** A post's videos, newest first; the ones still running are asked about and stored when done. */
postRoutes.get("/video/list", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const index = Number(c.req.query("index"));
  const rows = await all<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE batch = ? AND post = ? ORDER BY created DESC LIMIT 12", b.id, index);
  const pending = rows.filter((v) => v.status === "queued" && v.request_id);
  if (pending.length) {
    const engine = await makeClient(c.env).catch(() => null);
    if (engine)
      for (const v of pending) {
        try {
          const st = await engine.videoStatus(v.request_id!);
          if (st.state === "done") {
            const r = await fetch(st.url, { signal: AbortSignal.timeout(120_000) });
            if (!r.ok) throw new StudioError(`The video could not be fetched (${r.status}).`, 502);
            const key = `${b.owner}/${b.id}/video/${v.task}/${v.id}.mp4`;
            await c.env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: r.headers.get("content-type")?.split(";")[0] || "video/mp4" } });
            await run(c.env.DB, "UPDATE videos SET status = 'done', key = ?, error = NULL, updated = ? WHERE id = ?", key, now(), v.id);
            v.status = "done";
            v.key = key;
          } else if (st.state === "failed") {
            await run(c.env.DB, "UPDATE videos SET status = 'failed', error = ?, updated = ? WHERE id = ?", st.message.slice(0, 400), now(), v.id);
            v.status = "failed";
            v.error = st.message;
          } else if (now() - v.created > 30 * 60 * 1000) {
            await run(c.env.DB, "UPDATE videos SET status = 'failed', error = 'The engine did not finish in half an hour.', updated = ? WHERE id = ?", now(), v.id);
            v.status = "failed";
            v.error = "The engine did not finish in half an hour.";
          }
        } catch (e) {
          console.error("[video] status", v.id, errorMessage(e));
        }
      }
  }
  return c.json({ ok: true, videos: rows.map(videoItem), engines: VIDEO_MODELS });
});

/** The stored video. */
postRoutes.get("/video/file", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.query("batch"));
  const v = await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ? AND batch = ?", c.req.query("id") ?? "", b.id);
  const obj = v?.key ? await c.env.BUCKET.get(v.key) : null;
  if (!obj) throw new StudioError("Video not found.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "video/mp4",
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": `inline; filename="post-${v!.post}.mp4"`,
    },
  });
});

/** The outline of a post's product, read for its current picture; 404 once the picture changed. */
postRoutes.get("/subject/:batch/:index", async (c) => {
  const b = await ownedPlan(c.env, c.get("user"), c.req.param("batch"));
  const t = await first<{ output: string | null }>(c.env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ?", b.id, Number(c.req.param("index")));
  const obj = t?.output ? await c.env.BUCKET.get(`${t.output}.subject.json`) : null;
  if (!obj) throw new StudioError("No outline for this picture.", 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=86400" } });
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
  const d = await body(c, z.object({ batch: z.string().min(1), approve: z.boolean().optional(), run: z.string().max(80).optional() }));
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
  const palette = theme && monthPalette(config, theme).length ? monthPalette(config, theme) : paletteOf(client);
  const prompt = testGridPrompt({ client: client.name, layout, plan, palette, products, reference: !!refObj && images.length > products.length });
  const engine = await makeGoogleClient(c.env);
  const model = isGoogleModel(config.model) ? config.model! : GOOGLE_MODELS[0].slug;
  // One paid picture: approved by the designer's confirmation, reserved before it is asked for.
  await reserveOrAsk(c.env, b.id, rateFor(model)?.["2K"] ?? rateFor(GOOGLE_MODELS[0].slug)!["2K"], d.approve, "The test grid", d.run);
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
  // Drive: one option per product name (its cleanest, newest photo), with how many photos it has.
  // Photos vision read as the shop, the kitchen, people or a design are not products.
  const drive = new Map<string, { id: string; name: string; folder: string; note: string; n: number }>();
  for (const p of (await clientDrivePhotos(env, client)).sort((a, z) => productRank(a.kind) - productRank(z.kind) || z.modified.localeCompare(a.modified))) {
    if (p.video || (p.kind && !PRODUCT_KINDS.has(p.kind))) continue;
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
  // Another product, not another photo of the same one: the headline, idea and caption written for
  // the old product would describe a muffin under a picture of cake boxes, so they are written again.
  const sameKind = !current.product || productKeyOf(current.product) === productKeyOf(name) || productKeyOf(current.product).startsWith(productKeyOf(name)) || productKeyOf(name).startsWith(productKeyOf(current.product));
  if (!sameKind) {
    const row = (await all<SourceRow>(env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note FROM sources WHERE batch = ? AND kind = 'product'", b.id)).find((s) => productName(s) === name);
    try {
      return await rewritePostIdea(env, b, config, index, `The post's product is now "${name}"${row?.note ? ` (${row.note})` : ""}: keep the post's type, date and tile, and write its title, headline, subline, idea and caption for THIS product, as its photo shows it.`);
    } catch (e) {
      console.error("[products] rewrite after swap", index, errorMessage(e));
    }
  }
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
    // Every post takes the Drive photo that fits its tile best, spread across the Drive's products:
    // a photo already given to another post goes to the next pick, so the month is shuffled, not
    // the same product everywhere. The words are written again for whatever product is chosen.
    const given = new Set<string>();
    const chosen = matches.flatMap((m) => {
      const drivePicks = m.picks.filter((x) => x.source === "drive");
      const pick = drivePicks.find((x) => !given.has(x.id)) ?? drivePicks[0];
      if (!pick) return [];
      given.add(pick.id);
      return [{ index: m.index, pick }];
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
    const was = new Map((config.plan ?? []).map((p) => [p.index, p.product]));
    config.plan = (config.plan ?? []).map((p) => (names.has(p.index) ? withProduct(p, names.get(p.index)!) : p));
    await saveConfig(c.env, fresh!, config);
    for (const [index, product] of names) filled.push({ index, product, source: "drive" });
    // A different product than before: the post's words and idea follow it.
    for (const [index, product] of names) {
      const before = was.get(index);
      const same = !!before && (productKeyOf(before) === productKeyOf(product) || productKeyOf(before).startsWith(productKeyOf(product)) || productKeyOf(product).startsWith(productKeyOf(before)));
      if (same) continue;
      try {
        const latest = await first<BatchRow>(c.env.DB, "SELECT * FROM batches WHERE id = ?", b.id);
        await refitWords(c.env, latest!, JSON.parse(latest!.config) as Config, index);
      } catch (e) {
        console.error("[products] drive refit", index, errorMessage(e));
      }
    }
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
  // An admin continues from any team member's month; a member from their own.
  const admin = user.role === "admin";
  const taken = admin
    ? await first(c.env.DB, "SELECT id FROM batches WHERE client = ? AND month = ? AND deleted IS NULL", d.client, d.month)
    : await first(c.env.DB, "SELECT id FROM batches WHERE owner = ? AND client = ? AND month = ? AND deleted IS NULL", user.id, d.client, d.month);
  if (taken) throw new StudioError("This month already has a plan.", 409);
  const prev = admin
    ? await first<BatchRow>(
        c.env.DB,
        "SELECT * FROM batches WHERE client = ? AND month IS NOT NULL AND month < ? AND deleted IS NULL ORDER BY month DESC, updated DESC LIMIT 1",
        d.client,
        d.month,
      )
    : await first<BatchRow>(
        c.env.DB,
        "SELECT * FROM batches WHERE owner = ? AND client = ? AND month IS NOT NULL AND month < ? AND deleted IS NULL ORDER BY month DESC, updated DESC LIMIT 1",
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
  const shape = planShape(config.plan ?? []);
  const points = [
    ...(shape ? [shape] : []),
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
  const d = await body(c, z.object({ batch: z.string().min(1), step: z.enum(BRIEF_STEPS), sig: z.string().max(600).optional() }));
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
    const chosen = monthPalette(config, theme).length > 0;
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
                  chosen ? `THE MONTH'S COLOURS (chosen by the designer, they replace the pins' colours): ${monthPalette(config, theme).join(", ")}` : "",
                  `BRAND AMBASSADORS THIS MONTH: ${cast.map((a) => `${a.name} (${a.description})`).join("; ") || "none (product-only posts)"}`,
                ].join("\n")
              : "No theme: the month follows the brand identity only."
            : step === "colours"
              ? [
                  `CHOSEN COLOURS (first = background): ${monthPalette(config, theme).join(", ") || "none, the brand colours are used"}`,
                  `BRAND COLOURS: ${paletteOf(client).join(", ") || "none"}`,
                  `PRODUCTS AND THEIR PACKAGING:\n${productLines.join("\n") || "none"}`,
                ].join("\n")
              : [
                  `THIS MONTH'S SHOTS (one per post):\n${
                    (config.plan ?? []).filter((x) => x.scene).map((x) => `Post ${x.index} (${x.type}): ${x.scene}`).join("\n") ||
                    monthShots(config, theme).map((t, i) => `${i + 1}. ${chosen ? withoutColourWords(t) : t}`).join("\n") ||
                    "none"
                  }`,
                  chosen ? `THE MONTH'S COLOURS (first = background; they replace every colour of the pins): ${monthPalette(config, theme).join(", ")}` : "",
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
  cfg.brief = { ...(cfg.brief ?? {}), [step]: { ...note, at: now(), sig: d.sig } };
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
  // A post with a gallery style keeps its own shot (that style written for its product), and so
  // does a shot the designer wrote by hand, unless this post is asked for by name.
  const wanted = new Set(
    (d.indexes ?? plan.map((p) => p.index)).filter((i) => {
      const p = plan.find((x) => x.index === i);
      return !!p && !p.style && (!p.handShot || !!d.indexes || !!d.all);
    }),
  );
  const styledMissing = plan
    .filter((p) => p.style && ((d.all && !p.group) || !p.scene) && (!d.indexes || d.indexes.includes(p.index)))
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
  const palette = monthPalette(config, theme);
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
  const shotLessons = await lessonsFor(c.env, client.id).catch(() => [] as string[]);
  const ask = async (strict: boolean | string) => {
    const raw = parseJson<{ shots?: unknown }>(
      await askText(
        c.env,
        adaptShotsInstruction({
          shots: palette.length ? base.map(withoutColourWords) : base,
          posts,
          palette,
          props: theme?.props,
          strict,
          lessons: shotLessons,
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
  // Food, drink or toppings a shot names that its post's products do not have (a cookie from the
  // tile, syrup the product photo does not show) are invented: the writer is asked once more.
  const invented = (out: Map<number, string>) =>
    [...out].flatMap(([i, t]) => {
      const post = posts.find((p) => p.index === i);
      if (!post?.products.length) return [];
      // Only the products themselves are allowed: an idea that dips a biscuit in is not a licence.
      return foreignFood(t, post.products.join(" "));
    });
  const bad = [...new Set(invented(shots))];
  if (bad.length) shots = await ask(bad.slice(0, 12).join(", "));
  else if (!sellsDrinks && [...shots.values()].some((t) => foreignItemIn(t))) shots = await ask(true);
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
/** The idea casts its own people: a campaign post keeps them when a gallery style is written for it. */
const BRIEF_PEOPLE = /\b(man|men|woman|women|father|mother|parents?|family|families|couple|child|children|kid|kids|boy|girl|son|daughter|grand(?:mother|father|ma|pa)|people|person|friends?|customer|doctor|nurse|teacher|driver|barista|chef|model|lady|gentleman|teen(?:ager)?s?)\b/i;

async function writeStyleScenes(
  env: Env,
  b: BatchRow,
  config: Config,
  assign: { index: number; style: string | null }[],
): Promise<Map<number, { style?: string; scene?: string; brief?: string }>> {
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
  const palette = monthPalette(config, theme).length ? monthPalette(config, theme) : paletteOf(client);
  const scenes = new Map<number, { style?: string; scene?: string; brief?: string }>();
  const styleLessons = await lessonsFor(env, client.id).catch(() => [] as string[]);
  await Promise.all(
    assign.map(async (a) => {
      const post = plan.find((p) => p.index === a.index);
      if (!post) return;
      if (!a.style) return scenes.set(a.index, {});
      const style = await styleRow(env, a.style);
      if (!style || !style.prompt) throw new StudioError("That style is no longer in the gallery.", 404);
      const reference = style.status === "brief" || !!post.group;
      const m = matchProduct(post.type === "offer" ? post.offer?.products[0] : post.product, names);
      const src = m ? sources.find((x) => productName(x) === m) : undefined;
      // A post with more products shows them all together: the style is written for the set.
      const extras = (post.type === "offer" ? post.offer?.products.slice(1) ?? [] : post.products ?? [])
        .map((n) => matchProduct(n, names))
        .filter((n): n is string => !!n && n !== m)
        .map((n) => sources.find((x) => productName(x) === n))
        .filter((x): x is SourceRow => !!x);
      const productText = [src?.note?.trim() || "", ...extras.map((x) => x.note?.trim() || "")].filter(Boolean);
      // An ingredients slide: the ingredients themselves are "the product" the style is written for.
      if (!productText.length && post.ingredients?.trim()) productText.push(`ONLY THE INGREDIENTS of the brand's product, on their own, no cup, glass or packaging: ${post.ingredients.trim()}`);
      // A campaign's slides share its ingredients: nothing else edible joins the product on any slide.
      const onlyFood = post.ingredients?.trim() || (post.group ? plan.find((x) => x.group?.id === post.group?.id && x.ingredients?.trim())?.ingredients?.trim() : undefined);
      const text = await askText(
        env,
        adaptStyleInstruction({
          style: { title: style.title, kind: style.kind, prompt: style.prompt },
          product: productText.length > 1 ? `${productText.length} products TOGETHER in the one picture, each shown once: ${productText.map((t, i) => `(${i + 1}) ${t}`).join("; ")}` : productText[0] || "",
          category: src?.category || undefined,
          post: { type: POST_TYPE_INFO[post.type]?.label ?? post.type, headline: post.headline ?? "", brief: withoutProductNames(post.brief, names).slice(0, 500) },
          brand: { name: client.name, style: client.style, always: photoRules(client.dos), never: photoRules(client.donts) },
          palette: reference ? (config.campaign?.colours?.map((x) => `${x.name} ${x.hex}`.trim()) ?? []) : palette,
          people: (post.people ?? [])
            .map((n) => cast.find((x) => x.name.toLowerCase() === n.toLowerCase()))
            .filter((x): x is AmbassadorRow => !!x)
            .map((x) => `${x.name} (${x.description})`),
          briefPeople: reference && BRIEF_PEOPLE.test(post.brief),
          sellsDrinks,
          service: sources.length ? undefined : client.service || undefined,
          theme: reference ? undefined : config.gridRef ? config.gridNotes?.split("\n")[0] : theme ? [theme.goal, theme.description].filter(Boolean).join(" ") : undefined,
          lessons: styleLessons,
          onlyFood,
          reference,
        }),
        ADAPT_SCHEMA,
      );
      const answer = parseJson<{ prompt?: unknown; brief?: unknown }>(text);
      const scene = withoutProductNames(String(answer.prompt ?? "").trim(), names).slice(0, 1500);
      if (!scene) throw new StudioError("The model returned no shot. Try again.", 502);
      // The post's idea becomes the style's own, so the old idea's staging never joins the picture.
      // A campaign post keeps the designer's brief: only its shot is written.
      const brief = reference ? "" : String(answer.brief ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
      scenes.set(a.index, { style: style.id, scene, ...(brief ? { brief } : {}) });
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
    const { style: _style, scene: _scene, briefBeforeStyle: before, ...rest } = p;
    void _style;
    void _scene;
    // A style's own idea replaces the post's; taking the style off brings the post's idea back.
    // The tile's text layout (huge words at the centre…) goes with the tile: a styled post keeps
    // the plain layout, and gets the tile's back when the style is taken off.
    const typo = p.ov?.typo ? { typo: p.ov.typo, typoFor: p.ov.typoFor } : {};
    if (s.style) return { ...rest, style: s.style, scene: s.scene, ov: Object.keys(typo).length ? typo : undefined, ...(s.brief ? { brief: s.brief, briefBeforeStyle: before ?? p.brief } : before ? { briefBeforeStyle: before } : {}) };
    const tileOv = p.tileSpec ? overlayFromTile(p.tileSpec.text, p.tileSpec.kind) : {};
    return { ...rest, ...tileOv, ov: { ...(tileOv.ov ?? {}), ...typo }, ...(before ? { brief: before } : {}) };
  });
  await saveConfig(c.env, fresh, cfg);
  // The words follow the style: the headline and caption are written for the picture the style
  // describes, with the post's own products. The idea (brief) and the scene stay the style's.
  for (const a of d.assign) {
    const s = scenes.get(a.index);
    if (!s?.style || !s.scene) continue;
    try {
      const latest = await ownedPlan(c.env, user, d.batch);
      const latestCfg = JSON.parse(latest.config) as Config;
      const post = (latestCfg.plan ?? []).find((p) => p.index === a.index);
      // A campaign post's words are the designer's brief: they are never written again for a style.
      if (!post || post.group) continue;
      const names = [post.product, ...(post.products ?? [])].filter(Boolean);
      await rewritePostIdea(
        c.env,
        latest,
        latestCfg,
        a.index,
        `The picture of this post is now this style: ${s.scene.slice(0, 700)}${names.length ? ` It shows ${names.join(" and ")}.` : ""} Write the title, headline, second line and caption for THIS picture and what it shows; keep the product names exact.`,
        { wordsOnly: true },
      );
    } catch (e) {
      console.error("[style] words", a.index, errorMessage(e));
    }
  }
  const done = await ownedPlan(c.env, user, d.batch);
  return c.json({ ok: true, plan: (JSON.parse(done.config) as Config).plan });
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

/**
 * The conversation on the Ideas and dates screen: the designer says what to change in their own
 * words; the art director reads the month, changes exactly that (ideas, words, dates, products,
 * posts added or removed), keeps the thread on the month and answers in the designer's language.
 */
postRoutes.post("/chat", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1), message: z.string().trim().min(1).max(3000) }));
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  const client = await clientRow(c.env, config.client);
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const names = sources.map(productName);
  const drive = (await clientDrivePhotos(c.env, config.client ?? "").catch(() => [] as Awaited<ReturnType<typeof clientDrivePhotos>>))
    .filter((x) => !x.video && (!x.kind || PRODUCT_KINDS.has(x.kind)))
    .sort((x, y) => productRank(x.kind) - productRank(y.kind) || y.modified.localeCompare(x.modified));
  const driveOptions = drive.filter((p, i) => !matchProduct(p.name, names) && drive.findIndex((q) => q.name === p.name) === i);
  const products = [...sources.map((s) => ({ name: productName(s), note: s.note?.trim() || "" })), ...driveOptions.map((p) => ({ name: p.name, note: p.note?.trim() || "" }))];
  const month = config.month ?? "";
  const occasions = pickedOccasions(month, config.occasions).map((o) => ({ id: o.id, name: o.name, date: o.date }));
  const history = (config.chat ?? []).slice(-12);
  const raw = await askText(
    c.env,
    ideasChatInstruction({ client: client.name, month, posts: plan, products, notes: config.notes, history, message: d.message, occasions }),
    IDEAS_CHAT_SCHEMA,
  );
  const answer = parseIdeasChat(parseJson<unknown>(raw), plan, products.map((p) => p.name), month);
  console.log(`[chat] ${b.id} actions ${JSON.stringify(answer.actions).slice(0, 900)} raw ${raw.slice(0, 600)}`);
  if (!answer.reply && !answer.actions.length) throw new StudioError("The art director gave no usable answer. Say it once more.", 502);
  // Drive products the changes name join the month.
  const imported = new Map<string, string>();
  const taken = new Set(sources.map((s) => s.stem));
  const wanted = answer.actions.flatMap((a) => (a.op === "update" ? [a.fields.product] : a.op === "add" ? [a.post.product] : [])).filter((n): n is string => !!n && !matchProduct(n, names));
  for (const n of [...new Set(wanted)]) {
    const photo = driveOptions.find((p) => p.name === n);
    if (!photo) continue;
    try {
      const row = await importDrivePhoto(c.env, user.id, b.id, photo.id, photo.name, taken);
      if (photo.note || photo.kind) await run(c.env.DB, "UPDATE sources SET note = ?, category = ? WHERE id = ?", photo.note ?? null, photo.kind ?? null, row.id);
      imported.set(n, productName(row as unknown as SourceRow));
    } catch (e) {
      console.error("[chat] drive import", photo.name, errorMessage(e));
    }
  }
  const realName = (n?: string) => (n ? (imported.get(n) ?? matchProduct(n, names) ?? n) : undefined);
  // Removals first (by the original numbers, highest first so the others keep their numbers), then the rest.
  const removed = answer.actions.filter((a): a is ChatRemove => a.op === "remove").map((a) => a.index).sort((x, y) => y - x);
  for (const index of removed) await removePostAt(c.env, user, b.id, index).catch((e) => console.error("[chat] remove", errorMessage(e)));
  const shift = (index: number) => index - removed.filter((r) => r < index).length;
  const fresh = await ownedPlan(c.env, user, b.id);
  const cfg = JSON.parse(fresh.config) as Config;
  const t = now();
  const changed = new Set<number>();
  const captions: { index: number; caption: string; hashtags: string }[] = [];
  cfg.plan = cfg.plan ?? [];
  for (const a of answer.actions) {
    if (a.op === "update") {
      const index = shift(a.index);
      const p = cfg.plan.find((x) => x.index === index);
      if (!p || removed.includes(a.index)) continue;
      const f = a.fields;
      const next: Post = { ...p, ...(f.title ? { title: f.title } : {}), ...(f.headline ? { headline: f.headline } : {}), ...(f.subline ? { subline: f.subline } : {}), ...(f.date ? { date: f.date } : {}), ...(f.type ? { type: f.type } : {}) };
      if (f.brief || f.scene) {
        if (f.brief) next.brief = f.brief;
        if (f.scene) next.scene = f.scene;
        next.ideaAt = t;
      }
      const product = realName(f.product);
      if (product && next.type !== "offer") next.product = product;
      if (f.caption || f.hashtags) {
        if (f.caption) next.caption = f.caption;
        if (f.hashtags) next.hashtags = f.hashtags;
        next.captionHand = true;
        captions.push({ index, caption: next.caption, hashtags: next.hashtags });
      }
      cfg.plan = cfg.plan.map((x) => (x.index === index ? next : x));
      changed.add(index);
    } else if (a.op === "add") {
      const index = cfg.plan.reduce((m, x) => Math.max(m, x.index), 0) + 1;
      const last = cfg.plan.map((x) => x.date ?? "").filter(Boolean).sort().pop();
      const product = realName(a.post.product);
      cfg.plan.push({
        index,
        type: a.post.type ?? "lifestyle",
        title: a.post.title,
        brief: a.post.brief,
        scene: a.post.scene,
        headline: a.post.headline,
        subline: a.post.subline,
        caption: a.post.caption,
        hashtags: a.post.hashtags,
        date: a.post.date ?? last ?? undefined,
        product: product && (a.post.type ?? "lifestyle") !== "offer" ? product : undefined,
        ideaAt: t,
        captionHand: !!a.post.caption,
      });
      changed.add(index);
    }
  }
  for (const x of captions) await run(c.env.DB, "UPDATE tasks SET caption = ? WHERE batch = ? AND post = ?", JSON.stringify({ text: x.caption, hashtags: x.hashtags }), b.id, x.index);
  // New standing rules only when the designer gave some (an echo of the month's notes is not a change).
  const notesChanged = answer.notes !== undefined && answer.notes.trim() !== (cfg.notes ?? "").trim();
  if (notesChanged) cfg.notes = answer.notes;
  if (cfg.plan.length) cfg.postCount = cfg.plan.length;
  const make = [...new Set(answer.actions.filter((a): a is ChatMake => a.op === "make").flatMap((a) => a.indexes.map(shift)))].filter((i) => cfg.plan!.some((p) => p.index === i));
  cfg.chat = [...(cfg.chat ?? []), { role: "user" as const, text: d.message.slice(0, 3000), at: t }, { role: "studio" as const, text: answer.reply || "Done.", at: t + 1 }].slice(-40);
  await refreshCountNote(c.env, b.id, cfg);
  await saveConfig(c.env, fresh, cfg);
  return c.json({ ok: true, reply: answer.reply || "Done.", changed: [...changed], removed: removed.length, make, notes: notesChanged ? answer.notes : undefined, plan: cfg.plan });
});

/** The thread is cleared; the posts stay as they are. */
postRoutes.delete("/chat", async (c) => {
  const batchId = c.req.query("batch") ?? "";
  const b = await ownedPlan(c.env, c.get("user"), batchId);
  const cfg = JSON.parse(b.config) as Config;
  delete cfg.chat;
  await saveConfig(c.env, b, cfg);
  return c.json({ ok: true });
});

/**
 * "Do client comments": every change the client asked for on the approval page is read by the art
 * director and written into its post (another product from the month or the client's Drive, a new
 * brief and scene, the caption), the request is cleared, and the posts are returned to be made again.
 */
postRoutes.post("/client-changes", async (c) => {
  const d = await body(c, z.object({ batch: z.string().min(1) }));
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, d.batch);
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  const asks: ClientAsk[] = Object.entries(config.approvals ?? {})
    .filter(([, a]) => a.status === "changes" && a.note?.trim())
    .map(([k, a]) => ({ index: Number(k), note: a.note!.trim(), post: plan.find((p) => p.index === Number(k)) }))
    .filter((x): x is { index: number; note: string; post: Post } => !!x.post)
    .map(({ index, note, post }) => ({
      index,
      note,
      title: post.title,
      brief: post.brief,
      scene: post.scene,
      product: post.type === "offer" ? post.offer?.products[0] : post.product,
      headline: post.headline,
      caption: post.caption,
      hashtags: post.hashtags,
    }));
  if (!asks.length) throw new StudioError("The client has not asked for a change yet.");
  const client = await clientRow(c.env, config.client);
  const sources = await all<SourceRow>(
    c.env.DB,
    "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name",
    b.id,
  );
  await describeProducts(c.env, sources);
  const names = sources.map(productName);
  // The client's Drive: the cleanest photo of each product the month does not have yet.
  const drive = (await clientDrivePhotos(c.env, config.client ?? "").catch(() => [] as Awaited<ReturnType<typeof clientDrivePhotos>>))
    .filter((x) => !x.video && (!x.kind || PRODUCT_KINDS.has(x.kind)))
    .sort((x, y) => productRank(x.kind) - productRank(y.kind) || y.modified.localeCompare(x.modified));
  const driveOptions = drive.filter((p, i) => !matchProduct(p.name, names) && drive.findIndex((q) => q.name === p.name) === i);
  const products = [...sources.map((s) => ({ name: productName(s), note: s.note?.trim() || "" })), ...driveOptions.map((p) => ({ name: p.name, note: p.note?.trim() || "" }))];
  const raw = await askText(c.env, clientChangesInstruction({ client: client.name, asks, products }), CLIENT_CHANGES_SCHEMA);
  const changes = parseClientChanges(parseJson<unknown>(raw), asks, products.map((p) => p.name));
  if (!changes.length) throw new StudioError("The art director gave no usable answer. Try again.", 502);
  // Drive products the changes name join the month.
  const imported = new Map<string, string>();
  const taken = new Set(sources.map((s) => s.stem));
  for (const ch of changes) {
    if (!ch.product || matchProduct(ch.product, names) || imported.has(ch.product)) continue;
    const photo = driveOptions.find((p) => p.name === ch.product);
    if (!photo) continue;
    try {
      const row = await importDrivePhoto(c.env, user.id, b.id, photo.id, photo.name, taken);
      if (photo.note || photo.kind) await run(c.env.DB, "UPDATE sources SET note = ?, category = ? WHERE id = ?", photo.note ?? null, photo.kind ?? null, row.id);
      imported.set(ch.product, productName(row as unknown as SourceRow));
    } catch (e) {
      console.error("[client-changes] drive import", photo.name, errorMessage(e));
    }
  }
  const fresh = await ownedPlan(c.env, user, b.id);
  const cfg = JSON.parse(fresh.config) as Config;
  const t = now();
  const done: { index: number; summary: string }[] = [];
  cfg.plan = (cfg.plan ?? []).map((p) => {
    const ch = changes.find((x) => x.index === p.index);
    const ask = asks.find((x) => x.index === p.index);
    if (!ch || !ask) return p;
    const product = ch.product ? (imported.get(ch.product) ?? matchProduct(ch.product, names) ?? ch.product) : undefined;
    done.push({ index: p.index, summary: ch.summary });
    return {
      ...p,
      ...(product && p.type !== "offer" ? { product } : {}),
      brief: ch.brief,
      ...(ch.scene ? { scene: ch.scene } : {}),
      headline: ch.headline || p.headline,
      caption: ch.caption,
      hashtags: ch.hashtags,
      captionHand: true,
      ideaAt: t,
      clientNote: { note: ask.note, at: t, summary: ch.summary || undefined },
    };
  });
  // The request is answered: the approval page shows the fresh post without the old note.
  if (cfg.approvals) for (const x of done) delete cfg.approvals[String(x.index)];
  await saveConfig(c.env, fresh, cfg);
  // What the request teaches about this client waits for the admin on the Lessons learned page.
  for (const ch of changes) if (ch.lesson) await rememberLesson(c.env, config.client ?? null, b.id, "client", ch.lesson, "client").catch((e) => console.error("[lessons]", e));
  return c.json({ ok: true, indexes: done.map((x) => x.index), changes: done });
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
