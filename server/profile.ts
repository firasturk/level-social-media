/**
 * Client profiles: the Analysis reads the client's Instagram (Business Discovery), its website and
 * the brands the team compares it with, then one vision call writes the profile. The profile steers
 * ideas, headlines and captions, and its Pinterest searches bring suggested feed grids.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run } from "./db";
import { askText } from "./posts";
import { instagramProfile, type InstagramProfile } from "./meta";
import { suggestGrids } from "./styles";
import type { User } from "@shared/types";
import {
  parseProfile,
  PROFILE_REF_KINDS,
  PROFILE_SCHEMA,
  profileBrief,
  profileInstruction,
  type ClientProfile,
  type ProfileRecord,
  type ProfileRef,
  type ProfileSources,
  type ReadAccount,
} from "@shared/profile";

type Variables = { user: User };
export const profileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
/** Pictures attached to the one vision call: the client's, then a few of each compared brand. */
const CLIENT_IMAGES = 9;
const REF_IMAGES = 3;
/** A run older than this is taken as lost (the request ended without saving). */
const STALE_RUN = 5 * 60_000;

interface ProfileRow {
  client: string;
  instagram: string;
  website: string;
  refs: string;
  profile: string | null;
  sources: string | null;
  status: string;
  error: string | null;
  analysed: number | null;
  updated: number;
  drive?: string | null;
}

function parse<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toRecord(client: string, r: ProfileRow | null): ProfileRecord {
  const running = r?.status === "running" && now() - r.updated < STALE_RUN;
  return {
    client,
    instagram: r?.instagram ?? "",
    website: r?.website ?? "",
    refs: parse<ProfileRef[]>(r?.refs ?? null, []),
    profile: parse<ClientProfile | null>(r?.profile ?? null, null),
    sources: parse<ProfileSources | null>(r?.sources ?? null, null),
    status: running ? "running" : r?.status === "failed" ? "failed" : "idle",
    error: r?.error ?? null,
    analysed: r?.analysed ?? null,
    updated: r?.updated ?? 0,
    drive: r?.drive ?? "",
  };
}

async function profileRow(env: Env, client: string): Promise<ProfileRow | null> {
  return first<ProfileRow>(env.DB, "SELECT * FROM client_profiles WHERE client = ?", client);
}

/** The profile's lines for the writers of ideas and captions ('' before the first Analysis). */
export async function clientProfileBrief(env: Env, client: string): Promise<string> {
  const r = await profileRow(env, client);
  return profileBrief(parse<ClientProfile | null>(r?.profile ?? null, null));
}

const handleOf = (v: string) =>
  v
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .split(/[/?#\s]/)[0]
    .slice(0, 30);

function siteOf(v: string): string {
  const t = v.trim();
  if (!t) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

/* ───────────── Reading a website ───────────── */

function textOf(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "")) return null;
    return (await r.text()).slice(0, 1_500_000);
  } catch {
    return null;
  }
}

