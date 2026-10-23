/**
 * The one video preview of Level Studio (shared/video-preview.ts has the rules): a visible video
 * plays by itself, muted, inline and looping, with a sound toggle; it pauses off screen, in a
 * background tab and in a closed dialog; a person's pause wins and the playhead is never moved;
 * reduced motion keeps the poster with a Play button; a refused autoplay or a broken file shows a
 * Play button over the poster instead of a black box. Only one video is audible at a time, and at
 * most a handful play at once (the most visible ones).
 *
 * The media is not fetched until the video is near the screen (`src` is set then, `preload` is
 * "metadata"), so a long page of cards does not download every clip. Cards and galleries pass the
 * lightweight preview file as `src` and the full file as `fallbackSrc` (used when the preview is
 * missing or fails); the full file stays for editing and export.
 *
 * `mode`:
 *   - "preview" (cards, galleries, presets): no native controls; pause and sound buttons in a corner.
 *   - "player" (dialogs, client review, version stages): native controls (seek, volume, fullscreen
 *     where the browser offers it, never forced), starting muted; the sound button stays in the
 *     top corner for the first unmute.
 *   - "editor" (a working preview a timeline drives): never started, paused or seeked here; it
 *     only takes part in the one-audible-video rule and the background-tab pause.
 *
 * `decorative` (the studio's hero banners): no buttons but a small Play under reduced motion or
 * when the browser refuses; hidden from screen readers.
 */
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { allowedToPlay, decidePlayback, MAX_PLAYING, nextAudible, onScreenShare, PRELOAD_MARGIN, VISIBLE_RATIO } from "@shared/video-preview";

export interface AutoplayVideoProps {
  src: string | null | undefined;
  /** The file to use when `src` is missing or fails (the full clip behind a lightweight preview). */
  fallbackSrc?: string | null;
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
  /** Extra content drawn over the video (a tag, a badge, a click target). */
  children?: ReactNode;
  onError?: () => void;
  /** Called with the element once it exists (for editors that read `currentTime`). */
  onElement?: (el: HTMLVideoElement | null) => void;
  /** No corner buttons (the surface draws its own). */
  bare?: boolean;
  /** A decorative background video (a hero): no buttons, hidden from screen readers, a small Play when it cannot move. */
  decorative?: boolean;
}

/* ───────────── The page's registry: the cap, the one audible video, the background tab ───────────── */

interface Entry {
  id: string;
  ratio: number;
  wants: boolean;
  priority: boolean;
  apply: (allowed: boolean) => void;
  mute: () => void;
  /** Something outside its own surface (a dialog, a full-screen studio) lies over it. */
  covered: () => boolean;
}

const entries = new Map<string, Entry>();
let audible: string | null = null;
let scheduled = false;

function rebalance(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    // A preview under a dialog or a full-screen studio gives its place to the ones on top.
    const wanting = [...entries.values()].filter((e) => e.wants && !e.covered());
    const allowed = allowedToPlay(
      wanting.map((e) => ({ id: e.id, ratio: e.ratio, priority: e.priority })),
      MAX_PLAYING,
    );
    for (const e of entries.values()) e.apply(allowed.has(e.id));
  });
}

function claimSound(id: string, wantsSound: boolean): void {
  const next = nextAudible(audible, id, wantsSound);
  if (next.mute) entries.get(next.mute)?.mute();
  audible = next.audible;
}

/**
 * Whether something that is not part of the preview's own surface (its parent: a card, a hero, a
 * list row) is drawn over the visible part of it, at three points. Checked when the page's previews
 * change (a dialog with a video opens or closes), not continuously.
 */
function coveredBox(box: HTMLElement | null): boolean {
  if (!box || typeof document === "undefined" || typeof document.elementFromPoint !== "function") return false;
  const r = box.getBoundingClientRect();
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, window.innerWidth);
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  if (right <= left || bottom <= top) return false;
  const surface = box.parentElement ?? box;
  const y = (top + bottom) / 2;
  return [0.25, 0.5, 0.75].every((f) => {
    const hit = document.elementFromPoint(left + (right - left) * f, y);
    return !!hit && !surface.contains(hit);
  });
}

const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const REDUCED = "(prefers-reduced-motion: reduce)";
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.(REDUCED).matches;
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/** With no poster, a media fragment makes browsers (iPhone Safari included) paint the first frame instead of a black box. */
function withFirstFrame(src: string, poster: string | null | undefined): string {
  return poster || src.includes("#") ? src : `${src}#t=0.001`;
}

/* ───────────── The component ───────────── */

