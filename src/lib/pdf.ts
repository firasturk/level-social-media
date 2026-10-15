/**
 * A minimal PDF writer: one page that stacks JPEG images top to bottom. Enough for a long,
 * single-page presentation rendered on canvases, without a PDF library in the bundle.
 */
export interface PdfImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** @param scale points per pixel (0.5 → a 1600 px wide render becomes an 800 pt page). */
export function stackedImagesPdf(images: PdfImage[], scale: number): Blob {
  const pageW = Math.max(...images.map((i) => i.width)) * scale;
  const pageH = images.reduce((s, i) => s + i.height * scale, 0);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.byteLength;
  };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  push("%PDF-1.4\n%âãÏÓ\n");
  const firstImage = 4;
  const contentsId = firstImage + images.length;
  const xobjects = images.map((_, i) => `/Im${i} ${firstImage + i} 0 R`).join(" ");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageW)} ${fmt(pageH)}] /Resources << /XObject << ${xobjects} >> >> /Contents ${contentsId} 0 R >>`,
  );
  images.forEach((img, i) =>
    obj(
      firstImage + i,
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.byteLength} >>`,
      img.jpeg,
    ),
  );
  // PDF's origin is the bottom-left corner: place images from the top down.
  let y = pageH;
  const ops = images
    .map((img, i) => {
      const w = img.width * scale;
      const h = img.height * scale;
      y -= h;
      const x = (pageW - w) / 2;
      return `q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /Im${i} Do Q`;
    })
    .join("\n");
  const content = enc.encode(ops);
  obj(contentsId, `<< /Length ${content.byteLength} >>`, content);

  const count = contentsId + 1;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
