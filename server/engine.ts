/**
 * Batch engine: moves tasks through queued -> processing -> finalizing -> ready/review/failed.
 * It is driven from three places with the same function: the client's periodic tick,
 * the engine webhook, and the Worker cron trigger, so a batch keeps moving with the tab closed.
 * Every state transition is an atomic conditional UPDATE, so concurrent drivers never
 * submit the same task twice or store the same result twice.
 */
import type { Env } from "./env";
import { concurrency } from "./env";
import { all, first, run, now, uuid } from "./db";
import { fingerprint, postReferenceKeys, traceEvent } from "./trace";
import { HiggsfieldClient, downloadImage, type GenerationJob } from "./higgsfield";
import { manualQA, reviewWithGoogle, reviewWithOpenAI } from "./review";
import { facesIn, fixNote, parsePostReview, parsePreflight, POST_REVIEW_SCHEMA, postReviewInstruction, PREFLIGHT_SCHEMA, preflightInstruction, type FlagKind } from "@shared/qa";

/**
 * Findings a second take fixes by itself: hard faults only (a wrong product, writing, an invented
 * item, a bag, foreign food). Judgment calls (grid tile, staging, size, the brand's look, a look-alike,
 * a face that looks generated) stay review notes: on a grid month they fired on most pictures and
 * doubled the cost. One automatic take per post per month, whatever the team regenerates by hand.
 */
const SELF_FIX = new Set<FlagKind>(["product", "text", "invented", "bag", "foreign"]);
export const MAX_AUTO_TAKES = 1;
/** The flags of an automated review that a second take fixes by itself; an OCR flag is a note for the team, never a retake. */
export function selfFixable(qa: QA): PostFlag[] {
  return qa.automated ? (qa.flags ?? []).filter((f) => SELF_FIX.has(f.kind) && !isOcrFlag(f)) : [];
}
import { ocrReviewFlags } from "./ocr";
import { isOcrFlag } from "@shared/ocr-check";
import type { PostFlag } from "@shared/qa";
import { holdUncertain, releaseSpend, reserveSpend, spendFits } from "./spend";
import { PREVIEW_MESSAGE, previewNoImages } from "./env";
import { demoAnswer, demoMode } from "./demo";

/** The client's earlier picture this one looks like ("October 2026 · post 4"), when their fingerprints sit within a few bits. */
async function lookAlike(env: Env, batch: BatchRow, task: TaskRow, phash: string): Promise<string | null> {
  if (!batch.client) return null;
  const rows = await all<{ id: string; post: number | null; month: string | null; batch: string; phash: string }>(
    env.DB,
    "SELECT t.id, t.post, b.month, t.batch, t.phash FROM tasks t JOIN batches b ON b.id = t.batch WHERE b.client = ? AND b.deleted IS NULL AND t.phash IS NOT NULL AND t.output IS NOT NULL AND t.id != ? AND NOT (t.batch = ? AND t.post = ?) ORDER BY t.updated DESC LIMIT 400",
    batch.client,
    task.id,
    batch.id,
    task.card,
  );
  let best: { row: (typeof rows)[number]; d: number } | null = null;
  for (const row of rows) {
    const d = hashDistance(phash, row.phash);
    if (d <= 8 && (!best || d < best.d)) best = { row, d };
  }
  if (!best) return null;
  const where = best.row.batch === batch.id ? "this month" : best.row.month ? monthLabel(best.row.month) : "an earlier month";
  return `${where} · post ${best.row.post ?? "?"}`;
}
import { estimateCost } from "@shared/pricing";
import { notify } from "./notify";
import { rememberLesson, rememberLessons } from "./lessons";
import { hashDistance, pictureHash, resizedPicture } from "./thumbs";
import {
  StudioError,
  errorMessage,
  isFatalEngineError,
  isTransientEngineError,
  isDailyQuota,
  isRateLimit,
  retryAfterMs,
  isCreditsDepleted,
  creditsMessage,
} from "./errors";
import {
  buildPrompt,
  buildCompactPrompt,
  buildEditorialPrompt,
  buildNoPromptPrompt,
  RECENTER_SUFFIX,
  type PromptImages,
} from "@shared/prompts";
import {
  buildBriefWithGoogle,
  buildBriefWithOpenAI,
  builderInstruction,
  imageParts,
  parseBrief,
  SCHEMA as BUILDER_SCHEMA,
  planRun,
  type EditorialBrief,
  type EditorialRequest,
  askVisionGoogle,
  askVisionOpenAI,
  FRAMING_CHECK_INSTRUCTION,
  FRAMING_SCHEMA,
  parseFramingCheck,
  SCENE_READ_INSTRUCTION,
  SCENE_SCHEMA,
  parseSceneNotes,
  POSE_READ_INSTRUCTION,
  POSE_SCHEMA,
  parsePoseNotes,
  type Framing,
  wordCount,
  ZAID_MAX_WORDS,
  ZAID_MIN_WORDS,
  type FramingCheck,
} from "./editorial";
import { FABRIC_CARD, isNoPrompt, NP_BACKGROUNDS, NP_POSES, ratioForFormat, type Config } from "@shared/config";
import { buildPostPrompt, monthLabel, tileWithoutBags, type PostBrief, splitEdit, tileForPeople } from "@shared/posts";
import { parseDirectionRules, ruleOn } from "@shared/direction-rules";
import type { QA } from "@shared/types";
import {
  getSetting,
  resolveEngineKey,
  resolveEngineModel,
  resolveFalKey,
  resolveGoogleKey,
  resolveGoogleAuth,
  resolveOpenAIKey,
  setSetting,
  resolveAnthropicKey,
} from "./settings";
import { tryClaude } from "./anthropic";
import { GoogleImageClient, isGoogleModel } from "./google";
import { VertexImageClient } from "./vertex";
import { FalClient, decodeFalHandle, encodeFalHandle, isFalModel } from "./fal";
import { signObjectUrl } from "./signed";
import {
  isChildSubject,
  isContentPolicyError,
  sanitizeChildPrompt,
  sanitizePrompt,
} from "@shared/safety";
import { productKey, shotNumber } from "@shared/naming";
import { resolveSkill } from "./skills";
import { centeringApplies } from "@shared/prompts";
import { OPENAI_MODELS, OpenAIImageClient, isOpenAIModel, type ImageBytes } from "./openai";

interface BatchRow {
  id: string;
  owner: string;
  client: string | null;
  config: string;
  state: string;
}

interface TaskRow {
  id: string;
  batch: string;
  source: string;
  card: number;
  status: string;
  /** Engine override for this image after a content checker refused it on the batch's engine. */
  model: string | null;
  output: string | null;
  error: string | null;
  output_engine_url: string | null;
  edit: string | null;
  attempts: number;
  recenter: number;
  /** What the preflight changed in the brief before the engine was paid (JSON {at, notes}), null until it ran. */
  preflight: string | null;
  request_id: string | null;
  leased_at: number | null;
  updated: number;
  prompt: string;
  brief: string | null;
  /** Automatic second takes this post already had this month (never reset by a regenerate). */
  auto_retries: number;
  /** The post this picture is for (a post month), and the post's revision it is being made for. */
  post: number | null;
  making_for: number | null;
}

interface SourceRow {
  id: string;
  name: string;
  key: string;
  reference_key: string | null;
  mime: string;
  engine_url: string | null;
  /** Verified crop, stored after the first framing check: "LOWER_BODY|true|jeans, sneakers". */
  framing: string | null;
  /** Per-photo skill inside a Zaid creative direction batch; null = the batch's skill. */
  skill: string | null;
}

const SUBMIT_TIMEOUT_MS = 3 * 60 * 1000; // processing without a request id for this long = lost (page reload, dropped tick)
const FAL_PARALLEL = 24;
const BUILDER_PARALLEL = 8; // prompts being written at once, across all ticks and the cron (reference copies are 1600 px)
const WRITING = "Writing the prompt…";
const WRITING_STALE_MS = 4 * 60 * 1000; // a prompt "being written" this long belongs to a cut-off invocation
const ENGINE_TIMEOUT_MS = 45 * 60 * 1000; // engine still pending after this = give up
const OPENAI_TIMEOUT_MS = 12 * 60 * 1000; // a synchronous OpenAI edit is lost after this
const FINALIZE_TIMEOUT_MS = 2 * 60 * 1000; // finalizing this long = the saving job was cut off
const GOOGLE_TIMEOUT_MS = 20 * 60 * 1000; // a standard-tier Google generation still pending after this = give up
const MAX_AUTO_ATTEMPTS = 2; // one automatic retry for transient engine failures / off-centre

export function keyLooksValid(key: string | null | undefined): key is string {
  return !!key && /^[^:\s]+:[^:\s]+$/.test(key);
}

/**
 * The model a batch can run on now: its own when that vendor is connected, otherwise the first
 * connected vendor's default (Google, then OpenAI, then Higgsfield). Null when nothing is connected.
 */
export async function connectedModel(env: Env, model: string | undefined): Promise<string | null> {
  const slug = model || (await resolveEngineModel(env));
  const google = !!(await resolveGoogleAuth(env)).auth;
  const openai = !!(await resolveOpenAIKey(env)).key;
  const fal = !!(await resolveFalKey(env)).key;
  const higgsfield = await engineConfigured(env);
  const ok = isGoogleModel(slug)
    ? google
    : isOpenAIModel(slug)
      ? openai
      : isFalModel(slug)
        ? fal
        : higgsfield;
  if (ok) return slug;
  if (google) return "gemini-3-pro-image";
  if (openai) return OPENAI_MODELS[0].slug;
  if (higgsfield) return env.HIGGSFIELD_MODEL || "nano-banana-pro";
  return null;
}

export async function engineConfigured(env: Env): Promise<boolean> {
  return keyLooksValid((await resolveEngineKey(env)).key);
}

export async function makeClient(
  env: Env,
  key?: string,
  model?: string,
): Promise<HiggsfieldClient> {
  const apiKey = key ?? (await resolveEngineKey(env)).key;
  if (!apiKey)
    throw new StudioError("Higgsfield is not connected. Add the API key in Connection.", 428, true);
  return new HiggsfieldClient({
    apiKey,
    baseUrl: env.HIGGSFIELD_BASE_URL || "https://api.higgsfield.ai",
    model: model || (await resolveEngineModel(env)),
  });
}

function webhookUrl(env: Env, batchId: string): string | undefined {
  if (!env.PUBLIC_BASE_URL || !env.WEBHOOK_TOKEN) return undefined;
  const u = new URL("/api/hooks/engine", env.PUBLIC_BASE_URL);
  u.searchParams.set("token", env.WEBHOOK_TOKEN);
  u.searchParams.set("batch", batchId);
  return u.toString();
}

export type Background = (p: Promise<unknown>) => void;

/**
 * How a driver wants synchronous engines (OpenAI, Google standard tier) handled. Their generation
 * runs inside the Worker, and a request's waitUntil is cut off ~30 s after the response, so only
 * a driver that keeps its connection open (the client tick, held until the jobs settle) or the
 * cron (15 min budget) may start them. Quick mutations defer them to the next tick.
 */
export interface DriveOptions {
  background?: Background;
  deferSync?: boolean;
  /**
   * Until when a finished synchronous image refills its slot with the next queued one, so the
   * engine runs as a rolling pipeline (six in flight) instead of rounds that wait for the slowest.
   * Set by advanceBatch on the first call; the next tick or cron carries on after it.
   */
  refillUntil?: number;
}

/** How long one tick or cron pass keeps refilling slots as images finish. */
const REFILL_BUDGET_MS = 4 * 60 * 1000;

/** Either Google path: Vertex (the Cloud project's credits) when connected, else the AI Studio key. */
export type GoogleEngine = GoogleImageClient | VertexImageClient;

export async function makeGoogleClient(env: Env, key?: string): Promise<GoogleEngine> {
  if (key) return new GoogleImageClient(key);
  const { auth } = await resolveGoogleAuth(env);
  if (!auth)
    throw new StudioError(
      "Google is not connected. Add the AI Studio key or the Google Cloud service account in Connection.",
      428,
      true,
    );
  return "vertex" in auth ? new VertexImageClient(auth.vertex) : new GoogleImageClient(auth.key);
}

/** The AI Studio client only (background Flex jobs exist there alone). */
export async function makeGoogleApiClient(env: Env): Promise<GoogleImageClient> {
  const apiKey = (await resolveGoogleKey(env)).key;
  if (!apiKey)
    throw new StudioError("Google is not connected. Add the API key in Connection.", 428, true);
  return new GoogleImageClient(apiKey);
}

export async function makeFalClient(env: Env, key?: string): Promise<FalClient> {
  const apiKey = key ?? (await resolveFalKey(env)).key;
  if (!apiKey)
    throw new StudioError("fal.ai is not connected. Add the API key in Connection.", 428, true);
  return new FalClient(apiKey);
}

export async function makeOpenAIClient(env: Env, key?: string): Promise<OpenAIImageClient> {
  const apiKey = key ?? (await resolveOpenAIKey(env)).key;
  if (!apiKey)
    throw new StudioError("OpenAI is not connected. Add the API key in Connection.", 428, true);
  return new OpenAIImageClient(apiKey);
}

/**
 * Advance one batch as far as it can go right now. Safe to call concurrently.
 * `background` (waitUntil) lets synchronous engines finish after the HTTP response; without it they run inline.
 */
export async function advanceBatch(
  env: Env,
  batchId: string,
  options: DriveOptions = {},
): Promise<void> {
  const batch = await first<BatchRow>(
    env.DB,
    "SELECT id, owner, client, config, state FROM batches WHERE id = ?",
    batchId,
  );
  if (!batch) return;
  const config = JSON.parse(batch.config) as Config;
  // A batch saved without a model means "the default at the time it runs"; routing (Google /
  // OpenAI / Higgsfield) keys off the slug, so resolve it before anything looks at it.
  if (!config.model) config.model = await resolveEngineModel(env);

  await finalizeInFlight(env, batch, config);

  if (batch.state === "running") {
    await submitNext(env, batch, config, { ...options, refillUntil: options.refillUntil ?? now() + REFILL_BUDGET_MS });
    await settleIdle(env, batch, config);
  }
}

