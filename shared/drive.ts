/**
 * A client's Google Drive folder: the studio's service account reads its photos (the folder is
 * shared with it as Viewer), the team browses them by folder, and the vision model picks the best
 * product photos for the month.
 */

export interface DrivePhoto {
  id: string;
  /** The file's own name. */
  file: string;
  /** The product name the photo joins the month with (its folder, or a meaningful file name). */
  name: string;
  /** The folders from the client's folder down to the photo ("Kunafah - كنـافة / Sidr - Tray"). */
  folder: string;
  w: number;
  h: number;
  modified: string;
  /** What vision read in the photo, once read: product, place, people, design or other. */
  kind?: DriveKind;
  /** A few words on what it shows. */
  note?: string;
}

export const DRIVE_KINDS = ["product", "place", "people", "design", "other"] as const;
export type DriveKind = (typeof DRIVE_KINDS)[number];

/** The folder id in a Drive link (…/folders/<id>, ?id=<id>) or a bare id; null when there is none. */
export function driveFolderId(link: string): string | null {
  const s = link.trim();
  const m = s.match(/\/folders\/([\w-]{10,})/) ?? s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : null;
}

/** Camera and export names say nothing about the product ("DSC09913", "IMG_2041", "AT5A0019"). */
const MEANINGLESS = /^(dsc|dscf|img|_?mg|at5a|dji|pxl|zeko|gemini_generated_image|photo|image|screenshot|whatsapp image|untitled|copy of)[\s_-]*[\w-]*$/i;
/** Folders that only sort photos ("Gallery", "Final", "2024") and name no product. */
const GENERIC_FOLDER = /^(gallery|photos?|pictures?|images?|final|finals|edited|selects?|raw|jpe?g|png|high ?res|low ?res|web|new|old|misc|\d{2,4}([-_ ]\d{1,2})*)$/i;

export function photoName(file: string, folders: string[]): string {
  // "22. Turkish Trillica Kunafa.jpg" → "Turkish Trillica Kunafa": catalogue numbers name no product.
  const stem = file.replace(/(\.[a-z0-9]{2,5})+$/i, "").replace(/^\d{1,3}\s*[.)\-_]\s*/, "").trim();
  const meaningful = stem && !isCameraName(stem) && /[a-z؀-ۿ]{3,}/i.test(stem);
  if (meaningful) return stem.replace(/[_]+/g, " ").replace(/\s+\d+$/, "").trim();
  const folder = [...folders].reverse().find((f) => !GENERIC_FOLDER.test(f.trim()));
  return (folder ?? stem).trim();
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "");

/** A folder named after the client ("Habibah", "Abu saleh", "Habibah Photos"): its own folder in a shared one. */
export function isClientFolder(folder: string, client: string): boolean {
  const f = nameKey(folder);
  const c = nameKey(client);
  if (!f || c.length < 3) return false;
  return f === c || (f.startsWith(c) && f.length - c.length <= 12) || (c.startsWith(f) && f.length >= 4);
}

/** Camera and export codes ("DSC01838", "D22A1936 copy", "IMG_2041 (2)"): they say nothing of the product. */
/** One word with three digits in a row and no real word in it ("DSC01838", "D22A1936", "IMG_2041"). */
const CAMERA = /^(?=.*\d{3})(?!.*[a-z]{4})[a-z0-9_-]+$/i;
export function isCameraName(name: string): boolean {
  const s = name.replace(/(\s+copy|\s*\(\d+\))+$/i, "").trim();
  return !s || MEANINGLESS.test(s) || CAMERA.test(s) || /^\d+$/.test(s);
}

/* ───────────── Reading Drive photos ───────────── */

export const DRIVE_READ_SCHEMA = {
  type: "object",
  properties: {
    photos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          image: { type: "integer" },
          name: { type: "string" },
          kind: { type: "string", enum: [...DRIVE_KINDS] },
          note: { type: "string" },
        },
        required: ["image", "name", "kind", "note"],
      },
    },
  },
  required: ["photos"],
};

export function driveReadInstruction(client: string, photos: { file: string; folder: string }[]): string {
  return [
    `Images 1 to ${photos.length} are photos from the Google Drive of the client "${client}" (a brand in Jordan). Say what each one is, so the team finds it by name.`,
    `Where each comes from (folder / file):\n${photos.map((p, i) => `${i + 1}. ${p.folder || "(top folder)"} / ${p.file}`).join("\n")}`,
    [
      "For every image:",
      "- name: the product in it, 2-5 words, the way the brand would name it (\"Pistachio kunafa tray\", \"Mango juice cup\", \"Chocolate fudge cake slice\"); use the folder's or packaging's name when it says it; for a non-product photo, what it shows (\"Shop counter\", \"Barista at work\");",
      "- kind: product (a product is the subject), place (the shop, branch or a space), people (a person is the subject), design (a finished post, poster, logo or anything with designed text), other;",
      "- note: one short sentence on what is in it (packaging, colours, how it is shot).",
    ].join("\n"),
    "Return ONLY the JSON.",
  ].join("\n\n");
}

