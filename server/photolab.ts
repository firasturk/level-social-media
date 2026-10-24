/**
 * Photo lab: Freepik's real-photo tools (the Magnific family) applied to a client's approved Drive
 * photos, to a made picture or to an earlier result. Four operations: remove the background,
 * replace it from a prompt, relight, upscale. Each run is a `photolab_jobs` row: the input is copied
 * into the bucket first so the provider reads a stable signed URL, the result is downloaded next to
 * it, and the team then uses it as a post's picture (the previous one kept under Versions) or saves
 * it as a product photo of the month (a `sources` row like a Drive import).
 *
 * With no key saved the demo provider answers: the job completes at once with the input copied to
 * the output, provider "demo", cost 0, and nothing leaves the server.
 *
 * Routes mount at /api/studio/photolab (see studio.ts). Running the lab, saving the key and using a
 * result are admins-only and go through the integration rules in server/integrations.ts (switch,
 * ledger, confirm before spend, no duplicate, no retry); listing jobs and serving pictures stay
 * open to every signed-in user.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { FREEPIK_KEY_SETTING, deleteSetting, getSetting, setSetting } from "./settings";
import {
  assertIntegrationEnabled,
  confirmSchema,
  confirmSpend,
  finishIntegrationOpByTask,
  integrationAccess,
  noRetry,
  proposeOp,
  recordIntegrationOp,
  requireIntegrationAdmin,
  requireIntegrationUser,
  updateIntegrationOp,
} from "./integrations";
import { signObjectUrl } from "./signed";
import { ownedPlan } from "./posts";
import { photoBytes } from "./drive";
import type { ImageBytes } from "./openai";
import type { User } from "@shared/types";
import type { Config } from "@shared/config";
import { PHOTO_LAB_PRICES, type PhotoLabOp } from "@shared/pricing";
import { freeName } from "@shared/drive";
import { stemKey } from "@shared/naming";

/* ───────────── Provider constants: every Freepik path in one place ───────────── */

/**
 * The Freepik API as its documentation describes it in October 2026. docs.freepik.com now redirects
 * to docs.magnific.com, whose reference names the host api.magnific.com and the header
 * x-magnific-api-key; the key is sent under both the new and the former header name so either
 * gateway accepts it. See docs/photo-lab.md for what was read from the docs and what is assumed.
 */
export const FREEPIK = {
  base: "https://api.magnific.com",
  /** The host before the Magnific rebrand; kept for the day the new one refuses a Freepik key. */
  legacyBase: "https://api.freepik.com",
  headerNames: ["x-magnific-api-key", "x-freepik-api-key"] as const,
  /** Synchronous: form-urlencoded image_url → {url, high_resolution, preview, original}. */
  removeBackground: "/v1/ai/beta/remove-background",
  /** Async: JSON {image, prompt, change_background, style…} → data.task_id; GET …/{task-id}. */
  relight: "/v1/ai/image-relight",
  /** Async: JSON {image (base64), scale_factor, optimized_for…} → data.task_id; GET …/{task-id}. */
  upscale: "/v1/ai/image-upscaler",
  /** A stock search, the documented authentication example: valid key → 200, no credits spent. */
  verify: "/v1/resources?limit=1",
} as const;

export const PHOTO_LAB_OPS = ["remove-bg", "background", "relight", "upscale"] as const;
export const OP_LABELS: Record<PhotoLabOp, string> = {
  "remove-bg": "Remove background",
  background: "Replace background",
  relight: "Relight",
  upscale: "Upscale",
};

export const NOT_CONNECTED =
  "Not connected: add a Freepik API key under Connection → Freepik. Until then the Photo lab runs as a demo and changes nothing.";

/* ───────────── Provider adapter ───────────── */

export type ProviderState = "pending" | "done" | "failed";
export interface ProviderTask {
  taskId: string;
  state: ProviderState;
  /** URLs of the results when done (the first one is used). */
  generated: string[];
  error?: string;
}

export interface PhotoInput {
  /** A short-lived public URL of the input in the bucket. */
  url: string;
  bytes: ArrayBuffer;
  mime: string;
}

