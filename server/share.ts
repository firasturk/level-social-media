/**
 * The client's approval link: a month's feed behind a secret token, no sign-in. The client sees
 * each post as it will be published, approves it or asks for a change with a note.
 */
import { feedOrder } from "@shared/testgrid";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, now, run } from "./db";
import { resizedPicture, thumbWidth } from "./thumbs";
import { effectiveApproval, type Config, type ReviewAnswer } from "@shared/config";
import { recordClientAnswer } from "./notify";

export const shareRoutes = new Hono<{ Bindings: Env }>();

interface SharedBatch {
  id: string;
  config: string;
  client: string | null;
  month: string | null;
}

async function sharedBatch(env: Env, token: string | undefined): Promise<{ b: SharedBatch; config: Config }> {
  if (!token || !/^[0-9a-f]{32}$/.test(token)) throw new StudioError("This link is not valid.", 404);
  const b = await first<SharedBatch>(
    env.DB,
    "SELECT id, config, client, month FROM batches WHERE config LIKE ? AND deleted IS NULL LIMIT 1",
    `%"shareToken":"${token}"%`,
  );
  if (!b) throw new StudioError("This link is not valid any more.", 404);
  const config = JSON.parse(b.config) as Config;
  if (config.shareToken !== token) throw new StudioError("This link is not valid any more.", 404);
  return { b, config };
}

interface ClientMarks {
  id: string;
  name: string;
  overlay: string | null;
  logo_key: string | null;
  badge_key: string | null;
  updated: number;
}

/** The reviewer's own answer on a post, by the id their device sent; nothing of the other reviewers. */
function ownAnswer(approval: { answers?: ReviewAnswer[] } | undefined, rid: string): ReviewAnswer | null {
  if (!rid) return null;
  return approval?.answers?.find((a) => a.rid === rid) ?? null;
}

shareRoutes.get("/:token", async (c) => {
  const { b, config } = await sharedBatch(c.env, c.req.param("token"));
  const rid = (c.req.query("rid") ?? "").slice(0, 64);
  const client = await first<ClientMarks>(
    c.env.DB,
    "SELECT id, name, overlay, logo_key, badge_key, updated FROM clients WHERE id = ?",
    config.client ?? b.client ?? "",
  );
  if (!client) throw new StudioError("This link is not valid any more.", 404);
  const fonts = await all<{ id: string; name: string }>(
    c.env.DB,
    "SELECT id, name FROM brand_assets WHERE client = ? AND kind = 'font'",
    client.id,
  );
  const tasks = await all<{ post: number | null; output: string | null; caption: string | null; updated: number; qa: string | null }>(
    c.env.DB,
    "SELECT post, output, caption, updated, qa FROM tasks WHERE batch = ? AND post IS NOT NULL",
    b.id,
  );
  // The faces the review saw: the words keep off them on this page too.
  const facesOf = (qa: string | null | undefined): number[][] => {
    try {
      const f = qa ? (JSON.parse(qa) as { faces?: unknown }).faces : undefined;
      return Array.isArray(f) ? (f as number[][]).filter((x) => Array.isArray(x) && x.length === 4) : [];
    } catch {
      return [];
    }
  };
  const posts = (config.plan ?? []).map((p) => {
    const t = tasks.find((x) => x.post === p.index && x.output);
    let caption = { text: p.caption, hashtags: p.hashtags };
    try {
      if (t?.caption) caption = JSON.parse(t.caption) as typeof caption;
    } catch {
      /* the plan's caption */
    }
    return {
      index: p.index,
      date: p.date ?? null,
      headline: p.headline ?? "",
      subline: p.subline ?? "",
      overlay: p.overlay !== false,
      // The portrait of a royal day is served through this link, not the studio's.
      ov: p.ov
        ? {
            ...p.ov,
            photo: p.ov.photo && p.occasion ? `/api/share/${c.req.param("token")}/occasion/${encodeURIComponent(p.occasion)}` : undefined,
            // The product's outline (typography behind the product) through this link too.
            typo: p.ov.typo
              ? { ...p.ov.typo, subject: p.ov.typo.subject ? `/api/share/${c.req.param("token")}/subject/${p.index}?v=${t?.updated ?? 0}` : undefined }
              : undefined,
          }
        : null,
      caption: caption.text,
      hashtags: caption.hashtags,
      faces: facesOf(t?.qa),
      group: p.group ?? null,
      image: t ? t.updated : null,
      // Each reviewer sees only what they answered themselves.
      approval: ownAnswer(config.approvals?.[String(p.index)], rid),
    };
  });
  // The client's real Instagram account, from its analysed profile: the feed page shows that handle and its followers.
  const instagram = await (async () => {
    try {
      const row = await first<{ sources: string | null; instagram: string }>(c.env.DB, "SELECT sources, instagram FROM client_profiles WHERE client = ?", client.id);
      const src = row?.sources ? (JSON.parse(row.sources) as { instagram?: { username?: string; followers?: number } | null }) : null;
      const username = (src?.instagram?.username || row?.instagram || "").trim().replace(/^@/, "");
      return username ? { username, followers: src?.instagram?.followers ?? null } : null;
    } catch {
      return null;
    }
  })();
  return c.json({
    client: {
      name: client.name,
      instagram,
      overlay: (() => {
        try {
          return client.overlay ? (JSON.parse(client.overlay) as unknown) : null;
        } catch {
          return null;
        }
      })(),
      logo: !!client.logo_key,
      badge: !!client.badge_key,
      fonts,
      updated: client.updated,
    },
    month: config.month ?? b.month ?? "",
    // A grid month: its own fonts, and its words without a dark fade (as in the studio).
    grid: !!config.gridRef,
    // The feed as the profile will show it at the end of the month: the first page of the link.
    order: feedOrder(config.plan ?? []),
    monthFonts: config.monthFonts ?? null,
    posts,
  });
});

