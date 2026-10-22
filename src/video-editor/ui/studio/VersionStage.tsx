/**
 * The stage of every panel but Edit: the shown version playing large (the browser's own controls),
 * or the post's picture when the post has no clip yet, with the state of a clip still being made
 * and, in a compare, a second version beside the first.
 */
import { TriangleAlert } from "lucide-react";
import { Orb } from "@/components/Orb";
import { inFlight, STATUS_TEXT, versionLabel, type VideoItem } from "@/studio/videoApi";

export default function VersionStage({ shown, compare, pictureUrl, hint }: { shown: VideoItem | null; compare: VideoItem | null; pictureUrl: string | null; hint?: string }) {
  const one = (v: VideoItem | null, label: string) => (
    <figure className="vs-frame">
      {v?.status === "done" && v.url ? <video key={v.id} src={v.url} poster={v.poster ?? pictureUrl ?? undefined} controls playsInline preload="metadata" /> : pictureUrl ? <img src={v?.poster ?? pictureUrl} alt="" /> : <div className="vs-frame-empty">No picture yet</div>}
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