export interface PhotoProvider {
  readonly name: "freepik" | "demo";
  submit(op: PhotoLabOp, input: PhotoInput, prompt: string): Promise<ProviderTask>;
  status(op: PhotoLabOp, taskId: string): Promise<ProviderTask>;
}

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function mapStatus(s: string | undefined): ProviderState {
  if (s === "COMPLETED") return "done";
  if (s === "FAILED") return "failed";
  return "pending";
}

interface TaskAnswer {
  data?: { task_id?: string; status?: string; generated?: string[] };
}

/** Freepik over fetch; `fetchFn` is injected so a test never reaches the real host. */
export class FreepikClient implements PhotoProvider {
  readonly name = "freepik" as const;
  /** Always a plain call: Workers refuse the global `fetch` invoked as a method of another object ("Illegal invocation"). */
  private readonly fetchFn: typeof fetch;
  constructor(
    private readonly key: string,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = FREEPIK.base,
  ) {
    this.fetchFn = (input, init) => fetchFn(input, init);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    for (const name of FREEPIK.headerNames) h[name] = this.key;
    return h;
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const r = await this.fetchFn(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { message: text.slice(0, 200) };
    }
    if (!r.ok) {
      const msg = String(body.message ?? body.error ?? (body.detail as string) ?? r.statusText ?? "request failed");
      const status = r.status === 401 || r.status === 403 ? 401 : r.status === 402 ? 402 : 502;
      throw new StudioError(`Freepik (${r.status}): ${msg}`, status, r.status === 401 || r.status === 403);
    }
    return body;
  }

  /** One authenticated no-cost call: a valid key lists stock resources; a bad one is refused. */
  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.call(FREEPIK.verify, { method: "GET", headers: this.headers() });
      return { ok: true, message: "Freepik accepted the key." };
    } catch (e) {
      return { ok: false, message: errorMessage(e) };
    }
  }

  async submit(op: PhotoLabOp, input: PhotoInput, prompt: string): Promise<ProviderTask> {
    if (op === "remove-bg") {
      const body = await this.call(FREEPIK.removeBackground, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/x-www-form-urlencoded" }),
        body: new URLSearchParams({ image_url: input.url }).toString(),
      });
      const url = (body.high_resolution ?? body.url) as string | undefined;
      if (!url) throw new StudioError("Freepik returned no picture for the background removal.", 502);
      return { taskId: `sync:${uuid()}`, state: "done", generated: [url] };
    }
    if (op === "upscale") {
      const body = (await this.call(FREEPIK.upscale, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          image: toBase64(input.bytes),
          scale_factor: "2x",
          optimized_for: "films_n_photography",
          creativity: 0,
          resemblance: 0,
          engine: "automatic",
        }),
      })) as TaskAnswer;
      return this.fromTask(body);
    }
    // Relight, and "replace background" which is the relight tool asked to paint a new scene from
    // the prompt (change_background) while the product keeps its shape and print.
    const body = (await this.call(FREEPIK.relight, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        image: input.url,
        prompt,
        change_background: op === "background",
        style: "standard",
        preserve_details: true,
        light_transfer_strength: op === "background" ? 100 : 70,
      }),
    })) as TaskAnswer;
    return this.fromTask(body);
  }

  async status(op: PhotoLabOp, taskId: string): Promise<ProviderTask> {
    if (op === "remove-bg") return { taskId, state: "done", generated: [] };
    const path = op === "upscale" ? FREEPIK.upscale : FREEPIK.relight;
    const body = (await this.call(`${path}/${encodeURIComponent(taskId)}`, { method: "GET", headers: this.headers() })) as TaskAnswer;
    return this.fromTask(body, taskId);
  }

  private fromTask(body: TaskAnswer, fallbackId?: string): ProviderTask {
    const d = body.data ?? {};
    const taskId = d.task_id ?? fallbackId;
    if (!taskId) throw new StudioError("Freepik returned no task id.", 502);
    const state = mapStatus(d.status);
    return { taskId, state, generated: Array.isArray(d.generated) ? d.generated : [], ...(state === "failed" ? { error: "Freepik reported the task as failed." } : {}) };
  }
}