/** The home page and up to three pages about the brand and what it sells, as plain text. */
async function readWebsite(url: string, budget = 9000): Promise<{ text: string; pages: string[] } | null> {
  const home = await fetchPage(url);
  if (!home) return null;
  const base = new URL(url);
  const meta = (name: string) =>
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`, "i").exec(home)?.[1] ?? "";
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(home)?.[1]?.trim() ?? "";
  const links = [...home.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], base).toString();
      } catch {
        return "";
      }
    })
    .filter((u) => u && new URL(u).host === base.host && /about|story|menu|product|shop|store|collection|service|من-نحن|منتجات|قائمة/i.test(decodeURIComponent(u)));
  const pages = [base.toString(), ...[...new Set(links)].slice(0, 3)];
  const parts = [`${title}\n${meta("description") || meta("og:description")}\n${textOf(home).slice(0, budget / 2)}`];
  for (const p of pages.slice(1)) {
    const html = await fetchPage(p);
    if (html) parts.push(`--- ${new URL(p).pathname}\n${textOf(html).slice(0, budget / 4)}`);
  }
  return { text: parts.join("\n").slice(0, budget), pages };
}

/* ───────────── Reading Instagram ───────────── */

async function postImages(ig: InstagramProfile, count: number): Promise<{ bytes: ArrayBuffer; mime: string }[]> {
  const urls = ig.media.map((m) => m.image).filter((u): u is string => !!u).slice(0, count);
  const out = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return null;
        const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
        return mime.startsWith("image/") ? { bytes: await r.arrayBuffer(), mime } : null;
      } catch {
        return null;
      }
    }),
  );
  return out.filter((x): x is { bytes: ArrayBuffer; mime: string } => !!x);
}

function readAccount(name: string, kind: ReadAccount["kind"], ig: InstagramProfile | null, site: string | null, images: number): ReadAccount {
  return {
    name,
    kind,
    instagram: ig
      ? {
          username: ig.username,
          bio: ig.biography,
          followers: ig.followers,
          posts: ig.media.map((m) => ({ caption: m.caption, likes: m.likes, comments: m.comments, type: m.type, date: m.timestamp })),
        }
      : undefined,
    website: site ?? undefined,
    images,
  };
}

/* ───────────── Routes ───────────── */

profileRoutes.get("/:client", async (c) => {
  const client = c.req.param("client");
  return c.json({ ok: true, profile: toRecord(client, await profileRow(c.env, client)) });
});

const refSchema = z.object({
  handle: z.string().trim().max(120).default(""),
  website: z.string().trim().max(300).default(""),
  kind: z.enum(PROFILE_REF_KINDS).default("competitor"),
});
const inputSchema = z.object({
  instagram: z.string().trim().max(120).default(""),
  website: z.string().trim().max(300).default(""),
  refs: z.array(refSchema).max(4).default([]),
});

/** The accounts the Analysis reads, saved for the next run. */
async function saveInputs(env: Env, client: string, d: z.infer<typeof inputSchema>): Promise<void> {
  const refs = d.refs
    .map((r) => ({ handle: handleOf(r.handle), website: r.website.trim(), kind: r.kind }))
    .filter((r) => r.handle || r.website);
  await run(
    env.DB,
    "INSERT INTO client_profiles (client, instagram, website, refs, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(client) DO UPDATE SET instagram = excluded.instagram, website = excluded.website, refs = excluded.refs, updated = excluded.updated",
    client,
    handleOf(d.instagram),
    d.website.trim(),
    JSON.stringify(refs),
    now(),
  );
}

profileRoutes.put("/:client", async (c) => {
  const client = c.req.param("client");
  if (!(await first(c.env.DB, "SELECT 1 AS x FROM clients WHERE id = ?", client))) throw new StudioError("Client not found.", 404);
  const parsed = inputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Check the accounts and links.");
  await saveInputs(c.env, client, parsed.data);
  return c.json({ ok: true, profile: toRecord(client, await profileRow(c.env, client)) });
});

/** The Analysis: everything is read again and the profile is written anew. */
profileRoutes.post("/:client/analyse", async (c) => {
  const clientId = c.req.param("client");
  const client = await first<{ id: string; name: string; tone: string; dos: string; donts: string; style: string; colors: string; service: string | null }>(
    c.env.DB,
    "SELECT id, name, tone, dos, donts, style, colors, service FROM clients WHERE id = ?",
    clientId,
  );
  if (!client) throw new StudioError("Client not found.", 404);
  const parsed = inputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (parsed.success) await saveInputs(c.env, clientId, parsed.data);
  const row = await profileRow(c.env, clientId);
  const input = toRecord(clientId, row);
  if (input.status === "running") throw new StudioError("The Analysis is already running for this client.", 409);
  if (!input.instagram && !input.website) throw new StudioError("Give the client's Instagram account or website first.");
  await run(c.env.DB, "UPDATE client_profiles SET status = 'running', error = NULL, updated = ? WHERE client = ?", now(), clientId);
  try {
    const read = async (handle: string, posts: number) => {
      if (!handle) return null;
      try {
        return await instagramProfile(c.env, handle, posts);
      } catch (e) {
        // The client's own account must be readable; a compared brand may be skipped.
        if (handle === input.instagram) throw e;
        console.log(`[profile] @${handle} skipped: ${errorMessage(e).slice(0, 160)}`);
        return null;
      }
    };
    const [ig, site] = await Promise.all([read(input.instagram, 24), siteOf(input.website) ? readWebsite(siteOf(input.website)) : Promise.resolve(null)]);
    const clientImages = ig ? await postImages(ig, CLIENT_IMAGES) : [];
    const accounts: ReadAccount[] = [readAccount(client.name, "client", ig, site?.text ?? null, clientImages.length)];
    const images = [...clientImages];
    const refsRead: ProfileSources["refs"] = [];
    for (const ref of input.refs) {
      const [rig, rsite] = await Promise.all([read(ref.handle, 12), siteOf(ref.website) ? readWebsite(siteOf(ref.website), 3000) : Promise.resolve(null)]);
      const pics = rig ? await postImages(rig, REF_IMAGES) : [];
      images.push(...pics);
      const name = rig?.name || (ref.handle ? `@${ref.handle}` : new URL(siteOf(ref.website) || "https://brand").host);
      accounts.push(readAccount(name, ref.kind, rig, rsite?.text ?? null, pics.length));
      refsRead.push({ name, instagram: !!rig, website: !!rsite });
    }
    if (!ig && !site) throw new StudioError("Neither the Instagram account nor the website could be read.", 502);
    const colours = parse<{ name?: string; hex?: string }[]>(client.colors, []).map((x) => `${x.name ?? ""} ${x.hex ?? ""}`.trim());
    const text = await askText(
      c.env,
      profileInstruction({
        clientName: client.name,
        brandKit: { tone: client.tone, dos: client.dos, donts: client.donts, style: client.style, colours, service: client.service ?? undefined },
        accounts,
      }),
      PROFILE_SCHEMA,
      images,
    );
    const profile = parseProfile(JSON.parse(text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
    if (!profile) throw new StudioError("The model returned no usable profile. Try again.", 502);
    const grids = await suggestGrids(c.env, clientId, profile.gridQueries);
    const sources: ProfileSources = {
      instagram: ig ? { username: ig.username, followers: ig.followers, posts: ig.posts, read: ig.media.length, picture: ig.picture } : undefined,
      website: site ? { pages: site.pages } : undefined,
      refs: refsRead,
      grids,
    };
    await run(
      c.env.DB,
      "UPDATE client_profiles SET profile = ?, sources = ?, status = 'idle', error = NULL, analysed = ?, updated = ? WHERE client = ?",
      JSON.stringify(profile),
      JSON.stringify(sources),
      now(),
      now(),
      clientId,
    );
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    await run(c.env.DB, "UPDATE client_profiles SET status = 'failed', error = ?, updated = ? WHERE client = ?", message, now(), clientId);
    throw e instanceof StudioError ? e : new StudioError(`The Analysis failed: ${message}`, 502);
  }
  return c.json({ ok: true, profile: toRecord(clientId, await profileRow(c.env, clientId)) });
});

/** Grids suggested for the client, waiting for approval or already on the shelf. */
profileRoutes.get("/:client/grids", async (c) => {
  const rows = await all<{ id: string; title: string; status: string; updated: number; tiles: number }>(
    c.env.DB,
    "SELECT id, title, status, updated, tiles FROM styles WHERE client = ? AND category = 'grid' AND status IN ('review', 'active') ORDER BY status = 'active' DESC, score DESC LIMIT 24",
    c.req.param("client"),
  );
  const pool = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM styles WHERE client = ? AND status = 'pool'", c.req.param("client")))?.n ?? 0;
  return c.json({ ok: true, grids: rows, reading: pool });
});
