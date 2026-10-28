/**
 * Brand memory (the lessons table): what the studio remembers about a client and writes into its
 * prompts. Four kinds of item live here:
 *
 * - brand_rule: an approved requirement of the brand, for every picture of the client;
 * - campaign_instruction: an instruction for one month (scope {batch});
 * - post_instruction: an instruction for one post of one month (scope {batch, post});
 * - lesson: a mistake the review found, a change the client asked for or a retry's drift. It is
 *   proposed as pending and waits for the admin; only an approved lesson shapes a prompt.
 *
 * Only approved, active (not deactivated) items whose scope fits the post reach a prompt. A
 * revision keeps the old row (deactivated, linked by `replaces`) so the history stays readable.
 *
 * Bulk clearing: DELETE /?client=… removes a client's items but keeps its approved brand rules
 * unless `confirm=brand` is passed as well.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError } from "./errors";
import { all, first, run, now, uuid } from "./db";
import type { User } from "@shared/types";
import type { PostFlag } from "@shared/qa";
import {
  CATEGORY_ORDER,
  MEMORY_CATEGORIES,
  memoryLine,
  parseScope,
  scopeMatches,
  scopeString,
  type MemoryCategory,
  type MemoryItem,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
} from "@shared/brandMemory";

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
  /** The month where a lesson was found (its origin), kept for the list; where it applies is `scope`. */
  batch: string | null;
  /** approved: the prompts carry it; rejected: the admin called it wrong, kept so it is not learned again; pending: waits for the admin. */
  status: MemoryStatus;
  /** review: the automatic review found it; client: the client asked for it; retry: a take made again by itself; team: written by hand. */
  source: string;
  category: MemoryCategory;
  /** JSON {batch?, post?}; '' for the whole brand. */
  scope: string;
  approver: string | null;
  approved_at: number | null;
  revision: number;
  replaces: string | null;
  deactivated: number | null;
}

export type LessonSource = MemorySource;

/** How many lessons a prompt carries (the most repeated first, then the most recent). Rules and instructions are all carried. */
export const PROMPT_LESSONS = 10;
const MAX_PENDING_LESSONS = 60;

/** Notes that describe this one picture's run, not a mistake to avoid next time. */
const NOT_A_LESSON = /could not be placed|Automatic review|empty place was not clear|Looks like an earlier picture/i;

export async function rememberLessons(env: Env, client: string | null, batch: string, flags: PostFlag[] | undefined, source: LessonSource = "review"): Promise<void> {
  if (!client || !flags?.length) return;
  for (const f of flags) await rememberLesson(env, client, batch, f.kind, f.text, source);
}

/**
 * One proposed lesson, with the finding's exact words. It waits as pending for the admin; a finding
 * seen before is counted once more on its existing item (a rejected one stays rejected). It never
 * becomes a brand rule by itself.
 */
export async function rememberLesson(env: Env, client: string | null, batch: string | null, kind: string, rawText: string, source: LessonSource): Promise<void> {
  if (!client) return;
  const text = rawText.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text || NOT_A_LESSON.test(text)) return;
  const t = now();
  const existing = await first<LessonRow>(env.DB, "SELECT * FROM lessons WHERE client = ? AND text = ? AND deactivated IS NULL ORDER BY revision DESC LIMIT 1", client, text);
  if (existing) {
    await run(env.DB, "UPDATE lessons SET seen = seen + 1, last = ?, batch = COALESCE(?, batch) WHERE id = ?", t, batch, existing.id);
    return;
  }
  await run(
    env.DB,
    // A finding is a rule at once (28 Oct): the team rejects the wrong ones instead of approving each.
    "INSERT INTO lessons (id, client, kind, text, seen, first, last, batch, status, source, category, scope, revision) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'approved', ?, 'lesson', '', 1)",
    uuid(),
    client,
    kind,
    text,
    t,
    t,
    batch,
    source,
  );
  // The oldest rarely-seen proposals make room; decided items (approved or rejected) are kept.
  await run(
    env.DB,
    "DELETE FROM lessons WHERE client = ? AND category = 'lesson' AND status = 'pending' AND deactivated IS NULL AND id NOT IN (SELECT id FROM lessons WHERE client = ? AND category = 'lesson' AND status = 'pending' AND deactivated IS NULL ORDER BY seen DESC, last DESC LIMIT ?)",
    client,
    client,
    MAX_PENDING_LESSONS,
  );
}