/** The stand-in with no key: nothing is sent anywhere; the result is the input itself. */
export class DemoPhotoProvider implements PhotoProvider {
  readonly name = "demo" as const;
  async submit(): Promise<ProviderTask> {
    return { taskId: `demo:${uuid()}`, state: "done", generated: [] };
  }
  async status(_op: PhotoLabOp, taskId: string): Promise<ProviderTask> {
    return { taskId, state: "done", generated: [] };
  }
}

export interface ResolvedPhotoLab {
  provider: PhotoProvider;
  connected: boolean;
  reason: string;
}

export async function resolvePhotoLab(env: Env, fetchFn: typeof fetch = fetch): Promise<ResolvedPhotoLab> {
  const key = await getSetting(env, FREEPIK_KEY_SETTING);
  if (key) return { provider: new FreepikClient(key, fetchFn), connected: true, reason: "" };
  return { provider: new DemoPhotoProvider(), connected: false, reason: NOT_CONNECTED };
}

/* ───────────── Jobs ───────────── */

export interface JobRow {
  id: string;
  client: string;
  batch: string | null;
  post: number | null;
  op: PhotoLabOp;
  prompt: string;
  input_key: string;
  input_label: string;
  output_key: string | null;
  status: "queued" | "running" | "done" | "failed";
  provider: "freepik" | "demo";
  provider_task: string | null;
  cost: number;
  error: string | null;
  created: number;
  updated: number;
}

const extOf = (mime: string) => (/jpe?g/i.test(mime) ? "jpg" : /webp/i.test(mime) ? "webp" : /svg/i.test(mime) ? "svg" : "png");

/** The job as the UI reads it: its images by route, and the demo label when no key was connected. */
export function jobJson(j: JobRow) {
  const base = `/api/studio/photolab/jobs/${j.id}/image`;
  return {
    id: j.id,
    client: j.client,
    batch: j.batch,
    post: j.post,
    op: j.op,
    opLabel: OP_LABELS[j.op],
    prompt: j.prompt,
    inputLabel: j.input_label,
    status: j.status,
    provider: j.provider,
    demo: j.provider === "demo",
    cost: j.cost,
    error: j.error,
    input: `${base}?which=in`,
    output: j.output_key ? `${base}?which=out&v=${j.updated}` : null,
    created: j.created,
    updated: j.updated,
  };
}
export type JobJson = ReturnType<typeof jobJson>;

async function jobById(env: Env, id: string | undefined): Promise<JobRow> {
  if (!id) throw new StudioError("Job id is required.");
  const j = await first<JobRow>(env.DB, "SELECT * FROM photolab_jobs WHERE id = ?", id);
  if (!j) throw new StudioError("That Photo lab job is gone.", 404);
  return j;
}

async function download(url: string, fetchFn: typeof fetch): Promise<ImageBytes> {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new StudioError(`The result could not be downloaded (${r.status}).`, 502);
  const mime = (r.headers.get("content-type") || "image/png").split(";")[0].trim();
  return { bytes: await r.arrayBuffer(), mime: mime.startsWith("image/") ? mime : "image/png" };
}

