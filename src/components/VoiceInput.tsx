/**
 * Dictation into a text field, in Arabic or English, with the browser's own speech recognition
 * (no provider, no cost, nothing leaves the browser but the audio the browser's engine itself
 * sends to its vendor). The words land in the field as editable text; nothing is ever submitted,
 * generated or approved by recording. Where the browser has no recognition (Firefox), a plain
 * note says to type instead; the field itself always works. The state rules live in shared/voice.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { Orb } from "@/components/Orb";
import { appendDictation, idleVoice, VOICE_LANGS, voiceLangOf, voiceStatus, voiceStep, type VoiceEvent, type VoiceLangId, type VoiceSession } from "@shared/voice";

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

const LANG_KEY = "lsm-voice-lang";

export { appendDictation };

export default function VoiceInput({
  onText,
  disabled,
  compact,
  label = "Dictate",
}: {
  /** Final words, appended to the field by the caller (appendDictation puts the space in). */
  onText: (text: string) => void;
  disabled?: boolean;
  /** Icon only. */
  compact?: boolean;
  label?: string;
}) {
  const [session, setSession] = useState<VoiceSession>(idleVoice);
  // The engine's callbacks see the session as it is, not as it was when they were made.
  const sessionRef = useRef<VoiceSession>(session);
  const [lang, setLang] = useState<VoiceLangId>(() => {
    try {
      return voiceLangOf(localStorage.getItem(LANG_KEY));
    } catch {
      return "ar";
    }
  });
  const rec = useRef<Recognition | null>(null);
  const supported = voiceSupported();

  const step = (e: VoiceEvent) => {
    const r = voiceStep(sessionRef.current, e);
    sessionRef.current = r.session;
    setSession(r.session);
    if (r.deliver) onText(r.deliver);
  };

  useEffect(() => () => rec.current?.abort(), []);
  if (!supported) {
    return compact ? null : <small className="voice-fallback">Dictation is not available in this browser: type the words instead.</small>;
  }

  function start() {
    const Cls = recognitionClass();
    if (!Cls) return;
    const r = new Cls();
    r.lang = VOICE_LANGS.find((l) => l.id === lang)!.code;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let finals = "";
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) finals += text;
        else partial += text;
      }
      step({ type: "result", finals, partial });
    };
    r.onerror = (e) => step({ type: "error", error: e.error });
    r.onend = () => {
      rec.current = null;
      // Stop: what was heard goes into the field. Cancel: it is dropped.
      step({ type: "end" });
    };
    rec.current = r;
    try {
      r.start();
      step({ type: "start" });
    } catch {
      step({ type: "error", error: "could-not-start" });
    }
  }
  function stop() {
    step({ type: "stop" });
    rec.current?.stop();
  }
  function cancel() {
    step({ type: "cancel" });
    rec.current?.abort();
  }
  function pickLang(id: VoiceLangId) {
    setLang(id);
    try {
      localStorage.setItem(LANG_KEY, id);
    } catch {
      /* private mode */
    }
  }

  const recording = session.state === "recording" || session.state === "stopping";
  const status = voiceStatus(session);
  return (
    <span className={`voice ${recording ? "on" : ""} ${compact ? "compact" : ""}`}>
      {!recording ? (
        <>
          <button type="button" className="voice-btn" disabled={disabled} onClick={start} title={`${label}: the words are typed into the field for you to edit; nothing is sent or made by recording`} aria-label={label}>
            <Mic size={14} /> {!compact && label}
          </button>
          <span className="voice-langs" role="radiogroup" aria-label="Dictation language">
            {VOICE_LANGS.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={lang === l.id} className={lang === l.id ? "on" : ""} onClick={() => pickLang(l.id)} disabled={disabled} title={`Dictate in ${l.label}`}>
                {compact ? l.id.toUpperCase() : l.label}
              </button>
            ))}
          </span>
          {session.state === "error" && status && <small className="voice-error">{status}</small>}
        </>
      ) : (
        <>
          <span className="voice-live" aria-live="polite" dir="auto">
            {session.state === "stopping" ? <Orb size={13} /> : <span className="voice-dot" aria-hidden />}
            {status}
          </span>
          <button type="button" className="voice-btn stop" onClick={stop} title="Stop: the words go into the field, where you can edit them">
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
