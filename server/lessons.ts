/**
 * Lessons: every problem the automatic review finds in a client's picture is kept, and the next
 * prompts for that client forbid it explicitly. The team can forget a lesson that was a false alarm.
 */
import { Hono } from "hono";
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
}

/** How many lessons a prompt carries (the most repeated first, then the most recent). */
export const PROMPT_LESSONS = 10;
const MAX_LESSONS = 60;

/** Notes that describe this one picture's run, not a mistake to avoid next time. */
const NOT_A_LESSON = /could not be placed|Automatic review|empty place was not clear/i;

export async function rememberLessons(env: Env, client: string | null, batch: string, flags: PostFlag[] | undefined): Promise<void> {
  if (!client || !flags?.length) return;
  const t = now();
  for (const f of flags) {
    const text = f.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text || NOT_A_LESSON.test(text)) continue;
    await run(
      env.DB,
      "INSERT INTO lessons (id, client, kind, text, seen, first, last, batch) VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(client, text) DO UPDATE SET seen = seen + 1, last = excluded.last, batch = excluded.batch",
      uuid(),
      client,
      f.kind,
      text,
      t,
      t,
      batch,
    );
  }
  // The oldest rarely-seen lessons make room.
  await run(
    env.DB,
    "DELETE FROM lessons WHERE client = ? AND id NOT IN (SELECT id FROM lessons WHERE client = ? ORDER BY seen DESC, last DESC LIMIT ?)",
    client,
    client,
    MAX_LESSONS,
  );
}

/** The lines a prompt carries for this client, worded as rules. */
export async function lessonsFor(env: Env, client: string | null): Promise<string[]> {
  if (!client) return [];
  const rows = await all<LessonRow>(
    env.DB,
    "SELECT * FROM lessons WHERE client = ? ORDER BY seen DESC, last DESC LIMIT ?",
    client,
    PROMPT_LESSONS,
  );
  return rows.map((r) => lessonLine(r.kind as PostFlag["kind"], r.text));
}

lessonRoutes.get("/", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const rows = await all<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE client = ? ORDER BY seen DESC, last DESC", client);
  return c.json(rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, seen: r.seen, last: r.last, rule: lessonLine(r.kind as PostFlag["kind"], r.text) })));
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
