import { useState } from "react";
import { AlignCenter, AlignHorizontalDistributeCenter, AlignJustify, AlignLeft, AlignRight, AlignVerticalDistributeCenter, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Bold, CaseSensitive, Italic, List, ListOrdered, Strikethrough, Superscript, Subscript, TriangleAlert, Underline } from "lucide-react";
import type { CanvasFx, Fill, TextLayer } from "@shared/layers";
import { BLEND_MODES } from "@shared/layers";
import ColorField from "./ColorField";
import FontMenu from "./FontMenu";
import { brandFonts, onPalette, type Brand } from "./model";

export interface Selection {
  layer: TextLayer | null;
  count: number;
  /** Contrast of the layer's colour over the picture (WCAG ratio). */
  contrast: number | null;
}

export type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdist" | "vdist";

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

function Num({ label, value, onChange, min, max, step = 1, unit, title }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; unit?: string; title?: string }) {
  return (
    <label className="ts-num" title={title}>
      <span>{label}</span>
      <span className="ts-num-wrap">
        <input type="number" value={Number.isFinite(value) ? value : 0} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, format }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; format?: (n: number) => string }) {
  return (
    <label className="ts-slider">
      <span>
        {label} <em>{format ? format(value) : value}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Toggle({ on, label, onChange, children }: { on: boolean; label: string; onChange: (on: boolean) => void; children?: React.ReactNode }) {
  return (
    <div className={`ts-effect ${on ? "on" : ""}`}>
      <label className="ts-toggle">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {on && <div className="ts-effect-body">{children}</div>}
    </div>
  );
}

export default function Properties({
  sel,
  onChange,
  onRich,
  brand,
  palette,
  saved,
  onSaveColour,
  pickFromCanvas,
  canvasFx,
  onCanvasFx,
  onAlign,
  onUploadFont,
  W,
  richActive,
}: {
  sel: Selection;
  /** Applies to every selected layer. */
  onChange: (patch: Partial<TextLayer>) => void;
  /** Bold / italic / underline / strike / script / colour on the selected words (or the whole layer). */
  onRich: (what: "bold" | "italic" | "underline" | "strike" | "super" | "sub" | "highlight", value?: string) => void;
  brand: Brand;
  palette: { name: string; hex: string }[];
  saved: string[];
  onSaveColour: (hex: string) => void;
  pickFromCanvas: () => Promise<string | null>;
  canvasFx: CanvasFx | undefined;
  onCanvasFx: (fx: CanvasFx | undefined) => void;
  onAlign: (how: Align) => void;
  onUploadFont?: (file: File) => void;
  /** Canvas width in pixels, so sizes read in pixels at export size. */
  W: number;
  /** Which rich styles are on at the caret / selection. */
  richActive: { bold: boolean; italic: boolean; underline: boolean; strike: boolean; script: "super" | "sub" | null };
}) {
  const l = sel.layer;
  const fonts = brandFonts(brand);
  const swatches = [...brand.colors, ...palette.filter((p) => !brand.colors.some((c) => c.hex.toLowerCase() === p.hex.toLowerCase()))];
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const px = (f: number) => Math.round(f * W);
  const fromPx = (n: number) => n / W;
  if (!l) {
    return (
      <div className="ts-props">
        <details open>
          <summary>Picture</summary>
          <CanvasSection fx={canvasFx} onChange={onCanvasFx} brand={swatches} saved={saved} onSaveColour={onSaveColour} pickFromCanvas={pickFromCanvas} />
        </details>
        <p className="ts-hint">Select a layer to edit its type, colours and effects. Double-click a layer on the picture to type in it.</p>
      </div>
    );
  }
  const solidColour = l.fill.type === "solid" ? l.fill.color : l.fill.stops[0]?.color ?? "#ffffff";
  const offBrandFont = fonts.length > 0 && !fonts.includes(l.font);
  const offPalette = swatches.length > 0 && !onPalette(solidColour, swatches.map((c) => c.hex));
  const lowContrast = sel.contrast !== null && sel.contrast < 3;
  const multi = sel.count > 1;
  return (
    <div className="ts-props">
      {multi && (
        <div className="ts-align-row">
          <span className="ts-group-title">Align {sel.count} layers</span>
          <div className="ts-icons">
            <button type="button" title="Align left edges" onClick={() => onAlign("left")}><ArrowLeftToLine size={14} /></button>
            <button type="button" title="Align centres" onClick={() => onAlign("hcenter")}><AlignCenter size={14} /></button>
            <button type="button" title="Align right edges" onClick={() => onAlign("right")}><ArrowRightToLine size={14} /></button>
            <button type="button" title="Align top edges" onClick={() => onAlign("top")}><ArrowUpToLine size={14} /></button>
            <button type="button" title="Align middles" onClick={() => onAlign("vcenter")}><AlignJustify size={14} /></button>
            <button type="button" title="Align bottom edges" onClick={() => onAlign("bottom")}><ArrowDownToLine size={14} /></button>
            <button type="button" title="Distribute horizontally" onClick={() => onAlign("hdist")}><AlignHorizontalDistributeCenter size={14} /></button>
            <button type="button" title="Distribute vertically" onClick={() => onAlign("vdist")}><AlignVerticalDistributeCenter size={14} /></button>
          </div>
        </div>
      )}
      {(lowContrast || offBrandFont || offPalette) && (
        <div className="ts-warnings">
          {lowContrast && (
            <p>
              <TriangleAlert size={12} /> Low contrast over the picture ({sel.contrast!.toFixed(1)}:1).{" "}
              <button type="button" className="ts-link" onClick={() => onChange({ background: { color: luminanceOf(solidColour) > 0.5 ? "#000000" : "#ffffff", alpha: 0.35, padding: 0.4, radius: 0.4, blur: 12 } })}>
                Add a backing
              </button>{" "}
              <button type="button" className="ts-link" onClick={() => onCanvasFx({ ...(canvasFx ?? {}), gradient: { color: "#000000", angle: 180, from: 0, to: 0.65 } })}>
                Darken the bottom
              </button>
            </p>
          )}
          {offBrandFont && (
            <p>
              <TriangleAlert size={12} /> {l.font} is not a brand font.{" "}
              <button type="button" className="ts-link" onClick={() => onChange({ font: l.role === "subline" ? (brand.fonts.body ?? fonts[0]) : fonts[0] })}>
                Use {l.role === "subline" ? (brand.fonts.body ?? fonts[0]) : fonts[0]}
              </button>
            </p>
          )}
          {offPalette && (
            <p>
              <TriangleAlert size={12} /> {solidColour.toUpperCase()} is not a brand colour.{" "}
              <button type="button" className="ts-link" onClick={() => onChange({ fill: { type: "solid", color: swatches[0].hex } })}>
                Use {swatches[0].name || swatches[0].hex}
              </button>
            </p>
          )}
        </div>
      )}
      <details open>
        <summary>Text</summary>
        <textarea className="ts-text" dir="auto" rows={3} value={l.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="Type the words…" />
        <div className="ts-icons wrap">
          <button type="button" className={richActive.bold ? "on" : ""} title="Bold (⌘B)" onClick={() => onRich("bold")}><Bold size={14} /></button>
          <button type="button" className={richActive.italic ? "on" : ""} title="Italic (⌘I)" onClick={() => onRich("italic")}><Italic size={14} /></button>
          <button type="button" className={richActive.underline ? "on" : ""} title="Underline (⌘U)" onClick={() => onRich("underline")}><Underline size={14} /></button>
          <button type="button" className={richActive.strike ? "on" : ""} title="Strikethrough" onClick={() => onRich("strike")}><Strikethrough size={14} /></button>
          <button type="button" className={richActive.script === "super" ? "on" : ""} title="Superscript" onClick={() => onRich("super")}><Superscript size={14} /></button>
          <button type="button" className={richActive.script === "sub" ? "on" : ""} title="Subscript" onClick={() => onRich("sub")}><Subscript size={14} /></button>
          <span className="ts-sep" />
          <select value={l.transform ?? "none"} onChange={(e) => onChange({ transform: e.target.value as TextLayer["transform"] })} title="Case">
            <option value="none">As typed</option>
            <option value="upper">UPPER</option>
            <option value="lower">lower</option>
            <option value="title">Title Case</option>
          </select>
          <button type="button" className={l.list === "bullet" ? "on" : ""} title="Bulleted list" onClick={() => onChange({ list: l.list === "bullet" ? "none" : "bullet" })}><List size={14} /></button>
          <button type="button" className={l.list === "number" ? "on" : ""} title="Numbered list" onClick={() => onChange({ list: l.list === "number" ? "none" : "number" })}><ListOrdered size={14} /></button>
        </div>
        <p className="ts-hint">Select words in the box on the picture, then press B, I or a colour to style only them.</p>
        <details className="ts-sub">
          <summary>Find and replace</summary>
          <div className="ts-row">
            <input placeholder="Find" value={findText} onChange={(e) => setFindText(e.target.value)} dir="auto" />
            <input placeholder="Replace with" value={replaceText} onChange={(e) => setReplaceText(e.target.value)} dir="auto" />
            <button type="button" className="ts-mini" disabled={!findText} onClick={() => window.dispatchEvent(new CustomEvent("ts-replace", { detail: { find: findText, replace: replaceText } }))}>
              Replace all
            </button>
          </div>
        </details>
      </details>

      <details open>
        <summary>Font</summary>
        <FontMenu value={l.font} brand={fonts} onChange={(font) => onChange({ font })} onUpload={onUploadFont} />
        <div className="ts-row">
          <label className="ts-num">
            <span>Weight</span>
            <select value={WEIGHTS.includes(l.weight) ? l.weight : 400} onChange={(e) => onChange({ weight: Number(e.target.value) })}>
              {WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  {w} {w === 100 ? "Thin" : w === 300 ? "Light" : w === 400 ? "Regular" : w === 500 ? "Medium" : w === 600 ? "Semibold" : w === 700 ? "Bold" : w === 800 ? "Extra bold" : w === 900 ? "Black" : ""}
                </option>
              ))}
            </select>
          </label>
          <Num label="Size" value={px(l.size)} onChange={(n) => onChange({ size: Math.max(0.005, fromPx(n)) })} min={6} max={W} unit="px" title="At the export width" />
          <label className="ts-toggle inline">
            <input type="checkbox" checked={!!l.italic} onChange={(e) => onChange({ italic: e.target.checked || undefined })} />
            <span>Italic</span>
          </label>
        </div>
        <Slider label="Weight" value={l.weight} min={100} max={900} step={100} onChange={(weight) => onChange({ weight })} />
      </details>

      <details open>
        <summary>Spacing</summary>
        <Slider label="Line height" value={l.lineHeight} min={0.7} max={2.5} step={0.05} onChange={(lineHeight) => onChange({ lineHeight })} format={(n) => n.toFixed(2)} />
        <Slider label="Letter spacing" value={l.letterSpacing ?? 0} min={-0.1} max={0.6} step={0.01} onChange={(v) => onChange({ letterSpacing: v || undefined })} format={(n) => `${Math.round(n * 100)}`} />
        <Slider label="Word spacing" value={l.wordSpacing ?? 0} min={-0.2} max={1.5} step={0.05} onChange={(v) => onChange({ wordSpacing: v || undefined })} format={(n) => n.toFixed(2)} />
        <Slider label="Paragraph spacing" value={l.paragraphSpacing ?? 0} min={0} max={2} step={0.05} onChange={(v) => onChange({ paragraphSpacing: v || undefined })} format={(n) => n.toFixed(2)} />
        <div className="ts-row">
          <Num label="Indent" value={Math.round((l.indent ?? 0) * 100) / 100} onChange={(n) => onChange({ indent: n || undefined })} min={0} max={4} step={0.1} unit="em" />
          <Num label="Padding" value={Math.round((l.padding ?? 0) * 100) / 100} onChange={(n) => onChange({ padding: n || undefined })} min={0} max={2} step={0.1} unit="em" />
        </div>
      </details>

      <details open>
        <summary>Paragraph</summary>
        <div className="ts-icons">
          <button type="button" className={l.align === "left" ? "on" : ""} title="Align left" onClick={() => onChange({ align: "left" })}><AlignLeft size={14} /></button>
          <button type="button" className={l.align === "center" ? "on" : ""} title="Centre" onClick={() => onChange({ align: "center" })}><AlignCenter size={14} /></button>
          <button type="button" className={l.align === "right" ? "on" : ""} title="Align right" onClick={() => onChange({ align: "right" })}><AlignRight size={14} /></button>
          <button type="button" className={l.align === "justify" ? "on" : ""} title="Justify" onClick={() => onChange({ align: "justify" })}><AlignJustify size={14} /></button>
          <span className="ts-sep" />
          <select value={l.vAlign ?? "top"} onChange={(e) => onChange({ vAlign: e.target.value as TextLayer["vAlign"] })} title="Vertical alignment in a fixed box">
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
          <select value={l.direction ?? "auto"} onChange={(e) => onChange({ direction: e.target.value as TextLayer["direction"] })} title="Reading direction">
            <option value="auto">Auto direction</option>
            <option value="rtl">Right to left</option>
            <option value="ltr">Left to right</option>
          </select>
        </div>
        <div className="ts-seg">
          <button type="button" className={l.autoSize !== false ? "on" : ""} onClick={() => onChange({ autoSize: true, fit: undefined })} title="The box grows with the words">Auto height</button>
          <button type="button" className={l.autoSize === false && !l.fit ? "on" : ""} onClick={() => onChange({ autoSize: false, fit: undefined, h: l.h ?? 0.2 })} title="A fixed box the words wrap in">Fixed box</button>
          <button type="button" className={l.autoSize === false && l.fit ? "on" : ""} onClick={() => onChange({ autoSize: false, fit: true, h: l.h ?? 0.2 })} title="The words shrink to fit the box">Fit to box</button>
        </div>
      </details>

      <details open>
        <summary>Colour</summary>
        <ColorField label="Text colour" value={l.fill} onChange={(fill: Fill) => onChange({ fill })} brand={swatches} saved={saved} onSaveColour={onSaveColour} allowGradient onPickFromCanvas={pickFromCanvas} />
        <div className="ts-row">
          <span className="ts-label">Highlight the selected words</span>
          <ColorField compact label="Highlight colour" value={{ type: "solid", color: brand.colors[0]?.hex ?? "#ffe600" }} onChange={(f) => f.type === "solid" && onRich("highlight", f.color)} brand={swatches} saved={saved} />
        </div>
        <Slider label="Layer opacity" value={Math.round((l.opacity ?? 1) * 100)} min={0} max={100} onChange={(v) => onChange({ opacity: v === 100 ? undefined : v / 100 })} format={(n) => `${n}%`} />
        <label className="ts-num">
          <span>Blend</span>
          <select value={l.blend ?? "normal"} onChange={(e) => onChange({ blend: e.target.value === "normal" ? undefined : e.target.value })}>
            {BLEND_MODES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </details>

      <details>
        <summary>Background box</summary>
        <Toggle on={!!l.background} label="Box behind the words" onChange={(on) => onChange({ background: on ? { color: "#000000", alpha: 0.4, padding: 0.4, radius: 0.4 } : undefined })}>
          {l.background && (
            <>
              <div className="ts-row">
                <ColorField label="Box colour" value={{ type: "solid", color: l.background.color }} onChange={(f) => f.type === "solid" && onChange({ background: { ...l.background!, color: f.color } })} brand={swatches} saved={saved} onSaveColour={onSaveColour} />
              </div>
              <Slider label="Opacity" value={Math.round(l.background.alpha * 100)} min={0} max={100} onChange={(v) => onChange({ background: { ...l.background!, alpha: v / 100 } })} format={(n) => `${n}%`} />
              <Slider label="Padding" value={l.background.padding} min={0} max={2} step={0.05} onChange={(v) => onChange({ background: { ...l.background!, padding: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Corner radius" value={l.background.radius} min={0} max={3} step={0.05} onChange={(v) => onChange({ background: { ...l.background!, radius: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Blur behind" value={l.background.blur ?? 0} min={0} max={40} onChange={(v) => onChange({ background: { ...l.background!, blur: v || undefined } })} format={(n) => `${n}px`} />
            </>
          )}
        </Toggle>
      </details>

      <details>
        <summary>Effects</summary>
        <Toggle on={!!l.shadow} label="Drop shadow" onChange={(on) => onChange({ shadow: on ? { color: "#000000", blur: 0.3, x: 0.05, y: 0.08, alpha: 0.6 } : undefined })}>
          {l.shadow && (
            <>
              <ColorField label="Shadow colour" value={{ type: "solid", color: l.shadow.color }} onChange={(f) => f.type === "solid" && onChange({ shadow: { ...l.shadow!, color: f.color } })} brand={swatches} saved={saved} />
              <Slider label="Blur" value={l.shadow.blur} min={0} max={2} step={0.05} onChange={(v) => onChange({ shadow: { ...l.shadow!, blur: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Offset X" value={l.shadow.x} min={-1} max={1} step={0.01} onChange={(v) => onChange({ shadow: { ...l.shadow!, x: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Offset Y" value={l.shadow.y} min={-1} max={1} step={0.01} onChange={(v) => onChange({ shadow: { ...l.shadow!, y: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Opacity" value={Math.round((l.shadow.alpha ?? 1) * 100)} min={0} max={100} onChange={(v) => onChange({ shadow: { ...l.shadow!, alpha: v / 100 } })} format={(n) => `${n}%`} />
            </>
          )}
        </Toggle>
        <Toggle on={!!l.innerShadow} label="Inner shadow" onChange={(on) => onChange({ innerShadow: on ? { color: "#000000", blur: 0.15, x: 0.04, y: 0.04, alpha: 0.7 } : undefined })}>
          {l.innerShadow && (
            <>
              <ColorField label="Inner shadow colour" value={{ type: "solid", color: l.innerShadow.color }} onChange={(f) => f.type === "solid" && onChange({ innerShadow: { ...l.innerShadow!, color: f.color } })} brand={swatches} saved={saved} />
              <Slider label="Blur" value={l.innerShadow.blur} min={0} max={1} step={0.02} onChange={(v) => onChange({ innerShadow: { ...l.innerShadow!, blur: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Offset" value={l.innerShadow.y} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ innerShadow: { ...l.innerShadow!, x: v, y: v } })} format={(n) => n.toFixed(2)} />
            </>
          )}
        </Toggle>
        <Toggle on={!!l.stroke} label="Stroke (outline)" onChange={(on) => onChange({ stroke: on ? { color: "#000000", width: 0.04 } : undefined })}>
          {l.stroke && (
            <>
              <ColorField label="Stroke colour" value={{ type: "solid", color: l.stroke.color }} onChange={(f) => f.type === "solid" && onChange({ stroke: { ...l.stroke!, color: f.color } })} brand={swatches} saved={saved} />
              <Slider label="Width" value={l.stroke.width} min={0.005} max={0.3} step={0.005} onChange={(v) => onChange({ stroke: { ...l.stroke!, width: v } })} format={(n) => n.toFixed(3)} />
              <div className="ts-seg">
                <button type="button" className={l.stroke.outside !== false ? "on" : ""} onClick={() => onChange({ stroke: { ...l.stroke!, outside: undefined } })}>Outside</button>
                <button type="button" className={l.stroke.outside === false ? "on" : ""} onClick={() => onChange({ stroke: { ...l.stroke!, outside: false } })}>Centre</button>
              </div>
            </>
          )}
        </Toggle>
        <Toggle on={!!l.glow} label="Glow / neon" onChange={(on) => onChange({ glow: on ? { color: solidColour === "#ffffff" ? "#ff3fa4" : solidColour, blur: 0.4, strength: 2 } : undefined })}>
          {l.glow && (
            <>
              <ColorField label="Glow colour" value={{ type: "solid", color: l.glow.color }} onChange={(f) => f.type === "solid" && onChange({ glow: { ...l.glow!, color: f.color } })} brand={swatches} saved={saved} />
              <Slider label="Spread" value={l.glow.blur} min={0.05} max={2} step={0.05} onChange={(v) => onChange({ glow: { ...l.glow!, blur: v } })} format={(n) => n.toFixed(2)} />
              <Slider label="Strength" value={l.glow.strength ?? 2} min={1} max={5} onChange={(v) => onChange({ glow: { ...l.glow!, strength: v } })} />
            </>
          )}
        </Toggle>
        <Toggle on={!!l.blur} label="Blur the letters" onChange={(on) => onChange({ blur: on ? 0.05 : undefined })}>
          {l.blur !== undefined && <Slider label="Blur" value={l.blur} min={0.01} max={0.5} step={0.01} onChange={(v) => onChange({ blur: v })} format={(n) => n.toFixed(2)} />}
        </Toggle>
        <Toggle on={!!l.curve} label="Curve the text" onChange={(on) => onChange({ curve: on ? 45 : undefined })}>
          {!!l.curve && <Slider label="Arc" value={l.curve} min={-180} max={180} step={1} onChange={(v) => onChange({ curve: v || 1 })} format={(n) => `${n}°`} />}
        </Toggle>
        <div className="ts-row">
          <Num label="Rotate" value={Math.round(l.rotate ?? 0)} onChange={(n) => onChange({ rotate: n || undefined })} min={-360} max={360} unit="°" />
          <Num label="Skew" value={Math.round(l.skew ?? 0)} onChange={(n) => onChange({ skew: n || undefined })} min={-60} max={60} unit="°" />
        </div>
        <div className="ts-seg">
          <button type="button" onClick={() => onChange({ curve: 60, skew: undefined })}>Arc up</button>
          <button type="button" onClick={() => onChange({ curve: -60, skew: undefined })}>Arc down</button>
          <button type="button" onClick={() => onChange({ skew: -14, curve: undefined })}>Flag</button>
          <button type="button" onClick={() => onChange({ skew: undefined, curve: undefined, rotate: undefined })}>Straight</button>
        </div>
      </details>

      <details>
        <summary>Position and size</summary>
        <div className="ts-row four">
          <Num label="X" value={px(l.x)} onChange={(n) => onChange({ x: fromPx(n) })} unit="px" />
          <Num label="Y" value={Math.round(l.y * 1000) / 10} onChange={(n) => onChange({ y: n / 100 })} unit="%" title="Of the height" />
          <Num label="W" value={px(l.w)} onChange={(n) => onChange({ w: Math.max(0.02, fromPx(n)) })} unit="px" />
          <Num label="H" value={l.h !== undefined ? Math.round(l.h * 1000) / 10 : 0} onChange={(n) => onChange({ h: n / 100, autoSize: false })} unit="%" title="Of the height (fixed box)" />
        </div>
        <div className="ts-row">
          <label className="ts-toggle inline">
            <input type="checkbox" checked={!!l.locked} onChange={(e) => onChange({ locked: e.target.checked || undefined })} />
            <span>Locked</span>
          </label>
          <label className="ts-toggle inline">
            <input type="checkbox" checked={!!l.hidden} onChange={(e) => onChange({ hidden: e.target.checked || undefined })} />
            <span>Hidden</span>
          </label>
          <label className="ts-num">
            <span>Role</span>
            <select value={l.role ?? ""} onChange={(e) => onChange({ role: (e.target.value || undefined) as TextLayer["role"] })} title="The headline and second line are what the captions and checks read">
              <option value="">—</option>
              <option value="headline">Headline</option>
              <option value="subline">Second line</option>
            </select>
          </label>
        </div>
      </details>

      <details>
        <summary>Picture</summary>
        <CanvasSection fx={canvasFx} onChange={onCanvasFx} brand={swatches} saved={saved} onSaveColour={onSaveColour} pickFromCanvas={pickFromCanvas} />
      </details>
      <span className="ts-case-hint">
        <CaseSensitive size={12} /> Sizes are at the export width ({W}px).
      </span>
    </div>
  );
}

function luminanceOf(hex: string): number {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function CanvasSection({ fx, onChange, brand, saved, onSaveColour, pickFromCanvas }: { fx: CanvasFx | undefined; onChange: (fx: CanvasFx | undefined) => void; brand: { name: string; hex: string }[]; saved: string[]; onSaveColour: (hex: string) => void; pickFromCanvas: () => Promise<string | null> }) {
  const set = (patch: Partial<CanvasFx>) => {
    const next = { ...(fx ?? {}), ...patch };
    for (const k of Object.keys(next) as (keyof CanvasFx)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="ts-canvas-fx">
      <p className="ts-hint">Helpers for readability, over the picture and under the words. The picture itself is never changed.</p>
      <Toggle on={!!fx?.gradient} label="Fade from one edge" onChange={(on) => set({ gradient: on ? { color: "#000000", angle: 180, from: 0, to: 0.6 } : undefined })}>
        {fx?.gradient && (
          <>
            <ColorField label="Fade colour" value={{ type: "solid", color: fx.gradient.color }} onChange={(f) => f.type === "solid" && set({ gradient: { ...fx.gradient!, color: f.color } })} brand={brand} saved={saved} onSaveColour={onSaveColour} onPickFromCanvas={pickFromCanvas} />
            <div className="ts-seg">
              {[
                ["Bottom", 180],
                ["Top", 0],
                ["Left", 270],
                ["Right", 90],
              ].map(([name, angle]) => (
                <button key={name} type="button" className={fx.gradient!.angle === angle ? "on" : ""} onClick={() => set({ gradient: { ...fx.gradient!, angle: angle as number } })}>
                  {name}
                </button>
              ))}
            </div>
            <Slider label="Strength" value={Math.round(fx.gradient.to * 100)} min={0} max={100} onChange={(v) => set({ gradient: { ...fx.gradient!, to: v / 100 } })} format={(n) => `${n}%`} />
            <Slider label="Reach (from the far edge)" value={Math.round(fx.gradient.from * 100)} min={0} max={100} onChange={(v) => set({ gradient: { ...fx.gradient!, from: v / 100 } })} format={(n) => `${n}%`} />
          </>
        )}
      </Toggle>
      <Toggle on={!!fx?.overlay} label="Colour wash over the whole picture" onChange={(on) => set({ overlay: on ? { color: "#000000", alpha: 0.25 } : undefined })}>
        {fx?.overlay && (
          <>
            <ColorField label="Wash colour" value={{ type: "solid", color: fx.overlay.color }} onChange={(f) => f.type === "solid" && set({ overlay: { ...fx.overlay!, color: f.color } })} brand={brand} saved={saved} onSaveColour={onSaveColour} onPickFromCanvas={pickFromCanvas} />
            <Slider label="Opacity" value={Math.round(fx.overlay.alpha * 100)} min={0} max={100} onChange={(v) => set({ overlay: { ...fx.overlay!, alpha: v / 100 } })} format={(n) => `${n}%`} />
          </>
        )}
      </Toggle>
      <Toggle on={!!fx?.blur} label="Blur the picture" onChange={(on) => set({ blur: on ? 8 : undefined })}>
        {!!fx?.blur && <Slider label="Blur" value={fx.blur} min={1} max={40} onChange={(v) => set({ blur: v })} format={(n) => `${n}px`} />}
      </Toggle>
    </div>
  );
}
