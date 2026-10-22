/**
 * Freepik stock assets: one shared layer for the API routes (/api/studio/freepik) and the Magnific
 * MCP adapter (freepik-mcp.ts), over one asset library (`assets`, `asset_uses`). A stock item is
 * searched for free, downloaded once into the bucket (assets/<id>.<ext>) after the admin confirms
 * the estimate, and then used as a post's reference picture or as an image layer of a design.
 * Nothing here touches the theme (Pinterest pins), the engine or a product photo.
 *
 * With no key saved (Connection → Freepik) the demo catalogue answers: six labelled fixtures with
 * server-drawn placeholder cards; nothing leaves the server. See docs/freepik.md for what was read
 * from the documentation and what is assumed.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { all, first, now, run, uuid } from "./db";
import { FREEPIK_KEY_SETTING, FREEPIK_MCP_TOKEN_SETTING, FREEPIK_PLAN_SETTING, deleteSetting, getSetting, setSetting } from "./settings";
import { MAGNIFIC_MCP_URL, magnificSignIn } from "./magnific-signin";
import { assertIntegrationEnabled, claimSubmission, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { ownedPlan, saveConfig } from "./posts";
import { storeBytes } from "./styles";
import type { User } from "@shared/types";
import type { Config } from "@shared/config";
import type { PostReference } from "@shared/posts";

/* ───────────── Provider constants: every stock path in one place ───────────── */

/**
 * The stock content API as docs.magnific.com describes it in October 2026 (docs.freepik.com
 * redirects there). Host api.magnific.com, header x-magnific-api-key; the key is sent under the
 * former header name too, like the Photo lab does, so either gateway accepts it.
 */
export const FREEPIK_STOCK = {
  base: "https://api.magnific.com",
  headerNames: ["x-magnific-api-key", "x-freepik-api-key"] as const,
  /** GET, query term/page/limit/order/filters[...] → {data[], meta}. */
  search: "/v1/resources",
  /** GET → {data: {id, name, type, premium, license, preview, dimensions, available_formats, author…}}. */
  detail: (id: string) => `/v1/resources/${encodeURIComponent(id)}`,
  /** GET (?image_size=small|medium|large|original) → {data: {filename, url, signed_url}}; the file is then fetched from data.url. */
  download: (id: string) => `/v1/resources/${encodeURIComponent(id)}/download`,
  docs: {
    search: "https://docs.magnific.com/api-reference/resources/get-all-resources",
    detail: "https://docs.magnific.com/api-reference/resources/get-the-detail-of-a-resource-psd-vector-or-photo",
    download: "https://docs.magnific.com/api-reference/resources/download-a-resource",
    pricing: "https://docs.magnific.com/pricing",
    mcp: "https://docs.magnific.com/modelcontextprotocol",
  },
} as const;

export const NOT_CONNECTED = "Not connected: add a Freepik API key under Connection → Freepik. Until then the Freepik panel searches a labelled demo catalogue and nothing is sent anywhere.";

/* ───────────── Shapes ───────────── */