export function parseDriveRead(raw: unknown, count: number): { image: number; name: string; kind: DriveKind; note: string }[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { photos?: unknown }).photos) ? (raw as { photos: Record<string, unknown>[] }).photos : [];
  const out = new Map<number, { image: number; name: string; kind: DriveKind; note: string }>();
  for (const x of list) {
    const image = Math.round(Number(x?.image));
    if (image < 1 || image > count || out.has(image)) continue;
    const kind = (DRIVE_KINDS as readonly string[]).includes(String(x?.kind)) ? (String(x.kind) as DriveKind) : "other";
    const name = String(x?.name ?? "").replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) continue;
    out.set(image, { image, name, kind, note: String(x?.note ?? "").trim().slice(0, 240) });
  }
  return [...out.values()];
}

/** At most `max` photos spread over the folders (round robin, newest first in each), for the picker. */
export function spreadPhotos(photos: DrivePhoto[], max: number): DrivePhoto[] {
  const byFolder = new Map<string, DrivePhoto[]>();
  for (const p of [...photos].sort((a, b) => b.modified.localeCompare(a.modified))) {
    const list = byFolder.get(p.folder) ?? [];
    list.push(p);
    byFolder.set(p.folder, list);
  }
  const queues = [...byFolder.values()];
  const out: DrivePhoto[] = [];
  for (let round = 0; out.length < max && queues.some((q) => q.length > round); round++)
    for (const q of queues) if (q[round] && out.length < max) out.push(q[round]);
  return out;
}

export const DRIVE_PICK_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: { image: { type: "integer" }, product: { type: "string" }, reason: { type: "string" } },
        required: ["image", "product", "reason"],
      },
    },
  },
  required: ["picks"],
};

export function drivePickInstruction(r: { client: string; count: number; photos: DrivePhoto[]; profile?: string; wanted?: string }): string {
  return [
    `You are the art director of a social-media design agency. Images 1 to ${r.photos.length} are photos from the Google Drive of the client "${r.client}". The team needs ${r.count} of them as the product photos for this month's posts: the image model will rebuild each product from its photo, so the product itself must read perfectly.`,
    `Where each image comes from (folder / file):\n${r.photos.map((p, i) => `${i + 1}. ${p.folder || "(top folder)"} / ${p.file}`).join("\n")}`,
    r.profile ? `WHAT WE KNOW ABOUT THE CLIENT:\n${r.profile}` : "",
    r.wanted ? `THE TEAM ASKS FOR: ${r.wanted}` : "",
    [
      "Pick the best photos:",
      "- the product is clearly the subject, whole, sharp, well lit, in its real colours and packaging;",
      "- prefer clean product shots and appetising close-ups over wide scenes, people, events, screenshots, logos, menus or designs with text;",
      "- vary the products: different products and ranges (folders) before a second photo of the same one, and never two near-identical photos;",
      "- the client's hero products first when they are known.",
      `Return up to ${r.count} picks, best first: image (its number), product (a short name of the product in it, in the client's language when the folder or packaging says it), reason (a few words). Fewer when fewer are good enough.`,
    ].join("\n"),
    "Return ONLY the JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface DrivePick {
  id: string;
  product: string;
  reason: string;
}

export function parsePicks(raw: unknown, photos: DrivePhoto[], count: number): DrivePick[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { picks?: unknown }).picks) ? (raw as { picks: Record<string, unknown>[] }).picks : [];
  const seen = new Set<string>();
  const out: DrivePick[] = [];
  for (const x of list) {
    const photo = photos[Math.round(Number(x?.image)) - 1];
    if (!photo || seen.has(photo.id)) continue;
    seen.add(photo.id);
    out.push({ id: photo.id, product: String(x?.product ?? "").trim().slice(0, 80) || photo.name, reason: String(x?.reason ?? "").trim().slice(0, 160) });
    if (out.length >= count) break;
  }
  return out;
}

/* ───────────── Matching products to posts ───────────── */

/** Where a product photo can come from: this month, the client's earlier months, or its Drive. */
export type ProductSource = "month" | "gallery" | "drive";

export interface ProductOption {
  source: ProductSource;
  /** The month's or the gallery's photo id, or the Drive photo id. */
  id: string;
  name: string;
  /** What the photo shows, or where it sits in Drive. */
  note: string;
}

