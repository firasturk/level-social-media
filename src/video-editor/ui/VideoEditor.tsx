/**
 * The Video studio: one full-screen workspace for a post's videos, in the Photo studio's shell: a
 * top bar (the post, the clip's state, undo/redo for the timeline, Versions, the switches to the
 * Photo and Text studios, Close), a rail of tools on the left, the stage in the middle, the chosen
 * tool's panel on the right; on a phone one panel at a time from a bottom toolbar.
 *
 * The rail: Presets (Higgsfield's preset gallery with each preset's own reference video), Generate
 * (a clip from the picture: Higgsfield on the subscription credits or the Cloud key, or Magnific),
 * Edit (the browser-side editor that was here before: timeline, auto edit, music, colour, export),
 * Enhance (the providers' tools on a clip), Audio, Versions and Check. Nothing is made or spent
 * without the confirm each tool asks; members browse and look, admins run.
 *
 * Opened with no post (`/video-editor`) it is the standalone editor as before: footage from this
 * computer only, the export saved as a file.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Aperture, ArrowRight, Clapperboard, Download, History, Image as ImageIcon, LayoutGrid, Lock, Maximize, Monitor, Music, Palette, Pause, Play, Redo2, Save, ScanSearch, Scissors, SlidersHorizontal, Smartphone, Sparkles, Square, Type, Undo2, Volume2, VolumeX, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { saveBlob } from "@/lib/zip";
import { Orb } from "@/components/Orb";
import type { Approval } from "@shared/config";
import { parseCube, serialiseCube, type CubeLut } from "@shared/cube-lut";
import { cutTimes, DEFAULT_DUCKING, musicFileUrl, musicSourceFromTrack, newClip, newClipId, newProject, placeClips, timelineBeats, totalLength, validateProject, type Clip, type ClipSource, type VideoProject } from "@shared/video-project";
import { alignCutsToBeats, clickSelect, deleteClips, formatTimecode, moveClips, splitAt, stepFrames } from "@shared/video-timeline";
import { planFirstCut, type FirstCutInput, type Pace, type Purpose } from "@shared/video-autoedit";
import { frameOfOutput, newLogoOverlay, newTextOverlay, outputForFrame, type FitMode, type Overlay } from "@shared/video-compose";
import { isFrame, type FrameId } from "@shared/video-frame";
import type { PresetCard } from "@shared/video-presets";
import { inFlight, listAudio, listVideos, selectForClient, uploadAudio, versionLabel, type AudioTrack, type VideoItem } from "@/studio/videoApi";
import { createProject, failRender, getProject, listProjects, listRenders, reportRender, saveProject, startRender, uploadFootage, uploadRender, versionFileUrl, type EditorAccess, type RenderItem } from "../api";
import { checkCapabilities, STUDIO_CODECS, TEST_CODECS, type Capabilities } from "../engine/capabilities";
import { beatsOf, decodeAudio } from "../engine/audio";
import { MediaStore, type Media } from "../engine/media";
import { Player } from "../engine/preview";
import { exportProject, overallProgress, type ExportProgress } from "../engine/export";
import { useHistory } from "./history";
import Timeline from "./Timeline";
import { ClipsPanel, ExportPanel, LogoPanel, MusicPanel, TextPanel, type PanelCtx } from "./Panels";
import { AutoEditPanel } from "./AutoEditPanel";
import { VoicePanel } from "./MusicMix";
import { AUTOSAVE_MS, clearDraft, draftKey, draftTime, readDraft, recoveryOffer, setDraftAside, writeDraft } from "./autosave";
import { ColourPanel } from "./ColourPanel";
import type { MusicPick } from "./MusicLibrary";
import type { LooksCtx, RefPicture } from "./looks-ctx";
import { PresetDetailPanel, PresetsGallery, usePresets } from "./studio/PresetsPanel";
import GeneratePanel from "./studio/GeneratePanel";
import EnhancePanel from "./studio/EnhancePanel";
import AudioPanel from "./studio/AudioPanel";
import VersionsPanel from "./studio/VersionsPanel";
import CheckPanel from "./studio/CheckPanel";
import VersionStage from "./studio/VersionStage";
import type { GeneratePrefill, StudioPanel, StudioShared } from "./studio/types";
import "./video-studio.css";
import { getSession, patchSession, videoMemory } from "@/studio/editing-session";

export type { StudioPanel } from "./studio/types";

export interface EditorPost {
  batch: string;
  index: number;
  title: string;
}

interface Props {
  open: boolean;
  /** The post whose versions are the footage; null for the standalone editor. */
  post: EditorPost | null;
  /** The version to start from (the client's, else the newest finished clip). */
  initialVideoId?: string | null;
  /** The panel to open on; a post with no clip opens on Presets. */
  initialPanel?: StudioPanel;
  /** The post's picture: the first frame of a clip made here, and the stage before any clip exists. */
  pictureUrl?: string | null;
  /** The post as it will be published, words and logo drawn by the browser, as a data URL. */
  composeArtwork?: () => Promise<string>;
  /** The client's answers on the approval link for this post. */
  approval?: Approval | null;
  fileBase: string;
  onClose: () => void;
  /** An export was stored as a new version of the post. */
  onExported?: (video: VideoItem) => void;
  /** The post's versions changed (a clip made, selected or finished): the cards read them again. */
  onChanged?: () => void;
  /** Opens the Photo studio on the same post. */
  onPhotoStudio?: () => void;
  /** Opens the Text studio on the same post. */
  onTextStudio?: () => void;
  /** The client's logo (the brand kit's), offered as a logo layer. */
  logoUrl?: string | null;
  /** The client: its Drive photos (colour references) and its own music library. */
  client?: { id: string; name: string } | null;
  /** Pictures saved in the studio for this post (its pinned reference, the theme's pins), offered as colour references. */
  references?: RefPicture[];
}

type Tab = "clips" | "text" | "logo" | "music" | "colour" | "auto" | "export";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "clips", label: "Media", icon: <Clapperboard size={14} /> },
  { id: "text", label: "Text", icon: <Type size={14} /> },
  { id: "logo", label: "Logo", icon: <ImageIcon size={14} /> },
  { id: "music", label: "Music", icon: <Music size={14} /> },
  { id: "colour", label: "Colour", icon: <Palette size={14} /> },
  { id: "auto", label: "Auto edit", icon: <Wand2 size={14} /> },
  { id: "export", label: "Render", icon: <Download size={14} /> },
];

/** The four frames above the stage, each the encoded size of the render (shared/video-compose.ts). */
const RATIOS: { id: FrameId; icon: ReactNode; title: string }[] = [
  { id: "9:16", icon: <Smartphone size={13} />, title: "Reel 9:16 · renders 1080×1920" },
  { id: "4:5", icon: <Smartphone size={13} />, title: "Portrait 4:5 · renders 1080×1350" },
  { id: "1:1", icon: <Square size={13} />, title: "Square 1:1 · renders 1080×1080" },
  { id: "16:9", icon: <Monitor size={13} />, title: "Landscape 16:9 · renders 1920×1080" },
];

/** The automated render check turns this on to render VP9 + Opus where Chromium has no H.264 (never offered in the UI; the server refuses such files). */
const testCodecs = () => {
  try {
    return localStorage.getItem("lsm-video-test-codecs") === "vp9";
  } catch {
    return false;
  }
};

const PANELS: { id: StudioPanel; label: string; icon: ReactNode; title: string; paid?: boolean }[] = [
  { id: "presets", label: "Presets", icon: <LayoutGrid size={18} />, title: "Presets: Higgsfield's preset gallery, each with its reference video (browse freely; running one is admins only)" },
  { id: "generate", label: "Generate", icon: <Sparkles size={18} />, title: "Generate: a clip from this post's picture (Higgsfield or Magnific; the cost is said first)", paid: true },
  { id: "edit", label: "Edit", icon: <Scissors size={18} />, title: "Edit: cut, auto edit, music, colour and export, drawn here in the browser" },
  { id: "enhance", label: "Enhance", icon: <Wand2 size={18} />, title: "Enhance: upscale, colour grade, music, reframe and more on a clip (admins only for now)", paid: true },
  { id: "audio", label: "Audio", icon: <Music size={18} />, title: "Audio: the sound each version carries" },
  { id: "versions", label: "Versions", icon: <History size={18} />, title: "Versions: every clip of this post, compared and selected for the client" },
  { id: "check", label: "Check", icon: <ScanSearch size={18} />, title: "Check: Higgsfield's reading of a clip (admins only for now)", paid: true },
];

