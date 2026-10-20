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
/** Every Instagram business account the token sees: the team picks which one reads the others. */
const ACCOUNTS_SETTING = "meta_accounts";

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

/** The permissions Business Discovery needs (Meta's reference), and how to ask for them again. */
const PERMISSION_HELP =
  "In the Graph API Explorer add instagram_basic, instagram_manage_insights, pages_read_engagement, pages_show_list, business_management and ads_read, press Generate Access Token, extend it in the Access Token Debugger and paste the new token here.";

/**
 * The Instagram business accounts behind a pasted user token (one per Facebook page linked to one).
 * Business Discovery runs on a user token, so the user token is kept; it is checked by reading
 * another public account before it is saved.
 */
async function findAccounts(userToken: string): Promise<{ accounts: MetaAccount[]; chosen: MetaAccount }> {
  const pages = await graph<{ data?: { name: string; instagram_business_account?: { id: string; username?: string } }[] }>(
    "me/accounts?fields=name,instagram_business_account{id,username}&limit=100",
    userToken,
  );
  const expires = await expiresAt(userToken);
  if (expires && expires < Date.now() + 2 * 86_400_000)
    throw new StudioError(
      "This token lasts only an hour or two. Open the Access Token Debugger (the third link), paste it, press Debug, then Extend Access Token, and paste the new token here.",
      400,
    );
  const accounts: MetaAccount[] = (pages.data ?? [])
    .filter((p) => p.instagram_business_account?.id)
    .map((p) => ({
      igId: p.instagram_business_account!.id,
      username: p.instagram_business_account!.username ?? "",
      page: p.name,
      connected: Date.now(),
      expires: expires ?? 0,
    }));
  if (!accounts.length)
    throw new StudioError(
      "This token sees no Facebook page with an Instagram business account linked. Link an Instagram account to its Facebook page, tick that page when Facebook asks, then try again.",
      400,
    );
  // The agency's own account reads the others when the token sees it; any linked account works otherwise.
  const chosen = accounts.find((a) => /\blevel\b/i.test(`${a.page} ${a.username}`)) ?? accounts[0];
  await checkReads(chosen, userToken);
  return { accounts, chosen };
}

