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
import { FORMATS, MAX_POST_COUNT, postRevision, type Format, type Post, type PostReference } from "@shared/posts";
import { validateProject } from "@shared/video-project";
import type { MusicTrack } from "@shared/music";
import type { Config } from "@shared/config";
import type { User } from "@shared/types";
import { clipSeconds, postKindById, stepSignature, type CampaignPlan, type CostUnit, type ImagePlanItem, type ShotPlan, type VideoPlanItem } from "../shared/campaign-plan";
import { assembleReel, stillShots, type AssembleShot } from "../shared/campaign-assemble";
import { onScreenWords, peopleRule, showsPeople, STUDIO_WORDS, stripListIdRefs, type CastMember } from "../shared/campaign-planner";
import { REAL_PEOPLE_RULE, realRefLine } from "../shared/realism";
import { directionLines, LOOK_AVOID, MOTION_AVOID, movementLine, ON_LOCATION, referenceLine, registerLine, setupLine } from "../shared/cinematography";
import { angleById, anglePlateKey } from "../shared/angle-library";
import { templateById, type CreativeTemplate } from "../shared/creative-templates";
import type { CampaignRow, StepRow, StoredApproval } from "./campaign";

export const campaignScope = (id: string, unit: CostUnit) => `campaign:${id}:${unit}`;

/** Steps started in one pass, per kind: the providers are not flooded and one pass stays short. */
const START_LIMIT: Record<StepRow["kind"], number> = { post: 12, image: 3, frame: 3, review: 0, clip: 3, assemble: 4, render: 0 };
/** A render the browser started and stopped reporting on, after this long, is offered again. */
const RENDER_STALE_MS = 3 * 60 * 1000;

/** A shot picture still "running" this long after it started lost its pass (the engine answers in about a minute). */
const ENGINE_FRAME_STALE_MS = 8 * 60 * 1000;

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
 * A camera position from the angle library as the card's reference picture: the plate is copied
 * into the month (the card may delete its reference) and labelled as composition only.
 */
