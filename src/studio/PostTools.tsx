/**
 * Tools on one post's card: a reference the designer attaches for the next take or revision of
 * the picture, and the team's comments on the post.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus, MessageSquare, RefreshCw, Send, Wand2, X } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { del, postForm } from "@/api";
import { rasterize } from "@/lib/image";
import { FRESH_TAKE, type PostReference } from "@shared/posts";
import SourceBadge from "./SourceBadge";

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

/**
 * A reference for the picture: the designer attaches a picture and says what to take from it.
 * "Update the picture" revises the current result with it; "New take" makes the post again with it.
 */
export function PostReferenceBox({
  batchId,
  index,
  reference,
  hasPicture,
  disabled,
  onMake,
  onChanged,
}: {
  batchId: string;
  index: number;
  reference?: PostReference;
  hasPicture: boolean;
  disabled: boolean;
  /** Makes the post with the note (a revision of the current picture, or a fresh take). */
  onMake: (index: number, note: string) => Promise<void>;
  /** The month changed (a reference was attached or taken off). */
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState(reference?.note ?? "");
  const [busy, setBusy] = useState<"save" | "update" | "take" | "remove" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = file ? URL.createObjectURL(file) : reference ? referenceThumb(batchId, index, reference.at) : null;

  async function save(): Promise<boolean> {
    const form = new FormData();
    form.set("batch", batchId);
    form.set("index", String(index));
    form.set("note", note.trim());
    // The browser redraws the picture first (a logo as SVG, a phone photo, a huge PNG): the server reads a plain PNG or JPEG.
    if (file) {
      const ready = await rasterize(file);
      form.set("file", ready, ready.name);
    }
    await postForm("/api/studio/posts/reference", form);
    setFile(null);
    await onChanged();
    return true;
  }
  async function run(kind: "save" | "update" | "take") {
    if (!file && !reference) {
      toast.error("Attach a picture first.");
      return;
    }
    setBusy(kind);
    try {
      await save();
      const what = note.trim() ? `Use the attached reference: ${note.trim()}` : "Use the attached reference for this picture.";
      if (kind === "update") await onMake(index, what);
      else if (kind === "take") await onMake(index, `${FRESH_TAKE}${what}`);
      else toast.success("Reference saved on the post: its next picture takes it.");
      if (kind !== "save") setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the reference.");
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    setBusy("remove");
    try {
      await del(`/api/studio/posts/reference?batch=${encodeURIComponent(batchId)}&index=${index}`);
      setNote("");
      setFile(null);
      setOpen(false);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not take the reference off.");
    } finally {
      setBusy(null);
    }
  }

  if (!open && !reference)
    return (
      <div className="post-ref-row">
        <button type="button" className="text-button" onClick={() => setOpen(true)} disabled={disabled}>
          <ImagePlus size={13} /> Attach a reference
        </button>
      </div>
    );
  return (
    <div className={`post-ref ${reference ? "on" : ""}`}>
      <div className="post-ref-head">
        <button type="button" className="post-ref-pick" onClick={() => input.current?.click()} disabled={!!busy} title="Pick a picture">
          {preview ? <img src={preview} alt="" /> : <ImagePlus size={16} />}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            e.target.value = "";
          }}
        />
        <span className="post-ref-text">
          <strong>
            {reference ? "Reference on this post" : "Reference for the next picture"} {reference && !file && <SourceBadge source={reference.drive ? "drive" : (reference.source ?? "upload")} compact />}
          </strong>
          <small>{file ? file.name : reference?.name || "Pick a picture, then say what to take from it"}</small>
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={reference ? "Take the reference off" : "Close"}
          title={reference ? "Take the reference off" : "Close"}
          disabled={!!busy}
          onClick={() => (reference ? void remove() : (setOpen(false), setFile(null)))}
        >
          {busy === "remove" ? <Orb size={12} /> : <X size={12} />}
        </button>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What to take from it: the composition, the colours, the light, a prop, the pose… (optional)"
        rows={2}
      />
      <div className="post-ref-actions">
        {hasPicture && (
          <button type="button" className="primary" disabled={!!busy || disabled} onClick={() => void run("update")} title="Keep this picture and change it with the reference">
            {busy === "update" ? <Orb size={13} /> : <Wand2 size={13} />} Update the picture
          </button>
        )}
        <button type="button" className={hasPicture ? "secondary" : "primary"} disabled={!!busy || disabled} onClick={() => void run(hasPicture ? "take" : "save")} title={hasPicture ? "Make the post again from its brief with the reference" : "Save it on the post: its picture is made with it"}>
          {busy === "take" || busy === "save" ? <Orb size={13} /> : <RefreshCw size={13} />} {hasPicture ? "New take with it" : "Save on the post"}
        </button>
        {hasPicture && (
          <button type="button" className="text-button" disabled={!!busy} onClick={() => void run("save")}>
            Save only
          </button>
        )}
      </div>
    </div>
  );
}

/** What to change in a finished picture: the designer's words go to the engine as a revision of it. */
export function PostChangeBox({ index, disabled, onChange }: { index: number; disabled: boolean; onChange: (index: number, note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    const t = note.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onChange(index, t);
      setNote("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the picture.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="post-change">
      <span className="post-change-label">
        <Wand2 size={13} /> Change the picture
      </span>
      <div className="post-change-row">
        <textarea
          rows={2}
          value={note}
          dir="auto"
          placeholder="Write or dictate what to change…"
          disabled={disabled || busy}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <VoiceInput compact onText={(t) => setNote((n) => (n.trim() ? `${n.trim()} ${t}` : t))} disabled={disabled || busy} />
        <button type="button" className="secondary" disabled={disabled || busy || !note.trim()} onClick={() => void send()} title="Make the picture again with this change">
          {busy ? <Orb size={13} /> : <Wand2 size={13} />} Change it
        </button>
      </div>
    </div>
  );
}

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