/** The result into the bucket and the job marked done; a demo job keeps a copy of its input. */
async function finish(env: Env, job: JobRow, task: ProviderTask, fetchFn: typeof fetch): Promise<JobRow> {
  let result: ImageBytes;
  if (job.provider === "demo" || !task.generated[0]) {
    const obj = await env.BUCKET.get(job.input_key);
    if (!obj) throw new StudioError("The input picture is no longer in storage.", 404);
    result = { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" };
  } else {
    result = await download(task.generated[0], fetchFn);
  }
  const key = `photolab/${job.id}-out.${extOf(result.mime)}`;
  await env.BUCKET.put(key, result.bytes, { httpMetadata: { contentType: result.mime } });
  await run(env.DB, "UPDATE photolab_jobs SET status = 'done', output_key = ?, error = NULL, updated = ? WHERE id = ?", key, now(), job.id);
  // The ledger row that carries this provider task ends with the job; Freepik reports no amount, so the estimate stands.
  if (task.taskId) await finishIntegrationOpByTask(env, "freepik", task.taskId, "done", { reported: job.provider === "demo" ? 0 : null });
  return (await jobById(env, job.id))!;
}

async function fail(env: Env, job: JobRow, error: string): Promise<JobRow> {
  await run(env.DB, "UPDATE photolab_jobs SET status = 'failed', error = ?, updated = ? WHERE id = ?", error.slice(0, 500), now(), job.id);
  if (job.provider_task) await finishIntegrationOpByTask(env, "freepik", job.provider_task, "failed", { note: error.slice(0, 500) });
  return (await jobById(env, job.id))!;
}

/** A running job asked about: the provider is polled once and the job advanced when it moved. */
export async function refreshJob(env: Env, job: JobRow, fetchFn: typeof fetch = fetch): Promise<JobRow> {
  if (job.status !== "running" || !job.provider_task) return job;
  const { provider } = await resolvePhotoLab(env, fetchFn);
  if (provider.name !== job.provider) return fail(env, job, "The connection changed while the job ran: run it again.");
  try {
    const t = await provider.status(job.op, job.provider_task);
    if (t.state === "done") return finish(env, job, t, fetchFn);
    if (t.state === "failed") return fail(env, job, t.error ?? "The provider reported the task as failed.");
    return job;
  } catch (e) {
    return fail(env, job, errorMessage(e));
  }
}

/* ───────────── Routes ───────────── */

type Variables = { user: User };
export const photoLabRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Tests inject a fetch; production uses the global one. */
let fetchForTests: typeof fetch | null = null;
export function usePhotoLabFetch(fn: typeof fetch | null): void {
  fetchForTests = fn;
}
const fetcher = () => fetchForTests ?? fetch;

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** Open to every signed-in user: it says whether the viewer may run the lab (admins, switch on). */
photoLabRoutes.get("/status", async (c) => {
  const r = await resolvePhotoLab(c.env, fetcher());
  const access = await integrationAccess(c.env, c.get("user"), "freepik");
  return c.json({ connected: r.connected, provider: r.provider.name, reason: r.reason, prices: PHOTO_LAB_PRICES, approximate: true, access });
});

/** The key is kept only after Freepik accepted it on a no-cost call. Admins, switch on. */
photoLabRoutes.post("/key", async (c) => {
  const user = requireIntegrationAdmin(c, "freepik");
  await assertIntegrationEnabled(c.env, "freepik");
  const { key } = await body(c, z.object({ key: z.string().trim().min(16).max(400) }));
  const opId = await recordIntegrationOp(c.env, { provider: "freepik", kind: "key.save", user: user.id, estimate: 0, status: "running", note: "Verifying the key with a no-cost call" });
  const check = await new FreepikClient(key, fetcher()).verify();
  if (!check.ok) {
    await updateIntegrationOp(c.env, opId, { status: "failed", note: check.message });
    throw new StudioError(`Freepik rejected this key: ${check.message}`, 400);
  }
  await setSetting(c.env, FREEPIK_KEY_SETTING, key);
  await updateIntegrationOp(c.env, opId, { status: "done", reported: 0, note: "Key saved after Freepik accepted it" });
  return c.json({ ok: true, message: check.message });
});

/** Admins; allowed while the switch is off, so a key can always be taken out. */
photoLabRoutes.delete("/key", async (c) => {
  const user = requireIntegrationAdmin(c, "freepik");
  await deleteSetting(c.env, FREEPIK_KEY_SETTING);
  await recordIntegrationOp(c.env, { provider: "freepik", kind: "key.remove", user: user.id, estimate: 0, reported: 0, status: "done", note: "Key removed: the lab is a demo until a new one is saved" });
  return c.json({ ok: true });
});

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drive"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("task"), batch: z.string().min(1), id: z.string().min(1) }),
  z.object({ kind: z.literal("job"), id: z.string().min(1) }),
]);
type Source = z.infer<typeof sourceSchema>;

const runSchema = z.object({
  client: z.string().min(1).max(120),
  source: sourceSchema,
  op: z.enum(PHOTO_LAB_OPS),
  prompt: z.string().max(1000).optional(),
});

export interface Picked {
  image: ImageBytes;
  label: string;
  batch: string | null;
  post: number | null;
}

