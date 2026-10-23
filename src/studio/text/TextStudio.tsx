import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignCenter, AlignJustify, AlignLeft, Aperture, AlignRight, Bold, ChevronDown, Clapperboard, Download, Eye, Italic, Keyboard, Layers, LayoutTemplate, Lock, LockOpen, Minus, Palette, Plus, Redo2, RotateCcw, Sparkles, Trash2, TriangleAlert, Type, Underline, Undo2, X, Copy, Grid3x3, Wand2, Images } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { toast } from "sonner";
import { post, postForm } from "@/api";
import { askConfirm, askInput } from "@/lib/confirm";
import { saveBlob } from "@/lib/zip";
import { stackedImagesPdf } from "@/lib/pdf";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import type { Client } from "@shared/types";
import { editText, isTextLayer, layerId, logoLayerAt, newImageLayer, newLogoLayer, newShapeLayer, newTextLayer, replaceInLayers, setRunStyle, styleAt, upgradeDesign, wordsOf, type CanvasFx, type ImageLayer, type Layer, type RunStyle, type ShapeKind, type TextDesign, type TextLayer } from "@shared/layers";
import { loadFont, loadImage, paintFrame, renderOverlay, type OverlayLayout } from "@/lib/overlay";
import { drawBasePicture, renderDesignOnly, type LayerBox } from "@/lib/textLayers";
import { Orb } from "@/components/Orb";
import ColorField from "./ColorField";
import FontMenu from "./FontMenu";
import FreepikPanel, { LETTERING_LABEL, type DesignHow, type FreepikLayer } from "../FreepikPanel";
import { takeAssetsForDesign, type PendingAsset } from "../assetHandoff";
import { duplicateLayers, imageLayerFromAsset, patchLayers, removeLayers, reorderLayer, setBackground, zOrderLayers } from "@shared/layer-ops";
import { extractSvgColors, recolorSvg } from "@shared/svg-colors";
import { sanitizeSvg } from "@shared/svg-sanitize";
import { mergePieces, type MergePiece } from "@shared/svg-split";
import { fetchSvgText, planSplit, recolorFor, stripBackground } from "@/lib/svgSplit";
import VectorActions, { isSvgLayer, splitRefusal, type VectorBusy } from "./VectorActions";
import { Assistant, BrandAssets, LayersList, LayoutsList, PresetsList, type Asset } from "./Panels";
import Properties, { type Align } from "./Properties";
import { applyLayout, brandFonts, contrastOf, designFromLegacy, directionFor, hitLayer, languageWithSource, layoutsFor, patchWith, round3, sampleContent, savedColours, snapMove, styleToApply, toLocal, type ApplyRole, type Brand, type ClientLanguage, type Guide, type LayoutPreset } from "./model";
import "./text-studio.css";
import { heldMessage, holdNote, type HoldReason } from "@shared/client-hold";
import { commitSession, flashCard, getSession, patchSession, pendingLabel, pendingParts } from "../editing-session";
import "../editing-session.css";

/** What the design was opened from: a draft kept in the session is used only on the same words and design. */
const basisOf = (headline: string, subline: string, patch: PostOverlayPatch | undefined) => JSON.stringify([headline, subline, patch?.design ?? null]);

export interface EditorResult {
  headline: string;
  subline: string;
  ov: PostOverlayPatch | undefined;
}

export type { ApplyRole } from "./model";

interface Props {
  open: boolean;
  src: string;
  spec: OverlaySpec;
  logoSrc: string | null;
  headline: string;
  subline: string;
  patch: PostOverlayPatch | undefined;
  faces?: number[][];
  brand: Brand;
  /** The month's colours, offered after the brand's. */
  palette?: { name: string; hex: string }[];
  /** The saved post the assistant works on. */
  batchId?: string | null;
  index: number;
  /** Base of exported file names. */
  fileName: string;
  onClientsChanged?: (clients: Client[]) => void;
  onClose: () => void;
  /** Switches to the Photo studio on the same post (the design is saved first). */
  onPhotoStudio?: () => void;
  /** Switches to the Video studio on the same post (the design is saved first). */
  onVideoStudio?: () => void;
  /**
   * The client holds the post's current version (approved it, or sees it on the review link): the
   * words and layers are kept as a draft in the card's session, never saved over the client's
   * version without the designer choosing it at "Save & return".
   */
  hold?: HoldReason | null;
  /** keepOpen: an auto-save while the designer keeps working. */
  onSave: (r: EditorResult, keepOpen: boolean) => void;
  /** Pictures a picture layer can show: the month's product photos and the brand's own assets. */
  assets?: Asset[];
  /** Stores an uploaded graphic for the month and returns the studio URL a picture layer can point at. */
  onUploadGraphic?: (file: File) => Promise<string>;
  /**
   * Applies a look to the same-role layers of the month's other posts (their words stay) and
   * returns how many posts changed. The logo role carries the logo's place and size.
   */
  onApplyToAll?: (style: Partial<Layer>, role: ApplyRole) => Promise<number>;
  /**
   * The month's and this post's content language overrides, when any; the brand kit's language
   * is the default. The layouts and new layers follow the resolved language.
   */
  monthLanguage?: ClientLanguage;
  postLanguage?: ClientLanguage;
  /**
   * Applies a layout to the month's other designs: `make` builds each post's design from its own
   * words (and its own language); `dryRun` only counts. Returns how many posts changed (or would).
   */
  onApplyLayoutToAll?: (make: (post: { headline?: string; subline?: string; design?: TextDesign | null; language?: ClientLanguage }) => TextDesign, name: string, dryRun: boolean) => Promise<number>;
}

/** A layout on the stage before it is applied: nothing in the design has changed yet. */
interface Trial {
  id: string;
  name: string;
  design: TextDesign;
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "rot";
type Drag =
  | { kind: "move"; start: { x: number; y: number }; origin: Layer[]; ids: string[]; moved: boolean }
  | { kind: "resize"; handle: Handle; id: string; origin: Layer; box: LayerBox }
  | { kind: "rotate"; id: string; origin: Layer; box: LayerBox }
  | { kind: "marquee"; start: { x: number; y: number }; add: boolean; now: { x: number; y: number } };

const MAX_HISTORY = 60;
const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

/** True when the picture has no transparent pixel (sampled small): a JPG photo, not a cut-out. */
function isOpaque(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = 48;
    c.height = 48;
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return true;
    x.drawImage(img, 0, 0, 48, 48);
    const px = x.getImageData(0, 0, 48, 48).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return false;
    return true;
  } catch {
    return true;
  }
}

