/**
 * One stored object served the way a video player asks for it: HEAD for the size, GET with a
 * Range for a slice (206 + Content-Range), the whole file otherwise. Players (Safari on iPhone
 * above all) refuse to seek, and often to play at all, without Accept-Ranges and a correct 206.
 */
import { StudioError } from "./errors";

export interface ServeOptions {
  contentType: string;
  cacheControl: string;
  filename?: string;
}

/** A parsed `bytes=` header: the first and last byte to send, or null when it does not fit the size. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // The last n bytes.
    const n = Number(m[2]);
    if (!n) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return null;
  return { start, end };
}

export async function serveObject(bucket: R2Bucket, key: string, req: Request, o: ServeOptions): Promise<Response> {
  const head = await bucket.head(key);
  if (!head) throw new StudioError("Video not found.", 404);
  const size = head.size;
  const base: Record<string, string> = {
    "Content-Type": o.contentType,
    "Cache-Control": o.cacheControl,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  if (o.filename) base["Content-Disposition"] = `inline; filename="${o.filename}"`;
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...base, "Content-Length": String(size) } });
  const range = parseRange(req.headers.get("range"), size);
  if (range === null) return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  if (!range) {
    const obj = await bucket.get(key);
    if (!obj) throw new StudioError("Video not found.", 404);
    return new Response(obj.body ?? (await obj.arrayBuffer()), { status: 200, headers: { ...base, "Content-Length": String(size) } });
  }
  const length = range.end - range.start + 1;
  const obj = await bucket.get(key, { range: { offset: range.start, length } });
  if (!obj) throw new StudioError("Video not found.", 404);
  return new Response(obj.body ?? (await obj.arrayBuffer()), {
    status: 206,
    headers: { ...base, "Content-Length": String(length), "Content-Range": `bytes ${range.start}-${range.end}/${size}` },
  });
}
