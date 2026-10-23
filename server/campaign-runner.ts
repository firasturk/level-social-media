/**
 * Campaign Autopilot's production (docs/campaign-autopilot.md): one pass moves each approved
 * step forward. A step starts only when its inputs are done, with one conditional update (so a
 * page and the cron never start it twice), and a paid step reserves its estimate in the campaign's
 * ledger scope for its unit before any request; a step that does not fit pauses the campaign. The
 * studio's own tools do the work: the image engine (`generateRun`), Magnific "Change camera"
 * (`runPhotoTool`), Higgsfield clips (`submitMcpVideo` / `submitVideoRequest`, from the shot's own
 * starting picture), the editor's project and the browser render. A failed attempt keeps
 * everything that succeeded and is tried again alone, within the approved attempts.
 *
 * A campaign made on the preview (`simulate`) calls no provider: each picture is a copy of the
 * product photo or the key frame, each clip is its starting picture held as a still, every one
 * labelled "Simulated", so approval, steps, assembly, the browser render and the cards can be
 * walked without spending.
 */
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { generateRun, ownedPlan, plainBackground, saveConfig, type BatchRow } from "./posts";
import { releaseSpend, reserveSpend, holdUncertain } from "./spend";
import { driveFileCopy, driveFileInfo, importDrivePhoto, photoBytes } from "./drive";
import { readMp4 } from "./mp4";
import { higgsfieldBilling } from "./higgsfield-billing";
import { parseSettings, postRows, settlePending, type VideoRow } from "./video";
import { catalogTrack, libraryTrack, type MusicTrackRow } from "./music";
import { catalogEntry, CATALOG } from "@shared/music-catalog";
import { rateFor } from "@shared/pricing";
import { FORMATS, MAX_POST_COUNT, postRevision, type Format, type Post } from "@shared/posts";
import { validateProject } from "@shared/video-project";
import type { MusicTrack } from "@shared/music";
import type { Config } from "@shared/config";
import type { User } from "@shared/types";
import { clipSeconds, stepSignature, type CampaignPlan, type CostUnit, type ImagePlanItem, type ShotPlan, type VideoPlanItem } from "../shared/campaign-plan";
import { assembleReel, stillShots, type AssembleShot } from "../shared/campaign-assemble";
import { peopleRule, showsPeople, stripListIdRefs, type CastMember } from "../shared/campaign-planner";
import type { CampaignRow, StepRow, StoredApproval } from "./campaign";

export const campaignScope = (id: string, unit: CostUnit) => `campaign:${id}:${unit}`;

/** Steps started in one pass, per kind: the providers are not flooded and one pass stays short. */
const START_LIMIT: Record<StepRow["kind"], number> = { post: 12, image: 3, frame: 3, clip: 3, assemble: 4, render: 0 };
/** A render the browser started and stopped reporting on, after this long, is offered again. */
const RENDER_STALE_MS = 3 * 60 * 1000;

const SIMULATED = "Simulated (preview): no provider was called";

export function listEngineModels(): { kind: "engine"; model: string; name: string }[] {
  const names: Record<string, string> = {
    "gemini-3-pro-image": "Gemini 3 Pro Image",
    "gemini-nano-banana-2.1": "Nano Banana 2.1",
    "gemini-3.1-flash-image": "Gemini 3.1 Flash Image",
    "gemini-2.5-flash-image": "Gemini 2.5 Flash Image",
    "gpt-image-2": "GPT Image 2",
    "nano-banana-pro": "Nano Banana Pro",
    "flux-2-pro": "FLUX.2 Pro",
    "flux-2-max": "FLUX.2 Max",
  };
  return Object.entries(names)
    .filter(([m]) => rateFor(m))
    .map(([model, name]) => ({ kind: "engine", model, name: `${name} (list price, US dollars)` }));
}

