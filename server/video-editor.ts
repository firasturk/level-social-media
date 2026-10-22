/**
 * The video editor's server side: projects (a JSON document per cut of a post's footage) and the
 * export that comes back from the browser as a new version of the post. Nothing is decoded or
 * rendered here: a Worker cannot run ffmpeg, so the browser does the rendering and sends the mp4.
 *
 * Routes (mounted at /api/studio/posts/video/editor):
 *   GET  /projects?batch=&post=   the post's projects (every signed-in user under the month's permissions)
 *   GET  /projects/:id            one project with its document
 *   POST /projects                {batch, post, name, project, sourceVideo}: a new project (admins, switch, ledger editor.save)
 *   PUT  /projects/:id            {project, rev}: a save; 409 when the row moved on since the tab read it
 *   POST /render                  multipart {batch, post, projectId, file, note}: the export stored as a done
 *                                 version with provider = 'editor' (admins, switch, ledger editor.render)
 *
 * Raw footage the person brings (their own clips) goes through the existing upload route and is
 * listed as a version; the editor reads a post's versions as its sources.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { ownedPlan } from "./posts";
import { assertIntegrationEnabled, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp, type IntegrationAccess } from "./integrations";
import { MAX_VIDEO_FILE, storeVideoFile, type VideoItem } from "./video";
import { validateProject, type VideoProject } from "@shared/video-project";
import type { User } from "@shared/types";

type Variables = { user: User };
export const videoEditorRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PROVIDER = "editor" as const;
const MAX_POST = 200;
/** A saved document is bounded; the editor keeps the LUT table and the decoded media in memory, not here. */
const MAX_PROJECT_JSON = 512 * 1024;

export interface VideoProjectRow {
  id: string;
  batch: string;
  post: number;
  name: string;
  project: string;
  rev: number;
  source_video: string | null;
  rendered_video: string | null;
  created: number;
  updated: number;
  created_by: string;
  updated_by: string;
}

export interface VideoProjectItem {
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
  /** The timeline's clip count, for the list. */
  clips: number;
}

function parseDoc(row: VideoProjectRow): VideoProject | null {
  try {
    const r = validateProject(JSON.parse(row.project));
    return r.ok ? r.project : null;
  } catch {
    return null;
  }
}

function projectItem(row: VideoProjectRow): VideoProjectItem {
  const doc = parseDoc(row);
  return { id: row.id, batch: row.batch, post: row.post, name: row.name, rev: row.rev, sourceVideo: row.source_video, renderedVideo: row.rendered_video, created: row.created, updated: row.updated, createdBy: row.created_by, updatedBy: row.updated_by, clips: doc?.clips.length ?? 0 };
}

async function parseBody<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** The document checked and serialised; a document that fails says why in plain words. */
function checkedDoc(project: unknown): { doc: VideoProject; json: string } {
  const r = validateProject(project);
  if (!r.ok) throw new StudioError(`The project cannot be saved: ${r.reason}`);
  const json = JSON.stringify(r.project);
  if (json.length > MAX_PROJECT_JSON) throw new StudioError("The project is too large to save (512 KB at most).");
  return { doc: r.project, json };
}

async function projectRow(env: Env, user: User, id: string): Promise<{ row: VideoProjectRow; batch: { id: string; owner: string } }> {
  const row = await first<VideoProjectRow>(env.DB, "SELECT * FROM video_projects WHERE id = ?", id);
  if (!row) throw new StudioError("Project not found.", 404);
  const batch = await ownedPlan(env, user, row.batch);
  return { row, batch };
}

/** The post's projects, newest first, with what the viewer may do. */
videoEditorRoutes.get("/projects", async (c) => {
  const user = c.get("user");
  const b = await ownedPlan(c.env, user, c.req.query("batch"));
  const post = Number(c.req.query("post"));
  if (!Number.isInteger(post) || post < 1) throw new StudioError("Post index is required.");
  const rows = await all<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 50", b.id, post);
  const access: IntegrationAccess = await integrationAccess(c.env, user, PROVIDER);
  return c.json({ ok: true, projects: rows.map(projectItem), access });
});

videoEditorRoutes.get("/projects/:id", async (c) => {
  const user = c.get("user");
  const { row } = await projectRow(c.env, user, c.req.param("id"));
  const doc = parseDoc(row);
  if (!doc) throw new StudioError("This project's document cannot be read.", 409);
  return c.json({ ok: true, project: projectItem(row), document: { ...doc, rev: row.rev }, access: await integrationAccess(c.env, user, PROVIDER) });
});

const createSchema = z.object({
  batch: z.string().min(1),
  post: z.number().int().min(1).max(MAX_POST),
  name: z.string().trim().max(120).default(""),
  project: z.unknown(),
  sourceVideo: z.string().max(100).nullable().optional(),
});

