/**
 * The Studio board's Feed tab: the month as the client's Instagram grid will look, three across,
 * in feed order (by grid tile when the month follows a grid, else the newest post first, the same
 * order as the client's page). Each tile is the post's current picture with its words and logo
 * drawn on; a post with no picture yet is an empty tile with its title. A tile opens its post.
 */
import { FileText } from "lucide-react";
import type { Approval } from "@shared/config";
import { carouselEntries } from "@shared/carousel";
import { shortDate } from "@shared/occasions";
import type { OverlaySpec } from "@shared/overlay";
import { monthLabel, type Post } from "@shared/posts";
import { feedOrder } from "@shared/testgrid";
import type { Client, Task } from "@shared/types";
import { facesOf } from "@/lib/overlay";
import OverlayPreview from "./OverlayPreview";

export default function FeedView({
  client,
  month,
  plan,
  tasks,
  approvals = {},
  overlay,
  logoSrc,
  outputThumb,
  onOpen,
  onExportPdf,
  exporting,
}: {
  client: Client;
  month: string;
  plan: Post[];
  tasks: Task[];
  /** What the client said on the approval link, by post. */
  approvals?: Record<string, Approval>;
  /** The client's text layout and logo: each post is shown as it will be published. */
  overlay: OverlaySpec;
  logoSrc: string | null;
  outputThumb: (t: Task) => string;
  /** Opens one post (its editor). */
  onOpen: (index: number) => void;
  /** The month as one long PDF page (the More menu's "Feed PDF"). */
  onExportPdf: () => void;
  exporting: boolean;
}) {
  if (!plan.length) return <p className="flow-muted studio-empty">No posts in this month yet. Write the plan first; the feed shows its posts as the grid will look.</p>;
  const taskOf = (i: number) => tasks.find((t) => t.post === i && t.output) ?? null;
  // A carousel is one post of the feed: its first slide is the tile.
  const feed = carouselEntries(
    feedOrder(plan)
      .map((i) => plan.find((p) => p.index === i))
      .filter((p): p is Post => !!p),
  );
  const made = feed.filter((e) => taskOf(e.post.index)).length;
  return (
    <div className="feed-view">
      <div className="approval-head">
        <p>
          {client.name}'s {monthLabel(month)} as the grid will look on Instagram. <b>{made}</b> of {feed.length} with a picture. Click a post to open it.
        </p>
        <div className="approval-actions">
          <button type="button" className="cta secondary" onClick={onExportPdf} disabled={!made || exporting} title={!made ? "Nothing to export yet: this month has no pictures" : exporting ? "Wait: an export is running" : "One long PDF page of the month, to send to the client"}>
            <FileText size={14} /> Feed PDF
          </button>
        </div>
      </div>
      <div className="feed-phone">
        <div className="feed-profile">
          <span className="feed-avatar">{logoSrc ? <img src={logoSrc} alt="" /> : <strong>{client.name.slice(0, 1)}</strong>}</span>
          <strong>{client.name}</strong>
        </div>
        <div className="feed-grid">
          {feed.map(({ post: p, slides }, i) => {
            const t = taskOf(p.index);
            const a = approvals[String(p.index)];
            return (
              <button type="button" key={p.index} className="feed-tile" data-post={p.index} style={{ "--i": i } as React.CSSProperties} onClick={() => onOpen(p.index)} title={a?.note || `Open post ${p.index}: ${p.title}`}>
                {a && <span className={`feed-mark ${a.status}`}>{a.status === "approved" ? "✓" : "!"}</span>}
                {(p.date || slides) && (
                  <span className="feed-day">
                    {[p.date ? shortDate(p.date) : "", slides ? `${slides.length} slides` : ""].filter(Boolean).join(" · ")}
                  </span>
                )}
                {t ? (
                  p.overlay !== false && (p.headline || logoSrc) ? (
                    <OverlayPreview src={outputThumb(t)} spec={overlay} text={{ headline: p.headline, subline: p.subline }} logoSrc={logoSrc} patch={p.ov} faces={facesOf(t.qa)} width={420} alt={p.title} />
                  ) : (
                    <img src={outputThumb(t)} alt={p.title} loading="lazy" />
                  )
                ) : (
                  <span className="feed-empty">
                    {String(p.index).padStart(2, "0")}
                    <small dir="auto">{p.title}</small>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
