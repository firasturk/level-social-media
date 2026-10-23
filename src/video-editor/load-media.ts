/**
 * How a post's project gets its footage and sound in this tab, shared by the Video editor
 * (ui/VideoEditor.tsx) and the render without the editor (headless-render.ts), so both read a
 * saved project the same way:
 *  - footage: the post's finished versions (status done, with a file) as `version` sources, each
 *    registered once in the tab's MediaStore with its label;
 *  - music: a post's licensed track (`audioKey`, from the post's audio list) or a music library
 *    track (`catalog` / `library`, from the library's file route), decoded;
 *  - voice-overs: the post's tracks they name, decoded;
 *  - the codecs a render uses (H.264 + AAC; VP9 + Opus only for the automated render check).
 * Which files a project needs is decided in shared/editor-media.ts (pure, tested).
 */
import type { ClipSource, VoiceClip } from "@shared/video-project";
import { versionLabel, type AudioTrack, type VideoItem } from "@/studio/videoApi";
import { decodeAudio } from "./engine/audio";
import { STUDIO_CODECS, TEST_CODECS, type ExportCodecs } from "./engine/capabilities";
import type { Media } from "./engine/media";

export { footageFor, footageVersions, musicFileOf, needsPostAudio, referencedVersions } from "@shared/editor-media";

export type AddSource = (source: ClipSource, where: { url: string; file?: File; label: string }) => Promise<Media>;

/** The automated render check turns this on to render VP9 + Opus where Chromium has no H.264 (never offered in the UI; the server refuses such files). */
export const testCodecs = (): boolean => {
  try {
    return localStorage.getItem("lsm-video-test-codecs") === "vp9";
  } catch {
    return false;
  }
};

export const renderCodecs = (): ExportCodecs => (testCodecs() ? TEST_CODECS : STUDIO_CODECS);

export const versionSource = (batch: string, v: Pick<VideoItem, "id">): ClipSource => ({ kind: "version", batch, videoId: v.id });

/**
 * Each version registered as a source, one after another; one the browser cannot read is logged
 * and skipped (its error is returned). `skip` leaves out versions already there.
 */
export async function addVersions(add: AddSource, batch: string, videos: readonly VideoItem[], opts: { tag?: string; skip?: (source: ClipSource) => boolean } = {}): Promise<{ id: string; error: string }[]> {
  const failed: { id: string; error: string }[] = [];
  for (const v of videos) {
    const source = versionSource(batch, v);
    if (opts.skip?.(source)) continue;
    try {
      await add(source, { url: v.url!, label: versionLabel(v) });
    } catch (e) {
      console.warn(opts.tag ?? "[video-editor]", (e as Error).message);
      failed.push({ id: v.id, error: (e as Error).message });
    }
  }
  return failed;
}

/** The project's music decoded (null when it has none, or it could not be read). A library file answers with its status checked first. */
export async function loadMusic(file: { url: string; library: boolean }): Promise<AudioBuffer | null> {
  const r = await fetch(file.url, { credentials: "same-origin" });
  if (file.library && !r.ok) return null;
  return decodeAudio(await r.arrayBuffer());
}

/** The voice-overs kept with the post, decoded, by voice id; one that cannot be read is logged and left out. */
export async function loadVoices(voices: readonly VoiceClip[] | null | undefined, tracks: readonly AudioTrack[] | null | undefined): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  for (const v of voices ?? []) {
    const vt = v.source.kind === "audioKey" ? tracks?.find((t) => t.id === (v.source as { key: string }).key) : null;
    if (!vt?.url) continue;
    try {
      const buffer = await decodeAudio(await (await fetch(vt.url, { credentials: "same-origin" })).arrayBuffer());
      if (buffer) out.set(v.id, buffer);
    } catch (e) {
      console.warn("[video-editor] voice-over", (e as Error).message);
    }
  }
  return out;
}
