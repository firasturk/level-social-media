/**
 * Google Drive: the studio's Google Cloud service account (the one Vertex runs on) reads the photos
 * of a client's approved Drive folders once they are shared with it as Viewer. Each folder has a
 * role (product photos, brand assets, references, outputs); the team browses the photos by role and
 * folder, the vision model picks the best product photos, and the chosen ones join the month like an
 * upload. Drive gives resized renditions, so the huge camera files never pass through the Worker.
 *
 * What a month used is a snapshot: a photo imported as a product or pinned to a post is copied into
 * the bucket with the Drive file's id, version (modifiedTime) and checksum. A later change of the
 * file in Drive never reaches an older picture (see docs/drive.md).
 *
 * On a preview with no credential, the listing is the demo fixture (drive-mock.ts), flagged demo.
 */
import { Hono } from "hono";
import { z } from "zod";
import { previewNoImages, type Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { askText, ownedPlan, parseJson, plainBackground, profileOf, saveConfig } from "./posts";
import { resolveVertex } from "./settings";
import { vertexToken } from "./vertex";
import { DEMO_FOLDERS, driveMock } from "./drive-mock";
import type { ImageBytes } from "./openai";
import type { User } from "@shared/types";
import type { Config } from "@shared/config";
import type { PostReference } from "@shared/posts";
import {
  DRIVE_READ_SCHEMA,
  driveReadInstruction,
  groupByRole,
  isCameraName,
  isDriveRole,
  markDuplicates,
  parseDriveRead,
  type DriveFolder,
  type DriveKind,
  type DriveListing,
  type DriveRole,
} from "@shared/drive";
import {
  DRIVE_PICK_SCHEMA,
  DRIVE_READ_VERSION,
  driveFolderId,
  drivePickInstruction,
  freeName,
  isClientFolder,
  parsePicks,
  photoName,
  PLACE_KINDS,
  PRODUCT_KINDS,
  spreadPhotos,
  type DrivePhoto,
  type DriveSkipped,
} from "@shared/drive";
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

const REASON_GONE =
  "Not available in Drive: the file was deleted, moved out of the shared folders or unshared.";
const REASON_BIN = "Not available in Drive: the file is in the bin.";

/**
 * The demo Drive serves the picker only on a preview deployment with no Google Cloud credential.
 * With a credential, real or broken, Drive itself is asked: the fixture never stands in for it.
 */
export async function isDemoDrive(env: Env): Promise<boolean> {
  return previewNoImages(env) && !(await resolveVertex(env));
}

async function auth(env: Env): Promise<{ token: string; email: string }> {
  const creds = await resolveVertex(env);
  if (!creds)
    throw new StudioError(
      "Drive is read through the Google Cloud service account: connect Vertex in Connection first.",
      428,
    );
  return { token: await vertexToken(creds, fetch, SCOPE), email: creds.clientEmail };
}

/** One call to the Drive API, with the answer's status: the caller decides what a 404 means. */
async function driveRaw(
  env: Env,
  path: string,
): Promise<{ status: number; body: string; email: string }> {
  const { token, email } = await auth(env);
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25_000),
  });
  return { status: r.status, body: await r.text(), email };
}

function driveFailure(status: number, body: string, email: string): StudioError {
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(body))
    return new StudioError(
      "The Google Drive API is off in the Google Cloud project: enable it once, then try again.",
      428,
    );
  if (status === 404 || status === 403)
    return new StudioError(
      `The studio can't open this folder. Share it in Drive with ${email} as Viewer, then try again.`,
      403,
    );
  return new StudioError(`Google Drive answered ${status}: ${body.slice(0, 300)}`, 502);
}

async function drive<T>(env: Env, path: string): Promise<T> {
  const r = await driveRaw(env, path);
  if (r.status >= 200 && r.status < 300) return JSON.parse(r.body) as T;
  throw driveFailure(r.status, r.body, r.email);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  /** Drive's own version counter; the modifiedTime is the version the studio records. */
  version?: string;
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
  thumbnailLink?: string;
  imageMediaMetadata?: { width?: number; height?: number };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,version,md5Checksum,size,trashed,imageMediaMetadata(width,height),shortcutDetails";

/** The version of a file the studio records with what it used: its modifiedTime, else Drive's counter. */
const versionOf = (f: DriveFile): string => f.modifiedTime ?? f.version ?? "";

function mockFile(id: string): DriveFile | null {
  const f = driveMock.files.get(id);
  if (!f) return null;
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    md5Checksum: f.md5Checksum,
    size: String(f.size),
    trashed: f.trashed,
    imageMediaMetadata: { width: f.width, height: f.height },
  };
}