/** A new project for a post: the document is checked, the row written, the ledger told (no spend). */
videoEditorRoutes.post("/projects", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const d = await parseBody(c, createSchema);
  const b = await ownedPlan(c.env, user, d.batch);
  if (d.sourceVideo) {
    const v = await first<{ id: string }>(c.env.DB, "SELECT id FROM videos WHERE id = ? AND batch = ? AND post = ?", d.sourceVideo, b.id, d.post);
    if (!v) throw new StudioError("The version this project opens from is not on this post.", 404);
  }
  const { doc, json } = checkedDoc({ ...(d.project as object), rev: 1 });
  const id = uuid();
  const t = now();
  const name = d.name || doc.name || `Cut ${new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  await run(c.env.DB, "INSERT INTO video_projects (id, batch, post, name, project, rev, source_video, rendered_video, created, updated, created_by, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)", id, b.id, d.post, name, json, d.sourceVideo ?? null, t, t, user.id, user.id);
  await recordIntegrationOp(c.env, { provider: PROVIDER, kind: "editor.save", user: user.id, batch: b.id, post: d.post, estimate: 0, status: "done", note: `New project "${name}" · ${doc.clips.length} clip${doc.clips.length === 1 ? "" : "s"} · rendered in the browser, nothing sent out` });
  const row = (await first<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE id = ?", id))!;
  return c.json({ ok: true, project: projectItem(row), document: { ...doc, rev: 1 } });
});

/** A save: the row must still be at the rev the tab read, else 409 with the current one. */
videoEditorRoutes.put("/projects/:id", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const d = await parseBody(c, z.object({ project: z.unknown(), rev: z.number().int().min(0), name: z.string().trim().max(120).optional() }));
  const { row, batch } = await projectRow(c.env, user, c.req.param("id"));
  if (row.rev !== d.rev) throw new StudioError(`This project was saved elsewhere since you opened it (now at save ${row.rev}, you have ${d.rev}). Reload it to keep working.`, 409, false, { rev: row.rev, stale: true });
  const { doc, json } = checkedDoc({ ...(d.project as object), rev: d.rev + 1 });
  const t = now();
  const name = d.name ?? (doc.name || row.name);
  await run(c.env.DB, "UPDATE video_projects SET project = ?, rev = rev + 1, name = ?, updated = ?, updated_by = ? WHERE id = ? AND rev = ?", json, name, t, user.id, row.id, d.rev);
  const after = (await first<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE id = ?", row.id))!;
  if (after.rev !== d.rev + 1) throw new StudioError("This project was saved elsewhere a moment ago. Reload it to keep working.", 409, false, { rev: after.rev, stale: true });
  await recordIntegrationOp(c.env, { provider: PROVIDER, kind: "editor.save", user: user.id, batch: batch.id, post: row.post, estimate: 0, status: "done", note: `Saved "${name}" · save ${after.rev} · ${doc.clips.length} clip${doc.clips.length === 1 ? "" : "s"}` });
  return c.json({ ok: true, project: projectItem(after), document: { ...doc, rev: after.rev } });
});

/**
 * The export the browser rendered, stored as a finished version of the post with the same checks
 * as an upload (MP4, H.264; AAC and faststart noted). The project remembers the version it made.
 */
videoEditorRoutes.post("/render", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new StudioError("Send the export as a form upload.");
  const batch = String(form.get("batch") ?? "");
  const post = Number(form.get("post") ?? 0);
  const projectId = String(form.get("projectId") ?? "");
  const note = String(form.get("note") ?? "").slice(0, 200);
  const file = form.get("file");
  if (!(file instanceof File)) throw new StudioError("Attach the mp4 as 'file'.");
  if (file.size > MAX_VIDEO_FILE) throw new StudioError("The export is too large (60 MB at most). Pick a smaller bit rate or a shorter cut.");
  if (!Number.isInteger(post) || post < 1) throw new StudioError("Post index is required.");
  const b = await ownedPlan(c.env, user, batch);
  const row = projectId ? await first<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE id = ? AND batch = ? AND post = ?", projectId, b.id, post) : null;
  if (projectId && !row) throw new StudioError("Project not found on this post.", 404);
  const opId = await recordIntegrationOp(c.env, { provider: PROVIDER, kind: "editor.render", user: user.id, batch: b.id, post, estimate: 0, status: "running", note: `Export${row ? ` of "${row.name}" (save ${row.rev})` : ""} rendered in the browser · ${Math.round(file.size / 1024)} KB` });
  let stored: { video: VideoItem; info: unknown };
  try {
    stored = await storeVideoFile(c.env, user, b, { file, index: post, note: note || (row ? `Export of ${row.name}` : "Export"), provider: "editor", source: "editor", model: row ? `editor:${row.id}` : "editor", extra: row ? { project: row.id, rev: row.rev } : {}, opId });
  } catch (e) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: (e as Error).message.slice(0, 300) });
    throw e;
  }
  if (row) await run(c.env.DB, "UPDATE video_projects SET rendered_video = ?, updated = ?, updated_by = ? WHERE id = ?", stored.video.id, now(), user.id, row.id);
  await updateIntegrationOp(c.env, opId, { status: "done", taskId: stored.video.id });
  const after = row ? await first<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE id = ?", row.id) : null;
  return c.json({ ok: true, video: stored.video, info: stored.info, project: after ? projectItem(after) : null });
});
