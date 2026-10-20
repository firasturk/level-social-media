/**
 * Lessons: every problem the automatic review finds in a client's picture is kept, and the next
 * prompts for that client forbid it explicitly. The team can forget a lesson that was a false alarm.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, run, now, uuid } from "./db";
import type { User } from "@shared/types";
import { lessonLine, type PostFlag } from "@shared/qa";

type Variables = { user: User };
export const lessonRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export interface LessonRow {
  id: string;
  client: string;
  kind: string;
  text: string;
  seen: number;
  first: number;
  last: number;
  batch: string | null;
  /** approved: the prompts carry it (every new lesson, by itself); rejected: the admin called it wrong, kept so it is not learned again; pending: set aside. */
  status: "pending" | "approved" | "rejected";
  /** review: the automatic review found it; client: the client asked for it; retry: a take made again by itself. */
  source: string;
}

export type LessonSource = "review" | "client" | "retry";

/** How many lessons a prompt carries (the most repeated first, then the most recent). */
export const PROMPT_LESSONS = 10;
const MAX_LESSONS = 60;

/** Notes that describe this one picture's run, not a mistake to avoid next time. */
const NOT_A_LESSON = /could not be placed|Automatic review|empty place was not clear/i;

export async function rememberLessons(env: Env, client: string | null, batch: string, flags: PostFlag[] | undefined, source: LessonSource = "review"): Promise<void> {
  if (!client || !flags?.length) return;
  for (const f of flags) await rememberLesson(env, client, batch, f.kind, f.text, source);
}

/** One lesson, approved by itself the moment it is learned, or seen once more (a rejected one stays rejected). */
export async function rememberLesson(env: Env, client: string | null, batch: string | null, kind: string, rawText: string, source: LessonSource): Promise<void> {
  if (!client) return;
  const text = rawText.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text || NOT_A_LESSON.test(text)) return;
  const t = now();
  await run(
    env.DB,
    "INSERT INTO lessons (id, client, kind, text, seen, first, last, batch, status, source) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'approved', ?) ON CONFLICT(client, text) DO UPDATE SET seen = seen + 1, last = excluded.last, batch = excluded.batch",
    uuid(),
    client,
    kind,
    text,
    t,
    t,
    batch,
    source,
  );
  // The oldest rarely-seen lessons make room (a rejected one is kept so it is not learned again).
  await run(
    env.DB,
    "DELETE FROM lessons WHERE client = ? AND status != 'rejected' AND id NOT IN (SELECT id FROM lessons WHERE client = ? ORDER BY seen DESC, last DESC LIMIT ?)",
    client,
    client,
    MAX_LESSONS,
  );
}

/** The lines a prompt carries for this client, worded as rules: every lesson the admin has not rejected. */
export async function lessonsFor(env: Env, client: string | null): Promise<string[]> {
  if (!client) return [];
  const rows = await all<LessonRow>(
    env.DB,
    "SELECT * FROM lessons WHERE client = ? AND status = 'approved' ORDER BY seen DESC, last DESC LIMIT ?",
    client,
    PROMPT_LESSONS,
  );
  return rows.map((r) => lessonLine(r.kind as PostFlag["kind"], r.text));
}

const lessonJson = (r: LessonRow & { clientName?: string }) => ({ id: r.id, client: r.client, clientName: r.clientName, kind: r.kind, text: r.text, seen: r.seen, first: r.first, last: r.last, status: r.status, source: r.source, rule: lessonLine(r.kind as PostFlag["kind"], r.text) });

lessonRoutes.get("/", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const rows = await all<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE client = ? ORDER BY seen DESC, last DESC", client);
  return c.json(rows.map(lessonJson));
});

/** Lessons learned: every lesson of the last 60 days across the clients, newest first (admin). */
lessonRoutes.get("/learned", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const since = now() - 60 * 86_400_000;
  const rows = await all<LessonRow & { clientName: string }>(
    c.env.DB,
    "SELECT l.*, c.name AS clientName FROM lessons l LEFT JOIN clients c ON c.id = l.client WHERE l.last >= ? OR l.status = 'pending' ORDER BY l.last DESC LIMIT 600",
    since,
  );
  return c.json(rows.map(lessonJson));
});

/** How many lessons the studio learned in the last day (the sidebar badge). */
lessonRoutes.get("/pending", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ ok: true, n: 0 });
  const n = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM lessons WHERE status = 'approved' AND first >= ?", now() - 86_400_000))?.n ?? 0;
  return c.json({ ok: true, n });
});

/** The admin rejects a lesson that is wrong (the prompts drop it) or brings a rejected one back. */
lessonRoutes.put("/:id", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const d = z.object({ status: z.enum(["pending", "approved", "rejected"]) }).parse(await c.req.json().catch(() => ({})));
  const row = await first<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE id = ?", c.req.param("id"));
  if (!row) throw new StudioError("This lesson is already gone.", 404);
  await run(c.env.DB, "UPDATE lessons SET status = ? WHERE id = ?", d.status, row.id);
  return c.json({ ok: true, status: d.status });
});

lessonRoutes.delete("/:id", async (c) => {
  const row = await first<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE id = ?", c.req.param("id"));
  if (!row) throw new StudioError("This lesson is already gone.", 404);
  await run(c.env.DB, "DELETE FROM lessons WHERE id = ?", row.id);
  return c.json({ ok: true });
});

lessonRoutes.delete("/", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  await run(c.env.DB, "DELETE FROM lessons WHERE client = ?", client);
  return c.json({ ok: true });
});
