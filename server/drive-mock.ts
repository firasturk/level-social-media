/**
 * The demo Drive: on a preview deployment with no Google Cloud credential, the Drive picker is
 * served this in-memory fixture instead of answering 428, so the folders, the roles, a duplicate
 * pair and a missing file can be walked through without a credential and without the network.
 * It is never used when a credential exists (see `isDemoDrive` in drive.ts). The files are small
 * SVG cards, so a pinned or imported demo photo is a real object in the bucket like any other.
 */
import type { DriveRole } from "@shared/drive";
import type { ImageBytes } from "./openai";

export interface MockFolder {
  id: string;
  name: string;
  role: DriveRole;
}

export interface MockFile {
  id: string;
  folder: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  md5Checksum: string;
  size: number;
  width: number;
  height: number;
  /** The card's colour: a new colour is a new version of the picture. */
  color: string;
  /** In the Drive bin: listed, but no longer available. */
  trashed?: boolean;
  /** The file's own bytes (a clip a test adds); without them the file is an SVG card. */
  media?: Uint8Array;
}

export const DEMO_FOLDERS: readonly MockFolder[] = [
  { id: "demo-drinks", name: "Demo drinks (product photos)", role: "product" },
  { id: "demo-brand", name: "Demo brand assets", role: "brand" },
  { id: "demo-references", name: "Demo references", role: "reference" },
];

const DEMO_FILES: readonly MockFile[] = [
  {
    id: "demo-mango",
    folder: "demo-drinks",
    name: "Mango sunrise cup.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-02T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000001",
    size: 1_200_000,
    width: 2400,
    height: 3000,
    color: "#f2a21b",
  },
  {
    id: "demo-pistachio",
    folder: "demo-drinks",
    name: "Pistachio shake.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-03T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000002",
    size: 1_300_000,
    width: 2400,
    height: 3000,
    color: "#7cb66e",
  },
  {
    id: "demo-pistachio-copy",
    folder: "demo-drinks",
    name: "Pistachio shake (1).jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-10T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000002",
    size: 1_300_000,
    width: 2400,
    height: 3000,
    color: "#7cb66e",
  },
  {
    id: "demo-hibiscus",
    folder: "demo-drinks",
    name: "Iced hibiscus.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-04T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000003",
    size: 1_100_000,
    width: 2400,
    height: 3000,
    color: "#c2185b",
  },
  {
    id: "demo-lemon-mint",
    folder: "demo-drinks",
    name: "Lemon mint cooler.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-05T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000004",
    size: 1_000_000,
    width: 2400,
    height: 3000,
    color: "#9ccc65",
  },
  {
    id: "demo-cold-brew",
    folder: "demo-drinks",
    name: "DSC01838.JPG",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-06T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000005",
    size: 1_400_000,
    width: 3000,
    height: 2400,
    color: "#4e342e",
  },
  {
    id: "demo-berry-missing",
    folder: "demo-drinks",
    name: "Berry smoothie.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-09-07T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000006",
    size: 1_000_000,
    width: 2400,
    height: 3000,
    color: "#6a1b9a",
    trashed: true,
  },
  {
    id: "demo-logo",
    folder: "demo-brand",
    name: "Demo logo.png",
    mimeType: "image/png",
    modifiedTime: "2026-08-01T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000010",
    size: 240_000,
    width: 1200,
    height: 1200,
    color: "#0a7bd6",
  },
  {
    id: "demo-ref-sign",
    folder: "demo-references",
    name: "Street sign mood.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-08-12T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000020",
    size: 900_000,
    width: 2000,
    height: 2500,
    color: "#1565c0",
  },
  {
    id: "demo-ref-marble",
    folder: "demo-references",
    name: "Marble flat lay.jpg",
    mimeType: "image/jpeg",
    modifiedTime: "2026-08-13T09:00:00.000Z",
    md5Checksum: "d1a0f0c0e0b0a0900000000000000021",
    size: 950_000,
    width: 2000,
    height: 2500,
    color: "#8d8d8d",
  },
];

function escapeXml(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

export class DriveMock {
  readonly folders = new Map<string, MockFolder>();
  readonly files = new Map<string, MockFile>();

  constructor() {
    this.reset();
  }

  /** The fixture as shipped (a test that changed a file puts it back). */
  reset(): void {
    this.folders.clear();
    this.files.clear();
    for (const f of DEMO_FOLDERS) this.folders.set(f.id, { ...f });
    for (const f of DEMO_FILES) this.files.set(f.id, { ...f });
  }

  /** The folder, or the product folder for an id the fixture does not know (a pasted link). */
  folder(id: string): MockFolder {
    return this.folders.get(id) ?? { id, name: "Demo folder", role: "product" };
  }

  /** The files directly in a folder, the bin included (the listing marks those missing). */
  children(folder: string): MockFile[] {
    const id = this.folders.has(folder) ? folder : "demo-drinks";
    return [...this.files.values()].filter((f) => f.folder === id);
  }

  /** The file as Drive would give it, or null when Drive would answer 404 or it is in the bin. */
  meta(id: string): MockFile | null {
    const f = this.files.get(id);
    return f && !f.trashed ? f : null;
  }

  /** A rendition of the file: an SVG card of the asked size carrying the name and the colour. */
  bytes(id: string, size: number): ImageBytes | null {
    const f = this.meta(id);
    if (!f) return null;
    const w = Math.max(16, Math.min(2400, Math.round(size)));
    const h = Math.round((w * f.height) / f.width);
    const label = escapeXml(f.name.replace(/\.[a-z0-9]+$/i, ""));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${f.color}"/><text x="50%" y="52%" fill="#fff" font-family="sans-serif" font-size="${Math.max(10, Math.round(w / 12))}" text-anchor="middle">${label}</text><text x="50%" y="92%" fill="#fff" fill-opacity="0.7" font-family="sans-serif" font-size="${Math.max(8, Math.round(w / 20))}" text-anchor="middle">DEMO FIXTURE · ${escapeXml(f.modifiedTime.slice(0, 10))}</text></svg>`;
    return { bytes: new TextEncoder().encode(svg).buffer as ArrayBuffer, mime: "image/svg+xml" };
  }
}

/** The one fixture of the isolate; tests change it and reset it. */
export const driveMock = new DriveMock();