const readRow = (env: Env, id: string) => first<CampaignRow>(env.DB, "SELECT * FROM campaign_plans WHERE id = ?", id);
const stepsOf = (env: Env, id: string) => all<StepRow>(env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? ORDER BY rowid", id);

async function patchStep(env: Env, s: StepRow, patch: Partial<Record<keyof StepRow, unknown>>): Promise<void> {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await run(env.DB, `UPDATE campaign_steps SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE campaign = ? AND step = ?`, ...keys.map((k) => patch[k as keyof StepRow]), now(), s.campaign, s.step);
  Object.assign(s, patch);
}

async function pauseCampaign(env: Env, id: string, reason: string): Promise<void> {
  await run(env.DB, "UPDATE campaign_plans SET status = 'paused', pause_reason = ?, updated = ? WHERE id = ? AND status = 'producing'", reason.slice(0, 500), now(), id);
}

function itemOf(plan: CampaignPlan, key: string): { image: ImagePlanItem | null; video: VideoPlanItem | null } {
  return { image: plan.images.find((i) => i.key === key) ?? null, video: plan.videos.find((v) => v.key === key) ?? null };
}

const fmtAmount = (n: number | null, unit: CostUnit | null) => (n === null ? "an unknown amount" : unit === "usd" ? `$${n.toFixed(2)}` : `${n} ${unit === "magnific-credits" ? "Magnific" : "Higgsfield"} credits`);

/**
 * Reserves one attempt's cost in the campaign's scope before the request. Not enough left: the
 * step and the campaign pause with the amounts said; nothing is sent.
 */
async function reserveFor(env: Env, row: CampaignRow, s: StepRow, amount: number): Promise<boolean> {
  if (!s.unit || amount <= 0) return true;
  const r = await reserveSpend(env, campaignScope(row.id, s.unit), amount);
  if (r.ok) {
    await patchStep(env, s, { reserved: amount });
    return true;
  }
  const reason = `The approved allowance is not enough for "${s.label}" (${s.item}${s.shot ? ` ${s.shot}` : ""}): it needs ${fmtAmount(amount, s.unit)}, ${fmtAmount(r.status.remaining, s.unit)} is left. Approve more or change the plan.`;
  await patchStep(env, s, { status: "paused", note: reason, attempts: Math.max(0, s.attempts - 1) });
  await pauseCampaign(env, row.id, reason);
  return false;
}

/** The attempt cost what it cost: the reservation follows (released down, or topped up when the provider reported more). */
async function settleCost(env: Env, row: CampaignRow, s: StepRow, spent: number | null): Promise<void> {
  // Credits are "reported" from the balance's movement; jobs running side by side move one balance,
  // so a figure above the provider's own estimate for this exact request is the overlap, not this job.
  const overlap = spent !== null && s.unit !== "usd" && s.reserved > 0 && spent > s.reserved * 1.05;
  const cost = overlap ? s.reserved : (spent ?? s.reserved);
  if (overlap) await patchStep(env, s, { note: `${s.note ? `${s.note} · ` : ""}the balance moved by ${fmtAmount(spent, s.unit)} while other jobs ran too; counted at this request's estimate (${fmtAmount(s.reserved, s.unit)}).` });
  if (s.unit) {
    if (cost < s.reserved) await releaseSpend(env, campaignScope(row.id, s.unit), s.reserved - cost);
    else if (cost > s.reserved) {
      const more = await reserveSpend(env, campaignScope(row.id, s.unit), cost - s.reserved);
      if (!more.ok) await patchStep(env, s, { note: `The provider reported ${fmtAmount(cost, s.unit)}, more than the approved allowance had left; recorded for reconciliation.` });
    }
  }
  await patchStep(env, s, { spent: Math.round((s.spent + cost) * 1000) / 1000, reserved: 0 });
}

/** An attempt that failed: a known non-billing failure gives its reservation back; an unknown one keeps it for reconciliation. */
async function failAttempt(env: Env, row: CampaignRow, s: StepRow, message: string, billed: "no" | "unknown"): Promise<void> {
  if (s.unit && s.reserved > 0) {
    if (billed === "no") await releaseSpend(env, campaignScope(row.id, s.unit), s.reserved);
    else await holdUncertain(env, campaignScope(row.id, s.unit), s.reserved);
  }
  const again = s.attempts < s.max_attempts;
  await patchStep(env, s, { status: again ? "ready" : "failed", reserved: 0, error: message.slice(0, 500), finished: now() });
}

/* ───────────── The cards ───────────── */

const CAMPAIGN_STEM = "campaign-autopilot";

/** The month's source row campaign cards point at (a task always points at a source). */
async function campaignSource(env: Env, batchId: string, key: string): Promise<string> {
  const found = await first<{ id: string }>(env.DB, "SELECT id FROM sources WHERE batch = ? AND stem = ?", batchId, CAMPAIGN_STEM);
  if (found) return found.id;
  const id = uuid();
  await run(env.DB, "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, created) VALUES (?, ?, 'campaign/autopilot', ?, ?, NULL, 'image/png', 0, 'supporting', 'reference', ?)", id, batchId, CAMPAIGN_STEM, key, now());
  return id;
}

/** The product's name as the month knows it: a Drive product is copied into the month once (free). */
async function productStem(env: Env, user: User, b: BatchRow, p: ImagePlanItem["product"]): Promise<string | undefined> {
  if (!p) return undefined;
  if (p.from === "library") {
    const s = await first<{ name: string }>(env.DB, "SELECT name FROM sources WHERE id = ? AND batch = ?", p.id, b.id);
    return s ? (s.name.replace(/\.[a-z0-9]{2,5}$/i, "").split("/").pop() ?? s.name) : p.name;
  }
  const rows = await all<{ stem: string; name: string }>(env.DB, "SELECT stem, name FROM sources WHERE batch = ? AND kind = 'product'", b.id);
  const have = rows.find((r) => (r.name.replace(/\.[a-z0-9]{2,5}$/i, "").split("/").pop() ?? "") === p.name);
  if (have) return p.name;
  const imported = await importDrivePhoto(env, user.id, b.id, p.id, p.name, new Set(rows.map((r) => r.stem)));
  if (p.note) await run(env.DB, "UPDATE sources SET note = COALESCE(note, ?) WHERE id = ?", p.note, imported.id);
  return imported.name.replace(/\.[a-z0-9]{2,5}$/i, "").split("/").pop() ?? p.name;
}

const asFormat = (f: string): Format => (FORMATS as readonly string[]).includes(f) ? (f as Format) : "9:16";

/**
 * The item's card in the month, appended after its posts. The card's number is written on the
 * step before the month is saved, so a step that runs again finds its card instead of adding one.
 */
async function makePost(env: Env, user: User, row: CampaignRow, s: StepRow, plan: CampaignPlan): Promise<number> {
  const { image, video } = itemOf(plan, s.item);
  if (!image && !video) throw new StudioError("The item is no longer in the plan.", 409);
  const title = image ? image.headline || image.idea.slice(0, 60) : video!.hook || video!.concept.slice(0, 60);
  const b = await ownedPlan(env, user, row.batch);
  const product = await productStem(env, user, b, (image ?? video)!.product);
  const fresh = await ownedPlan(env, user, row.batch);
  const config = JSON.parse(fresh.config) as Config;
  const planPosts = config.plan ?? [];
  if (s.post) {
    const mine = planPosts.find((p) => p.index === s.post && p.title === title);
    if (mine) return mine.index;
  }
  if (planPosts.length >= MAX_POST_COUNT) throw new StudioError(`The month holds ${MAX_POST_COUNT} posts already.`, 409);
  const index = planPosts.reduce((m, p) => Math.max(m, p.index), 0) + 1;
  await patchStep(env, s, { post: index });
  const t = now();
  const setup = JSON.parse(row.setup) as { imageFormat?: string };
  let post: Post;
  if (image) {
    post = { index, type: product ? "product" : "lifestyle", title, brief: `${image.idea}\n${image.visual}`.trim(), caption: [image.caption, image.cta].filter(Boolean).join("\n"), hashtags: "", headline: image.headline || undefined, format: asFormat(setup.imageFormat ?? config.format ?? "4:5"), ideaAt: t, captionHand: true, ...(product ? { product } : {}) };
  } else {
    const v = video!;
    const keyShot = v.shots.find((x) => x.source === "start-image") ?? v.shots[0];
    post = { index, type: product ? "product" : "lifestyle", title, brief: `${v.concept}\nKey frame: ${keyShot?.action ?? ""} ${keyShot?.framing ?? ""}`.trim(), caption: [v.caption, v.cta].filter(Boolean).join("\n"), hashtags: "", headline: v.hook || undefined, overlay: false, format: asFormat(v.frame), ideaAt: t, captionHand: true, ...(product ? { product } : {}) };
  }
  // A card that shows a person or a hand names the client's cast, so the engine draws one of them
  // (from his or her reference photo) instead of inventing someone.
  const { castOf } = await import("./campaign");
  const cast = await castOf(env, config.client ?? null);
  const words = image ? `${image.idea} ${image.visual}` : `${video!.concept} ${video!.shots.map((x) => x.action).join(" ")}`;
  if (cast.length && showsPeople(words)) post.people = [cast[0].name];
  config.plan = [...planPosts, post];
  config.postCount = Math.min(MAX_POST_COUNT, Math.max(config.postCount ?? planPosts.length, planPosts.length) + 1);
  await saveConfig(env, fresh, config);
  return index;
}

/** A picture stored as the card's picture (a new take: the earlier one stays a version). */
async function setCardPicture(env: Env, b: { id: string; owner: string; config: string }, index: number, bytes: ArrayBuffer, mime: string, note: string): Promise<string> {
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === index);
  const made = post ? postRevision(post, config) : null;
  const t = await first<{ id: string }>(env.DB, "SELECT id FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, index);
  const taskId = t?.id ?? uuid();
  const key = `${b.owner}/${b.id}/output/${taskId}/${uuid()}.${/png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : "jpg"}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  if (t) await run(env.DB, "UPDATE tasks SET output = ?, status = 'ready', made_for = ?, updated = ? WHERE id = ?", key, made, now(), taskId);
  else {
    const source = await campaignSource(env, b.id, key);
    await run(env.DB, "INSERT INTO tasks (id, batch, source, card, status, output, prompt, brief, post, caption, qa, making_for, made_for, updated) VALUES (?, ?, ?, ?, 'ready', ?, '', ?, ?, ?, NULL, ?, ?, ?)", taskId, b.id, source, index, key, JSON.stringify({ post: true, index, campaign: true }), index, JSON.stringify({ text: "", hashtags: "" }), made, made, now());
  }
  await run(env.DB, "INSERT INTO post_takes (id, batch, post, task, status, key, cost, note, made_for, created) VALUES (?, ?, ?, ?, 'made', ?, 0, ?, ?, ?)", uuid(), b.id, index, taskId, key, note.slice(0, 500), made, now());
  return key;
}

/** A picture to simulate with (a PNG, JPEG or WebP, as an engine returns): the product photo, else the month's newest picture, else a plain card. */
async function simulatedPicture(env: Env, b: BatchRow, plan: CampaignPlan, item: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const raster = (mime: string | undefined) => /^image\/(png|jpeg|webp)$/i.test(mime ?? "");
  const { image, video } = itemOf(plan, item);
  const p = (image ?? video)?.product;
  if (p?.from === "library") {
    const s = await first<{ key: string; reference_key: string | null }>(env.DB, "SELECT key, reference_key FROM sources WHERE id = ?", p.id);
    const obj = s ? await env.BUCKET.get(s.reference_key ?? s.key) : null;
    if (obj && raster(obj.httpMetadata?.contentType)) return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata!.contentType! };
  }
  if (p?.from === "drive") {
    const img = await photoBytes(env, p.id, 1600).catch(() => null);
    if (img && raster(img.mime)) return img;
  }
  for (const t of await all<{ output: string }>(env.DB, "SELECT output FROM tasks WHERE batch = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 6", b.id)) {
    const obj = await env.BUCKET.get(t.output);
    if (obj && raster(obj.httpMetadata?.contentType)) return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata!.contentType! };
  }
  const config = JSON.parse(b.config) as Config;
  return { bytes: await plainBackground("#3a3f4b", config.format ?? "4:5"), mime: "image/png" };
}

/* ───────────── Starting a step ───────────── */

interface Ctx {
  env: Env;
  user: User;
  row: CampaignRow;
  plan: CampaignPlan;
  steps: Map<string, StepRow>;
  waitUntil: (p: Promise<unknown>) => void;
}

const postOfItem = (ctx: Ctx, item: string) => ctx.steps.get(`${item}:-:post`)?.post ?? null;

/** Magnific "Change camera" takes these angles; a shot's camera words pick one, never the same twice in a video. */
const ANGLES = ["left", "right", "low", "top", "closer", "wider", "front"] as const;
export function angleFor(shot: ShotPlan, taken: Set<string>): string {
  const words = `${shot.camera} ${shot.framing}`.toLowerCase();
  const want = /low/.test(words) ? "low" : /top|overhead|bird/.test(words) ? "top" : /close|macro|push in|detail/.test(words) ? "closer" : /wide|establish|pull out/.test(words) ? "wider" : /left/.test(words) ? "left" : /right/.test(words) ? "right" : "front";
  const pick = !taken.has(want) ? want : (ANGLES.find((a) => !taken.has(a)) ?? want);
  taken.add(pick);
  return pick;
}

/** The motion prompt a shot's clip is asked with. */
export function clipPrompt(v: VideoPlanItem, s: ShotPlan, cast: CastMember[] = []): string {
  const people = peopleRule(cast).replace(/^PEOPLE: /, "").replace(" in a post or shot", "");
  return [s.action, s.framing && `Framing: ${s.framing}.`, s.camera && `Camera: ${s.camera}.`, v.product ? `Keep ${v.product.name} exactly as in the picture: shape, label and colours unchanged.` : "", "Natural, realistic motion; no text appears; no new objects.", showsPeople(s.action) || cast.length ? `People: ${people}` : ""].filter(Boolean).join(" ").slice(0, 1500);
}

/** The picture a shot's clip starts from. */
async function startKey(ctx: Ctx, v: VideoPlanItem, s: ShotPlan, b: BatchRow): Promise<string> {
  const firstStart = v.shots.find((x) => x.source === "start-image");
  if (s.source === "start-image" && s.key !== firstStart?.key) {
    const f = ctx.steps.get(`${v.key}:${s.key}:frame`);
    if (!f?.output_key) throw new StudioError("The shot's starting picture is not made yet.", 409);
    return f.output_key;
  }
  if (s.source === "animate" && s.asset) {
    // The client's photo, copied into the month once (free, read-only Drive).
    const img = await photoBytes(ctx.env, s.asset.id, 2048);
    const key = `${b.owner}/${b.id}/campaign/${ctx.row.id}/${v.key}-${s.key}-start.${/png/.test(img.mime) ? "png" : "jpg"}`;
    if (!(await ctx.env.BUCKET.head(key))) await ctx.env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    return key;
  }
  const k = ctx.steps.get(`${v.key}:-:image`);
  if (!k?.output_key) throw new StudioError("The key frame is not made yet.", 409);
  return k.output_key;
}

async function startStep(ctx: Ctx, s: StepRow): Promise<void> {
  const { env, user, row, plan } = ctx;
  const { image, video } = itemOf(plan, s.item);
  const sig = stepSignature(plan, s);
  // A paid step whose inputs changed since approval waits for a new approval: nothing silent.
  if (s.unit && s.sig && s.sig !== sig) {
    await patchStep(env, s, { status: "paused", note: "Changed after approval: approve the changes to make it." });
    return;
  }
  // One attempt at a time, never past the approved attempts (counted in the row, not in a page's copy of it).
  const claimed = await run(env.DB, "UPDATE campaign_steps SET status = 'running', attempts = attempts + 1, started = ?, run_sig = ?, error = NULL, updated = ? WHERE campaign = ? AND step = ? AND status = 'ready' AND attempts < max_attempts", now(), sig, now(), row.id, s.step);
  if (!claimed) {
    const fresh = await first<StepRow>(env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, s.step);
    if (fresh?.status === "ready" && fresh.attempts >= fresh.max_attempts) await patchStep(env, fresh, { status: "failed", error: fresh.error ?? "The approved attempts are used." });
    return;
  }
  const counted = await first<{ attempts: number }>(env.DB, "SELECT attempts FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, s.step);
  s.status = "running";
  s.attempts = counted?.attempts ?? s.attempts + 1;
  s.started = now();
  s.run_sig = sig;
  const b = await ownedPlan(env, user, row.batch);
  try {
    switch (s.kind) {
      case "post": {
        const index = await makePost(env, user, row, s, plan);
        await patchStep(env, s, { status: "done", post: index, finished: now(), note: `Card ${index} in the month` });
        return;
      }
      case "image": {
        const index = postOfItem(ctx, s.item);
        if (!index) throw new StudioError("The card is not made yet.", 409);
        const engine = image ? image.engine : video!.keyFrameEngine;
        if (row.simulate) {
          // The preview reserves and spends its fixture estimate too, so the budget stops can be walked.
          if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
          await settleCost(env, row, s, null);
          const pic = await simulatedPicture(env, b, plan, s.item);
          const key = await setCardPicture(env, b, index, pic.bytes, pic.mime, `${SIMULATED}: the product photo stands in for the ${image ? "post's picture" : "key frame"}.`);
          await patchStep(env, s, { status: "done", post: index, output_key: key, ref_kind: "task", finished: now(), note: SIMULATED });
          return;
        }
        // The engine is the one approved: a month switched to another engine since pauses here.
        const config = JSON.parse(b.config) as Config;
        const { resolveEngineModel } = await import("./settings");
        const monthModel = config.model || (await resolveEngineModel(env));
        if (engine.kind === "engine" && engine.model !== monthModel) {
          await patchStep(env, s, { status: "paused", attempts: s.attempts - 1, note: `The month's image engine is now ${monthModel}; this step was approved for ${engine.model}. Change the plan's engine (and approve it) or switch the month back.` });
          await pauseCampaign(env, row.id, "An image engine differs from the approved one; nothing was switched silently.");
          return;
        }
        if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
        const had = await first<{ output: string | null }>(env.DB, "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL LIMIT 1", b.id, index);
        const r = await generateRun(env, user, { batch: b.id, indexes: [index], regenerate: !!had?.output, approve: true, run: `campaign:${row.id}:${s.step}:${s.attempts}` }, ctx.waitUntil);
        if (r.status !== 200) throw new StudioError(String(r.body.error ?? "The image engine did not start."), 409);
        await patchStep(env, s, { post: index, ref_kind: "task", ref_id: String(index), note: "Sent to the image engine" });
        return;
      }
      case "frame": {
        const index = postOfItem(ctx, s.item);
        const v = video!;
        const shot = v.shots.find((x) => x.key === s.shot)!;
        const taken = new Set<string>();
        let angle = "left";
        for (const x of v.shots.filter((y) => y.source === "start-image").slice(1)) {
          const a = angleFor(x, taken);
          if (x.key === shot.key) angle = a;
        }
        if (row.simulate) {
          if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
          await settleCost(env, row, s, null);
          const k = ctx.steps.get(`${v.key}:-:image`)?.output_key;
          const obj = k ? await env.BUCKET.get(k) : null;
          const key = `${b.owner}/${b.id}/campaign/${row.id}/${v.key}-${shot.key}-frame-sim.${k?.endsWith(".png") ? "png" : "jpg"}`;
          if (obj) await env.BUCKET.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: obj.httpMetadata?.contentType || "image/jpeg" } });
          await patchStep(env, s, { status: "done", post: index, output_key: obj ? key : k ?? null, finished: now(), note: `${SIMULATED}: the key frame stands in for the "${angle}" angle.` });
          return;
        }
        const { estimatePhotoTool, runPhotoTool } = await import("./photo-tools");
        const ask = { batch: b.id, index: index!, tool: "mg-camera", options: { camera: angle } };
        const est = await estimatePhotoTool(env, user, ask);
        if (est.credits === null) throw new StudioError("Magnific could not estimate this angle: nothing was run.", 409);
        if (!(await reserveFor(env, row, s, est.credits))) return;
        const job = await runPhotoTool(env, user, { ...ask, confirm: true });
        await patchStep(env, s, { post: index, ref_kind: "photo_job", ref_id: job.id, note: `Magnific Change camera (${angle}) · ${est.credits} credits estimated` });
        if (job.status === "done") await settleStep(ctx, s);
        return;
      }
      case "clip": {
        const index = postOfItem(ctx, s.item);
        const v = video!;
        const shot = v.shots.find((x) => x.key === s.shot)!;
        const posterKey = await startKey(ctx, v, shot, b);
        if (row.simulate) {
          if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
          await settleCost(env, row, s, null);
          await patchStep(env, s, { status: "done", post: index, output_key: posterKey, ref_kind: "still", finished: now(), note: `${SIMULATED}: the starting picture is held as a still for ${shot.seconds} s.` });
          return;
        }
        const engine = v.clipEngine;
        const billing = await higgsfieldBilling(env);
        if ((engine.provider === "higgsfield-mcp") !== (billing === "credits")) {
          await patchStep(env, s, { status: "paused", attempts: s.attempts - 1, note: `Higgsfield billing is now "${billing}"; this clip was approved for ${engine.name}. Nothing was switched: change the plan's clip engine (and approve it) or switch the billing back.` });
          await pauseCampaign(env, row.id, "The Higgsfield billing differs from the approved clip engine; nothing was switched silently.");
          return;
        }
        const duration = clipSeconds(shot.seconds);
        const { castOf } = await import("./campaign");
        const prompt = clipPrompt(v, shot, await castOf(env, (JSON.parse(b.config) as Config).client ?? null));
        const note = `Campaign Autopilot ${v.key} ${shot.key}`;
        let videoId: string;
        if (engine.provider === "higgsfield-mcp") {
          const { estimateMcpVideo, submitMcpVideo } = await import("./higgsfield-mcp");
          const ask = { batch: b.id, index: index!, model: engine.model, prompt, duration, aspect: v.frame, source: "picture" as const };
          const est = await estimateMcpVideo(env, user, ask, false, { posterKey });
          if (est.unlimChoice) throw new StudioError("Higgsfield asks whether to use the unlimited allowance: answer it from the Video dialog once, then retry this step.", 409);
          const amount = est.credits ?? s.estimate;
          if (amount === null) throw new StudioError("Higgsfield gave no cost for this clip and none was accepted: nothing was sent.", 409);
          if (!(await reserveFor(env, row, s, amount))) return;
          const item = await submitMcpVideo(env, user, { ...ask, confirm: true, note }, { posterKey });
          videoId = item.id;
        } else {
          const { submitVideoRequest } = await import("./video");
          if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
          const item = await submitVideoRequest(env, user, { batch: b.id, index: index!, prompt, model: engine.model, duration, source: "picture", confirm: s.estimate !== null, note }, { posterKey });
          videoId = item.id;
        }
        await patchStep(env, s, { post: index, ref_kind: "video", ref_id: videoId, note: `${engine.name} · ${duration} s` });
        return;
      }
      case "assemble": {
        await assembleStep(ctx, s, b);
        return;
      }
      case "render":
        // The browser renders (a Worker cannot): the step waits for the campaign page.
        await patchStep(env, s, { status: "ready", attempts: s.attempts - 1, note: "Waiting for the campaign page to render it in the browser." });
        return;
    }
  } catch (e) {
    const message = errorMessage(e);
    // A timeout after the request was accepted: the outcome is unknown, so nothing is resent.
    const unknown = e instanceof StudioError && (e.data as { outcomeUnknown?: boolean } | undefined)?.outcomeUnknown;
    await failAttempt(env, row, s, message, unknown ? "unknown" : "no");
  }
}