/** The files directly in a folder, those in the bin included (the listing marks them missing). */
async function children(env: Env, folder: string): Promise<DriveFile[]> {
  if (await isDemoDrive(env)) return driveMock.children(folder).map((f) => mockFile(f.id)!);
  const out: DriveFile[] = [];
  let page = "";
  do {
    const q = encodeURIComponent(`'${folder}' in parents`);
    const fields = encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`);
    const d = await drive<{ files?: DriveFile[]; nextPageToken?: string }>(
      env,
      `?q=${q}&fields=${fields}&pageSize=1000&${ALL_DRIVES}${page ? `&pageToken=${page}` : ""}`,
    );
    out.push(...(d.files ?? []));
    page = d.nextPageToken ?? "";
  } while (page && out.length < MAX_PHOTOS);
  return out;
}

/** One file as Drive gives it now, or why it is not available (deleted, in the bin, unshared). */
async function fileMeta(env: Env, id: string): Promise<{ file: DriveFile } | { missing: string }> {
  if (await isDemoDrive(env)) {
    const f = mockFile(id);
    if (!f) return { missing: REASON_GONE };
    return f.trashed ? { missing: REASON_BIN } : { file: f };
  }
  const r = await driveRaw(
    env,
    `/${encodeURIComponent(id)}?fields=${FILE_FIELDS},thumbnailLink&${ALL_DRIVES}`,
  );
  if (r.status === 404) return { missing: REASON_GONE };
  if (r.status === 403 && !/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(r.body))
    return {
      missing: "Not available in Drive: the studio can't open this file any more (unshared).",
    };
  if (r.status < 200 || r.status >= 300) throw driveFailure(r.status, r.body, r.email);
  const file = JSON.parse(r.body) as DriveFile;
  return file.trashed ? { missing: REASON_BIN } : { file };
}

/** A folder's name and type, demo or real. */
async function folderMeta(
  env: Env,
  id: string,
): Promise<{ id: string; name: string; mimeType: string }> {
  if (await isDemoDrive(env)) return { ...driveMock.folder(id), mimeType: FOLDER };
  return drive<DriveFile>(env, `/${encodeURIComponent(id)}?fields=id,name,mimeType&${ALL_DRIVES}`);
}

/** Drive no longer gives this photo: the listing says so until it comes back. */
async function markMissing(env: Env, id: string, reason: string): Promise<void> {
  await run(
    env.DB,
    "UPDATE drive_photos SET status = 'missing', reason = ?, updated = ? WHERE id = ?",
    reason,
    now(),
    id,
  );
}

interface FolderListing {
  at: number;
  photos: DrivePhoto[];
  /** Photos in the bin: known, not available. */
  trashed: DrivePhoto[];
  skipped: DriveSkipped[];
  /** False when the tree was cut at MAX_FOLDERS or MAX_PHOTOS: a photo not seen may still exist. */
  complete: boolean;
}

const listed = new Map<string, FolderListing>(); // per isolate

/** What a file the studio does not read is, in words. */
function skippedKind(mime: string, size: number): string {
  if (mime.startsWith("video/")) return "videos";
  if (/^image\//.test(mime))
    return /^image\/(jpe?g|png|webp|heic|heif|tiff)$/i.test(mime) && size <= 40_000
      ? "tiny images"
      : "RAW or other image files";
  if (mime === "application/pdf") return "PDFs";
  if (mime.startsWith("application/vnd.google-apps.shortcut")) return "shortcuts";
  return `${mime.replace(/^application\//, "")} files`;
}

/** Every photo under the folder, its subfolders included, with the folder path it sits in. */
async function photosIn(env: Env, root: string, fresh = false): Promise<FolderListing> {
  const cached = listed.get(root);
  if (!fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached;
  const photos: DrivePhoto[] = [];
  const trashed: DrivePhoto[] = [];
  const queue: { id: string; path: string[] }[] = [{ id: root, path: [] }];
  let folders = 0;
  const skipped = new Map<string, DriveSkipped>();
  while (queue.length && folders < MAX_FOLDERS && photos.length < MAX_PHOTOS) {
    const batch = queue.splice(0, 6);
    folders += batch.length;
    const lists = await Promise.all(
      batch.map((f) => children(env, f.id).then((files) => ({ f, files }))),
    );
    for (const { f, files } of lists)
      for (const x of files) {
        const mime = x.shortcutDetails?.targetMimeType ?? x.mimeType;
        const id = x.shortcutDetails?.targetId ?? x.id;
        if (mime === FOLDER) {
          if (!x.trashed) queue.push({ id, path: [...f.path, x.name] });
        } else if (
          (/^image\/(jpe?g|png|webp|heic|heif|tiff)$/i.test(mime) &&
            Number(x.size ?? 1e6) > 40_000) ||
          mime.startsWith("video/")
        ) {
          const photo: DrivePhoto = {
            // A video is read from its frame (Drive's thumbnail): a kitchen or factory clip becomes a place photo.
            ...(mime.startsWith("video/") ? { video: true } : {}),
            id,
            file: x.name,
            name: photoName(x.name, f.path),
            folder: f.path.join(" / "),
            w: x.imageMediaMetadata?.width ?? 0,
            h: x.imageMediaMetadata?.height ?? 0,
            modified: versionOf(x),
            md5: x.md5Checksum ?? "",
          };
          if (x.trashed) trashed.push({ ...photo, missing: true, reason: REASON_BIN });
          else photos.push(photo);
        } else if (!/xml|json/i.test(mime) && !x.trashed) {
          // Camera sidecar files (XML) are not worth a word.
          const folder = f.path[0] ?? "";
          const what = skippedKind(mime, Number(x.size ?? 0));
          const had = skipped.get(`${folder}|${what}`);
          if (had) had.n++;
          else skipped.set(`${folder}|${what}`, { folder, what, n: 1 });
        }
      }
  }
  const out: FolderListing = {
    at: Date.now(),
    photos,
    trashed,
    skipped: [...skipped.values()].sort((a, b) => b.n - a.n),
    complete: queue.length === 0 && photos.length < MAX_PHOTOS,
  };
  listed.set(root, out);
  return out;
}

/** A resized rendition of the photo (Drive's thumbnail service), or the file itself when it has none. */
export async function photoBytes(
  env: Env,
  id: string,
  size: number,
  known?: DriveFile,
): Promise<ImageBytes> {
  if (await isDemoDrive(env)) {
    const img = driveMock.bytes(id, size);
    if (!img) {
      await markMissing(env, id, REASON_GONE);
      throw new StudioError(REASON_GONE, 404);
    }
    return img;
  }
  let meta = known;
  if (!meta?.thumbnailLink) {
    const m = await fileMeta(env, id);
    if ("missing" in m) {
      await markMissing(env, id, m.missing);
      throw new StudioError(m.missing, 404);
    }
    meta = m.file;
  }
  if (meta.thumbnailLink) {
    const url = meta.thumbnailLink.replace(/=s\d+(-[\w-]+)?$/, "") + `=s${size}`;
    for (const headers of [{}, { Authorization: `Bearer ${(await auth(env)).token}` }] as Record<
      string,
      string
    >[]) {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) }).catch(
        () => null,
      );
      if (r?.ok && (r.headers.get("content-type") ?? "").startsWith("image/"))
        return { bytes: await r.arrayBuffer(), mime: r.headers.get("content-type")!.split(";")[0] };
    }
  }
  if (meta.mimeType.startsWith("video/"))
    throw new StudioError("Drive has no frame of this video yet; try again later.", 502);
  if (Number(meta.size ?? 0) > 25_000_000)
    throw new StudioError(
      "Drive has no smaller copy of this photo yet; try again in a minute.",
      502,
    );
  const { token } = await auth(env);
  const r = await fetch(`${API}/${encodeURIComponent(id)}?alt=media&${ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (r.status === 404) {
    await markMissing(env, id, REASON_GONE);
    throw new StudioError(REASON_GONE, 404);
  }
  if (!r.ok) throw new StudioError(`Google Drive answered ${r.status} for the photo.`, 502);
  return { bytes: await r.arrayBuffer(), mime: meta.mimeType };
}

async function folderOf(env: Env, client: string): Promise<string> {
  const r = await first<{ drive: string }>(
    env.DB,
    "SELECT drive FROM client_profiles WHERE client = ?",
    client,
  );
  return r?.drive ?? "";
}

const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

interface FolderRow {
  id: string;
  client: string;
  name: string;
  role: string;
  approved: number;
  added_by: string;
  created: number;
}

const folderOfRow = (r: FolderRow): DriveFolder => ({
  id: r.id,
  name: r.name,
  role: isDriveRole(r.role) ? r.role : "product",
  approved: r.approved === 1,
  link: folderLink(r.id),
  addedBy: r.added_by,
  created: r.created,
});

/** Every folder the team added for the client, approved or waiting. */
async function folderRows(env: Env, client: string): Promise<DriveFolder[]> {
  return (
    await all<FolderRow>(
      env.DB,
      "SELECT id, client, name, role, approved, added_by, created FROM drive_folders WHERE client = ? ORDER BY created",
      client,
    )
  ).map(folderOfRow);
}

/**
 * The folders the client's photos are read from: its approved folders; while none is approved, the
 * folder linked on its profile as the product folder; on the demo Drive with nothing set, the fixture.
 */
async function readFolders(env: Env, client: string): Promise<DriveFolder[]> {
  const approved = (await folderRows(env, client)).filter((f) => f.approved);
  if (approved.length) return approved;
  const link = await folderOf(env, client);
  const id = driveFolderId(link);
  if (id) return [{ id, name: "", role: "product", approved: true, link, default: true }];
  if (await isDemoDrive(env))
    return DEMO_FOLDERS.map((f) => ({
      id: f.id,
      name: f.name,
      role: f.role,
      approved: true,
      link: folderLink(f.id),
      demo: true,
      default: true,
    }));
  return [];
}

interface ClientListing {
  folders: DriveFolder[];
  photos: DrivePhoto[];
  missing: DrivePhoto[];
  skipped: DriveSkipped[];
}

/**
 * The client's photos across its folders, each with its folder's role, with what vision read in them:
 * a camera-named photo ("DSC01838") takes the name vision gave it. New photos are queued for the cron
 * to read; a photo whose checksum changed is read again; copies point at their first; a photo Drive
 * no longer gives is marked missing and listed apart with the reason.
 */
async function listClient(env: Env, client: string, fresh = false): Promise<ClientListing> {
  const folders = await readFolders(env, client);
  const photos: DrivePhoto[] = [];
  const trashed: DrivePhoto[] = [];
  const skipped: DriveSkipped[] = [];
  let complete = folders.length > 0;
  for (const f of folders) {
    const r = await photosIn(env, f.id, fresh);
    photos.push(...r.photos.map((p) => ({ ...p, role: f.role, folderId: f.id })));
    trashed.push(...r.trashed.map((p) => ({ ...p, role: f.role, folderId: f.id })));
    skipped.push(...r.skipped);
    complete &&= r.complete;
  }
  const t = now();
  const upsert = env.DB.prepare(
    `INSERT INTO drive_photos (id, client, file, folder, role, md5, modified, status, reason, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET file = excluded.file, folder = excluded.folder, role = excluded.role, md5 = excluded.md5, modified = excluded.modified, updated = excluded.updated,
       status = CASE
         WHEN excluded.status = 'missing' THEN 'missing'
         WHEN drive_photos.status = 'missing' OR (drive_photos.md5 != '' AND excluded.md5 != '' AND drive_photos.md5 != excluded.md5) THEN 'new'
         ELSE drive_photos.status END,
       reason = excluded.reason`,
  );
  const rows = [
    ...photos.map((p) => ({ p, status: "new", reason: "" })),
    ...trashed.map((p) => ({ p, status: "missing", reason: p.reason ?? REASON_BIN })),
  ];
  for (let i = 0; i < rows.length; i += 50)
    await env.DB.batch(
      rows
        .slice(i, i + 50)
        .map(({ p, status, reason }) =>
          upsert.bind(
            p.id,
            client,
            p.file,
            p.folder,
            p.role ?? "product",
            p.md5 ?? "",
            p.modified,
            status,
            reason,
            t,
          ),
        ),
    );
  if (complete) {
    // A photo the studio knew that no folder lists any more is gone from Drive (or the folder was unshared).
    const seen = new Set(rows.map((r) => r.p.id));
    const gone = (
      await all<{ id: string }>(
        env.DB,
        "SELECT id FROM drive_photos WHERE client = ? AND status != 'missing'",
        client,
      )
    ).filter((r) => !seen.has(r.id));
    const mark = env.DB.prepare(
      "UPDATE drive_photos SET status = 'missing', reason = ?, updated = ? WHERE id = ?",
    );
    for (let i = 0; i < gone.length; i += 50)
      await env.DB.batch(gone.slice(i, i + 50).map((r) => mark.bind(REASON_GONE, t, r.id)));
  }
  await run(env.DB, "UPDATE client_profiles SET drive_listed = ? WHERE client = ?", t, client);
  const known = new Map(
    (
      await all<{
        id: string;
        file: string;
        folder: string;
        role: string;
        name: string;
        kind: string;
        note: string;
        status: string;
        reason: string;
        md5: string;
        modified: string;
      }>(
        env.DB,
        "SELECT id, file, folder, role, name, kind, note, status, reason, md5, modified FROM drive_photos WHERE client = ?",
        client,
      )
    ).map((r) => [r.id, r]),
  );
  const seenIds = new Set(photos.map((p) => p.id));
  const withRead = photos.map((p) => {
    const r = known.get(p.id);
    if (!r || r.status !== "read") return p;
    const own = photoName(p.file, []);
    return {
      ...p,
      name: isCameraName(own) ? r.name : p.name,
      kind: r.kind as DriveKind,
      note: r.note,
    };
  });
  const missing: DrivePhoto[] = [...known.values()]
    .filter((r) => r.status === "missing" && !seenIds.has(r.id))
    .map((r) => ({
      id: r.id,
      file: r.file,
      name: r.name || photoName(r.file, r.folder.split(" / ")),
      folder: r.folder,
      w: 0,
      h: 0,
      modified: r.modified,
      md5: r.md5,
      role: isDriveRole(r.role) ? r.role : "product",
      ...(r.kind ? { kind: r.kind as DriveKind, note: r.note } : {}),
      missing: true,
      reason: r.reason || REASON_GONE,
    }));
  return { folders, photos: markDuplicates(withRead), missing, skipped };
}

/** The client's Drive product photos, or none when it has no folder or the folder can't be read. */
/** True when the file is in one of the client's approved Drive folders (its listing, any role). */
export async function isClientDriveFile(env: Env, client: string, id: string): Promise<boolean> {
  const known = await first<{ client: string }>(
    env.DB,
    "SELECT client FROM drive_photos WHERE id = ? AND client = ? AND status != 'missing'",
    id,
    client,
  );
  if (known) return true;
  const listing = await listClient(env, client);
  return listing.photos.some((p) => p.id === id);
}

export async function clientDrivePhotos(env: Env, client: string): Promise<DrivePhoto[]> {
  try {
    return (await listClient(env, client)).photos.filter(
      (p) => (p.role ?? "product") === "product",
    );
  } catch (e) {
    console.error("[drive] list", errorMessage(e));
    return [];
  }
}

/**
 * The cron reads a few Drive photos each minute: lists one client's folders when it is due (every
 * six hours), then names the next photos waiting, twelve to a vision call.
 */
export async function readDrivePhotos(env: Env, calls = 3): Promise<number> {
  if (!(await resolveVertex(env))) return 0;
  const due = await first<{ client: string }>(
    env.DB,
    `SELECT c.client FROM (SELECT client FROM client_profiles WHERE drive != '' UNION SELECT client FROM drive_folders WHERE approved = 1) c
     LEFT JOIN client_profiles p ON p.client = c.client WHERE p.drive_listed IS NULL OR p.drive_listed < ? ORDER BY p.drive_listed LIMIT 1`,
    now() - 6 * 3600_000,
  );
  if (due)
    await listClient(env, due.client, true).catch((e) =>
      console.error("[drive] list", errorMessage(e)),
    );
  let done = 0;
  for (let call = 0; call < calls; call++) {
    // New photos first, then the ones an older reading named (they keep that reading meanwhile).
    const waiting = "(status = 'new' OR (status != 'missing' AND version < ?))";
    const head = await first<{ client: string }>(
      env.DB,
      `SELECT client FROM drive_photos WHERE ${waiting} ORDER BY status = 'new' DESC, updated LIMIT 1`,
      DRIVE_READ_VERSION,
    );
    if (!head) break;
    const rows = await all<{ id: string; file: string; folder: string }>(
      env.DB,
      `SELECT id, file, folder FROM drive_photos WHERE client = ? AND ${waiting} ORDER BY status = 'new' DESC, updated LIMIT 12`,
      head.client,
      DRIVE_READ_VERSION,
    );
    const client =
      (await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", head.client))
        ?.name ?? head.client;
    const images = await Promise.all(rows.map((r) => photoBytes(env, r.id, 384).catch(() => null)));
    const seen = rows.filter((_, i) => images[i]);
    const t = now();
    // A photo that went missing while its bytes were fetched keeps that status.
    const mark = env.DB.prepare(
      `UPDATE drive_photos SET status = ?, name = ?, kind = ?, note = ?, updated = ?, version = ${DRIVE_READ_VERSION} WHERE id = ? AND status != 'missing'`,
    );
    const results = new Map<string, { name: string; kind: DriveKind; note: string }>();
    if (seen.length)
      try {
        const raw = await askText(
          env,
          driveReadInstruction(client, seen),
          DRIVE_READ_SCHEMA,
          images.filter((x): x is ImageBytes => !!x),
        );
        for (const x of parseDriveRead(parseJson<unknown>(raw), seen.length))
          results.set(seen[x.image - 1].id, x);
      } catch (e) {
        console.error("[drive] read", errorMessage(e));
        break;
      }
    await env.DB.batch(
      rows.map((r) => {
        const x = results.get(r.id);
        return x
          ? mark.bind("read", x.name, x.kind, x.note, t, r.id)
          : mark.bind("failed", "", "", "", t, r.id);
      }),
    );
    done += results.size;
  }
  return done;
}

/** The client's own spaces in its Drive (the shop, the kitchen or factory), as vision read them. */
export async function clientPlacePhotos(env: Env, client: string): Promise<DrivePhoto[]> {
  return (await clientDrivePhotos(env, client)).filter((p) => p.kind && PLACE_KINDS.has(p.kind));
}

/** A Drive photo of the client's place, kept in the bucket once, for the engine to set a post in. */
export async function drivePlaceKey(env: Env, client: string, photoId: string): Promise<string> {
  const key = `drive-place/${client}/${photoId}`;
  if (await env.BUCKET.head(key)) return key;
  const img = await photoBytes(env, photoId, 1600);
  await env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
  return key;
}

/** The file as Drive gives it now; a file Drive no longer gives is marked missing and refused. */
async function liveFile(env: Env, photoId: string): Promise<DriveFile> {
  const m = await fileMeta(env, photoId);
  if ("missing" in m) {
    await markMissing(env, photoId, m.missing);
    throw new StudioError(m.missing, 404);
  }
  return m.file;
}

/** What the studio knows of a Drive file before copying it: its name, type, size and version. */
export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  version: string;
  md5?: string;
}

/** One Drive file as Drive gives it now (read only); a file Drive no longer gives is refused (404). */
export async function driveFileInfo(env: Env, id: string): Promise<DriveFileInfo> {
  const f = await liveFile(env, id);
  const mime = f.shortcutDetails?.targetMimeType ?? f.mimeType;
  return {
    id: f.shortcutDetails?.targetId ?? f.id,
    name: f.name,
    mimeType: mime,
    size: Number(f.size ?? 0),
    version: versionOf(f),
    ...(f.md5Checksum ? { md5: f.md5Checksum } : {}),
  };
}

/**
 * A copy of a Drive file's bytes for the studio's storage (Start → Edit images / Create or edit
 * video). Drive is only read (the scope is drive.readonly and every call is a GET): the original
 * stays as it is. A picture Drive can give as it is (JPEG, PNG or WebP within `max`) is copied
 * byte for byte; any other picture (HEIC, TIFF, a huge file) comes as Drive's large rendition. A
 * clip is copied as it is, up to `max`.
 */
export async function driveFileCopy(
  env: Env,
  info: DriveFileInfo,
  max: number,
): Promise<ImageBytes> {
  const video = info.mimeType.startsWith("video/");
  if (info.size > max && video)
    throw new StudioError(
      `${info.name} is too large to copy (${Math.round(max / 1024 / 1024)} MB at most).`,
      413,
    );
  if (await isDemoDrive(env)) {
    const f = driveMock.meta(info.id);
    if (!f) throw new StudioError(REASON_GONE, 404);
    if (f.media) return { bytes: f.media.slice().buffer as ArrayBuffer, mime: f.mimeType };
    if (video) throw new StudioError("The demo Drive has no clip bytes for this file.", 404);
    // The demo card is an SVG; the copy is a real picture (a PNG in the card's colour) so the
    // card's thumbnails and the editors read it like any other.
    return { bytes: await plainBackground(f.color, "4:5"), mime: "image/png" };
  }
  const asIs = video || (/^image\/(jpeg|png|webp)$/i.test(info.mimeType) && info.size <= max);
  if (!asIs) return photoBytes(env, info.id, 2560);
  const { token } = await auth(env);
  const r = await fetch(`${API}/${encodeURIComponent(info.id)}?alt=media&${ALL_DRIVES}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(90_000),
  });
  if (r.status === 404) {
    await markMissing(env, info.id, REASON_GONE);
    throw new StudioError(REASON_GONE, 404);
  }
  if (!r.ok) throw new StudioError(`Google Drive answered ${r.status} for ${info.name}.`, 502);
  const bytes = await r.arrayBuffer();
  if (bytes.byteLength > max)
    throw new StudioError(`${info.name} is too large to copy.`, 413);
  return { bytes, mime: info.mimeType };
}

/**
 * An audio file from Drive, read whole (the music library's import: docs/music-library.md). Only
 * a file shared with the service account is reachable; the answer carries the version the studio
 * records with the copy (modifiedTime) and Drive's checksum. The demo Drive has no audio.
 */
export async function driveAudioFile(
  env: Env,
  id: string,
  maxBytes: number,
): Promise<{ bytes: ArrayBuffer; name: string; mime: string; version: string; md5: string | null }> {
  if (await isDemoDrive(env))
    throw new StudioError("The demo Drive has no audio files. Connect Google Drive (Vertex) to import from Drive, or upload the track.", 409);
  const m = await fileMeta(env, id);
  if ("missing" in m) throw new StudioError(m.missing, 404);
  const file = m.file;
  const looksAudio = file.mimeType.startsWith("audio/") || /\.(mp3|m4a|aac|wav)$/i.test(file.name);
  if (!looksAudio) throw new StudioError(`"${file.name}" is not an audio file (Drive says ${file.mimeType}).`, 415);
  if (Number(file.size ?? 0) > maxBytes)
    throw new StudioError(`"${file.name}" is too large (${Math.round(maxBytes / 1024 / 1024)} MB at most).`, 413);
  const { token } = await auth(env);
  const r = await fetch(`${API}/${encodeURIComponent(id)}?alt=media&${ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (r.status === 404) throw new StudioError(REASON_GONE, 404);
  if (!r.ok) throw new StudioError(`Google Drive answered ${r.status} for the audio file.`, 502);
  const bytes = await r.arrayBuffer();
  if (bytes.byteLength > maxBytes)
    throw new StudioError(`"${file.name}" is too large (${Math.round(maxBytes / 1024 / 1024)} MB at most).`, 413);
  return { bytes, name: file.name, mime: file.mimeType, version: versionOf(file), md5: file.md5Checksum ?? null };
}

const extOf = (mime: string) =>
  mime === "image/png"
    ? "png"
    : mime === "image/webp"
      ? "webp"
      : mime === "image/svg+xml"
        ? "svg"
        : "jpg";

/**
 * One Drive photo joins the month as a product photo under a name free in the month: a 2000px
 * rendition as the original and a small JPEG as the copy vision reads. The source row records the
 * Drive file, its version and checksum at this moment. Returns the new source.
 */
export async function importDrivePhoto(
  env: Env,
  userId: string,
  batchId: string,
  photoId: string,
  name: string,
  taken: Set<string>,
): Promise<{
  id: string;
  name: string;
  stem: string;
  key: string;
  kind: string;
  role: string;
  reference_key: string | null;
  note: null;
}> {
  const file = await liveFile(env, photoId);
  const [big, small] = await Promise.all([
    photoBytes(env, photoId, 2000, file),
    photoBytes(env, photoId, 768, file).catch(() => null),
  ]);
  const free = freeName(name, taken);
  const fileName = `${free}.${extOf(big.mime)}`;
  const stem = stemKey(fileName);
  const id = uuid();
  const key = `${userId}/${batchId}/source/${id}`;
  await env.BUCKET.put(key, big.bytes, { httpMetadata: { contentType: big.mime } });
  let referenceKey: string | null = null;
  if (small?.mime === "image/jpeg") {
    referenceKey = `${key}.reference`;
    await env.BUCKET.put(referenceKey, small.bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }
  await run(
    env.DB,
    "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created, drive_id, drive_version, drive_md5) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', 'product', ?, ?, ?, ?)",
    id,
    batchId,
    fileName,
    stem,
    key,
    referenceKey,
    big.mime,
    big.bytes.byteLength,
    now(),
    file.id,
    versionOf(file),
    file.md5Checksum ?? null,
  );
  taken.add(stem);
  return {
    id,
    name: fileName,
    stem,
    key,
    kind: "product",
    role: "lead",
    reference_key: referenceKey,
    note: null,
  };
}

/**
 * A Drive photo pinned to one post as its reference: the bytes are copied into the bucket (a large
 * rendition and a thumbnail, like the designer's own upload on /reference) and the post records the
 * Drive file, its version and checksum. The copy is what the post uses from now on.
 */
export async function pinDrivePhoto(
  env: Env,
  user: User,
  client: string,
  batchId: string,
  postIndex: number,
  photoId: string,
  note = "",
): Promise<PostReference> {
  const b = await ownedPlan(env, user, batchId);
  const config = JSON.parse(b.config) as Config;
  if ((config.client ?? "") !== client)
    throw new StudioError("This month belongs to another client.", 409);
  const post = (config.plan ?? []).find((p) => p.index === postIndex);
  if (!post) throw new StudioError("That post is not in the month.", 404);
  const file = await liveFile(env, photoId);
  const big = await photoBytes(env, photoId, 2000, file);
  const small = await photoBytes(env, photoId, 360, file).catch(() => big);
  const id = uuid();
  const key = `${b.owner}/${b.id}/reference/${id}.${extOf(big.mime)}`;
  const thumb = `${b.owner}/${b.id}/reference/${id}-thumb.${extOf(small.mime)}`;
  await env.BUCKET.put(key, big.bytes, { httpMetadata: { contentType: big.mime } });
  await env.BUCKET.put(thumb, small.bytes, { httpMetadata: { contentType: small.mime } });
  const known = await first<{ name: string; status: string }>(
    env.DB,
    "SELECT name, status FROM drive_photos WHERE id = ?",
    photoId,
  );
  if (!known)
    await run(
      env.DB,
      "INSERT OR IGNORE INTO drive_photos (id, client, file, md5, modified, updated) VALUES (?, ?, ?, ?, ?, ?)",
      photoId,
      client,
      file.name,
      file.md5Checksum ?? "",
      versionOf(file),
      now(),
    );
  const reference: PostReference = {
    key,
    thumb,
    name: (known?.status === "read" && known.name) || photoName(file.name, []),
    note: note.trim().slice(0, 600) || undefined,
    at: now(),
    drive: {
      id: file.id,
      version: versionOf(file),
      ...(file.md5Checksum ? { md5: file.md5Checksum } : {}),
      name: file.name,
    },
  };
  const fresh = await ownedPlan(env, user, batchId);
  const cfg = JSON.parse(fresh.config) as Config;
  const old = (cfg.plan ?? []).find((p) => p.index === postIndex)?.reference;
  if (old?.key && old.key !== key)
    await env.BUCKET.delete([old.key, old.thumb].filter(Boolean)).catch(() => undefined);
  cfg.plan = (cfg.plan ?? []).map((p) => (p.index === postIndex ? { ...p, reference } : p));
  await saveConfig(env, fresh, cfg);
  return reference;
}

/** The account to share folders with, and whether Drive can be read at all. */
driveRoutes.get("/", async (c) => {
  const creds = await resolveVertex(c.env);
  return c.json({ ok: true, email: creds?.clientEmail ?? null, demo: await isDemoDrive(c.env) });
});

/** The client's folders, their roles and approval, and its photos by role. */
driveRoutes.get("/:client", async (c) => {
  const client = c.req.param("client");
  const link = await folderOf(c.env, client);
  const email = (await resolveVertex(c.env))?.clientEmail ?? null;
  const demo = await isDemoDrive(c.env);
  const empty: DriveListing = {
    link,
    email,
    folder: null,
    folders: await folderRows(c.env, client),
    photos: [],
    groups: groupByRole([]),
    missing: [],
    demo,
  };
  try {
    const read = await readFolders(c.env, client);
    if (!read.length) return c.json({ ok: true, ...empty });
    const listing = await listClient(c.env, client, c.req.query("fresh") === "1");
    const head = listing.folders.find((f) => f.role === "product") ?? listing.folders[0];
    const folderName =
      head.name ||
      (await folderMeta(c.env, head.id)
        .then((f) => f.name)
        .catch(() => head.id));
    // The folders as the team manages them (waiting ones too), the default one shown among them.
    const managed = await folderRows(c.env, client);
    const folders = [
      ...managed,
      ...listing.folders
        .filter((f) => !managed.some((m) => m.id === f.id))
        .map((f) => ({ ...f, name: f.name || folderName })),
    ];
    const out: DriveListing = {
      ...empty,
      folder: folderName,
      folders,
      photos: listing.photos,
      groups: groupByRole(listing.photos),
      missing: listing.missing,
      skipped: listing.skipped,
    };
    return c.json({ ok: true, ...out });
  } catch (e) {
    return c.json({ ok: true, ...empty, error: errorMessage(e) });
  }
});

/* ───────────── Approved folders ───────────── */

async function requireClient(env: Env, id: string): Promise<{ id: string; name: string }> {
  const client = await first<{ id: string; name: string }>(
    env.DB,
    "SELECT id, name FROM clients WHERE id = ?",
    id,
  );
  if (!client) throw new StudioError("Client not found.", 404);
  return client;
}

/** The client's folders, approved or waiting, with the default profile folder when it stands in. */
driveRoutes.get("/:client/folders", async (c) => {
  const client = c.req.param("client");
  const folders = await folderRows(c.env, client);
  const reading = folders.some((f) => f.approved)
    ? []
    : (await readFolders(c.env, client)).filter((f) => f.default);
  return c.json({
    ok: true,
    folders: [...folders, ...reading],
    email: (await resolveVertex(c.env))?.clientEmail ?? null,
    demo: await isDemoDrive(c.env),
  });
});

/** A folder added for the client with a role; it is read once approved. */
driveRoutes.post("/:client/folders", async (c) => {
  const client = await requireClient(c.env, c.req.param("client"));
  const parsed = z
    .object({
      link: z.string().trim().max(400).optional(),
      id: z.string().trim().max(120).optional(),
      role: z.string().default("product"),
      approved: z.boolean().default(false),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    throw new StudioError("Paste the folder's Drive link and say what it holds.");
  const id = parsed.data.id || (parsed.data.link ? driveFolderId(parsed.data.link) : null);
  if (!id)
    throw new StudioError(
      "This is not a Drive folder link: open the folder in Drive and copy the address.",
    );
  if (!isDriveRole(parsed.data.role))
    throw new StudioError("A folder holds product photos, brand assets, references or outputs.");
  const had = await first<FolderRow>(
    c.env.DB,
    "SELECT id, client, name, role, approved, added_by, created FROM drive_folders WHERE id = ?",
    id,
  );
  if (had && had.client !== client.id)
    throw new StudioError("This folder is already set up for another client.", 409);
  const meta = await folderMeta(c.env, id);
  if (meta.mimeType !== FOLDER)
    throw new StudioError("This link is a file: give the link of the folder the photos are in.");
  const t = now();
  await run(
    c.env.DB,
    `INSERT INTO drive_folders (id, client, name, role, approved, added_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, approved = excluded.approved, updated = excluded.updated`,
    id,
    client.id,
    meta.name,
    parsed.data.role,
    parsed.data.approved ? 1 : 0,
    c.get("user").id,
    had?.created ?? t,
    t,
  );
  listed.delete(id);
  const row = await first<FolderRow>(
    c.env.DB,
    "SELECT id, client, name, role, approved, added_by, created FROM drive_folders WHERE id = ?",
    id,
  );
  return c.json({ ok: true, folder: folderOfRow(row!) });
});

/** A folder's role or approval changed. */
driveRoutes.put("/:client/folders/:id", async (c) => {
  const client = c.req.param("client");
  const id = c.req.param("id");
  const parsed = z
    .object({ role: z.string().optional(), approved: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Say the folder's role or whether it is approved.");
  const had = await first<FolderRow>(
    c.env.DB,
    "SELECT id, client, name, role, approved, added_by, created FROM drive_folders WHERE id = ? AND client = ?",
    id,
    client,
  );
  if (!had) throw new StudioError("That folder is not set up for this client.", 404);
  if (parsed.data.role !== undefined && !isDriveRole(parsed.data.role))
    throw new StudioError("A folder holds product photos, brand assets, references or outputs.");
  const role = parsed.data.role ?? had.role;
  const approved = parsed.data.approved ?? had.approved === 1;
  await run(
    c.env.DB,
    "UPDATE drive_folders SET role = ?, approved = ?, updated = ? WHERE id = ?",
    role,
    approved ? 1 : 0,
    now(),
    id,
  );
  // The photos take the new role at the next listing (the folder is listed afresh).
  listed.delete(id);
  return c.json({ ok: true, folder: { ...folderOfRow(had), role: role as DriveRole, approved } });
});

/** A folder taken off the client: its photos are no longer listed (what months imported stays). */
driveRoutes.delete("/:client/folders/:id", async (c) => {
  const client = c.req.param("client");
  const id = c.req.param("id");
  const n = await run(
    c.env.DB,
    "DELETE FROM drive_folders WHERE id = ? AND client = ?",
    id,
    client,
  );
  if (!n) throw new StudioError("That folder is not set up for this client.", 404);
  listed.delete(id);
  return c.json({ ok: true });
});

/** The client's own folder directly inside a shared one ("Level shared" → "Habibah"), or null. */
async function clientSubfolder(
  env: Env,
  parent: string,
  client: string,
): Promise<{ id: string; name: string } | null> {
  const hit = (await children(env, parent)).find(
    (x) =>
      !x.trashed &&
      (x.shortcutDetails?.targetMimeType ?? x.mimeType) === FOLDER &&
      isClientFolder(x.name, client),
  );
  return hit ? { id: hit.shortcutDetails?.targetId ?? hit.id, name: hit.name } : null;
}

async function saveFolder(env: Env, client: string, link: string): Promise<void> {
  await run(
    env.DB,
    "INSERT INTO client_profiles (client, drive, updated) VALUES (?, ?, ?) ON CONFLICT(client) DO UPDATE SET drive = excluded.drive, updated = excluded.updated",
    client,
    link,
    now(),
  );
}

/**
 * The client's profile folder (the default product folder). A shared folder of every client
 * ("Level shared") is narrowed to the folder named after the client, so a client never reads
 * another client's photos.
 */
driveRoutes.put("/:client", async (c) => {
  const client = await requireClient(c.env, c.req.param("client"));
  const parsed = z
    .object({ link: z.string().trim().max(400) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Paste the folder's Drive link.");
  let link = parsed.data.link;
  const id = link ? driveFolderId(link) : "";
  if (link && !id)
    throw new StudioError(
      "This is not a Drive folder link: open the folder in Drive and copy the address.",
    );
  let folder = "";
  let narrowed = false;
  if (id) {
    const f = await folderMeta(c.env, id);
    if (f.mimeType !== FOLDER)
      throw new StudioError("This link is a file: give the link of the folder the photos are in.");
    folder = f.name;
    if (!isClientFolder(f.name, client.name)) {
      const sub = await clientSubfolder(c.env, id, client.name);
      if (sub) {
        link = folderLink(sub.id);
        folder = sub.name;
        narrowed = true;
      }
    }
  }
  await saveFolder(c.env, client.id, link);
  return c.json({ ok: true, folder, narrowed });
});

/** Every client gets its own folder from one shared folder of all the clients, by name. */
driveRoutes.post("/all", async (c) => {
  const parsed = z
    .object({ link: z.string().trim().min(1).max(400) })
    .safeParse(await c.req.json().catch(() => ({})));
  const id = parsed.success ? driveFolderId(parsed.data.link) : null;
  if (!id)
    throw new StudioError("Paste the Drive link of the folder that holds every client's folder.");
  const clients = await all<{ id: string; name: string; drive: string | null }>(
    c.env.DB,
    "SELECT c.id, c.name, p.drive FROM clients c LEFT JOIN client_profiles p ON p.client = c.id WHERE c.status = 'active' ORDER BY c.name",
  );
  const connected: { client: string; folder: string }[] = [];
  const missing: string[] = [];
  for (const cl of clients) {
    const sub = await clientSubfolder(c.env, id, cl.name);
    if (!sub) {
      if (!cl.drive) missing.push(cl.name);
      continue;
    }
    await saveFolder(c.env, cl.id, folderLink(sub.id));
    connected.push({ client: cl.name, folder: sub.name });
  }
  return c.json({ ok: true, connected, missing });
});

/** One photo, resized by Drive: small for the picker, large to join the month. */
driveRoutes.get("/photo/:id", async (c) => {
  const size = Math.min(2400, Math.max(160, Number(c.req.query("size") ?? 480) || 480));
  const img = await photoBytes(c.env, c.req.param("id"), size);
  return new Response(img.bytes, {
    headers: { "Content-Type": img.mime, "Cache-Control": "private, max-age=86400" },
  });
});

/** A Drive photo pinned to one post as its reference: copied into the bucket, its version recorded. */
driveRoutes.post("/:client/pin", async (c) => {
  const client = c.req.param("client");
  const parsed = z
    .object({
      batch: z.string().min(1),
      post: z.number().int(),
      photoId: z.string().min(1).max(120),
      note: z.string().max(600).optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    throw new StudioError("Say which post of which month the photo is pinned to.");
  const reference = await pinDrivePhoto(
    c.env,
    c.get("user"),
    client,
    parsed.data.batch,
    parsed.data.post,
    parsed.data.photoId,
    parsed.data.note ?? "",
  );
  return c.json({ ok: true, reference });
});

/** The vision model looks at the product folders' photos and picks the best product photos for the month. */
driveRoutes.post("/:client/pick", async (c) => {
  const clientId = c.req.param("client");
  const client = await requireClient(c.env, clientId);
  const d = z
    .object({
      count: z.number().int().min(1).max(20).default(6),
      folder: z.string().max(400).default(""),
      wanted: z.string().max(400).default(""),
    })
    .parse(await c.req.json().catch(() => ({})));
  if (!(await readFolders(c.env, clientId)).length)
    throw new StudioError("Add the client's Drive folder first.");
  // Only product photos, and of those only what vision read as a product: the shop, the kitchen,
  // people or a design stay out, and a copy of a photo already in the list is not looked at twice.
  const all = (await listClient(c.env, clientId)).photos
    .filter(
      (p) =>
        (p.role ?? "product") === "product" &&
        !p.video &&
        !p.duplicateOf &&
        (!p.kind || PRODUCT_KINDS.has(p.kind)),
    )
    .filter((p) => !d.folder || p.folder === d.folder || p.folder.startsWith(`${d.folder} / `));
  if (!all.length) throw new StudioError("No photos in this folder.", 404);
  const candidates = spreadPhotos(all, 36);
  const images: (ImageBytes | null)[] = [];
  for (let i = 0; i < candidates.length; i += 8)
    images.push(
      ...(await Promise.all(
        candidates.slice(i, i + 8).map((p) => photoBytes(c.env, p.id, 384).catch(() => null)),
      )),
    );
  const seen = candidates.filter((_, i) => images[i]);
  if (!seen.length)
    throw new StudioError(
      "Drive gave no previews of these photos yet; try again in a minute.",
      502,
    );
  const raw = await askText(
    c.env,
    drivePickInstruction({
      client: client.name,
      count: d.count,
      photos: seen,
      profile: await profileOf(c.env, clientId),
      wanted: d.wanted,
    }),
    DRIVE_PICK_SCHEMA,
    images.filter((x): x is ImageBytes => !!x),
  );
  return c.json({
    ok: true,
    picks: parsePicks(parseJson<unknown>(raw), seen, d.count),
    looked: seen.length,
    of: all.length,
  });
});
