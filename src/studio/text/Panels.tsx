import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Circle, Copy, Eye, EyeOff, GripVertical, Image as ImageIcon, LayoutTemplate, Lock, LockOpen, Minus, Plus, Search, Sparkles, Square, Stamp, Trash2, TriangleAlert, Type, Upload } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { toast } from "sonner";
import { post } from "@/api";
import { ASSIST_ACTIONS, ASSIST_LABELS, type AssistAction, type AssistAnswer, type AssistSuggestion } from "@shared/text-assist";
import { isTextLayer, type Layer, type ShapeKind, type TextLayer } from "@shared/layers";
import type { LanguageSource } from "@shared/language";
import { brandFonts, LANGUAGE_LABELS, PRESETS, savedStyles, styleOf, type Brand, type ClientLanguage, type LayoutPreset, type SavedStyle } from "./model";
import SourceBadge from "../SourceBadge";

/* ───────────── Layers ───────────── */

/** A picture a picture layer can show, with where it comes from. */
export interface Asset {
  name: string;
  src: string;
  kind: "product" | "brand";
}

/** The row's name: the layer's own, else its words, else what it is. */
export function layerLabel(l: Layer): string {
  if (l.name) return l.name;
  if (isTextLayer(l)) return l.text.split("\n")[0] || "Empty";
  if (l.type === "logo") return "Logo";
  if (l.type === "image") return l.behind ? "Background" : l.lettering ? "Decorative lettering" : "Picture";
  return l.shape === "rect" ? "Rectangle" : l.shape === "ellipse" ? "Ellipse" : "Line";
}

function LayerIcon({ layer }: { layer: Layer }) {
  if (isTextLayer(layer)) return <Type size={12} className="ts-layer-icon" />;
  if (layer.type === "logo") return <Stamp size={12} className="ts-layer-icon" />;
  if (layer.type === "image") return <ImageIcon size={12} className="ts-layer-icon" />;
  if (layer.shape === "ellipse") return <Circle size={12} className="ts-layer-icon" />;
  if (layer.shape === "line") return <Minus size={12} className="ts-layer-icon" />;
  return <Square size={12} className="ts-layer-icon" />;
}

