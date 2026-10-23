/**
 * One search, one import: an asset chosen in the Photo studio's Assets panel ("Add as layer",
 * "Set as background") is downloaded once into the library there, then carried to the Text
 * studio, which composes the design. The Photo studio queues it here for (month, post) and opens
 * the Text studio on the same post; the Text studio takes it on load and adds the layer, so the
 * same asset is never searched for or imported twice. Kept in sessionStorage (this tab only) with
 * an in-memory fallback, and forgotten after ten minutes.
 */
import type { FreepikLayer } from "./FreepikPanel";

export interface PendingAsset {
  batch: string;
  post: number;
  how: "layer" | "background";
  layer: FreepikLayer;
  at: number;
}

const KEY = "lsm-asset-handoff";
const TTL = 10 * 60_000;
let memory: PendingAsset[] = [];

function read(): PendingAsset[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingAsset[]) : memory;
  } catch {
    return memory;
  }
}
function write(list: PendingAsset[]) {
  memory = list;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: the in-memory copy carries it within this page */
  }
}

/** Queues an asset for the design of one post; the Text studio adds it when it opens on that post. */
export function queueAssetForDesign(item: Omit<PendingAsset, "at">): void {
  const now = Date.now();
  write([...read().filter((p) => now - p.at < TTL), { ...item, at: now }].slice(-8));
}

/** The assets queued for this post (oldest first), removed from the queue. */
export function takeAssetsForDesign(batch: string | null | undefined, post: number): PendingAsset[] {
  if (!batch) return [];
  const now = Date.now();
  const all = read().filter((p) => now - p.at < TTL);
  const mine = all.filter((p) => p.batch === batch && p.post === post);
  if (mine.length || all.length !== read().length) write(all.filter((p) => !mine.includes(p)));
  return mine;
}