export const ASSET_KINDS = ["photo", "vector", "psd", "template"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ORIENTATIONS = ["landscape", "portrait", "square", "panoramic"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];
export const COLORS = ["black", "blue", "gray", "green", "orange", "red", "white", "yellow", "purple", "cyan", "pink"] as const;

export type LicenseType = "freemium" | "premium";
/** The licence as the API reports it: the type and its URL; attribution follows Freepik's free licence (assumed, see docs). */
export interface AssetLicense {
  type: LicenseType;
  attribution: boolean;
  /** Allowed uses, as the API reports them: the stock API reports only the licence URL, so this stays empty. */
  uses: string[];
  url?: string;
}

export interface StockItem {
  id: string;
  kind: AssetKind;
  title: string;
  author: string;
  license: AssetLicense;
  preview: string;
  width: number | null;
  height: number | null;
  orientation: Orientation | "unknown";
  /** True when the format the download gives cannot be edited as layers (a photo; a PSD rendered to a picture). */
  flattened: boolean;
  formats: string[];
  url: string;
  demo: boolean;
}

export interface SearchParams {
  q: string;
  type?: AssetKind | "";
  orientation?: Orientation | "";
  color?: string;
  page?: number;
  limit?: number;
}

export interface SearchResult {
  items: StockItem[];
  page: number;
  lastPage: number;
  total: number;
  demo: boolean;
}

export interface Downloaded {
  bytes: ArrayBuffer;
  mime: string;
  filename: string;
}

export interface StockProvider {
  readonly name: "freepik" | "demo";
  search(p: SearchParams): Promise<SearchResult>;
  detail(id: string): Promise<StockItem>;
  download(id: string): Promise<Downloaded>;
}

/* ───────────── Freepik over fetch ───────────── */

interface ListItem {
  id?: number | string;
  title?: string;
  url?: string;
  filename?: string;
  licenses?: { type?: string; url?: string }[];
  image?: { type?: string; orientation?: string; source?: { url?: string; size?: string } };
  author?: { name?: string };
  meta?: { available_formats?: Record<string, unknown> | string[] };
}
interface DetailBody {
  data?: {
    id?: number | string;
    name?: string;
    type?: string;
    vertical?: string;
    url?: string;
    license?: string;
    premium?: boolean;
    preview?: { url?: string; width?: number; height?: number };
    dimensions?: { width?: number; height?: number };
    available_formats?: Record<string, unknown>;
    author?: { name?: string };
  };
}

function kindOf(type: string | undefined, vertical?: string): AssetKind {
  if (vertical === "template" || vertical === "mockup") return "template";
  if (type === "vector") return "vector";
  if (type === "psd") return "psd";
  return "photo";
}

/** A photo and a PSD arrive as one flat picture; a vector's download is its source files, editable. */
export const isFlattened = (kind: AssetKind): boolean => kind !== "vector";

function orientationOf(o: string | undefined): Orientation | "unknown" {
  if (o === "horizontal" || o === "landscape") return "landscape";
  if (o === "vertical" || o === "portrait") return "portrait";
  if (o === "square" || o === "panoramic") return o;
  return "unknown";
}

/**
 * Freepik's licence model: a free (freemium) resource needs the author credited, a premium one does
 * not. The API reports only the type and the licence URL; the attribution rule is Freepik's
 * published licence, assumed here and noted in docs/freepik.md.
 */
export function licenseOf(type: string | undefined, url?: string): AssetLicense {
  const t: LicenseType = type === "premium" ? "premium" : "freemium";
  return { type: t, attribution: t === "freemium", uses: [], ...(url ? { url } : {}) };
}

function fromListItem(it: ListItem): StockItem {
  const kind = kindOf(it.image?.type);
  const size = /^(\d+)x(\d+)$/.exec(it.image?.source?.size ?? "");
  const lic = it.licenses?.find((l) => l.type === "premium") ?? it.licenses?.[0];
  const formats = Array.isArray(it.meta?.available_formats) ? (it.meta.available_formats as string[]) : Object.keys(it.meta?.available_formats ?? {});
  return {
    id: String(it.id ?? ""),
    kind,
    title: (it.title ?? it.filename ?? "Untitled").slice(0, 200),
    author: it.author?.name ?? "",
    license: licenseOf(lic?.type, lic?.url),
    preview: it.image?.source?.url ?? "",
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    orientation: orientationOf(it.image?.orientation),
    flattened: isFlattened(kind),
    formats,
    url: it.url ?? "",
    demo: false,
  };
}

/** The documented query: term, page, limit, filters[content_type][photo]=1 and so on. */
export function searchQuery(p: SearchParams): URLSearchParams {
  const q = new URLSearchParams();
  if (p.q.trim()) q.set("term", p.q.trim());
  q.set("page", String(Math.max(1, Math.min(100, p.page ?? 1))));
  q.set("limit", String(Math.max(1, Math.min(50, p.limit ?? 24))));
  q.set("order", "relevance");
  if (p.type && p.type !== "template") q.set(`filters[content_type][${p.type}]`, "1");
  if (p.orientation) q.set(`filters[orientation][${p.orientation}]`, "1");
  if (p.color && (COLORS as readonly string[]).includes(p.color)) q.set("filters[color]", p.color);
  return q;
}

/** Freepik over fetch; `fetchFn` is injected so a test never reaches the real host. */
export class FreepikStockClient implements StockProvider {
  readonly name = "freepik" as const;
  /** Always a plain call: Workers refuse the global `fetch` invoked as a method of another object ("Illegal invocation"). */
  private readonly fetchFn: typeof fetch;
  constructor(
    private readonly key: string,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = FREEPIK_STOCK.base,
  ) {
    this.fetchFn = (input, init) => fetchFn(input, init);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", "Accept-Language": "en-US" };
    for (const name of FREEPIK_STOCK.headerNames) h[name] = this.key;
    return h;
  }

  private async call<T>(path: string): Promise<T> {
    const r = await this.fetchFn(`${this.base}${path}`, { method: "GET", headers: this.headers(), signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { message: text.slice(0, 200) };
    }
    if (!r.ok) {
      const msg = String(body.message ?? body.error ?? body.detail ?? r.statusText ?? "request failed");
      const status = r.status === 401 ? 401 : r.status === 403 ? 403 : r.status === 404 ? 404 : r.status === 429 ? 429 : 502;
      throw new StudioError(`Freepik (${r.status}): ${msg}`, status, r.status === 401);
    }
    return body as T;
  }

  async search(p: SearchParams): Promise<SearchResult> {
    const body = await this.call<{ data?: ListItem[]; meta?: { current_page?: number; last_page?: number; total?: number } }>(`${FREEPIK_STOCK.search}?${searchQuery(p)}`);
    const items = (body.data ?? []).map(fromListItem).filter((i) => i.id);
    return { items: p.type === "template" ? items.filter((i) => i.kind === "template" || i.kind === "psd") : items, page: body.meta?.current_page ?? p.page ?? 1, lastPage: body.meta?.last_page ?? 1, total: body.meta?.total ?? items.length, demo: false };
  }

  async detail(id: string): Promise<StockItem> {
    const body = await this.call<DetailBody>(FREEPIK_STOCK.detail(id));
    const d = body.data;
    if (!d?.id) throw new StudioError("Freepik returned no resource.", 502);
    const kind = kindOf(d.type, d.vertical);
    return {
      id: String(d.id),
      kind,
      title: (d.name ?? "Untitled").slice(0, 200),
      author: d.author?.name ?? "",
      license: licenseOf(d.premium ? "premium" : "freemium", d.license),
      preview: d.preview?.url ?? "",
      width: d.dimensions?.width ?? d.preview?.width ?? null,
      height: d.dimensions?.height ?? d.preview?.height ?? null,
      orientation: d.dimensions?.width && d.dimensions?.height ? (d.dimensions.width > d.dimensions.height ? "landscape" : d.dimensions.width < d.dimensions.height ? "portrait" : "square") : "unknown",
      flattened: isFlattened(kind),
      formats: Object.keys(d.available_formats ?? {}),
      url: d.url ?? "",
      demo: false,
    };
  }

  /** The documented two steps: the download endpoint answers a JSON with the file's URL; the file is then fetched from it. */
  async download(id: string): Promise<Downloaded> {
    const body = await this.call<{ data?: { filename?: string; url?: string; signed_url?: string | null } }>(FREEPIK_STOCK.download(id));
    const url = body.data?.url;
    if (!url) throw new StudioError("Freepik returned no file for this resource.", 502);
    const r = await this.fetchFn(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new StudioError(`The file could not be downloaded (${r.status}).`, 502);
    const mime = (r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const filename = body.data?.filename || `${id}`;
    return { bytes: await r.arrayBuffer(), mime: mime === "application/octet-stream" ? mimeOfName(filename) : mime, filename };
  }
}

export function mimeOfName(name: string): string {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] ?? "").toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "svg" ? "image/svg+xml" : ext === "zip" ? "application/zip" : ext === "psd" ? "image/vnd.adobe.photoshop" : "application/octet-stream";
}

export function extOf(mime: string, filename = ""): string {
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  if (/svg/i.test(mime)) return "svg";
  if (/zip/i.test(mime)) return "zip";
  if (/photoshop/i.test(mime)) return "psd";
  const m = /\.([a-z0-9]{2,5})$/i.exec(filename);
  return m ? m[1].toLowerCase() : "bin";
}

/* ───────────── The demo catalogue ───────────── */

interface DemoFixture {
  id: string;
  kind: AssetKind;
  title: string;
  author: string;
  license: LicenseType;
  orientation: Orientation;
  color: (typeof COLORS)[number];
  hex: string;
  width: number;
  height: number;
  words: string[];
}

export const DEMO_CATALOGUE: readonly DemoFixture[] = [
  { id: "demo-1", kind: "photo", title: "Pistachio dessert on marble", author: "Demo studio", license: "freemium", orientation: "portrait", color: "green", hex: "#6f9f5d", width: 2400, height: 3000, words: ["pistachio", "dessert", "marble", "food", "sweet", "cafe"] },
  { id: "demo-2", kind: "photo", title: "Iced coffee by the window", author: "Demo studio", license: "premium", orientation: "landscape", color: "orange", hex: "#c98a3a", width: 3000, height: 2000, words: ["coffee", "iced", "window", "drink", "cafe", "morning"] },
  { id: "demo-3", kind: "vector", title: "Lantern pattern, Ramadan", author: "Demo vectors", license: "freemium", orientation: "square", color: "blue", hex: "#2f5ea8", width: 2000, height: 2000, words: ["lantern", "ramadan", "pattern", "eid", "ornament", "arabic"] },
  { id: "demo-4", kind: "vector", title: "Sale badge set", author: "Demo vectors", license: "premium", orientation: "square", color: "red", hex: "#b8372f", width: 2000, height: 2000, words: ["sale", "badge", "offer", "discount", "sticker", "label"] },
  { id: "demo-5", kind: "psd", title: "Story template, product launch", author: "Demo templates", license: "premium", orientation: "portrait", color: "purple", hex: "#6a3fa0", width: 1080, height: 1920, words: ["template", "story", "launch", "product", "instagram", "layout"] },
  { id: "demo-6", kind: "photo", title: "Fresh mango splash", author: "Demo studio", license: "freemium", orientation: "square", color: "yellow", hex: "#e0b43a", width: 2000, height: 2000, words: ["mango", "splash", "fruit", "juice", "fresh", "summer"] },
];

export const DEMO_PREVIEW_PATH = "/api/studio/freepik/demo";

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

/** The placeholder card of a demo fixture: a coloured SVG with its title and a DEMO label; drawn on the server, never fetched. */
export function demoCard(f: DemoFixture, w = 600): { bytes: ArrayBuffer; mime: string } {
  const h = Math.round((w * f.height) / f.width);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${f.hex}"/><text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.max(12, Math.round(w / 14))}" text-anchor="middle">${escapeXml(f.title)}</text><text x="50%" y="92%" fill="#fff" fill-opacity="0.75" font-family="sans-serif" font-size="${Math.max(9, Math.round(w / 24))}" text-anchor="middle">DEMO FIXTURE · ${f.kind.toUpperCase()} · ${f.license.toUpperCase()}</text></svg>`;
  return { bytes: new TextEncoder().encode(svg).buffer as ArrayBuffer, mime: "image/svg+xml" };
}

function fromFixture(f: DemoFixture): StockItem {
  return {
    id: f.id,
    kind: f.kind,
    title: `${f.title} (demo)`,
    author: f.author,
    license: licenseOf(f.license, "https://www.freepik.com/legal/terms-of-use"),
    preview: `${DEMO_PREVIEW_PATH}/${f.id}.svg`,
    width: f.width,
    height: f.height,
    orientation: f.orientation,
    flattened: isFlattened(f.kind),
    formats: f.kind === "vector" ? ["svg", "eps"] : f.kind === "psd" ? ["psd", "jpg"] : ["jpg"],
    url: "",
    demo: true,
  };
}

/** The stand-in with no key: the six fixtures, filtered like the real search; nothing is sent anywhere. */
export class DemoStockProvider implements StockProvider {
  readonly name = "demo" as const;
  async search(p: SearchParams): Promise<SearchResult> {
    const words = p.q.toLowerCase().split(/\s+/).filter(Boolean);
    const items = DEMO_CATALOGUE.filter((f) => {
      if (p.type && !(p.type === f.kind || (p.type === "template" && f.kind === "psd"))) return false;
      if (p.orientation && p.orientation !== f.orientation) return false;
      if (p.color && p.color !== f.color) return false;
      return true;
    });
    const matched = words.length ? items.filter((f) => words.every((w) => [f.title.toLowerCase(), ...f.words].some((h) => h.includes(w)))) : items;
    // The demo catalogue is six cards: when the words match none of them, all six are shown (labelled demo) so the flow can be tried.
    const shown = (matched.length ? matched : items).map(fromFixture);
    return { items: shown, page: 1, lastPage: 1, total: shown.length, demo: true };
  }
  async detail(id: string): Promise<StockItem> {
    const f = DEMO_CATALOGUE.find((x) => x.id === id);
    if (!f) throw new StudioError("That demo asset does not exist.", 404);
    return fromFixture(f);
  }
  async download(id: string): Promise<Downloaded> {
    const f = DEMO_CATALOGUE.find((x) => x.id === id);
    if (!f) throw new StudioError("That demo asset does not exist.", 404);
    const card = demoCard(f, 1200);
    return { ...card, filename: `${f.id}.svg` };
  }
}

/* ───────────── Connection, plan and estimates ───────────── */

export type FreepikPlan = "premium" | "business" | "unknown";
export const PLAN_LABELS: Record<FreepikPlan, string> = {
  premium: "Premium, Premium+ or Pro: stock downloads through the API are in the plan, capped at 100 a day",
  business: "Business or Enterprise: no daily cap, every download is charged to the credit balance",
  unknown: "Not set",
};

/** What the pricing page says the plan includes (docs.magnific.com/pricing, read 22 Oct 2026). */
export const ENTITLEMENTS = {
  search: "Searching stock is not billed (assumed: the pricing page lists no cost for a search; it is the documented authentication example).",
  downloadPremium: "On Premium, Premium+ and Pro, API stock downloads don't consume credits, capped at 100 downloads a day; further requests are rejected until the next day.",
  downloadBusiness: "On Business and Enterprise there is no daily cap: each download is deducted from the credit balance like any other API call. The per-download amount is on a page the studio could not read.",
  generation: "Every AI call through the API or the MCP deducts credits from the organisation's balance; an Unlimited website subscription covers the web app only.",
  docs: FREEPIK_STOCK.docs,
} as const;

export interface ResolvedFreepik {
  provider: StockProvider;
  connected: boolean;
  reason: string;
  plan: FreepikPlan;
}

export async function resolveFreepik(env: Env, fetchFn: typeof fetch = fetch): Promise<ResolvedFreepik> {
  const key = await getSetting(env, FREEPIK_KEY_SETTING);
  const planRaw = await getSetting(env, FREEPIK_PLAN_SETTING);
  const plan: FreepikPlan = planRaw === "premium" || planRaw === "business" ? planRaw : "unknown";
  if (key) return { provider: new FreepikStockClient(key, fetchFn), connected: true, reason: "", plan };
  return { provider: new DemoStockProvider(), connected: false, reason: NOT_CONNECTED, plan };
}

/**
 * What one download costs, from the docs: 0 in the demo and on the Premium family (in the plan,
 * 100 a day); null when the plan bills credits per download (the amount is not readable) or when
 * the plan is not set. Null blocks the download with "cost not known".
 */
export function downloadEstimate(plan: FreepikPlan, connected: boolean): number | null {
  if (!connected) return 0;
  if (plan === "premium") return 0;
  return null;
}

export function costNotKnown(plan: FreepikPlan): string {
  return plan === "business"
    ? "Cost not known: on a Business or Enterprise plan each download is charged to the credit balance and the studio could not read the amount. Set the plan under Connection → Freepik once the rate is known, or download the file on freepik.com."
    : "Cost not known: set the Freepik plan under Connection → Freepik first (Premium, Premium+ and Pro include API downloads; Business and Enterprise bill credits).";
}

/* ───────────── The library ───────────── */

export interface AssetRow {
  id: string;
  client: string | null;
  source: "freepik" | "upload";
  provider_id: string;
  kind: AssetKind;
  title: string;
  author: string;
  license: string;
  preview_url: string;
  file_key: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  flattened: number;
  added_by: string;
  created: number;
}

export const assetFileUrl = (id: string) => `/api/studio/freepik/assets/${encodeURIComponent(id)}/file`;

/** The asset as the UI and the Prompt Box read it. */
export function assetJson(a: AssetRow, uses: number | null = null) {
  let license: AssetLicense = { type: "freemium", attribution: true, uses: [] };
  try {
    license = { ...license, ...(JSON.parse(a.license) as Partial<AssetLicense>) };
  } catch {
    /* the default stands */
  }
  const mime = a.mime ?? "";
  return {
    id: a.id,
    client: a.client,
    source: a.source,
    providerId: a.provider_id,
    kind: a.kind,
    title: a.title,
    author: a.author,
    license,
    preview: a.preview_url,
    file: a.file_key ? assetFileUrl(a.id) : null,
    stored: !!a.file_key,
    mime: a.mime,
    width: a.width,
    height: a.height,
    flattened: a.flattened === 1,
    /** True when the stored file can be an image layer (a picture the browser draws: JPG, PNG, WebP, SVG). */
    layerable: /^image\/(jpeg|png|webp|svg\+xml)$/.test(mime),
    demo: a.provider_id.startsWith("demo-"),
    addedBy: a.added_by,
    created: a.created,
    ...(uses === null ? {} : { uses }),
  };
}
export type AssetJson = ReturnType<typeof assetJson>;

export async function assetById(env: Env, id: string | undefined): Promise<AssetRow> {
  if (!id) throw new StudioError("Asset id is required.");
  const a = await first<AssetRow>(env.DB, "SELECT * FROM assets WHERE id = ?", id);
  if (!a) throw new StudioError("That asset is not in the library.", 404);
  return a;
}

export async function assetByProvider(env: Env, providerId: string): Promise<AssetRow | null> {
  return first<AssetRow>(env.DB, "SELECT * FROM assets WHERE source = 'freepik' AND provider_id = ?", providerId);
}

/**
 * A stock item known to the library (its preview and licence), without a file yet: the row the
 * MCP adapter and the API share so a later download lands on the same asset.
 */
export async function upsertStockItem(env: Env, item: StockItem, user: User, client: string | null): Promise<AssetRow> {
  const existing = await assetByProvider(env, item.id);
  if (existing) {
    if (!existing.title && item.title) await run(env.DB, "UPDATE assets SET title = ?, author = ?, preview_url = COALESCE(NULLIF(preview_url, ''), ?) WHERE id = ?", item.title, item.author, item.preview, existing.id);
    if (!existing.client && client) await run(env.DB, "UPDATE assets SET client = ? WHERE id = ?", client, existing.id);
    return (await assetById(env, existing.id))!;
  }
  const id = uuid();
  await run(
    env.DB,
    "INSERT INTO assets (id, client, source, provider_id, kind, title, author, license, preview_url, file_key, mime, width, height, flattened, added_by, created) VALUES (?, ?, 'freepik', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)",
    id,
    client,
    item.id,
    item.kind,
    item.title,
    item.author,
    JSON.stringify(item.license),
    item.preview,
    item.width,
    item.height,
    item.flattened ? 1 : 0,
    user.id,
    now(),
  );
  return (await assetById(env, id))!;
}

/** The downloaded file into the bucket under assets/<provider id>.<ext>, and the row completed. */
export async function storeDownloaded(env: Env, asset: AssetRow, file: Downloaded): Promise<AssetRow> {
  const key = `assets/${asset.provider_id}.${extOf(file.mime, file.filename)}`;
  await env.BUCKET.put(key, file.bytes, { httpMetadata: { contentType: file.mime }, customMetadata: { name: file.filename.slice(0, 120) } });
  const flattened = /^image\/svg/.test(file.mime) ? 0 : asset.kind === "vector" && /zip/.test(file.mime) ? 0 : 1;
  await run(env.DB, "UPDATE assets SET file_key = ?, mime = ?, flattened = ? WHERE id = ?", key, file.mime, flattened, asset.id);
  return (await assetById(env, asset.id))!;
}

export interface DownloadOutcome {
  asset: AssetRow;
  reused: boolean;
  estimate: number;
  opId: string;
}

/**
 * One licensed download, governed: the estimate is recorded as a proposed op and the caller must
 * confirm; a file already in the bucket is reused (no second download, no second charge). The
 * item's details come from the provider so the licence stored is what it reports.
 */
export async function downloadAsset(
  env: Env,
  user: User,
  id: string,
  opts: { confirm: boolean; client?: string | null; batch?: string | null; post?: number | null; item?: StockItem },
  fetchFn: typeof fetch = fetch,
): Promise<DownloadOutcome> {
  const fp = await resolveFreepik(env, fetchFn);
  const existing = await assetByProvider(env, id);
  if (existing?.file_key) {
    const opId = await recordIntegrationOp(env, { provider: "freepik", kind: "download", user: user.id, batch: opts.batch ?? null, post: opts.post ?? null, estimate: 0, reported: 0, status: "done", note: `Reused ${existing.provider_id} already in the library` });
    if (!existing.client && opts.client) await run(env.DB, "UPDATE assets SET client = ? WHERE id = ?", opts.client, existing.id);
    return { asset: (await assetById(env, existing.id))!, reused: true, estimate: 0, opId };
  }
  const item = opts.item ?? (await fp.provider.detail(id));
  if (item.demo !== !fp.connected) throw new StudioError(fp.connected ? "That is a demo asset: search again with the key connected." : NOT_CONNECTED, 409);
  const estimate = downloadEstimate(fp.plan, fp.connected);
  const asset = await upsertStockItem(env, item, user, opts.client ?? null);
  if (estimate === null) {
    await recordIntegrationOp(env, { provider: "freepik", kind: "download", user: user.id, batch: opts.batch ?? null, post: opts.post ?? null, estimate: null, status: "refused", note: `Cost not known for ${id} (plan ${fp.plan})` });
    throw new StudioError(costNotKnown(fp.plan), 409, false, { blocked: true, plan: fp.plan, asset: assetJson(asset) });
  }
  if (!opts.confirm) {
    const opId = await recordIntegrationOp(env, { provider: "freepik", kind: "download", user: user.id, batch: opts.batch ?? null, post: opts.post ?? null, estimate, status: "proposed", note: `Download ${id}: ${item.title}` });
    throw new StudioError(
      estimate === 0 ? `Confirm the download: ${item.title} is in the plan (no credits; ${fp.connected ? "counts toward the 100 a day" : "demo"}).` : `Confirm the download: about ${estimate} credits.`,
      409,
      false,
      { needsConfirm: true, estimate, opId, asset: assetJson(asset) },
    );
  }
  if (!(await claimSubmission(env, `freepik:download:${id}`, 120_000))) throw new StudioError("This download is already in progress.", 409);
  const opId = await recordIntegrationOp(env, { provider: "freepik", kind: "download", user: user.id, batch: opts.batch ?? null, post: opts.post ?? null, estimate, status: "running", note: `Download ${id}: ${item.title}` });
  try {
    const file = await fp.provider.download(id);
    const stored = await storeDownloaded(env, asset, file);
    await updateIntegrationOp(env, opId, { status: "done", reported: estimate, note: `${stored.file_key} (${file.mime}, ${file.bytes.byteLength} bytes)` });
    return { asset: stored, reused: false, estimate, opId };
  } catch (e) {
    await updateIntegrationOp(env, opId, { status: "failed", note: errorMessage(e) });
    throw e;
  }
}

/* ───────────── Uses: a post's reference or a design layer ───────────── */

export type UseRole = "reference" | "design";

export interface UseInput {
  asset: string;
  batch: string;
  post: number;
  slide?: number | null;
  role: UseRole;
  layerId?: string | null;
}

/** The R2 key of the preview picture kept next to a bundle (a vector's ZIP), once fetched. */
export const previewKeyOf = (asset: AssetRow): string => `assets/${asset.provider_id}.preview`;

/**
 * A vector or template downloads as a file bundle (ZIP) that is no picture. Its preview picture
 * (the one the search shows, from Freepik's CDN) stands in: fetched once, kept next to the bundle
 * under `assets/<id>.preview`, and used as the reference or the design layer, flattened.
 */
export async function previewPicture(env: Env, asset: AssetRow, fetchFn: typeof fetch = fetch): Promise<{ bytes: ArrayBuffer; mime: string; key: string }> {
  const key = previewKeyOf(asset);
  const kept = await env.BUCKET.get(key);
  if (kept) return { bytes: await kept.arrayBuffer(), mime: kept.httpMetadata?.contentType || "image/jpeg", key };
  if (!asset.preview_url || !/^https?:/.test(asset.preview_url)) throw new StudioError("This asset is a file bundle, not a picture, and it has no preview picture to use instead.", 415);
  const r = await fetchFn(asset.preview_url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new StudioError(`The asset's preview picture could not be fetched (${r.status}).`, 502);
  const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp)$/i.test(mime)) throw new StudioError("The asset's preview is not a picture the studio can use.", 415);
  const bytes = await r.arrayBuffer();
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  return { bytes, mime, key };
}

