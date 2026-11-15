/**
 * Tools on one post's card: a reference the designer attaches for the next take or revision of
 * the picture, and the team's comments on the post.
 */
import { useState } from "react";
import { toast } from "sonner";
import { MessageSquare, Send } from "lucide-react";
import { Orb } from "@/components/Orb";

export interface PostComment {
  id: string;
  post: number;
  user: string;
  name: string;
  text: string;
  created: number;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString("en-GB");
}

export const referenceThumb = (batchId: string, index: number, at: number) =>
  `/api/studio/posts/reference/image?batch=${encodeURIComponent(batchId)}&index=${index}&v=${at}`;

/** The team's comments on one post. */
export function PostComments({
  index,
  comments,
  userId,
  isAdmin,
  onAdd,
  onDelete,
}: {
  index: number;
  comments: PostComment[];
  userId: string;
  isAdmin: boolean;
  onAdd: (index: number, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onAdd(index, t);
      setText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the comment.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`post-comments ${open ? "open" : ""}`}>
      <button type="button" className="post-comments-toggle" onClick={() => setOpen((o) => !o)}>
        <MessageSquare size={13} /> {comments.length ? `${comments.length} comment${comments.length > 1 ? "s" : ""}` : "Comment"}
      </button>
      {open && (
        <div className="post-comments-body">
          {comments.length > 0 && (
            <ul className="post-comment-list">
              {comments.map((c) => (
                <li key={c.id}>
                  <span className="post-comment-meta">
                    <b>{c.name}</b> · {ago(c.created)}
                  </span>
                  <span className="post-comment-text">{c.text}</span>
                  {(c.user === userId || isAdmin) && (
                    <button type="button" className="post-comment-delete" aria-label="Delete the comment" onClick={() => void onDelete(c.id)}>
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="post-comment-write">
            <textarea
              value={text}
              rows={2}
              placeholder="Write a comment for the team…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="Add the comment">
              {busy ? <Orb size={13} /> : <Send size={13} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
