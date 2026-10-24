/**
 * The preset galleries keep themselves up to date: every category of the Video and Photo studios'
 * Higgsfield galleries is read again once a day, one category per cron pass at most every few
 * minutes, so a preset Higgsfield publishes shows up by itself the next day and no page visit waits
 * for a whole catalog. Browsing only: nothing is generated or spent. It runs only while Higgsfield
 * is signed in and switched on; a category that fails is tried again on a later pass.
 */
import type { Env } from "./env";
import { errorMessage } from "./errors";
import { claimSubmission, integrationSwitch, recordIntegrationOp } from "./integrations";
import { fetcher, HiggsfieldMcp, higgsfieldSignIn } from "./higgsfield-mcp";
import { refreshVideoCategory, videoCacheAge } from "./video-presets";
import { photoCacheAge, refreshPhotoCategory } from "./photo-presets";
import { PRESET_CATEGORY_IDS, type PresetCategoryId } from "@shared/video-presets";
import { PHOTO_PRESET_CATEGORIES, type PhotoPresetCategoryId } from "@shared/photo-presets";

/** A stored list older than this is read again (a little under a day, so each category moves daily). */
export const PRESET_REFRESH_AGE_MS = 20 * 60 * 60 * 1000;
/** One refresh per this long, across every worker pass. */
const PASS_GAP_MS = 3 * 60 * 1000;

export type RefreshTarget = { studio: "video"; category: PresetCategoryId } | { studio: "photo"; category: Exclude<PhotoPresetCategoryId, "magnific-looks"> };

/** Every Higgsfield category of both galleries, in the order they are refreshed. */
export function refreshTargets(): RefreshTarget[] {
  return [
    ...PRESET_CATEGORY_IDS.map((category) => ({ studio: "video" as const, category })),
    ...PHOTO_PRESET_CATEGORIES.filter((c) => c.provider === "higgsfield").map((c) => ({ studio: "photo" as const, category: c.id as Exclude<PhotoPresetCategoryId, "magnific-looks"> })),
  ];
}

/** The category most in need of a refresh (never stored first, then the oldest), or null when all are fresh. */
export async function stalestTarget(env: Env): Promise<RefreshTarget | null> {
  let best: { t: RefreshTarget; age: number } | null = null;
  for (const t of refreshTargets()) {
    const age = t.studio === "video" ? await videoCacheAge(env, t.category) : await photoCacheAge(env, t.category);
    const a = age ?? Number.POSITIVE_INFINITY;
    if (a < PRESET_REFRESH_AGE_MS) continue;
    if (!best || a > best.age) best = { t, age: a };
  }
  return best?.t ?? null;
}

/** One pass: the stalest category read again, when Higgsfield is signed in and on. Returns what was refreshed. */
export async function refreshStalePresets(env: Env): Promise<string | null> {
  if (!(await higgsfieldSignIn.isSignedIn(env))) return null;
  if (!(await integrationSwitch(env, "higgsfield"))) return null;
  const target = await stalestTarget(env);
  if (!target) return null;
  if (!(await claimSubmission(env, "presets:daily-refresh", PASS_GAP_MS))) return null;
  const label = `${target.studio} · ${target.category}`;
  try {
    const mcp = new HiggsfieldMcp(env, fetcher());
    await mcp.connect();
    const n = target.studio === "video" ? await refreshVideoCategory(env, mcp, target.category) : await refreshPhotoCategory(env, mcp, target.category);
    await recordIntegrationOp(env, { provider: "higgsfield", kind: "preset.browse", user: "system", estimate: 0, reported: 0, status: "done", note: `daily refresh · ${label} · ${n} preset${n === 1 ? "" : "s"} (browsing, nothing spent)` });
    return label;
  } catch (e) {
    console.error("[presets] refresh", label, errorMessage(e));
    return null;
  }
}
