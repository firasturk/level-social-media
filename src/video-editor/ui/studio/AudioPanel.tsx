/**
 * Audio: the Video dialog's Audio block for the shown version (engine sound or none, an uploaded
 * track, generated music when a provider is connected, the Instagram note). Writing the choice is
 * an admin's action; members see it read-only.
 */
import { useEffect, useState } from "react";
import { Music } from "lucide-react";
import { toast } from "sonner";
import type { AudioChoice } from "@shared/video-audio";
import VideoAudio from "@/studio/VideoAudio";
import { chooseAudio, inFlight, versionLabel } from "@/studio/videoApi";
import type { StudioShared } from "./types";

export default function AudioPanel({ s }: { s: StudioShared }) {
  const shown = (s.shownId ? s.videos.find((v) => v.id === s.shownId) : null) ?? s.videos.find((v) => v.status === "done") ?? s.videos[0] ?? null;
  const [choice, setChoice] = useState<AudioChoice>(shown?.audioChoice ?? "none");
  const [audioId, setAudioId] = useState<string | null>(shown?.audioId ?? null);
  useEffect(() => {
    setChoice(shown?.audioChoice ?? "none");
    setAudioId(shown?.audioId ?? null);
  }, [shown?.id, shown?.audioChoice, shown?.audioId]);
  if (!s.post) return null;
  const post = s.post;
  async function pick(c: AudioChoice, id: string | null) {
    setChoice(c);
    setAudioId(id);
    if (!shown || inFlight(shown) || !s.admin) return;
    try {
      await chooseAudio(post.batch, post.index, shown.id, c, id ?? undefined);
      await s.reloadVideos();
      s.onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <div className="vs-panel">
      <div className="ts-panel-head">
        <span>
          <Music size={13} /> Audio
        </span>
        <small>{shown ? versionLabel(shown) : "no clip yet"}</small>
      </div>
      {!shown && <p className="ts-hint">The audio choice is written on a version. Make a clip first; the choice you pick here is carried to the next clip made in Generate.</p>}
      <VideoAudio batchId={post.batch} index={post.index} engineSound={shown?.audioChoice === "provider"} engineName={shown?.label ?? "The engine"} admin={s.admin} version={shown && !inFlight(shown) ? shown : null} choice={choice} audioId={audioId} onChange={(c, id) => void pick(c, id)} />
      <p className="ts-hint">An uploaded track is mixed into the clip by the Edit panel's export (Music), not by the server: the stored file stays as it is until then.</p>
    </div>
  );
}
