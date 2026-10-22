/**
 * The Frame control of Generate (the Video studio) and of the Video dialog: Reel 9:16 (the default),
 * Portrait 4:5, Square 1:1, Landscape 16:9, with the fill for engines that follow the picture's
 * frame (crop to fit, or blur the edges) and one line saying how the chosen engine gets the frame.
 * The last choice is remembered per month (`useFrameChoice`). The maths and words live in
 * shared/video-frame.ts; the composing in src/video-editor/frame.ts.
 */
import { useEffect, useState } from "react";
import { DEFAULT_FILL, DEFAULT_FRAME, FILLS, FRAMES, frameLabel, frameRoute, frameRouteLine, frameStorageKey, parseFrameChoice, type FrameChoice, type FrameFill, type FrameId } from "@shared/video-frame";

/** The frame and fill for a month, from the browser's memory (the defaults when none), written back on each change. */
export function useFrameChoice(batch: string | null | undefined): [FrameChoice, (c: Partial<FrameChoice>) => void] {
  const read = (): FrameChoice => {
    if (!batch) return { frame: DEFAULT_FRAME, fill: DEFAULT_FILL };
    try {
      return parseFrameChoice(localStorage.getItem(frameStorageKey(batch)));
    } catch {
      return { frame: DEFAULT_FRAME, fill: DEFAULT_FILL };
    }
  };
  const [choice, setChoice] = useState<FrameChoice>(read);
  useEffect(() => {
    setChoice(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch]);
  const update = (c: Partial<FrameChoice>) => {
    setChoice((cur) => {
      const next = { ...cur, ...c };
      if (batch) {
        try {
          localStorage.setItem(frameStorageKey(batch), JSON.stringify(next));
        } catch {
          /* private mode: the choice lasts the session */
        }
      }
      return next;
    });
  };
  return [choice, update];
}

interface Props {
  frame: FrameId;
  fill: FrameFill;
  onChange: (c: Partial<FrameChoice>) => void;
  /** The engine the frame goes to, and its frame options (null or [] when it follows the picture). */
  engine: { name: string; aspects: readonly string[] | null | undefined } | null;
  disabled?: boolean;
  /** "studio" draws with the Video studio's classes; "dialog" with the post dialog's. */
  variant: "studio" | "dialog";
}

export default function FrameControl({ frame, fill, onChange, engine, disabled, variant }: Props) {
  const route = engine ? frameRoute(frame, engine.aspects) : { aspect: undefined, compose: true };
  const studio = variant === "studio";
  return (
    <div className={studio ? "vs-framectl" : "video-frame"} data-frame={frame} data-fill={route.compose ? fill : "engine"}>
      <div className={studio ? "vs-seg vs-framectl-seg" : "preset-row video-frame-row"} role="radiogroup" aria-label="Frame">
        {FRAMES.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={frame === f.id} className={studio ? (frame === f.id ? "on" : "") : `format-chip ${frame === f.id ? "active" : ""}`} disabled={disabled} title={f.hint} onClick={() => onChange({ frame: f.id })}>
            {studio ? (
              <>
                {f.name} <small>{f.id}</small>
              </>
            ) : (
              <>
                <strong>{f.name}</strong>
                <small>{f.id}</small>
              </>
            )}
          </button>
        ))}
      </div>
      {route.compose && (
        <label className={studio ? "vs-framectl-fill" : "video-frame-fill"}>
          <span>Fill</span>
          <select value={fill} disabled={disabled} onChange={(e) => onChange({ fill: e.target.value as FrameFill })} aria-label="How the picture fills the frame">
            {FILLS.map((x) => (
              <option key={x.id} value={x.id} title={x.hint}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <small className={studio ? "ts-hint vs-framectl-note" : "field-hint video-frame-note"}>{engine ? frameRouteLine(engine.name, frame, engine.aspects, fill) : `${frameLabel(frame)}: the engine takes the frame when it has that option; otherwise the picture is made ${frameLabel(frame)} here first.`}</small>
    </div>
  );
}