async function finalizeInFlight(env: Env, batch: BatchRow, config: Config): Promise<void> {
  const inflight = await all<TaskRow>(
    env.DB,
    "SELECT * FROM tasks WHERE batch = ? AND status IN ('processing','finalizing') ORDER BY leased_at",
    batch.id,
  );
  if (!inflight.length) return;
  const client = (await engineConfigured(env)) ? await makeClient(env) : null;

  for (const task of inflight) {
    const age = now() - (task.leased_at ?? now());
    if (task.status === "finalizing") {
      // A saving job that never reported back (the isolate was evicted mid-way). Synchronous
      // engines lose the bytes, so the task fails with its previous result kept; polled engines
      // still hold the image, so the task goes back to processing and is fetched again.
      if (now() - task.updated < FINALIZE_TIMEOUT_MS) continue;
      if (!task.request_id || task.request_id.startsWith("sync:"))
        await failTask(
          env,
          task,
          "Saving the result was interrupted. Retry this image.",
          task.output,
        );
      else
        await run(
          env.DB,
          "UPDATE tasks SET status = 'processing', updated = ? WHERE id = ? AND status = 'finalizing'",
          now(),
          task.id,
        );
      continue;
    }
    if (!task.request_id) {
      // The submission died with the request that carried it (a page reload, a closed tab, a dropped
      // connection). Put it back in the queue automatically; only repeated losses fail the image.
      if (age > SUBMIT_TIMEOUT_MS) {
        console.error("[lost submission]", {
          task: task.id,
          batch: batch.id,
          attempts: task.attempts,
          lastStage: task.error,
        });
        // An interrupted submission may or may not have reached the vendor: its cost and
        // reservation stay, counted as uncertain for reconciliation, and it gets more automatic
        // tries than an engine failure.
        const estimate =
          estimateCost(taskConfig(config, task), 1, [task.card]).total +
          (task.edit || task.recenter ? 0.008 : 0);
        await holdUncertain(env, batch.id, estimate);
        if (task.attempts <= MAX_AUTO_ATTEMPTS + 2)
          await requeue(env, task, "submission was interrupted, starting again");
        else
          await failTask(env, task, "Submission was interrupted. Retry this image.", task.output);
      }
      continue;
    }
    if (task.request_id.startsWith("google:")) {
      await finalizeGoogleFlex(env, batch, config, task);
      continue;
    }
    if (task.request_id.startsWith("fal:")) {
      await finalizeFal(env, batch, config, task);
      continue;
    }
    if (task.request_id.startsWith("openai:") || task.request_id.startsWith("sync:")) {
      // Synchronous engine: the background job finalises the task itself; only guard against a lost isolate.
      if (age > OPENAI_TIMEOUT_MS)
        await failTask(
          env,
          task,
          "The picture was cut off while it was being made (the server restarted). Retry this image.",
          task.output,
        );
      continue;
    }
    if (!client) continue;
    let status;
    try {
      status = await client.status(task.request_id);
    } catch (e) {
      // A transient status error is retried on the next tick; a fatal one pauses the batch.
      if (isFatalEngineError(e)) await pauseBatch(env, batch.id, errorMessage(e));
      continue;
    }
    if (status.state === "pending") {
      if (age > ENGINE_TIMEOUT_MS)
        await failTask(
          env,
          task,
          "The engine did not finish in time. Retry this image.",
          task.output,
        );
      continue;
    }
    if (status.state === "failed") {
      // The vendor accepted the request and failed later: whether it billed is not known.
      if (!isContentPolicyError(status.message)) await holdUncertain(env, batch.id, estimateCost(taskConfig(config, task), 1, [task.card]).total);
      if (
        isContentPolicyError(status.message) &&
        (await retryAfterRefusal(env, taskConfig(config, task), task, status.message))
      )
        continue;
      if (status.retryable && task.attempts < MAX_AUTO_ATTEMPTS)
        await requeue(env, task, status.message);
      else await failTask(env, task, status.message, task.output);
      continue;
    }
    // Claim the finalisation so a concurrent driver does not download and store the same image.
    const claimed = await run(
      env.DB,
      "UPDATE tasks SET status = 'finalizing', updated = ? WHERE id = ? AND status = 'processing' AND request_id = ?",
      now(),
      task.id,
      task.request_id,
    );
    if (!claimed) continue;
    try {
      await storeResult(env, batch, config, task, status.url);
    } catch (e) {
      // Put it back so the next tick retries the download; the engine result still exists.
      await run(
        env.DB,
        "UPDATE tasks SET status = 'processing', error = ?, updated = ? WHERE id = ? AND status = 'finalizing'",
        errorMessage(e, "Could not store the result."),
        now(),
        task.id,
      );
    }
  }
}

async function storeResult(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
  url: string,
): Promise<void> {
  await storeResultBytes(env, batch, config, task, await downloadImage(url), url);
}

/** What one attempt of this task is recorded as costing (the same figure the budget reserved). */
async function attemptCostOf(env: Env, config: Config, task: TaskRow): Promise<number> {
  const cfg = taskConfig(config, task);
  return estimateCost({ ...cfg, model: cfg.model || (await resolveEngineModel(env)) }, 1, [task.card]).total + (task.edit || task.recenter ? 0.008 : 0);
}

/**
 * A take of a post's picture, kept as its own row as it lands or fails: the editor's Versions list,
 * "Previous picture" and the compare read these, so nothing depends on a browser's memory.
 */
async function recordTake(env: Env, batch: BatchRow, task: TaskRow, take: { status: "made" | "failed"; key: string | null; cost: number; note: string }): Promise<void> {
  if (task.post == null) return;
  await run(
    env.DB,
    "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    uuid(),
    batch.id,
    task.post,
    task.id,
    take.status,
    take.key,
    Math.round(take.cost * 1000) / 1000,
    take.note.slice(0, 500),
    task.making_for ?? null,
    now(),
  ).catch((e) => console.error("[takes]", task.id, errorMessage(e)));
}

async function storeResultBytes(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
  result: ImageBytes,
  url: string | null,
): Promise<void> {
  // Exact product mode: the engine painted the place; the real product photo is set into it here.
  // A revision of an exact post edits the finished picture, which already holds the real product.
  let exactNote = "";
  if (config.mode === "post" && !task.edit?.trim() && !task.recenter) {
    const pb = postBrief(task);
    if (pb.exact) {
      // A paid scene is never lost: when the placing fails, the scene is kept and flagged.
      try {
        const product = await first<SourceRow>(env.DB, "SELECT * FROM sources WHERE id = ?", pb.exact.source);
        if (!product) throw new StudioError("the product photo of this post was removed");
        const { placeProduct } = await import("./exact");
        const placed = await placeProduct(env, product, result, pb.product ?? "", batch.id);
        result = placed.image;
        url = null;
        if (!placed.empty) exactNote = "The empty place was not clear: check that nothing stands behind the product.";
      } catch (e) {
        console.error("[exact] placing failed", e);
        exactNote = `The real product could not be placed (${errorMessage(e)}): make it again.`;
      }
    }
  }
  const ext = /jpe?g/i.test(result.mime) ? "jpg" : /webp/i.test(result.mime) ? "webp" : "png";
  const key = `${batch.owner}/${batch.id}/output/${task.id}/${uuid()}.${ext}`;
  await env.BUCKET.put(key, result.bytes, {
    httpMetadata: { contentType: result.mime || "image/png" },
  });
  const phash = await pictureHash(result.bytes);
  // Save the image before the (slow) automatic review so an evicted isolate never loses a paid
  // result; the review then upgrades the status if it is still waiting for it.
  await run(
    env.DB,
    "UPDATE tasks SET status = 'review', output = ?, output_engine_url = ?, qa = ?, edit = NULL, recenter = 0, request_id = NULL, lease = NULL, leased_at = NULL, error = NULL, made_for = making_for, updated = ? WHERE id = ? AND status = 'finalizing'",
    key,
    url,
    JSON.stringify(manualQA("Automatic review still running. Check manually.")),
    now(),
    task.id,
  );
  if (phash) await run(env.DB, "UPDATE tasks SET phash = ? WHERE id = ?", phash, task.id).catch(() => undefined);
  const attemptCost = await attemptCostOf(env, config, task);
  await recordTake(env, batch, task, { status: "made", key, cost: attemptCost, note: task.edit?.trim() ? `Edit: ${task.edit.trim()}` : task.recenter ? "Recentred" : "" });
  void traceEvent(env, { kind: "generation", traceId: batch.id, spanId: task.id, name: "stored", output: { picture: key, engineUrl: url ? "[url]" : null }, model: taskConfig(config, task).model ?? null, cost: attemptCost, metadata: { client: batch.client, post: task.post, revision: task.making_for, references: postReferenceKeys(task.brief), engine: taskConfig(config, task).model ?? null, attempt: task.attempts } });

  let qa: QA;
  if (config.mode === "post") {
    // The review and the OCR read a 1080-px JPEG copy of the picture (made once here, the copy the
    // page shows): a 2K PNG of 6 MB as base64 is too large for Claude and, with six pictures in
    // flight at once, for the isolate's memory (the run of 27 Oct died twice of exceeded memory).
    const reviewBytes: ImageBytes = (await resizedPicture(env, key, 1080).catch(() => null)) ?? result;
    // A post is checked against the real product photo: what changed, writing, bags, drinks, people.
    try {
      qa = await reviewPostImage(env, task, reviewBytes);
      // Every finding is proposed as a lesson with its exact words; it waits for the admin before any prompt carries it.
      if (qa.automated) await rememberLessons(env, batch.client, batch.id, qa.flags).catch((e) => console.error("[lessons]", e));
      if (exactNote) qa = { ...qa, flags: [...(qa.flags ?? []), { kind: "invented", text: exactNote }] };
      // A picture that looks like one of the client's earlier posts (the same composition) is noticed.
      const twin = phash ? await lookAlike(env, batch, task, phash).catch(() => null) : null;
      if (twin) qa = { ...qa, flags: [...(qa.flags ?? []), { kind: "similar", text: `Looks like an earlier picture: ${twin}` }] };
    } catch (e) {
      qa = manualQA(`Automatic review unavailable (${errorMessage(e)}). Check manually.`);
    }
    void traceEvent(env, { kind: "review", traceId: batch.id, spanId: task.id, name: "review", input: { picture: key }, output: { automated: qa.automated, notes: qa.notes, flags: qa.flags ?? [] }, metadata: { client: batch.client, post: task.post, revision: task.making_for, engine: taskConfig(config, task).model ?? null, attempt: task.attempts } });
    // A take that drifted from its idea (the sign is missing, the cup stands alone) is made again once,
    // from the post's original reference with the idea as the note; the drift stays as a lesson.
    const pb = postBrief(task);
    // An automatic retake spends money: it stays inside the month's approved budget.
    const budget = await autoTakeAllowed(env, batch, config, task);
    const drifted = qa.automated && (qa.flags ?? []).some((f) => f.kind === "idea");
    if (drifted && pb.originalRef && !pb.retried && (task.auto_retries ?? 0) < MAX_AUTO_TAKES && budget.ok) {
      const retry: PostBrief = {
        ...pb,
        retried: true,
        styleKey: undefined,
        noRefImage: undefined,
        editRef: {
          key: pb.originalRef,
          note: `Recreate this exact idea, element by element, with the brand's product in it: ${pb.brief.slice(0, 700)}${pb.clientChange ? ` The client asked: "${pb.clientChange.slice(0, 200)}".` : ""} Nothing written appears anywhere.`,
        },
      };
      const done = await run(
        env.DB,
        "UPDATE tasks SET status = 'queued', prompt = ?, brief = ?, qa = ?, edit = NULL, recenter = 0, attempts = 0, request_id = NULL, lease = NULL, leased_at = NULL, error = NULL, auto_retries = auto_retries + 1, updated = ? WHERE id = ? AND status = 'review' AND output = ?",
        buildPostPrompt(retry),
        JSON.stringify(retry),
        JSON.stringify({ ...qa, notes: "Drifted from its idea: being made again from the original reference." }),
        now(),
        task.id,
        key,
      );
      console.log(`[idea] task ${task.id} post ${pb.index} drifted; retry from original reference queued`, done);
      if (done) await rememberLesson(env, batch.client, batch.id, "idea", `Post ${pb.index} drifted from its idea and was made again from its original reference: ${(qa.flags ?? []).find((f) => f.kind === "idea")?.text ?? ""}`, "retry").catch(() => undefined);
      return;
    }
    // Any other mistake the review can name (a wrong product, writing, a bag, foreign food, staging)
    // is fixed once by itself: a fresh take with the findings as the note, as "Fix it" would send it.
    const fixable = selfFixable(qa);
    if (fixable.length && !pb.retried && (task.auto_retries ?? 0) < MAX_AUTO_TAKES && !budget.ok) qa = { ...qa, notes: `${qa.notes ? `${qa.notes} ` : ""}Not made again by itself: ${budget.why}. Press Fix it to make it again.` };
    if (fixable.length && !pb.retried && (task.auto_retries ?? 0) < MAX_AUTO_TAKES && budget.ok) {
      const retry: PostBrief = { ...pb, retried: true };
      const done = await run(
        env.DB,
        "UPDATE tasks SET status = 'queued', brief = ?, edit = ?, qa = ?, recenter = 0, attempts = 0, request_id = NULL, lease = NULL, leased_at = NULL, error = NULL, auto_retries = auto_retries + 1, updated = ? WHERE id = ? AND status = 'review' AND output = ?",
        JSON.stringify(retry),
        fixNote(fixable),
        JSON.stringify({ ...qa, notes: `Being made again by itself: ${fixable.map((f) => f.text).join(" ")}` }),
        now(),
        task.id,
        key,
      );
      console.log(`[self-fix] task ${task.id} post ${pb.index}: ${fixable.map((f) => f.kind).join(",")}`, done);
      if (done) return;
    }
    // Writing read by OCR (when Google Vision is connected) is a review note added after the retake
    // decisions: it never queues a take by itself. A faint reading says "check the writing".
    qa = await ocrReviewFlags(env, batch, task, qa, reviewBytes, [pb.product?.split(":")[0] ?? "", ...(pb.productNames ?? []), ...(pb.extraProducts ?? []).map((x) => x.name)]);
    // A person that looks generated is a review note like any other: the team decides with Fix it.
    // (An automatic second take doubled the time and the cost of every post with people.)
    await run(
      env.DB,
      "UPDATE tasks SET status = ?, qa = ?, updated = ? WHERE id = ? AND status = 'review' AND output = ?",
      qa.automated && !qa.flags?.length ? "ready" : "review",
      JSON.stringify(qa),
      now(),
      task.id,
      key,
    );
    return;
  }
  const googleKey = (await resolveGoogleAuth(env)).auth;
  const openaiKey = googleKey ? null : (await resolveOpenAIKey(env)).key;
  if (googleKey || openaiKey) {
    try {
      const source = await first<SourceRow>(
        env.DB,
        "SELECT * FROM sources WHERE id = ?",
        task.source,
      );
      if (!source) throw new StudioError("Original unavailable for review.");
      const ref = await sourceBytes(env, source);
      // Studio cards must show the same face as card 1.
      let identity: ImageBytes | undefined;
      if (config.mode === "1" && task.card > 1 && task.card < FABRIC_CARD) {
        const firstCard = await first<{ output: string | null }>(
          env.DB,
          "SELECT output FROM tasks WHERE batch = ? AND source = ? AND card = 1",
          batch.id,
          task.source,
        );
        if (firstCard?.output) identity = await outputBytes(env, firstCard);
      }
      try {
        qa = googleKey
          ? await reviewWithGoogle(googleKey, ref, result, task.card === FABRIC_CARD, identity)
          : await reviewWithOpenAI(openaiKey!, ref, result, task.card === FABRIC_CARD, identity);
      } catch (e) {
        const oa = googleKey ? (await resolveOpenAIKey(env)).key : null;
        if (oa && googleUnavailable(e))
          qa = await reviewWithOpenAI(oa, ref, result, task.card === FABRIC_CARD, identity);
        else throw e;
      }
    } catch (e) {
      qa = manualQA(`Automatic review unavailable (${errorMessage(e)}). Check manually.`);
    }
  } else {
    qa = manualQA();
  }
  void traceEvent(env, { kind: "review", traceId: batch.id, spanId: task.id, name: "review", input: { picture: key }, output: { automated: qa.automated, notes: qa.notes, productConcern: qa.productConcern, centered: qa.centered, sameFace: qa.sameFace }, metadata: { client: batch.client, post: task.post, revision: task.making_for, engine: taskConfig(config, task).model ?? null, attempt: task.attempts } });

  const wantsCenter = centeringApplies(config, task.card);
  // An off-centre result is flagged for review, never regenerated on its own: each image is
  // generated once, and a second pass only happens when the team asks for a revision.

  const status = qa.automated
    ? qa.productConcern || qa.sameFace === false || (wantsCenter && !qa.centered)
      ? "review"
      : "ready"
    : "review";
  // Only while nobody approved or re-queued it in the meantime.
  await run(
    env.DB,
    "UPDATE tasks SET status = ?, qa = ?, updated = ? WHERE id = ? AND status = 'review' AND output = ?",
    status,
    JSON.stringify(qa),
    now(),
    task.id,
    key,
  );
}

