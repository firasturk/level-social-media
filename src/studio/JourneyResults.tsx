import { useState } from "react";
import TypographyControls, { type TypographyProps } from "./TypographyControls";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, Download, LoaderCircle, Maximize2, RotateCcw, Share2, TriangleAlert, Wand2, X } from "lucide-react";
import type { Client } from "@shared/types";
import type { Approval } from "@shared/config";
import { fixNote, type PostFlag } from "@shared/qa";
import { FORMAT_INFO, monthLabel, POST_TYPE_INFO, type Format, type Post } from "@shared/posts";
import { shortDate } from "@shared/occasions";
import type { OverlaySpec } from "@shared/overlay";
import OverlayPreview from "./OverlayPreview";
import { KitIcon } from "./kit";

/** One post of the month as the journey's last screens see it: its idea and its image. */
export interface JourneyPost {
  index: number;
  taskId: string | null;
  /** queued | processing | finalizing | ready | review | approved | failed, or "none" before Generate. */
  status: string;
  url: string | null;
  /** The image's storage key: a caption written from another key is older than the image. */
  output: string | null;
  error: string | null;
  /** What the automatic review found (null while it has not run). */
  flags: PostFlag[] | null;
}

export const MAKING = ["queued", "processing", "finalizing"];

/** A caption is current when it was written from this very image, or when the designer wrote it. */
export function captionCurrent(p: Post, j: JourneyPost | undefined): boolean {
  return !j?.output || !!p.captionHand || p.captionFrom === j.output;
}

/** Every post on one screen: up to six across, the rows share the height. */
function gridOf(count: number) {
  const n = Math.max(1, count);
  const cols = n <= 4 ? n : n <= 8 ? Math.ceil(n / 2) : 6;
  const rows = Math.ceil(n / cols);
  return {
    rows,
    style: {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridTemplateRows: rows <= 2 ? `repeat(${rows}, minmax(0, 1fr))` : undefined,
      gridAutoRows: rows > 2 ? "minmax(300px, 1fr)" : undefined,
    },
  };
}

function Head({ kit, title, children, action }: { kit: "output" | "voice"; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="journey-head">
      <KitIcon kit={kit} size={18} />
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
      {action}
    </div>
  );
}

/** Over the whole screen: the journey's moving step would otherwise hold it inside itself. */
function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="make-lightbox" role="dialog" aria-label={title} onClick={onClose}>
      {children}
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}

