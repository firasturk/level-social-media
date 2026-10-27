/**
 * The Help assistant, "Firas" (named after the studio's owner): a member asks how to do something; the text model answers only from the
 * studio's own guide (shared/help-guide.ts), in the member's language, with the English labels as
 * they appear. When the guide does not cover it (the thing does not exist, or something is broken),
 * the answer says so and drafts a message to Firas, which the member sends with one click: it lands
 * in the admins' Help inbox and, when Resend is set up, in their e-mail. One text call per question,
 * nothing else is run or paid.
 *
 * Routes (mounted at /api/studio/help):
 *   POST /ask                {message, history?, screen?}         every member, 60 questions a day each
 *   POST /requests           {question, message, answer?, screen?} every member: the request to Firas
 *   GET  /requests/mine                                           the member's own requests and replies
 *   GET  /requests           ?kind=request|question               admins: the inbox (newest first)
 *   POST /requests/:id       {status, reply?}                     admins: done / open, with a reply
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { askText, parseJson } from "./posts";
import { getSetting, NOTIFY_FROM_SETTING, RESEND_KEY_SETTING } from "./settings";
import { FALLBACK_FROM, publicOrigin, sendResend } from "./notify";
import { HELP_GUIDE } from "@shared/help-guide";
import type { User } from "@shared/types";

type Variables = { user: User };
export const helpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Questions one member may ask in a day (a text call each). */
export const HELP_DAILY_LIMIT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export const HELP_SCHEMA = {
  type: "object",
  properties: {
    /** The answer in the member's language, short, labels in English as in the guide. */
    answer: { type: "string" },
    /** The steps to follow, one per item, in order; empty when there is nothing to click. */
    steps: { type: "array", items: { type: "string" } },
    /** The guide covers it (true), or it does not exist / is not covered / looks broken (false). */
    known: { type: "boolean" },
    /** When known is false: the message to Firas, written for him, in the member's language. */
    request: { type: "string" },
  },
  required: ["answer", "steps", "known", "request"],
};

export interface HelpAnswer {
  answer: string;
  steps: string[];
  known: boolean;
  request: string;
}

export interface HelpTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * The character Firas asked for: a grumpy, fed-up Firas who still always helps, with a bank of his
 * lines to vary from. A joke for the team, never a real insult; the steps stay exact and the
 * request to the real Firas stays plain.
 */
export const HELP_CHARACTER = [
  "YOUR CHARACTER (softened for the team on 27 Oct): you are a warm, quick colleague who likes helping and keeps it light. Simple Jordanian/Levantine Arabic (or plain English when they write English), friendly and direct, never preachy. A little humour is welcome (a wink at a very simple question: a 😄 or \"سهلة 😄\" before the answer), never teasing, never a line that could make the member feel slow or a nuisance: no \"use your brain\", no \"last time you ask\", no sighing at the question. At most one emoji per answer, and some answers with none.",
  "Habits: thanked → a short warm \"عفواً، بأي وقت 🙂\". The same question again in this conversation → answer it again, shorter, without remarking on it. A step that costs credits or money → say it plainly: \"انتبه، هاي بتكلف كريدت 💸\". Admins only → \"هاي للأدمن بس: اطلبها من الأدمن\". Not in the studio → \"مش موجودة بالاستوديو لسا، ببعتها لفراس عشان يضيفها\" (and set known false). A long, messy question → answer the actual question without comment.",
  "Local time habits (only when the time below says so): late at night (22:00–05:00) → one warm line such as \"لسا صاحي؟ هاي الجواب وبعدين ريّح 🌙\" once; Friday → \"جمعة مباركة\" once; early morning (05:00–08:00) → \"صباح الخير ☕\" once.",
  "Limits: nothing about their intelligence, person, family, looks or religion; no swearing; the steps stay complete and exact. If someone is clearly upset or stuck on something urgent (a client waiting, money at stake), skip every pleasantry and just help. The `request` for Firas is written plainly and politely, without the character.",
];