const isBundle = (mime: string): boolean => !/^image\//i.test(mime);

/**
 * The stored file as a post's reference picture, through the same storage the reference route
 * uses (a thumbnail is made for a raster picture); the previous reference's files are deleted,
 * as the route does. An SVG is kept as it is; a file bundle (a vector's ZIP) is replaced by its
 * preview picture.
 */
async function attachReference(env: Env, user: User, asset: AssetRow, batch: string, index: number, fetchFn: typeof fetch = fetch): Promise<PostReference> {
  if (!asset.file_key) throw new StudioError("Download this asset to the library first.", 409);
  const obj = await env.BUCKET.get(asset.file_key);
  if (!obj) throw new StudioError("The asset's file is no longer in storage: download it again.", 404);
  let bytes = await obj.arrayBuffer();
  let mime = obj.httpMetadata?.contentType || asset.mime || "application/octet-stream";
  let fromPreview = false;
  if (isBundle(mime)) {
    const p = await previewPicture(env, asset, fetchFn);
    bytes = p.bytes;
    mime = p.mime;
    fromPreview = true;
  }
  let image: string;
  let thumb: string;
  const id = uuid();
  if (/^image\/(jpeg|png|webp)$/i.test(mime)) {
    const stored = await storeBytes(env, id, bytes, mime);
    image = stored.image;
    thumb = stored.thumb;
  } else if (/^image\/svg/i.test(mime)) {
    image = `styles/${id}.svg`;
    thumb = image;
    await env.BUCKET.put(image, bytes, { httpMetadata: { contentType: mime } });
  } else {
    throw new StudioError("This asset is not a picture the studio can use as a reference.", 415);
  }
  const b = await ownedPlan(env, user, batch);
  const config = JSON.parse(b.config) as Config;
  const post = (config.plan ?? []).find((p) => p.index === index);
  if (!post) throw new StudioError("That post is not in the month.", 404);
  if (post.reference?.key) await env.BUCKET.delete([post.reference.key, post.reference.thumb]).catch(() => undefined);
  const reference: PostReference = { key: image, thumb, name: `${asset.title.slice(0, 180)}${fromPreview ? " (preview picture)" : ""}`, note: post.reference?.note, at: now() };
  config.plan = (config.plan ?? []).map((p) => (p.index === index ? { ...p, reference } : p));
  await saveConfig(env, b, config);
  return reference;
}

