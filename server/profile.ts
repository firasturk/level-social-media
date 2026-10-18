/**
 * Client profiles: the Analysis reads the client's Instagram (Business Discovery), its website and
 * the brands the team compares it with, then one vision call writes the profile. The profile steers
 * ideas, headlines and captions, and its Pinterest searches bring suggested feed grids.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { listClients } from "./clients";
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
  let filled: string[] = [];
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
    // What the kit still lacks is filled from what was just read; the designer's own entries stay.
    filled = await fillKitFromProfile(c.env, clientId, profile, ig?.picture ?? null).catch((e) => {
      console.error("[profile] kit", errorMessage(e));
      return [];
    });
  } catch (e) {
    const message = errorMessage(e).slice(0, 400);
    await run(c.env.DB, "UPDATE client_profiles SET status = 'failed', error = ?, updated = ? WHERE client = ?", message, now(), clientId);
    throw e instanceof StudioError ? e : new StudioError(`The Analysis failed: ${message}`, 502);
  }
  return c.json({ ok: true, profile: toRecord(clientId, await profileRow(c.env, clientId)), filled, clients: await listClients(c.env) });
});

/* ───────────── The brand kit filled from the Analysis ───────────── */

const HEX = /#[0-9a-f]{6}\b/i;

/** A headline font that suits the lettering the Analysis saw. */
function headlineFontFor(lettering: string): string {
  const t = lettering.toLowerCase();
  if (/nastaliq|calligraph|thuluth|diwani|خط/.test(t)) return "Aref Ruqaa";
  if (/naskh|classic|traditional|serif/.test(t)) return "Amiri";
  if (/kufi|geometric|square/.test(t)) return "Reem Kufi";
  if (/playful|rounded|hand|script|fun|kids|child/.test(t)) return "Lemonada";
  if (/heavy|display|bold|strong|impact/.test(t)) return "Lalezar";
  if (/elegant|modern|luxury|premium|minimal/.test(t)) return "El Messiri";
  return "Cairo";
}

/**
 * The Analysis fills what the brand kit still lacks: colours, tone of voice, rules, the visual
 * identity text, the fonts and the logo (the Instagram profile picture). Anything the designer
 * already filled is never touched. Returns the names of the fields filled.
 */
export async function fillKitFromProfile(env: Env, clientId: string, profile: ClientProfile, picture: string | null): Promise<string[]> {
  const row = await first<{ colors: string; fonts: string; tone: string; dos: string; donts: string; style: string; logo_key: string | null }>(
    env.DB,
    "SELECT colors, fonts, tone, dos, donts, style, logo_key FROM clients WHERE id = ?",
    clientId,
  );
  if (!row) return [];
  const sets: string[] = [];
  const params: unknown[] = [];
  const filled: string[] = [];
  const set = (col: string, value: string, label: string) => {
    sets.push(`${col} = ?`);
    params.push(value);
    filled.push(label);
  };
  const colours = parse<{ name?: string; hex?: string }[]>(row.colors, []);
  if (!colours.length) {
    const seen = new Set<string>();
    const list = profile.branding.colours
      .map((c) => {
        const hex = HEX.exec(c)?.[0]?.toLowerCase();
        if (!hex || seen.has(hex)) return null;
        seen.add(hex);
        const name = c.replace(HEX, "").replace(/[()·:,-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || hex;
        return { name, hex };
      })
      .filter((x): x is { name: string; hex: string } => !!x)
      .slice(0, 6);
    if (list.length) set("colors", JSON.stringify(list), "colours");
  }
  if (!row.tone.trim()) {
    const tone = [profile.tone.description, profile.tone.dialect && `Dialect: ${profile.tone.dialect}.`].filter(Boolean).join(" ").trim();
    if (tone) set("tone", tone.slice(0, 2000), "tone of voice");
  }
  const rule = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!row.dos.trim()) {
    const dos = [...profile.tips.design, ...profile.tips.headlines].map(rule).filter((t) => t && !/\b(never|avoid|no |don't|do not)\b/i.test(t)).slice(0, 6);
    if (dos.length) set("dos", dos.join("\n"), "always rules");
  }
  if (!row.donts.trim()) {
    const donts = [...profile.tips.design, ...profile.tips.headlines, ...profile.tips.captions, ...profile.tone.improve].map(rule).filter((t) => /\b(never|avoid|no |don't|do not|stop)\b/i.test(t)).slice(0, 5);
    if (donts.length) set("donts", donts.join("\n"), "never rules");
  }
  if (!row.style.trim()) {
    const style = [profile.branding.photography, profile.branding.packaging && `Packaging: ${profile.branding.packaging}`, profile.branding.type && `Lettering: ${profile.branding.type}`].filter(Boolean).join(" ").trim();
    if (style) set("style", style.slice(0, 2000), "visual identity");
  }
  const fonts = parse<{ headline?: string; body?: string }>(row.fonts, {});
  if (!fonts.headline) {
    const corporate = /corporate|insurance|bank|finance|clean|sans/i.test(profile.branding.type);
    set("fonts", JSON.stringify({ ...fonts, headline: headlineFontFor(profile.branding.type), body: fonts.body ?? (corporate ? "Almarai" : "Tajawal") }), "fonts");
  }
  if (!row.logo_key && picture) {
    try {
      const r = await fetch(picture, { signal: AbortSignal.timeout(15_000) });
      const type = r.headers.get("content-type")?.split(";")[0] ?? "";
      if (r.ok && /^image\/(png|jpeg|webp)$/.test(type)) {
        const key = `clients/${clientId}/logo-${uuid()}`;
        await env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType: type } });
        set("logo_key", key, "logo (the Instagram profile picture)");
      }
    } catch (e) {
      console.error("[profile] logo", errorMessage(e));
    }
  }
  if (!sets.length) return [];
  await run(env.DB, `UPDATE clients SET ${sets.join(", ")}, updated = ? WHERE id = ?`, ...params, now(), clientId);
  return filled;
}

/** Fills the brand kit's empty fields from the stored Analysis (the Analysis does this by itself too). */
profileRoutes.post("/:client/fill-kit", async (c) => {
  const clientId = c.req.param("client");
  const rec = toRecord(clientId, await profileRow(c.env, clientId));
  if (!rec.profile) throw new StudioError("Run the Analysis first.", 409);
  const filled = await fillKitFromProfile(c.env, clientId, rec.profile, rec.sources?.instagram?.picture ?? null);
  return c.json({ ok: true, filled, clients: await listClients(c.env) });
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
