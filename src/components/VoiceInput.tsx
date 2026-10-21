/**
 * Dictation into a text field, in Arabic or English, with the browser's own speech recognition
 * (no provider, no cost, nothing leaves the browser but the audio the browser's engine itself
 * sends to its vendor). The words land in the field as editable text; nothing is ever submitted,
 * generated or approved by recording. Hidden where the browser has no recognition (Firefox).
 */
import { useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { Orb } from "@/components/Orb";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupported = () => typeof window !== "undefined" && !!recognitionClass();

const LANGS = [
  { id: "ar", label: "عربي", code: "ar-JO" },
  { id: "en", label: "EN", code: "en-US" },
] as const;
type LangId = (typeof LANGS)[number]["id"];
const LANG_KEY = "lsm-voice-lang";

export default function VoiceInput({
  onText,
  disabled,
  compact,
  label = "Dictate",
}: {
  /** Final words, appended to the field by the caller (with a space before them when needed). */
  onText: (text: string) => void;
  disabled?: boolean;
  /** Icon only. */
  compact?: boolean;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "recording" | "stopping" | "error">("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const [lang, setLang] = useState<LangId>(() => {
    try {
      const v = localStorage.getItem(LANG_KEY);
      return v === "en" ? "en" : "ar";
    } catch {
      return "ar";
    }
  });
  const rec = useRef<Recognition | null>(null);
  const heard = useRef("");
  const cancelled = useRef(false);
  const supported = voiceSupported();

  useEffect(() => () => rec.current?.abort(), []);
  if (!supported) return null;

  function start() {
    const Cls = recognitionClass();
    if (!Cls) return;
    const r = new Cls();
    r.lang = LANGS.find((l) => l.id === lang)!.code;
    r.continuous = true;
    r.interimResults = true;
    heard.current = "";
    cancelled.current = false;
    setInterim("");
    setError("");
    r.onresult = (e) => {
      let finals = "";
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) finals += text;
        else partial += text;
      }
      if (finals) heard.current = `${heard.current} ${finals}`.trim();
      setInterim(partial.trim());
    };
    r.onerror = (e) => {
      if (e.error === "aborted") return;
      setError(e.error === "not-allowed" ? "The microphone is blocked for this site. Allow it in the browser's address bar." : e.error === "no-speech" ? "Nothing was heard." : `Dictation stopped (${e.error}).`);
      setState("error");
    };
    r.onend = () => {
      rec.current = null;
      // Stop: what was heard goes into the field. Cancel: it is dropped.
      if (!cancelled.current && heard.current) onText(heard.current);
      heard.current = "";
      setInterim("");
      setState((s) => (s === "error" ? "error" : "idle"));
    };
    rec.current = r;
    try {
      r.start();
      setState("recording");
    } catch {
      setError("Dictation could not start.");
      setState("error");
    }
  }
  function stop() {
    setState("stopping");
    rec.current?.stop();
  }
  function cancel() {
    cancelled.current = true;
    rec.current?.abort();
    setInterim("");
    setState("idle");
  }
  function pickLang(id: LangId) {
    setLang(id);
    try {
      localStorage.setItem(LANG_KEY, id);
    } catch {
      /* private mode */
    }
  }

  const recording = state === "recording" || state === "stopping";
  return (
    <span className={`voice ${recording ? "on" : ""} ${compact ? "compact" : ""}`}>
      {!recording ? (
        <>
          <button type="button" className="voice-btn" disabled={disabled} onClick={start} title={`${label}: the words are typed into the field for you to edit; nothing is sent or made by recording`} aria-label={label}>
            <Mic size={14} /> {!compact && label}
          </button>
          <span className="voice-langs" role="radiogroup" aria-label="Dictation language">
            {LANGS.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={lang === l.id} className={lang === l.id ? "on" : ""} onClick={() => pickLang(l.id)} disabled={disabled}>
                {l.label}
              </button>
            ))}
          </span>
          {state === "error" && error && <small className="voice-error">{error}</small>}
        </>
      ) : (
        <>
          <span className="voice-live" aria-live="polite">
            {state === "stopping" ? <Orb size={13} /> : <span className="voice-dot" aria-hidden />}
            {state === "stopping" ? "Writing the words…" : interim || "Listening… speak, then press Stop"}
          </span>
          <button type="button" className="voice-btn stop" onClick={stop} title="Stop: the words go into the field">
            <Square size={12} /> Stop
          </button>
          <button type="button" className="voice-btn cancel" onClick={cancel} title="Cancel: nothing is kept">
            <X size={12} /> Cancel
          </button>
        </>
      )}
    </span>
  );
}
