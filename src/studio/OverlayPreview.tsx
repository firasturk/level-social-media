import { useEffect, useState } from "react";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import { renderOverlay, type OverlayText } from "@/lib/overlay";

/** The generated image with the client's overlay drawn over it, rendered once per change. */
export default function OverlayPreview({
  src,
  spec,
  text,
  logoSrc,
  patch,
  width = 720,
  alt = "",
  className,
}: {
  src: string;
  spec: OverlaySpec;
  text: OverlayText;
  logoSrc: string | null;
  patch?: PostOverlayPatch;
  width?: number;
  alt?: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const key = JSON.stringify([src, spec, text.headline ?? "", text.subline ?? "", logoSrc, width, patch]);
  useEffect(() => {
    let alive = true;
    renderOverlay(src, spec, text, logoSrc, width, { patch })
      .then((canvas) => alive && setUrl(canvas.toDataURL("image/jpeg", 0.86)))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <img src={url ?? src} alt={alt} className={className} loading="lazy" />;
}
