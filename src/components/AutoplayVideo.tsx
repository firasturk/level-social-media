/**
 * The one video preview of Level Studio (shared/video-preview.ts has the rules): a visible video
 * plays by itself, muted, inline and looping, with a sound toggle; it pauses off screen, in a
 * background tab and in a closed dialog; a person's pause wins and the playhead is never moved;
 * reduced motion keeps the poster with a Play button; a refused autoplay or a broken file shows a
 * Play button over the poster instead of a black box. Only one video is audible at a time, and at
 * most a handful play at once (the most visible ones).
 *
 * The media is not fetched until the video is near the screen (`src` is set then, `preload` is
 * "metadata"), so a long page of cards does not download every clip. Use the lightweight preview
 * file for cards and galleries (`src` = the preview, the full file stays for editing and export).
 *
 * `mode`:
 *   - "preview" (cards, galleries, presets): no native controls; sound and pause buttons in a corner.
 *   - "player" (dialogs, client review, version stages): native controls (seek, volume, fullscreen
 *     where the browser offers it), starting muted; the sound button stays for the first unmute.
 *   - "editor" (a working preview a timeline drives): never autoplayed; it only takes part in the
 *     one-audible-video rule and the background-tab pause.
 */
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { allowedToPlay, decidePlayback, MAX_PLAYING, nextAudible, PRELOAD_MARGIN, VISIBLE_RATIO } from "@shared/video-preview";

export interface AutoplayVideoProps {
  src: string | null | undefined;
  poster?: string | null;
  mode?: "preview" | "player" | "editor";
  /** The surface is open (a dialog, a panel, a tab of the editor). False pauses the video. */
  active?: boolean;
  /** Loop the clip (default: true for previews, false for players). */
  loop?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Shown to screen readers and as the title of the buttons. */
  label?: string;
  /** Extra content drawn over the video (a tag, a badge). */
  children?: ReactNode;
  onError?: () => void;
  /** Called with the element once it exists (for editors that read `currentTime`). */
  onElement?: (el: HTMLVideoElement | null) => void;
  /** No corner buttons (the surface draws its own). */
  bare?: boolean;
}

/* ───────────── The page's registry: the cap, the one audible video, the background tab ───────────── */

interface Entry {
  id: string;
  ratio: number;
  wants: boolean;
  priority: boolean;
  apply: (allowed: boolean) => void;
  mute: () => void;
}

const entries = new Map<string, Entry>();
let audible: string | null = null;
let scheduled = false;

function rebalance(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const wanting = [...entries.values()].filter((e) => e.wants);
    const allowed = allowedToPlay(wanting.map((e) => ({ id: e.id, ratio: e.ratio, priority: e.priority })), MAX_PLAYING);
    for (const e of entries.values()) e.apply(allowed.has(e.id));
  });
}

function claimSound(id: string, wantsSound: boolean): void {
  const next = nextAudible(audible, id, wantsSound);
  if (next.mute) entries.get(next.mute)?.mute();
  audible = next.audible;
}

const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* ───────────── The component ───────────── */

