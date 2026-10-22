import { useEffect, useRef, useState } from "react";
import { Check, Clapperboard, Download, Lightbulb, RefreshCw, TriangleAlert, Users } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, post } from "@/api";
import { DEFAULT_VIDEO_MODEL, durationChoices, VIDEO_MODELS, videoModel } from "@shared/video-models";
import type { Post } from "@shared/posts";
import type { AudioChoice } from "@shared/video-audio";
import { audioLine, chooseAudio, inFlight, listVideos, retryVideo, selectForClient, STATUS_TEXT, versionLabel, type VideoItem, type VideoList } from "./videoApi";
import VideoAudio from "./VideoAudio";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/**
 * A finished post set in motion: the motion director writes the idea from the picture, the
 * designer edits it, picks the engine and its settings, and Higgsfield makes a short clip from
 * the picture (or from the composed artwork, words and logo included) as its first frame. Every
 * clip stays with the post as a version; one of them can go to the client for review.
 */
export default function VideoDialog({
  open,
  batchId,
  post: p,
  src,
  fileBase,
  composeArtwork,
  onClose,
  onChanged,
}: {
  open: boolean;
  batchId: string;
  post: Post;
  /** The post's picture (for the preview). */
  src: string;
  fileBase: string;
  /** The post as it will be published, words and logo drawn by the browser, as a data URL. */
  composeArtwork?: () => Promise<string>;
  onClose: () => void;
  /** The post's versions changed (a clip made, selected or finished): the cards read them again. */
  onChanged?: () => void;
}) {
  const [idea, setIdea] = useState("");
  const [model, setModel] = useState(DEFAULT_VIDEO_MODEL);
  const [duration, setDuration] = useState<number>(videoModel(DEFAULT_VIDEO_MODEL)!.duration.default);
  const [aspect, setAspect] = useState<string>("");
  const [resolution, setResolution] = useState<string>("");
  /** The audio choice: engine sound or none for the next clip, a track, or a note for Instagram (shared/video-audio.ts). */
  const [audioChoice, setAudioChoice] = useState<AudioChoice>("none");
  const [audioId, setAudioId] = useState<string | null>(null);
  const [withWords, setWithWords] = useState(false);
  const [writing, setWriting] = useState(false);
  const [making, setMaking] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [admin, setAdmin] = useState(true);
  const [error, setError] = useState("");
  /** The server refused because nobody knows the cost: the person may confirm it anyway. */
  const [needsConfirm, setNeedsConfirm] = useState<null | { retryOf?: string }>(null);
  const [shown, setShown] = useState<string | null>(null);
  const polled = useRef<ReturnType<typeof setInterval> | null>(null);
  const m = videoModel(model) ?? VIDEO_MODELS[0];
  const price = prices[model] ?? null;

  function pickModel(slug: string) {
    const next = videoModel(slug);
    if (!next) return;
    setModel(slug);
    setDuration(next.duration.options?.includes(duration) || (!next.duration.options && duration >= (next.duration.min ?? 1) && duration <= (next.duration.max ?? 60)) ? duration : next.duration.default);
    setAspect(next.aspect?.includes(aspect) ? aspect : "");
    setResolution(next.resolution?.includes(resolution) ? resolution : next.resolution ? (next.resolution.includes("720p") ? "720p" : next.resolution[0]) : "");
    if (!next.audio && audioChoice === "provider") setAudioChoice("none");
  }
  /** The choice is written on the shown version at once (admins); otherwise it waits for the next clip. */
  async function pickAudio(choice: AudioChoice, id: string | null) {
    setAudioChoice(choice);
    setAudioId(id);
    const v = shown ? videos.find((x) => x.id === shown) : videos[0];
    if (!v || inFlight(v) || !admin) return;
    try {
      const r = await chooseAudio(batchId, p.index, v.id, choice, id ?? undefined);
      setVideos(r.videos);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function load(): Promise<VideoList | null> {
    try {
      const r = await listVideos(batchId, p.index);
      setVideos(r.videos);
      setPrices(r.prices);
      setAdmin(r.admin);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
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
  async function make(confirm = false) {
    if (m.promptRequired && idea.trim().length < 5) return;
    setMaking(true);
    setError("");
    setNeedsConfirm(null);
    try {
      const artwork = withWords && composeArtwork ? await composeArtwork() : undefined;
      const r = await post<{ video: VideoItem }>("/api/studio/posts/video", {
        batch: batchId,
        index: p.index,
        prompt: idea.trim(),
        model,
        duration,
        aspect: aspect || undefined,
        resolution: resolution || undefined,
        audio: audioChoice === "provider",
        source: withWords ? "artwork" : "picture",
        artwork,
        confirm,
      });
      setVideos((v) => [r.video, ...v]);
      setShown(r.video.id);
      if (audioChoice === "upload" || audioChoice === "instagram") {
        // A track or the Instagram note belongs to the version, not to the engine: written as soon as the row exists.
        await chooseAudio(batchId, p.index, r.video.id, audioChoice, audioId ?? undefined)
          .then((x) => setVideos(x.videos))
          .catch((e: Error) => setError(e.message));
      }
      toast.success("The video is being made; it takes a minute or two.");
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.data.needsEstimate) setNeedsConfirm({});
      setError((e as Error).message);
      void load();
    } finally {
      setMaking(false);
    }
  }
  async function retry(id: string, confirm = false) {
    setMaking(true);
    setError("");
    setNeedsConfirm(null);
    try {
      const r = await retryVideo(batchId, id, confirm);
      setVideos((v) => [r.video, ...v]);
      setShown(r.video.id);
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.data.needsEstimate) setNeedsConfirm({ retryOf: id });
      setError((e as Error).message);
      void load();
    } finally {
      setMaking(false);
    }
  }
  async function select(id: string | null) {
    try {
      const r = await selectForClient(batchId, p.index, id);
      setVideos(r.videos);
      toast.success(id ? "This video goes to the client for review." : "The client sees the picture.");
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!open) return;
    setError("");
    setNeedsConfirm(null);
    setShown(null);
    void load().then((r) => {
      const last = r?.videos.find((v) => v.provider === "higgsfield") ?? null;
      if (last) {
        setIdea(last.prompt);
        pickModel(videoModel(last.model) ? last.model : DEFAULT_VIDEO_MODEL);
        if (last.duration) setDuration(last.duration);
        if (last.aspect) setAspect(last.aspect);
        if (last.resolution) setResolution(last.resolution);
        setWithWords(last.source === "artwork");
        if (last.audioChoice) {
          setAudioChoice(last.audioChoice);
          setAudioId(last.audioId);
        }
      } else void writeIdea();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, batchId, p.index]);
  // While a clip is being made, the list is asked again every few seconds (the server reconnects to the job).
  const pending = videos.some(inFlight);
  useEffect(() => {
    if (!open || !pending) return;
    polled.current = setInterval(() => void load().then((r) => r && !r.videos.some(inFlight) && onChanged?.()), 6000);
    return () => {
      if (polled.current) clearInterval(polled.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);
  const latest = (shown ? videos.find((v) => v.id === shown) : null) ?? videos[0];
  // Showing another version brings up its audio choice.
  useEffect(() => {
    if (latest?.audioChoice) {
      setAudioChoice(latest.audioChoice);
      setAudioId(latest.audioId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id]);
  const clientVersion = videos.find((v) => v.forClient) ?? null;
  const ideaTooLong = m.promptMax !== null && idea.length > m.promptMax;
  const canMake = !making && !writing && !pending && admin && (!m.promptRequired || idea.trim().length >= 5) && !ideaTooLong;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="animate-dialog video-dialog">
        <DialogHeader>
          <DialogTitle>
            <Clapperboard size={18} /> Video of post {String(p.index).padStart(2, "0")}
          </DialogTitle>
          <DialogDescription>The picture becomes a short ad clip on Higgsfield: the first frame is the post, the motion is the idea below. The product stays exactly as it is.</DialogDescription>
        </DialogHeader>
        <div className="overlay-editor-body">
          <div className="video-stage">
            {latest?.status === "done" && latest.url ? (
              <video key={latest.id} src={latest.url} controls playsInline preload="metadata" poster={latest.poster ?? src} />
            ) : (
              <img src={latest?.poster && latest.status !== "done" ? latest.poster : src} alt="" />
            )}
            {latest && inFlight(latest) && (
              <span className="video-making">
                <Orb variant="generate" size={18} status={null} /> {STATUS_TEXT[latest.status]}… a minute or two
              </span>
            )}
            {latest?.status === "failed" && (
              <span className="video-making failed">
                <TriangleAlert size={14} /> Failed · {latest.error}
              </span>
            )}
          </div>
          <div className="overlay-editor-controls">
            <label className="field-label">
              <Lightbulb size={13} /> The motion idea
            </label>
            <textarea rows={5} value={idea} placeholder={writing ? "Writing an idea from the picture…" : "What moves, and how"} onChange={(e) => setIdea(e.target.value)} disabled={writing} />
            <div className="video-idea-row">
              <button type="button" className="text-button" onClick={() => void writeIdea()} disabled={writing || making}>
                {writing ? <Orb size={13} /> : <RefreshCw size={13} />} Another idea
              </button>
              {m.promptMax !== null && (
                <small className={`field-hint ${ideaTooLong ? "warn" : ""}`}>
                  {idea.length}/{m.promptMax}
                </small>
              )}
            </div>
            <label className="field-label">Engine</label>
            <div className="preset-row">
              {VIDEO_MODELS.map((x) => (
                <button key={x.slug} type="button" className={`format-chip ${model === x.slug ? "active" : ""}`} onClick={() => pickModel(x.slug)} title={`${x.family} · ${x.note}`}>
                  {x.name}
                </button>
              ))}
            </div>
            <small className="field-hint">
              {m.note}.{" "}
              <a href={m.docs} target="_blank" rel="noreferrer" className="text-link">
                Model page
              </a>
            </small>
            <div className="video-settings">
              <label>
                <span>Length</span>
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {durationChoices(m).map((s) => (
                    <option key={s} value={s}>
                      {s} s
                    </option>
                  ))}
                </select>
              </label>
              {m.aspect && (
                <label>
                  <span>Frame</span>
                  <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                    <option value="">As the picture</option>
                    {m.aspect.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {m.resolution && (
                <label>
                  <span>Resolution</span>
                  <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                    {m.resolution.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="video-check video-words">
              <input type="checkbox" checked={withWords} disabled={!composeArtwork} onChange={(e) => setWithWords(e.target.checked)} />
              <span>
                <b>Include the words and logo in the video input</b>
                <small>The clip is made from the post as it will be published, words and logo drawn in. Nothing is overlaid after generation: the words move with the picture and cannot be changed later. Off, the clip is made from the bare picture.</small>
              </span>
            </label>
            <VideoAudio batchId={batchId} index={p.index} engineSound={m.audio !== null} engineName={m.name} admin={admin} version={latest && !inFlight(latest) ? latest : null} choice={audioChoice} audioId={audioId} onChange={(c, id) => void pickAudio(c, id)} />
            <small className="field-hint">
              {price !== null ? (
                <>About {usd(price)} per clip, from the admin's setting. Billed in Higgsfield credits, outside the month's picture budget.</>
              ) : (
                <>Cost not known yet: Higgsfield is asked for an estimate when the clip is made. If it gives none, an admin sets a price in Connection → Higgsfield, or confirms the clip at an unknown cost. Billed in credits, outside the month's picture budget.</>
              )}
            </small>
            {!admin && <small className="field-hint warn">Admins only for now: Higgsfield video is restricted until wider access is approved.</small>}
            {error && (
              <p className="video-error">
                <TriangleAlert size={14} /> {error}
                {/not connected/i.test(error) && <span> Add the Higgsfield Cloud key (cloud.higgsfield.ai) in Connection, bottom of the menu.</span>}
              </p>
            )}
            {needsConfirm && admin && (
              <div className="video-confirm">
                <button type="button" className="secondary" disabled={making} onClick={() => (needsConfirm.retryOf ? void retry(needsConfirm.retryOf, true) : void make(true))}>
                  Make it anyway, cost unknown
                </button>
                <small>Or set the price of {m.name} in Connection → Higgsfield first.</small>
              </div>
            )}
            <div className="footer-actions">
              <button type="button" className="primary" onClick={() => void make()} disabled={!canMake} title={!admin ? "Admins only for now" : undefined}>
                {making ? <Orb size={14} /> : <Clapperboard size={14} />} Make the video
              </button>
              {latest?.status === "failed" && admin && (
                <button type="button" className="secondary" disabled={making || pending} onClick={() => void retry(latest.id)} title="The same idea and settings submitted again as a new job">
                  <RefreshCw size={14} /> Try again
                </button>
              )}
              {latest?.status === "done" && latest.url && (
                <a className="secondary video-download" href={latest.url} download={`${fileBase}_post${String(p.index).padStart(2, "0")}_video${latest.version}.mp4`}>
                  <Download size={14} /> Download
                </a>
              )}
            </div>
            {videos.length > 0 && (
              <div className="video-versions">
                <span className="field-label">
                  <Users size={13} /> Versions · the client sees {clientVersion ? versionLabel(clientVersion) : "the picture"}
                </span>
                <ul className="video-history">
                  {videos.map((v) => (
                    <li key={v.id} className={`${v.status} ${v.id === latest?.id ? "shown" : ""} ${v.forClient ? "client" : ""}`}>
                      <button type="button" className="video-history-main" onClick={() => setShown(v.id)} title="Show this version above">
                        <span className={`pill ${v.status === "done" ? "ready" : v.status === "failed" ? "failed" : "queued"}`}>{STATUS_TEXT[v.status]}</span>
                        <b>{versionLabel(v)}</b>
                        <small>
                          {v.provider === "upload" ? "Uploaded" : videoModel(v.model)?.name ?? v.model}
                          {v.duration ? ` · ${v.duration}s` : ""}
                          {v.source === "artwork" ? " · with words" : v.source === "picture" ? " · bare picture" : ""}
                          {v.estimate !== null && v.estimate > 0 ? ` · ${usd(v.estimate)}` : ""}
                          {audioLine(v) ? ` · ${audioLine(v)}` : ""}
                        </small>
                      </button>
                      {v.status === "done" &&
                        (v.forClient ? (
                          <button type="button" className="text-button on" onClick={() => void select(null)} title="Show the client the picture instead">
                            <Check size={12} /> Client sees this
                          </button>
                        ) : (
                          <button type="button" className="text-button" onClick={() => void select(v.id)}>
                            Select for client review
                          </button>
                        ))}
                      {v.status === "failed" && v.error && <small className="video-fail">{v.error}</small>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