export interface ProductMatch {
  index: number;
  picks: (ProductOption & { reason: string })[];
}

/** Tiles that show no product: their posts are not given one (a person tile holds one). */
export const NO_PRODUCT_TILES = new Set(["text", "texture", "place"]);

export interface MatchPost {
  index: number;
  type: string;
  headline?: string;
  brief: string;
  product?: string;
  tile?: { kind: string; items: string };
}

export const PRODUCT_MATCH_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          post: { type: "integer" },
          picks: {
            type: "array",
            items: { type: "object", properties: { option: { type: "integer" }, reason: { type: "string" } }, required: ["option", "reason"] },
          },
        },
        required: ["post", "picks"],
      },
    },
  },
  required: ["matches"],
};

export function productMatchInstruction(r: { client: string; posts: MatchPost[]; options: ProductOption[]; preferDrive?: boolean; exact?: boolean }): string {
  const where = { month: "this month", gallery: "an earlier month", drive: "the client's Drive" };
  return [
    `You plan the product photos of the month's posts for the client "${r.client}". Each post needs the photo of the product its picture shows; the image model rebuilds that product from the photo.`,
    `THE POSTS:\n${r.posts
      .map(
        (p) =>
          `Post ${p.index} [${p.type}${p.tile ? `, grid tile: ${p.tile.kind}${p.tile.items ? ` (${p.tile.items})` : ""}` : ""}]${p.headline ? ` "${p.headline}"` : ""}: ${p.brief.replace(/\s+/g, " ").slice(0, 260)}${p.product ? ` · product now: ${p.product}` : ""}`,
      )
      .join("\n")}`,
    `THE PRODUCT PHOTOS THERE ARE:\n${r.options.map((o, i) => `${i + 1}. ${o.name} (${where[o.source]})${o.note ? ` — ${o.note.replace(/\s+/g, " ").slice(0, 140)}` : ""}`).join("\n")}`,
    [
      "For every post, pick up to 3 photos (their numbers) that fit what its picture shows and its grid tile, best first:",
      "- the post's current product first when it fits and has a photo;",
      "- the same product, or the closest one in look and kind (a kunafa for a kunafa, a can for a can, a tray for a tray) when the exact one has no photo;",
      r.preferDrive
        ? "- the team asks for the client's Drive photos: pick a Drive photo first whenever one fits the post and its tile, then the others;"
        : "- at equal fit, this month's photos first, then earlier months, then Drive;",
      "- spread the month: avoid giving the same product to every post when others fit;",
      "- a post whose picture shows no product (a text or quote tile, a texture, a place, a greeting) gets no picks; a person tile gets the product the person holds (a box or tin held level with both hands suits it best).",
      r.exact ? "- exact product mode is on: the product photo is set into the picture as it is, so prefer a photo where the product stands alone on a plain background (a studio packshot) over one with a table, cups or a scene around it;" : "",
      "reason: a few words on why it fits.",
    ].filter(Boolean).join("\n"),
    "Return ONLY the JSON.",
  ].join("\n\n");
}

export function parseMatches(raw: unknown, posts: MatchPost[], options: ProductOption[]): ProductMatch[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { matches?: unknown }).matches) ? (raw as { matches: Record<string, unknown>[] }).matches : [];
  const indexes = new Set(posts.map((p) => p.index));
  const out = new Map<number, ProductMatch>();
  for (const m of list) {
    const index = Math.round(Number(m?.post));
    if (!indexes.has(index) || out.has(index)) continue;
    const seen = new Set<number>();
    const picks = (Array.isArray(m.picks) ? (m.picks as Record<string, unknown>[]) : [])
      .map((x) => ({ n: Math.round(Number(x?.option)) - 1, reason: String(x?.reason ?? "").trim().slice(0, 140) }))
      .filter((x) => options[x.n] && !seen.has(x.n) && seen.add(x.n))
      .slice(0, 3)
      .map((x) => ({ ...options[x.n], reason: x.reason }));
    out.set(index, { index, picks });
  }
  return posts.map((p) => out.get(p.index) ?? { index: p.index, picks: [] });
}

/** A product name that is free in the month: "Sidr - Tray", then "Sidr - Tray (2)"… (stems are unique). */
export function freeName(name: string, taken: Set<string>): string {
  const base = [...name].map((ch) => (ch < " " || ch === "/" || ch === "\\" ? " " : ch)).join("").replace(/\s+/g, " ").trim().slice(0, 120) || "Product";
  let out = base;
  for (let n = 2; taken.has(out.normalize("NFC").toLowerCase()); n++) out = `${base} (${n})`;
  return out;
}