export interface UseOutcome {
  asset: AssetRow;
  use: { id: string; role: UseRole; batch: string; post: number; slide: number | null; layerId: string | null };
  reference?: PostReference;
  /** For a design use: the studio URL an image layer points at, and whether it is flattened. */
  layer?: { src: string; name: string; flattened: boolean; layerable: boolean };
}

export async function useAsset(env: Env, user: User, d: UseInput, fetchFn: typeof fetch = fetch): Promise<UseOutcome> {
  const asset = await assetById(env, d.asset);
  if (!asset.file_key) throw new StudioError("Download this asset to the library first.", 409);
  await ownedPlan(env, user, d.batch);
  const out: UseOutcome = { asset, use: { id: uuid(), role: d.role, batch: d.batch, post: d.post, slide: d.slide ?? null, layerId: null } };
  if (d.role === "reference") {
    out.reference = await attachReference(env, user, asset, d.batch, d.post, fetchFn);
  } else {
    const json = assetJson(asset);
    out.use.layerId = d.layerId ?? null;
    if (json.layerable) {
      out.layer = { src: assetFileUrl(asset.id), name: asset.title, flattened: asset.flattened === 1, layerable: true };
    } else {
      // A bundle (a vector's ZIP) is drawn as its preview picture, flattened; the source files stay in the library.
      await previewPicture(env, asset, fetchFn);
      out.layer = { src: `${assetFileUrl(asset.id)}?preview=1`, name: `${asset.title} (preview picture)`, flattened: true, layerable: true };
    }
  }
  await run(env.DB, "INSERT INTO asset_uses (id, asset, batch, post, slide, role, layer_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", out.use.id, asset.id, d.batch, d.post, d.slide ?? null, d.role, out.use.layerId, now());
  await recordIntegrationOp(env, { provider: "freepik", kind: "use", user: user.id, batch: d.batch, post: d.post, estimate: 0, reported: 0, status: "done", note: `${d.role}: ${asset.provider_id}` });
  return out;
}

