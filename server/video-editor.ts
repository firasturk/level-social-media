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
 *   POST /render                  multipart {batch, post, projectId, renderId?, file, preview?, still?, note}: the export
 *                                 stored as a done version with provider = 'editor' (admins, switch, ledger
 *                                 editor.render); with a renderId the job is closed and its version promoted
 *   POST /renders                 {projectId, rev}: a render job of that saved revision (admins, switch)
 *   POST /renders/:id/progress    {progress, phase}: the tab's heartbeat (admins)
 *   POST /renders/:id/fail        {error}: the tab gave up (admins)
 *   GET  /renders?project=        the project's last render jobs (every signed-in user of the month)
 *   POST /reference, GET /reference/:id   "Edit like this video": a reference video copied for analysis (server/video-reference.ts)
 *
 * Render jobs (migration 0076, `video_renders`): the browser renders, so a job is a record of what
 * was asked (the project and the saved revision, its document frozen in the row), the progress the
 * tab reports, and the outcome. A job whose tab stops reporting for RENDER_STALE_MS reads as
 * interrupted: rendering cannot continue without the tab, the person starts it again. When the
 * upload lands the version is promoted to the card unless a newer render or a later explicit choice
 * is there already (`decidePromotion`), and it becomes the client's version unless the client
 * approved the current one: approval stays with the exact version it was given to.
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
import { MAX_VIDEO_FILE, renditionFrom, storeVideoFile, type VideoItem, type VideoRow } from "./video";
import { readMp4 } from "./mp4";
import { referenceRoutes } from "./video-reference";
import { validateProject, type VideoProject } from "@shared/video-project";
import type { User } from "@shared/types";
import type { Approval, Config } from "@shared/config";
import { answeredCurrent } from "@shared/client-hold";

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

/** "Edit like this video": the reference file fetched for analysis (server/video-reference.ts). */
videoEditorRoutes.route("/reference", referenceRoutes);

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

/* ───────────── Render jobs ───────────── */

/** A render whose tab has not reported for this long reads as interrupted. */
export const RENDER_STALE_MS = 90_000;

export type RenderStatus = "rendering" | "uploading" | "done" | "failed" | "interrupted";
export type RenderOutcome = "card" | "review" | "superseded";

export interface VideoRenderRow {
  id: string;
  project: string;
  batch: string;
  post: number;
  project_rev: number;
  document: string;
  status: RenderStatus;
  progress: number;
  phase: string | null;
  video_id: string | null;
  outcome: RenderOutcome | null;
  error: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  created: number;
  updated: number;
  finished: number | null;
  created_by: string;
}

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

/** What the person reads for a job: a running one whose tab went quiet is interrupted. */
export function renderStatus(row: Pick<VideoRenderRow, "status" | "updated">, t = now()): RenderStatus {
  if ((row.status === "rendering" || row.status === "uploading") && t - row.updated > RENDER_STALE_MS) return "interrupted";
  return row.status;
}

export function renderItem(row: VideoRenderRow, t = now()): RenderItem {
  return {
    id: row.id,
    project: row.project,
    projectRev: row.project_rev,
    status: renderStatus(row, t),
    progress: row.progress,
    phase: row.phase,
    videoId: row.video_id,
    outcome: row.outcome,
    error: row.error,
    width: row.width,
    height: row.height,
    duration: row.duration,
    created: row.created,
    updated: row.updated,
    finished: row.finished,
    createdBy: row.created_by,
  };
}

/** The version on the card now, with the render that made it (when an editor render did). */
export interface CardTop {
  id: string;
  rank: number;
  project: string | null;
  rev: number | null;
}

/**
 * Where a finished render goes, decided before anything is written:
 *  - superseded: a version with a higher card rank is there (a render that started later, or an
 *    explicit choice made after this render started), or the card shows a newer revision of the
 *    same project. The version is kept; it replaces nothing.
 *  - review: it goes on the card, but the client answered the version they see (approved it, or
 *    asked for a change), so the client link keeps that version until someone presses "Send for
 *    review" (shared/client-hold.ts).
 *  - card: on the card and the client's version (a post the client has not answered yet).
 */
