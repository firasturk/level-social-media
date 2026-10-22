/**
 * Check: what the automatic review found on this picture (with "Edit this picture" and "Accept as
 * it is"), and the Writing check (OCR) of the raw picture and the final artwork.
 */
import { Check, RefreshCw, ScanSearch } from "lucide-react";
import { Orb } from "@/components/Orb";
import type { QA } from "@shared/types";
import { fixNote } from "@shared/qa";
import type { StudioCtx } from "../types";

export default function CheckPanel({ ctx }: { ctx: StudioCtx }) {
  const { editor, task, busy, inFlight, cost } = ctx;
  let qa: QA | null = null;
  try {
    qa = task.qa ? (JSON.parse(task.qa) as QA) : null;
  } catch {
    qa = null;
  }
  const flags = qa?.flags ?? null;
  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>
          <ScanSearch size={13} /> Check
        </span>
      </div>
      <span className="ts-group-title">Automatic review</span>
      {!qa && <p className="ts-hint">No review notes on this picture.</p>}
      {qa && flags && (
        <div className={`post-review ps-review ${flags.length ? "warn" : "pass"}`}>
          <strong>{flags.length ? "Check these" : "Review passed"}</strong>
          {flags.length ? (
            <ul>
              {flags.map((f, i) => (
                <li key={i}>{f.text}</li>
              ))}
            </ul>
          ) : (
            <span>{qa.notes}</span>
          )}
          {flags.length > 0 && (
            <div className="ps-row ps-wrap">
              <button type="button" className="ts-btn primary" disabled={busy || inFlight} onClick={() => void ctx.revise(fixNote(flags))} title="Edit this picture: the current photo is changed to take out what the review found (one paid picture)">
                {busy ? <Orb size={14} /> : <RefreshCw size={14} />} Edit this picture{cost}
              </button>
              {editor.onAccept && !editor.acceptedBy && (
                <button type="button" className="ts-btn" disabled={busy || inFlight} onClick={() => void editor.onAccept!()} title="The team accepts the picture as it is; the client's approval is separate">
                  <Check size={14} /> Accept as it is
                </button>
              )}
            </div>
          )}
          {editor.acceptedBy && <span className="ts-hint">Accepted by {editor.acceptedBy} (team). The client's approval is separate.</span>}
        </div>
      )}
      {qa && !flags && (
        <div className="ps-row ps-wrap">
          <span className={`qa-chip ${qa.productConcern ? "warn" : "pass"}`}>Fidelity: {!qa.automated ? "manual" : qa.productConcern ? "check differences" : "ok"}</span>
          {qa.automated && <span className={`qa-chip ${qa.centered ? "pass" : "warn"}`}>Alignment: {qa.found ? `${Number(qa.offset ?? 0).toFixed(1)}% off` : "check"}</span>}
          {qa.notes && <span className="ts-hint">{qa.notes}</span>}
        </div>
      )}
      <span className="ts-group-title">Writing check (OCR)</span>
      {ctx.ocrPanel ?? <p className="ts-hint">The writing check reads the picture once the month is saved for a client.</p>}
    </div>
  );
}
