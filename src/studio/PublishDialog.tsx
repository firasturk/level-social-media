/**
 * Publishing to Instagram from the studio: one post's dialog (the account, now or a time, the
 * artwork as it goes, the caption as it goes), the month's "Schedule the approved posts" dialog, the
 * card's pill, and the readiness line in Connection. The artwork is composed in the browser the
 * same way the OCR check and the export compose it, so what goes out is what the designer saw.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, Check, ExternalLink, Send, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OverlaySpec } from "@shared/overlay";
import type { Post } from "@shared/posts";
import type { Task } from "@shared/types";
import type { Approval } from "@shared/config";
import { buildCaption, CAPTION_MAX, defaultPublishAt, formatPublishTime, isLive, publicationFor, publishLabel, slidesOf, toLocalInputValue, type Publication } from "@shared/publish";
import { cancelPublication, composeArtwork, requestPublish, retryPublication, usePublications, usePublishStatus, type PublishStatus } from "./publish";

/** The state of a post's publication on its card. */
export function PublishPill({ publication: p }: { publication: Publication | null }) {
  if (!p || p.status === "cancelled") return null;
  if (p.status === "published" && p.permalink)
    return (
      <a className="publish-pill published" href={p.permalink} target="_blank" rel="noreferrer" title={p.publishedAt ? `Published ${formatPublishTime(p.publishedAt)}` : "Published"}>
        Published <ExternalLink size={11} />
      </a>
    );
  return (
    <span className={`publish-pill ${p.status}`} title={p.error ?? undefined}>
      {p.status === "queued" && <CalendarClock size={11} />}
      {p.status === "published" && <Check size={11} />}
      {p.status === "failed" && <TriangleAlert size={11} />}
      {p.status === "publishing" && <Orb size={11} status={null} />}
      {publishLabel(p)}
    </span>
  );
}

