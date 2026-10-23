/**
 * The editing session of one Studio card, as plain data: what the Photo, Text and Video studios
 * hold for a post while the designer moves between them (the page's store and its hooks live in
 * src/studio/editing-session.ts; this file has no browser types so the tests read it as is).
 *
 *   picture   the picture version the studios open on (a take picked under Versions), or null
 *   videoId   the clip version the Video studio opens on
 *   photo     the Adjust tool's settings not applied yet, and the picture they apply to
 *   text      the words and layers not saved yet (only while the client holds the post)
 *   video     the video cut not saved yet: its document, its project and the save it builds on
 *   held      the last save kept as a new version because the client holds the current one
 */
import { isDefaultAdjust, type AdjustParams } from "./photo-adjust";
import type { HoldReason } from "./client-hold";
import type { PostOverlayPatch } from "./overlay";
import type { VideoProject } from "./video-project";

export type StudioKind = "photo" | "text" | "video";

/** A picture version picked under Versions (not the card's current picture). */
export interface PicturePick {
  key: string;
  url: string;
  label: string;
}

/** A save kept as a new version beside the client's (pictures; clips are the video routes' own). */
export interface Held {
  kind: "picture" | "words";
  reason: HoldReason;
  message: string;
  /** The picture take to send for review. */
  key?: string;
}

export interface WordsResult {
  headline: string;
  subline: string;
  ov: PostOverlayPatch | undefined;
}

export interface EditingSession {
  key: string;
  batch: string;
  index: number;
  /** The studio open now (null: none; the card shows what is kept). */
  studio: StudioKind | null;
  picture: PicturePick | null;
  videoId: string | null;
  photo: { adjust: AdjustParams; basis: string; png: boolean } | null;
  text: { result: WordsResult; basis: string } | null;
  video: { project: VideoProject; projectId: string | null; rev: number } | null;
  held: Held | null;
  updated: number;
}

export const sessionKey = (batch: string, index: number) => `${batch}:${index}`;

export function blankSession(batch: string, index: number): EditingSession {
  return { key: sessionKey(batch, index), batch, index, studio: null, picture: null, videoId: null, photo: null, text: null, video: null, held: null, updated: Date.now() };
}

/** The parts with unsaved work. */
export function pendingParts(s: EditingSession | null | undefined): StudioKind[] {
  if (!s) return [];
  const out: StudioKind[] = [];
  if (s.photo && !isDefaultAdjust(s.photo.adjust)) out.push("photo");
  if (s.text) out.push("text");
  if (s.video) out.push("video");
  return out;
}

export const PART_LABEL: Record<StudioKind, string> = { photo: "picture adjustments", text: "words and layers", video: "the video cut" };

/** "picture adjustments and the video cut". */
export function pendingLabel(parts: StudioKind[]): string {
  const words = parts.map((p) => PART_LABEL[p]);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A session with nothing in it is not kept. */
export function isEmptySession(s: EditingSession): boolean {
  return !s.picture && !s.videoId && !s.held && pendingParts(s).length === 0;
}

/** Where the sessions are kept between reloads of the tab (sessionStorage in the page). */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE = "lsm-edit-session:";

/**
 * The sessions of the open tab: read once from storage, changed in memory, written back, and every
 * listener told. A storage that throws (private mode, full) leaves the sessions in memory only.
 */
export class SessionStore {
  private sessions = new Map<string, EditingSession | null>();
  private listeners = new Set<() => void>();
  constructor(private storage: () => SessionStorageLike | null) {}

  get(batch: string | null | undefined, index: number): EditingSession | null {
    if (!batch) return null;
    const key = sessionKey(batch, index);
    if (!this.sessions.has(key)) {
      let s: EditingSession | null = null;
      try {
        const raw = this.storage()?.getItem(STORAGE + key);
        s = raw ? (JSON.parse(raw) as EditingSession) : null;
      } catch {
        s = null;
      }
      this.sessions.set(key, s);
    }
    return this.sessions.get(key) ?? null;
  }

  patch(batch: string, index: number, patch: Partial<Omit<EditingSession, "key" | "batch" | "index">> | ((s: EditingSession) => Partial<EditingSession>)): EditingSession {
    const cur = this.get(batch, index) ?? blankSession(batch, index);
    const next: EditingSession = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch), key: cur.key, batch, index, updated: Date.now() };
    this.sessions.set(cur.key, next);
    this.write(cur.key, next);
    this.emit();
    return next;
  }

  clear(batch: string, index: number) {
    const key = sessionKey(batch, index);
    this.sessions.set(key, null);
    this.write(key, null);
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** One string for the month's cards: it changes only when a card's notice would. */
  noticeKey(batch: string | null | undefined): string {
    if (!batch) return "";
    const parts: string[] = [];
    for (const [k, s] of this.sessions) {
      if (!s || !k.startsWith(`${batch}:`)) continue;
      parts.push(`${s.index}|${s.studio ?? ""}|${pendingParts(s).join(",")}|${s.held ? `${s.held.kind}:${s.held.key ?? ""}` : ""}|${s.picture?.key ?? ""}|${s.videoId ?? ""}`);
    }
    return parts.sort().join(";");
  }

  private write(key: string, s: EditingSession | null) {
    try {
      const st = this.storage();
      if (!st) return;
      if (!s || isEmptySession(s)) st.removeItem(STORAGE + key);
      else st.setItem(STORAGE + key, JSON.stringify(s));
    } catch {
      /* private mode or full: the session lives in memory only */
    }
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
