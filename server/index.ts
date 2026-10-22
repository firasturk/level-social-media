import { dailyStyles } from "./styles";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { authRoutes, currentUser, SESSION_COOKIE } from "./auth";
import { studioRoutes } from "./studio";
import { verifyObjectToken } from "./signed";
import { adminRoutes, cleanupOldBatches } from "./admin";
import { advanceBatch, activeBatchIds, readPendingReferences } from "./engine";
import type { User } from "@shared/types";
import { serveStatic } from "./static";
import { readDrivePhotos } from "./drive";
import { auditRoutes, dailyAudit } from "./audit";
import { shareRoutes } from "./share";

type Variables = { user: User };

import { ASSETS } from "./generated/assets";

/** Changes with every deploy: the hashed script names are unique to a build. */
const BUILD_ID = Object.keys(ASSETS)
  .filter((k) => k.endsWith(".js"))
  .sort()
  .join("|")
  .split("")
  .reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
  .toString(36);

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Same-origin guard for state-changing requests. Browsers always send Origin on cross-origin POSTs.
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if ((origin && origin !== new URL(c.req.url).origin) || site === "cross-site") {
      throw new StudioError("Invalid request origin.", 403);
    }
  }
  await next();
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
  // The build the page's scripts belong to: the client reloads when it changes under it.
  c.res.headers.set("X-Build", BUILD_ID);
});

app.route("/api/auth", authRoutes);

// Signed, short-lived access to one stored image, for engines that fetch inputs by URL (fal.ai).
app.get("/api/public/object", async (c) => {
  const key = c.req.query("k") ?? "";
  const exp = c.req.query("e") ?? "";
  const sig = c.req.query("s") ?? "";
  if (!key || !(await verifyObjectToken(c.env, key, exp, sig)))
    return c.json({ error: "Invalid or expired link." }, 403);
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found." }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// Engine webhook: no session, protected by the shared token. Payload is ignored; state is re-read from the engine.
app.post("/api/hooks/engine", async (c) => {
  const token = c.req.query("token");
  const batch = c.req.query("batch");
  if (!c.env.WEBHOOK_TOKEN || !token || token !== c.env.WEBHOOK_TOKEN || !batch)
    return c.json({ ok: false }, 403);
  c.executionCtx.waitUntil(
    advanceBatch(c.env, batch, { background: (p) => c.executionCtx.waitUntil(p), deferSync: true }),
  );
  return c.json({ ok: true });
});

// The client's approval link: no session, the secret token in the path is the access.
app.route("/api/share", shareRoutes);

app.use("/api/admin/*", async (c, next) => {
  const user = await currentUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new StudioError("Sign in to use the studio.", 401);
  c.set("user", user);
  await next();
});
app.route("/api/admin", adminRoutes);
app.route("/api/admin/audit", auditRoutes);

app.use("/api/studio/*", async (c, next) => {
  const user = await currentUser(c.env, getCookie(c, SESSION_COOKIE));
  if (!user) throw new StudioError("Sign in to use the studio.", 401);
  c.set("user", user);
  await next();
});
app.route("/api/studio", studioRoutes);

app.get("*", (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
  return serveStatic(c.req.path) ?? c.json({ error: "Not found." }, 404);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

app.onError((e, c) => {
  c.header("X-Build", BUILD_ID);
  if (e instanceof StudioError) return c.json({ ...(e.data ?? {}), error: e.message }, e.status as 400);
  console.error("[studio]", e instanceof Error ? e.stack || e.message : e);
  return c.json({ error: `Studio request failed. Retry shortly. (${c.req.method} ${c.req.path.replace(/^\/api\/studio\//, "")})` }, 500);
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Page visits on the long workers.dev and pages.dev addresses move to the studio's own domain, so
    // everyone signs in and bookmarks a single address. API calls are served where they arrive.
    const canonical = env.CANONICAL_ORIGIN;
    if (canonical && (request.method === "GET" || request.method === "HEAD")) {
      const url = new URL(request.url);
      const elsewhere = (url.hostname.endsWith(".workers.dev") || url.hostname.endsWith(".pages.dev")) && `${url.protocol}//${url.host}` !== canonical;
      if (elsewhere && !url.pathname.startsWith("/api/")) return Response.redirect(`${canonical}${url.pathname}${url.search}`, 301);
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupOldBatches(env).catch((e) => console.error("[cleanup]", e)));
    ctx.waitUntil(
      readPendingReferences(env).catch((e) => console.error("[refs]", errorMessage(e))),
    );
    // The style library grows by itself: new pins collected each day, a few read each minute.
    ctx.waitUntil(dailyStyles(env).catch((e) => console.error("[styles]", errorMessage(e))));
    // The clients' Drive photos are named by vision a few at a time, so the team finds them by name.
    ctx.waitUntil(readDrivePhotos(env).catch((e) => console.error("[drive]", errorMessage(e))));
    // The system check runs once a day and tells the admin when something fails.
    ctx.waitUntil(dailyAudit(env).catch((e) => console.error("[audit]", errorMessage(e))));
    const ids = await activeBatchIds(env);
    // Synchronous images run in the background of the cron pass (six at once, refilled as they
    // finish) instead of one after another.
    const background = (p: Promise<unknown>) => ctx.waitUntil(p.catch(() => {}));
    for (const id of ids)
      ctx.waitUntil(advanceBatch(env, id, { background }).catch((e) => console.error("[cron]", id, e)));
  },
} satisfies ExportedHandler<Env>;