function toItem(r: LessonRow & { clientName?: string }): MemoryItem {
  return {
    id: r.id,
    client: r.client,
    clientName: r.clientName,
    category: r.category ?? "lesson",
    kind: r.kind,
    text: r.text,
    scope: parseScope(r.scope),
    status: r.status,
    source: r.source,
    seen: r.seen,
    first: r.first,
    last: r.last,
    batch: r.batch,
    approver: r.approver ?? null,
    approved_at: r.approved_at ?? null,
    revision: r.revision ?? 1,
    replaces: r.replaces ?? null,
    deactivated: r.deactivated ?? null,
    rule: memoryLine(r.category ?? "lesson", r.kind, r.text),
  };
}

/** Every active item of a client whose scope fits, in prompt order (optionally only approved ones). */
async function activeItems(env: Env, client: string, scope: MemoryScope | undefined, approvedOnly: boolean): Promise<MemoryItem[]> {
  const rows = await all<LessonRow>(
    env.DB,
    `SELECT * FROM lessons WHERE client = ? AND deactivated IS NULL${approvedOnly ? " AND status = 'approved'" : ""} ORDER BY seen DESC, last DESC`,
    client,
  );
  return rows
    .map(toItem)
    .filter((i) => scopeMatches(i.scope, scope))
    .sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || b.seen - a.seen || b.last - a.last);
}

/**
 * The lines a prompt carries for this client: every approved, active brand rule, the instructions
 * of this month and post (when a scope is given), and the most repeated approved lessons. Without a
 * scope only brand-wide items are returned. Pending and rejected items never appear.
 */
export async function lessonsFor(env: Env, client: string | null, scope?: MemoryScope): Promise<string[]> {
  if (!client) return [];
  const items = await activeItems(env, client, scope, true);
  let lessons = 0;
  return items.filter((i) => i.category !== "lesson" || lessons++ < PROMPT_LESSONS).map((i) => i.rule);
}

export type Memory = Record<MemoryCategory, MemoryItem[]>;

/** The active items that apply to a batch and post (every status), grouped by category, for the UI. */
export async function memoryFor(env: Env, client: string | null, scope: MemoryScope): Promise<Memory> {
  const out: Memory = { brand_rule: [], campaign_instruction: [], post_instruction: [], lesson: [] };
  if (!client) return out;
  for (const i of await activeItems(env, client, scope, false)) out[i.category].push(i);
  return out;
}

const whoIs = (u: User) => u.name || u.email || u.id;

/**
 * GET /?client=…[&category=…][&status=…][&batch=…][&active=1]
 * Every item of a client (deactivated ones included unless active=1), newest first.
 * batch=… keeps brand-wide items and those scoped to that month.
 */
lessonRoutes.get("/", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const category = c.req.query("category") ?? "";
  const status = c.req.query("status") ?? "";
  const batch = c.req.query("batch") ?? "";
  const active = c.req.query("active") === "1";
  const where = ["client = ?"];
  const args: unknown[] = [client];
  if (category) {
    if (!MEMORY_CATEGORIES.includes(category as MemoryCategory)) throw new StudioError("Unknown category.");
    where.push("category = ?");
    args.push(category);
  }
  if (status) {
    if (!["pending", "approved", "rejected"].includes(status)) throw new StudioError("Unknown status.");
    where.push("status = ?");
    args.push(status);
  }
  if (active) where.push("deactivated IS NULL");
  const rows = await all<LessonRow>(c.env.DB, `SELECT * FROM lessons WHERE ${where.join(" AND ")} ORDER BY last DESC, revision DESC`, ...args);
  const items = rows.map(toItem).filter((i) => !batch || !i.scope.batch || i.scope.batch === batch);
  return c.json(items);
});

/** GET /memory?client=…&batch=…[&post=…]: the active items that apply there, grouped by category. */
lessonRoutes.get("/memory", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const batch = c.req.query("batch") || undefined;
  const post = c.req.query("post") ? Number(c.req.query("post")) : undefined;
  return c.json(await memoryFor(c.env, client, { batch, post: Number.isInteger(post) && post! > 0 ? post : undefined }));
});