async function failTask(
  env: Env,
  task: TaskRow,
  message: string,
  previousOutput: string | null,
): Promise<void> {
  // Any earlier result stays visible for review; only a task with nothing to show is marked failed.
  const status = previousOutput ? "review" : "failed";
  await run(
    env.DB,
    "UPDATE tasks SET status = ?, error = ?, edit = NULL, recenter = 0, request_id = NULL, lease = NULL, leased_at = NULL, updated = ? WHERE id = ? AND status IN ('processing','finalizing')",
    status,
    message.slice(0, 500),
    now(),
    task.id,
  );
}

/**
 * A generation attempt that threw: the engine produced nothing, so the recorded attempt cost is
 * refunded; a transient failure gets one automatic retry, anything else fails the task.
 */
async function settleFailedAttempt(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
  e: unknown,
): Promise<void> {
  const refund =
    estimateCost({ ...config, model: config.model || (await resolveEngineModel(env)) }, 1, [
      task.card,
    ]).total + (task.edit || task.recenter ? 0.008 : 0);
  const message = errorMessage(e, "Generation failed.");
  // The reservation is given back only when the vendor is known to have done no work: it rejected
  // the request before generating (a bad request, a rejected key, an empty balance, a missing
  // model, a rate limit). A content refusal may be billed and keeps its cost. A timeout, a dropped
  // connection, a vendor error after it accepted the request or anything unknown keeps the cost
  // and the reservation too, counted as uncertain for reconciliation.
  const billing = attemptBilling(e, message);
  if (billing === "none") {
    await run(env.DB, "UPDATE tasks SET cost = MAX(0, cost - ?) WHERE id = ?", refund, task.id);
    await releaseSpend(env, batch.id, refund);
  } else if (billing === "uncertain") {
    await holdUncertain(env, batch.id, refund);
  }
  if (isCreditsDepleted(e)) {
    await requeue(env, task, creditsMessage(e));
    await pauseBatch(env, batch.id, creditsMessage(e));
    return;
  }
  if (isContentPolicyError(message) && (await retryAfterRefusal(env, config, task, message)))
    return;
  // "IMAGE_RECITATION": the engine judged its picture too close to a published one. One more try
  // asks for an original arrangement; a second refusal fails the post as usual.
  if (/RECITATION/i.test(message) && !/original composition/i.test(task.error ?? "")) {
    await run(
      env.DB,
      "UPDATE tasks SET prompt = prompt || ? WHERE id = ?",
      "\n\nORIGINAL COMPOSITION: this is an original photograph made for this brand, never a reproduction of any published picture: change the exact arrangement, angle, distance and props a little so it is its own picture, keeping the brief, the product and the look.",
      task.id,
    );
    await requeue(env, task, `the engine held its picture back as too close to a published one; trying an original composition. ${message}`);
    return;
  }
  // A vendor rate limit is not the image's fault: new submissions wait as long as the vendor
  // asked, the engine narrows (two fewer at once, never under two) and widens again step by
  // step while the vendor stays quiet; the image keeps its place and gets its attempt back.
  if (isRateLimit(e)) {
    const wait = Math.max(5_000, retryAfterMs(e));
    enginePausedUntil = Math.max(enginePausedUntil, now() + wait);
    narrowAfterRateLimit(env);
    await run(env.DB, "UPDATE tasks SET attempts = MAX(0, attempts - 1) WHERE id = ?", task.id);
    const detail = message.replace(/^.*?\(429\):?\s*/, "").replace(/\s+/g, " ").trim().slice(0, 160);
    await requeue(env, task, `Engine rate limited; retrying in ${Math.round(wait / 1000)} s.${detail ? ` ${detail}` : ""}`);
    return;
  }
  if (isTransientEngineError(e) && task.attempts < MAX_AUTO_ATTEMPTS) {
    await requeue(env, task, message);
    return;
  }
  // The router: an engine that fails this picture for its own reasons hands it to another connected
  // engine once (the batch's choice stays for the other pictures); only then does the post fail.
  if (!task.model && !isFatalEngineError(e) && task.attempts <= MAX_AUTO_ATTEMPTS) {
    const fallback = await contentFallbackModel(env, config.model);
    if (fallback) {
      await run(env.DB, "UPDATE tasks SET model = ? WHERE id = ?", fallback, task.id);
      console.log(`[router] task ${task.id}: ${config.model ?? "the batch engine"} failed (${message.slice(0, 120)}); moving to ${fallback}`);
      await requeue(env, task, `${config.model ?? "the batch engine"} could not make this picture; trying ${fallback}. ${message}`);
      return;
    }
  }
  // The failed attempt is listed with what it cost (nothing when the vendor refused the request
  // before working, its recorded cost otherwise, which may be billed).
  await recordTake(env, batch, task, { status: "failed", key: null, cost: billing === "none" ? 0 : refund, note: message });
  void traceEvent(env, { kind: "generation", traceId: batch.id, spanId: task.id, name: "failed", output: { error: message }, model: config.model ?? null, cost: billing === "none" ? 0 : refund, metadata: { client: batch.client, post: task.post, revision: task.making_for, engine: config.model ?? null, attempt: task.attempts, error: message, billing } });
  if (isFatalEngineError(e) && task.model) {
    // The picture had been handed to another engine (the router); that engine's own trouble (a
    // disabled model, no credits there) fails this picture alone and hands it back to the batch's
    // engine for the next try. The month never stops for an engine it does not run on.
    await run(env.DB, "UPDATE tasks SET model = NULL WHERE id = ?", task.id);
    await failTask(env, task, `${task.model} could not take this picture either: ${message} Retry this image.`, task.output);
    return;
  }
  await failTask(env, task, message, task.output);
  if (isFatalEngineError(e)) await pauseBatch(env, batch.id, message);
}

/**
 * What a failed attempt may have cost. "none": the vendor rejected the request before any work
 * (4xx answers: bad request, key, balance, model, validation, rate limit). "billable": a content
 * refusal, which some vendors charge. "uncertain": a timeout, a dropped connection, a 5xx or
 * anything else, where work may have been done.
 */
export function attemptBilling(e: unknown, message = errorMessage(e)): "none" | "billable" | "uncertain" {
  if (isContentPolicyError(message)) return "billable";
  if (isRateLimit(e) || isCreditsDepleted(e)) return "none";
  if (e instanceof StudioError && (e.status === 428 || /\((400|401|403|404|422)\)/.test(message) || /rejected the (API )?key|not connected|model not found|rejected the request|looks invalid/i.test(message))) return "none";
  return "uncertain";
}

let enginePausedUntil = 0; // after a vendor rate limit, no image is submitted before this time (per isolate)
/** Images in flight at once on Google after its rate limits: 0 = the full width. */
let googleWidth = 0;
let lastRateLimitAt = 0;
let lastWidenAt = 0;
/** A quiet stretch this long widens the engine by one image. */
const WIDEN_AFTER_MS = 45_000;
const MIN_WIDTH = 2;
/**
 * Synchronous Google pictures in flight at once in one isolate: each one holds its 2K result (as
 * base64 and as bytes) and its review copy in memory, and six at once took the isolate past its
 * 128 MB twice on 27 Oct with six, and again with four (the exact-mode cut-outs and the reviews
 * decode the pictures here too). Two keep it inside.
 */
const GOOGLE_SYNC_PARALLEL = 2;
const googleFull = (env: Env) => Math.min(concurrency(env), GOOGLE_SYNC_PARALLEL);

function narrowAfterRateLimit(env: Env): void {
  const current = googleWidth || googleFull(env);
  googleWidth = Math.max(MIN_WIDTH, current - 2);
  lastRateLimitAt = now();
}

/**
 * Google runs at full width until it throttles; then two fewer images at once, and one more
 * again for every quiet stretch, back up to the full width. The width follows the quota
 * instead of collapsing to one image at a time.
 */
function googleParallel(env: Env): number {
  const full = googleFull(env);
  if (!googleWidth) return full;
  if (googleWidth < full && now() - Math.max(lastRateLimitAt, lastWidenAt) > WIDEN_AFTER_MS) {
    googleWidth += 1;
    lastWidenAt = now();
  }
  if (googleWidth >= full) googleWidth = 0;
  return googleWidth || full;
}

async function requeue(env: Env, task: TaskRow, message: string): Promise<void> {
  await run(
    env.DB,
    "UPDATE tasks SET status = 'queued', error = ?, request_id = NULL, lease = NULL, leased_at = NULL, updated = ? WHERE id = ? AND status = 'processing'",
    `Retrying: ${message}`.slice(0, 500),
    now(),
    task.id,
  );
}

export async function pauseBatch(env: Env, batchId: string, reason: string | null): Promise<void> {
  const changed = await run(
    env.DB,
    "UPDATE batches SET state = 'paused', last_error = ?, updated = ? WHERE id = ? AND state != 'paused'",
    reason ? reason.slice(0, 500) : null,
    now(),
    batchId,
  );
  if (changed && reason) {
    const row = await first<{ name: string }>(
      env.DB,
      "SELECT name FROM batches WHERE id = ?",
      batchId,
    );
    await notify(env, `Batch paused: ${row?.name ?? batchId}`, reason);
  }
}

