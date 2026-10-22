/**
 * The Photo studio: one full-screen workspace for a post's picture, with the same shell as the Text
 * studio (top bar, a rail of tools on the left, the picture large in the middle, the chosen tool's
 * panel on the right; on a phone one panel at a time from a bottom toolbar). The tools: Edit with
 * AI (the same paid edit as the post editor), Adjust (free, drawn here), the Photo lab and Assets
 * (Freepik, admins only for now), Versions and Check. Nothing is made or spent without the confirm
 * each tool asks.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FlaskConical, History, Images, LayoutGrid, Lock, Minus, Plus, Redo2, ScanSearch, SlidersHorizontal, Sparkles, Type, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { postForm } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { formatUsd } from "@shared/pricing";
import { POST_TYPE_INFO } from "@shared/posts";
import type { Task } from "@shared/types";
import { DEFAULT_ADJUST, describeAdjust, isDefaultAdjust, rotatedSize, type AdjustParams } from "@shared/photo-adjust";
import type { PostEditorTools } from "../ReviewDialog";
import { useFreepikStatus } from "../FreepikPanel";
import { usePhotoLab } from "../photolab/usePhotoLab";
import { usePhotoTools } from "./usePhotoTools";
import { useParamsHistory } from "./history";
import { canvasFile, drawAdjusted, loadPicture, MAX_OUTPUT_EDGE } from "./render";
import Stage from "./Stage";
import EditPanel from "./panels/Edit";
import AdjustPanel from "./panels/Adjust";
import LabPanel from "./panels/Lab";
import AssetsPanel from "./panels/Assets";
import VersionsPanel from "./panels/Versions";
import CheckPanel from "./panels/Check";
import ToolsPanel from "./panels/Tools";
import { PresetDetailPanel, PresetsGallery, usePhotoPresets } from "./panels/Presets";
import type { Area, PhotoPanel, StageView, StudioCtx } from "./types";
import "./photo-studio.css";

export type { PhotoPanel } from "./types";

interface Props {
  open: boolean;
  /** The post editor's tools for this post: the same object the dialog gets. */
  editor: PostEditorTools;
  task: Task;
  busy: boolean;
  /** The product photo the picture was made from, and the picture itself. */
  originalUrl: string;
  resultUrl: string;
  clientId: string | null;
  initialPanel?: PhotoPanel;
  /** The AI edit from an instruction: the same server call as the post editor. */
  onRevise: (edit: string) => Promise<void>;
  /** A fresh picture from the saved idea (asked first); absent when the post cannot be remade. */
  onRemake?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  /** Opens the Text studio on the same post. */
  onTextStudio?: () => void;
  /** The post's picture changed (Adjust applied): the month is read again. */
  onPictureChanged: () => Promise<void> | void;
}

const PANELS: { id: PhotoPanel; label: string; icon: ReactNode; title: string }[] = [
  { id: "presets", label: "Presets", icon: <LayoutGrid size={18} />, title: "Presets: picture styles, product shots and looks with the providers' sample pictures (browsing is free)" },
  { id: "tools", label: "AI tools", icon: <Sparkles size={18} />, title: "AI tools: Higgsfield's and Magnific's picture tools on this picture, paid in credits (admins only for now)" },
  { id: "edit", label: "Edit", icon: <Wand2 size={18} />, title: "Edit with AI: an instruction changes the picture (one paid picture)" },
  { id: "adjust", label: "Adjust", icon: <SlidersHorizontal size={18} />, title: "Adjust: crop, turn, light and colour, drawn here for free" },
  { id: "lab", label: "Photo lab", icon: <FlaskConical size={18} />, title: "Photo lab: Freepik's real-photo tools (admins only for now)" },
  { id: "assets", label: "Assets", icon: <Images size={18} />, title: "Assets: Freepik stock and the client's Drive photos" },
  { id: "versions", label: "Versions", icon: <History size={18} />, title: "Versions: every take of this post, compared and restored" },
  { id: "check", label: "Check", icon: <ScanSearch size={18} />, title: "Check: the automatic review and the writing check" },
];

/** On a phone the two picture-making panels share one "AI" button, so eight tools fit a 390 px toolbar. */
const AI_GROUP: PhotoPanel[] = ["presets", "tools"];
const NARROW_PANELS: { id: PhotoPanel; label: string; icon: ReactNode; title: string }[] = [{ id: "tools", label: "AI", icon: <Sparkles size={18} />, title: "Presets and AI tools" }, ...PANELS.filter((t) => !AI_GROUP.includes(t.id))];