/** The input picture: a Drive photo (a 2000px rendition), a post's current picture, or an earlier result. */
async function pickInput(env: Env, user: User, client: string, s: Source): Promise<Picked> {
  if (s.kind === "drive") {
    const image = await photoBytes(env, s.id, 2000);
    const row = await first<{ name: string; file: string; client: string }>(env.DB, "SELECT name, file, client FROM drive_photos WHERE id = ?", s.id).catch(() => null);
    if (row && row.client !== client) throw new StudioError("That Drive photo belongs to another client.", 409);
    return { image, label: row?.name || row?.file || "Drive photo", batch: null, post: null };
  }
  if (s.kind === "task") {
    const b = await ownedPlan(env, user, s.batch);
    const config = JSON.parse(b.config) as Config;
    if ((config.client ?? "") !== client) throw new StudioError("This month belongs to another client.", 409);
    const t = await first<{ id: string; output: string | null; post: number | null }>(env.DB, "SELECT id, output, post FROM tasks WHERE id = ? AND batch = ?", s.id, b.id);
    if (!t?.output) throw new StudioError("This post has no picture yet.", 404);
    const obj = await env.BUCKET.get(t.output);
    if (!obj) throw new StudioError("The picture is not in storage.", 404);
    return {
      image: { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" },
      label: t.post != null ? `Post ${t.post} picture` : "Made picture",
      batch: b.id,
      post: t.post,
    };
  }
  const j = await jobById(env, s.id);
  if (j.client !== client) throw new StudioError("That result belongs to another client.", 409);
  if (!j.output_key) throw new StudioError("That job has no result yet.", 409);
  const obj = await env.BUCKET.get(j.output_key);
  if (!obj) throw new StudioError("The result is no longer in storage.", 404);
  return {
    image: { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" },
    label: `${j.input_label} · ${OP_LABELS[j.op]}`,
    batch: j.batch,
    post: j.post,
  };
}

/**
 * Two requests make one run. The first, without an op id, proposes it: the input is checked and
 * the estimate written to the ledger, and {opId, estimate, needsConfirmation: true} comes back
 * with nothing sent to Freepik. The second carries {opId, confirm: true} and runs it once. Both
 * are admins-only and refused while the Freepik switch is off.
 */
export type PhotoLabRun = z.infer<typeof runSchema>;

/** The run's estimate and ledger note, the same for the dialog and the Prompt Box. */
export async function proposePhotoLab(env: Env, user: User, d: PhotoLabRun): Promise<{ opId: string; estimate: number | null; needsConfirmation: true; picked: Picked; lab: ResolvedPhotoLab; kind: string }> {
  const prompt = (d.prompt ?? "").trim();
  if (d.op === "background" && !prompt) throw new StudioError("Describe the new background first.");
  const picked = await pickInput(env, user, d.client, d.source);
  const lab = await resolvePhotoLab(env, fetcher());
  const cost = lab.connected ? PHOTO_LAB_PRICES[d.op] : 0;
  const kind = `photolab.${d.op}`;
  const proposal = await proposeOp(env, {
    provider: "freepik",
    kind,
    user: user.id,
    batch: picked.batch,
    post: picked.post,
    estimate: cost,
    note: `${OP_LABELS[d.op]} on ${picked.label.slice(0, 120)}${lab.connected ? "" : " (demo: nothing is sent)"}`,
  });
  return { ...proposal, picked, lab, kind };
}

photoLabRoutes.post("/run", async (c) => {
  const user = requireIntegrationUser(c, "freepik");
  await assertIntegrationEnabled(c.env, "freepik");
  const d = await body(c, runSchema.merge(confirmSchema));
  if (!d.opId) {
    const p = await proposePhotoLab(c.env, user, d);
    return c.json({ opId: p.opId, estimate: p.estimate, needsConfirmation: true, approximate: true, connected: p.lab.connected, provider: p.lab.provider.name, reason: p.lab.reason });
  }
  const op = await confirmSpend(c.env, { provider: "freepik", user, opId: d.opId, confirm: d.confirm });
  if (op.kind !== `photolab.${d.op}`) throw new StudioError("This confirmation is for another tool: propose the run again.", 409);
  const prompt = (d.prompt ?? "").trim();
  if (d.op === "background" && !prompt) throw new StudioError("Describe the new background first.");
  const picked = await pickInput(c.env, user, d.client, d.source);
  const lab = await resolvePhotoLab(c.env, fetcher());
  const cost = lab.connected ? PHOTO_LAB_PRICES[d.op] : 0;
  const out = await runPhotoLabJob(c.env, d, picked, lab, cost, op.id);
  return c.json({ opId: op.id, job: jobJson(out), connected: lab.connected, provider: lab.provider.name, reason: lab.reason });
});

/** A confirmed Photo lab run: the input stored, the job row written, one submission, the ledger closed on refusal. */
export async function runPhotoLabJob(env: Env, d: PhotoLabRun, picked: Picked, lab: ResolvedPhotoLab, cost: number, opId: string): Promise<JobRow> {
  const prompt = (d.prompt ?? "").trim();
  const id = uuid();
  const inputKey = `photolab/${id}-in.${extOf(picked.image.mime)}`;
  await env.BUCKET.put(inputKey, picked.image.bytes, { httpMetadata: { contentType: picked.image.mime } });
  const t = now();
  await run(
    env.DB,
    "INSERT INTO photolab_jobs (id, client, batch, post, op, prompt, input_key, input_label, status, provider, cost, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
    id,
    d.client,
    picked.batch,
    picked.post,
    d.op,
    prompt,
    inputKey,
    picked.label.slice(0, 200),
    lab.provider.name,
    cost,
    t,
    t,
  );
  let job = await jobById(env, id);
  try {
    const url = lab.connected ? await signObjectUrl(env, inputKey, 2 * 60 * 60 * 1000) : "";
    // One submission: a failure stands (no retry pays twice, no other provider stands in).
    const task = await noRetry(() => lab.provider.submit(d.op, { url, bytes: picked.image.bytes, mime: picked.image.mime }, prompt));
    await run(env.DB, "UPDATE photolab_jobs SET status = 'running', provider_task = ?, updated = ? WHERE id = ?", task.taskId, now(), id);
    await updateIntegrationOp(env, opId, { status: "running", taskId: task.taskId, note: `Job ${id}` });
    job = await jobById(env, id);
    if (task.state === "done") job = await finish(env, job, task, fetcher());
    else if (task.state === "failed") job = await fail(env, job, task.error ?? "The provider refused the picture.");
  } catch (e) {
    job = await fail(env, job, errorMessage(e));
    if (!job.provider_task) await updateIntegrationOp(env, opId, { status: "failed", note: errorMessage(e) });
  }
  return job;
}

photoLabRoutes.get("/jobs", async (c) => {
  const client = c.req.query("client");
  if (!client) throw new StudioError("A client is required.");
  const rows = await all<JobRow>(c.env.DB, "SELECT * FROM photolab_jobs WHERE client = ? ORDER BY created DESC LIMIT 60", client);
  return c.json({ jobs: rows.map(jobJson) });
});

photoLabRoutes.get("/jobs/:id", async (c) => {
  const job = await refreshJob(c.env, await jobById(c.env, c.req.param("id")), fetcher());
  return c.json({ job: jobJson(job) });
});

photoLabRoutes.get("/jobs/:id/image", async (c) => {
  const job = await jobById(c.env, c.req.param("id"));
  const key = c.req.query("which") === "out" ? job.output_key : job.input_key;
  if (!key) throw new StudioError("No result yet.", 404);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw new StudioError("Not found.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/png", "Cache-Control": "private, max-age=604800" },
  });
});

