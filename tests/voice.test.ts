/**
 * Dictation: the session's states, the words that reach the field (Stop delivers, Cancel drops),
 * tentative words shown while listening, errors in plain words, and the rule that recording never
 * submits anything: the only thing a session can hand over is text for an editable field.
 */
import { describe, expect, it } from "vitest";
import { appendDictation, idleVoice, VOICE_LANGS, voiceErrorMessage, voiceLangOf, voiceStatus, voiceStep, type VoiceEvent, type VoiceSession } from "../shared/voice";

function play(events: VoiceEvent[], from: VoiceSession = idleVoice()): { session: VoiceSession; delivered: string[] } {
  const delivered: string[] = [];
  let session = from;
  for (const e of events) {
    const r = voiceStep(session, e);
    session = r.session;
    if (r.deliver) delivered.push(r.deliver);
  }
  return { session, delivered };
}

describe("dictation session", () => {
  it("offers Arabic and English, in plain English labels, and remembers English only when chosen", () => {
    expect(VOICE_LANGS.map((l) => l.label)).toEqual(["Arabic", "English"]);
    expect(VOICE_LANGS.map((l) => l.code)).toEqual(["ar-JO", "en-US"]);
    expect(voiceLangOf("en")).toBe("en");
    expect(voiceLangOf("ar")).toBe("ar");
    expect(voiceLangOf(null)).toBe("ar");
    expect(voiceLangOf("fr")).toBe("ar");
  });

  it("goes idle → recording → stopping → idle and hands the final words over once, on Stop", () => {
    const r = play([{ type: "start" }, { type: "result", finals: "اطلب الآن", partial: "" }, { type: "result", finals: "", partial: "قبل" }, { type: "stop" }, { type: "result", finals: "قبل الأحد", partial: "" }, { type: "end" }]);
    expect(r.delivered).toEqual(["اطلب الآن قبل الأحد"]);
    expect(r.session.state).toBe("idle");
    expect(r.session.heard).toBe("");
  });

  it("shows tentative words while listening and the final words so far", () => {
    const { session } = play([{ type: "start" }, { type: "result", finals: "", partial: "hello" }]);
    expect(session.state).toBe("recording");
    expect(voiceStatus(session)).toBe("hello");
    const more = play([{ type: "result", finals: "hello there", partial: "" }], session).session;
    expect(voiceStatus(more)).toBe("hello there …");
    expect(voiceStatus(play([{ type: "start" }]).session)).toMatch(/Listening/);
    expect(voiceStatus(play([{ type: "start" }, { type: "stop" }]).session)).toMatch(/Writing the words/);
  });

  it("drops everything on Cancel: nothing reaches the field", () => {
    const r = play([{ type: "start" }, { type: "result", finals: "delete all the posts", partial: "" }, { type: "cancel" }, { type: "end" }]);
    expect(r.delivered).toEqual([]);
    expect(r.session.state).toBe("idle");
    expect(r.session.cancelled).toBe(false);
  });

  it("delivers nothing when nothing was heard, and nothing after an error", () => {
    expect(play([{ type: "start" }, { type: "stop" }, { type: "end" }]).delivered).toEqual([]);
    const r = play([{ type: "start" }, { type: "result", finals: "some words", partial: "" }, { type: "error", error: "network" }, { type: "end" }]);
    expect(r.delivered).toEqual([]);
    expect(r.session.state).toBe("error");
    expect(voiceStatus(r.session)).toMatch(/speech service/);
  });

  it("explains the browser's errors in plain words and ignores its own abort", () => {
    expect(voiceErrorMessage("not-allowed")).toMatch(/microphone is blocked/);
    expect(voiceErrorMessage("no-speech")).toMatch(/Nothing was heard/);
    expect(voiceErrorMessage("audio-capture")).toMatch(/No microphone/);
    expect(voiceErrorMessage("aborted")).toBe("");
    expect(voiceErrorMessage("weird")).toBe("Dictation stopped (weird).");
    const { session } = play([{ type: "start" }, { type: "error", error: "aborted" }]);
    expect(session.state).toBe("recording");
  });

  it("ignores results that arrive outside a session", () => {
    const { session } = play([{ type: "result", finals: "ghost", partial: "" }]);
    expect(session).toEqual(idleVoice());
  });

  it("appends dictated words to the field with one space, so they stay editable text", () => {
    expect(appendDictation("", "اطلب الآن")).toBe("اطلب الآن");
    expect(appendDictation("Keep the outfit. ", "Brighter background")).toBe("Keep the outfit. Brighter background");
    expect(appendDictation("A", "  ")).toBe("A");
  });
});
