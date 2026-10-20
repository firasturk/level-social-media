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
 * small tolerance), stopping at the first row or column with real content. Only a near-white or
 * near-black border wider than 1% of the side and narrower than 40%, ending in a hard edge, counts;
 * a plain wall, a sky or a studio backdrop is left alone.
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
  // A mat is near-white or near-black and ends in a hard edge; a plain wall or sky is neither.
  const isMat = (c: readonly [number, number, number]) => {
    const max = Math.max(c[0], c[1], c[2]);
    const min = Math.min(c[0], c[1], c[2]);
    return max - min <= 12 && (min >= 232 || max <= 24);
  };
  const lineMean = (side: "left" | "right" | "top" | "bottom", k: number) => {
    const line =
      side === "left"
        ? Array.from({ length: ph }, (_, y) => px(k, y))
        : side === "right"
          ? Array.from({ length: ph }, (_, y) => px(pw - 1 - k, y))
          : side === "top"
            ? Array.from({ length: pw }, (_, x) => px(x, k))
            : Array.from({ length: pw }, (_, x) => px(x, ph - 1 - k));
    const sum = line.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
    return sum.map((v) => v / line.length);
  };
  const keep = (side: "left" | "right" | "top" | "bottom", k: number, n: number) => {
    if (!(k / n > 0.01 && k / n < 0.4)) return 0;
    const edge = lineMean(side, 0);
    if (!isMat([edge[0], edge[1], edge[2]])) return 0;
    const next = lineMean(side, Math.min(n - 1, k + 1));
    const diff =
      Math.abs(next[0] - edge[0]) + Math.abs(next[1] - edge[1]) + Math.abs(next[2] - edge[2]);
    return diff >= 60 ? k : 0;
  };
  const left = keep("left", count("left"), pw);
  const right = keep("right", count("right"), pw);
  const top = keep("top", count("top"), ph);
  const bottom = keep("bottom", count("bottom"), ph);
  if (!left && !right && !top && !bottom) return null;
  const back = 1 / scale;
  return {
    left: Math.round(left * back),
    right: Math.round(right * back),
    top: Math.round(top * back),
    bottom: Math.round(bottom * back),
  };
}

/**
 * A picture the studio can read for sure. The browser draws the file (a PNG, a JPG, a WebP, an SVG
 * logo, a HEIC photo where the browser opens it) on a canvas no wider than `maxEdge` and hands back
 * a PNG when the picture may have transparency (a logo), a JPEG otherwise. A file the browser
 * cannot draw is refused here with a clear message, never sent as bytes the server cannot decode.
 */
export async function rasterize(file: File, maxEdge = 2048): Promise<File> {
  const keepAlpha = /png|svg|webp|gif/i.test(file.type) || /\.(png|svg|webp|gif)$/i.test(file.name);
  const source = await drawable(file);
  try {
    const w = source.width;
    const h = source.height;
    if (!w || !h) throw new Error("This picture has no size the browser can read. Save it as PNG or JPG and attach it again.");
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    if (!keepAlpha) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Unable to prepare the picture."))), keepAlpha ? "image/png" : "image/jpeg", 0.94),
    );
    const stem = file.name.replace(/\.[^.]+$/, "") || "picture";
    return new File([blob], `${stem}.${keepAlpha ? "png" : "jpg"}`, { type: blob.type });
  } finally {
    source.close();
  }
}

type Drawable = { image: CanvasImageSource; width: number; height: number; close: () => void };

/** The file as something a canvas draws: a bitmap when the browser decodes it, an <img> otherwise (an SVG). */
async function drawable(file: Blob): Promise<Drawable> {
  if (!/svg/i.test(file.type)) {
    try {
      const bmp = await createImageBitmap(file);
      return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* an <img> may still read it */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("This picture can't be read by the browser. Save it as PNG or JPG and attach it again."));
      el.src = url;
    });
    // An SVG with no size of its own is drawn 1600 wide.
    const width = img.naturalWidth || 1600;
    const height = img.naturalHeight || 1600;
    return { image: img, width, height, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}
