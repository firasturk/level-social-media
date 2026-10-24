/**
 * Direct to Studio (docs/direct-to-studio.md): the Start screen's "Edit images" and "Create or
 * edit video" skip Direction and Plan. The person picks files from the client's Drive and/or the
 * computer, and each file becomes one card of the month, ready in the Studio: its picture (or its
 * clip, with a still as the card's picture) is a copy in the month's storage. No brief, theme,
 * shot or product is asked for, and nothing is generated: every paid step stays a confirmed
 * action on the card or in the editors.
 *
 * Routes (mounted at /api/studio/media):
 *   POST /intake   multipart {kind: images|video, batch? | client + month, items (JSON), file<n>,
 *                  poster<n>}: one card per new file, appended after the month's posts (never
 *                  over one). Pictures: every member (a free copy). Clips: admins (a video
 *                  upload, as POST /posts/video/upload). The same file picked again finds its
 *                  card instead of making a second one.
 *   POST /combine  multipart {batch, target: new|<post>, items (JSON [{post, still?}]), still<n>}:
 *                  chosen cards' clips (and pictures rendered as short clips in the browser) in
 *                  that order become one video project on a card, opened in the Video editor.
 *                  Admins, the editor's switch, a ledger line `editor.save` (no spend).
 *   GET  /clip     ?client=: the newest finished clip of the client the viewer may open (the
 *                  Start card's moving picture), or null.
 *
 * Drive is only read: the copy is made with the read-only scope (see `driveFileCopy`).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { ownedPlan, plainBackground, saveConfig, type BatchRow } from "./posts";
import { requireActiveClient } from "./clients";
import { resolveEngineModel } from "./settings";
import { driveFileCopy, driveFileInfo, isClientDriveFile, isDemoDrive, photoBytes, type DriveFileInfo } from "./drive";
import { readMp4 } from "./mp4";
import { autoSelectForClient, MAX_VIDEO_FILE } from "./video";
import { assertIntegrationEnabled, recordIntegrationOp, requireIntegrationAdmin } from "./integrations";
import { postConfig, type Config } from "@shared/config";
import { isMediaPost, MAX_POST_COUNT, postRevision, type Post, type PostMedia } from "@shared/posts";
import { newClip, newProject, validateProject } from "@shared/video-project";
import type { User } from "@shared/types";

type Variables = { user: User };
export const mediaRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The largest picture copied (the Photo studio's own upload limit). */
export const MEDIA_IMAGE_MAX = 20 * 1024 * 1024;
/** The largest clip copied (the video upload's limit). */
export const MEDIA_VIDEO_MAX = MAX_VIDEO_FILE;
/** Files sent from the computer in one request, all together (the browser splits a larger pick). */
export const MEDIA_REQUEST_MAX = 95 * 1024 * 1024;
/** Files in one request. */
export const MEDIA_ITEMS_MAX = 24;
/** Cards combined into one video at most. */
export const COMBINE_MAX = 12;

const IMAGE_TYPES = /^image\/(png|jpeg|webp)$/i;
const VIDEO_TYPES = /^video\/(mp4|quicktime)$/i;

const itemsSchema = z
  .array(
    z.union([
      z.object({ from: z.literal("drive"), id: z.string().min(1).max(200) }),
      z.object({ from: z.literal("upload"), field: z.string().regex(/^file\d{1,3}$/), poster: z.string().regex(/^poster\d{1,3}$/).optional() }),
    ]),
  )
  .min(1, "Pick at least one file.")
  .max(MEDIA_ITEMS_MAX, `At most ${MEDIA_ITEMS_MAX} files at a time.`);

