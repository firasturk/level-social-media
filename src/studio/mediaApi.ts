/**
 * The browser side of Direct to Studio (server/media-intake.ts): the picked files sent in groups
 * small enough for one request, the combine of chosen cards, the Start card's clip, and the cards
 * just made (so the Studio opens with them selected, ready for the next explicit step).
 */
import { get, postForm } from "@/api";
import { posterOf } from "./stillClip";

export type MediaRoute = "images" | "video";

/** One file in the selection tray: from the client's Drive (copied there, never changed) or from this computer. */
export type TrayItem =
  | { key: string; from: "drive"; id: string; name: string; video: boolean }
  | { key: string; from: "upload"; file: File; name: string; video: boolean; preview: string };

export interface IntakeAnswer {
  ok: true;
  batch: string;
  created: { index: number; kind: "image" | "video"; name: string; from: "drive" | "upload" }[];
  existing: { index: number; name: string }[];
}

/** Matches the server's limits (MEDIA_ITEMS_MAX, MEDIA_REQUEST_MAX), with room for the form itself. */
const GROUP_ITEMS = 12;
const GROUP_BYTES = 80 * 1024 * 1024;

export const isVideoFile = (f: File) => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);
export const isImageFile = (f: File) => /^image\/(png|jpeg|webp)$/i.test(f.type);

/** The tray in groups, in order: a new group when the next file would pass the item or byte limit. */
export function groupTray(items: TrayItem[]): TrayItem[][] {
  const out: TrayItem[][] = [];
  let cur: TrayItem[] = [];
  let bytes = 0;
  for (const it of items) {
    const size = it.from === "upload" ? it.file.size : 0;
    if (cur.length && (cur.length >= GROUP_ITEMS || bytes + size > GROUP_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Sends the tray, group after group, in order; the cards come back in the order picked. */
export async function sendTray(
  route: MediaRoute,
  dest: { batch?: string | null; client?: string; month?: string },
  items: TrayItem[],
  onProgress?: (done: number, of: number, phase: string) => void,
): Promise<IntakeAnswer> {
  const all: IntakeAnswer = { ok: true, batch: dest.batch ?? "", created: [], existing: [] };
  let done = 0;
  let batch = dest.batch ?? "";
  for (const group of groupTray(items)) {
    const form = new FormData();
    form.set("kind", route);
    if (batch) form.set("batch", batch);
    else {
      form.set("client", dest.client ?? "");
      form.set("month", dest.month ?? "");
    }
    const list = [];
    for (const [i, it] of group.entries()) {
      if (it.from === "drive") list.push({ from: "drive", id: it.id });
      else {
        form.set(`file${i}`, it.file, it.file.name);
        let poster: Blob | null = null;
        if (it.video) {
          onProgress?.(done, items.length, `Reading the first frame of ${it.name}…`);
          poster = await posterOf(it.file);
          if (poster) form.set(`poster${i}`, poster, "poster.jpg");
        }
        list.push({ from: "upload", field: `file${i}`, ...(poster ? { poster: `poster${i}` } : {}) });
      }
    }
    form.set("items", JSON.stringify(list));
    onProgress?.(done, items.length, `Copying ${done + 1}${group.length > 1 ? `–${done + group.length}` : ""} of ${items.length}…`);
    const r = await postForm<IntakeAnswer>("/api/studio/media/intake", form);
    batch ||= r.batch;
    all.batch = r.batch || all.batch;
    all.created.push(...r.created);
    all.existing.push(...r.existing);
    done += group.length;
    onProgress?.(done, items.length, "");
  }
  return all;
}

export interface CombineAnswer {
  ok: true;
  target: number;
  created: boolean;
  project: string;
  clips: string[];
}

/** The chosen cards, in order, as one video project on the target card ("new" for a new card). */
export function combineCards(batch: string, target: number | "new", items: { post: number; still?: File }[], name?: string): Promise<CombineAnswer> {
  const form = new FormData();
  form.set("batch", batch);
  form.set("target", String(target));
  if (name) form.set("name", name);
  form.set("items", JSON.stringify(items.map((it, i) => ({ post: it.post, ...(it.still ? { still: `still${i}` } : {}) }))));
  items.forEach((it, i) => it.still && form.set(`still${i}`, it.still, it.still.name));
  return postForm<CombineAnswer>("/api/studio/media/combine", form);
}

export interface StartClip {
  batch: string;
  id: string;
  url: string;
  poster: string | null;
}

export async function latestClip(client: string): Promise<StartClip | null> {
  const r = await get<{ clip: StartClip | null }>(`/api/studio/media/clip?client=${encodeURIComponent(client)}`);
  return r.clip;
}

/* ───────────── The cards just made: the Studio opens with them selected ───────────── */

const NEW_KEY = (batch: string) => `lsm-media-new:${batch}`;

export function rememberNewCards(batch: string, route: MediaRoute, indexes: number[]): void {
  try {
    sessionStorage.setItem(NEW_KEY(batch), JSON.stringify({ route, indexes, at: Date.now() }));
  } catch {
    /* private mode */
  }
}

/** The cards made a moment ago in this tab (read once), or null. */
export function takeNewCards(batch: string | null): { route: MediaRoute; indexes: number[] } | null {
  if (!batch) return null;
  try {
    const raw = sessionStorage.getItem(NEW_KEY(batch));
    if (!raw) return null;
    sessionStorage.removeItem(NEW_KEY(batch));
    const d = JSON.parse(raw) as { route: MediaRoute; indexes: number[]; at: number };
    return Date.now() - d.at < 10 * 60_000 ? { route: d.route, indexes: d.indexes } : null;
  } catch {
    return null;
  }
}
