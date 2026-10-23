import { describe, expect, it } from "vitest";
import { footageFor, footageVersions, musicFileOf, needsPostAudio, referencedVersions } from "../shared/editor-media";
import { gapClip, newClip, newProject, type VideoProject } from "../shared/video-project";

const video = (id: string, status = "done", url: string | null = `/api/studio/posts/video/file?batch=b1&id=${id}`) => ({ id, status, url });

function project(): VideoProject {
  const p = newProject("Reel", 1);
  p.clips = [
    newClip({ kind: "version", batch: "b1", videoId: "v1" }, 5, "a"),
    gapClip(2, "g"),
    newClip({ kind: "version", batch: "b1", videoId: "v2" }, 5, "b"),
    newClip({ kind: "version", batch: "b1", videoId: "v1" }, 5, "c"),
    newClip({ kind: "version", batch: "b0", videoId: "v9" }, 5, "d"),
  ];
  return p;
}

describe("a project's footage in the browser (the editor and the headless render)", () => {
  it("lists the versions the clips use, once each, in order", () => {
    expect(referencedVersions(project())).toEqual([
      { batch: "b1", videoId: "v1" },
      { batch: "b1", videoId: "v2" },
      { batch: "b0", videoId: "v9" },
    ]);
  });

  it("takes the post's finished versions as the editor does, and names the others to read from the file route", () => {
    const videos = [video("v1"), video("v2", "generating", null), video("v3")];
    expect(footageVersions(videos).map((v) => v.id)).toEqual(["v1", "v3"]);
    const f = footageFor(project(), "b1", videos);
    expect(f.listed.map((v) => v.id)).toEqual(["v1"]);
    expect(f.other).toEqual([
      { batch: "b1", videoId: "v2" },
      { batch: "b0", videoId: "v9" },
    ]);
  });
});

describe("the project's music file", () => {
  const tracks = [{ id: "t1", name: "Licensed track", url: "/api/audio/t1" }];

  it("is the post's track, or the music library's route", () => {
    const p = project();
    expect(musicFileOf(p.music, tracks)).toBeNull();
    expect(needsPostAudio(p)).toBe(false);
    p.music = { source: { kind: "audioKey", key: "t1" }, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 };
    expect(musicFileOf(p.music, tracks)).toEqual({ name: "Licensed track", url: "/api/audio/t1", library: false });
    expect(musicFileOf(p.music, [])).toBeNull();
    expect(needsPostAudio(p)).toBe(true);
    const rights = { licence: { id: "cc0-1.0" as const, name: "CC0", version: "1.0", url: "" }, attributionRequired: false, credit: "", author: "", sourcePage: "", contentId: { status: "unknown" as const, note: "" } };
    p.music = { ...p.music, source: { kind: "catalog", trackId: "cat:bright", name: "Bright", rights } };
    expect(musicFileOf(p.music, [])).toEqual({ name: "Bright", url: "/api/studio/music/file?id=cat%3Abright", library: true });
    expect(needsPostAudio(p)).toBe(false);
  });
});
