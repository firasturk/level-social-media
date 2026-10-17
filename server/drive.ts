/**
 * Google Drive: the studio's Google Cloud service account (the one Vertex runs on) reads the photos
 * of a client's Drive folder once the folder is shared with it as Viewer. The team browses them by
 * folder and the vision model picks the best product photos; the chosen ones join the month like an
 * upload. Drive gives resized renditions, so the huge camera files never pass through the Worker.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { first, now, run, uuid } from "./db";
import { askText, parseJson, profileOf } from "./posts";
import { resolveVertex } from "./settings";
import { vertexToken } from "./vertex";
import type { ImageBytes } from "./openai";
import type { User } from "@shared/types";
import { DRIVE_PICK_SCHEMA, driveFolderId, drivePickInstruction, freeName, parsePicks, photoName, spreadPhotos, type DrivePhoto } from "@shared/drive";
import { stemKey } from "@shared/naming";

type Variables = { user: User };
export const driveRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const API = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER = "application/vnd.google-apps.folder";
const ALL_DRIVES = "supportsAllDrives=true&includeItemsFromAllDrives=true";
/** A folder tree is read this deep and this wide at most. */
const MAX_FOLDERS = 120;
const MAX_PHOTOS = 2000;

async function auth(env: Env): Promise<{ token: string; email: string }> {
  const creds = await resolveVertex(env);
  if (!creds) throw new StudioError("Drive is read through the Google Cloud service account: connect Vertex in Connection first.", 428);
  return { token: await vertexToken(creds, fetch, SCOPE), email: creds.clientEmail };
}

async function drive<T>(env: Env, path: string): Promise<T> {
  const { token, email } = await auth(env);
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000) });
  if (r.ok) return (await r.json()) as T;
  const body = (await r.text()).slice(0, 300);
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(body))
    throw new StudioError("The Google Drive API is off in the Google Cloud project: enable it once, then try again.", 428);
  if (r.status === 404 || r.status === 403)
    throw new StudioError(`The studio can't open this folder. Share it in Drive with ${email} as Viewer, then try again.`, 403);
  throw new StudioError(`Google Drive answered ${r.status}: ${body}`, 502);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  thumbnailLink?: string;
  imageMediaMetadata?: { width?: number; height?: number };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

async function children(env: Env, folder: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let page = "";
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
    const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,size,imageMediaMetadata(width,height),shortcutDetails)");
    const d = await drive<{ files?: DriveFile[]; nextPageToken?: string }>(env, `?q=${q}&fields=${fields}&pageSize=1000&${ALL_DRIVES}${page ? `&pageToken=${page}` : ""}`);
    out.push(...(d.files ?? []));
    page = d.nextPageToken ?? "";
  } while (page && out.length < MAX_PHOTOS);
  return out;
}

const listed = new Map<string, { at: number; photos: DrivePhoto[] }>(); // per isolate

