import { describe, expect, it } from "vitest";
import { assembleReel, ASSEMBLE_CROSSFADE, ASSEMBLE_LOOK_AMOUNT, beatsFromBpm, GENERATED_LEAD, pendingStills, placeStillClip, shotClipId, splitWords, STILL_MARGIN, stillShots, type AssembleInput } from "../shared/campaign-assemble";
import { clipLength, cutTimes, MAX_TIMELINE_SECONDS, placeClips, totalLength, validateProject, type VideoProject } from "../shared/video-project";
import type { TextOverlay } from "../shared/video-compose";
import type { MusicTrack } from "../shared/music";

const NOW = 1_760_000_000_000;

const track = (bpm: number | null): MusicTrack => ({
  id: "cat:bright-days",
  kind: "catalog",
  title: "Bright Days",
  artist: "Someone",
  moods: ["upbeat"],
  genre: "pop",
  duration: 125,
  bpm,
  bpmSource: bpm ? "source" : null,
  test: false,
  source: { name: "Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Bright.ogg", author: "Someone" },
  licence: { id: "cc-by-4.0", name: "CC BY (Attribution)", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/", attribution: '"Bright Days" by Someone (CC BY 4.0)', attributionRequired: true },
  contentId: { status: "unknown", note: "Not stated by the source." },
  url: "/api/studio/music/file?id=cat%3Abright-days",
  peaksUrl: "/api/studio/music/peaks?id=cat%3Abright-days",
});

/** Three generated clips and the client's own clip (a Drive clip stored as a version). */
function reel(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    name: "Summer offer · Reel 1",
    batch: "batch-1",
    frame: "9:16",
    hook: "عرض الصيف / Summer offer",
    cta: { ar: "اطلب الآن", en: "Order now" },
    language: "both",
    transitions: "cuts",
    look: "warm-film",
    logo: { src: "/api/studio/clients/c1/logo", name: "Brand logo" },
    music: null,
    shots: [
      { key: "s1", seconds: 3, text: "", source: { kind: "video", videoId: "v-gen-1", duration: 5, origin: "generated" } },
      { key: "s2", seconds: 4, text: "طازج كل يوم\nFresh every day", source: { kind: "video", videoId: "v-gen-2", duration: 5.04, origin: "generated" } },
      { key: "s3", seconds: 3, text: { ar: "صنع بحب", en: "Made with love" }, source: { kind: "video", videoId: "v-gen-3", duration: 10, origin: "generated" } },
      { key: "s4", seconds: 5, text: "Visit us today", source: { kind: "video", videoId: "v-drive", duration: 24, origin: "existing" } },
    ],
    ...over,
  };
}

const texts = (p: VideoProject) => p.overlays.filter((o): o is TextOverlay => o.kind === "text");
const ARABIC = /[؀-ۿ]/;