/* ───────────── Routes ───────────── */

type Variables = { user: User };
export const freepikRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Tests inject a fetch; production uses the global one. */
let fetchForTests: typeof fetch | null = null;
export function useFreepikFetch(fn: typeof fetch | null): void {
  fetchForTests = fn;
}
const fetcher = () => fetchForTests ?? fetch;

async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioError(`Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? "is invalid"}.`);
  }
  return parsed.data;
}

/** Admins only, and the integration switched on. */
async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "freepik");
  await assertIntegrationEnabled(c.env, "freepik");
  return u;
}

/** Connected or not, who may use it, and what the plan includes: readable by every member so the entry can say "Admins only for now". */
freepikRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const fp = await resolveFreepik(c.env, fetcher());
  // The MCP is connected through the sign-in (server/magnific-signin.ts) or, the advanced path, a pasted token.
  const mcpToken = await getSetting(c.env, FREEPIK_MCP_TOKEN_SETTING);
  const mcpSignedIn = await magnificSignIn.isSignedIn(c.env);
  let enabled = true;
  let switchReason = "";
  try {
    await assertIntegrationEnabled(c.env, "freepik");
  } catch (e) {
    enabled = false;
    switchReason = errorMessage(e);
  }
  return c.json({
    connected: fp.connected,
    provider: fp.provider.name,
    demo: !fp.connected,
    reason: fp.reason,
    admin: user.role === "admin",
    access: user.role === "admin" ? "admin" : "Admins only for now",
    plan: fp.plan,
    planLabel: PLAN_LABELS[fp.plan],
    downloadEstimate: downloadEstimate(fp.plan, fp.connected),
    entitlements: ENTITLEMENTS,
    mcp: { connected: mcpSignedIn || !!mcpToken, signedIn: mcpSignedIn, token: !!mcpToken, url: MAGNIFIC_MCP_URL },
    switch: { enabled, reason: switchReason },
  });
});