/** The Add menu: a text layer, the client's logo, a picture (product photo, brand asset, upload, a Freepik asset), a shape. */
export function AddLayerMenu({ onAdd, onAddLogo, onAddImage, onAddShape, onUploadGraphic, onAddFreepik, assets }: { onAdd: () => void; onAddLogo?: () => void; onAddImage: (src: string, name?: string, source?: Asset["kind"]) => void; onAddShape: (kind: ShapeKind) => void; onUploadGraphic?: (file: File) => void; /** Opens the Freepik assets picker (admins only for now; the picker says so to a member). */ onAddFreepik?: () => void; assets: Asset[] }) {
  const [open, setOpen] = useState(false);
  const [pictures, setPictures] = useState(false);
  const products = assets.filter((a) => a.kind === "product");
  const brandAssets = assets.filter((a) => a.kind === "brand");
  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
    setPictures(false);
  };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPictures(false); }}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className="ts-mini" title="Add a layer: text, logo, picture or shape">
          <Plus size={12} /> Add
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content className="ts-pop ts-menu ts-add-menu" sideOffset={6} align="end" collisionPadding={12}>
          {!pictures ? (
            <>
              <button type="button" onClick={pick(onAdd)}><Type size={13} /> Text <kbd>T</kbd></button>
              <button type="button" onClick={onAddLogo ? pick(onAddLogo) : undefined} disabled={!onAddLogo} title={onAddLogo ? "The client's logo, as a layer you can move and resize" : "This client has no logo yet"}><Stamp size={13} /> Logo</button>
              <button type="button" onClick={() => setPictures(true)}><ImageIcon size={13} /> Image…</button>
              <hr />
              <button type="button" onClick={pick(() => onAddShape("rect"))}><Square size={13} /> Rectangle</button>
              <button type="button" onClick={pick(() => onAddShape("ellipse"))}><Circle size={13} /> Ellipse</button>
              <button type="button" onClick={pick(() => onAddShape("line"))}><Minus size={13} /> Line</button>
            </>
          ) : (
            <div className="ts-asset-pick">
              <span className="ts-group-title">Product photos</span>
              {!products.length && <p className="ts-empty">No product photos in this month.</p>}
              <div className="ts-asset-grid">
                {products.map((a) => (
                  <button key={a.src} type="button" title={a.name} onClick={pick(() => onAddImage(a.src, a.name, a.kind))}>
                    <img src={a.src} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
              {brandAssets.length > 0 && (
                <>
                  <span className="ts-group-title">Brand assets</span>
                  <div className="ts-asset-grid">
                    {brandAssets.map((a) => (
                      <button key={a.src} type="button" title={a.name} onClick={pick(() => onAddImage(a.src, a.name, a.kind))}>
                        <img src={a.src} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                </>
              )}
              <label className={`ts-font-upload ${onUploadGraphic ? "" : "off"}`} title={onUploadGraphic ? "A PNG, JPG, WebP or SVG graphic, kept with the month" : "Save the month first to upload a graphic"}>
                <Upload size={12} /> Upload a graphic
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden disabled={!onUploadGraphic} onChange={(e) => { const f = e.target.files?.[0]; if (f && onUploadGraphic) pick(() => onUploadGraphic(f))(); e.target.value = ""; }} />
              </label>
              {onAddFreepik && (
                <button type="button" className="ts-link" onClick={pick(onAddFreepik)} title="Freepik icons, photos, backgrounds and lettering, in the Assets panel. Admins only for now.">
                  <Search size={12} /> Freepik assets…
                </button>
              )}
              <button type="button" className="ts-link" onClick={() => setPictures(false)}>Back</button>
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function LayersList({
  layers,
  selected,
  warnings,
  onSelect,
  onChange,
  onReorder,
  onDuplicate,
  onDelete,
  onAdd,
  onAddLogo,
  onAddImage,
  onAddShape,
  onUploadGraphic,
  onAddFreepik,
  assets,
  vectorBar,
}: {
  layers: Layer[];
  selected: string[];
  /** Layer ids whose words read badly over the picture. */
  warnings: Set<string>;
  onSelect: (id: string, add: boolean) => void;
  onChange: (id: string, patch: Partial<Layer>) => void;
  /** Moves the layer at `from` (top-first order) to `to`. */
  onReorder: (from: number, to: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onAddLogo?: () => void;
  onAddImage: (src: string, name?: string, source?: Asset["kind"]) => void;
  onAddShape: (kind: ShapeKind) => void;
  onUploadGraphic?: (file: File) => void;
  onAddFreepik?: () => void;
  assets: Asset[];
  /** The selected vector's actions (Split into layers, Remove background, Merge back), labelled. */
  vectorBar?: React.ReactNode;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // Shown top-first, like every layers panel: the last drawn is the first row.
  const rows = [...layers].reverse();
  return (
    <div className="ts-layers">
      <div className="ts-panel-head">
        <span>Layers</span>
        <AddLayerMenu onAdd={onAdd} onAddLogo={onAddLogo} onAddImage={onAddImage} onAddShape={onAddShape} onUploadGraphic={onUploadGraphic} onAddFreepik={onAddFreepik} assets={assets} />
      </div>
      {vectorBar}
      {!rows.length && <p className="ts-empty">No layers yet. Press T for text, or “Add” for a logo, a picture or a shape.</p>}
      <ul>
        {rows.map((l, i) => {
          const on = selected.includes(l.id);
          const text = isTextLayer(l) ? l : null;
          return (
            <li
              key={l.id}
              className={`ts-layer ${on ? "on" : ""} ${l.hidden ? "hidden" : ""} ${over === i && dragging !== null && dragging !== i ? "over" : ""}`}
              draggable
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) onReorder(dragging, i);
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onClick={(e) => onSelect(l.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              onDoubleClick={() => setRenaming(l.id)}
            >
              <GripVertical size={12} className="ts-grip" />
              <LayerIcon layer={l} />
              {renaming === l.id ? (
                <input
                  autoFocus
                  className="ts-layer-rename"
                  defaultValue={l.name ?? ""}
                  placeholder={text ? text.text.split("\n")[0] : layerLabel(l)}
                  onBlur={(e) => {
                    onChange(l.id, { name: e.target.value.trim() || undefined });
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="ts-layer-name" dir="auto" title="Double-click to rename">
                  {layerLabel(l)}
                </span>
              )}
              {l.type === "image" && l.behind && <span className="ts-layer-bg" title="The background: drawn behind the photo">BG</span>}
              {l.type === "image" && l.source && !l.piece && <SourceBadge source={l.source} compact />}
              {text?.role && <span className="ts-layer-role" title={text.role === "headline" ? "The post's headline" : "The post's second line"}>{text.role === "headline" ? "H" : "2"}</span>}
              {l.type === "image" && l.piece && <span className="ts-layer-piece" title="A piece of a split vector, grouped with the other pieces">Piece</span>}
              {l.group && !(l.type === "image" && l.piece) && <span className="ts-layer-group" title="In a group">G</span>}
              {warnings.has(l.id) && <TriangleAlert size={12} className="ts-layer-warn" aria-label="Low contrast" />}
              <span className="ts-layer-actions" onClick={(e) => e.stopPropagation()}>
                <button type="button" aria-label="Move up" title="Bring forward" disabled={i === 0} onClick={() => onReorder(i, i - 1)}>
                  <ChevronUp size={12} />
                </button>
                <button type="button" aria-label="Move down" title="Send backward" disabled={i === rows.length - 1} onClick={() => onReorder(i, i + 1)}>
                  <ChevronDown size={12} />
                </button>
                <button type="button" aria-label={l.hidden ? "Show" : "Hide"} onClick={() => onChange(l.id, { hidden: !l.hidden || undefined })}>
                  {l.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button type="button" aria-label={l.locked ? "Unlock" : "Lock"} onClick={() => onChange(l.id, { locked: !l.locked || undefined })}>
                  {l.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                </button>
                <button type="button" aria-label="Duplicate" onClick={() => onDuplicate(l.id)}>
                  <Copy size={12} />
                </button>
                <button type="button" aria-label="Delete" className="danger" onClick={() => onDelete(l.id)}>
                  <Trash2 size={12} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ───────────── Layouts ───────────── */

/**
 * The layouts library: whole arrangements drawn as thumbnails over this very picture (the one
 * renderer at a small size), previewed on the stage before anything changes, applied to this
 * design by default and to the month's other designs only after an explicit confirmation.
 */
export function LayoutsList({
  layouts,
  language,
  languageSource,
  thumb,
  cacheKey,
  trialId,
  onPreview,
  onApply,
  onApplyAll,
}: {
  layouts: LayoutPreset[];
  language: ClientLanguage;
  languageSource: LanguageSource;
  /** The layout over this post's picture, as a small JPEG data URL; null when it could not be drawn. */
  thumb: (preset: LayoutPreset) => Promise<string | null>;
  /** Changes when the thumbnails must be drawn again (the words, the picture or the language changed). */
  cacheKey: string;
  /** The layout on the stage right now, when one is being previewed. */
  trialId: string | null;
  onPreview: (preset: LayoutPreset) => void;
  onApply: (preset: LayoutPreset) => void;
  /** Absent when the studio is not open on a month (nothing else to apply to). */
  onApplyAll?: (preset: LayoutPreset) => void;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let alive = true;
    setThumbs({});
    void (async () => {
      // One at a time: each thumbnail loads fonts and draws the picture; a burst would stall the stage.
      for (const l of layouts) {
        const url = await thumb(l).catch(() => null);
        if (!alive) return;
        setThumbs((t) => ({ ...t, [l.id]: url }));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, layouts]);
  const from = languageSource === "post" ? "this post" : languageSource === "month" ? "this month" : languageSource === "brand" ? "the brand kit" : "the studio default";
  return (
    <div className="ts-layouts">
      <div className="ts-panel-head">
        <span>
          <LayoutTemplate size={13} /> Layouts
        </span>
      </div>
      <p className="ts-hint">
        Built for {LANGUAGE_LABELS[language]} (from {from}) in the brand's fonts and colours, with this post's own words. Preview puts one on the picture without changing anything; Apply replaces this design's words, shapes and helpers (pictures you added stay) and ⌘Z brings yours back.
      </p>
      {layouts.map((l) => {
        const t = thumbs[l.id];
        const on = trialId === l.id;
        return (
          <div key={l.id} className={`ts-layout ${on ? "on" : ""}`}>
            <button type="button" className="ts-layout-thumb" onClick={() => onPreview(l)} title={on ? "On the stage now" : "Preview on the picture (nothing changes until you apply)"} aria-pressed={on}>
              {t ? <img src={t} alt={`${l.name} over this picture`} /> : t === null ? <span className="ts-layout-blank">No preview</span> : <span className="ts-layout-blank">Drawing…</span>}
            </button>
            <span className="ts-layout-meta">
              <b>{l.name}</b>
              <small>{l.hint}</small>
              <span className="ts-preset-actions">
                <button type="button" className="ts-link" onClick={() => onPreview(l)}>
                  {on ? "Previewing" : "Preview"}
                </button>
                <button type="button" className="ts-link" onClick={() => onApply(l)} title="Apply to this design only">
                  Apply
                </button>
                {onApplyAll && (
                  <button type="button" className="ts-link" onClick={() => onApplyAll(l)} title="Apply to every design of the month, after a confirmation that says how many change">
                    All designs…
                  </button>
                )}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────── Text styles and saved styles ───────────── */

export function PresetsList({
  brand,
  selected,
  onApply,
  onAddWith,
}: {
  brand: Brand;
  selected: TextLayer | null;
  onApply: (style: Partial<TextLayer>) => void;
  onAddWith: (style: Partial<TextLayer>, name: string) => void;
}) {
  const [saved, setSaved] = useState<SavedStyle[]>(() => savedStyles.list(brand.id));
  const fonts = brandFonts(brand);
  const save = () => {
    if (!selected) return;
    const name = window.prompt("Name this style", selected.name || "My style");
    if (!name?.trim()) return;
    const next = [{ name: name.trim(), style: styleOf(selected) }, ...saved.filter((s) => s.name !== name.trim())];
    savedStyles.save(brand.id, next);
    setSaved(next);
    toast.success(`Style "${name.trim()}" saved for ${brand.name}.`);
  };
  const remove = (name: string) => {
    const next = saved.filter((s) => s.name !== name);
    savedStyles.save(brand.id, next);
    setSaved(next);
  };
  const card = (name: string, hint: string, style: Partial<TextLayer>, onRemove?: () => void) => (
    <div key={name} className="ts-preset">
      <button type="button" className="ts-preset-sample" onClick={() => (selected ? onApply(style) : onAddWith(style, name))} title={selected ? "Apply to the selected layer" : "Add a layer in this style"}>
        <span
          style={{
            fontFamily: `"${style.font ?? "Inter"}", Tajawal, sans-serif`,
            fontWeight: style.weight ?? 700,
            fontStyle: style.italic ? "italic" : "normal",
            letterSpacing: style.letterSpacing ? `${style.letterSpacing}em` : undefined,
            textTransform: style.transform === "upper" ? "uppercase" : undefined,
            color: style.fill?.type === "solid" && (style.fill.alpha ?? 1) > 0 ? style.fill.color : "#fff",
            WebkitTextStroke: style.stroke ? `1px ${style.stroke.color}` : undefined,
            textShadow: style.glow ? `0 0 10px ${style.glow.color}` : style.shadow ? `${style.shadow.x * 10}px ${style.shadow.y * 10}px ${style.shadow.blur * 10}px ${style.shadow.color}` : undefined,
            background: style.background && style.background.alpha > 0 ? style.background.color : undefined,
            borderRadius: style.background ? `${style.background.radius * 6}px` : undefined,
            padding: style.background ? "2px 10px" : undefined,
            transform: style.rotate ? `rotate(${style.rotate}deg)` : undefined,
          }}
        >
          {name}
        </span>
      </button>
      <span className="ts-preset-meta">
        <b>{name}</b>
        <small>{hint}</small>
        <span className="ts-preset-actions">
          <button type="button" className="ts-link" onClick={() => onAddWith(style, name)}>
            Add
          </button>
          {selected && (
            <button type="button" className="ts-link" onClick={() => onApply(style)}>
              Apply
            </button>
          )}
          {onRemove && (
            <button type="button" className="ts-link danger" onClick={onRemove}>
              Remove
            </button>
          )}
        </span>
      </span>
    </div>
  );
  return (
    <div className="ts-presets">
      <div className="ts-panel-head">
        <span>Text styles</span>
        <button type="button" className="ts-mini" onClick={save} disabled={!selected} title="Save the selected layer's look as a reusable style">
          <Plus size={12} /> Save style
        </button>
      </div>
      <p className="ts-hint">The look of one layer: font, colour, outline, glow. Nothing moves. Whole arrangements are under Layouts.</p>
      {saved.length > 0 && (
        <>
          <span className="ts-group-title">Saved for {brand.name}</span>
          {saved.map((s) => card(s.name, "Saved style", s.style, () => remove(s.name)))}
        </>
      )}
      <span className="ts-group-title">{fonts.length ? `Built on ${brand.name}'s fonts` : "Presets"}</span>
      {PRESETS.map((p) => card(p.name, p.hint, p.make(brand)))}
    </div>
  );
}

/* ───────────── Brand assets ───────────── */

export function BrandAssets({ brand, palette, onFont, onColour, onUploadFont }: { brand: Brand; palette: { name: string; hex: string }[]; onFont: (f: string) => void; onColour: (hex: string) => void; onUploadFont?: (file: File) => void }) {
  const fonts = brandFonts(brand);
  return (
    <div className="ts-brand">
      <div className="ts-panel-head">
        <span>Brand assets</span>
      </div>
      <span className="ts-group-title">Fonts</span>
      {!fonts.length && <p className="ts-empty">No brand fonts yet: set them in the Brand kit, or upload a file.</p>}
      {fonts.map((f) => (
        <button key={f} type="button" className="ts-brand-font" style={{ fontFamily: `"${f}", Tajawal, sans-serif` }} onClick={() => onFont(f)} title="Use this font on the selected layer">
          <span>{f}</span>
          <small>{f === brand.fonts.headline ? "Headline" : f === brand.fonts.body ? "Body" : "Uploaded"}</small>
        </button>
      ))}
      {onUploadFont && (
        <label className="ts-font-upload">
          <Plus size={12} /> Upload a brand font
          <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={(e) => e.target.files?.[0] && onUploadFont(e.target.files[0])} />
        </label>
      )}
      <span className="ts-group-title">Colours</span>
      <div className="ts-brand-colours">
        {[...brand.colors, ...palette.filter((p) => !brand.colors.some((c) => c.hex.toLowerCase() === p.hex.toLowerCase()))].map((c, i) => (
          <button key={`${c.hex}${i}`} type="button" className="ts-brand-colour" onClick={() => onColour(c.hex)} title="Use this colour on the selected layer">
            <span style={{ background: c.hex }} />
            <b>{c.name || c.hex}</b>
            <small>{c.hex.toUpperCase()}</small>
          </button>
        ))}
        {!brand.colors.length && !palette.length && <p className="ts-empty">No brand colours yet: add them in the Brand kit or the Colours page.</p>}
      </div>
    </div>
  );
}

/* ───────────── Assistant ───────────── */

export function Assistant({
  batch,
  index,
  text,
  allText,
  compose,
  language,
  onApply,
  onAddLayer,
}: {
  batch: string | null;
  index: number;
  /** The selected layer's words. */
  text: string;
  /** Every layer's words, one per line. */
  allText: string;
  /** The composed post as a JPEG data URL, for the layout judgement. */
  compose: () => Promise<string | null>;
  language?: "ar" | "en" | "both";
  onApply: (text: string) => void;
  onAddLayer: (text: string) => void;
}) {
  const [busy, setBusy] = useState<AssistAction | null>(null);
  const [answer, setAnswer] = useState<{ action: AssistAction; a: AssistAnswer } | null>(null);
  const run = async (action: AssistAction) => {
    if (!batch) {
      toast.error("Save the month first: the assistant works on a saved post.");
      return;
    }
    const words = action === "layout" ? allText : text;
    if (!words.trim()) {
      toast.error(action === "layout" ? "No text on the post yet." : "Select a text layer first.");
      return;
    }
    setBusy(action);
    try {
      const image = action === "layout" ? await compose() : null;
      const a = await post<AssistAnswer>("/api/studio/posts/text-assist", { batch, index, action, text: words, image: image ?? undefined });
      setAnswer({ action, a });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const label = (a: AssistAction) => (a === "translate" ? (language === "en" ? "Translate to Arabic" : language === "ar" ? "Translate to English" : "Translate AR ⇄ EN") : ASSIST_LABELS[a]);
  return (
    <div className="ts-assist">
      <div className="ts-panel-head">
        <span>
          <Sparkles size={13} /> Assistant
        </span>
      </div>
      <p className="ts-hint">Suggestions only: nothing changes until you apply one.</p>
      <div className="ts-assist-actions">
        {ASSIST_ACTIONS.map((a) => (
          <button key={a} type="button" className={`ts-chip ${busy === a ? "busy" : ""}`} disabled={!!busy} onClick={() => void run(a)}>
            {label(a)}
          </button>
        ))}
      </div>
      {busy && <p className="ts-hint">Thinking…</p>}
      {answer && (
        <div className="ts-assist-answer">
          {answer.a.verdict && <p className="ts-verdict" dir="auto">{answer.a.verdict}</p>}
          {answer.a.suggestions.map((s: AssistSuggestion, i: number) => (
            <div key={i} className="ts-suggestion">
              <p dir="auto">{s.text}</p>
              {s.note && <small dir="auto">{s.note}</small>}
              {answer.action !== "layout" && (
                <span className="ts-suggestion-actions">
                  <button type="button" className="ts-mini primary" onClick={() => onApply(s.text)}>
                    Apply
                  </button>
                  <button type="button" className="ts-mini" onClick={() => onAddLayer(s.text)}>
                    Add as layer
                  </button>
                  <button type="button" className="ts-mini" onClick={() => void navigator.clipboard?.writeText(s.text)}>
                    Copy
                  </button>
                </span>
              )}
            </div>
          ))}
          {!answer.a.suggestions.length && !answer.a.verdict && <p className="ts-empty">Nothing came back. Try again.</p>}
        </div>
      )}
    </div>
  );
}
