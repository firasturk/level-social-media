/** Text colours that read on the picture behind them (the overlay checks every headline). */

/** Relative luminance (0-1) of a #rrggbb colour; null for anything else. */
export function luminanceOf(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
}

/** The colour itself when it reads on the background (contrast 2.5:1), else a dark or a light ink. */
export function readableOn(color: string, behind: number): string {
  const l = luminanceOf(color);
  if (l === null) return color;
  const contrast = (Math.max(l, behind) + 0.05) / (Math.min(l, behind) + 0.05);
  if (contrast >= 2.5) return color;
  return behind > 0.35 ? "#1f1a17" : "#ffffff";
}

