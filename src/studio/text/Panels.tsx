import { useState } from "react";
import { Copy, Eye, EyeOff, GripVertical, Lock, LockOpen, Plus, Sparkles, Trash2, TriangleAlert, Type } from "lucide-react";
import { toast } from "sonner";
import { post } from "@/api";
import { ASSIST_ACTIONS, ASSIST_LABELS, type AssistAction, type AssistAnswer, type AssistSuggestion } from "@shared/text-assist";
import type { TextLayer } from "@shared/layers";
import { brandFonts, PRESETS, savedStyles, styleOf, type Brand, type SavedStyle } from "./model";

/* ───────────── Layers ───────────── */

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
}: {
  layers: TextLayer[];
  selected: string[];
  /** Layer ids whose words read badly over the picture. */
  warnings: Set<string>;
  onSelect: (id: string, add: boolean) => void;
  onChange: (id: string, patch: Partial<TextLayer>) => void;
  /** Moves the layer at `from` (top-first order) to `to`. */
  onReorder: (from: number, to: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
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
        <button type="button" className="ts-mini" onClick={onAdd} title="Add a text layer (T)">
          <Plus size={12} /> Text
        </button>
      </div>
      {!rows.length && <p className="ts-empty">No text yet. Press T or “Text” to add a layer.</p>}
      <ul>
        {rows.map((l, i) => {
          const on = selected.includes(l.id);
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
              <Type size={12} className="ts-layer-icon" />
              {renaming === l.id ? (
                <input
                  autoFocus
                  className="ts-layer-rename"
                  defaultValue={l.name ?? ""}
                  placeholder={l.text.split("\n")[0]}
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
                  {l.name || l.text.split("\n")[0] || "Empty"}
                </span>
              )}
              {l.group && <span className="ts-layer-group" title="In a group">G</span>}
              {warnings.has(l.id) && <TriangleAlert size={12} className="ts-layer-warn" aria-label="Low contrast" />}
              <span className="ts-layer-actions" onClick={(e) => e.stopPropagation()}>
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

/* ───────────── Presets and saved styles ───────────── */

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
        <span>Styles</span>
        <button type="button" className="ts-mini" onClick={save} disabled={!selected} title="Save the selected layer's look as a reusable style">
          <Plus size={12} /> Save style
        </button>
      </div>
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
