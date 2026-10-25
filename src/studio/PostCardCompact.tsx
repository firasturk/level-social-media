/**
 * The Studio's post card in the four-stage workflow: the picture, the post's number, type and
 * day, a short title and a clear status, one Edit action and a quiet menu for the rest. Every
 * field and tool lives in the editor's four groups; nothing was taken away, only folded.
 */
import { isMediaPost } from "@shared/posts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Aperture, Check, Clapperboard, Ellipsis, GalleryHorizontalEnd, Image as ImageIcon, Pencil, Rows3, Sparkles, TriangleAlert, Type, Wand2 } from "lucide-react";
import "./text/text-studio.css";
import { Orb } from "@/components/Orb";
import { POST_TYPE_INFO, type Post } from "@shared/posts";
import type { Task } from "@shared/types";
import type { Approval } from "@shared/config";
import { CardComments, cardComments } from "./ClientChangesDialog";

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
  onPhotoStudio,
  onTextStudio,
  onEditVideo,
  onFixReview,
  onAccept,
  fixing,
  accepting,
  disabled,
  menu,
  primary,
  extra,
  select,
}: {
  post: Post;
  task: Task | null;
  /** The picture area (the overlay preview, the picture or the placeholder, with its progress and chips). */
  media: ReactNode;
  inFlight: boolean;
  state: { cls: string; icon: ReactNode; text: string } | null;
  flags: { text: string }[];
  approval?: Approval;
  styleTitle?: string | null;
  dayTitle?: string;
  onEdit: (group?: EditorGroup) => void;
  /** Opens the Photo studio on this post's picture: "Edit picture" and the aperture icon above the picture. Only when the post has a picture. */
  onPhotoStudio?: () => void;
  /** Opens the Text studio on this post's words and layers: the icon above the picture. No picture is made. */
  onTextStudio?: () => void;
  /** Opens the Video editor on the post's selected video version: the icon under the T. Only when a finished clip exists. */
  onEditVideo?: () => void;
  onFixReview?: () => void;
  onAccept?: () => void;
  fixing: boolean;
  accepting: boolean;
  disabled: boolean;
  /** The secondary actions, in the overflow menu. */
  menu: MenuItem[];
  /**
   * The card's one primary action when it is not the editor: making the post's first picture, or
   * making it again after a failure or for a newer idea. Its title says the scope and the cost.
   */
  primary?: { label: string; title: string; onClick: () => void; disabled?: boolean; busy?: boolean };
  /** Anything the card still shows under its title (an unsaved-changes row, a client's note). */
  extra?: ReactNode;
  /** While cards are being chosen for one step (a style, the Text studio, one video): the tick and its place in the order. */
  select?: { on: boolean; n: number; onToggle: () => void };
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
          {select && (
            <button
              type="button"
              className={`pc-select ${select.on ? "on" : ""}`}
              role="checkbox"
              aria-checked={select.on}
              aria-label={`Choose post ${post.index}`}
              title={select.on ? `Chosen (${select.n}): click to leave it out` : "Choose this card"}
              onClick={(e) => {
                e.stopPropagation();
                select.onToggle();
              }}
            >
              {select.on ? <span className="pc-select-n">{select.n}</span> : null}
            </button>
          )}
          <span className="post-num">{String(post.index).padStart(2, "0")}</span>
          {/* A picture or clip brought in as it is has no post type of its own: no type tag on it. */}
          {!isMediaPost(post) && <span className="post-type-pill">{POST_TYPE_INFO[post.type]?.label ?? post.type}</span>}
          {post.group ? (
            <span className={`post-group ${post.group.kind}`} title={post.group.kind === "carousel" ? `Carousel: slide ${post.group.slide} of ${post.group.of}, posted together` : `Series: part ${post.group.slide} of ${post.group.of}`}>
              {post.group.kind === "carousel" ? <GalleryHorizontalEnd size={12} aria-hidden /> : <Rows3 size={12} aria-hidden />} {post.group.kind === "carousel" ? "Carousel" : "Series"} {post.group.slide}/{post.group.of}
            </span>
          ) : (
            post.media?.kind !== "video" && (
              <span className="post-group single" title="A single post: one picture">
                <ImageIcon size={12} aria-hidden /> Post
              </span>
            )
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
          {task?.output && !inFlight && (onTextStudio || onEditVideo || onPhotoStudio) && (
            <span className="pc-head-tools">
              {onPhotoStudio && (
                <button
                  type="button"
                  className="pc-text-studio pc-photo-studio"
                  title="Photo studio: the picture large, with every picture tool"
                  aria-label="Photo studio"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPhotoStudio();
                  }}
                >
                  <Aperture size={13} />
                </button>
              )}
              {onTextStudio && (
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
              {onEditVideo && (
                <button
                  type="button"
                  className="pc-text-studio pc-edit-video"
                  title="Video studio: presets with their reference videos, a clip from this picture, edits and versions"
                  aria-label="Video studio"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditVideo();
                  }}
                >
                  <Clapperboard size={13} />
                </button>
              )}
            </span>
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
            <span className={`pc-approval ${approval.status}`} title={`The client's answer on the approval page${approval.by ? `, by ${approval.by}` : ""}${approval.note ? `: ${approval.note}` : ""}. Separate from the team's own acceptance of the picture.`}>
              {approval.status === "approved" ? (approval.by ? `Client approved · ${approval.by}` : "Client approved") : approval.by ? `Client asks a change · ${approval.by}` : "Client asks a change"}
              {(approval.answers?.length ?? 0) > 1 ? ` · ${approval.answers!.length} answers` : ""}
            </span>
          )}
        </div>
        {(() => {
          const c = cardComments(post, approval);
          return c ? <CardComments comments={c} steps={c.done ? post.clientSteps?.steps : undefined} /> : null;
        })()}
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
          {primary ? (
            <>
              <button type="button" className="cta primary small" onClick={primary.onClick} disabled={inFlight || primary.disabled || primary.busy} title={primary.title}>
                {primary.busy ? <Orb size={13} /> : <Sparkles size={14} />} {primary.label}
              </button>
              <button type="button" className="cta secondary small" onClick={() => (task?.output && onPhotoStudio ? onPhotoStudio() : onEdit(task?.output ? "image" : "idea"))} disabled={inFlight} title={task?.output ? "Open the Photo studio: the picture large, with the AI edit, free adjustments, the Photo lab, versions and checks" : "Open the editor on the idea and the shot; no picture is made"}>
                {task?.output ? <Aperture size={14} /> : <Pencil size={14} />} {task?.output ? "Edit picture" : "Edit the idea"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="cta primary small" onClick={() => (task?.output && onPhotoStudio ? onPhotoStudio() : onEdit(task?.output ? "image" : "idea"))} disabled={inFlight} title={task?.output ? "Open the Photo studio: the picture large, with the AI edit, free adjustments, the Photo lab, versions and checks" : "Open the editor on the idea and the shot; no picture is made"}>
                {task?.output ? <Aperture size={14} /> : <Pencil size={14} />} {task?.output ? "Edit picture" : "Edit the idea"}
              </button>
              <button type="button" className="cta secondary small" onClick={() => onEdit("words")} disabled={inFlight} title="Headline and caption, and how the words sit on the picture (the T button opens the Text studio); no picture is made">
                Words &amp; caption
              </button>
            </>
          )}
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
