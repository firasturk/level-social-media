/**
 * Meta (Instagram) connection: the agency's own Instagram business account, linked to a Facebook
 * page, reads any public business or creator account through Business Discovery: its bio, its
 * last posts, their captions, pictures, likes and comments. A client's profile and the brands the
 * team studies are read this way. The token is stored encrypted and never sent back.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { deleteSetting, getSetting, setSetting } from "./settings";
import type { User } from "@shared/types";

type Variables = { user: User };
export const metaRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** One Graph API version for every call; bump it here when Meta retires it. */
const GRAPH = "https://graph.facebook.com/v23.0";
const TOKEN_SETTING = "meta_token";
const ACCOUNT_SETTING = "meta_account";

/** The agency account the token reads through. */
interface MetaAccount {
  igId: string;
  username: string;
  page: string;
  connected: number;
  /** When the stored token stops working (0: never). */
  expires: number;
}

export interface InstagramPost {
  id: string;
  caption: string;
  type: string;
  image: string | null;
  permalink: string;
  timestamp: string;
  likes: number | null;
  comments: number | null;
}

export interface InstagramProfile {
  username: string;
  name: string;
  biography: string;
  website: string;
  followers: number;
  posts: number;
  picture: string | null;
  media: InstagramPost[];
}

async function graph<T>(path: string, token: string): Promise<T> {
  const url = `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  const d = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!r.ok || d.error) {
    const m = d.error?.message ?? `Meta answered ${r.status}`;
    // 190: the token expired or was revoked.
    if (d.error?.code === 190) throw new StudioError(`The Meta token no longer works: ${m.replace(/\.?$/, ".")} Paste a new one in Connection.`, 401);
    throw new StudioError(`Meta: ${m}`, r.status >= 400 && r.status < 500 ? 400 : 502);
  }
  return d;
}

/** When a token stops working, in ms (0: never; null: Meta would not say). */
async function expiresAt(token: string): Promise<number | null> {
  try {
    const d = await graph<{ data?: { expires_at?: number } }>(`debug_token?input_token=${encodeURIComponent(token)}`, token);
    const at = d.data?.expires_at;
    return typeof at === "number" ? at * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The Instagram business account behind a pasted user token, and the token to keep: the page's own
 * token, which never expires when it comes from a long-lived user token (an extended one).
 */
async function findAccount(userToken: string): Promise<{ account: MetaAccount; token: string }> {
  const pages = await graph<{ data?: { name: string; access_token?: string; instagram_business_account?: { id: string; username?: string } }[] }>(
    "me/accounts?fields=name,access_token,instagram_business_account{id,username}&limit=50",
    userToken,
  );
  const page = (pages.data ?? []).find((p) => p.instagram_business_account?.id);
  if (!page?.instagram_business_account)
    throw new StudioError(
      "This token sees no Facebook page with an Instagram business account linked. Link Level MENA's Instagram to its Facebook page, tick that page when Facebook asks, then try again.",
      400,
    );
  const ig = page.instagram_business_account;
  // The page token is kept when it can read Instagram accounts; otherwise the user token itself.
  let token = userToken;
  if (page.access_token)
    try {
      await graph(`${ig.id}?fields=business_discovery.username(${ig.username ?? "instagram"}){username}`, page.access_token);
      token = page.access_token;
    } catch {
      /* the user token stays */
    }
  const expires = await expiresAt(token);
  if (expires && expires < Date.now() + 2 * 86_400_000)
    throw new StudioError(
      "This token lasts only an hour or two. Open the Access Token Debugger (the third link), paste it, press Debug, then Extend Access Token, and paste the new token here.",
      400,
    );
  return {
    token,
    account: { igId: ig.id, username: ig.username ?? "", page: page.name, connected: Date.now(), expires: expires ?? 0 },
  };
}

async function connection(env: Env): Promise<{ token: string; account: MetaAccount } | null> {
  const token = await getSetting(env, TOKEN_SETTING);
  const raw = await getSetting(env, ACCOUNT_SETTING);
  if (!token || !raw) return null;
  try {
    return { token, account: JSON.parse(raw) as MetaAccount };
  } catch {
    return null;
  }
}

/** A public business or creator account and its last posts, read through Business Discovery. */
export async function instagramProfile(env: Env, username: string, posts = 24): Promise<InstagramProfile> {
  const c = await connection(env);
  if (!c) throw new StudioError("Instagram is not connected yet: an admin connects Meta in Connection.", 428);
  const handle = username.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) throw new StudioError("That is not an Instagram username.");
  const media = `media.limit(${Math.max(1, Math.min(50, posts))}){caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count}`;
  const d = await graph<{
    business_discovery?: {
      username: string;
      name?: string;
      biography?: string;
      website?: string;
      followers_count?: number;
      media_count?: number;
      profile_picture_url?: string;
      media?: { data?: Record<string, unknown>[] };
    };
  }>(`${c.account.igId}?fields=business_discovery.username(${handle}){username,name,biography,website,followers_count,media_count,profile_picture_url,${media}}`, c.token);
  const b = d.business_discovery;
  if (!b) throw new StudioError(`@${handle} could not be read: only public business and creator accounts can be.`, 404);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    username: b.username,
    name: b.name ?? "",
    biography: b.biography ?? "",
    website: b.website ?? "",
    followers: b.followers_count ?? 0,
    posts: b.media_count ?? 0,
    picture: b.profile_picture_url ?? null,
    media: (b.media?.data ?? []).map((m) => ({
      id: str(m.id),
      caption: str(m.caption),
      type: str(m.media_type),
      // A video shows its cover; a carousel its first picture.
      image: str(m.media_type) === "VIDEO" ? str(m.thumbnail_url) || null : str(m.media_url) || null,
      permalink: str(m.permalink),
      timestamp: str(m.timestamp),
      likes: num(m.like_count),
      comments: num(m.comments_count),
    })),
  };
}

function admin(user: User) {
  if (user.role !== "admin") throw new StudioError("Only an admin connects Meta.", 403);
}

/** Whether Instagram is connected, and through which account (never the token). */
metaRoutes.get("/", async (c) => {
  const conn = await connection(c.env);
  return c.json({
    ok: true,
    connected: !!conn,
    account: conn ? { username: conn.account.username, page: conn.account.page, connected: conn.account.connected, expires: conn.account.expires ?? 0 } : null,
  });
});

/** An admin pastes the token: it is checked against Meta, then kept encrypted. */
metaRoutes.post("/", async (c) => {
  admin(c.get("user"));
  const parsed = z.object({ token: z.string().trim().min(40).max(1000) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Paste the whole access token.");
  const { account, token } = await findAccount(parsed.data.token);
  await setSetting(c.env, TOKEN_SETTING, token);
  await setSetting(c.env, ACCOUNT_SETTING, JSON.stringify(account));
  return c.json({ ok: true, account: { username: account.username, page: account.page, connected: account.connected, expires: account.expires } });
});

metaRoutes.delete("/", async (c) => {
  admin(c.get("user"));
  await deleteSetting(c.env, TOKEN_SETTING);
  await deleteSetting(c.env, ACCOUNT_SETTING);
  return c.json({ ok: true });
});

/** Reads one public account: the connection's test, and the client profile's source. */
metaRoutes.get("/instagram/:username", async (c) => {
  try {
    return c.json({ ok: true, profile: await instagramProfile(c.env, c.req.param("username"), Number(c.req.query("posts") ?? 12) || 12) });
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError(`Instagram could not be read: ${errorMessage(e)}`, 502);
  }
});