export function decidePromotion(a: { renderStart: number; project: string; rev: number; top: CardTop | null; clientAnswered: boolean }): RenderOutcome {
  if (a.top && (a.top.rank > a.renderStart || (a.top.project === a.project && a.top.rev !== null && a.top.rev > a.rev))) return "superseded";
  return a.clientAnswered ? "review" : "card";
}

/**
 * Whether the client answered (approved, or asked for a change on) the version they see now: the
 * clip by id, or the picture when no clip is theirs. The answer belongs to the exact version the
 * reviewer saw (the review page sends its id); one recorded before versions were sent is taken as
 * about the current version, the safe reading.
 */
export function clientAnswered(approval: Approval | null | undefined, clientVideoId: string | null): boolean {
  return answeredCurrent(approval, clientVideoId);
}

async function cardTop(env: Env, batch: string, post: number): Promise<CardTop | null> {
  const top = await first<{ id: string; card_rank: number }>(env.DB, "SELECT id, card_rank FROM videos WHERE batch = ? AND post = ? AND status = 'done' AND key IS NOT NULL AND card_rank IS NOT NULL ORDER BY card_rank DESC LIMIT 1", batch, post);
  if (!top) return null;
  const r = await first<{ project: string; project_rev: number }>(env.DB, "SELECT project, project_rev FROM video_renders WHERE video_id = ? LIMIT 1", top.id);
  return { id: top.id, rank: top.card_rank, project: r?.project ?? null, rev: r?.project_rev ?? null };
}

/**
 * The finished render's version put where it belongs (see `decidePromotion`). The card's rank is
 * written with a guard, so two uploads landing together cannot both win: the one whose render
 * started later keeps the card.
 */
export async function promoteRender(env: Env, b: { id: string; config: string }, render: Pick<VideoRenderRow, "project" | "project_rev" | "created" | "post">, videoId: string): Promise<RenderOutcome> {
  const top = await cardTop(env, b.id, render.post);
  const client = await first<{ id: string }>(env.DB, "SELECT id FROM videos WHERE batch = ? AND post = ? AND for_client = 1 AND status = 'done' LIMIT 1", b.id, render.post);
  let approval: Approval | undefined;
  try {
    approval = (JSON.parse(b.config) as Config).approvals?.[String(render.post)];
  } catch {
    approval = undefined;
  }
  const outcome = decidePromotion({ renderStart: render.created, project: render.project, rev: render.project_rev, top, clientAnswered: clientAnswered(approval, client?.id ?? null) });
  if (outcome === "superseded") return outcome;
  const t = now();
  const r = await env.DB.prepare("UPDATE videos SET card_rank = ?, updated = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM videos WHERE batch = ? AND post = ? AND id != ? AND card_rank > ?)")
    .bind(render.created, t, videoId, b.id, render.post, videoId, render.created)
    .run();
  if ((r.meta?.changes ?? 0) === 0) return "superseded";
  if (outcome === "card") {
    await run(env.DB, "UPDATE videos SET for_client = 0, updated = ? WHERE batch = ? AND post = ? AND for_client = 1 AND id != ?", t, b.id, render.post, videoId);
    await run(env.DB, "UPDATE videos SET for_client = 1, updated = ? WHERE id = ?", t, videoId);
  }
  return outcome;
}

async function renderRow(env: Env, user: User, id: string): Promise<VideoRenderRow> {
  const row = await first<VideoRenderRow>(env.DB, "SELECT * FROM video_renders WHERE id = ?", id);
  if (!row) throw new StudioError("Render not found.", 404);
  await ownedPlan(env, user, row.batch);
  return row;
}

const readRender = async (env: Env, id: string) => (await first<VideoRenderRow>(env.DB, "SELECT * FROM video_renders WHERE id = ?", id))!;

