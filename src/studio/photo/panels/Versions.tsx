/**
 * Versions: every take of this post (picture, date, cost, what it was made for, the team's
 * acceptance), compare any two on the canvas, "Use this picture" (a restore), the video versions
 * when the post has clips, and the month's earlier versions.
 */
import { Check, Columns2, History, PenLine, RotateCcw } from "lucide-react";
import { Orb } from "@/components/Orb";
import { formatUsd } from "@shared/pricing";
import type { StudioCtx } from "../types";

const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function VersionsPanel({ ctx, busy }: { ctx: StudioCtx; busy: boolean }) {
  const { editor, inFlight, comparePick, toggleComparePick } = ctx;
  const takes = editor.takes ?? [];
  const current = takes.find((t) => t.current);
  const currentFor = current?.madeFor ?? null;
  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>
          <History size={13} /> Versions
        </span>
        <small>{takes.filter((t) => t.status === "made").length} takes</small>
      </div>
      <p className="ts-hint">
        {editor.lineage === "current" && "This picture was made for the idea as it is now."}
        {editor.lineage === "older" && "This picture was made for an earlier version of the idea. Edit it to bring it up to date, or make another version."}
        {editor.lineage === "unknown" && "Made before the studio kept track of which idea each picture was made for. It stays usable as it is."}
        {editor.acceptedBy ? ` Accepted by ${editor.acceptedBy} (team); the client's approval is separate.` : ""}
      </p>
      {comparePick.length > 0 && (
        <p className="ts-hint ps-compare-note">
          <Columns2 size={13} /> {comparePick.length === 1 ? "Comparing with the current picture on the canvas." : "Comparing the two picked takes on the canvas."}{" "}
          <button type="button" className="ts-link" onClick={() => comparePick.forEach((k) => toggleComparePick(k))}>
            Stop comparing
          </button>
        </p>
      )}
      {ctx.picked && ctx.pickVersion && (
        <p className="ts-hint ps-compare-note">
          <PenLine size={13} /> The studios work on an earlier take; the post's picture stays until you apply an edit.{" "}
          <button type="button" className="ts-link" onClick={() => ctx.pickVersion!(null)}>
            Back to the current picture
          </button>
        </p>
      )}
      {editor.onPrevious && (
        <button type="button" className="ts-mini" disabled={busy || inFlight} onClick={() => void editor.onPrevious!()} title="The picture from before the last remake, back on the post">
          <RotateCcw size={13} /> Previous picture
        </button>
      )}
      {takes.length === 0 && <p className="ts-hint">No takes recorded for this post yet.</p>}
      <ul className="ps-takes">
        {takes.map((tk) => {
          const picked = tk.key ? comparePick.includes(tk.key) : false;
          const older = tk.madeFor != null && currentFor != null && tk.madeFor < currentFor;
          return (
            <li key={tk.id} className={`${tk.status} ${tk.current ? "current" : ""} ${picked ? "picked" : ""}`}>
              {tk.image ? <img src={tk.image} alt="" loading="lazy" /> : <span className="ps-take-blank" aria-hidden />}
              <span className="ps-take-text">
                <b>
                  {tk.status === "failed" ? "Failed" : tk.current ? "Current picture" : "Earlier take"}
                  {tk.cost > 0 ? ` · ${formatUsd(tk.cost)}` : tk.status === "failed" ? " · nothing charged" : " · free"}
                </b>
                <small>
                  {when(tk.created)}
                  {tk.note ? ` · ${tk.note}` : ""}
                </small>
                <small>{tk.madeFor == null ? "Made for: not recorded" : older ? "Made for an earlier idea" : "Made for the idea as it is now"}{tk.current && editor.acceptedBy ? ` · accepted by ${editor.acceptedBy}` : ""}</small>
              </span>
              {tk.status === "made" && tk.key && (
                <span className="ps-take-actions">
                  {!tk.current && (
                    <button type="button" className={`ts-mini ${picked ? "primary" : ""}`} onClick={() => toggleComparePick(tk.key!)} title="Put this take on the canvas beside the current picture (pick two takes to compare them with each other)">
                      <Columns2 size={12} /> {picked ? "Comparing" : "Compare"}
                    </button>
                  )}
                  {!tk.current && ctx.pickVersion && (
                    <button type="button" className={`ts-mini ${ctx.picked === tk.key ? "primary" : ""}`} onClick={() => ctx.pickVersion!(ctx.picked === tk.key ? null : tk)} title="Edit this take: the Photo, Text and Video studios open on it; the post's picture changes only when you apply an edit">
                      <PenLine size={12} /> {ctx.picked === tk.key ? "Editing" : "Edit this version"}
                    </button>
                  )}
                  {!tk.current && editor.onUseTake && (
                    <button type="button" className="ts-mini" disabled={busy || inFlight} onClick={() => void editor.onUseTake!(tk.key!)} title="This take back as the post's picture; the current one stays listed here">
                      {busy ? <Orb size={12} /> : <Check size={12} />} Use this picture
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {ctx.videoVersions}
      {ctx.monthVersions && (
        <details className="ps-details">
          <summary>The month's earlier versions</summary>
          {ctx.monthVersions}
        </details>
      )}
    </div>
  );
}