describe("assembleReel", () => {
  it("puts the four shots in order, each trimmed to its planned seconds from its source", () => {
    const p = assembleReel(reel(), NOW);
    expect(p.clips.map((c) => c.id)).toEqual(["shot-s1", "shot-s2", "shot-s3", "shot-s4"]);
    expect(p.clips.map((c) => (c.source.kind === "version" ? c.source.videoId : null))).toEqual(["v-gen-1", "v-gen-2", "v-gen-3", "v-drive"]);
    expect(p.clips.every((c) => c.source.kind === "version" && c.source.batch === "batch-1")).toBe(true);
    expect(p.clips.map((c) => Math.round(clipLength(c) * 1000) / 1000)).toEqual([3, 4, 3, 5]);
    // Generated clips start just after their first frames; the client's clip is taken from its middle.
    expect(p.clips[0].in).toBeCloseTo(GENERATED_LEAD, 6);
    expect(p.clips[1].in).toBeCloseTo(0.2, 6);
    expect(p.clips[3].in).toBeCloseTo((24 - 5) / 2, 6);
    for (const c of p.clips) expect(c.out).toBeLessThanOrEqual(c.duration);
    expect(p.clips.every((c) => c.transition === "cut")).toBe(true);
    expect(totalLength(p)).toBeCloseTo(15, 6);
    expect(cutTimes(p.clips)).toEqual([3, 7, 10]);
    expect(p.output).toMatchObject({ width: 1080, height: 1920 });
  });

  it("uses a clip shorter than planned whole, and never reads past a clip's end", () => {
    const input = reel();
    input.shots[1] = { ...input.shots[1], seconds: 4, source: { kind: "video", videoId: "v-short", duration: 2.5, origin: "generated" } };
    input.shots[2] = { ...input.shots[2], source: { kind: "video", videoId: "v-gen-3", duration: 3.1, origin: "generated", start: 9 } };
    const p = assembleReel(input, NOW);
    expect(p.clips[1]).toMatchObject({ in: 0, out: 2.5 });
    expect(p.clips[2].out).toBeLessThanOrEqual(3.1);
    expect(clipLength(p.clips[2])).toBeCloseTo(3, 6);
    expect(p.edit!.summary.some((l) => l.includes("Shot 2") && l.includes("used whole"))).toBe(true);
    expect(validateProject(p).ok).toBe(true);
  });

  it("times the words: the hook on the first shot, each shot's words over it, the call to action and the logo on the end card", () => {
    const p = assembleReel(reel({ language: "en" }), NOW);
    const t = texts(p);
    const hook = t.find((o) => o.text === "Summer offer")!;
    expect(hook.start).toBeCloseTo(0.1, 3);
    expect(hook.end).toBeCloseTo(3, 3);
    expect(hook.y).toBeLessThan(0.3);
    const s2 = t.find((o) => o.text === "Fresh every day")!;
    expect([s2.start, s2.end]).toEqual([3.1, 7]);
    const s3 = t.find((o) => o.text === "Made with love")!;
    expect([s3.start, s3.end]).toEqual([7.1, 10]);
    // The last shot's words first, then the call to action to the end.
    const s4 = t.find((o) => o.text === "Visit us today")!;
    const cta = t.find((o) => o.text === "Order now")!;
    expect(s4.start).toBeCloseTo(10.1, 3);
    expect(s4.end).toBeCloseTo(cta.start, 3);
    expect(cta.end).toBeCloseTo(15, 3);
    expect(cta.end - cta.start).toBeGreaterThanOrEqual(1.2);
    const logo = p.overlays.find((o) => o.kind === "logo")!;
    expect(logo).toMatchObject({ src: "/api/studio/clients/c1/logo", end: 15 });
    expect(logo.start).toBeGreaterThanOrEqual(10);
    // Shot 1 has no words: nothing but the hook over it.
    expect(t.filter((o) => o.start < 3).map((o) => o.text)).toEqual(["Summer offer"]);
  });

  it("writes the words in Arabic, in English, or both (Arabic above English)", () => {
    const ar = texts(assembleReel(reel({ language: "ar" }), NOW));
    expect(ar.every((o) => ARABIC.test(o.text) || o.text === "Visit us today")).toBe(true);
    expect(ar.map((o) => o.text)).toContain("طازج كل يوم");
    expect(ar.map((o) => o.text)).toContain("اطلب الآن");
    // A shot with English words only shows them whatever the language asked.
    expect(ar.map((o) => o.text)).toContain("Visit us today");

    const en = texts(assembleReel(reel({ language: "en" }), NOW));
    expect(en.some((o) => ARABIC.test(o.text))).toBe(false);

    const both = texts(assembleReel(reel({ language: "both" }), NOW));
    const a = both.find((o) => o.text === "صنع بحب")!;
    const e = both.find((o) => o.text === "Made with love")!;
    expect([a.start, a.end]).toEqual([e.start, e.end]);
    expect(a.y).toBeLessThan(e.y);
    expect(both.filter((o) => o.text === "Visit us today")).toHaveLength(1);
  });

  it("applies the look, and says what was assembled", () => {
    const p = assembleReel(reel(), NOW);
    expect(p.look).toBe("warm-film");
    expect(p.lookAmount).toBe(ASSEMBLE_LOOK_AMOUNT);
    expect(p.edit).toMatchObject({ purpose: "campaign", pace: "cuts", at: NOW });
    expect(p.edit!.summary[0]).toMatch(/4 shots, 15\.0 s/);
    expect(p.edit!.summary.join("\n")).toMatch(/Look: Warm Film at 80 %/);
    expect(p.edit!.summary.length).toBeLessThanOrEqual(16);
    const none = assembleReel(reel({ look: "" }), NOW);
    expect(none.look).toBe("none");
    const unknown = assembleReel(reel({ look: "sepia-dream" }), NOW);
    expect(unknown.look).toBe("none");
    expect(unknown.edit!.summary.join("\n")).toMatch(/not one of the editor's looks/);
  });

  it("sets the music and snaps every cut to its beat when the BPM is known", () => {
    const p = assembleReel(reel({ music: track(128) }), NOW);
    expect(p.music?.source).toMatchObject({ kind: "catalog", trackId: "cat:bright-days", name: "Bright Days" });
    expect(p.music?.source.kind === "catalog" && p.music.source.rights.attributionRequired).toBe(true);
    expect(p.snapToBeats).toBe(true);
    expect(p.clips.every((c) => c.muted)).toBe(true);
    const beats = beatsFromBpm(128, 60);
    expect(p.music?.beats?.slice(0, 4)).toEqual(beats.slice(0, 4));
    const cuts = cutTimes(p.clips);
    expect(cuts).toHaveLength(3);
    for (const c of cuts) expect(beats.some((b) => Math.abs(b - c) <= 0.002)).toBe(true);
    // Moved to the nearest beat: within half a beat of the planned second.
    [3, 7, 10].forEach((want, i) => expect(Math.abs(cuts[i] - want)).toBeLessThanOrEqual(60 / 128 / 2 + 1e-3));
    // The words follow the snapped cuts.
    const s3 = texts(p).find((o) => o.text === "Made with love")!;
    expect(s3.start).toBeCloseTo(cuts[1] + 0.1, 3);
    expect(s3.end).toBeCloseTo(cuts[2], 3);
    expect(p.edit!.summary.join("\n")).toMatch(/3 of 3 on the beat at 128 BPM/);
    expect(validateProject(p).ok).toBe(true);
  });

  it("keeps the planned cuts when the track's tempo is unknown", () => {
    const p = assembleReel(reel({ music: track(null) }), NOW);
    expect(p.music?.beats).toBeUndefined();
    expect(p.snapToBeats).toBe(false);
    expect(cutTimes(p.clips)).toEqual([3, 7, 10]);
  });

  it("crossfades keep every cut on its planned second; mixed fades into the end card only", () => {
    const x = assembleReel(reel({ transitions: "crossfades" }), NOW);
    expect(x.clips.slice(1).every((c) => c.transition === "crossfade" && c.transitionDuration === ASSEMBLE_CROSSFADE)).toBe(true);
    expect(cutTimes(x.clips).map((t) => Math.round(t * 1e6) / 1e6)).toEqual([3, 7, 10]);
    expect(totalLength(x)).toBeCloseTo(15, 6);
    const m = assembleReel(reel({ transitions: "mixed" }), NOW);
    expect(m.clips.map((c) => c.transition)).toEqual(["cut", "cut", "cut", "crossfade"]);
    expect(totalLength(m)).toBeCloseTo(15, 6);
  });

  it("passes the editor's own validation unchanged", () => {
    for (const over of [{}, { music: track(128) }, { transitions: "crossfades" as const }, { language: "ar" as const, logo: null }]) {
      const p = assembleReel(reel(over), NOW);
      const checked = validateProject(JSON.parse(JSON.stringify(p)));
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(checked.project).toEqual(p);
    }
  });

  it("is deterministic for the same input", () => {
    expect(JSON.stringify(assembleReel(reel({ music: track(128) }), NOW))).toBe(JSON.stringify(assembleReel(reel({ music: track(128) }), NOW)));
  });

  it("leaves a photo's shot as a gap the browser fills, with its picture listed", () => {
    const input = reel({ transitions: "mixed" });
    input.shots[2] = { key: "s3", seconds: 3, text: "Made with love", source: { kind: "photo", url: "/api/studio/drive/photo?id=abc", name: "shop.jpg" } };
    const p = assembleReel(input, NOW);
    const gap = p.clips[2];
    expect(gap.source.kind).toBe("gap");
    expect(gap.id).toBe(shotClipId(input.shots[2], 2));
    expect(gap.keyframes?.zoom?.length).toBe(2);
    // Mixed: crossfades into and out of the photo, into the end card; the cuts stay on their seconds.
    expect(p.clips.map((c) => c.transition)).toEqual(["cut", "cut", "crossfade", "crossfade"]);
    expect(cutTimes(p.clips).map((t) => Math.round(t * 1e6) / 1e6)).toEqual([3, 7, 10]);
    expect(stillShots(input)).toEqual([{ clipId: "shot-s3", url: "/api/studio/drive/photo?id=abc", name: "shop.jpg" }]);
    expect(p.edit!.summary.some((l) => l.includes("shop.jpg"))).toBe(true);
    expect(validateProject(p).ok).toBe(true);
  });

  it("keeps the timeline within the editor's limit", () => {
    const shots = Array.from({ length: 8 }, (_, i) => ({ key: `s${i + 1}`, seconds: 10, text: "", source: { kind: "video" as const, videoId: `v${i}`, duration: 10, origin: "generated" as const } }));
    const p = assembleReel(reel({ shots, music: track(128) }), NOW);
    expect(totalLength(p)).toBeLessThanOrEqual(MAX_TIMELINE_SECONDS);
    expect(p.clips.length).toBe(6);
    expect(validateProject(p).ok).toBe(true);
    expect(placeClips(p.clips).at(-1)!.end).toBeLessThanOrEqual(MAX_TIMELINE_SECONDS);
  });

  it("refuses a Reel with no shots or a clip with no length", () => {
    expect(() => assembleReel(reel({ shots: [] }), NOW)).toThrow(/no shots/);
    const input = reel();
    input.shots[0] = { ...input.shots[0], source: { kind: "video", videoId: "x", duration: 0, origin: "generated" } };
    expect(() => assembleReel(input, NOW)).toThrow(/Shot 1/);
  });
});

describe("photo shots drawn in the browser", () => {
  const withPhoto = () => {
    const input = reel({ music: track(128) });
    input.shots[2] = { key: "s3", seconds: 3, text: "", source: { kind: "photo", url: "/api/p", name: "shop.jpg" } };
    return input;
  };

  it("lists the gaps still to draw with the seconds of picture they need", () => {
    const input = withPhoto();
    const p = assembleReel(input, NOW);
    const todo = pendingStills(p, stillShots(input));
    expect(todo).toHaveLength(1);
    expect(todo[0].clipId).toBe("shot-s3");
    expect(todo[0].seconds).toBeGreaterThanOrEqual(p.clips[2].out + STILL_MARGIN - 1e-9);
    // A still whose clip was deleted in the editor is not drawn.
    expect(pendingStills({ clips: p.clips.filter((c) => c.id !== "shot-s3") }, stillShots(input))).toEqual([]);
  });

  it("puts the drawn clip in place of its gap, keeping its place, joins and push in", () => {
    const input = withPhoto();
    const p = assembleReel(input, NOW);
    const before = placeClips(p.clips);
    const q = placeStillClip(p, "shot-s3", { batch: "batch-1", videoId: "v-still", duration: pendingStills(p, stillShots(input))[0].seconds });
    const c = q.clips[2];
    expect(c.source).toEqual({ kind: "version", batch: "batch-1", videoId: "v-still" });
    expect(c.muted).toBe(true);
    expect(c.keyframes).toEqual(p.clips[2].keyframes);
    expect(placeClips(q.clips).map((x) => [x.start, x.end])).toEqual(before.map((x) => [x.start, x.end]));
    expect(validateProject(q).ok).toBe(true);
    expect(pendingStills(q, stillShots(input))).toEqual([]);
    // Placing again (a retry) changes nothing.
    expect(placeStillClip(q, "shot-s3", { batch: "batch-1", videoId: "other", duration: 9 })).toBe(q);
  });
});

describe("splitWords", () => {
  it("reads the Arabic and the English line from one string or apart", () => {
    expect(splitWords("عرض الصيف / Summer offer")).toEqual({ ar: "عرض الصيف", en: "Summer offer" });
    expect(splitWords("Hello\nمرحبا")).toEqual({ ar: "مرحبا", en: "Hello" });
    expect(splitWords("Only English")).toEqual({ ar: "", en: "Only English" });
    expect(splitWords({ ar: " مرحبا ", en: null })).toEqual({ ar: "مرحبا", en: "" });
    expect(splitWords(null)).toEqual({ ar: "", en: "" });
  });
});
