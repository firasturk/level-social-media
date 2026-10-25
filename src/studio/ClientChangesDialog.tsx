/**
 * "Do client comments", step by step: the art director's proposal for each post the client asked to
 * change is shown first (the client's words, then what changes: the product, the headline, the
 * caption, the shot), and nothing is saved until the team presses Apply. Applying writes exactly what
 * is shown; no picture is made until the team asks for it. The comments stay on the cards, marked done.
 */
import { ArrowRight, Check, MessageSquareReply } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Orb } from "@/components/Orb";
import type { ClientChange } from "@shared/client-changes";
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

/**
 * On a card: the client's comments of the last round the studio applied, marked done, with every
 * earlier comment in the tooltip. Shown once the client has no open answer on the post.
 */
export function DoneComments({ notes }: { notes: ClientComment[] }) {
  const last = Math.max(...notes.map((n) => n.done));
  const round = notes.filter((n) => n.done === last);
  const when = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const all = notes.map((n) => `“${n.note}”${n.by ? ` · ${n.by}` : ""} · done ${when(n.done)}${n.summary ? `: ${n.summary}` : ""}`).join("\n");
  return (
    <small className="pc-meta client-done" dir="auto" title={all}>
      <Check size={11} /> Done · {round.map((n) => `“${n.note}”${n.by ? ` · ${n.by}` : ""}`).join(" · ")}
      {notes.length > round.length ? ` (+${notes.length - round.length} earlier)` : ""}
    </small>
  );
}

/** The post's applied comments; a post done before 25 Oct kept only its last one, in `clientNote`. */
export function doneCommentsOf(p: Pick<Post, "clientNotes" | "clientNote">): ClientComment[] {
  if (p.clientNotes?.length) return p.clientNotes;
  return p.clientNote ? [{ note: p.clientNote.note, at: p.clientNote.at, done: p.clientNote.at, summary: p.clientNote.summary }] : [];
}
