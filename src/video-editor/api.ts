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

/** The rendered mp4 stored as a new version of the post. */
export function uploadRender(args: { batch: string; post: number; projectId: string | null; file: Blob; note: string }): Promise<{ video: VideoItem; project: ProjectItem | null }> {
  const form = new FormData();
  form.set("batch", args.batch);
  form.set("post", String(args.post));
  if (args.projectId) form.set("projectId", args.projectId);
  form.set("note", args.note);
  form.set("file", new File([args.file], "export.mp4", { type: "video/mp4" }));
  return postForm(`${BASE}/render`, form);
}

/** Raw footage the person brings for a post: stored as an uploaded version through the existing route. */
export function uploadFootage(batch: string, index: number, file: File): Promise<{ video: VideoItem }> {
  const form = new FormData();
  form.set("batch", batch);
  form.set("index", String(index));
  form.set("note", file.name.replace(/\.[^.]+$/, "").slice(0, 80));
  form.set("file", file);
  return postForm("/api/studio/posts/video/upload", form);
}

export const versionFileUrl = (batch: string, id: string) => `/api/studio/posts/video/file?batch=${encodeURIComponent(batch)}&id=${encodeURIComponent(id)}`;
