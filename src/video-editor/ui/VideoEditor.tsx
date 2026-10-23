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
import { Aperture, Clapperboard, Download, History, LayoutGrid, Lock, Music, Palette, Pause, Play, Redo2, Save, ScanSearch, Scissors, SlidersHorizontal, Sparkles, Type, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { saveBlob } from "@/lib/zip";
import { Orb } from "@/components/Orb";
import type { Approval } from "@shared/config";
import { parseCube, type CubeLut } from "@shared/cube-lut";
import { moveClip, newClip, newProject, placeClips, planAutoEdit, snapCutsToBeats, splitClip, timelineBeats, totalLength, validateProject, type AutoStyle, type Clip, type ClipSource, type VideoProject } from "@shared/video-project";
import type { PresetCard } from "@shared/video-presets";
import { inFlight, listVideos, versionLabel, type VideoItem } from "@/studio/videoApi";
import { createProject, getProject, listProjects, saveProject, uploadFootage, uploadRender, versionFileUrl, type EditorAccess } from "../api";
import { checkCapabilities, type Capabilities } from "../engine/capabilities";
import { beatsOf, decodeAudio } from "../engine/audio";
import { MediaStore, type Media } from "../engine/media";
import { Player } from "../engine/preview";
import { exportProject, type ExportProgress } from "../engine/export";
import { useHistory } from "./history";
import Timeline from "./Timeline";
import { AutoEditPanel, ClipsPanel, ColourPanel, ExportPanel, MusicPanel, type PanelCtx } from "./Panels";
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
}

type Tab = "clips" | "auto" | "music" | "colour" | "export";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "clips", label: "Clips", icon: <Clapperboard size={14} /> },
  { id: "auto", label: "Auto edit", icon: <Wand2 size={14} /> },
  { id: "music", label: "Music", icon: <Music size={14} /> },
  { id: "colour", label: "Colour", icon: <Palette size={14} /> },
  { id: "export", label: "Export", icon: <Download size={14} /> },
];

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

