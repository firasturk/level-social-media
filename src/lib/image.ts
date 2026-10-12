/**
 * Downsized JPEG used for inference and thumbnails so large originals never leave the browser twice.
 * With `trimBorders` a flat mat around the picture (white side bars, a frame) is cut away first,
 * so the engines never learn the bars as part of the scene.
 */
export async function makeReference(
  file: Blob,
  maxEdge = 1600,
  quality = 0.94,
  trimBorders = false,
): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const crop = trimBorders ? uniformBorders(image) : null;
    const sx = crop?.left ?? 0;
    const sy = crop?.top ?? 0;
    const sw = image.width - sx - (crop?.right ?? 0);
    const sh = image.height - sy - (crop?.bottom ?? 0);
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Unable to prepare image."))),
        "image/jpeg",
        quality,
      ),
    );
  } finally {
    image.close();
  }
}

/**
 * Measures a flat border on each side: rows or columns whose pixels all share one colour (within a
 * small tolerance), stopping at the first row or column with real content. Only a border wider than
 * 1% of the side and narrower than 40% counts, so a plain studio backdrop is left alone.
 */
export function uniformBorders(
  image: ImageBitmap,
): { left: number; right: number; top: number; bottom: number } | null {
  const w = image.width;
  const h = image.height;
  const probe = document.createElement("canvas");
  // A small copy is enough to find bars and keeps this fast on 20 MB uploads.
  const scale = Math.min(1, 600 / Math.max(w, h));
  probe.width = Math.max(1, Math.round(w * scale));
  probe.height = Math.max(1, Math.round(h * scale));
  const ctx = probe.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, probe.width, probe.height);
  const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
  const pw = probe.width;
  const ph = probe.height;
  const px = (x: number, y: number) => {
    const i = (y * pw + x) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
  const flat = (line: (readonly [number, number, number])[]) => {
    const ref = line[0];
    let ok = 0;
    for (const c of line)
      if (
        Math.abs(c[0] - ref[0]) <= 8 &&
        Math.abs(c[1] - ref[1]) <= 8 &&
        Math.abs(c[2] - ref[2]) <= 8
      )
        ok++;
    return ok / line.length >= 0.985;
  };
  const count = (side: "left" | "right" | "top" | "bottom") => {
    const n = side === "left" || side === "right" ? pw : ph;
    let k = 0;
    for (; k < n; k++) {
      const line =
        side === "left"
          ? Array.from({ length: ph }, (_, y) => px(k, y))
          : side === "right"
            ? Array.from({ length: ph }, (_, y) => px(pw - 1 - k, y))
            : side === "top"
              ? Array.from({ length: pw }, (_, x) => px(x, k))
              : Array.from({ length: pw }, (_, x) => px(x, ph - 1 - k));
      if (!flat(line)) break;
    }
    return k;
  };
  const keep = (k: number, n: number) => (k / n > 0.01 && k / n < 0.4 ? k : 0);
  const left = keep(count("left"), pw);
  const right = keep(count("right"), pw);
  const top = keep(count("top"), ph);
  const bottom = keep(count("bottom"), ph);
  if (!left && !right && !top && !bottom) return null;
  const back = 1 / scale;
  return {
    left: Math.round(left * back),
    right: Math.round(right * back),
    top: Math.round(top * back),
    bottom: Math.round(bottom * back),
  };
}
