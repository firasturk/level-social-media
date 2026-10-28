/**
 * Publishing to Instagram: the shape of a publication as the browser sees it, the caption as it
 * goes out, and the default posting time. Shared by the server routes, the cron and the dialogs.
 */
import type { Post } from "./posts";

export type PublicationStatus = "queued" | "publishing" | "published" | "failed" | "cancelled";
export type PublicationKind = "single" | "carousel";

export interface Publication {
  id: string;
  batch: string;
  /** The post's index in the plan; a carousel's first slide. */
  post: number;
  igAccount: string;
  kind: PublicationKind;
  status: PublicationStatus;
  scheduledAt: number;
  publishedAt: number | null;
  mediaId: string | null;
  permalink: string | null;
  error: string | null;
  /** How many pictures go out (a carousel's slides). */
  slides: number;
  caption: string;
  created: number;
  updated: number;
}

/** Instagram's caption limit. */
export const CAPTION_MAX = 2200;
/** Instagram publishes at most this many posts per account per rolling 24 hours. */
export const DAILY_LIMIT = 25;
/** A carousel holds 2 to 10 pictures. */
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 15;
/** The hour (local to the designer) a scheduled post goes out by default. */
export const DEFAULT_HOUR = 10;

/** The caption as Instagram receives it: the caption, a blank line, the hashtags. */
export function buildCaption(caption: string | undefined, hashtags: string | undefined): string {
  const c = (caption ?? "").trim();
  const h = (hashtags ?? "").trim();
  return [c, h].filter(Boolean).join("\n\n");
}

/**
 * The default time a post goes out: its date at 10:00 in the browser's time zone. A post with no
 * date, or a date already past, takes the next 10:00 still to come.
 */
export function defaultPublishAt(date: string | undefined, now: Date = new Date()): Date {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), DEFAULT_HOUR, 0, 0, 0);
    if (d.getTime() > now.getTime()) return d;
  }
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DEFAULT_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** A Date as the value of an <input type="datetime-local">, in local time. */
export function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "12 Oct 10:00" for the card's pill and the dialog. */
export function formatPublishTime(at: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/** The posts that go out together: a carousel's slides in order, or the post alone. */
export function slidesOf(plan: Post[], index: number): Post[] {
  const p = plan.find((x) => x.index === index);
  if (!p) return [];
  if (p.group?.kind !== "carousel") return [p];
  const id = p.group.id;
  return plan.filter((x) => x.group?.kind === "carousel" && x.group.id === id).sort((a, b) => (a.group?.slide ?? 0) - (b.group?.slide ?? 0));
}

/** The publication that stands for a post: a carousel's row is on any of its slides. */
export function publicationFor(list: Publication[], plan: Post[], index: number): Publication | null {
  const indexes = new Set(slidesOf(plan, index).map((p) => p.index));
  if (!indexes.size) indexes.add(index);
  const rows = list.filter((x) => indexes.has(x.post));
  const live = rows.find((x) => x.status === "queued" || x.status === "publishing" || x.status === "published");
  return live ?? rows.sort((a, b) => b.created - a.created)[0] ?? null;
}

/** Whether a publication still stands (the post must not be queued or published again). */
export function isLive(p: Publication | null | undefined): boolean {
  return !!p && (p.status === "queued" || p.status === "publishing" || p.status === "published");
}

/** The short wording of a publication's state on a card. */
export function publishLabel(p: Publication): string {
  switch (p.status) {
    case "queued":
      return `Scheduled ${formatPublishTime(p.scheduledAt)}`;
    case "publishing":
      return "Publishing…";
    case "published":
      return "Published";
    case "failed":
      return "Publish failed";
    case "cancelled":
      return "Publish cancelled";
  }
}
