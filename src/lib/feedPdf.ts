import { POST_TYPE_INFO, monthLabel, type Post } from "@shared/posts";
import type { Client } from "@shared/types";
import { canvasBlob } from "./overlay";
import { stackedImagesPdf, type PdfImage } from "./pdf";

/** One rendered post (the image with its overlay) and the plan entry it came from. */
export interface FeedPost {
  post: Post;
  image: HTMLCanvasElement | HTMLImageElement;
}

export interface FeedDeck {
  client: Client;
  month: string;
  logo: HTMLImageElement | null;
  /** The month's direction text, shown before the per-post notes. */
  direction: string;
  posts: FeedPost[];
}

const W = 1600;
const PAD = 120;
const SANS = "Inter, system-ui, sans-serif";
const ARABIC = "Tajawal, Cairo, system-ui, sans-serif";
const AR = /[؀-ۿ]/;

/**
 * A one-page presentation of the month: cover, an Instagram-style profile grid with every post,
 * the direction and a note per post, and a closing page on black.
 */
export async function buildFeedPdf(deck: FeedDeck): Promise<Blob> {
  const brand = deck.client.fonts.headline || "Inter";
  // Canvas text only uses a web font once it is loaded; fonts load lazily, so ask for them first.
  await Promise.all(
    [`700 64px ${brand}`, `400 30px Inter`, `600 30px Inter`, `400 30px Tajawal`, `700 40px Tajawal`].map((f) =>
      document.fonts.load(f).catch(() => []),
    ),
  );
  await document.fonts.ready;
  const sections: HTMLCanvasElement[] = [
    cover(deck, brand),
    feed(deck, brand),
    ...notes(deck, brand),
    closing(deck, brand),
  ];
  const images: PdfImage[] = [];
  for (const c of sections) {
    const blob = await canvasBlob(c, 0.9);
    images.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height });
  }
  return stackedImagesPdf(images, 0.45);
}

function canvas(height: number, fill: string): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = Math.round(height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, c.width, c.height);
  return [c, ctx];
}

function fontFor(text: string, size: number, weight = 400, family = SANS): string {
  return `${weight} ${size}px ${AR.test(text) ? ARABIC : family}`;
}

