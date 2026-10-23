/**
 * "Edit like this video": the reference video's file, fetched for the browser to analyse
 * (docs/video-editor.md → Edit quality). The reference is never rendered into a post's video and
 * nothing is generated or charged: the server only copies the file into R2 under `editor-refs/`
 * for seven days, so the tab can read it (WebCodecs needs the bytes; Pinterest's video host does
 * not allow the studio's page to read it directly) and play it next to the cut.
 *
 * Routes (mounted at /api/studio/posts/video/editor/reference):
 *   POST /           {from: "pinterest", url, batch?} | {from: "drive", client, fileId, batch?}
 *                    admins, behind the editor switch; ledger `editor.reference` at estimate 0
 *   GET  /:id        the stored copy, with Range (any signed-in user who may see the month);
 *                    410 once it has expired (it is then deleted)
 *
 * A Pinterest pin, when Pinterest is connected (Connection → Pinterest, server/pinterest.ts): its
 * id is read from the link (a pin.it short link's redirect is read from pin.it), the pin is asked
 * from Pinterest's official API (GET /v5/pins/{id}) and its first video taken from `media` (a
 * video pin's `video_url`, or the first video item of a multi-item pin). Not connected, the old
 * path is kept as a fallback: Pinterest's pin endpoint and, failing that, the pin page, read for
 * MP4 renditions, with a hint to connect Pinterest. Either way the bytes come from Pinterest's
 * video host only (v1.pinimg.com and its siblings, https), only an MP4 (its `ftyp` box checked),
 * 60 MB at most. A refusal says plainly what happened: pin not found or private, a picture pin,
 * a video Pinterest withheld, or Pinterest refusing the server, and names the alternatives.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { now, uuid } from "./db";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, recordIntegrationOp, requireIntegrationAdmin } from "./integrations";
import { NOT_CONNECTED_HINT, pinIdOfLink, pinterestConnected, pinVideoViaApi } from "./pinterest";
import { driveFileCopy, driveFileInfo, isClientDriveFile } from "./drive";
import { serveObject } from "./range";
import type { User } from "@shared/types";

type Variables = { user: User };
export const referenceRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const REFERENCE_PREFIX = "editor-refs/";
/** How long a fetched reference is kept. */
export const REFERENCE_TTL_MS = 7 * 24 * 3600 * 1000;
export const MAX_REFERENCE_BYTES = 60 * 1024 * 1024;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const BLOCKED_MESSAGE = "Pinterest did not hand this pin's video to the studio (it often refuses servers). Save the video from Pinterest and use Upload, or pick the clip from the client's Drive: the analysis is the same.";
export const NO_VIDEO_MESSAGE = "No video was found on this pin (it may be a picture, or a story pin whose video Pinterest does not show to the studio). Save the video and use Upload, or pick it from the client's Drive.";

/** A pin's id from a pinterest.* /pin/ link. */
export const pinIdOf = (url: string): string | null => /pinterest\.[a-z.]+\/pin\/(?:[^/]*--)?(\d{6,})/i.exec(url)?.[1] ?? null;

/** Pinterest's video host, and only it: https, v1.pinimg.com (or v.pinimg.com, v2…), a /videos/ path to an .mp4. */
export function isPinVideoUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && /^v\d*\.pinimg\.com$/i.test(url.hostname) && url.pathname.startsWith("/videos/") && url.pathname.toLowerCase().endsWith(".mp4");
  } catch {
    return false;
  }
}

/**
 * The MP4 renditions of a pin's video found in Pinterest's JSON or the pin page's HTML (escaped or
 * not), best first: 720p, then the other MP4 sizes by their height, never the HLS playlist.
 */