export function helpInstruction(r: { message: string; history: HelpTurn[]; role: User["role"]; name: string; screen?: string; local?: { hour: number; weekday: number } }): string {
  const history = r.history.length ? r.history.map((t) => `${t.role === "user" ? "Member" : "Assistant"}: ${t.text}`).join("\n") : "(none)";
  return [
    "You are Firas, the assistant inside Level Studio, the social-media post studio of the agency Level MENA (you are named after the studio's owner, Firas, who receives the requests you cannot answer). Team members ask you how to do things in the studio. Speak in the first person and briefly.",
    ...HELP_CHARACTER,
    "Answer ONLY from the guide below. Never invent a button, tab, setting or feature. Quote labels exactly as the guide writes them, in English, in double quotes (the studio's screens are in English).",
    "Write in the member's language: Arabic (simple Levantine/Jordanian Arabic) when they write Arabic, English when they write English.",
    "ALWAYS SHORT: `answer` is one short sentence (at most about 20 words, any friendly line included; never a paragraph), then the clicks in `steps` (at most 5, a few words each, one action each). No greetings, no explanations nobody asked for, no repeating the question. Say when a step costs credits or money, and when it is admins only (then tell a member to ask an admin).",
    "If the guide does not cover the question, if the thing does not exist in the studio, or if the member describes something that looks broken: set known to false, say plainly (no guessing) that it is not in the studio yet or that you do not know, that you can pass it to Firas himself (the owner) to add or fix, and write `request`: a clear message to Firas (the studio's owner) in the member's language saying who needs what, on which screen, and why, so he can add or fix it. Keep it to 2–4 sentences. Otherwise known is true and request is \"\". When the studio cannot do what they want, known is false even when you also give a workaround (for example: posting to TikTok is not in the studio; downloading and posting by hand is only a workaround).",
    "If the question is not about the studio at all, answer in one sentence that you only help with the studio; known true, request \"\".",
    `The member: ${r.name || "a team member"} (${r.role === "admin" ? "admin" : "member, not an admin"}).${r.screen ? ` They are on the screen at ${r.screen}.` : ""}`,
    r.local ? `Their local time: ${String(r.local.hour).padStart(2, "0")}:00, ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][r.local.weekday] ?? "a weekday"}.` : "",
    "",
    "<guide>",
    HELP_GUIDE,
    "</guide>",
    "",
    "The conversation so far:",
    history,
    "",
    `The member's question: ${r.message}`,
    "",
    "Answer as JSON: {\"answer\": string, \"steps\": string[], \"known\": boolean, \"request\": string}.",
  ].join("\n");
}

/** The model's answer made safe to show: strings trimmed and bounded, a request only when not known. */
export function readHelpAnswer(raw: unknown): HelpAnswer {
  const o = (raw ?? {}) as Partial<Record<keyof HelpAnswer, unknown>>;
  const answer = typeof o.answer === "string" ? o.answer.trim().slice(0, 2000) : "";
  const steps = Array.isArray(o.steps) ? o.steps.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, 6) : [];
  const known = o.known !== false;
  const request = !known && typeof o.request === "string" ? o.request.trim().slice(0, 1500) : "";
  if (!answer && !steps.length) throw new StudioError("The assistant gave no usable answer. Ask once more.", 502);
  return { answer, steps, known, request };
}

const askSchema = z.object({
  message: z.string().trim().min(1, "Write a question.").max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) }))
    .max(12)
    .default([]),
  screen: z.string().max(200).optional(),
  local: z.object({ hour: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6) }).optional(),
});

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(issue?.message && !/Required|Expected/.test(issue.message) ? issue.message : `Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

helpRoutes.post("/ask", async (c) => {
  const user = c.get("user");
  const d = await body(c, askSchema);
  const asked = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM help_requests WHERE user_id = ? AND kind = 'question' AND created > ?", user.id, now() - DAY_MS);
  if ((asked?.n ?? 0) >= HELP_DAILY_LIMIT) throw new StudioError(`That is ${HELP_DAILY_LIMIT} questions today. Send the rest to Firas with "Send to Firas", or ask again tomorrow.`, 429);
  const raw = await askText(c.env, helpInstruction({ message: d.message, history: d.history, role: user.role, name: user.name, screen: d.screen, local: d.local }), HELP_SCHEMA);
  const a = readHelpAnswer(parseJson<unknown>(raw));
  const t = now();
  await run(
    c.env.DB,
    "INSERT INTO help_requests (id, user_id, user_name, kind, question, answer, message, known, screen, status, created, updated) VALUES (?, ?, ?, 'question', ?, ?, ?, ?, ?, 'done', ?, ?)",
    uuid(),
    user.id,
    user.name || user.email,
    d.message,
    [a.answer, ...a.steps.map((s, i) => `${i + 1}. ${s}`)].join("\n").slice(0, 4000),
    a.request,
    a.known ? 1 : 0,
    d.screen ?? null,
    t,
    t,
  ).catch((e) => console.error("[help] log", errorMessage(e)));
  return c.json({ ok: true, ...a });
});

const requestSchema = z.object({
  question: z.string().trim().max(2000).default(""),
  message: z.string().trim().min(1, "Write what you need.").max(3000),
  answer: z.string().max(4000).optional(),
  screen: z.string().max(200).optional(),
});

/** The request mailed to every admin when Resend is set up; false (kept in the inbox only) otherwise or when Resend refuses. */
async function mailAdmins(env: Env, user: User, d: z.infer<typeof requestSchema>): Promise<boolean> {
  const key = await getSetting(env, RESEND_KEY_SETTING);
  if (!key) return false;
  const to = (await all<{ email: string }>(env.DB, "SELECT email FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY email")).map((r) => r.email.trim().toLowerCase()).filter(Boolean);
  if (!to.length) return false;
  const from = (await getSetting(env, NOTIFY_FROM_SETTING)) || FALLBACK_FROM;
  const who = user.name || user.email;
  const text = [`${who} (${user.email}) sent you a request through the studio's assistant:`, "", d.message, "", d.question ? `Their question: ${d.question}` : "", d.screen ? `Screen: ${d.screen}` : "", "", `Open the Help inbox: ${publicOrigin(env)}/?help=inbox`].filter((l, i, all) => l || all[i - 1]).join("\n");
  try {
    await sendResend(key, { from, to: [...new Set(to)], subject: `Studio request from ${who} (via the assistant)`, text });
    return true;
  } catch (e) {
    console.error("[help] mail", errorMessage(e));
    return false;
  }
}