/** Draws wrapped text; Arabic lines are laid out right to left. Returns the next y. */
function paragraph(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  opts: { weight?: number; family?: string; color?: string; lineHeight?: number; maxLines?: number } = {},
): number {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return y;
  const rtl = AR.test(clean);
  ctx.font = fontFor(clean, size, opts.weight ?? 400, opts.family ?? SANS);
  ctx.fillStyle = opts.color ?? "#111";
  ctx.textBaseline = "top";
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";
  const lh = opts.lineHeight ?? size * 1.45;
  const lines: string[] = [];
  let line = "";
  for (const word of clean.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  const max = opts.maxLines ?? lines.length;
  const shown = lines.slice(0, max);
  if (lines.length > max) shown[max - 1] = shown[max - 1].replace(/[\s.,،]*$/, "") + "…";
  shown.forEach((l, i) => ctx.fillText(l, rtl ? x + width : x, y + i * lh));
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  return y + shown.length * lh;
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = img.width;
  const ih = img.height;
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = img.width;
  const ih = img.height;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function circleImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  cx: number,
  cy: number,
  r: number,
  initials: string,
  color: string,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.clip();
  if (img) drawContain(ctx, img, cx - r * 0.72, cy - r * 0.72, r * 1.44, r * 1.44);
  else {
    ctx.fillStyle = color;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${r * 0.9}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials, cx, cy + r * 0.05);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#dbdbdb";
  ctx.lineWidth = 2;
  ctx.stroke();
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

function cover(deck: FeedDeck, brand: string): HTMLCanvasElement {
  const accent = deck.client.colors[0]?.hex || "#111";
  const [c, ctx] = canvas(1100, "#ffffff");
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 14);
  if (deck.logo) drawContain(ctx, deck.logo, W / 2 - 240, 170, 480, 260);
  else circleImage(ctx, null, W / 2, 300, 120, initialsOf(deck.client.name), accent);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#6b6b6b";
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText("CONTENT CALENDAR", W / 2, 520);
  ctx.fillStyle = "#111";
  ctx.font = fontFor(deck.client.name, 84, 700, brand);
  ctx.fillText(deck.client.name, W / 2, 575);
  ctx.fillStyle = "#333";
  ctx.font = `400 44px ${SANS}`;
  ctx.fillText(monthLabel(deck.month), W / 2, 695);
  ctx.fillStyle = "#9a9a9a";
  ctx.font = `400 24px ${SANS}`;
  ctx.fillText(`${deck.posts.length} posts  ·  prepared by Level Social Media`, W / 2, 790);
  ctx.textAlign = "left";
  return c;
}

function feed(deck: FeedDeck, brand: string): HTMLCanvasElement {
  const frameW = 1180;
  const gap = 6;
  const tileW = Math.floor((frameW - gap * 2) / 3);
  const tileH = Math.round(tileW * 1.25);
  const rows = Math.ceil(deck.posts.length / 3);
  const headerH = 560;
  const frameH = headerH + rows * (tileH + gap) + 80;
  const [c, ctx] = canvas(frameH + 200, "#ececec");
  const fx = (W - frameW) / 2;
  const fy = 100;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 50;
  ctx.shadowOffsetY = 16;
  roundRect(ctx, fx, fy, frameW, frameH, 44);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, fx, fy, frameW, frameH, 44);
  ctx.clip();

  // Status bar and the handle name.
  ctx.fillStyle = "#111";
  ctx.font = `600 26px ${SANS}`;
  ctx.textBaseline = "top";
  ctx.fillText("9:41", fx + 60, fy + 34);
  ctx.textAlign = "right";
  ctx.fillText("●●● ▲ ▮", fx + frameW - 60, fy + 34);
  ctx.textAlign = "left";
  const handle = deck.client.slug.replace(/-/g, ".");
  ctx.font = `700 34px ${SANS}`;
  ctx.fillText(handle, fx + 60, fy + 110);
  ctx.textAlign = "right";
  ctx.font = `400 34px ${SANS}`;
  ctx.fillText("+  ≡", fx + frameW - 60, fy + 106);
  ctx.textAlign = "left";

  // Avatar and counts.
  const accent = deck.client.colors[0]?.hex || "#111";
  circleImage(ctx, deck.logo, fx + 150, fy + 270, 86, initialsOf(deck.client.name), accent);
  const stats: [string, string][] = [
    [String(deck.posts.length), "posts"],
    ["—", "followers"],
    ["—", "following"],
  ];
  stats.forEach(([n, label], i) => {
    const x = fx + 400 + i * 240;
    ctx.textAlign = "center";
    ctx.fillStyle = "#111";
    ctx.font = `700 34px ${SANS}`;
    ctx.fillText(n, x, fy + 230);
    ctx.fillStyle = "#333";
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText(label, x, fy + 276);
  });
  ctx.textAlign = "left";
  ctx.fillStyle = "#111";
  ctx.font = fontFor(deck.client.name, 30, 700, brand);
  ctx.direction = AR.test(deck.client.name) ? "rtl" : "ltr";
  ctx.fillText(deck.client.name, fx + 60, fy + 380);
  ctx.direction = "ltr";
  ctx.fillStyle = "#333";
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText(`${monthLabel(deck.month)} · content calendar`, fx + 60, fy + 424);

  // Buttons and the grid tab.
  const bw = (frameW - 120 - 16) / 2;
  roundRect(ctx, fx + 60, fy + 470, bw, 54, 12);
  ctx.fillStyle = "#0095f6";
  ctx.fill();
  roundRect(ctx, fx + 60 + bw + 16, fy + 470, bw, 54, 12);
  ctx.fillStyle = "#efefef";
  ctx.fill();
  ctx.textAlign = "center";
  ctx.font = `600 26px ${SANS}`;
  ctx.fillStyle = "#fff";
  ctx.fillText("Follow", fx + 60 + bw / 2, fy + 484);
  ctx.fillStyle = "#111";
  ctx.fillText("Message", fx + 60 + bw + 16 + bw / 2, fy + 484);
  ctx.textAlign = "left";
  ctx.fillStyle = "#111";
  ctx.fillRect(fx, fy + headerH - 4, frameW / 3, 3);
  ctx.strokeStyle = "#dbdbdb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(fx, fy + headerH);
  ctx.lineTo(fx + frameW, fy + headerH);
  ctx.stroke();

  // The grid, newest post first like a real profile.
  const ordered = [...deck.posts].sort((a, b) => b.post.index - a.post.index);
  ordered.forEach((p, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = fx + col * (tileW + gap);
    const y = fy + headerH + 6 + row * (tileH + gap);
    drawCover(ctx, p.image, x, y, tileW, tileH);
  });
  ctx.restore();
  return c;
}

