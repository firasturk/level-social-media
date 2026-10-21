import { useState } from "react";
import { ChevronDown, ChevronUp, Grid3x3, Link2, MessageSquareReply, PanelLeft, Share2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import type { Config } from "@shared/config";
import type { Theme } from "@shared/types";
import { briefLines } from "@shared/brief";
import { monthLabel, planShape, type Post } from "@shared/posts";
import { shortDate } from "@shared/occasions";
import { KitIcon } from "./kit";

/**
 * The month's brief at the top of the studio: what the journey agreed (count, theme, colours, the
 * rules each screen added) and how the client answered on the approval link.
 */
export default function BriefCard({
  config,
  theme,
  plan,
  onShare,
  made = 0,
  toCheck = 0,
  making = 0,
  eta,
  onFeed,
  kitOpen,
  onKit,
  onWhatsApp,
  onClientChanges,
  clientChangesBusy,
}: {
  config: Config;
  theme: Theme | null;
  plan: Post[];
  onShare: () => void;
  /** Posts with a picture, posts the review flagged, posts being made now. */
  made?: number;
  toCheck?: number;
  making?: number;
  /** Minutes left while posts are being made. */
  eta?: number | null;
  /** Opens the month's feed. */
  onFeed?: () => void;
  /** The brand kit panel: open or folded away. */
  kitOpen?: boolean;
  onKit?: () => void;
  /** Apply the client's change requests from the approval page and make those posts again. */
  onClientChanges?: () => void;
  clientChangesBusy?: boolean;
  /** Sends the client's link on WhatsApp. */
  onWhatsApp?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = briefLines(config.brief);
  const approvals = Object.values(config.approvals ?? {});
  const approved = approvals.filter((a) => a.status === "approved").length;
  const changes = approvals.filter((a) => a.status === "changes").length;
  const dates = plan.map((p) => p.date).filter(Boolean) as string[];
  return (
    <section className={`brief-card ${open ? "open" : ""}`}>
      <div className="brief-card-row">
        <KitIcon kit="direction" />
        <div className="brief-card-facts">
          <span>
            <strong>{plan.length ? planShape(plan).split(":")[0] : `${config.postCount || 12} posts`}</strong> · {monthLabel(config.month ?? "")}
            {dates.length ? ` · ${shortDate(dates[0])} to ${shortDate(dates[dates.length - 1])}` : ""}
          </span>
          {plan.length > 0 && (
            <span className="brief-card-state">
              {making ? (
                <em className="busy">
                  <Orb size={12} /> making {made}/{plan.length}
                  {eta ? ` · about ${eta} min left` : ""}
                </em>
              ) : (
                <em className={made === plan.length ? "ok" : ""}>
                  {made}/{plan.length} designs made
                </em>
              )}
              {toCheck > 0 && <em className="warn">{toCheck} need review</em>}
            </span>
          )}
          <span>
            Theme <strong>{theme?.title ?? "brand identity"}</strong>
          </span>
          {theme?.palette.length ? (
            <span className="brief-card-swatches" title="The month's colours (first = background)">
              {theme.palette.map((c, i) => (
                <i key={c.hex + i} style={{ background: c.hex }} />
              ))}
            </span>
          ) : null}
          {approvals.length > 0 && (
            <span className="brief-card-approvals">
              {approved > 0 && <em className="ok">{approved} approved</em>}
              {changes > 0 && <em className="warn">{changes} to change</em>}
            </span>
          )}
        </div>
        {onKit && (
          <button type="button" className="text-button" onClick={onKit} aria-pressed={kitOpen} title="Logos, colours, fonts, tone, rules, theme and ambassadors">
            <PanelLeft size={14} /> {kitOpen ? "Hide brand kit" : "Brand kit"}
          </button>
        )}
        {onFeed && made > 0 && (
          <button type="button" className="secondary" onClick={onFeed} title="The month as the client's grid will look">
            <Grid3x3 size={14} /> Open the feed
          </button>
        )}
        <button type="button" className="secondary" onClick={onShare} title="Copy a link the client opens to approve the posts">
          <Link2 size={14} /> Client link
        </button>
        {onClientChanges && changes > 0 && (
          <button type="button" className="primary" onClick={onClientChanges} disabled={clientChangesBusy} title="Read what the client asked on the approval page, change those posts and make them again">
            {clientChangesBusy ? <Orb size={12} /> : <MessageSquareReply size={14} />} Do client comments ({changes})
          </button>
        )}
        {onWhatsApp && made > 0 && (
          <button type="button" className="secondary" onClick={onWhatsApp} title="Send the client's link on WhatsApp">
            <Share2 size={14} /> WhatsApp
          </button>
        )}
        {(lines.length > 0 || plan.some((x) => x.scene)) && (
          <button type="button" className="text-button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            The logic {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      {open && lines.length > 0 && (
        <ol className="brief-card-logic">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      )}
      {open && plan.some((x) => x.scene) && (
        <>
          <strong className="brief-card-sub">The shot list (one per post)</strong>
          <ol className="brief-card-logic">
            {plan
              .filter((x) => x.scene)
              .map((x) => (
                <li key={x.index}>
                  <b>{String(x.index).padStart(2, "0")}</b> {x.scene}
                </li>
              ))}
          </ol>
        </>
      )}
    </section>
  );
}
