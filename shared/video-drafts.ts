/**
 * Recoverable autosave (phase 2), the rules: while a cut has unsaved changes, the editor keeps a
 * copy in the browser's local storage every few seconds, keyed by the project's id (or, for a cut
 * never saved, by the post) together with the server revision it was edited from. When the editor
 * opens and the copy is newer than the server's draft, it asks "Recover unsaved changes from
 * <time>?". Recovering puts the copy on the timeline as unsaved changes (undo goes back to the
 * server's draft); nothing is written to the server without the person's Save. Declining keeps
 * the copy aside (one backup per project) instead of deleting it, so a mis-click loses nothing.
 *
 * The storage is handed in (`DraftStore`, the browser's localStorage in the editor:
 * src/video-editor/ui/autosave.ts), so these functions are tested as they run.
 */
import type { VideoProject } from "./video-project";

export const AUTOSAVE_MS = 4000;
export const MAX_DRAFTS = 8;
const PREFIX = "lsm-video-draft:";

/** The part of Web Storage the drafts use. */
export interface DraftStore {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface LocalDraft {
  key: string;
  projectId: string | null;
  /** The server revision the copy was edited from (0 for a cut never saved). */
  rev: number;
  /** When the copy was written, ms. */
  savedAt: number;
  project: VideoProject;
}

/** The storage key: the project's id, or the post for a cut that has no project yet. */
export function draftKey(post: { batch: string; index: number }, projectId: string | null): string {
  return `${PREFIX}${projectId ?? `new:${post.batch}:${post.index}`}`;
}

/** The document without what changes on every save (revision, timestamps), to compare two copies. */
const content = (p: VideoProject): string => JSON.stringify({ ...p, rev: 0, updatedAt: 0, createdAt: 0 });

export interface Recovery {
  offer: boolean;
  /** The server's draft was saved again after the copy's revision (elsewhere, or by another tab): recovering replaces that save once the person saves. */
  stale: boolean;
}

/**
 * Whether to offer the local copy: only when it differs from the server's draft and was written
 * after the server's last save (for a cut never saved: whenever it has clips or layers).
 */
export function recoveryOffer(local: LocalDraft | null, server: { id: string | null; rev: number; updated: number; document: VideoProject } | null): Recovery {
  const no = { offer: false, stale: false };
  if (!local) return no;
  if (!server || !server.id) return { offer: !local.projectId && (local.project.clips.length > 0 || local.project.overlays.length > 0), stale: false };
  if (local.projectId !== server.id) return no;
  if (content(local.project) === content(server.document)) return no;
  if (local.savedAt <= server.updated) return no;
  return { offer: true, stale: local.rev < server.rev };
}

export function readDraft(store: DraftStore | null, key: string): LocalDraft | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as LocalDraft;
    return d && typeof d.savedAt === "number" && d.project && Array.isArray(d.project.clips) ? d : null;
  } catch {
    return null;
  }
}

/** Writes the copy; drops the oldest copies beyond `MAX_DRAFTS`. False when the storage refused (full, private mode). */
export function writeDraft(store: DraftStore | null, d: LocalDraft): boolean {
  if (!store) return false;
  try {
    store.setItem(d.key, JSON.stringify(d));
    const keys: { key: string; at: number }[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(PREFIX) && !k.endsWith(":declined")) keys.push({ key: k, at: readDraft(store, k)?.savedAt ?? 0 });
    }
    keys.sort((a, b) => b.at - a.at);
    for (const old of keys.slice(MAX_DRAFTS)) store.removeItem(old.key);
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(store: DraftStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

/** Declined: kept aside as one backup (not offered again), out of the way of the next autosave. */
export function setDraftAside(store: DraftStore | null, key: string): void {
  try {
    const raw = store?.getItem(key);
    if (raw) store?.setItem(`${key}:declined`, raw);
    store?.removeItem(key);
  } catch {
    /* best effort */
  }
}

/** "14:05" today, else "23 Oct, 14:05": the time in the recovery question. */
export function draftTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}