/** The professional text editor: layers of real text over the picture, drawn by the one renderer. */
export default function TextStudio(p: Props) {
  const { open, src, spec, logoSrc, brand } = p;
  const palette = p.palette ?? [];
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const [design, setDesign] = useState<TextDesign | null>(null);
  const designRef = useRef<TextDesign | null>(null);
  designRef.current = design;
  const pastRef = useRef<TextDesign[]>([]);
  const futureRef = useRef<TextDesign[]>([]);
  const [histTick, setHistTick] = useState(0);
  const typingAtRef = useRef(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [boxes, setBoxes] = useState<LayerBox[]>([]);
  const boxesRef = useRef<LayerBox[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const dragRef = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(0.5);
  const [leftTab, setLeftTab] = useState<"layers" | "layouts" | "presets" | "brand">("layers");
  const [rightTab, setRightTab] = useState<"props" | "assist" | "assets">("props");
  /** Narrow screens have one panel: which side's tab it shows. */
  const [side, setSide] = useState<"left" | "right">("right");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [safe, setSafe] = useState(false);
  const [saving, setSaving] = useState<"saved" | "dirty" | "saving">("saved");
  const [saved, setSaved] = useState<string[]>(() => savedColours.list(brand.id));
  const [shortcuts, setShortcuts] = useState(false);
  const pickRef = useRef<((hex: string | null) => void) | null>(null);
  const [picking, setPicking] = useState(false);
  const clipRef = useRef<Layer[]>([]);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const histKey = `lsm-ts-hist:${p.batchId ?? "x"}:${p.index}`;
  const [previewOn, setPreviewOn] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [returning, setReturning] = useState(false);
  /** A vector being split, stripped of its background or merged back. */
  const [vectorBusy, setVectorBusy] = useState<VectorBusy>(null);
  /** "Remove background": what would go, highlighted on the stage, until it is confirmed or cancelled. */
  const [bgPreview, setBgPreview] = useState<{ polys: { x: number; y: number }[][]; note: string; confirm: () => Promise<void> } | null>(null);
  const hold = p.hold ?? null;
  const batch = p.batchId ?? null;
  const basis = basisOf(p.headline, p.subline, p.patch);

  const W = size?.W ?? 1080;
  const H = size?.H ?? 1350;
  const scale = fit * zoom;
  const layers = useMemo(() => design?.layers ?? [], [design]);
  const primary = useMemo(() => layers.find((l) => l.id === selected[0]) ?? null, [layers, selected]);
  /** The selected layer when it is a text layer: the type tools work on this one. */
  const primaryText = primary && isTextLayer(primary) ? primary : null;
  const selLayers = useMemo(() => layers.filter((l) => selected.includes(l.id)), [layers, selected]);
  const fonts = brandFonts(brand);
  /** The content language in force: the post's, else the month's, else the brand kit's. */
  const { language: lang, source: langSource } = languageWithSource(brand.language, p.monthLanguage, p.postLanguage);

  /* ───────────── Narrow screens: one panel, every tab ───────────── */
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open]);

  /* ───────────── Loading ───────────── */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setDesign(null);
    setSelected([]);
    setEditing(null);
    pastRef.current = [];
    futureRef.current = [];
    void (async () => {
      try {
        const img = await loadImage(src);
        if (!alive) return;
        imgRef.current = img;
        const w = Math.min(1080, img.naturalWidth || 1080);
        const h = Math.round((w * (img.naturalHeight || 1350)) / (img.naturalWidth || 1080));
        const base = document.createElement("canvas");
        base.width = w;
        base.height = h;
        base.getContext("2d")!.drawImage(img, 0, 0, w, h);
        baseRef.current = base;
        photoOpaque.current = isOpaque(img);
        setSize({ W: w, H: h });
        for (const f of brand.fontFiles) void loadFont(f.name, `/api/studio/clients/${brand.id}/fonts/${f.id}/file`);
        // A stored design of any earlier shape is read into the current one (text-only designs come back as they were).
        let d = p.patch?.design ? (upgradeDesign(p.patch.design) ?? undefined) : undefined;
        // Where the client's automatic layout puts the words and the logo on this picture.
        const automatic = async (): Promise<OverlayLayout> => {
          const probe = document.createElement("canvas");
          probe.width = w;
          probe.height = h;
          const { design: _d, ...legacy } = p.patch ?? {};
          void _d;
          return paintFrame(probe, img, spec, { headline: p.headline, subline: p.subline }, logoSrc, { patch: legacy, faces: p.faces });
        };
        if (!d) {
          // The first visit: the automatic layout's words and logo become layers exactly where they were.
          const layout = await automatic();
          d = designFromLegacy(spec, p.headline, p.subline, p.patch, layout.text, w, h, layout.logo);
        } else if (logoSrc && !d.layers.some((l) => l.type === "logo")) {
          // A design saved before the logo was a layer: the logo the layout draws becomes one, in place.
          const logo = logoLayerAt((await automatic()).logo, w, h);
          if (logo) d = { ...d, layers: [logo, ...d.layers] };
        }
        // A draft kept in the card's session (a switch to another studio, or held for the client) comes back.
        const kept = getSession(batch, p.index)?.text;
        const keptDesign = kept && kept.basis === basis && kept.result.ov?.design ? upgradeDesign(kept.result.ov.design) : null;
        // The undo history of an earlier session on this very design.
        try {
          const raw = sessionStorage.getItem(histKey);
          if (raw) {
            const h = JSON.parse(raw) as { present: TextDesign; past: TextDesign[] };
            if (JSON.stringify(h.present) === JSON.stringify(d)) pastRef.current = h.past;
          }
        } catch {
          /* no history */
        }
        if (!alive) return;
        if (keptDesign) {
          pastRef.current = [...pastRef.current, d];
          d = keptDesign;
        }
        setDesign(d);
        setSelected(d.layers.length ? [d.layers[d.layers.length - 1].id] : []);
        dirtyRef.current = !!keptDesign;
        setSaving(keptDesign ? "dirty" : "saved");
        // An asset chosen in the Photo studio for this post: placed once the design is on the stage.
        pendingAssetsRef.current = takeAssetsForDesign(p.batchId, p.index);
      } catch (e) {
        toast.error((e as Error).message);
        p.onClose();
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, src]);

  /* ───────────── The asset carried over from the Photo studio (one search, one import) ───────────── */
  useEffect(() => {
    if (!open || !design || !size || !pendingAssetsRef.current.length) return;
    const list = pendingAssetsRef.current;
    pendingAssetsRef.current = [];
    for (const it of list) addFromAsset(it.layer, it.how);
    setRightTab(list[list.length - 1].how === "background" ? "props" : "assets");
    setSide("right");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, design, size]);

  /* ───────────── Fit to the stage ───────────── */
  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setFit(Math.max(0.05, Math.min((r.width - 48) / W, (r.height - 48) / H)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, W, H, size]);

  /* ───────────── Drawing ───────────── */
  useEffect(() => {
    const c = canvasRef.current;
    const img = imgRef.current;
    if (!open || !design || !c || !img || !size) return;
    c.width = W;
    c.height = H;
    let alive = true;
    const skip = editing ? new Set([editing]) : undefined;
    // A layout being previewed is drawn in place of the design; the design itself is untouched.
    const shown = trial?.design ?? design;
    // The picture alone, cropped and shifted as the design asks: what the colour picker and the
    // contrast warnings read, and what frosted backings blur.
    const base = baseRef.current;
    if (base) drawBasePicture(base.getContext("2d")!, img, base.width, base.height, shown.canvas);
    void paintFrame(c, img, spec, { headline: "", subline: "" }, logoSrc, { patch: patchWith(p.patch, shown), skipLayers: skip }).then((l) => {
      if (!alive) return;
      boxesRef.current = l.layers ?? [];
      setBoxes(l.layers ?? []);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, design, trial, size, editing, spec, logoSrc]);

  /* ───────────── History and saving ───────────── */
  const persistHistory = (present: TextDesign) => {
    try {
      sessionStorage.setItem(histKey, JSON.stringify({ present, past: pastRef.current.slice(-20) }));
    } catch {
      /* full */
    }
  };
  const commit = useCallback((next: TextDesign, typing = false) => {
    const cur = designRef.current;
    if (!cur) return;
    const now = Date.now();
    if (!(typing && now - typingAtRef.current < 900)) {
      pastRef.current = [...pastRef.current.slice(-MAX_HISTORY + 1), cur];
      futureRef.current = [];
    }
    typingAtRef.current = typing ? now : 0;
    designRef.current = next;
    setDesign(next);
    dirtyRef.current = true;
    setSaving("dirty");
    setHistTick((t) => t + 1);
    persistHistory(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** A change that is not a history step on its own (a drag in progress). */
  const replace = (next: TextDesign) => {
    designRef.current = next;
    setDesign(next);
  };
  const undo = () => {
    const cur = designRef.current;
    const prev = pastRef.current.pop();
    if (!cur || !prev) return;
    futureRef.current.push(cur);
    designRef.current = prev;
    setDesign(prev);
    dirtyRef.current = true;
    setSaving("dirty");
    setHistTick((t) => t + 1);
    setSelected((s) => s.filter((id) => prev.layers.some((l) => l.id === id)));
  };
  const redo = () => {
    const cur = designRef.current;
    const next = futureRef.current.pop();
    if (!cur || !next) return;
    pastRef.current.push(cur);
    designRef.current = next;
    setDesign(next);
    dirtyRef.current = true;
    setSaving("dirty");
    setHistTick((t) => t + 1);
  };
  const result = (d: TextDesign): EditorResult => {
    const words = wordsOf(d);
    const ov: PostOverlayPatch = { ...(p.patch ?? {}), design: d };
    delete ov.dx;
    delete ov.dy;
    delete ov.scale;
    delete ov.position;
    delete ov.pin;
    delete ov.typo;
    delete ov.typoFor;
    return { headline: words.headline, subline: words.subline, ov };
  };
  const flushSave = useCallback(
    (keepOpen: boolean) => {
      const d = designRef.current;
      if (!d) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (!dirtyRef.current && keepOpen) return;
      // The client holds this post: the words and layers wait in the card's session as a draft.
      if (hold && batch) {
        patchSession(batch, p.index, { text: { result: result(d), basis } });
        if (!keepOpen) p.onClose();
        return;
      }
      dirtyRef.current = false;
      setSaving("saving");
      p.onSave(result(d), keepOpen);
      setSaving("saved");
      if (batch && getSession(batch, p.index)?.text) patchSession(batch, p.index, { text: null });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.onSave, p.patch, hold, batch, basis],
  );
  useEffect(() => {
    if (!open || !design || !dirtyRef.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flushSave(true), 1200);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [design, open, flushSave]);
  /* ───────────── The card's session: this studio is open; Save & return ───────────── */
  useEffect(() => {
    if (!open || !batch) return;
    patchSession(batch, p.index, { studio: "text" });
    return () => {
      patchSession(batch, p.index, (s) => ({ studio: s.studio === "text" ? null : s.studio }));
    };
  }, [open, batch, p.index]);
  /** "Save & return": the words (and whatever else the card's session holds) are saved, then the card comes back into view. */
  const saveAndReturn = async () => {
    if (editing) setEditing(null);
    if (dirtyRef.current) flushSave(true);
    if (!batch) return p.onClose();
    setReturning(true);
    try {
      const r = await commitSession(batch, p.index, { hold });
      if (!r.ok) return;
      if (!r.kept.includes("text")) dirtyRef.current = false;
      patchSession(batch, p.index, { studio: null, picture: null });
      p.onClose();
      flashCard(p.index);
    } finally {
      setReturning(false);
    }
  };
  /** Closing never drops work: the words save themselves (or wait as a draft); other studios' work is saved now or kept. */
  const close = async () => {
    if (editing) setEditing(null);
    if (dirtyRef.current) flushSave(true);
    const parts = pendingParts(getSession(batch, p.index));
    if (parts.length) {
      const ok = await askConfirm(`Not saved yet: ${pendingLabel(parts)}. Save now and go back to the card, or keep them for later? Kept edits wait on the card until you save or discard them.`, { ok: "Save & return", danger: false, cancel: "Keep for later" });
      if (ok) return saveAndReturn();
    }
    p.onClose();
  };

  /* ───────────── Layer operations ───────────── */
  const update = (ids: string[], patch: Partial<Layer> | ((l: Layer) => Partial<Layer>), typing = false) => {
    const d = designRef.current;
    if (!d) return;
    commit({ ...d, layers: d.layers.map((l) => (ids.includes(l.id) ? ({ ...l, ...(typeof patch === "function" ? patch(l) : patch) } as Layer) : l)) }, typing);
  };
  const updateSel = (patch: Partial<Layer>) => update(selected, patch);
  /** A change meant for text layers only (the font menu, the colour): other selected layers are left alone. */
  const updateText = (patch: Partial<TextLayer>) => update(selected.filter((id) => layers.find((l) => l.id === id && isTextLayer(l))), patch);
  const setCanvasFx = (fx: CanvasFx | undefined) => {
    const d = designRef.current;
    if (d) commit({ ...d, canvas: fx });
  };
  const addLayer = (over: Partial<TextLayer> = {}, text = "Your words here") => {
    const d = designRef.current;
    if (!d) return;
    const l = newTextLayer(text, {
      font: fonts[0] ?? spec.headline.font ?? "Inter",
      weight: 700,
      size: 0.06,
      x: 0.1,
      y: 0.42,
      w: 0.8,
      name: undefined,
      // A new layer reads the way the post's language does; mixed copy decides for itself.
      direction: directionFor(lang),
      ...over,
    });
    commit({ ...d, layers: [...d.layers, l] });
    setSelected([l.id]);
    return l;
  };
  /**
   * A new text from the Add menu or T: it opens for typing with its placeholder selected, so typing
   * replaces it. Its box appears once the frame is drawn; keys typed before that are held and become
   * its first letters (and a capital T is a letter then, not another new text).
   */
  const typeInto = useRef<{ id: string; held: string } | null>(null);
  const addTextAndType = () => {
    const l = addLayer();
    if (!l) return;
    typeInto.current = { id: l.id, held: "" };
    setEditing(l.id);
  };
  useEffect(() => {
    const t = typeInto.current;
    const box = textareaRef.current;
    if (!t) return;
    // Editing went elsewhere (Escape, another layer) before the box appeared: nothing is held any more.
    if (editing !== t.id) {
      typeInto.current = null;
      return;
    }
    if (!box) return;
    typeInto.current = null;
    box.focus();
    if (t.held) {
      update([t.id], (l) => (isTextLayer(l) ? editText(l, t.held) : {}), true);
      box.setSelectionRange(t.held.length, t.held.length);
    } else box.select();
  });
  /** Any new layer goes on top and becomes the selection. */
  const addAny = (l: Layer) => {
    const d = designRef.current;
    if (!d) return;
    commit({ ...d, layers: [...d.layers, l] });
    setSelected([l.id]);
    setEditing(null);
  };
  const addLogo = () => {
    if (!logoSrc) return toast.error("This client has no logo yet: add one in the Brand kit.");
    const d = designRef.current;
    if (d?.layers.some((l) => l.type === "logo")) {
      const existing = d.layers.find((l) => l.type === "logo")!;
      setSelected([existing.id]);
      return toast.message("The logo is already a layer: it is selected.");
    }
    // Where the client's layout puts it, so adding the layer changes nothing until it is moved.
    const w = spec.logo.width;
    const x = spec.logo.position === "top-left" ? spec.margin : spec.logo.position === "top-right" ? 1 - spec.margin - w : (1 - w) / 2;
    const y = (spec.logo.top * W) / H;
    addAny(newLogoLayer({ x: round3(x), y: round3(spec.logo.position === "bottom-center" ? 1 - y - (w * W * 0.5) / H : y), w }));
  };
  const addImage = (src: string, name?: string, source?: ImageLayer["source"], over: Partial<ImageLayer> = {}) => addAny(newImageLayer(src, { name, x: 0.25, y: 0.3, w: 0.5, h: round3((0.5 * W) / H), ...(source ? { source } : {}), ...over }));
  /**
   * A Freepik asset placed on the design (from the Assets tab here, or carried over from the Photo
   * studio): an image layer on top, or the background behind the photo. The layer takes the id the
   * use was recorded against. Free: the design is data drawn over the photo; nothing is generated.
   */
  const addFromAsset = (l: FreepikLayer, how: DesignHow) => {
    const d = designRef.current;
    if (!d) return;
    const made = imageLayerFromAsset({ ...l, source: "freepik" }, W, H, () => l.layerId ?? layerId());
    if (how === "background") {
      const { design: next, layer } = setBackground(d, made.src, { ...made, name: `Background · ${made.name}`.slice(0, 60) });
      commit(next);
      setSelected([layer.id]);
      setEditing(null);
      setRightTab("props");
      toast.success(photoOpaque.current ? "Background added behind the photo. This photo has no transparent areas, so the background shows around it once you make the photo smaller (Properties › Background)." : "Background added behind the photo: it shows through the photo's transparent areas.");
      return;
    }
    addAny(made);
    if (how === "pieces") {
      // "Add as separate layers": the vector is placed, then taken apart; a file that is not an SVG stays one picture and says why.
      if (l.editable) void splitLayer(made.id);
      else toast.message(`${splitRefusal(l.format)} It was added as one picture.`);
      return;
    }
    if (l.lettering) toast.success(`${LETTERING_LABEL}: placed as a picture. Use “Add editable text” for words you can type.`);
    else if (l.editable) toast.success("Added as an editable vector: change its colours under Properties › Vector colours.");
    else toast.success(l.note ?? "Added as a layer: a flattened picture.");
  };
  /** The asset hand-over from the Photo studio, taken once the design is loaded. */
  const pendingAssetsRef = useRef<PendingAsset[]>([]);
  /** True when the photo has no transparent pixel: a background then shows only around a smaller photo. */
  const photoOpaque = useRef(true);
  const addShape = (kind: ShapeKind) =>
    addAny(
      newShapeLayer(kind, {
        fill: { type: "solid", color: brand.colors[0]?.hex ?? (kind === "line" ? "#ffffff" : "#1129d3") },
        ...(kind === "line" ? { h: round3((0.004 * W) / H) } : {}),
      }),
    );
  const uploadGraphic = async (file: File) => {
    if (!p.onUploadGraphic) return toast.error("Save the month first: an uploaded graphic is kept with it.");
    try {
      const src = await p.onUploadGraphic(file);
      // An uploaded SVG is a vector like a Freepik one: its colours can change and it can be split into layers.
      let over: Partial<ImageLayer> = {};
      if (file.type === "image/svg+xml") {
        try {
          const colors = extractSvgColors(sanitizeSvg(await file.text()));
          over = { format: "SVG", fit: "contain", ...(colors.length ? { colors: colors.slice(0, 24) } : {}) };
        } catch {
          over = { format: "SVG", fit: "contain" };
        }
      }
      addImage(src, file.name.replace(/\.[^.]+$/, ""), "upload", over);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const duplicate = (ids: string[]) => {
    const d = designRef.current;
    if (!d) return;
    const r = duplicateLayers(d, ids);
    if (!r.copies.length) return;
    commit(r.design);
    setSelected(r.copies);
  };
  const remove = (ids: string[]) => {
    const d = designRef.current;
    if (!d) return;
    commit(removeLayers(d, ids));
    setSelected((s) => s.filter((id) => !ids.includes(id)));
    if (editing && ids.includes(editing)) setEditing(null);
  };
  const reorder = (fromTop: number, toTop: number) => {
    const d = designRef.current;
    if (!d) return;
    const next = reorderLayer(d, fromTop, toTop);
    if (next !== d) commit(next);
  };
  const zOrder = (how: "up" | "down" | "front" | "back") => {
    const d = designRef.current;
    if (!d || !selected.length) return;
    const next = zOrderLayers(d, selected, how);
    if (next !== d) commit(next);
  };
  /** Any picture layer as the background (full canvas, behind the photo), or back over the photo. */
  const makeBackground = (id: string, on: boolean) => {
    const d = designRef.current;
    const l = d?.layers.find((x) => x.id === id);
    if (!d || !l || l.type !== "image") return;
    if (on) {
      // The same layer (same id, file and colours) moves to the bottom, full canvas, behind the photo.
      const { design: next, layer } = setBackground(removeLayers(d, [id]), l.src, { ...l });
      commit(next);
      setSelected([layer.id]);
    } else commit(patchLayers(d, [id], { behind: undefined }));
  };
  const group = (on: boolean) => {
    if (selected.length < (on ? 2 : 1)) return;
    const id = on ? `G${layerId()}` : undefined;
    update(selected, { group: id });
  };
  /** A row of the Layers list selects that layer alone, even inside a group (a piece of a split vector). */
  const selectRow = (id: string, add: boolean) => {
    setSelected((s) => (add ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
    if (editing && editing !== id) setEditing(null);
  };

  /* ───────────── Vectors: split into layers, remove background, merge back ───────────── */
  /** Stores SVG pieces with the month (sanitised and deduplicated by the Worker); their studio URLs. */
  const storePieces = async (svgs: string[]): Promise<string[]> => {
    if (!batch) throw new Error("Save the month first: the pieces are kept with it.");
    const r = await post<{ urls: string[] }>(`/api/studio/posts/graphic/pieces?batch=${encodeURIComponent(batch)}`, { pieces: svgs });
    return r.urls;
  };
  const r5 = (n: number) => Math.round(n * 100000) / 100000;
  const vectorName = (l: ImageLayer) => (l.name ?? "Vector").replace(/^.* · /, "").slice(0, 40);
  /**
   * "Split into layers": the vector's groups and shapes become image layers of their own (small
   * SVGs kept with the month), each exactly where it was drawn, grouped, in place of the vector
   * in the stack. One step of history: ⌘Z puts the single layer back.
   */
  const splitLayer = async (id: string) => {
    const d = designRef.current;
    const l = d?.layers.find((x) => x.id === id);
    if (!d || !l || l.type !== "image") return;
    if (!isSvgLayer(l) && l.format) return void toast.error(splitRefusal(l.format));
    if (!batch) return void toast.error("Save the month first: the pieces are kept with it.");
    const budget = Math.min(30, 40 - (d.layers.length - 1));
    if (budget < 2) return void toast.error("This design already holds 40 layers, the most a design can: delete some before splitting.");
    setVectorBusy("split");
    try {
      const text = await fetchSvgText(l.src);
      if (!text) return void toast.error(splitRefusal(l.format));
      const plan = planSplit(text, l, W, H, budget);
      if (plan.pieces.length < 2) return void toast.message(plan.pieces.length ? "This vector is one element (one shape, or one group with an effect on it): there is nothing to split." : "Nothing of this vector is visible to split.");
      const urls = await storePieces(plan.pieces.map((pc) => pc.svg));
      const group = l.group ?? `G${layerId()}`;
      const base = vectorName(l);
      const made = plan.pieces.map((pc, i) =>
        newImageLayer(urls[i], {
          name: `${pc.name} · ${base}`.slice(0, 60),
          x: r5(pc.place.x),
          y: r5(pc.place.y),
          w: r5(pc.place.w),
          h: r5(pc.place.h),
          rotate: pc.place.rotate,
          fit: "contain",
          opacity: l.opacity,
          blend: l.blend,
          hidden: l.hidden,
          locked: l.locked,
          behind: l.behind,
          source: l.source,
          asset: l.asset,
          format: "SVG",
          note: pc.bg ? `The background of “${base}”: Remove background (or Delete) takes it away; the other pieces stay.` : `A piece of “${base}”: move, resize, turn, recolour or delete it on its own.`,
          ...(pc.colors.length ? { colors: pc.colors.slice(0, 24) } : {}),
          recolor: recolorFor(l.recolor, pc.colors),
          lettering: pc.lettering || l.lettering || undefined,
          group,
          piece: true,
          bgShape: pc.bg || undefined,
        }),
      );
      const cur = designRef.current!;
      const at = cur.layers.findIndex((x) => x.id === id);
      if (at < 0) return;
      commit({ ...cur, layers: [...cur.layers.slice(0, at), ...made, ...cur.layers.slice(at + 1)] });
      setSelected(made.map((m) => m.id));
      setEditing(null);
      const bg = plan.pieces.some((pc) => pc.bg);
      toast.success(
        `Split into ${made.length} layers${plan.merged ? ` (the vector has ${plan.elements} elements: neighbours were kept together to stay within the 40 layers a design holds)` : ""}. They are grouped: pick one in the Layers list to change it alone.${bg ? " Its background is a piece of its own: Remove background takes it away." : ""}`,
      );
    } catch (e) {
      toast.error((e as Error).message || "The vector could not be split.");
    } finally {
      setVectorBusy(null);
    }
  };
  /** The four corners of a layer's box on the canvas, rotation included (for the highlight). */
  const cornersOf = (b: LayerBox) => {
    const a = ((b.rotate ?? 0) * Math.PI) / 180;
    return [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, b.y + b.h],
      [b.x, b.y + b.h],
    ].map(([x, y]) => ({ x: b.cx + (x - b.cx) * Math.cos(a) - (y - b.cy) * Math.sin(a), y: b.cy + (x - b.cx) * Math.sin(a) + (y - b.cy) * Math.cos(a) }));
  };
  /**
   * "Remove background": what would go is highlighted first and removed only once confirmed. On a
   * split vector it is the piece found to be its background; on a whole vector, the elements found
   * to be its background are left out of a new copy of the SVG (the layer keeps its place). Undoable.
   */
  const removeVectorBackground = async (id: string) => {
    const d = designRef.current;
    const l = d?.layers.find((x) => x.id === id);
    if (!d || !l || l.type !== "image") return;
    if (l.piece && l.group) {
      const bgs = d.layers.filter((x) => x.group === l.group && x.type === "image" && x.bgShape);
      if (!bgs.length) return void toast.message("No piece of this vector was found to be its background. Select the piece you do not want and press Delete (⌘Z brings it back).");
      const polys = bgs.map((x) => boxesRef.current.find((b) => b.id === x.id)).filter((b): b is LayerBox => !!b).map(cornersOf);
      setSelected(bgs.map((x) => x.id));
      setBgPreview({
        polys,
        note: `Highlighted: the vector's background (${bgs.length === 1 ? "one piece" : `${bgs.length} pieces`}). Remove it and keep the other elements?`,
        confirm: async () => {
          remove(bgs.map((x) => x.id));
          toast.success("Background removed: the other pieces stay where they were. ⌘Z brings it back.");
        },
      });
      return;
    }
    if (!isSvgLayer(l)) return void toast.error(splitRefusal(l.format));
    if (!batch) return void toast.error("Save the month first: the new copy of the vector is kept with it.");
    setVectorBusy("bg");
    try {
      const text = await fetchSvgText(l.src);
      if (!text) return void toast.error(splitRefusal(l.format));
      const plan = planSplit(text, l, W, H, 40);
      if (!plan.background.length) return void toast.message("No background found: no filled shape covers most of this vector. Split it into layers and delete the piece you do not want.");
      const cover = Math.round(Math.max(...plan.background.map((b) => b.cover)) * 100);
      setSelected([id]);
      setBgPreview({
        polys: plan.background.map((b) => b.polygon),
        note: `Highlighted: the vector's background (${plan.background.length === 1 ? "a filled shape" : `${plan.background.length} filled shapes`} covering ${cover}% of it). Remove it and keep the other elements?`,
        confirm: async () => {
          const { svg, colors } = stripBackground(plan);
          const [url] = await storePieces([svg]);
          const cur = designRef.current!;
          if (!cur.layers.some((x) => x.id === id)) return;
          commit(patchLayers(cur, [id], { src: url, format: "SVG", colors: colors.length ? colors.slice(0, 24) : undefined, recolor: recolorFor(l.recolor, colors) } as Partial<Layer>));
          toast.success("Background removed: the elements stay where they were. ⌘Z brings it back.");
        },
      });
    } catch (e) {
      toast.error((e as Error).message || "The vector could not be read.");
    } finally {
      setVectorBusy(null);
    }
  };
  const confirmBackground = async () => {
    const pv = bgPreview;
    if (!pv) return;
    setVectorBusy("bg");
    try {
      await pv.confirm();
      setBgPreview(null);
    } catch (e) {
      toast.error((e as Error).message || "The background could not be removed.");
    } finally {
      setVectorBusy(null);
    }
  };
  /**
   * "Merge back": the pieces of a split vector as one layer again, with every change made to them
   * (moves, turns, colours, fades; deleted pieces stay deleted, hidden ones are left out). The
   * pieces are composed into one SVG (each at its place), stored like a piece, and replace the group.
   */
  const mergeBack = async (id: string) => {
    const d = designRef.current;
    const l = d?.layers.find((x) => x.id === id);
    if (!d || !l || !l.group) return;
    const members = d.layers.filter((x) => x.group === l.group);
    if (!members.every((x) => isSvgLayer(x))) return void toast.error("Only the pieces of a vector can be merged back: this group also holds text, a logo, a shape or a picture. Ungroup it first (⇧⌘G).");
    const parts = members as ImageLayer[];
    const shown = parts.filter((x) => !x.hidden);
    if (!shown.length) return void toast.message("Every piece is hidden: show the ones to keep, then merge.");
    if (!batch) return void toast.error("Save the month first: the merged vector is kept with it.");
    setVectorBusy("merge");
    try {
      const texts = await Promise.all(shown.map((x) => fetchSvgText(x.src)));
      if (texts.some((t) => !t)) return void toast.error("A piece of this vector could not be read, so nothing was merged.");
      const pieces: MergePiece[] = shown.map((x, i) => ({ svg: recolorSvg(texts[i]!, x.recolor), box: { x: x.x * W, y: x.y * H, w: x.w * W, h: x.h * H }, rotate: x.rotate, opacity: x.opacity, fit: x.fit }));
      const { svg, box } = mergePieces(pieces);
      const [url] = await storePieces([svg]);
      const colors = extractSvgColors(svg);
      const first = parts[0];
      const blends = new Set(shown.map((x) => x.blend ?? "normal"));
      const merged = newImageLayer(url, {
        name: vectorName(first),
        x: r5(box.x / W),
        y: r5(box.y / H),
        w: r5(Math.max(0.01, box.w / W)),
        h: r5(Math.max(0.01, box.h / H)),
        fit: "contain",
        blend: blends.size === 1 ? first.blend : undefined,
        behind: first.behind,
        source: first.source,
        asset: first.asset,
        format: "SVG",
        note: "The vector merged back into one layer, with the changes made to its pieces.",
        ...(colors.length ? { colors: colors.slice(0, 24) } : {}),
        lettering: parts.some((x) => x.lettering) || undefined,
      });
      const cur = designRef.current!;
      const ids = new Set(members.map((x) => x.id));
      const at = cur.layers.findIndex((x) => ids.has(x.id));
      if (at < 0) return;
      const rest = cur.layers.filter((x) => !ids.has(x.id));
      commit({ ...cur, layers: [...rest.slice(0, at), merged, ...rest.slice(at)] });
      setSelected([merged.id]);
      const left = parts.length - shown.length;
      toast.success(`Merged back into one layer${left ? ` (${left} hidden piece${left === 1 ? " was" : "s were"} left out)` : ""}${blends.size > 1 ? "; the pieces' different blend modes became normal" : ""}. ⌘Z gives the pieces back.`);
    } catch (e) {
      toast.error((e as Error).message || "The pieces could not be merged.");
    } finally {
      setVectorBusy(null);
    }
  };
  const selectGroupOf = (id: string) => {
    const d = designRef.current;
    const l = d?.layers.find((x) => x.id === id);
    if (!d || !l?.group) return;
    setSelected(d.layers.filter((x) => x.group === l.group).map((x) => x.id));
  };
  /** The vector actions for the selected layer (Layers panel and Properties). */
  const vectorActions = (compact: boolean) => {
    if (!primary || primary.type !== "image") return null;
    const groupSize = primary.group ? layers.filter((x) => x.group === primary.group).length : 1;
    return (
      <VectorActions
        layer={primary}
        groupSize={groupSize}
        busy={vectorBusy}
        compact={compact}
        onSplit={() => void splitLayer(primary.id)}
        onRemoveBackground={() => void removeVectorBackground(primary.id)}
        onMerge={() => void mergeBack(primary.id)}
        onSelectGroup={() => selectGroupOf(primary.id)}
      />
    );
  };

  const align = (how: Align) => {
    const d = designRef.current;
    if (!d) return;
    const bs = boxesRef.current.filter((b) => selected.includes(b.id));
    if (bs.length < 2) return;
    const minX = Math.min(...bs.map((b) => b.x));
    const maxX = Math.max(...bs.map((b) => b.x + b.w));
    const minY = Math.min(...bs.map((b) => b.y));
    const maxY = Math.max(...bs.map((b) => b.y + b.h));
    const moves = new Map<string, { x?: number; y?: number }>();
    if (how === "hdist" || how === "vdist") {
      const sorted = [...bs].sort((a, b) => (how === "hdist" ? a.cx - b.cx : a.cy - b.cy));
      const span = how === "hdist" ? maxX - minX - sorted.reduce((s, b) => s + b.w, 0) : maxY - minY - sorted.reduce((s, b) => s + b.h, 0);
      const gap = span / (sorted.length - 1);
      let cursor = how === "hdist" ? minX : minY;
      for (const b of sorted) {
        moves.set(b.id, how === "hdist" ? { x: cursor / W } : { y: cursor / H });
        cursor += (how === "hdist" ? b.w : b.h) + gap;
      }
    } else
      for (const b of bs)
        moves.set(
          b.id,
          how === "left" ? { x: minX / W } : how === "right" ? { x: (maxX - b.w) / W } : how === "hcenter" ? { x: ((minX + maxX) / 2 - b.w / 2) / W } : how === "top" ? { y: minY / H } : how === "bottom" ? { y: (maxY - b.h) / H } : { y: ((minY + maxY) / 2 - b.h / 2) / H },
        );
    commit({ ...d, layers: d.layers.map((l) => (moves.has(l.id) ? { ...l, ...moves.get(l.id) } : l)) });
  };

  /* ───────────── Rich text ───────────── */
  const editingRange = (): { id: string; start: number; end: number } | null => {
    if (!editing) return null;
    const ta = textareaRef.current;
    if (!ta) return null;
    return { id: editing, start: ta.selectionStart, end: ta.selectionEnd };
  };
  const rich = (what: "bold" | "italic" | "underline" | "strike" | "super" | "sub" | "highlight", value?: string) => {
    const d = designRef.current;
    if (!d) return;
    const r = editingRange();
    const targets = r && r.end > r.start ? [r.id] : selected;
    commit({
      ...d,
      layers: d.layers.map((l) => {
        if (!targets.includes(l.id) || !isTextLayer(l)) return l;
        const from = r && r.end > r.start ? r.start : 0;
        const to = r && r.end > r.start ? r.end : l.text.length;
        const whole = from === 0 && to === l.text.length;
        const at = styleAt(l.runs, from);
        if (whole && what === "bold" && !l.runs?.some((x) => x.style.bold)) return { ...l, weight: l.weight >= 700 ? 400 : 700 };
        if (whole && what === "italic" && !l.runs?.some((x) => x.style.italic)) return { ...l, italic: !l.italic || undefined };
        const style: RunStyle =
          what === "highlight"
            ? { highlight: at.highlight === value ? undefined : value }
            : what === "super" || what === "sub"
              ? { script: at.script === what ? undefined : what }
              : { [what]: at[what] ? undefined : true };
        return { ...l, runs: setRunStyle(l.runs, from, to, style) };
      }),
    });
    textareaRef.current?.focus();
  };
  const richActive = useMemo(() => {
    const l = primaryText;
    if (!l) return { bold: false, italic: false, underline: false, strike: false, script: null };
    const at = editing === l.id ? styleAt(l.runs, Math.max(0, caret.start)) : styleAt(l.runs, 0);
    return { bold: !!at.bold || (editing !== l.id && l.weight >= 700), italic: !!at.italic || !!l.italic, underline: !!at.underline, strike: !!at.strike, script: at.script ?? null };
  }, [primaryText, editing, caret]);

  /* ───────────── Pointer ───────────── */
  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const d = designRef.current;
    if (!d) return;
    const pt = toCanvas(e);
    if (pickRef.current) {
      const base = baseRef.current;
      const px = base?.getContext("2d", { willReadFrequently: true })?.getImageData(Math.floor(pt.x), Math.floor(pt.y), 1, 1).data;
      pickRef.current(px ? `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}` : null);
      pickRef.current = null;
      setPicking(false);
      return;
    }
    const target = e.target as HTMLElement;
    const handle = target.dataset.handle as Handle | undefined;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (handle && primary) {
      const box = boxesRef.current.find((b) => b.id === primary.id);
      if (!box) return;
      dragRef.current = handle === "rot" ? { kind: "rotate", id: primary.id, origin: primary, box } : { kind: "resize", handle, id: primary.id, origin: primary, box };
      e.preventDefault();
      return;
    }
    if (target.closest("textarea")) return;
    const hit = hitLayer(boxesRef.current, d.layers, pt.x, pt.y, 4, selected);
    if (hit) {
      const l = d.layers.find((x) => x.id === hit.id)!;
      const add = e.shiftKey || e.metaKey || e.ctrlKey;
      let ids = selected;
      if (!selected.includes(hit.id) || add) {
        const members = l.group ? d.layers.filter((x) => x.group === l.group).map((x) => x.id) : [hit.id];
        ids = add ? (selected.includes(hit.id) ? selected.filter((x) => !members.includes(x)) : [...selected, ...members]) : members;
        setSelected(ids);
      }
      if (editing && editing !== hit.id) setEditing(null);
      if (editing === hit.id) return;
      const movable = ids.filter((id) => !d.layers.find((x) => x.id === id)?.locked);
      dragRef.current = { kind: "move", start: pt, origin: d.layers, ids: movable, moved: false };
      e.preventDefault();
      return;
    }
    if (editing) setEditing(null);
    dragRef.current = { kind: "marquee", start: pt, add: e.shiftKey, now: pt };
    if (!e.shiftKey) setSelected([]);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const d = designRef.current;
    if (!drag || !d) return;
    const pt = toCanvas(e);
    if (drag.kind === "move") {
      let dx = pt.x - drag.start.x;
      let dy = pt.y - drag.start.y;
      let gs: Guide[] = [];
      if (!e.altKey) {
        const moving = boxesRef.current.filter((b) => drag.ids.includes(b.id));
        const others = boxesRef.current.filter((b) => !drag.ids.includes(b.id));
        const origin = moving.map((b) => ({ ...b, ...boxAt(drag.origin.find((l) => l.id === b.id)!, b) }));
        const s = snapMove(origin, others, dx, dy, W, H, spec.margin * W, 6 / scale);
        dx = s.dx;
        dy = s.dy;
        gs = s.guides;
      }
      if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
      setGuides(gs);
      replace({ ...d, layers: drag.origin.map((l) => (drag.ids.includes(l.id) ? { ...l, x: round3(l.x + dx / W), y: round3(l.y + dy / H) } : l)) });
      return;
    }
    if (drag.kind === "rotate") {
      const b = drag.box;
      let deg = (Math.atan2(pt.y - b.cy, pt.x - b.cx) * 180) / Math.PI + 90;
      if (!e.shiftKey) {
        const snapped = Math.round(deg / 15) * 15;
        if (Math.abs(snapped - deg) < 4) deg = snapped;
      }
      deg = Math.round(((deg + 540) % 360) - 180);
      replace({ ...d, layers: d.layers.map((l) => (l.id === drag.id ? { ...l, rotate: deg || undefined } : l)) });
      return;
    }
    if (drag.kind === "resize") {
      const b = drag.box;
      const o = drag.origin;
      const lp = toLocal(b, pt.x, pt.y);
      const h = drag.handle;
      let left = b.x;
      let right = b.x + b.w;
      let top = b.y;
      let bottom = b.y + b.h;
      const corner = h.length === 2;
      if (corner) {
        // Corners scale the layer: the opposite corner stays. Type follows the width; a picture or
        // a shape keeps its proportions; a logo's height follows its file anyway.
        const fixedX = h.includes("w") ? right : left;
        const fixedY = h.includes("n") ? bottom : top;
        const newW = Math.max(W * 0.03, Math.abs(lp.x - fixedX));
        const f = newW / b.w;
        if (h.includes("w")) left = fixedX - newW;
        else right = fixedX + newW;
        const newH = b.h * f;
        if (h.includes("n")) top = fixedY - newH;
        else bottom = fixedY + newH;
        const c = world(b, (left + right) / 2, (top + bottom) / 2);
        const x = round3((c.x - (right - left) / 2) / W);
        const y = round3((c.y - (bottom - top) / 2) / H);
        const w = round3((right - left) / W);
        const hh = round3((bottom - top) / H);
        replace({
          ...d,
          layers: d.layers.map((l): Layer => {
            if (l.id !== drag.id) return l;
            if (isTextLayer(l) && isTextLayer(o)) return { ...l, size: round3(o.size * f * 1000) / 1000, w, h: o.autoSize === false && o.h ? hh : o.h, x, y };
            if (l.type === "logo") return { ...l, w, x, y };
            return { ...l, w, h: hh, x, y };
          }),
        });
        return;
      }
      if (h === "e") right = Math.max(left + W * 0.03, lp.x);
      if (h === "w") left = Math.min(right - W * 0.03, lp.x);
      if (h === "s") bottom = Math.max(top + H * 0.02, lp.y);
      if (h === "n") top = Math.min(bottom - H * 0.02, lp.y);
      const c = world(b, (left + right) / 2, (top + bottom) / 2);
      const vertical = h === "n" || h === "s";
      replace({
        ...d,
        layers: d.layers.map((l): Layer => {
          if (l.id !== drag.id) return l;
          const x = round3((c.x - (right - left) / 2) / W);
          const y = round3((c.y - (vertical ? bottom - top : b.h) / 2) / H);
          const w = round3((right - left) / W);
          if (isTextLayer(l)) return { ...l, w, ...(vertical ? { h: round3((bottom - top) / H), autoSize: false } : {}), x, y };
          if (l.type === "logo") return vertical ? l : { ...l, w, x, y };
          return { ...l, w, ...(vertical ? { h: round3((bottom - top) / H) } : {}), x, y };
        }),
      });
      return;
    }
    if (drag.kind === "marquee") {
      drag.now = pt;
      setMarquee({ x: Math.min(drag.start.x, pt.x), y: Math.min(drag.start.y, pt.y), w: Math.abs(pt.x - drag.start.x), h: Math.abs(pt.y - drag.start.y) });
    }
  };
  const onUp = () => {
    const drag = dragRef.current;
    const d = designRef.current;
    dragRef.current = null;
    setGuides([]);
    if (!drag || !d) return;
    if (drag.kind === "marquee") {
      const m = marquee;
      setMarquee(null);
      if (m && (m.w > 4 || m.h > 4)) {
        const ids = boxesRef.current.filter((b) => b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y && !d.layers.find((l) => l.id === b.id)?.hidden).map((b) => b.id);
        setSelected((s) => (drag.add ? [...new Set([...s, ...ids])] : ids));
      }
      return;
    }
    // The drag becomes one history step: the state before it goes to the past.
    const before = drag.kind === "move" ? { ...d, layers: drag.origin } : { ...d, layers: d.layers.map((l) => (l.id === drag.id ? drag.origin : l)) };
    if (JSON.stringify(before) === JSON.stringify(d)) return;
    pastRef.current = [...pastRef.current.slice(-MAX_HISTORY + 1), before];
    futureRef.current = [];
    dirtyRef.current = true;
    setSaving("dirty");
    setHistTick((t) => t + 1);
    persistHistory(d);
    setDesign({ ...d });
  };
  const onDouble = (e: React.MouseEvent<HTMLDivElement>) => {
    const d = designRef.current;
    if (!d) return;
    const pt = toCanvas(e);
    const hit = hitLayer(boxesRef.current, d.layers, pt.x, pt.y, 4, selected);
    const l = hit ? d.layers.find((x) => x.id === hit.id) : undefined;
    if (hit && l && isTextLayer(l) && !l.locked) {
      setSelected([hit.id]);
      setEditing(hit.id);
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else if (hit && l?.group) {
      // Into the group: one piece of a split vector (or one member of any group) alone.
      setSelected([hit.id]);
    }
  };
  const boxAt = (l: Layer, b: LayerBox) => ({ x: l.x * W, y: l.y * H, cx: l.x * W + b.w / 2, cy: l.y * H + b.h / 2 });
  const world = (b: LayerBox, lx: number, ly: number) => {
    if (!b.rotate) return { x: lx, y: ly };
    const a = (b.rotate * Math.PI) / 180;
    const dx = lx - b.cx;
    const dy = ly - b.cy;
    return { x: b.cx + dx * Math.cos(a) - dy * Math.sin(a), y: b.cy + dx * Math.sin(a) + dy * Math.cos(a) };
  };

  /* ───────────── Keyboard ───────────── */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = isEditable(e.target);
      const inOurBox = e.target === textareaRef.current;
      // A new text whose box is not drawn yet: the letters typed meanwhile are its first words.
      if (typeInto.current && !inOurBox && !mod && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        typeInto.current.held += e.key;
        return;
      }
      if (e.key === "Escape") {
        if (bgPreview) {
          setBgPreview(null);
          return;
        }
        if (picking) {
          pickRef.current?.(null);
          pickRef.current = null;
          setPicking(false);
        } else if (trial) setTrial(null);
        else if (editing) setEditing(null);
        else if (shortcuts) setShortcuts(false);
        else if (selected.length) setSelected([]);
        else void close();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        if (inField && !inOurBox) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y")) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && ["b", "i", "u"].includes(e.key.toLowerCase()) && (inOurBox || !inField)) {
        e.preventDefault();
        rich(e.key.toLowerCase() === "b" ? "bold" : e.key.toLowerCase() === "i" ? "italic" : "underline");
        return;
      }
      if (inField) return;
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setZoom((z) => Math.min(6, z * 1.2));
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(0.2, z / 1.2));
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        setZoom(1);
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(layers.filter((l) => !l.hidden).map((l) => l.id));
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        group(!e.shiftKey);
        return;
      }
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        update(selected, (l) => ({ locked: !l.locked || undefined }));
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        update(selected, (l) => ({ hidden: !l.hidden || undefined }));
        return;
      }
      if (mod && (e.key === "]" || e.key === "[")) {
        e.preventDefault();
        zOrder(e.key === "]" ? (e.shiftKey ? "front" : "up") : e.shiftKey ? "back" : "down");
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        clipRef.current = selLayers;
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        clipRef.current = selLayers;
        remove(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        if (clipRef.current.length) {
          e.preventDefault();
          const d = designRef.current!;
          const copies = clipRef.current.map((l): Layer => ({ ...l, id: layerId(), x: l.x + 0.03, y: l.y + 0.03, ...(isTextLayer(l) ? { role: undefined } : {}) }) as Layer);
          commit({ ...d, layers: [...d.layers, ...copies] });
          setSelected(copies.map((c) => c.id));
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flushSave(true);
        toast.success("Saved.");
        return;
      }
      if (mod) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.length) {
          e.preventDefault();
          remove(selected.filter((id) => !layers.find((l) => l.id === id)?.locked));
        }
        return;
      }
      if (e.key === "Enter" && primaryText && !primaryText.locked) {
        e.preventDefault();
        setEditing(primaryText.id);
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }
      if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        addTextAndType();
        return;
      }
      if (e.key === "?") {
        setShortcuts((s) => !s);
        return;
      }
      if (e.key.startsWith("Arrow") && selected.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        update(
          selected.filter((id) => !layers.find((l) => l.id === id)?.locked),
          (l) => ({ x: round3(l.x + dx / W), y: round3(l.y + dy / H) }),
          true,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Plain text pasted from elsewhere becomes a new layer.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || clipRef.current.length) return;
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text) {
        e.preventDefault();
        addLayer({}, text.slice(0, 500));
      }
    };
    const onReplace = (e: Event) => {
      const { find, replace: rep } = (e as CustomEvent<{ find: string; replace: string }>).detail;
      const d = designRef.current;
      if (!d) return;
      const r = replaceInLayers(d.layers, find, rep);
      if (!r.count) return toast.message("Nothing to replace.");
      commit({ ...d, layers: r.layers });
      toast.success(`${r.count} replaced.`);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("ts-replace", onReplace);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("ts-replace", onReplace);
    };
  });

  /* ───────────── Export ───────────── */
  const compose = async (width: number): Promise<HTMLCanvasElement> => {
    const d = designRef.current!;
    return renderOverlay(src, spec, { headline: "", subline: "" }, logoSrc, width, { patch: patchWith(p.patch, d) });
  };
  const exportAs = async (kind: "png" | "png2x" | "jpg" | "text" | "pdf") => {
    try {
      const d = designRef.current!;
      const nat = imgRef.current?.naturalWidth || 1080;
      if (kind === "text") {
        const c = await renderDesignOnly(d, nat, Math.round((nat * H) / W), { logoSrc });
        c.toBlob((b) => b && saveBlob(b, `${p.fileName}_text.png`), "image/png");
        return;
      }
      const width = kind === "png2x" ? nat * 2 : nat;
      const c = await compose(width);
      if (kind === "pdf") {
        const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode."))), "image/jpeg", 0.92));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        saveBlob(stackedImagesPdf([{ jpeg: bytes, width: c.width, height: c.height }], 0.5), `${p.fileName}.pdf`);
        return;
      }
      c.toBlob((b) => b && saveBlob(b, `${p.fileName}.${kind === "jpg" ? "jpg" : "png"}`), kind === "jpg" ? "image/jpeg" : "image/png", 0.92);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const composeJpeg = async (): Promise<string | null> => {
    try {
      const c = await compose(720);
      return c.toDataURL("image/jpeg", 0.8);
    } catch {
      return null;
    }
  };
  // Export preview: the final artwork composed at the output size (the picture cropped and shifted,
  // the helpers, every layer), drawn in the browser exactly as the export and the share link draw it.
  useEffect(() => {
    if (!open || !previewOn || !design) return;
    let alive = true;
    const t = window.setTimeout(() => {
      const nat = imgRef.current?.naturalWidth || 1080;
      compose(nat)
        .then((c) => alive && setPreview(c.toDataURL("image/jpeg", 0.92)))
        .catch((e) => alive && toast.error((e as Error).message));
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, previewOn, design, spec, logoSrc]);
  const downloadPreview = async () => {
    try {
      const nat = imgRef.current?.naturalWidth || 1080;
      const c = await compose(nat);
      c.toBlob((b) => b && saveBlob(b, `${p.fileName}_preview.png`), "image/png");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /* ───────────── One look for the month ───────────── */
  const applyTarget = primary ? styleToApply(primary) : null;
  const applyToAll = async () => {
    if (!applyTarget || !p.onApplyToAll || applying) return;
    const what = applyTarget.role === "logo" ? "the logo's place and size" : `the ${applyTarget.role === "headline" ? "headline" : "second line"} style`;
    const ok = await askConfirm(`Apply ${what} to the month's other posts? Their words stay; only the look changes.`, { ok: "Apply to all", danger: false });
    if (!ok) return;
    setApplying(true);
    try {
      // This post is saved first, so the month's one save holds every post as it is now.
      flushSave(true);
      const n = await p.onApplyToAll(applyTarget.style, applyTarget.role);
      toast.success(n ? `Applied to ${n} other post${n === 1 ? "" : "s"}.` : "No other post to apply it to.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  /* ───────────── Layouts: preview on the stage, apply here, apply to the month on request ───────────── */
  const layouts = useMemo(() => layoutsFor(lang), [lang]);
  /** This post's words as the layouts draw them: the design's own lines, else the plan's. */
  const wordsNow = (d: TextDesign | null): { headline?: string; subline?: string } => {
    const w = d ? wordsOf(d) : { headline: "", subline: "" };
    return { headline: w.headline || p.headline, subline: w.subline || p.subline };
  };
  const designForLayout = (preset: LayoutPreset, base: TextDesign | null, words: { headline?: string; subline?: string }, language: ClientLanguage = lang): TextDesign =>
    applyLayout(base, preset.make({ brand, language, sample: sampleContent(language, words), hasLogo: !!logoSrc, ratio: H / W }));
  const layoutThumb = async (preset: LayoutPreset): Promise<string | null> => {
    const d = designRef.current;
    if (!d) return null;
    const c = await renderOverlay(src, spec, { headline: "", subline: "" }, logoSrc, 320, { patch: patchWith(p.patch, designForLayout(preset, d, wordsNow(d))) });
    return c.toDataURL("image/jpeg", 0.8);
  };
  const layoutKey = useMemo(() => {
    const w = wordsNow(design);
    return `${src}|${lang}|${w.headline ?? ""}|${w.subline ?? ""}|${logoSrc ?? ""}|${design?.layers.filter((l) => l.type === "image").length ?? 0}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, lang, logoSrc, design ? wordsOf(design).headline : "", design ? wordsOf(design).subline : "", design?.layers.filter((l) => l.type === "image").length]);
  const previewLayout = (preset: LayoutPreset) => {
    const d = designRef.current;
    if (!d) return;
    if (trial?.id === preset.id) return setTrial(null);
    setEditing(null);
    setTrial({ id: preset.id, name: preset.name, design: designForLayout(preset, d, wordsNow(d)) });
  };
  const applyLayoutHere = (preset: LayoutPreset) => {
    const d = designRef.current;
    if (!d) return;
    const next = trial?.id === preset.id ? trial.design : designForLayout(preset, d, wordsNow(d));
    setTrial(null);
    commit(next);
    const head = next.layers.find((l) => isTextLayer(l) && l.role === "headline");
    setSelected(head ? [head.id] : []);
    toast.success(`"${preset.name}" applied to this design. ⌘Z brings yours back.`);
  };
  const applyLayoutEverywhere = async (preset: LayoutPreset) => {
    if (!p.onApplyLayoutToAll || applying) return;
    const make = (post: { headline?: string; subline?: string; design?: TextDesign | null; language?: ClientLanguage }) => designForLayout(preset, post.design ?? null, { headline: post.headline, subline: post.subline }, post.language ?? lang);
    setApplying(true);
    try {
      const n = await p.onApplyLayoutToAll(make, preset.name, true);
      if (!n) {
        toast.message("No other design with a picture to apply it to.");
        return;
      }
      const ok = await askConfirm(
        `Apply "${preset.name}" to the other ${n} design${n === 1 ? "" : "s"} of the month? Each is built from its own post's words and language; pictures added to a design stay. Their current layouts are replaced, and this cannot be undone from here (each post keeps "Back to the automatic layout"). This design is not changed by this.`,
        { ok: `Apply to ${n} design${n === 1 ? "" : "s"}`, danger: false, cancel: "Not now" },
      );
      if (!ok) return;
      flushSave(true);
      const changed = await p.onApplyLayoutToAll(make, preset.name, false);
      toast.success(`"${preset.name}" applied to ${changed} other design${changed === 1 ? "" : "s"}. No picture was touched.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  /* ───────────── Misc ───────────── */
  const pickFromCanvas = () =>
    new Promise<string | null>((resolve) => {
      pickRef.current = resolve;
      setPicking(true);
      toast.message("Click a point on the picture to pick its colour.");
    });
  const saveColour = (hex: string) => {
    savedColours.add(brand.id, hex);
    setSaved(savedColours.list(brand.id));
  };
  const uploadFont = async (file: File) => {
    const name = await askInput("Font family name", file.name.replace(/\.[^.]+$/, "").replace(/[-_]?(regular|bold|semibold|medium)$/i, ""), { ok: "Add font" });
    if (!name?.trim()) return;
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim());
      const r = await postForm<{ clients: Client[] }>(`/api/studio/clients/${brand.id}/fonts`, form);
      p.onClientsChanged?.(r.clients);
      const mine = r.clients.find((c) => c.id === brand.id);
      const f = mine?.fontFiles.find((x) => x.name === name.trim());
      if (f) await loadFont(f.name, `/api/studio/clients/${brand.id}/fonts/${f.id}/file`);
      if (selected.length) updateText({ font: name.trim() });
      toast.success(`Font "${name.trim()}" added to ${brand.name}.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const resetToAuto = () => {
    const ov: PostOverlayPatch = { ...(p.patch ?? {}) };
    delete ov.design;
    dirtyRef.current = false;
    const r = { headline: p.headline, subline: p.subline, ov: Object.keys(ov).length ? ov : undefined };
    // The client holds this post: the automatic layout waits as a draft too.
    if (hold && batch) {
      patchSession(batch, p.index, { text: { result: r, basis } });
      p.onClose();
      return;
    }
    p.onSave(r, false);
  };
  const warnings = useMemo(() => {
    const s = new Set<string>();
    for (const l of layers) {
      if (!isTextLayer(l)) continue;
      const c = contrastOf(baseRef.current, l, boxes.find((b) => b.id === l.id));
      if (c !== null && c < 3) s.add(l.id);
    }
    return s;
  }, [layers, boxes]);
  const contrast = primaryText ? contrastOf(baseRef.current, primaryText, boxes.find((b) => b.id === primaryText.id)) : null;
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void histTick;
  const editingFound = editing ? layers.find((l) => l.id === editing) : null;
  const editingLayer = editingFound && isTextLayer(editingFound) ? editingFound : null;
  const editingBox = editing ? boxes.find((b) => b.id === editing) : null;

  if (!open) return null;

  /* ───────────── The two panels' tabs and bodies (one panel holds all of them on a narrow screen) ───────────── */
  const pickLeft = (t: typeof leftTab) => {
    setLeftTab(t);
    setSide("left");
  };
  const pickRight = (t: typeof rightTab) => {
    setRightTab(t);
    setSide("right");
  };
  const leftOn = (t: typeof leftTab) => (leftTab === t && (!narrow || side === "left") ? "on" : "");
  const rightOn = (t: typeof rightTab) => (rightTab === t && (!narrow || side === "right") ? "on" : "");
  const leftTabs = (
    <>
      <button type="button" className={leftOn("layers")} onClick={() => pickLeft("layers")}><Layers size={13} /> Layers</button>
      <button type="button" className={leftOn("layouts")} onClick={() => pickLeft("layouts")} title="Whole arrangements of the words, built for this post"><LayoutTemplate size={13} /> Layouts</button>
      <button type="button" className={leftOn("presets")} onClick={() => pickLeft("presets")} title="The look of one layer: outline, neon, gradient…"><Wand2 size={13} /> Styles</button>
      <button type="button" className={leftOn("brand")} onClick={() => pickLeft("brand")}><Palette size={13} /> Brand</button>
    </>
  );
  const rightTabs = (
    <>
      <button type="button" className={rightOn("props")} onClick={() => pickRight("props")}>Properties</button>
      <button type="button" className={rightOn("assist")} onClick={() => pickRight("assist")}><Sparkles size={13} /> Assistant</button>
      <button type="button" className={rightOn("assets")} onClick={() => pickRight("assets")} title="Freepik icons, photos, backgrounds and lettering as layers"><Images size={13} /> Assets</button>
    </>
  );
  const leftBody = (
    <>
      {leftTab === "layers" && design && (
        <LayersList
          layers={layers}
          selected={selected}
          warnings={warnings}
          onSelect={selectRow}
          onChange={(id, patch) => update([id], patch)}
          vectorBar={vectorActions(true)}
          onReorder={reorder}
          onDuplicate={(id) => duplicate([id])}
          onDelete={(id) => remove([id])}
          onAdd={addTextAndType}
          onAddLogo={logoSrc ? addLogo : undefined}
          onAddImage={addImage}
          onAddShape={addShape}
          onUploadGraphic={p.onUploadGraphic ? uploadGraphic : undefined}
          onAddFreepik={p.batchId ? () => pickRight("assets") : undefined}
          assets={p.assets ?? []}
        />
      )}
      {leftTab === "layouts" && design && (
        <LayoutsList layouts={layouts} language={lang} languageSource={langSource} thumb={layoutThumb} cacheKey={layoutKey} trialId={trial?.id ?? null} onPreview={previewLayout} onApply={applyLayoutHere} onApplyAll={p.onApplyLayoutToAll ? (l) => void applyLayoutEverywhere(l) : undefined} />
      )}
      {leftTab === "presets" && <PresetsList brand={brand} selected={primaryText} onApply={(style) => updateText(style)} onAddWith={(style, name) => addLayer({ ...style, name }, name === "Price tag" ? sampleContent(lang).price : name === "Quote" ? "“Made with love”" : "Your words here")} />}
      {leftTab === "brand" && (
        <BrandAssets
          brand={brand}
          palette={palette}
          onFont={(font) => (primaryText ? updateText({ font }) : addLayer({ font }))}
          onColour={(hex) => (primaryText ? updateText({ fill: { type: "solid", color: hex } }) : primary?.type === "shape" ? updateSel({ fill: { type: "solid", color: hex } }) : addLayer({ fill: { type: "solid", color: hex } }))}
          onUploadFont={uploadFont}
        />
      )}
    </>
  );
  const rightBody = (
    <>
      {rightTab === "props" && design && (
        <Properties
          sel={{ layer: primary, count: selLayers.length, contrast }}
          onChange={(patch) => ("text" in patch && patch.text !== undefined && primaryText ? update(selected, (l) => (isTextLayer(l) ? editText(l, patch.text!) : {}), true) : updateSel(patch))}
          onRich={rich}
          brand={brand}
          palette={palette}
          saved={saved}
          onSaveColour={saveColour}
          pickFromCanvas={pickFromCanvas}
          canvasFx={design.canvas}
          onCanvasFx={setCanvasFx}
          onAlign={align}
          onUploadFont={uploadFont}
          W={W}
          richActive={richActive}
          onAddText={() => addLayer()}
          onBackground={makeBackground}
          photoOpaque={photoOpaque.current}
          vector={vectorActions(false)}
        />
      )}
      {rightTab === "assets" && (
        <div className="ts-assets">
          {p.batchId ? (
            <FreepikPanel fill clientId={brand.id} batchId={p.batchId} post={p.index} mode="all" onDesign={addFromAsset} onAddText={() => addLayer()} layerHint="An image layer on top of the design: move, resize, turn and stack it; free, no picture is made." />
          ) : (
            <p className="ts-hint">Freepik assets are available on a saved month of a client.</p>
          )}
        </div>
      )}
      {rightTab === "assist" && (
        <Assistant
          batch={p.batchId ?? null}
          index={p.index}
          text={primaryText?.text ?? ""}
          allText={layers.filter(isTextLayer).filter((l) => !l.hidden).map((l) => l.text).join("\n")}
          compose={composeJpeg}
          language={lang}
          onApply={(text) => {
            if (primaryText) update([primaryText.id], (l) => (isTextLayer(l) ? editText(l, text) : {}));
            else addLayer({}, text);
          }}
          onAddLayer={(text) => addLayer({ y: (primaryText?.y ?? 0.4) + 0.12 }, text)}
        />
      )}
    </>
  );

  const sheet = (
    <div className={`ts ${picking ? "picking" : ""}`} role="dialog" aria-label="Text studio">
      {/* Top toolbar */}
      <header className="ts-top">
        <div className="ts-top-left">
          <button type="button" className="ts-icon" onClick={() => void close()} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
          <span className="ts-title">
            Text studio <small>· post {p.index}</small>
          </span>
          <span className={`ts-save ${saving}`}>{hold && saving !== "saved" ? "Draft: not on the client's link yet" : saving === "saved" ? "Saved" : saving === "saving" ? "Saving…" : "Unsaved changes"}</span>
          {hold && (
            <span className="ts-hold" title={heldMessage(hold)}>
              {holdNote(hold)}
            </span>
          )}
        </div>
        <div className="ts-top-right">
          <span className="ts-tool-group" aria-label="History">
            <button type="button" className="ts-icon" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)"><Undo2 size={15} /></button>
            <button type="button" className="ts-icon" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)"><Redo2 size={15} /></button>
          </span>
          {p.onApplyToAll && applyTarget && (
            <button type="button" className="ts-btn ts-apply-all" onClick={() => void applyToAll()} disabled={applying} title={applyTarget.role === "logo" ? "Apply this style to all posts: the logo in this place and size on every post of the month" : "Apply this style to all posts: every post's same line gets this look; their words stay"}>
              {applying ? <Orb size={13} /> : <Wand2 size={13} />} <span>Apply this style to all posts</span>
            </button>
          )}
          <button type="button" className={`ts-btn ts-preview-toggle ${previewOn ? "on" : ""}`} onClick={() => setPreviewOn((s) => !s)} title="Export preview: the final artwork at the output size, drawn here (no server call)" aria-pressed={previewOn}>
            <Eye size={14} /> <span>Preview</span>
          </button>
          {p.onPhotoStudio && (
            <button
              type="button"
              className="ts-btn"
              onClick={() => {
                if (dirtyRef.current) flushSave(true);
                p.onPhotoStudio!();
              }}
              title="The picture itself, in the Photo studio: the AI edit, free adjustments, the Photo lab, versions and checks"
            >
              <Aperture size={14} /> <span>Photo studio</span>
            </button>
          )}
          {p.onVideoStudio && (
            <button
              type="button"
              className="ts-btn"
              onClick={() => {
                if (dirtyRef.current) flushSave(true);
                p.onVideoStudio!();
              }}
              title="This post's videos, in the Video studio (the words are kept)"
            >
              <Clapperboard size={14} /> <span>Video studio</span>
            </button>
          )}
          <PopoverPrimitive.Root>
            <PopoverPrimitive.Trigger asChild>
              <button type="button" className="ts-btn" title="Export this post"><Download size={14} /> Export <ChevronDown size={12} /></button>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content className="ts-pop ts-menu" sideOffset={8} align="end" collisionPadding={12}>
                <button type="button" onClick={() => void exportAs("png")}>PNG · {imgRef.current?.naturalWidth ?? 1080}px</button>
                <button type="button" onClick={() => void exportAs("png2x")}>PNG · 2× ({(imgRef.current?.naturalWidth ?? 1080) * 2}px)</button>
                <button type="button" onClick={() => void exportAs("jpg")}>JPG · high quality</button>
                <button type="button" onClick={() => void exportAs("text")}>Text only · transparent PNG</button>
                <button type="button" onClick={() => void exportAs("pdf")}>PDF</button>
                <hr />
                <button type="button" onClick={() => void resetToAuto()}><RotateCcw size={12} /> Back to the automatic layout</button>
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
          <button type="button" className="ts-btn primary ts-save-return" onClick={() => void saveAndReturn()} disabled={returning} title="Save every edit of this post (words, picture, video cut) and go back to its card">{returning ? "Saving…" : "Save & return"}</button>
        </div>
      </header>

      {/* Selected-layer tools, grouped by task: type · emphasis · alignment · colour and spacing. Nothing here makes a picture. */}
      <div className="ts-tools" role="toolbar" aria-label="Layer tools">
        <span className="ts-tool-group" aria-label="Add">
          <button type="button" className="ts-icon" onClick={() => addLayer()} title="Add text (T)" aria-label="Add text"><Type size={15} /></button>
        </span>
        {primaryText && (
          <>
            <span className="ts-tool-group" aria-label="Type">
              <FontMenu value={primaryText.font} brand={fonts} onChange={(font) => updateText({ font })} onUpload={uploadFont} />
              <input className="ts-size" type="number" min={6} max={W} value={Math.round(primaryText.size * W)} onChange={(e) => updateText({ size: Math.max(0.005, Number(e.target.value) / W) })} title="Size at export width" aria-label="Font size" />
              <select className="ts-weight" value={primaryText.weight} onChange={(e) => updateText({ weight: Number(e.target.value) })} title="Weight" aria-label="Font weight">
                {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </span>
            <span className="ts-tool-group" aria-label="Emphasis">
              <button type="button" className={`ts-icon ${richActive.bold ? "on" : ""}`} onClick={() => rich("bold")} title="Bold (⌘B)"><Bold size={15} /></button>
              <button type="button" className={`ts-icon ${richActive.italic ? "on" : ""}`} onClick={() => rich("italic")} title="Italic (⌘I)"><Italic size={15} /></button>
              <button type="button" className={`ts-icon ${richActive.underline ? "on" : ""}`} onClick={() => rich("underline")} title="Underline (⌘U)"><Underline size={15} /></button>
            </span>
            <span className="ts-tool-group" aria-label="Alignment">
              <button type="button" className={`ts-icon ${primaryText.align === "left" ? "on" : ""}`} onClick={() => updateText({ align: "left" })} title="Align left"><AlignLeft size={15} /></button>
              <button type="button" className={`ts-icon ${primaryText.align === "center" ? "on" : ""}`} onClick={() => updateText({ align: "center" })} title="Centre"><AlignCenter size={15} /></button>
              <button type="button" className={`ts-icon ${primaryText.align === "right" ? "on" : ""}`} onClick={() => updateText({ align: "right" })} title="Align right"><AlignRight size={15} /></button>
              <button type="button" className={`ts-icon ${primaryText.align === "justify" ? "on" : ""}`} onClick={() => updateText({ align: "justify" })} title="Justify"><AlignJustify size={15} /></button>
              <select className="ts-dir" value={primaryText.direction ?? "auto"} onChange={(e) => updateText({ direction: e.target.value as TextLayer["direction"] })} title="Reading direction: auto follows the first letter; set it for a line of numbers or a mixed line" aria-label="Reading direction">
                <option value="auto">Auto</option>
                <option value="rtl">RTL</option>
                <option value="ltr">LTR</option>
              </select>
            </span>
            <span className="ts-tool-group" aria-label="Colour and spacing">
              <ColorField compact label="Text colour" value={primaryText.fill} onChange={(fill) => updateText({ fill })} brand={[...brand.colors, ...palette]} saved={saved} onSaveColour={saveColour} allowGradient onPickFromCanvas={pickFromCanvas} />
              <PopoverPrimitive.Root>
                <PopoverPrimitive.Trigger asChild>
                  <button type="button" className="ts-icon" title="Spacing" aria-label="Spacing"><span className="ts-spacing-glyph">A↔</span></button>
                </PopoverPrimitive.Trigger>
                <PopoverPrimitive.Portal>
                  <PopoverPrimitive.Content className="ts-pop ts-spacing" sideOffset={8} collisionPadding={12}>
                    <label className="ts-slider"><span>Line height <em>{primaryText.lineHeight.toFixed(2)}</em></span><input type="range" min={0.7} max={2.5} step={0.05} value={primaryText.lineHeight} onChange={(e) => updateText({ lineHeight: Number(e.target.value) })} /></label>
                    <label className="ts-slider"><span>Letter spacing <em>{Math.round((primaryText.letterSpacing ?? 0) * 100)}</em></span><input type="range" min={-0.1} max={0.6} step={0.01} value={primaryText.letterSpacing ?? 0} onChange={(e) => updateText({ letterSpacing: Number(e.target.value) || undefined })} /></label>
                    <label className="ts-slider"><span>Word spacing <em>{(primaryText.wordSpacing ?? 0).toFixed(2)}</em></span><input type="range" min={-0.2} max={1.5} step={0.05} value={primaryText.wordSpacing ?? 0} onChange={(e) => updateText({ wordSpacing: Number(e.target.value) || undefined })} /></label>
                  </PopoverPrimitive.Content>
                </PopoverPrimitive.Portal>
              </PopoverPrimitive.Root>
            </span>
            {contrast !== null && contrast < 3 && (
              <button type="button" className="ts-warn-chip" onClick={() => { setRightTab("props"); setSide("right"); }} title={`These words read badly over the picture (${contrast.toFixed(1)}:1). Properties offers a backing or a fade; your colours are never changed for you.`}>
                <TriangleAlert size={12} /> Low contrast
              </button>
            )}
          </>
        )}
        {primary && !primaryText && (
          <label className="ts-slider ts-tool-opacity" title="Layer opacity">
            <span>Opacity <em>{Math.round((primary.opacity ?? 1) * 100)}%</em></span>
            <input type="range" min={0} max={100} value={Math.round((primary.opacity ?? 1) * 100)} onChange={(e) => updateSel({ opacity: Number(e.target.value) === 100 ? undefined : Number(e.target.value) / 100 })} />
          </label>
        )}
        {!primary && <span className="ts-tools-hint">Select a layer to edit it, press T for text, or pick a layout. Words, logo, position and size are drawn here: no picture is made.</span>}
      </div>

      <div className="ts-body">
        {/* Left sidebar (on narrow screens its tabs join the one panel at the bottom) */}
        {!narrow && (
          <aside className="ts-left">
            <div className="ts-tabs">{leftTabs}</div>
            <div className="ts-side-body">{leftBody}</div>
          </aside>
        )}

        {/* Stage: the scroller, with the trial bar and the view tools pinned over it (they do not scroll away when zoomed in) */}
        <div className="ts-stage-wrap">
          {bgPreview && (
            <div className="ts-trial ts-bg-confirm" role="alertdialog" aria-label="Remove background">
              <span className="ts-bg-note">{bgPreview.note}</span>
              <button type="button" className="ts-btn primary" onClick={() => void confirmBackground()} disabled={vectorBusy === "bg"}>
                {vectorBusy === "bg" ? <Orb size={12} /> : null} Remove background
              </button>
              <button type="button" className="ts-btn" onClick={() => setBgPreview(null)}>
                Cancel
              </button>
            </div>
          )}
          {trial && (
            <div className="ts-trial" role="status">
              <span>
                <LayoutTemplate size={13} /> Previewing <b>{trial.name}</b> · nothing has changed yet
              </span>
              <button type="button" className="ts-btn primary" onClick={() => applyLayoutHere(layouts.find((l) => l.id === trial.id) ?? layouts[0])}>Apply to this design</button>
              <button type="button" className="ts-btn" onClick={() => setTrial(null)}>Keep my design</button>
            </div>
          )}
        <div className="ts-stage" ref={stageRef}>
          {!design && (
            <div className="ts-loading">
              <Orb size={24} />
            </div>
          )}
          {design && size && previewOn && (
            <div className="ts-preview" style={{ width: W * scale }}>
              <div className="ts-preview-head">
                <span>
                  Export preview · {imgRef.current?.naturalWidth ?? W} × {Math.round(((imgRef.current?.naturalWidth ?? W) * H) / W)} px, drawn here
                </span>
                <button type="button" className="ts-btn" onClick={() => void downloadPreview()} title="Save this preview as a PNG (no server call)">
                  <Download size={13} /> Download preview PNG
                </button>
              </div>
              {preview ? <img src={preview} alt="Export preview" style={{ width: W * scale, height: H * scale }} /> : <div className="ts-loading" style={{ width: W * scale, height: H * scale }}><Orb size={24} /></div>}
            </div>
          )}
          {design && size && !previewOn && (
            <div className="ts-canvas-wrap" style={{ width: W * scale, height: H * scale }}>
              <canvas ref={canvasRef} style={{ width: W * scale, height: H * scale }} />
              <div className={`ts-overlay ${trial ? "trial" : ""}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble}>
                {safe && (
                  <div className="ts-safe" aria-hidden>
                    <span className="ts-safe-top" style={{ height: `${14}%` }} />
                    <span className="ts-safe-bottom" style={{ height: `${20}%` }} />
                    <span className="ts-safe-side left" style={{ width: `${spec.margin * 100}%` }} />
                    <span className="ts-safe-side right" style={{ width: `${spec.margin * 100}%` }} />
                  </div>
                )}
                {guides.map((g, i) => (
                  <span key={i} className={`ts-guide ${g.axis}`} style={g.axis === "x" ? { left: g.at * scale } : { top: g.at * scale }} />
                ))}
                {selLayers.map((l) => {
                  const b = boxes.find((x) => x.id === l.id);
                  if (!b || l.hidden) return null;
                  const single = selLayers.length === 1 && editing !== l.id;
                  return (
                    <div
                      key={l.id}
                      className={`ts-sel ${l.locked ? "locked" : ""} ${single ? "single" : ""}`}
                      style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale, transform: b.rotate ? `rotate(${b.rotate}deg)` : undefined }}
                    >
                      {single && !l.locked && (
                        <>
                          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).filter((h) => l.type !== "logo" || (h !== "n" && h !== "s")).map((h) => (
                            <span key={h} className={`ts-handle ${h}`} data-handle={h} />
                          ))}
                          <span className="ts-rot-line" />
                          <span className="ts-handle rot" data-handle="rot" title="Drag to rotate (⇧ for free angles)" />
                        </>
                      )}
                      {single && l.rotate ? <span className="ts-angle">{Math.round(l.rotate)}°</span> : null}
                    </div>
                  );
                })}
                {bgPreview && (
                  <svg className="ts-bg-highlight" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
                    <defs>
                      <pattern id="ts-bg-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <rect width="6" height="12" fill="rgba(229, 57, 53, 0.28)" />
                      </pattern>
                    </defs>
                    {bgPreview.polys.map((poly, i) => (
                      <polygon key={i} points={poly.map((pt) => `${pt.x},${pt.y}`).join(" ")} fill="url(#ts-bg-hatch)" stroke="#e53935" strokeWidth={3 / scale} strokeDasharray={`${8 / scale} ${5 / scale}`} />
                    ))}
                  </svg>
                )}
                {marquee && <div className="ts-marquee" style={{ left: marquee.x * scale, top: marquee.y * scale, width: marquee.w * scale, height: marquee.h * scale }} />}
                {editingLayer && editingBox && (
                  <textarea
                    ref={textareaRef}
                    className="ts-inline"
                    dir={editingLayer.direction && editingLayer.direction !== "auto" ? editingLayer.direction : "auto"}
                    value={editingLayer.text}
                    spellCheck={false}
                    style={{
                      left: editingBox.x * scale,
                      top: editingBox.y * scale,
                      width: editingBox.w * scale,
                      height: Math.max(editingBox.h, editingBox.px * editingLayer.lineHeight) * scale,
                      transform: editingBox.rotate ? `rotate(${editingBox.rotate}deg)` : undefined,
                      fontFamily: `"${editingLayer.font}", Tajawal, Inter, sans-serif`,
                      fontWeight: editingLayer.weight,
                      fontStyle: editingLayer.italic ? "italic" : "normal",
                      fontSize: editingBox.px * scale,
                      lineHeight: editingLayer.lineHeight,
                      letterSpacing: `${(editingLayer.letterSpacing ?? 0) * editingBox.px * scale}px`,
                      wordSpacing: `${(editingLayer.wordSpacing ?? 0) * editingBox.px * scale}px`,
                      textAlign: editingLayer.align === "justify" ? "justify" : editingLayer.align,
                      textTransform: editingLayer.transform === "upper" ? "uppercase" : editingLayer.transform === "lower" ? "lowercase" : editingLayer.transform === "title" ? "capitalize" : "none",
                      color: editingLayer.fill.type === "solid" ? (editingLayer.fill.alpha === 0 ? "transparent" : editingLayer.fill.color) : editingLayer.fill.stops[0]?.color,
                      WebkitTextStroke: editingLayer.fill.type === "solid" && editingLayer.fill.alpha === 0 ? `1px ${editingLayer.stroke?.color ?? "#fff"}` : undefined,
                      padding: (editingLayer.padding ?? 0) * editingBox.px * scale,
                      opacity: editingLayer.opacity ?? 1,
                    }}
                    onChange={(e) => {
                      update([editingLayer.id], (l) => (isTextLayer(l) ? editText(l, e.target.value) : {}), true);
                      setCaret({ start: e.target.selectionStart, end: e.target.selectionEnd });
                    }}
                    onSelect={(e) => setCaret({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEditing(null);
                      }
                    }}
                    onBlur={(e) => {
                      // A click on the toolbar keeps the box open; a click on the picture closes it.
                      const to = e.relatedTarget as HTMLElement | null;
                      if (!to || !to.closest(".ts-top, .ts-right, .ts-pop")) setEditing(null);
                    }}
                  />
                )}
                {primary && selLayers.length === 1 && !editing && boxes.find((b) => b.id === primary.id) && (
                  <ContextBar
                    box={boxes.find((b) => b.id === primary.id)!}
                    scale={scale}
                    layer={primary}
                    onRich={rich}
                    onDuplicate={() => duplicate([primary.id])}
                    onDelete={() => remove([primary.id])}
                    onLock={() => update([primary.id], { locked: !primary.locked || undefined })}
                    onAssist={() => setRightTab("assist")}
                    fill={
                      primaryText ? (
                        <ColorField compact label="Text colour" value={primaryText.fill} onChange={(fill) => updateText({ fill })} brand={[...brand.colors, ...palette]} saved={saved} onSaveColour={saveColour} allowGradient onPickFromCanvas={pickFromCanvas} />
                      ) : primary.type === "shape" ? (
                        <ColorField compact label="Fill" value={primary.fill} onChange={(fill) => updateSel({ fill })} brand={[...brand.colors, ...palette]} saved={saved} onSaveColour={saveColour} allowGradient onPickFromCanvas={pickFromCanvas} />
                      ) : null
                    }
                  />
                )}
              </div>
            </div>
          )}
        </div>
          {/* View tools: zoom, safe zones and the shortcuts card sit by the stage, out of the editing tools' way. */}
          <div className="ts-view" role="toolbar" aria-label="View">
            <div className="ts-zoom">
              <button type="button" className="ts-icon" onClick={() => setZoom((z) => Math.max(0.2, z / 1.2))} title="Zoom out (⌘−)" aria-label="Zoom out"><Minus size={14} /></button>
              <button type="button" className="ts-zoom-value" onClick={() => setZoom(1)} title="Fit (⌘0)">{Math.round(scale * 100)}%</button>
              <button type="button" className="ts-icon" onClick={() => setZoom((z) => Math.min(6, z * 1.2))} title="Zoom in (⌘+)" aria-label="Zoom in"><Plus size={14} /></button>
            </div>
            <button type="button" className={`ts-icon ${safe ? "on" : ""}`} onClick={() => setSafe((s) => !s)} title="Safe zones (where Instagram's buttons and captions sit)" aria-label="Safe zones" aria-pressed={safe}><Grid3x3 size={15} /></button>
            <button type="button" className="ts-icon" onClick={() => setShortcuts((s) => !s)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><Keyboard size={15} /></button>
          </div>
        </div>

        {/* Right panel; on narrow screens the one panel, with every tab */}
        <aside className="ts-right">
          <div className="ts-tabs">
            {narrow && leftTabs}
            {rightTabs}
          </div>
          <div className="ts-side-body">{narrow && side === "left" ? leftBody : rightBody}</div>
        </aside>
      </div>
      {shortcuts && (
        <div className="ts-shortcuts" onClick={() => setShortcuts(false)}>
          <div className="ts-shortcuts-card" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <dl>
              {[
                ["T", "Add a text layer"],
                ["Enter / double-click", "Edit the words in place"],
                ["Layers › Add", "A logo, a picture (product, brand asset, upload) or a shape"],
                ["Layouts", "Preview a whole arrangement on the picture; Apply changes this design only (⌘Z undoes it)"],
                ["Esc", "Stop editing, clear the selection, close"],
                ["⌘Z / ⇧⌘Z", "Undo / redo"],
                ["⌘B ⌘I ⌘U", "Bold, italic, underline (selected words or layer)"],
                ["⌘D", "Duplicate"],
                ["⌘C ⌘X ⌘V", "Copy, cut, paste layers (or paste plain text as a layer)"],
                ["⌘A", "Select every layer"],
                ["⌘G / ⇧⌘G", "Group / ungroup"],
                ["⌘L", "Lock / unlock"],
                ["⇧⌘H", "Hide / show"],
                ["⌘] / ⌘[", "Bring forward / send backward (⇧ to front / back)"],
                ["Arrows", "Nudge 1px (⇧ 10px)"],
                ["⌘+ ⌘− ⌘0", "Zoom in, out, fit"],
                ["⌥ while dragging", "No snapping"],
                ["⇧ while rotating", "Free angle"],
                ["⌘S", "Save now (it also saves on its own)"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
  return createPortal(sheet, document.body);
}

function ContextBar({ box, scale, layer, onRich, onDuplicate, onDelete, onLock, onAssist, fill }: { box: LayerBox; scale: number; layer: Layer; onRich: (w: "bold" | "italic") => void; onDuplicate: () => void; onDelete: () => void; onLock: () => void; onAssist: () => void; fill: React.ReactNode }) {
  // Above the rotation handle; under the box when the layer touches the top edge.
  const top = box.y * scale - 92;
  const text = isTextLayer(layer) ? layer : null;
  return (
    <div className="ts-context" style={{ left: Math.max(0, box.cx * scale - 120), top: top < 0 ? (box.y + box.h) * scale + 14 : top }} onPointerDown={(e) => e.stopPropagation()}>
      {fill}
      {text && (
        <>
          <button type="button" className={text.weight >= 700 ? "on" : ""} onClick={() => onRich("bold")} title="Bold"><Bold size={13} /></button>
          <button type="button" className={text.italic ? "on" : ""} onClick={() => onRich("italic")} title="Italic"><Italic size={13} /></button>
        </>
      )}
      <button type="button" onClick={onDuplicate} title="Duplicate (⌘D)"><Copy size={13} /></button>
      <button type="button" onClick={onLock} title={layer.locked ? "Unlock" : "Lock"}>{layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
      {text && <button type="button" onClick={onAssist} title="Ask the assistant"><Sparkles size={13} /></button>}
      <button type="button" className="danger" onClick={onDelete} title="Delete"><Trash2 size={13} /></button>
    </div>
  );
}