/* ───────────── Settling running steps ───────────── */

async function settleStep(ctx: Ctx, s: StepRow): Promise<void> {
  const { env, row } = ctx;
  if (s.status !== "running") return;
  const b = await ownedPlan(env, ctx.user, row.batch);
  if (s.ref_kind === "task" && s.post) {
    const t = await first<{ status: string; output: string | null; error: string | null; updated: number }>(env.DB, "SELECT status, output, error, updated FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, s.post);
    if (!t) return;
    if ((t.status === "ready" || t.status === "approved") && t.output && t.updated >= (s.started ?? 0)) {
      const cost = await first<{ c: number | null }>(env.DB, "SELECT SUM(cost) AS c FROM post_takes WHERE batch = ? AND post = ? AND created >= ?", b.id, s.post, s.started ?? 0);
      await settleCost(env, row, s, cost?.c ?? null);
      await patchStep(env, s, { status: "done", output_key: t.output, finished: now() });
    } else if (t.status === "failed" && t.updated >= (s.started ?? 0)) {
      await failAttempt(env, row, s, t.error || "The image engine failed.", "no");
    }
    return;
  }
  if (s.ref_kind === "photo_job" && s.ref_id) {
    const { settlePhotoJobs } = await import("./photo-tools");
    const rows = await all<import("./photo-tools").PhotoJobRow>(env.DB, "SELECT * FROM photo_tool_jobs WHERE id = ?", s.ref_id);
    await settlePhotoJobs(env, b, rows).catch((e) => console.error("[campaign] photo settle", errorMessage(e)));
    const j = await first<import("./photo-tools").PhotoJobRow>(env.DB, "SELECT * FROM photo_tool_jobs WHERE id = ?", s.ref_id);
    if (j?.status === "done" && j.output_key) {
      await settleCost(env, row, s, j.reported ?? j.estimate);
      await patchStep(env, s, { status: "done", output_key: j.output_key, finished: now() });
    } else if (j?.status === "failed") await failAttempt(env, row, s, j.error || "Magnific failed.", j.provider_job ? "unknown" : "no");
    return;
  }
  if (s.ref_kind === "video" && s.ref_id && s.post) {
    const rows = await postRows(env, b.id, s.post);
    await settlePending(env, b, rows).catch((e) => console.error("[campaign] video settle", errorMessage(e)));
    const v = await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ?", s.ref_id);
    if (v?.status === "done" && v.key) {
      const op = v.op_id ? await first<{ reported: number | null }>(env.DB, "SELECT reported FROM integration_ops WHERE id = ?", v.op_id) : null;
      await settleCost(env, row, s, typeof op?.reported === "number" ? op.reported : null);
      await patchStep(env, s, { status: "done", output_key: v.key, finished: now() });
    } else if (v?.status === "failed") await failAttempt(env, row, s, v.error || "Higgsfield failed.", v.request_id ? "unknown" : "no");
  }
}

/* ───────────── Assembly and render ───────────── */

/** The music for a Reel: the track the plan names, else the client's or the catalog's first track whose mood the direction mentions. */
async function musicFor(env: Env, client: string | null, v: VideoPlanItem): Promise<MusicTrack | null> {
  const id = v.music.trackId;
  if (id?.startsWith("cat:")) {
    const e = catalogEntry(id.slice(4));
    return e ? catalogTrack(e) : null;
  }
  if (id?.startsWith("lib:")) {
    const r = await first<MusicTrackRow>(env.DB, "SELECT * FROM music_tracks WHERE id = ? AND archived IS NULL", id.slice(4));
    return r ? libraryTrack(r) : null;
  }
  const words = v.music.direction.toLowerCase();
  const lib = client ? await all<MusicTrackRow>(env.DB, "SELECT * FROM music_tracks WHERE client = ? AND archived IS NULL ORDER BY created DESC LIMIT 40", client).catch(() => []) : [];
  const tracks = [...lib.map(libraryTrack), ...CATALOG.filter((e) => !e.test).map((e) => catalogTrack(e))];
  return tracks.find((t) => t.moods.some((m) => words.includes(m))) ?? tracks[0] ?? null;
}

/** A client clip used as it is: copied once into the month as a version of the Reel's card (free). */
async function existingClip(env: Env, user: User, b: BatchRow, index: number, driveId: string): Promise<{ id: string; duration: number }> {
  const fp = `drive:${driveId}`;
  const found = await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE batch = ? AND post = ? AND source = 'upload' AND prompt = ?", b.id, index, fp);
  if (found) return { id: found.id, duration: parseSettings(found).duration ?? 5 };
  const info = await driveFileInfo(env, driveId);
  const clip = await driveFileCopy(env, info, 60 * 1024 * 1024);
  const meta = readMp4(clip.bytes);
  if (!meta.isMp4 || meta.video !== "h264") throw new StudioError(`${info.name}: only H.264 MP4 clips can be used as they are.`, 415);
  const task = await first<{ id: string; output: string | null }>(env.DB, "SELECT id, output FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, index);
  if (!task) throw new StudioError("The Reel's card has no picture yet.", 409);
  const id = uuid();
  const key = `${b.owner}/${b.id}/video/${task.id}/${id}.mp4`;
  await env.BUCKET.put(key, clip.bytes, { httpMetadata: { contentType: "video/mp4" } });
  const settings = { duration: meta.duration ? Math.round(meta.duration) : undefined, codecs: meta.codecs, width: meta.width, height: meta.height, note: `From the client's Drive: ${info.name}`.slice(0, 200), estimate: 0, estimateSource: "catalog" };
  await run(env.DB, "INSERT INTO videos (id, batch, post, task, owner, model, prompt, status, request_id, key, error, created, updated, provider, settings, poster_key, source, for_client, op_id) VALUES (?, ?, ?, ?, ?, 'upload', ?, 'done', NULL, ?, NULL, ?, ?, 'upload', ?, ?, 'upload', 0, NULL)", id, b.id, index, task.id, user.id, fp, key, now(), now(), JSON.stringify(settings), task.output);
  return { id, duration: meta.duration ?? 5 };
}

async function assembleStep(ctx: Ctx, s: StepRow, b: BatchRow): Promise<void> {
  const { env, user, row, plan } = ctx;
  const v = plan.videos.find((x) => x.key === s.item)!;
  const index = postOfItem(ctx, s.item);
  if (!index) throw new StudioError("The Reel's card is not made yet.", 409);
  const config = JSON.parse(b.config) as Config;
  const setup = JSON.parse(row.setup) as { language: "ar" | "en" | "both" };
  const fileUrl = (step: string) => `/api/studio/campaigns/${row.id}/file?step=${encodeURIComponent(step)}`;
  const shots: AssembleShot[] = [];
  for (const shot of v.shots) {
    if (shot.source === "existing") {
      if (shot.asset?.media === "clip") {
        const c = await existingClip(env, user, b, index, shot.asset.id);
        shots.push({ key: shot.key, seconds: shot.seconds, text: shot.text, source: { kind: "video", videoId: c.id, duration: c.duration, origin: "existing" } });
      } else shots.push({ key: shot.key, seconds: shot.seconds, text: shot.text, source: { kind: "photo", url: `/api/studio/drive/photo/${encodeURIComponent(shot.asset!.id)}?size=1600`, name: shot.asset!.label } });
      continue;
    }
    const clip = ctx.steps.get(`${v.key}:${shot.key}:clip`);
    if (!clip || clip.status !== "done") throw new StudioError(`Shot ${shot.key} is not finished.`, 409);
    if (clip.ref_kind === "still") shots.push({ key: shot.key, seconds: shot.seconds, text: shot.text, source: { kind: "photo", url: fileUrl(clip.step), name: `${v.key} ${shot.key} (simulated)` } });
    else {
      const vr = await first<VideoRow>(env.DB, "SELECT * FROM videos WHERE id = ?", clip.ref_id);
      if (!vr?.key) throw new StudioError(`Shot ${shot.key}'s clip is missing.`, 409);
      shots.push({ key: shot.key, seconds: shot.seconds, text: shot.text, source: { kind: "video", videoId: vr.id, duration: parseSettings(vr).duration ?? clipSeconds(shot.seconds), origin: "generated" } });
    }
  }
  const client = config.client ? await first<{ logo_key: string | null; name: string }>(env.DB, "SELECT logo_key, name FROM clients WHERE id = ?", config.client) : null;
  const music = await musicFor(env, config.client ?? null, v);
  const input = {
    name: `${v.hook || v.concept.slice(0, 40)} · Autopilot`,
    batch: b.id,
    shots,
    frame: v.frame,
    hook: v.hook,
    cta: v.cta,
    language: setup.language,
    transitions: v.transitions,
    look: v.look,
    logo: client?.logo_key && config.client ? { src: `/api/studio/clients/${config.client}/logo`, name: `${client.name} logo` } : null,
    music,
  };
  const project = assembleReel(input);
  const checked = validateProject(project);
  if (!checked.ok) throw new StudioError(`The assembled project is not valid: ${checked.reason}`, 500);
  // One project per Reel and campaign: a second assembly (after an edit) saves a new revision of it.
  const t = now();
  const existing = s.ref_id ? await first<{ id: string; rev: number }>(env.DB, "SELECT id, rev FROM video_projects WHERE id = ?", s.ref_id) : null;
  let projectId: string;
  if (existing) {
    projectId = existing.id;
    await run(env.DB, "UPDATE video_projects SET project = ?, rev = rev + 1, updated = ?, updated_by = ? WHERE id = ?", JSON.stringify({ ...checked.project, rev: existing.rev + 1 }), t, user.id, projectId);
  } else {
    projectId = uuid();
    await run(env.DB, "INSERT INTO video_projects (id, batch, post, name, project, rev, source_video, rendered_video, created, updated, created_by, updated_by) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?, ?)", projectId, b.id, index, checked.project.name.slice(0, 120), JSON.stringify({ ...checked.project, rev: 1 }), t, t, user.id, user.id);
  }
  await patchStep(env, s, { status: "done", post: index, ref_kind: "project", ref_id: projectId, finished: now(), note: `Editable project with ${shots.length} shots${music ? ` · music: ${music.title}` : ""}${row.simulate ? ` · ${SIMULATED}` : ""}` });
  const render = ctx.steps.get(`${v.key}:-:render`);
  if (render) await patchStep(env, render, { ref_kind: "project", ref_id: projectId, post: index, data: JSON.stringify({ stills: stillShots(input) }) });
}

/** The browser stored a render of the Reel's project on its card (the editor's own render job): the render step is done. */
export async function finishRender(env: Env, row: CampaignRow, step: string, videoId: string): Promise<void> {
  const s = await first<StepRow>(env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, step);
  if (!s || s.kind !== "render") throw new StudioError("Step not found.", 404);
  const r = await first<{ id: string; project: string; status: string; post: number }>(env.DB, "SELECT id, project, status, post FROM video_renders WHERE video_id = ? AND batch = ? ORDER BY created DESC LIMIT 1", videoId, row.batch);
  if (!r || r.project !== s.ref_id) throw new StudioError("That version is not a render of this Reel's project.", 409);
  if (r.status !== "done") throw new StudioError("The render has not finished.", 409);
  await run(env.DB, "UPDATE campaign_steps SET status = 'done', ref_kind = 'render', output_key = (SELECT key FROM videos WHERE id = ?), note = ?, finished = ?, updated = ? WHERE campaign = ? AND step = ? AND status != 'done'", videoId, `Rendered in the browser and stored on card ${r.post} (render ${r.id.slice(0, 8)})`, now(), now(), row.id, step);
}

/** A words-only edit after approval: the card's words follow; the Reel is assembled and rendered again (free). */
export async function applyWords(env: Env, user: User, row: CampaignRow, b: BatchRow, plan: CampaignPlan, item: string): Promise<void> {
  const post = await first<StepRow>(env.DB, "SELECT * FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, `${item}:-:post`);
  if (post?.post) {
    const fresh = await ownedPlan(env, user, b.id);
    const config = JSON.parse(fresh.config) as Config;
    const { image, video } = itemOf(plan, item);
    config.plan = (config.plan ?? []).map((p) => {
      if (p.index !== post.post) return p;
      if (image) return { ...p, headline: image.headline || undefined, caption: [image.caption, image.cta].filter(Boolean).join("\n"), captionHand: true };
      if (video) return { ...p, headline: video.hook || undefined, caption: [video.caption, video.cta].filter(Boolean).join("\n"), captionHand: true };
      return p;
    });
    await saveConfig(env, fresh, config);
  }
  await run(env.DB, "UPDATE campaign_steps SET status = 'waiting', note = 'Words changed: assembled and rendered again (free).', updated = ? WHERE campaign = ? AND item = ? AND kind IN ('assemble', 'render') AND status IN ('done', 'ready', 'failed')", now(), row.id, item);
}

/* ───────────── One pass ───────────── */

/**
 * Settles what is running, then starts what is ready, then says whether the campaign is done.
 * Completion is "ready for review": nothing is sent to the client or published.
 */
export async function advanceCampaign(env: Env, user: User, id: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const row = await readRow(env, id);
  if (!row || row.status !== "producing") return;
  const plan = stripListIdRefs(JSON.parse(row.plan) as CampaignPlan);
  const approval = row.approval ? (JSON.parse(row.approval) as StoredApproval) : null;
  const held = new Set(approval?.needsApproval ?? []);
  const list = await stepsOf(env, id);
  const ctx: Ctx = { env, user, row, plan, steps: new Map(list.map((s) => [s.step, s])), waitUntil };
  for (const s of list) if (s.status === "running") await settleStep(ctx, s).catch((e) => console.error("[campaign] settle", s.step, errorMessage(e)));
  // A running render the tab stopped reporting on is offered again.
  for (const s of list) if (s.kind === "render" && s.status === "running" && now() - s.updated > RENDER_STALE_MS) await patchStep(env, s, { status: "ready" });
  // Waiting steps whose inputs are done become ready.
  for (const s of list) {
    if (s.status !== "waiting" || held.has(s.item)) continue;
    const deps = JSON.parse(s.deps) as string[];
    if (deps.every((d) => ctx.steps.get(d)?.status === "done")) await patchStep(env, s, { status: "ready" });
  }
  const started: Record<string, number> = {};
  for (const s of list) {
    if (s.status !== "ready" || held.has(s.item)) continue;
    const fresh = await readRow(env, id);
    if (fresh?.status !== "producing") break;
    if ((started[s.kind] ?? 0) >= START_LIMIT[s.kind]) continue;
    started[s.kind] = (started[s.kind] ?? 0) + 1;
    await startStep(ctx, s);
  }
  const after = await stepsOf(env, id);
  const open = after.filter((s) => s.status !== "done" && s.status !== "skipped");
  if (!open.length) await run(env.DB, "UPDATE campaign_plans SET status = 'done', pause_reason = NULL, updated = ? WHERE id = ? AND status = 'producing'", now(), id);
  else if (open.every((s) => s.status === "failed" || s.status === "paused" || (s.status === "waiting" && (held.has(s.item) || (JSON.parse(s.deps) as string[]).some((d) => ["failed", "paused"].includes(after.find((x) => x.step === d)?.status ?? "")))))) {
    const failed = open.filter((s) => s.status === "failed").length;
    await pauseCampaign(env, id, failed ? `${failed} step${failed === 1 ? "" : "s"} failed after the approved attempts. Everything else is kept: retry the failed step${failed === 1 ? "" : "s"} alone.` : "Waiting for an approval of the changed items.");
  }
  await run(env.DB, "UPDATE campaign_plans SET updated = ? WHERE id = ?", now(), id);
}

/** The cron's pass over the campaigns in production, as their admins. */
export async function advanceCampaigns(env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const rows = await all<{ id: string; owner: string }>(env.DB, "SELECT id, owner FROM campaign_plans WHERE status = 'producing' ORDER BY updated LIMIT 5").catch(() => []);
  for (const r of rows) {
    const user = await first<User>(env.DB, "SELECT id, email, name, role FROM users WHERE id = ?", r.owner);
    if (!user || user.role !== "admin") continue;
    await advanceCampaign(env, user, r.id, waitUntil).catch((e) => console.error("[campaign] cron", r.id, errorMessage(e)));
  }
}
