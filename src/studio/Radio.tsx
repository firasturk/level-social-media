import { useEffect, useRef, useState } from "react";
import { Music2, Pause, Play } from "lucide-react";

/** Jordanian stations with direct HTTPS streams (checked in October 2026). */
const STATIONS = [
  { name: "Mazaj FM", note: "Arabic and international hits", url: "https://mazajfm.ice.infomaniak.ch/mazajfm-192.mp3" },
  { name: "Hayat FM", note: "Arabic pop", url: "https://dc1.serverse.com/proxy/kjxwtpdt/stream" },
  { name: "Radio Dahab", note: "Arabic classics", url: "https://dahab.ice.infomaniak.ch/dahab-192.mp3" },
  { name: "Ain FM", note: "Arabic music", url: "https://radio.ainfm.site/ainfm" },
  { name: "Beat FM", note: "International hits", url: "https://securestreams2.autopo.st:1242/live" },
  { name: "Mood FM 92", note: "Chill and pop", url: "https://securestreams2.autopo.st:1241/live" },
];

const KEY = "lsm-radio";

/** "Listen to your favourite music": a small player of Jordanian radio while the team works. */
export default function Radio({ className = "" }: { className?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => () => audio.current?.pause(), []);

  function play(i: number) {
    if (!audio.current) audio.current = new Audio();
    const a = audio.current;
    if (playing === i) {
      a.pause();
      setPlaying(null);
      return;
    }
    setFailed(null);
    setLoading(true);
    a.src = STATIONS[i].url;
    a.onplaying = () => setLoading(false);
    a.onerror = () => {
      setLoading(false);
      setPlaying(null);
      setFailed(i);
    };
    void a.play().catch(() => {
      setLoading(false);
      setPlaying(null);
      setFailed(i);
    });
    setPlaying(i);
    try {
      localStorage.setItem(KEY, String(i));
    } catch {
      /* private mode */
    }
  }

  const last = (() => {
    try {
      return Number(localStorage.getItem(KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  })();

  return (
    <div className={`radio ${className}`} ref={box}>
      <button
        type="button"
        className={`radio-button ${playing !== null ? "on" : ""}`}
        onClick={() => (playing === null && !open ? setOpen(true) : setOpen((v) => !v))}
        title="Listen to your favourite music"
        aria-label="Listen to your favourite music"
      >
        {playing !== null ? <span className="radio-bars" aria-hidden><i /><i /><i /></span> : <Music2 size={15} />}
        <span className="radio-label">{playing !== null ? STATIONS[playing].name : "Listen to your favourite music"}</span>
      </button>
      {open && (
        <div className="radio-pop" role="menu">
          <strong>Jordanian radio</strong>
          {STATIONS.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="menuitem"
              className={`radio-station ${playing === i ? "on" : ""} ${last === i && playing === null ? "last" : ""}`}
              onClick={() => play(i)}
            >
              {playing === i ? <Pause size={14} /> : <Play size={14} />}
              <span>
                {s.name}
                <small>{failed === i ? "Not reachable right now, try another" : playing === i && loading ? "Tuning in…" : s.note}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
