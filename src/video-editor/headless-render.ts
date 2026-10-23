/**
 * "Render & update card" without the editor on screen (Campaign Autopilot's `render` step,
 * docs/campaign-autopilot.md): the project's latest SAVED revision rendered in this tab with the
 * editor's own engine and stored on the card, exactly as the editor's button does it
 * (ui/VideoEditor.tsx `runExport`): a render job of that revision (`startRender`, whose answer is
 * the revision's document, frozen), the footage and sound read the way the editor reads them
 * (load-media.ts), the frames rendered (`exportProject`), the job's heartbeat (`reportRender`),
 * the upload (`uploadRender`: the server stores the version and decides whether it goes on the
 * card), and `failRender` when anything fails after the job started.
 *
 * Photos (shared/campaign-assemble.ts): a photo's shot is a gap in the assembled project. With
 * `stills`, each such gap still in the saved project is first drawn as a clip at the project's size
 * and the gap's length (src/studio/stillClip.ts, as "Combine into one video" does), stored as a
 * version of the post (the upload route), put in place of its gap, and the project saved; the
 * render is then of that new revision. A retry finds those clips already in place and skips them.
 *
 * The browser must decode and encode H.264 (WebCodecs), as for the editor's render; the tab must
 * stay open until it finishes (a job whose tab stops reporting reads as interrupted on the server).
 */
import { pendingStills, placeStillClip, type StillRef } from "@shared/campaign-assemble";
import { isGap, type ClipSource, type VideoProject } from "@shared/video-project";
import { stillToClip } from "@/studio/stillClip";
import { listAudio, listVideos, type AudioTrack } from "@/studio/videoApi";
import { failRender, getProject, reportRender, saveProject, startRender, uploadFootage, uploadRender, versionFileUrl, type RenderItem } from "./api";
import { checkCapabilities } from "./engine/capabilities";
import { exportProject, overallProgress } from "./engine/export";
import { MediaStore } from "./engine/media";
import { addVersions, footageFor, loadMusic, loadVoices, musicFileOf, needsPostAudio, renderCodecs } from "./load-media";

export type { StillRef } from "@shared/campaign-assemble";

export interface HeadlessRenderOptions {
  /** 0 … 1 for the whole render (the job's own numbers), and what it is doing ("opening", "stills", "footage", the export's phases, "uploading", "done"). */
  onProgress?: (fraction: number, phase: string) => void;
  signal?: AbortSignal;
}

/** Draws the saved project's pending photo shots as clips, stores them as versions and saves the project; returns the revision to render. */
async function drawStills(args: { batch: string; post: number; projectId: string }, doc: VideoProject, rev: number, stills: readonly StillRef[], opts: HeadlessRenderOptions): Promise<{ doc: VideoProject; rev: number }> {
  const todo = pendingStills(doc, stills);
  if (!todo.length) return { doc, rev };
  let next = doc;
  for (const [n, t] of todo.entries()) {
    if (opts.signal?.aborted) throw new Error("Render stopped.");
    opts.onProgress?.(0, `stills ${n + 1}/${todo.length}`);
    const stem = t.still.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60) || "photo";
    const file = await stillToClip(t.still.url, `Photo ${stem}, as a clip`, t.seconds, doc.output);
    const { video } = await uploadFootage(args.batch, args.post, file);
    next = placeStillClip(next, t.clipId, { batch: args.batch, videoId: video.id, duration: video.duration && video.duration > 0 ? video.duration : t.seconds });
  }
  const saved = await saveProject(args.projectId, next, rev);
  return { doc: saved.document, rev: saved.project.rev };
}

/**
 * Renders the project's latest saved revision onto its post's card, as the editor's "Render &
 * update card" does; see the file's header. Resolves with the new version and where the server put
 * it ("card", "review" or "superseded"); rejects with a plain message (the job, when one was
 * started, is marked failed with it).
 */
