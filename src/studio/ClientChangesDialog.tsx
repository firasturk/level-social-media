/**
 * "Do client comments", step by step: the art director's proposal for each post the client asked to
 * change is shown first (the client's words, then what changes: the product, the headline, the
 * caption, the shot), and nothing is saved until the team presses Apply. Applying writes exactly what
 * is shown; no picture is made until the team asks for it. The comments stay on the cards, marked done.
 */
import { useState } from "react";
import { ArrowRight, Check, MessageSquareReply } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Orb } from "@/components/Orb";
import type { ClientChange } from "@shared/client-changes";
import type { Approval } from "@shared/config";
import type { ClientComment, Post } from "@shared/posts";
import "./client-changes.css";

export interface ClientChangePreview {
  index: number;
  title: string;
  comments: { note: string; by?: string; at: number }[];
  before: { product: string; headline: string; caption: string; hashtags: string; brief: string };
  change: ClientChange;
}

function Diff({ label, before, after }: { label: string; before: string; after: string }) {
  if (!after || before.trim() === after.trim()) return null;
  return (
    <div className="ccd-diff">
      <span className="ccd-label">{label}</span>
      <span className="ccd-before" dir="auto">
        {before || "(none)"}
      </span>
      <ArrowRight size={12} className="ccd-arrow" />
      <span className="ccd-after" dir="auto">
        {after}
      </span>
    </div>
  );
}

export default function ClientChangesDialog({ items, applying, onApply, onClose }: { items: ClientChangePreview[]; applying: boolean; onApply: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && !applying && onClose()}>
      <DialogContent className="ccd">
        <DialogHeader>
          <DialogTitle>
            <MessageSquareReply size={16} /> What the client's comments will change
          </DialogTitle>
          <DialogDescription>
            Nothing is saved yet. Apply writes these changes into {items.length === 1 ? "the post" : `the ${items.length} posts`}; no picture is made until you ask. The client's comments stay on the cards, marked done, and the approval link asks the client again.
          </DialogDescription>
        </DialogHeader>
        <div className="ccd-list">
          {items.map((it) => (
            <article key={it.index} className="ccd-post">
              <b className="ccd-title" dir="auto">
                {String(it.index).padStart(2, "0")} · {it.title}
              </b>
              <ul className="ccd-comments">
                {it.comments.map((c, i) => (
                  <li key={i} dir="auto">
                    <q>{c.note}</q>
                    {c.by ? <small> · {c.by}</small> : null}
                  </li>
                ))}
              </ul>
              {it.change.summary && (
                <p className="ccd-summary">
                  <Check size={13} /> {it.change.summary}
                </p>
              )}
              <Diff label="Product" before={it.before.product} after={it.change.product} />
              <Diff label="Headline" before={it.before.headline} after={it.change.headline} />
              <Diff label="Caption" before={it.before.caption} after={it.change.caption} />
              <Diff label="Hashtags" before={it.before.hashtags} after={it.change.hashtags} />
              {it.change.brief.trim() !== it.before.brief.trim() && (
                <details className="ccd-brief">
                  <summary>The new shot for the picture</summary>
                  <p>{it.change.brief}</p>
                  {it.change.scene && <p className="ccd-scene">{it.change.scene}</p>}
                </details>
              )}
            </article>
          ))}
        </div>
        <div className="ccd-actions">
          <button type="button" className="cta secondary" onClick={onClose} disabled={applying}>
            Not now
          </button>
          <button type="button" className="cta primary" onClick={onApply} disabled={applying}>
            {applying ? <Orb size={13} /> : <Check size={14} />} Apply the changes
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the client wrote that a card keeps in sight: the open request, or the last round the studio did. */
export function cardComments(p: Pick<Post, "clientNotes" | "clientNote">, approval: Approval | undefined): { done: boolean; items: { note: string; by?: string; summary?: string; at: number }[]; earlier: ClientComment[] } | null {
  if (approval?.status === "changes") {
    const asks = (approval.answers ?? []).filter((x) => x.status === "changes" && x.note?.trim());
    const items = asks.length ? asks.map((x) => ({ note: x.note!.trim(), by: x.by?.trim() || undefined, at: x.at })) : approval.note?.trim() ? [{ note: approval.note.trim(), by: approval.by, at: approval.at }] : [];
    return items.length ? { done: false, items, earlier: doneCommentsOf(p) } : null;
  }
  if (approval) return null;
  const notes = doneCommentsOf(p);
  if (!notes.length) return null;
  const last = Math.max(...notes.map((n) => n.done));
  return { done: true, items: notes.filter((n) => n.done === last), earlier: notes.filter((n) => n.done !== last) };
}

/**
 * At the top of a card, under its title: every comment the client wrote, whole, with who wrote it:
 * orange while it waits, green once "Do client comments" did it. It stays while the team works on
 * the post (25 Oct); a click folds or unfolds long comments.
 */
export function CardComments({ comments }: { comments: NonNullable<ReturnType<typeof cardComments>> }) {
  const [open, setOpen] = useState(false);
  const when = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const history = comments.earlier.map((n) => `“${n.note}”${n.by ? ` · ${n.by}` : ""} · done ${when(n.done)}`).join("\n");
  return (
    <button type="button" className={`pc-comments ${comments.done ? "done" : "open"} ${open ? "unfolded" : ""}`} onClick={() => setOpen((o) => !o)} title={open ? "Fold" : "Show the whole comment"}>
      <span className="pc-comments-head">
        {comments.done ? <Check size={12} /> : <MessageSquareReply size={12} />} {comments.done ? "Client comments · done" : "What the client wrote"}
        {comments.earlier.length ? <small title={history}> · {comments.earlier.length} earlier</small> : null}
      </span>
      {comments.items.map((n, i) => (
        <span key={i} className="pc-comment" dir="auto" title={n.summary ? `Done: ${n.summary}` : undefined}>
          {n.by ? <b>{n.by}: </b> : null}
          {n.note}
        </span>
      ))}
    </button>
  );
}

/** The post's applied comments; a post done before 25 Oct kept only its last one, in `clientNote`. */
export function doneCommentsOf(p: Pick<Post, "clientNotes" | "clientNote">): ClientComment[] {
  if (p.clientNotes?.length) return p.clientNotes;
  return p.clientNote ? [{ note: p.clientNote.note, at: p.clientNote.at, done: p.clientNote.at, summary: p.clientNote.summary }] : [];
}
