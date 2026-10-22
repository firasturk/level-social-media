import { useEffect, useRef, useState } from "react";
import { Check, Clapperboard, Coins, Download, Lightbulb, RefreshCw, TriangleAlert, Users } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, post } from "@/api";
import { DEFAULT_VIDEO_MODEL, durationChoices, VIDEO_MODELS, videoModel } from "@shared/video-models";
import type { Post } from "@shared/posts";
import type { AudioChoice } from "@shared/video-audio";
import { frameRoute, type FrameFill, type FrameId } from "@shared/video-frame";
import { audioLine, chooseAudio, costLabel, engineLabel, frameLine, inFlight, inputLine, listVideos, MCP_PROVIDER, mcpEstimate, mcpGenerate, mcpModels as fetchMcpModels, mcpStatus, retryVideo, selectForClient, STATUS_TEXT, versionLabel, type HiggsfieldBilling, type HiggsfieldMcpStatus, type McpAsk, type McpVideoModel, type VideoItem, type VideoList } from "./videoApi";
import VideoAudio from "./VideoAudio";
import FrameControl, { useFrameChoice } from "./FrameControl";
import { composeFrame } from "@/video-editor/frame";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/**
 * A finished post set in motion: the motion director writes the idea from the picture, the
 * designer edits it, picks the engine and its settings, and Higgsfield makes a short clip from
 * the picture (or from the composed artwork, words and logo included) as its first frame. Every
 * clip stays with the post as a version; one of them can go to the client for review.
 *
 * Two ways to pay, chosen under Connection → Higgsfield: the subscription credits (the Higgsfield
 * sign-in; the engines come from the subscription's catalog, the cost is asked in credits before
 * the run) or the Cloud API key (pay per clip; the engines come from shared/video-models.ts).
 */
/** Engines shown before "More engines" unfolds the rest of the subscription's list. */
const ENGINES_SHOWN = 6;