export default function VideoEditor({ open, post, initialVideoId, initialPanel, pictureUrl, composeArtwork, approval, fileBase, onClose, onExported, onChanged, onPhotoStudio, onTextStudio }: Props) {
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
  const [selected, setSelected] = useState<string | null>(null);
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
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
        const c = await checkCapabilities();
        if (!alive) return;
        setCaps(c);
        let doc: VideoProject | null = null;
        let vids: VideoItem[] = [];
        let latestId: string | null = null;
        if (post) {
          setLoading("Reading the post's versions…");
          const [list, projects] = await Promise.all([listVideos(post.batch, post.index), listProjects(post.batch, post.index)]);
          if (!alive) return;
          setVideos(list.videos);
          setAdmin(list.admin);
          setVideosLoaded(true);
          vids = list.videos.filter((v) => v.status === "done" && v.url);
          setAccess(projects.access);
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
          } else {
            doc = newProject(`${post.title || `Post ${post.index}`} · cut`);
            const m = start ? media.get({ kind: "version", batch: post.batch, videoId: start.id }) : null;
            if (m) doc.clips = [newClip(m.source, m.duration)];
          }
        } else {
          doc = newProject("New cut");
        }
        if (!alive) return;
        history.load(doc);
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

  // While a clip is being made, the versions are read again every few seconds (the server reconnects to the job).
  const pending = videos.some(inFlight);
  useEffect(() => {
    if (!open || !pending) return;
    const t = setInterval(() => void reloadVideos().then(() => onChanged?.()), 6000);
    return () => clearInterval(t);
  }, [open, pending, reloadVideos, onChanged]);

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
    if (playerRef.current) playerRef.current.bypass = bypass;
  }, [bypass]);
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
    const pl = placeClips(p.clips).find((x) => t > x.start && t < x.end && (!selected || x.clip.id === selected));
    if (!pl) return toast.message("Put the playhead inside a clip to split it.");
    const parts = splitClip(pl.clip, t - pl.start);
    if (!parts) return toast.message("Too close to the clip's edge to split.");
    history.commit((q) => ({ ...q, clips: q.clips.flatMap((c) => (c.id === pl.clip.id ? parts : [c])) }));
    setSelected(parts[1].id);
  };
  const remove = () => {
    if (!selected) return;
    history.commit((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== selected) }));
    setSelected(null);
  };
  const move = (dir: -1 | 1) => {
    if (!selected) return;
    history.commit((p) => {
      const i = p.clips.findIndex((c) => c.id === selected);
      return i < 0 ? p : { ...p, clips: moveClip(p.clips, i, i + dir) };
    });
  };

  const runAuto = async (target: number, style: AutoStyle) => {
    const media = mediaRef.current.all();
    if (!media.length) return;
    try {
      const inputs = [];
      for (const [i, m] of media.entries()) {
        setAutoBusy(`Measuring motion in ${m.label} (${i + 1}/${media.length})…`);
        const energy = await mediaRef.current.energy(m).catch(() => new Float32Array(0));
        inputs.push({ id: m.key.replace(/[^a-z0-9]/gi, "").slice(-12) || `s${i}`, source: m.source, duration: m.duration, energy, step: 0.5 });
      }
      setAutoBusy("Building the cut…");
      const p = projectRef.current!;
      const grid = timelineBeats(p.music, target + 5);
      let clips = planAutoEdit(inputs, { target, style, beats: grid.length ? grid : undefined });
      if (p.snapToBeats && grid.length) clips = snapCutsToBeats(clips, grid);
      if (!clips.length) {
        toast.error("Nothing could be cut from this footage.");
        return;
      }
      history.commit((q) => ({ ...q, clips, look: q.look === "none" ? (style === "energetic" ? "punch" : "clean") : q.look }));
      setSelected(null);
      seek(0);
      toast.success(`A ${style} cut of ${clips.length} shots, ${totalLength({ clips }).toFixed(1)} s.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAutoBusy("");
    }
  };

  const pickMusic = async (file: File) => {
    try {
      setMusicBusy(`Reading ${file.name}…`);
      const buffer = await decodeAudio(await file.arrayBuffer());
      if (!buffer) throw new Error(`${file.name} could not be decoded as audio.`);
      setMusicBusy("Finding the beats…");
      const found = beatsOf(buffer);
      setMusicFile({ name: file.name, buffer, beats: found });
      history.commit((p) => ({ ...p, music: { source: { kind: "upload", name: file.name, size: file.size }, offset: p.music?.offset ?? 0, volume: p.music?.volume ?? 0.9, fadeIn: p.music?.fadeIn ?? 0.5, fadeOut: p.music?.fadeOut ?? 1, duration: buffer.duration, beats: found } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMusicBusy("");
    }
  };
  const removeMusic = () => {
    setMusicFile(null);
    history.commit((p) => ({ ...p, music: null, snapToBeats: false }));
  };
  const snap = () => {
    history.commit((p) => {
      const grid = timelineBeats(p.music, totalLength(p) + 5);
      const on = !p.snapToBeats;
      return { ...p, snapToBeats: on, clips: on && grid.length ? snapCutsToBeats(p.clips, grid) : p.clips };
    });
  };

  const pickLut = async (file: File) => {
    const r = parseCube(await file.text());
    if (!r.ok) {
      toast.error(r.reason);
      return;
    }
    setLut({ name: file.name, lut: r.lut });
    history.commit((p) => ({ ...p, lut: { name: file.name, size: r.lut.size, strength: p.lut?.strength ?? 1 } }));
  };
  const clearLut = () => {
    setLut(null);
    history.commit((p) => ({ ...p, lut: null }));
  };

  /* ───────────── Save and export ───────────── */
  const save = async (): Promise<boolean> => {
    const p = projectRef.current;
    if (!p || !post || readOnly) return false;
    const check = validateProject(p);
    if (!check.ok) {
      toast.error(check.reason);
      return false;
    }
    setSaving(true);
    try {
      if (projectId) {
        const r = await saveProject(projectId, p, rev);
        setRev(r.project.rev);
      } else {
        const r = await createProject({ batch: post.batch, post: post.index, name: p.name, project: p, sourceVideo: initialVideoId ?? null });
        setProjectId(r.project.id);
        setRev(r.project.rev);
      }
      history.markSaved();
      toast.success("Project saved.");
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409 && (err.data as { stale?: boolean })?.stale) toast.error(err.message);
      else toast.error(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runExport = async () => {
    const p = projectRef.current;
    if (!p) return;
    const check = validateProject(p);
    if (!check.ok) return setExportError(check.reason);
    if (p.music && !musicFile) return setExportError("Pick the music file again before exporting: a saved project keeps its name, not the file.");
    if (p.lut && !lut) return setExportError("Load the LUT file again before exporting: a saved project keeps its name, not the table.");
    playerRef.current?.pause();
    setExportError(null);
    setExportResult(null);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const blob = await exportProject({ project: p, media: mediaRef.current, music: musicFile?.buffer ?? null, lut: lut?.lut ?? null, onProgress: setProgress, signal: abort.signal });
      if (post && !readOnly) {
        setProgress({ phase: "finishing", fraction: 1 });
        if (history.dirty || !projectId) await save();
        const r = await uploadRender({ batch: post.batch, post: post.index, projectId, file: blob, note: `${p.name} · export` });
        setExportResult(`Stored as ${versionLabel(r.video)} of this post (${formatSize(blob.size)}).`);
        onExported?.(r.video);
        void reloadVideos();
        toast.success(`Stored as ${versionLabel(r.video)}.`);
      } else {
        saveBlob(blob, `${fileBase || "video"}_cut.mp4`);
        setExportResult(`Saved as a file (${formatSize(blob.size)}).`);
      }
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const close = async () => {
    if (progress) {
      if (!(await askConfirm("An export is running. Stop it and close the studio?", { ok: "Stop and close", danger: true, cancel: "Keep rendering" }))) return;
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
      } else if (e.key === "s" && !readOnly) split();
      else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) remove();
      else if (e.key === "ArrowLeft") seek((playerRef.current?.time ?? 0) - (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === "ArrowRight") seek((playerRef.current?.time ?? 0) + (e.shiftKey ? 1 : 1 / 30));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;

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
        auto: { busy: autoBusy, run: runAuto },
        music: { name: musicFile?.name ?? null, duration: musicFile?.buffer.duration ?? project.music?.duration ?? 0, beats: project.music?.beats?.length ?? 0, busy: musicBusy, pick: pickMusic, remove: removeMusic, snap },
        colour: { lutName: lut?.name ?? null, pickLut, clearLut, bypass, setBypass },
        exporting: { progress, result: exportResult, error: exportError, run: runExport, stop: () => abortRef.current?.abort(), canExport: !!caps?.canExport, capsMessage: caps?.message ?? "", standalone },
      }
    : null;

  const editBody = ctx ? (tab === "clips" ? <ClipsPanel ctx={ctx} /> : tab === "auto" ? <AutoEditPanel ctx={ctx} /> : tab === "music" ? <MusicPanel ctx={ctx} /> : tab === "colour" ? <ColourPanel ctx={ctx} /> : <ExportPanel ctx={ctx} />) : null;
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
  const title = post ? `Video studio` : "Video editor";
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
          <span className="ts-title">
            {title}
            <small>{post ? ` · post ${post.index} · ${post.title || "post"}` : ` · ${project?.name ?? ""}`}</small>
          </span>
          {post && <span className={`vs-state ${state}`}>{stateLabel}</span>}
          {history.dirty && !readOnly && post && <span className="ts-save dirty">Cut not saved</span>}
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
          {post && (
            <button type="button" className={`ts-btn ${panel === "versions" ? "on" : ""}`} onClick={() => openPanel("versions")} title="Every clip of this post">
              <History size={14} /> <span>Versions · {videos.length}</span>
            </button>
          )}
          {onPhotoStudio && (
            <button type="button" className="ts-btn" onClick={onPhotoStudio} title="The picture, in the Photo studio">
              <Aperture size={14} /> <span>Photo studio</span>
            </button>
          )}
          {onTextStudio && (
            <button type="button" className="ts-btn" onClick={onTextStudio} title="The words and layers on the picture, in the Text studio">
              <Type size={14} /> <span>Text studio</span>
            </button>
          )}
          {editing && post && !readOnly && (
            <button type="button" className="ts-btn" onClick={() => void save()} disabled={saving || !project} title="Save this cut with the post (⌘S)">
              {saving ? <Orb size={14} status={null} /> : <Save size={14} />} <span>Save cut</span>
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
          <button type="button" className="ts-btn primary" onClick={() => void close()}>
            Close
          </button>
        </div>
      </header>
      <div className="vs-body">
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
              <div className="ve-stage">
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
                <span className="ve-time">
                  {time.toFixed(1)}s <small>/ {length.toFixed(1)}s</small>
                </span>
                {selectedClip && <span className="ve-selected">{labelOf(selectedClip)} selected</span>}
                <span className="ve-grow" />
                <button type="button" className={`ts-icon ${bypass ? "on" : ""}`} onPointerDown={() => setBypass(true)} onPointerUp={() => setBypass(false)} onPointerLeave={() => setBypass(false)} title="Hold to see the footage before colour" aria-label="Before colour">
                  <SlidersHorizontal size={15} />
                </button>
              </div>
              {project && (
                <Timeline
                  project={project}
                  time={time}
                  beats={beats}
                  selected={selected}
                  readOnly={readOnly}
                  onSelect={setSelected}
                  onSeek={seek}
                  onTrimStart={history.mark}
                  onTrim={(id, patch) => history.patch((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))}
                  onTrimEnd={() => history.commit((p) => p)}
                  labelOf={labelOf}
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