/** The kind of picture the bytes are, read from their first bytes (the declared type is not trusted). */
export function sniffImage(bytes: ArrayBuffer): "image/png" | "image/jpeg" | "image/webp" | null {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

const extOf = (mime: string) => (/png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : "jpg");

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A card's title from the file's name: no extension, no camera-code underscores, 80 characters. */
export function titleOf(name: string): string {
  const t = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (t || "Untitled").slice(0, 80);
}

/** The month's source row the media cards' tasks point at (a task always points at a source). */
async function mediaSourceOf(env: Env, batchId: string, key: string): Promise<string> {
  const found = await first<{ id: string }>(env.DB, "SELECT id FROM sources WHERE batch = ? AND stem = 'media-intake'", batchId);
  if (found) return found.id;
  const id = uuid();
  await run(
    env.DB,
    "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created) VALUES (?, ?, 'media/intake', 'media-intake', ?, NULL, 'image/png', 0, 'supporting', 'reference', ?)",
    id,
    batchId,
    key,
    now(),
  );
  return id;
}

/**
 * Where the cards go: the month asked for by id, else the client's month (the newest one the
 * person may open), else a new month of that client, made the way POST /batch makes one.
 */
async function destination(env: Env, user: User, d: { batch?: string; client?: string; month?: string }, create: boolean): Promise<BatchRow | null> {
  if (d.batch) {
    const b = await ownedPlan(env, user, d.batch);
    const cfg = JSON.parse(b.config) as Config;
    if (d.client && cfg.client && cfg.client !== d.client) throw new StudioError("This month belongs to another client.", 409);
    if (d.month && cfg.month && cfg.month !== d.month) throw new StudioError("This month is not the month chosen.", 409);
    return b;
  }
  if (!d.client || !d.month) throw new StudioError("Choose the client and the month first.");
  if (!/^\d{4}-\d{2}$/.test(d.month)) throw new StudioError("Choose a month (YYYY-MM).");
  const client = await requireActiveClient(env, d.client);
  const found =
    user.role === "admin"
      ? await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE client = ? AND month = ? AND deleted IS NULL ORDER BY updated DESC LIMIT 1", client.id, d.month)
      : await first<BatchRow>(env.DB, "SELECT * FROM batches WHERE client = ? AND month = ? AND owner = ? AND deleted IS NULL ORDER BY updated DESC LIMIT 1", client.id, d.month, user.id);
  if (found && (JSON.parse(found.config) as Config).mode === "post") return found;
  if (!create) return null;
  const config = postConfig(client.id, d.month, { model: await resolveEngineModel(env), postCount: 1 });
  const id = uuid();
  const t = now();
  await run(
    env.DB,
    "INSERT INTO batches (id, owner, name, config, client, month, theme, state, created, updated) VALUES (?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?)",
    id,
    user.id,
    `${client.name} · ${d.month}`.slice(0, 100),
    JSON.stringify(config),
    client.id,
    d.month,
    t,
    t,
  );
  return ownedPlan(env, user, id);
}

interface Picked {
  kind: "image" | "video";
  from: "drive" | "upload";
  name: string;
  fp: string;
  drive?: DriveFileInfo;
  /** An upload's bytes (read once, for its fingerprint and its copy). */
  bytes?: ArrayBuffer;
  mime?: string;
  poster?: ArrayBuffer;
}

export interface IntakeResult {
  ok: true;
  batch: string;
  /** The new cards, in the order picked. */
  created: { index: number; kind: "image" | "video"; name: string; from: "drive" | "upload" }[];
  /** Files already on a card of this month: nothing new was made for them. */
  existing: { index: number; name: string }[];
}

/** One card per new file, appended to the month; the same file twice is one card. */
mediaRoutes.post("/intake", async (c) => {
  const user = c.get("user");
  const form = await c.req.formData().catch(() => {
    throw new StudioError("Send the files as a form: the kind, the month and the items.");
  });
  const kind = String(form.get("kind") ?? "");
  if (kind !== "images" && kind !== "video") throw new StudioError("Say what the files are for: images or video.");
  let items: z.infer<typeof itemsSchema>;
  try {
    const parsed = itemsSchema.safeParse(JSON.parse(String(form.get("items") ?? "[]")));
    if (!parsed.success) throw new StudioError(parsed.error.issues[0]?.message ?? "The list of files is not readable.");
    items = parsed.data;
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError("The list of files is not readable.");
  }
  const dest = { batch: String(form.get("batch") ?? "") || undefined, client: String(form.get("client") ?? "") || undefined, month: String(form.get("month") ?? "") || undefined };
  // The month is checked first (a member's own month, an admin's any month), without making one yet.
  const existingMonth = await destination(c.env, user, dest, false);

  // 1. What each file is, with every gate checked before anything is copied or written.
  const picked: Picked[] = [];
  let sent = 0;
  const clientId = existingMonth ? ((JSON.parse(existingMonth.config) as Config).client ?? "") : (dest.client ?? "");
  for (const it of items) {
    if (it.from === "drive") {
      // Only the client's own approved folders: a Drive id of another client's file is refused.
      if (!clientId || !(await isClientDriveFile(c.env, clientId, it.id))) throw new StudioError("That Drive file is not in this client's folders.", 403);
      const info = await driveFileInfo(c.env, it.id);
      const k = info.mimeType.startsWith("video/") ? "video" : info.mimeType.startsWith("image/") ? "image" : null;
      if (!k) throw new StudioError(`${info.name} is not a picture or a clip.`, 415);
      if (k === "video" && !VIDEO_TYPES.test(info.mimeType)) throw new StudioError(`${info.name}: only MP4 (H.264) clips can be added.`, 415);
      if (k === "video" && info.size > MEDIA_VIDEO_MAX) throw new StudioError(`${info.name} is too large (60 MB at most for a clip).`, 413);
      picked.push({ kind: k, from: "drive", name: info.name, fp: `drive:${info.id}:${info.md5 || info.version}`, drive: info });
    } else {
      const file = form.get(it.field);
      if (!(typeof file === "object" && file !== null && "arrayBuffer" in file)) throw new StudioError("A file from the computer did not arrive; pick it again.");
      const f = file as File;
      const k = VIDEO_TYPES.test(f.type) ? "video" : IMAGE_TYPES.test(f.type) ? "image" : null;
      if (!k) throw new StudioError(`${f.name}: pictures must be PNG, JPEG or WebP; clips MP4.`, 415);
      if (k === "image" && f.size > MEDIA_IMAGE_MAX) throw new StudioError(`${f.name} is too large (20 MB at most for a picture).`, 413);
      if (k === "video" && f.size > MEDIA_VIDEO_MAX) throw new StudioError(`${f.name} is too large (60 MB at most for a clip).`, 413);
      sent += f.size;
      if (sent > MEDIA_REQUEST_MAX) throw new StudioError("Too much at once: send the files in smaller groups.", 413);
      const bytes = await f.arrayBuffer();
      let mime = f.type.toLowerCase();
      if (k === "image") {
        const real = sniffImage(bytes);
        if (!real) throw new StudioError(`${f.name} is not a readable PNG, JPEG or WebP picture.`, 415);
        mime = real;
      }
      let poster: ArrayBuffer | undefined;
      if (k === "video" && it.poster) {
        const p = form.get(it.poster);
        if (typeof p === "object" && p !== null && "arrayBuffer" in p && (p as File).size <= 5 * 1024 * 1024) {
          const pb = await (p as File).arrayBuffer();
          if (sniffImage(pb)) poster = pb;
        }
      }
      picked.push({ kind: k, from: "upload", name: f.name, fp: `upload:${await sha256Hex(bytes)}`, bytes, mime, poster });
    }
  }
  if (kind === "images" && picked.some((p) => p.kind === "video"))
    throw new StudioError("Edit images takes pictures only. Choose Create or edit video for clips.", 415);

  // 2. The same file twice (in this pick, or already a card of the month) is one card.
  const seen = new Map<string, number>();
  for (const p of (existingMonth ? ((JSON.parse(existingMonth.config) as Config).plan ?? []) : [])) if (isMediaPost(p) && p.media?.fp) seen.set(p.media.fp, p.index);
  const existing: IntakeResult["existing"] = [];
  const fresh: Picked[] = [];
  const inPick = new Set<string>();
  for (const p of picked) {
    const at = seen.get(p.fp);
    if (at !== undefined) existing.push({ index: at, name: p.name });
    else if (!inPick.has(p.fp)) {
      inPick.add(p.fp);
      fresh.push(p);
    }
  }
  const planLength = existingMonth ? ((JSON.parse(existingMonth.config) as Config).plan ?? []).length : 0;
  if (planLength + fresh.length > MAX_POST_COUNT) throw new StudioError(`A month holds at most ${MAX_POST_COUNT} posts: this one has ${planLength}. Pick fewer files.`, 409);
  if (!fresh.length) return c.json({ ok: true, batch: existingMonth?.id ?? "", created: [], existing } satisfies IntakeResult);

  // 3. The month (made now when the client has none for that month), then the copies.
  const b = existingMonth ?? (await destination(c.env, user, dest, true))!;
  const format = (JSON.parse(b.config) as Config).format ?? "4:5";
  const demo = fresh.some((p) => p.from === "drive") ? await isDemoDrive(c.env) : false;
  const stored: { p: Picked; taskId: string; picture: string; video?: { id: string; key: string; info: ReturnType<typeof readMp4> } }[] = [];
  const written: string[] = [];
  try {
    for (const p of fresh) {
      const taskId = uuid();
      if (p.kind === "image") {
        const img = p.from === "drive" ? await driveFileCopy(c.env, p.drive!, MEDIA_IMAGE_MAX) : { bytes: p.bytes!, mime: p.mime! };
        const key = `${b.owner}/${b.id}/output/${taskId}/${uuid()}.${extOf(img.mime)}`;
        // A Drive copy keeps its Drive id: a camera original too large to shrink here is shrunk by Drive (server/thumbs.ts).
        await c.env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.mime }, ...(p.from === "drive" && !demo ? { customMetadata: { drive: p.drive!.id } } : {}) });
        written.push(key);
        stored.push({ p, taskId, picture: key });
      } else {
        const clip = p.from === "drive" ? await driveFileCopy(c.env, p.drive!, MEDIA_VIDEO_MAX) : { bytes: p.bytes!, mime: p.mime! };
        const info = readMp4(clip.bytes);
        if (!info.isMp4) throw new StudioError(`${p.name} is not an MP4 (no ftyp box at the start).`, 415);
        if (info.video !== "h264") throw new StudioError(`${p.name}: the clip must be H.264 in an MP4 for iPhone playback (found: ${info.codecs.join(", ") || "no video track"}).`, 415);
        const videoId = uuid();
        const key = `${b.owner}/${b.id}/video/${taskId}/${videoId}.mp4`;
        await c.env.BUCKET.put(key, clip.bytes, { httpMetadata: { contentType: "video/mp4" } });
        written.push(key);
        // The card's picture: the frame the browser read, Drive's own frame, else a dark still.
        let poster: { bytes: ArrayBuffer; mime: string } | null = p.poster ? { bytes: p.poster, mime: sniffImage(p.poster)! } : null;
        if (!poster && p.from === "drive" && !demo) poster = await photoBytes(c.env, p.drive!.id, 1600).catch(() => null);
        if (!poster || !/^image\/(png|jpeg|webp)$/.test(poster.mime)) poster = { bytes: await plainBackground("#202024", format), mime: "image/png" };
        const picture = `${b.owner}/${b.id}/output/${taskId}/${uuid()}.${extOf(poster.mime)}`;
        await c.env.BUCKET.put(picture, poster.bytes, { httpMetadata: { contentType: poster.mime } });
        written.push(picture);
        stored.push({ p, taskId, picture, video: { id: videoId, key, info } });
      }
    }
  } catch (e) {
    await c.env.BUCKET.delete(written).catch(() => undefined);
    throw e;
  }

  // 4. The cards: read the month again (another tab may have added a post meanwhile) and append.
  const fresh2 = await ownedPlan(c.env, user, b.id);
  const config = JSON.parse(fresh2.config) as Config;
  const plan = config.plan ?? [];
  const already = new Map(plan.filter((p) => isMediaPost(p) && p.media?.fp).map((p) => [p.media!.fp, p.index]));
  const t = now();
  let next = plan.reduce((m, p) => Math.max(m, p.index), 0);
  const added: { post: Post; s: (typeof stored)[number] }[] = [];
  for (const s of stored) {
    const at = already.get(s.p.fp);
    if (at !== undefined) {
      existing.push({ index: at, name: s.p.name });
      await c.env.BUCKET.delete([s.picture, ...(s.video ? [s.video.key] : [])]).catch(() => undefined);
      continue;
    }
    const media: PostMedia = {
      kind: s.p.kind,
      from: s.p.from,
      name: s.p.name.slice(0, 200),
      fp: s.p.fp,
      ...(s.p.drive ? { drive: { id: s.p.drive.id, version: s.p.drive.version, ...(s.p.drive.md5 ? { md5: s.p.drive.md5 } : {}) } } : {}),
      at: t,
    };
    const post: Post = { index: ++next, type: "lifestyle", title: titleOf(s.p.name), brief: "", caption: "", hashtags: "", ideaAt: t, source: "media", media };
    added.push({ post, s });
  }
  if (!added.length) return c.json({ ok: true, batch: b.id, created: [], existing } satisfies IntakeResult);
  const wasEmpty = !plan.length;
  config.plan = [...plan, ...added.map((a) => a.post)];
  config.postCount = wasEmpty ? config.plan.length : Math.max(config.postCount ?? plan.length, plan.length) + added.length;
  if (config.postCount > MAX_POST_COUNT) config.postCount = MAX_POST_COUNT;
  await saveConfig(c.env, fresh2, config);
  const source = await mediaSourceOf(c.env, b.id, added[0].s.picture);
  const statements: D1PreparedStatement[] = [];
  for (const { post, s } of added) {
    const made = postRevision(post, config);
    const brief = JSON.stringify({ post: true, index: post.index, type: post.type, media: s.p.kind });
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO tasks (id, batch, source, card, status, output, prompt, brief, post, caption, qa, making_for, made_for, updated) VALUES (?, ?, ?, ?, 'ready', ?, '', ?, ?, ?, NULL, ?, ?, ?)",
      ).bind(s.taskId, b.id, source, post.index, s.picture, brief, post.index, JSON.stringify({ text: "", hashtags: "" }), made, made, t),
      c.env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)").bind(
        uuid(),
        b.id,
        post.index,
        s.taskId,
        s.picture,
        `${s.p.from === "drive" ? "Copied from the client's Drive" : "Uploaded"}: ${s.p.name}`.slice(0, 500),
        made,
        t,
      ),
    );
    if (s.video) {
      const info = s.video.info;
      const warnings: string[] = [];
      if (info.audio && info.audio !== "aac") warnings.push("The sound is not AAC; iPhone may play it silently.");
      if (info.faststart === false) warnings.push("The moov index is at the end of the file; playback starts only after the whole file is fetched.");
      const settings = { duration: info.duration ? Math.round(info.duration) : undefined, faststart: info.faststart, codecs: info.codecs, width: info.width, height: info.height, warnings, note: `${s.p.from === "drive" ? "From the client's Drive" : "Uploaded"}: ${s.p.name}`.slice(0, 200), estimate: 0, estimateSource: "catalog" };
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, 'upload', ?, 'done', NULL, ?, NULL, ?, ?, 'upload', ?, ?, 'upload', 0, NULL)",
        ).bind(s.video.id, b.id, post.index, s.taskId, user.id, s.p.name.slice(0, 200), s.video.key, t, t, JSON.stringify(settings), s.picture),
      );
    }
  }
  await c.env.DB.batch(statements);
  for (const { post, s } of added) if (s.video) await autoSelectForClient(c.env, { id: s.video.id, batch: b.id, post: post.index, status: "done", key: s.video.key });
  return c.json({
    ok: true,
    batch: b.id,
    created: added.map(({ post, s }) => ({ index: post.index, kind: s.p.kind, name: s.p.name, from: s.p.from })),
    existing,
  } satisfies IntakeResult);
});