export async function renderProjectToCard(args: { batch: string; post: number; projectId: string; stills?: readonly StillRef[] }, opts: HeadlessRenderOptions = {}): Promise<{ videoId: string; outcome: string }> {
  const { signal } = opts;
  const stop = () => {
    if (signal?.aborted) throw new Error("Render stopped.");
  };
  const progress = (f: number, phase: string) => opts.onProgress?.(Math.max(0, Math.min(1, f)), phase);
  const codecs = renderCodecs();
  const media = new MediaStore();
  let job: RenderItem | null = null;
  try {
    // 1. The project as saved, and a browser that can render it.
    progress(0, "opening");
    const opened = await getProject(args.projectId);
    if (opened.project.batch !== args.batch || opened.project.post !== args.post) throw new Error("This project belongs to another post.");
    const caps = await checkCapabilities(opened.document.output, codecs);
    if (!caps.canExport || !caps.videoCodec || !caps.audioEncoder) throw new Error(`${caps.message} ${caps.details.join(" ")}`.trim());
    stop();

    // 2. Photos drawn as clips first (a new saved revision), then the job of the revision to render.
    let rev = opened.project.rev;
    if (args.stills?.length) rev = (await drawStills(args, opened.document, rev, args.stills, opts)).rev;
    stop();
    const started = await startRender(args.projectId, rev);
    job = started.render;
    const jobId = job.id;
    const doc = started.document;

    // 3. The footage and the sound, read as the editor reads them.
    progress(0, "footage");
    if (doc.clips.some((c) => c.source.kind === "upload")) throw new Error("A clip uses a file picked on a computer, which is not stored with the post: open the project in the Video editor and replace it.");
    if (doc.lut && !doc.lut.data) throw new Error("This draft's LUT was saved before LUT tables were kept with it: open it in the Video editor and load the LUT file again.");
    const list = await listVideos(args.batch, args.post);
    const footage = footageFor(doc, args.batch, list.videos);
    const failed = await addVersions((s: ClipSource, where) => media.add(s, where), args.batch, footage.listed, { tag: "[headless-render]" });
    for (const o of footage.other) {
      try {
        await media.add({ kind: "version", batch: o.batch, videoId: o.videoId }, { url: versionFileUrl(o.batch, o.videoId), label: "Version" });
      } catch (e) {
        failed.push({ id: o.videoId, error: (e as Error).message });
      }
    }
    const missing = doc.clips.find((c) => !isGap(c) && !media.get(c.source));
    if (missing) throw new Error(failed[0]?.error ?? "A clip's footage could not be read in this tab.");
    stop();
    let tracks: AudioTrack[] = [];
    if (needsPostAudio(doc)) tracks = (await listAudio(args.batch, args.post)).tracks;
    let music: AudioBuffer | null = null;
    const musicAt = musicFileOf(doc.music, tracks);
    if (doc.music) {
      music = musicAt ? await loadMusic(musicAt).catch(() => null) : null;
      if (!music) throw new Error("The project's music could not be read: open it in the Video editor and pick the track again.");
    }
    const voices = await loadVoices(doc.voices, tracks);
    const lostVoice = doc.voices.find((v) => !voices.has(v.id));
    if (lostVoice) throw new Error(`The voice-over “${lostVoice.name}” could not be read: open the project in the Video editor and add it again or remove it.`);
    stop();

    // 4. The frames, rendered here; the job hears how far it is every two seconds.
    let lastBeat = 0;
    const result = await exportProject({
      project: doc,
      media,
      music,
      voices,
      lut: null,
      codecs,
      signal,
      onProgress: (x) => {
        const f = overallProgress(x) * 0.95;
        progress(f, x.phase);
        if (Date.now() - lastBeat > 2000) {
          lastBeat = Date.now();
          void reportRender(jobId, f, x.phase).catch(() => undefined);
        }
      },
    });

    // 5. The upload: the server stores the version and decides where it shows.
    progress(0.96, "uploading");
    void reportRender(jobId, 0.96, "uploading").catch(() => undefined);
    const r = await uploadRender({ batch: args.batch, post: args.post, projectId: args.projectId, renderId: jobId, file: result.blob, still: result.still, note: `${doc.name} · render of save ${rev}` });
    progress(1, "done");
    return { videoId: r.video.id, outcome: r.outcome ?? "card" };
  } catch (e) {
    const message = (e as Error).message || "The render failed.";
    if (job) await failRender(job.id, message).catch(() => undefined);
    throw new Error(message);
  } finally {
    media.dispose();
  }
}