/** GET /months?client=…: the client's months, for the scope picker. */
lessonRoutes.get("/months", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const rows = await all<{ id: string; name: string; month: string | null }>(
    c.env.DB,
    "SELECT id, name, month FROM batches WHERE client = ? AND deleted IS NULL ORDER BY COALESCE(month, '') DESC, created DESC LIMIT 60",
    client,
  );
  return c.json(rows);
});

/** Lessons learned: every lesson of the last 60 days across the clients, newest first (admin). */
lessonRoutes.get("/learned", async (c) => {
  if (c.get("user").role !== "admin") throw new StudioError("Admins only.", 403);
  const since = now() - 60 * 86_400_000;
  const rows = await all<LessonRow & { clientName: string }>(
    c.env.DB,
    "SELECT l.*, c.name AS clientName FROM lessons l LEFT JOIN clients c ON c.id = l.client WHERE l.deactivated IS NULL AND (l.last >= ? OR l.status = 'pending') ORDER BY l.last DESC LIMIT 600",
    since,
  );
  return c.json(rows.map(toItem));
});

/** How many items wait for the admin (the sidebar badge). */
lessonRoutes.get("/pending", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ ok: true, n: 0 });
  const n = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM lessons WHERE status = 'pending' AND deactivated IS NULL"))?.n ?? 0;
  return c.json({ ok: true, n });
});

const createBody = z.object({
  client: z.string().min(1),
  text: z.string().trim().min(1).max(600),
  category: z.enum(["brand_rule", "campaign_instruction", "post_instruction", "lesson"]),
  scope: z.object({ batch: z.string().min(1).optional(), post: z.number().int().min(1).optional() }).optional(),
  kind: z.string().trim().max(30).optional(),
});

function checkScope(category: MemoryCategory, scope: MemoryScope | undefined): MemoryScope {
  const s: MemoryScope = { batch: scope?.batch, post: scope?.post };
  if (category === "brand_rule") return {};
  if (category === "campaign_instruction") {
    if (!s.batch) throw new StudioError("A campaign instruction needs its month.");
    return { batch: s.batch };
  }
  if (category === "post_instruction") {
    if (!s.batch || !s.post) throw new StudioError("A post instruction needs its month and post.");
    return { batch: s.batch, post: s.post };
  }
  return s.batch ? (s.post ? { batch: s.batch, post: s.post } : { batch: s.batch }) : {};
}

/**
 * POST / {client, text, category, scope?, kind?}
 * A brand rule, a month's or a post's instruction, or a lesson written by hand. Approved at once
 * when an admin writes anything but a lesson; pending otherwise. Answers the item.
 */
lessonRoutes.post("/", async (c) => {
  const d = createBody.parse(await c.req.json().catch(() => ({})));
  const user = c.get("user");
  const scope = checkScope(d.category, d.scope);
  const text = d.text.replace(/\s+/g, " ").trim();
  const dup = await first<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE client = ? AND text = ? AND deactivated IS NULL", d.client, text);
  if (dup) throw new StudioError("This is already in the memory.", 409);
  if (scope.batch) {
    const b = await first<{ id: string; client: string | null }>(c.env.DB, "SELECT id, client FROM batches WHERE id = ? AND deleted IS NULL", scope.batch);
    if (!b || b.client !== d.client) throw new StudioError("That month is not this client's.", 404);
  }
  const approved = user.role === "admin" && d.category !== "lesson";
  const t = now();
  const id = uuid();
  await run(
    c.env.DB,
    "INSERT INTO lessons (id, client, kind, text, seen, first, last, batch, status, source, category, scope, approver, approved_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'team', ?, ?, ?, ?, 1)",
    id,
    d.client,
    d.kind || (d.category === "lesson" ? "client" : "rule"),
    text,
    t,
    t,
    scope.batch ?? null,
    approved ? "approved" : "pending",
    d.category,
    scopeString(scope),
    approved ? whoIs(user) : null,
    approved ? t : null,
  );
  const row = await first<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE id = ?", id);
  return c.json(toItem(row!), 201);
});