/** A render job of a saved revision: the tab renders it next. The project must be saved at that revision. */
videoEditorRoutes.post("/renders", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const d = await parseBody(c, z.object({ projectId: z.string().min(1), rev: z.number().int().min(1) }));
  const { row, batch } = await projectRow(c.env, user, d.projectId);
  if (row.rev !== d.rev) throw new StudioError(`Save the draft first: the project is at save ${row.rev}, this tab has ${d.rev}.`, 409, false, { rev: row.rev, stale: true });
  const doc = parseDoc(row);
  if (!doc) throw new StudioError("This project's document cannot be read.", 409);
  if (!doc.clips.length) throw new StudioError("The timeline is empty: add a clip first.");
  const id = uuid();
  const t = now();
  await run(c.env.DB, "INSERT INTO video_renders (id, project, batch, post, project_rev, document, status, progress, phase, created, updated, created_by) VALUES (?, ?, ?, ?, ?, ?, 'rendering', 0, 'starting', ?, ?, ?)", id, row.id, batch.id, row.post, row.rev, row.project, t, t, user.id);
  return c.json({ ok: true, render: renderItem(await readRender(c.env, id)), document: { ...doc, rev: row.rev } });
});

/** The tab's heartbeat: how far the render is. A job read as interrupted comes back when its tab reports again. */
videoEditorRoutes.post("/renders/:id/progress", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  const d = await parseBody(c, z.object({ progress: z.number().min(0).max(1), phase: z.string().max(40).optional() }));
  const row = await renderRow(c.env, user, c.req.param("id"));
  if (row.status === "done" || row.status === "failed") return c.json({ ok: true, render: renderItem(row) });
  const status: RenderStatus = d.phase === "uploading" ? "uploading" : "rendering";
  await run(c.env.DB, "UPDATE video_renders SET status = ?, progress = ?, phase = ?, updated = ? WHERE id = ? AND status NOT IN ('done', 'failed')", status, d.progress, d.phase ?? row.phase, now(), row.id);
  return c.json({ ok: true, render: renderItem(await readRender(c.env, row.id)) });
});

/** The tab could not finish (an encoder error, a stop): the job keeps the reason; the card keeps its video. */
videoEditorRoutes.post("/renders/:id/fail", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  const d = await parseBody(c, z.object({ error: z.string().max(400) }));
  const row = await renderRow(c.env, user, c.req.param("id"));
  if (row.status !== "done") await run(c.env.DB, "UPDATE video_renders SET status = 'failed', error = ?, updated = ?, finished = ? WHERE id = ?", d.error || "The render stopped.", now(), now(), row.id);
  return c.json({ ok: true, render: renderItem(await readRender(c.env, row.id)) });
});

/** A project's last jobs, newest first; a job whose tab went quiet is written down as interrupted. */
videoEditorRoutes.get("/renders", async (c) => {
  const user = c.get("user");
  const { row } = await projectRow(c.env, user, c.req.query("project") ?? "");
  const t = now();
  await run(c.env.DB, "UPDATE video_renders SET status = 'interrupted' WHERE project = ? AND status IN ('rendering', 'uploading') AND updated < ?", row.id, t - RENDER_STALE_MS);
  const rows = await all<VideoRenderRow>(c.env.DB, "SELECT * FROM video_renders WHERE project = ? ORDER BY created DESC LIMIT 10", row.id);
  return c.json({ ok: true, renders: rows.map((r) => renderItem(r, t)) });
});

/**
 * The export the browser rendered, stored as a finished version of the post with the same checks
 * as an upload (MP4, H.264; AAC and faststart noted). The project remembers the version it made.
 * With a render job: the file must have the size its frozen revision asks for, the job is closed,
 * and the version is promoted (`promoteRender`). Without one (an older tab): stored, and the
 * client's version only when the post has none, as before.
 */