function Lightbox({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  return (
    <Overlay title={title} onClose={onClose}>
      <img src={url} alt={title} />
    </Overlay>
  );
}

/* ───────────── Generate: the month's images arrive here one by one ───────────── */

export function MakeStep({
  plan,
  posts,
  format,
  onRetake,
  onFix,
}: {
  plan: Post[];
  posts: JourneyPost[];
  format: Format;
  onRetake: (index: number) => Promise<void>;
  onFix: (index: number, edit: string) => Promise<void>;
}) {
  const [acting, setActing] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const done = posts.filter((x) => x.url && !MAKING.includes(x.status)).length;
  const making = posts.filter((x) => MAKING.includes(x.status)).length;
  const grid = gridOf(plan.length);
  const act = async (index: number, run: () => Promise<void>) => {
    setActing(index);
    try {
      await run();
    } finally {
      setActing(null);
    }
  };
  const opened = open !== null ? posts.find((x) => x.index === open) : null;
  return (
    <>
      <Head kit="output" title={making ? "Your posts are being made" : "Your posts"}>
        {making
          ? `${done} of ${plan.length} ready. Each one is checked against its product photo as it arrives; you can close the page, they keep going.`
          : "Check every post. Retake the ones you do not like, or let me fix what the review found. The captions are written from these pictures next."}
      </Head>
      <div className="make-progress" aria-hidden>
        <i style={{ width: `${plan.length ? (done / plan.length) * 100 : 0}%` }} />
      </div>
      <div className={`journey-boxes idea-grid results ${grid.rows > 2 ? "scrolls" : ""}`} style={grid.style}>
        {plan.map((p, i) => {
          const j = posts.find((x) => x.index === p.index);
          const busy = !!j && MAKING.includes(j.status);
          const flags = j?.flags ?? [];
          return (
            <article key={p.index} className={`journey-box make-card ${flags.length ? "flagged" : ""}`} style={{ "--i": i } as React.CSSProperties}>
              <div className="idea-meta">
                <span className="idea-index">{String(p.index).padStart(2, "0")}</span>
                {p.date && <span className="journey-tag">{shortDate(p.date)}</span>}
                <span className="make-type">{POST_TYPE_INFO[p.type]?.label ?? p.type}</span>
                {j?.url && !busy && j.flags && (
                  <span className={`make-state ${flags.length ? "warn" : "ok"}`} title={flags.length ? flags.map((f) => f.text).join("\n") : "Passed the automatic review"}>
                    {flags.length ? <TriangleAlert size={12} /> : <Check size={12} />}
                    {flags.length ? `${flags.length} to check` : "Checked"}
                  </span>
                )}
              </div>
              <div className="make-image" style={{ aspectRatio: format.replace(":", " / ") }}>
                {j?.url && (
                  <button type="button" className="make-open" onClick={() => setOpen(p.index)} title="Open large" aria-label={`Open post ${p.index}`}>
                    <img src={j.url} alt={p.title} className={busy ? "fading" : ""} />
                    <Maximize2 size={14} className="make-zoom" />
                  </button>
                )}
                {busy ? (
                  <span className="make-wait">
                    <LoaderCircle className="spinning" size={18} />
                    {j?.status === "queued" ? "Waiting its turn" : "Making it"}
                  </span>
                ) : j?.status === "failed" ? (
                  <span className="make-wait failed">Failed: {(j.error ?? "try again").replace(/\.$/, "")}</span>
                ) : !j?.url ? (
                  <span className="make-wait">Not made yet</span>
                ) : null}
              </div>
              <strong className="idea-title" title={p.title}>
                {p.title}
              </strong>
              {flags.length > 0 && !busy && (
                <ul className="make-flags">
                  {flags.map((f, n) => (
                    <li key={n}>{f.text}</li>
                  ))}
                </ul>
              )}
              <div className="make-actions">
                {flags.length > 0 && !busy && j?.taskId && (
                  <button type="button" className="secondary" disabled={acting !== null} onClick={() => void act(p.index, () => onFix(p.index, fixNote(flags)))}>
                    {acting === p.index ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Fix
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={acting !== null || busy}
                  onClick={() => void act(p.index, () => onRetake(p.index))}
                  title="Make this post again, a new take of the same idea"
                >
                  {acting === p.index && !flags.length ? <LoaderCircle className="spinning" size={13} /> : <RotateCcw size={13} />}
                  {j?.status === "failed" || !j?.url ? "Make it" : "Retake"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {opened?.url && <Lightbox url={opened.url} title={`Post ${opened.index}`} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ───────────── Captions: written from the finished pictures ───────────── */

export function CaptionsStep({
  plan,
  posts,
  writing,
  failed,
  onWrite,
  onSave,
}: {
  plan: Post[];
  posts: JourneyPost[];
  /** The posts whose captions are being written now. */
  writing: number[];
  failed: number[];
  onWrite: (indexes?: number[], force?: boolean) => void;
  onSave: (post: Post) => void;
}) {
  const grid = gridOf(plan.length);
  const busy = writing.length > 0;
  return (
    <>
      <Head
        kit="voice"
        title="Captions"
        action={
          <button type="button" className="secondary journey-head-action" disabled={busy} onClick={() => onWrite(plan.map((p) => p.index), true)}>
            {busy ? <LoaderCircle className="spinning" size={15} /> : <Wand2 size={15} />} Write them all again
          </button>
        }
      >
        {busy
          ? `Looking at ${writing.length === 1 ? "the picture" : `${writing.length} pictures`} and writing what each one shows, in the client's tone…`
          : "Every caption is written from its finished picture. Edit any of them: your words stay even if the picture is made again."}
      </Head>
      <div className={`journey-boxes idea-grid results ${grid.rows > 2 ? "scrolls" : ""}`} style={grid.style}>
        {plan.map((p, i) => (
          <CaptionCard
            key={`${p.index}:${p.captionFrom ?? ""}:${p.caption.length}`}
            post={p}
            job={posts.find((x) => x.index === p.index)}
            order={i}
            writing={writing.includes(p.index)}
            failed={failed.includes(p.index)}
            onWrite={() => onWrite([p.index], true)}
            onSave={onSave}
          />
        ))}
      </div>
    </>
  );
}

function CaptionCard({
  post,
  job,
  order,
  writing,
  failed,
  onWrite,
  onSave,
}: {
  post: Post;
  job: JourneyPost | undefined;
  order: number;
  writing: boolean;
  failed: boolean;
  onWrite: () => void;
  onSave: (post: Post) => void;
}) {
  const [caption, setCaption] = useState(post.caption);
  const [hashtags, setHashtags] = useState(post.hashtags);
  const save = () => {
    if (caption !== post.caption || hashtags !== post.hashtags) onSave({ ...post, caption, hashtags, captionHand: true });
  };
  const current = captionCurrent(post, job);
  return (
    <article className="journey-box idea-card caption-card" style={{ "--i": order } as React.CSSProperties}>
      <div className="caption-top">
        <span className="caption-thumb">{job?.url ? <img src={job.url} alt="" /> : null}</span>
        <div className="caption-what">
          <div className="idea-meta">
            <span className="idea-index">{String(post.index).padStart(2, "0")}</span>
            {post.date && <span className="journey-tag">{shortDate(post.date)}</span>}
          </div>
          {post.headline && (
            <strong className="caption-headline" dir="auto">
              {post.headline}
            </strong>
          )}
        </div>
      </div>
      {writing ? (
        <div className="analysis-skeleton caption-skeleton">
          <i />
          <i />
          <i />
        </div>
      ) : (
        <>
          <textarea className="idea-caption" dir="auto" value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={save} aria-label="Caption" />
          <input className="caption-tags" dir="auto" value={hashtags} onChange={(e) => setHashtags(e.target.value)} onBlur={save} aria-label="Hashtags" />
        </>
      )}
      <div className="caption-foot">
        <small className={failed ? "caption-note warn" : "caption-note"}>
          {writing
            ? "Writing from the picture…"
            : failed
              ? "Could not be written. Try again."
              : post.captionHand
                ? "Your words"
                : current && post.captionFrom
                  ? "From the picture"
                  : job?.url
                    ? "The idea's draft: not from the picture yet"
                    : "No picture yet"}
        </small>
        <button type="button" className="text-button" disabled={writing || !job?.url} onClick={onWrite} title="Look at the picture again and write a new caption">
          <Wand2 size={13} /> From the picture
        </button>
      </div>
    </article>
  );
}

/* ───────────── The feed: the month as the client's grid will look ───────────── */

export function FeedStep({
  client,
  month,
  plan,
  posts,
  format,
  overlay,
  logoSrc,
  onShare,
  onExport,
  typography,
  onOpenStudio,
  versions,
  reference,
  onRetake,
  approvals = {},
  onFix,
}: {
  client: Client;
  month: string;
  plan: Post[];
  posts: JourneyPost[];
  format: Format;
  overlay: OverlaySpec;
  logoSrc: string | null;
  onShare: () => Promise<void>;
  onExport: () => Promise<void>;
  typography: TypographyProps;
  /** Opens the studio on one post. */
  onOpenStudio: (index: number) => void;
  /** The month's earlier versions, shown under the feed. */
  versions?: React.ReactNode;
  /** The reference grid the month follows (its picture), shown beside the feed. */
  reference?: string;
  onRetake: (index: number) => Promise<void>;
  /** What the client said on the approval link, by post. */
  approvals?: Record<string, Approval>;
  /** Changes one post's picture as a note asks. */
  onFix: (index: number, edit: string) => Promise<void>;
}) {
  const [sharing, setSharing] = useState(false);
  const [fixing, setFixing] = useState<number | null>(null);
  const [fixingPost, setFixingPost] = useState<number | null>(null);
  const comments = plan.filter((p) => approvals[String(p.index)]?.status === "changes" && approvals[String(p.index)].note);
  const approvedCount = plan.filter((p) => approvals[String(p.index)]?.status === "approved").length;
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // The newest post sits top left, as in the feed at the end of the month.
  const feed = [...plan].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.index - a.index);
  const flagged = posts.filter((x) => x.flags?.length).length;
  const drifted = posts.filter((x) => x.flags?.some((f) => f.kind === "tile")).length;
  const [retaking, setRetaking] = useState(false);
  const ready = posts.filter((x) => x.url).length;
  const opened = open !== null ? plan.find((p) => p.index === open) : null;
  const openedJob = opened ? posts.find((x) => x.index === opened.index) : null;
  const run = async (set: (v: boolean) => void, fn: () => Promise<void>) => {
    set(true);
    try {
      await fn();
    } finally {
      set(false);
    }
  };
  return (
    <>
      <Head kit="output" title="The feed">
        {client.name}'s {monthLabel(month)} as the grid will look at the end of the month, the newest post first.
      </Head>
      <div className="journey-boxes feed-cols">
        <div className="journey-box feed-phone">
          <div className="feed-profile">
            <span className="feed-avatar">{logoSrc ? <img src={logoSrc} alt="" /> : <strong>{client.name.slice(0, 1)}</strong>}</span>
            <strong>{client.name}</strong>
          </div>
          <div className="feed-grid">
            {feed.map((p, i) => {
              const j = posts.find((x) => x.index === p.index);
              const drift = j?.flags?.find((f) => f.kind === "tile");
              return (
                <button
                  type="button"
                  key={p.index}
                  className={`feed-tile ${drift ? "drift" : ""}`}
                  style={{ "--i": i } as React.CSSProperties}
                  onClick={() => setOpen(p.index)}
                  disabled={!j?.url}
                  title={approvals[String(p.index)]?.note || drift?.text}
                >
                  {approvals[String(p.index)] && <span className={`feed-mark ${approvals[String(p.index)].status}`}>{approvals[String(p.index)].status === "approved" ? "✓" : "!"}</span>}
                  {j?.url ? (
                    p.overlay !== false && (p.headline || logoSrc) ? (
                      <OverlayPreview src={j.url} spec={overlay} text={{ headline: p.headline, subline: p.subline }} logoSrc={logoSrc} patch={p.ov} width={420} alt={p.title} />
                    ) : (
                      <img src={j.url} alt={p.title} loading="lazy" />
                    )
                  ) : (
                    <span className="feed-empty">{String(p.index).padStart(2, "0")}</span>
                  )}
                </button>
              );
            })}
          </div>
          {versions}
        </div>
        <div className="journey-box feed-side">
          {reference && (
            <figure className="feed-reference">
              <img src={reference} alt="The grid this month follows" />
              <figcaption>
                The grid you picked. {drifted ? `${drifted} post${drifted > 1 ? "s" : ""} drift from their tile (marked in orange): open one to make it again.` : "Every post follows its tile."}
              </figcaption>
            </figure>
          )}
          {posts.some((x) => x.flags?.length && !MAKING.includes(x.status)) && (
            <div className="feed-check">
              <strong>To check</strong>
              {posts
                .filter((x) => x.flags?.length && !MAKING.includes(x.status))
                .map((x) => (
                  <div key={x.index} className="feed-check-item">
                    <span>
                      <b>Post {x.index}</b> {x.flags!.map((f) => f.text).join("; ")}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={fixingPost !== null}
                      onClick={() => {
                        setFixingPost(x.index);
                        void onFix(x.index, fixNote(x.flags!)).finally(() => setFixingPost(null));
                      }}
                    >
                      {fixingPost === x.index ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Fix it
                    </button>
                  </div>
                ))}
            </div>
          )}
          <p className="magic-big">{ready}</p>
          <p className="field-hint">
            posts ready · {FORMAT_INFO[format].label} · {monthLabel(month)}
            {flagged ? `. ${flagged} still have points from the review: open them in the studio before sending.` : "."}
          </p>
          <button type="button" className="primary" disabled={sharing} onClick={() => void run(setSharing, onShare)}>
            {sharing ? <LoaderCircle className="spinning" size={15} /> : <Share2 size={15} />} Copy the client's approval link
          </button>
          <TypographyControls {...typography} disabled={!ready} />
          <button type="button" className="secondary" disabled={exporting} onClick={() => void run(setExporting, onExport)}>
            {exporting ? <LoaderCircle className="spinning" size={15} /> : <Download size={15} />} Download the month
          </button>
          {(comments.length > 0 || approvedCount > 0) && (
            <div className="feed-comments">
              <strong>
                The client's answers: {approvedCount} approved{comments.length ? `, ${comments.length} asking a change` : ""}
              </strong>
              {comments.map((p) => (
                <div key={p.index} className="feed-comment">
                  <span>Post {p.index}</span>
                  <p dir="auto">“{approvals[String(p.index)].note}”</p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={fixing !== null || !posts.find((x) => x.index === p.index)?.url}
                    onClick={() => {
                      setFixing(p.index);
                      void onFix(p.index, approvals[String(p.index)].note!).finally(() => setFixing(null));
                    }}
                  >
                    {fixing === p.index ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Make the change
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="field-hint">
            The client opens the link, approves each post or asks for a change. The studio holds the month for edits, the text on the images and the
            exports.
          </p>
        </div>
      </div>
      {opened && openedJob?.url && (
        <Overlay title={opened.title} onClose={() => setOpen(null)}>
          <div className="feed-open-card" onClick={(e) => e.stopPropagation()}>
            <img src={openedJob.url} alt={opened.title} />
            <div className="feed-open-text">
              <strong dir="auto">{opened.headline ?? opened.title}</strong>
              <p dir="auto">{opened.caption}</p>
              <small dir="auto">{opened.hashtags}</small>
              <button type="button" className="secondary" onClick={() => onOpenStudio(opened.index)}>
                <ArrowUpRight size={14} /> Open this post in the studio
              </button>
              {openedJob.flags?.find((f) => f.kind === "tile") && (
                <>
                  <p className="feed-drift">{openedJob.flags.find((f) => f.kind === "tile")!.text}</p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={retaking}
                    onClick={() => void run(setRetaking, () => onRetake(opened.index)).then(() => setOpen(null))}
                  >
                    {retaking ? <LoaderCircle className="spinning" size={14} /> : <RotateCcw size={14} />} Make it again
                  </button>
                </>
              )}
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}
