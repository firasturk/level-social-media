/**
 * Generate: a clip from this post's picture. The Video dialog's content, moved in: the motion idea
 * (written from the picture, dictated or typed), the Higgsfield engines (the subscription catalog
 * as compact chips with "Get the cost" and "Make the video · N credits" when the billing is the
 * credits; the Cloud catalog when it is the key), "Include the words and logo"; plus a Magnific
 * section: its video engines, the cost simulated, confirmed, then made with the picture as the
 * first keyframe. A preset's "Use this preset" lands here prefilled. Members see it read-only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Coins, Lightbulb, RefreshCw, Sparkles, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import VoiceInput, { appendDictation } from "@/components/VoiceInput";
import { ApiError, post as post_ } from "@/api";
import { DEFAULT_VIDEO_MODEL, durationChoices, VIDEO_MODELS, videoModel } from "@shared/video-models";
import { listVideos, MCP_PROVIDER, mcpEstimate, mcpGenerate, mcpModels as fetchMcpModels, mcpStatus, type HiggsfieldBilling, type HiggsfieldMcpStatus, type McpAsk, type McpVideoModel, type VideoItem } from "@/studio/videoApi";
import { magnificGenerate, magnificModels, magnificStatus, type ConfirmAsk, type MagnificStatus, type MagnificVideoModel } from "../../studioApi";
import type { StudioShared } from "./types";

const ENGINES_SHOWN = 6;
type Provider = "higgsfield" | "magnific";
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function GeneratePanel({ s }: { s: StudioShared }) {
  const post = s.post;
  const [idea, setIdea] = useState("");
  const [writing, setWriting] = useState(false);
  const [provider, setProvider] = useState<Provider>("higgsfield");
  const [withWords, setWithWords] = useState(false);
  const artworkRef = useRef<string | null>(null);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState("");
  const [fromPreset, setFromPreset] = useState<{ title: string; command: string | null } | null>(null);

  /* Higgsfield */
  const [billing, setBilling] = useState<HiggsfieldBilling>("cloud");
  const [admin, setAdmin] = useState(s.admin);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [mcp, setMcp] = useState<HiggsfieldMcpStatus | null>(null);
  const [engines, setEngines] = useState<McpVideoModel[]>([]);
  const [moreEngines, setMoreEngines] = useState(false);
  const [engineId, setEngineId] = useState("");
  const [mcpDuration, setMcpDuration] = useState<number | "">("");
  const [mcpAspect, setMcpAspect] = useState("");
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState("");
  const [cost, setCost] = useState<null | { credits: number | null; balance: number | null }>(null);
  const [costing, setCosting] = useState(false);
  const [unlim, setUnlim] = useState<unknown>(null);
  const [cloudModel, setCloudModel] = useState(DEFAULT_VIDEO_MODEL);
  const [cloudDuration, setCloudDuration] = useState<number>(videoModel(DEFAULT_VIDEO_MODEL)!.duration.default);
  const [cloudAspect, setCloudAspect] = useState("");
  const [cloudResolution, setCloudResolution] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const engine = engines.find((x) => x.id === engineId) ?? null;
  const credits = billing === "credits";
  const cm = videoModel(cloudModel) ?? VIDEO_MODELS[0];

  /* Magnific */
  const [mg, setMg] = useState<MagnificStatus | null>(null);
  const [mgModels, setMgModels] = useState<MagnificVideoModel[]>([]);
  const [mgMore, setMgMore] = useState(false);
  const [mgSlug, setMgSlug] = useState("");
  const [mgDuration, setMgDuration] = useState<number>(5);
  const [mgAspect, setMgAspect] = useState("");
  const [mgSfx, setMgSfx] = useState(false);
  const [mgLoading, setMgLoading] = useState(false);
  const [mgError, setMgError] = useState("");
  const [mgCost, setMgCost] = useState<number | null>(null);
  const mgEngine = mgModels.find((m) => m.slug === mgSlug) ?? null;

  const resetCost = useCallback(() => {
    setCost(null);
    setUnlim(null);
    setMgCost(null);
  }, []);

  const loadMcp = useCallback(
    async (refresh = false, wanted?: string | null) => {
      setMcpLoading(true);
      setMcpError("");
      try {
        const st = await mcpStatus();
        setMcp(st);
        if (!st.signedIn || !st.admin) return;
        const r = await fetchMcpModels(refresh);
        setEngines(r.models);
        setEngineId((cur) => {
          const pick = (wanted && (r.models.find((x) => x.id === wanted) ?? matchEngine(r.models, wanted))) || r.models.find((x) => x.id === cur) || r.models[0];
          if (pick && pick.id !== cur) {
            setMcpDuration(pick.durations.length ? (pick.durations.includes(5) ? 5 : pick.durations[0]) : "");
            setMcpAspect("");
          }
          return pick?.id ?? cur;
        });
      } catch (e) {
        setMcpError((e as Error).message);
      } finally {
        setMcpLoading(false);
      }
    },
    [],
  );
  const loadMagnific = useCallback(async (refresh = false) => {
    setMgLoading(true);
    setMgError("");
    try {
      const st = await magnificStatus();
      setMg(st);
      if (!st.connected || !st.admin || !st.access.enabled) return;
      const r = await magnificModels(refresh);
      const sorted = [...r.models].filter((m) => m.imageToVideo).sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));
      setMgModels(sorted);
      setMgSlug((cur) => {
        const pick = sorted.find((m) => m.slug === cur) ?? sorted[0];
        if (pick && pick.slug !== cur) setMgDuration(pick.durations.length ? (pick.durations.includes(5) ? 5 : pick.durations[0]) : 5);
        return pick?.slug ?? cur;
      });
    } catch (e) {
      setMgError((e as Error).message);
    } finally {
      setMgLoading(false);
    }
  }, []);

  /* The idea: the last clip's, the preset's, or one written from the picture. */
  async function writeIdea() {
    if (!post) return;
    setWriting(true);
    setError("");
    try {
      const r = await post_<{ idea: string }>("/api/studio/posts/video/idea", { batch: post.batch, index: post.index });
      setIdea(r.idea);
      resetCost();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriting(false);
    }
  }
  useEffect(() => {
    if (!post) return;
    let alive = true;
    void (async () => {
      try {
        const r = await listVideos(post.batch, post.index);
        if (!alive) return;
        setPrices(r.prices);
        setAdmin(r.admin);
        setBilling(r.billing ?? "cloud");
        const last = r.videos.find((v) => v.provider === "higgsfield" || v.provider === MCP_PROVIDER) ?? null;
        if (r.billing === "credits") void loadMcp(false, last?.provider === MCP_PROVIDER ? last.model : null);
        if (last && !s.prefill) {
          setIdea(last.prompt);
          if (last.provider === "higgsfield" && videoModel(last.model)) setCloudModel(last.model);
          if (last.duration) {
            setCloudDuration(last.duration);
            setMcpDuration(last.duration);
          }
          if (last.aspect) {
            setCloudAspect(last.aspect);
            setMcpAspect(last.aspect);
          }
          setWithWords(last.source === "artwork");
        } else if (!last && !s.prefill) void writeIdea();
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    void loadMagnific();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.batch, post?.index]);
  // "Use this preset" hands over its words and engine.
  useEffect(() => {
    if (!s.prefill) return;
    setIdea(s.prefill.prompt);
    setFromPreset({ title: s.prefill.presetTitle, command: s.prefill.presetCommand });
    setProvider("higgsfield");
    resetCost();
    if (s.prefill.engine) {
      const hit = matchEngine(engines, s.prefill.engine);
      if (hit) setEngineId(hit.id);
      const cloud = VIDEO_MODELS.find((m) => squash(m.name) === squash(s.prefill!.engine!) || squash(m.slug).includes(squash(s.prefill!.engine!)));
      if (cloud) setCloudModel(cloud.slug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.prefill?.at]);

  async function artworkOrNull(): Promise<string | undefined> {
    if (!withWords || !s.composeArtwork) return undefined;
    if (!artworkRef.current) artworkRef.current = await s.composeArtwork();
    return artworkRef.current;
  }
  async function afterSubmit(video: VideoItem, words: string) {
    await s.reloadVideos();
    s.setShownId(video.id);
    s.onChanged?.();
    toast.success(words);
  }
  async function mcpAsk(): Promise<McpAsk> {
    return { batch: post!.batch, index: post!.index, model: engineId, prompt: idea.trim(), duration: typeof mcpDuration === "number" ? mcpDuration : undefined, aspect: mcpAspect || undefined, source: withWords ? "artwork" : "picture", artwork: await artworkOrNull() };
  }
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
  async function makeCredits(useUnlim?: boolean) {
    setMaking(true);
    setError("");
    try {
      const r = await mcpGenerate({ ...(await mcpAsk()), useUnlim, confirm: true, note: fromPreset ? `from the preset ${fromPreset.command ?? fromPreset.title}` : undefined });
      resetCost();
      await afterSubmit(r.video, "The video is being made on the subscription credits; it takes a minute or two.");
      void mcpStatus(true).then(setMcp).catch(() => undefined);
    } catch (e) {
      const err = e as ApiError;
      if (err.data?.unlimChoice) setUnlim(err.data.unlimChoice);
      else if (err.data?.outcomeUnknown) void s.reloadVideos();
      setError(err.message);
    } finally {
      setMaking(false);
    }
  }
  async function makeCloud(confirm = false) {
    if (!post) return;
    setMaking(true);
    setError("");
    setNeedsConfirm(false);
    try {
      const r = await post_<{ video: VideoItem }>("/api/studio/posts/video", { batch: post.batch, index: post.index, prompt: idea.trim(), model: cloudModel, duration: cloudDuration, aspect: cloudAspect || undefined, resolution: cloudResolution || undefined, source: withWords ? "artwork" : "picture", artwork: await artworkOrNull(), confirm });
      await afterSubmit(r.video, "The video is being made; it takes a minute or two.");
    } catch (e) {
      const err = e as ApiError;
      if (err.data?.needsEstimate) setNeedsConfirm(true);
      setError(err.message);
    } finally {
      setMaking(false);
    }
  }
  async function makeMagnific(confirm = false) {
    if (!post || !mgEngine) return;
    setMaking(true);
    setError("");
    try {
      const r = await magnificGenerate({ batch: post.batch, index: post.index, slug: mgEngine.slug, prompt: idea.trim(), duration: mgDuration, aspectRatio: mgAspect || undefined, source: withWords ? "artwork" : "picture", artwork: await artworkOrNull(), withSoundEffects: mgSfx || undefined, confirm });
      setMgCost(null);
      await afterSubmit(r.video, "Magnific is making the video; it takes a minute or two.");
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && d.needsConfirm) setMgCost(d.estimate ?? null);
      else setError(err.message);
    } finally {
      setMaking(false);
    }
  }

  if (!post) return null;
  const readOnly = !admin;
  const pending = s.videos.some((v) => v.status === "queued" || v.status === "generating");
  const ideaTooLong = provider === "higgsfield" && !credits && cm.promptMax !== null && idea.length > cm.promptMax;
  const canMake = !making && !writing && !pending && admin && !!s.pictureUrl && !ideaTooLong;
  const canAskCost = canMake && !costing && !!mcp?.signedIn && !!engine;
  const mgReady = !!mg?.connected && mg.admin && mg.access.enabled;

  return (
    <div className="vs-panel">
      <div className="ts-panel-head">
        <span>
          <Sparkles size={13} /> Generate
        </span>
        <small>{pending ? "a clip is being made" : "from this post's picture"}</small>
      </div>
      {fromPreset && (
        <p className="vs-note vs-from-preset">
          <Sparkles size={12} /> From the preset <b>{fromPreset.title}</b>
          {fromPreset.command ? <em className="vs-chip cmd">{fromPreset.command}</em> : null}
          <button type="button" className="ts-icon" onClick={() => setFromPreset(null)} aria-label="Forget the preset">
            <X size={11} />
          </button>
        </p>
      )}
      <label className="ts-group-title" htmlFor="vs-idea">
        <Lightbulb size={12} /> The motion idea
      </label>
      <textarea id="vs-idea" className="vs-idea" rows={4} value={idea} placeholder={writing ? "Writing an idea from the picture…" : "What moves, and how"} disabled={writing || readOnly} onChange={(e) => { setIdea(e.target.value); resetCost(); }} />
      <div className="vs-row">
        <button type="button" className="ts-mini" onClick={() => void writeIdea()} disabled={writing || making || readOnly} title="An idea written from the picture by the text model">
          {writing ? <Orb size={12} status={null} /> : <RefreshCw size={12} />} Another idea
        </button>
        <VoiceInput label="Dictate the idea" onText={(t) => setIdea((i) => appendDictation(i, t))} disabled={writing || readOnly} />
        {provider === "higgsfield" && !credits && cm.promptMax !== null && <small className={`vs-count ${ideaTooLong ? "warn" : ""}`}>{idea.length}/{cm.promptMax}</small>}
      </div>

      <span className="ts-group-title">Made by</span>
      <div className="vs-seg" role="tablist" aria-label="Provider">
        <button type="button" role="tab" aria-selected={provider === "higgsfield"} className={provider === "higgsfield" ? "on" : ""} onClick={() => { setProvider("higgsfield"); resetCost(); }}>
          Higgsfield{credits ? " · credits" : " · Cloud key"}
        </button>
        <button type="button" role="tab" aria-selected={provider === "magnific"} className={provider === "magnific" ? "on" : ""} onClick={() => { setProvider("magnific"); resetCost(); }}>
          Magnific
        </button>
      </div>

      {provider === "higgsfield" && credits && (
        <>
          <div className="vs-row vs-between">
            <span className="ts-group-title">Engine · subscription catalog</span>
            {admin && mcp?.signedIn && (
              <button type="button" className="ts-link" onClick={() => void loadMcp(true, engineId)} disabled={mcpLoading} title="Ask Higgsfield for today's engines">
                {mcpLoading ? <Orb size={11} status={null} /> : <RefreshCw size={11} />} Refresh list
              </button>
            )}
          </div>
          {mcp && !mcp.signedIn ? (
            <p className="ts-hint warn">
              <TriangleAlert size={12} /> Not signed in: Connection → Higgsfield → Sign in. Videos on the subscription credits run on that sign-in (or switch the billing to the Cloud API there).
            </p>
          ) : engines.length ? (
            <div className="vs-engines">
              {(moreEngines ? engines : engines.slice(0, ENGINES_SHOWN)).map((x) => (
                <button key={x.id} type="button" className={`vs-engine ${engineId === x.id ? "on" : ""}`} disabled={readOnly} title={x.description || x.id} onClick={() => { setEngineId(x.id); setMcpDuration(x.durations.length ? (typeof mcpDuration === "number" && x.durations.includes(mcpDuration) ? mcpDuration : x.durations.includes(5) ? 5 : x.durations[0]) : mcpDuration); setMcpAspect(x.aspects.includes(mcpAspect) ? mcpAspect : ""); resetCost(); }}>
                  {x.name}
                </button>
              ))}
              {engines.length > ENGINES_SHOWN && (
                <button type="button" className="vs-engine more" onClick={() => setMoreEngines((m) => !m)}>
                  {moreEngines ? "Fewer engines" : `More engines · ${engines.length - ENGINES_SHOWN}`}
                </button>
              )}
            </div>
          ) : (
            <p className="ts-hint">{mcpLoading ? "Reading the subscription's engines…" : mcpError || (admin ? "No engine list yet." : "Admins only for now.")}</p>
          )}
          {engine && <p className="ts-hint">{engine.description || engine.id}{engine.supportsUnlim ? " · has an unlimited allowance on this plan (Higgsfield asks which to use)" : ""}</p>}
          <div className="vs-settings">
            <label>
              <span>Length</span>
              {engine?.durations.length ? (
                <select value={mcpDuration} disabled={readOnly} onChange={(e) => { setMcpDuration(Number(e.target.value)); resetCost(); }}>
                  {engine.durations.map((d) => (
                    <option key={d} value={d}>
                      {d} s
                    </option>
                  ))}
                </select>
              ) : (
                <input type="number" min={1} max={60} placeholder="engine default" value={mcpDuration} disabled={readOnly} onChange={(e) => { setMcpDuration(e.target.value === "" ? "" : Number(e.target.value)); resetCost(); }} />
              )}
            </label>
            {engine && engine.aspects.length > 0 && (
              <label>
                <span>Frame</span>
                <select value={mcpAspect} disabled={readOnly} onChange={(e) => { setMcpAspect(e.target.value); resetCost(); }}>
                  <option value="">As the picture</option>
                  {engine.aspects.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </>
      )}
      {provider === "higgsfield" && !credits && (
        <>
          <span className="ts-group-title">Engine · Cloud API</span>
          <div className="vs-engines">
            {VIDEO_MODELS.map((x) => (
              <button key={x.slug} type="button" className={`vs-engine ${cloudModel === x.slug ? "on" : ""}`} disabled={readOnly} title={`${x.family} · ${x.note}`} onClick={() => { setCloudModel(x.slug); setCloudDuration(x.duration.options?.includes(cloudDuration) || (!x.duration.options && cloudDuration >= (x.duration.min ?? 1) && cloudDuration <= (x.duration.max ?? 60)) ? cloudDuration : x.duration.default); setCloudAspect(x.aspect?.includes(cloudAspect) ? cloudAspect : ""); setCloudResolution(x.resolution?.includes(cloudResolution) ? cloudResolution : x.resolution ? (x.resolution.includes("720p") ? "720p" : x.resolution[0]) : ""); }}>
                {x.name}
              </button>
            ))}
          </div>
          <p className="ts-hint">
            {cm.note}.{" "}
            <a href={cm.docs} target="_blank" rel="noreferrer" className="ts-link">
              Model page
            </a>
          </p>
          <div className="vs-settings">
            <label>
              <span>Length</span>
              <select value={cloudDuration} disabled={readOnly} onChange={(e) => setCloudDuration(Number(e.target.value))}>
                {durationChoices(cm).map((d) => (
                  <option key={d} value={d}>
                    {d} s
                  </option>
                ))}
              </select>
            </label>
            {cm.aspect && (
              <label>
                <span>Frame</span>
                <select value={cloudAspect} disabled={readOnly} onChange={(e) => setCloudAspect(e.target.value)}>
                  <option value="">As the picture</option>
                  {cm.aspect.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {cm.resolution && (
              <label>
                <span>Resolution</span>
                <select value={cloudResolution} disabled={readOnly} onChange={(e) => setCloudResolution(e.target.value)}>
                  {cm.resolution.map((r) => (
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
      {provider === "magnific" && (
        <>
          <div className="vs-row vs-between">
            <span className="ts-group-title">Engine · Magnific</span>
            {mgReady && (
              <button type="button" className="ts-link" onClick={() => void loadMagnific(true)} disabled={mgLoading} title="Ask Magnific for today's engines">
                {mgLoading ? <Orb size={11} status={null} /> : <RefreshCw size={11} />} Refresh list
              </button>
            )}
          </div>
          {mg && !mg.connected && (
            <p className="ts-hint warn">
              <TriangleAlert size={12} /> {mg.reason}
            </p>
          )}
          {mg && mg.connected && !mg.admin && <p className="ts-hint warn">Admins only for now: Magnific runs are limited to admins until the integration is approved for the whole team.</p>}
          {mg && mg.connected && mg.admin && !mg.access.enabled && <p className="ts-hint warn">{mg.access.reason}</p>}
          {mgError && <p className="ts-hint warn">{mgError}</p>}
          {mgReady && mgModels.length > 0 && (
            <div className="vs-engines">
              {(mgMore ? mgModels : mgModels.slice(0, ENGINES_SHOWN)).map((m) => (
                <button key={m.slug} type="button" className={`vs-engine ${mgSlug === m.slug ? "on" : ""}`} title={m.recommendation || m.description || m.slug} onClick={() => { setMgSlug(m.slug); setMgDuration(m.durations.length ? (m.durations.includes(mgDuration) ? mgDuration : m.durations.includes(5) ? 5 : m.durations[0]) : mgDuration); setMgAspect(m.aspectRatios.includes(mgAspect) ? mgAspect : ""); resetCost(); }}>
                  {m.name}
                  {m.recommended ? " ★" : ""}
                </button>
              ))}
              {mgModels.length > ENGINES_SHOWN && (
                <button type="button" className="vs-engine more" onClick={() => setMgMore((m) => !m)}>
                  {mgMore ? "Fewer engines" : `More engines · ${mgModels.length - ENGINES_SHOWN}`}
                </button>
              )}
            </div>
          )}
          {mgReady && !mgModels.length && <p className="ts-hint">{mgLoading ? "Reading Magnific's engines…" : "No engine list yet."}</p>}
          {mgEngine && <p className="ts-hint">{mgEngine.recommendation || mgEngine.description || mgEngine.slug}</p>}
          {mgReady && (
            <div className="vs-settings">
              <label>
                <span>Length</span>
                {mgEngine?.durations.length ? (
                  <select value={mgDuration} onChange={(e) => { setMgDuration(Number(e.target.value)); resetCost(); }}>
                    {mgEngine.durations.map((d) => (
                      <option key={d} value={d}>
                        {d} s
                      </option>
                    ))}
                  </select>
                ) : (
                  <input type="number" min={1} max={60} value={mgDuration} onChange={(e) => { setMgDuration(Number(e.target.value) || 5); resetCost(); }} />
                )}
              </label>
              {mgEngine && mgEngine.aspectRatios.length > 0 && (
                <label>
                  <span>Frame</span>
                  <select value={mgAspect} onChange={(e) => { setMgAspect(e.target.value); resetCost(); }}>
                    <option value="">As the picture</option>
                    {mgEngine.aspectRatios.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="vs-check">
                <input type="checkbox" checked={mgSfx} onChange={(e) => { setMgSfx(e.target.checked); resetCost(); }} /> With sound effects
              </label>
            </div>
          )}
        </>
      )}

      <label className="vs-check vs-words">
        <input type="checkbox" checked={withWords} disabled={!s.composeArtwork || readOnly} onChange={(e) => { setWithWords(e.target.checked); artworkRef.current = null; resetCost(); }} />
        <span>
          <b>Include the words and logo in the video input</b>
          <small>The clip is made from the post as it will be published, words and logo drawn in; they move with the picture and cannot be changed later. Off, the clip is made from the bare picture.</small>
        </span>
      </label>

      {/* The cost line and the actions */}
      {provider === "higgsfield" && credits && (
        <div className="vs-cost">
          {cost ? (
            <p className="ts-hint">
              {cost.credits !== null ? (
                <>
                  <b>About {cost.credits} credits</b>
                  {cost.balance !== null ? ` · balance ${cost.balance.toLocaleString("en-GB")}` : ""}. From the subscription, outside the month's picture budget.
                </>
              ) : (
                <>Higgsfield gave no figure for this clip. You can make it at an unknown cost, or pick another engine.</>
              )}
            </p>
          ) : (
            <p className="ts-hint">
              {mcp?.credits != null ? `Credits: ${mcp.credits.toLocaleString("en-GB")}${mcp.plan ? ` · ${mcp.plan}` : ""}. ` : ""}
              The cost of exactly this clip is asked in credits before it runs; "Get the cost" makes nothing.
            </p>
          )}
          {unlim != null && admin && (
            <div className="vs-unlim">
              <small>Higgsfield asks: this engine has an unlimited allowance on your plan. Use it, or pay credits?</small>
              <div className="vs-row">
                <button type="button" className="ts-mini" disabled={making} onClick={() => void makeCredits(true)}>
                  Use the unlimited allowance
                </button>
                <button type="button" className="ts-mini" disabled={making} onClick={() => void makeCredits(false)}>
                  Pay credits{cost?.credits != null ? ` (${cost.credits})` : ""}
                </button>
              </div>
            </div>
          )}
          {!cost ? (
            <button type="button" className="ts-btn primary vs-cta" onClick={() => void getCost()} disabled={!canAskCost} title={!admin ? "Admins only for now" : !mcp?.signedIn ? "Sign in under Connection → Higgsfield first" : undefined}>
              {costing ? <Orb size={14} status={null} /> : <Coins size={14} />} Get the cost
            </button>
          ) : cost.credits !== null ? (
            <button type="button" className="ts-btn primary vs-cta" onClick={() => void makeCredits()} disabled={!canMake || unlim != null} title={unlim != null ? "Answer Higgsfield's question above first" : undefined}>
              {making ? <Orb size={14} status={null} /> : <Clapperboard size={14} />} Make the video · {cost.credits} credits
            </button>
          ) : (
            <button type="button" className="ts-btn vs-cta" onClick={() => void makeCredits()} disabled={!canMake}>
              {making ? <Orb size={14} status={null} /> : <Clapperboard size={14} />} Make it anyway, cost unknown
            </button>
          )}
        </div>
      )}
      {provider === "higgsfield" && !credits && (
        <div className="vs-cost">
          <p className="ts-hint">{prices[cloudModel] != null ? `About ${usd(prices[cloudModel]!)} per clip, from the admin's setting. Billed in Higgsfield credits, outside the month's picture budget.` : "Cost not known yet: Higgsfield is asked for an estimate when the clip is made. If it gives none, an admin sets a price in Connection → Higgsfield, or confirms the clip at an unknown cost."}</p>
          <button type="button" className="ts-btn primary vs-cta" onClick={() => void makeCloud()} disabled={!canMake || (cm.promptRequired && idea.trim().length < 5)} title={!admin ? "Admins only for now" : undefined}>
            {making ? <Orb size={14} status={null} /> : <Clapperboard size={14} />} Make the video
          </button>
          {needsConfirm && admin && (
            <button type="button" className="ts-btn vs-cta" disabled={making} onClick={() => void makeCloud(true)}>
              Make it anyway, cost unknown
            </button>
          )}
        </div>
      )}
      {provider === "magnific" && (
        <div className="vs-cost">
          {mgCost !== null ? (
            <p className="ts-hint">
              <b>About {mgCost} credits</b> from the Magnific balance (simulated for exactly this clip).
            </p>
          ) : (
            <p className="ts-hint">The cost is simulated by Magnific before the clip runs; nothing is made by "Get the cost". A clip whose cost cannot be simulated is not made.</p>
          )}
          {mgCost === null ? (
            <button type="button" className="ts-btn primary vs-cta" onClick={() => void makeMagnific(false)} disabled={!canMake || !mgReady || !mgEngine} title={!mgReady ? (mg?.reason || "Admins only for now") : undefined}>
              {making ? <Orb size={14} status={null} /> : <Coins size={14} />} Get the cost
            </button>
          ) : (
            <button type="button" className="ts-btn primary vs-cta" onClick={() => void makeMagnific(true)} disabled={!canMake || !mgReady || !mgEngine}>
              {making ? <Orb size={14} status={null} /> : <Clapperboard size={14} />} Make the video · {mgCost} credits
            </button>
          )}
        </div>
      )}
      {!admin && <p className="ts-hint warn">Admins only for now: making a video is limited to admins until wider access is approved.</p>}
      {!s.pictureUrl && <p className="ts-hint warn">This post has no picture yet: a clip starts from the picture.</p>}
      {error && (
        <p className="ts-hint warn">
          <TriangleAlert size={12} /> {error}
          {provider === "higgsfield" && !credits && /not connected/i.test(error) ? " Add the Higgsfield Cloud key (cloud.higgsfield.ai) in Connection, bottom of the menu." : ""}
        </p>
      )}
    </div>
  );
}

/** The subscription engine a preset's engine name points at ("Seedance 2.5" → seedance_2_5), when one does. */
function matchEngine(models: McpVideoModel[], wanted: string): McpVideoModel | null {
  const w = squash(wanted);
  if (!w) return null;
  return models.find((m) => squash(m.id) === w || squash(m.name) === w) ?? models.find((m) => squash(m.name).includes(w) || w.includes(squash(m.name)) || squash(m.id).includes(w)) ?? null;
}
