/**
 * What a Studio card says about its editing session: work kept from an editor that was closed
 * without saving (with "Open" to finish it and an explicit "Discard"), and a save that was kept as
 * a new version because the client holds the current one (with "Send it for review" to make it the
 * client's version). Nothing here is paid; the card's picture and clip come from the server.
 */
import { useState } from "react";
import { Send, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { patchSession, pendingLabel, pendingParts, sendHeldForReview, type EditingSession, type StudioKind } from "./editing-session";
import "./editing-session.css";

export default function CardSession({ session, open, onSent }: { session: EditingSession | null; /** Opens the studio the session was last in. */ open: (kind: StudioKind) => void; /** The month is read again after a version went to the client. */ onSent: () => void | Promise<void> }) {
  const [sending, setSending] = useState(false);
  if (!session) return null;
  const parts = session.studio ? [] : pendingParts(session);
  const held = session.held;
  if (!parts.length && !held) return null;
  return (
    <div className="pc-session" onClick={(e) => e.stopPropagation()}>
      {parts.length > 0 && (
        <p className="pc-session-row">
          <span>Unsaved edits kept: {pendingLabel(parts)}.</span>
          <span className="pc-session-actions">
            <button type="button" className="text-button" onClick={() => open(parts[0])} title="Open the editor with these edits, then Save & return">
              Open to finish
            </button>
            <button
              type="button"
              className="text-button danger"
              onClick={async () => {
                const ok = await askConfirm(`Discard the unsaved ${pendingLabel(parts)} of post ${session.index}? The card's picture, words and video stay as they are.`, { ok: "Discard", danger: true, cancel: "Keep them" });
                if (ok) patchSession(session.batch, session.index, { photo: null, text: null, video: null });
              }}
            >
              <Undo2 size={12} /> Discard
            </button>
          </span>
        </p>
      )}
      {held && (
        <p className="pc-session-row held" role="status">
          <span>{held.message}</span>
          <span className="pc-session-actions">
            <button
              type="button"
              className="text-button"
              disabled={sending}
              title={held.kind === "words" ? "Asks the client to review this post again" : "Makes the new version the one the client sees on the review link; the client's earlier answer is cleared so they answer the new one"}
              onClick={async () => {
                const ok = await askConfirm(`Make the new ${held.kind === "words" ? "words" : "picture"} the client's version of post ${session.index}? The client sees it on the review link and is asked to review it again. The current version stays under Versions.`, { ok: "Send it for review", danger: false, cancel: "Not now" });
                if (!ok) return;
                setSending(true);
                try {
                  await sendHeldForReview(session.batch, session.index, held);
                  toast.success(`Post ${session.index}: the new version is the client's now, sent for review.`);
                  await onSent();
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? <Orb size={12} /> : <Send size={12} />} Send it for review
            </button>
            <button type="button" className="text-button" onClick={() => patchSession(session.batch, session.index, { held: null })} title="Hide this note; the new version stays under Versions">
              Keep the client's
            </button>
          </span>
        </p>
      )}
    </div>
  );
}
