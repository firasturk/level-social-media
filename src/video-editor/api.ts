/** The video editor's server routes (/api/studio/posts/video/editor) and their shapes. */
import { get, post, postForm, put } from "@/api";
import type { VideoProject } from "@shared/video-project";
import type { VideoItem } from "@/studio/videoApi";

export interface ProjectItem {
  id: string;
  batch: string;
  post: number;
  name: string;
  rev: number;
  sourceVideo: string | null;
  renderedVideo: string | null;
  created: number;
  updated: number;
  createdBy: string;
  updatedBy: string;
  clips: number;
}

export interface EditorAccess {
  admin: boolean;
  enabled: boolean;
  reason: string;
}

const BASE = "/api/studio/posts/video/editor";

export function listProjects(batch: string, post: number): Promise<{ projects: ProjectItem[]; access: EditorAccess }> {
  return get(`${BASE}/projects?batch=${encodeURIComponent(batch)}&post=${post}`);
}

export function getProject(id: string): Promise<{ project: ProjectItem; document: VideoProject; access: EditorAccess }> {
  return get(`${BASE}/projects/${encodeURIComponent(id)}`);
}

export function createProject(body: { batch: string; post: number; name: string; project: VideoProject; sourceVideo: string | null }): Promise<{ project: ProjectItem; document: VideoProject }> {
  return post(`${BASE}/projects`, body);
}

export function saveProject(id: string, project: VideoProject, rev: number): Promise<{ project: ProjectItem; document: VideoProject }> {
  return put(`${BASE}/projects/${encodeURIComponent(id)}`, { project, rev });
}

/**
 * The lightweight preview and still of a clip about to be stored, made in this browser (best
 * effort: src/lib/video-rendition.ts), so cards and galleries do not play the full file.
 */
async function withRendition(form: FormData, file: Blob): Promise<FormData> {
  try {
    const { addRendition, makeRendition } = await import("@/lib/video-rendition");
    addRendition(form, await makeRendition(file));
  } catch {
    /* the full file plays instead */
  }
  return form;
}

/* ───────────── Render jobs ───────────── */

export type RenderStatus = "rendering" | "uploading" | "done" | "failed" | "interrupted";
export type RenderOutcome = "card" | "review" | "superseded";

/** One "Render & update card" (server/video-editor.ts `RenderItem`). */
export interface RenderItem {
  id: string;
  project: string;
  projectRev: number;
  status: RenderStatus;
  progress: number;
  phase: string | null;
  videoId: string | null;
  outcome: RenderOutcome | null;
  error: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  created: number;
  updated: number;
  finished: number | null;
  createdBy: string;
}

/** A render job of the saved revision `rev`; the answer carries that revision's document, frozen. */
export function startRender(projectId: string, rev: number): Promise<{ render: RenderItem; document: VideoProject }> {
  return post(`${BASE}/renders`, { projectId, rev });
}

/** The tab's heartbeat. */
export function reportRender(id: string, progress: number, phase: string): Promise<{ render: RenderItem }> {
  return post(`${BASE}/renders/${encodeURIComponent(id)}/progress`, { progress: Math.max(0, Math.min(1, progress)), phase });
}

export function failRender(id: string, error: string): Promise<{ render: RenderItem }> {
  return post(`${BASE}/renders/${encodeURIComponent(id)}/fail`, { error: error.slice(0, 400) });
}

export function listRenders(projectId: string): Promise<{ renders: RenderItem[] }> {
  return get(`${BASE}/renders?project=${encodeURIComponent(projectId)}`);
}

/**
 * The rendered mp4 stored as a new version of the post, with its preview rendition; with a
 * render job the server closes it and puts the version on the card (or says why not). The still
 * the compositor kept is the poster when there is one.
 */
export async function uploadRender(args: { batch: string; post: number; projectId: string | null; renderId?: string | null; file: Blob; still?: Blob | null; note: string }): Promise<{ video: VideoItem; project: ProjectItem | null; render: RenderItem | null; outcome: RenderOutcome | null }> {
  const form = new FormData();
  form.set("batch", args.batch);
  form.set("post", String(args.post));
  if (args.projectId) form.set("projectId", args.projectId);
  if (args.renderId) form.set("renderId", args.renderId);
  form.set("note", args.note);
  form.set("file", new File([args.file], "export.mp4", { type: "video/mp4" }));
  await withRendition(form, args.file);
  if (args.still) form.set("still", new File([args.still], "still.jpg", { type: "image/jpeg" }));
  return postForm(`${BASE}/render`, form);
}

/** Raw footage the person brings for a post: stored as an uploaded version through the existing route, with its preview rendition. */
export async function uploadFootage(batch: string, index: number, file: File): Promise<{ video: VideoItem }> {
  const form = new FormData();
  form.set("batch", batch);
  form.set("index", String(index));
  form.set("note", file.name.replace(/\.[^.]+$/, "").slice(0, 80));
  form.set("file", file);
  return postForm("/api/studio/posts/video/upload", await withRendition(form, file));
}

export const versionFileUrl = (batch: string, id: string) => `/api/studio/posts/video/file?batch=${encodeURIComponent(batch)}&id=${encodeURIComponent(id)}`;