function notes(deck: FeedDeck, brand: string): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const colW = W - PAD * 2;
  const thumbW = 280;
  const thumbH = Math.round(thumbW * 1.25);
  const textX = PAD + thumbW + 60;
  const textW = colW - thumbW - 60;

  // Intro: the direction.
  {
    const scratch = canvas(4000, "#fff");
    let y = PAD;
    y = paragraph(scratch[1], "THE MONTH", PAD, y, colW, 24, { weight: 500, color: "#6b6b6b" }) + 16;
    y = paragraph(scratch[1], `What these ${deck.posts.length} posts do`, PAD, y, colW, 64, {
      weight: 700,
      family: brand,
    }) + 30;
    y = paragraph(scratch[1], deck.direction || "Each post is planned for a place in the feed: product moments, lifestyle, offers and tips in a rhythm that keeps the page alive.", PAD, y, colW, 30, {
      color: "#333",
      lineHeight: 46,
      maxLines: 14,
    });
    const h = y + PAD;
    const [c, ctx] = canvas(h, "#fff");
    ctx.drawImage(scratch[0], 0, 0);
    out.push(c);
  }

  // One block per post, a few posts per canvas.
  const perChunk = 6;
  for (let i = 0; i < deck.posts.length; i += perChunk) {
    const chunk = deck.posts.slice(i, i + perChunk);
    const scratch = canvas(perChunk * (thumbH + 70) + PAD, "#fff");
    const sctx = scratch[1];
    let y = i === 0 ? 20 : 60;
    for (const { post, image } of chunk) {
      const top = y;
      drawCover(sctx, image, PAD, top, thumbW, thumbH);
      const info = POST_TYPE_INFO[post.type];
      let ty = top;
      ty = paragraph(
        sctx,
        `${String(post.index).padStart(2, "0")}  ·  ${info?.label ?? post.type}`,
        textX,
        ty,
        textW,
        24,
        { weight: 500, color: "#6b6b6b" },
      ) + 8;
      ty = paragraph(sctx, post.headline || post.title, textX, ty, textW, 40, { weight: 700, family: brand }) + 10;
      if (post.subline) ty = paragraph(sctx, post.subline, textX, ty, textW, 28, { color: "#333" }) + 10;
      ty = paragraph(sctx, post.brief, textX, ty, textW, 25, { color: "#444", lineHeight: 38, maxLines: 5 }) + 14;
      if (post.caption)
        ty = paragraph(sctx, post.caption, textX, ty, textW, 25, { color: "#777", lineHeight: 38, maxLines: 4 });
      y = Math.max(top + thumbH, ty) + 70;
      sctx.strokeStyle = "#e8e8e8";
      sctx.lineWidth = 2;
      sctx.beginPath();
      sctx.moveTo(PAD, y - 35);
      sctx.lineTo(W - PAD, y - 35);
      sctx.stroke();
    }
    const [c, ctx] = canvas(y, "#fff");
    ctx.drawImage(scratch[0], 0, 0);
    out.push(c);
  }
  return out;
}

function closing(deck: FeedDeck, brand: string): HTMLCanvasElement {
  const [c, ctx] = canvas(1000, "#000000");
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#fff";
  ctx.font = `700 120px ${brand}, ${SANS}`;
  ctx.fillText("Thank you", W / 2, 300);
  ctx.fillStyle = "#9a9a9a";
  ctx.font = `400 30px ${SANS}`;
  ctx.fillText(`${deck.client.name}  ·  ${monthLabel(deck.month)}`, W / 2, 470);
  circleImage(ctx, deck.logo, W / 2, 680, 80, initialsOf(deck.client.name), deck.client.colors[0]?.hex || "#333");
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b6b6b";
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText("LEVEL  ·  SOCIAL MEDIA", W / 2, 820);
  ctx.textAlign = "left";
  return c;
}