export const AutoplayVideo = forwardRef<HTMLVideoElement | null, AutoplayVideoProps>(function AutoplayVideo(
  { src, fallbackSrc, poster, mode = "preview", active = true, loop, className, style, label, children, onError, onElement, bare, decorative },
  ref,
) {
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  useImperativeHandle(ref, () => video.current as HTMLVideoElement, []);

  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [hidden, setHidden] = useState(tabHidden);
  const [reduced, setReduced] = useState(reducedMotion);
  const [userPaused, setUserPaused] = useState(false);
  const [userStarted, setUserStarted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  // Granted by the page's registry (the cap): nothing plays until it has been counted.
  const [allowed, setAllowed] = useState(false);
  // How many play()/pause() calls of ours have not had their event yet, so the element's events
  // can tell them from a person's (native controls, a keyboard, the system).
  const pending = useRef({ play: 0, pause: 0 });

  const driven = mode === "editor";
  const file = (useFallback ? fallbackSrc : src) || (!src ? fallbackSrc : null) || null;
  const visible = ratio >= VISIBLE_RATIO;
  const decision = decidePlayback({ visible, active, tabHidden: hidden, userPaused, reducedMotion: reduced, autoplay: !driven, blocked: blocked || failed, userStarted, finished, driven });

  // What the element's events need to know now, without waiting for a render.
  const now = useRef({ visible, active, hidden, loop: loop ?? mode === "preview" });
  now.current = { visible, active, hidden, loop: loop ?? mode === "preview" };
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onElementRef = useRef(onElement);
  onElementRef.current = onElement;

  // A new file is a new clip: the person's earlier choices on the old one do not carry over.
  useEffect(() => {
    setUserPaused(false);
    setUserStarted(false);
    setBlocked(false);
    setFailed(false);
    setFinished(false);
    setUseFallback(false);
    setPlaying(false);
    pending.current = { play: 0, pause: 0 };
  }, [src, fallbackSrc]);

  // On screen, and near it (to start loading a little before it arrives).
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      setRatio(1);
      return;
    }
    const nearObs = new IntersectionObserver((list) => list.forEach((e) => e.isIntersecting && setNear(true)), { rootMargin: PRELOAD_MARGIN });
    const seenObs = new IntersectionObserver(
      (list) =>
        list.forEach((e) => {
          const screen = e.rootBounds?.height || window.innerHeight || 1;
          setRatio(e.isIntersecting ? onScreenShare(e.intersectionRatio, e.intersectionRect.height / screen) : 0);
        }),
      { threshold: THRESHOLDS },
    );
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

  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(REDUCED) : undefined;
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
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
      covered: () => coveredBox(box.current),
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
    // The person's own choices and the large players (a stage, a dialog, the client's link) come before small previews.
    e.priority = userStarted || !muted || mode === "player";
    rebalance();
  }, [id, ratio, decision, userStarted, muted, mode]);

  const tryPlay = useCallback(async () => {
    const v = video.current;
    if (!v || !v.paused) return;
    pending.current.play++;
    try {
      await v.play();
      setBlocked(false);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      // A refused or impossible start fires no "play" event; a newer pause or load (AbortError) did fire it.
      if (name !== "AbortError") pending.current.play = Math.max(0, pending.current.play - 1);
      // NotAllowedError: a policy (Low Power Mode, a browser setting) refused it: the Play button shows.
      if (name === "NotAllowedError") setBlocked(true);
    }
  }, []);

  const doPause = useCallback(() => {
    const v = video.current;
    if (!v || v.paused) return;
    pending.current.pause++;
    v.pause();
  }, []);

  // Apply the decision. "hold" leaves the element as it is.
  useEffect(() => {
    if (!near || !file) return;
    if (decision === "play" && allowed) void tryPlay();
    else if (decision === "pause" || (decision === "play" && !allowed)) doPause();
  }, [decision, allowed, near, file, tryPlay, doPause]);

  // The element's own events: a pause or play we did not ask for is the person's (native controls).
  const onPlay = () => {
    setPlaying(true);
    setFinished(false);
    if (pending.current.play > 0) pending.current.play--;
    else {
      setUserPaused(false);
      setUserStarted(true);
    }
  };
  const onPause = () => {
    setPlaying(false);
    const v = video.current;
    if (pending.current.pause > 0) pending.current.pause--;
    else if (v?.ended) setFinished(true);
    // A pause while it is on screen, open and in a visible tab is the person's; one the system made
    // (the tab going to the background, the browser saving power off screen) is not.
    else if (now.current.visible && now.current.active && !now.current.hidden && !tabHidden()) setUserPaused(true);
  };
  const onVolume = () => {
    const v = video.current;
    if (!v) return;
    setMuted(v.muted);
    claimSound(id, !v.muted);
  };
  const onFailed = () => {
    if (!file) return;
    if (!useFallback && fallbackSrc && fallbackSrc !== src && file === src) {
      // The lightweight preview is missing or broken: the full file instead, without a word.
      setUseFallback(true);
      return;
    }
    pending.current = { play: 0, pause: 0 };
    setPlaying(false);
    setFailed(true);
    onErrorRef.current?.();
  };

  const stop = (e: MouseEvent) => e.stopPropagation();
  const toggleSound = (e: MouseEvent) => {
    stop(e);
    const v = video.current;
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    setMuted(next);
    claimSound(id, !next);
    if (!next && v.paused) {
      setUserPaused(false);
      setUserStarted(true);
      setBlocked(false);
      void v.play().catch(() => setBlocked(true));
    }
  };
  const togglePlay = (e: MouseEvent) => {
    stop(e);
    const v = video.current;
    if (!v) return;
    if (failed) {
      // Try the file again (a network hiccup, a file that has arrived since).
      setFailed(false);
      setUseFallback(false);
      // A load drops the element's queued events: none of ours is pending after it.
      pending.current = { play: 0, pause: 0 };
      v.load();
    }
    if (v.paused || failed) {
      setUserPaused(false);
      setUserStarted(true);
      setBlocked(false);
      setFinished(false);
      void v.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked(true);
      });
    } else {
      setUserPaused(true);
      v.pause();
    }
  };

  // A stable ref callback: React calls it once per element, not on every render.
  const setEl = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    if (el) {
      // Muted from the start, as a property and an attribute (iPhone Safari reads both before it
      // lets a video start by itself; React writes only the property, and only at creation).
      el.muted = true;
      el.defaultMuted = true;
      el.setAttribute("muted", "");
      // iPhone Safari before 10 and some in-app browsers read the prefixed attribute.
      el.setAttribute("webkit-playsinline", "");
    }
    onElementRef.current?.(el);
  }, []);

  const name = label ?? "Video";
  const showPlayButton = !!file && !playing && (blocked || failed || (reduced && !userStarted && !driven) || (mode === "preview" && userPaused && !bare && !decorative));
  const playText = failed ? "Try again" : blocked ? "Play" : reduced && !userStarted ? "Play (reduced motion)" : "Play";
  const tools = !bare && !decorative && !!file && !failed;

  return (
    <div ref={box} className={`apv apv-${mode} ${decorative ? "apv-decor" : ""} ${playing ? "is-playing" : ""} ${failed ? "is-failed" : ""} ${className ?? ""}`} style={style} data-playing={playing ? "1" : "0"}>
      <video
        ref={setEl}
        // The file is fetched once the video is near the screen; the poster shows until then.
        src={near && file ? withFirstFrame(file, poster) : undefined}
        poster={poster ?? undefined}
        playsInline
        loop={loop ?? mode === "preview"}
        preload={near ? "metadata" : "none"}
        controls={mode !== "preview" && !decorative && !failed}
        disablePictureInPicture={mode === "preview" || decorative}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative ? true : undefined}
        tabIndex={decorative ? -1 : undefined}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={() => !now.current.loop && setFinished(true)}
        onVolumeChange={onVolume}
        onError={onFailed}
      />
      {failed && poster && <img className="apv-poster" src={poster} alt="" />}
      {children}
      {tools && (
        <span className="apv-tools" onKeyDown={(e) => e.stopPropagation()}>
          {mode === "preview" && !showPlayButton && (
            <button type="button" className="apv-btn" onClick={togglePlay} aria-label={playing ? `Pause ${name}` : `Play ${name}`} title={playing ? "Pause" : "Play"}>
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
          )}
          <button type="button" className={`apv-btn ${muted ? "" : "on"}`} onClick={toggleSound} aria-label={muted ? `Sound on for ${name}` : `Sound off for ${name}`} title={muted ? "Sound on" : "Sound off"} aria-pressed={!muted}>
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        </span>
      )}
      {showPlayButton && (
        <button type="button" className="apv-play" onClick={togglePlay} onKeyDown={(e) => e.stopPropagation()} aria-label={failed ? `Try ${name} again` : `Play ${name}`}>
          {failed ? <RotateCcw size={22} /> : <Play size={22} />}
          <span>{playText}</span>
          {failed && <small>The video could not load.</small>}
        </button>
      )}
    </div>
  );
});

export default AutoplayVideo;