freepikRoutes.post("/plan", async (c) => {
  await gate(c);
  const { plan } = await body(c, z.object({ plan: z.enum(["premium", "business", "unknown"]) }));
  if (plan === "unknown") await deleteSetting(c.env, FREEPIK_PLAN_SETTING);
  else await setSetting(c.env, FREEPIK_PLAN_SETTING, plan);
  return c.json({ ok: true, plan, downloadEstimate: downloadEstimate(plan, !!(await getSetting(c.env, FREEPIK_KEY_SETTING))) });
});

const searchSchema = z.object({
  q: z.string().max(200).default(""),
  type: z.enum(ASSET_KINDS).or(z.literal("")).default(""),
  orientation: z.enum(ORIENTATIONS).or(z.literal("")).default(""),
  color: z.enum(COLORS).or(z.literal("")).default(""),
  page: z.coerce.number().int().min(1).max(100).default(1),
  client: z.string().max(120).optional(),
});

/** A stock search: free per the docs, still recorded as an op (estimate 0) so the ledger shows the browsing. */
freepikRoutes.get("/search", async (c) => {
  const user = await gate(c);
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) throw new StudioError(`Invalid search: ${parsed.error.issues[0]?.path.join(".") || "query"} ${parsed.error.issues[0]?.message ?? "is invalid"}.`);
  const d = parsed.data;
  const fp = await resolveFreepik(c.env, fetcher());
  const result = await fp.provider.search({ q: d.q, type: d.type, orientation: d.orientation, color: d.color, page: d.page });
  await recordIntegrationOp(c.env, { provider: "freepik", kind: "search", user: user.id, estimate: 0, reported: 0, status: "done", note: `"${d.q}" ${d.type || "any"} ${d.orientation || ""} ${d.color || ""} p${d.page}: ${result.items.length}`.trim() });
  return c.json({ ...result, connected: fp.connected, reason: fp.reason, plan: fp.plan, downloadEstimate: downloadEstimate(fp.plan, fp.connected) });
});

