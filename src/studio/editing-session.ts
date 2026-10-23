/**
 * The editing session of one Studio card: what the Photo, Text and Video studios hold for a post
 * while the designer moves between them. Each studio is its own full-screen overlay with its own
 * state; this small store (one entry per month + post) is what carries the work across a switch,
 * so going Photo studio → Text studio → Video studio and back never drops anything unsaved:
 *
 *   picture   the picture version the studios open on (the card's current picture unless a take
 *             was picked under Versions)
 *   videoId   the clip version the Video studio opens on
 *   photo     the Adjust tool's settings not applied yet (and the picture they apply to)
 *   text      the words and layers not saved yet (only while the client holds the post: elsewhere
 *             the Text studio saves by itself)
 *   video     the video cut not saved yet (its document, the project and save it belongs to)
 *   held      the last save that was kept as a new version because the client holds the current one
 *
 * The plain parts are kept in sessionStorage too (a reload in the same tab keeps them); the music
 * file and the LUT a cut uses stay in memory only. "Save & return" (`commitSession`) saves every
 * part that is pending, wherever it was started; closing an editor without saving keeps them for
 * later and the card says so — nothing is ever discarded without the designer choosing it.
 */
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { post, postForm } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { describeAdjust, isDefaultAdjust } from "@shared/photo-adjust";
import { heldMessage, type HoldReason } from "@shared/client-hold";
import type { CubeLut } from "@shared/cube-lut";
import { PART_LABEL, SessionStore, sessionKey, type EditingSession, type Held, type StudioKind, type WordsResult } from "@shared/editing-session";
import { canvasFile, drawAdjusted, loadPicture, MAX_OUTPUT_EDGE } from "./photo/render";

export { isEmptySession, pendingLabel, pendingParts, sessionKey } from "@shared/editing-session";
export type { EditingSession, Held, PicturePick, StudioKind, WordsResult } from "@shared/editing-session";

/** In memory only: the files the video cut was using (not serialisable, not kept across a reload). */
export interface VideoMemory {
  music?: { name: string; buffer: AudioBuffer; beats: number[] } | null;
  lut?: { name: string; lut: CubeLut } | null;
}

const sessions = new SessionStore(() => (typeof sessionStorage !== "undefined" ? sessionStorage : null));
const memory = new Map<string, VideoMemory>();

/** The card's session, or null when it has none. */
export const getSession = (batch: string | null | undefined, index: number): EditingSession | null => sessions.get(batch, index);

/** Changes the card's session (made when it has none); every studio and the card see it at once. */
export const patchSession: SessionStore["patch"] = (batch, index, patch) => sessions.patch(batch, index, patch);

/** Ends the card's session: every kept part is dropped (only on the designer's explicit choice). */
export function clearSession(batch: string, index: number) {
  memory.delete(sessionKey(batch, index));
  sessions.clear(batch, index);
}

export function videoMemory(batch: string, index: number): VideoMemory {
  const key = sessionKey(batch, index);
  if (!memory.has(key)) memory.set(key, {});
  return memory.get(key)!;
}

const subscribe = (fn: () => void) => sessions.subscribe(fn);

/** The card's session, live: a studio re-renders when another part of the session changes. */
export function useEditingSession(batch: string | null | undefined, index: number): EditingSession | null {
  return useSyncExternalStore(
    subscribe,
    () => sessions.get(batch, index),
    () => null,
  );
}

/**
 * Re-renders the caller when any card's notice in this month changes (one string for the month),
 * not on every slider move inside a studio.
 */
export function useSessionNotices(batch: string | null | undefined): string {
  return useSyncExternalStore(
    subscribe,
    () => sessions.noticeKey(batch),
    () => "",
  );
}