async function anglePlateRef(env: Env, b: BatchRow, campaignId: string, angleId: string): Promise<PostReference | null> {
  const pos = angleById(angleId);
  if (!pos) return null;
  const key = `${b.owner}/${b.id}/campaign/${campaignId}/angle-${pos.id}.jpg`;
  const thumb = `${b.owner}/${b.id}/campaign/${campaignId}/angle-${pos.id}-thumb.jpg`;
  if (!(await env.BUCKET.head(key))) {
    const [bw, colour] = await Promise.all([env.BUCKET.get(anglePlateKey(pos.id, true)), env.BUCKET.get(anglePlateKey(pos.id, false))]);
    if (!bw) return null;
    await env.BUCKET.put(key, await bw.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
    if (colour) await env.BUCKET.put(thumb, await colour.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
  }
  return { key, thumb, name: `Camera: ${pos.name}`, note: `Composition only: take this photo's camera position, height, distance and framing (${pos.words}). Take nothing else from it: not its white cup, its place, its people, its light or its colours.`, at: now() };
}

/**
 * A new card number for the step, claimed in one conditional update: above every card in the month
 * and every number another campaign step of this month holds. A step another pass already gave a
 * number keeps that one.
 */
async function claimPostIndex(env: Env, row: CampaignRow, s: StepRow, posts: { index: number }[]): Promise<number> {
  const stale = s.post ?? -1;
  for (let n = 0; n < 6; n++) {
    const held = await first<{ m: number | null }>(env.DB, "SELECT MAX(x.post) m FROM campaign_steps x JOIN campaign_plans p ON x.campaign = p.id WHERE p.batch = ?", row.batch);
    const want = Math.max(posts.reduce((m, p) => Math.max(m, p.index), 0), held?.m ?? 0) + 1 + n;
    const claimed = await run(env.DB, "UPDATE campaign_steps SET post = ?, updated = ? WHERE campaign = ? AND step = ? AND (post IS NULL OR post = ?) AND NOT EXISTS (SELECT 1 FROM campaign_steps x JOIN campaign_plans p ON x.campaign = p.id WHERE p.batch = ? AND x.post = ?)", want, now(), row.id, s.step, stale, row.batch, want);
    if (claimed) return want;
    const mine = await first<{ post: number | null }>(env.DB, "SELECT post FROM campaign_steps WHERE campaign = ? AND step = ?", row.id, s.step);
    if (mine?.post && mine.post !== stale) return mine.post;
  }
  throw new StudioError("Could not reserve a card number in the month; the step will try again.", 409);
}

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
  const before = (JSON.parse((await ownedPlan(env, user, row.batch)).config) as Config).plan ?? [];
  // The item's card already exists (an earlier attempt, or the approval before an edit): it is
  // updated in place, never doubled; its pictures stay its versions. A new card's number is claimed
  // in one statement, so two passes at once never give two items the same card (seen live, 24 Oct).
  const had = s.post && before.some((p) => p.index === s.post) ? s.post : null;
  if (!had && before.length >= MAX_POST_COUNT) throw new StudioError(`The month holds ${MAX_POST_COUNT} posts already.`, 409);
  const index = had ?? (await claimPostIndex(env, row, s, before));
  const fresh = await ownedPlan(env, user, row.batch);
  const config = JSON.parse(fresh.config) as Config;
  const planPosts = config.plan ?? [];
  const existing = planPosts.find((p) => p.index === index);
  const t = now();
  const setup = JSON.parse(row.setup) as { imageFormat?: string; direction?: { prompt?: string } };
  // A studio only when the admin's direction asks for one by name; every other idea is on location.
  const studioAsked = /\bstudio\b/i.test(setup.direction?.prompt ?? "");
  let post: Post;
  if (image) {
    const pos = angleById(image.angleId);
    // A product hero, a detail or a graphic ad is a designed picture: its set is built, not found.
    const kind = postKindById(image.kind);
    const located = !!image.setting && !studioAsked && !kind?.designed;
    const reference = pos ? await anglePlateRef(env, b, row.id, pos.id) : null;
    const where = image.setting && `${kind?.designed ? "SET" : "PLACE"}: ${image.setting.replace(/[.\s]+$/, "")}.`;
    post = { index, type: kind ? (kind.people ? "lifestyle" : "product") : product ? "product" : "lifestyle", title, brief: [kind && `KIND OF PICTURE: ${kind.label}: ${kind.words}.`, image.idea, image.visual, where, pos && `CAMERA POSITION "${pos.name}": ${pos.words}.`, located ? ON_LOCATION : ""].filter(Boolean).join("\n").trim(), ...(located ? { onLocation: true } : {}), ...(reference ? { reference } : {}), caption: [image.caption, image.cta].filter(Boolean).join("\n"), hashtags: "", headline: image.headline || undefined, format: asFormat(setup.imageFormat ?? config.format ?? "4:5"), ideaAt: t, captionHand: true, ...(product ? { product } : {}) };
  } else {
    const v = video!;
    const keyShot = v.shots.find((x) => x.source === "start-image") ?? v.shots[0];
    const located = !!v.direction?.place && !STUDIO_WORDS.test(v.direction.place) && !studioAsked;
    const reference = keyShot?.angleId ? await anglePlateRef(env, b, row.id, keyShot.angleId) : null;
    post = { index, type: product ? "product" : "lifestyle", title, brief: [v.concept, `Key frame: ${keyShot?.action ?? ""}`, keyShot ? setupLine(keyShot) : "", ...directionLines(v.direction), registerLine(v.format), located ? ON_LOCATION : "", v.direction ? LOOK_AVOID : ""].filter(Boolean).join("\n").trim(), ...(located ? { onLocation: true } : {}), ...(reference ? { reference } : {}), caption: [v.caption, v.cta].filter(Boolean).join("\n"), hashtags: "", headline: onScreenWords(v.hook) || undefined, overlay: false, format: asFormat(v.frame), ideaAt: t, captionHand: true, ...(product ? { product } : {}) };
  }
  // A card that shows a person or a hand names the client's cast, so the engine draws one of them
  // (from his or her reference photo) instead of inventing someone.
  const { castOf } = await import("./campaign");
  const cast = await castOf(env, config.client ?? null);
  const words = image ? `${image.idea} ${image.visual}` : `${video!.concept} ${video!.shots.map((x) => x.action).join(" ")}`;
  const person = castFor(cast, words, image ? postKindById(image.kind) : null);
  if (person) post.people = [person];
  if (existing) {
    // Kept from the card: its date, group and anything the team set on it since.
    const { index: _i, ...words2 } = post;
    void _i;
    config.plan = planPosts.map((p) => (p.index === index ? { ...p, ...words2, people: post.people ?? p.people } : p));
  } else {
    config.plan = [...planPosts, post];
    config.postCount = Math.min(MAX_POST_COUNT, Math.max(config.postCount ?? planPosts.length, planPosts.length) + 1);
  }
  await saveConfig(env, fresh, config);
  return index;
}

/**
 * The cast member a card shows: the one its words name; none for a picture kind without people (a
 * product hero, a detail, a graphic ad), or when the words show no one; otherwise the first of the
 * cast only when nobody is named. (Before, every card with a person or a hand got the first cast
 * member, so one ambassador ended up in every piece.)
 */
export function castFor(cast: { name: string }[], words: string, kind: { people: boolean } | null): string | null {
  if (!cast.length || !showsPeople(words)) return null;
  const named = cast.find((m) => m.name && new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(words));
  if (named) return named.name;
  if (kind && !kind.people) return null;
  return cast[0].name;
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
  const photo = await productPhoto(env, plan, item);
  if (photo) return photo;
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
  /** A background pass (the cron), which may wait on a picture engine that answers in one long call. */
  background: boolean;
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
export function clipPrompt(v: VideoPlanItem, s: ShotPlan, cast: CastMember[] = [], opts: { references?: boolean } = {}): string {
  const people = peopleRule(cast).replace(/^PEOPLE: /, "").replace(" in a post or shot", "");
  const d = v.direction;
  return [
    v.hookMove && s.key === v.shots?.[0]?.key ? `The first second, to stop the scroll: ${v.hookMove}` : "",
    s.action,
    setupLine(s),
    movementLine(s, v.format),
    registerLine(v.format),
    d?.lighting && `Light, as in the start frame: ${d.lighting}`,
    d?.colour && `Colour: ${d.colour}; keep the start frame's grade, skin tones natural.`,
    v.product ? `Keep ${v.product.name} exactly as in the picture: shape, label, colours and contents unchanged.` : "",
    opts.references ? "The reference images are the real product and the cast's faces: keep them exactly; never take anything else from them." : "",
    "No text appears; no new objects or people.",
    MOTION_AVOID,
    showsPeople(s.action) || cast.length ? `People: ${people}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2400);
}

/** The picture a shot's clip starts from. */
async function startKey(ctx: Ctx, v: VideoPlanItem, s: ShotPlan, b: BatchRow): Promise<string> {
  if (v.template) {
    const key = await productKeyFor(ctx, b, v);
    if (!key) throw new StudioError("A template Reel is made from the product's photo: give the Reel a product with a photo.", 409);
    return key;
  }
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

/** What "Make again" asked for: the admin's note, else the automatic check's notes on the last picture. */
export function redoNote(s: Pick<StepRow, "data" | "note">): string {
  let asked = "";
  try {
    asked = s.data ? ((JSON.parse(s.data) as { note?: string }).note ?? "").trim() : "";
  } catch {
    asked = "";
  }
  if (asked) return asked.slice(0, 600);
  const flagged = /^The automatic check asks you to look: (.+)$/s.exec(s.note ?? "");
  return flagged ? `Fix what the check found on the last picture: ${flagged[1]}`.slice(0, 600) : "";
}

/** The prompt a shot's own starting picture is made with: the shot's moment, the key frame's world. */
export function framePrompt(v: VideoPlanItem, s: ShotPlan, opts: { cast?: CastMember[]; rules?: string[]; note?: string; productPhoto?: boolean; faces?: { name: string; image: number }[]; realRef?: number | null; refs?: { role: "colour" | "composition"; image: number }[]; plate?: number | null } = {}): string {
  const cast = opts.cast ?? [];
  const people = peopleRule(cast).replace(/^PEOPLE: /, "");
  const faces = opts.faces ?? [];
  const withPeople = showsPeople(s.action) || faces.length > 0;
  return [
    "Make one photograph: the starting frame of one shot in a short vertical video ad. It must look like a real photo from the same shoot as the first image.",
    v.direction?.place && !STUDIO_WORDS.test(v.direction.place)
      ? "The first image is the campaign's key frame: keep the same people (same faces, skin tone, hands and clothes), the same light, time of day, weather and colour palette. The place is this shot's own spot in the same world (it may be another part of the same street, car, room or terrace); never a studio or a plain backdrop."
      : "The first image is the campaign's key frame: keep the same people (same faces, skin tone, hands and clothes), the same place, light, time of day and colour palette.",
    v.product ? `${opts.productPhoto ? "The second image is the product itself, and it wins over the key frame: " : ""}keep ${v.product.name} exactly as ${opts.productPhoto ? "that photo shows it" : "it is"}: the same cup, shape, label, colours, size and toppings. Add nothing the product photo does not show (no mint or other garnish, no straw, no lid, no extra toppings), even if the key frame shows them.` : "",
    `The campaign idea: ${v.concept}`,
    ...directionLines(v.direction),
    `THIS SHOT: ${s.action}`,
    setupLine(s),
    s.camera && `The clip will move like this: ${s.camera}; frame the start of that move.`,
    "This is a different camera setup in the same scene as the key frame: build the composition this shot describes; do not copy the key frame's composition, crop or pose.",
    ...(opts.refs ?? []).map((r) => referenceLine(r.role, r.image)),
    opts.plate ? `Image ${opts.plate} is a black-and-white camera-position reference: copy its camera height, angle, distance and framing exactly; take nothing else from it (not its white cup, place, people, light or colours).` : "",
    registerLine(v.format),
    v.direction?.place && !STUDIO_WORDS.test(v.direction.place) ? ON_LOCATION : "",
    v.format === "ugc"
      ? `A vertical ${v.frame} frame of creator phone footage: real textures, nothing extra in the frame, no text, no captions, no logos added, no legible signs of other businesses, no car badges, no watermark, no split screen.`
      : `A vertical ${v.frame} frame from a professionally filmed lifestyle commercial: natural skin and textures, nothing extra in the frame, no text, no captions, no logos added, no legible signs of other businesses, no car badges, no watermark, no split screen.`,
    LOOK_AVOID,
    showsPeople(s.action) || cast.length ? `People: ${people}` : "",
    ...faces.map((f) => `Image ${f.image} is ${f.name}'s portrait: wherever ${f.name} appears, it is exactly this man's face (face shape, eyes, nose, beard, hairline, skin tone), photographed again in this scene.`),
    faces.length > 1 ? `${faces.map((f) => f.name).join(" and ")} are different people with different faces: never give two people the same face, never twins.` : "",
    withPeople ? REAL_PEOPLE_RULE : "",
    opts.realRef ? realRefLine(opts.realRef) : "",
    opts.rules?.length ? `Brand rules (never break them): ${opts.rules.slice(0, 8).join(" · ")}` : "",
    opts.note ? `Fix this from the last try: ${opts.note}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

/** The product's photo, when the plan names one in the library or on Drive (read-only, free). */
async function productPhoto(env: Env, plan: CampaignPlan, item: string): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
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
  return null;
}

/** The inspiration pictures a shot's picture may borrow from, each with its role (Drive, read-only, free). */
async function inspirationFor(env: Env, row: CampaignRow, shot: ShotPlan): Promise<{ role: "colour" | "composition"; img: { bytes: ArrayBuffer; mime: string } }[]> {
  const picks: { id: string; role: "colour" | "composition" }[] = [];
  if (shot.reference?.kind === "reference") picks.push({ id: shot.reference.id, role: shot.reference.role ?? "composition" });
  try {
    const setup = JSON.parse(row.setup) as { direction?: { references?: { id: string; role?: string }[] } };
    const colour = setup.direction?.references?.find((r) => r.role === "colour" && !picks.some((p) => p.id === r.id));
    if (colour) picks.push({ id: colour.id, role: "colour" });
  } catch {
    /* no setup references */
  }
  const out: { role: "colour" | "composition"; img: { bytes: ArrayBuffer; mime: string } }[] = [];
  for (const p of picks.slice(0, 2)) {
    const img = await photoBytes(env, p.id, 1200).catch(() => null);
    if (img && /^image\/(png|jpeg|webp)$/i.test(img.mime)) out.push({ role: p.role, img });
  }
  return out;
}

/**
 * A shot's own starting picture, made by Google's image engine from the key frame (and the product's
 * photo) and the shot's words. Google answers in one call: the step is done or failed when it returns.
 */
async function engineFrame(ctx: Ctx, s: StepRow, b: BatchRow, v: VideoPlanItem, shot: ShotPlan, index: number | null): Promise<void> {
  const { env, row } = ctx;
  const model = v.frameEngine.model;
  const keyFrame = ctx.steps.get(`${v.key}:-:image`)?.output_key;
  const keyObj = keyFrame ? await env.BUCKET.get(keyFrame) : null;
  if (!keyObj) throw new StudioError("The key frame is not made yet.", 409);
  const config = JSON.parse(b.config) as Config;
  const { castOf } = await import("./campaign");
  const cast = await castOf(env, config.client ?? null);
  const rules = config.client ? await (await import("./lessons")).lessonsFor(env, config.client, { batch: b.id }).catch(() => [] as string[]) : [];
  const product = await productPhoto(env, ctx.plan, s.item);
  // The cast's portraits (the people this shot names, else everyone when it shows people) and one real photo for realism.
  const named = cast.filter((m) => new RegExp(`\\b${m.name}\\b`, "i").test(`${shot.action} ${v.concept}`));
  const shown = named.length ? named : showsPeople(shot.action) ? cast : [];
  const portraits: { name: string; img: { bytes: ArrayBuffer; mime: string } }[] = [];
  for (const m of shown.slice(0, 3)) {
    const row = config.client ? await first<{ image_key: string | null }>(env.DB, "SELECT image_key FROM ambassadors WHERE client = ? AND name = ?", config.client, m.name).catch(() => null) : null;
    const obj = row?.image_key ? await env.BUCKET.get(row.image_key) : null;
    if (obj) portraits.push({ name: m.name, img: { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" } });
  }
  const realKey = shown.length ? ((config.client ? await first<{ key: string }>(env.DB, "SELECT key FROM brand_assets WHERE client = ? AND kind = 'realref' ORDER BY RANDOM() LIMIT 1", config.client).catch(() => null) : null) ?? (await first<{ key: string }>(env.DB, "SELECT key FROM brand_assets WHERE kind = 'realref' ORDER BY RANDOM() LIMIT 1").catch(() => null))) : null;
  const realObj = realKey ? await env.BUCKET.get(realKey.key) : null;
  const real = realObj ? { bytes: await realObj.arrayBuffer(), mime: realObj.httpMetadata?.contentType || "image/jpeg" } : null;
  const first2 = product ? 3 : 2;
  const faces = portraits.map((p, n) => ({ name: p.name, image: first2 + n }));
  // Inspiration references, labelled by what they may lend: the shot's own (its framing, unless marked
  // for colour) and the campaign's first colour reference. Never the product: that is its own photo.
  const inspiration = await inspirationFor(env, row, shot);
  const refStart = first2 + portraits.length + (real ? 1 : 0);
  const refs = inspiration.map((r, n) => ({ role: r.role, image: refStart + n }));
  // The shot's camera position from the angle library, in black and white (it lends the framing only).
  const plateObj = shot.angleId && angleById(shot.angleId) ? await env.BUCKET.get(anglePlateKey(shot.angleId, true)) : null;
  const plate = plateObj ? { bytes: await plateObj.arrayBuffer(), mime: "image/jpeg" } : null;
  const prompt = framePrompt(v, shot, { cast, rules, note: redoNote(s), productPhoto: !!product, faces, realRef: real ? first2 + portraits.length : null, refs, plate: plate ? refStart + inspiration.length : null });
  if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
  await patchStep(env, s, { post: index, ref_kind: "engine", ref_id: model, note: `Making this shot's picture with ${model}` });
  const { makeGoogleClient } = await import("./engine");
  const engine = await makeGoogleClient(env);
  let img: { bytes: ArrayBuffer; mime: string };
  try {
    img = await engine.edit({ model, prompt, images: [{ bytes: await keyObj.arrayBuffer(), mime: keyObj.httpMetadata?.contentType || "image/png" }, ...(product ? [product] : []), ...portraits.map((p) => p.img), ...(real ? [real] : []), ...inspiration.map((r) => r.img), ...(plate ? [plate] : [])], aspectRatio: v.frame, size: config.size ?? "2K" });
  } catch (e) {
    // Google bills a picture it returns: a refusal or an error answer returns none; a lost connection may have made one.
    const message = errorMessage(e);
    await failAttempt(env, row, s, `${model}: ${message}`, /timed? ?out|abort|network|connection/i.test(message) ? "unknown" : "no");
    return;
  }
  const mime = img.mime || "image/png";
  const key = `${b.owner}/${b.id}/campaign/${row.id}/${v.key}-${shot.key}-frame-${s.attempts}.${/jpe?g/.test(mime) ? "jpg" : /webp/.test(mime) ? "webp" : "png"}`;
  await env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: mime } });
  await settleCost(env, row, s, s.reserved);
  const made = `Made by ${model} from the key frame${product ? ", the product photo" : ""}${portraits.length ? `, ${portraits.map((p) => p.name).join(" and ")}'s portrait${portraits.length > 1 ? "s" : ""}` : ""}, for this shot's own moment`;
  // The automatic check (one text call): the people's faces and an AI look, shown on the shot for the admin.
  const keyBytes = await env.BUCKET.get(keyFrame!).then((o) => (o ? o.arrayBuffer().then((bytes) => ({ bytes, mime: o.httpMetadata?.contentType || "image/png" })) : null));
  const flags = portraits.length || showsPeople(shot.action) || product ? await checkFrame(env, { bytes: img.bytes, mime }, portraits, shot, product, keyBytes).catch((e) => (console.error("[campaign] frame check", errorMessage(e)), [] as string[])) : [];
  await patchStep(env, s, { status: "done", output_key: key, finished: now(), note: flags.length ? `The automatic check asks you to look: ${flags.join("; ")}`.slice(0, 500) : made });
}

const FRAME_CHECK_SCHEMA = { type: "object", properties: { problems: { type: "array", items: { type: "string" } } }, required: ["problems"] } as const;

/** What a person would object to in a shot's picture: the wrong or a repeated face, an AI look, broken hands. */
async function checkFrame(env: Env, pic: { bytes: ArrayBuffer; mime: string }, portraits: { name: string; img: { bytes: ArrayBuffer; mime: string } }[], shot: ShotPlan, product: { bytes: ArrayBuffer; mime: string } | null = null, keyFrame: { bytes: ArrayBuffer; mime: string } | null = null): Promise<string[]> {
  const { askText, parseJson } = await import("./posts");
  const at = 2 + (product ? 1 : 0) + (keyFrame ? 1 : 0);
  const instruction = [
    "You check one picture for a brand's video ad before it is animated. Image 1 is the picture.",
    product ? "Image 2 is the real product photo." : "",
    keyFrame ? `Image ${product ? 3 : 2} is the Reel's key frame, another shot of the same scene.` : "",
    ...portraits.map((p, n) => `Image ${n + at} is ${p.name}'s portrait.`),
    keyFrame ? "- broken continuity with the key frame: different light direction or time of day, a different grade or colour cast, different clothes, a different product, or a place from another world (another spot of the same street, car or room is fine);" : "",
    "- a studio look when the shot is set in a real place: a seamless or solid-colour backdrop, a pedestal, a plain matte plane behind the product; legible signs of other businesses or car badges;",
    "- a generated look: plastic or waxy skin, HDR, oversaturation, orange-and-teal grade, glow, heavy background blur, a distorted face or product;",
    product ? "- the product differing from its photo: added garnish (mint, fruit), a straw or a lid the photo does not show, other toppings, another cup, a changed label or colour;" : "",
    `The shot should show: ${shot.action}`,
    "List only problems you can clearly see and are certain of, that a creative director would reject, each in one short sentence; when unsure, leave it out (a false alarm costs a new picture). Count fingers before calling a hand malformed.",
    portraits.length ? "- a person whose face does not match their portrait; two people with the same face (twins). Compare faces only: the portraits' clothes do not count, the clothes follow the key frame;" : "",
    "- people who look AI-generated rather than photographed (waxy or plastic skin, airbrushed face, doll eyes, CGI smoothness, a stiff pose or frozen smile, a person lit separately from the set);",
    "- extra, missing or malformed hands or fingers; a woman or a girl, or a woman's hand, when the people should be men only; people toasting or clinking cups or glasses together;",
    "- the picture showing something else than the shot asks (a different action or place); close-up versus macro or a slightly different pose is not a problem.",
    'Answer {"problems": []} when it is fine.',
  ]
    .filter(Boolean)
    .join("\n");
  const out = parseJson<{ problems?: string[] }>(await askText(env, instruction, FRAME_CHECK_SCHEMA, [pic, ...(product ? [product] : []), ...(keyFrame ? [keyFrame] : []), ...portraits.map((p) => p.img)]));
  return (out.problems ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
}

/** The brief a template Reel is made with: the planner's brief, what to adapt, the product's truth and the brand's rules. */
export function templatePrompt(v: VideoPlanItem, t: CreativeTemplate, cast: CastMember[] = []): string {
  const people = peopleRule(cast).replace(/^PEOPLE: /, "");
  return [
    v.template?.brief || v.concept,
    v.hookMove ? `The first second: ${v.hookMove}` : "",
    `Adapt the template for this brand: ${t.adapt}.`,
    v.product ? `The product is ${v.product.name}${v.product.note ? ` (${v.product.note})` : ""}: keep it exactly as in the photo (shape, label, colours, contents, size); add nothing to it.` : "",
    t.person === "none" ? "No people, at most hands." : `People: ${people}`,
    "Any place is in Jordan (Amman unless the brief says otherwise). No other brands' logos or legible signs; words on screen only as the template uses them, short and true to the product.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 4000);
}

/** The product's photo as a file of this month (a Drive photo is copied once): a template's input. */
async function productKeyFor(ctx: Ctx, b: BatchRow, v: VideoPlanItem): Promise<string | null> {
  const p = v.product;
  if (p?.from === "library") {
    const src = await first<{ key: string; reference_key: string | null }>(ctx.env.DB, "SELECT key, reference_key FROM sources WHERE id = ?", p.id);
    return src ? (src.reference_key ?? src.key) : null;
  }
  if (p?.from === "drive") {
    const key = `${b.owner}/${b.id}/campaign/${ctx.row.id}/product-${p.id}.jpg`;
    if (!(await ctx.env.BUCKET.head(key))) {
      const img = await photoBytes(ctx.env, p.id, 1600).catch(() => null);
      if (img) await ctx.env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    }
    return (await ctx.env.BUCKET.head(key)) ? key : null;
  }
  return null;
}

/** Stored keys of the product's photo and the portraits of the people a shot shows (identity references for the clip). */
async function identityKeys(ctx: Ctx, b: BatchRow, v: VideoPlanItem, shot: ShotPlan, cast: CastMember[]): Promise<string[]> {
  const { env, row } = ctx;
  const keys: string[] = [];
  const p = v.product;
  if (p?.from === "library") {
    const src = await first<{ key: string; reference_key: string | null }>(env.DB, "SELECT key, reference_key FROM sources WHERE id = ?", p.id);
    if (src) keys.push(src.reference_key ?? src.key);
  } else if (p?.from === "drive") {
    const key = `${b.owner}/${b.id}/campaign/${row.id}/product-${p.id}.jpg`;
    if (!(await env.BUCKET.head(key))) {
      const img = await photoBytes(env, p.id, 1600).catch(() => null);
      if (img) await env.BUCKET.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    }
    if (await env.BUCKET.head(key)) keys.push(key);
  }
  const config = JSON.parse(b.config) as Config;
  const named = cast.filter((m) => new RegExp(`\\b${m.name}\\b`, "i").test(shot.action));
  const shown = named.length ? named : showsPeople(shot.action) ? cast : [];
  for (const m of shown.slice(0, 3)) {
    const a = config.client ? await first<{ image_key: string | null }>(env.DB, "SELECT image_key FROM ambassadors WHERE client = ? AND name = ?", config.client, m.name).catch(() => null) : null;
    if (a?.image_key) keys.push(a.image_key);
  }
  return keys;
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
        let index = postOfItem(ctx, s.item);
        if (!index) throw new StudioError("The card is not made yet.", 409);
        // A card lost from the month (an older copy of the month written over it) is made again first.
        if (!((JSON.parse(b.config) as Config).plan ?? []).some((p) => p.index === index)) {
          const postStep = ctx.steps.get(`${s.item}:-:post`)!;
          index = await makePost(env, user, row, postStep, plan);
          await patchStep(env, postStep, { post: index, note: `Card ${index} in the month (made again: it had been lost from the month)` });
        }
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
        const fix = redoNote(s);
        const r = await generateRun(env, user, { batch: b.id, indexes: [index], regenerate: !!had?.output, approve: true, run: `campaign:${row.id}:${s.step}:${s.attempts}`, ...(fix ? { note: fix } : {}) }, ctx.waitUntil);
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
        // "Make again" with an angle the admin picked on the review.
        const asked = s.data ? (JSON.parse(s.data) as { angle?: string }).angle : undefined;
        if (asked) angle = asked;
        if (v.frameEngine.kind === "engine") {
          if (row.simulate) {
            if (!(await reserveFor(env, row, s, s.estimate ?? 0))) return;
            await settleCost(env, row, s, null);
            const k = ctx.steps.get(`${v.key}:-:image`)?.output_key;
            const obj = k ? await env.BUCKET.get(k) : null;
            const key = `${b.owner}/${b.id}/campaign/${row.id}/${v.key}-${shot.key}-frame-sim.${k?.endsWith(".png") ? "png" : "jpg"}`;
            if (obj) await env.BUCKET.put(key, await obj.arrayBuffer(), { httpMetadata: { contentType: obj.httpMetadata?.contentType || "image/jpeg" } });
            await patchStep(env, s, { status: "done", post: index, output_key: obj ? key : k ?? null, finished: now(), note: `${SIMULATED}: the key frame stands in for this shot's own picture.` });
            return;
          }
          await engineFrame(ctx, s, b, v, shot, index);
          return;
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
        const tpl = v.template ? templateById(v.template.id) : null;
        if (tpl) {
          // The template is run on the subscription credits; the card shows the product's photo until the Reel is rendered.
          if ((await higgsfieldBilling(env)) !== "credits") {
            await patchStep(env, s, { status: "paused", attempts: s.attempts - 1, note: "Higgsfield templates run on the subscription credits; the billing is on the Cloud API. Switch it back to run this Reel." });
            await pauseCampaign(env, row.id, "A template Reel needs the Higgsfield subscription credits; nothing was switched silently.");
            return;
          }
          if (!(await first<{ id: string }>(env.DB, "SELECT id FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL", b.id, index))) {
            const obj = await env.BUCKET.get(posterKey);
            if (!obj) throw new StudioError("The product's photo could not be read.", 409);
            await setCardPicture(env, b, index!, await obj.arrayBuffer(), obj.httpMetadata?.contentType || "image/jpeg", "The product's photo, the card's picture until the Reel is rendered");
          }
          const { castOf } = await import("./campaign");
          const cast = await castOf(env, (JSON.parse(b.config) as Config).client ?? null);
          const { estimateMcpVideo, submitMcpVideo, TEMPLATE_MODEL } = await import("./higgsfield-mcp");
          const template = { presetId: tpl.id, type: tpl.family, name: tpl.name };
          const ask = { batch: b.id, index: index!, model: TEMPLATE_MODEL, prompt: templatePrompt(v, tpl, cast), aspect: v.frame, source: "picture" as const };
          const est = await estimateMcpVideo(env, user, ask, false, { posterKey, template });
          if (est.unlimChoice) throw new StudioError("Higgsfield asks whether to use the unlimited allowance: answer it from the Video dialog once, then retry this step.", 409);
          const amount = est.credits ?? s.estimate;
          if (amount === null) throw new StudioError("Higgsfield gave no cost for this template and none was accepted: nothing was sent.", 409);
          if (!(await reserveFor(env, row, s, amount))) return;
          const item = await submitMcpVideo(env, user, { ...ask, confirm: true, note: `Campaign Autopilot ${v.key} · template ${tpl.name}` }, { posterKey, template });
          await patchStep(env, s, { post: index, ref_kind: "video", ref_id: item.id, note: `Higgsfield template "${tpl.name}"` });
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
        const cast = await castOf(env, (JSON.parse(b.config) as Config).client ?? null);
        // The real product and the faces of the people in the shot go with the start frame where the engine takes references.
        const references = engine.provider === "higgsfield-mcp" ? await identityKeys(ctx, b, v, shot, cast) : [];
        const prompt = clipPrompt(v, shot, cast, { references: references.length > 0 });
        const note = `Campaign Autopilot ${v.key} ${shot.key}`;
        let videoId: string;
        if (engine.provider === "higgsfield-mcp") {
          const { estimateMcpVideo, submitMcpVideo } = await import("./higgsfield-mcp");
          const ask = { batch: b.id, index: index!, model: engine.model, prompt, duration, aspect: v.frame, source: "picture" as const };
          const est = await estimateMcpVideo(env, user, ask, false, { posterKey, references });
          if (est.unlimChoice) throw new StudioError("Higgsfield asks whether to use the unlimited allowance: answer it from the Video dialog once, then retry this step.", 409);
          const amount = est.credits ?? s.estimate;
          if (amount === null) throw new StudioError("Higgsfield gave no cost for this clip and none was accepted: nothing was sent.", 409);
          if (!(await reserveFor(env, row, s, amount))) return;
          const item = await submitMcpVideo(env, user, { ...ask, confirm: true, note }, { posterKey, references });
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
    const t = await first<{ status: string; output: string | null; error: string | null; updated: number; qa: string | null }>(env.DB, "SELECT status, output, error, updated, qa FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, s.post);
    if (!t) return;
    // A picture still being made: the month's engine is moved on from here, as the Studio page does,
    // so it never waits for someone to open the month.
    if (["queued", "processing", "finalizing"].includes(t.status)) {
      const { advanceBatch } = await import("./engine");
      ctx.waitUntil(advanceBatch(env, b.id, { background: ctx.waitUntil, deferSync: true }).catch((e) => console.error("[campaign] advance month", errorMessage(e))));
      return;
    }
    // Made: "ready", or "review" (made, with the automatic check's notes for a person to look at).
    if ((t.status === "ready" || t.status === "approved" || t.status === "review") && t.output && t.updated >= (s.started ?? 0)) {
      const cost = await first<{ c: number | null }>(env.DB, "SELECT SUM(cost) AS c FROM post_takes WHERE batch = ? AND post = ? AND created >= ?", b.id, s.post, s.started ?? 0);
      await settleCost(env, row, s, cost?.c ?? null);
      let checked = "";
      if (t.status === "review") {
        try {
          const qa = JSON.parse(t.qa ?? "{}") as { flags?: { text: string }[]; notes?: string };
          const flags = (qa.flags ?? []).map((f) => f.text).join("; ");
          // "Still running" is the check not finished yet, not a finding: no warning for it.
          const pending = !flags && /still running/i.test(qa.notes ?? "");
          checked = pending ? "" : `The automatic check asks you to look: ${flags || qa.notes || "see the card"}`.slice(0, 400);
        } catch {
          checked = "The automatic check asks you to look at this picture.";
        }
      }
      await patchStep(env, s, { status: "done", output_key: t.output, finished: now(), note: checked || s.note });
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
    name: `${onScreenWords(v.hook) || v.concept.slice(0, 40)} · Autopilot`,
    batch: b.id,
    shots,
    frame: v.frame,
    hook: onScreenWords(v.hook),
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
      if (video) return { ...p, headline: onScreenWords(video.hook) || undefined, caption: [video.caption, video.cta].filter(Boolean).join("\n"), captionHand: true };
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
export async function advanceCampaign(env: Env, user: User, id: string, waitUntil: (p: Promise<unknown>) => void, background = false): Promise<void> {
  const row = await readRow(env, id);
  if (!row || row.status !== "producing") return;
  const plan = stripListIdRefs(JSON.parse(row.plan) as CampaignPlan);
  const approval = row.approval ? (JSON.parse(row.approval) as StoredApproval) : null;
  const held = new Set(approval?.needsApproval ?? []);
  const list = await stepsOf(env, id);
  const ctx: Ctx = { env, user, row, plan, steps: new Map(list.map((s) => [s.step, s])), waitUntil, background };
  for (const s of list) if (s.status === "running") await settleStep(ctx, s).catch((e) => console.error("[campaign] settle", s.step, errorMessage(e)));
  // A shot picture whose pass ended before the engine answered: its outcome is unknown (counted, never resent by itself).
  for (const s of list) if (s.kind === "frame" && s.status === "running" && s.ref_kind === "engine" && now() - (s.started ?? s.updated) > ENGINE_FRAME_STALE_MS) await failAttempt(env, row, s, "The image engine did not answer in time; whether it charged is unknown, so it is held for reconciliation.", "unknown");
  // A running render the tab stopped reporting on is offered again.
  for (const s of list) if (s.kind === "render" && s.status === "running" && now() - s.updated > RENDER_STALE_MS) await patchStep(env, s, { status: "ready" });
  // Waiting steps whose inputs are done become ready.
  for (const s of list) {
    if (s.status !== "waiting" || held.has(s.item)) continue;
    const deps = JSON.parse(s.deps) as string[];
    if (deps.every((d) => ctx.steps.get(d)?.status === "done")) await patchStep(env, s, { status: "ready" });
  }
  const started: Record<string, number> = {};
  const slow: Promise<void>[] = [];
  for (const s of list) {
    if (s.status !== "ready" || held.has(s.item)) continue;
    const engineMade = s.kind === "frame" && !row.simulate && itemOf(plan, s.item).video?.frameEngine.kind === "engine";
    // A page's pass leaves those to the cron (within a minute): a closed tab would cut the engine's answer off.
    if (engineMade && !background) continue;
    const fresh = await readRow(env, id);
    if (fresh?.status !== "producing") break;
    if ((started[s.kind] ?? 0) >= START_LIMIT[s.kind]) continue;
    started[s.kind] = (started[s.kind] ?? 0) + 1;
    if (engineMade) slow.push(startStep(ctx, s));
    else await startStep(ctx, s);
  }
  await Promise.all(slow);
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
    await advanceCampaign(env, user, r.id, waitUntil, true).catch((e) => console.error("[campaign] cron", r.id, errorMessage(e)));
  }
}
