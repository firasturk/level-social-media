import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, Music2, Pause, Play, Square, X } from "lucide-react";

/** Jordanian stations with direct HTTPS streams (checked in October 2026). */
const STATIONS = [
  { name: "Mazaj FM", note: "Arabic and international hits", url: "https://mazajfm.ice.infomaniak.ch/mazajfm-192.mp3" },
  { name: "Hayat FM", note: "Arabic pop", url: "https://dc1.serverse.com/proxy/kjxwtpdt/stream" },
  { name: "Radio Dahab", note: "Arabic classics", url: "https://dahab.ice.infomaniak.ch/dahab-192.mp3" },
  { name: "Ain FM", note: "Arabic music", url: "https://radio.ainfm.site/ainfm" },
  { name: "Beat FM", note: "International hits", url: "https://securestreams2.autopo.st:1242/live" },
  { name: "Mood FM 92", note: "Chill and pop", url: "https://securestreams2.autopo.st:1241/live" },
];

const LAST_KEY = "lsm-radio";
const ON_KEY = "lsm-radio-on";

/**
 * One player for the whole app, outside React: the music carries on through the journey, the
 * studio and every screen change. A dropped stream reconnects by itself; after a page reload the
 * station is remembered and a single click resumes it (browsers allow sound only after a click).
 */
type State = { station: number | null; status: "off" | "tuning" | "on" | "reconnecting" | "failed"; resume: number | null };

let state: State = { station: null, status: "off", resume: readOn() };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function readOn(): number | null {
  try {
    const v = sessionStorage.getItem(ON_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function set(next: Partial<State>) {
  state = { ...state, ...next };
  try {
    if (state.station !== null && state.status !== "failed") sessionStorage.setItem(ON_KEY, String(state.station));
    else if (state.station === null) sessionStorage.removeItem(ON_KEY);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

function player(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "none";
  a.addEventListener("playing", () => {
    retries = 0;
    set({ status: "on" });
  });
  // A live stream that stalls, ends or errors while it should be playing comes back by itself.
  const recover = () => {
    if (state.station === null) return;
    if (retries >= 6) return set({ status: "failed" });
    retries++;
    set({ status: "reconnecting" });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => tune(state.station!), Math.min(15000, 1000 * 2 ** retries));
  };
  a.addEventListener("ended", recover);
  a.addEventListener("error", recover);
  a.addEventListener("stalled", () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (state.station !== null && a.readyState < 3) recover();
    }, 8000);
  });
  audio = a;
  return a;
}

function tune(i: number) {
  const a = player();
  // A fresh URL each time: a live stream restarts at "now" instead of a stale buffer.
  a.src = `${STATIONS[i].url}${STATIONS[i].url.includes("?") ? "&" : "?"}t=${Date.now()}`;
  void a.play().catch(() => {
    if (state.station === i && state.status === "tuning") set({ status: "failed" });
  });
  mediaSession(i);
}

function play(i: number) {
  clearTimeout(retryTimer);
  retries = 0;
  set({ station: i, status: "tuning", resume: null });
  try {
    localStorage.setItem(LAST_KEY, String(i));
  } catch {
    /* private mode */
  }
  tune(i);
}

/** Signing out ends the music. */
export function stopRadio() {
  stop();
}

function stop() {
  clearTimeout(retryTimer);
  audio?.pause();
  if (audio) audio.removeAttribute("src");
  set({ station: null, status: "off", resume: null });
}

/** The station shows on the phone's lock screen and the computer's media keys work. */
function mediaSession(i: number) {
  try {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: STATIONS[i].name,
      artist: "Jordanian radio · Level Studio",
      artwork: [{ src: "/level-icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.setActionHandler("play", () => play(state.station ?? i));
    navigator.mediaSession.setActionHandler("pause", () => stop());
    navigator.mediaSession.setActionHandler("stop", () => stop());
  } catch {
    /* unsupported */
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

/** "Listen to your favourite music": a small player of Jordanian radio while the team works. */
export default function Radio({ className = "" }: { className?: string }) {
  const s = useSyncExternalStore(subscribe, snapshot);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const last = (() => {
    try {
      return Number(localStorage.getItem(LAST_KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  })();
  const live = s.station !== null && s.status !== "failed";

  return (
    <div className={`radio ${className}`} ref={box}>
      {s.resume !== null && s.station === null ? (
        <span className="radio-pill">
          <button
            type="button"
            className="radio-button resume"
            onClick={() => play(s.resume!)}
            title="The page reloaded: one click brings the music back"
          >
            <Play size={14} />
            <span className="radio-label">Resume {STATIONS[s.resume]?.name ?? "radio"}</span>
          </button>
          <button type="button" className="radio-stop" onClick={() => stop()} title="No music" aria-label="Dismiss the radio">
            <X size={13} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={`radio-button ${live ? "on" : ""}`}
          onClick={() => setOpen((v) => !v)}
          title="Listen to your favourite music"
          aria-label="Listen to your favourite music"
        >
          {s.status === "tuning" || s.status === "reconnecting" ? (
            <LoaderCircle className="spinning" size={14} />
          ) : live ? (
            <span className="radio-bars" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          ) : (
            <Music2 size={15} />
          )}
          <span className="radio-label">
            {live
              ? `${STATIONS[s.station!].name}${s.status === "reconnecting" ? " · reconnecting" : ""}`
              : "Listen to your favourite music"}
          </span>
        </button>
      )}
      {live && s.resume === null && (
        <button type="button" className="radio-stop" onClick={() => stop()} title="Stop the music" aria-label="Stop the music">
          <Square size={11} fill="currentColor" />
        </button>
      )}
      {open && (
        <div className="radio-pop" role="menu">
          <strong>Jordanian radio · keeps playing on every screen</strong>
          {STATIONS.map((st, i) => {
            const on = s.station === i;
            return (
              <button
                key={st.name}
                type="button"
                role="menuitem"
                className={`radio-station ${on ? "on" : ""} ${last === i && s.station === null ? "last" : ""}`}
                onClick={() => (on && live ? stop() : play(i))}
              >
                {on && live ? <Pause size={14} /> : <Play size={14} />}
                <span>
                  {st.name}
                  <small>
                    {on && s.status === "failed"
                      ? "Not reachable right now, try another"
                      : on && s.status === "tuning"
                        ? "Tuning in…"
                        : on && s.status === "reconnecting"
                          ? "Reconnecting…"
                          : st.note}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