const useSchema = z.discriminatedUnion("as", [
  z.object({ as: z.literal("product"), batch: z.string().min(1), name: z.string().max(120).optional() }),
  z.object({ as: z.literal("picture"), batch: z.string().min(1), post: z.number().int().min(1) }),
]);

/**
 * The result into the month: as a product photo (a `sources` row, like a Drive import: the picture
 * under the owner's source prefix, a name free in the month) or as a post's picture (the task's
 * output replaced; the previous picture kept as a take and with the month's earlier pictures).
 */
photoLabRoutes.post("/jobs/:id/use", async (c) => {
  const user = requireIntegrationUser(c, "freepik");
  await assertIntegrationEnabled(c.env, "freepik");
  const job = await jobById(c.env, c.req.param("id"));
  if (job.status !== "done" || !job.output_key) throw new StudioError("The result is not ready yet.", 409);
  const d = await body(c, useSchema);
  const b = await ownedPlan(c.env, user, d.batch);
  // Nothing is sent to Freepik here; the row only says who took the result into the month.
  await recordIntegrationOp(c.env, { provider: "freepik", kind: `result.${d.as}`, user: user.id, batch: b.id, post: d.as === "picture" ? d.post : job.post, taskId: job.provider_task, estimate: 0, reported: 0, status: "done", note: `Job ${job.id} used as ${d.as === "picture" ? `post ${d.post}'s picture` : "a product photo"}` });
  const config = JSON.parse(b.config) as Config;
  if ((config.client ?? "") !== job.client) throw new StudioError("This month belongs to another client.", 409);
  const obj = await c.env.BUCKET.get(job.output_key);
  if (!obj) throw new StudioError("The result is no longer in storage.", 404);
  const bytes = await obj.arrayBuffer();
  const mime = obj.httpMetadata?.contentType || "image/png";
  const note = `Photo lab: ${OP_LABELS[job.op]}${job.prompt ? ` (${job.prompt.slice(0, 80)})` : ""}${job.provider === "demo" ? " · demo" : ""}`;

  if (d.as === "product") {
    const taken = new Set((await all<{ stem: string }>(c.env.DB, "SELECT stem FROM sources WHERE batch = ?", b.id)).map((r) => r.stem.normalize("NFC").toLowerCase()));
    const wanted = (d.name?.trim() || `${job.input_label.replace(/\.[a-z0-9]{2,5}$/i, "")} ${OP_LABELS[job.op].toLowerCase()}`).trim();
    const free = freeName(wanted, taken);
    const fileName = `${free}.${extOf(mime)}`;
    const stem = stemKey(fileName);
    const id = uuid();
    const key = `${b.owner}/${b.id}/source/${id}`;
    await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
    // The small JPEG copy vision reads; when it cannot be made here the original stands in.
    let referenceKey: string | null = null;
    try {
      const { resizedPicture } = await import("./thumbs");
      const small = await resizedPicture(c.env, key, 720);
      if (small) referenceKey = small.key;
    } catch {
      referenceKey = null;
    }
    await run(
      c.env.DB,
      "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', 'product', ?, ?)",
      id,
      b.id,
      fileName,
      stem,
      key,
      referenceKey,
      mime,
      bytes.byteLength,
      note,
      now(),
    );
    return c.json({ ok: true, source: { id, name: fileName, stem, key, kind: "product", role: "lead", reference_key: referenceKey, note } });
  }

  const t = await first<{ id: string; output: string | null; status: string }>(c.env.DB, "SELECT id, output, status FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, d.post);
  if (!t) throw new StudioError(`Post ${d.post} has no picture slot yet: make its picture once first.`, 409);
  if (["queued", "processing", "finalizing"].includes(t.status)) throw new StudioError("This post is being made: wait for it first.", 409);
  const key = `${b.owner}/${b.id}/output/${t.id}/${uuid()}.${extOf(mime)}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  await run(
    c.env.DB,
    "UPDATE tasks SET output = ?, status = 'ready', error = NULL, edit = NULL, qa = NULL, made_for = NULL, updated = ? WHERE id = ?",
    key,
    now() + 1,
    t.id,
  );
  await run(
    c.env.DB,
    "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, ?, ?, NULL, ?)",
    uuid(),
    b.id,
    d.post,
    t.id,
    key,
    Math.round(job.cost * 1000) / 1000,
    note.slice(0, 500),
    now(),
  );
  if (t.output)
    await run(
      c.env.DB,
      "INSERT INTO month_versions (id, batch, kind, label, outputs, takes, created) VALUES (?, ?, 'snapshot', ?, ?, ?, ?)",
      uuid(),
      b.id,
      `Post ${d.post} before the Photo lab`,
      JSON.stringify({ [String(d.post)]: t.output }),
      JSON.stringify([{ post: d.post, key: t.output, at: now() }]),
      now(),
    );
  return c.json({ ok: true, task: t.id, key, previous: t.output });
});
