/**
 * A post's video on its card: the clip plays by itself over the picture while the card is on
 * screen (muted, inline, looping: the shared preview, src/components/AutoplayVideo.tsx), with
 * pause and sound buttons in its corner; a badge with the length and the frame ("Video · 5s ·
 * Reel 9:16") says when the client sees this clip on the review link, and switches the card back
 * to the picture. The lightweight preview file plays when one was kept, else the full clip (loaded
 * only near the screen). The state of the newest clip shows while it is being made or when it failed.
 *
 * The clip on the card is the card's version (the last "Render & update card", or the last explicit
 * choice), else the client's version, else the newest finished clip. "Edit video" opens the Video
 * studio's editor on that clip.
 */
import { useState } from "react";
import { Clapperboard, Image as ImageIcon, Scissors } from "lucide-react";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { frameLabel } from "@shared/video-frame";
import { inFlight, STATUS_TEXT, versionLabel, type VideoItem } from "./videoApi";

export default function VideoOnCard({ summary, onEdit }: { summary: { latest: VideoItem; client: VideoItem | null; done: VideoItem | null; card?: VideoItem | null }; onEdit?: (videoId: string) => void }) {
  // The card shows the clip; the badge brings the picture back (and the clip again).
  const [picture, setPicture] = useState(false);
  // The card's version (a render, or the last explicit choice), else the client's, else the newest finished clip.
  const clip = summary.card ?? summary.client ?? summary.done;
  const latest = summary.latest;
  const frame = clip ? frameLabel(clip.frame) : "";
  return (
    <>
      {clip && !picture && (
        <AutoplayVideo
          key={clip.id}
          className="pc-video-preview"
          src={clip.preview ?? clip.url}
          fallbackSrc={clip.preview ? clip.url : null}
          poster={clip.poster}
          mode="preview"
          label={`Post ${clip.post} · ${versionLabel(clip)}`}
        />
      )}
      {clip && (
        <button
          type="button"
          className={`pc-video-badge ${clip.forClient ? "client" : ""}`}
          title={`${versionLabel(clip)}${frame ? ` · ${frame}` : ""}${clip.forClient ? " · the client sees this" : " · not shown to the client yet"} · ${picture ? "show the clip" : "show the picture"}`}
          aria-pressed={!picture}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setPicture((p) => !p);
          }}
        >
          {picture ? <Clapperboard size={11} /> : <ImageIcon size={11} />} Video{clip.duration ? ` · ${clip.duration}s` : ""}
          {frame ? ` · ${frame}` : ""}
          {clip.forClient ? <small className="pc-video-client">the client sees this</small> : <small className="pc-video-client off">not the client's version</small>}
        </button>
      )}
      {clip && onEdit && (
        <button
          type="button"
          className="pc-video-edit"
          title="Edit this video in the Video studio: trim, frame, text, logo, music, colour, then Render & update card"
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(clip.id);
          }}
        >
          <Scissors size={11} /> Edit video
        </button>
      )}
      {inFlight(latest) && (
        <span className="post-progress pc-video-state">
          <Orb size={16} status={null} />
          {STATUS_TEXT[latest.status]}…
        </span>
      )}
      {latest.status === "failed" && (
        <span className="post-failed pc-video-state" title={latest.error ?? undefined}>
          Video failed · {latest.error}
        </span>
      )}
    </>
  );
}
