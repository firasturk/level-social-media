import { useEffect, useRef, useState } from "react";
import { Clapperboard, Download, Lightbulb, RefreshCw, TriangleAlert } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post } from "@/api";
import { VIDEO_MODELS, VIDEO_SECONDS } from "@shared/qa";
import type { Post } from "@shared/posts";
import { askConfirm } from "@/lib/confirm";
import { formatUsd } from "@shared/pricing";
import type { IntegrationAccess } from "./FreepikConnection";

interface VideoItem {
  id: string;
  post: number;
  model: string;
  prompt: string;
  status: "queued" | "done" | "failed";
  error: string | null;
  created: number;
  url: string | null;
}

/**
 * A finished post set in motion: the motion director writes the idea from the picture, the
 * designer edits it and picks the engine, and Higgsfield makes a five-second clip from the
 * picture as its first frame. The clips stay with the post.
 *
 * Admins only for now: a member sees the clips already made and the note, no controls. Making one
 * is two requests: the server proposes it with the estimate on file (none: it refuses, "cost not
 * known"), the admin confirms, and the same request goes again with {opId, confirm: true}.
 */
export default function VideoDialog({
  open,
  batchId,
  post: p,
  src,
  fileBase,
  onClose,
}: {
  open: boolean;
  batchId: string;
  post: Post;
  /** The post's picture (for the preview). */
  src: string;
  fileBase: string;
  onClose: () => void;
}) {
  const [idea, setIdea] = useState("");
  const [model, setModel] = useState(VIDEO_MODELS[0].slug);
  const [writing, setWriting] = useState(false);
  const [making, setMaking] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [error, setError] = useState("");
  const [access, setAccess] = useState<IntegrationAccess | null>(null);
  const polled = useRef<ReturnType<typeof setInterval> | null>(null);
  const locked = !!access && (!access.admin || !access.enabled);

  async function load() {
    try {
      const r = await get<{ videos: VideoItem[]; access?: IntegrationAccess }>(`/api/studio/posts/video/list?batch=${encodeURIComponent(batchId)}&index=${p.index}`);
      setVideos(r.videos);
      if (r.access) setAccess(r.access);
      return { videos: r.videos, access: r.access };
    } catch (e) {
      setError((e as Error).message);
      return { videos: [] as VideoItem[], access: undefined };
    }
  }
  async function writeIdea() {
    setWriting(true);
    setError("");
    try {
      const r = await post<{ idea: string }>("/api/studio/posts/video/idea", { batch: batchId, index: p.index });
      setIdea(r.idea);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriting(false);
    }
  }
  async function make() {
    if (!idea.trim()) return;
    setMaking(true);
    setError("");
    try {
      const payload = { batch: batchId, index: p.index, prompt: idea.trim(), model };
      // First the proposal: nothing is sent; the server answers with the estimate an admin put on file.
      const proposal = await post<{ opId: string; estimate: number | null; needsConfirmation: true }>("/api/studio/posts/video", payload);
      const ok = await askConfirm(
        proposal.estimate == null
          ? "The cost of a video clip is not known, so the server will refuse it until an admin enters an estimate under Admin → Integrations."
          : `A ${VIDEO_SECONDS}-second clip on Higgsfield costs about ${formatUsd(proposal.estimate)} (the estimate on file; Higgsfield bills its own credits). Make it?`,
        { ok: proposal.estimate == null ? "Try anyway" : `Make it · about ${formatUsd(proposal.estimate)}`, danger: false, cancel: "Not now" },
      );
      if (!ok) return;
      const r = await post<{ video: VideoItem }>("/api/studio/posts/video", { ...payload, opId: proposal.opId, confirm: true });
      setVideos((v) => [r.video, ...v]);
      toast.success("The video is being made; it takes a minute or two.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMaking(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    setError("");
    void load().then(({ videos: list, access: a }) => {
      const last = list[0];
      if (last) {
        setIdea(last.prompt);
        setModel(VIDEO_MODELS.some((m) => m.slug === last.model) ? last.model : VIDEO_MODELS[0].slug);
      } else if (a?.admin && a.enabled) void writeIdea(); // as before, for those who may make one
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, batchId, p.index]);
  // While a clip is being made, the list is asked again every few seconds.
  const pending = videos.some((v) => v.status === "queued");
  useEffect(() => {
    if (!open || !pending) return;
    polled.current = setInterval(() => void load(), 6000);
    return () => {
      if (polled.current) clearInterval(polled.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);
  const latest = videos[0];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="animate-dialog video-dialog">
        <DialogHeader>
          <DialogTitle>
            <Clapperboard size={18} /> Video of post {String(p.index).padStart(2, "0")}
          </DialogTitle>
          <DialogDescription>
            The picture becomes a {VIDEO_SECONDS}-second ad clip on Higgsfield: the first frame is the post, the motion is the idea below. The product stays exactly as it is.
          </DialogDescription>
        </DialogHeader>
        <div className="overlay-editor-body">
          <div className="video-stage">
            {latest?.status === "done" && latest.url ? (
              <video key={latest.id} src={latest.url} controls autoPlay loop playsInline poster={src} />
            ) : (
              <img src={src} alt="" />
            )}
            {latest?.status === "queued" && (
              <span className="video-making">
                <Orb variant="generate" size={18} status={null} /> Making the video… a minute or two
              </span>
            )}
          </div>
          {locked && access ? (
            <div className="overlay-editor-controls">
              <p className="quality-note">
                <b>{access.admin ? "Switched off" : "Admins only for now"}.</b> {access.reason}
              </p>
              {latest?.status === "done" && latest.url && (
                <div className="footer-actions">
                  <a className="secondary video-download" href={latest.url} download={`${fileBase}_post${String(p.index).padStart(2, "0")}.mp4`}>
                    <Download size={14} /> Download
                  </a>
                </div>
              )}
            </div>
          ) : (
          <div className="overlay-editor-controls">
            <label className="field-label">
              <Lightbulb size={13} /> The motion idea
            </label>
            <textarea rows={6} value={idea} placeholder={writing ? "Writing an idea from the picture…" : "What moves, and how (or ask for an idea below)"} onChange={(e) => setIdea(e.target.value)} disabled={writing} />
            <button type="button" className="text-button" onClick={() => void writeIdea()} disabled={writing || making || !access}>
              {writing ? <Orb size={13} /> : <RefreshCw size={13} />} {idea ? "Another idea" : "Write an idea from the picture"}
            </button>
            <label className="field-label">Engine</label>
            <div className="preset-row">
              {VIDEO_MODELS.map((m) => (
                <button key={m.slug} type="button" className={`format-chip ${model === m.slug ? "active" : ""}`} onClick={() => setModel(m.slug)} title={m.note}>
                  {m.name}
                </button>
              ))}
            </div>
            <small className="field-hint">{VIDEO_MODELS.find((m) => m.slug === model)?.note}</small>
            <small className="field-hint">Videos are billed in Higgsfield credits at the engine's own price. They are outside the month's picture budget and are not covered by its spending limit.</small>
            {error && (
              <p className="video-error">
                <TriangleAlert size={14} /> {error}
                {/not connected/i.test(error) && <span> Add the Higgsfield Cloud key (cloud.higgsfield.ai) in Connection, bottom of the menu.</span>}
              </p>
            )}
            <div className="footer-actions">
              <button type="button" className="primary" onClick={() => void make()} disabled={making || writing || !idea.trim() || pending}>
                {making ? <Orb size={14} /> : <Clapperboard size={14} />} Make the video
              </button>
              {latest?.status === "done" && latest.url && (
                <a className="secondary video-download" href={latest.url} download={`${fileBase}_post${String(p.index).padStart(2, "0")}.mp4`}>
                  <Download size={14} /> Download
                </a>
              )}
            </div>
            {videos.length > 1 && (
              <ul className="video-history">
                {videos.slice(1).map((v) => (
                  <li key={v.id}>
                    <span className={`pill ${v.status === "done" ? "ready" : v.status === "failed" ? "failed" : "queued"}`}>{v.status}</span>
                    <span>{new Date(v.created).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    {v.url && (
                      <a href={v.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    )}
                    {v.error && <small>{v.error}</small>}
                  </li>
                ))}
              </ul>
            )}
            {latest?.status === "failed" && latest.error && (
              <p className="video-error">
                <TriangleAlert size={14} /> {latest.error}
              </p>
            )}
          </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
