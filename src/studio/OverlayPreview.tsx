import { useEffect, useRef, useState } from "react";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import { renderOverlay, type OverlayText } from "@/lib/overlay";

/** The generated image with the client's overlay drawn over it, rendered once per change. */
export default function OverlayPreview({
  src,
  spec,
  text,
  logoSrc,
  patch,
  faces,
  width = 720,
  alt = "",
  className,
  onSize,
}: {
  src: string;
  spec: OverlaySpec;
  text: OverlayText;
  logoSrc: string | null;
  patch?: PostOverlayPatch;
  /** Faces in the picture (from the review): the words keep off them. */
  faces?: number[][];
  width?: number;
  alt?: string;
  className?: string;
  /** The drawn picture's size, once drawn (the card compares it with the month's frame). */
  onSize?: (width: number, height: number) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [seen, setSeen] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // Drawn only once it comes near the screen: a month of cards would otherwise draw all at once.
  useEffect(() => {
    const el = ref.current;
    if (!el || seen || typeof IntersectionObserver === "undefined") {
      if (!seen && typeof IntersectionObserver === "undefined") setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const key = JSON.stringify([src, spec, text.headline ?? "", text.subline ?? "", logoSrc, width, patch, faces, seen]);
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    renderOverlay(src, spec, text, logoSrc, width, { patch, faces })
      .then((canvas) => {
        if (!alive) return;
        setUrl(canvas.toDataURL("image/jpeg", 0.86));
        onSize?.(canvas.width, canvas.height);
      })
      .catch((e) => {
        console.error("[overlay] could not draw the words:", e);
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <img ref={ref} src={url ?? src} alt={alt} className={className} loading="lazy" />;
}
