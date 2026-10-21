import { useEffect, useRef, useState } from "react";
import { Pipette, Plus } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { Fill, GradientStop } from "@shared/layers";

/** #rrggbb from any of the three notations; null when it is not a colour. */
export function parseColour(input: string): string | null {
  const s = input.trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m) return `#${m[1].split("").map((c) => c + c).join("")}`;
  m = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/.exec(s);
  if (m) return rgbHex(+m[1], +m[2], +m[3]);
  m = /^hsla?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)%?\s*[, ]\s*(\d+(?:\.\d+)?)%?/.exec(s);
  if (m) {
    const [r, g, b] = hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
    return rgbHex(r, g, b);
  }
  return null;
}

export const rgbHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

interface EyeDropperLike {
  open: () => Promise<{ sRGBHex: string }>;
}

/** CSS for a swatch of a fill. */
export function fillCss(f: Fill): string {
  if (f.type === "solid") return f.color;
  const stops = f.stops.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(", ");
  return f.type === "linear" ? `linear-gradient(${f.angle}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
}

/**
 * A colour (or gradient) field: a swatch that opens a panel with the brand colours first, saved
 * colours, HEX / RGB / HSL inputs, opacity, an eyedropper and a gradient editor.
 */
export default function ColorField({
  value,
  onChange,
  brand,
  saved,
  onSaveColour,
  allowGradient = false,
  onPickFromCanvas,
  label,
  compact = false,
}: {
  value: Fill;
  onChange: (f: Fill) => void;
  brand: { name: string; hex: string }[];
  saved: string[];
  onSaveColour?: (hex: string) => void;
  allowGradient?: boolean;
  /** Starts a pick on the canvas; resolves with the colour under the next click. */
  onPickFromCanvas?: () => Promise<string | null>;
  label: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const solid = value.type === "solid" ? value.color : (value.stops[0]?.color ?? "#ffffff");
  const alpha = value.type === "solid" ? (value.alpha ?? 1) : 1;
  const [hexText, setHexText] = useState(solid);
  const [stopIdx, setStopIdx] = useState(0);
  useEffect(() => setHexText(solid), [solid]);
  const [r, g, b] = hexRgb(solid);
  const [h, s, l] = rgbToHsl(r, g, b);

  const setColour = (hex: string) => {
    if (value.type === "solid") onChange({ ...value, color: hex });
    else {
      const stops = value.stops.map((st, i) => (i === stopIdx ? { ...st, color: hex } : st));
      onChange({ ...value, stops } as Fill);
    }
  };
  const commitHex = () => {
    const c = parseColour(hexText);
    if (c) setColour(c);
    else setHexText(solid);
  };
  const eyedrop = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
    try {
      if (ED) {
        const res = await new ED().open();
        if (res?.sRGBHex) setColour(res.sRGBHex.toLowerCase());
        return;
      }
      if (onPickFromCanvas) {
        setOpen(false);
        const c = await onPickFromCanvas();
        if (c) setColour(c);
      }
    } catch {
      /* cancelled */
    }
  };
  const kind = value.type;
  const setKind = (k: Fill["type"]) => {
    if (k === kind) return;
    if (k === "solid") onChange({ type: "solid", color: solid });
    else {
      const stops: GradientStop[] = value.type === "solid" ? [{ at: 0, color: solid }, { at: 1, color: brand[0]?.hex && brand[0].hex !== solid ? brand[0].hex : "#1129d3" }] : value.stops;
      onChange(k === "linear" ? { type: "linear", angle: value.type === "linear" ? value.angle : 90, stops } : { type: "radial", stops });
    }
  };
  const stops = value.type === "solid" ? [] : value.stops;
  const stopRef = useRef<HTMLDivElement>(null);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={`ts-swatch ${compact ? "compact" : ""}`} aria-label={label} title={label}>
          <span className="ts-swatch-chip" style={{ background: fillCss(value), opacity: alpha }} />
          {!compact && <span className="ts-swatch-text">{value.type === "solid" ? solid.toUpperCase() : value.type === "linear" ? "Linear gradient" : "Radial gradient"}</span>}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content className="ts-pop ts-colour" sideOffset={8} align="start" collisionPadding={12}>
          {allowGradient && (
            <div className="ts-seg">
              {(["solid", "linear", "radial"] as const).map((k) => (
                <button key={k} type="button" className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                  {k === "solid" ? "Solid" : k === "linear" ? "Linear" : "Radial"}
                </button>
              ))}
            </div>
          )}
          {value.type !== "solid" && (
            <div className="ts-gradient">
              <div className="ts-gradient-bar" style={{ background: fillCss({ type: "linear", angle: 90, stops: value.stops }) }} ref={stopRef} onDoubleClick={(e) => {
                const r = stopRef.current!.getBoundingClientRect();
                const at = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                const next = [...value.stops, { at, color: solid }].sort((a, b) => a.at - b.at);
                onChange({ ...value, stops: next } as Fill);
                setStopIdx(next.findIndex((st) => st.at === at));
              }}>
                {value.stops.map((st, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`ts-stop ${i === stopIdx ? "on" : ""}`}
                    style={{ left: `${st.at * 100}%`, background: st.color }}
                    aria-label={`Colour stop ${i + 1}`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setStopIdx(i);
                      const bar = stopRef.current!;
                      const move = (ev: PointerEvent) => {
                        const r = bar.getBoundingClientRect();
                        const at = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
                        onChange({ ...value, stops: value.stops.map((x, k) => (k === i ? { ...x, at } : x)) } as Fill);
                      };
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                  />
                ))}
              </div>
              <div className="ts-row">
                {value.type === "linear" && (
                  <label className="ts-num">
                    <span>Angle</span>
                    <input type="number" value={Math.round(value.angle)} onChange={(e) => onChange({ ...value, angle: Number(e.target.value) || 0 })} />
                  </label>
                )}
                <label className="ts-num">
                  <span>Stop opacity</span>
                  <input type="range" min={0} max={100} value={Math.round((stops[stopIdx]?.alpha ?? 1) * 100)} onChange={(e) => onChange({ ...value, stops: value.stops.map((x, k) => (k === stopIdx ? { ...x, alpha: Number(e.target.value) / 100 } : x)) } as Fill)} />
                </label>
                {stops.length > 2 && (
                  <button type="button" className="ts-mini" onClick={() => {
                    onChange({ ...value, stops: value.stops.filter((_, k) => k !== stopIdx) } as Fill);
                    setStopIdx(0);
                  }}>
                    Remove stop
                  </button>
                )}
              </div>
            </div>
          )}
          {brand.length > 0 && (
            <div className="ts-swatches">
              <span className="ts-swatches-title">Brand</span>
              {brand.map((c, i) => (
                <button key={`${c.hex}${i}`} type="button" className={`ts-dot ${c.hex.toLowerCase() === solid ? "on" : ""}`} style={{ background: c.hex }} title={c.name || c.hex} onClick={() => setColour(c.hex.toLowerCase())} />
              ))}
            </div>
          )}
          <div className="ts-swatches">
            <span className="ts-swatches-title">Saved</span>
            {["#ffffff", "#000000", ...saved].map((c, i) => (
              <button key={`${c}${i}`} type="button" className={`ts-dot ${c === solid ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => setColour(c)} />
            ))}
            {onSaveColour && !saved.includes(solid) && (
              <button type="button" className="ts-dot add" title="Save this colour" onClick={() => onSaveColour(solid)}>
                <Plus size={11} />
              </button>
            )}
          </div>
          <div className="ts-colour-wheel">
            <input type="color" value={solid} onChange={(e) => setColour(e.target.value)} aria-label="Colour picker" />
            <button type="button" className="ts-mini" onClick={() => void eyedrop()} title="Pick a colour from the screen">
              <Pipette size={13} /> Eyedropper
            </button>
          </div>
          <div className="ts-row ts-colour-inputs">
            <label className="ts-num">
              <span>HEX</span>
              <input value={hexText} onChange={(e) => setHexText(e.target.value)} onBlur={commitHex} onKeyDown={(e) => e.key === "Enter" && commitHex()} />
            </label>
            <label className="ts-num"><span>R</span><input type="number" min={0} max={255} value={r} onChange={(e) => setColour(rgbHex(+e.target.value, g, b))} /></label>
            <label className="ts-num"><span>G</span><input type="number" min={0} max={255} value={g} onChange={(e) => setColour(rgbHex(r, +e.target.value, b))} /></label>
            <label className="ts-num"><span>B</span><input type="number" min={0} max={255} value={b} onChange={(e) => setColour(rgbHex(r, g, +e.target.value))} /></label>
          </div>
          <div className="ts-row ts-colour-inputs">
            <label className="ts-num"><span>H</span><input type="number" min={0} max={360} value={Math.round(h)} onChange={(e) => setColour(rgbHex(...hslToRgb(+e.target.value, s, l)))} /></label>
            <label className="ts-num"><span>S</span><input type="number" min={0} max={100} value={Math.round(s * 100)} onChange={(e) => setColour(rgbHex(...hslToRgb(h, +e.target.value / 100, l)))} /></label>
            <label className="ts-num"><span>L</span><input type="number" min={0} max={100} value={Math.round(l * 100)} onChange={(e) => setColour(rgbHex(...hslToRgb(h, s, +e.target.value / 100)))} /></label>
            {value.type === "solid" && (
              <label className="ts-num">
                <span>Opacity</span>
                <input type="number" min={0} max={100} value={Math.round(alpha * 100)} onChange={(e) => onChange({ ...value, alpha: Math.max(0, Math.min(1, +e.target.value / 100)) })} />
              </label>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