function imageResponse(obj: R2ObjectBody): Response {
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/png",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * A post's picture for the client's page. With `w` it is a smaller JPEG made once and kept; the
 * address carries the picture's version, so the browser and the edge keep it for a year.
 */
shareRoutes.get("/:token/image/:index", async (c) => {
  const versioned = !!c.req.query("v");
  const cache = versioned ? await caches.open("share-pictures") : null;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const { b } = await sharedBatch(c.env, c.req.param("token"));
  const row = await first<{ output: string | null }>(
    c.env.DB,
    "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1",
    b.id,
    Number(c.req.param("index")) || 0,
  );
  if (!row?.output) throw new StudioError("Image not found.", 404);
  const w = thumbWidth(c.req.query("w"));
  let res: Response;
  if (w) {
    const small = await resizedPicture(c.env, row.output, w);
    if (!small) throw new StudioError("Image not found.", 404);
    res = new Response(small.bytes, { headers: { "Content-Type": small.mime, "X-Content-Type-Options": "nosniff" } });
  } else {
    const obj = await c.env.BUCKET.get(row.output);
    if (!obj) throw new StudioError("Image not found.", 404);
    res = imageResponse(obj);
  }
  res.headers.set("Cache-Control", versioned ? "public, max-age=31536000, immutable" : "private, max-age=3600");
  if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

shareRoutes.get("/:token/subject/:index", async (c) => {
  const { b } = await sharedBatch(c.env, c.req.param("token"));
  const row = await first<{ output: string | null }>(
    c.env.DB,
    "SELECT output FROM tasks WHERE batch = ? AND post = ? AND output IS NOT NULL ORDER BY updated DESC LIMIT 1",
    b.id,
    Number(c.req.param("index")) || 0,
  );
  const obj = row?.output ? await c.env.BUCKET.get(`${row.output}.subject.json`) : null;
  if (!obj) throw new StudioError("Not found.", 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
});

for (const mark of ["logo", "badge"] as const) {
  shareRoutes.get(`/:token/${mark}`, async (c) => {
    const { b, config } = await sharedBatch(c.env, c.req.param("token"));
    const row = await first<ClientMarks>(
      c.env.DB,
      "SELECT logo_key, badge_key FROM clients WHERE id = ?",
      config.client ?? b.client ?? "",
    );
    const key = mark === "logo" ? row?.logo_key : row?.badge_key;
    const obj = key ? await c.env.BUCKET.get(key) : null;
    if (!obj) throw new StudioError("Not found.", 404);
    return imageResponse(obj);
  });
}

shareRoutes.get("/:token/font/:id", async (c) => {
  const { b, config } = await sharedBatch(c.env, c.req.param("token"));
  const row = await first<{ key: string }>(
    c.env.DB,
    "SELECT key FROM brand_assets WHERE id = ? AND client = ? AND kind = 'font'",
    c.req.param("id"),
    config.client ?? b.client ?? "",
  );
  const obj = row ? await c.env.BUCKET.get(row.key) : null;
  if (!obj) throw new StudioError("Font not found.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "font/ttf", "Cache-Control": "private, max-age=604800" },
  });
});

shareRoutes.get("/:token/occasion/:id", async (c) => {
  const { config } = await sharedBatch(c.env, c.req.param("token"));
  const key = config.occasions?.photos?.[c.req.param("id")];
  const obj = key ? await c.env.BUCKET.get(key) : null;
  if (!obj) throw new StudioError("Not found.", 404);
  return imageResponse(obj);
});

/** The client approves a post or asks for a change. */
shareRoutes.post("/:token/review", async (c) => {
  const parsed = z
    .object({
      index: z.number().int().min(1).max(200),
      status: z.enum(["approved", "changes"]),
      note: z.string().trim().max(1000).optional(),
      by: z.string().trim().max(80).optional(),
      rid: z.string().trim().min(6).max(64).optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError("Invalid review.");
  const { b, config } = await sharedBatch(c.env, c.req.param("token"));
  if (!(config.plan ?? []).some((p) => p.index === parsed.data.index))
    throw new StudioError("That post is not in this month.", 404);
  // Re-read just before writing so two quick answers do not overwrite each other.
  const fresh = await first<{ config: string }>(c.env.DB, "SELECT config FROM batches WHERE id = ?", b.id);
  const cfg = JSON.parse(fresh?.config ?? b.config) as Config;
  // One answer per reviewer (the id their device keeps); a reviewer answering again replaces their own answer only.
  const rid = parsed.data.rid ?? `anon-${crypto.randomUUID()}`;
  const key = String(parsed.data.index);
  const mine: ReviewAnswer = { rid, status: parsed.data.status, note: parsed.data.note || undefined, by: parsed.data.by || undefined, at: now() };
  const answers = [...(cfg.approvals?.[key]?.answers ?? []).filter((a) => a.rid !== rid), mine];
  cfg.approvals = { ...(cfg.approvals ?? {}), [key]: effectiveApproval(answers)! };
  await run(c.env.DB, "UPDATE batches SET config = ?, updated = ? WHERE id = ?", JSON.stringify(cfg), now(), b.id);
  await recordClientAnswer(c.env, { id: b.id, client: config.client ?? b.client }, { index: parsed.data.index, ...mine }).catch((e) => console.error("[notify]", e));
  // The reviewer gets their own answer back, never the others'.
  return c.json({ ok: true, approval: mine });
});
