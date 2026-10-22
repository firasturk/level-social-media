/**
 * The video editor: a full-screen screen like the Text Studio. Left, the preview (the timeline
 * played on a canvas); below it the timeline; right, the panels (Clips, Auto edit, Music, Colour,
 * Export); on top the post's name, undo and redo, Save project, Export and Close. On a narrow
 * screen one panel shows at a time under the preview, picked from a bottom toolbar.
 *
 * Opened on a post it reads the post's finished video versions as footage and keeps the project
 * on the server (admins); members see it read-only. Opened with no post it is a standalone
 * editor: footage from this computer only, the export saved as a file.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, Download, Music, Palette, Pause, Play, Redo2, Save, Scissors, SlidersHorizontal, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { saveBlob } from "@/lib/zip";
import { Orb } from "@/components/Orb";
import { parseCube, type CubeLut } from "@shared/cube-lut";
import { moveClip, newClip, newProject, placeClips, planAutoEdit, snapCutsToBeats, splitClip, timelineBeats, totalLength, validateProject, type AutoStyle, type Clip, type ClipSource, type VideoProject } from "@shared/video-project";
import { listVideos, versionLabel, type VideoItem } from "@/studio/videoApi";
import { createProject, getProject, listProjects, saveProject, uploadFootage, uploadRender, versionFileUrl, type EditorAccess } from "../api";
import { checkCapabilities, type Capabilities } from "../engine/capabilities";
import { beatsOf, decodeAudio } from "../engine/audio";
import { MediaStore, type Media } from "../engine/media";
import { Player } from "../engine/preview";
import { exportProject, type ExportProgress } from "../engine/export";
import { useHistory } from "./history";
import Timeline from "./Timeline";
import { AutoEditPanel, ClipsPanel, ColourPanel, ExportPanel, MusicPanel, type PanelCtx } from "./Panels";

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
  fileBase: string;
  onClose: () => void;
  /** An export was stored as a new version of the post. */
  onExported?: (video: VideoItem) => void;
}

type Tab = "clips" | "auto" | "music" | "colour" | "export";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "clips", label: "Clips", icon: <Clapperboard size={14} /> },
  { id: "auto", label: "Auto edit", icon: <Wand2 size={14} /> },
  { id: "music", label: "Music", icon: <Music size={14} /> },
  { id: "colour", label: "Colour", icon: <Palette size={14} /> },
  { id: "export", label: "Export", icon: <Download size={14} /> },
];

const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
const MAX_FOOTAGE = 60 * 1024 * 1024;