export const AutoplayVideo = forwardRef<HTMLVideoElement | null, AutoplayVideoProps>(function AutoplayVideo(
  { src, poster, mode = "preview", active = true, loop, className, style, label, children, onError, onElement, bare },
  ref,
) {
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  useImperativeHandle(ref, () => video.current as HTMLVideoElement, []);

  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [hidden, setHidden] = useState(tabHidden());
  const [reduced] = useState(reducedMotion());
  const [userPaused, setUserPaused] = useState(false);
  const [userStarted, setUserStarted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [allowed, setAllowed] = useState(true);
  // Our own play()/pause() calls, so the element's events can tell them from a person's.
  const ours = useRef<"play" | "pause" | null>(null);

  const autoplay = mode !== "editor";
  const visible = ratio >= VISIBLE_RATIO;
  const decision = decidePlayback({ visible, active, tabHidden: hidden, userPaused, reducedMotion: reduced, autoplay, blocked: blocked || failed, userStarted });

  // A new file is a new clip: the person's earlier choices on the old one do not carry over.
  useEffect(() => {
    setUserPaused(false);
    setUserStarted(false);
    setBlocked(false);
    setFailed(false);
  }, [src]);

  // On screen, and near it (to start loading a little before it arrives).
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      setRatio(1);
      return;
    }
    const nearObs = new IntersectionObserver((list) => list.forEach((e) => e.isIntersecting && setNear(true)), { rootMargin: PRELOAD_MARGIN });
    const seenObs = new IntersectionObserver((list) => list.forEach((e) => setRatio(e.isIntersecting ? e.intersectionRatio : 0)), { threshold: [0, 0.15, VISIBLE_RATIO, 0.6, 0.85, 1] });
    nearObs.observe(el);
    seenObs.observe(el);
    return () => {
      nearObs.disconnect();
      seenObs.disconnect();
    };
  }, []);

  useEffect(() => {
    const on = () => setHidden(tabHidden());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // The page's registry: the cap on playing previews and the one audible video.
  useEffect(() => {
    entries.set(id, {
      id,
      ratio: 0,
      wants: false,
      priority: false,
      apply: (ok) => setAllowed(ok),
      mute: () => {
        const v = video.current;
        if (v) v.muted = true;
        setMuted(true);
      },
    });
    return () => {
      entries.delete(id);
      if (audible === id) audible = null;
      rebalance();
    };
  }, [id]);
  useEffect(() => {
    const e = entries.get(id);
    if (!e) return;
    e.ratio = ratio;
    e.wants = decision === "play";
    e.priority = userStarted || !muted;
    rebalance();
  }, [id, ratio, decision, userStarted, muted]);

  const tryPlay = useCallback(async () => {
    const v = video.current;
    if (!v || !v.paused) return;
    ours.current = "play";
    try {
      await v.play();
      setBlocked(false);
    } catch (e) {
      ours.current = null;
      // NotAllowedError (a policy refused it) shows the Play button; an AbortError (a newer pause) is fine.
      if (e instanceof DOMException && e.name === "NotAllowedError") setBlocked(true);
    }
  }, []);

  const doPause = useCallback(() => {
    const v = video.current;
    if (!v || v.paused) return;
    ours.current = "pause";
    v.pause();
  }, []);

  // Apply the decision. "hold" leaves the element as it is.
  useEffect(() => {
    if (!near || !src) return;
    if (decision === "play" && allowed) void tryPlay();
    else if (decision === "pause" || (decision === "play" && !allowed)) doPause();
  }, [decision, allowed, near, src, tryPlay, doPause]);

  // The element's own events: a pause or play we did not ask for is the person's (native controls).
  const onPlay = () => {
    setPlaying(true);
    if (ours.current === "play") ours.current = null;
    else {
      setUserPaused(false);
      setUserStarted(true);
    }
  };
  const onPause = () => {
    setPlaying(false);
    if (ours.current === "pause") ours.current = null;
    else if (video.current && !video.current.ended) setUserPaused(true);
  };
  const onVolume = () => {
    const v = video.current;
    if (!v) return;
    setMuted(v.muted);
    if (!v.muted) claimSound(id, true);
  };

  const toggleSound = () => {
    const v = video.current;
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    setMuted(next);
    claimSound(id, !next);
    if (!next && v.paused) {
      setUserPaused(false);
      setUserStarted(true);
      void tryPlay();
    }
  };
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      setUserPaused(false);
      setUserStarted(true);
      setBlocked(false);
      ours.current = null; // a person's play, counted as such by onPlay
      void v.play().catch(() => setBlocked(true));
    } else {
      setUserPaused(true);
      ours.current = null;
      v.pause();
    }
  };

  const setEl = (el: HTMLVideoElement | null) => {
    video.current = el;
    if (el) {
      // iPhone Safari before 10 and some in-app browsers read the prefixed attribute.
      el.setAttribute("webkit-playsinline", "");
      el.muted = muted;
    }
    onElement?.(el);
  };

  const showPlayButton = !playing && (blocked || failed || (reduced && !userStarted) || (mode === "preview" && userPaused));
  const name = label ?? "Video";

  return (
    <div ref={box} className={`apv apv-${mode} ${playing ? "is-playing" : ""} ${className ?? ""}`} style={style}>
      {failed && poster ? (
        <img className="apv-poster" src={poster} alt="" />
      ) : (
        <video
          ref={setEl}
          // The file is fetched once the video is near the screen; the poster shows until then.
          src={near && src ? src : undefined}
          poster={poster ?? undefined}
          muted={muted}
          playsInline
          loop={loop ?? mode === "preview"}
          preload={near ? "metadata" : "none"}
          controls={mode !== "preview"}
          controlsList="nodownload"
          disablePictureInPicture={mode === "preview"}
          aria-label={name}
          onPlay={onPlay}
          onPause={onPause}
          onVolumeChange={onVolume}
          onError={() => {
            if (!src) return;
            setFailed(true);
            onError?.();
          }}
        />
      )}
      {children}
      {!bare && src && !failed && (
        <span className="apv-tools">
          {mode === "preview" && (
            <button type="button" className="apv-btn" onClick={togglePlay} aria-label={playing ? `Pause ${name}` : `Play ${name}`} title={playing ? "Pause" : "Play"}>
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
          )}
          <button type="button" className={`apv-btn ${muted ? "" : "on"}`} onClick={toggleSound} aria-label={muted ? `Sound on for ${name}` : `Sound off for ${name}`} title={muted ? "Sound on" : "Sound off"} aria-pressed={!muted}>
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        </span>
      )}
      {showPlayButton && src && (
        <button type="button" className="apv-play" onClick={togglePlay} aria-label={`Play ${name}`}>
          <Play size={22} />
          <span>{failed ? "Play (the preview could not load)" : blocked ? "Play" : reduced ? "Play (reduced motion)" : "Play"}</span>
        </button>
      )}
    </div>
  );
});

export default AutoplayVideo;
