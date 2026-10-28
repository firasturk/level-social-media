/**
 * Internal approvals on a creative: its review state, the actions (request approval, request
 * changes with a note, approve this version, mark revisions complete) and the history of
 * decisions. Ordinary chat never changes a status; only these buttons do.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, History, Pencil, Send } from "lucide-react";
import { toast } from "sonner";
import { askConfirm, askInput } from "@/lib/confirm";
import type { RefPreview, Review, ReviewStatus } from "@shared/team";
import { Avatar } from "./Avatar";
import { fullTime } from "@shared/team-ui";
import { ReviewPill, reviewLabel } from "./MessageBody";
import { useTeam } from "./useTeam";

export function ReviewActions({ batch, post, preview, version, compact = false }: { batch: string; post: number; preview?: RefPreview | null; version?: string | null; compact?: boolean }) {
  const team = useTeam();
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [openHistory, setOpenHistory] = useState(false);
  const [busy, setBusy] = useState<ReviewStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await team.listReviews(batch);
      setReviews(all.filter((r) => r.post === post).sort((a, b) => b.at - a.at));
    } catch {
      setReviews([]);
    }
  }, [batch, post, team]);
  useEffect(() => {
    void load();
  }, [load, team.reviewsStamp]);

  const latest = reviews?.[0] ?? null;
  const status: ReviewStatus | null = latest?.status ?? preview?.review ?? null;
  const pictureKey = version ?? latest?.version ?? null;

  const act = async (next: ReviewStatus, note?: string) => {
    setBusy(next);
    try {
      await team.postReview({ batch, post, status: next, note, version: next === "approved" ? pictureKey : undefined });
      toast.success(next === "approved" ? "Approved: the picture is accepted in the Studio." : next === "changes" ? "Changes requested: a task was opened for the month's owner." : next === "review" ? "Approval requested." : "Saved.");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const requestChanges = async () => {
    const note = await askInput("What should change in this creative?", "", { ok: "Request changes", placeholder: "The note the designer will read" });
    if (note === null) return;
    await act("changes", note.trim());
  };
  const approve = async () => {
    const ok = await askConfirm(`Approve this version of “${preview?.title ?? `post ${post}`}”? The Studio accepts its picture; the client's own approval stays separate.`, { ok: "Approve this version", danger: false, cancel: "Not yet" });
    if (ok) await act("approved");
  };

  return (
    <div className={`tm-review ${compact ? "compact" : ""}`}>
      <div className="tm-review-head">
        <span className="tm-review-label">Internal approval</span>
        {status ? <ReviewPill status={status} /> : <span className="tm-pill soft">Not reviewed</span>}
      </div>
      <div className="tm-review-actions">
        {status !== "approved" && status !== "review" && (
          <button type="button" className="cta secondary small" disabled={!!busy} onClick={() => void act("review")} title="Asks the team to look at this creative">
            <Send size={13} /> {status === "changes" ? "Mark revisions complete" : "Request approval"}
          </button>
        )}
        {status !== "changes" && (
          <button type="button" className="cta secondary small" disabled={!!busy} onClick={() => void requestChanges()} title="With a note; a task is opened for the month's owner">
            <Pencil size={13} /> Request changes
          </button>
        )}
        {status !== "approved" && (
          <button type="button" className="cta primary small tm-approve" disabled={!!busy} onClick={() => void approve()} title="The Studio accepts this picture">
            {preview?.thumb ? <img src={preview.thumb} alt="" className="tm-approve-thumb" /> : <Check size={13} />}
            Approve this version
          </button>
        )}
      </div>
      <button type="button" className="tm-review-toggle" onClick={() => setOpenHistory((o) => !o)} aria-expanded={openHistory}>
        {openHistory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <History size={13} /> Versions and comments {reviews ? `(${reviews.length})` : ""}
      </button>
      {openHistory && (
        <ul className="tm-review-history">
          {reviews === null && <li className="tm-muted">Loading…</li>}
          {reviews?.length === 0 && <li className="tm-muted">No decisions yet.</li>}
          {reviews?.map((r) => (
            <li key={r.id}>
              <Avatar user={r.by} size={22} />
              <div>
                <div className="tm-review-line">
                  <b>{r.by.name}</b> <ReviewPill status={r.status} /> <time title={fullTime(r.at)}>{fullTime(r.at)}</time>
                </div>
                {r.note && <p dir="auto">{r.note}</p>}
                {r.version && <small className="tm-muted">Version {r.version.split("/").at(-1)?.slice(0, 12)}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { reviewLabel };
