/**
 * The Studio's post card in the four-stage workflow: the picture, the post's number, type and
 * day, a short title and a clear status, one Edit action and a quiet menu for the rest. Every
 * field and tool lives in the editor's four groups; nothing was taken away, only folded.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Ellipsis, Pencil, TriangleAlert, Type, Wand2 } from "lucide-react";
import "./text/text-studio.css";
import { Orb } from "@/components/Orb";
import { POST_TYPE_INFO, type Post } from "@shared/posts";
import type { Task } from "@shared/types";

export type EditorGroup = "idea" | "image" | "words" | "versions";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}

export default function PostCardCompact({
  post,
  task,
  media,
  inFlight,
  state,
  flags,
  approval,
  styleTitle,
  dayTitle,
  onEdit,
  onTextStudio,
  onFixReview,
  onAccept,
  fixing,
  accepting,
  disabled,
  menu,
  extra,
}: {
  post: Post;
  task: Task | null;
  /** The picture area (the overlay preview, the picture or the placeholder, with its progress and chips). */
  media: ReactNode;
  inFlight: boolean;
  state: { cls: string; icon: ReactNode; text: string } | null;
  flags: { text: string }[];
  approval?: { status: "approved" | "changes"; note?: string; by?: string };
  styleTitle?: string | null;
  dayTitle?: string;
  onEdit: (group?: EditorGroup) => void;
  /** Opens the Text studio on this post's words and layers: the icon above the picture. No picture is made. */
  onTextStudio?: () => void;
  onFixReview?: () => void;
  onAccept?: () => void;
  fixing: boolean;
  accepting: boolean;
  disabled: boolean;
  /** The secondary actions, in the overflow menu. */
  menu: MenuItem[];
  /** Anything the card still shows under its title (an unsaved-changes row, a client's note). */
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const needsReview = !!task?.output && !inFlight && flags.length > 0;
  return (
    <>
      <div className="post-media pc-media" onClick={() => onEdit(task?.output ? "image" : "idea")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onEdit(task?.output ? "image" : "idea")}>
        <header className="post-head">
          <span className="post-num">{String(post.index).padStart(2, "0")}</span>
          <span className="post-type-pill">{POST_TYPE_INFO[post.type]?.label ?? post.type}</span>
          {post.group && (
            <span className={`post-group ${post.group.kind}`}>
              {post.group.kind === "carousel" ? "Carousel" : "Series"} {post.group.slide}/{post.group.of}
            </span>
          )}
          {post.date && (
            <span className="post-day" title={dayTitle || "Posting day"}>
              {post.date.slice(5).replace("-", "/")}
            </span>
          )}
          {needsReview ? (
            <span className="post-state warn">
              <TriangleAlert size={12} /> Needs review
            </span>
          ) : (
            state && (
              <span className={`post-state ${state.cls}`}>
                {state.icon} {state.text}
              </span>
            )
          )}
          {onTextStudio && task?.output && !inFlight && (
            <button
              type="button"
              className="pc-text-studio"
              title="Text studio: the words and layers on this picture"
              aria-label="Text studio"
              onClick={(e) => {
                e.stopPropagation();
                onTextStudio();
              }}
            >
              <Type size={13} />
            </button>
          )}
        </header>
        {media}
      </div>
      <div className="pc-body">
        <div className="pc-title-row">
          <b className="pc-title" dir="auto" title={post.title}>
            {post.title || POST_TYPE_INFO[post.type]?.label}
          </b>
          {approval && (
            <span className={`pc-approval ${approval.status}`} title={[approval.by, approval.note].filter(Boolean).join(": ")}>
              {approval.status === "approved" ? (approval.by ? `Approved by ${approval.by}` : "Client approved") : approval.by ? `${approval.by} asks a change` : "Client asks a change"}
            </span>
          )}
        </div>
        {(styleTitle || post.product) && (
          <small className="pc-meta">
            {post.product ? post.product : ""}
            {post.product && styleTitle ? " · " : ""}
            {styleTitle ? `Style: ${styleTitle}` : ""}
          </small>
        )}
        {needsReview && (
          <div className="pc-review">
            <span className="pc-review-text">
              <TriangleAlert size={13} /> {flags.length === 1 ? flags[0].text : `${flags.length} things to check`}
            </span>
            <span className="pc-review-actions">
              {onFixReview && (
                <button type="button" className="text-button" disabled={disabled || fixing} onClick={onFixReview} title="Edit this picture: the current photo is changed to take out what the review found">
                  {fixing ? <Orb size={12} /> : <Wand2 size={12} />} Edit this picture
                </button>
              )}
              {onAccept && (
                <button type="button" className="text-button" disabled={disabled || accepting} onClick={onAccept} title="Keep the picture as it is: the review's notes are cleared">
                  {accepting ? <Orb size={12} /> : <Check size={12} />} Accept
                </button>
              )}
            </span>
          </div>
        )}
        {extra}
        <div className="pc-actions">
          <button type="button" className="cta primary small" onClick={() => onEdit(task?.output ? "image" : "idea")} disabled={inFlight} title={task?.output ? "The picture: retake, fix, compare" : "The idea and the shot"}>
            <Pencil size={14} /> {task?.output ? "Edit picture" : "Edit the idea"}
          </button>
          <button type="button" className="cta secondary small" onClick={() => onEdit("words")} disabled={inFlight} title="Headline, caption and the layout of the words on the picture">
            Words &amp; layout
          </button>
          <div className="card-menu" ref={box}>
            <button type="button" className="cta secondary small icon" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Ellipsis size={16} />
            </button>
            {open && (
              <ul className="card-menu-list" role="menu">
                {menu.map((m) => (
                  <li key={m.label} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className={m.danger ? "danger" : ""}
                      disabled={m.disabled}
                      title={m.title}
                      onClick={() => {
                        setOpen(false);
                        m.onClick();
                      }}
                    >
                      {m.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