/** Brings the card back into view and highlights it for a moment (after "Save & return"). */
export function flashCard(index: number) {
  const run = (tries: number) => {
    const el = document.getElementById(`post-card-${index}`);
    if (!el) {
      if (tries > 0) window.setTimeout(() => run(tries - 1), 120);
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("pc-flash");
    void el.offsetWidth;
    el.classList.add("pc-flash");
    window.setTimeout(() => el.classList.remove("pc-flash"), 2400);
  };
  // The editor's overlay leaves first; the card may mount a moment later.
  window.setTimeout(() => run(15), 60);
}

/* ───────────── Saving what the session holds ───────────── */

interface UploadAnswer {
  ok: true;
  key: string;
  held: HoldReason | null;
  message?: string;
}

/**
 * A picture drawn with the Adjust tool, sent as the post's picture; when the client holds the
 * current one the server keeps it as a new version and the session remembers it for the card.
 */
export async function uploadAdjusted(batch: string, index: number, canvas: HTMLCanvasElement, png: boolean, note: string): Promise<UploadAnswer> {
  const file = await canvasFile(canvas, `post-${index}-adjusted`, png);
  const form = new FormData();
  form.set("batch", batch);
  form.set("index", String(index));
  form.set("note", note);
  form.set("file", file, file.name);
  const r = await postForm<UploadAnswer>("/api/studio/posts/picture/upload", form);
  if (r.held) patchSession(batch, index, { held: { kind: "picture", reason: r.held, message: r.message || heldMessage(r.held), key: r.key } });
  return r;
}

/** The Adjust settings kept in the session, applied from wherever "Save & return" was pressed. */
async function applyKeptAdjustments(s: EditingSession): Promise<boolean> {
  const p = s.photo!;
  const im = await loadPicture(p.basis);
  const { canvas } = drawAdjusted(im, p.adjust, MAX_OUTPUT_EDGE, true);
  const changes = describeAdjust(p.adjust);
  const r = await uploadAdjusted(s.batch, s.index, canvas, p.png, `Adjusted in the Photo studio: ${changes.join(", ")}`);
  patchSession(s.batch, s.index, { photo: null });
  if (r.held) toast.message(r.message || heldMessage(r.held));
  return true;
}

/** The open month's own hooks: its saver for a post's words and layers (the plan lives in the month's view) and its refresh. */
export interface MonthHooks {
  saveWords: (index: number, r: WordsResult) => Promise<void>;
  refresh: () => Promise<void> | void;
}
const months = new Map<string, MonthHooks>();
export function registerMonth(batch: string, hooks: MonthHooks): () => void {
  months.set(batch, hooks);
  return () => {
    if (months.get(batch) === hooks) months.delete(batch);
  };
}

/** The video cut kept in the session, saved with the post (admins: the server says who may). */
async function saveKeptCut(s: EditingSession): Promise<boolean> {
  const v = s.video!;
  const api = await import("@/video-editor/api");
  if (v.projectId) {
    const r = await api.saveProject(v.projectId, v.project, v.rev);
    patchSession(s.batch, s.index, { video: null });
    void r;
  } else {
    await api.createProject({ batch: s.batch, post: s.index, name: v.project.name, project: v.project, sourceVideo: s.videoId });
    patchSession(s.batch, s.index, { video: null });
  }
  return true;
}

export interface CommitOptions {
  /** The open Photo studio applies its own adjustments (it has the picture decoded already). */
  applyPhoto?: () => Promise<boolean>;
  /** The open Video studio saves its own cut. */
  saveCut?: () => Promise<boolean>;
  /** The client holds the post: the words wait for an explicit choice. */
  hold?: HoldReason | null;
}

export interface CommitResult {
  /** Everything pending was saved (or kept on the designer's explicit choice): the editor may close. */
  ok: boolean;
  saved: StudioKind[];
  kept: StudioKind[];
  failed: { part: StudioKind; error: string }[];
}

/**
 * "Save & return": every pending part of the card's session is saved, the picture adjustments
 * first. A part that fails stays in the session (and the editor stays open, saying what failed);
 * words held for the client are saved only when the designer says so, and the client is asked to
 * review the post again.
 */
export async function commitSession(batch: string, index: number, opts: CommitOptions = {}): Promise<CommitResult> {
  const out: CommitResult = { ok: true, saved: [], kept: [], failed: [] };
  const attempt = async (part: StudioKind, fn: () => Promise<boolean>) => {
    try {
      if (await fn()) out.saved.push(part);
      else out.kept.push(part);
    } catch (e) {
      out.failed.push({ part, error: (e as Error).message });
    }
  };
  let s = getSession(batch, index);
  if (s?.photo && !isDefaultAdjust(s.photo.adjust)) await attempt("photo", () => (opts.applyPhoto ? opts.applyPhoto() : applyKeptAdjustments(getSession(batch, index)!)));
  s = getSession(batch, index);
  if (s?.text) {
    const month = months.get(batch);
    const text = s.text;
    await attempt("text", async () => {
      if (!month) throw new Error("The month is not open: the words could not be saved.");
      const reason = opts.hold ?? "shared";
      const ok = await askConfirm(
        `${reason === "approved" ? "The client approved the current version of this post." : "The client's review link shows the current version of this post."} Saving the words and layers changes what the client sees, so the client is asked to review this post again. Save them and send the post for review, or keep them here as an unsaved draft?`,
        { ok: "Save and send for review", danger: false, cancel: "Keep as a draft" },
      );
      if (!ok) return false;
      await month.saveWords(index, text.result);
      await post("/api/studio/posts/versions/send-for-review", { batch, index });
      patchSession(batch, index, { text: null });
      return true;
    });
  }
  s = getSession(batch, index);
  if (s?.video) await attempt("video", () => (opts.saveCut ? opts.saveCut() : saveKeptCut(getSession(batch, index)!)));
  // The card shows what was saved (a new picture, the client's answer cleared).
  if (out.saved.includes("photo") || out.saved.includes("text")) await Promise.resolve(months.get(batch)?.refresh()).catch(() => undefined);
  if (out.failed.length) {
    out.ok = false;
    toast.error(`Not saved: ${out.failed.map((f) => `${PART_LABEL[f.part]} (${f.error})`).join("; ")}. Everything else is kept.`);
  }
  return out;
}

/** "Send it for review": the new version becomes the client's, and the client answers again. */
export async function sendHeldForReview(batch: string, index: number, held: Held): Promise<void> {
  await post("/api/studio/posts/versions/send-for-review", { batch, index, key: held.kind === "picture" ? held.key : undefined });
  patchSession(batch, index, { held: null });
}
