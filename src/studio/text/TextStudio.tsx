import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronDown, Download, Italic, Keyboard, Layers, Lock, LockOpen, Minus, Palette, Plus, Redo2, RotateCcw, Sparkles, Trash2, Type, Underline, Undo2, X, Copy, Grid3x3, Wand2 } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { toast } from "sonner";
import { postForm } from "@/api";
import { askInput } from "@/lib/confirm";
import { saveBlob } from "@/lib/zip";
import { stackedImagesPdf } from "@/lib/pdf";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import type { Client } from "@shared/types";
import { editText, layerId, newTextLayer, replaceInLayers, setRunStyle, styleAt, wordsOf, type CanvasFx, type RunStyle, type TextDesign, type TextLayer } from "@shared/layers";
import { loadFont, loadImage, paintFrame, renderOverlay, type OverlayLayout } from "@/lib/overlay";
import { renderDesignOnly, type LayerBox } from "@/lib/textLayers";
import { Orb } from "@/components/Orb";
import ColorField from "./ColorField";
import FontMenu from "./FontMenu";
import { Assistant, BrandAssets, LayersList, PresetsList } from "./Panels";
import Properties, { type Align } from "./Properties";
import { brandFonts, contrastOf, designFromLegacy, hitLayer, patchWith, round3, savedColours, snapMove, toLocal, type Brand, type Guide } from "./model";

export interface EditorResult {
  headline: string;
  subline: string;
  ov: PostOverlayPatch | undefined;
}

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
  /** keepOpen: an auto-save while the designer keeps working. */
  onSave: (r: EditorResult, keepOpen: boolean) => void;
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "rot";
type Drag =
  | { kind: "move"; start: { x: number; y: number }; origin: TextLayer[]; ids: string[]; moved: boolean }
  | { kind: "resize"; handle: Handle; id: string; origin: TextLayer; box: LayerBox }
  | { kind: "rotate"; id: string; origin: TextLayer; box: LayerBox }
  | { kind: "marquee"; start: { x: number; y: number }; add: boolean; now: { x: number; y: number } };