export default function VideoDialog({
  open,
  batchId,
  post: p,
  src,
  fileBase,
  composeArtwork,
  onClose,
  onChanged,
  onEditVideo,
  onOpenStudio,
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
  /** Opens the Video editor on a finished version (trims, colour, music; the export becomes a new version). */
  onEditVideo?: (id: string) => void;
  /** Opens the Video studio on this post (the preset gallery, Generate, Enhance, Versions); the dialog closes. */
  onOpenStudio?: () => void;
}) {
  const [idea, setIdea] = useState("");
  const [model, setModel] = useState(DEFAULT_VIDEO_MODEL);
  const [duration, setDuration] = useState<number>(videoModel(DEFAULT_VIDEO_MODEL)!.duration.default);
  const [resolution, setResolution] = useState<string>("");
  /** The frame (a Reel 9:16 by default) and the fill, remembered per month; the picture is composed to it when the engine follows the picture. */
  const [frameChoice, setFrameChoice] = useFrameChoice(batchId);
  const framedRef = useRef<{ key: string; dataUrl: string } | null>(null);
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

  /* The subscription credits (Connection → Higgsfield → sign-in): its own engines, a cost step in credits before the run. */
  const [billing, setBilling] = useState<HiggsfieldBilling>("cloud");
  const [mcp, setMcp] = useState<HiggsfieldMcpStatus | null>(null);
  const [mcpModels, setMcpModels] = useState<McpVideoModel[]>([]);
  /** The engine list shows a handful first; the rest unfold. */
  const [moreEngines, setMoreEngines] = useState(false);
  const [mcpModel, setMcpModel] = useState("");
  const [mcpDuration, setMcpDuration] = useState<number | "">("");
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState("");
  const [cost, setCost] = useState<null | { credits: number | null; balance: number | null }>(null);
  const [costing, setCosting] = useState(false);
  /** Higgsfield asked whether to use the unlimited allowance for this engine or pay credits; the admin answers with one of two buttons. */
  const [unlim, setUnlim] = useState<unknown>(null);
  const artworkRef = useRef<string | null>(null);
  const credits = billing === "credits";
  const engine = mcpModels.find((x) => x.id === mcpModel) ?? null;

  function pickModel(slug: string) {
    const next = videoModel(slug);
    if (!next) return;
    setModel(slug);
    setDuration(next.duration.options?.includes(duration) || (!next.duration.options && duration >= (next.duration.min ?? 1) && duration <= (next.duration.max ?? 60)) ? duration : next.duration.default);
    setResolution(next.resolution?.includes(resolution) ? resolution : next.resolution ? (next.resolution.includes("720p") ? "720p" : next.resolution[0]) : "");
    if (!next.audio && audioChoice === "provider") setAudioChoice("none");
  }
  /** A changed ask has no cost yet: the credits are asked again before the run. */
  function resetCost() {
    setCost(null);
    setUnlim(null);
  }
  function pickMcpModel(id: string) {
    const next = mcpModels.find((x) => x.id === id);
    if (!next) return;
    setMcpModel(id);
    setMcpDuration(next.durations.length ? (typeof mcpDuration === "number" && next.durations.includes(mcpDuration) ? mcpDuration : next.durations.includes(5) ? 5 : next.durations[0]) : mcpDuration);
    if (audioChoice === "provider") setAudioChoice("none");
    resetCost();
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

  async function loadMcp(refresh = false, lastModel?: string | null) {
    setMcpLoading(true);
    setMcpError("");
    try {
      const s = await mcpStatus();
      setMcp(s);
      if (!s.signedIn || !s.admin) return;
      const r = await fetchMcpModels(refresh);
      setMcpModels(r.models);
      const pick = (lastModel && r.models.find((x) => x.id === lastModel)) || r.models.find((x) => x.id === mcpModel) || r.models[0];
      if (pick) {
        setMcpModel(pick.id);
        setMcpDuration(pick.durations.length ? (pick.durations.includes(5) ? 5 : pick.durations[0]) : "");
      }
    } catch (e) {
      setMcpError((e as Error).message);
    } finally {
      setMcpLoading(false);
    }
  }
  async function load(): Promise<VideoList | null> {
    try {
      const r = await listVideos(batchId, p.index);
      setVideos(r.videos);
      setPrices(r.prices);
      setAdmin(r.admin);
      setBilling(r.billing ?? "cloud");
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
      resetCost();
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
      const input = await framedInput(m.aspect);
      const r = await post<{ video: VideoItem }>("/api/studio/posts/video", {
        batch: batchId,
        index: p.index,
        prompt: idea.trim(),
        model,
        duration,
        aspect: frameRoute(frameChoice.frame, m.aspect).aspect,
        resolution: resolution || undefined,
        audio: audioChoice === "provider",
        ...input,
        confirm,
      });
      await afterSubmit(r.video);
    } catch (e) {
      if (e instanceof ApiError && e.data.needsEstimate) setNeedsConfirm({});
      setError((e as Error).message);
      void load();
    } finally {
      setMaking(false);
    }
  }
  async function afterSubmit(video: VideoItem) {
    setVideos((v) => [video, ...v]);
    setShown(video.id);
    if (audioChoice === "upload" || audioChoice === "instagram") {
      // A track or the Instagram note belongs to the version, not to the engine: written as soon as the row exists.
      await chooseAudio(batchId, p.index, video.id, audioChoice, audioId ?? undefined)
        .then((x) => setVideos(x.videos))
        .catch((e: Error) => setError(e.message));
    }
    toast.success("The video is being made; it takes a minute or two.");
    onChanged?.();
  }
  /**
   * The clip's first frame for an engine with these frame options: the picture or the artwork as it
   * is when the engine takes the frame itself; composed to the frame here (crop to fit, or blur the
   * edges) and sent as the artwork when the engine follows the picture. Composed once per cost step.
   */
  async function framedInput(aspects: readonly string[] | null | undefined): Promise<{ source: "picture" | "artwork"; artwork?: string; frame: FrameId; fill?: FrameFill; words: boolean }> {
    const { frame, fill } = frameChoice;
    const words = withWords && !!composeArtwork;
    if (words && !artworkRef.current) artworkRef.current = await composeArtwork!();
    const artwork = words ? (artworkRef.current ?? undefined) : undefined;
    const route = frameRoute(frame, aspects);
    if (!route.compose) return { source: words ? "artwork" : "picture", artwork, frame, words };
    const key = `${frame}:${fill}:${words ? "words" : "bare"}`;
    if (framedRef.current?.key !== key) framedRef.current = { key, dataUrl: await composeFrame(artwork ?? src, frame, fill) };
    return { source: "artwork", artwork: framedRef.current.dataUrl, frame, fill, words };
  }
  /** The ask the cost and the run share; the artwork composed once per cost step. */
  async function mcpAsk(): Promise<McpAsk> {
    const input = await framedInput(engine?.aspects ?? null);
    return {
      batch: batchId,
      index: p.index,
      model: mcpModel,
      prompt: idea.trim(),
      duration: typeof mcpDuration === "number" ? mcpDuration : undefined,
      aspect: frameRoute(frameChoice.frame, engine?.aspects ?? null).aspect,
      ...input,
    };
  }
  /** The cost in credits of exactly this clip; nothing is submitted. */
  async function getCost(useUnlim?: boolean) {
    setCosting(true);
    setError("");
    setUnlim(null);
    try {
      const r = await mcpEstimate({ ...(await mcpAsk()), useUnlim });
      setCost({ credits: r.credits, balance: r.balance });
      if (r.unlimChoice && useUnlim === undefined) setUnlim(r.unlimChoice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCosting(false);
    }
  }
  /** The run, confirmed with the credits shown; `useUnlim` answers Higgsfield's question when it asked one. */
  async function makeCredits(useUnlim?: boolean) {
    setMaking(true);
    setError("");
    try {
      const r = await mcpGenerate({ ...(await mcpAsk()), useUnlim, confirm: true });
      resetCost();
      await afterSubmit(r.video);
      void mcpStatus(true)
        .then(setMcp)
        .catch(() => undefined);
    } catch (e) {
      if (e instanceof ApiError && e.data.unlimChoice) setUnlim(e.data.unlimChoice);
      else if (e instanceof ApiError && e.data.outcomeUnknown) void load();
      setError((e as Error).message);
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
    resetCost();
    artworkRef.current = null;
    void load().then((r) => {
      const last = r?.videos.find((v) => v.provider === "higgsfield" || v.provider === MCP_PROVIDER) ?? null;
      if (r?.billing === "credits") void loadMcp(false, last?.provider === MCP_PROVIDER ? last.model : null);
      if (last) {
        setIdea(last.prompt);
        if (last.provider === "higgsfield") {
          pickModel(videoModel(last.model) ? last.model : DEFAULT_VIDEO_MODEL);
          if (last.resolution) setResolution(last.resolution);
        }
        if (last.duration) {
          setDuration(last.duration);
          setMcpDuration(last.duration);
        }
        // The frame is remembered per month in the browser, not read back from the last clip.
        setWithWords(last.words === true);
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
  const ideaTooLong = !credits && m.promptMax !== null && idea.length > m.promptMax;
  const canMake = !making && !writing && !pending && admin && (credits || !m.promptRequired || idea.trim().length >= 5) && !ideaTooLong;
  const canAskCost = canMake && !costing && !!mcp?.signedIn && !!engine;
  const cloudName = (slug: string) => videoModel(slug)?.name;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="animate-dialog video-dialog">
        <DialogHeader>
          <DialogTitle>
            <Clapperboard size={18} /> Video of post {String(p.index).padStart(2, "0")}
          </DialogTitle>
          <DialogDescription>
            The picture becomes a short ad clip on Higgsfield{credits ? ", paid from the subscription credits" : ""}: the first frame is the post, the motion is the idea below. The product stays exactly as it is.
          </DialogDescription>
        </DialogHeader>
        {onOpenStudio && (
          <button
            type="button"
            className="editor-open-photo-studio"
            onClick={() => {
              onClose();
              onOpenStudio();
            }}
            title="The full-screen video workspace: Higgsfield's presets with their reference videos, Generate, Edit, Enhance, Audio, Versions and Check"
          >
            <Clapperboard size={15} /> Open the Video studio <small>· presets, generate, edit, enhance, versions</small>
          </button>
        )}
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
            <textarea
              rows={5}
              value={idea}
              placeholder={writing ? "Writing an idea from the picture…" : "What moves, and how"}
              onChange={(e) => {
                setIdea(e.target.value);
                resetCost();
              }}
              disabled={writing}
            />
            <div className="video-idea-row">
              <button type="button" className="text-button" onClick={() => void writeIdea()} disabled={writing || making}>
                {writing ? <Orb size={13} /> : <RefreshCw size={13} />} Another idea
              </button>
              {!credits && m.promptMax !== null && (
                <small className={`field-hint ${ideaTooLong ? "warn" : ""}`}>
                  {idea.length}/{m.promptMax}
                </small>
              )}
            </div>
            {credits ? (
              <>
                <label className="field-label">
                  <Coins size={13} /> Engine · subscription catalog
                  {admin && mcp?.signedIn && (
                    <button type="button" className="text-button" style={{ marginLeft: "auto" }} onClick={() => void loadMcp(true, mcpModel)} disabled={mcpLoading} title="Ask Higgsfield for the current list of engines">
                      {mcpLoading ? <Orb size={12} /> : <RefreshCw size={12} />} Refresh list
                    </button>
                  )}
                </label>
                {mcp && !mcp.signedIn ? (
                  <p className="video-error">
                    <TriangleAlert size={14} /> Not signed in: Connection → Higgsfield → Sign in. Videos on the subscription credits run on that sign-in (or switch the billing to the Cloud API there).
                  </p>
                ) : mcpModels.length ? (
                  <div className="engine-chips">
                    {(moreEngines ? mcpModels : mcpModels.slice(0, ENGINES_SHOWN)).map((x) => (
                      <button key={x.id} type="button" className={`engine-chip ${mcpModel === x.id ? "active" : ""}`} onClick={() => pickMcpModel(x.id)} title={x.description || x.id}>
                        {x.name}
                      </button>
                    ))}
                    {mcpModels.length > ENGINES_SHOWN && (
                      <button type="button" className="engine-chip more" onClick={() => setMoreEngines((m) => !m)}>
                        {moreEngines ? "Fewer engines" : `More engines · ${mcpModels.length - ENGINES_SHOWN}`}
                      </button>
                    )}
                  </div>
                ) : (
                  <small className="field-hint">{mcpLoading ? "Reading the subscription's engines…" : mcpError || (admin ? "No engine list yet." : "Admins only for now.")}</small>
                )}
                {engine && (
                  <small className="field-hint">
                    {engine.description || engine.id}
                    {engine.supportsUnlim ? " · has an unlimited allowance on this plan (Higgsfield asks which to use)" : ""}
                  </small>
                )}
                <div className="video-settings">
                  <label>
                    <span>Length</span>
                    {engine?.durations.length ? (
                      <select
                        value={mcpDuration}
                        onChange={(e) => {
                          setMcpDuration(Number(e.target.value));
                          resetCost();
                        }}
                      >
                        {engine.durations.map((s) => (
                          <option key={s} value={s}>
                            {s} s
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        min={1}
                        max={60}
                        placeholder="engine default"
                        value={mcpDuration}
                        onChange={(e) => {
                          setMcpDuration(e.target.value === "" ? "" : Number(e.target.value));
                          resetCost();
                        }}
                      />
                    )}
                  </label>
                </div>
              </>
            ) : (
              <>
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
              </>
            )}
            <label className="field-label">Frame</label>
            <FrameControl
              variant="dialog"
              frame={frameChoice.frame}
              fill={frameChoice.fill}
              engine={credits ? (engine ? { name: engine.name, aspects: engine.aspects } : null) : { name: m.name, aspects: m.aspect }}
              onChange={(c) => {
                setFrameChoice(c);
                resetCost();
              }}
            />
            <label className="video-check video-words">
              <input
                type="checkbox"
                checked={withWords}
                disabled={!composeArtwork}
                onChange={(e) => {
                  setWithWords(e.target.checked);
                  artworkRef.current = null;
                  resetCost();
                }}
              />
              <span>
                <b>Include the words and logo in the video input</b>
                <small>The clip is made from the post as it will be published, words and logo drawn in. Nothing is overlaid after generation: the words move with the picture and cannot be changed later. Off, the clip is made from the bare picture.</small>
              </span>
            </label>
            <VideoAudio batchId={batchId} index={p.index} engineSound={credits ? false : m.audio !== null} engineName={credits ? (engine?.name ?? "the engine") : m.name} admin={admin} version={latest && !inFlight(latest) ? latest : null} choice={audioChoice} audioId={audioId} onChange={(c, id) => void pickAudio(c, id)} />
            {credits ? (
              <div className="hf-cost">
                {cost ? (
                  <small className="field-hint">
                    {cost.credits !== null ? (
                      <>
                        <b>About {cost.credits} credits</b>
                        {cost.balance !== null ? ` · balance ${cost.balance.toLocaleString("en-GB")}` : ""}. From the subscription, outside the month's picture budget.
                      </>
                    ) : (
                      <>Higgsfield gave no figure for this clip. You can make it at an unknown cost, or pick another engine.</>
                    )}
                  </small>
                ) : (
                  <small className="field-hint">
                    {mcp?.credits !== null && mcp?.credits !== undefined ? `Credits: ${mcp.credits.toLocaleString("en-GB")}${mcp.plan ? ` · ${mcp.plan}` : ""}. ` : ""}
                    The cost of exactly this clip is asked in credits before it runs; nothing is made by "Get the cost".
                  </small>
                )}
                {unlim != null && admin && (
                  <div className="video-confirm hf-unlim">
                    <small>Higgsfield asks: this engine has an unlimited allowance on your plan. Use it, or pay credits?</small>
                    <div className="footer-actions">
                      <button type="button" className="secondary" disabled={making} onClick={() => void makeCredits(true)}>
                        Use the unlimited allowance
                      </button>
                      <button type="button" className="secondary" disabled={making} onClick={() => void makeCredits(false)}>
                        Pay credits{cost?.credits !== null && cost?.credits !== undefined ? ` (${cost.credits})` : ""}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <small className="field-hint">
                {price !== null ? (
                  <>About {usd(price)} per clip, from the admin's setting. Billed in Higgsfield credits, outside the month's picture budget.</>
                ) : (
                  <>Cost not known yet: Higgsfield is asked for an estimate when the clip is made. If it gives none, an admin sets a price in Connection → Higgsfield, or confirms the clip at an unknown cost. Billed in credits, outside the month's picture budget.</>
                )}
              </small>
            )}
            {!admin && <small className="field-hint warn">Admins only for now: Higgsfield video is restricted until wider access is approved.</small>}
            {error && (
              <p className="video-error">
                <TriangleAlert size={14} /> {error}
                {!credits && /not connected/i.test(error) && <span> Add the Higgsfield Cloud key (cloud.higgsfield.ai) in Connection, bottom of the menu.</span>}
              </p>
            )}
            {needsConfirm && admin && !credits && (
              <div className="video-confirm">
                <button type="button" className="secondary" disabled={making} onClick={() => (needsConfirm.retryOf ? void retry(needsConfirm.retryOf, true) : void make(true))}>
                  Make it anyway, cost unknown
                </button>
                <small>Or set the price of {m.name} in Connection → Higgsfield first.</small>
              </div>
            )}
            <div className="footer-actions">
              {credits ? (
                !cost ? (
                  <button type="button" className="primary" onClick={() => void getCost()} disabled={!canAskCost} title={!admin ? "Admins only for now" : !mcp?.signedIn ? "Sign in under Connection → Higgsfield first" : undefined}>
                    {costing ? <Orb size={14} /> : <Coins size={14} />} Get the cost
                  </button>
                ) : cost.credits !== null ? (
                  <button type="button" className="primary" onClick={() => void makeCredits()} disabled={!canMake || unlim != null} title={unlim != null ? "Answer Higgsfield's question above first" : undefined}>
                    {making ? <Orb size={14} /> : <Clapperboard size={14} />} Make the video · {cost.credits} credits
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={() => void makeCredits()} disabled={!canMake}>
                    {making ? <Orb size={14} /> : <Clapperboard size={14} />} Make it anyway, cost unknown
                  </button>
                )
              ) : (
                <button type="button" className="primary" onClick={() => void make()} disabled={!canMake} title={!admin ? "Admins only for now" : undefined}>
                  {making ? <Orb size={14} /> : <Clapperboard size={14} />} Make the video
                </button>
              )}
              {latest?.status === "failed" && admin && latest.provider === "higgsfield" && !credits && (
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
                          {engineLabel(v, cloudName)}
                          {v.duration ? ` · ${v.duration}s` : ""}
                          {frameLine(v) ? ` · ${frameLine(v)}` : ""}
                          {inputLine(v) ? ` · ${inputLine(v)}` : ""}
                          {costLabel(v) ? ` · ${costLabel(v)}` : ""}
                          {audioLine(v) ? ` · ${audioLine(v)}` : ""}
                        </small>
                      </button>
                      {v.status === "done" &&
                        (v.forClient ? (
                          <button type="button" className="text-button on" onClick={() => void select(null)} title="Show the picture instead: the review link shows the picture, no clip">
                            <Check size={12} /> The client sees this
                          </button>
                        ) : (
                          <button type="button" className="text-button" onClick={() => void select(v.id)}>
                            Select for client review
                          </button>
                        ))}
                      {v.status === "done" && v.url && onEditVideo && (
                        <button type="button" className="text-button" onClick={() => onEditVideo(v.id)} title="Trim, colour, music and more; the export becomes a new version">
                          Edit in the Video editor
                        </button>
                      )}
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