videoEditorRoutes.post("/render", async (c) => {
  const user = requireIntegrationAdmin(c, PROVIDER);
  await assertIntegrationEnabled(c.env, PROVIDER);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new StudioError("Send the export as a form upload.");
  const batch = String(form.get("batch") ?? "");
  const post = Number(form.get("post") ?? 0);
  const projectId = String(form.get("projectId") ?? "");
  const renderId = String(form.get("renderId") ?? "");
  const note = String(form.get("note") ?? "").slice(0, 200);
  const file = form.get("file");
  if (!(file instanceof File)) throw new StudioError("Attach the mp4 as 'file'.");
  if (file.size > MAX_VIDEO_FILE) throw new StudioError("The export is too large (60 MB at most). Pick a smaller bit rate or a shorter cut.");
  if (!Number.isInteger(post) || post < 1) throw new StudioError("Post index is required.");
  const b = await ownedPlan(c.env, user, batch);
  const row = projectId ? await first<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE id = ? AND batch = ? AND post = ?", projectId, b.id, post) : null;
  if (projectId && !row) throw new StudioError("Project not found on this post.", 404);
  const job = renderId ? await first<VideoRenderRow>(c.env.DB, "SELECT * FROM video_renders WHERE id = ? AND batch = ? AND post = ?", renderId, b.id, post) : null;
  if (renderId && !job) throw new StudioError("Render not found on this post.", 404);
  if (job && row && job.project !== row.id) throw new StudioError("This render belongs to another project.", 409);
  if (job?.status === "done") throw new StudioError("This render was stored already.", 409);
  const rev = job?.project_rev ?? row?.rev ?? 0;
  const fail = async (message: string) => {
    if (job) await run(c.env.DB, "UPDATE video_renders SET status = 'failed', error = ?, updated = ?, finished = ? WHERE id = ?", message.slice(0, 400), now(), now(), job.id);
  };
  // The file must be the size the frozen revision asks for: the frame chosen in the editor is the frame encoded.
  if (job) {
    const want = (JSON.parse(job.document) as VideoProject).output;
    const info = readMp4(await file.arrayBuffer());
    if (info.width && info.height && (info.width !== want.width || info.height !== want.height)) {
      const message = `The rendered file is ${info.width}×${info.height} but the project asks for ${want.width}×${want.height}.`;
      await fail(message);
      throw new StudioError(message);
    }
  }
  const opId = await recordIntegrationOp(c.env, { provider: PROVIDER, kind: "editor.render", user: user.id, batch: b.id, post, estimate: 0, status: "running", note: `Export${row ? ` of "${row.name}" (save ${rev})` : ""} rendered in the browser · ${Math.round(file.size / 1024)} KB` });
  let stored: { video: VideoItem; info: ReturnType<typeof readMp4> };
  try {
    stored = await storeVideoFile(c.env, user, b, {
      file,
      index: post,
      note: note || (row ? `Export of ${row.name}` : "Export"),
      provider: "editor",
      source: "editor",
      model: row ? `editor:${row.id}` : "editor",
      extra: row ? { project: row.id, rev, ...(job ? { render: job.id } : {}) } : {},
      opId,
      // The still (the render's own frame, the poster) and the light preview, made by the tab.
      rendition: renditionFrom(form),
      autoSelect: !job,
    });
  } catch (e) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: (e as Error).message.slice(0, 300) });
    await fail((e as Error).message);
    throw e;
  }
  let outcome: RenderOutcome | null = null;
  if (job) {
    outcome = await promoteRender(c.env, b, job, stored.video.id);
    await run(
      c.env.DB,
      "UPDATE video_renders SET status = 'done', progress = 1, phase = 'done', video_id = ?, outcome = ?, error = NULL, width = ?, height = ?, duration = ?, updated = ?, finished = ? WHERE id = ?",
      stored.video.id,
      outcome,
      stored.info.width,
      stored.info.height,
      stored.info.duration,
      now(),
      now(),
      job.id,
    );
  }
  if (row) await run(c.env.DB, "UPDATE video_projects SET rendered_video = ?, updated = ?, updated_by = ? WHERE id = ?", stored.video.id, now(), user.id, row.id);
  await updateIntegrationOp(c.env, opId, { status: "done", taskId: stored.video.id });
  const after = row ? await first<VideoProjectRow>(c.env.DB, "SELECT * FROM video_projects WHERE id = ?", row.id) : null;
  const video = (await first<VideoRow>(c.env.DB, "SELECT * FROM videos WHERE id = ?", stored.video.id))!;
  return c.json({ ok: true, video: { ...stored.video, forClient: video.for_client === 1 }, info: stored.info, project: after ? projectItem(after) : null, render: job ? renderItem(await readRender(c.env, job.id)) : null, outcome });
});
