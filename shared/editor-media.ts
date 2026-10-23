/**
 * Which files a video-editor project needs in the browser, decided the same way by the Video
 * editor and by the render without the editor (src/video-editor/load-media.ts,
 * src/video-editor/headless-render.ts): the post's versions used as footage, and where the music is
 * read from. Pure: the browser fetches and decodes.
 */
import { musicFileUrl, type Music, type VideoProject } from "./video-project";

/** The versions the editor reads as footage: finished, with a file. */
export const footageVersions = <T extends { status: string; url: string | null }>(videos: readonly T[]): T[] => videos.filter((v) => v.status === "done" && !!v.url);

/** The versions a project's clips use, in order, once each. */
export function referencedVersions(project: Pick<VideoProject, "clips">): { batch: string; videoId: string }[] {
  const seen = new Set<string>();
  const out: { batch: string; videoId: string }[] = [];
  for (const c of project.clips) {
    if (c.source.kind !== "version") continue;
    const k = `${c.source.batch}:${c.source.videoId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ batch: c.source.batch, videoId: c.source.videoId });
  }
  return out;
}

/**
 * The footage a project needs: the post's own finished versions it uses (`listed`, registered as
 * the editor registers them), and any other version it names (`other`: another month's, or one the
 * post's list does not show as finished), to be read from the studio's file route.
 */
export function footageFor<T extends { id: string; status: string; url: string | null }>(project: Pick<VideoProject, "clips">, batch: string, videos: readonly T[]): { listed: T[]; other: { batch: string; videoId: string }[] } {
  const own = footageVersions(videos);
  const listed: T[] = [];
  const other: { batch: string; videoId: string }[] = [];
  for (const r of referencedVersions(project)) {
    const v = r.batch === batch ? own.find((x) => x.id === r.videoId) : undefined;
    if (v) listed.push(v);
    else other.push(r);
  }
  return { listed, other };
}

/** Where the project's music is read from: the post's track (its name and address), or the music library's file route; null when there is none to read. */
export function musicFileOf(music: Pick<Music, "source"> | null | undefined, tracks: readonly { id: string; name: string; url: string | null }[] | null | undefined): { name: string; url: string; library: boolean } | null {
  const s = music?.source;
  if (!s) return null;
  if (s.kind === "audioKey") {
    const track = tracks?.find((t) => t.id === s.key);
    return track?.url ? { name: track.name, url: track.url, library: false } : null;
  }
  if (s.kind === "catalog" || s.kind === "library") return { name: s.name, url: musicFileUrl(s.trackId), library: true };
  return null;
}

/** Whether the project's sound needs the post's audio list (a post track as music or a voice-over). */
export const needsPostAudio = (p: Pick<VideoProject, "music" | "voices">): boolean => p.music?.source.kind === "audioKey" || (p.voices ?? []).some((v) => v.source.kind === "audioKey");