async function rowOr404(env: Env, id: string): Promise<LessonRow> {
  const row = await first<LessonRow>(env.DB, "SELECT * FROM lessons WHERE id = ?", id);
  if (!row) throw new StudioError("This item is already gone.", 404);
  return row;
}

/** PUT /:id {status}: the admin approves, rejects or sets aside one item; who and when are kept. Other items are untouched. */
lessonRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") throw new StudioError("Admins only.", 403);
  const d = z.object({ status: z.enum(["pending", "approved", "rejected"]) }).parse(await c.req.json().catch(() => ({})));
  const row = await rowOr404(c.env, c.req.param("id"));
  if (row.deactivated) throw new StudioError("This item was retired; revise or write it again.", 409);
  const t = now();
  await run(c.env.DB, "UPDATE lessons SET status = ?, approver = ?, approved_at = ? WHERE id = ?", d.status, whoIs(user), d.status === "approved" ? t : null, row.id);
  return c.json({ ok: true, status: d.status, approver: whoIs(user), approved_at: d.status === "approved" ? t : null });
});

/**
 * POST /:id/revise {text, scope?}: a new row with revision + 1 that replaces the old one; the old row
 * is deactivated and keeps its text. An admin's revision of an approved item stays approved; every
 * other revision waits as pending. Answers the new item.
 */
lessonRoutes.post("/:id/revise", async (c) => {
  const user = c.get("user");
  const d = z
    .object({ text: z.string().trim().min(1).max(600), scope: z.object({ batch: z.string().min(1).optional(), post: z.number().int().min(1).optional() }).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const old = await rowOr404(c.env, c.req.param("id"));
  if (old.deactivated) throw new StudioError("This item was already revised or retired.", 409);
  const category = old.category ?? "lesson";
  const scope = d.scope ? checkScope(category, d.scope) : parseScope(old.scope);
  const text = d.text.replace(/\s+/g, " ").trim();
  const t = now();
  const approved = user.role === "admin" && old.status === "approved";
  const id = uuid();
  await run(c.env.DB, "UPDATE lessons SET deactivated = ? WHERE id = ?", t, old.id);
  await run(
    c.env.DB,
    "INSERT INTO lessons (id, client, kind, text, seen, first, last, batch, status, source, category, scope, approver, approved_at, revision, replaces) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    old.client,
    old.kind,
    text,
    old.seen,
    old.first,
    t,
    scope.batch ?? old.batch,
    approved ? "approved" : "pending",
    old.source,
    category,
    scopeString(scope),
    approved ? whoIs(user) : null,
    approved ? t : null,
    (old.revision ?? 1) + 1,
    old.id,
  );
  const row = await first<LessonRow>(c.env.DB, "SELECT * FROM lessons WHERE id = ?", id);
  return c.json(toItem(row!), 201);
});

/** POST /:id/deactivate: the item is retired; it stays readable but never reaches a prompt again. */
lessonRoutes.post("/:id/deactivate", async (c) => {
  const row = await rowOr404(c.env, c.req.param("id"));
  if (!row.deactivated) await run(c.env.DB, "UPDATE lessons SET deactivated = ? WHERE id = ?", now(), row.id);
  return c.json({ ok: true });
});

lessonRoutes.delete("/:id", async (c) => {
  const row = await rowOr404(c.env, c.req.param("id"));
  await run(c.env.DB, "DELETE FROM lessons WHERE id = ?", row.id);
  return c.json({ ok: true });
});

/**
 * DELETE /?client=…[&confirm=brand]: clears a client's memory. Approved brand rules are kept unless
 * confirm=brand is passed. Answers how many rows went and how many brand rules were kept.
 */
lessonRoutes.delete("/", async (c) => {
  const client = c.req.query("client") ?? "";
  if (!client) throw new StudioError("Client is required.");
  const confirmBrand = c.req.query("confirm") === "brand";
  const kept = confirmBrand ? 0 : ((await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM lessons WHERE client = ? AND category = 'brand_rule' AND status = 'approved'", client))?.n ?? 0);
  const r = confirmBrand
    ? await run(c.env.DB, "DELETE FROM lessons WHERE client = ?", client)
    : await run(c.env.DB, "DELETE FROM lessons WHERE client = ? AND NOT (category = 'brand_rule' AND status = 'approved')", client);
  return c.json({ ok: true, deleted: r, kept });
});
