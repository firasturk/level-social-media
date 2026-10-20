/**
 * The studio's loading orbs: one component, three animations, all real geometry.
 *
 *  - caption:    luminous ribbons that keep morphing (SMIL path morphs), for words being written.
 *  - generate:   three liquid blobs that merge, separate and turn (a gooey SVG filter), for pictures
 *                and videos being made.
 *  - processing: three thin glowing orbits turning at their own speeds and gently deforming, for
 *                any other wait.
 *
 * Everything is SVG with CSS keyframes and SMIL, so it runs on the compositor at 60 fps without a
 * JavaScript loop; `prefers-reduced-motion` pauses it (the SMIL morphs too) and leaves a soft
 * breathing glow. A small size (a button's spinner) draws the shapes without glow filters.
 */
import { useEffect, useId, useRef } from "react";

export type OrbVariant = "caption" | "generate" | "processing";
export type OrbState = "idle" | "loading" | "success" | "error";

export const ORB_STATUS: Record<OrbVariant, string> = {
  caption: "Crafting your caption…",
  generate: "Bringing your vision to life…",
  processing: "Working on it…",
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
  const svg = useRef<SVGSVGElement>(null);
  const id = useId().replace(/:/g, "");
  const inline = size <= 24;
  const words = status === undefined ? ORB_STATUS[variant] : status;
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof el.pauseAnimations !== "function") return;
    if (reduce || state !== "loading") el.pauseAnimations();
    else el.unpauseAnimations();
  }, [reduce, state]);
  const title = state === "success" ? "Done" : state === "error" ? "Something went wrong" : (words ?? ORB_STATUS[variant]);
  return (
    <span className={`orb orb-${variant} orb-${state} ${inline ? "orb-inline" : "orb-block"} ${stacked ? "orb-stacked" : ""} ${className}`} role="status" aria-live="polite" aria-label={title} style={{ "--orb": `${size}px` } as React.CSSProperties}>
      <svg ref={svg} viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false">
        <defs>
          {variant === "generate" && (
            <>
              <radialGradient id={`${id}-a`} cx="40%" cy="40%" r="65%">
                <stop offset="0%" stopColor="#8df3ff" />
                <stop offset="55%" stopColor="#1fb6ff" />
                <stop offset="100%" stopColor="#2038e2" />
              </radialGradient>
              <radialGradient id={`${id}-b`} cx="45%" cy="40%" r="65%">
                <stop offset="0%" stopColor="#9fb2ff" />
                <stop offset="55%" stopColor="#3d5cff" />
                <stop offset="100%" stopColor="#5b2be0" />
              </radialGradient>
              <radialGradient id={`${id}-c`} cx="45%" cy="45%" r="65%">
                <stop offset="0%" stopColor="#ffd0ec" />
                <stop offset="55%" stopColor="#ff6ad5" />
                <stop offset="100%" stopColor="#7a4dff" />
              </radialGradient>
              <radialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                <stop offset="45%" stopColor="#dff6ff" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
              {!inline && (
                <filter id={`${id}-goo`} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
                  <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" result="goo" />
                  <feComposite in="SourceGraphic" in2="goo" operator="atop" />
                </filter>
              )}
              {!inline && (
                <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="4" />
                </filter>
              )}
            </>
          )}
          {variant === "processing" && (
            <>
              <linearGradient id={`${id}-o1`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#2038e2" stopOpacity="0.15" />
                <stop offset="50%" stopColor="#2038e2" />
                <stop offset="100%" stopColor="#8df3ff" />
              </linearGradient>
              <linearGradient id={`${id}-o2`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#007bff" stopOpacity="0.15" />
                <stop offset="50%" stopColor="#007bff" />
                <stop offset="100%" stopColor="#b9e8ff" />
              </linearGradient>
              <linearGradient id={`${id}-o3`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ff5a00" stopOpacity="0.15" />
                <stop offset="50%" stopColor="#ff5a00" />
                <stop offset="100%" stopColor="#ffd3b8" />
              </linearGradient>
              {!inline && (
                <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
                  <feGaussianBlur stdDeviation="2.4" />
                </filter>
              )}
            </>
          )}
          {variant === "caption" && (
            <>
              <linearGradient id={`${id}-r1`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#8df3ff" />
                <stop offset="50%" stopColor="#007bff" />
                <stop offset="100%" stopColor="#2038e2" />
              </linearGradient>
              <linearGradient id={`${id}-r2`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ffe6d0" />
                <stop offset="50%" stopColor="#ff8a3d" />
                <stop offset="100%" stopColor="#ff5a00" />
              </linearGradient>
              <linearGradient id={`${id}-r3`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#c7b6ff" />
                <stop offset="50%" stopColor="#7a4dff" />
                <stop offset="100%" stopColor="#2038e2" />
              </linearGradient>
              <clipPath id={`${id}-clip`}>
                <circle cx="50" cy="50" r="46" />
              </clipPath>
              {!inline && (
                <filter id={`${id}-haze`} x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="3.5" />
                </filter>
              )}
            </>
          )}
        </defs>

        <g className="orb-scene">
          {variant === "generate" && <GenerateScene id={id} inline={inline} />}
          {variant === "processing" && <ProcessingScene id={id} inline={inline} />}
          {variant === "caption" && <CaptionScene id={id} inline={inline} />}
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

/* Three liquid blobs that merge and part under a gooey threshold, with a bright diffused core. */
function GenerateScene({ id, inline }: { id: string; inline: boolean }) {
  return (
    <>
      {!inline && <circle className="orb-halo" cx="50" cy="50" r="44" fill={`url(#${id}-core)`} />}
      <g className="orb-goo" filter={inline ? undefined : `url(#${id}-goo)`}>
        <g className="orb-blob orb-blob-1">
          <circle cx="50" cy="50" r={inline ? 24 : 18} fill={`url(#${id}-a)`} />
        </g>
        <g className="orb-blob orb-blob-2">
          <circle cx="50" cy="50" r={inline ? 22 : 16} fill={`url(#${id}-b)`} />
        </g>
        <g className="orb-blob orb-blob-3">
          <circle cx="50" cy="50" r={inline ? 20 : 15} fill={`url(#${id}-c)`} />
        </g>
      </g>
      {!inline && <circle className="orb-core" cx="50" cy="50" r="15" fill={`url(#${id}-core)`} filter={`url(#${id}-soft)`} />}
    </>
  );
}

/* Three thin glowing orbits, each turning at its own pace and breathing in shape. */
function ProcessingScene({ id, inline }: { id: string; inline: boolean }) {
  const ring = (n: 1 | 2 | 3, rx: number, ry: number) => (
    <g className={`orb-orbit orb-orbit-${n}`}>
      <g className="orb-deform">
        {!inline && <ellipse cx="50" cy="50" rx={rx} ry={ry} fill="none" stroke={`url(#${id}-o${n})`} strokeWidth="5" opacity="0.4" filter={`url(#${id}-glow)`} />}
        <ellipse cx="50" cy="50" rx={rx} ry={ry} fill="none" stroke={`url(#${id}-o${n})`} strokeWidth={inline ? 7 : 2.6} strokeLinecap="round" />
      </g>
    </g>
  );
  return (
    <>
      {ring(1, 42, 16)}
      {ring(2, 40, 15)}
      {ring(3, 38, 14)}
      <circle className="orb-dot" cx="50" cy="50" r={inline ? 7 : 3.2} fill="#2038e2" />
    </>
  );
}

/* Ribbons of light that keep flowing into new waves (SMIL path morphs, in a round window). */
function CaptionScene({ id, inline }: { id: string; inline: boolean }) {
  // Each ribbon is a band: a curve across and the same curve back a little lower. The three
  // shapes of every band share their command list, so the morph between them is smooth.
  const band = (ys: number[], t: number) =>
    `M-10,${ys[0]} C20,${ys[1]} 35,${ys[2]} 50,${ys[3]} C65,${ys[4]} 80,${ys[5]} 110,${ys[6]} L110,${ys[6] + t} C80,${ys[5] + t} 65,${ys[4] + t} 50,${ys[3] + t} C35,${ys[2] + t} 20,${ys[1] + t} -10,${ys[0] + t} Z`;
  const ribbons: { frames: number[][]; t: number; grad: string; op: number; dur: string }[] = [
    { frames: [[38, 18, 62, 40, 20, 58, 36], [48, 70, 22, 44, 66, 24, 52], [30, 36, 50, 34, 60, 30, 44], [38, 18, 62, 40, 20, 58, 36]], t: 13, grad: `url(#${id}-r1)`, op: 0.82, dur: "7.5s" },
    { frames: [[58, 76, 40, 60, 80, 42, 62], [50, 30, 72, 52, 28, 70, 48], [66, 60, 48, 70, 50, 78, 58], [58, 76, 40, 60, 80, 42, 62]], t: 11, grad: `url(#${id}-r2)`, op: 0.72, dur: "9s" },
    { frames: [[24, 44, 14, 28, 46, 12, 30], [34, 12, 40, 22, 10, 38, 20], [18, 30, 26, 14, 34, 24, 10], [24, 44, 14, 28, 46, 12, 30]], t: 9, grad: `url(#${id}-r3)`, op: 0.62, dur: "6.5s" },
  ];
  return (
    <g clipPath={`url(#${id}-clip)`} className="orb-ribbons">
      {!inline && <circle cx="50" cy="50" r="46" className="orb-window" />}
      {ribbons.map((r, i) => {
        const values = r.frames.map((f) => band(f, r.t)).join(";");
        const path = (extra: Record<string, string | number>) => (
          <path d={band(r.frames[0], r.t)} fill={r.grad} {...extra}>
            <animate attributeName="d" values={values} dur={r.dur} repeatCount="indefinite" calcMode="spline" keyTimes="0;0.33;0.66;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1" />
          </path>
        );
        return (
          <g key={i} className={`orb-ribbon orb-ribbon-${i + 1}`}>
            {!inline && path({ opacity: r.op * 0.6, filter: `url(#${id}-haze)` })}
            {path({ opacity: r.op })}
          </g>
        );
      })}
    </g>
  );
}

function useReducedMotion(): boolean {
  const ref = useRef(typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false);
  return ref.current;
}

export default Orb;