freepikRoutes.get("/resource/:id", async (c) => {
  const user = await gate(c);
  const id = c.req.param("id");
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) throw new StudioError("Resource id is invalid.");
  const fp = await resolveFreepik(c.env, fetcher());
  const item = await fp.provider.detail(id);
  const stored = await assetByProvider(c.env, id);
  await recordIntegrationOp(c.env, { provider: "freepik", kind: "detail", user: user.id, estimate: 0, reported: 0, status: "done", note: id });
  return c.json({ item, asset: stored ? assetJson(stored) : null, connected: fp.connected, downloadEstimate: downloadEstimate(fp.plan, fp.connected) });
});

const downloadSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/i),
  confirm: z.boolean().optional(),
  client: z.string().max(120).optional(),
  batch: z.string().max(120).optional(),
  post: z.number().int().min(1).optional(),
});

/** One licensed download into the library; `confirm: true` after the estimate was shown. */
freepikRoutes.post("/download", async (c) => {
  const user = await gate(c);
  const d = await body(c, downloadSchema);
  const out = await downloadAsset(c.env, user, d.id, { confirm: d.confirm === true, client: d.client ?? null, batch: d.batch ?? null, post: d.post ?? null }, fetcher());
  return c.json({ ok: true, asset: assetJson(out.asset), reused: out.reused, estimate: out.estimate, opId: out.opId });
});