export function pinVideoUrls(text: string): string[] {
  const plain = text.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  const found = new Set<string>();
  for (const m of plain.matchAll(/https:\/\/v\d*\.pinimg\.com\/videos\/[A-Za-z0-9/_.-]+?\.mp4/g)) if (isPinVideoUrl(m[0])) found.add(m[0]);
  const rank = (u: string) => {
    if (/\/720p\//i.test(u)) return 0;
    const h = /\/(\d{3,4})p\//.exec(u);
    if (h) return Number(h[1]) <= 1080 ? 1 + Math.abs(720 - Number(h[1])) / 1000 : 3;
    return /expMp4|mp4/i.test(u) ? 2 : 4;
  };
  return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The bytes of an MP4 within the size limit, or a reason. Reads the body in chunks so a lying Content-Length cannot run past the limit. */
export async function readVideoBody(r: Response, max = MAX_REFERENCE_BYTES): Promise<ArrayBuffer | string> {
  if (!r.ok) return `answered ${r.status}`;
  const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type && type !== "video/mp4" && type !== "application/octet-stream" && type !== "binary/octet-stream") return `sent ${type}, not an MP4`;
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > max) return `the video is ${Math.round(len / 1048576)} MB (${Math.round(max / 1048576)} MB at most)`;
  const parts: Uint8Array[] = [];
  let total = 0;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return `the video is larger than ${Math.round(max / 1048576)} MB`;
      }
      parts.push(value);
    }
  } else {
    const b = new Uint8Array(await r.arrayBuffer());
    total = b.byteLength;
    if (total > max) return `the video is larger than ${Math.round(max / 1048576)} MB`;
    parts.push(b);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  if (total < 12 || String.fromCharCode(...out.subarray(4, 8)) !== "ftyp") return "the file is not an MP4";
  return out.buffer;
}

/** A pin's video: its id, the renditions found, the bytes of the best one that downloads. Throws a StudioError with a plain reason. */
export async function fetchPinterestVideo(link: string, f: typeof fetch = fetch): Promise<{ pinId: string; videoUrl: string; bytes: ArrayBuffer }> {
  let pinId = pinIdOf(link);
  let host: string;
  try {
    host = new URL(link).hostname.replace(/^www\./, "");
  } catch {
    throw new StudioError("That is not a link.", 400);
  }
  if (!/^(?:[a-z]{2}\.)?pinterest\.[a-z.]+$|^pin\.it$/i.test(host)) throw new StudioError("Paste a Pinterest pin link (pinterest.com/pin/… or pin.it/…).", 400);
  let pageText = "";
  if (!pinId) {
    // A pin.it short link lands on the pin page.
    const r = await f(link, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r?.ok) {
      pinId = pinIdOf(r.url);
      pageText = (await r.text()).slice(0, 3_000_000);
    } else if (r && (r.status === 403 || r.status === 429)) throw new StudioError(BLOCKED_MESSAGE, 502);
    if (!pinId) throw new StudioError("The link did not lead to a pin.", 400);
  }
  let urls: string[] = [];
  let blocked = false;
  // 1. Pinterest's pin endpoint (it answers servers plainly more often than the page).
  try {
    const r = await f(`https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=${pinId}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.ok) urls = pinVideoUrls(await r.text());
    else if (r.status === 403 || r.status === 429) blocked = true;
  } catch (e) {
    console.error("[reference] pin info failed", pinId, errorMessage(e));
  }
  // 2. The page a short link landed on, then the pin's own page.
  if (!urls.length) urls = pinVideoUrls(pageText);
  if (!urls.length) {
    try {
      const r = await f(`https://www.pinterest.com/pin/${pinId}/`, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (r.ok) urls = pinVideoUrls((await r.text()).slice(0, 3_000_000));
      else if (r.status === 403 || r.status === 429) blocked = true;
    } catch (e) {
      console.error("[reference] pin page failed", pinId, errorMessage(e));
    }
  }
  if (!urls.length) throw new StudioError(blocked ? BLOCKED_MESSAGE : NO_VIDEO_MESSAGE, 502);
  // 3. The bytes, from Pinterest's video host only.
  const reasons: string[] = [];
  for (const u of urls.slice(0, 3)) {
    if (!isPinVideoUrl(u)) continue;
    try {
      const r = await f(u, { headers: { "User-Agent": UA, Accept: "video/mp4,*/*;q=0.5", Referer: "https://www.pinterest.com/" }, redirect: "error", signal: AbortSignal.timeout(45_000) });
      const got = await readVideoBody(r);
      if (typeof got !== "string") return { pinId, videoUrl: u, bytes: got };
      reasons.push(got);
      if (r.status === 403 || r.status === 429) blocked = true;
    } catch (e) {
      reasons.push(errorMessage(e));
    }
  }
  if (blocked) throw new StudioError(BLOCKED_MESSAGE, 502);
  throw new StudioError(`The pin's video could not be used: ${reasons[0] ?? "no rendition answered"}. Save it and use Upload instead.`, 502);
}

