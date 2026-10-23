/**
 * The stage of every panel but Edit: the shown version playing large (the shared player: it starts
 * by itself, muted, with the browser's own controls for seeking, volume and fullscreen), or the
 * post's picture when the post has no clip yet, with the state of a clip still being made and, in a
 * compare, a second version beside the first (one audible at a time).
 *
 * For admins, a finished clip with no lightweight preview gets one made in this browser after it
 * has been on the stage a moment (src/lib/video-rendition.ts): cards and galleries then play that
 * small file instead of the full clip.
 */
import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { inFlight, STATUS_TEXT, versionLabel, type VideoItem } from "@/studio/videoApi";

/** How long a clip stays on the stage before its preview is made (it is not made for a quick glance). */
const BACKFILL_AFTER_MS = 4000;

function useBackfill(v: VideoItem | null, enabled: boolean, onDone?: (v: VideoItem) => void) {
  const id = v?.id;
  const wants = enabled && !!v && v.status === "done" && !!v.url && !v.preview;
  useEffect(() => {
    if (!wants || !v) return;
    const timer = setTimeout(() => {
      void import("@/lib/video-rendition").then(({ backfillRendition }) => backfillRendition(v)).then((after) => after && onDone?.(after));
    }, BACKFILL_AFTER_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, wants]);
}

export default function VersionStage({ shown, compare, pictureUrl, hint, active = true, backfill = false, onPreview }: { shown: VideoItem | null; compare: VideoItem | null; pictureUrl: string | null; hint?: string; /** False while the studio is closed or another panel covers the stage: the clips pause. */ active?: boolean; /** Make the lightweight preview of a shown clip that has none (admins). */ backfill?: boolean; onPreview?: (v: VideoItem) => void }) {
  useBackfill(shown, backfill, onPreview);
  const one = (v: VideoItem | null, label: string) => (
    <figure className="vs-frame">
      {v?.status === "done" && v.url ? <AutoplayVideo key={v.id} src={v.url} poster={v.poster ?? pictureUrl} mode="player" loop active={active} label={label} /> : pictureUrl ? <img src={v?.poster ?? pictureUrl} alt="" /> : <div className="vs-frame-empty">No picture yet</div>}
      {v && inFlight(v) && (
        <span className="vs-making">
          <Orb variant="generate" size={16} status={null} /> {STATUS_TEXT[v.status]}… a minute or two
        </span>
      )}
      {v?.status === "failed" && (
        <span className="vs-making failed">
          <TriangleAlert size={13} /> Failed · {v.error}
        </span>
      )}
      <figcaption>{label}</figcaption>
    </figure>
  );
  return (
    <div className={`vs-stage ${compare ? "compare" : ""}`}>
      {one(shown, shown ? `${versionLabel(shown)}${shown.forClient ? " · the client sees this" : ""}` : "The post's picture")}
      {compare && one(compare, versionLabel(compare))}
      {hint && <div className="vs-hint-pill">{hint}</div>}
    </div>
  );
}