const useSchema = z.object({
  asset: z.string().min(1).max(60),
  batch: z.string().min(1).max(120),
  post: z.number().int().min(1),
  slide: z.number().int().min(1).optional(),
  role: z.enum(["reference", "design"]),
  layerId: z.string().max(60).optional(),
});

/** The asset onto a post: as its reference picture, or as the file an image layer of its design points at. */
freepikRoutes.post("/use", async (c) => {
  const user = await gate(c);
  const d = await body(c, useSchema);
  const out = await useAsset(c.env, user, { asset: d.asset, batch: d.batch, post: d.post, slide: d.slide ?? null, role: d.role, layerId: d.layerId ?? null }, fetcher());
  return c.json({ ok: true, asset: assetJson(out.asset), use: out.use, ...(out.reference ? { reference: out.reference } : {}), ...(out.layer ? { layer: out.layer } : {}) });
});

/** The library: everything brought in for a client (and the assets with no client), newest first. */
freepikRoutes.get("/assets", async (c) => {
  await gate(c);
  const client = c.req.query("client") ?? "";
  const rows = client
    ? await all<AssetRow & { uses: number }>(c.env.DB, "SELECT a.*, (SELECT COUNT(*) FROM asset_uses u WHERE u.asset = a.id) AS uses FROM assets a WHERE a.client = ? OR a.client IS NULL ORDER BY a.created DESC LIMIT 200", client)
    : await all<AssetRow & { uses: number }>(c.env.DB, "SELECT a.*, (SELECT COUNT(*) FROM asset_uses u WHERE u.asset = a.id) AS uses FROM assets a ORDER BY a.created DESC LIMIT 200");
  return c.json({ assets: rows.map((r) => assetJson(r, r.uses)) });
});

/** The stored file, for viewing and for image layers: every member may read it (a design shows it). */
freepikRoutes.get("/assets/:id/file", async (c) => {
  const a = await assetById(c.env, c.req.param("id"));
  if (!a.file_key) throw new StudioError("Not downloaded yet.", 404);
  // `?preview=1`: the preview picture kept next to a bundle (fetched when the bundle was first used).
  const obj = c.req.query("preview") ? ((await c.env.BUCKET.get(previewKeyOf(a))) ?? (await previewPicture(c.env, a, fetcher()).then(() => c.env.BUCKET.get(previewKeyOf(a))))) : await c.env.BUCKET.get(a.file_key);
  if (!obj) throw new StudioError("Not found.", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || a.mime || "application/octet-stream", "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" },
  });
});

/** The demo catalogue's placeholder cards, drawn here. */
freepikRoutes.get("/demo/:id", async (c) => {
  const id = c.req.param("id").replace(/\.svg$/, "");
  const f = DEMO_CATALOGUE.find((x) => x.id === id);
  if (!f) throw new StudioError("Not found.", 404);
  const card = demoCard(f);
  return new Response(card.bytes, { headers: { "Content-Type": card.mime, "Cache-Control": "public, max-age=86400" } });
});