const PREVIEW_EDGE = 1200;
const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
const STATE_LABEL: Record<string, string> = { ready: "Ready", review: "Review", approved: "Approved", failed: "Failed", queued: "Queued", processing: "Making…" };

export default function PhotoStudio(p: Props) {
  const { open, editor, task, busy, originalUrl, resultUrl, onRevise, onClose, onPictureChanged } = p;
  const post = editor.post;
  const index = post.index;
  const inFlight = task.status === "queued" || task.status === "processing";
  const cost = editor.perPicture ? ` · about ${formatUsd(editor.perPicture)}` : "";

  // A post with no picture yet opens on the presets: a picture can start from one.
  const [panel, setPanel] = useState<PhotoPanel>(p.initialPanel ?? (task.output ? "edit" : "presets"));
  const [panelOpen, setPanelOpen] = useState(true);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches);
  const [view, setView] = useState<StageView>({ kind: "picture", src: resultUrl, label: "The AI result" });
  const [zoom, setZoom] = useState(1);
  const fitRef = useRef(1);
  const onFit = useCallback((f: number) => {
    fitRef.current = f;
  }, []);
  const [marking, setMarking] = useState(false);
  const [area, setArea] = useState<Area | null>(null);
  const [edit, setEdit] = useState("");
  const [holdBefore, setHoldBefore] = useState(false);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [applying, setApplying] = useState(false);
  const [comparePick, setComparePick] = useState<string[]>([]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [preview, setPreview] = useState<HTMLCanvasElement | null>(null);
  const history = useParamsHistory<AdjustParams>(DEFAULT_ADJUST);
  const params = history.value;
  const rootRef = useRef<HTMLDivElement>(null);
  const freepik = useFreepikStatus();
  const lab = usePhotoLab({ clientId: p.clientId ?? "", batchId: editor.batchId, post: index, task: { id: task.id, imageUrl: resultUrl }, onChanged: editor.onMonthChanged });
  const aiActive = open && (panel === "presets" || panel === "tools");
  const tools = usePhotoTools({ batchId: editor.batchId, post: index, hasPicture: !!task.output, onChanged: onPictureChanged, active: aiActive });
  const presets = usePhotoPresets(editor.batchId ? { batch: editor.batchId, index } : null, open && panel === "presets");

  /* ───────────── Narrow screens: one panel, a bottom toolbar ───────────── */
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open]);

  /* ───────────── The picture ───────────── */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setImg(null);
    setNatural(null);
    setArea(null);
    setMarking(false);
    setComparePick([]);
    history.reset(DEFAULT_ADJUST);
    setView((v) => (v.kind === "adjust" ? v : { kind: "picture", src: resultUrl, label: "The AI result" }));
    loadPicture(resultUrl)
      .then((im) => {
        if (!alive) return;
        imgRef.current = im;
        setImg(im);
        setNatural({ w: im.naturalWidth, h: im.naturalHeight });
      })
      .catch((e) => alive && toast.error((e as Error).message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resultUrl]);

  /* ───────────── The panel decides what the canvas shows ───────────── */
  useEffect(() => {
    if (panel === "adjust") setView({ kind: "adjust" });
    else setView((v) => (v.kind === "adjust" ? { kind: "picture", src: resultUrl, label: "The AI result" } : v));
  }, [panel, resultUrl]);
  const takes = useMemo(() => editor.takes ?? [], [editor.takes]);
  useEffect(() => {
    if (panel !== "versions") return;
    const pics = comparePick.map((k) => takes.find((t) => t.key === k)?.image).filter((x): x is string => !!x);
    if (pics.length === 2) setView({ kind: "compare", before: pics[0], after: pics[1], beforeLabel: "First pick", afterLabel: "Second pick" });
    else if (pics.length === 1) setView({ kind: "compare", before: pics[0], after: resultUrl, beforeLabel: "Earlier take", afterLabel: "Current picture" });
    else setView({ kind: "picture", src: resultUrl, label: "The AI result" });
  }, [panel, comparePick, takes, resultUrl]);
  const toggleComparePick = useCallback((key: string) => {
    setComparePick((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s.slice(-1), key]));
  }, []);
  // Marking a box needs the picture alone under the pointer.
  useEffect(() => {
    if (marking) setView((v) => (v.kind === "compare" ? { kind: "picture", src: resultUrl, label: "The AI result" } : v));
  }, [marking, resultUrl]);

  /* ───────────── The Adjust preview ───────────── */
  useEffect(() => {
    if (panel !== "adjust" || !img) {
      setPreview(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      try {
        setPreview(drawAdjusted(img, params, PREVIEW_EDGE, false).canvas);
      } catch (e) {
        toast.error((e as Error).message);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [panel, img, params]);

  /* ───────────── Actions ───────────── */
  const setParams = useCallback((next: AdjustParams, coalesce?: string) => history.set(next, coalesce), [history]);
  const resetParams = useCallback(() => history.set(DEFAULT_ADJUST), [history]);
  const applyAdjust = useCallback(
    async (confirm = true): Promise<boolean> => {
      const im = imgRef.current;
      const prm = history.value;
      const changes = describeAdjust(prm);
      if (!im || !editor.batchId || !changes.length) return false;
      if (confirm) {
        const ok = await askConfirm(`Apply to post ${index}'s picture: ${changes.join(", ")}. The adjusted picture becomes the post's picture (free: drawn here, nothing is generated); the current one stays under Versions. The words and the logo are redrawn over it.`, { ok: "Apply", danger: false, cancel: "Not yet" });
        if (!ok) return false;
      }
      setApplying(true);
      try {
        const { canvas } = drawAdjusted(im, prm, MAX_OUTPUT_EDGE, true);
        const png = /\.png(\?|$)/i.test(task.output ?? "");
        const file = await canvasFile(canvas, `post-${index}-adjusted`, png);
        const form = new FormData();
        form.set("batch", editor.batchId);
        form.set("index", String(index));
        form.set("note", `Adjusted in the Photo studio: ${changes.join(", ")}`);
        form.set("file", file, file.name);
        await postForm("/api/studio/posts/picture/upload", form);
        history.reset(DEFAULT_ADJUST);
        toast.success(`Post ${index}'s picture adjusted. The previous one is under Versions.`);
        await onPictureChanged();
        return true;
      } catch (e) {
        toast.error((e as Error).message);
        return false;
      } finally {
        setApplying(false);
      }
    },
    [editor.batchId, history, index, onPictureChanged, task.output],
  );
  const close = useCallback(async () => {
    if (!isDefaultAdjust(history.value)) {
      const ok = await askConfirm("Adjustments not applied yet. Apply them as the post's new picture before closing, or leave without them?", { ok: "Apply and close", danger: false, cancel: "Leave without applying" });
      if (ok && !(await applyAdjust(false))) return;
    }
    onClose();
  }, [applyAdjust, history.value, onClose]);
  const revise = useCallback(
    async (text: string) => {
      if (!text) return;
      const slide = post.group ? ` (slide ${post.group.slide} of ${post.group.of})` : "";
      const ok = await askConfirm(`Edit post ${index}'s picture${slide}: one paid picture${cost}. Only this post changes; the current picture stays under Versions.`, { ok: `Edit this picture${cost}`, danger: false, cancel: "Not now" });
      if (!ok) return;
      // The instruction is also the note on the attached reference, so the engine does with it exactly what was asked.
      if (editor.batchId && post.reference && edit.trim()) {
        const form = new FormData();
        form.set("batch", editor.batchId);
        form.set("index", String(index));
        form.set("note", edit.trim());
        await postForm("/api/studio/posts/reference", form).catch(() => undefined);
      }
      await onRevise(text);
      setEdit("");
      setArea(null);
      setMarking(false);
    },
    [cost, edit, editor.batchId, index, onRevise, post.group, post.reference],
  );
  const remake = useMemo(
    () =>
      p.onRemake
        ? async () => {
            const slide = post.group ? ` (slide ${post.group.slide} of ${post.group.of})` : "";
            const ok = await askConfirm(`Make another version of post ${index}${slide}? A fresh picture is made from the saved idea and shot, not from the current picture. One paid picture${cost}. Only this post changes; the current picture stays under Versions.`, { ok: `Make another version${cost}`, danger: false, cancel: "Not now" });
            if (ok) p.onRemake!();
          }
        : undefined,
    [p.onRemake, post.group, index, cost],
  );
  const openPanel = useCallback((id: PhotoPanel) => {
    setPanel(id);
    setPanelOpen(true);
  }, []);
  const toggleZoom = () => setZoom((z) => (Math.abs(z * fitRef.current - 1) < 0.02 ? 1 : 1 / fitRef.current));

  /* ───────────── Keyboard ───────────── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (e.key === "[" && p.onPrev) {
        e.preventDefault();
        p.onPrev();
      } else if (e.key === "]" && p.onNext) {
        e.preventDefault();
        p.onNext();
      } else if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        toggleZoom();
      } else if ((e.key === "c" || e.key === "C") && !e.repeat) {
        e.preventDefault();
        if (panel === "adjust") setHoldBefore(true);
        else setHoldOriginal(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (marking) setMarking(false);
        else if (view.kind === "compare") {
          setComparePick([]);
          setView({ kind: "picture", src: resultUrl, label: "The AI result" });
        } else if (panel === "adjust" && params.crop) history.set({ ...params, crop: null, aspect: "free" });
        else void close();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "c" || e.key === "C") {
        setHoldBefore(false);
        setHoldOriginal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  }, [open, p, panel, marking, view.kind, params, history, close, resultUrl]);
  // ⌘/ctrl + wheel over the picture zooms; a plain wheel scrolls (pans) the stage.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !open) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !(e.target as HTMLElement).closest(".ps-stage")) return;
      e.preventDefault();
      setZoom((z) => Math.min(8 / fitRef.current, Math.max(1, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  /* ───────────── What the stage shows ───────────── */
  const stageView: StageView = holdOriginal && view.kind !== "adjust" ? { kind: "picture", src: originalUrl, label: "The product photo" } : view;
  const stageSize = view.kind === "adjust" && natural ? rotatedSize(natural.w, natural.h, params.rotate) : natural;
  const cropFrame = view.kind === "adjust" && params.crop && stageSize ? { rect: params.crop, aspect: params.aspect, frameW: stageSize.w, frameH: stageSize.h, onChange: (c: AdjustParams["crop"]) => history.set({ ...params, crop: c }, "crop") } : null;
  const percent = Math.round(fitRef.current * zoom * 100);

  const ctx: StudioCtx = {
    editor,
    task,
    busy,
    inFlight,
    resultUrl,
    originalUrl,
    clientId: p.clientId,
    cost,
    view,
    setView,
    openPanel,
    onTextStudio: p.onTextStudio,
    edit,
    setEdit,
    marking,
    setMarking,
    area,
    setArea,
    revise,
    remake,
    params,
    setParams,
    resetParams,
    natural,
    holdBefore,
    setHoldBefore,
    applyAdjust: () => applyAdjust(true).then(() => undefined),
    applying,
    lab,
    presets,
    tools,
    comparePick,
    toggleComparePick,
    ocrPanel: editor.ocrPanel,
    freepik: editor.freepik,
    drivePicker: editor.drivePicker,
    videoVersions: editor.videoVersions,
    monthVersions: editor.versions,
  };
  const body = panel === "presets" ? <PresetDetailPanel ctx={ctx} /> : panel === "tools" ? <ToolsPanel ctx={ctx} /> : panel === "edit" ? <EditPanel ctx={ctx} /> : panel === "adjust" ? <AdjustPanel ctx={ctx} /> : panel === "lab" ? <LabPanel ctx={ctx} /> : panel === "assets" ? <AssetsPanel ctx={ctx} /> : panel === "versions" ? <VersionsPanel ctx={ctx} busy={busy} /> : <CheckPanel ctx={ctx} />;
  const locked = (id: PhotoPanel) => (id === "lab" ? lab.locked : id === "assets" ? !!freepik && !freepik.admin : id === "tools" ? !!tools.catalog && !tools.catalog.admin : false);
  const bottomOn = (id: PhotoPanel) => (id === "tools" ? AI_GROUP.includes(panel) : panel === id);
  const madeTakes = takes.filter((t) => t.status === "made").length;
  const state = inFlight ? "making" : task.status === "failed" ? "failed" : task.status === "review" ? "review" : "ready";
  const dirty = !isDefaultAdjust(params);

  if (!open) return null;
  const sheet = (
    <div className={`ts ps ${narrow ? "narrow" : ""}`} role="dialog" aria-label="Photo studio" ref={rootRef}>
      <header className="ts-top">
        <div className="ts-top-left">
          <button type="button" className="ts-icon" onClick={() => void close()} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
          <span className="ts-title">
            Photo studio <small>· post {index} · {post.title || POST_TYPE_INFO[post.type]?.label || "post"}</small>
          </span>
          <span className={`ps-state ${state}`}>{STATE_LABEL[task.status] ?? task.status}</span>
          {dirty && <span className="ts-save dirty">Adjustments not applied</span>}
        </div>
        <div className="ts-tools ps-tools" role="toolbar" aria-label="History">
          <span className="ts-tool-group">
            <button type="button" className="ts-icon" onClick={history.undo} disabled={!history.canUndo} title="Undo an adjustment (⌘Z)" aria-label="Undo">
              <Undo2 size={15} />
            </button>
            <button type="button" className="ts-icon" onClick={history.redo} disabled={!history.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
              <Redo2 size={15} />
            </button>
          </span>
        </div>
        <div className="ts-top-right">
          <button type="button" className={`ts-btn ${panel === "versions" ? "on" : ""}`} onClick={() => openPanel("versions")} title="Every take of this post">
            <History size={14} /> <span>Versions · {madeTakes}</span>
          </button>
          {p.onTextStudio && (
            <button type="button" className="ts-btn" onClick={p.onTextStudio} title="The words and layers on this picture, in the Text studio (no picture is made)">
              <Type size={14} /> <span>Text studio</span>
            </button>
          )}
          <button type="button" className="ts-btn primary" onClick={() => void close()}>
            Close
          </button>
        </div>
      </header>
      <div className="ps-body">
        {!narrow && (
          <nav className="ps-rail" aria-label="Tools">
            {PANELS.map((t) => (
              <button key={t.id} type="button" className={panel === t.id ? "on" : ""} onClick={() => openPanel(t.id)} title={t.title} aria-pressed={panel === t.id}>
                {t.icon}
                <span>{t.label}</span>
                {locked(t.id) && <Lock size={9} className="ps-rail-lock" aria-label="Admins only for now" />}
              </button>
            ))}
          </nav>
        )}
        {panel === "presets" ? (
          <PresetsGallery ctx={ctx} />
        ) : (
          <Stage view={stageView} size={stageSize} zoom={zoom} onFit={onFit} marking={marking} area={area} onArea={setArea} preview={preview} holdBefore={holdBefore} beforeSrc={resultUrl} crop={cropFrame} loading={!img && !!task.output}>
            {marking && <div className="ps-hint-pill">{area && area.w > 0.01 ? "Marked: put it in the instruction from the Edit panel. Not a mask; the whole picture is redrawn." : "Drag on the picture to mark the area to change."}</div>}
            {view.kind === "compare" && !marking && <div className="ps-hint-pill">Drag the slider to compare · Esc to stop</div>}
            {holdOriginal && <div className="ps-hint-pill">The product photo</div>}
            {!task.output && <div className="ps-hint-pill">No picture yet: start from a preset, or make the picture first.</div>}
            <div className="ts-view ps-view" role="toolbar" aria-label="View">
              <div className="ts-zoom">
                <button type="button" className="ts-icon" onClick={() => setZoom((z) => Math.max(1, z / 1.2))} title="Zoom out" aria-label="Zoom out">
                  <Minus size={14} />
                </button>
                <button type="button" className="ts-zoom-value" onClick={toggleZoom} title="Fit or 100% (Z)">
                  {percent}%
                </button>
                <button type="button" className="ts-icon" onClick={() => setZoom((z) => Math.min(8 / fitRef.current, z * 1.2))} title="Zoom in" aria-label="Zoom in">
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </Stage>
        )}
        <aside className={`ts-right ps-side ${narrow && !panelOpen ? "closed" : ""}`}>
          <div className="ts-side-body">{body}</div>
        </aside>
        {narrow && (
          <nav className="ps-bottom" aria-label="Tools">
            {NARROW_PANELS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={bottomOn(t.id) && panelOpen ? "on" : ""}
                onClick={() => {
                  if (bottomOn(t.id) && panelOpen) setPanelOpen(false);
                  else openPanel(t.id === "tools" && AI_GROUP.includes(panel) ? panel : t.id);
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
