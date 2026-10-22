/**
 * Dictation state, kept apart from the browser's speech API so it can be tested: what a recording
 * session is in (idle, recording, stopping, error), what was heard so far, what is still tentative,
 * and the one rule that matters: Stop hands the words to the field, Cancel drops them, and nothing
 * is ever submitted, generated or approved by recording.
 */

export const VOICE_LANGS = [
  { id: "ar", label: "Arabic", code: "ar-JO" },
  { id: "en", label: "English", code: "en-US" },
] as const;
export type VoiceLangId = (typeof VOICE_LANGS)[number]["id"];

/** The remembered dictation language, read back from storage: Arabic unless English was chosen. */
export function voiceLangOf(stored: string | null | undefined): VoiceLangId {
  return stored === "en" ? "en" : "ar";
}

export type VoiceState = "idle" | "recording" | "stopping" | "error";

export interface VoiceSession {
  state: VoiceState;
  /** Final words heard so far in this session. */
  heard: string;
  /** Tentative words the engine may still change. */
  interim: string;
  /** What went wrong, in plain words, when state is "error". */
  error: string;
  /** Cancel was pressed: the session's words are dropped when the engine ends. */
  cancelled: boolean;
}

export const idleVoice = (): VoiceSession => ({ state: "idle", heard: "", interim: "", error: "", cancelled: false });

export type VoiceEvent =
  | { type: "start" }
  | { type: "result"; finals: string; partial: string }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "error"; error: string }
  | { type: "end" };

/** The browser's error codes in the designer's words. Empty for "aborted" (our own Cancel). */
export function voiceErrorMessage(code: string): string {
  if (code === "aborted") return "";
  if (code === "not-allowed" || code === "service-not-allowed") return "The microphone is blocked for this site. Allow it in the browser's address bar.";
  if (code === "no-speech") return "Nothing was heard. Try again closer to the microphone.";
  if (code === "audio-capture") return "No microphone was found.";
  if (code === "network") return "The browser's speech service could not be reached.";
  return `Dictation stopped (${code}).`;
}

/**
 * One step of a session. `end` is the engine closing (after Stop, Cancel, an error or on its own):
 * the words go to the field only when Stop ended a session that heard something.
 */
export function voiceStep(s: VoiceSession, e: VoiceEvent): { session: VoiceSession; deliver: string | null } {
  switch (e.type) {
    case "start":
      return { session: { ...idleVoice(), state: "recording" }, deliver: null };
    case "result": {
      if (s.state !== "recording" && s.state !== "stopping") return { session: s, deliver: null };
      const heard = e.finals.trim() ? `${s.heard} ${e.finals.trim()}`.trim() : s.heard;
      return { session: { ...s, heard, interim: e.partial.trim() }, deliver: null };
    }
    case "stop":
      return { session: s.state === "recording" ? { ...s, state: "stopping" } : s, deliver: null };
    case "cancel":
      return { session: { ...s, state: "idle", cancelled: true, interim: "", heard: "" }, deliver: null };
    case "error": {
      const message = voiceErrorMessage(e.error);
      if (!message) return { session: s, deliver: null };
      return { session: { ...s, state: "error", error: message, interim: "" }, deliver: null };
    }
    case "end": {
      const deliver = !s.cancelled && s.state !== "error" && s.heard ? s.heard : null;
      return { session: { ...s, state: s.state === "error" ? "error" : "idle", heard: "", interim: "", cancelled: false }, deliver };
    }
  }
}

/** Dictated words appended to what is already in the field, with one space between and no stray blanks. */
export function appendDictation(field: string, words: string): string {
  const w = words.trim();
  if (!w) return field;
  const f = field.replace(/\s+$/, "");
  return f ? `${f} ${w}` : w;
}

/** The status line under the microphone, for each state. */
export function voiceStatus(s: VoiceSession): string {
  if (s.state === "stopping") return "Writing the words into the field…";
  if (s.state === "recording") return s.interim || (s.heard ? `${s.heard} …` : "Listening… speak, then press Stop. Nothing is sent or made by recording.");
  if (s.state === "error") return s.error;
  return "";
}
