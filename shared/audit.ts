/**
 * The system check: what the studio looks at in production (its connections, crons, clients,
 * months, library, storage and writing) and how it reports what it finds.
 */

export type AuditSeverity = "error" | "warn" | "ok" | "info";
export type AuditArea = "connections" | "crons" | "clients" | "months" | "library" | "storage" | "writing";

export const AUDIT_AREAS: { id: AuditArea; label: string }[] = [
  { id: "connections", label: "Connected tools" },
  { id: "crons", label: "Background jobs" },
  { id: "clients", label: "Clients" },
  { id: "months", label: "Months" },
  { id: "writing", label: "Writing" },
  { id: "library", label: "Style library" },
  { id: "storage", label: "Storage" },
];

export interface AuditFinding {
  area: AuditArea;
  severity: AuditSeverity;
  title: string;
  /** What was seen, in a sentence or two. */
  detail?: string;
  /** What to do about it. */
  fix?: string;
  /** The client or month it is about. */
  about?: string;
}

export interface AuditReport {
  at: number;
  /** How long the check took. */
  ms: number;
  /** The live tools were called too (the text model, Instagram, Drive, the writing review). */
  deep: boolean;
  findings: AuditFinding[];
}

export function auditCounts(r: Pick<AuditReport, "findings">): Record<AuditSeverity, number> {
  const out: Record<AuditSeverity, number> = { error: 0, warn: 0, ok: 0, info: 0 };
  for (const f of r.findings) out[f.severity]++;
  return out;
}

/* ───────────── The writing review ───────────── */

export const WRITING_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    summary: { type: "string" },
    issues: { type: "array", items: { type: "object", properties: { post: { type: "integer" }, issue: { type: "string" } }, required: ["post", "issue"] } },
  },
  required: ["score", "summary", "issues"],
};

export function writingReviewInstruction(r: {
  client: string;
  tone: string;
  language: string;
  posts: { index: number; type: string; headline?: string; subline?: string; caption?: string; hashtags?: string }[];
}): string {
  return [
    `You are the senior Arabic copy editor of a social media agency in Jordan, reviewing one month of Instagram posts written for the brand "${r.client}" before they go out. Tone of voice the brand asked for: ${r.tone || "not given"}. Language: ${r.language}.`,
    `THE POSTS:\n${r.posts
      .map((p) => `Post ${p.index} (${p.type}): headline "${p.headline ?? ""}"${p.subline ? `; second line "${p.subline}"` : ""}${p.caption ? `; caption: ${p.caption.replace(/\s+/g, " ").slice(0, 400)}` : "; no caption yet"}${p.hashtags ? `; hashtags: ${p.hashtags.slice(0, 160)}` : ""}`)
      .join("\n")}`,
    [
      "Check, strictly:",
      "- spelling and grammar in Arabic (a misspelt word, a wrong hamza, a broken plural, Latin letters inside Arabic);",
      "- the dialect and tone the brand asked for (Jordanian colloquial stays colloquial; formal Fusha stays formal), consistent across the month;",
      "- headlines: short, one idea, no repetition of the same headline or the same opening across posts, no empty filler;",
      "- captions: speak to the reader, name the product, end with one clear call to action, hashtags relevant and not spammy;",
      "- anything that would embarrass the brand (a wrong claim, a word with a bad second meaning, a competitor's name).",
      "Report only real problems, one per line, with the post number. Give score 1-10 for the month's writing and a two-sentence summary in English.",
    ].join("\n"),
    "Return ONLY the JSON.",
  ].join("\n\n");
}

export function parseWritingReview(raw: unknown): { score: number; summary: string; issues: { post: number; issue: string }[] } | null {
  const x = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!x) return null;
  const score = Math.max(0, Math.min(10, Math.round(Number(x.score)) || 0));
  const issues = (Array.isArray(x.issues) ? x.issues : [])
    .map((i) => ({ post: Math.round(Number((i as { post?: unknown })?.post)) || 0, issue: String((i as { issue?: unknown })?.issue ?? "").trim() }))
    .filter((i) => i.issue)
    .slice(0, 30);
  return { score, summary: String(x.summary ?? "").trim().slice(0, 500), issues };
}
