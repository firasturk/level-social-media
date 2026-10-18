/**
 * Autopilot: the admin's one button that walks the whole journey for a client. The journey runs
 * each screen by itself; what a person would decide is decided here.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first } from "./db";
import { askText, profileOf } from "./posts";
import type { User } from "@shared/types";
import { GRID_PICK_SCHEMA, gridPickInstruction, parseGridPick, type GridCandidate } from "@shared/autopilot";

type Variables = { user: User };

export const autopilotRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

autopilotRoutes.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") throw new StudioError("Autopilot is for admins.", 403);
  await next();
});

/** The grid from the library that fits the client best, with why. */
autopilotRoutes.post("/grid", async (c) => {
  const d = z.object({ client: z.string().min(1), count: z.number().int().min(1).max(30).default(9), choices: z.number().int().min(1).max(5).default(1) }).parse(await c.req.json().catch(() => ({})));
  const client = await first<{ id: string; name: string; tone: string; style: string; colors: string; service: string | null }>(
    c.env.DB,
    "SELECT id, name, tone, style, colors, service FROM clients WHERE id = ?",
    d.client,
  );
  if (!client) throw new StudioError("Client not found.", 404);
  const rows = await all<{ id: string; title: string; tags: string; prompt: string; tiles: number; client: string }>(
    c.env.DB,
    "SELECT id, title, tags, prompt, tiles, client FROM styles WHERE category = 'grid' AND status = 'active' AND image_key IS NOT NULL AND client IN ('', ?) ORDER BY client = ? DESC, score DESC LIMIT 80",
    client.id,
    client.id,
  );
  if (!rows.length) throw new StudioError("The grid library is empty: approve some grids first.", 404);
  const grids: GridCandidate[] = rows.map((r) => ({ id: r.id, title: r.title, tags: r.tags, about: r.prompt, tiles: r.tiles, forClient: r.client === client.id }));
  const products = await all<{ name: string }>(
    c.env.DB,
    "SELECT name, COUNT(*) AS n FROM drive_photos WHERE client = ? AND status = 'read' AND kind IN ('product', 'lifestyle', 'drink') GROUP BY name ORDER BY n DESC LIMIT 40",
    client.id,
  );
  const places = await all<{ kind: string; n: number }>(
    c.env.DB,
    "SELECT kind, COUNT(*) AS n FROM drive_photos WHERE client = ? AND status = 'read' AND kind IN ('place', 'factory') GROUP BY kind",
    client.id,
  );
  const colours = (() => {
    try {
      return (JSON.parse(client.colors) as { name?: string; hex?: string }[]).map((x) => `${x.name ?? ""} ${x.hex ?? ""}`.trim()).join(", ");
    } catch {
      return "";
    }
  })();
  const raw = await askText(
    c.env,
    gridPickInstruction({
      client: client.name,
      profile: await profileOf(c.env, client.id),
      brand: [client.service ? `offers ${client.service}` : "", client.tone ? `tone: ${client.tone}` : "", colours ? `colours: ${colours}` : "", client.style?.slice(0, 400) ?? ""]
        .filter(Boolean)
        .join("; "),
      products: products.map((p) => p.name),
      places: places.map((p) => `${p.kind === "factory" ? "its kitchen or factory" : "its shop"} (${p.n})`).join(", "),
      count: d.count,
      grids,
      choices: d.choices,
    }),
    GRID_PICK_SCHEMA,
  );
  const pick = parseGridPick(JSON.parse(raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()), grids);
  if (!pick) throw new StudioError("The model picked no grid. Try again.", 502);
  const titleOf = (g: GridCandidate) => ({ id: g.id, title: g.title, tiles: g.tiles });
  return c.json({
    ok: true,
    id: pick.grid.id,
    title: pick.grid.title,
    reason: pick.reason,
    choices: [{ ...titleOf(pick.grid), reason: pick.reason }, ...pick.others.slice(0, d.choices - 1).map((o) => ({ ...titleOf(o.grid), reason: o.reason }))],
  });
});