/** One read of another public account: the token is only kept when Business Discovery answers. */
async function checkReads(account: MetaAccount, token: string): Promise<void> {
  const target = account.username.toLowerCase() === "instagram" ? "creators" : "instagram";
  try {
    await graph(`${account.igId}?fields=business_discovery.username(${target}){username}`, token);
  } catch (e) {
    if (e instanceof StudioError && /\(#10\)|\(#200\)|permission/i.test(e.message))
      throw new StudioError(`Meta does not let this token read other Instagram accounts yet. ${PERMISSION_HELP}`, 400);
    throw e;
  }
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
async function accountsOf(env: Env): Promise<MetaAccount[]> {
  try {
    return JSON.parse((await getSetting(env, ACCOUNTS_SETTING)) ?? "[]") as MetaAccount[];
  } catch {
    return [];
  }
}

metaRoutes.get("/", async (c) => {
  const conn = await connection(c.env);
  const options = conn ? (await accountsOf(c.env)).map((a) => ({ igId: a.igId, username: a.username, page: a.page })) : [];
  return c.json({
    ok: true,
    connected: !!conn,
    account: conn
      ? { igId: conn.account.igId, username: conn.account.username, page: conn.account.page, connected: conn.account.connected, expires: conn.account.expires ?? 0 }
      : null,
    options,
  });
});

/** An admin pastes the token: it is checked against Meta, then kept encrypted. */
metaRoutes.post("/", async (c) => {
  admin(c.get("user"));
  const parsed = z.object({ token: z.string().trim().min(40).max(1000) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Paste the whole access token.");
  const { accounts, chosen } = await findAccounts(parsed.data.token);
  await setSetting(c.env, TOKEN_SETTING, parsed.data.token);
  await setSetting(c.env, ACCOUNT_SETTING, JSON.stringify(chosen));
  await setSetting(c.env, ACCOUNTS_SETTING, JSON.stringify(accounts));
  return c.json({ ok: true, account: { username: chosen.username, page: chosen.page, connected: chosen.connected, expires: chosen.expires } });
});

/** An admin picks which of the token's Instagram accounts reads the others. */
metaRoutes.put("/account", async (c) => {
  admin(c.get("user"));
  const parsed = z.object({ igId: z.string().min(1).max(40) }).safeParse(await c.req.json().catch(() => ({})));
  const conn = await connection(c.env);
  const next = parsed.success ? (await accountsOf(c.env)).find((a) => a.igId === parsed.data.igId) : undefined;
  if (!conn || !next) throw new StudioError("That account is not behind the saved token.", 404);
  await checkReads(next, conn.token);
  const account = { ...next, connected: Date.now(), expires: conn.account.expires };
  await setSetting(c.env, ACCOUNT_SETTING, JSON.stringify(account));
  return c.json({ ok: true, account });
});

metaRoutes.delete("/", async (c) => {
  admin(c.get("user"));
  await deleteSetting(c.env, TOKEN_SETTING);
  await deleteSetting(c.env, ACCOUNT_SETTING);
  await deleteSetting(c.env, ACCOUNTS_SETTING);
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


/** An Instagram post link (a post, a reel or a carousel): its shortcode, or null. */
export function instagramShortcode(link: string): string | null {
  const m = link.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]{5,})/i);
  return m ? m[1] : null;
}

export interface InstagramSlides {
  username: string;
  caption: string;
  /** Every slide of a carousel (one picture for a single post; a video gives its cover). */
  slides: { url: string; type: string }[];
  /** Why only the first picture could be read, when that is the case. */
  partial?: string;
}

/**
 * The pictures of one public Instagram post. Instagram's public oEmbed names the account and gives
 * the first picture; the agency's Meta connection then reads the whole carousel through Business
 * Discovery (public business and creator accounts only).
 */
export async function instagramPostSlides(env: Env, link: string): Promise<InstagramSlides> {
  const code = instagramShortcode(link);
  if (!code) throw new StudioError("That is not an Instagram post link.");
  const oe = await fetch(`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(`https://www.instagram.com/p/${code}/`)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
    signal: AbortSignal.timeout(20_000),
  });
  const od = (await oe.json().catch(() => ({}))) as { author_name?: string; title?: string; thumbnail_url?: string };
  if (!oe.ok || !od.author_name) throw new StudioError("Instagram did not give that post up: it may be private, deleted, or the link is wrong. Attach the slides as pictures instead.", 404);
  const first = od.thumbnail_url ? [{ url: od.thumbnail_url, type: "IMAGE" }] : [];
  const c = await connection(env);
  if (!c) return { username: od.author_name, caption: od.title ?? "", slides: first, partial: "Instagram is not connected in the studio, so only the first picture of the post could be read." };
  type Media = { permalink?: string; media_type?: string; media_url?: string; thumbnail_url?: string; caption?: string; children?: { data?: { media_url?: string; media_type?: string; thumbnail_url?: string }[] } };
  let found: Media | undefined;
  try {
    const d = await graph<{ business_discovery?: { media?: { data?: Media[] } } }>(
      `${c.account.igId}?fields=business_discovery.username(${od.author_name}){media.limit(50){permalink,media_type,media_url,thumbnail_url,caption,children{media_url,media_type,thumbnail_url}}}`,
      c.token,
    );
    found = (d.business_discovery?.media?.data ?? []).find((x) => (x.permalink ?? "").includes(`/${code}/`) || (x.permalink ?? "").endsWith(`/${code}`));
  } catch (e) {
    return { username: od.author_name, caption: od.title ?? "", slides: first, partial: `Only the first picture could be read: ${errorMessage(e)}` };
  }
  if (!found) return { username: od.author_name, caption: od.title ?? "", slides: first, partial: "The post is older than the account's last 50, so only its first picture could be read." };
  const pick = (x: { media_url?: string; media_type?: string; thumbnail_url?: string }) => ({ url: (x.media_type === "VIDEO" ? x.thumbnail_url : x.media_url) ?? "", type: x.media_type ?? "IMAGE" });
  const slides = (found.children?.data?.length ? found.children.data.map(pick) : [pick(found)]).filter((x) => x.url);
  return { username: od.author_name, caption: found.caption ?? od.title ?? "", slides: slides.length ? slides : first };
}
