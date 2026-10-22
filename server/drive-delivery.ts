/**
 * Delivery into the client's Google Drive: a month's final posts (the artwork composed in the
 * browser, words and logo over the picture) are written by the studio's Google Cloud service
 * account into a month subfolder of the client's approved Outputs folder, with a captions.txt.
 *
 * This is the one place the service account writes to Drive (scope drive, not drive.readonly):
 * the client's folder has to be shared with it as Editor. A delivery is remembered per file in
 * `drive_deliveries`; delivering a post again updates the file it made instead of adding a copy.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { ownedPlan } from "./posts";
import { resolveVertex } from "./settings";
import { vertexToken } from "./vertex";
import type { User } from "@shared/types";
import type { Config } from "@shared/config";
import { monthLabel, type Post } from "@shared/posts";

type Variables = { user: User };
export const deliveryRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const WRITE_SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,webViewLink,md5Checksum";
/** How many posts one request carries (the browser sends the month in chunks of this size). */
export const MAX_POSTS_PER_REQUEST = 4;
/** One composed picture, as a base64 data URL (a 1080 px JPEG is well under this). */
const MAX_IMAGE_CHARS = 12_000_000;
/** Waits before the second and third try of a call Drive answered 5xx to. */
const RETRY_WAITS = [400, 1200];

export const NO_OUTPUTS_FOLDER =
  "Pick an Outputs folder in the Drive picker: add the client's delivery folder with the role Outputs and approve it.";
export const NO_CREDENTIAL =
  "Drive is written through the Google Cloud service account: connect Vertex in Connection first.";
export const shareAsEditor = (email: string) =>
  `Share the folder with ${email} as Editor (in Drive: Share, add the account, Editor), then try again.`;

const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** The name of the month's subfolder under the client's Outputs folder. */
export function deliveryFolderName(month: string): string {
  return `${monthLabel(month)} · Level Social Media`;
}

/** The file name of a post's picture in Drive: "03 Mango crossing.jpg". */
export function pictureName(post: { index: number; title: string }): string {
  const title = post.title
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  const n = String(post.index).padStart(2, "0");
  return `${n} ${title || `Post ${n}`}.jpg`;
}

/** The text of captions.txt: one block per post with its number, title, date, caption and hashtags. */
export function captionsText(
  heading: string,
  posts: Pick<Post, "index" | "title" | "date" | "caption" | "hashtags">[],
): string {
  const blocks = posts.map((p) => {
    const lines = [`${String(p.index).padStart(2, "0")} · ${p.title.trim() || "Untitled"}`];
    if (p.date) lines.push(`Date: ${p.date}`);
    lines.push("");
    lines.push(p.caption.trim() || "(no caption)");
    if (p.hashtags.trim()) lines.push("", p.hashtags.trim());
    return lines.join("\n");
  });
  return `${heading}\n${"=".repeat(heading.length)}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

/* ───────────── Drive calls ───────────── */

async function writeAuth(env: Env): Promise<{ token: string; email: string }> {
  const creds = await resolveVertex(env);
  if (!creds) throw new StudioError(NO_CREDENTIAL, 428);
  return { token: await vertexToken(creds, fetch, WRITE_SCOPE), email: creds.clientEmail };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One call to Drive, tried again after a 5xx or a dropped connection, a bounded number of times. */
async function driveCall(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  let last: { status: number; body: string } | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(60_000),
      });
      last = { status: r.status, body: await r.text() };
      if (r.status < 500) return last;
    } catch (e) {
      last = { status: 599, body: e instanceof Error ? e.message : String(e) };
    }
    if (attempt >= RETRY_WAITS.length) return last;
    await sleep(RETRY_WAITS[attempt]);
  }
}

/** What went wrong, in words the team can act on. */
function deliveryFailure(status: number, body: string, email: string, what: string): StudioError {
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(body))
    return new StudioError(
      "The Google Drive API is off in the Google Cloud project: enable it once, then try again.",
      428,
    );
  if (/storageQuotaExceeded|storage quota/i.test(body))
    return new StudioError(
      "The service account has no Drive storage of its own, so it can't own files in a My Drive folder. Put the Outputs folder in a shared drive (and add the account there as Content manager), then try again.",
      403,
    );
  if (status === 403 || status === 404)
    return new StudioError(
      `The studio can't ${what}: Drive refused (${status}). ${shareAsEditor(email)}`,
      403,
    );
  if (status === 599)
    return new StudioError(`Google Drive could not be reached: ${body.slice(0, 200)}`, 502);
  return new StudioError(
    `Google Drive answered ${status} while trying to ${what}: ${body.slice(0, 300)}`,
    502,
  );
}

interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
  md5Checksum?: string;
}

function parseFile(body: string): DriveFile {
  try {
    return JSON.parse(body) as DriveFile;
  } catch {
    throw new StudioError("Google Drive answered with something that is not a file.", 502);
  }
}

/** Builds a multipart/related body: the file's metadata, then its bytes. */
function multipart(meta: Record<string, unknown>, bytes: Uint8Array, mime: string) {
  const boundary = `level_${crypto.randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

function dataUrlBytes(url: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i.exec(url.trim());
  if (!m) throw new StudioError("Each picture must be a base64 image data URL (JPEG).");
  const bin = atob(m[2]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return {
    bytes: out,
    mime: m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase(),
  };
}

interface Writer {
  token: string;
  email: string;
}

/** The month's subfolder under the Outputs folder: found by name, else created. */
async function ensureSubfolder(
  w: Writer,
  parent: string,
  name: string,
): Promise<DriveFile & { created: boolean }> {
  const q = encodeURIComponent(
    `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`,
  );
  const found = await driveCall(
    w.token,
    `${API}?q=${q}&fields=${encodeURIComponent("files(id,name,webViewLink)")}&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  );
  if (found.status < 200 || found.status >= 300)
    throw deliveryFailure(found.status, found.body, w.email, "open the Outputs folder");
  const files = (JSON.parse(found.body) as { files?: DriveFile[] }).files ?? [];
  if (files.length) return { ...files[0], created: false };
  const made = await driveCall(w.token, `${API}?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
  if (made.status < 200 || made.status >= 300)
    throw deliveryFailure(made.status, made.body, w.email, "create the month's folder");
  return { ...parseFile(made.body), created: true };
}

/** A new file in the folder (metadata and bytes in one multipart upload). */
async function createFile(
  w: Writer,
  folder: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<DriveFile> {
  const { body, contentType } = multipart({ name, parents: [folder] }, bytes, mime);
  const r = await driveCall(
    w.token,
    `${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`,
    {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    },
  );
  if (r.status < 200 || r.status >= 300)
    throw deliveryFailure(r.status, r.body, w.email, `upload ${name}`);
  return parseFile(r.body);
}

/**
 * New bytes for a file delivered earlier (and its name when the title changed). Null when the file
 * is gone from Drive (deleted, or the folder was unshared): the caller creates it anew.
 */
async function updateFile(
  w: Writer,
  id: string,
  name: string,
  oldName: string,
  bytes: Uint8Array,
  mime: string,
): Promise<DriveFile | null> {
  const r = await driveCall(
    w.token,
    `${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true&fields=${FILE_FIELDS}`,
    {
      method: "PATCH",
      headers: { "Content-Type": mime },
      body: bytes,
    },
  );
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300)
    throw deliveryFailure(r.status, r.body, w.email, `update ${oldName}`);
  let file = parseFile(r.body);
  if (name !== oldName) {
    const renamed = await driveCall(
      w.token,
      `${API}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${FILE_FIELDS}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (renamed.status >= 200 && renamed.status < 300) file = parseFile(renamed.body);
  }
  return file;
}

/* ───────────── Rows ───────────── */

interface DeliveryRow {
  id: string;
  batch: string;
  client: string;
  folder: string;
  file_id: string;
  post: number | null;
  name: string;
  kind: string;
  md5: string;
  web_link: string;
  created: number;
  updated: number;
}

const SELECT =
  "SELECT id, batch, client, folder, file_id, post, name, kind, md5, web_link, created, updated FROM drive_deliveries";

async function rowsOf(env: Env, batch: string): Promise<DeliveryRow[]> {
  return all<DeliveryRow>(env.DB, `${SELECT} WHERE batch = ? ORDER BY kind DESC, post`, batch);
}

async function saveRow(
  env: Env,
  existing: DeliveryRow | undefined,
  data: {
    batch: string;
    client: string;
    folder: string;
    post: number | null;
    kind: string;
    file: DriveFile;
  },
): Promise<void> {
  const t = now();
  if (existing)
    await run(
      env.DB,
      "UPDATE drive_deliveries SET folder = ?, file_id = ?, name = ?, md5 = ?, web_link = ?, updated = ? WHERE id = ?",
      data.folder,
      data.file.id,
      data.file.name,
      data.file.md5Checksum ?? "",
      data.file.webViewLink ?? "",
      t,
      existing.id,
    );
  else
    await run(
      env.DB,
      "INSERT INTO drive_deliveries (id, batch, client, folder, file_id, post, name, kind, md5, web_link, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      uuid(),
      data.batch,
      data.client,
      data.folder,
      data.file.id,
      data.post,
      data.file.name,
      data.kind,
      data.file.md5Checksum ?? "",
      data.file.webViewLink ?? "",
      t,
      t,
    );
}

/** Creates the file, or updates the one an earlier delivery made (creating anew when Drive lost it). */
async function putFile(
  env: Env,
  w: Writer,
  ctx: { batch: string; client: string; folder: string },
  existing: DeliveryRow | undefined,
  post: number | null,
  kind: "picture" | "captions",
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ file: DriveFile; updated: boolean }> {
  let file: DriveFile | null = null;
  let updated = false;
  if (existing) {
    file = await updateFile(w, existing.file_id, name, existing.name, bytes, mime);
    updated = !!file;
  }
  if (!file) file = await createFile(w, ctx.folder, name, bytes, mime);
  await saveRow(env, existing, { ...ctx, post, kind, file });
  return { file, updated };
}

/* ───────────── Status ───────────── */

interface OutputsFolder {
  id: string;
  name: string;
  link: string;
}

/** The client's approved folder with the role Outputs; the product folder never stands in. */
export async function outputsFolder(env: Env, client: string): Promise<OutputsFolder | null> {
  const row = await first<{ id: string; name: string }>(
    env.DB,
    "SELECT id, name FROM drive_folders WHERE client = ? AND role = 'output' AND approved = 1 ORDER BY created LIMIT 1",
    client,
  );
  return row ? { id: row.id, name: row.name, link: folderLink(row.id) } : null;
}

export interface DeliveryStatus {
  ok: true;
  /** The service account the folder has to be shared with (null until Vertex is connected). */
  email: string | null;
  folder: OutputsFolder | null;
  writable: boolean;
  /** What is missing when the month cannot be delivered. */
  reason: string | null;
}

/** Whether the service account can add files to the folder, and why not when it cannot. */
async function checkWritable(
  env: Env,
  folder: OutputsFolder,
): Promise<Pick<DeliveryStatus, "email" | "writable" | "reason"> & { name?: string }> {
  const creds = await resolveVertex(env);
  if (!creds) return { email: null, writable: false, reason: NO_CREDENTIAL };
  const email = creds.clientEmail;
  let token: string;
  try {
    token = await vertexToken(creds, fetch, WRITE_SCOPE);
  } catch (e) {
    return { email, writable: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const r = await driveCall(
    token,
    `${API}/${encodeURIComponent(folder.id)}?fields=${encodeURIComponent("capabilities(canAddChildren),name")}&supportsAllDrives=true`,
  );
  if (r.status === 403 || r.status === 404) {
    if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(r.body))
      return {
        email,
        writable: false,
        reason: deliveryFailure(r.status, r.body, email, "").message,
      };
    return {
      email,
      writable: false,
      reason: `The studio can't open the Outputs folder. ${shareAsEditor(email)}`,
    };
  }
  if (r.status < 200 || r.status >= 300)
    return {
      email,
      writable: false,
      reason: deliveryFailure(r.status, r.body, email, "open the Outputs folder").message,
    };
  const meta = JSON.parse(r.body) as { name?: string; capabilities?: { canAddChildren?: boolean } };
  if (!meta.capabilities?.canAddChildren)
    return {
      email,
      name: meta.name,
      writable: false,
      reason: `The account can see the folder but not write to it. ${shareAsEditor(email)}`,
    };
  return { email, name: meta.name, writable: true, reason: null };
}

export async function deliveryStatus(env: Env, client: string): Promise<DeliveryStatus> {
  const folder = await outputsFolder(env, client);
  const email = (await resolveVertex(env))?.clientEmail ?? null;
  if (!folder) return { ok: true, email, folder: null, writable: false, reason: NO_OUTPUTS_FOLDER };
  const w = await checkWritable(env, folder);
  return {
    ok: true,
    email: w.email,
    folder: { ...folder, name: w.name || folder.name },
    writable: w.writable,
    reason: w.reason,
  };
}

/* ───────────── Routes ───────────── */

deliveryRoutes.get("/:client/status", async (c) =>
  c.json(await deliveryStatus(c.env, c.req.param("client"))),
);

const deliverSchema = z.object({
  batch: z.string().min(1),
  posts: z
    .array(
      z.object({ index: z.number().int().min(1), image: z.string().min(32).max(MAX_IMAGE_CHARS) }),
    )
    .max(MAX_POSTS_PER_REQUEST),
  captions: z.boolean().default(false),
});

export interface DeliveredFile {
  post: number | null;
  kind: "picture" | "captions";
  name: string;
  webViewLink: string;
  updated: boolean;
}

/**
 * Writes the posts' pictures (and captions.txt when asked) into the month's subfolder of the
 * client's Outputs folder. captions.txt covers every post of the plan delivered so far.
 */
deliveryRoutes.post("/:client/deliver", async (c) => {
  const client = c.req.param("client");
  const parsed = deliverSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new StudioError(
      `Send the month, up to ${MAX_POSTS_PER_REQUEST} composed pictures as data URLs, and whether to include captions.txt.`,
    );
  const { batch: batchId, posts, captions } = parsed.data;
  const batch = await ownedPlan(c.env, c.get("user"), batchId);
  if (batch.client !== client) throw new StudioError("This month belongs to another client.", 409);
  const config = JSON.parse(batch.config) as Config;
  const plan = config.plan ?? [];
  const month = batch.month ?? "";
  for (const p of posts)
    if (!plan.some((x) => x.index === p.index))
      throw new StudioError(`Post ${p.index} is not in this month's plan.`, 409);
  if (!posts.length && !captions) throw new StudioError("Nothing to deliver.");

  const folder = await outputsFolder(c.env, client);
  if (!folder) throw new StudioError(NO_OUTPUTS_FOLDER, 428);
  const w = await writeAuth(c.env);
  const sub = await ensureSubfolder(w, folder.id, deliveryFolderName(month));
  const ctx = { batch: batchId, client, folder: sub.id };
  const rows = await rowsOf(c.env, batchId);
  const files: DeliveredFile[] = [];

  for (const p of posts) {
    const post = plan.find((x) => x.index === p.index)!;
    const { bytes, mime } = dataUrlBytes(p.image);
    const existing = rows.find((r) => r.kind === "picture" && r.post === p.index);
    const { file, updated } = await putFile(
      c.env,
      w,
      ctx,
      existing,
      p.index,
      "picture",
      pictureName(post),
      bytes,
      mime,
    );
    files.push({
      post: p.index,
      kind: "picture",
      name: file.name,
      webViewLink: file.webViewLink ?? "",
      updated,
    });
  }

  if (captions) {
    const delivered = new Set(
      (await rowsOf(c.env, batchId))
        .filter((r) => r.kind === "picture" && r.post !== null)
        .map((r) => r.post!),
    );
    const covered = plan.filter((p) => delivered.has(p.index)).sort((a, b) => a.index - b.index);
    const clientName =
      (await first<{ name: string }>(c.env.DB, "SELECT name FROM clients WHERE id = ?", client))
        ?.name ?? "";
    const heading = [monthLabel(month), clientName].filter(Boolean).join(" · ");
    const text = new TextEncoder().encode(captionsText(heading, covered));
    const existing = rows.find((r) => r.kind === "captions");
    const { file, updated } = await putFile(
      c.env,
      w,
      ctx,
      existing,
      null,
      "captions",
      "captions.txt",
      text,
      "text/plain; charset=utf-8",
    );
    files.push({
      post: null,
      kind: "captions",
      name: file.name,
      webViewLink: file.webViewLink ?? "",
      updated,
    });
  }

  return c.json({
    ok: true,
    folder: {
      id: sub.id,
      name: sub.name,
      webViewLink: sub.webViewLink ?? folderLink(sub.id),
      created: sub.created,
    },
    files,
  });
});

/** What this month has delivered so far, with the links. */
deliveryRoutes.get("/:client/deliveries", async (c) => {
  const client = c.req.param("client");
  const batchId = c.req.query("batch") ?? "";
  const batch = await ownedPlan(c.env, c.get("user"), batchId);
  if (batch.client !== client) throw new StudioError("This month belongs to another client.", 409);
  const rows = await rowsOf(c.env, batchId);
  return c.json({
    ok: true,
    folder: rows.length ? { id: rows[0].folder, webViewLink: folderLink(rows[0].folder) } : null,
    files: rows.map((r) => ({
      post: r.post,
      kind: r.kind,
      name: r.name,
      webViewLink: r.web_link,
      fileId: r.file_id,
      updated: r.updated,
    })),
  });
});
