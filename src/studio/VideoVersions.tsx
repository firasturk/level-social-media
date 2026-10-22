/**
 * The video versions of a post in the editor's Versions group: each clip with its engine, length
 * and state, the one the client reviews marked, and "Select for client review" on the others. The
 * picture is a version too: with no clip selected, it is what the client sees.
 */
import { useEffect, useState } from "react";
import { Check, Clapperboard, TriangleAlert } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import { videoModel } from "@shared/video-models";
import { inFlight, listVideos, selectForClient, STATUS_TEXT, versionLabel, type VideoItem } from "./videoApi";

export default function VideoVersions({ batchId, index, onOpenVideo, onChanged }: { batchId: string; index: number; onOpenVideo?: () => void; onChanged?: () => void }) {
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    listVideos(batchId, index)
      .then((r) => setVideos(r.videos))
      .catch(() => setVideos([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, index]);
  const pending = !!videos?.some(inFlight);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  async function select(id: string | null) {
    setBusy(true);
    try {
      const r = await selectForClient(batchId, index, id);
      setVideos(r.videos);
      toast.success(id ? "This video goes to the client for review." : "The client sees the picture.");
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (videos === null) return null;
  const client = videos.find((v) => v.forClient) ?? null;
  return (
    <div className="takes video-takes">
      <span className="field-label">
        <Clapperboard size={13} /> Video versions · {videos.length}
      </span>
      <ul className="takes-list">
        <li className={`made ${client ? "" : "current"}`}>
          <span className="take-blank" aria-hidden />
          <span className="take-text">
            <b>The picture{client ? "" : " · shown to the client"}</b>
            <small>The post's current picture, words drawn by the page.</small>
          </span>
          {client && (
            <span className="take-actions">
              <button type="button" className="text-button" disabled={busy} onClick={() => void select(null)}>
                Show the picture to the client
              </button>
            </span>
          )}
        </li>
        {videos.map((v) => (
          <li key={v.id} className={`${v.status === "done" ? "made" : v.status} ${v.forClient ? "current" : ""}`}>
            {v.poster ? <img src={v.poster} alt="" loading="lazy" /> : <span className="take-blank" aria-hidden />}
            <span className="take-text">
              <b>
                {versionLabel(v)}
                {v.forClient ? " · shown to the client" : ""}
              </b>
              <small>
                {v.provider === "upload" ? "Uploaded" : videoModel(v.model)?.name ?? v.model}
                {v.duration ? ` · ${v.duration}s` : ""}
                {v.source === "artwork" ? " · with words and logo" : v.source === "picture" ? " · bare picture" : ""}
                {` · ${STATUS_TEXT[v.status]}`}
                {v.estimate !== null && v.estimate > 0 ? ` · $${v.estimate.toFixed(v.estimate < 1 ? 3 : 2)}` : ""}
              </small>
              {inFlight(v) && (
                <small>
                  <Orb size={12} status={null} /> {STATUS_TEXT[v.status]}…
                </small>
              )}
              {v.status === "failed" && v.error && (
                <small className="warn">
                  <TriangleAlert size={12} /> {v.error}
                </small>
              )}
            </span>
            <span className="take-actions">
              {v.status === "done" && v.url && (
                <a className="text-button" href={v.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
              {v.status === "done" &&
                (v.forClient ? (
                  <span className="text-button on">
                    <Check size={12} /> Client version
                  </span>
                ) : (
                  <button type="button" className="text-button" disabled={busy} onClick={() => void select(v.id)}>
                    Select for client review
                  </button>
                ))}
            </span>
          </li>
        ))}
      </ul>
      {onOpenVideo && (
        <button type="button" className="secondary" onClick={onOpenVideo}>
          <Clapperboard size={14} /> {videos.length ? "Make another video" : "Make a video"}
        </button>
      )}
    </div>
  );
}