/** Which Instagram account, from the connection's list; one line when there is a single choice. */
function AccountPicker({ status, value, onChange }: { status: PublishStatus | null; value: string; onChange: (v: string) => void }) {
  if (!status) return <small className="field-hint">Checking the Instagram connection…</small>;
  if (!status.connected)
    return (
      <p className="publish-not-connected">
        <TriangleAlert size={14} /> {status.reason}
      </p>
    );
  if (status.accounts.length === 1)
    return (
      <small className="field-hint">
        Publishes to <strong>@{status.accounts[0].username}</strong>.
      </small>
    );
  return (
    <label className="field-label">
      Instagram account
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {status.accounts.map((a) => (
          <option key={a.igId} value={a.igId}>
            @{a.username}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The post's slides with their pictures, in order; a slide with no picture yet is named. */
function slidesWithPictures(plan: Post[], tasks: Task[], index: number): { slides: { post: Post; task: Task }[]; missing: Post[] } {
  const slides: { post: Post; task: Task }[] = [];
  const missing: Post[] = [];
  for (const p of slidesOf(plan, index)) {
    const t = tasks.find((x) => x.post === p.index && !!x.output);
    if (t) slides.push({ post: p, task: t });
    else missing.push(p);
  }
  return { slides, missing };
}

export interface PublishDialogProps {
  open: boolean;
  batchId: string;
  clientId: string | null;
  /** The post the designer clicked; a carousel's slides go out together whichever slide it was. */
  index: number;
  plan: Post[];
  tasks: Task[];
  overlay: OverlaySpec;
  logoSrc: string | null;
  outputUrl: (t: Task) => string;
  /** The month's publications, so the dialog shows what already stands for this post. */
  publications: Publication[];
  onClose: () => void;
  /** The publications changed on the server: the month reads them again. */
  onChanged: () => void | Promise<void>;
}

export default function PublishDialog({ open, batchId, clientId, index, plan, tasks, overlay, logoSrc, outputUrl, publications, onClose, onChanged }: PublishDialogProps) {
  const status = usePublishStatus(open, clientId);
  const { slides, missing } = useMemo(() => slidesWithPictures(plan, tasks, index), [plan, tasks, index]);
  const lead = slides[0]?.post ?? plan.find((p) => p.index === index) ?? null;
  const existing = publicationFor(publications, plan, index);
  const [account, setAccount] = useState("");
  const [mode, setMode] = useState<"now" | "later">("later");
  const [at, setAt] = useState("");
  const [artwork, setArtwork] = useState<string[] | null>(null);
  const [drawError, setDrawError] = useState("");
  const [busy, setBusy] = useState<"publish" | "cancel" | "retry" | null>(null);

  useEffect(() => {
    if (status?.chosen) setAccount((a) => a || status.chosen || status.accounts[0]?.igId || "");
  }, [status]);
  // The default time follows the post, not the plan's refresh ticks (the designer's edits stay).
  const leadIndex = lead?.index;
  const leadDate = lead?.date;
  useEffect(() => {
    if (!open || leadIndex === undefined) return;
    setAt(toLocalInputValue(defaultPublishAt(leadDate)));
    setMode("later");
  }, [open, leadIndex, leadDate]);
  // The artwork is drawn when the dialog opens: every slide at 1080 px, as a JPEG.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setArtwork(null);
    setDrawError("");
    Promise.all(slides.map((s) => composeArtwork(outputUrl(s.task), overlay, s.post, s.task, logoSrc)))
      .then((a) => !cancelled && setArtwork(a))
      .catch((e: Error) => !cancelled && setDrawError(e.message || "The artwork could not be drawn."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, batchId]);

  const caption = lead ? buildCaption(lead.caption, lead.hashtags) : "";
  const when = mode === "now" ? null : new Date(at);
  const whenPast = !!when && Number.isFinite(when.getTime()) && when.getTime() <= Date.now();
  const canSend = !!status?.connected && !!account && !!artwork && artwork.length === slides.length && !missing.length && !!lead && caption.length <= CAPTION_MAX && (mode === "now" || (!!when && Number.isFinite(when.getTime())));

  async function send() {
    if (!canSend || !artwork) return;
    setBusy("publish");
    try {
      const p = await requestPublish({ batch: batchId, index, igAccount: account, when: mode === "now" || whenPast ? "now" : when!.toISOString(), artwork });
      if (p.status === "published") toast.success(`Post ${String(p.post).padStart(2, "0")} is on Instagram.`);
      else if (p.status === "queued") toast.success(`Post ${String(p.post).padStart(2, "0")} is scheduled for ${formatPublishTime(p.scheduledAt)}.`);
      else toast.error(p.error || "Instagram did not take the post.");
      await onChanged();
      if (p.status !== "failed") onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function cancel() {
    if (!existing) return;
    setBusy("cancel");
    try {
      await cancelPublication(existing.id);
      toast.success("The scheduled post was cancelled.");
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function retry() {
    if (!existing) return;
    setBusy("retry");
    try {
      const p = await retryPublication(existing.id);
      if (p.status === "published") toast.success("The post is on Instagram.");
      else toast.error(p.error || "Instagram did not take the post.");
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const label = lead ? `Post ${String(lead.index).padStart(2, "0")}${slides.length > 1 ? ` · carousel of ${slidesOf(plan, index).length}` : ""}` : "Post";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="animate-dialog publish-dialog">
        <DialogHeader>
          <DialogTitle>
            <Send size={18} /> Publish to Instagram · {label}
          </DialogTitle>
          <DialogDescription>The artwork goes out exactly as the card shows it: the picture with its words and the logo, as a JPEG. The caption and the hashtags go with it.</DialogDescription>
        </DialogHeader>
        <div className="overlay-editor-body publish-body">
          <div className="publish-preview">
            {drawError ? (
              <p className="publish-not-connected">
                <TriangleAlert size={14} /> {drawError}
              </p>
            ) : artwork ? (
              artwork.map((src, i) => <img key={i} src={src} alt={`Slide ${i + 1}`} />)
            ) : slides.length ? (
              <span className="publish-drawing">
                <Orb size={18} status={null} /> Drawing the artwork…
              </span>
            ) : null}
            {missing.map((p) => (
              <p key={p.index} className="publish-not-connected">
                <TriangleAlert size={14} /> Slide {p.group?.slide ?? p.index} (post {String(p.index).padStart(2, "0")}) has no picture yet.
              </p>
            ))}
          </div>
          <div className="overlay-editor-controls publish-controls">
            {existing && isLive(existing) ? (
              <div className={`publish-state ${existing.status}`}>
                <PublishPill publication={existing} />
                {existing.status === "queued" && (
                  <>
                    <small className="field-hint">Scheduled for {formatPublishTime(existing.scheduledAt)}. The studio publishes it by itself at that minute.</small>
                    <button type="button" className="secondary" onClick={() => void cancel()} disabled={busy !== null}>
                      {busy === "cancel" ? <Orb size={14} /> : <X size={14} />} Cancel the schedule
                    </button>
                  </>
                )}
                {existing.status === "publishing" && <small className="field-hint">Instagram is taking the picture now; this takes a few seconds.</small>}
                {existing.status === "published" && (
                  <small className="field-hint">
                    Published {existing.publishedAt ? formatPublishTime(existing.publishedAt) : ""}.{" "}
                    {existing.permalink ? (
                      <a className="text-link" href={existing.permalink} target="_blank" rel="noreferrer">
                        Open on Instagram
                      </a>
                    ) : (
                      "The link will show once Instagram gives it."
                    )}
                  </small>
                )}
              </div>
            ) : (
              <>
                {existing?.status === "failed" && (
                  <div className="publish-state failed">
                    <p className="publish-not-connected">
                      <TriangleAlert size={14} /> {existing.error || "Instagram did not take the post."}
                    </p>
                    <button type="button" className="secondary" onClick={() => void retry()} disabled={busy !== null || !status?.connected}>
                      {busy === "retry" ? <Orb size={14} /> : <Send size={14} />} Retry with the same artwork
                    </button>
                    <small className="field-hint">Or publish again below with the artwork as it is now.</small>
                  </div>
                )}
                <AccountPicker status={status} value={account} onChange={setAccount} />
                <label className="field-label">When</label>
                <div className="preset-row">
                  <button type="button" className={`format-chip ${mode === "now" ? "active" : ""}`} onClick={() => setMode("now")}>
                    Now
                  </button>
                  <button type="button" className={`format-chip ${mode === "later" ? "active" : ""}`} onClick={() => setMode("later")}>
                    {lead?.date ? "On its date at 10:00" : "At a time"}
                  </button>
                </div>
                {mode === "later" && (
                  <>
                    <input type="datetime-local" aria-label="When to publish" value={at} onChange={(e) => setAt(e.target.value)} />
                    {whenPast && <small className="field-hint field-warn">That time has passed: the post goes out right away.</small>}
                  </>
                )}
                {lead?.format === "9:16" && <small className="field-hint field-warn">Instagram's feed takes pictures between 4:5 and 1.91:1; a 9:16 story format is refused.</small>}
                <label className="field-label">Caption as it goes</label>
                <pre className="publish-caption" dir="auto">
                  {caption || "(no caption)"}
                </pre>
                <small className={`field-hint ${caption.length > CAPTION_MAX ? "field-warn" : ""}`}>
                  {caption.length.toLocaleString()} / {CAPTION_MAX.toLocaleString()} characters
                </small>
                <div className="footer-actions">
                  <button type="button" className="primary" onClick={() => void send()} disabled={!canSend || busy !== null}>
                    {busy === "publish" ? <Orb size={14} /> : mode === "now" || whenPast ? <Send size={14} /> : <CalendarClock size={14} />}
                    {mode === "now" || whenPast ? "Publish" : "Schedule"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────── The month: every approved post on its date ───────────── */

interface Candidate {
  lead: Post;
  slides: { post: Post; task: Task }[];
  missing: Post[];
  at: Date;
}

export function ScheduleApprovedDialog({
  open,
  batchId,
  clientId,
  plan,
  tasks,
  approvals,
  overlay,
  logoSrc,
  outputUrl,
  onClose,
  onChanged,
}: {
  open: boolean;
  batchId: string;
  clientId: string | null;
  plan: Post[];
  tasks: Task[];
  approvals: Record<string, Approval>;
  overlay: OverlaySpec;
  logoSrc: string | null;
  outputUrl: (t: Task) => string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const status = usePublishStatus(open, clientId);
  const { list, refresh } = usePublications(open ? batchId : null);
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ index: number; text: string; ok: boolean }[]>([]);
  useEffect(() => {
    if (status?.chosen) setAccount((a) => a || status.chosen || status.accounts[0]?.igId || "");
  }, [status]);

  // Approved posts not yet queued or published, a carousel once (its first slide stands for it).
  const candidates = useMemo(() => {
    const seen = new Set<number>();
    const out: Candidate[] = [];
    for (const p of plan) {
      if (approvals[String(p.index)]?.status !== "approved") continue;
      const { slides, missing } = slidesWithPictures(plan, tasks, p.index);
      const lead = slides[0]?.post ?? slidesOf(plan, p.index)[0] ?? p;
      if (seen.has(lead.index)) continue;
      seen.add(lead.index);
      if (isLive(publicationFor(list, plan, lead.index))) continue;
      out.push({ lead, slides, missing, at: defaultPublishAt(lead.date) });
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [plan, tasks, approvals, list]);
  const ready = candidates.filter((c) => !c.missing.length && c.slides.length);
  const alreadyLive = plan.filter((p) => approvals[String(p.index)]?.status === "approved" && isLive(publicationFor(list, plan, p.index))).length;

  async function scheduleAll() {
    if (!account || !ready.length) return;
    setBusy(true);
    setDone([]);
    for (const c of ready) {
      try {
        const artwork: string[] = [];
        for (const s of c.slides) artwork.push(await composeArtwork(outputUrl(s.task), overlay, s.post, s.task, logoSrc));
        const p = await requestPublish({ batch: batchId, index: c.lead.index, igAccount: account, when: c.at.getTime() <= Date.now() ? "now" : c.at.toISOString(), artwork });
        setDone((d) => [...d, { index: c.lead.index, ok: p.status !== "failed", text: p.status === "failed" ? p.error || "Instagram did not take it." : publishLabel(p) }]);
      } catch (e) {
        setDone((d) => [...d, { index: c.lead.index, ok: false, text: (e as Error).message }]);
      }
    }
    setBusy(false);
    await refresh();
    await onChanged();
  }

  const row = (c: Candidate): ReactNode => (
    <li key={c.lead.index}>
      <strong>Post {String(c.lead.index).padStart(2, "0")}</strong>
      <span dir="auto">{c.lead.title}</span>
      {c.slides.length > 1 && <span className="publish-pill">carousel of {c.slides.length + c.missing.length}</span>}
      {c.missing.length ? <span className="publish-pill failed">no picture yet</span> : <span className="publish-pill queued">{formatPublishTime(c.at.getTime())}</span>}
    </li>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="animate-dialog publish-dialog">
        <DialogHeader>
          <DialogTitle>
            <CalendarClock size={18} /> Schedule the approved posts
          </DialogTitle>
          <DialogDescription>Every post the client approved that is not already scheduled or published is queued on its own date at 10:00. The studio publishes each one when its minute comes.</DialogDescription>
        </DialogHeader>
        <div className="publish-controls">
          <AccountPicker status={status} value={account} onChange={setAccount} />
          {done.length ? (
            <ul className="publish-list">
              {done.map((d) => (
                <li key={d.index} className={d.ok ? "" : "failed"}>
                  {d.ok ? <Check size={14} /> : <TriangleAlert size={14} />}
                  <strong>Post {String(d.index).padStart(2, "0")}</strong>
                  <span>{d.text}</span>
                </li>
              ))}
            </ul>
          ) : candidates.length ? (
            <ul className="publish-list">{candidates.map(row)}</ul>
          ) : (
            <p className="field-hint">
              {alreadyLive ? `All ${alreadyLive} approved posts are already scheduled or published.` : "No post is approved by the client yet. Approvals come from the client link (Client tab)."}
            </p>
          )}
          {!done.length && alreadyLive > 0 && candidates.length > 0 && <small className="field-hint">{alreadyLive} approved posts are already scheduled or published and stay as they are.</small>}
          <div className="footer-actions">
            {done.length ? (
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => void scheduleAll()} disabled={busy || !status?.connected || !account || !ready.length}>
                {busy ? <Orb size={14} /> : <CalendarClock size={14} />} Schedule {ready.length} {ready.length === 1 ? "post" : "posts"}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────── Connection → Instagram: is publishing ready ───────────── */

export function PublishReadiness() {
  const status = usePublishStatus(true, null);
  if (!status) return null;
  return status.connected ? (
    <p className="publish-readiness ready">
      <Check size={15} /> Publishing: ready. Posts go to {status.accounts.map((a) => `@${a.username}`).join(", ")}.
    </p>
  ) : (
    <p className="publish-readiness">
      <TriangleAlert size={15} /> Publishing: {status.reason}
    </p>
  );
}
