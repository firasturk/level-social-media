/**
 * A post's video on its card: a badge with the length and the frame ("Video · 5s · Reel 9:16") over
 * the poster, the inline player when tapped (seek, mute and fullscreen are the browser's own
 * controls), and the state of the newest clip while it is being made or when it failed. The badge
 * says when the client sees this clip on the review link.
 */
import { useState } from "react";
import { Play, X } from "lucide-react";
import { Orb } from "@/components/Orb";
import { frameLabel } from "@shared/video-frame";
import { inFlight, STATUS_TEXT, versionLabel, type VideoItem } from "./videoApi";

export default function VideoOnCard({ summary }: { summary: { latest: VideoItem; client: VideoItem | null; done: VideoItem | null } }) {
  const [playing, setPlaying] = useState(false);
  // The client's version when one is selected, else the newest finished clip.
  const clip = summary.client ?? summary.done;
  const latest = summary.latest;
  return (
    <>
      {clip && !playing && (
        <button
          type="button"
          className={`pc-video-badge ${clip.forClient ? "client" : ""}`}
          title={`${versionLabel(clip)}${frameLabel(clip.frame) ? ` · ${frameLabel(clip.frame)}` : ""}${clip.forClient ? " · the client sees this" : " · not shown to the client yet"} · play`}
          onClick={(e) => {
            e.stopPropagation();
            setPlaying(true);
          }}
        >
          <Play size={11} /> Video{clip.duration ? ` · ${clip.duration}s` : ""}
          {frameLabel(clip.frame) ? ` · ${frameLabel(clip.frame)}` : ""}
          {clip.forClient ? <small className="pc-video-client">the client sees this</small> : null}
        </button>
      )}
      {clip && playing && (
        <div className="pc-video-player" role="presentation" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <video key={clip.id} src={clip.url ?? undefined} poster={clip.poster ?? undefined} controls playsInline preload="metadata" autoPlay />
          <button
            type="button"
            className="pc-video-close"
            aria-label="Close the video"
            onClick={(e) => {
              e.stopPropagation();
              setPlaying(false);
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {inFlight(latest) && (
        <span className="post-progress pc-video-state">
          <Orb size={16} status={null} />
          {STATUS_TEXT[latest.status]}…
        </span>
      )}
      {latest.status === "failed" && !playing && (
        <span className="post-failed pc-video-state" title={latest.error ?? undefined}>
          Video failed · {latest.error}
        </span>
      )}
    </>
  );
}