const combineItems = z
  .array(z.object({ post: z.number().int().min(1).max(MAX_POST_COUNT), still: z.string().regex(/^still\d{1,2}$/).optional() }))
  .min(2, "Choose at least two cards to combine.")
  .max(COMBINE_MAX, `At most ${COMBINE_MAX} cards in one video.`);

interface ClipRow {
  id: string;
  post: number;
  key: string;
  settings: string | null;
  for_client: number;
  created: number;
}

/**
 * The chosen cards, in the order given, as one video project on a card: each card's clip (the
 * client's version, else its newest finished clip) and each picture rendered as a short clip in
 * the browser become versions of the target card; the project lists exactly those, in order. The
 * Video editor then opens on the target card with that project. Nothing is generated or paid.
 */
mediaRoutes.post("/combine", async (c) => {
  const user = requireIntegrationAdmin(c, "editor");
  await assertIntegrationEnabled(c.env, "editor");
  const form = await c.req.formData().catch(() => {
    throw new StudioError("Send the cards as a form: the month, the target and the items.");
  });
  const b = await ownedPlan(c.env, user, String(form.get("batch") ?? ""));
  let items: z.infer<typeof combineItems>;
  try {
    const parsed = combineItems.safeParse(JSON.parse(String(form.get("items") ?? "[]")));
    if (!parsed.success) throw new StudioError(parsed.error.issues[0]?.message ?? "The list of cards is not readable.");
    items = parsed.data;
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError("The list of cards is not readable.");
  }
  const targetRaw = String(form.get("target") ?? "new");
  const config = JSON.parse(b.config) as Config;
  const plan = config.plan ?? [];
  const postOf = (i: number) => plan.find((p) => p.index === i);
  for (const it of items) if (!postOf(it.post)) throw new StudioError(`Post ${it.post} is not in the month.`, 404);
  const clips = await all<ClipRow>(c.env.DB, "SELECT id, post, key, settings, for_client, created FROM videos WHERE batch = ? AND status = 'done' AND key IS NOT NULL ORDER BY created DESC", b.id);
  const clipOf = (i: number) => clips.find((v) => v.post === i && v.for_client) ?? clips.find((v) => v.post === i) ?? null;
  // Each item: its clip, or the still the browser rendered from its picture. A card with neither cannot join.
  const parts: { post: number; clip: ClipRow | null; still: File | null }[] = [];
  for (const it of items) {
    const still = it.still ? form.get(it.still) : null;
    const file = typeof still === "object" && still !== null && "arrayBuffer" in still ? (still as File) : null;
    const clip = file ? null : clipOf(it.post);
    if (!file && !clip) throw new StudioError(`Post ${it.post} has no clip yet: it joins as its picture, rendered in the browser first.`, 409);
    if (file && file.size > MEDIA_VIDEO_MAX) throw new StudioError("A picture's clip is too large (60 MB at most).", 413);
    parts.push({ post: it.post, clip, still: file });
  }
  const name = (String(form.get("name") ?? "").trim() || `Combined video · posts ${items.map((i) => String(i.post).padStart(2, "0")).join(", ")}`).slice(0, 120);

  // The target card: a new card (its picture a copy of the first card's), or one of the month's.
  const t = now();
  let target: number;
  let created = false;
  let targetTask: { id: string; output: string } | null;
  if (targetRaw === "new") {
    if (plan.length + 1 > MAX_POST_COUNT) throw new StudioError(`A month holds at most ${MAX_POST_COUNT} posts.`, 409);
    const first0 = await first<{ id: string; output: string | null }>(c.env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, items[0].post);
    if (!first0?.output) throw new StudioError(`Post ${items[0].post} has no picture to start the new card from.`, 409);
    const obj = await c.env.BUCKET.get(first0.output);
    if (!obj) throw new StudioError(`Post ${items[0].post}'s picture is missing from storage.`, 404);
    const taskId = uuid();
    const mime = obj.httpMetadata?.contentType || "image/png";
    const picture = `${b.owner}/${b.id}/output/${taskId}/${uuid()}.${extOf(mime)}`;
    await c.env.BUCKET.put(picture, await obj.arrayBuffer(), { httpMetadata: { contentType: mime } });
    const fresh = await ownedPlan(c.env, user, b.id);
    const cfg = JSON.parse(fresh.config) as Config;
    const list = cfg.plan ?? [];
    target = list.reduce((m, p) => Math.max(m, p.index), 0) + 1;
    const post: Post = { index: target, type: "lifestyle", title: name.slice(0, 80), brief: "", caption: "", hashtags: "", ideaAt: t, source: "media", media: { kind: "video", from: "combine", name, fp: `combine:${uuid()}`, at: t } };
    cfg.plan = [...list, post];
    cfg.postCount = Math.min(MAX_POST_COUNT, Math.max(cfg.postCount ?? list.length, list.length) + 1);
    await saveConfig(c.env, fresh, cfg);
    const made = postRevision(post, cfg);
    const source = await mediaSourceOf(c.env, b.id, picture);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO tasks (id, batch, source, card, status, output, prompt, brief, post, caption, qa, making_for, made_for, updated) VALUES (?, ?, ?, ?, 'ready', ?, '', ?, ?, ?, NULL, ?, ?, ?)",
      ).bind(taskId, b.id, source, target, picture, JSON.stringify({ post: true, index: target, type: post.type, media: "video" }), target, JSON.stringify({ text: "", hashtags: "" }), made, made, t),
      c.env.DB.prepare("INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)").bind(uuid(), b.id, target, taskId, picture, `The first card's picture, for ${name}`.slice(0, 500), made, t),
    ]);
    targetTask = { id: taskId, output: picture };
    created = true;
  } else {
    target = Math.round(Number(targetRaw));
    if (!postOf(target)) throw new StudioError("Choose the card the video goes on.", 404);
    const row = await first<{ id: string; output: string | null }>(c.env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, target);
    if (!row?.output) throw new StudioError(`Post ${target} has no picture yet: choose another card or a new card.`, 409);
    targetTask = { id: row.id, output: row.output };
  }

  // Each part becomes a finished version of the target card (a clip already there is used as it is).
  const versions: { id: string; duration: number }[] = [];
  for (const part of parts) {
    if (part.clip && part.post === target) {
      const s = part.clip.settings ? (JSON.parse(part.clip.settings) as { duration?: number }) : {};
      const obj = s.duration ? null : await c.env.BUCKET.get(part.clip.key);
      const duration = s.duration ?? (obj ? (readMp4(await obj.arrayBuffer()).duration ?? 0) : 0);
      versions.push({ id: part.clip.id, duration });
      continue;
    }
    let bytes: ArrayBuffer;
    if (part.still) bytes = await part.still.arrayBuffer();
    else {
      const obj = await c.env.BUCKET.get(part.clip!.key);
      if (!obj) throw new StudioError(`Post ${part.post}'s clip is missing from storage.`, 404);
      bytes = await obj.arrayBuffer();
    }
    const info = readMp4(bytes);
    if (!info.isMp4 || info.video !== "h264") throw new StudioError(`Post ${part.post}: the clip must be H.264 in an MP4.`, 415);
    const id = uuid();
    const key = `${b.owner}/${b.id}/video/${targetTask.id}/${id}.mp4`;
    await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
    const note = part.still ? `Picture of post ${String(part.post).padStart(2, "0")}, as a clip` : `Clip of post ${String(part.post).padStart(2, "0")}`;
    const settings = { duration: info.duration ? Math.round(info.duration * 100) / 100 : undefined, faststart: info.faststart, codecs: info.codecs, width: info.width, height: info.height, warnings: [], note, estimate: 0, estimateSource: "catalog", combinedFrom: part.post };
    await run(
      c.env.DB,
      "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, 'upload', ?, 'done', NULL, ?, NULL, ?, ?, 'upload', ?, ?, 'upload', 0, NULL)",
      id,
      b.id,
      target,
      targetTask.id,
      user.id,
      note,
      key,
      now(),
      now(),
      JSON.stringify(settings),
      targetTask.output,
    );
    versions.push({ id, duration: info.duration ?? 0 });
  }
  if (versions.some((v) => !(v.duration > 0))) throw new StudioError("A clip's length could not be read.", 415);

  // The project: exactly those clips, in that order.
  const doc = newProject(name, t);
  doc.clips = versions.map((v) => newClip({ kind: "version", batch: b.id, videoId: v.id }, v.duration));
  const checked = validateProject({ ...doc, rev: 1 });
  if (!checked.ok) throw new StudioError(`The project cannot be saved: ${checked.reason}`);
  const projectId = uuid();
  await run(
    c.env.DB,
    "INSERT INTO video_projects (id, batch, post, name, project, rev, source_video, rendered_video, created, updated, created_by, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)",
    projectId,
    b.id,
    target,
    name,
    JSON.stringify(checked.project),
    versions[0].id,
    t,
    t,
    user.id,
    user.id,
  );
  await recordIntegrationOp(c.env, {
    provider: "editor",
    kind: "editor.save",
    user: user.id,
    batch: b.id,
    post: target,
    estimate: 0,
    status: "done",
    note: `Combined ${versions.length} cards (posts ${items.map((i) => i.post).join(", ")}) into "${name}" on post ${target}${created ? " (a new card)" : ""} · nothing generated`,
  });
  return c.json({ ok: true, target, created, project: projectId, clips: versions.map((v) => v.id) });
});