helpRoutes.post("/requests", async (c) => {
  const user = c.get("user");
  const d = await body(c, requestSchema);
  const open = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM help_requests WHERE user_id = ? AND kind = 'request' AND created > ?", user.id, now() - DAY_MS);
  if ((open?.n ?? 0) >= 20) throw new StudioError("That is 20 requests today: write to Firas directly for the rest.", 429);
  const id = uuid();
  const t = now();
  await run(c.env.DB, "INSERT INTO help_requests (id, user_id, user_name, kind, question, answer, message, known, screen, status, created, updated) VALUES (?, ?, ?, 'request', ?, ?, ?, 0, ?, 'open', ?, ?)", id, user.id, user.name || user.email, d.question, d.answer ?? "", d.message, d.screen ?? null, t, t);
  const mailed = await mailAdmins(c.env, user, d);
  if (mailed) await run(c.env.DB, "UPDATE help_requests SET mailed = 1 WHERE id = ?", id);
  return c.json({ ok: true, id, mailed });
});

interface HelpRow {
  id: string;
  user_id: string;
  user_name: string;
  kind: string;
  question: string;
  answer: string;
  message: string;
  known: number;
  screen: string | null;
  status: string;
  reply: string | null;
  mailed: number;
  created: number;
  updated: number;
}
const rowJson = (r: HelpRow) => ({ id: r.id, user: r.user_name, kind: r.kind, question: r.question, answer: r.answer, message: r.message, known: !!r.known, screen: r.screen, status: r.status, reply: r.reply, mailed: !!r.mailed, created: r.created, updated: r.updated });

helpRoutes.get("/requests/mine", async (c) => {
  const user = c.get("user");
  const rows = await all<HelpRow>(c.env.DB, "SELECT * FROM help_requests WHERE user_id = ? AND kind = 'request' ORDER BY created DESC LIMIT 30", user.id);
  return c.json({ ok: true, requests: rows.map(rowJson) });
});

helpRoutes.get("/requests", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") throw new StudioError("Admins only.", 403);
  const kind = c.req.query("kind") === "question" ? "question" : "request";
  const rows = await all<HelpRow>(c.env.DB, "SELECT * FROM help_requests WHERE kind = ? ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created DESC LIMIT 200", kind);
  const open = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM help_requests WHERE kind = 'request' AND status = 'open'");
  return c.json({ ok: true, kind, open: open?.n ?? 0, items: rows.map(rowJson) });
});

helpRoutes.post("/requests/:id", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") throw new StudioError("Admins only.", 403);
  const d = await body(c, z.object({ status: z.enum(["open", "done"]), reply: z.string().trim().max(2000).optional() }));
  const row = await first<HelpRow>(c.env.DB, "SELECT * FROM help_requests WHERE id = ? AND kind = 'request'", c.req.param("id"));
  if (!row) throw new StudioError("That request is gone.", 404);
  await run(c.env.DB, "UPDATE help_requests SET status = ?, reply = COALESCE(?, reply), updated = ? WHERE id = ?", d.status, d.reply ?? null, now(), row.id);
  return c.json({ ok: true, request: rowJson({ ...row, status: d.status, reply: d.reply ?? row.reply, updated: now() }) });
});
