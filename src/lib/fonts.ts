/**
 * Fonts for the canvas: the client's uploaded files, and Google families fetched at the weight and
 * style a layer asks for (index.html preloads one or two weights of each; the rest come on demand).
 */
import { HOSTED_FONTS } from "@shared/overlay";

const loadedFonts = new Map<string, Promise<void>>();
const requested = new Set<string>();

export const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function fontStack(family: string): string {
  const quoted = `"${family.replace(/"/g, "")}"`;
  if (HOSTED_FONTS.includes(family)) return `${quoted}, Tajawal, sans-serif`;
  return `${quoted}, Tajawal, Inter, sans-serif`;
}

/** Loads an uploaded brand font once; hosted Google fonts come from the stylesheet in index.html. */
export function loadFont(name: string, url: string): Promise<void> {
  const key = `${name}|${url}`;
  let p = loadedFonts.get(key);
  if (!p) {
    p = (async () => {
      const face = new FontFace(name, `url(${url})`);
      await face.load();
      document.fonts.add(face);
    })().catch(() => undefined);
    loadedFonts.set(key, p);
  }
  return p;
}

/** The weights index.html preloads for every hosted family (others are fetched on demand). */
const PRELOADED = new Set([400, 700]);

/**
 * Makes sure a hosted family is available at this weight and style: one stylesheet request per
 * (family, weight, italic), then the browser is asked to load the face for the given text so the
 * right (Arabic or Latin) subset is fetched before the canvas draws it.
 */
export async function ensureFont(family: string, weight: number, italic: boolean, sample: string): Promise<void> {
  if (typeof document === "undefined") return;
  const w = Math.max(100, Math.min(900, Math.round(weight / 100) * 100));
  const key = `${family}|${w}|${italic ? 1 : 0}`;
  if (HOSTED_FONTS.includes(family) && !requested.has(key) && (italic || !PRELOADED.has(w))) {
    requested.add(key);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:ital,wght@${italic ? 1 : 0},${w}&display=swap`;
    document.head.appendChild(link);
    await new Promise<void>((resolve) => {
      link.onload = () => resolve();
      link.onerror = () => resolve();
      setTimeout(resolve, 2500);
    });
  }
  try {
    await document.fonts.load(`${italic ? "italic " : ""}${w} 48px ${fontStack(family)}`, sample || "حب Ab");
  } catch {
    /* the fallback face draws */
  }
}
