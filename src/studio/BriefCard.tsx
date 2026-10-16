import { useState } from "react";
import { ChevronDown, ChevronUp, Link2 } from "lucide-react";
import type { Config } from "@shared/config";
import type { Theme } from "@shared/types";
import { briefLines } from "@shared/brief";
import { monthLabel, type Post } from "@shared/posts";
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
}: {
  config: Config;
  theme: Theme | null;
  plan: Post[];
  onShare: () => void;
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
            <strong>{plan.length || config.postCount || 12}</strong> posts · {monthLabel(config.month ?? "")}
            {dates.length ? ` · ${shortDate(dates[0])} to ${shortDate(dates[dates.length - 1])}` : ""}
          </span>
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
        <button type="button" className="secondary" onClick={onShare} title="Copy a link the client opens to approve the posts">
          <Link2 size={14} /> Client link
        </button>
        {(lines.length > 0 || !!config.shots?.length) && (
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
      {open && !!config.shots?.length && (
        <>
          <strong className="brief-card-sub">This month's shots (written for its products)</strong>
          <ol className="brief-card-logic">
            {config.shots.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
