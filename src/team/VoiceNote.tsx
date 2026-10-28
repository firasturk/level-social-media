/**
 * Voice notes: recorded with the browser's MediaRecorder (webm/opus, or mp4 on Safari), at most
 * three minutes, with a timer and a level meter while recording; played back with a compact
 * player of our own. No transcription, nothing leaves the studio's bucket.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Mic, Pause, Play, Square, X } from "lucide-react";
import { TEAM_VOICE_SECONDS_MAX } from "@shared/team";
import { formatDuration } from "@shared/team-ui";

export function recordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

const BARS = 24;

/** Records until Stop (or three minutes), then hands back the file and its length; Cancel throws it away. */
export function VoiceRecorder({ onDone, onCancel }: { onDone: (file: File, seconds: number) => void; onCancel: () => void }) {
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.08));
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const raf = useRef(0);
  const finish = useRef<"save" | "cancel">("cancel");
  const audioCtx = useRef<AudioContext | null>(null);

  useEffect(() => {
    let alive = true;
    const mime = recordingMime();
    if (!mime) {
      setError("This browser cannot record audio.");
      return;
    }
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!alive) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        const r = new MediaRecorder(s, { mimeType: mime });
        recorder.current = r;
        chunks.current = [];
        r.ondataavailable = (e) => {
          if (e.data.size) chunks.current.push(e.data);
        };
        r.onstop = () => {
          const secs = Math.min(TEAM_VOICE_SECONDS_MAX, Math.round((Date.now() - started.current) / 1000));
          s.getTracks().forEach((t) => t.stop());
          if (finish.current === "save" && chunks.current.length) {
            const ext = mime.startsWith("audio/mp4") ? "m4a" : mime.startsWith("audio/ogg") ? "ogg" : "webm";
            const type = mime.split(";")[0];
            onDone(new File(chunks.current, `voice-note.${ext}`, { type }), Math.max(1, secs));
          } else onCancel();
        };
        started.current = Date.now();
        r.start(250);
        // The level meter: a small analyser over the stream.
        try {
          const ctx = new AudioContext();
          audioCtx.current = ctx;
          const src = ctx.createMediaStreamSource(s);
          const an = ctx.createAnalyser();
          an.fftSize = 256;
          src.connect(an);
          const data = new Uint8Array(an.frequencyBinCount);
          const loop = () => {
            if (!alive) return;
            an.getByteTimeDomainData(data);
            let sum = 0;
            for (const v of data) {
              const d = (v - 128) / 128;
              sum += d * d;
            }
            const rms = Math.sqrt(sum / data.length);
            setLevels((l) => [...l.slice(1), Math.min(1, 0.08 + rms * 3)]);
            setSeconds(Math.floor((Date.now() - started.current) / 1000));
            raf.current = requestAnimationFrame(loop);
          };
          raf.current = requestAnimationFrame(loop);
        } catch {
          const t = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 250);
          raf.current = -t as unknown as number;
        }
      } catch {
        if (alive) setError("The microphone is not available. Allow it in the browser and try again.");
      }
    })();
    return () => {
      alive = false;
      if (raf.current > 0) cancelAnimationFrame(raf.current);
      else if (raf.current < 0) clearInterval(-raf.current);
      void audioCtx.current?.close().catch(() => undefined);
      if (recorder.current && recorder.current.state !== "inactive") {
        finish.current = "cancel";
        recorder.current.stop();
      } else stream.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Three minutes at most.
  useEffect(() => {
    if (seconds >= TEAM_VOICE_SECONDS_MAX && recorder.current?.state === "recording") {
      finish.current = "save";
      recorder.current.stop();
    }
  }, [seconds]);

  const stop = (how: "save" | "cancel") => {
    finish.current = how;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    else onCancel();
  };

  if (error)
    return (
      <div className="tm-recorder error" role="alert">
        <span>{error}</span>
        <button type="button" className="tm-icon" onClick={onCancel} aria-label="Close">
          <X size={16} />
        </button>
      </div>
    );
  return (
    <div className="tm-recorder" role="status" aria-live="polite">
      <span className="tm-rec-dot" aria-hidden="true" />
      <span className="tm-rec-time">{formatDuration(seconds)}</span>
      <span className="tm-meter" aria-hidden="true">
        {levels.map((v, i) => (
          <i key={i} style={{ height: `${Math.round(v * 100)}%` }} />
        ))}
      </span>
      <span className="tm-rec-max">/ {formatDuration(TEAM_VOICE_SECONDS_MAX)}</span>
      <button type="button" className="tm-icon" onClick={() => stop("cancel")} title="Discard" aria-label="Discard the recording">
        <X size={16} />
      </button>
      <button type="button" className="tm-rec-stop" onClick={() => stop("save")} title="Stop and attach" aria-label="Stop and attach">
        <Square size={12} fill="currentColor" />
        <Check size={14} />
      </button>
    </div>
  );
}

/** Play / pause, a progress bar you can scrub, the time left. */
export function VoicePlayer({ src, duration }: { src: string; duration: number | null }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [len, setLen] = useState(duration ?? 0);
  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    a.src = src;
    audio.current = a;
    const onTime = () => setT(a.currentTime);
    const onMeta = () => Number.isFinite(a.duration) && a.duration > 0 && setLen(a.duration);
    const onEnd = () => {
      setPlaying(false);
      setT(0);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("play", () => setPlaying(true));
    return () => {
      a.pause();
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("ended", onEnd);
      a.src = "";
    };
  }, [src]);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a || !len) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    a.currentTime = Math.max(0, Math.min(1, rtl ? 1 - x : x)) * len;
  };
  const pct = len ? Math.min(100, (t / len) * 100) : 0;
  return (
    <div className="tm-voice" dir="ltr">
      <button type="button" className="tm-voice-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <div className="tm-voice-bar" onClick={seek} role="slider" aria-valuemin={0} aria-valuemax={Math.round(len)} aria-valuenow={Math.round(t)} aria-label="Position">
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className="tm-voice-time">{playing || t > 0 ? formatDuration(t) : formatDuration(len)}</span>
      <Mic size={12} className="tm-voice-mic" aria-hidden="true" />
    </div>
  );
}