/** The newest finished clip of the client the viewer may open: the Start card's moving picture. */
mediaRoutes.get("/clip", async (c) => {
  const user = c.get("user");
  const client = c.req.query("client") ?? "";
  if (!client) return c.json({ ok: true, clip: null });
  const row =
    user.role === "admin"
      ? await first<{ id: string; batch: string; poster_key: string | null }>(c.env.DB, "SELECT v.id, v.batch, v.poster_key FROM videos v JOIN batches b ON b.id = v.batch WHERE b.client = ? AND b.deleted IS NULL AND v.status = 'done' AND v.key IS NOT NULL ORDER BY v.created DESC LIMIT 1", client)
      : await first<{ id: string; batch: string; poster_key: string | null }>(c.env.DB, "SELECT v.id, v.batch, v.poster_key FROM videos v JOIN batches b ON b.id = v.batch WHERE b.client = ? AND b.owner = ? AND b.deleted IS NULL AND v.status = 'done' AND v.key IS NOT NULL ORDER BY v.created DESC LIMIT 1", client, user.id);
  if (!row) return c.json({ ok: true, clip: null });
  const q = `batch=${encodeURIComponent(row.batch)}&id=${encodeURIComponent(row.id)}`;
  return c.json({ ok: true, clip: { batch: row.batch, id: row.id, url: `/api/studio/posts/video/file?${q}`, poster: row.poster_key ? `/api/studio/posts/video/poster?${q}` : null } });
});
