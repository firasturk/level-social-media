/**
 * The autosave's status, wherever edits save themselves: "Saving…", "Saved", "Saved 3 min ago", or
 * "Save failed" with the edit kept and a Retry. One small line; the words come from the shared
 * reducer so every board says the same thing.
 */
import { useEffect, useState } from "react";
import { Check, RefreshCw, TriangleAlert } from "lucide-react";
import { Orb } from "@/components/Orb";
import { saveLabel, type SaveStatus as Status } from "@shared/save-status";

export default function SaveStatus({ status, onRetry, className = "" }: { status: Status; onRetry?: () => void; className?: string }) {
  // "Saved" turns into "Saved N min ago" by itself.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.state !== "saved") return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [status]);
  if (status.state === "idle") return null;
  const label = saveLabel(status, status.state === "saved" ? Math.max(now, status.at) : now);
  return (
    <span className={`save-status ${status.state} ${className}`} role="status" aria-live="polite" title={status.state === "failed" ? status.error : undefined}>
      {status.state === "saving" ? <Orb size={11} /> : status.state === "failed" ? <TriangleAlert size={12} /> : <Check size={12} />}
      <span>{label}</span>
      {status.state === "failed" && onRetry && (
        <button type="button" className="text-button" onClick={onRetry}>
          <RefreshCw size={11} /> Retry
        </button>
      )}
    </span>
  );
}