/** The bytes of a pin's video link, from Pinterest's video host only. */
async function downloadPinVideo(u: string, f: typeof fetch): Promise<ArrayBuffer> {
  if (!isPinVideoUrl(u)) throw new StudioError("Pinterest gave a video link outside its video host (an MP4 on v1.pinimg.com was expected), so it was not fetched. Save the video and use Upload instead.", 502);
  let r: Response;
  try {
    r = await f(u, { headers: { "User-Agent": UA, Accept: "video/mp4,*/*;q=0.5" }, redirect: "error", signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    throw new StudioError(`The pin's video could not be downloaded: ${errorMessage(e)}. Save it and use Upload instead.`, 502);
  }
  const got = await readVideoBody(r);
  if (typeof got === "string") throw new StudioError(`The pin's video could not be used: ${got}. Save it and use Upload instead.`, 502);
  return got;
}

/** A pin's video through Pinterest's official API (Connection → Pinterest): the pin's id, its first video's link, the bytes. */
export async function fetchPinterestVideoViaApi(env: Env, link: string, f: typeof fetch = fetch): Promise<{ pinId: string; videoUrl: string; bytes: ArrayBuffer }> {
  const pinId = await pinIdOfLink(link, f);
  const videoUrl = await pinVideoViaApi(env, pinId, f);
  return { pinId, videoUrl, bytes: await downloadPinVideo(videoUrl, f) };
}

/**
 * A pin's video: through the API when Pinterest is connected, else the old page reading, whose
 * refusals carry the hint to connect Pinterest.
 */
export async function pinterestVideo(env: Env, link: string, f: typeof fetch = fetch): Promise<{ pinId: string; videoUrl: string; bytes: ArrayBuffer; via: "api" | "page" }> {
  if (await pinterestConnected(env)) return { ...(await fetchPinterestVideoViaApi(env, link, f)), via: "api" };
  try {
    return { ...(await fetchPinterestVideo(link, f)), via: "page" };
  } catch (e) {
    if (e instanceof StudioError && e.status >= 500) throw new StudioError(`${e.message} ${NOT_CONNECTED_HINT}`, e.status, e.fatal, { ...(e.data ?? {}), pinterest: "not_connected" });
    throw e;
  }
}

/** Deletes expired copies (a few per call: R2 has no per-object expiry without a bucket rule). */
export async function sweepReferences(bucket: R2Bucket, t = now()): Promise<number> {
  const list = await bucket.list({ prefix: REFERENCE_PREFIX, limit: 100, include: ["customMetadata"] } as R2ListOptions);
  const old = list.objects.filter((o) => Number(o.customMetadata?.expires ?? 0) < t).map((o) => o.key);
  if (old.length) await bucket.delete(old.slice(0, 50));
  return Math.min(50, old.length);
}

const body = z.discriminatedUnion("from", [
  z.object({ from: z.literal("pinterest"), url: z.string().url().max(2000), batch: z.string().max(100).optional() }),
  z.object({ from: z.literal("drive"), client: z.string().min(1).max(100), fileId: z.string().regex(/^[A-Za-z0-9_-]{6,200}$/), batch: z.string().max(100).optional() }),
]);

referenceRoutes.post("/", async (c) => {
  const user = requireIntegrationAdmin(c, "editor");
  await assertIntegrationEnabled(c.env, "editor");
  const parsed = body.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Send a Pinterest pin link, or a Drive video of the client.", 400);
  const d = parsed.data;
  if (d.batch) await ownedPlan(c.env, user, d.batch);
  let bytes: ArrayBuffer;
  let name: string;
  let sourceId: string;
  let note: string;
  if (d.from === "pinterest") {
    await assertIntegrationEnabled(c.env, "pinterest");
    const v = await pinterestVideo(c.env, d.url);
    bytes = v.bytes;
    name = `Pinterest pin ${v.pinId}`;
    sourceId = v.pinId;
    note = `Pinterest pin ${v.pinId}${v.via === "api" ? " (through the Pinterest API)" : " (read from the pin page)"}: its video copied for analysis (kept 7 days, never rendered into a post)`;
  } else {
    if (!(await isClientDriveFile(c.env, d.client, d.fileId))) throw new StudioError("That file is not in the client's Drive folders.", 404);
    const info = await driveFileInfo(c.env, d.fileId);
    if (!info.mimeType.startsWith("video/")) throw new StudioError(`"${info.name}" is not a video.`, 415);
    if (info.size > MAX_REFERENCE_BYTES) throw new StudioError(`"${info.name}" is too large (60 MB at most).`, 413);
    const copy = await driveFileCopy(c.env, info, MAX_REFERENCE_BYTES);
    const u8 = new Uint8Array(copy.bytes);
    if (u8.byteLength < 12 || String.fromCharCode(...u8.subarray(4, 8)) !== "ftyp") throw new StudioError(`"${info.name}" is not an MP4 the editor can read.`, 415);
    bytes = copy.bytes;
    name = info.name.slice(0, 200);
    sourceId = info.id;
    note = `Drive video "${name}" copied for analysis (kept 7 days, never rendered into a post); Drive was only read`;
  }
  await sweepReferences(c.env.BUCKET).catch(() => 0);
  const id = uuid();
  const t = now();
  const expires = t + REFERENCE_TTL_MS;
  await c.env.BUCKET.put(`${REFERENCE_PREFIX}${id}.mp4`, bytes, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { owner: user.id, batch: d.batch ?? "", expires: String(expires), from: d.from, source: sourceId, name } });
  await recordIntegrationOp(c.env, { provider: "editor", kind: "editor.reference", user: user.id, batch: d.batch ?? null, estimate: 0, status: "done", note });
  return c.json({ ok: true, id, name, from: d.from, sourceId, size: bytes.byteLength, expires, url: `/api/studio/posts/video/editor/reference/${id}` });
});

referenceRoutes.on(["GET", "HEAD"], "/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new StudioError("Reference not found.", 404);
  const key = `${REFERENCE_PREFIX}${id}.mp4`;
  const head = await c.env.BUCKET.head(key);
  if (!head) throw new StudioError("This reference copy is gone (they are kept for 7 days). Fetch or pick it again.", 404);
  const meta = head.customMetadata ?? {};
  if (Number(meta.expires ?? 0) < now()) {
    await c.env.BUCKET.delete(key);
    throw new StudioError("This reference copy expired (they are kept for 7 days). Fetch or pick it again.", 410);
  }
  if (meta.batch) await ownedPlan(c.env, user, meta.batch);
  else if (user.role !== "admin" && meta.owner !== user.id) throw new StudioError("Reference not found.", 404);
  return serveObject(c.env.BUCKET, key, c.req.raw, { contentType: "video/mp4", cacheControl: "private, max-age=3600" });
});