const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
const MAX_FOOTAGE = 60 * 1024 * 1024;

export default function VideoEditor({ open, post, initialVideoId, initialPanel, pictureUrl, composeArtwork, approval, fileBase, onClose, onExported, onChanged, onPhotoStudio, onTextStudio, logoUrl, client, references }: Props) {
  const history = useHistory();
  const { project } = history;
  const projectRef = useRef<VideoProject | null>(null);
  projectRef.current = project;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<MediaStore>(new MediaStore());
  const playerRef = useRef<Player | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState("Opening the editor…");
  const [fatal, setFatal] = useState<string | null>(null);
  const [access, setAccess] = useState<EditorAccess>({ admin: !post, enabled: true, reason: "" });
  const [sources, setSources] = useState<Media[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  /** The selected clips (shift / cmd clicks on the timeline); the last one is the one the panels show. */
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.length ? selection[selection.length - 1] : null;
  const [snapping, setSnapping] = useState(true);
  const [autoNotes, setAutoNotes] = useState<string[]>([]);
  /** The voice-over recordings' sound, by voice id (the project keeps where they are, the tab keeps the sound). */
  const [voiceBuffers, setVoiceBuffers] = useState<Map<string, AudioBuffer>>(() => new Map());
  const [voiceBusy, setVoiceBusy] = useState("");
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>("clips");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches);
  const [panelOpen, setPanelOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [footageBusy, setFootageBusy] = useState("");
  const [autoBusy, setAutoBusy] = useState("");
  const [musicFile, setMusicFile] = useState<{ name: string; buffer: AudioBuffer; beats: number[] } | null>(null);
  const [musicBusy, setMusicBusy] = useState("");
  const [lut, setLut] = useState<{ name: string; lut: CubeLut } | null>(null);
  const [bypass, setBypass] = useState(false);
  const [splitView, setSplitView] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The project's render jobs, newest first, and the one this tab is running. */
  const [renders, setRenders] = useState<RenderItem[]>([]);
  const [running, setRunning] = useState<{ id: string | null; progress: number } | null>(null);
  const [selectedOverlay, setSelectedOverlay] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  /** The project is loaded: from now on the unsaved cut, its music and LUT travel in the card's editing session. */
  const [ready, setReady] = useState(false);

  /* The studio around the editor */
  // A post opens on Generate (or the panel asked for); once its versions are read, a post with no clip opens on Presets instead.
  const [panel, setPanel] = useState<StudioPanel>(post ? (initialPanel ?? "generate") : "edit");
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [videosLoaded, setVideosLoaded] = useState(false);
  const [admin, setAdmin] = useState(!post);
  const [shownId, setShownId] = useState<string | null>(initialVideoId ?? null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<GeneratePrefill | null>(null);

  const readOnly = !access.admin || !access.enabled;
  const standalone = !post;
  const editing = panel === "edit";

  /* ───────────── Narrow screens ───────────── */
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open]);

  /* ───────────── Loading: capabilities, the post's versions, the project ───────────── */
  const labelOf = useCallback((clip: Clip): string => {
    if (clip.source.kind === "gap") return "Gap";
    const m = mediaRef.current.get(clip.source);
    if (m) return m.label;
    return clip.source.kind === "version" ? "Version" : clip.source.name;
  }, []);

  const addSource = useCallback(async (source: ClipSource, where: { url: string; file?: File; label: string }): Promise<Media> => {
    const m = await mediaRef.current.add(source, where);
    setSources(mediaRef.current.all());
    return m;
  }, []);

  /** The post's versions read again; new finished clips join the footage when this browser can decode them. */
  const reloadVideos = useCallback(async () => {
    if (!post) return;
    try {
      const list = await listVideos(post.batch, post.index);
      setVideos(list.videos);
      setAdmin(list.admin);
      setVideosLoaded(true);
      if (caps?.canDecode) {
        for (const v of list.videos.filter((v) => v.status === "done" && v.url)) {
          if (mediaRef.current.get({ kind: "version", batch: post.batch, videoId: v.id })) continue;
          try {
            await addSource({ kind: "version", batch: post.batch, videoId: v.id }, { url: v.url!, label: versionLabel(v) });
          } catch (e) {
            console.warn("[video-studio]", (e as Error).message);
          }
        }
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [post, caps?.canDecode, addSource]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const media = mediaRef.current;
    void (async () => {
      try {
        const c = await checkCapabilities(undefined, testCodecs() ? TEST_CODECS : STUDIO_CODECS);
        if (!alive) return;
        setCaps(c);
        let doc: VideoProject | null = null;
        let vids: VideoItem[] = [];
        let latestId: string | null = null;
        let canWrite = false;
        let serverUpdatedAt = 0;
        if (post) {
          setLoading("Reading the post's versions…");
          const [list, projects] = await Promise.all([listVideos(post.batch, post.index), listProjects(post.batch, post.index)]);
          if (!alive) return;
          setVideos(list.videos);
          setAdmin(list.admin);
          setVideosLoaded(true);
          vids = list.videos.filter((v) => v.status === "done" && v.url);
          setAccess(projects.access);
          canWrite = projects.access.admin && projects.access.enabled;
          // The stage shows the version asked for, else the client's, else the newest finished clip; a post with no clip opens on Presets.
          const start = vids.find((v) => v.id === initialVideoId) ?? vids.find((v) => v.forClient) ?? vids[0] ?? null;
          setShownId(start?.id ?? null);
          if (!vids.length && !initialPanel) setPanel("presets");
          if (c.canDecode) {
            setLoading("Reading the footage…");
            for (const v of vids) {
              try {
                await addSource({ kind: "version", batch: post.batch, videoId: v.id }, { url: v.url!, label: versionLabel(v) });
              } catch (e) {
                console.warn("[video-editor]", (e as Error).message);
              }
            }
          }
          const latest = projects.projects[0];
          latestId = latest?.id ?? null;
          if (latest) {
            setLoading("Opening the project…");
            const r = await getProject(latest.id);
            if (!alive) return;
            doc = r.document;
            setProjectId(r.project.id);
            setRev(r.project.rev);
            serverUpdatedAt = r.project.updated;
            void listRenders(r.project.id)
              .then((x) => alive && setRenders(x.renders))
              .catch(() => undefined);
          } else {
            doc = newProject(`${post.title || `Post ${post.index}`} · cut`);
            // A new cut starts in the frame of the clip it opens from (what the card plays), Reel 9:16 when that is not one of the four.
            if (start?.frame && isFrame(start.frame)) doc.output = { ...doc.output, ...outputForFrame(start.frame) };
            const m = start ? media.get({ kind: "version", batch: post.batch, videoId: start.id }) : null;
            if (m) doc.clips = [newClip(m.source, m.duration)];
          }
          // The post's licensed tracks: the music a saved cut uses is read back from them, so a reopened project sounds as it did.
          const audio = await listAudio(post.batch, post.index).catch(() => null);
          if (audio && alive) setTracks(audio.tracks);
          const keyed = doc.music?.source.kind === "audioKey" ? doc.music.source.key : null;
          const track = keyed ? audio?.tracks.find((t) => t.id === keyed) : null;
          if (track?.url && doc.music) {
            setLoading("Reading the music…");
            try {
              const buffer = await decodeAudio(await (await fetch(track.url, { credentials: "same-origin" })).arrayBuffer());
              if (buffer && alive) setMusicFile({ name: track.name, buffer, beats: doc.music.beats ?? [] });
            } catch (e) {
              console.warn("[video-editor] music", (e as Error).message);
            }
          }
          // A music library track (catalog or the client's own) is read back from the library's route.
          const lib = doc.music?.source.kind === "catalog" || doc.music?.source.kind === "library" ? doc.music.source : null;
          if (lib && doc.music) {
            setLoading("Reading the music…");
            try {
              const r = await fetch(musicFileUrl(lib.trackId), { credentials: "same-origin" });
              const buffer = r.ok ? await decodeAudio(await r.arrayBuffer()) : null;
              if (buffer && alive) setMusicFile({ name: lib.name, buffer, beats: doc.music.beats ?? [] });
            } catch (e) {
              console.warn("[video-editor] music", (e as Error).message);
            }
          }
          // The voice-overs kept with the post, read back the same way.
          const voiceMap = new Map<string, AudioBuffer>();
          for (const v of doc.voices ?? []) {
            const vt = v.source.kind === "audioKey" ? audio?.tracks.find((t) => t.id === (v.source as { key: string }).key) : null;
            if (!vt?.url) continue;
            try {
              const buffer = await decodeAudio(await (await fetch(vt.url, { credentials: "same-origin" })).arrayBuffer());
              if (buffer) voiceMap.set(v.id, buffer);
            } catch (e) {
              console.warn("[video-editor] voice-over", (e as Error).message);
            }
          }
          if (alive && voiceMap.size) setVoiceBuffers(voiceMap);
        } else {
          doc = newProject("New cut");
        }
        if (!alive) return;
        history.load(doc);
        // An autosaved copy newer than the server's draft: ask before using it; the server's draft is never touched without Save.
        if (post && canWrite) {
          const key = draftKey(post, latestId);
          const local = readDraft(key);
          const server = latestId ? { id: latestId, rev: doc.rev, updated: serverUpdatedAt, document: doc } : null;
          const offer = recoveryOffer(local, server);
          if (local && offer.offer) {
            const ok = await askConfirm(
              `Recover unsaved changes from ${draftTime(local.savedAt)}? They were kept in this browser and never saved to the studio.${offer.stale ? ` The draft has been saved again since (now save ${doc.rev}); recovering and then saving would replace that save.` : ""}`,
              { ok: "Recover", danger: false, cancel: "Keep the saved draft" },
            );
            if (!alive) return;
            if (ok) {
              const checked = validateProject({ ...local.project, rev: doc.rev });
              if (checked.ok) {
                history.commit(checked.project);
                toast.message("Unsaved changes recovered: Save draft to keep them.");
              } else toast.error(`The kept copy cannot be opened: ${checked.reason}`);
            } else setDraftAside(key);
          } else if (local && !offer.offer && latestId) clearDraft(key);
        }
        // A cut not saved yet (left for the Photo or Text studio) comes back on top of the saved one: undo goes back to it.
        const kept = post ? getSession(post.batch, post.index)?.video : null;
        if (post && kept) {
          history.commit(kept.project);
          const mem = videoMemory(post.batch, post.index);
          if (kept.project.music && mem.music && "name" in kept.project.music.source && mem.music.name === kept.project.music.source.name) setMusicFile(mem.music);
          if (kept.project.lut && mem.lut && mem.lut.name === kept.project.lut.name) setLut(mem.lut);
          if (kept.projectId && kept.projectId !== latestId) toast.message("Your unsaved cut is back; it was started on another project of this post.");
        }
        setReady(true);
        setLoading("");
      } catch (e) {
        if (alive) setFatal((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, post?.batch, post?.index]);

  /* ───────────── The card's editing session: the unsaved cut, its files and the version shown travel with a switch ───────────── */
  // The post arrives as a new object on every render of the month: the session follows its batch and index.
  const pb = post?.batch ?? null;
  const pi = post?.index ?? 0;
  useEffect(() => {
    if (!open || !pb) return;
    patchSession(pb, pi, { studio: "video" });
    return () => {
      patchSession(pb, pi, (s) => ({ studio: s.studio === "video" ? null : s.studio }));
    };
  }, [open, pb, pi]);
  const dirty = history.dirty;
  useEffect(() => {
    if (!open || !pb || !ready || readOnly || !project) return;
    const cur = getSession(pb, pi)?.video ?? null;
    if (dirty) {
      if (cur?.project !== project || cur.projectId !== projectId || cur.rev !== rev) patchSession(pb, pi, { video: { project, projectId, rev } });
    } else if (cur) patchSession(pb, pi, { video: null });
  }, [open, pb, pi, ready, readOnly, project, projectId, rev, dirty]);
  useEffect(() => {
    if (!pb || !ready) return;
    const mem = videoMemory(pb, pi);
    mem.music = musicFile;
    mem.lut = lut;
  }, [pb, pi, ready, musicFile, lut]);
  useEffect(() => {
    if (!open || !pb || !ready || !shownId) return;
    if (getSession(pb, pi)?.videoId !== shownId) patchSession(pb, pi, { videoId: shownId });
  }, [open, pb, pi, ready, shownId]);

  /* ───────────── Autosave: a local copy of unsaved changes every few seconds (never sent without Save) ───────────── */
  const lastWritten = useRef<VideoProject | null>(null);
  const autosaveRef = useRef({ pb, pi, projectId, rev, dirty });
  autosaveRef.current = { pb, pi, projectId, rev, dirty };
  useEffect(() => {
    if (!open || !pb || !ready || readOnly) return;
    const t = setInterval(() => {
      const a = autosaveRef.current;
      const p = projectRef.current;
      if (!a.pb || !a.dirty || !p || p === lastWritten.current) return;
      if (writeDraft({ key: draftKey({ batch: a.pb, index: a.pi }, a.projectId), projectId: a.projectId, rev: a.rev, savedAt: Date.now(), project: p })) lastWritten.current = p;
    }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [open, pb, ready, readOnly]);

  // While a clip is being made, the versions are read again every few seconds (the server reconnects to the job).
  const pending = videos.some(inFlight);
  useEffect(() => {
    if (!open || !pending) return;
    const t = setInterval(() => void reloadVideos().then(() => onChanged?.()), 6000);
    return () => clearInterval(t);
  }, [open, pending, reloadVideos, onChanged]);

  // The footage on the timeline is read once with the demuxer when it is placed there (rotation, colour), so
  // the Media panel says what was found; versions not on the timeline are not downloaded for it.
  const clipSources = project?.clips.map((c) => c.source);
  useEffect(() => {
    if (!open || !clipSources) return;
    for (const src of clipSources) {
      const m = mediaRef.current.get(src);
      if (m && !m.inspecting) void mediaRef.current.inspect(m).then((meta) => meta && setSources(mediaRef.current.all().slice()));
    }
  }, [open, clipSources, sources]);

  /* ───────────── The player ───────────── */
  useEffect(() => {
    if (!open || !project || !canvasRef.current || playerRef.current) return;
    try {
      const player = new Player(canvasRef.current, mediaRef.current, project);
      player.onTime = (t, p) => {
        setTime(t);
        setPlaying(p);
      };
      playerRef.current = player;
      player.split = splitView ? 0.5 : null;
    } catch (e) {
      setFatal((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project === null, editing]);
  useEffect(() => {
    if (project) playerRef.current?.setProject(project);
  }, [project]);
  useEffect(() => {
    playerRef.current?.setLut(lut?.lut ?? null);
  }, [lut]);
  useEffect(() => {
    playerRef.current?.setMusic(musicFile?.buffer ?? null);
  }, [musicFile]);
  useEffect(() => {
    playerRef.current?.setVoices(voiceBuffers);
  }, [voiceBuffers]);
  useEffect(() => {
    if (playerRef.current) playerRef.current.bypass = bypass;
  }, [bypass]);
  useEffect(() => {
    if (playerRef.current) playerRef.current.split = splitView ? 0.5 : null;
  }, [splitView]);
  // Leaving the Edit panel unmounts the canvas: the player is disposed and made again on return.
  useEffect(() => {
    if (editing) return;
    playerRef.current?.dispose();
    playerRef.current = null;
  }, [editing]);
  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      playerRef.current?.dispose();
      playerRef.current = null;
      media.dispose();
    };
  }, []);

  /* ───────────── Editing ───────────── */
  const selectedClip = useMemo(() => project?.clips.find((c) => c.id === selected) ?? null, [project, selected]);
  const beats = useMemo(() => (project ? timelineBeats(project.music, totalLength(project)) : []), [project]);

  const seek = (t: number) => playerRef.current?.seek(t);
  const togglePlay = () => (playerRef.current?.playing ? playerRef.current.pause() : playerRef.current?.play());

  const addClip = (m: Media) => {
    history.commit((p) => ({ ...p, clips: [...p.clips, newClip(m.source, m.duration)] }));
    const total = project ? totalLength(project) : 0;
    if (total + m.duration > 60) toast.message("The timeline is longer than 60 s now; trim it before exporting.");
  };

  const addFootage = async (files: FileList) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FOOTAGE) {
        toast.error(`${file.name} is larger than 60 MB.`);
        continue;
      }
      try {
        if (post && !readOnly) {
          setFootageBusy(`Uploading ${file.name}…`);
          const r = await uploadFootage(post.batch, post.index, file);
          setFootageBusy(`Reading ${file.name}…`);
          const m = await addSource({ kind: "version", batch: post.batch, videoId: r.video.id }, { url: r.video.url ?? versionFileUrl(post.batch, r.video.id), label: versionLabel(r.video) });
          addClip(m);
          void reloadVideos();
        } else {
          setFootageBusy(`Reading ${file.name}…`);
          const m = await addSource({ kind: "upload", name: file.name, size: file.size }, { url: URL.createObjectURL(file), file, label: file.name.replace(/\.[^.]+$/, "") });
          addClip(m);
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setFootageBusy("");
      }
    }
  };

  const split = () => {
    const p = projectRef.current;
    if (!p) return;
    const t = playerRef.current?.time ?? time;
    const under = placeClips(p.clips).some((x) => t > x.start && t < x.end);
    if (!under) return toast.message("Put the playhead inside a clip to split it.");
    // The selected clip under the playhead, else whichever clip is under it.
    const r = splitAt(p.clips, t, selection.filter((id) => placeClips(p.clips).some((x) => x.clip.id === id && t > x.start && t < x.end)));
    if (!r) return toast.message("Too close to the clip's edge to split.");
    const speech = p.clips.find((c) => c.speech && !r.clips.some((x) => x.id === c.id && x.out === c.out));
    history.commit((q) => ({ ...q, clips: r.clips }));
    setSelection(r.right);
    if (speech) toast.message("This clip has speech: the split may cut a word in two.");
  };
  /** Deletes the selected clips: closing the gap (ripple: what follows moves left with its text and voice-over) or leaving it. */
  const remove = (ripple = true) => {
    if (!selection.length) return;
    history.commit((p) => deleteClips(p, selection, ripple));
    setSelection([]);
  };
  const move = (dir: -1 | 1) => {
    if (!selection.length) return;
    history.commit((p) => {
      const idx = p.clips.map((c, i) => (selection.includes(c.id) ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return p;
      const to = dir < 0 ? Math.max(0, idx[0] - 1) : Math.min(p.clips.length, idx[idx.length - 1] + 2);
      return { ...p, clips: moveClips(p.clips, selection, to) };
    });
  };
  const toggleLock = () => {
    if (!selection.length) return;
    history.commit((p) => {
      const chosen = p.clips.filter((c) => selection.includes(c.id));
      const lock = !chosen.every((c) => c.locked);
      return { ...p, clips: p.clips.map((c) => (selection.includes(c.id) ? { ...c, locked: lock || undefined } : c)) };
    });
  };
  const clipClick = (id: string, mods: { shift: boolean; toggle: boolean }) => {
    const p = projectRef.current;
    if (!p) return;
    setSelection((s) => clickSelect(s, id, mods, p.clips.map((c) => c.id)));
    setSelectedOverlay(null);
    setSelectedVoice(null);
    if (!mods.shift && !mods.toggle) setTab("clips");
  };
  const alignBeats = () => {
    const p = projectRef.current;
    if (!p) return;
    const grid = timelineBeats(p.music, totalLength(p));
    const r = alignCutsToBeats(p.clips, grid);
    if (!r.moved) return toast.message(r.kept ? "No cut could move: the ones near a beat touch a locked clip or speech, or have no footage to give." : "Every cut is already on a beat or too far from one (a quarter second).");
    history.commit((q) => ({ ...q, clips: r.clips }));
    toast.success(`${r.moved} cut${r.moved === 1 ? "" : "s"} moved onto the beat${r.kept ? `; ${r.kept} left where ${r.kept === 1 ? "it was" : "they were"} (locked or speech)` : ""}.`);
  };

  /**
   * Auto edit: the footage's motion measured, then a first cut for the purpose, length and pace
   * (shared/video-autoedit.ts), on the music's beats when there is music. Locked clips stay at
   * their place; the source seconds of clips marked "has speech" come back whole.
   */
  const runAuto = async (opts: { purpose: Purpose; pace: Pace; target: number }) => {
    const media = mediaRef.current.all();
    if (!media.length) return;
    try {
      const p0 = projectRef.current!;
      const inputs: FirstCutInput[] = [];
      for (const [i, m] of media.entries()) {
        setAutoBusy(`Measuring motion in ${m.label} (${i + 1}/${media.length})…`);
        const energy = await mediaRef.current.energy(m).catch(() => new Float32Array(0));
        const speech = p0.clips.filter((c) => c.speech && c.source.kind !== "gap" && mediaRef.current.get(c.source)?.key === m.key).map((c) => ({ in: c.in, out: c.out }));
        inputs.push({ id: `s${i}`, source: m.source, duration: m.duration, energy, step: 0.5, ...(speech.length ? { speech } : {}) });
      }
      setAutoBusy("Building the cut…");
      const p = projectRef.current!;
      const grid = timelineBeats(p.music, Math.max(opts.target, totalLength(p)) + 5);
      const locked = placeClips(p.clips)
        .filter((pl) => pl.clip.locked)
        .map((pl) => ({ clip: pl.clip, start: pl.start }));
      const plan = planFirstCut(inputs, { ...opts, beats: grid.length ? grid : undefined, locked });
      // Fresh ids for the new shots; locked clips keep theirs.
      const clips = plan.clips.map((c) => (c.locked ? c : { ...c, id: newClipId() }));
      if (!clips.length) {
        toast.error("Nothing could be cut from this footage.");
        return;
      }
      history.commit((q) => ({ ...q, clips, look: q.look === "none" ? plan.look : q.look }));
      setAutoNotes(plan.notes);
      setSelection([]);
      seek(0);
      toast.success(`A first cut of ${clips.length} shots, ${totalLength({ clips }).toFixed(1)} s.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAutoBusy("");
    }
  };

  /**
   * A track for the cut. With a post open (admins) it is kept with the post as a licensed track
   * (the Audio panel's list, with the licence line typed here), so the saved project points at it
   * and a reopened project sounds the same; otherwise it lives in this tab only.
   */
  const pickMusic = async (file: File, license = "") => {
    try {
      setMusicBusy(`Reading ${file.name}…`);
      const buffer = await decodeAudio(await file.arrayBuffer());
      if (!buffer) throw new Error(`${file.name} could not be decoded as audio.`);
      setMusicBusy("Finding the beats…");
      const found = beatsOf(buffer);
      const name = file.name.replace(/\.[a-z0-9]+$/i, "");
      let source: NonNullable<VideoProject["music"]>["source"] = { kind: "upload", name: file.name, size: file.size };
      if (post && !readOnly) {
        setMusicBusy(`Keeping ${file.name} with the post…`);
        try {
          const r = await uploadAudio(post.batch, post.index, file, { name, license, durationMs: Math.round(buffer.duration * 1000) });
          setTracks(r.tracks);
          source = { kind: "audioKey", key: r.track.id, name: r.track.name };
        } catch (e) {
          toast.message(`The track plays in this tab only: ${(e as Error).message}`);
        }
      }
      setMusicFile({ name: source.kind === "audioKey" ? (source.name ?? name) : file.name, buffer, beats: found });
      history.commit((p) => ({ ...p, music: { source, offset: p.music?.offset ?? 0, volume: p.music?.volume ?? 0.9, fadeIn: p.music?.fadeIn ?? 0.5, fadeOut: p.music?.fadeOut ?? 1, duration: buffer.duration, beats: found, start: p.music?.start ?? 0, ...(p.music?.end !== undefined ? { end: p.music.end } : {}), duck: p.music?.duck ?? { ...DEFAULT_DUCKING } } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMusicBusy("");
    }
  };
  /** One of the post's tracks (already kept with the post) as the cut's music. */
  const chooseTrack = async (track: AudioTrack) => {
    if (!track.url) return;
    try {
      setMusicBusy(`Reading ${track.name}…`);
      const buffer = await decodeAudio(await (await fetch(track.url, { credentials: "same-origin" })).arrayBuffer());
      if (!buffer) throw new Error(`${track.name} could not be decoded as audio.`);
      const found = beatsOf(buffer);
      setMusicFile({ name: track.name, buffer, beats: found });
      history.commit((p) => ({ ...p, music: { source: { kind: "audioKey", key: track.id, name: track.name }, offset: p.music?.offset ?? 0, volume: p.music?.volume ?? 0.9, fadeIn: p.music?.fadeIn ?? 0.5, fadeOut: p.music?.fadeOut ?? 1, duration: buffer.duration, beats: found, start: p.music?.start ?? 0, ...(p.music?.end !== undefined ? { end: p.music.end } : {}), duck: p.music?.duck ?? { ...DEFAULT_DUCKING } } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMusicBusy("");
    }
  };

  /** A track from the music library: decoded here, its beats found, its licence, credit and Content ID kept with the project. */
  const pickLibrary = async (pick: MusicPick) => {
    if (readOnly) return;
    try {
      setMusicBusy(`Reading ${pick.track.title}…`);
      const r = await fetch(pick.fileUrl, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`${pick.track.title} could not be read from the library (${r.status}).`);
      const buffer = await decodeAudio(await r.arrayBuffer());
      if (!buffer) throw new Error(`${pick.track.title} could not be decoded as audio.`);
      setMusicBusy("Finding the beats…");
      const found = beatsOf(buffer);
      const source = musicSourceFromTrack(pick.track);
      setMusicFile({ name: pick.track.title, buffer, beats: found });
      history.commit((p) => ({ ...p, music: { source, offset: p.music?.offset ?? 0, volume: p.music?.volume ?? 0.9, fadeIn: p.music?.fadeIn ?? 0.5, fadeOut: p.music?.fadeOut ?? 1, duration: buffer.duration, beats: found, start: p.music?.start ?? 0, ...(p.music?.end !== undefined ? { end: p.music.end } : {}), duck: p.music?.duck ?? { ...DEFAULT_DUCKING } } }));
      if (source.kind !== "audioKey" && source.kind !== "upload" && source.rights.attributionRequired) toast.message("This track's licence asks for credit: copy the credit line under Music into the post's caption.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMusicBusy("");
    }
  };
  /**
   * A voice-over at the playhead on the Voice lane. With a post open (admins) the recording is kept
   * with the post's audio (so the saved draft reopens with it), otherwise it lives in this tab.
   */
  const addVoice = async (file: File) => {
    try {
      setVoiceBusy(`Reading ${file.name}…`);
      const buffer = await decodeAudio(await file.arrayBuffer());
      if (!buffer) throw new Error(`${file.name} could not be decoded as audio.`);
      const name = file.name.replace(/\.[a-z0-9]+$/i, "");
      let source: NonNullable<VideoProject["music"]>["source"] = { kind: "upload", name: file.name, size: file.size };
      if (post && !readOnly) {
        setVoiceBusy(`Keeping ${file.name} with the post…`);
        try {
          const r = await uploadAudio(post.batch, post.index, file, { name: `${name} (voice-over)`, license: "Voice-over recording", durationMs: Math.round(buffer.duration * 1000) });
          setTracks(r.tracks);
          source = { kind: "audioKey", key: r.track.id, name: r.track.name };
        } catch (e) {
          toast.message(`The voice-over plays in this tab only: ${(e as Error).message}`);
        }
      }
      const id = `v${Math.random().toString(36).slice(2, 10)}`;
      const at = Math.max(0, Math.min(playerRef.current?.time ?? time, Math.max(0, (projectRef.current ? totalLength(projectRef.current) : 0) - 0.25)));
      setVoiceBuffers((m) => new Map(m).set(id, buffer));
      history.commit((p) => ({ ...p, voices: [...p.voices, { id, source, name, start: at, in: 0, out: buffer.duration, duration: buffer.duration, volume: 1 }] }));
      setSelectedVoice(id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setVoiceBusy("");
    }
  };
  const removeVoice = (id: string) => {
    history.commit((p) => ({ ...p, voices: p.voices.filter((v) => v.id !== id) }));
    setSelectedVoice(null);
  };

  /* ───────────── Frame, framing, text and logo layers ───────────── */
  const frame = project ? frameOfOutput(project.output) : null;
  const setFrame = (f: FrameId) => history.commit((p) => ({ ...p, output: { ...p.output, ...outputForFrame(f) } }));
  /** Fill or Fit: the selected clip's own framing when one is selected, else the whole cut's. */
  const setFit = (fit: FitMode) =>
    history.commit((p) => {
      const clip = selected ? p.clips.find((c) => c.id === selected) : null;
      if (clip?.framing) return { ...p, clips: p.clips.map((c) => (c.id === clip.id ? { ...c, framing: { ...c.framing!, fit } } : c)) };
      return { ...p, framing: { ...p.framing, fit } };
    });
  const addText = () => {
    const p = projectRef.current;
    if (!p) return;
    const start = Math.min(time, Math.max(0, totalLength(p) - 0.5));
    const o = newTextOverlay("Your words", start, Math.min(Math.max(start + 0.5, totalLength(p)), start + 3));
    history.commit((q) => ({ ...q, overlays: [...q.overlays, o] }));
    setSelectedOverlay(o.id);
    setTab("text");
  };
  const addLogo = (src: string, name: string) => {
    const p = projectRef.current;
    if (!p) return;
    const o = newLogoOverlay(src, name, 0, Math.max(0.5, totalLength(p)));
    history.commit((q) => ({ ...q, overlays: [...q.overlays, o] }));
    setSelectedOverlay(o.id);
    setTab("logo");
  };
  const patchOverlay = (id: string, patch: Partial<Overlay>, step: "patch" | "commit" = "commit") =>
    (step === "commit" ? history.commit : history.patch)((p) => ({ ...p, overlays: p.overlays.map((o) => (o.id === id ? ({ ...o, ...patch } as Overlay) : o)) }));
  const removeOverlay = (id: string) => {
    history.commit((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== id) }));
    setSelectedOverlay(null);
  };
  const toggleMute = () => {
    setMuted((m) => {
      playerRef.current?.setMuted(!m);
      return !m;
    });
  };
  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const removeMusic = () => {
    setMusicFile(null);
    history.commit((p) => ({ ...p, music: null, snapToBeats: false }));
  };

  const pickLut = async (file: File) => {
    const r = parseCube(await file.text());
    if (!r.ok) {
      toast.error(r.reason);
      return;
    }
    setLut({ name: file.name, lut: r.lut });
    // The table is kept with the draft (at most 33³, 8-bit), so a reopened draft renders with it.
    const stored = serialiseCube(r.lut);
    history.commit((p) => ({ ...p, lut: { name: file.name.slice(0, 200), size: stored.size, strength: p.lut?.strength ?? 1, data: stored.data } }));
  };
  const clearLut = () => {
    setLut(null);
    history.commit((p) => ({ ...p, lut: null }));
  };

  /* ───────────── Save draft, and Render & update card ───────────── */
  /** "Save draft": the editable project with its revision. Returns the saved project and revision, or null. */
  const save = async (opts: { quiet?: boolean } = {}): Promise<{ id: string; rev: number } | null> => {
    const p = projectRef.current;
    if (!p || !post || readOnly) return null;
    const check = validateProject(p);
    if (!check.ok) {
      toast.error(check.reason);
      return null;
    }
    setSaving(true);
    try {
      let saved: { id: string; rev: number };
      if (projectId) {
        const r = await saveProject(projectId, p, rev);
        saved = { id: r.project.id, rev: r.project.rev };
      } else {
        const r = await createProject({ batch: post.batch, post: post.index, name: p.name, project: p, sourceVideo: initialVideoId ?? null });
        saved = { id: r.project.id, rev: r.project.rev };
        setProjectId(saved.id);
      }
      setRev(saved.rev);
      history.markSaved();
      // Saved to the studio: the local copies are no longer needed.
      clearDraft(draftKey(post, saved.id));
      clearDraft(draftKey(post, null));
      lastWritten.current = p;
      if (!opts.quiet) toast.success("Draft saved.");
      return saved;
    } catch (e) {
      toast.error((e as ApiError).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const reloadRenders = useCallback(async (id: string | null) => {
    if (!id) return;
    try {
      setRenders((await listRenders(id)).renders);
    } catch {
      /* the list is a convenience */
    }
  }, []);

  /**
   * "Render & update card": the draft saved, a render job of that exact revision, the frames
   * rendered here from the job's frozen document, the file and its still uploaded; the server puts
   * the new version on the card (and the client link unless the client approved the current one).
   * Until the upload lands the card keeps its video; a failure is recorded on the job.
   * With no post (the standalone editor) the render is saved as a file.
   */
  const runExport = async () => {
    const p = projectRef.current;
    if (!p || running) return;
    const check = validateProject(p);
    if (!check.ok) return setExportError(check.reason);
    if (p.music && !musicFile) return setExportError("The music is not loaded in this tab: pick the track again under Music before rendering.");
    if (p.lut && !p.lut.data && !lut) return setExportError("Load the LUT file again before rendering: this draft was saved before LUT tables were kept with it.");
    const lostVoice = p.voices.find((v) => !voiceBuffers.has(v.id));
    if (lostVoice) return setExportError(`The voice-over “${lostVoice.name}” is not loaded in this tab: add it again under Music (Voice-over) or remove it before rendering.`);
    playerRef.current?.pause();
    setExportError(null);
    setExportResult(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const codecs = testCodecs() ? TEST_CODECS : STUDIO_CODECS;
    if (!post || readOnly) {
      try {
        setRunning({ id: null, progress: 0 });
        const r = await exportProject({ project: p, media: mediaRef.current, music: musicFile?.buffer ?? null, voices: voiceBuffers, lut: lut?.lut ?? null, codecs, signal: abort.signal, onProgress: (x) => {
          setProgress(x);
          setRunning({ id: null, progress: overallProgress(x) });
        } });
        saveBlob(r.blob, `${fileBase || "video"}_cut.mp4`);
        setExportResult(`Saved as a file: ${r.width}×${r.height}, ${r.duration.toFixed(1)} s, ${formatSize(r.blob.size)}.`);
      } catch (e) {
        setExportError((e as Error).message);
      } finally {
        setProgress(null);
        setRunning(null);
        abortRef.current = null;
      }
      return;
    }
    // 1. The draft, saved: a render is always of a saved revision.
    const saved = history.dirty || !projectId ? await save({ quiet: true }) : { id: projectId, rev };
    if (!saved) return setExportError("The draft could not be saved, so nothing was rendered.");
    let job: RenderItem | null = null;
    let lastBeat = 0;
    try {
      // 2. The job, and the revision's document exactly as stored.
      const started = await startRender(saved.id, saved.rev);
      job = started.render;
      setRenders((list) => [started.render, ...list.filter((x) => x.id !== started.render.id)]);
      setRunning({ id: job.id, progress: 0 });
      const jobId = job.id;
      // 3. The frames, rendered here; the job hears how far it is every two seconds.
      const result = await exportProject({ project: started.document, media: mediaRef.current, music: musicFile?.buffer ?? null, voices: voiceBuffers, lut: lut?.lut ?? null, codecs, signal: abort.signal, onProgress: (x) => {
        setProgress(x);
        const f = overallProgress(x) * 0.95;
        setRunning({ id: jobId, progress: f });
        if (Date.now() - lastBeat > 2000) {
          lastBeat = Date.now();
          void reportRender(jobId, f, x.phase).catch(() => undefined);
        }
      } });
      // 4. The upload: the server stores the version and decides where it shows.
      setRunning({ id: jobId, progress: 0.96 });
      void reportRender(jobId, 0.96, "uploading").catch(() => undefined);
      const r = await uploadRender({ batch: post.batch, post: post.index, projectId: saved.id, renderId: jobId, file: result.blob, still: result.still, note: `${p.name} · render of save ${saved.rev}` });
      const where = r.outcome === "review" ? "on the card; the client approved the version they see, so it waits for “Send for review”" : r.outcome === "superseded" ? "kept as a version; a newer render or choice is on the card" : "on the card and the client link";
      setExportResult(`${versionLabel(r.video)} · ${result.width}×${result.height} · ${result.duration.toFixed(1)} s · ${formatSize(result.blob.size)}: ${where}.`);
      onExported?.(r.video);
      onChanged?.();
      void reloadVideos();
      toast.success(r.outcome === "card" ? `Rendered: ${versionLabel(r.video)} is on the card.` : r.outcome === "review" ? `Rendered ${versionLabel(r.video)}: send it for review to show it to the client.` : `Rendered ${versionLabel(r.video)} (kept as a version).`);
    } catch (e) {
      const message = (e as Error).message;
      setExportError(message);
      if (job) await failRender(job.id, message).catch(() => undefined);
    } finally {
      setProgress(null);
      setRunning(null);
      abortRef.current = null;
      void reloadRenders(saved.id);
    }
  };

  /** "Send for review": the render the card shows becomes the client's version (the client approved an earlier one). */
  const sendForReview = async (videoId: string) => {
    if (!post) return;
    if (!(await askConfirm("Make this render the client's version? The client sees it on the review link and can approve it again.", { ok: "Send for review", cancel: "Not now" }))) return;
    try {
      await selectForClient(post.batch, post.index, videoId);
      toast.success("The client's link shows the new render.");
      onChanged?.();
      void reloadVideos();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Closing the tab stops a render: the browser asks first.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const close = async () => {
    if (running) {
      if (!(await askConfirm("A render is running in this tab. Stop it and close the studio? The card keeps its current video.", { ok: "Stop and close", danger: true, cancel: "Keep rendering" }))) return;
      abortRef.current?.abort();
    } else if (history.dirty && !readOnly && post) {
      const ok = await askConfirm("Save this cut before closing?", { ok: "Save and close", danger: false, cancel: "Close without saving" });
      if (ok && !(await save())) return;
      // "Close without saving" is the designer's choice: the cut is not kept for the card either.
      if (!ok) patchSession(post.batch, post.index, { video: null });
    }
    onClose();
  };

  /* ───────────── The studio's shared state and the preset gallery ───────────── */
  const openPanel = useCallback((p: StudioPanel) => {
    setPanel(p);
    setPanelOpen(true);
  }, []);
  const usePresetCard = useCallback(
    (card: PresetCard) => {
      setPrefill({ prompt: card.prompt ?? [card.title, card.description].filter(Boolean).join(": "), engine: card.engine, presetTitle: card.title, presetCommand: card.command, at: Date.now() });
      openPanel("generate");
    },
    [openPanel],
  );
  const shared: StudioShared = {
    post,
    pictureUrl: pictureUrl ?? null,
    fileBase,
    composeArtwork,
    approval: approval ?? null,
    videos,
    videosLoaded,
    reloadVideos,
    shownId,
    setShownId: (id) => {
      setShownId(id);
      setCompareId(null);
    },
    compareId,
    setCompareId,
    openPanel,
    usePreset: usePresetCard,
    prefill,
    onChanged,
    admin,
  };
  const presets = usePresets(shared, open && !!post && panel === "presets");

  /* ───────────── Keys ───────────── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (compareId) setCompareId(null);
        else if (panel === "presets" && presets.selected) presets.select(null);
        else void close();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (!editing) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "s" && !mod && !readOnly) split();
      // Delete closes the gap (ripple); Shift + Delete leaves it.
      else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) remove(!e.shiftKey);
      else if (e.key === "l" && !mod && !readOnly) toggleLock();
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const p = projectRef.current;
        const len = p ? totalLength(p) : 0;
        const now = playerRef.current?.time ?? 0;
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        seek(e.shiftKey ? Math.min(len, Math.max(0, now + dir)) : stepFrames(now, dir, len));
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && projectRef.current) {
        // The previous or next cut.
        e.preventDefault();
        const p = projectRef.current;
        const now = playerRef.current?.time ?? 0;
        const marks = [0, ...cutTimes(p.clips), totalLength(p)];
        const to = e.key === "ArrowUp" ? [...marks].reverse().find((t) => t < now - 1e-3) : marks.find((t) => t > now + 1e-3);
        if (to !== undefined) seek(to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

  /* The draft and render state, in one line: "Draft saved · Render needed", "Rendering 42%", "Rendered", "Render failed: …". */
  const lastRender = renders[0] ?? null;
  const chip: { cls: string; text: string } | null = !post
    ? null
    : running
      ? { cls: "rendering", text: `Rendering ${Math.round(running.progress * 100)}%` }
      : !projectId && !history.dirty
        ? { cls: "", text: "Not saved yet" }
        : history.dirty
          ? { cls: "dirty", text: "Unsaved changes · Render needed" }
          : lastRender?.status === "interrupted"
            ? { cls: "failed", text: "Render interrupted · Render again" }
            : lastRender?.status === "failed" && lastRender.projectRev === rev
              ? { cls: "failed", text: `Render failed: ${lastRender.error ?? "unknown error"}` }
              : (lastRender?.status === "rendering" || lastRender?.status === "uploading") && lastRender.projectRev === rev
                ? { cls: "rendering", text: `Rendering in another tab ${Math.round(lastRender.progress * 100)}%` }
                : lastRender?.status === "done" && lastRender.projectRev === rev
                  ? { cls: "done", text: lastRender.outcome === "review" ? "Rendered · Send for review" : lastRender.outcome === "superseded" ? "Rendered · kept as a version" : "Rendered · on the card" }
                  : { cls: "draft", text: "Draft saved · Render needed" };

  const ctx: PanelCtx | null = project
    ? {
        project,
        readOnly,
        reason: readOnly ? access.reason || "Admins only for now." : "",
        selected: selectedClip,
        time,
        commit: history.commit,
        patch: history.patch,
        mark: history.mark,
        sources,
        labelOf,
        onAddClip: addClip,
        onAddFootage: addFootage,
        footageBusy,
        onSplit: split,
        onDelete: remove,
        onMove: move,
        selection,
        onToggleLock: toggleLock,
        seek,
        auto: { busy: autoBusy, run: runAuto, notes: autoNotes },
        voice: { busy: voiceBusy, add: addVoice, remove: removeVoice, selected: selectedVoice, select: setSelectedVoice, loaded: (id) => voiceBuffers.has(id) },
        music: { name: musicFile?.name ?? null, duration: musicFile?.buffer.duration ?? project.music?.duration ?? 0, beats: project.music?.beats?.length ?? 0, busy: musicBusy, pick: pickMusic, remove: removeMusic, tracks, choose: chooseTrack, keeps: !!post && !readOnly, align: alignBeats },
        colour: { lutName: lut?.name ?? null, pickLut, clearLut, bypass, setBypass },
        exporting: { progress, result: exportResult, error: exportError, run: runExport, stop: () => abortRef.current?.abort(), canExport: !!caps?.canExport, capsMessage: caps?.message ?? "", standalone, running: !!running, renders, chip: chip?.text ?? "", sendForReview, videoLabel: (id) => { const v = videos.find((x) => x.id === id); return v ? versionLabel(v) : "the new version"; }, clientId: videos.find((v) => v.forClient)?.id ?? null },
        layers: { selected: selectedOverlay, select: setSelectedOverlay, addText, addLogo, patch: patchOverlay, remove: removeOverlay, logoUrl: logoUrl ?? null },
        framing: { frame, setFrame },
        looks: { split: splitView, setSplit: setSplitView, client: client ?? null, references: references ?? [], pickLibrary, tabLutName: lut?.name ?? null } satisfies LooksCtx,
      }
    : null;

  const editBody = ctx ? (tab === "clips" ? <ClipsPanel ctx={ctx} /> : tab === "text" ? <TextPanel ctx={ctx} /> : tab === "logo" ? <LogoPanel ctx={ctx} /> : tab === "auto" ? <AutoEditPanel ctx={ctx} /> : tab === "music" ? (
      <>
        <MusicPanel ctx={ctx} />
        <VoicePanel ctx={ctx} />
      </>
    ) : tab === "colour" ? <ColourPanel ctx={ctx} /> : <ExportPanel ctx={ctx} />) : null;
  const sideBody = !post || editing ? (
    <>
      <div className="ts-tabs vs-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="ts-side-body">{editBody}</div>
    </>
  ) : (
    <div className="ts-side-body">{panel === "presets" ? <PresetDetailPanel s={shared} ps={presets} /> : panel === "generate" ? <GeneratePanel s={shared} /> : panel === "enhance" ? <EnhancePanel s={shared} /> : panel === "audio" ? <AudioPanel s={shared} /> : panel === "versions" ? <VersionsPanel s={shared} /> : <CheckPanel s={shared} />}</div>
  );
  const length = project ? totalLength(project) : 0;
  const title = post ? "Video studio" : "Video editor";
  const shown = videos.find((v) => v.id === shownId) ?? null;
  const compare = videos.find((v) => v.id === compareId) ?? null;
  const newest = videos[0] ?? null;
  const state = newest && inFlight(newest) ? "making" : newest?.status === "failed" ? "failed" : videos.some((v) => v.status === "done") ? "ready" : "none";
  const stateLabel = state === "making" ? "Making…" : state === "failed" ? "Failed" : state === "ready" ? `${videos.filter((v) => v.status === "done").length} clip${videos.filter((v) => v.status === "done").length === 1 ? "" : "s"}` : "No clip yet";
  const rail = post ? PANELS : PANELS.filter((p) => p.id === "edit");
  const locked = (id: StudioPanel) => !!PANELS.find((p) => p.id === id)?.paid && videosLoaded && !admin;

  const sheet = (
    <div className={`ts ve vs ${narrow ? "narrow" : ""} ${editing || !post ? "editing" : ""} ${panel === "presets" && post ? "gallery" : ""}`} role="dialog" aria-label={post ? "Video studio" : "Video editor"}>
      <header className="ts-top">
        <div className="ts-top-left">
          <button type="button" className="ts-icon" onClick={() => void close()} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
          <nav className="ts-title ve-crumbs" aria-label="Where you are">
            {post && <span className="ve-crumb">Level Studio</span>}
            <span className="ve-crumb">{title}</span>
            <span className="ve-crumb now">{post ? post.title || `Post ${post.index}` : (project?.name ?? "")}</span>
          </nav>
          {post && editing && chip ? (
            <span className={`ve-chip ${chip.cls}`} role="status" title={chip.text}>
              <i aria-hidden /> {chip.text}
            </span>
          ) : post ? (
            <span className={`vs-state ${state}`}>{stateLabel}</span>
          ) : null}
        </div>
        <div className="ts-tools ve-tools" role="toolbar" aria-label="Edit">
          <span className="ts-tool-group" aria-label="History">
            <button type="button" className="ts-icon" onClick={history.undo} disabled={!history.canUndo} title="Undo on the timeline (⌘Z)" aria-label="Undo">
              <Undo2 size={15} />
            </button>
            <button type="button" className="ts-icon" onClick={history.redo} disabled={!history.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
              <Redo2 size={15} />
            </button>
          </span>
          <span className="ts-sep" />
          <button type="button" className="ts-icon" onClick={split} disabled={!editing || readOnly || !project?.clips.length} title="Split at the playhead (S)" aria-label="Split at the playhead">
            <Scissors size={15} />
          </button>
        </div>
        <div className="ts-top-right">
          {/* While editing, the top bar is the mock-up's: Save draft and Render & update card; Versions stays on the rail, the other studios as icons. */}
          {post && !editing && (
            <button type="button" className={`ts-btn ${panel === "versions" ? "on" : ""}`} onClick={() => openPanel("versions")} title="Every clip of this post">
              <History size={14} /> <span>Versions · {videos.length}</span>
            </button>
          )}
          {onPhotoStudio && (
            <button type="button" className={editing && post ? "ts-icon" : "ts-btn"} onClick={onPhotoStudio} title="The picture, in the Photo studio" aria-label="Photo studio">
              <Aperture size={14} /> {!(editing && post) && <span>Photo studio</span>}
            </button>
          )}
          {onTextStudio && (
            <button type="button" className={editing && post ? "ts-icon" : "ts-btn"} onClick={onTextStudio} title="The words and layers on the picture, in the Text studio" aria-label="Text studio">
              <Type size={14} /> {!(editing && post) && <span>Text studio</span>}
            </button>
          )}
          {editing && post && !readOnly && (
            <button type="button" className="ts-btn" onClick={() => void save()} disabled={saving || !project} title="Save the editable project with the post (⌘S); the card keeps its video until you render">
              {saving ? <Orb size={14} status={null} /> : <Save size={14} />} <span>Save draft</span>
            </button>
          )}
          {editing && post && !readOnly && (
            <button
              type="button"
              className="ts-btn primary ve-render"
              onClick={() => void runExport()}
              disabled={!!running || !project?.clips.length || !caps?.canExport}
              title={caps && !caps.canExport ? caps.message : "Save the draft, render a new version here in the browser, and put it on the card (keep this tab open while it renders)"}
            >
              {running ? <Orb size={14} status={null} /> : null}
              <span>{running ? `Rendering ${Math.round(running.progress * 100)}%` : "Render & update card"}</span>
              {!running && <ArrowRight size={14} />}
            </button>
          )}
          {readOnly && editing && post && (
            <span className="ve-readonly" title={access.reason}>
              Admins only for now
            </span>
          )}
          {!post && (
            <button type="button" className="ts-btn" onClick={() => { setTab("export"); setPanelOpen(true); }} disabled={!project}>
              <Download size={14} /> <span>Export</span>
            </button>
          )}
          {!(editing && post && !readOnly) && (
            <button type="button" className="ts-btn primary" onClick={() => void close()}>
              Close
            </button>
          )}
        </div>
      </header>
      <div className={`vs-body${!narrow && post ? "" : " no-rail"}`}>
        {!narrow && post && (
          <nav className="vs-rail" aria-label="Tools">
            {rail.map((t) => (
              <button key={t.id} type="button" className={panel === t.id ? "on" : ""} onClick={() => openPanel(t.id)} title={t.title} aria-pressed={panel === t.id}>
                {t.icon}
                <span>{t.label}</span>
                {locked(t.id) && <Lock size={9} className="vs-rail-lock" aria-label="Admins only for now" />}
              </button>
            ))}
          </nav>
        )}
        <div className="ve-main vs-main">
          {post && panel === "presets" ? (
            <PresetsGallery s={shared} ps={presets} />
          ) : post && !editing ? (
            <VersionStage shown={shown} compare={compare} pictureUrl={pictureUrl ?? null} hint={compare ? "Two versions side by side · Esc to stop" : undefined} backfill={shared.admin} onPreview={() => void shared.reloadVideos()} />
          ) : (
            <>
              {project && (
                <div className="ve-framebar" role="toolbar" aria-label="Frame">
                  <span className="ve-seg" role="group" aria-label="Aspect ratio">
                    {RATIOS.map((r) => (
                      <button key={r.id} type="button" className={frame === r.id ? "on" : ""} aria-pressed={frame === r.id} disabled={readOnly} onClick={() => setFrame(r.id)} title={r.title}>
                        {r.icon} {r.id}
                      </button>
                    ))}
                  </span>
                  <span className="ve-seg" role="group" aria-label="Fill or fit">
                    {(["fill", "fit"] as FitMode[]).map((f) => {
                      const cur = (selectedClip?.framing ?? project.framing).fit;
                      return (
                        <button key={f} type="button" className={cur === f ? "on" : ""} aria-pressed={cur === f} disabled={readOnly} onClick={() => setFit(f)} title={f === "fill" ? "Fill: the picture covers the frame, the edges are cropped (never stretched)" : "Fit: the whole picture shows, over the background colour"}>
                          {f === "fill" ? "Fill" : "Fit"}
                        </button>
                      );
                    })}
                  </span>
                  <span className="ve-framebar-size">
                    {project.output.width}×{project.output.height} · {project.output.fps} fps
                  </span>
                </div>
              )}
              <div className="ve-stage" ref={stageRef}>
                {fatal ? (
                  <div className="ve-stop ve-stage-msg">{fatal}</div>
                ) : caps && !caps.canDecode ? (
                  <div className="ve-stop ve-stage-msg">
                    <b>{caps.message}</b>
                    <small>{caps.details.join(" ")}</small>
                  </div>
                ) : loading ? (
                  <div className="ve-stage-msg">
                    <Orb size={24} /> {loading}
                  </div>
                ) : null}
                <canvas ref={canvasRef} className="ve-canvas" style={{ aspectRatio: project ? `${project.output.width} / ${project.output.height}` : "9 / 16" }} />
                {caps && caps.canDecode && !caps.canExport && !loading && <div className="ve-stop ve-stage-note">{caps.message}</div>}
              </div>
              <div className="ve-transport" role="toolbar" aria-label="Playback">
                <button type="button" className="ts-icon" onClick={togglePlay} disabled={!project?.clips.length} title={playing ? "Pause (space)" : "Play (space)"} aria-label={playing ? "Pause" : "Play"}>
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <span className="ve-time" aria-label="Time (minutes:seconds:frames at 30 fps)">
                  {formatTimecode(time)} <small>/ {formatTimecode(length)}</small>
                </span>
                <input className="ve-scrub" type="range" min={0} max={Math.max(0.01, length)} step={1 / 30} value={Math.min(time, length)} onChange={(e) => seek(Number(e.target.value))} aria-label="Scrub" disabled={!project?.clips.length} />
                {selectedClip && <span className="ve-selected">{labelOf(selectedClip)}</span>}
                <button type="button" className={`ts-icon ${bypass ? "on" : ""}`} onPointerDown={() => setBypass(true)} onPointerUp={() => setBypass(false)} onPointerLeave={() => setBypass(false)} title="Hold to see the footage before colour" aria-label="Before colour">
                  <SlidersHorizontal size={15} />
                </button>
                <button type="button" className="ts-icon" onClick={toggleMute} title={muted ? "Sound on" : "Mute the preview"} aria-label={muted ? "Sound on" : "Mute"} aria-pressed={muted}>
                  {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
                <button type="button" className="ts-icon" onClick={fullscreen} title="Full screen" aria-label="Full screen">
                  <Maximize size={15} />
                </button>
              </div>
              {project && (
                <Timeline
                  project={project}
                  time={time}
                  beats={beats}
                  selection={selection}
                  readOnly={readOnly}
                  snapping={snapping}
                  setSnapping={setSnapping}
                  onClipClick={clipClick}
                  onClearSelection={() => setSelection([])}
                  onSeek={seek}
                  mark={history.mark}
                  patch={history.patch}
                  commit={history.commit}
                  onSplit={split}
                  onDelete={remove}
                  onToggleLock={toggleLock}
                  labelOf={labelOf}
                  selectedOverlay={selectedOverlay}
                  selectedVoice={selectedVoice}
                  onSelectOverlay={(id) => {
                    setSelectedOverlay(id);
                    setSelectedVoice(null);
                    const o = project.overlays.find((x) => x.id === id);
                    if (o) {
                      setTab(o.kind === "text" ? "text" : "logo");
                      setPanelOpen(true);
                    }
                  }}
                  onSelectVoice={(id) => {
                    setSelectedVoice(id);
                    setSelectedOverlay(null);
                    setTab("music");
                    setPanelOpen(true);
                  }}
                  onSelectMusic={() => {
                    setTab("music");
                    setPanelOpen(true);
                  }}
                  musicName={musicFile?.name ?? (project.music ? (project.music.source.kind === "upload" ? project.music.source.name : (project.music.source.name ?? "Track")) : null)}
                />
              )}
            </>
          )}
        </div>
        <aside className={`ts-right ve-side vs-side ${narrow && !panelOpen ? "closed" : ""}`}>{sideBody}</aside>
        {narrow && (
          <nav className="vs-bottom" aria-label="Tools">
            {rail.map((t) => (
              <button
                key={t.id}
                type="button"
                className={panel === t.id && panelOpen ? "on" : ""}
                onClick={() => {
                  if (panel === t.id && panelOpen) setPanelOpen(false);
                  else openPanel(t.id);
                }}
                title={t.title}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
  return createPortal(sheet, document.body);
}

function formatSize(n: number): string {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