const MAX_HISTORY = 60;
const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

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
  const [leftTab, setLeftTab] = useState<"layers" | "presets" | "brand">("layers");
  const [rightTab, setRightTab] = useState<"props" | "assist">("props");
  const [safe, setSafe] = useState(false);
  const [saving, setSaving] = useState<"saved" | "dirty" | "saving">("saved");
  const [saved, setSaved] = useState<string[]>(() => savedColours.list(brand.id));
  const [shortcuts, setShortcuts] = useState(false);
  const pickRef = useRef<((hex: string | null) => void) | null>(null);
  const [picking, setPicking] = useState(false);
  const clipRef = useRef<TextLayer[]>([]);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const histKey = `lsm-ts-hist:${p.batchId ?? "x"}:${p.index}`;

  const W = size?.W ?? 1080;
  const H = size?.H ?? 1350;
  const scale = fit * zoom;
  const layers = useMemo(() => design?.layers ?? [], [design]);
  const primary = useMemo(() => layers.find((l) => l.id === selected[0]) ?? null, [layers, selected]);
  const selLayers = useMemo(() => layers.filter((l) => selected.includes(l.id)), [layers, selected]);
  const fonts = brandFonts(brand);

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
        setSize({ W: w, H: h });
        for (const f of brand.fontFiles) void loadFont(f.name, `/api/studio/clients/${brand.id}/fonts/${f.id}/file`);
        let d = p.patch?.design;
        if (!d) {
          // The first visit: the automatic layout's words become layers exactly where they were.
          const probe = document.createElement("canvas");
          probe.width = w;
          probe.height = h;
          const { design: _d, ...legacy } = p.patch ?? {};
          void _d;
          const layout: OverlayLayout = await paintFrame(probe, img, spec, { headline: p.headline, subline: p.subline }, logoSrc, { patch: legacy, faces: p.faces });
          d = designFromLegacy(spec, p.headline, p.subline, p.patch, layout.text, w, h);
        }
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
        setDesign(d);
        setSelected(d.layers.length ? [d.layers[d.layers.length - 1].id] : []);
        dirtyRef.current = false;
        setSaving("saved");
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
    void paintFrame(c, img, spec, { headline: "", subline: "" }, logoSrc, { patch: patchWith(p.patch, design), skipLayers: skip }).then((l) => {
      if (!alive) return;
      boxesRef.current = l.layers ?? [];
      setBoxes(l.layers ?? []);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, design, size, editing, spec, logoSrc]);

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
      dirtyRef.current = false;
      setSaving("saving");
      p.onSave(result(d), keepOpen);
      setSaving("saved");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.onSave, p.patch],
  );
  useEffect(() => {
    if (!open || !design || !dirtyRef.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => flushSave(true), 1200);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [design, open, flushSave]);
  const close = () => {
    if (editing) setEditing(null);
    if (dirtyRef.current) flushSave(false);
    else p.onClose();
  };

  /* ───────────── Layer operations ───────────── */
  const update = (ids: string[], patch: Partial<TextLayer> | ((l: TextLayer) => Partial<TextLayer>), typing = false) => {
    const d = designRef.current;
    if (!d) return;
    commit({ ...d, layers: d.layers.map((l) => (ids.includes(l.id) ? { ...l, ...(typeof patch === "function" ? patch(l) : patch) } : l)) }, typing);
  };
  const updateSel = (patch: Partial<TextLayer>) => update(selected, patch);
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
      ...over,
    });
    commit({ ...d, layers: [...d.layers, l] });
    setSelected([l.id]);
    return l;
  };
  const duplicate = (ids: string[]) => {
    const d = designRef.current;
    if (!d) return;
    const copies: TextLayer[] = [];
    const next = [...d.layers];
    for (const id of ids) {
      const l = d.layers.find((x) => x.id === id);
      if (!l) continue;
      const c = { ...l, id: layerId(), name: l.name ? `${l.name} copy` : undefined, role: undefined, x: l.x + 0.02, y: l.y + 0.02 };
      copies.push(c);
      next.push(c);
    }
    if (!copies.length) return;
    commit({ ...d, layers: next });
    setSelected(copies.map((c) => c.id));
  };
  const remove = (ids: string[]) => {
    const d = designRef.current;
    if (!d) return;
    commit({ ...d, layers: d.layers.filter((l) => !ids.includes(l.id)) });
    setSelected((s) => s.filter((id) => !ids.includes(id)));
    if (editing && ids.includes(editing)) setEditing(null);
  };
  const reorder = (fromTop: number, toTop: number) => {
    const d = designRef.current;
    if (!d) return;
    const n = d.layers.length;
    const from = n - 1 - fromTop;
    const to = n - 1 - toTop;
    const next = [...d.layers];
    const [l] = next.splice(from, 1);
    next.splice(to, 0, l);
    commit({ ...d, layers: next });
  };
  const zOrder = (how: "up" | "down" | "front" | "back") => {
    const d = designRef.current;
    if (!d || !selected.length) return;
    const next = [...d.layers];
    const picked = next.filter((l) => selected.includes(l.id));
    const rest = next.filter((l) => !selected.includes(l.id));
    if (how === "front") return commit({ ...d, layers: [...rest, ...picked] });
    if (how === "back") return commit({ ...d, layers: [...picked, ...rest] });
    const i = next.findIndex((l) => l.id === selected[0]);
    const j = how === "up" ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    commit({ ...d, layers: next });
  };
  const group = (on: boolean) => {
    if (selected.length < (on ? 2 : 1)) return;
    const id = on ? `G${layerId()}` : undefined;
    update(selected, { group: id });
  };
  const select = (id: string, add: boolean) => {
    const d = designRef.current;
    const l = d?.layers.find((x) => x.id === id);
    const members = l?.group ? d!.layers.filter((x) => x.group === l.group).map((x) => x.id) : [id];
    setSelected((s) => (add ? (s.includes(id) ? s.filter((x) => !members.includes(x)) : [...s, ...members.filter((m) => !s.includes(m))]) : members));
    if (editing && editing !== id) setEditing(null);
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
        if (!targets.includes(l.id)) return l;
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
    const l = primary;
    if (!l) return { bold: false, italic: false, underline: false, strike: false, script: null };
    const at = editing === l.id ? styleAt(l.runs, Math.max(0, caret.start)) : styleAt(l.runs, 0);
    return { bold: !!at.bold || (editing !== l.id && l.weight >= 700), italic: !!at.italic || !!l.italic, underline: !!at.underline, strike: !!at.strike, script: at.script ?? null };
  }, [primary, editing, caret]);

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
    const hit = hitLayer(boxesRef.current, d.layers, pt.x, pt.y, 4);
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
        // Corners scale the type: the opposite corner stays, the size follows the width.
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
        replace({
          ...d,
          layers: d.layers.map((l) => (l.id === drag.id ? { ...l, size: round3(o.size * f * 1000) / 1000, w: round3((right - left) / W), h: o.autoSize === false && o.h ? round3(((bottom - top) / H) * 1) : o.h, x: round3((c.x - (right - left) / 2) / W), y: round3((c.y - (bottom - top) / 2) / H) } : l)),
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
        layers: d.layers.map((l) =>
          l.id === drag.id
            ? { ...l, w: round3((right - left) / W), ...(vertical ? { h: round3((bottom - top) / H), autoSize: false } : {}), x: round3((c.x - (right - left) / 2) / W), y: round3((c.y - (vertical ? bottom - top : b.h) / 2) / H) }
            : l,
        ),
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
    const hit = hitLayer(boxesRef.current, d.layers, pt.x, pt.y, 4);
    if (hit && !d.layers.find((l) => l.id === hit.id)?.locked) {
      setSelected([hit.id]);
      setEditing(hit.id);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };
  const boxAt = (l: TextLayer, b: LayerBox) => ({ x: l.x * W, y: l.y * H, cx: l.x * W + b.w / 2, cy: l.y * H + b.h / 2 });
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
      if (e.key === "Escape") {
        if (picking) {
          pickRef.current?.(null);
          pickRef.current = null;
          setPicking(false);
        } else if (editing) setEditing(null);
        else if (shortcuts) setShortcuts(false);
        else if (selected.length) setSelected([]);
        else close();
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
          const copies = clipRef.current.map((l) => ({ ...l, id: layerId(), role: undefined, x: l.x + 0.03, y: l.y + 0.03 }));
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
      if (e.key === "Enter" && primary && !primary.locked) {
        e.preventDefault();
        setEditing(primary.id);
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }
      if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        addLayer();
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
        const c = await renderDesignOnly(d, nat, Math.round((nat * H) / W));
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
      if (selected.length) updateSel({ font: name.trim() });
      toast.success(`Font "${name.trim()}" added to ${brand.name}.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const resetToAuto = () => {
    const ov: PostOverlayPatch = { ...(p.patch ?? {}) };
    delete ov.design;
    dirtyRef.current = false;
    p.onSave({ headline: p.headline, subline: p.subline, ov: Object.keys(ov).length ? ov : undefined }, false);
  };
  const warnings = useMemo(() => {
    const s = new Set<string>();
    for (const l of layers) {
      const c = contrastOf(baseRef.current, l, boxes.find((b) => b.id === l.id));
      if (c !== null && c < 3) s.add(l.id);
    }
    return s;
  }, [layers, boxes]);
  const contrast = primary ? contrastOf(baseRef.current, primary, boxes.find((b) => b.id === primary.id)) : null;
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void histTick;
  const editingLayer = editing ? layers.find((l) => l.id === editing) : null;
  const editingBox = editing ? boxes.find((b) => b.id === editing) : null;

  if (!open) return null;
  const sheet = (
    <div className={`ts ${picking ? "picking" : ""}`} role="dialog" aria-label="Text studio">
      {/* Top toolbar */}
      <header className="ts-top">
        <div className="ts-top-left">
          <button type="button" className="ts-icon" onClick={close} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
          <span className="ts-title">
            Text studio <small>· post {p.index}</small>
          </span>
          <span className={`ts-save ${saving}`}>{saving === "saved" ? "Saved" : saving === "saving" ? "Saving…" : "Unsaved changes"}</span>
        </div>
        <div className="ts-tools">
          <button type="button" className="ts-icon" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)"><Undo2 size={15} /></button>
          <button type="button" className="ts-icon" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)"><Redo2 size={15} /></button>
          <span className="ts-sep" />
          <button type="button" className="ts-icon" onClick={() => addLayer()} title="Add text (T)"><Type size={15} /></button>
          {primary && (
            <>
              <FontMenu value={primary.font} brand={fonts} onChange={(font) => updateSel({ font })} onUpload={uploadFont} />
              <input className="ts-size" type="number" min={6} max={W} value={Math.round(primary.size * W)} onChange={(e) => updateSel({ size: Math.max(0.005, Number(e.target.value) / W) })} title="Size at export width" />
              <select className="ts-weight" value={primary.weight} onChange={(e) => updateSel({ weight: Number(e.target.value) })} title="Weight">
                {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
              <button type="button" className={`ts-icon ${richActive.bold ? "on" : ""}`} onClick={() => rich("bold")} title="Bold (⌘B)"><Bold size={15} /></button>
              <button type="button" className={`ts-icon ${richActive.italic ? "on" : ""}`} onClick={() => rich("italic")} title="Italic (⌘I)"><Italic size={15} /></button>
              <button type="button" className={`ts-icon ${richActive.underline ? "on" : ""}`} onClick={() => rich("underline")} title="Underline (⌘U)"><Underline size={15} /></button>
              <span className="ts-sep" />
              <button type="button" className={`ts-icon ${primary.align === "left" ? "on" : ""}`} onClick={() => updateSel({ align: "left" })} title="Align left"><AlignLeft size={15} /></button>
              <button type="button" className={`ts-icon ${primary.align === "center" ? "on" : ""}`} onClick={() => updateSel({ align: "center" })} title="Centre"><AlignCenter size={15} /></button>
              <button type="button" className={`ts-icon ${primary.align === "right" ? "on" : ""}`} onClick={() => updateSel({ align: "right" })} title="Align right"><AlignRight size={15} /></button>
              <button type="button" className={`ts-icon ${primary.align === "justify" ? "on" : ""}`} onClick={() => updateSel({ align: "justify" })} title="Justify"><AlignJustify size={15} /></button>
              <span className="ts-sep" />
              <ColorField compact label="Text colour" value={primary.fill} onChange={(fill) => updateSel({ fill })} brand={[...brand.colors, ...palette]} saved={saved} onSaveColour={saveColour} allowGradient onPickFromCanvas={pickFromCanvas} />
              <PopoverPrimitive.Root>
                <PopoverPrimitive.Trigger asChild>
                  <button type="button" className="ts-icon" title="Spacing"><span className="ts-spacing-glyph">A↔</span></button>
                </PopoverPrimitive.Trigger>
                <PopoverPrimitive.Portal>
                  <PopoverPrimitive.Content className="ts-pop ts-spacing" sideOffset={8} collisionPadding={12}>
                    <label className="ts-slider"><span>Line height <em>{primary.lineHeight.toFixed(2)}</em></span><input type="range" min={0.7} max={2.5} step={0.05} value={primary.lineHeight} onChange={(e) => updateSel({ lineHeight: Number(e.target.value) })} /></label>
                    <label className="ts-slider"><span>Letter spacing <em>{Math.round((primary.letterSpacing ?? 0) * 100)}</em></span><input type="range" min={-0.1} max={0.6} step={0.01} value={primary.letterSpacing ?? 0} onChange={(e) => updateSel({ letterSpacing: Number(e.target.value) || undefined })} /></label>
                    <label className="ts-slider"><span>Word spacing <em>{(primary.wordSpacing ?? 0).toFixed(2)}</em></span><input type="range" min={-0.2} max={1.5} step={0.05} value={primary.wordSpacing ?? 0} onChange={(e) => updateSel({ wordSpacing: Number(e.target.value) || undefined })} /></label>
                  </PopoverPrimitive.Content>
                </PopoverPrimitive.Portal>
              </PopoverPrimitive.Root>
            </>
          )}
        </div>
        <div className="ts-top-right">
          <div className="ts-zoom">
            <button type="button" className="ts-icon" onClick={() => setZoom((z) => Math.max(0.2, z / 1.2))} title="Zoom out (⌘−)"><Minus size={14} /></button>
            <button type="button" className="ts-zoom-value" onClick={() => setZoom(1)} title="Fit (⌘0)">{Math.round(scale * 100)}%</button>
            <button type="button" className="ts-icon" onClick={() => setZoom((z) => Math.min(6, z * 1.2))} title="Zoom in (⌘+)"><Plus size={14} /></button>
          </div>
          <button type="button" className={`ts-icon ${safe ? "on" : ""}`} onClick={() => setSafe((s) => !s)} title="Safe zones (where Instagram's buttons and captions sit)"><Grid3x3 size={15} /></button>
          <button type="button" className="ts-icon" onClick={() => setShortcuts((s) => !s)} title="Keyboard shortcuts (?)"><Keyboard size={15} /></button>
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
          <button type="button" className="ts-btn primary" onClick={close}>Done</button>
        </div>
      </header>

      <div className="ts-body">
        {/* Left sidebar */}
        <aside className="ts-left">
          <div className="ts-tabs">
            <button type="button" className={leftTab === "layers" ? "on" : ""} onClick={() => setLeftTab("layers")}><Layers size={13} /> Layers</button>
            <button type="button" className={leftTab === "presets" ? "on" : ""} onClick={() => setLeftTab("presets")}><Wand2 size={13} /> Styles</button>
            <button type="button" className={leftTab === "brand" ? "on" : ""} onClick={() => setLeftTab("brand")}><Palette size={13} /> Brand</button>
          </div>
          <div className="ts-side-body">
            {leftTab === "layers" && design && (
              <LayersList layers={layers} selected={selected} warnings={warnings} onSelect={select} onChange={(id, patch) => update([id], patch)} onReorder={reorder} onDuplicate={(id) => duplicate([id])} onDelete={(id) => remove([id])} onAdd={() => addLayer()} />
            )}
            {leftTab === "presets" && <PresetsList brand={brand} selected={primary} onApply={(style) => updateSel(style)} onAddWith={(style, name) => addLayer({ ...style, name }, name === "Price tag" ? "19.99 JOD" : name === "Quote" ? "“Made with love”" : "Your words here")} />}
            {leftTab === "brand" && <BrandAssets brand={brand} palette={palette} onFont={(font) => (selected.length ? updateSel({ font }) : addLayer({ font }))} onColour={(hex) => (selected.length ? updateSel({ fill: { type: "solid", color: hex } }) : addLayer({ fill: { type: "solid", color: hex } }))} onUploadFont={uploadFont} />}
          </div>
        </aside>

        {/* Stage */}
        <div className="ts-stage" ref={stageRef}>
          {!design && (
            <div className="ts-loading">
              <Orb size={24} />
            </div>
          )}
          {design && size && (
            <div className="ts-canvas-wrap" style={{ width: W * scale, height: H * scale }}>
              <canvas ref={canvasRef} style={{ width: W * scale, height: H * scale }} />
              <div className="ts-overlay" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble}>
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
                          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((h) => (
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
                      update([editingLayer.id], (l) => editText(l, e.target.value), true);
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
                  <ContextBar box={boxes.find((b) => b.id === primary.id)!} scale={scale} layer={primary} onRich={rich} onDuplicate={() => duplicate([primary.id])} onDelete={() => remove([primary.id])} onLock={() => update([primary.id], { locked: !primary.locked || undefined })} onAssist={() => setRightTab("assist")} fill={<ColorField compact label="Text colour" value={primary.fill} onChange={(fill) => updateSel({ fill })} brand={[...brand.colors, ...palette]} saved={saved} onSaveColour={saveColour} allowGradient onPickFromCanvas={pickFromCanvas} />} />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right panel */}
        <aside className="ts-right">
          <div className="ts-tabs">
            <button type="button" className={rightTab === "props" ? "on" : ""} onClick={() => setRightTab("props")}>Properties</button>
            <button type="button" className={rightTab === "assist" ? "on" : ""} onClick={() => setRightTab("assist")}><Sparkles size={13} /> Assistant</button>
          </div>
          <div className="ts-side-body">
            {rightTab === "props" && design && (
              <Properties
                sel={{ layer: primary, count: selLayers.length, contrast }}
                onChange={(patch) => (patch.text !== undefined && primary ? update(selected, (l) => editText(l, patch.text!), true) : updateSel(patch))}
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
              />
            )}
            {rightTab === "assist" && (
              <Assistant
                batch={p.batchId ?? null}
                index={p.index}
                text={primary?.text ?? ""}
                allText={layers.filter((l) => !l.hidden).map((l) => l.text).join("\n")}
                compose={composeJpeg}
                language={brand.language}
                onApply={(text) => {
                  if (primary) update([primary.id], (l) => editText(l, text));
                  else addLayer({}, text);
                }}
                onAddLayer={(text) => addLayer({ y: (primary?.y ?? 0.4) + 0.12 }, text)}
              />
            )}
          </div>
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

function ContextBar({ box, scale, layer, onRich, onDuplicate, onDelete, onLock, onAssist, fill }: { box: LayerBox; scale: number; layer: TextLayer; onRich: (w: "bold" | "italic") => void; onDuplicate: () => void; onDelete: () => void; onLock: () => void; onAssist: () => void; fill: React.ReactNode }) {
  // Above the rotation handle; under the box when the layer touches the top edge.
  const top = box.y * scale - 92;
  return (
    <div className="ts-context" style={{ left: Math.max(0, box.cx * scale - 120), top: top < 0 ? (box.y + box.h) * scale + 14 : top }} onPointerDown={(e) => e.stopPropagation()}>
      {fill}
      <button type="button" className={layer.weight >= 700 ? "on" : ""} onClick={() => onRich("bold")} title="Bold"><Bold size={13} /></button>
      <button type="button" className={layer.italic ? "on" : ""} onClick={() => onRich("italic")} title="Italic"><Italic size={13} /></button>
      <button type="button" onClick={onDuplicate} title="Duplicate (⌘D)"><Copy size={13} /></button>
      <button type="button" onClick={onLock} title={layer.locked ? "Unlock" : "Lock"}>{layer.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
      <button type="button" onClick={onAssist} title="Ask the assistant"><Sparkles size={13} /></button>
      <button type="button" className="danger" onClick={onDelete} title="Delete"><Trash2 size={13} /></button>
    </div>
  );
}