export default function VideoEditor({ open, post, initialVideoId, fileBase, onClose, onExported }: Props) {
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
  const [panelOpen, setPanelOpen] = useState(false);
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

  const readOnly = !access.admin || !access.enabled;
  const standalone = !post;

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
  const labelOf = useCallback(
    (clip: Clip): string => {
      const m = mediaRef.current.get(clip.source);
      if (m) return m.label;
      return clip.source.kind === "version" ? "Version" : clip.source.name;
    },
    [],
  );

  const addSource = useCallback(async (source: ClipSource, where: { url: string; file?: File; label: string }): Promise<Media> => {
    const m = await mediaRef.current.add(source, where);
    setSources(mediaRef.current.all());
    return m;
  }, []);

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
        if (post) {
          setLoading("Reading the post's versions…");
          const [list, projects] = await Promise.all([listVideos(post.batch, post.index), listProjects(post.batch, post.index)]);
          if (!alive) return;
          vids = list.videos.filter((v) => v.status === "done" && v.url);
          setAccess(projects.access);
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
          if (latest) {
            setLoading("Opening the project…");
            const r = await getProject(latest.id);
            if (!alive) return;
            doc = r.document;
            setProjectId(r.project.id);
            setRev(r.project.rev);
          } else {
            doc = newProject(`${post.title || `Post ${post.index}`} · cut`);
            const start = vids.find((v) => v.id === initialVideoId) ?? vids.find((v) => v.forClient) ?? vids[0];
            const m = start ? media.get({ kind: "version", batch: post.batch, videoId: start.id }) : null;
            if (m) doc.clips = [newClip(m.source, m.duration)];
          }
        } else {
          doc = newProject("New cut");
        }
        if (!alive) return;
        history.load(doc);
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
  }, [open, project === null]);
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
      if (!(await askConfirm("An export is running. Stop it and close the editor?", { ok: "Stop and close", danger: true, cancel: "Keep rendering" }))) return;
      abortRef.current?.abort();
    } else if (history.dirty && !readOnly && post) {
      const ok = await askConfirm("Save this project before closing?", { ok: "Save and close", danger: false, cancel: "Close without saving" });
      if (ok && !(await save())) return;
    }
    onClose();
  };

  /* ───────────── Keys ───────────── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (e.key === "s" && !readOnly) split();
      else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly) remove();
      else if (e.key === "Escape") void close();
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

  const panelBody = ctx ? (tab === "clips" ? <ClipsPanel ctx={ctx} /> : tab === "auto" ? <AutoEditPanel ctx={ctx} /> : tab === "music" ? <MusicPanel ctx={ctx} /> : tab === "colour" ? <ColourPanel ctx={ctx} /> : <ExportPanel ctx={ctx} />) : null;
  const length = project ? totalLength(project) : 0;
  const title = post ? post.title || `Post ${post.index}` : "Video editor";

  const sheet = (
    <div className={`ts ve ${narrow ? "narrow" : ""}`} role="dialog" aria-label="Video editor">
      <header className="ts-top">
        <div className="ts-top-left">
          <button type="button" className="ts-icon" onClick={() => void close()} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
          <span className="ts-title">
            {title}
            <small> · {project?.name ?? "Video editor"}</small>
          </span>
          {history.dirty && !readOnly && post && <span className="ts-save dirty">Unsaved</span>}
        </div>
        <div className="ts-tools ve-tools" role="toolbar" aria-label="Edit">
          <span className="ts-tool-group" aria-label="History">
            <button type="button" className="ts-icon" onClick={history.undo} disabled={!history.canUndo} title="Undo (⌘Z)" aria-label="Undo">
              <Undo2 size={15} />
            </button>
            <button type="button" className="ts-icon" onClick={history.redo} disabled={!history.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
              <Redo2 size={15} />
            </button>
          </span>
          <span className="ts-sep" />
          <button type="button" className="ts-icon" onClick={split} disabled={readOnly || !project?.clips.length} title="Split at the playhead (S)" aria-label="Split at the playhead">
            <Scissors size={15} />
          </button>
        </div>
        <div className="ts-top-right">
          {readOnly ? (
            <span className="ve-readonly" title={access.reason}>
              Admins only for now
            </span>
          ) : (
            post && (
              <button type="button" className="ts-btn" onClick={() => void save()} disabled={saving || !project} title="Save this project with the post (⌘S)">
                {saving ? <Orb size={14} status={null} /> : <Save size={14} />} Save project
              </button>
            )
          )}
          <button type="button" className="ts-btn" onClick={() => { setTab("export"); setPanelOpen(true); }} disabled={!project}>
            <Download size={14} /> Export
          </button>
          <button type="button" className="ts-btn primary" onClick={() => void close()}>
            Close
          </button>
        </div>
      </header>
      <div className="ve-body">
        <div className="ve-main">
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
            {selectedClip && (
              <span className="ve-selected">
                {labelOf(selectedClip)} selected
              </span>
            )}
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
        </div>
        <aside className={`ts-right ve-side ${narrow && !panelOpen ? "closed" : ""}`}>
          {!narrow && (
            <div className="ts-tabs">
              {TABS.map((t) => (
                <button key={t.id} type="button" className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="ts-side-body">{panelBody}</div>
        </aside>
        {narrow && (
          <nav className="ve-bottom" aria-label="Panels">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id && panelOpen ? "on" : ""}
                onClick={() => {
                  if (tab === t.id && panelOpen) setPanelOpen(false);
                  else {
                    setTab(t.id);
                    setPanelOpen(true);
                  }
                }}
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
