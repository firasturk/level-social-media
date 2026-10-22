/**
 * OCR routes, mounted at /api/studio/ocr: is a provider connected, check one post's raw picture
 * (the engine's output in R2) or its final artwork (the composed PNG the browser uploads, since the
 * words are drawn client-side), and list the checks kept for a post. With no Google credential the
 * demo provider answers and every result is labelled connected:false, provider:"demo".
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { first } from "./db";
import type { User } from "@shared/types";
import type { Config } from "@shared/config";
import { ownedPlan } from "./posts";
import { listChecks, resolveOcr, storeCheck } from "./ocr";
import { checkRawImage, compareArtwork, type ExpectedText } from "@shared/ocr-check";

type Variables = { user: User };
export const ocrRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const expectedSchema = z
  .object({
    headline: z.string().max(300).optional(),
    subline: z.string().max(300).optional(),
    price: z.string().max(100).optional(),
    numbers: z.array(z.string().max(100)).max(20).optional(),
    allowed: z.array(z.string().max(200)).max(50).optional(),
  })
  .strip();

const checkSchema = z.object({
  batch: z.string().min(1),
  post: z.coerce.number().int().min(0),
  task: z.string().min(1).optional(),
  kind: z.enum(["raw", "artwork"]),
  expected: expectedSchema.optional(),
  /** A data URL of the composed artwork, for a JSON request that carries no file. */
  image: z.string().optional(),
});

const MAX_UPLOAD = 15 * 1024 * 1024;

ocrRoutes.get("/status", async (c) => {
  const o = await resolveOcr(c.env);
  return c.json({ connected: o.connected, provider: o.provider.name, reason: o.reason });
});

/** The request's fields and file, from multipart or JSON. */
async function readCheckRequest(c: { req: { header(name: string): string | undefined; formData(): Promise<FormData>; json(): Promise<unknown> } }): Promise<{ data: z.infer<typeof checkSchema>; file: { bytes: ArrayBuffer; mime: string } | null }> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const raw: Record<string, unknown> = {};
    for (const k of ["batch", "post", "task", "kind", "image"]) {
      const v = form.get(k);
      if (typeof v === "string" && v !== "") raw[k] = v;
    }
    const expected = form.get("expected");
    if (typeof expected === "string" && expected.trim()) {
      try {
        raw.expected = JSON.parse(expected);
      } catch {
        throw new StudioError("The expected words are not valid JSON.");
      }
    }
    const data = checkSchema.parse(raw);
    const file = form.get("file");
    let bytes: { bytes: ArrayBuffer; mime: string } | null = null;
    if (typeof file === "object" && file !== null && "arrayBuffer" in file) {
      if (!file.type.startsWith("image/") || file.size > MAX_UPLOAD) throw new StudioError("Attach a picture (PNG, JPG or WebP, up to 15 MB).");
      bytes = { bytes: await file.arrayBuffer(), mime: file.type };
    }
    return { data, file: bytes };
  }
  const data = checkSchema.parse(await c.req.json());
  return { data, file: data.image ? dataUrlBytes(data.image) : null };
}

function dataUrlBytes(url: string): { bytes: ArrayBuffer; mime: string } {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url.trim());
  if (!m) throw new StudioError("The artwork must be a base64 image data URL.");
  const bin = atob(m[2]);
  if (bin.length > MAX_UPLOAD) throw new StudioError("The artwork is too large (up to 15 MB).");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out.buffer, mime: m[1].toLowerCase() };
}

interface TaskRow {
  id: string;
  batch: string;
  post: number | null;
  output: string | null;
}

/** The words the brand is allowed to show in a picture: its product names and its own name. */
async function allowedWords(env: Env, config: Config, client: string | null, post: number): Promise<string[]> {
  const p = (config.plan ?? []).find((x) => x.index === post);
  const words = new Set<string>();
  for (const w of [p?.product, ...(p?.products ?? []), ...(p?.offer?.products ?? [])]) if (w?.trim()) words.add(w.trim());
  if (client) {
    const row = await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", client).catch(() => null);
    if (row?.name) words.add(row.name);
  }
  return [...words];
}

ocrRoutes.post("/check", async (c) => {
  const { data, file } = await readCheckRequest(c);
  const b = await ownedPlan(c.env, c.get("user"), data.batch);
  const config = JSON.parse(b.config) as Config;
  const planPost = (config.plan ?? []).find((p) => p.index === data.post);
  const allowed = await allowedWords(c.env, config, b.client, data.post);

  let image: { bytes: ArrayBuffer; mime: string };
  let taskId: string | null = data.task ?? null;
  if (data.kind === "raw") {
    const task = data.task
      ? await first<TaskRow>(c.env.DB, "SELECT id, batch, post, output FROM tasks WHERE id = ? AND batch = ?", data.task, b.id)
      : await first<TaskRow>(c.env.DB, "SELECT id, batch, post, output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1", b.id, data.post);
    if (!task?.output) throw new StudioError("This post has no picture to read yet.", 404);
    const obj = await c.env.BUCKET.get(task.output);
    if (!obj) throw new StudioError("The picture is not in storage.", 404);
    image = { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" };
    taskId = task.id;
  } else {
    if (!file) throw new StudioError("Upload the composed artwork as the file field: the words are drawn in the browser.");
    image = file;
  }

  const o = await resolveOcr(c.env);
  const detected = await o.provider.detect(image);
  const expected: ExpectedText | { allowed: string[] } =
    data.kind === "raw"
      ? { allowed }
      : {
          headline: data.expected?.headline ?? planPost?.headline,
          subline: data.expected?.subline ?? planPost?.subline,
          price: data.expected?.price ?? planPost?.offer?.price,
          numbers: data.expected?.numbers,
          allowed: [...allowed, ...(data.expected?.allowed ?? [])],
        };
  const findings = data.kind === "raw" ? checkRawImage(detected, allowed) : compareArtwork(expected as ExpectedText, detected);
  const check = await storeCheck(c.env, {
    batch: b.id,
    post: data.post,
    task: taskId,
    kind: data.kind,
    provider: o.provider.name,
    connected: o.connected,
    expected,
    detected,
    findings,
  });
  return c.json({ check, findings, connected: o.connected, provider: o.provider.name, reason: o.reason });
});

ocrRoutes.get("/checks", async (c) => {
  const batch = c.req.query("batch");
  const post = Number(c.req.query("post"));
  if (!Number.isInteger(post)) throw new StudioError("A post index is required.");
  const b = await ownedPlan(c.env, c.get("user"), batch);
  const checks = await listChecks(c.env, b.id, post);
  return c.json({ checks });
});