/** Every photo under the folder, its subfolders included, with the folder path it sits in. */
async function photosIn(env: Env, root: string, fresh = false): Promise<DrivePhoto[]> {
  const cached = listed.get(root);
  if (!fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.photos;
  const photos: DrivePhoto[] = [];
  const queue: { id: string; path: string[] }[] = [{ id: root, path: [] }];
  let folders = 0;
  while (queue.length && folders < MAX_FOLDERS && photos.length < MAX_PHOTOS) {
    const batch = queue.splice(0, 6);
    folders += batch.length;
    const lists = await Promise.all(batch.map((f) => children(env, f.id).then((files) => ({ f, files }))));
    for (const { f, files } of lists)
      for (const x of files) {
        const mime = x.shortcutDetails?.targetMimeType ?? x.mimeType;
        const id = x.shortcutDetails?.targetId ?? x.id;
        if (mime === FOLDER) queue.push({ id, path: [...f.path, x.name] });
        else if (/^image\/(jpe?g|png|webp|heic|heif|tiff)$/i.test(mime) && Number(x.size ?? 1e6) > 40_000)
          photos.push({
            id,
            file: x.name,
            name: photoName(x.name, f.path),
            folder: f.path.join(" / "),
            w: x.imageMediaMetadata?.width ?? 0,
            h: x.imageMediaMetadata?.height ?? 0,
            modified: x.modifiedTime ?? "",
          });
      }
  }
  listed.set(root, { at: Date.now(), photos });
  return photos;
}

/** A resized rendition of the photo (Drive's thumbnail service), or the file itself when it has none. */
async function photoBytes(env: Env, id: string, size: number): Promise<ImageBytes> {
  const meta = await drive<DriveFile>(env, `/${encodeURIComponent(id)}?fields=id,mimeType,size,thumbnailLink&${ALL_DRIVES}`);
  if (meta.thumbnailLink) {
    const url = meta.thumbnailLink.replace(/=s\d+(-[\w-]+)?$/, "") + `=s${size}`;
    for (const headers of [{}, { Authorization: `Bearer ${(await auth(env)).token}` }] as Record<string, string>[]) {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null);
      if (r?.ok && (r.headers.get("content-type") ?? "").startsWith("image/"))
        return { bytes: await r.arrayBuffer(), mime: r.headers.get("content-type")!.split(";")[0] };
    }
  }
  if (Number(meta.size ?? 0) > 25_000_000) throw new StudioError("Drive has no smaller copy of this photo yet; try again in a minute.", 502);
  const { token } = await auth(env);
  const r = await fetch(`${API}/${encodeURIComponent(id)}?alt=media&${ALL_DRIVES}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new StudioError(`Google Drive answered ${r.status} for the photo.`, 502);
  return { bytes: await r.arrayBuffer(), mime: meta.mimeType };
}

async function folderOf(env: Env, client: string): Promise<string> {
  const r = await first<{ drive: string }>(env.DB, "SELECT drive FROM client_profiles WHERE client = ?", client);
  return r?.drive ?? "";
}

/** The client's Drive photos, or none when it has no folder or the folder can't be read. */
export async function clientDrivePhotos(env: Env, client: string): Promise<DrivePhoto[]> {
  const id = driveFolderId(await folderOf(env, client));
  if (!id) return [];
  try {
    return await photosIn(env, id);
  } catch (e) {
    console.error("[drive] list", errorMessage(e));
    return [];
  }
}

/**
 * One Drive photo joins the month as a product photo under a name free in the month: a 2000px
 * rendition as the original and a small JPEG as the copy vision reads. Returns the new source.
 */
export async function importDrivePhoto(
  env: Env,
  userId: string,
  batchId: string,
  photoId: string,
  name: string,
  taken: Set<string>,
): Promise<{ id: string; name: string; stem: string; key: string; kind: string; role: string; reference_key: string | null; note: null }> {
  const [big, small] = await Promise.all([photoBytes(env, photoId, 2000), photoBytes(env, photoId, 768).catch(() => null)]);
  const ext = big.mime === "image/png" ? "png" : big.mime === "image/webp" ? "webp" : "jpg";
  const free = freeName(name, taken);
  const file = `${free}.${ext}`;
  const stem = stemKey(file);
  const id = uuid();
  const key = `${userId}/${batchId}/source/${id}`;
  await env.BUCKET.put(key, big.bytes, { httpMetadata: { contentType: big.mime } });
  let referenceKey: string | null = null;
  if (small?.mime === "image/jpeg") {
    referenceKey = `${key}.reference`;
    await env.BUCKET.put(referenceKey, small.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  }
  await run(
    env.DB,
    "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', 'product', ?)",
    id,
    batchId,
    file,
    stem,
    key,
    referenceKey,
    big.mime,
    big.bytes.byteLength,
    now(),
  );
  taken.add(stem);
  return { id, name: file, stem, key, kind: "product", role: "lead", reference_key: referenceKey, note: null };
}

/** The account to share folders with, and whether Drive can be read at all. */
driveRoutes.get("/", async (c) => {
  const creds = await resolveVertex(c.env);
  return c.json({ ok: true, email: creds?.clientEmail ?? null });
});

/** The client's folder: its link, its name and its photos. */
driveRoutes.get("/:client", async (c) => {
  const link = await folderOf(c.env, c.req.param("client"));
  const id = driveFolderId(link);
  const email = (await resolveVertex(c.env))?.clientEmail ?? null;
  if (!id) return c.json({ ok: true, link, email, folder: null, photos: [] });
  try {
    const folder = await drive<DriveFile>(c.env, `/${id}?fields=id,name&${ALL_DRIVES}`);
    const photos = await photosIn(c.env, id, c.req.query("fresh") === "1");
    return c.json({ ok: true, link, email, folder: folder.name, photos });
  } catch (e) {
    return c.json({ ok: true, link, email, folder: null, photos: [], error: errorMessage(e) });
  }
});

driveRoutes.put("/:client", async (c) => {
  const client = c.req.param("client");
  if (!(await first(c.env.DB, "SELECT 1 AS x FROM clients WHERE id = ?", client))) throw new StudioError("Client not found.", 404);
  const parsed = z.object({ link: z.string().trim().max(400) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Paste the folder's Drive link.");
  const link = parsed.data.link;
  const id = link ? driveFolderId(link) : "";
  if (link && !id) throw new StudioError("This is not a Drive folder link: open the folder in Drive and copy the address.");
  if (id) {
    const f = await drive<DriveFile>(c.env, `/${id}?fields=id,name,mimeType&${ALL_DRIVES}`);
    if (f.mimeType !== FOLDER) throw new StudioError("This link is a file: give the link of the folder the photos are in.");
  }
  await run(
    c.env.DB,
    "INSERT INTO client_profiles (client, drive, updated) VALUES (?, ?, ?) ON CONFLICT(client) DO UPDATE SET drive = excluded.drive, updated = excluded.updated",
    client,
    link,
    now(),
  );
  return c.json({ ok: true });
});

/** One photo, resized by Drive: small for the picker, large to join the month. */
driveRoutes.get("/photo/:id", async (c) => {
  const size = Math.min(2400, Math.max(160, Number(c.req.query("size") ?? 480) || 480));
  const img = await photoBytes(c.env, c.req.param("id"), size);
  return new Response(img.bytes, { headers: { "Content-Type": img.mime, "Cache-Control": "private, max-age=86400" } });
});

/** The vision model looks at the folder's photos and picks the best product photos for the month. */
driveRoutes.post("/:client/pick", async (c) => {
  const clientId = c.req.param("client");
  const client = await first<{ name: string }>(c.env.DB, "SELECT name FROM clients WHERE id = ?", clientId);
  if (!client) throw new StudioError("Client not found.", 404);
  const d = z
    .object({ count: z.number().int().min(1).max(20).default(6), folder: z.string().max(400).default(""), wanted: z.string().max(400).default("") })
    .parse(await c.req.json().catch(() => ({})));
  const id = driveFolderId(await folderOf(c.env, clientId));
  if (!id) throw new StudioError("Add the client's Drive folder first.");
  const all = (await photosIn(c.env, id)).filter((p) => !d.folder || p.folder === d.folder || p.folder.startsWith(`${d.folder} / `));
  if (!all.length) throw new StudioError("No photos in this folder.", 404);
  const candidates = spreadPhotos(all, 36);
  const images: (ImageBytes | null)[] = [];
  for (let i = 0; i < candidates.length; i += 8)
    images.push(...(await Promise.all(candidates.slice(i, i + 8).map((p) => photoBytes(c.env, p.id, 384).catch(() => null)))));
  const seen = candidates.filter((_, i) => images[i]);
  if (!seen.length) throw new StudioError("Drive gave no previews of these photos yet; try again in a minute.", 502);
  const raw = await askText(
    c.env,
    drivePickInstruction({ client: client.name, count: d.count, photos: seen, profile: await profileOf(c.env, clientId), wanted: d.wanted }),
    DRIVE_PICK_SCHEMA,
    images.filter((x): x is ImageBytes => !!x),
  );
  return c.json({ ok: true, picks: parsePicks(parseJson<unknown>(raw), seen, d.count), looked: seen.length, of: all.length });
});
