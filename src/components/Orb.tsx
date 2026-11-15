/**
 * The studio's loader: one quiet ring in one colour (15 Nov 2026: it was three animated orbs in
 * blue, lime and mint with glows; the owner asked for something simpler with fewer colours).
 *
 * A thin grey track and one arc turning on it, in the colour of the text around it. The three
 * variants (caption, generate, processing) only choose the words beside the ring; they look the
 * same. A finished wait draws a tick, a failed one a cross. `prefers-reduced-motion` stops the
 * turning and leaves the ring still.
 */
import { useRef } from "react";

export type OrbVariant = "caption" | "generate" | "processing";
export type OrbState = "idle" | "loading" | "success" | "error";

export const ORB_STATUS: Record<OrbVariant, string> = {
  caption: "Writing…",
  generate: "Making it…",
  processing: "Working…",
};

export function Orb({
  variant = "processing",
  size = 16,
  status,
  state = "loading",
  className = "",
  stacked = false,
}: {
  variant?: OrbVariant;
  /** The orb's side in px. Up to 24 it is an inline spinner (no words, no glow). */
  size?: number;
  /** The words beside the orb (the variant's own by default; null for none). */
  status?: string | null;
  state?: OrbState;
  className?: string;
  /** The words under the orb instead of beside it. */
  stacked?: boolean;
}) {
  const inline = size <= 24;
  const words = status === undefined ? ORB_STATUS[variant] : status;
  const reduce = useReducedMotion();
  const title = state === "success" ? "Done" : state === "error" ? "Something went wrong" : (words ?? ORB_STATUS[variant]);
  return (
    <span className={`orb orb-${variant} orb-${state} ${inline ? "orb-inline" : "orb-block"} ${stacked ? "orb-stacked" : ""} ${className}`} role="status" aria-live="polite" aria-label={title} style={{ "--orb": `${size}px` } as React.CSSProperties}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false">
        <g className={`orb-scene${reduce ? " orb-still" : ""}`}>
          <circle className="orb-track" cx="50" cy="50" r="40" strokeWidth={inline ? 12 : 7} />
          <circle className="orb-arc" cx="50" cy="50" r="40" strokeWidth={inline ? 12 : 7} pathLength="100" />
        </g>

        {/* The outcome: a filled disc with a tick or a cross, drawn in when the state changes. */}
        <g className="orb-outcome">
          <circle className="orb-outcome-disc" cx="50" cy="50" r="34" />
          <path className="orb-outcome-tick" d="M32 51 L45 63 L69 38" pathLength="1" />
          <path className="orb-outcome-cross" d="M38 38 L62 62 M62 38 L38 62" pathLength="1" />
        </g>
      </svg>
      {!inline && words && <span className="orb-status">{state === "success" ? "Done" : state === "error" ? "Something went wrong" : words}</span>}
    </span>
  );
}

function useReducedMotion(): boolean {
  const ref = useRef(typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false);
  return ref.current;
}

export default Orb;
