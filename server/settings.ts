/**
 * Encrypted server-side settings, used for the engine key when it is entered from the app
 * instead of being set as a Worker secret. Values are AES-GCM encrypted with a key derived
 * from SESSION_SECRET, so a database dump alone does not reveal them.
 */
import type { Env } from "./env";
import type { GoogleAuth, VertexCreds } from "./vertex";
import { StudioError } from "./errors";
import { first, run, now } from "./db";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16)
    throw new StudioError("Server is missing SESSION_SECRET. Set it as a secret.", 503);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`settings:${env.SESSION_SECRET}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(value)),
  );
  await run(
    env.DB,
    "INSERT INTO settings (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated",
    key,
    `${b64(iv)}.${b64(cipher)}`,
    now(),
  );
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    key,
  );
  if (!row) return null;
  const [iv, cipher] = row.value.split(".");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) },
      await aesKey(env),
      unb64(cipher),
    );
    return dec.decode(plain);
  } catch {
    return null; // SESSION_SECRET changed; the setting must be entered again
  }
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await run(env.DB, "DELETE FROM settings WHERE key = ?", key);
}

export const ENGINE_KEY_SETTING = "higgsfield_api_key";

export type EngineKeySource = "secret" | "stored" | "none";

/** The engine credential: a Worker secret wins, otherwise the key saved from the app. */
export async function resolveEngineKey(
  env: Env,
): Promise<{ key: string | null; source: EngineKeySource }> {
  if (env.HIGGSFIELD_API_KEY) return { key: env.HIGGSFIELD_API_KEY, source: "secret" };
  const stored = await getSetting(env, ENGINE_KEY_SETTING);
  return stored ? { key: stored, source: "stored" } : { key: null, source: "none" };
}

export const ENGINE_MODEL_SETTING = "higgsfield_model";

/**
 * The model slug: saved from the app when present; otherwise Nano Banana Pro through Google when a
 * Google key exists, else the HIGGSFIELD_MODEL variable.
 */
export async function resolveEngineModel(env: Env): Promise<string> {
  const stored = await getSetting(env, ENGINE_MODEL_SETTING);
  if (stored) return stored;
  if ((await resolveGoogleAuth(env)).auth) return "gemini-3-pro-image";
  return env.HIGGSFIELD_MODEL || "nano-banana-pro";
}

export const OPENAI_KEY_SETTING = "openai_api_key";

/** OpenAI credential: a Worker secret wins, otherwise the key saved from the app. */
export async function resolveOpenAIKey(
  env: Env,
): Promise<{ key: string | null; source: EngineKeySource }> {
  if (env.OPENAI_API_KEY) return { key: env.OPENAI_API_KEY, source: "secret" };
  const stored = await getSetting(env, OPENAI_KEY_SETTING);
  return stored ? { key: stored, source: "stored" } : { key: null, source: "none" };
}

export const GOOGLE_KEY_SETTING = "google_api_key";

/** Google AI Studio credential: the GEMINI_API_KEY secret wins, otherwise the key saved from the app. */
export async function resolveGoogleKey(
  env: Env,
): Promise<{ key: string | null; source: EngineKeySource }> {
  if (env.GEMINI_API_KEY) return { key: env.GEMINI_API_KEY, source: "secret" };
  const stored = await getSetting(env, GOOGLE_KEY_SETTING);
  return stored ? { key: stored, source: "stored" } : { key: null, source: "none" };
}

export const VERTEX_SETTING = "vertex_service_account";

/** Google Cloud (Vertex AI) credential saved from the app: a service account for the billed project. */
export async function resolveVertex(env: Env): Promise<VertexCreds | null> {
  const stored = await getSetting(env, VERTEX_SETTING);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as VertexCreds;
  } catch {
    return null;
  }
}

/**
 * How Google is reached: the Vertex service account when one is saved (the project's credits pay),
 * otherwise the AI Studio key. Nothing connected gives null.
 */
export async function resolveGoogleAuth(
  env: Env,
): Promise<{
  auth: GoogleAuth | null;
  vertex: VertexCreds | null;
  source: EngineKeySource | "vertex";
}> {
  const vertex = await resolveVertex(env);
  if (vertex) return { auth: { vertex }, vertex, source: "vertex" };
  const k = await resolveGoogleKey(env);
  return { auth: k.key ? { key: k.key } : null, vertex: null, source: k.source };
}

export const FAL_KEY_SETTING = "fal_api_key";

/** fal.ai credential: the FAL_KEY secret wins, otherwise the key saved from the app. */
export async function resolveFalKey(
  env: Env,
): Promise<{ key: string | null; source: EngineKeySource }> {
  if (env.FAL_KEY) return { key: env.FAL_KEY, source: "secret" };
  const stored = await getSetting(env, FAL_KEY_SETTING);
  return stored ? { key: stored, source: "stored" } : { key: null, source: "none" };
}

export const ZAID_DIRECTION_SETTING = "zaid_direction";
/** Creative direction: the Mood board entry's name, tagline, description and hidden flag. */
export const MOOD_BOARD_SETTING = "zaid_skill";
export const MODES_SETTING = "modes_config";
/** R2 keys of the looping hero video shown under the studio title, one per format. */
export const HERO_KEYS = { mp4: "hero/video", webm: "hero/video.webm" } as const;
export type HeroFormat = keyof typeof HERO_KEYS;

let heroCache: { stamp: string; at: number } | null = null;
/** Version stamp of the hero video ("" when none), from R2 metadata, cached briefly per isolate. */
export async function heroStamp(env: Env, fresh = false): Promise<string> {
  if (!fresh && heroCache && Date.now() - heroCache.at < 60_000) return heroCache.stamp;
  const heads = await Promise.all(Object.values(HERO_KEYS).map((k) => env.BUCKET.head(k)));
  const latest = Math.max(0, ...heads.map((h) => (h ? h.uploaded.getTime() : 0)));
  const stamp = latest ? String(latest) : "";
  heroCache = { stamp, at: Date.now() };
  return stamp;
}
export const INVITE_CODE_SETTING = "invite_code";
export const SPEND_THRESHOLD_SETTING = "spend_threshold";
/** "1" when admins use the four-stage workflow instead of the journey. */
export const WORKFLOW_V2_SETTING = "workflow_v2";
/** Who sees prices: "everyone" (the default) or "admins". Spend confirmations happen either way. */
export const PRICING_VISIBILITY_SETTING = "pricing_visibility";
/** "1" when Autopilot stops at the plan for a look instead of paying by itself. */
export const AUTOPILOT_REVIEW_SETTING = "autopilot_review";
export const RETENTION_DAYS_SETTING = "retention_days";
export const NOTIFY_WEBHOOK_SETTING = "notify_webhook";
export const NOTIFY_EMAIL_SETTING = "notify_email";
export const RESEND_KEY_SETTING = "resend_api_key";
/** The sender of client-answer e-mails ("Level Studio <studio@levelmena.com>"); its domain is verified in Resend. */
export const NOTIFY_FROM_SETTING = "notify_from";
/** Freepik (Magnific) API key for the Photo lab, saved from Connection → Freepik. */
export const FREEPIK_KEY_SETTING = "freepik_api_key";
/** A pasted bearer token for the Magnific MCP server (mcp.magnific.com): the advanced path, honoured as a fallback to the sign-in for one release; see docs/freepik.md. */
export const FREEPIK_MCP_TOKEN_SETTING = "freepik_mcp_token";
/** Magnific MCP sign-in (server/magnific-signin.ts): the OAuth client the studio registered once at auth.magnific.com, as JSON. */
export const FREEPIK_MCP_CLIENT_SETTING = "freepik_mcp_client";
/** Magnific MCP sign-in: the access and refresh tokens of the signed-in Magnific account, as JSON. */
export const FREEPIK_MCP_TOKENS_SETTING = "freepik_mcp_tokens";
/** Magnific MCP sign-in: a sign-in in progress (PKCE state and verifier, or a device code), short-lived. */
export const FREEPIK_MCP_PENDING_SETTING = "freepik_mcp_pending";
/** The Freepik API plan family, which decides whether a stock download is in the plan or billed in credits. */
export const FREEPIK_PLAN_SETTING = "freepik_plan";
/** Higgsfield MCP (mcp.higgsfield.ai, the subscription credits): the OAuth client the studio registered once, as JSON. */
export const HIGGSFIELD_MCP_CLIENT_SETTING = "higgsfield_mcp_client";
/** Higgsfield MCP: the access and refresh tokens of the signed-in Higgsfield account, as JSON. */
export const HIGGSFIELD_MCP_TOKENS_SETTING = "higgsfield_mcp_tokens";
/** Higgsfield MCP: a sign-in in progress (PKCE state and verifier, or a device code), short-lived. */
export const HIGGSFIELD_MCP_PENDING_SETTING = "higgsfield_mcp_pending";
/** Higgsfield MCP: the engine catalog read from `models_explore`, cached per sign-in, as JSON. */
export const HIGGSFIELD_MCP_MODELS_SETTING = "higgsfield_mcp_models";
/** Which Higgsfield account pays for videos: "credits" (the subscription, through the MCP sign-in) or "cloud" (the Cloud API key). */
export const HIGGSFIELD_BILLING_SETTING = "higgsfield_billing";
/** Pinterest API v5 (server/pinterest.ts): the access token, and the app id, app secret and refresh token that renew it, as JSON. */
export const PINTEREST_SETTING = "pinterest_connection";
/** Pinterest sign-in in progress (state, who started it, the redirect), short-lived. */
export const PINTEREST_PENDING_SETTING = "pinterest_pending";