/** Tasks that may start now: card 1 and the fabric card always; cards 2-5 once card 1 has a result. */
async function eligibleQueued(
  env: Env,
  batch: BatchRow,
  config: Config,
  limit: number,
): Promise<TaskRow[]> {
  const queued = await all<TaskRow & { source_name: string }>(
    env.DB,
    "SELECT t.*, s.name AS source_name FROM tasks t JOIN sources s ON s.id = t.source WHERE t.batch = ? AND t.status = 'queued' ORDER BY s.name, t.card",
    batch.id,
  );
  // The highest shot (_02 before _01) leads every set; the others follow its scene and light.
  if (SKILL_MODES.has(config.mode)) return setAwareQueue(env, batch, queued, limit, true);
  if (config.mode !== "1") return queued.slice(0, limit);
  const out: TaskRow[] = [];
  for (const t of queued) {
    if (t.card === 1 || t.card === FABRIC_CARD) {
      out.push(t);
    } else {
      const firstCard = await first<{ status: string; output: string | null }>(
        env.DB,
        "SELECT status, output FROM tasks WHERE batch = ? AND source = ? AND card = 1",
        batch.id,
        t.source,
      );
      const ready = (r: { status: string; output: string | null } | null) =>
        !!r?.output && !["processing", "finalizing", "queued"].includes(r.status);
      if (!ready(firstCard)) continue;
      if (t.card > 2) {
        const studioCard = await first<{ status: string; output: string | null }>(
          env.DB,
          "SELECT status, output FROM tasks WHERE batch = ? AND source = ? AND card = 2",
          batch.id,
          t.source,
        );
        if (!ready(studioCard)) continue;
      }
      out.push(t);
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function submitNext(
  env: Env,
  batch: BatchRow,
  config: Config,
  options: DriveOptions,
): Promise<void> {
  const { background, deferSync, refillUntil = 0 } = options;
  // A finished synchronous image hands its slot to the next queued one while the budget lasts.
  const refill = async () => {
    if (deferSync || !background || now() > refillUntil) return;
    await advanceBatch(env, batch.id, options).catch((e) => console.error("[refill]", batch.id, errorMessage(e)));
  };
  // A month planned before the right engine was connected keeps an unusable model: move it to the
  // connected one instead of pausing on "not connected".
  const usable = await connectedModel(env, config.model);
  if (usable && usable !== config.model) {
    config.model = usable;
    await run(
      env.DB,
      "UPDATE batches SET config = ?, updated = ? WHERE id = ?",
      JSON.stringify(config),
      now(),
      batch.id,
    );
  }
  // The preview never pays an image engine: the month pauses and says so before anything is reserved.
  if (previewNoImages(env)) {
    await pauseBatch(env, batch.id, PREVIEW_MESSAGE);
    return;
  }
  const openai = isOpenAIModel(config.model);
  const google = isGoogleModel(config.model);
  const fal = isFalModel(config.model);
  const sync = openai || (google && !config.economy);
  if (sync && deferSync) return;
  if (fal) {
    if (!(await resolveFalKey(env)).key) {
      await pauseBatch(
        env,
        batch.id,
        "fal.ai is not connected. Add the API key in Connection and resume.",
      );
      return;
    }
  } else if (openai) {
    if (!(await resolveOpenAIKey(env)).key) {
      await pauseBatch(
        env,
        batch.id,
        "OpenAI is not connected. Add the API key in Connection and resume.",
      );
      return;
    }
  } else if (google) {
    if (!(await resolveGoogleAuth(env)).auth) {
      await pauseBatch(
        env,
        batch.id,
        "Google is not connected. Add the AI Studio key or the Google Cloud service account in Connection and resume.",
      );
      return;
    }
  } else if (!(await engineConfigured(env))) {
    await pauseBatch(
      env,
      batch.id,
      "Higgsfield is not connected. Add the API key in Connection and resume.",
    );
    return;
  }
  const processing = await first<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM tasks WHERE batch = ? AND status IN ('processing','finalizing')",
    batch.id,
  );
  if (now() < enginePausedUntil) return; // a vendor asked us to wait
  const vertexActive = google ? !!(await resolveGoogleAuth(env)).vertex : false;
  // Synchronous engines hold a connection per image, so they are capped; fal.ai queues on its side.
  const slots =
    (fal ? FAL_PARALLEL : google ? googleParallel(env) : concurrency(env)) -
    (processing?.n ?? 0);
  if (slots <= 0) return;
  // Prompts are written ahead of submission: every set leader first, then the followers whose
  // leader already has a prompt, so a follower only waits for the leader's image, not its text.
  if (SKILL_MODES.has(config.mode))
    await prepareBriefs(env, batch, config, await briefPool(env, batch));
  let candidates = await eligibleQueued(env, batch, config, slots);
  if (SKILL_MODES.has(config.mode)) candidates = candidates.filter((t) => !!t.brief);
  const client = openai || google || fal ? null : await makeClient(env, undefined, config.model);

  // The images are submitted side by side: reading each one's references and writing its prompt
  // takes seconds, and six in a row would delay the last one by most of a minute.
  const submitOne = async (task: TaskRow): Promise<void> => {
    // An image moved to another engine after a refusal runs on that engine, with that engine's rules.
    const cfg = taskConfig(config, task);
    const tFal = isFalModel(cfg.model);
    const tGoogle = isGoogleModel(cfg.model);
    const tOpenai = isOpenAIModel(cfg.model);
    // Economy (Flex, background) exists on the AI Studio path only; Vertex always runs synchronously.
    const economy = !!cfg.economy && !vertexActive;
    if (deferSync && (tOpenai || (tGoogle && !economy))) return;
    const token = uuid();
    const claimed = await run(
      env.DB,
      "UPDATE tasks SET status = 'processing', lease = ?, leased_at = ?, request_id = NULL, attempts = attempts + 1, error = 'Submitting to the engine…', updated = ? WHERE id = ? AND status = 'queued'",
      token,
      now(),
      now(),
      task.id,
    );
    if (!claimed) return;
    const attemptCost =
      estimateCost({ ...cfg, model: cfg.model || (await resolveEngineModel(env)) }, 1, [task.card])
        .total + (task.edit || task.recenter ? 0.008 : 0);
    // Every attempt, automatic retakes and retries included, reserves its cost against the month's
    // approved budget before anything is sent. The reservation is one conditional UPDATE, so two
    // attempts cannot spend the same remaining allowance; past the budget the month pauses and
    // says so, and the designer's next Generate approves more.
    const reserved = await reserveSpend(env, batch.id, attemptCost);
    if (!reserved.ok) {
      const why = reserved.status.approved
        ? `The month's approved budget ($${reserved.status.approved.toFixed(2)}) is used up ($${reserved.status.reserved.toFixed(2)} reserved). Press Generate to approve more.`
        : "This month has no approved budget yet. Press Generate to approve its pictures.";
      await run(
        env.DB,
        "UPDATE tasks SET status = 'queued', lease = NULL, leased_at = NULL, attempts = MAX(0, attempts - 1), error = ?, updated = ? WHERE id = ? AND lease = ?",
        why,
        now(),
        task.id,
        token,
      );
      await pauseBatch(env, batch.id, why);
      return;
    }
    await run(env.DB, "UPDATE tasks SET cost = cost + ? WHERE id = ?", attemptCost, task.id);
    try {
      const requestId = tFal
        ? await submitFalTask(env, batch, cfg, task)
        : tGoogle && economy
          ? await submitGoogleBackgroundTask(env, batch, cfg, task)
          : tOpenai || tGoogle
            ? await submitOpenAITask(env, batch, cfg, task, token, background, refill)
            : await submitTask(
                env,
                client ?? (await makeClient(env, undefined, cfg.model)),
                batch,
                cfg,
                task,
              );
      await run(
        env.DB,
        "UPDATE tasks SET request_id = ?, updated = ? WHERE id = ? AND lease = ?",
        requestId,
        now(),
        task.id,
        token,
      );
    } catch (e) {
      await settleFailedAttempt(
        env,
        batch,
        cfg,
        { ...task, status: "processing", attempts: task.attempts + 1 },
        e,
      );
    }
  };
  await Promise.all(candidates.map(submitOne));
}

/** The batch config with the image's own engine when a refusal moved it to another one. */
export function taskConfig(config: Config, task: Pick<TaskRow, "model" | "post">): Config {
  // A card with its own format (a 9:16 Reel in a 4:5 month) is made in that format's ratio.
  const post = config.mode === "post" && task.post ? (config.plan ?? []).find((p) => p.index === task.post) : undefined;
  const ratio = post?.format ? ratioForFormat(post.format) : config.ratio;
  const own = ratio !== config.ratio ? { ...config, ratio } : config;
  return task.model ? { ...own, model: task.model } : own;
}

/**
 * May the engine queue one more take of this post by itself? Only while the month's approved
 * budget (every approved Generate adds its estimate, automatic retakes included) still covers it.
 * This is a read: the submission itself reserves the cost atomically, so a take that no longer
 * fits by then pauses the month instead of spending past the budget.
 */
export async function autoTakeAllowed(env: Env, batch: BatchRow, _config: Config, task: TaskRow): Promise<{ ok: boolean; why: string }> {
  if (_config.autoRetakes === false) return { ok: false, why: "automatic retakes are off for this month" };
  const cfg = taskConfig(_config, task);
  const unit = estimateCost({ ...cfg, model: cfg.model || (await resolveEngineModel(env)) }, 1, [task.card]).total;
  const fit = await spendFits(env, batch.id, unit);
  if (fit.ok) return { ok: true, why: "" };
  return {
    ok: false,
    why: fit.status.approved
      ? `the month's approved budget ($${fit.status.approved.toFixed(2)}) is used up ($${fit.status.reserved.toFixed(2)} reserved)`
      : "this month has no approved budget",
  };
}

async function contentFallbackModel(env: Env, current: string | undefined): Promise<string | null> {
  const candidates: string[] = [];
  if ((await resolveGoogleAuth(env)).auth) candidates.push("gemini-3-pro-image");
  if (await engineConfigured(env)) candidates.push("nano-banana-pro");
  if ((await resolveOpenAIKey(env)).key) candidates.push("gpt-image-1");
  return candidates.find((m) => m !== current) ?? null;
}

/**
 * A content checker refused the image: move it to another engine once, else send it once more
 * with the short plain prompt, else fail it. True when a retry was queued.
 */
async function retryAfterRefusal(
  env: Env,
  config: Config,
  task: TaskRow,
  message: string,
): Promise<boolean> {
  if (task.attempts > MAX_AUTO_ATTEMPTS) return false;
  if (!task.model) {
    const fallback = await contentFallbackModel(env, config.model);
    if (fallback) {
      await run(env.DB, "UPDATE tasks SET model = ? WHERE id = ?", fallback, task.id);
      console.log(
        `[refused] task ${task.id}: ${config.model} refused the photo, moving to ${fallback}`,
      );
      await requeue(
        env,
        task,
        `the content checker refused this photo on ${config.model ?? "the batch engine"}; trying ${fallback}. ${message}`,
      );
      return true;
    }
  }
  if (!/content check/i.test(task.error ?? "")) {
    await requeue(
      env,
      task,
      `the content check refused the full prompt; trying a short plain one. ${message}`,
    );
    return true;
  }
  return false;
}

/** Upload the inference reference once per source and cache the engine URL. */
async function sourceEngineUrl(
  env: Env,
  client: HiggsfieldClient,
  source: SourceRow,
): Promise<string> {
  if (source.engine_url) return source.engine_url;
  const obj = (await env.BUCKET.get(await engineKeyOf(env, source))) ?? (await env.BUCKET.get(source.key));
  if (!obj) throw new StudioError("Original unavailable.", 404);
  const url = await client.upload(
    await obj.arrayBuffer(),
    obj.httpMetadata?.contentType || source.mime,
  );
  await run(env.DB, "UPDATE sources SET engine_url = ? WHERE id = ?", url, source.id);
  return url;
}

async function identityEngineUrl(
  env: Env,
  client: HiggsfieldClient,
  owner: string,
  identityId: string,
): Promise<string> {
  const row = await first<{ id: string; key: string; engine_url: string | null }>(
    env.DB,
    "SELECT id, key, engine_url FROM identities WHERE id = ? AND owner = ?",
    identityId,
    owner,
  );
  if (!row) throw new StudioError("Identity reference unavailable.", 404);
  if (row.engine_url) return row.engine_url;
  const obj = await env.BUCKET.get(row.key);
  if (!obj) throw new StudioError("Identity reference unavailable.", 404);
  const url = await client.upload(
    await obj.arrayBuffer(),
    obj.httpMetadata?.contentType || "image/jpeg",
  );
  await run(env.DB, "UPDATE identities SET engine_url = ? WHERE id = ?", url, row.id);
  return url;
}

/** Latest stored result as an engine URL: the cached CDN URL, or a fresh upload from R2. */
async function outputEngineUrl(
  env: Env,
  client: HiggsfieldClient,
  task: Pick<TaskRow, "id" | "output" | "output_engine_url">,
): Promise<string> {
  if (task.output_engine_url) return task.output_engine_url;
  if (!task.output) throw new StudioError("Result unavailable.", 404);
  const obj = await env.BUCKET.get(task.output);
  if (!obj) throw new StudioError("Result unavailable.", 404);
  const url = await client.upload(
    await obj.arrayBuffer(),
    obj.httpMetadata?.contentType || "image/png",
  );
  await run(env.DB, "UPDATE tasks SET output_engine_url = ? WHERE id = ?", url, task.id);
  return url;
}

/** Runs the prompt-builder skill once per card and stores the brief; revisions and retries reuse it. */
async function ensureBrief(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
  source: SourceRow,
): Promise<EditorialBrief> {
  if (task.brief) {
    const cached = JSON.parse(task.brief) as EditorialBrief;
    // A mood photo removed from the library since the brief was written is not used again:
    // the brief is rebuilt with a photo that still exists.
    if (!cached.mood || (await referenceExists(env, cached.mood))) return cached;
    console.log(
      `[missing reference] task ${task.id}: mood ${cached.mood} removed, rebuilding brief`,
    );
  }
  const image = await sourceBytes(env, source);
  // Step 0, before any skill text is read: what does the upload actually show? Checked once per
  // upload with a tiny dedicated vision call and stored, so every card and retry uses the same fact.
  const check = await uploadFraming(env, source, image);
  const siblings = await all<{ card: number; brief: string | null }>(
    env.DB,
    "SELECT card, brief FROM tasks WHERE batch = ? AND source = ? AND id != ? AND brief IS NOT NULL ORDER BY card",
    batch.id,
    task.source,
    task.id,
  );
  const used = siblings.map((t) => {
    const b = JSON.parse(t.brief!) as EditorialBrief;
    return { scene: b.scene, pose: b.pose };
  });
  // Scenes from the owner's other recent batches, so every new batch does not open on the same street.
  const recentRows = await all<{ brief: string }>(
    env.DB,
    "SELECT t.brief FROM tasks t JOIN batches b ON b.id = t.batch WHERE b.owner = ? AND t.batch != ? AND t.brief IS NOT NULL ORDER BY t.updated DESC LIMIT 12",
    batch.owner,
    batch.id,
  );
  // Every mood photo already used in this batch (all products), newest first, then the owner's
  // last few hundred images from other batches, so a reference photo is not picked twice while
  // unused ones remain.
  const batchMoods = await all<{ mood: string }>(
    env.DB,
    "SELECT json_extract(brief, '$.mood') AS mood FROM tasks WHERE batch = ? AND id != ? AND brief IS NOT NULL AND json_extract(brief, '$.mood') IS NOT NULL ORDER BY updated DESC",
    batch.id,
    task.id,
  );
  const pastMoods = await all<{ mood: string }>(
    env.DB,
    "SELECT json_extract(t.brief, '$.mood') AS mood FROM tasks t JOIN batches b ON b.id = t.batch WHERE b.owner = ? AND t.batch != ? AND t.brief IS NOT NULL AND json_extract(t.brief, '$.mood') IS NOT NULL ORDER BY t.updated DESC LIMIT 300",
    batch.owner,
    batch.id,
  );
  const recentBriefs = recentRows.map((r) => JSON.parse(r.brief) as EditorialBrief);
  const recent = recentBriefs.map((b) => b.scene).filter(Boolean);
  // Zaid creative direction: the photo's own skill, else the batch's, else Zaid's own mood board.
  const skillId =
    config.mode === "7"
      ? source.skill || config.skill || "zaid"
      : source.skill || config.skill || "editorial";
  const library = await all<{ id: string }>(
    env.DB,
    "SELECT id FROM refs WHERE skill = ? ORDER BY created",
    skillId,
  );
  const usedReferences = [...batchMoods, ...pastMoods].map((r) => r.mood).filter(Boolean);
  const req: EditorialRequest = {
    image,
    run: task.card,
    recent,
    skill: skillId,
    skillDef: skillId === "zaid" ? undefined : await resolveSkill(env, skillId),
    zaid: config.mode === "7",
    references: library.map((r) => r.id),
    usedReferences,
    direction: config.mode === "7" ? config.prompt : undefined,
    rules: config.mode === "7" ? await directionRules(env) : undefined,
    market: config.market || "auto",
    preference: config.mode === "7" ? "" : config.prompt,
    aspectRatio: config.ratio,
    used,
    newModel: config.mode === "8",
    uploadFraming: check.framing,
    visibleGarments: check.garments,
    handsInPockets: check.handsInPockets,
    backView: check.backView,
  };
  // A saved look leads instead of the reference photos: same scene, pose and light, no mood photo.
  const look = config.look
    ? await first<{
        name: string;
        prompt: string;
        negative: string;
        scene: string;
        pose: string;
        light: string;
      }>(
        env.DB,
        "SELECT name, prompt, negative, scene, pose, light FROM looks WHERE id = ?",
        config.look,
      )
    : null;
  if (look) req.look = look;
  // Draw the scene here so the mood photo attached to the builder is the one the text names.
  const leader = await setLeader(env, batch, task, source);
  const leaderBrief = leader ? (JSON.parse(leader.brief) as EditorialBrief) : null;
  const leaderMood =
    leaderBrief?.mood && (await referenceExists(env, leaderBrief.mood))
      ? leaderBrief.mood
      : undefined;
  const plan = leaderBrief
    ? { scene: leaderBrief.scene || null, mood: leaderMood }
    : look
      ? { scene: look.scene || null }
      : planRun(req);
  req.scene = plan.scene;
  if (plan.mood) {
    req.reference = plan.mood;
    req.extraImages = [await referenceBytes(env, plan.mood)];
  }
  if (leader && leaderBrief) {
    // The prompt builder gets the sibling's scene, light and pose as text only. Inlining the 2K
    // sibling image (base64, several copies) with several prompts in flight exhausted the Worker's
    // memory and silently killed the request. The image engine still receives the sibling image.
    req.set = {
      scene: leaderBrief.scene,
      light: leaderBrief.light,
      pose: leaderBrief.pose,
      hasImage: false,
    };
  }
  // The builder follows the image engine's vendor when possible (OpenAI model -> OpenAI builder),
  // so one key is enough and errors come from a single provider.
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  const anthropic = (await resolveAnthropicKey(env)).key;
  if (!google && !openai && !anthropic)
    throw new StudioError(
      "The editorial prompt builder needs a Claude, Google or OpenAI key in Connection.",
      428,
      true,
    );
  const preferOpenAI = isOpenAIModel(config.model) ? !!openai : !google;
  const build = async (): Promise<EditorialBrief> => {
    // Claude writes the prompt first when its key is saved (27 Oct); the vendors below stand in.
    const claude = await tryClaude(env, builderInstruction(req), imageParts(req), BUILDER_SCHEMA);
    if (claude !== null) return parseBrief(claude);
    if (!google && !openai) throw new StudioError("Claude could not write this prompt, and no Google or OpenAI key is connected to write it instead.", 502, true);
    if (preferOpenAI) {
      try {
        return await buildBriefWithOpenAI(openai!, req);
      } catch (e) {
        // OpenAI throttled, or its key rejected: Google writes this prompt instead of the batch waiting.
        if (google && (isRateLimit(e) || isBadKey(e))) {
          console.log(
            `[builder] OpenAI unavailable, using Google: ${errorMessage(e).slice(0, 160)}`,
          );
          return buildBriefWithGoogle(google, req);
        }
        throw e;
      }
    }
    try {
      return await buildBriefWithGoogle(google!, req);
    } catch (e) {
      // Gemini refuses some Cloudflare regions, a drained prepaid balance, or throttles the key;
      // OpenAI takes over for this prompt.
      if (openai && (googleUnavailable(e) || isRateLimit(e))) {
        console.log(`[builder] Google unavailable, using OpenAI: ${errorMessage(e).slice(0, 160)}`);
        try {
          return await buildBriefWithOpenAI(openai, req);
        } catch (e2) {
          // A rejected OpenAI key is not this image's fault: keep Google's own verdict (a rate
          // limit waits and retries) instead of failing the image on the stand-in's error.
          if (isBadKey(e2)) {
            console.error(`[builder] OpenAI key rejected: ${errorMessage(e2).slice(0, 160)}`);
            throw e;
          }
          throw e2;
        }
      }
      throw e;
    }
  };
  let brief = await build();
  // Zaid creative direction: a short draft gets one more attempt with the shortfall spelled out.
  // Children keep the standard length: long body-and-skin description is what content checkers refuse.
  if (
    config.mode === "7" &&
    !isChildSubject(brief.subject, config.skill) &&
    wordCount(brief.prompt) < ZAID_MIN_WORDS
  ) {
    const words = wordCount(brief.prompt);
    console.log(`[short prompt] task ${task.id}: ${words} words, rebuilding`);
    req.expand = `YOUR PREVIOUS DRAFT WAS REJECTED: it was ${words} words, below the mandatory minimum of ${ZAID_MIN_WORDS}. Write it again, same facts and the same scene, ${ZAID_MIN_WORDS}-${ZAID_MAX_WORDS} words: expand every section with more concrete, specific sentences (each background element and its material, where the light lands on each one, every garment detail, the pose joint by joint). Do not pad with repetition.`;
    const longer = await build();
    if (wordCount(longer.prompt) > words) brief = longer;
  }
  if (plan.mood) brief.mood = plan.mood;
  if (leader) brief.setOf = leader.id;
  // The verified crop is binding: the builder's own reading never replaces it.
  brief.framing = check.framing;
  await run(env.DB, "UPDATE tasks SET brief = ? WHERE id = ?", JSON.stringify(brief), task.id);
  return brief;
}

/**
 * Queued tasks whose prompt is not written yet, in writing order: every set leader (the highest
 * shot of each product), then the followers whose leader already has a prompt.
 */
async function briefPool(env: Env, batch: BatchRow): Promise<TaskRow[]> {
  const rows = await all<TaskRow & { source_name: string; has_brief: number }>(
    env.DB,
    "SELECT t.*, s.name AS source_name, (t.brief IS NOT NULL) AS has_brief FROM tasks t JOIN sources s ON s.id = t.source WHERE t.batch = ? ORDER BY s.name, t.card",
    batch.id,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${productKey(r.source_name)}#${r.card}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const leaders: TaskRow[] = [];
  const followers: TaskRow[] = [];
  for (const g of groups.values()) {
    const leader = [...g].sort((a, b) => shotNumber(b.source_name) - shotNumber(a.source_name))[0];
    const groupHasBrief = g.some((r) => r.has_brief);
    for (const r of g) {
      if (r.status !== "queued" || r.has_brief) continue;
      if (r.id === leader.id || g.length === 1) leaders.push(r);
      else if (groupHasBrief) followers.push(r);
    }
  }
  return [...leaders, ...followers];
}

/**
 * Skill campaigns: write the prompts for queued images first, a few at a time, before anything is
 * submitted. Each prompt is a 20-40 s vision call; keeping it out of the submission step means a
 * tick never holds a prompt and a generation in one go, and a lost tick costs nothing already written.
 * Returns the candidates that have a prompt now; the rest wait for the next tick.
 */
let builderPausedUntil = 0; // after a vendor rate limit, no prompt is written before this time (per isolate)

async function prepareBriefs(
  env: Env,
  batch: BatchRow,
  config: Config,
  candidates: TaskRow[],
): Promise<TaskRow[]> {
  const needs = candidates.filter((t) => !t.brief);
  if (!needs.length) return candidates;
  const ready = new Set(candidates.filter((t) => !!t.brief).map((t) => t.id));
  if (now() < builderPausedUntil) return candidates.filter((t) => ready.has(t.id));
  // Several invocations (the held tick, the cron) run at once: each claims tasks up to a shared cap.
  const inFlight = await first<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM tasks WHERE batch = ? AND status = 'queued' AND brief IS NULL AND error = ? AND updated > ?",
    batch.id,
    WRITING,
    now() - WRITING_STALE_MS,
  );
  const room = BUILDER_PARALLEL - (inFlight?.n ?? 0);
  if (room <= 0) return candidates.filter((t) => ready.has(t.id));
  const claimed: TaskRow[] = [];
  for (const task of needs) {
    if (claimed.length >= room) break;
    const ok = await run(
      env.DB,
      "UPDATE tasks SET error = ?, updated = ? WHERE id = ? AND status = 'queued' AND brief IS NULL AND (error IS NULL OR error != ? OR updated < ?)",
      WRITING,
      now(),
      task.id,
      WRITING,
      now() - WRITING_STALE_MS,
    );
    if (ok) claimed.push(task);
  }
  await Promise.allSettled(
    claimed.map(async (task) => {
      const source = await first<SourceRow>(
        env.DB,
        "SELECT * FROM sources WHERE id = ?",
        task.source,
      );
      if (!source) return;
      try {
        await ensureBrief(env, batch, config, task, source);
        ready.add(task.id);
        await run(
          env.DB,
          "UPDATE tasks SET error = NULL WHERE id = ? AND status = 'queued'",
          task.id,
        );
      } catch (e) {
        // An empty prepaid balance will not clear by waiting or retrying: stop the batch and say so.
        if (isCreditsDepleted(e)) {
          console.error(`[builder] credits depleted: ${errorMessage(e).slice(0, 200)}`);
          await run(
            env.DB,
            "UPDATE tasks SET error = NULL, updated = ? WHERE id = ? AND status = 'queued'",
            now(),
            task.id,
          );
          await pauseBatch(env, batch.id, creditsMessage(e));
          return;
        }
        if (isRateLimit(e)) {
          const detail = errorMessage(e);
          console.log(`[builder] rate limited: ${detail.slice(0, 300)}`);
          // A used-up daily or free-tier quota will not clear by waiting: stop and say so.
          if (isDailyQuota(e)) {
            const vendor = /google/i.test(detail) ? "Google" : "OpenAI";
            await pauseBatch(
              env,
              batch.id,
              `${vendor}'s prompt-builder quota for today is used up (${detail.slice(0, 160)}). Raise the quota or enable billing for that key, or connect the other provider in Connection, then resume.`,
            );
            return;
          }
          // Stay in the queue and wait as long as the vendor asked; the next tick resumes.
          const wait = retryAfterMs(e);
          builderPausedUntil = Math.max(builderPausedUntil, now() + wait);
          await run(
            env.DB,
            "UPDATE tasks SET error = ?, updated = ? WHERE id = ? AND status = 'queued'",
            `Prompt builder is rate limited by ${/google/i.test(detail) ? "Google" : "OpenAI"}; retrying in ${Math.round(wait / 1000)} s.`,
            now(),
            task.id,
          );
          return;
        }
        if (isTransientEngineError(e)) return; // next tick tries again
        await run(
          env.DB,
          "UPDATE tasks SET status = 'failed', error = ?, updated = ? WHERE id = ? AND status = 'queued'",
          errorMessage(e, "Prompt builder failed.").slice(0, 500),
          now(),
          task.id,
        );
        if (isFatalEngineError(e)) await pauseBatch(env, batch.id, errorMessage(e));
      }
    }),
  );
  return candidates.filter((t) => ready.has(t.id));
}

/** What one No prompt image is built from; stored on the task so retries reuse the same choice. */
interface NoPromptPlan {
  np: true;
  bg: string | null;
  pose: string | null;
  framing: Framing;
  handsInPockets: boolean;
  backView: boolean;
  /** What the vision model read from the background photo: light, shadows, camera, standing spot. */
  scene?: string;
  /** What the vision model read from the pose photo: stance, hands, head, gaze. */
  poseNotes?: string;
}

/**
 * Picks the background and the pose for a No prompt image and stores the choice on the task.
 * The background is a random photo from the library, never the same one twice until every photo
 * has been used once in the batch. The pose comes from the photos whose framing matches the
 * upload's, chosen the same way.
 */
async function noPromptPlan(
  env: Env,
  batch: BatchRow,
  task: TaskRow,
  source: SourceRow,
): Promise<NoPromptPlan> {
  if (task.brief) {
    const stored = JSON.parse(task.brief) as Partial<NoPromptPlan>;
    // A plan whose background or pose was deleted from the library since is made again.
    if (
      stored.np &&
      (!stored.bg || (await referenceExists(env, stored.bg))) &&
      (!stored.pose || (await referenceExists(env, stored.pose)))
    )
      return stored as NoPromptPlan;
  }
  const check = await uploadFraming(env, source, await sourceBytes(env, source));
  const backgrounds = await all<{ id: string }>(
    env.DB,
    "SELECT id FROM refs WHERE skill = ? ORDER BY created",
    NP_BACKGROUNDS,
  );
  if (!backgrounds.length)
    throw new StudioError(
      "The No prompt approach needs background photos: add them in the Backgrounds library first.",
      428,
      true,
    );
  const poses = await all<{ id: string; framing: string | null }>(
    env.DB,
    "SELECT id, framing FROM refs WHERE skill = ? ORDER BY created",
    NP_POSES,
  );
  const wanted = check.framing;
  const fallback = wanted === "THREE_QUARTER" ? "FULL_BODY" : wanted;
  const pool =
    poses.filter((p) => p.framing === wanted).length > 0
      ? poses.filter((p) => p.framing === wanted)
      : poses.filter((p) => p.framing === fallback).length > 0
        ? poses.filter((p) => p.framing === fallback)
        : poses;
  // Random choice, spread evenly: a photo is picked at random among the ones used least so far
  // in this batch, so nothing repeats until the whole library has been used once.
  const used = new Map<string, number>();
  for (const row of await all<{ brief: string }>(
    env.DB,
    "SELECT brief FROM tasks WHERE batch = ? AND id != ? AND brief LIKE '{\"np\":true%'",
    batch.id,
    task.id,
  )) {
    try {
      const other = JSON.parse(row.brief) as Partial<NoPromptPlan>;
      for (const id of [other.bg, other.pose]) if (id) used.set(id, (used.get(id) ?? 0) + 1);
    } catch {
      // an unreadable plan counts for nothing
    }
  }
  const plan: NoPromptPlan = {
    np: true,
    bg: pickLeastUsed(backgrounds, used),
    pose: pool.length ? pickLeastUsed(pool, used) : null,
    framing: check.framing,
    handsInPockets: check.handsInPockets,
    backView: check.backView,
  };
  // The reads are cached on the reference rows, so only the first batch after an upload pays for them.
  if (plan.bg) plan.scene = await referenceNotes(env, plan.bg, "scene");
  if (plan.pose) plan.poseNotes = await referenceNotes(env, plan.pose, "pose");
  task.brief = JSON.stringify(plan);
  await run(env.DB, "UPDATE tasks SET brief = ? WHERE id = ?", task.brief, task.id);
  return plan;
}

/** A random item among those used the fewest times. */
function pickLeastUsed(items: { id: string }[], used: Map<string, number>): string {
  const min = Math.min(...items.map((i) => used.get(i.id) ?? 0));
  const pool = items.filter((i) => (used.get(i.id) ?? 0) === min);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/**
 * The vision read of a No prompt reference: for a background, the light, shadows, camera and the
 * spot the model stands on; for a pose, stance, hands, head and gaze. Cached in refs.notes.
 */
export async function referenceNotes(
  env: Env,
  id: string,
  kind: "scene" | "pose",
): Promise<string | undefined> {
  const row = await first<{ notes: string | null }>(
    env.DB,
    "SELECT notes FROM refs WHERE id = ?",
    id,
  );
  if (row?.notes === UNREADABLE) return undefined;
  if (row?.notes) return row.notes;
  try {
    const notes = await runReferenceRead(env, await referenceBytes(env, id), kind);
    if (notes) await run(env.DB, "UPDATE refs SET notes = ? WHERE id = ?", notes, id);
    return notes || undefined;
  } catch (e) {
    console.error(`[no prompt] ${kind} read failed`, errorMessage(e));
    return undefined;
  }
}

/** Stored in refs.notes when a photo could not be read twice, so the cron stops paying for it. */
const UNREADABLE = "-";

/**
 * Cron warm-up: reads a few No prompt references that have no notes yet (photos added before the
 * reads existed, or whose read failed at upload), so a batch never waits for them.
 */
export async function readPendingReferences(env: Env, limit = 4): Promise<number> {
  const rows = await all<{ id: string; skill: string }>(
    env.DB,
    "SELECT id, skill FROM refs WHERE skill IN (?, ?) AND notes IS NULL ORDER BY created LIMIT ?",
    NP_BACKGROUNDS,
    NP_POSES,
    limit,
  );
  if (!rows.length) return 0;
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  if (!google && !openai) return 0;
  let done = 0;
  await Promise.all(
    rows.map(async (r) => {
      const notes = await referenceNotes(env, r.id, r.skill === NP_POSES ? "pose" : "scene");
      if (notes) done++;
      // Still nothing after the upload-time attempt and this one: leave it alone from now on.
      else
        await run(
          env.DB,
          "UPDATE refs SET notes = ? WHERE id = ? AND notes IS NULL",
          UNREADABLE,
          r.id,
        );
    }),
  );
  return done;
}

/**
 * One vision call: Google first; when Google refuses the region, is out of credits or throttles,
 * OpenAI answers instead. A rejected OpenAI key is never the verdict: Google's own error is kept
 * (and logged) so the batch shows what actually went wrong.
 */
async function askVision(
  env: Env,
  instruction: string,
  images: ImageBytes[],
  schema: unknown,
): Promise<string> {
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  const anthropic = (await resolveAnthropicKey(env)).key;
  if (!google && !openai && !anthropic && (await demoMode(env))) return demoAnswer(instruction, schema, images.length);
  if (!google && !openai && !anthropic) throw new StudioError("Connect Claude, Google or OpenAI first.", 428, true);
  // Claude answers first when its key is saved (27 Oct); the others stand in when it cannot.
  const claude = await tryClaude(env, instruction, images, schema);
  if (claude !== null) return claude;
  if (!google && !openai) throw new StudioError("Claude could not answer this time, and no Google or OpenAI key is connected to answer instead.", 502, true);
  if (!google) return askVisionOpenAI(openai!, instruction, images, fetch, "gpt-4.1-mini");
  try {
    return await askVisionGoogle(google, instruction, images, schema);
  } catch (e) {
    const detail = errorMessage(e);
    if (!openai || !(googleUnavailable(e) || isRateLimit(e))) throw e;
    console.error(`[vision] Google failed, trying OpenAI: ${detail.slice(0, 200)}`);
    try {
      return await askVisionOpenAI(openai, instruction, images, fetch, "gpt-4.1-mini");
    } catch (e2) {
      if (isBadKey(e2)) {
        console.error(`[vision] OpenAI key rejected: ${errorMessage(e2).slice(0, 160)}`);
        throw e;
      }
      throw e2;
    }
  }
}

/** Runs the scene or pose read on an image and returns the sentences for the engine ("" if unreadable). */
export async function runReferenceRead(
  env: Env,
  image: ImageBytes,
  kind: "scene" | "pose",
): Promise<string> {
  const instruction = kind === "scene" ? SCENE_READ_INSTRUCTION : POSE_READ_INSTRUCTION;
  const schema = kind === "scene" ? SCENE_SCHEMA : POSE_SCHEMA;
  const parse = kind === "scene" ? parseSceneNotes : parsePoseNotes;
  return parse(await askVision(env, instruction, [image], schema));
}

/** The framing check on any image (uploads, and pose photos when they are added to the library). */
export async function runFramingCheck(env: Env, image: ImageBytes): Promise<FramingCheck> {
  const text = await askVision(env, FRAMING_CHECK_INSTRUCTION, [image], FRAMING_SCHEMA);
  return parseFramingCheck(text);
}

/**
 * The verified crop of an upload (FULL_BODY / UPPER_BODY / LOWER_BODY), from a small dedicated
 * vision call, cached on the source row. Runs before any prompt is written.
 */
async function uploadFraming(
  env: Env,
  source: SourceRow,
  image: ImageBytes,
): Promise<FramingCheck> {
  if (source.framing) {
    const [framing, face, third, fourth, ...rest] = source.framing.split("|");
    // Current form: framing|face|pockets|back|garments. Older rows lack the back flag, or the
    // pockets flag too; a flag is always "true"/"false", garments never are.
    const isFlag = (v: string | undefined) => v === "true" || v === "false";
    const hasPockets = isFlag(third);
    const hasBack = hasPockets && isFlag(fourth);
    if (
      framing === "FULL_BODY" ||
      framing === "THREE_QUARTER" ||
      framing === "UPPER_BODY" ||
      framing === "LOWER_BODY"
    )
      return {
        framing,
        faceVisible: face === "true",
        handsInPockets: hasPockets ? third === "true" : false,
        backView: hasBack ? fourth === "true" : false,
        garments: hasBack
          ? rest.join("|")
          : hasPockets
            ? [fourth, ...rest].filter(Boolean).join("|")
            : [third, fourth, ...rest].filter(Boolean).join("|"),
      };
  }
  const text = await askVision(env, FRAMING_CHECK_INSTRUCTION, [image], FRAMING_SCHEMA);
  const result = parseFramingCheck(text);
  await run(
    env.DB,
    "UPDATE sources SET framing = ? WHERE id = ?",
    `${result.framing}|${result.faceVisible}|${result.handsInPockets}|${result.backView}|${result.garments}`,
    source.id,
  );
  return result;
}

/** Google failures another vendor can cover: region refusal or an exhausted prepaid balance. */
/** A vendor rejected the API key itself (401/403, "incorrect API key"), not the request. */
function isBadKey(e: unknown): boolean {
  return /\((401|403)\)|incorrect api key|invalid api key|api key not valid|unauthorized/i.test(
    errorMessage(e),
  );
}

function googleUnavailable(e: unknown): boolean {
  return /location is not supported|credits are used up|credits are depleted/i.test(
    errorMessage(e),
  );
}

/** A reference-library photo from R2. */
async function referenceExists(env: Env, id: string): Promise<boolean> {
  return !!(await referenceKey(env, id));
}

/** A theme's reference photo, or a grid from the style library ("style:<id>", a month's grid). */
async function referenceKey(env: Env, id: string): Promise<string | null> {
  if (id.startsWith("style:"))
    return (await first<{ image_key: string | null }>(env.DB, "SELECT image_key FROM styles WHERE id = ?", id.slice(6)))?.image_key ?? null;
  return (await first<{ key: string }>(env.DB, "SELECT key FROM refs WHERE id = ?", id))?.key ?? null;
}

async function referenceBytes(env: Env, id: string): Promise<ImageBytes> {
  const key = await referenceKey(env, id);
  const obj = key ? await env.BUCKET.get(key) : null;
  if (!obj) throw new StudioError("Reference photo is missing from the library.", 500);
  return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" };
}

/** Reference photo as a Higgsfield upload URL, cached in settings. */
async function referenceEngineUrl(env: Env, client: HiggsfieldClient, id: string): Promise<string> {
  const settingName = `ref_url_${id}`;
  const cached = await getSetting(env, settingName);
  if (cached) return cached;
  const img = await referenceBytes(env, id);
  const url = await client.upload(img.bytes, img.mime);
  await setSetting(env, settingName, url);
  return url;
}

const SKILL_MODES = new Set(["5", "7", "8"]);

/** The stored brief of a social-media post (written when the post was planned). */
/** A test post is made at its draft size; everything else at the month's size. */
function sizeOf(config: Config, task: TaskRow): Config["size"] {
  if (config.mode !== "post" || !task.brief) return config.size;
  try {
    return (JSON.parse(task.brief) as Partial<PostBrief>).draft ?? config.size;
  } catch {
    return config.size;
  }
}

/**
 * The preflight: before the engine is paid, the art director reads the scene, the product notes,
 * the allowed people and the attached style or tile image, and fixes in writing what the engine
 * would get wrong (a reference's adults over child ambassadors, words to copy, a garment staged
 * against its print, an impossible action, a bag). Runs once per brief; never blocks a submission.
 */
/** What the preflight reads from: when any of it changes, a stored reading no longer applies. */
export function preflightInputs(pb: PostBrief): string {
  return JSON.stringify({
    brief: pb.brief,
    shot: pb.shot ?? "",
    product: pb.product ?? "",
    extra: (pb.extraProducts ?? []).map((e) => e.name),
    people: (pb.ambassadors ?? []).map((a) => a.name),
    style: pb.styleKey ?? "",
    tile: pb.tileKey ?? "",
    ref: pb.ref ?? "",
    editRef: pb.editRef?.key ?? "",
    exact: !!pb.exact,
    keepRef: !!pb.keepRef,
    ingredients: pb.ingredients ?? "",
  });
}

/**
 * The reading itself, over a brief: returns the brief as the engine should get it and the notes.
 * A text (and vision) call, or the demo fixture; never throws (a failed reading leaves the brief as it is).
 */
export async function preflightBrief(env: Env, batch: BatchRow, pb: PostBrief): Promise<{ pb: PostBrief; notes: string[]; dropped: boolean }> {
  const notes: string[] = [];
  let dropped = false;
  try {
    const { askText, parseJson } = await import("./posts");
    const scene = pb.shot?.trim() || pb.brief.trim();
    const products = pb.exact
      ? []
      : pb.hasProduct
      ? [pb.product ?? "", ...(pb.extraProducts ?? []).map((e) => e.note ?? e.name)].filter(Boolean)
      : pb.ingredients
        ? [`an ingredients slide: only these ingredients of the product, on their own, no cup or packaging: ${pb.ingredients}`]
        : [];
    const attachable = !pb.refIsSource && !pb.noRefImage;
    const reference: "style" | "tile" | "grid" | "" = pb.styleKey && attachable ? "style" : pb.tileKey && attachable ? "tile" : pb.ref && pb.grid && attachable ? "grid" : "";
    const images: ImageBytes[] = [];
    if (reference === "grid") images.push(await referenceBytes(env, pb.ref!));
    else if (reference) {
      const obj = await env.BUCKET.get((pb.styleKey || pb.tileKey)!);
      if (obj) images.push({ bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" });
    }
    const client = batch.client ? await first<{ name: string }>(env.DB, "SELECT name FROM clients WHERE id = ?", batch.client) : null;
    const pf = parsePreflight(
      parseJson<unknown>(
        await askText(
          env,
          preflightInstruction({
            client: client?.name ?? "the brand",
            scene: pb.grid && pb.tile ? `${scene}\nTILE OF THE GRID THIS POST FOLLOWS: ${tileForPeople(pb.tile, (pb.ambassadors ?? []).length)}` : scene,
            products,
            people: (pb.ambassadors ?? []).map((a) => `${a.name} (${a.description})`),
            reference,
            // In exact mode the product is a photo set in afterwards: lessons about drawing it do not apply.
            lessons: (pb.lessons ?? []).filter((l) => !pb.exact || !/^(Product truth|True size|No writing)/.test(l)),
            rules: pb.rules,
            campaign: pb.campaign,
            exact: !!pb.exact,
          }),
          PREFLIGHT_SCHEMA,
          images,
        ),
      ),
    );
    if (pf && !pf.ok) {
      notes.push(...pf.problems);
      if (pf.scene) {
        if (pb.shot?.trim()) pb.shot = pf.scene;
        else pb.brief = pf.scene;
        notes.push("the shot was written again without them");
      }
      // A campaign brief's reference is the designer's own picture, and so is one the designer asked
      // to keep: neither is ever left out.
      if (pf.dropReference && reference && !pb.campaign && !pb.keepRef) {
        pb.noRefImage = true;
        dropped = true;
        notes.push(`the ${reference} image was left out so the engine copies nothing from it`);
      } else if (pf.dropReference && reference && pb.keepRef) notes.push(`the ${reference} image is kept as you asked, though the reading would have left it out`);
    }
  } catch (e) {
    console.error("[preflight]", errorMessage(e));
  }
  return { pb, notes, dropped };
}

async function preflightPost(env: Env, batch: BatchRow, task: TaskRow): Promise<void> {
  if (task.preflight !== null && task.preflight !== undefined) return;
  const pb = postBrief(task);
  // A reading made from the Plan for this very post and these very inputs is used as it is: the plan
  // showed what the engine gets, and nothing is read twice.
  if (task.post != null) {
    const stored = await first<{ revision: number | null; brief: string; inputs: string; notes: string }>(env.DB, "SELECT revision, brief, inputs, notes FROM plan_preflights WHERE batch = ? AND post = ?", batch.id, task.post).catch(() => null);
    if (stored && stored.revision === (task.making_for ?? null) && stored.inputs === preflightInputs(pb)) {
      task.brief = stored.brief;
      task.preflight = JSON.stringify({ at: now(), notes: JSON.parse(stored.notes) as string[], reused: true });
      await run(env.DB, "UPDATE tasks SET brief = ?, preflight = ? WHERE id = ?", task.brief, task.preflight, task.id);
      return;
    }
  }
  const read = await preflightBrief(env, batch, pb);
  task.brief = JSON.stringify(read.pb);
  task.preflight = JSON.stringify({ at: now(), notes: read.notes });
  await run(env.DB, "UPDATE tasks SET brief = ?, preflight = ? WHERE id = ?", task.brief, task.preflight, task.id);
}

/** One picture the engine receives for a post, in the order the prompt numbers them. */
export interface PostImage {
  key: string;
  role: "product" | "portrait" | "place" | "realRef" | "look" | "editRef";
  /** The reference-library id behind a look picture, for an engine that uploads references by id. */
  refId?: string;
}

/**
 * The pictures a post sends after its own product photo, in the prompt's order: extra products,
 * ambassador portraits, the client's place, the real-people photo, then ONE look picture (an
 * applied style, a grid tile, or a theme or library reference), then the designer's reference for
 * this take. Every engine path draws from this list, so "Image n" in the prompt names what was sent.
 */
export async function postImages(pb: PostBrief, resolveRef: (id: string) => Promise<string | null>): Promise<{ images: PostImage[]; mood: boolean; reference: boolean }> {
  const images: PostImage[] = [];
  for (const e of pb.extraProducts ?? []) images.push({ key: e.key, role: "product" });
  for (const a of pb.ambassadors ?? []) images.push({ key: a.key, role: "portrait" });
  if (pb.place) images.push({ key: pb.place.key, role: "place" });
  if (pb.realRef) images.push({ key: pb.realRef.key, role: "realRef" });
  let mood = false;
  if (!pb.refIsSource && !pb.noRefImage) {
    if (pb.styleKey || pb.tileKey) {
      images.push({ key: (pb.styleKey || pb.tileKey)!, role: "look" });
      mood = true;
    } else if (pb.ref) {
      const key = await resolveRef(pb.ref);
      if (key) {
        images.push({ key, role: "look", refId: pb.ref });
        mood = true;
      }
    }
  }
  const reference = !!pb.editRef?.key;
  if (pb.editRef?.key) images.push({ key: pb.editRef.key, role: "editRef" });
  return { images, mood, reference };
}

function postBrief(task: TaskRow): PostBrief {
  if (!task.brief) throw new StudioError("This post has no brief. Generate the posts again.", 500);
  const b = JSON.parse(task.brief) as Partial<PostBrief>;
  if (!b.post) throw new StudioError("This post's brief is unreadable. Generate it again.", 500);
  return b as PostBrief;
}

export const DIRECTION_RULES_SETTING = "direction_rules";

/** The Creative direction fixed rules as the team keeps them (defaults until they edit). */
export async function directionRules(env: Env) {
  return parseDirectionRules(await getSetting(env, DIRECTION_RULES_SETTING));
}

/** The engine-side switches that follow the team's rule list. */
async function engineRuleFlags(env: Env) {
  const rules = await directionRules(env);
  const keys = [
    "identity",
    "tattoos",
    "framing",
    "hands",
    "light",
    "detail",
    "integration",
    "composition",
    "grain",
  ] as const;
  return Object.fromEntries(keys.map((k) => [k, ruleOn(rules, k)]));
}

/** Prompt for a card: the editorial brief in mode 5, the deterministic builder otherwise. */
async function promptFor(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
  source: SourceRow,
  edit: string,
  roles: PromptImages,
): Promise<string> {
  let prompt: string;
  if (isNoPrompt(config.mode)) {
    // The plan (background, pose, verified framing) was stored on the task when the images were gathered.
    const plan = task.brief ? (JSON.parse(task.brief) as NoPromptPlan) : null;
    prompt = buildNoPromptPrompt(
      plan?.framing,
      plan?.handsInPockets ?? false,
      plan?.backView ?? false,
      roles,
      edit,
      { scene: plan?.scene, pose: plan?.poseNotes },
    );
  } else if (config.mode === "post") {
    prompt = buildPostPrompt(postBrief(task), edit, roles);
  } else if (SKILL_MODES.has(config.mode)) {
    const brief = await ensureBrief(env, batch, config, task, source);
    const stored = source.framing?.split("|") ?? [];
    const pockets = stored[2] === "true";
    const backView = stored[3] === "true";
    const child = isChildSubject(brief.subject, config.skill);
    // After a content checker refused the full prompt, the retry sends a short plain one.
    const compact = /content check/i.test(task.error ?? "");
    prompt = compact
      ? buildCompactPrompt(
          brief,
          config.mode === "8",
          centeringApplies(config, task.card),
          brief.framing,
          pockets,
        )
      : buildEditorialPrompt(
          brief.prompt,
          brief.negative,
          edit,
          roles,
          config.mode === "8",
          centeringApplies(config, task.card),
          brief.framing,
          pockets,
          config.mode === "7",
          backView,
          config.mode === "7" ? await engineRuleFlags(env) : {},
        );
    if (child) prompt = sanitizeChildPrompt(prompt);
  } else {
    prompt = buildPrompt(config, task.card, edit, roles);
  }
  if (task.recenter) prompt += `\n\n${RECENTER_SUFFIX}`;
  prompt = sanitizePrompt(prompt);
  await run(env.DB, "UPDATE tasks SET prompt = ? WHERE id = ?", prompt, task.id);
  void traceEvent(env, { kind: "generation", traceId: batch.id, spanId: task.id, name: "submit", input: { prompt, images: Object.entries(roles).filter(([, on]) => on).map(([role]) => role), edit: edit || undefined }, model: config.model ?? null, metadata: { client: batch.client, post: task.post, revision: task.making_for, promptVersion: fingerprint(prompt), references: config.mode === "post" ? postReferenceKeys(task.brief) : [], engine: config.model ?? null, attempt: task.attempts + 1 } });
  return prompt;
}

async function submitTask(
  env: Env,
  client: HiggsfieldClient,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<string> {
  const source = await first<SourceRow>(env.DB, "SELECT * FROM sources WHERE id = ?", task.source);
  if (!source) throw new StudioError("Original unavailable.", 404);
  if (config.mode === "post") await preflightPost(env, batch, task);
  const imageUrls = [await sourceEngineUrl(env, client, source)];
  const roles = {
    identity: false,
    firstCard: false,
    studio: false,
    revision: false,
    mood: false,
    set: false,
    background: false,
    pose: false,
    reference: false,
  };

  if (config.mode === "3" && config.identity) {
    imageUrls.push(await identityEngineUrl(env, client, batch.owner, config.identity));
    roles.identity = true;
  }
  if (config.mode === "1" && task.card > 1 && task.card < FABRIC_CARD) {
    const firstCard = await first<TaskRow>(
      env.DB,
      "SELECT id, output, output_engine_url FROM tasks WHERE batch = ? AND source = ? AND card = 1",
      batch.id,
      task.source,
    );
    if (!firstCard?.output)
      throw new StudioError(
        "Generate lifestyle card 1 first to establish the model identity.",
        409,
      );
    imageUrls.push(await outputEngineUrl(env, client, firstCard));
    roles.firstCard = true;
    if (task.card > 2) {
      const studioCard = await first<TaskRow>(
        env.DB,
        "SELECT id, output, output_engine_url FROM tasks WHERE batch = ? AND source = ? AND card = 2",
        batch.id,
        task.source,
      );
      if (studioCard?.output) {
        imageUrls.push(await outputEngineUrl(env, client, studioCard));
        roles.studio = true;
      }
    }
  }
  if (SKILL_MODES.has(config.mode)) {
    const brief = await ensureBrief(env, batch, config, task, source);
    if (brief.mood) {
      imageUrls.push(await referenceEngineUrl(env, client, brief.mood));
      roles.mood = true;
    }
    const sibling = brief.setOf ? await setSibling(env, brief.setOf) : null;
    if (sibling) {
      imageUrls.push(await outputEngineUrl(env, client, sibling));
      roles.set = true;
    }
  }
  if (isNoPrompt(config.mode)) {
    const plan = await noPromptPlan(env, batch, task, source);
    // The location photo goes first: the engine then adds the model into that photograph instead
    // of swapping the background behind a cutout of the model photo.
    if (plan.bg) {
      imageUrls.unshift(await referenceEngineUrl(env, client, plan.bg));
      roles.background = true;
    }
    if (plan.pose) {
      imageUrls.push(await referenceEngineUrl(env, client, plan.pose));
      roles.pose = true;
    }
  }
  if (config.mode === "post") {
    const post = await postImages(postBrief(task), (id) => referenceKey(env, id));
    for (const i of post.images) imageUrls.push(i.refId ? await referenceEngineUrl(env, client, i.refId) : await signObjectUrl(env, i.key));
    roles.mood = post.mood;
    roles.reference = post.reference;
  }
  const edit = task.edit?.trim() ?? "";
  if ((edit || task.recenter) && task.output && !splitEdit(edit).fresh) {
    imageUrls.push(await outputEngineUrl(env, client, task));
    roles.revision = true;
  }

  const prompt = await promptFor(env, batch, config, task, source, edit, roles);

  const job: GenerationJob = {
    prompt,
    imageUrls,
    aspectRatio: config.ratio,
    size: sizeOf(config, task),
    webhookUrl: webhookUrl(env, batch.id),
  };
  return client.submit(job);
}

/** Originals up to this size go to the engine as they are: a print or a logo stays readable. */
const ENGINE_ORIGINAL_MAX = 7 * 1024 * 1024;

/** The R2 key the engine is given for a source: the original while it is light enough, else the small copy. */
export async function engineKeyOf(env: Env, source: { key: string; reference_key?: string | null; size?: number | null }): Promise<string> {
  if (!source.reference_key) return source.key;
  const size = source.size ?? (await env.BUCKET.head(source.key))?.size ?? Infinity;
  return size <= ENGINE_ORIGINAL_MAX ? source.key : source.reference_key;
}

/** Bytes of a source for the engine: the original (a print stays readable), the small copy when the original is heavy. */
async function sourceBytes(env: Env, source: SourceRow): Promise<ImageBytes> {
  const obj = (await env.BUCKET.get(await engineKeyOf(env, source))) ?? (await env.BUCKET.get(source.reference_key || source.key)) ?? (await env.BUCKET.get(source.key));
  if (!obj) throw new StudioError("Original unavailable.", 404);
  return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || source.mime };
}

/** The automatic review of a post image: the vision model compares it with the product photos. */
async function reviewPostImage(env: Env, task: TaskRow, result: ImageBytes): Promise<QA> {
  const pb = postBrief(task);
  const images: ImageBytes[] = [];
  const notes: string[] = [];
  if (pb.hasProduct || pb.exact) {
    const source = await first<SourceRow>(env.DB, "SELECT * FROM sources WHERE id = ?", pb.exact?.source ?? task.source);
    if (!source) throw new StudioError("Product photo unavailable for review.");
    // The vision model compares with a 1080-px copy of each product photo: a client's own 6 MB
    // picture as base64 is too large for Claude and heavy on the isolate's memory.
    const small = async (key: string): Promise<ImageBytes | null> => resizedPicture(env, key, 1080).catch(() => null);
    images.push((await small(source.reference_key || source.key)) ?? (await sourceBytes(env, source)));
    notes.push(pb.product ?? "");
    for (const x of pb.extraProducts ?? []) {
      const obj = (await small(x.key)) ?? (await env.BUCKET.get(x.key).then(async (o) => (o ? { bytes: await o.arrayBuffer(), mime: o.httpMetadata?.contentType || "image/jpeg" } : null)));
      if (!obj) continue;
      images.push(obj);
      notes.push(x.note ?? "");
    }
  }
  const ctx = {
    products: images.length,
    productNotes: notes,
    type: pb.type,
    people: (pb.ambassadors ?? []).map((a) => ({ name: a.name, description: a.description })),
    sellsDrinks: pb.sellsDrinks,
    ingredients: pb.ingredients,
    allowedFood: pb.campaign?.ingredients,
    campaignStaging: !!pb.campaign || !!pb.editRef,
    idea: pb.brief,
    coffeeDay: pb.occasionId === "coffee-day",
    brand: pb.palette?.length || pb.photography ? { palette: pb.palette ?? [], photography: pb.photography } : undefined,
    style: pb.styleKey ? pb.shot : undefined,
    // The tile as the post was asked to follow it: its bags and cards were left out on purpose.
    tile: pb.grid && pb.tile ? tileForPeople(tileWithoutBags(pb.tile, !!pb.hasProduct || !!pb.exact), (pb.ambassadors ?? []).length) : undefined,
  };
  const instruction = postReviewInstruction(ctx);
  const all = [...images, result];
  const google = (await resolveGoogleAuth(env)).auth;
  const openai = (await resolveOpenAIKey(env)).key;
  let text: string;
  const claude = await tryClaude(env, instruction, all, POST_REVIEW_SCHEMA);
  if (claude !== null) text = claude;
  else if (google) {
    try {
      text = await askVisionGoogle(google, instruction, all, POST_REVIEW_SCHEMA);
    } catch (e) {
      if (!openai) throw e;
      text = await askVisionOpenAI(openai, instruction, all);
    }
  } else if (openai) text = await askVisionOpenAI(openai, instruction, all);
  else return manualQA();
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned) as unknown;
  const flags = parsePostReview(parsed, ctx);
  return {
    found: false,
    count: 0,
    box: [],
    faces: facesIn(parsed),
    productConcern: flags.some((f) => f.kind === "product" || f.kind === "size" || f.kind === "invented"),
    notes: flags.length
      ? `${flags.length} thing${flags.length > 1 ? "s" : ""} to check before publishing.`
      : "Checked: the product matches its photo; no writing, bags, foreign items or extra people.",
    automated: true,
    flags,
  };
}

async function outputBytes(env: Env, task: Pick<TaskRow, "output">): Promise<ImageBytes> {
  if (!task.output) throw new StudioError("Result unavailable.", 404);
  const obj = await env.BUCKET.get(task.output);
  if (!obj) throw new StudioError("Result unavailable.", 404);
  return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/png" };
}

/**
 * OpenAI edits are synchronous, so the generation runs as a background job that finalises
 * the task itself. The returned request id marks the task as in flight for the finaliser.
 */
async function submitOpenAITask(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
  lease: string,
  background?: Background,
  /** Runs once the image is saved or has failed: the engine's chance to start the next one. */
  onSettled?: () => Promise<void>,
): Promise<string> {
  const source = await first<SourceRow>(env.DB, "SELECT * FROM sources WHERE id = ?", task.source);
  if (!source) throw new StudioError("Original unavailable.", 404);
  if (config.mode === "post") await preflightPost(env, batch, task);
  const images: ImageBytes[] = [await sourceBytes(env, source)];
  const roles = {
    identity: false,
    firstCard: false,
    studio: false,
    revision: false,
    mood: false,
    set: false,
    background: false,
    pose: false,
    reference: false,
  };

  if (config.mode === "1" && task.card > 1 && task.card < FABRIC_CARD) {
    const firstCard = await first<TaskRow>(
      env.DB,
      "SELECT id, output, output_engine_url FROM tasks WHERE batch = ? AND source = ? AND card = 1",
      batch.id,
      task.source,
    );
    if (!firstCard?.output)
      throw new StudioError(
        "Generate lifestyle card 1 first to establish the model identity.",
        409,
      );
    images.push(await outputBytes(env, firstCard));
    roles.firstCard = true;
    if (task.card > 2) {
      const studioCard = await first<TaskRow>(
        env.DB,
        "SELECT id, output FROM tasks WHERE batch = ? AND source = ? AND card = 2",
        batch.id,
        task.source,
      );
      if (studioCard?.output) {
        images.push(await outputBytes(env, studioCard));
        roles.studio = true;
      }
    }
  }
  if (SKILL_MODES.has(config.mode)) {
    const brief = await ensureBrief(env, batch, config, task, source);
    if (brief.mood) {
      images.push(await referenceBytes(env, brief.mood));
      roles.mood = true;
    }
    const sibling = brief.setOf ? await setSibling(env, brief.setOf) : null;
    if (sibling) {
      images.push(await outputBytes(env, sibling));
      roles.set = true;
    }
  }
  if (isNoPrompt(config.mode)) {
    const plan = await noPromptPlan(env, batch, task, source);
    // Location photo first (see submitTask).
    if (plan.bg) {
      images.unshift(await referenceBytes(env, plan.bg));
      roles.background = true;
    }
    if (plan.pose) {
      images.push(await referenceBytes(env, plan.pose));
      roles.pose = true;
    }
  }
  if (config.mode === "post") {
    // Order matters: the prompt numbers products, then portraits, then the one reference.
    const post = await postImages(postBrief(task), (id) => referenceKey(env, id));
    for (const i of post.images) {
      const obj = await env.BUCKET.get(i.key);
      if (!obj) {
        if (i.refId) throw new StudioError("Reference photo is missing from the library.", 500);
        continue;
      }
      images.push({ bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" });
      if (i.role === "look") roles.mood = true;
      if (i.role === "editRef") roles.reference = true;
    }
  }
  const edit = task.edit?.trim() ?? "";
  if ((edit || task.recenter) && task.output && !splitEdit(edit).fresh) {
    images.push(await outputBytes(env, task));
    roles.revision = true;
  }

  const prompt = await promptFor(env, batch, config, task, source, edit, roles);

  const requestId = `sync:${uuid()}`;
  // Record the id before the slow call so a concurrent driver sees the task as in flight.
  await run(
    env.DB,
    "UPDATE tasks SET request_id = ?, error = 'Making the picture…', updated = ? WHERE id = ? AND lease = ?",
    requestId,
    now(),
    task.id,
    lease,
  );

  const client = isGoogleModel(config.model)
    ? await makeGoogleClient(env)
    : await makeOpenAIClient(env);
  const job = (async () => {
    try {
      const result = await client.edit({
        model: config.model!,
        prompt,
        images,
        aspectRatio: config.ratio,
        size: sizeOf(config, task),
      });
      const claimed = await run(
        env.DB,
        "UPDATE tasks SET status = 'finalizing', updated = ? WHERE id = ? AND status = 'processing' AND request_id = ?",
        now(),
        task.id,
        requestId,
      );
      if (!claimed) return;
      await storeResultBytes(
        env,
        batch,
        config,
        { ...task, status: "finalizing", request_id: requestId },
        result,
        null,
      );
    } catch (e) {
      await settleFailedAttempt(
        env,
        batch,
        config,
        { ...task, status: "processing", request_id: requestId, attempts: task.attempts + 1 },
        e,
      );
    }
    if (onSettled) await onSettled();
  })();
  if (background) background(job);
  else await job;
  return requestId;
}

/** Economy mode: Google's Flex tier runs in the background and the finaliser polls for the image. */
async function submitGoogleBackgroundTask(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<string> {
  if (config.mode === "post") await preflightPost(env, batch, task);
  const { images, roles, source } = await collectReferenceBytes(env, batch, config, task);
  const edit = task.edit?.trim() ?? "";
  const prompt = await promptFor(env, batch, config, task, source, edit, roles);
  const client = await makeGoogleApiClient(env);
  const id = await client.submitFlex({
    model: config.model!,
    prompt,
    images,
    aspectRatio: config.ratio,
    size: sizeOf(config, task),
  });
  return `google:${id}`;
}

const FLEX_TIMEOUT_MS = 26 * 60 * 60 * 1000; // Google's Flex tier may take up to a day

async function finalizeGoogleFlex(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<void> {
  const age = now() - (task.leased_at ?? now());
  let client: GoogleImageClient;
  try {
    client = await makeGoogleApiClient(env);
  } catch {
    return;
  }
  let status: Awaited<ReturnType<GoogleImageClient["status"]>>;
  try {
    status = await client.status(task.request_id!.slice("google:".length));
  } catch (e) {
    if (isFatalEngineError(e)) await pauseBatch(env, batch.id, errorMessage(e));
    return;
  }
  if (status.state === "pending") {
    if (age > (config.economy ? FLEX_TIMEOUT_MS : GOOGLE_TIMEOUT_MS))
      await failTask(
        env,
        task,
        config.economy
          ? "Google Flex did not finish within a day. Retry this image."
          : "Google did not finish in time. Retry this image.",
        task.output,
      );
    return;
  }
  if (status.state === "failed") {
    if (
      isContentPolicyError(status.message) &&
      (await retryAfterRefusal(env, taskConfig(config, task), task, status.message))
    )
      return;
    if (status.retryable && task.attempts < MAX_AUTO_ATTEMPTS)
      await requeue(env, task, status.message);
    else await failTask(env, task, status.message, task.output);
    return;
  }
  const claimed = await run(
    env.DB,
    "UPDATE tasks SET status = 'finalizing', updated = ? WHERE id = ? AND status = 'processing' AND request_id = ?",
    now(),
    task.id,
    task.request_id,
  );
  if (!claimed) return;
  try {
    await storeResultBytes(env, batch, config, task, status.image, null);
    void client.forget(task.request_id!.slice("google:".length));
  } catch (e) {
    await run(
      env.DB,
      "UPDATE tasks SET status = 'processing', error = ?, updated = ? WHERE id = ? AND status = 'finalizing'",
      errorMessage(e, "Could not store the result."),
      now(),
      task.id,
    );
  }
}

const FAL_TIMEOUT_MS = 20 * 60 * 1000;

/** fal.ai queues the job; the finaliser polls for the image. */
async function submitFalTask(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<string> {
  // fal fetches its inputs by URL: signed links to the stored images keep multi-megabyte results
  // out of the Worker's memory, which is what cut off revisions and set siblings before.
  const { keys, roles, source } = await collectReferenceKeys(env, batch, config, task);
  const edit = task.edit?.trim() ?? "";
  const prompt = await promptFor(env, batch, config, task, source, edit, roles);
  const imageUrls: string[] = [];
  for (const k of keys) imageUrls.push(await signObjectUrl(env, k));
  const client = await makeFalClient(env);
  const handle = await client.submit({
    model: config.model!,
    prompt,
    imageUrls,
    aspectRatio: config.ratio,
    size: sizeOf(config, task),
  });
  return encodeFalHandle(handle);
}

async function finalizeFal(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<void> {
  const age = now() - (task.leased_at ?? now());
  let client: FalClient;
  try {
    client = await makeFalClient(env);
  } catch {
    return;
  }
  let status: Awaited<ReturnType<FalClient["status"]>>;
  try {
    status = await client.status(decodeFalHandle(task.request_id!));
  } catch (e) {
    if (isFatalEngineError(e)) await pauseBatch(env, batch.id, errorMessage(e));
    return;
  }
  if (status.state === "pending") {
    if (age > FAL_TIMEOUT_MS)
      await failTask(env, task, "fal.ai did not finish in time. Retry this image.", task.output);
    return;
  }
  if (status.state === "failed") {
    if (
      isContentPolicyError(status.message) &&
      (await retryAfterRefusal(env, taskConfig(config, task), task, status.message))
    )
      return;
    if (status.retryable && task.attempts < MAX_AUTO_ATTEMPTS)
      await requeue(env, task, status.message);
    else await failTask(env, task, status.message, task.output);
    return;
  }
  const claimed = await run(
    env.DB,
    "UPDATE tasks SET status = 'finalizing', updated = ? WHERE id = ? AND status = 'processing' AND request_id = ?",
    now(),
    task.id,
    task.request_id,
  );
  if (!claimed) return;
  try {
    await storeResultBytes(env, batch, config, task, status.image, null);
  } catch (e) {
    await run(
      env.DB,
      "UPDATE tasks SET status = 'processing', error = ?, updated = ? WHERE id = ? AND status = 'finalizing'",
      errorMessage(e, "Could not store the result."),
      now(),
      task.id,
    );
  }
}

/**
 * Product sets: images named <id>_01, <id>_02 ... are one product. The first file of a set (by name)
 * generates alone; the others wait for it and then copy its scene, light and reference so the set
 * looks like one shoot. Different sets run in parallel as usual.
 */
async function setAwareQueue(
  env: Env,
  batch: BatchRow,
  queued: (TaskRow & { source_name: string })[],
  limit: number,
  highestShotLeads = false,
): Promise<TaskRow[]> {
  const rows = await all<{
    id: string;
    status: string;
    output: string | null;
    card: number;
    name: string;
  }>(
    env.DB,
    "SELECT t.id, t.status, t.output, t.card, s.name FROM tasks t JOIN sources s ON s.id = t.source WHERE t.batch = ? ORDER BY s.name, t.card",
    batch.id,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${productKey(r.name)}#${r.card}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  // The first row of a group is its leader: by name (_01 first), or the highest shot number first.
  if (highestShotLeads)
    for (const g of groups.values()) g.sort((a, b) => shotNumber(b.name) - shotNumber(a.name));
  const out: TaskRow[] = [];
  const claimedGroups = new Set<string>();
  for (const t of queued) {
    const k = `${productKey(t.source_name)}#${t.card}`;
    const g = groups.get(k) ?? [];
    if (g.length > 1) {
      const leaderDone = g.some(
        (r) => !!r.output && !["processing", "finalizing", "queued"].includes(r.status),
      );
      const inFlight = g.some((r) => ["processing", "finalizing"].includes(r.status));
      const isFirst = g[0]?.id === t.id;
      // One at a time per set until the leader exists; then the rest may run in parallel.
      if (!leaderDone && (inFlight || claimedGroups.has(k) || !isFirst)) continue;
      if (!leaderDone) claimedGroups.add(k);
    }
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** The sibling task of a set, if its output still exists. */
async function setSibling(env: Env, id: string): Promise<TaskRow | null> {
  const t = await first<TaskRow>(env.DB, "SELECT * FROM tasks WHERE id = ?", id);
  return t?.output ? t : null;
}

/**
 * The image of the same product (same card) whose scene this task must match: the one already
 * generated if there is one, else the one whose prompt exists, so a follower's prompt can be
 * written while the leader's image is still rendering.
 */
async function setLeader(
  env: Env,
  batch: BatchRow,
  task: TaskRow,
  source: SourceRow,
): Promise<(TaskRow & { brief: string }) | null> {
  const key = productKey(source.name);
  const rows = await all<TaskRow & { name: string }>(
    env.DB,
    "SELECT t.*, s.name FROM tasks t JOIN sources s ON s.id = t.source WHERE t.batch = ? AND t.card = ? AND t.id != ? AND t.brief IS NOT NULL ORDER BY (t.output IS NOT NULL) DESC, s.name DESC",
    batch.id,
    task.card,
    task.id,
  );
  const leader = rows.find((r) => productKey(r.name) === key);
  return leader ? (leader as TaskRow & { brief: string }) : null;
}

/** Reference images as bytes (garment, card 1, card 2, latest result) for the synchronous engines. */
/**
 * The stored images one generation needs, as R2 keys in engine order: the garment photo first,
 * then the consistency, mood, set-sibling and revision images that apply.
 */
async function collectReferenceKeys(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<{ keys: string[]; roles: PromptImages; source: SourceRow }> {
  const source = await first<SourceRow>(env.DB, "SELECT * FROM sources WHERE id = ?", task.source);
  if (!source) throw new StudioError("Original unavailable.", 404);
  const keys: string[] = [await engineKeyOf(env, source)];
  const roles = {
    identity: false,
    firstCard: false,
    studio: false,
    revision: false,
    mood: false,
    set: false,
    background: false,
    pose: false,
    reference: false,
  };
  if (config.mode === "1" && task.card > 1 && task.card < FABRIC_CARD) {
    const firstCard = await first<{ output: string | null }>(
      env.DB,
      "SELECT output FROM tasks WHERE batch = ? AND source = ? AND card = 1",
      batch.id,
      task.source,
    );
    if (!firstCard?.output)
      throw new StudioError(
        "Generate lifestyle card 1 first to establish the model identity.",
        409,
      );
    keys.push(firstCard.output);
    roles.firstCard = true;
    if (task.card > 2) {
      const studioCard = await first<{ output: string | null }>(
        env.DB,
        "SELECT output FROM tasks WHERE batch = ? AND source = ? AND card = 2",
        batch.id,
        task.source,
      );
      if (studioCard?.output) {
        keys.push(studioCard.output);
        roles.studio = true;
      }
    }
  }
  if (SKILL_MODES.has(config.mode)) {
    const brief = await ensureBrief(env, batch, config, task, source);
    if (brief.mood) {
      const ref = await first<{ key: string }>(
        env.DB,
        "SELECT key FROM refs WHERE id = ?",
        brief.mood,
      );
      if (!ref) throw new StudioError("Reference photo is missing from the library.", 500);
      keys.push(ref.key);
      roles.mood = true;
    }
    const sibling = brief.setOf ? await setSibling(env, brief.setOf) : null;
    if (sibling?.output) {
      keys.push(sibling.output);
      roles.set = true;
    }
  }
  if (isNoPrompt(config.mode)) {
    const plan = await noPromptPlan(env, batch, task, source);
    for (const id of [plan.bg, plan.pose]) {
      if (!id) continue;
      const ref = await first<{ key: string }>(env.DB, "SELECT key FROM refs WHERE id = ?", id);
      if (!ref) throw new StudioError("A No prompt library photo is missing.", 500);
      // Location photo first (see submitTask).
      if (id === plan.bg) {
        keys.unshift(ref.key);
        roles.background = true;
      } else {
        keys.push(ref.key);
        roles.pose = true;
      }
    }
  }
  if (config.mode === "post") {
    const post = await postImages(postBrief(task), (id) => referenceKey(env, id));
    for (const i of post.images) keys.push(i.key);
    roles.mood = post.mood;
    roles.reference = post.reference;
  }
  const edit = task.edit?.trim() ?? "";
  if ((edit || task.recenter) && task.output && !splitEdit(edit).fresh) {
    keys.push(task.output);
    roles.revision = true;
  }
  return { keys, roles, source };
}

async function objectBytes(
  env: Env,
  key: string,
  fallbackMime = "image/jpeg",
): Promise<ImageBytes> {
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new StudioError("Image unavailable.", 404);
  return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || fallbackMime };
}

/** Same as collectReferenceKeys, with the bytes loaded, for engines that need inline images. */
async function collectReferenceBytes(
  env: Env,
  batch: BatchRow,
  config: Config,
  task: TaskRow,
): Promise<{ images: ImageBytes[]; roles: PromptImages; source: SourceRow }> {
  const { keys, roles, source } = await collectReferenceKeys(env, batch, config, task);
  const images: ImageBytes[] = [];
  for (const k of keys) images.push(await objectBytes(env, k, source.mime));
  return { images, roles, source };
}

/** A running batch goes back to idle when nothing is in flight and nothing else can start (e.g. cards 2-5 whose card 1 failed). */
async function settleIdle(env: Env, batch: BatchRow, config: Config): Promise<void> {
  const checkedAt = now();
  const inflight = await first<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM tasks WHERE batch = ? AND status IN ('processing','finalizing')",
    batch.id,
  );
  if ((inflight?.n ?? 0) > 0) return;
  const startable = await eligibleQueued(env, batch, config, 1);
  if (startable.length) return;
  const changed = await run(
    env.DB,
    // Only if nothing was queued or started while this check ran: a "Generate" that lands at the
    // same moment as the last image finishing must not be left waiting in an idle month.
    "UPDATE batches SET state = 'idle', updated = ? WHERE id = ? AND state = 'running' AND NOT EXISTS (SELECT 1 FROM tasks WHERE batch = ? AND (status IN ('processing','finalizing') OR (status = 'queued' AND updated >= ?)))",
    now(),
    batch.id,
    batch.id,
    checkedAt - 10_000,
  );
  if (changed) {
    const row = await first<{
      name: string;
      total: number;
      review: number;
      failed: number;
      spent: number;
    }>(
      env.DB,
      "SELECT b.name, COUNT(t.id) AS total, SUM(CASE WHEN t.status='review' THEN 1 ELSE 0 END) AS review, SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS failed, SUM(t.cost) AS spent FROM batches b LEFT JOIN tasks t ON t.batch = b.id WHERE b.id = ? GROUP BY b.id",
      batch.id,
    );
    if (row)
      await notify(
        env,
        config.mode === "post" ? `Posts ready: ${row.name}` : `Batch finished: ${row.name}`,
        `${row.total} images generated. ${row.review} need review, ${row.failed} failed. Estimated spend $${(row.spent ?? 0).toFixed(2)}.`,
      );
  }
}

/** Batches the cron trigger should look at. */
export async function activeBatchIds(env: Env): Promise<string[]> {
  const rows = await all<{ id: string }>(
    env.DB,
    "SELECT DISTINCT b.id FROM batches b LEFT JOIN tasks t ON t.batch = b.id AND t.status IN ('processing','finalizing') WHERE b.deleted IS NULL AND (b.state = 'running' OR t.id IS NOT NULL) LIMIT 50",
  );
  // A month of posts left idle with posts still queued has nothing to wait for: it runs again.
  const stuck = await all<{ id: string }>(
    env.DB,
    "SELECT DISTINCT b.id FROM batches b JOIN tasks t ON t.batch = b.id AND t.status = 'queued' WHERE b.deleted IS NULL AND b.state = 'idle' AND b.config LIKE '%\"mode\":\"post\"%' LIMIT 20",
  );
  for (const r of stuck)
    await run(env.DB, "UPDATE batches SET state = 'running', updated = ? WHERE id = ? AND state = 'idle'", now(), r.id);
  return [...new Set([...rows.map((r) => r.id), ...stuck.map((r) => r.id)])];
}
